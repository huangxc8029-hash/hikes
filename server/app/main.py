"""到此一游 · API v1

实现在 docs/API.md 里定义的契约。全部返回体声明 response_model，错误响应也列出，
否则 /docs 里响应是空的，前端没法照着联调。
"""
import io
import json
import logging
import hashlib
import math
import os
import pathlib
import re
import sys
import tempfile
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from typing import Any, Literal

import jwt
import httpx
from fastapi import Depends, FastAPI, Header, HTTPException, Path
from fastapi import Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.responses import RedirectResponse
from fastapi.responses import Response
try:
    import qrcode
    import qrcode.image.svg
    HAS_QR = True
except ImportError:            # 可选依赖：没装也不该让整个服务起不来
    HAS_QR = False
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from sqlalchemy import create_engine, text
from sqlalchemy.exc import IntegrityError
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

# Vercel 的 @vercel/python 入口可能直接加载 server/app/main.py（模块名 main），
# 此时 `app.*` 需要 server/ 在 sys.path 上；本地作为 app.main 导入时这段是无操作。
_SERVER_ROOT = pathlib.Path(__file__).resolve().parents[1]
if (_SERVER_ROOT / "app" / "main.py").is_file():
    sys.path.insert(0, str(_SERVER_ROOT))

from app.checkins import (record_visit, CHECKIN_RADIUS_PEAK_M,
                          CHECKIN_RADIUS_OTHER_M, MAX_ACCURACY_M)
from app.efforts import reconcile_efforts
from app.letters import public_letter, letter_is_unlocked
from app.king_routes import build_king_router
from app.king_service import ServiceError
from app.content_safety import moderator, ModerationError

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql+psycopg://hikes:hikes@db:5432/hikes")
JWT_SECRET = os.getenv("JWT_SECRET", "dev-only-change-me")
JWT_ALG = "HS256"
PUBLIC_BASE = os.getenv("PUBLIC_BASE_URL", "http://localhost:8000").rstrip("/")
# 部署验收用：/health 里能直接看出跑的是哪一版，避免"推了但没上线"时误判。
BUILD_REVISION = "2026-10-18.5"
_engine_options = {"pool_pre_ping": True}
if "supabase.co" in DATABASE_URL or "pooler.supabase.com" in DATABASE_URL:
    # Supabase 的 Vercel 连接应使用 transaction pooler，且 psycopg 不能依赖预处理语句。
    # 每个 warm instance 留几个连接：线路列表页会同时请求 6 条线路详情，
    # 单连接会把几十次查询排成一队，很容易把前端的 15 秒超时耗尽。
    # 函数已与 Supabase 同区（sin1），pool_pre_ping 的 SELECT 1 只有毫秒级，
    # 保留它能挡住 pooler 回收连接后偶发的 500。
    _engine_options.update(
        pool_size=4,
        max_overflow=2,
        pool_timeout=10,
        pool_recycle=300,
        connect_args={"prepare_threshold": None, "sslmode": "require",
                      "connect_timeout": 10},
    )
engine = create_engine(DATABASE_URL, **_engine_options)

app = FastAPI(title="到此一游 API", version="1.0",
              description="契约见仓库 docs/API.md。错误响应统一为 "
                          "error.code / error.message。")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"],
                   allow_headers=["*"])


# ==================== 基础设施 ====================

def q(sql: str, **params):
    with engine.begin() as conn:
        return conn.execute(text(sql), params).mappings().all()


def q1(sql: str, **params):
    rows = q(sql, **params)
    return rows[0] if rows else None


def _audit(conn, actor_id: int, action: str, target_type: str, target_id: int,
           previous: dict, current: dict, reason: str | None = None,
           point_id: int | None = None, board_id: int | None = None):
    conn.execute(text("""INSERT INTO maintenance_audit_logs
        (actor_id, action, board_id, target_type, target_id, previous, current, reason)
        VALUES (:actor, :action,
          coalesce(:board, (SELECT b.id FROM points p JOIN boards b
            ON b.mountain_id = p.mountain_id AND b.board_type = 'summit'
            WHERE p.id = :point LIMIT 1)),
          :target_type, :target_id, CAST(:previous AS jsonb), CAST(:current AS jsonb), :reason)"""),
        {"actor": actor_id, "action": action, "board": board_id,
         "target_type": target_type, "target_id": target_id,
         "previous": json.dumps(previous, ensure_ascii=False, default=str),
         "current": json.dumps(current, ensure_ascii=False, default=str),
         "reason": reason, "point": point_id})


def err(status: int, code: str, message: str):
    raise HTTPException(status, detail={"error": {"code": code, "message": message}})


def make_token(user_id: int) -> str:
    exp = datetime.now(timezone.utc) + timedelta(days=7)
    return jwt.encode({"sub": str(user_id), "exp": exp}, JWT_SECRET, algorithm=JWT_ALG)


def require_user(authorization: str | None = Header(default=None)) -> int:
    """按契约 docs/API.md：Authorization: Bearer <jwt>。"""
    if not authorization or not authorization.lower().startswith("bearer "):
        err(401, "UNAUTHORIZED", "未登录")
    try:
        payload = jwt.decode(authorization.split(" ", 1)[1], JWT_SECRET, algorithms=[JWT_ALG])
    except jwt.ExpiredSignatureError:
        err(401, "TOKEN_EXPIRED", "登录已过期，请重新进入")
    except Exception:
        err(401, "TOKEN_INVALID", "登录凭证无效")
    uid = int(payload["sub"])
    # 注销过的账号：JWT 是无状态的，签出去的令牌还没到期也必须立刻失效
    if not q1("SELECT 1 AS ok FROM users WHERE id = :u AND deleted_at IS NULL", u=uid):
        err(401, "ACCOUNT_DELETED", "账号已注销，请重新注册或联系平台")
    return uid


def require_ad_reviewer(uid: int = Depends(require_user)) -> int:
    if not q1("SELECT 1 AS ok FROM system_roles WHERE user_id = :u AND role = 'ad_reviewer'", u=uid):
        err(403, "AD_REVIEW_FORBIDDEN", "只有系统广告审核员可以审核和调整展示位置")
    return uid


def require_place_curator(uid: int = Depends(require_user)) -> int:
    if not q1("SELECT 1 AS ok FROM system_roles WHERE user_id = :u AND role = 'place_curator'", u=uid):
        err(403, "PLACE_CURATOR_FORBIDDEN", "只有地理资料审核员可以合并山峰身份")
    return uid


def require_collaboration_reviewer(uid: int = Depends(require_user)) -> int:
    if not q1("SELECT 1 AS ok FROM system_roles WHERE user_id = :u AND role = 'collaboration_reviewer'", u=uid):
        err(403, "COLLABORATION_REVIEW_FORBIDDEN", "只有平台协作审核员可以审批维护协作")
    return uid


def require_content_reviewer(uid: int = Depends(require_user)) -> int:
    if not q1("SELECT 1 AS ok FROM system_roles WHERE user_id = :u AND role = 'content_reviewer'", u=uid):
        err(403, "CONTENT_REVIEW_FORBIDDEN", "只有平台内容审核员可以复核留言申诉")
    return uid


# 统一山大王申请 / 山寨 / 留言版管理。路由模块不反向导入 main，
# 引擎与鉴权依赖在这里注入，避免循环依赖。
app.include_router(build_king_router(
    engine, err, require_user, require_collaboration_reviewer))


@app.exception_handler(ServiceError)
async def _service_error_handler(request: Request, exc: ServiceError):
    """业务状态机错误统一成既有 error.code / error.message 结构。"""
    return JSONResponse(status_code=exc.status, content={
        "detail": {"error": {"code": exc.code, "message": exc.message}}})


ERR_401 = {401: {"description": "未登录 / token 无效"}}
ERR_403 = {403: {"description": "没有这个操作的权限"}}
ERR_404 = {404: {"description": "资源不存在"}}


# ==================== 响应模型 ====================

class HealthOut(BaseModel):
    ok: bool
    postgis: str
    db: str
    revision: str = ""
    routes: int
    segments: int
    peaks: int
    points: int
    routesMissingGeom: int = 0
    routesMissingPath: int = 0
    routesMissingProfile: int = 0


class RouteBrief(BaseModel):
    id: int
    slug: str
    name: str
    sub: str | None = None
    km: float
    up: int
    down: int
    hardest_level: Literal["easy", "mid", "hard", "hidden"] | None = Field(
        default=None,
        description="最难那一段的等级，不代表整条线路；整条没有可定级爬升时为 null")
    hours: float | None = Field(default=None, description="平均完成时间（估算）")
    kcal: int | None = Field(default=None, description="大致消耗（估算）")
    weekly_visits: int = Field(default=0, description="近 7 天打卡人次")
    fastest_time: str | None = Field(default=None, description="最快用时；没人记过则为 null")
    fastest_holder: str | None = Field(default=None, description="记录保持者")
    peak_count: int
    segment_count: int
    visit_count: int
    city: str | None = Field(default=None, description="所在区域 / 城市，路书页的「区域」筛选用")
    heatTier: str | None = Field(
        default=None,
        description="这条线路沿途最近的有资料山头的热度档（极热/热门/较热/小众）；"
                    "1.5 km 内没有带热度的山头则为 null，列表里排在带热度的后面")


class RouteListOut(BaseModel):
    items: list[RouteBrief]
    nextCursor: str | None = None


class SegmentOut(BaseModel):
    id: int = Field(description="分段 id，留言挂在它上面")
    trail_segment_id: int | None = None
    board_id: int | None = None
    no: int
    from_km: float
    to_km: float
    km: float
    rise: int
    pct: int
    level: Literal["easy", "mid", "hard", "hidden"] | None = Field(
        default=None,
        description="段难度；下降段与平缓段不适用登顶难度，为 null（不评级）")
    kind: Literal["climb", "desc", "flat"]
    source: Literal["auto", "manual"]
    confirmed: bool
    difficulty_applicable: bool = True
    not_applicable: Literal["descent", "gentle"] | None = Field(
        default=None, description="不定级的原因：下坡 / 平缓")
    up_m: int = Field(default=0, description="段内累计爬升（说明用；定级用 max_rise_m）")
    down_m: int = Field(default=0, description="段内累计下降")
    max_rise_m: int = Field(default=0, description="段内最大连续爬升（定级用这个）")
    max_drop_m: int = Field(default=0, description="段内最大连续下降（米）")


class PeakOut(BaseModel):
    idx: int
    km: float
    altitude: int
    elevation_m: int | None = None
    rise: int
    name: str | None = None
    name_status: Literal["unconfirmed", "candidate", "confirmed"] = "unconfirmed"
    candidate_id: int | None = None
    candidate_name: str | None = None
    near_cp: str | None = Field(default=None, description="最近的打卡点名字（组委会给的点名）")
    near_cp_m: int | None = Field(default=None, description="离那个打卡点多少米（沿线里程差）")


class CheckpointOut(BaseModel):
    """赛事打卡点：组委会 GPX 里的 <wpt>，我们贴回轨迹算出里程与海拔。"""
    no: int
    name: str
    km: float
    altitude: int | None = None
    lat: float | None = None
    lng: float | None = None
    off_track_m: int | None = Field(default=None, description="点名离轨迹多少米，>300 基本是录错的")
    supply_type: str | None = None
    notes: str | None = None
    source: Literal["official", "maintainer"] = "official"
    id: int | None = None
    id: int | None = None


class RouteDetail(BaseModel):
    id: int
    slug: str
    name: str
    sub: str | None = None
    city: str | None = Field(default=None, description="所在区域 / 城市")
    km: float
    up: int
    down: int
    hardest_level: Literal["easy", "mid", "hard", "hidden"] | None = None
    kind: Literal["hike", "race"] | None = Field(
        default=None, description="hike = 徒步/越野路线，race = 赛事赛道（不套用休闲估时）")
    hours: float | None = None
    kcal: int | None = None
    est: dict[str, Any] | None = None
    peak_count: int
    path: list[list[float]] = Field(description="归一化 0-1 坐标，前端直接画 SVG")
    coordinates: list[list[float]] = Field(default_factory=list, description="轨迹经纬度 [纬度, 经度]")
    terrain_url: str | None = Field(default=None, description="离线生成的真实 DEM 地形底图")
    terrain_bounds: dict[str, float] | None = Field(default=None, description="地形图地理范围")
    terrain_contour: dict[str, Any] | None = Field(default=None, description="等高线起点基准与相对高差间距")
    profile: list[float] = Field(description="归一化海拔剖面")
    elevation_m: list[float] = Field(default_factory=list, description="与轨迹采样一一对应的实际海拔米数")
    segments: list[SegmentOut]
    peaks: list[PeakOut]
    checkpoints: list[CheckpointOut] = Field(
        default_factory=list, description="赛道打卡点；没有组委会轨迹的线路是空的")
    can_maintain_route: bool = False
    coverUrl: str | None = Field(default=None, description="审核通过的真实封面；没有则为空")
    coverThumbnailUrl: str | None = None
    coverByline: str | None = Field(default=None, description="拍摄者署名")


class CommentOut(BaseModel):
    reply_count: int = 0
    id: int
    text: str
    nickname: str | None = None
    is_maintainer: bool
    like_count: int
    bad_count: int
    status: Literal["normal", "flagged", "hidden"]
    pinned: bool = False
    hidden_reason: str | None = None
    created_at: datetime


class PointDetail(BaseModel):
    id: int
    code: str
    type: Literal["peak", "junction", "trailhead"]
    name: str | None = Field(default=None, description="空 = 名称待定，不是错误")
    route_id: int | None = None
    route_slug: str | None = None
    route_name: str | None = None
    index_in_route: int | None = None
    total_in_route: int | None = None
    level: Literal["easy", "mid", "hard", "hidden"]
    altitude: int | None = None
    guide: dict[str, Any] | None = None
    maintainerName: str | None = None
    recentContribution: str | None = None
    pendingCount: int = 0
    mountainId: int | None = None
    boardId: int | None = None
    boardPointCodes: list[str] = Field(default_factory=list)
    status: Literal["draft", "published"]
    version: int
    visitCount: int
    topComment: CommentOut | None = None


class VisitIn(BaseModel):
    source: Literal["scan", "nearby", "manual"] = "scan"
    clientUuid: str | None = None
    occurredAt: datetime | None = None
    lat: float | None = None
    lng: float | None = None
    accuracyM: int | None = None


class VisitOut(BaseModel):
    visitId: int | None = None
    seq: int = Field(description="你是第 N 位")
    isFirstVisit: bool = Field(description="今天是否首次打卡；同日重复请求为 false")
    myVisitCount: int
    message: str
    visitedAt: datetime
    pointCode: str
    peakName: str | None = None
    altitude: int | None = None
    routeName: str | None = None
    idxInRoute: int | None = None
    totalInRoute: int | None = None


class TokenOut(BaseModel):
    token: str
    tokenType: str = "Bearer"
    userId: int
    mergedVisits: int = 0
    mergedDrafts: int = 0


class AccountOut(BaseModel):
    userId: int
    username: str | None = None
    nickname: str | None = None
    createdAt: datetime


class QrTargetOut(BaseModel):
    code: str
    encodes: str = Field(description="二维码里实际编码的 URL")


class EventsOut(BaseModel):
    accepted: int


# ==================== 认证 ====================

@app.post("/api/auth/dev-login", response_model=TokenOut, tags=["认证"],
          summary="开发用登录（正式登录走 /api/auth/wechat）")
def dev_login(user_id: int = 1):
    """只在 ALLOW_DEV_LOGIN=1 时开放。生产环境返回 404。"""
    if os.getenv("ALLOW_DEV_LOGIN") != "1":
        err(404, "NOT_FOUND", "未开放")
    return TokenOut(token=make_token(user_id), userId=user_id)


password_hasher = PasswordHasher()
USERNAME_RE = re.compile(r"^[A-Za-z0-9_]{3,32}$")
EMAIL_RE = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


class RegisterIn(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=12, max_length=128)
    nickname: str | None = Field(default=None, max_length=32)
    email: str | None = Field(default=None, max_length=254)


class LoginIn(BaseModel):
    username: str = Field(min_length=3, max_length=32)
    password: str = Field(min_length=1, max_length=128)


class WechatLoginIn(BaseModel):
    code: str = Field(min_length=1, max_length=256)


def _auth_bucket_key(kind: str, value: str) -> str:
    digest = hashlib.sha256((kind + ":" + value).encode("utf-8")).hexdigest()
    return kind + ":" + digest


def _auth_rate_limited(keys: list[str], limit: int, minutes: int) -> bool:
    if not keys:
        return False
    row = q1("""SELECT coalesce(max(attempts), 0) AS attempts
                  FROM auth_rate_limits
                 WHERE bucket_key = ANY(:keys)
                   AND window_started_at > now() - (:mins * interval '1 minute')""",
             keys=keys, mins=minutes)
    return bool(row and row["attempts"] >= limit)


def _auth_record_attempt(keys: list[str], minutes: int):
    with engine.begin() as conn:
        for key in keys:
            conn.execute(text("""INSERT INTO auth_rate_limits
                    (bucket_key, window_started_at, attempts, updated_at)
                VALUES (:k, now(), 1, now())
                ON CONFLICT (bucket_key) DO UPDATE SET
                  attempts = CASE
                    WHEN auth_rate_limits.window_started_at <= now() - (:mins * interval '1 minute') THEN 1
                    ELSE auth_rate_limits.attempts + 1 END,
                  window_started_at = CASE
                    WHEN auth_rate_limits.window_started_at <= now() - (:mins * interval '1 minute') THEN now()
                    ELSE auth_rate_limits.window_started_at END,
                  updated_at = now()"""), {"k": key, "mins": minutes})


# ==================== 写接口限流（留言 / 情报 / 打卡 / 举报）====================
# 口径：每个滚动小时，按身份（账号或游客）与来源 IP 双桶计数。计数沿用
# auth_rate_limits 这张表——表名是历史遗留，它实际就是通用计数器（桶键是哈希，不存原文）。
# 阈值可用环境变量覆盖，见 docs/API.md「写接口限流」与 deploy/.env.example。
# 广告提交的限流随广告一起冻结，不在这里。
RATE_LIMIT_DEFAULTS: dict[str, tuple[int, int]] = {
    "comment": (10, 30),      # 留言 / 岔路情报：每身份、每 IP
    "visit": (60, 120),       # 打卡
    "report": (10, 30),       # 举报
}
RATE_LIMIT_MESSAGES = {
    "comment": "留言太频繁，请稍后再试",
    "visit": "打卡太频繁，请稍后再试",
    "report": "举报提交过于频繁，请稍后再试",
}


def _rate_limit_table() -> dict[str, tuple[int, int]]:
    """默认值 + 环境变量覆盖。环境变量留空即用默认值，不做隐式 0 值。"""
    table: dict[str, tuple[int, int]] = {}
    for scope, (identity_default, ip_default) in RATE_LIMIT_DEFAULTS.items():
        resolved = []
        for suffix, fallback in (("PER_IDENTITY_HOUR", identity_default),
                                 ("PER_IP_HOUR", ip_default)):
            raw = os.getenv(f"RATE_LIMIT_{scope.upper()}_{suffix}", "").strip()
            resolved.append(int(raw) if raw.isdigit() else fallback)
        table[scope] = (resolved[0], resolved[1])
    return table


RATE_LIMITS = _rate_limit_table()


def _record_rate_event(scope: str, identity: str | None, request: Request,
                       bucket_key: str) -> None:
    """限流事件写库供审计（谁在什么时候被哪一桶拦下）。只存 IP 哈希，不存明文。
    审计写失败不能顶掉限流本身，所以这里吞异常只告警。"""
    # 存纯哈希（不带桶前缀）；桶键里的 ip:<hash> 由它拼出来，需要时能对上
    ip_hash = hashlib.sha256(f"ip:{_request_ip(request)}".encode("utf-8")).hexdigest()
    try:
        with engine.begin() as conn:
            conn.execute(text("""INSERT INTO rate_limit_events
                    (scope, bucket_key, identity, ip_hash, path)
                VALUES (:s, :b, :i, :ip, :p)"""),
                {"s": scope, "b": bucket_key, "i": identity, "ip": ip_hash,
                 "p": request.url.path})
    except Exception as exc:  # noqa: BLE001
        print(f"[rate-limit] 事件写库失败：{exc}", file=sys.stderr)
    print(f"[rate-limit] scope={scope} identity={identity or '-'} "
          f"path={request.url.path} ip={ip_hash[:16]}", file=sys.stderr)


def _rate_check(request: Request, scope: str, identity: str | None) -> list[str]:
    """写接口统一入口。超限抛 429 并记一条限流事件；返回桶键，
    调用方在**写入成功之后**再调 _rate_hit，这样校验失败和重复提交都不占额度。"""
    limit_identity, limit_ip = RATE_LIMITS[scope]
    identity_key = _auth_bucket_key(scope, identity) if identity else None
    ip_key = _auth_bucket_key(f"{scope}-ip", _request_ip(request))
    over_identity = bool(identity_key) and _auth_rate_limited([identity_key], limit_identity, 60)
    over_ip = _auth_rate_limited([ip_key], limit_ip, 60)
    if over_identity or over_ip:
        _record_rate_event(scope, identity, request, identity_key if over_identity else ip_key)
        err(429, "RATE_LIMITED", RATE_LIMIT_MESSAGES[scope])
    return [k for k in (identity_key, ip_key) if k]


def _rate_hit(keys: list[str]) -> None:
    _auth_record_attempt(keys, 60)


# ==================== 公开读取限流 ====================
# 写接口限的是"乱发内容"，这里限的是"批量把公开数据抓走"。
# 只针对匿名可读的 GET：/api/* 与二维码短链 /p/*；/api/me、/api/admin 这类
# 需要登录的接口本来就按账号校验，交给各自的鉴权，不在这里重复限。
# 阈值按来源 IP 双窗口：每分钟挡突发，每小时挡持续拉取；一小时内被挡够多次就临时封禁。
READ_LIMIT_PER_MINUTE = 120        # 正常浏览（一次页面加载几个请求）碰不到
READ_LIMIT_PER_HOUR = 2000
READ_BLOCK_AFTER_TRIPS = 200       # 一小时内被拒这么多**次**才临时封禁：
                                   # 按"被拒次数"而不是"触顶轮次"计，阈值必须高于正常人一次突发的量
                                   # （页面狂点也就几十次），否则会把误触的人当成爬虫封掉。
READ_BLOCK_MINUTES = 60


def _read_limit_config() -> tuple[int, int, int]:
    def pick(name: str, fallback: int) -> int:
        raw = os.getenv(name, "").strip()
        return int(raw) if raw.isdigit() else fallback
    return (pick("RATE_LIMIT_READ_PER_MINUTE_IP", READ_LIMIT_PER_MINUTE),
            pick("RATE_LIMIT_READ_PER_HOUR_IP", READ_LIMIT_PER_HOUR),
            pick("RATE_LIMIT_READ_BLOCK_AFTER_TRIPS", READ_BLOCK_AFTER_TRIPS))


READ_LIMITS = _read_limit_config()


def _limit_response(status: int, code: str, message: str) -> JSONResponse:
    """限流/封禁的响应要和契约里的错误体一致：{error:{code,message}}。"""
    return JSONResponse(status_code=status,
                        content={"error": {"code": code, "message": message}})


def _is_public_read(request: Request) -> bool:
    if request.method != "GET":
        return False
    path = request.url.path
    if path.startswith(("/api/me/", "/api/admin/", "/api/auth/", "/health", "/docs")):
        return False
    return path.startswith("/api/") or path.startswith("/p/")


def _read_limit_response(request: Request) -> JSONResponse | None:
    """超限时返回响应对象（中间件里不能靠抛异常），正常返回 None。"""
    per_minute, per_hour, block_after = READ_LIMITS
    # 清单接口最容易被循环枚举；正常翻页远低于这个阈值。
    if request.url.path in ("/api/routes", "/api/summits"):
        per_minute = min(per_minute, 30)
        per_hour = min(per_hour, 300)
    ip_hash = hashlib.sha256(f"ip:{_request_ip(request)}".encode("utf-8")).hexdigest()
    block_key = _auth_bucket_key("read-block", _request_ip(request))
    if _auth_rate_limited([block_key], 1, READ_BLOCK_MINUTES):
        return _limit_response(403, "READ_BLOCKED",
                               "这个来源的访问频率异常，已临时限制，请稍后再试")
    minute_key = _auth_bucket_key("read-min", _request_ip(request))
    hour_key = _auth_bucket_key("read-hour", _request_ip(request))
    if _auth_rate_limited([minute_key], per_minute, 1):
        _record_rate_event("read", None, request, minute_key)
        trips = q1("""SELECT count(*) AS n FROM rate_limit_events
            WHERE scope = 'read' AND ip_hash = :h AND created_at > now() - interval '1 hour'""",
                   h=ip_hash)["n"]
        if trips >= block_after:
            _auth_record_attempt([block_key], READ_BLOCK_MINUTES)
        return _limit_response(429, "RATE_LIMITED", "读取太频繁，请放慢一点再试")
    if _auth_rate_limited([hour_key], per_hour, 60):
        _record_rate_event("read", None, request, hour_key)
        return _limit_response(429, "RATE_LIMITED", "今天读得有点多，请稍后再试")
    _auth_record_attempt([minute_key], 1)
    _auth_record_attempt([hour_key], 60)
    return None


@app.middleware("http")
async def public_read_rate_limit(request: Request, call_next):
    if _is_public_read(request):
        limited = _read_limit_response(request)
        if limited is not None:
            return limited
    return await call_next(request)


def _reject_duplicate_comment(uid: int, text: str, point_id: int | None = None,
                              segment_id: int | None = None) -> None:
    """同一账号、同一目标、十分钟内字面完全相同的原文：明确拒绝，不当作新留言。
    打卡的重复是靠数据库按"身份+点位+日期"去重；留言没有天然唯一键，所以按原文挡一次。"""
    dup = q1("""SELECT id FROM comments
        WHERE user_id = :uid AND text = :txt AND created_at > now() - interval '10 minutes'
          AND point_id IS NOT DISTINCT FROM :pid AND segment_id IS NOT DISTINCT FROM :sid
        LIMIT 1""", uid=uid, txt=text, pid=point_id, sid=segment_id)
    if dup:
        err(409, "COMMENT_DUPLICATE", "十分钟内已经发过一模一样的一句，换一句再发")


def _merge_guest_records(conn, token: str | None, uid: int):
    if not token:
        return {"mergedVisits": 0, "dropped": 0, "mergedDrafts": 0}
    guest = conn.execute(text("SELECT id, merged_user_id FROM guests WHERE token = :t FOR UPDATE"),
                         {"t": token}).mappings().first()
    if not guest:
        err(404, "GUEST_NOT_FOUND", "游客身份无效，请重新打开扫码页面")
    if guest["merged_user_id"]:
        if guest["merged_user_id"] != uid:
            err(409, "GUEST_ALREADY_MERGED", "这份游客记录已归入另一个账号")
        return {"mergedVisits": 0, "dropped": 0, "mergedDrafts": 0}
    gid = guest["id"]
    affected_dates = [r[0] for r in conn.execute(text(
        "SELECT DISTINCT visit_date FROM visits WHERE guest_id=:g"), {"g": gid}).all()]
    conn.execute(text("DELETE FROM segment_efforts WHERE guest_id=:g"), {"g": gid})
    # Keep each accepted client action mapped to the surviving account visit.
    conn.execute(text("""UPDATE visit_submission_receipts r
        SET canonical_visit_id = u.id
        FROM visits v JOIN visits u ON u.user_id=:uid
          AND u.point_id=v.point_id AND u.visit_date=v.visit_date
        WHERE v.guest_id=:g AND r.canonical_visit_id=v.id"""),
        {"g": gid, "uid": uid})
    dropped = conn.execute(text("""DELETE FROM visits v USING visits u
        WHERE v.guest_id = :g AND u.user_id = :uid
          AND u.point_id = v.point_id AND u.visit_date = v.visit_date"""),
        {"g": gid, "uid": uid}).rowcount
    moved = conn.execute(text("UPDATE visits SET user_id = :uid, guest_id = NULL WHERE guest_id = :g"),
                         {"uid": uid, "g": gid}).rowcount
    conn.execute(text("""INSERT INTO visit_submission_receipts
        (identity_type, identity_id, client_uuid, payload_hash, canonical_visit_id)
        SELECT 'user', :uid, client_uuid, payload_hash, canonical_visit_id
        FROM visit_submission_receipts
        WHERE identity_type='guest' AND identity_id=:g
        ON CONFLICT (identity_type, identity_id, client_uuid) DO NOTHING"""),
        {"uid": uid, "g": gid})
    drafts = conn.execute(text("""INSERT INTO account_arrival_drafts
            (user_id, point_id, private_note, public_comment_draft)
        SELECT :uid, point_id, private_note, public_comment_draft
          FROM guest_arrival_drafts WHERE guest_id = :g
        ON CONFLICT (user_id, point_id) DO UPDATE SET
          private_note = COALESCE(EXCLUDED.private_note, account_arrival_drafts.private_note),
          public_comment_draft = COALESCE(EXCLUDED.public_comment_draft, account_arrival_drafts.public_comment_draft),
          updated_at = now()
        RETURNING id"""), {"uid": uid, "g": gid}).rowcount
    conn.execute(text("UPDATE guests SET merged_user_id = :uid WHERE id = :g"),
                 {"uid": uid, "g": gid})
    for day in affected_dates:
        try:
            with conn.begin_nested():
                reconcile_efforts(conn, "user", uid, day)
        except Exception:
            logging.exception("merged effort reconciliation failed")
    return {"mergedVisits": moved, "dropped": dropped, "mergedDrafts": drafts}


def _request_ip(request: Request) -> str:
    if os.getenv("TRUST_PROXY_HEADERS") == "1":
        forwarded = request.headers.get("x-real-ip", "").strip()
        if forwarded:
            return forwarded
    return request.client.host if request.client else "unknown"


def _validate_auth_input(username: str, email: str | None = None):
    if not USERNAME_RE.fullmatch(username):
        err(400, "USERNAME_INVALID", "用户名需为 3–32 位英文字母、数字或下划线")
    if email and not EMAIL_RE.fullmatch(email):
        err(400, "EMAIL_INVALID", "邮箱格式无效")


@app.post("/api/auth/register", response_model=TokenOut, tags=["认证"],
          responses={400: {"description": "账号字段不合法"}, 409: {"description": "用户名或邮箱已注册"},
                     429: {"description": "注册过于频繁"}},
          summary="注册用户名密码账号，并原子合并当前游客记录")
def register(body: RegisterIn, request: Request,
             x_guest_token: str | None = Header(default=None)):
    username = body.username.strip().lower()
    email = body.email.strip().lower() if body.email else None
    _validate_auth_input(username, email)
    ip_key = _auth_bucket_key("register-ip", _request_ip(request))
    if _auth_rate_limited([ip_key], limit=10, minutes=60):
        err(429, "RATE_LIMITED", "注册请求过于频繁，请稍后再试")
    _auth_record_attempt([ip_key], minutes=60)
    encoded = password_hasher.hash(body.password)
    try:
        with engine.begin() as conn:
            exists_sql = "SELECT 1 FROM users WHERE lower(username) = :u"
            exists_params = {"u": username}
            if email:
                exists_sql += " OR lower(email) = :email"
                exists_params["email"] = email
            exists = conn.execute(text(exists_sql + " LIMIT 1"), exists_params).first()
            if exists:
                err(409, "ACCOUNT_EXISTS", "用户名或邮箱已注册")
            uid = conn.execute(text("""INSERT INTO users (username, password_hash, email, nickname)
                 VALUES (:u, :p, :e, :n) RETURNING id"""),
                               {"u": username, "p": encoded, "e": email,
                                "n": body.nickname.strip() if body.nickname else username}).scalar_one()
            merged = _merge_guest_records(conn, x_guest_token, uid)
    except IntegrityError:
        err(409, "ACCOUNT_EXISTS", "用户名或邮箱已注册")
    return TokenOut(token=make_token(uid), userId=uid, **merged)


@app.post("/api/auth/login", response_model=TokenOut, tags=["认证"],
          responses={401: {"description": "用户名或密码错误"}, 429: {"description": "登录尝试过多"}},
          summary="用户名密码登录，并合并当前游客记录")
def login(body: LoginIn, request: Request,
          x_guest_token: str | None = Header(default=None)):
    username = body.username.strip().lower()
    _validate_auth_input(username)
    ip = _request_ip(request)
    ip_key = _auth_bucket_key("login-ip", ip)
    user_key = _auth_bucket_key("login-user", username)
    if _auth_rate_limited([ip_key, user_key], limit=5, minutes=15):
        err(429, "RATE_LIMITED", "登录尝试过多，请 15 分钟后再试")
    user = q1("SELECT id, password_hash FROM users WHERE lower(username) = :u", u=username)
    valid = False
    if user and user["password_hash"]:
        try:
            valid = password_hasher.verify(user["password_hash"], body.password)
        except (VerifyMismatchError, InvalidHashError):
            valid = False
    if not valid:
        _auth_record_attempt([ip_key, user_key], minutes=15)
        err(401, "LOGIN_FAILED", "用户名或密码错误")
    with engine.begin() as conn:
        conn.execute(text("DELETE FROM auth_rate_limits WHERE bucket_key = :k"), {"k": user_key})
        merged = _merge_guest_records(conn, x_guest_token, user["id"])
    return TokenOut(token=make_token(user["id"]), userId=user["id"], **merged)


@app.post("/api/auth/wechat", response_model=TokenOut, tags=["认证"],
          responses={401: {"description": "微信登录 code 无效"},
                     429: {"description": "登录尝试过多"},
                     502: {"description": "微信登录服务暂不可用"},
                     503: {"description": "服务端未配置微信小程序凭据"}},
          summary="用小程序登录 code 换取 JWT，并原子合并游客记录")
def wechat_login(body: WechatLoginIn, request: Request,
                 x_guest_token: str | None = Header(default=None)):
    app_id = os.getenv("WECHAT_APP_ID", "").strip()
    app_secret = os.getenv("WECHAT_APP_SECRET", "").strip()
    if not app_id or not app_secret:
        err(503, "WECHAT_LOGIN_NOT_CONFIGURED", "服务端尚未配置微信小程序登录凭据")

    ip_key = _auth_bucket_key("wechat-login-ip", _request_ip(request))
    if _auth_rate_limited([ip_key], limit=30, minutes=15):
        err(429, "RATE_LIMITED", "微信登录尝试过多，请稍后再试")
    _auth_record_attempt([ip_key], minutes=15)

    try:
        with httpx.Client(timeout=8, trust_env=False) as client:
            response = client.get(
                "https://api.weixin.qq.com/sns/jscode2session",
                params={"appid": app_id, "secret": app_secret,
                        "js_code": body.code, "grant_type": "authorization_code"},
            )
            response.raise_for_status()
            session = response.json()
    except (httpx.HTTPError, ValueError):
        err(502, "WECHAT_LOGIN_UNAVAILABLE", "暂时无法连接微信登录服务，请稍后重试")

    if not isinstance(session, dict):
        err(502, "WECHAT_LOGIN_UNAVAILABLE", "微信登录服务返回异常，请稍后重试")
    openid = session.get("openid")
    unionid = session.get("unionid") or None
    if not openid or session.get("errcode"):
        err(401, "WECHAT_CODE_INVALID", "微信登录已过期，请重新登录")

    try:
        with engine.begin() as conn:
            user = conn.execute(text("""SELECT id, wx_openid, wx_unionid
                  FROM users WHERE wx_openid = :openid AND deleted_at IS NULL
                  FOR UPDATE"""), {"openid": openid}).mappings().first()
            if not user and unionid:
                user = conn.execute(text("""SELECT id, wx_openid, wx_unionid
                      FROM users WHERE wx_unionid = :unionid AND deleted_at IS NULL
                      FOR UPDATE"""), {"unionid": unionid}).mappings().first()

            if user:
                uid = user["id"]
                conn.execute(text("""UPDATE users SET
                      wx_openid = COALESCE(wx_openid, :openid),
                      wx_unionid = COALESCE(wx_unionid, :unionid),
                      last_seen_at = now()
                    WHERE id = :uid"""),
                    {"openid": openid, "unionid": unionid, "uid": uid})
            else:
                uid = conn.execute(text("""INSERT INTO users
                      (wx_openid, wx_unionid, nickname)
                    VALUES (:openid, :unionid, '山友')
                    ON CONFLICT (wx_openid) DO UPDATE SET last_seen_at = now()
                    RETURNING id"""),
                    {"openid": openid, "unionid": unionid}).scalar_one()

            merged = _merge_guest_records(conn, x_guest_token, uid)
    except IntegrityError:
        err(409, "WECHAT_ACCOUNT_CONFLICT", "微信身份已关联其他账号，请联系平台处理")
    return TokenOut(token=make_token(uid), userId=uid, **merged)


@app.get("/api/me/account", response_model=AccountOut, tags=["认证"], responses=ERR_401,
         summary="当前登录账号的基本资料")
def my_account(uid: int = Depends(require_user)):
    row = q1("""SELECT id, username, nickname, created_at
                  FROM users WHERE id = :uid AND deleted_at IS NULL""", uid=uid)
    if not row:
        err(404, "ACCOUNT_NOT_FOUND", "账号不存在")
    return AccountOut(userId=row["id"], username=row["username"],
                      nickname=row["nickname"], createdAt=row["created_at"])


# ==================== 健康检查 ====================

@app.get("/health", response_model=HealthOut, tags=["系统"])
def health():
    try:
        row = q1("SELECT postgis_version() AS pgis, current_database() AS db")
        counts = q1("""SELECT
            (SELECT count(*) FROM routes)          AS routes,
            (SELECT count(*) FROM route_segments)  AS segments,
            (SELECT count(*) FROM route_peaks)     AS peaks,
            (SELECT count(*) FROM points)          AS points,
            (SELECT count(*) FROM routes
              WHERE status='published' AND geom IS NULL) AS "routesMissingGeom",
            (SELECT count(*) FROM routes
              WHERE status='published'
                AND (path IS NULL OR jsonb_array_length(path) < 2)) AS "routesMissingPath",
            (SELECT count(*) FROM routes
              WHERE status='published'
                AND (profile IS NULL OR jsonb_array_length(profile) < 2))
              AS "routesMissingProfile"
        """)
    except Exception as exc:
        # 不在响应里暴露连接串；只告诉部署者问题发生在 DB 连接/迁移层。
        err(503, "DB_UNAVAILABLE",
            "数据库暂时不可用，请检查 DATABASE_URL、Supabase 迁移和网络区域（%s）"
            % exc.__class__.__name__)
    return HealthOut(ok=True, postgis=row["pgis"], db=row["db"],
                     revision=BUILD_REVISION, **dict(counts))


# ==================== 路书 ====================

@app.get("/api/routes", response_model=RouteListOut, tags=["路书"])
def list_routes(level: str | None = None, limit: int = 20):
    # 排序口径：先是"这座山在互联网上有多热"（mountains.heat_tier，来自名山资料库），
    # 再是本周打卡量，最后按里程兜底。线路本身没有搜索热度字段，热度取自线路峰点
    # 1.5 km 内最近的有资料山头（与 pipeline/match_peaks.py 的 MAX_KM 同一个口径）。
    # 没有任何带热度山头的线路 heatTier 为 null，排在带热度的之后。
    sql = """SELECT id, slug, name, sub, city, km, up, down, hardest_level, hours, kcal,
                    peak_count,
                    (SELECT count(*) FROM route_segments s WHERE s.route_id = r.id) AS segment_count,
                    (SELECT coalesce(sum(seq),0) FROM visits v
                       JOIN points p ON p.id = v.point_id WHERE p.route_id = r.id) AS visit_count,
                    (SELECT count(*) FROM visits v JOIN points p ON p.id = v.point_id
                       WHERE p.route_id = r.id AND v.created_at > now() - interval '7 days')
                       AS weekly_visits,
                    (SELECT to_char(make_interval(secs => min(v.duration_sec)), 'HH24:MI')
                       FROM visits v JOIN points p ON p.id = v.point_id
                       WHERE p.route_id = r.id AND v.duration_sec IS NOT NULL) AS fastest_time,
                    (SELECT u.nickname FROM visits v
                       JOIN points p ON p.id = v.point_id JOIN users u ON u.id = v.user_id
                       WHERE p.route_id = r.id AND v.duration_sec IS NOT NULL
                       ORDER BY v.duration_sec LIMIT 1) AS fastest_holder,
                    heat.heat_tier AS "heatTier"
             FROM routes r
             LEFT JOIN LATERAL (
                SELECT (array_agg(hh.heat_tier ORDER BY hh.rank DESC, hh.dist))[1] AS heat_tier
                  FROM (
                    SELECT m.heat_tier,
                           CASE m.heat_tier WHEN '极热' THEN 4 WHEN '热门' THEN 3
                                            WHEN '较热' THEN 2 WHEN '小众' THEN 1 ELSE 0 END AS rank,
                           ST_Distance(m.geom::geography, mp.geom::geography) AS dist
                      FROM points mp
                      JOIN mountains m ON m.geom IS NOT NULL
                       AND ST_DWithin(m.geom::geography, mp.geom::geography, 1500)
                     WHERE mp.route_id = r.id AND mp.type = 'peak'
                       AND mp.geom IS NOT NULL AND m.heat_tier IS NOT NULL
                  ) hh
             ) heat ON TRUE
             WHERE r.status = 'published'"""
    if level:
        sql += " AND hardest_level = :level"
    # NULLS LAST：没有热度数据的线路不插队到前面
    sql += """ ORDER BY CASE heat.heat_tier WHEN '极热' THEN 4 WHEN '热门' THEN 3
                        WHEN '较热' THEN 2 WHEN '小众' THEN 1 END DESC NULLS LAST,
                  weekly_visits DESC, km LIMIT :limit"""
    return RouteListOut(items=[dict(r) for r in q(sql, level=level, limit=limit)],
                        nextCursor=None)


def _terrain_bounds_from_coords(coords):
    """按 pipeline/build_terrain.py 的 dem_crop 算法复算底图边界。

    Vercel 的函数包里没有静态目录的 sidecar JSON；用同一套 Web Mercator
    窗口（12 级、12% 余量、760×420）算出来的边界与 PNG 完全一致，
    这样线上不用额外打包清单也能把轨迹和地形对齐。
    """
    if not coords or len(coords) < 2:
        return None
    n = 256 * 2 ** 12

    def merc(lat, lon):
        lat = max(-85.0, min(85.0, lat))
        return ((lon + 180.0) / 360.0 * n,
                (1.0 - math.log(math.tan(math.radians(lat)) + 1 / math.cos(math.radians(lat)))
                 / math.pi) / 2.0 * n)

    def inv(x, y):
        return (math.degrees(math.atan(math.sinh(math.pi * (1 - 2 * y / n)))),
                x / n * 360.0 - 180.0)

    xs, ys = zip(*(merc(lat, lon) for lat, lon in coords))
    w, h = max(xs) - min(xs), max(ys) - min(ys)
    pad_x, pad_y = max(w * .12, 60.0), max(h * .12, 60.0)
    cx, cy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2
    w, h = w + pad_x * 2, h + pad_y * 2
    target = 760 / 420
    if w / h < target:
        w = h * target
    else:
        h = w / target
    x0, y0 = round(cx - w / 2), round(cy - h / 2)
    x1, y1 = x0 + round(w), y0 + round(h)
    nw, se = inv(x0, y0), inv(x1, y1)
    return {"west": round(nw[1], 7), "north": round(nw[0], 7),
            "east": round(se[1], 7), "south": round(se[0], 7)}


@app.get("/api/routes/{slug}", response_model=RouteDetail, tags=["路书"], responses=ERR_404)
def get_route(slug: str, authorization: str | None = Header(default=None)):
    # 详情页要的五块数据一次取回。线上函数与 Supabase 不同区时，每次往返都要
    # 几百毫秒到一秒；拆成 5 个查询会把一条线路拖到 7–8 秒，列表一次请求 6 条
    # 详情就必然撞上前端 15 秒超时。这里用相关子查询聚合，只走一次数据库。
    r = q1("""SELECT r.*, ST_AsGeoJSON(r.geom) AS route_geojson,
        (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.no), '[]'::jsonb)
           FROM (
             SELECT rs.id, rs.no, rs.from_km, rs.to_km, rs.km, rs.rise, rs.pct,
                    CASE WHEN rs.pct >= -3 AND (rs.max_rise_m >= 200 OR rs.pct > 3)
                         THEN rs.level ELSE NULL END AS level,
                    rs.kind, rs.source, rs.confirmed,
                    (rs.pct >= -3 AND (rs.max_rise_m >= 200 OR rs.pct > 3))
                      AS difficulty_applicable,
                    CASE WHEN rs.pct < -3 THEN 'descent'
                         WHEN rs.max_rise_m < 200 AND rs.pct <= 3 THEN 'gentle' END
                      AS not_applicable,
                    rs.up_m, rs.down_m, rs.max_rise_m, rs.max_drop_m,
                    link.trail_segment_id, b.id AS board_id
               FROM route_segments rs
               LEFT JOIN route_segment_links link ON link.route_id = rs.route_id
                 AND link.route_segment_no = rs.no
                 AND link.direction = CASE rs.kind WHEN 'climb' THEN 'ascending'
                     WHEN 'desc' THEN 'descending' ELSE 'traverse' END
               LEFT JOIN boards b ON b.trail_segment_id = link.trail_segment_id
                 AND b.board_type = 'segment'
              WHERE rs.route_id = r.id ORDER BY rs.no
           ) s) AS segments_json,
        (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.idx), '[]'::jsonb)
           FROM (
             SELECT rp.idx, rp.km, coalesce(rp.elevation_m, rp.altitude) AS altitude,
                    coalesce(rp.elevation_m, rp.altitude) AS elevation_m,
                    rp.rise, rp.near_cp, rp.near_cp_m,
                    coalesce(rp.name, m.name) AS name,
                    CASE WHEN rp.name IS NOT NULL THEN 'confirmed'
                         ELSE coalesce(m.name_status, rp.name_status) END AS name_status,
                    cand.id AS candidate_id, cand.candidate_name
               FROM route_peaks rp LEFT JOIN mountains m ON m.id = rp.mountain_id
               LEFT JOIN LATERAL (SELECT id, candidate_name FROM route_peak_candidates
                   WHERE route_peak_id = rp.id AND status = 'pending'
                   ORDER BY created_at DESC LIMIT 1) cand ON true
              WHERE rp.route_id = r.id ORDER BY rp.idx
           ) p) AS peaks_json,
        (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.km, c.no), '[]'::jsonb)
           FROM (
             SELECT id, no, name, km, altitude, lat, lng, off_track_m,
                    supply_type, notes, source
               FROM route_checkpoints WHERE route_id = r.id ORDER BY km, no
           ) c) AS checkpoints_json,
        (SELECT to_jsonb(cv) FROM (
             SELECT storage_key, thumbnail_key, photographer, caption
               FROM route_cover_submissions
              WHERE route_id = r.id AND status = 'approved'
              ORDER BY reviewed_at DESC LIMIT 1
           ) cv) AS cover_json
        FROM routes r WHERE r.slug = :slug""", slug=slug)
    if not r:
        err(404, "ROUTE_NOT_FOUND", "线路不存在")
    # 段难度规则只在这里、pipeline/build.py 和 migration 0008 三处出现，必须一致：
    # 定级看段内最大连续爬升（max_rise_m ≥ 200 m）与净坡度（> 3%）；净下坡（< −3%）不定级。
    segs = r["segments_json"] or []
    peaks = r["peaks_json"] or []
    cps = r["checkpoints_json"] or []
    cover = r["cover_json"]
    d = dict(r)
    coordinates = []
    if d.get("route_geojson"):
        coordinates = [[lat, lon] for lon, lat in json.loads(d["route_geojson"]).get("coordinates", [])]
    web_dir = pathlib.Path(os.getenv("STATIC_DIR", "/srv/web"))
    if not web_dir.is_dir():
        web_dir = pathlib.Path(__file__).resolve().parents[2] / "app" / "web"
    terrain_dir = web_dir / "terrain"
    # 地形图在仓库里是 app/web/terrain/。线上静态资源由 Vercel 直接从 app/ 提供，
    # 所以必须走 /app/web/terrain/…；旧的 /terrain/… 只在本机静态根挂载时成立，
    # 部署后会 404，轨迹图就没有地形底图了。
    terrain_url = f"/app/web/terrain/{slug}.png"
    terrain_bounds = _terrain_bounds_from_coords(coordinates)
    terrain_contour = None
    if (terrain_dir / f"{slug}.png").is_file():
        bounds_file = terrain_dir / f"{slug}.json"
        if bounds_file.is_file():
            terrain_meta = json.loads(bounds_file.read_text(encoding="utf-8"))
            terrain_bounds = {k: terrain_meta[k] for k in ("west", "south", "east", "north")}
            # 底图 sidecar 里等高距的键历史上有两种写法，两个都认（新产物写 contour_steps_m）。
            terrain_contour = {}
            for src, dst in (("contour_origin_m", "contour_origin_m"),
                             ("contour_steps_m", "contour_steps_m"),
                             ("contour_interval_m", "contour_steps_m")):
                if src in terrain_meta and dst not in terrain_contour:
                    terrain_contour[dst] = terrain_meta[src]
    keys = ("id", "slug", "name", "sub", "city", "km", "up", "down", "hardest_level", "kind", "hours",
            "kcal", "est", "peak_count", "path", "profile")
    elevation_m = d.get("elevation_m") or []
    uid = None
    if authorization and authorization.lower().startswith("bearer "):
        try:
            uid = require_user(authorization)
        except HTTPException:
            uid = None
    return RouteDetail(**{k: d[k] for k in keys},
                       elevation_m=elevation_m,
                       can_maintain_route=_route_board_maintainer(r["id"], uid),
                       coverUrl=("/media/" + cover["storage_key"]) if cover else None,
                       coverThumbnailUrl=("/media/" + cover["thumbnail_key"]) if cover else None,
                       coverByline=(cover["photographer"] if cover else None),
                       coordinates=coordinates, terrain_url=terrain_url,
                       terrain_bounds=terrain_bounds, terrain_contour=terrain_contour,
                       segments=[dict(s) for s in segs],
                       peaks=[dict(p) for p in peaks],
                       checkpoints=[dict(c) for c in cps])


def _route_board_maintainer(route_id: int, uid: int) -> bool:
    if uid is None:
        return False
    return bool(q1("""SELECT 1 AS ok
        FROM route_peaks rp
        JOIN mountains m ON m.id = rp.mountain_id
        JOIN mountain_members mm ON mm.mountain_id = m.id
        WHERE rp.route_id = :route_id
          AND mm.user_id = :uid AND mm.status = 'active'
        LIMIT 1""", route_id=route_id, uid=uid))


class PeakNameCandidateIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)


class CheckpointCreateIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    km: float = Field(ge=0)
    supply_type: str | None = Field(default=None, max_length=80)
    notes: str | None = Field(default=None, max_length=1000)


@app.post("/api/routes/{slug}/peaks/{idx}/name-candidates", tags=["路书"])
def suggest_route_peak_name(slug: str, idx: int, body: PeakNameCandidateIn,
                            uid: int = Depends(require_user)):
    peak = q1("""SELECT rp.id, rp.route_id FROM route_peaks rp JOIN routes r ON r.id = rp.route_id
                 WHERE r.slug = :slug AND rp.idx = :idx""", slug=slug, idx=idx)
    if not peak:
        err(404, "ROUTE_PEAK_NOT_FOUND", "未找到这座线路山顶")
    name = body.name.strip()
    if not name:
        err(422, "PEAK_NAME_EMPTY", "山峰名称不能为空")
    if q1("SELECT 1 AS ok FROM route_peak_candidates WHERE route_peak_id = :pid AND status = 'pending' LIMIT 1",
          pid=peak["id"]):
        err(409, "PEAK_NAME_SUGGESTION_PENDING", "这座山顶已有待确认的名称建议")
    try:
        row = q1("""INSERT INTO route_peak_candidates
            (route_peak_id, source, candidate_name, status)
            VALUES (:pid, 'user', :name, 'pending')
            RETURNING id""", pid=peak["id"], name=name)
    except Exception:
        err(409, "PEAK_NAME_SUGGESTION_EXISTS", "这个峰名建议已存在")
    return {"id": row["id"], "status": "pending"}


@app.post("/api/routes/{slug}/peaks/{idx}/name-candidates/review", tags=["路书"])
def review_route_peak_name(slug: str, idx: int, body: dict[str, Any],
                           uid: int = Depends(require_user)):
    candidate_id = int(body.get("candidate_id", 0))
    decision = body.get("decision")
    if decision not in ("accepted", "rejected"):
        err(422, "INVALID_DECISION", "审核操作无效")
    peak = q1("""SELECT rp.id, rp.route_id, rp.mountain_id FROM route_peaks rp
                 JOIN routes r ON r.id = rp.route_id WHERE r.slug = :slug AND rp.idx = :idx""",
              slug=slug, idx=idx)
    if not peak:
        err(404, "ROUTE_PEAK_NOT_FOUND", "未找到这座线路山顶")
    point = q1("""SELECT id FROM points WHERE mountain_id = :mid AND type = 'peak' LIMIT 1""",
               mid=peak["mountain_id"])
    if not point or (not _is_maintainer_of(point, uid) and not _is_board_collaborator(point["id"], uid)):
        err(403, "ROUTE_MAINTAINER_REQUIRED", "只有关联山头的维护人可以审核峰名")
    candidate = q1("""UPDATE route_peak_candidates c SET status = :decision,
        reviewed_by = :uid, reviewed_at = now()
        FROM route_peaks rp, routes r
        WHERE c.id = :cid AND c.route_peak_id = rp.id AND rp.id = :pid
          AND r.id = rp.route_id AND r.slug = :slug AND c.status = 'pending'
        RETURNING c.candidate_name""", decision=decision, uid=uid, cid=candidate_id,
        pid=peak["id"], slug=slug)
    if not candidate:
        err(404, "PEAK_NAME_CANDIDATE_NOT_FOUND", "未找到待审核的峰名建议")
    if decision == "accepted":
        with engine.begin() as conn:
            conn.execute(text("""UPDATE route_peaks SET name = :name, name_status = 'confirmed'
                WHERE id = :pid"""), {"name": candidate["candidate_name"], "pid": peak["id"]})
            if peak["mountain_id"]:
                conn.execute(text("""UPDATE mountains SET name = :name, name_status = 'confirmed',
                    updated_at = now() WHERE id = :mid"""),
                    {"name": candidate["candidate_name"], "mid": peak["mountain_id"]})
                conn.execute(text("""UPDATE route_peaks SET name = :name, name_status = 'confirmed'
                    WHERE mountain_id = :mid"""),
                    {"name": candidate["candidate_name"], "mid": peak["mountain_id"]})
    elif decision == "rejected":
        q("""UPDATE route_peaks SET name_status = CASE WHEN name IS NULL THEN 'unconfirmed' ELSE 'confirmed' END
             WHERE id = :pid""", pid=peak["id"])
    return {"status": decision}


@app.post("/api/routes/{slug}/checkpoints", tags=["路书"], status_code=201)
def create_route_checkpoint(slug: str, body: CheckpointCreateIn,
                            uid: int = Depends(require_user)):
    route = q1("SELECT id, km, geom, elevation_m FROM routes WHERE slug = :slug AND status = 'published'", slug=slug)
    if not route:
        err(404, "ROUTE_NOT_FOUND", "线路不存在")
    if route["geom"] is None:
        err(422, "CHECKPOINT_POSITION_UNAVAILABLE", "这条线路暂时没有可用的地理轨迹")
    if body.km > float(route["km"]):
        err(422, "CHECKPOINT_KM_OUT_OF_RANGE", "CP 里程不能超过路线全长")
    if not _route_board_maintainer(route["id"], uid):
        err(403, "ROUTE_MAINTAINER_REQUIRED", "只有本线路关联山头的维护人可以新增 CP")
    fraction = min(1.0, max(0.0, body.km / float(route["km"])))
    pos = q1("""SELECT ST_Y(p) AS lat, ST_X(p) AS lng
        FROM routes r, LATERAL ST_LineInterpolatePoint(r.geom, :fraction) p
        WHERE r.id = :rid""", fraction=fraction, rid=route["id"])
    samples = route.get("elevation_m") or []
    if not pos or len(samples) < 2:
        err(422, "CHECKPOINT_POSITION_UNAVAILABLE", "无法从路线轨迹计算 CP 位置")
    sample = fraction * (len(samples) - 1)
    lo = int(sample)
    hi = min(len(samples) - 1, lo + 1)
    altitude = round(float(samples[lo]) + (float(samples[hi]) - float(samples[lo])) * (sample - lo))
    with engine.begin() as conn:
        conn.execute(text("SELECT pg_advisory_xact_lock(:route_id)"), {"route_id": route["id"]})
        result = conn.execute(text("""INSERT INTO route_checkpoints
            (route_id, no, name, km, altitude, lat, lng, geom, supply_type, notes, source)
            SELECT :rid, coalesce(max(no), 0) + 1, :name, :km, :alt, :lat, :lng,
                   ST_SetSRID(ST_MakePoint(:lng, :lat), 4326), :supply, :notes, 'maintainer'
            FROM route_checkpoints WHERE route_id = :rid RETURNING id"""),
            {"rid": route["id"], "name": body.name.strip(), "km": body.km, "alt": altitude,
             "lat": pos["lat"], "lng": pos["lng"], "supply": body.supply_type,
             "notes": body.notes}).mappings().first()
    return {"id": result["id"], "name": body.name.strip(), "km": body.km,
            "altitude": altitude, "lat": pos["lat"], "lng": pos["lng"],
            "supply_type": body.supply_type, "notes": body.notes, "source": "maintainer"}


# ==================== 点位 ====================

class PeakItem(BaseModel):
    id: int
    origin: Literal["route", "user"] = Field(
        default="route", description="route = GPX 自动识别的线路山顶；user = 用户自建点位")
    code: str | None = Field(default=None, description="用户自建点位的编号")
    route_slug: str | None = Field(default=None, description="用户自建点位没有所属线路")
    route_name: str | None = None
    city: str | None = Field(default=None, description="所在城市 / 区域")
    level: Literal["easy", "mid", "hard", "hidden"] = Field(
        default="mid", description="所属线路最难段的等级")
    idx: int = 0
    km: float = 0
    altitude: int
    rise: int = Field(description="自上一个山顶（或起点）的爬升")
    name: str | None = Field(default=None, description="主峰真名；空表示待维护人命名")
    lat: float | None = None
    lng: float | None = None
    weekly_heat: int = Field(default=0, description="本周热度：该线路近 7 天打卡人次")


class PointBrief(BaseModel):
    id: int
    code: str
    type: Literal["peak", "junction", "trailhead"]
    name: str | None = Field(default=None, description="空 = 名称待定")
    route_name: str | None = None
    # 线路识别出的点位可能没有逐点难度；此时沿用所属线路的综合难度。
    level: Literal["easy", "mid", "hard", "hidden"] = "mid"
    altitude: int | None = None
    status: Literal["draft", "published"]
    visit_count: int


@app.get("/api/points", response_model=list[PointBrief], tags=["点位"],
         summary="点位台账（维护台用）")
def list_points(limit: int = 200):
    rows = q("""SELECT pt.id, pt.code, pt.type, pt.name, r.name AS route_name,
                       coalesce(pt.level, r.hardest_level, 'mid') AS level,
                       pt.altitude, pt.status,
                       (SELECT count(*) FROM visits v WHERE v.point_id = pt.id) AS visit_count
                FROM points pt LEFT JOIN routes r ON r.id = pt.route_id
                ORDER BY pt.id LIMIT :limit""", limit=limit)
    return [PointBrief(**dict(r)) for r in rows]


@app.get("/api/mountains", response_model=list[dict], tags=["点位"],
         summary="山头清单：给点位关联与维护选择用")
def list_mountains(keyword: str | None = None, limit: int = 400):
    limit = min(max(limit, 1), 1000)
    rows = q("""SELECT m.id, m.name, m.region,
                       (SELECT count(*) FROM points p WHERE p.mountain_id = m.id)
                         AS "pointCount"
                  FROM mountains m
                 WHERE m.name IS NOT NULL AND m.name <> ''
                   AND (CAST(:kw AS text) IS NULL OR m.name ILIKE :like)
                 ORDER BY m.name, m.id LIMIT :limit""",
             kw=keyword, like=f"%{keyword}%" if keyword else None, limit=limit)
    return [dict(row) for row in rows]


class PointPatch(BaseModel):
    name: str | None = None
    level: Literal["easy", "mid", "hard", "hidden"] | None = None
    altitude: int | None = None
    guide: dict[str, Any] | None = Field(default=None, description="{arrow,title,desc,next}")
    status: Literal["draft", "published"] | None = None
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)


@app.patch("/api/points/{point_id}", response_model=PointDetail, tags=["点位"],
           responses={**ERR_401, **ERR_404},
           summary="改点位内容。编号不可改——标牌已经印出去了")
def patch_point(point_id: int, body: PointPatch, uid: int = Depends(require_user)):
    point = q1("SELECT id, code, maintainer_id, name, level, altitude, guide, status, version FROM points WHERE id = :id", id=point_id)
    if not point:
        err(404, "POINT_NOT_FOUND", "点位不存在")
    if not _is_maintainer_of(point, uid):
        err(403, "NOT_MAINTAINER", "只能修改自己维护的点位")
    changed = body.model_dump(exclude_none=True)
    lat, lng = changed.pop("lat", None), changed.pop("lng", None)
    if (lat is None) != (lng is None):
        err(400, "LOCATION_INCOMPLETE", "经纬度必须同时提供")
    sets, params = [], {"id": point_id}
    for k, v in changed.items():
        if k == "guide":
            sets.append("guide = CAST(:guide AS jsonb)")
            params["guide"] = json.dumps(v, ensure_ascii=False)
        else:
            sets.append(f"{k} = :{k}")
            params[k] = v
    if lat is not None:
        sets.append("geom = ST_SetSRID(ST_MakePoint(:lng, :lat), 4326)")
        params.update(lat=lat, lng=lng)
        changed.update(lat=lat, lng=lng)
    if not sets:
        err(400, "NOTHING_TO_UPDATE", "没有要改的字段")
    with engine.begin() as conn:
        conn.execute(text(f"UPDATE points SET {', '.join(sets)}, version = version + 1 "
                          f"WHERE id = :id"), params)
        _audit(conn, uid, "point.update", "point", point_id,
               {k: point[k] for k in changed if k in point}, changed, point_id=point_id)
    return get_point(q1("SELECT code FROM points WHERE id=:i", i=point_id)["code"])


class TrailheadCandidateOut(BaseModel):
    id: int
    code: str
    name: str | None = None
    routeId: int | None = None
    routeName: str | None = None
    mountainId: int | None = None
    mountainName: str | None = None
    lat: float
    lng: float
    needsMountain: bool = False
    canReview: bool = False


@app.get("/api/me/trailhead-candidates", response_model=list[TrailheadCandidateOut],
         tags=["点位"], responses=ERR_401,
         summary="待核验的山脚候选：轨迹起点只是候选，维护人确认后才可打卡")
def my_trailhead_candidates(uid: int = Depends(require_user)):
    """只返回当前用户有权处理的山脚候选。

    山头负责人处理自己山头的候选；平台地理审核员（place_curator）能处理全部，
    包括轨迹里没有识别出山顶、暂时无法归属山头的候选。
    """
    curator = _is_place_curator(uid)
    rows = q("""SELECT p.id, p.code, p.name, p.route_id AS "routeId",
                       r.name AS "routeName", p.mountain_id AS "mountainId",
                       m.name AS "mountainName",
                       ST_Y(p.geom) AS lat, ST_X(p.geom) AS lng,
                       coalesce((p.guide->>'needs_mountain')::boolean, false)
                         AS "needsMountain"
                  FROM points p
                  LEFT JOIN routes r ON r.id = p.route_id
                  LEFT JOIN mountains m ON m.id = p.mountain_id
                 WHERE p.type = 'trailhead' AND p.status = 'draft'
                   AND p.geom IS NOT NULL
                   AND p.guide->>'candidate_source' = 'route_start'
                   AND coalesce(p.guide->>'trailhead_review', 'draft') = 'draft'
                   AND (:curator OR EXISTS (
                         SELECT 1 FROM mountain_members mm
                          WHERE mm.mountain_id = p.mountain_id
                            AND mm.user_id = :uid AND mm.status = 'active'
                            AND mm.role = 'owner'))
                 ORDER BY (p.mountain_id IS NULL) DESC, m.name NULLS LAST, p.name, p.id
                 LIMIT 300""", uid=uid, curator=curator)
    return [TrailheadCandidateOut(**dict(row), canReview=True) for row in rows]


class TrailheadReviewIn(BaseModel):
    decision: Literal["publish", "reject"]
    name: str | None = Field(default=None, max_length=120)
    lat: float | None = Field(default=None, ge=-90, le=90)
    lng: float | None = Field(default=None, ge=-180, le=180)
    mountainId: int | None = None
    note: str | None = Field(default=None, max_length=500)


@app.post("/api/points/{point_id}/trailhead-review", response_model=dict,
          tags=["点位"], responses={**ERR_401, **ERR_403, **ERR_404},
          summary="核验山脚候选：确认名称与坐标后发布，或标记不是山脚")
def review_trailhead(point_id: int, body: TrailheadReviewIn,
                     uid: int = Depends(require_user)):
    point = q1("""SELECT id, code, name, mountain_id, status,
                         ST_Y(geom) AS lat, ST_X(geom) AS lng, guide
                    FROM points
                   WHERE id = :id AND type = 'trailhead'
                     AND guide->>'candidate_source' = 'route_start'""", id=point_id)
    if not point:
        err(404, "TRAILHEAD_CANDIDATE_NOT_FOUND", "没有这个山脚候选")
    if point["status"] != "draft":
        err(409, "TRAILHEAD_ALREADY_REVIEWED", "这个山脚点已经处理过了")
    curator = _is_place_curator(uid)
    if not curator:
        owned = point["mountain_id"] and _is_mountain_owner(point["mountain_id"], uid)
        if not owned:
            err(403, "TRAILHEAD_REVIEW_FORBIDDEN", "只有该山头负责人或平台地理审核员可以核验")
        if body.mountainId and body.mountainId != point["mountain_id"]:
            err(403, "TRAILHEAD_MOUNTAIN_FORBIDDEN", "只有平台地理审核员可以改所属山头")
    target_mountain = (body.mountainId if curator and body.mountainId
                       else point["mountain_id"])

    if body.decision == "reject":
        marker = {"trailhead_review": "rejected",
                  "review_note": (body.note or "").strip() or None,
                  "reviewed_by": uid}
        with engine.begin() as conn:
            conn.execute(text("""UPDATE points
                SET guide = coalesce(guide, '{}'::jsonb) || CAST(:marker AS jsonb),
                    version = version + 1
                WHERE id = :id"""),
                {"id": point_id, "marker": json.dumps(marker, ensure_ascii=False)})
            _audit(conn, uid, "trailhead.reject", "point", point_id,
                   {"status": point["status"]}, marker, body.note, point_id=point_id)
        return {"ok": True, "status": "draft", "review": "rejected"}

    name = (body.name if body.name is not None else (point["name"] or "")).strip()
    if len(name) < 2:
        err(422, "TRAILHEAD_NAME_REQUIRED", "发布前请填写山脚名称")
    lat = body.lat if body.lat is not None else point["lat"]
    lng = body.lng if body.lng is not None else point["lng"]
    if lat is None or lng is None:
        err(422, "TRAILHEAD_LOCATION_REQUIRED", "发布前请确认山脚坐标")
    if not target_mountain:
        err(422, "TRAILHEAD_MOUNTAIN_REQUIRED", "请先关联这座山脚所属的山头")

    marker = {"trailhead_review": "published",
              "review_note": (body.note or "").strip() or None,
              "reviewed_by": uid}
    with engine.begin() as conn:
        conn.execute(text("""UPDATE points
            SET name = :name,
                mountain_id = :mid,
                geom = ST_SetSRID(ST_MakePoint(:lng, :lat), 4326),
                status = 'published',
                guide = coalesce(guide, '{}'::jsonb) || CAST(:marker AS jsonb),
                version = version + 1
            WHERE id = :id"""),
            {"id": point_id, "name": name, "mid": target_mountain,
             "lat": lat, "lng": lng,
             "marker": json.dumps(marker, ensure_ascii=False)})
        _audit(conn, uid, "trailhead.publish", "point", point_id,
               {"name": point["name"], "lat": point["lat"], "lng": point["lng"],
                "mountainId": point["mountain_id"], "status": point["status"]},
               {"name": name, "lat": lat, "lng": lng,
                "mountainId": target_mountain, "status": "published"},
               body.note, point_id=point_id)
    return {"ok": True, "status": "published", "name": name,
            "mountainId": target_mountain}


@app.get("/api/peaks", response_model=list[PeakItem], tags=["点位"],
         summary="全部山顶，按海拔排序（线路 GPX 识别 + 用户自建点位合并）")
def list_peaks(limit: int = 200, route: str | None = None):
    """一支数据源：线路 GPX 自动识别的山顶 + 用户自己上传 GPX 建的点位。
    两者都是 GPX 算出来的，没道理分成两个列表——筛选某条线路时才只看那一条。"""
    from_route = """SELECT p.id, 'route' AS origin, NULL AS code,
                    r.slug AS route_slug, r.name AS route_name, p.idx, p.km,
                    p.altitude, p.rise, p.name, p.lat, p.lng,
                    r.city, coalesce(r.hardest_level, 'mid') AS level,
                    (SELECT count(*) FROM visits v JOIN points pt ON pt.id = v.point_id
                       WHERE pt.route_id = r.id AND v.created_at > now() - interval '7 days')
                       AS weekly_heat
             FROM route_peaks p JOIN routes r ON r.id = p.route_id"""
    if route:
        return [PeakItem(**dict(r)) for r in q(
            from_route + " WHERE r.slug = :route ORDER BY p.altitude DESC, p.idx LIMIT :limit",
            limit=limit, route=route)]
    sql = from_route + """
             UNION ALL
             SELECT pt.id, 'user' AS origin, pt.code,
                    NULL, NULL, 0, coalesce(pt.track_km, 0),
                    pt.altitude, coalesce(pt.track_up, 0)::int, pt.name,
                    ST_Y(pt.geom), ST_X(pt.geom), NULL, coalesce(pt.level, 'mid'),
                    (SELECT count(*) FROM visits v WHERE v.point_id = pt.id
                       AND v.created_at > now() - interval '7 days') AS weekly_heat
             FROM points pt
             WHERE pt.type = 'peak' AND pt.status = 'published'
               AND pt.track_path IS NOT NULL AND pt.altitude IS NOT NULL
             ORDER BY altitude DESC, origin DESC, id DESC LIMIT :limit"""
    return [PeakItem(**dict(r)) for r in q(sql, limit=limit)]

def _board_point_ids(point_id: int) -> list[int]:
    rows = q("""SELECT peer.id FROM points src JOIN points peer
        ON peer.mountain_id = src.mountain_id AND peer.type = 'peak'
        WHERE src.id = :pid AND src.type = 'peak'
        UNION SELECT :pid""", pid=point_id)
    return [r["id"] for r in rows]


class NearbyRequest(BaseModel):
    lat: float = Field(ge=-90, le=90)
    lng: float = Field(ge=-180, le=180)
    accuracyM: int = Field(ge=0, le=1000)


@app.post("/api/points/nearby", tags=["点位"])
def nearby_points(body: NearbyRequest, request: Request):
    keys = _rate_check(request, "visit", "nearby")
    if body.accuracyM > MAX_ACCURACY_M:
        err(422, "LOCATION_INACCURATE",
            "定位精度不足（需不超过 50 米），请到开阔处重试或扫码")
    rows = q("""SELECT p.id AS "pointId", p.code, p.name, p.type AS kind,
          p.route_id AS "routeId", r.name AS "routeName",
          p.mountain_id AS "mountainId", m.name AS "mountainName",
          round(ST_Distance(p.geom::geography,
            ST_SetSRID(ST_MakePoint(:lng,:lat),4326)::geography))::int AS "distanceM",
          CASE WHEN p.type='peak' THEN :peak_radius ELSE :other_radius END
            AS "checkinRadiusM",
          TRUE AS "canCheckIn"
          FROM points p
          LEFT JOIN routes r ON r.id = p.route_id
          LEFT JOIN mountains m ON m.id = p.mountain_id
         WHERE p.status='published' AND p.geom IS NOT NULL
           AND ST_DWithin(p.geom::geography,
             ST_SetSRID(ST_MakePoint(:lng,:lat),4326)::geography,
             CASE WHEN p.type='peak' THEN :peak_radius ELSE :other_radius END)
         ORDER BY "distanceM", p.id LIMIT 20""",
        lat=body.lat, lng=body.lng, peak_radius=CHECKIN_RADIUS_PEAK_M,
        other_radius=CHECKIN_RADIUS_OTHER_M)
    _rate_hit(keys)
    return [dict(row) for row in rows]


def _window_since(window: str) -> datetime:
    """窗口起点（Asia/Shanghai，周一为一周起点）。周/月/年/历史四个口径共用。"""
    local = datetime.now(ZoneInfo("Asia/Shanghai"))
    if window == "week":
        return (local - timedelta(days=local.weekday())).replace(
            hour=0, minute=0, second=0, microsecond=0)
    if window == "month":
        return local.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    if window == "year":
        return local.replace(month=1, day=1, hour=0, minute=0, second=0, microsecond=0)
    return datetime(1970, 1, 1, tzinfo=timezone.utc)


@app.get("/api/boards/mountains", response_model=dict, tags=["榜单"])
def board_mountains(window: Literal["week", "month", "year", "all"] = "week",
                    metric: Literal["people", "visits", "hot"] = "people",
                    limit: int = 5):
    """山头榜，三个口径分开列、分开说：

    * `metric=people`：窗口内按去重**人数**排 —— 首页"打卡人数榜"
    * `metric=visits`：窗口内按到访**人次**排 —— 占山为王"登顶榜"（同一人多次也算）
    * `metric=hot`   ：按数据里的**热度档 + 年接待量**排 —— "门票卖得多的那些山"，
      不依赖打卡量（有的山确实没什么人在这里打过卡，但它就是热门景区）

    每条都带上 `heatTier` / `annualVisits`，前端能把"为什么它排前面"写出来。
    """
    since = _window_since(window)
    # 年接待量是自由文本（"2024 年接待游客 941.09 万人次"）：要取"万"前面那个数，
    # 不能取第一个数字——那是年份，会把每座山都算成 2024 万。
    annual_weight = """CASE WHEN m.annual_visits LIKE '%%万%%'
        THEN coalesce((regexp_match(m.annual_visits, '([0-9]+([.][0-9]+)?)[[:space:]]*万'))[1]
                      ::numeric, 0) * 10000
        ELSE 0 END"""
    heat_rank = """CASE m.heat_tier WHEN '极热' THEN 4 WHEN '热门' THEN 3
        WHEN '较热' THEN 2 WHEN '小众' THEN 1 ELSE 0 END"""
    limit = min(max(limit, 1), 50)
    if metric == "hot":
        rows = q("""SELECT m.id AS "mountainId", m.name, m.heat_tier AS "heatTier",
            m.annual_visits AS "annualVisits",
            /* 热门榜不依赖打卡：随便取这座山的一个点位当入口，没有到访也能点进去 */
            (SELECT min(p.code) FROM points p WHERE p.mountain_id = m.id AND p.type = 'peak')
              AS "pointCode",
            coalesce(count(v.id), 0) AS visits,
            count(DISTINCT CASE WHEN v.user_id IS NOT NULL THEN 'u:' || v.user_id::text
                                WHEN v.guest_id IS NOT NULL THEN 'g:' || v.guest_id::text END)
              AS people
          FROM mountains m
          LEFT JOIN points p ON p.mountain_id = m.id
          LEFT JOIN visits v ON v.point_id = p.id AND v.occurred_at >= :since
         WHERE m.heat_tier IS NOT NULL
         GROUP BY m.id, m.name, m.heat_tier, m.annual_visits
         ORDER BY """ + heat_rank + """ DESC, """ + annual_weight + """ DESC, visits DESC
         LIMIT :limit""", since=since, limit=limit)
        return {"window": window, "metric": metric, "items": [dict(r) for r in rows]}
    order = "people DESC, visits DESC" if metric == "people" else "visits DESC, people DESC"
    rows = q("""SELECT p.mountain_id AS "mountainId",
        coalesce(m.name, min(p.name), '编号 ' || min(p.code)) AS name,
        /* 榜上点进去要能落到具体点位：给一个代表编号（该山到访过的最小 code，
           基本就是主峰那个码）。前端用它拼 /app/#/peaks/p-<code>。 */
        min(p.code) AS "pointCode",
        count(*) AS visits,
        count(DISTINCT CASE WHEN v.user_id IS NOT NULL
                            THEN 'u:' || v.user_id::text
                            ELSE 'g:' || v.guest_id::text END) AS people,
        max(m.heat_tier) AS "heatTier",
        max(m.annual_visits) AS "annualVisits"
      FROM visits v JOIN points p ON p.id = v.point_id
      JOIN mountains m ON m.id = p.mountain_id
     WHERE v.occurred_at >= :since AND p.mountain_id IS NOT NULL
     GROUP BY 1, m.name ORDER BY """ + order + " LIMIT :limit",
        since=since, limit=limit)
    return {"window": window, "metric": metric,
            "items": [dict(r) for r in rows]}


@app.get("/api/boards/climbers", response_model=dict, tags=["榜单"])
def board_climbers(window: Literal["week", "month", "year", "all"] = "week",
                   limit: int = 10,
                   authorization: str | None = Header(default=None)):
    """位次榜：按"窗口内打过卡的不同山头数"排，其次看总打卡次数。

    只公开昵称与计数，不带账号 ID、不带坐标。登录时额外返回自己的位次——
    即使不在榜单前几名，也能看到"我第几"。
    """
    since = _window_since(window)
    rows = q("""SELECT coalesce(u.nickname, g.nickname, '山友') AS nickname,
        v.user_id AS uid, v.guest_id AS gid, p.mountain_id AS "mountainId"
      FROM visits v JOIN points p ON p.id = v.point_id
      LEFT JOIN users u ON u.id = v.user_id
      LEFT JOIN guests g ON g.id = v.guest_id
     WHERE v.occurred_at >= :since AND p.mountain_id IS NOT NULL""", since=since)
    tally: dict[str, dict] = {}
    for row in rows:
        who = ("u:%d" % row["uid"]) if row["uid"] is not None else ("g:%d" % row["gid"])
        item = tally.setdefault(who, {"who": who, "nickname": row["nickname"],
                                      "visits": 0, "mountains": set()})
        item["visits"] += 1
        item["mountains"].add(row["mountainId"])
    ranked = sorted(tally.values(),
                    key=lambda item: (-len(item["mountains"]), -item["visits"], item["who"]))
    public = [{"rank": index + 1, "nickname": item["nickname"],
               "summits": len(item["mountains"]), "visits": item["visits"]}
              for index, item in enumerate(ranked)]
    mine = None
    if authorization:
        # 令牌过期不该让榜单整页报错：读不出身份就只当没有"我的位次"。
        try:
            uid = require_user(authorization)
        except HTTPException:
            uid = None
        if uid is not None:
            for index, item in enumerate(ranked):
                if item["who"] == "u:%d" % uid:
                    mine = public[index]
                    break
    return {"window": window, "sampleSize": len(public),
            "items": public[:min(max(limit, 1), 50)], "mine": mine}


# ==================== 占山为王申请（山大王 / 版主） ====================
# 口径（2026-10-16 起）：接管一座已有山头不再是"先到先得、点了就给"——
# 申请人要写清为什么申请、成为版主后的期待、一个月能去几次，然后进 3 天审核期：
#   * kind=solo（山大王）：审核通过后独占这座山；同一座山只有一个，通过时会把
#     同一座山其它待审申请自动驳回并写明理由（避免"谁先被点通过"的暗箱感）。
#   * kind=clan（山寨）：审核通过后成为协作者，同一座山可以多人；第一个人顺带
#     成为维护人（负责物料与标牌对接），后面的人走协作身份。
# 自建全新山头（POST /api/claims，新编号新二维码）不走审核：它不跟任何人抢，
# 而且二维码得当场印出来贴，卡在审核里等于这条链路废掉。
MASTER_APPLICATION_DAYS = 3


class MasterApplicationIn(BaseModel):
    code: str = Field(description="要申请维护的点位编号")
    kind: Literal["solo", "clan"] = Field(default="solo", description="solo=山大王（单人）· clan=山寨（多人协作）")
    reason: str = Field(min_length=20, max_length=1000, description="为什么申请这座山（≥20 字）")
    expectations: str = Field(min_length=10, max_length=1000, description="成为版主后的期待（≥10 字）")
    visitsPerMonth: int = Field(ge=1, le=30, description="一个月能去几次")
    nickname: str | None = None
    contact: str | None = None


def _expire_master_applications(conn) -> int:
    """3 天审核期到了还没处理的申请置为 expired。

    这里选择"失效"而不是"自动通过"：山大王是独占身份，没人看就自动给出去，
    抢注的人只要挑没人上班的时间提交就行。失效后申请人可以重新提交，
    页面上会写清楚"超过 3 天没人处理，可以重新申请"。
    """
    return conn.execute(text("""UPDATE master_applications
        SET status = 'expired', decided_at = now(),
            review_note = coalesce(review_note, '超过 3 天审核期，未处理自动失效')
        WHERE status = 'pending' AND due_at < now()""")).rowcount


def _master_application_out(row, applicant_name=None) -> dict:
    return {
        "id": row["id"], "kind": row["kind"], "status": row["status"],
        "pointCode": row["point_code"], "pointId": row["point_id"],
        "mountainName": row["point_name"], "reason": row["reason"],
        "expectations": row["expectations"], "visitsPerMonth": row["visits_per_month"],
        "dueAt": row["due_at"], "createdAt": row["created_at"],
        "reviewNote": row["review_note"], "decidedAt": row["decided_at"],
        "applicantName": applicant_name,
    }


MASTER_APPLICATION_SELECT = """
    SELECT ma.*, pt.code AS point_code, pt.name AS point_name, pt.type AS point_type
      FROM master_applications ma JOIN points pt ON pt.id = ma.point_id"""


def _master_application_row(conn, application_id: int):
    return conn.execute(text(MASTER_APPLICATION_SELECT + " WHERE ma.id = :id"),
                        {"id": application_id}).mappings().first()


@app.post("/api/master-applications", response_model=dict, tags=["占山为王"],
          responses={**ERR_401, 404: {"description": "点位不存在"},
                     409: {"description": "已经有人维护 / 你已有一份待审申请"}},
          summary="申请成为山大王或版主：写理由与频次，进 3 天审核期")
def create_master_application(body: MasterApplicationIn, uid: int = Depends(require_user)):
    err(410, "UPGRADE_REQUIRED",
        "申请入口已升级：请在「占山为王 → 统一申请」填写申请原因、经营计划与目标山头。"
        "旧客户端不会再直接创建或授予身份。")
    reason = body.reason.strip()
    expectations = body.expectations.strip()
    if len(reason) < 20:
        err(422, "REASON_TOO_SHORT", "请至少写 20 个字说明为什么申请这座山")
    if len(expectations) < 10:
        err(422, "EXPECTATIONS_TOO_SHORT", "请至少写 10 个字说明成为版主后想做什么")
    point = q1("SELECT id, code, name, type, mountain_id FROM points WHERE code = :c",
               c=body.code.strip().upper())
    if not point:
        err(404, "POINT_NOT_FOUND", "这个点位不存在")
    with engine.begin() as conn:
        _expire_master_applications(conn)
        # 已经被单人独占的山头：不能再申请山大王，但可以申请加入（山寨/协作）
        owner = conn.execute(text("""SELECT 1 FROM master_applications
            WHERE point_id = :pid AND status = 'approved' AND kind = 'solo' LIMIT 1"""),
            {"pid": point["id"]}).first()
        maintained = conn.execute(text("""SELECT 1 FROM points pt LEFT JOIN claims cl
              ON cl.code = pt.code AND cl.status = 'active'
             WHERE pt.id = ANY(:ids) AND (pt.maintainer_id IS NOT NULL OR cl.id IS NOT NULL)
             LIMIT 1"""),
            {"ids": _board_point_ids(point["id"])}).first()
        if body.kind == "solo" and (owner or maintained):
            err(409, "ALREADY_MASTERED",
                "这座山已经有人维护了。想一起做的话，把申请类型改成「山寨（多人协作）」")
        mine = conn.execute(text("""SELECT id FROM master_applications
            WHERE point_id = :pid AND applicant_id = :uid AND status = 'pending'"""),
            {"pid": point["id"], "uid": uid}).first()
        if mine:
            err(409, "APPLICATION_PENDING", "你已经有一份待审申请了，3 天内会给答复")
        row = conn.execute(text("""INSERT INTO master_applications
            (applicant_id, point_id, mountain_id, kind, reason, expectations, visits_per_month)
            VALUES (:uid, :pid, :mid, :kind, :reason, :expect, :visits) RETURNING *"""),
            {"uid": uid, "pid": point["id"], "mid": point["mountain_id"], "kind": body.kind,
             "reason": reason, "expect": expectations, "visits": body.visitsPerMonth}
            ).mappings().one()
        _audit(conn, uid, "master_application.submit", "master_application", row["id"],
               {}, {"kind": body.kind, "pointCode": point["code"],
                    "visitsPerMonth": body.visitsPerMonth}, point_id=point["id"])
    return {"id": row["id"], "status": row["status"], "kind": row["kind"],
            "pointCode": point["code"], "dueAt": row["due_at"],
            "message": "申请已提交：%d 天内给答复。审核期内可以补充说明，也可以撤回。" % MASTER_APPLICATION_DAYS}


@app.get("/api/me/master-applications", response_model=list[dict], tags=["占山为王"],
         responses=ERR_401, summary="我提交的维护申请与状态")
def my_master_applications(uid: int = Depends(require_user)):
    with engine.begin() as conn:
        _expire_master_applications(conn)
        rows = conn.execute(text(MASTER_APPLICATION_SELECT +
                                 " WHERE ma.applicant_id = :uid ORDER BY ma.created_at DESC"),
                            {"uid": uid}).mappings().all()
    return [_master_application_out(row) for row in rows]


class MasterApplicationWithdraw(BaseModel):
    note: str | None = None


@app.post("/api/master-applications/{application_id}/withdraw", response_model=dict,
          tags=["占山为王"], responses={**ERR_401, 404: {"description": "申请不存在"}},
          summary="撤回自己的待审申请")
def withdraw_master_application(application_id: int, body: MasterApplicationWithdraw,
                                uid: int = Depends(require_user)):
    with engine.begin() as conn:
        updated = conn.execute(text("""UPDATE master_applications
            SET status = 'withdrawn', review_note = coalesce(:note, '申请人自己撤回'),
                reviewer_id = :uid, decided_at = now()
            WHERE id = :id AND applicant_id = :uid AND status = 'pending'
            RETURNING id"""), {"id": application_id, "uid": uid,
                               "note": (body.note or '').strip() or None}).first()
    if not updated:
        err(404, "APPLICATION_NOT_FOUND", "没有可撤回的待审申请")
    return {"withdrawn": True}


@app.get("/api/admin/master-applications", response_model=list[dict], tags=["占山为王"],
         summary="维护申请审核队列")
def list_master_applications(
        status: Literal["pending", "approved", "rejected", "expired", "withdrawn"] = "pending",
        limit: int = 50, uid: int = Depends(require_collaboration_reviewer)):
    with engine.begin() as conn:
        _expire_master_applications(conn)
        rows = conn.execute(text("""
            SELECT ma.*, pt.code AS point_code, pt.name AS point_name,
                   au.nickname AS applicant_name, au.username AS applicant_username
              FROM master_applications ma JOIN points pt ON pt.id = ma.point_id
              LEFT JOIN users au ON au.id = ma.applicant_id
             WHERE ma.status = :status ORDER BY ma.created_at LIMIT :limit"""),
            {"status": status, "limit": min(max(limit, 1), 100)}).mappings().all()
    return [_master_application_out(row, row["applicant_name"] or row["applicant_username"])
            for row in rows]


class MasterApplicationReview(BaseModel):
    decision: Literal["approved", "rejected"]
    note: str = Field(min_length=6, max_length=500, description="审核说明，驳回时要写给申请人看")


@app.post("/api/admin/master-applications/{application_id}/review", response_model=dict,
          tags=["占山为王"],
          responses={**ERR_401, 403: {"description": "不能审核自己的申请"},
                     404: {"description": "申请不存在"},
                     409: {"description": "这份申请已经有结论 / 已过期"}},
          summary="审核维护申请：通过则授予山大王或协作者身份")
def review_master_application(application_id: int, body: MasterApplicationReview,
                              uid: int = Depends(require_collaboration_reviewer)):
    err(410, "UPGRADE_REQUIRED",
        "旧审核入口已停用：请在平台审核台使用统一申请审核，旧接口不会再授予负责人或成员身份。")
    note = body.note.strip()
    with engine.begin() as conn:
        _expire_master_applications(conn)
        row = conn.execute(text(MASTER_APPLICATION_SELECT +
                                " WHERE ma.id = :id FOR UPDATE"),
                           {"id": application_id}).mappings().first()
        if not row:
            err(404, "APPLICATION_NOT_FOUND", "申请不存在")
        if row["applicant_id"] == uid:
            err(403, "SELF_REVIEW_FORBIDDEN", "不能审核自己的申请")
        if row["status"] != "pending":
            err(409, "APPLICATION_CLOSED", "这份申请已经是 %s 状态" % row["status"])
        auto_rejected = 0
        if body.decision == "approved":
            point_ids = _board_point_ids(row["point_id"])
            if row["kind"] == "solo":
                # 单人山大王：独占。通过时把同一座山其它待审申请一起驳回并写明理由，
                # 不让"谁先被点"成为没人说得清的规则。
                other = conn.execute(text("""UPDATE master_applications
                    SET status = 'rejected', reviewer_id = :uid, decided_at = now(),
                        review_note = '这座山已由另一位申请人获得（山大王单人独占）'
                    WHERE point_id = :pid AND status = 'pending' AND id <> :id
                    RETURNING id"""), {"pid": row["point_id"], "id": application_id,
                                       "uid": uid}).rowcount
                auto_rejected = other
                conn.execute(text("UPDATE points SET maintainer_id = :u WHERE id = ANY(:ids)"),
                             {"u": row["applicant_id"], "ids": point_ids})
                conn.execute(text("""INSERT INTO claims
                    (user_id, target_key, target_name, kind, nickname, contact, code)
                    VALUES (:uid, :k, :n, :kind, NULL, NULL, NULL)
                    ON CONFLICT (target_key) DO NOTHING"""),
                    {"uid": row["applicant_id"], "k": "master:" + row["point_code"],
                     "n": row["point_name"] or row["point_code"],
                     "kind": "junction" if row["point_type"] == "junction" else "peak"})
            else:
                # 山寨：多人协作。第一个人顺带成为维护人（物料与标牌对接要有个人负责），
                # 其余人走协作身份；协作入口保持开放。
                board = conn.execute(text("""SELECT b.id FROM boards b
                    JOIN points pt ON pt.mountain_id = b.mountain_id AND pt.type = 'peak'
                    WHERE pt.id = :pid AND b.board_type = 'summit' LIMIT 1"""),
                    {"pid": row["point_id"]}).mappings().first()
                if not board:
                    err(409, "BOARD_NOT_FOUND", "这座山还没有留言板，先请维护人认领")
                occupied = conn.execute(text("""SELECT 1 FROM points pt
                    LEFT JOIN claims cl ON cl.code = pt.code AND cl.status = 'active'
                    WHERE pt.id = ANY(:ids)
                      AND (pt.maintainer_id IS NOT NULL OR cl.id IS NOT NULL) LIMIT 1"""),
                    {"ids": point_ids}).first()
                if not occupied:
                    conn.execute(text("UPDATE points SET maintainer_id = :u WHERE id = ANY(:ids)"),
                                 {"u": row["applicant_id"], "ids": point_ids})
                conn.execute(text("""INSERT INTO board_collaboration_applications
                    (board_id, applicant_id, message, status, reviewer_id, review_note, reviewed_at)
                    VALUES (:b, :u, :m, 'approved', :r, :n, now())
                    ON CONFLICT (board_id, applicant_id) WHERE status IN ('pending','approved')
                    DO NOTHING"""),
                    {"b": board["id"], "u": row["applicant_id"],
                     "m": ("山寨申请：" + row["reason"])[:500], "r": uid, "n": note})
        conn.execute(text("""UPDATE master_applications SET status = :status,
            reviewer_id = :uid, review_note = :note, decided_at = now()
            WHERE id = :id"""),
            {"status": body.decision, "uid": uid, "note": note, "id": application_id})
        _audit(conn, uid, "master_application." + body.decision, "master_application",
               application_id, {"status": "pending"},
               {"status": body.decision, "kind": row["kind"], "autoRejected": auto_rejected},
               reason=note, point_id=row["point_id"])
    return {"id": application_id, "status": body.decision, "kind": row["kind"],
            "autoRejected": auto_rejected,
            "message": ("已通过：%s 成为这座山的%s" % (
                "申请人", "山大王" if row["kind"] == "solo" else "协作者"))
            if body.decision == "approved" else "已驳回，申请人会看到你写的说明"}


@app.get("/api/mountains/{mountain_id}/courses", response_model=list[dict], tags=["打卡"])
def mountain_courses(mountain_id: int = Path(ge=1)):
    rows = q("""SELECT id, name, start_point_id AS "startPointId",
        end_point_id AS "endPointId", ranking_enabled AS "rankingEnabled"
        FROM ascent_courses WHERE mountain_id=:mountain ORDER BY id""", mountain=mountain_id)
    return [dict(r) for r in rows]


@app.get("/api/efforts/leaderboard", response_model=dict, tags=["打卡"])
def effort_leaderboard(courseId: int, window: Literal["week", "month", "year", "all"] = "week",
                       authorization: str | None = Header(default=None)):
    course = q1("SELECT id, ranking_enabled FROM ascent_courses WHERE id=:id", id=courseId)
    if not course:
        err(404, "COURSE_NOT_FOUND", "登顶路线不存在")
    since = _window_since(window)
    rows = q("""SELECT DISTINCT ON (e.user_id) e.user_id, e.duration_s,
        e.end_at AT TIME ZONE 'Asia/Shanghai' AS local_end,
        coalesce(u.nickname, u.username, '山友') AS nickname
        FROM segment_efforts e JOIN users u ON u.id=e.user_id
        WHERE e.course_id=:course AND e.eligible AND u.leaderboard_enabled
          AND e.end_at >= :since
        ORDER BY e.user_id, e.duration_s, e.end_at""",
        course=courseId, since=since)
    scores = sorted(rows, key=lambda r: (r["duration_s"], r["user_id"]))
    uid = require_user(authorization) if authorization else None
    mine = next((r for r in scores if r["user_id"] == uid), None)
    enough = course["ranking_enabled"] and len(scores) >= 8
    def rank(row):
        return 1 + sum(other["duration_s"] < row["duration_s"] for other in scores)
    def public_row(row, ranked):
        return {"nickname": row["nickname"], "durationS": row["duration_s"],
                "date": row["local_end"].date().isoformat(),
                "rank": rank(row) if ranked else None}
    leaders = [public_row(r, True) for r in scores if rank(r) <= 3] if enough else []
    my_row = public_row(mine, enough) if mine else None
    if my_row is not None:
        my_row["percentile"] = round(100 * sum(r["duration_s"] > mine["duration_s"] for r in scores) / len(scores)) if enough else None
    return {"courseId": courseId, "window": window, "sampleSize": len(scores),
            "rankingAvailable": enough, "leaders": leaders, "myBest": my_row}


@app.get("/api/me/leaderboard-settings", response_model=dict, tags=["我"])
def get_leaderboard_settings(uid: int = Depends(require_user)):
    row = q1("SELECT leaderboard_enabled FROM users WHERE id=:uid", uid=uid)
    return {"enabled": row["leaderboard_enabled"]}


class LeaderboardSettingsIn(BaseModel):
    enabled: bool


@app.patch("/api/me/leaderboard-settings", response_model=dict, tags=["我"])
def set_leaderboard_settings(body: LeaderboardSettingsIn,
                             uid: int = Depends(require_user)):
    with engine.begin() as conn:
        conn.execute(text("UPDATE users SET leaderboard_enabled=:value WHERE id=:uid"),
                     {"value": body.enabled, "uid": uid})
    return {"enabled": body.enabled}


def _receipts(identity_type: str, identity_id: int, limit: int, cursor: int | None = None):
    """凭证列表。游标用"上一页最后一条的 visitId"：按 (occurred_at, id) 取更早的，
    这样翻页不会因为同一秒多条而漏掉或重复（计划 4 节的 cursor/limit≤50）。"""
    col = "user_id" if identity_type == "user" else "guest_id"
    rows = q("""SELECT v.id AS "visitId", p.code, p.name, p.type AS kind,
        v.seq, v.occurred_at AS "visitedAt", v.recorded_at AS "recordedAt",
        e.duration_s AS "durationS", e.excluded_reason AS "effortReason"
        FROM visits v JOIN points p ON p.id=v.point_id
        LEFT JOIN segment_efforts e ON e.end_visit_id=v.id
        WHERE v.""" + col + """=:identity
          AND (CAST(:cursor AS bigint) IS NULL OR (v.occurred_at, v.id) <
               (SELECT occurred_at, id FROM visits WHERE id=CAST(:cursor AS bigint)))
        ORDER BY v.occurred_at DESC, v.id DESC LIMIT :limit""",
        identity=identity_id, limit=limit, cursor=cursor)
    return [dict(r) for r in rows]


@app.get("/api/me/visit-receipts", response_model=list[dict], tags=["我"])
def my_visit_receipts(limit: int = 20, cursor: int | None = None,
                      uid: int = Depends(require_user)):
    return _receipts("user", uid, min(max(limit, 1), 50), cursor)


@app.get("/api/guest/visit-receipts", response_model=list[dict], tags=["游客"])
def guest_visit_receipts(limit: int = 20, cursor: int | None = None,
                         x_guest_token: str | None = Header(default=None)):
    guest = _guest_of(x_guest_token)
    if not guest or guest["merged_user_id"]:
        err(401, "GUEST_TOKEN_REQUIRED", "游客身份无效")
    return _receipts("guest", guest["id"], min(max(limit, 1), 50), cursor)


def _mountain_summary(identity_type: str, identity_id: int, limit: int):
    col = "user_id" if identity_type == "user" else "guest_id"
    rows = q(f"""SELECT p.mountain_id AS "mountainId", m.name,
        max(v.occurred_at) AS "myLastVisitedAt",
        (SELECT count(DISTINCT CASE WHEN allv.user_id IS NOT NULL
            THEN 'u:' || allv.user_id::text ELSE 'g:' || allv.guest_id::text END)
         FROM visits allv JOIN points allp ON allp.id=allv.point_id
         WHERE allp.mountain_id=p.mountain_id) AS "visitorCount"
        FROM visits v JOIN points p ON p.id=v.point_id
        JOIN mountains m ON m.id=p.mountain_id
        WHERE v.{col}=:identity GROUP BY p.mountain_id,m.name
        ORDER BY "myLastVisitedAt" DESC LIMIT :limit""",
        identity=identity_id, limit=limit)
    return [dict(r) for r in rows]


@app.get("/api/me/mountain-summary", response_model=list[dict], tags=["我"])
def my_mountain_summary(limit: int = 3, uid: int = Depends(require_user)):
    return _mountain_summary("user", uid, min(max(limit, 1), 50))


@app.get("/api/guest/mountain-summary", response_model=list[dict], tags=["游客"])
def guest_mountain_summary(limit: int = 3,
                           x_guest_token: str | None = Header(default=None)):
    guest = _guest_of(x_guest_token)
    if not guest or guest["merged_user_id"]:
        err(401, "GUEST_TOKEN_REQUIRED", "游客身份无效")
    return _mountain_summary("guest", guest["id"], min(max(limit, 1), 50))


class PrivateLetterIn(BaseModel):
    text: str = Field(min_length=1, max_length=2000)
    mode: Literal["date", "checkin", "open"]
    years: Literal[1, 3, 5] | None = None
    pointId: int | None = None


@app.get("/api/me/letters", response_model=list[dict], tags=["我"])
def my_private_letters(uid: int = Depends(require_user)):
    with engine.begin() as conn:
        rows = conn.execute(text("""SELECT * FROM letters WHERE user_id=:uid
            AND status<>'deleted' ORDER BY created_at DESC"""), {"uid": uid}).mappings().all()
        return [public_letter(conn, row, include_text=True) for row in rows]


@app.post("/api/me/letters", response_model=dict, tags=["我"])
def write_private_letter(body: PrivateLetterIn, uid: int = Depends(require_user)):
    # 先去掉首尾空白再判空：全是空格的信在 pydantic 眼里长度合法，
    # 但存下来就是一封空信（封存之后用户连"写错了"都看不出来）。
    if not body.text.strip():
        err(422, "LETTER_EMPTY", "信里还没有内容")
    if body.mode == "date" and body.years is None:
        err(422, "LETTER_YEARS_REQUIRED", "请选择一、三或五年")
    if body.mode == "checkin" and body.pointId is None:
        err(422, "LETTER_POINT_REQUIRED", "请选择现场打卡地点")
    if body.mode != "date" and body.years is not None:
        err(422, "LETTER_MODE_CONFLICT", "这种解锁方式无需年限")
    if body.mode != "checkin" and body.pointId is not None:
        err(422, "LETTER_MODE_CONFLICT", "这种解锁方式无需目标点位")
    target = None
    if body.mode == "date":
        local = datetime.now(ZoneInfo("Asia/Shanghai"))
        try:
            target = local.replace(year=local.year + body.years)
        except ValueError:
            target = local.replace(year=local.year + body.years, day=28)
        target = target.replace(hour=0, minute=0, second=0, microsecond=0)
    with engine.begin() as conn:
        if body.pointId is not None and not conn.execute(text(
            "SELECT 1 FROM points WHERE id=:id"), {"id": body.pointId}).scalar_one_or_none():
            err(404, "POINT_NOT_FOUND", "目标点位不存在")
        row = conn.execute(text("""INSERT INTO letters
            (user_id, point_id, text, unlock_at, unlock_mode)
            VALUES (:uid,:point,:body,:target,:mode) RETURNING *"""),
            {"uid": uid, "point": body.pointId, "body": body.text.strip(),
             "target": target, "mode": body.mode}).mappings().one()
        return public_letter(conn, row, include_text=True)


@app.get("/api/me/letters/{letter_id}", response_model=dict, tags=["我"])
def read_private_letter(letter_id: int, uid: int = Depends(require_user)):
    with engine.begin() as conn:
        row = conn.execute(text("""SELECT * FROM letters WHERE id=:id AND user_id=:uid
            AND status<>'deleted' FOR UPDATE"""), {"id": letter_id, "uid": uid}).mappings().first()
        if not row:
            err(404, "LETTER_NOT_FOUND", "信不存在")
        unlocked = letter_is_unlocked(conn, row)
        if unlocked:
            conn.execute(text("UPDATE letters SET read_at=coalesce(read_at,now()) WHERE id=:id"),
                         {"id": letter_id})
        return public_letter(conn, row, include_text=True)


@app.delete("/api/me/letters/{letter_id}", response_model=dict, tags=["我"])
def delete_private_letter(letter_id: int, uid: int = Depends(require_user)):
    with engine.begin() as conn:
        result = conn.execute(text("DELETE FROM letters WHERE id=:id AND user_id=:uid"),
                              {"id": letter_id, "uid": uid})
    if not result.rowcount:
        err(404, "LETTER_NOT_FOUND", "信不存在")
    return {"deleted": True}


@app.get("/api/points/{code}", response_model=PointDetail, tags=["点位"], responses=ERR_404)
def get_point(code: str):
    p = q1("""SELECT pt.*, r.slug AS route_slug, r.name AS route_name,
                     r.hardest_level AS route_hardest_level,
                     coalesce(u.nickname, owner.nickname, cl.nickname) AS maintainer_name,
                     coalesce(pt.maintainer_id, cl.user_id) AS responsible_id
              FROM points pt LEFT JOIN routes r ON r.id = pt.route_id
              LEFT JOIN users u ON u.id = pt.maintainer_id
              LEFT JOIN LATERAL (SELECT user_id, nickname FROM claims
                WHERE code = pt.code AND status = 'active' ORDER BY id DESC LIMIT 1) cl ON true
              LEFT JOIN users owner ON owner.id = cl.user_id
              WHERE pt.code = :code""", code=code)
    if not p:
        err(404, "POINT_NOT_FOUND", "点位不存在")
    point_ids = _board_point_ids(p["id"])
    board = q1("SELECT id FROM boards WHERE board_type = 'summit' AND mountain_id = :m",
               m=p["mountain_id"]) if p["mountain_id"] else None
    codes = q("SELECT code FROM points WHERE id = ANY(:ids) ORDER BY code", ids=point_ids)
    responsible = q1("""SELECT coalesce(pt.maintainer_id, cl.user_id) AS uid,
                            coalesce(u.nickname, owner.nickname, cl.nickname) AS nickname
        FROM points pt LEFT JOIN users u ON u.id = pt.maintainer_id
        LEFT JOIN LATERAL (SELECT user_id, nickname FROM claims
          WHERE code = pt.code AND status = 'active' ORDER BY id DESC LIMIT 1) cl ON true
        LEFT JOIN users owner ON owner.id = cl.user_id
        WHERE pt.id = ANY(:ids) AND coalesce(pt.maintainer_id, cl.user_id) IS NOT NULL
        ORDER BY pt.id LIMIT 1""", ids=point_ids)
    top = q1("""SELECT c.id, c.text, c.like_count, c.bad_count, c.status, c.created_at,
                       u.nickname, coalesce(:uid = c.user_id, false) AS is_maintainer
                FROM comments c
                JOIN users u   ON u.id = c.user_id
                WHERE c.point_id = ANY(:ids) AND c.status <> 'hidden'
                ORDER BY is_maintainer DESC, (c.like_count - c.bad_count) DESC, c.created_at DESC
                LIMIT 1""", ids=point_ids, uid=responsible["uid"] if responsible else None)
    n = q1("""SELECT count(DISTINCT (coalesce(user_id, -guest_id), visit_date)) AS n
              FROM visits WHERE point_id = ANY(:ids)""", ids=point_ids)
    pending = q1("SELECT count(*) AS n FROM comments WHERE point_id = ANY(:ids) AND status = 'flagged'", ids=point_ids)
    contribution = q1("""SELECT c.text FROM comments c
        WHERE c.point_id = ANY(:ids) AND c.user_id = :uid AND c.status <> 'hidden'
        ORDER BY c.created_at DESC LIMIT 1""", ids=point_ids,
        uid=responsible["uid"] if responsible else None)
    d = dict(p)
    if d.get("level") is None:
        d["level"] = d.get("route_hardest_level") or "mid"
    keys = ("id", "code", "type", "name", "route_id", "route_slug", "route_name", "index_in_route",
            "total_in_route", "level", "altitude", "guide", "status", "version")
    return PointDetail(**{k: d.get(k) for k in keys}, visitCount=n["n"],
                       maintainerName=responsible["nickname"] if responsible else None,
                       recentContribution=contribution["text"] if contribution else None,
                       pendingCount=pending["n"],
                       mountainId=p["mountain_id"], boardId=board["id"] if board else None,
                       boardPointCodes=[r["code"] for r in codes],
                       topComment=CommentOut(**dict(top)) if top else None)


class MountainLinkIn(BaseModel):
    sourceCode: str
    targetCode: str
    evidence: str = Field(min_length=8, max_length=1000)


@app.post("/api/admin/mountains/link", tags=["山峰"],
          responses={**ERR_401, **ERR_404, 403: {"description": "无地理资料审核权限"},
                     409: {"description": "维护关系冲突或山峰归属变化，需重新核对"}},
          summary="人工核实两组扫码入口属于同一山峰后，合并稳定身份与留言板")
def link_mountain_identity(body: MountainLinkIn,
                           uid: int = Depends(require_place_curator)):
    if len(body.evidence.strip()) < 8:
        err(400, "EVIDENCE_REQUIRED", "请填写可核查的同山依据")
    source_code, target_code = body.sourceCode.strip().upper(), body.targetCode.strip().upper()
    source = q1("SELECT id, mountain_id, type FROM points WHERE code = :c", c=source_code)
    target = q1("SELECT id, mountain_id, type FROM points WHERE code = :c", c=target_code)
    if not source or not target or source["type"] != "peak" or target["type"] != "peak":
        err(404, "SUMMIT_POINT_NOT_FOUND", "请提供两个已存在的山顶编号")
    source_id, target_id = source["mountain_id"], target["mountain_id"]
    if not source_id or not target_id or source_id == target_id:
        err(409, "MOUNTAIN_ALREADY_LINKED", "两处入口已属同一座山，或尚无稳定身份")
    with engine.begin() as conn:
        conn.execute(text("SELECT id FROM mountains WHERE id IN (:a, :b) ORDER BY id FOR UPDATE"),
                     {"a": source_id, "b": target_id})
        current = conn.execute(text("""SELECT code, mountain_id FROM points
            WHERE id IN (:source, :target)"""),
            {"source": source["id"], "target": target["id"]}).mappings().all()
        if {r["code"]: r["mountain_id"] for r in current} != {
                source_code: source_id, target_code: target_id}:
            err(409, "MOUNTAIN_CHANGED", "山峰归属刚被更新，请重新核对后提交")
        owners = conn.execute(text("""SELECT DISTINCT coalesce(p.maintainer_id, cl.user_id) AS uid
            FROM points p LEFT JOIN claims cl ON cl.code = p.code AND cl.status = 'active'
            WHERE p.mountain_id IN (:a, :b)
              AND coalesce(p.maintainer_id, cl.user_id) IS NOT NULL"""),
            {"a": source_id, "b": target_id}).scalars().all()
        if len(owners) > 1:
            err(409, "MAINTAINER_CONFLICT", "两块山顶板有不同维护人，先完成交接")
        conn.execute(text("UPDATE points SET mountain_id = :target WHERE mountain_id = :source"),
                     {"target": target_id, "source": source_id})
        conn.execute(text("UPDATE route_peaks SET mountain_id = :target WHERE mountain_id = :source"),
                     {"target": target_id, "source": source_id})
        conn.execute(text("""INSERT INTO mountain_identity_links
            (source_mountain_id, target_mountain_id, reviewed_by, evidence)
            VALUES (:source, :target, :uid, :e)"""),
            {"source": source_id, "target": target_id, "uid": uid, "e": body.evidence.strip()})
        board_id = conn.execute(text("""SELECT id FROM boards
            WHERE board_type = 'summit' AND mountain_id = :m"""), {"m": target_id}).scalar_one()
        codes = conn.execute(text("SELECT code FROM points WHERE mountain_id = :m ORDER BY code"),
                             {"m": target_id}).scalars().all()
    return {"boardId": board_id, "mountainId": target_id, "pointCodes": codes}


# ==================== 热门登顶榜 ====================

# 一条线路的「主峰」= 最难的那条爬升段所通向的那个顶。
# 这是全站的核心模型：卡片的标题是它，二维码贴在它身上，留言板挂在它下面。
# 线路名（三峰连穿）只是"这条线怎么走"，不是山头的名字。
HARD_SEG = """
    SELECT DISTINCT ON (route_id) route_id, to_km, rise, km, level, pct
    FROM route_segments
    ORDER BY route_id,
             -- 优先挑爬升段；但**不能只要爬升段**——全平或全下坡的线路
             -- （或者海拔数据坏掉、全被判成"平缓"的轨迹）会一段都挑不出来，
             -- 那条线路就会从山头榜里静默消失（曾漏掉 5 条）。
             (kind = 'climb') DESC,
             CASE level WHEN 'hidden' THEN 3 WHEN 'hard' THEN 2
                        WHEN 'mid' THEN 1 ELSE 0 END DESC,
             abs(pct) DESC
"""
MAIN_PEAK = f"""
    -- idx 要 +1 才对得上 points.index_in_route：那边山脚是 0、第 N 个顶是 N
    SELECT DISTINCT ON (rp.route_id) rp.route_id, rp.idx + 1 AS idx, rp.altitude,
           rp.name AS peak_name,
           rp.lat, rp.lng
    FROM route_peaks rp JOIN ({HARD_SEG}) h ON h.route_id = rp.route_id
    ORDER BY rp.route_id, abs(rp.km - h.to_km)
"""


class SummitItem(BaseModel):
    id: str = Field(description="前端 key，等同 p-{code}")
    pointId: int
    code: str = Field(description="这个山顶自己的编号，二维码印的就是它")
    name: str | None = Field(default=None, description="主峰真名；空 = 名称待定")
    altitude: int
    level: Literal["easy", "mid", "hard", "hidden"] = "mid"
    routeSlug: str | None = Field(default=None, description="自建山头没有归属线路")
    routeName: str | None = Field(default=None,
                                  description="归属线路；卡片上用 @线路名 小字注出来")
    city: str | None = None
    province: str | None = Field(default=None, description="省级行政区，山头页「本省」筛选用")
    country: str | None = Field(default=None, description="国家/地区，「本国 / 海外」筛选用")
    peakCount: int = 1
    segRise: int = Field(default=0, description="最难那条爬升段的爬升")
    segKm: float = Field(default=0, description="那一段有多长")
    lat: float | None = None
    lng: float | None = None
    visits30: int = Field(default=0, description="本周热度：这个顶近 7 天被扫了几次")
    heatTier: str | None = Field(
        default=None,
        description="互联网热度档（极热/热门/较热/小众），来自名山资料库；"
                    "没有资料的山头为 null，列表里排在带热度的之后")
    annualVisits: str | None = Field(default=None, description="年接待量原文，例如「年徒步到访 20 万人次以上（估算）」")
    fastest: str | None = None
    holder: str | None = None
    origin: Literal["route", "user"] = "route"
    series: str | None = Field(default=None, description="所属系列：世界前 10 / 七大洲 / 中国名山 / 各国名山")


# 系列 = 这批山头的来历。编号前缀就是系列，不用额外加字段。
SERIES = {"W10": "世界前 10 高峰", "7S": "七大洲最高峰",
          "CN": "中国名山", "WM": "各国名山"}


def series_of(code: str | None) -> str | None:
    return SERIES.get((code or "").split("-")[0])


@app.get("/api/summits", response_model=list[SummitItem], tags=["点位"],
         summary="山头列表：一条线路一张卡，卡是它的主峰")
def list_summits(limit: int = 100):
    # 排序口径：先按互联网热度档（mountains.heat_tier，来自名山资料库：
    # 极热 > 热门 > 较热 > 小众），再按本周打卡量、海拔。
    # 没有热度资料的山头 heatTier 为 null，用 NULLS LAST 排在后面，不插队。
    rows = q(f"""
        WITH base AS (
          SELECT 'p-' || pt.code        AS id, pt.id AS "pointId", pt.code,
                 pt.name, mp.altitude, coalesce(pt.level, r.hardest_level, 'mid') AS level,
                 r.slug                 AS "routeSlug", r.name AS "routeName",
                 coalesce(pt.city, r.city) AS city, pt.country, pt.province,
                 r.peak_count           AS "peakCount",
                 h.rise                 AS "segRise", round(h.km, 2) AS "segKm",
                 mp.lat, mp.lng,
                 (SELECT count(*) FROM visits v WHERE v.point_id = pt.id
                    AND v.created_at > now() - interval '7 days') AS "visits30",
                 (SELECT to_char(make_interval(secs => min(v.duration_sec)), 'HH24:MI')
                    FROM visits v WHERE v.point_id = pt.id AND v.duration_sec IS NOT NULL) AS fastest,
                 (SELECT u.nickname FROM visits v JOIN users u ON u.id = v.user_id
                    WHERE v.point_id = pt.id AND v.duration_sec IS NOT NULL
                    ORDER BY v.duration_sec LIMIT 1) AS holder,
                 'route' AS origin,
                 hm.heat_tier AS "heatTier", hm.annual_visits AS "annualVisits",
                 CASE hm.heat_tier WHEN '极热' THEN 4 WHEN '热门' THEN 3
                                   WHEN '较热' THEN 2 WHEN '小众' THEN 1 END AS heat_rank
          FROM routes r
          JOIN ({HARD_SEG}) h ON h.route_id = r.id
          JOIN ({MAIN_PEAK}) mp ON mp.route_id = r.id
          JOIN points pt ON pt.route_id = r.id AND pt.index_in_route = mp.idx
          LEFT JOIN mountains hm ON hm.id = pt.mountain_id
          UNION ALL
          SELECT 'p-' || pt.code, pt.id, pt.code, pt.name, pt.altitude,
                 coalesce(pt.level, 'mid'),
                 NULL, NULL, pt.city, pt.country, pt.province,
                 1, coalesce(pt.track_up, 0), coalesce(pt.track_km, 0),
                 ST_Y(pt.geom), ST_X(pt.geom),
                 (SELECT count(*) FROM visits v WHERE v.point_id = pt.id
                    AND v.created_at > now() - interval '7 days'),
                 (SELECT to_char(make_interval(secs => min(v.duration_sec)), 'HH24:MI')
                    FROM visits v WHERE v.point_id = pt.id AND v.duration_sec IS NOT NULL),
                 (SELECT u.nickname FROM visits v JOIN users u ON u.id = v.user_id
                    WHERE v.point_id = pt.id AND v.duration_sec IS NOT NULL
                    ORDER BY v.duration_sec LIMIT 1),
                 'user',
                 hm.heat_tier, hm.annual_visits,
                 CASE hm.heat_tier WHEN '极热' THEN 4 WHEN '热门' THEN 3
                                   WHEN '较热' THEN 2 WHEN '小众' THEN 1 END
          FROM points pt
          LEFT JOIN mountains hm ON hm.id = pt.mountain_id
          WHERE pt.type = 'peak' AND pt.status = 'published'
            AND pt.route_id IS NULL AND pt.altitude IS NOT NULL
        )
        SELECT * FROM base
        ORDER BY heat_rank DESC NULLS LAST, "visits30" DESC, altitude DESC
        LIMIT :limit""", limit=limit)
    out = []
    for r in rows:
        d = dict(r)
        d["series"] = series_of(d.get("code"))
        try:
            out.append(SummitItem(**d))
        except Exception:
            # 不把内部字段暴露给公开接口，但日志里要能定位是哪一行。
            logging.exception("summits row invalid: code=%s", d.get("code"))
            raise
    return out

class WantIn(BaseModel):
    kind: Literal["peak", "trail", "junction"]
    target_key: str = Field(description="前端 key：线路 = slug，山顶 = slug-idx，自建点位 = p-{code}")


class HotPeak(BaseModel):
    rank: int
    target_key: str = Field(description="点进去用：p-{code}（山头自己那个点位）")
    kind: Literal["trail", "peak"]
    name: str | None = Field(default=None, description="主峰真名；空 = 名称待定")
    route_slug: str | None = None
    route_name: str | None = Field(default=None, description="归属线路，卡片上 @ 出来")
    code: str | None = None
    city: str | None = None
    province: str | None = Field(default=None, description="省级行政区，山头页「本省」筛选用")
    country: str | None = Field(default=None, description="国家/地区，「本国 / 海外」筛选用")
    level: Literal["easy", "mid", "hard", "hidden"] | None = Field(
        default=None, description="通向它的那一段的难度，「登顶难度」筛选用")
    altitude: int
    peak_count: int = 1
    seg_rise: int = Field(default=0, description="单段爬升：全线最难那一段上升了多少米")
    seg_km: float = Field(default=0, description="单段距离：那一趟多长")
    heat7: int = Field(description="本周打卡次数")
    heat30: int = Field(description="近 30 天打卡次数")
    visitors: int = Field(description="近 30 天去重人数")
    wants: int = Field(description="关注度：想去 / 收藏过它的人")
    fastest_time: str | None = Field(default=None, description="登顶最快用时；没人记过则为 null")
    fastest_holder: str | None = Field(default=None, description="记录保持者")
    score: int


@app.get("/api/peaks/hot", response_model=list[HotPeak], tags=["点位"],
         summary="热门登顶排行榜（本周打卡热度 + 用户关注度）")
def hot_peaks(limit: int = 10):
    """一座**山头**一行。

    这里的"山头"是**主峰**，不是线路：一条线路挑出最难那条爬升段通向的顶，
    它的名字（没采到就是"名称待定"）、它的海拔、它自己的扫码热度。
    线路名只在卡片上做一行小字注（@三峰连穿），点进去才是整条线路的路书。

    score = 本周打卡 × 3 + 近 30 天打卡 + 关注 × 2
    本周权重最高——榜要反映"现在热不热"，不是"历史上攒了多少"。
    """
    rows = q(f"""
        SELECT * FROM (
          SELECT 'p-' || pt.code  AS target_key, 'peak' AS kind,
                 pt.name, pt.code, r.slug AS route_slug, r.name AS route_name,
                 coalesce(pt.city, r.city) AS city, pt.province, pt.country,
                 mp.altitude, r.peak_count,
                 h.rise AS seg_rise, round(h.km, 2) AS seg_km,
                 h.level,
                 (SELECT count(*) FROM visits v WHERE v.point_id = pt.id
                    AND v.created_at > now() - interval '7 days')  AS heat7,
                 (SELECT count(*) FROM visits v WHERE v.point_id = pt.id
                    AND v.created_at > now() - interval '30 days') AS heat30,
                 (SELECT count(DISTINCT v.user_id) FROM visits v WHERE v.point_id = pt.id
                    AND v.created_at > now() - interval '30 days') AS visitors,
                 (SELECT count(*) FROM wants w WHERE w.target_key = 'p-' || pt.code
                    OR w.target_key = r.slug OR w.target_key LIKE r.slug || '-%') AS wants,
                 (SELECT to_char(make_interval(secs => min(v.duration_sec)), 'HH24:MI')
                    FROM visits v WHERE v.point_id = pt.id AND v.duration_sec IS NOT NULL)
                    AS fastest_time,
                 (SELECT u.nickname FROM visits v JOIN users u ON u.id = v.user_id
                    WHERE v.point_id = pt.id AND v.duration_sec IS NOT NULL
                    ORDER BY v.duration_sec LIMIT 1) AS fastest_holder
          FROM routes r
          JOIN ({HARD_SEG}) h ON h.route_id = r.id
          JOIN ({MAIN_PEAK}) mp ON mp.route_id = r.id
          JOIN points pt ON pt.route_id = r.id AND pt.index_in_route = mp.idx
          UNION ALL
          -- 列必须和上面那条分支严格对齐（UNION ALL 按位置合并）
          SELECT 'p-' || pt.code, 'peak', pt.name, pt.code, NULL, NULL, pt.city,
                 pt.province, pt.country,
                 pt.altitude, 1, coalesce(pt.track_up, 0), coalesce(pt.track_km, 0),
                 pt.level,
                 (SELECT count(*) FROM visits v WHERE v.point_id = pt.id
                    AND v.created_at > now() - interval '7 days'),
                 (SELECT count(*) FROM visits v WHERE v.point_id = pt.id
                    AND v.created_at > now() - interval '30 days'),
                 (SELECT count(DISTINCT v.user_id) FROM visits v WHERE v.point_id = pt.id
                    AND v.created_at > now() - interval '30 days'),
                 (SELECT count(*) FROM wants w WHERE w.target_key = 'p-' || pt.code),
                 (SELECT to_char(make_interval(secs => min(v.duration_sec)), 'HH24:MI')
                    FROM visits v WHERE v.point_id = pt.id AND v.duration_sec IS NOT NULL),
                 (SELECT u.nickname FROM visits v JOIN users u ON u.id = v.user_id
                    WHERE v.point_id = pt.id AND v.duration_sec IS NOT NULL
                    ORDER BY v.duration_sec LIMIT 1)
          FROM points pt
          WHERE pt.type = 'peak' AND pt.status = 'published'
            AND pt.route_id IS NULL AND pt.altitude IS NOT NULL
        ) t
        WHERE altitude IS NOT NULL
        ORDER BY (heat7 * 3 + heat30 + wants * 2) DESC, altitude DESC
        LIMIT :limit""", limit=limit)
    out = []
    for i, r in enumerate(rows):
        d = dict(r)
        d["score"] = d["heat7"] * 3 + d["heat30"] + d["wants"] * 2
        d["rank"] = i + 1
        out.append(HotPeak(**d))
    return out


@app.post("/api/wants", status_code=204, tags=["关注"],
          responses=ERR_401, summary="关注 / 想去（重复调用不报错）")
def add_want(body: WantIn, uid: int = Depends(require_user)):
    # q() 只用于 SELECT（它要 .mappings()），写操作走 engine.begin()
    with engine.begin() as conn:
        conn.execute(text("""INSERT INTO wants (user_id, kind, target_key)
            VALUES (:uid, :k, :t)
            ON CONFLICT (user_id, kind, target_key) DO NOTHING"""),
            {"uid": uid, "k": body.kind, "t": body.target_key})


@app.delete("/api/wants", status_code=204, tags=["关注"],
            responses=ERR_401, summary="取消关注")
def drop_want(kind: Literal["peak", "trail", "junction"], target_key: str,
              uid: int = Depends(require_user)):
    with engine.begin() as conn:
        conn.execute(text("""DELETE FROM wants
            WHERE user_id = :uid AND kind = :k AND target_key = :t"""),
            {"uid": uid, "k": kind, "t": target_key})


@app.get("/api/me/wants", tags=["关注"], responses=ERR_401, summary="我关注 / 想去的东西")
def my_wants(uid: int = Depends(require_user)):
    rows = q("""SELECT kind, target_key, created_at FROM wants
                WHERE user_id = :uid ORDER BY created_at DESC""", uid=uid)
    return [{"kind": r["kind"], "targetKey": r["target_key"],
             "at": r["created_at"].isoformat()} for r in rows]


# ==================== 消息页：我的山头 / 关注 / 留言提醒 ====================

class MySummit(BaseModel):
    id: int
    pointId: int
    code: str
    name: str | None = None
    altitude: int | None = None
    level: str = "mid"
    city: str | None = None
    routeSlug: str | None = None
    type: Literal["peak", "junction", "trailhead"] = Field(
        default="peak", description="peak=山头（山大王）；junction=岔路口（NPC指路人）")
    role: Literal["maintainer", "owner", "collaborator"] = Field(description="maintainer=版主；owner=山大王；collaborator=本板协作者")
    commentCount: int = 0
    unread: int = 0
    heat7: int = 0
    lastCommentAt: str | None = None
    boardId: int | None = None
    boardPointCodes: list[str] = Field(default_factory=list)


@app.get("/api/me/summits", response_model=list[MySummit], tags=["消息"],
         responses=ERR_401, summary="我的山头：我维护的 + 我自己开的")
def my_summits(uid: int = Depends(require_user)):
    """Return one responsibility row per board, even when several QR points share it."""
    rows = q("""
        SELECT pt.id AS point_id, pt.code, pt.name, pt.altitude, pt.level, pt.mountain_id,
               pt.type AS point_type, b.id AS board_id,
               coalesce(pt.city, r.city) AS city, r.slug AS route_slug,
               (mm.role = 'owner') AS is_maint,
               (mm.role = 'member') AS is_collab
          FROM points pt
          JOIN mountain_members mm ON mm.mountain_id = pt.mountain_id
          LEFT JOIN routes r ON r.id = pt.route_id
          LEFT JOIN boards b ON b.mountain_id = pt.mountain_id AND b.board_type = 'summit'
         WHERE mm.user_id = :uid AND mm.status = 'active'
         ORDER BY pt.id""", uid=uid)
    groups: dict[int, list] = {}
    for row in rows:
        groups.setdefault(row["mountain_id"] or -row["point_id"], []).append(row)
    out = []
    seen_at = q1("SELECT notif_seen_at FROM users WHERE id = :uid", uid=uid)["notif_seen_at"]
    for group in groups.values():
        lead = next((r for r in group if r["is_maint"]), group[0])
        ids = [r["point_id"] for r in group]
        activity = q1("""SELECT
            (SELECT count(*) FROM comments WHERE point_id = ANY(:ids) AND status <> 'hidden') AS comments,
            (SELECT count(*) FROM comments WHERE point_id = ANY(:ids) AND status <> 'hidden'
              AND created_at > :seen) AS unread,
            (SELECT count(DISTINCT (coalesce(user_id, -guest_id), visit_date)) FROM visits
              WHERE point_id = ANY(:ids) AND created_at > now() - interval '7 days') AS heat,
            (SELECT max(created_at) FROM comments WHERE point_id = ANY(:ids)) AS last_at""",
                      ids=ids, seen=seen_at)
        out.append(MySummit(id=lead["point_id"], pointId=lead["point_id"], code=lead["code"],
                            name=lead["name"], altitude=lead["altitude"], level=lead["level"],
                            type=lead["point_type"], city=lead["city"], routeSlug=lead["route_slug"],
                            role="maintainer" if lead["is_maint"] else
                                 "collaborator" if lead["is_collab"] else "owner",
                            commentCount=activity["comments"], unread=activity["unread"],
                            heat7=activity["heat"], boardId=lead["board_id"],
                            boardPointCodes=[r["code"] for r in group],
                            lastCommentAt=activity["last_at"].isoformat() if activity["last_at"] else None))
    out.sort(key=lambda r: (r.lastCommentAt or "", r.heat7), reverse=True)
    return out[:50]


class FollowedSummit(BaseModel):
    targetKey: str
    pointId: int | None = None
    code: str | None = None
    name: str | None = None
    altitude: int | None = None
    city: str | None = None
    routeSlug: str | None = None
    commentCount: int = 0
    unread: int = 0
    at: str | None = None


@app.get("/api/me/follows", response_model=list[FollowedSummit], tags=["消息"],
         responses=ERR_401, summary="我关注的山头（含留言未读数）")
def my_follows(uid: int = Depends(require_user)):
    rows = q("""
        SELECT w.target_key, w.created_at AS at,
               pt.id AS point_id, pt.code, pt.name, pt.altitude, pt.mountain_id,
               coalesce(pt.city, r.city) AS city, r.slug AS route_slug,
               (SELECT count(*) FROM comments c JOIN points peer ON peer.id = c.point_id
                  WHERE (peer.id = pt.id OR (pt.type = 'peak' AND peer.mountain_id = pt.mountain_id))
                    AND c.status <> 'hidden') AS comment_count,
               (SELECT count(*) FROM comments c JOIN points peer ON peer.id = c.point_id
                  WHERE (peer.id = pt.id OR (pt.type = 'peak' AND peer.mountain_id = pt.mountain_id))
                    AND c.status <> 'hidden'
                    AND c.created_at > u.notif_seen_at) AS unread
          FROM wants w
          JOIN users u ON u.id = :uid
          LEFT JOIN points pt ON pt.code = replace(w.target_key, 'p-', '')
          LEFT JOIN routes r ON r.id = pt.route_id
         WHERE w.user_id = :uid AND w.kind = 'peak'
         ORDER BY unread DESC, comment_count DESC, w.created_at DESC
         LIMIT 50""", uid=uid)
    seen_boards = set()
    unique_rows = []
    for row in rows:
        board_key = row["mountain_id"] if row["mountain_id"] is not None else row["target_key"]
        if board_key not in seen_boards:
            seen_boards.add(board_key)
            unique_rows.append(row)
    return [FollowedSummit(targetKey=r["target_key"], pointId=r["point_id"], code=r["code"],
                           name=r["name"], altitude=r["altitude"], city=r["city"],
                           routeSlug=r["route_slug"], commentCount=r["comment_count"],
                           unread=r["unread"],
                           at=r["at"].isoformat() if r["at"] else None) for r in unique_rows]


class NotifItem(BaseModel):
    commentId: int
    pointId: int
    code: str | None = None
    peakName: str | None = None
    who: str | None = None
    text: str
    at: str
    unread: bool = False
    reason: Literal["maintainer", "follow"] = Field(description="为什么提醒你：我维护的 / 我关注的")


@app.get("/api/me/notifications", response_model=list[NotifItem], tags=["消息"],
         responses=ERR_401, summary="留言提醒：我维护或关注的山头上的新留言")
def my_notifications(limit: int = 30, uid: int = Depends(require_user)):
    rows = q("""
        SELECT c.id AS comment_id, c.point_id, c.text, c.created_at,
               pt.code, pt.name AS peak_name, u2.nickname AS who,
               EXISTS (SELECT 1 FROM points peer
                        WHERE (peer.id = pt.id OR (pt.type = 'peak' AND peer.mountain_id = pt.mountain_id))
                          AND (peer.maintainer_id = :uid OR peer.code IN
                               (SELECT code FROM claims WHERE user_id = :uid AND code IS NOT NULL))) AS mine,
               (c.created_at > u.notif_seen_at) AS unread
          FROM comments c
          JOIN points pt ON pt.id = c.point_id
          JOIN users u ON u.id = :uid
          LEFT JOIN users u2 ON u2.id = c.user_id
         WHERE c.status <> 'hidden'
           AND (EXISTS (SELECT 1 FROM points peer
                         WHERE (peer.id = pt.id OR (pt.type = 'peak' AND peer.mountain_id = pt.mountain_id))
                           AND (peer.maintainer_id = :uid OR peer.code IN
                                (SELECT code FROM claims WHERE user_id = :uid AND code IS NOT NULL)))
                OR EXISTS (SELECT 1 FROM wants w JOIN points followed
                            ON followed.code = replace(w.target_key, 'p-', '')
                            WHERE w.user_id = :uid AND w.kind = 'peak'
                              AND (followed.id = pt.id OR (pt.type = 'peak' AND followed.mountain_id = pt.mountain_id))))
         ORDER BY c.created_at DESC
         LIMIT :limit""", uid=uid, limit=limit)
    return [NotifItem(commentId=r["comment_id"], pointId=r["point_id"], code=r["code"],
                      peakName=r["peak_name"], who=r["who"], text=r["text"],
                      at=r["created_at"].isoformat(), unread=bool(r["unread"]),
                      reason="maintainer" if r["mine"] else "follow") for r in rows]


@app.post("/api/me/notifications/seen", status_code=204, tags=["消息"],
          responses=ERR_401, summary="留言提醒全部标记已读")
def seen_notifications(uid: int = Depends(require_user)):
    with engine.begin() as conn:
        conn.execute(text("UPDATE users SET notif_seen_at = now() WHERE id = :u"), {"u": uid})


class HideCommentIn(BaseModel):
    reason: str | None = Field(default=None, max_length=500)


@app.post("/api/comments/{comment_id}/hide", status_code=204, tags=["留言"],
          responses={**ERR_401, **ERR_404, 403: {"description": "不是维护人，也不是作者"}},
          summary="隐藏留言：维护人可以管自己山头下的任意一条")
def hide_comment(comment_id: int, body: HideCommentIn | None = None,
                 uid: int = Depends(require_user)):
    """维护人的"更高权限"就体现在这里：别人山头下的留言他管不着，
    自己山头下的可以隐藏（status=hidden，不物理删除，留痕）。"""
    row = q1("""SELECT c.user_id, c.point_id, c.status, pt.maintainer_id, pt.code
                  FROM comments c JOIN points pt ON pt.id = c.point_id
                 WHERE c.id = :id""", id=comment_id)
    if not row:
        err(404, "COMMENT_NOT_FOUND", "留言不存在")
    if row["user_id"] != uid and not _is_maintainer_of(row, uid) and not _is_board_collaborator(row["point_id"], uid):
        err(403, "NOT_MAINTAINER", "只有维护人（或留言作者自己）能隐藏这条留言")
    reason = body.reason.strip() if body and body.reason else None
    if row["user_id"] != uid and (not reason or len(reason) < 8):
        err(422, "MODERATION_REASON_REQUIRED", "隐藏他人留言须填写至少 8 字理由")
    if row["status"] == "hidden":
        return
    with engine.begin() as conn:
        changed = conn.execute(text("""UPDATE comments SET status = 'hidden',
              hidden_reason = coalesce(:reason, hidden_reason)
            WHERE id = :id AND status <> 'hidden' RETURNING id"""),
            {"id": comment_id, "reason": reason}).first()
        if changed:
            _audit(conn, uid, "comment.hide", "comment", comment_id,
                   {"status": row["status"]}, {"status": "hidden"},
                   reason=reason, point_id=row["point_id"])


class CommentAppealIn(BaseModel):
    reason: str = Field(min_length=8, max_length=500)


class CommentAppealReviewIn(BaseModel):
    decision: Literal["restored", "rejected"]
    note: str = Field(min_length=8, max_length=500)


class CommentAppealOut(BaseModel):
    id: int
    commentId: int
    status: Literal["pending", "restored", "rejected"]
    reason: str
    reviewNote: str | None = None
    commentText: str | None = None
    pointCode: str | None = None
    pointName: str | None = None
    authorName: str | None = None
    hiddenReason: str | None = None


def _appeal_out(row) -> CommentAppealOut:
    return CommentAppealOut(id=row["id"], commentId=row["comment_id"],
                            status=row["status"], reason=row["reason"],
                            reviewNote=row["review_note"],
                            commentText=row.get("comment_text"),
                            pointCode=row.get("point_code"), pointName=row.get("point_name"),
                            authorName=row.get("author_name"),
                            hiddenReason=row.get("hidden_reason"))


class HiddenCommentOut(BaseModel):
    id: int
    text: str
    pointCode: str | None = None
    pointName: str | None = None
    appealable: bool
    appeal: CommentAppealOut | None = None


@app.get("/api/me/hidden-comments", response_model=list[HiddenCommentOut], tags=["留言申诉"])
def my_hidden_comments(uid: int = Depends(require_user)):
    rows = q("""SELECT c.id, c.text, pt.code AS point_code, pt.name AS point_name,
            (c.status = 'hidden' AND (h.actor_id IS NULL OR h.actor_id <> :uid)) AS appealable,
            ca.id AS appeal_id, ca.comment_id AS appeal_comment_id,
            ca.status AS appeal_status, ca.reason AS appeal_reason,
            ca.review_note AS appeal_review_note
        FROM comments c JOIN points pt ON pt.id = c.point_id
        LEFT JOIN LATERAL (SELECT id, actor_id FROM maintenance_audit_logs
            WHERE action = 'comment.hide' AND target_type = 'comment' AND target_id = c.id
            ORDER BY id DESC LIMIT 1) h ON true
        LEFT JOIN comment_appeals ca ON ca.comment_id = c.id
            AND ca.hide_event_id = coalesce(h.id, 0)
        WHERE c.user_id = :uid AND (c.status = 'hidden' OR ca.status = 'restored')
        ORDER BY c.created_at DESC LIMIT 100""", uid=uid)
    return [HiddenCommentOut(id=r["id"], text=r["text"], pointCode=r["point_code"],
                             pointName=r["point_name"], appealable=r["appealable"],
                             appeal=CommentAppealOut(id=r["appeal_id"],
                                commentId=r["appeal_comment_id"], status=r["appeal_status"],
                                reason=r["appeal_reason"], reviewNote=r["appeal_review_note"])
                             if r["appeal_id"] else None) for r in rows]


@app.post("/api/comments/{comment_id}/appeals", response_model=CommentAppealOut,
          tags=["留言申诉"], responses={**ERR_401, **ERR_404})
def appeal_hidden_comment(comment_id: int, body: CommentAppealIn,
                          uid: int = Depends(require_user)):
    reason = body.reason.strip()
    if len(reason) < 8:
        err(422, "APPEAL_REASON_TOO_SHORT", "请至少写 8 字说明申诉理由")
    with engine.begin() as conn:
        row = conn.execute(text("""SELECT id, point_id, user_id, status FROM comments
            WHERE id = :id FOR UPDATE"""), {"id": comment_id}).mappings().first()
        if not row:
            err(404, "COMMENT_NOT_FOUND", "留言不存在")
        if row["user_id"] != uid:
            err(403, "NOT_COMMENT_AUTHOR", "只有留言作者可以申诉")
        if row["status"] != "hidden":
            err(409, "COMMENT_NOT_HIDDEN", "这条留言目前未被隐藏")
        hidden = conn.execute(text("""SELECT id, actor_id FROM maintenance_audit_logs
            WHERE action = 'comment.hide' AND target_type = 'comment' AND target_id = :id
            ORDER BY id DESC LIMIT 1"""), {"id": comment_id}).mappings().first()
        if hidden and hidden["actor_id"] == uid:
            err(409, "SELF_HIDDEN", "自己隐藏的留言不能申诉")
        event_id = hidden["id"] if hidden else 0
        existing = conn.execute(text("""SELECT * FROM comment_appeals
            WHERE comment_id = :id AND hide_event_id = :event"""),
            {"id": comment_id, "event": event_id}).mappings().first()
        if existing:
            return _appeal_out(existing)
        appeal = conn.execute(text("""INSERT INTO comment_appeals
            (comment_id, hide_event_id, author_id, reason)
            VALUES (:id, :event, :uid, :reason) RETURNING *"""),
            {"id": comment_id, "event": event_id, "uid": uid,
             "reason": reason}).mappings().one()
    return _appeal_out(appeal)


@app.get("/api/admin/comment-appeals", response_model=list[CommentAppealOut], tags=["留言申诉"])
def list_comment_appeals(status: Literal["pending", "restored", "rejected"] = "pending",
                         uid: int = Depends(require_content_reviewer)):
    rows = q("""SELECT ca.*, c.text AS comment_text, pt.code AS point_code,
            pt.name AS point_name, u.nickname AS author_name,
            h.reason AS hidden_reason
        FROM comment_appeals ca JOIN comments c ON c.id = ca.comment_id
        JOIN points pt ON pt.id = c.point_id
        JOIN users u ON u.id = ca.author_id
        LEFT JOIN maintenance_audit_logs h ON h.id = ca.hide_event_id
        WHERE ca.status = :status ORDER BY ca.created_at LIMIT 100""", status=status)
    return [_appeal_out(r) for r in rows]


@app.post("/api/admin/comment-appeals/{appeal_id}/review", response_model=CommentAppealOut,
          tags=["留言申诉"])
def review_comment_appeal(appeal_id: int, body: CommentAppealReviewIn,
                          uid: int = Depends(require_content_reviewer)):
    note = body.note.strip()
    if len(note) < 8:
        err(422, "REVIEW_NOTE_TOO_SHORT", "请至少写 8 字复核依据")
    with engine.begin() as conn:
        row = conn.execute(text("""SELECT ca.*, c.point_id, c.status AS comment_status,
                h.actor_id AS hidden_by, h.previous AS hide_previous
            FROM comment_appeals ca JOIN comments c ON c.id = ca.comment_id
            LEFT JOIN maintenance_audit_logs h ON h.id = ca.hide_event_id
            WHERE ca.id = :id FOR UPDATE OF ca, c"""),
            {"id": appeal_id}).mappings().first()
        if not row:
            err(404, "APPEAL_NOT_FOUND", "申诉不存在")
        if row["status"] != "pending" or row["comment_status"] != "hidden":
            err(409, "APPEAL_NOT_PENDING", "申诉或留言状态已改变")
        if uid in (row["author_id"], row["hidden_by"]):
            err(403, "REVIEW_CONFLICT", "作者或隐藏执行人不能复核这条申诉")
        if body.decision == "restored":
            original = (row["hide_previous"] or {}).get("status", "normal")
            original = original if original in ("normal", "flagged") else "normal"
            conn.execute(text("UPDATE comments SET status = :status WHERE id = :id"),
                         {"status": original, "id": row["comment_id"]})
            _audit(conn, uid, "comment.restore", "comment", row["comment_id"],
                   {"status": "hidden"}, {"status": original}, reason=note,
                   point_id=row["point_id"])
        updated = conn.execute(text("""UPDATE comment_appeals SET status = :decision,
            reviewer_id = :uid, review_note = :note, reviewed_at = now()
            WHERE id = :id RETURNING *"""),
            {"decision": body.decision, "uid": uid, "note": note,
             "id": appeal_id}).mappings().one()
        _audit(conn, uid, "comment.appeal_review", "comment_appeal", appeal_id,
               {"status": "pending"}, {"status": body.decision},
               reason=note, point_id=row["point_id"])
    return _appeal_out(updated)


# ==================== 举报与处置 ====================
# 非公开输入：游客和账号都能举报一条留言（岔路情报就是岔路点位上的留言），
# 但只有本人能看到自己提交的举报；处置由 content_reviewer 执行，
# 不能处置自己提交的举报，通过并选择隐藏时复用 comment.hide 审计，
# 于是原作者仍能走 023 的申诉通道。广告举报随广告一起冻结。

class ReportIn(BaseModel):
    targetType: Literal["comment"] = "comment"
    targetId: int = Field(ge=1)
    reason: Literal["spam", "abuse", "false_info", "privacy", "illegal", "other"]
    detail: str | None = Field(default=None, max_length=200)


class ReportOut(BaseModel):
    id: int
    targetType: str
    targetId: int
    reason: str
    detail: str | None = None
    status: Literal["pending", "accepted", "rejected"]
    handleReason: str | None = None
    actionTaken: str | None = None
    createdAt: datetime
    duplicate: bool = Field(default=False,
                            description="同一身份对同一对象的重复举报：返回已存在的那条，不新建")


class ReportQueueItem(BaseModel):
    id: int
    targetType: str
    targetId: int
    reason: str
    detail: str | None = None
    reporter: str = Field(description="举报人昵称；游客没有昵称时显示“游客”")
    createdAt: datetime
    comment: str | None = None
    commentStatus: str | None = None
    commentAuthor: str | None = None
    pointCode: str | None = None
    pointName: str | None = None
    segmentId: int | None = None


class ReportReviewIn(BaseModel):
    decision: Literal["accepted", "rejected"]
    reason: str = Field(min_length=8, max_length=500,
                        description="处置理由，举报人和审计都要能看懂")
    action: Literal["none", "hide"] = Field(
        default="none", description="通过时是否顺带隐藏该留言；驳回时忽略")


def _report_out(row, duplicate: bool = False) -> ReportOut:
    return ReportOut(id=row["id"], targetType=row["target_type"], targetId=row["target_id"],
                     reason=row["reason"], detail=row["detail"], status=row["status"],
                     handleReason=row["handle_reason"], actionTaken=row["action_taken"],
                     createdAt=row["created_at"], duplicate=duplicate)


def _report_identity(uid: int | None, guest):
    """举报必须能追溯到身份：账号优先，其次游客令牌。"""
    if uid is not None:
        return f"u:{uid}", uid, None
    if guest is not None:
        return f"g:{guest['id']}", None, guest["id"]
    return err(401, "REPORT_IDENTITY_REQUIRED", "举报需要一个身份：先扫码获得游客身份或登录账号")


_REPORT_QUEUE_SQL = """
    SELECT r.*,
           coalesce(ru.nickname, '游客') AS reporter_name,
           c.text AS comment_text, c.status AS comment_status, c.segment_id,
           cu.nickname AS comment_author,
           pt.code AS point_code, pt.name AS point_name
      FROM content_reports r
      LEFT JOIN users ru ON ru.id = r.reporter_user_id
      LEFT JOIN comments c ON r.target_type = 'comment' AND c.id = r.target_id
      LEFT JOIN users cu ON cu.id = c.user_id
      LEFT JOIN points pt ON pt.id = c.point_id
"""


@app.post("/api/reports", response_model=ReportOut, status_code=201, tags=["举报"],
          responses={**ERR_401, **ERR_404,
                     409: {"description": "对象不可举报，或举报自己的留言"},
                     429: {"description": "提交过于频繁"}},
          summary="提交非公开举报（游客或账号都可以）")
def submit_report(body: ReportIn, request: Request, response: Response,
                  authorization: str | None = Header(default=None),
                  x_guest_token: str | None = Header(default=None)):
    uid = None
    if authorization and authorization.lower().startswith("bearer "):
        uid = require_user(authorization)
    identity_key, reporter_uid, reporter_gid = _report_identity(uid, _guest_of(x_guest_token))

    comment = q1("SELECT id, user_id, status FROM comments WHERE id = :i", i=body.targetId)
    if not comment:
        err(404, "COMMENT_NOT_FOUND", "留言不存在")
    if comment["status"] == "hidden":
        err(409, "REPORT_TARGET_NOT_REPORTABLE", "这条留言已被隐藏，无需举报")
    if reporter_uid is not None and comment["user_id"] == reporter_uid:
        err(409, "REPORT_SELF", "不能举报自己的留言")

    keys = _rate_check(request, "report", identity_key)

    existing = q1("""SELECT * FROM content_reports
        WHERE target_type = :t AND target_id = :i AND reporter_key = :k AND status = 'pending'""",
                  t=body.targetType, i=body.targetId, k=identity_key)
    if existing:
        response.status_code = 200                 # 重复提交是幂等，不是新建
        return _report_out(existing, duplicate=True)

    detail = (body.detail or "").strip() or None
    with engine.begin() as conn:
        row = conn.execute(text("""INSERT INTO content_reports
                (target_type, target_id, reason, detail,
                 reporter_user_id, reporter_guest_id, reporter_key)
            VALUES (:t, :i, :r, :d, :uid, :gid, :k) RETURNING *"""),
            {"t": body.targetType, "i": body.targetId, "r": body.reason, "d": detail,
             "uid": reporter_uid, "gid": reporter_gid, "k": identity_key}).mappings().one()
    _rate_hit(keys)
    return _report_out(row)


@app.get("/api/admin/reports", response_model=list[ReportQueueItem], tags=["举报"],
         responses={**ERR_401, 403: {"description": "不是内容审核员"}},
         summary="举报队列（content_reviewer）")
def admin_reports(status: Literal["pending", "accepted", "rejected"] = "pending",
                  limit: int = 50, uid: int = Depends(require_content_reviewer)):
    limit = max(1, min(limit, 200))
    rows = q(_REPORT_QUEUE_SQL + " WHERE r.status = :s ORDER BY r.created_at ASC LIMIT :l",
             s=status, l=limit)
    return [ReportQueueItem(
        id=r["id"], targetType=r["target_type"], targetId=r["target_id"],
        reason=r["reason"], detail=r["detail"], reporter=r["reporter_name"],
        createdAt=r["created_at"], comment=r["comment_text"],
        commentStatus=r["comment_status"], commentAuthor=r["comment_author"],
        pointCode=r["point_code"], pointName=r["point_name"], segmentId=r["segment_id"],
    ) for r in rows]


@app.post("/api/admin/reports/{report_id}/review", response_model=ReportOut, tags=["举报"],
          responses={**ERR_401, **ERR_404,
                     403: {"description": "不是内容审核员，或想处置自己提交的举报"},
                     409: {"description": "这条举报已经处理过"}},
          summary="处置举报：通过（可同时隐藏留言）或驳回，必须写理由")
def review_report(report_id: int, body: ReportReviewIn,
                  uid: int = Depends(require_content_reviewer)):
    note = body.reason.strip()
    with engine.begin() as conn:
        row = conn.execute(text("SELECT * FROM content_reports WHERE id = :i FOR UPDATE"),
                           {"i": report_id}).mappings().first()
        if not row:
            err(404, "REPORT_NOT_FOUND", "举报不存在")
        if row["status"] != "pending":
            err(409, "REPORT_ALREADY_HANDLED", "这条举报已经处理过了")
        if row["reporter_user_id"] == uid:
            err(403, "SELF_REVIEW_FORBIDDEN", "不能处置自己提交的举报")

        action_taken = "none"
        if body.decision == "accepted" and body.action == "hide":
            comment = conn.execute(text("""SELECT id, point_id, status FROM comments
                WHERE id = :i FOR UPDATE"""), {"i": row["target_id"]}).mappings().first()
            if comment and comment["status"] != "hidden":
                conn.execute(text("UPDATE comments SET status = 'hidden' WHERE id = :i"),
                             {"i": comment["id"]})
                # 复用留言隐藏的审计动作：023 的申诉通道认这条记录，原作者可以申诉
                _audit(conn, uid, "comment.hide", "comment", comment["id"],
                       {"status": comment["status"]}, {"status": "hidden"},
                       reason=note, point_id=comment["point_id"])
                action_taken = "comment.hide"

        updated = conn.execute(text("""UPDATE content_reports
            SET status = :s, handled_by = :uid, handled_at = now(),
                handle_reason = :note, action_taken = :action
            WHERE id = :i RETURNING *"""),
            {"s": body.decision, "uid": uid, "note": note, "action": action_taken,
             "i": report_id}).mappings().one()
        _audit(conn, uid, "report.review", "report", report_id,
               {"status": "pending"}, {"status": body.decision, "action": action_taken},
               reason=note)
    return _report_out(updated)


@app.get("/api/me/reports", response_model=list[ReportOut], tags=["举报"], responses=ERR_401,
         summary="我提交过的举报与处置结果；看不到别人的")
def my_reports(uid: int = Depends(require_user)):
    rows = q("""SELECT * FROM content_reports WHERE reporter_user_id = :u
        ORDER BY created_at DESC LIMIT 50""", u=uid)
    return [_report_out(r) for r in rows]


# ==================== 账号注销 ====================
# 注销 = 删个人数据 + 匿名化账号行（不是 DELETE users）：
# 审计表对 actor 是 RESTRICT、留言对作者是 CASCADE，物理删会踩两头——
# 要么删不掉，要么把后来者要看的公开路况一起删掉。见迁移 0004 的说明。


class DeleteAccountIn(BaseModel):
    password: str | None = Field(default=None, min_length=1, max_length=128,
                                 description="密码账号再次输入密码")
    code: str | None = Field(default=None, min_length=1, max_length=256,
                             description="微信小程序重新登录取得的一次性 code")
    confirm: str = Field(description="必须原样写“注销”两个字")


class DeletedAccountOut(BaseModel):
    deletedAt: datetime
    removed: dict[str, int] = Field(description="已删除的个人数据行数")
    kept: dict[str, int] = Field(description="保留正文但已去掉身份的内容行数")
    message: str


@app.post("/api/me/delete-account", response_model=DeletedAccountOut, tags=["我"],
          responses={**ERR_401,
                     400: {"description": "确认字样不对"},
                     403: {"description": "密码不对"},
                     409: {"description": "账号已经注销过"}},
          summary="注销账号：删个人数据，公开内容保留但不再署你的名字")
def delete_account(body: DeleteAccountIn, uid: int = Depends(require_user)):
    if body.confirm.strip() != "注销":
        err(400, "CONFIRM_REQUIRED", "请原样输入“注销”两个字再提交")
    user = q1("SELECT username, password_hash, deleted_at FROM users WHERE id = :u", u=uid)
    if not user:
        err(404, "USER_NOT_FOUND", "账号不存在")
    if user["deleted_at"]:
        err(409, "ACCOUNT_DELETED", "这个账号已经注销过了")
    if body.code:
        app_id = os.getenv("WECHAT_APP_ID", "").strip()
        app_secret = os.getenv("WECHAT_APP_SECRET", "").strip()
        if not app_id or not app_secret:
            err(503, "WECHAT_LOGIN_NOT_CONFIGURED", "服务端尚未配置微信小程序登录凭据")
        try:
            with httpx.Client(timeout=8, trust_env=False) as client:
                response = client.get("https://api.weixin.qq.com/sns/jscode2session",
                    params={"appid": app_id, "secret": app_secret,
                            "js_code": body.code, "grant_type": "authorization_code"})
                response.raise_for_status()
                session = response.json()
        except (httpx.HTTPError, ValueError):
            err(502, "WECHAT_LOGIN_UNAVAILABLE", "暂时无法连接微信登录服务，请稍后重试")
        current_openid = q1("SELECT wx_openid FROM users WHERE id=:u AND deleted_at IS NULL", u=uid)
        if not isinstance(session, dict) or session.get("errcode") or not session.get("openid") \
                or not current_openid or session["openid"] != current_openid["wx_openid"]:
            err(403, "REAUTH_FAILED", "微信身份验证失败，请确认当前登录的是此账号")
    elif body.password:
        if not user["password_hash"]:
            err(403, "PASSWORD_MISMATCH", "此账号请使用微信身份验证注销")
        try:
            password_hasher.verify(user["password_hash"], body.password)
        except (VerifyMismatchError, InvalidHashError):
            err(403, "PASSWORD_MISMATCH", "密码不对")
    else:
        err(400, "REAUTH_REQUIRED", "请使用微信身份验证或输入账号密码")

    removed: dict[str, int] = {}
    kept: dict[str, int] = {}
    with engine.begin() as conn:
        def run(sql: str, **params) -> int:
            return conn.execute(text(sql), params).rowcount

        def count(sql: str, **params) -> int:
            return conn.execute(text(sql), params).scalar() or 0

        # 删：位置轨迹、到访、想去、私人纪念与草稿、回执、赞踩、申诉、协作申请、认领、系统角色
        removed["tracks"] = run("DELETE FROM user_tracks WHERE user_id = :u", u=uid)
        # 成绩和打卡回执必须先删：它们分别以 RESTRICT / 身份列引用到访行，
        # 先删到访会被外键挡住，也会把"谁来打过卡"留在库里。
        removed["efforts"] = run("DELETE FROM segment_efforts WHERE user_id = :u", u=uid)
        removed["visitReceipts"] = run(
            "DELETE FROM visit_submission_receipts "
            "WHERE identity_type = 'user' AND identity_id = :u", u=uid)
        removed["visits"] = run("DELETE FROM visits WHERE user_id = :u", u=uid)
        removed["wants"] = run("DELETE FROM wants WHERE user_id = :u", u=uid)
        removed["events"] = run("DELETE FROM events WHERE user_id = :u", u=uid)
        removed["drafts"] = run("DELETE FROM account_arrival_drafts WHERE user_id = :u", u=uid)
        removed["publishReceipts"] = run("DELETE FROM arrival_publish_receipts WHERE user_id = :u", u=uid)
        removed["votes"] = run("DELETE FROM comment_votes WHERE user_id = :u", u=uid)
        removed["appeals"] = run("DELETE FROM comment_appeals WHERE author_id = :u", u=uid)
        removed["collaborationApplications"] = run(
            "DELETE FROM board_collaboration_applications WHERE applicant_id = :u", u=uid)
        removed["transfers"] = run(
            "DELETE FROM transfer_applications WHERE from_user_id = :u OR to_user_id = :u",
            u=uid)
        removed["memberRemovals"] = run(
            "DELETE FROM member_removal_applications "
            "WHERE member_user_id = :u OR requested_by = :u", u=uid)
        removed["createdClans"] = run("DELETE FROM clans WHERE created_by = :u", u=uid)
        removed["coverSubmissions"] = run(
            "DELETE FROM route_cover_submissions WHERE submitter_id = :u", u=uid)
        removed["kingNotifications"] = run(
            "DELETE FROM king_notifications WHERE user_id = :u", u=uid)
        removed["pointSuggestions"] = run(
            "DELETE FROM point_edit_suggestions WHERE author_id = :u", u=uid)
        removed["claims"] = run("DELETE FROM claims WHERE user_id = :u", u=uid)
        removed["roles"] = run("DELETE FROM system_roles WHERE user_id = :u", u=uid)
        removed["letters"] = run("DELETE FROM letters WHERE user_id = :u", u=uid)
        removed["maintainedPoints"] = run(
            "UPDATE points SET maintainer_id = NULL WHERE maintainer_id = :u", u=uid)

        # 保留正文、去掉身份归属：这些行仍指向本账号，但账号本身马上会被匿名化
        kept["comments"] = count("SELECT count(*) FROM comments WHERE user_id = :u", u=uid)
        kept["reports"] = count("SELECT count(*) FROM content_reports WHERE reporter_user_id = :u", u=uid)
        kept["auditLogs"] = count("SELECT count(*) FROM maintenance_audit_logs WHERE actor_id = :u", u=uid)
        kept["reviews"] = count("SELECT count(*) FROM comment_appeals WHERE reviewer_id = :u", u=uid)
        kept["unlinkedScans"] = run("UPDATE scans SET user_id = NULL WHERE user_id = :u", u=uid)
        kept["mergedGuests"] = run("UPDATE guests SET merged_user_id = NULL WHERE merged_user_id = :u", u=uid)
        kept["adVersions"] = count("SELECT count(*) FROM summit_ads WHERE author_id = :u", u=uid)

        deleted_at = conn.execute(text("""UPDATE users
            SET username = NULL, email = NULL, nickname = NULL, avatar = NULL,
                password_hash = NULL, wx_openid = NULL, wx_unionid = NULL,
                deleted_at = now(), last_seen_at = now()
            WHERE id = :u RETURNING deleted_at"""), {"u": uid}).scalar()
    return DeletedAccountOut(
        deletedAt=deleted_at, removed=removed, kept=kept,
        message="账号已注销：到访、轨迹和私人纪念已删除，公开留言保留但不再显示你的名字。"
                "同一个用户名可以重新注册，但那是一个新账号。")


# ==================== 山头广告位 ====================
# 同一块山顶板只有一个展示位；新素材可待审，但不能挤掉当前版本。

AD_DAYS_MAX = 30                               # 单条最长投放天数


class AdOut(BaseModel):
    id: int
    title: str
    body: str | None = None
    image: str | None = None
    link: str | None = None
    status: Literal["draft", "pending", "approved", "rejected", "expired"]
    rejectReason: str | None = None
    promoted: bool = Field(default=False,
                           description="审核时被提升到第一屏的广告；默认只出现在留言区顶部")
    endsAt: str
    durationDays: int = 30
    pointId: int | None = None
    pointCode: str | None = None
    peakName: str | None = None
    authorName: str | None = None


class AdQuota(BaseModel):
    level: int
    levelName: str
    used: int = Field(description="该留言板当前展示的广告位数量，0 或 1")
    total: int = Field(description="每块留言板固定一个广告位")


class AdsOut(BaseModel):
    items: list[AdOut] = Field(default_factory=list, description="已过审且在有效期内的")
    mine: list[AdOut] = Field(default_factory=list, description="我自己投的（含待审 / 被拒）")
    quota: AdQuota | None = None
    isMaintainer: bool = False


class AdIn(BaseModel):
    title: str = Field(min_length=2, max_length=30)
    body: str | None = Field(default=None, max_length=60)
    image: str | None = None
    link: str | None = None
    days: int = Field(default=30, ge=1, le=AD_DAYS_MAX)


class AdDraftIn(BaseModel):
    title: str = Field(default="", max_length=30)
    body: str | None = Field(default=None, max_length=60)
    image: str | None = None
    link: str | None = None
    days: int = Field(default=30, ge=1, le=AD_DAYS_MAX)


class AdReviewIn(BaseModel):
    approve: bool
    reason: str | None = Field(default=None, max_length=60)
    promote: bool = Field(default=False, description="通过时顺带放到第一屏（只在 approve=true 时有意义）")


def _ad_out(r) -> AdOut:
    status = "expired" if r["status"] == "approved" and r["ends_at"] <= datetime.now(timezone.utc) else r["status"]
    return AdOut(id=r["id"], title=r["title"], body=r["body"], image=r["image"],
                 link=r["link"], status=status, rejectReason=r["reject_reason"],
                 promoted=bool(r["promoted"]) and status == "approved",
                 endsAt=r["ends_at"].isoformat(), durationDays=r["duration_days"],
                 pointId=r.get("point_id"),
                 pointCode=r.get("point_code"), peakName=r.get("peak_name"),
                 authorName=r.get("author_name"))


AD_SELECT = """
    SELECT a.*, pt.code AS point_code, pt.name AS peak_name,
           pt.mountain_id, u.nickname AS author_name
      FROM summit_ads a
      JOIN points pt ON pt.id = a.point_id
      LEFT JOIN users u ON u.id = a.author_id
"""


def _is_maintainer_of(point_row, uid: int | None) -> bool:
    if uid is None:
        return False
    point_id = point_row.get("id") or point_row.get("point_id")
    if not point_id:
        return False
    return bool(q1("""SELECT 1 AS ok
        FROM points pt JOIN mountain_members mm ON mm.mountain_id = pt.mountain_id
        WHERE pt.id = :pid AND mm.user_id = :uid
          AND mm.status = 'active' AND mm.role = 'owner'
        LIMIT 1""", pid=point_id, uid=uid))


def _is_mountain_owner(mountain_id: int, uid: int) -> bool:
    return bool(q1("""SELECT 1 AS ok FROM mountain_members
        WHERE mountain_id = :mid AND user_id = :uid
          AND status = 'active' AND role = 'owner'
        LIMIT 1""", mid=mountain_id, uid=uid))


def _is_place_curator(uid: int) -> bool:
    return bool(q1("""SELECT 1 AS ok FROM system_roles
        WHERE user_id = :uid AND role = 'place_curator'
        LIMIT 1""", uid=uid))


def _is_board_collaborator(point_id: int, uid: int) -> bool:
    return bool(q1("""SELECT 1 AS ok
        FROM points pt JOIN mountain_members mm ON mm.mountain_id = pt.mountain_id
        WHERE pt.id = :pid AND mm.user_id = :uid
          AND mm.status = 'active' AND mm.role = 'member'
        LIMIT 1""", pid=point_id, uid=uid))


class CollaborationApplyIn(BaseModel):
    message: str = Field(min_length=8, max_length=500)


class CollaborationReviewIn(BaseModel):
    decision: Literal["approved", "rejected", "revoked"]
    note: str = Field(min_length=8, max_length=500)


class CollaborationOut(BaseModel):
    id: int
    boardId: int
    applicantId: int
    boardName: str | None = None
    applicantName: str | None = None
    status: Literal["pending", "approved", "rejected", "revoked"]
    message: str
    reviewNote: str | None = None
    createdAt: str


def _collaboration_out(row) -> CollaborationOut:
    return CollaborationOut(id=row["id"], boardId=row["board_id"],
                            applicantId=row["applicant_id"],
                            boardName=row.get("board_name"), applicantName=row.get("applicant_name"),
                            status=row["status"],
                            message=row["message"], reviewNote=row["review_note"],
                            createdAt=row["created_at"].isoformat())


@app.get("/api/me/collaboration-applications", response_model=list[CollaborationOut], tags=["维护协作"])
def my_collaboration_applications(uid: int = Depends(require_user)):
    return [_collaboration_out(r) for r in q("""SELECT * FROM board_collaboration_applications
        WHERE applicant_id = :uid ORDER BY created_at DESC LIMIT 100""", uid=uid)]


@app.post("/api/boards/{board_id}/collaboration-applications", response_model=CollaborationOut,
          tags=["维护协作"], responses={**ERR_401, **ERR_404})
def apply_board_collaboration(board_id: int, body: CollaborationApplyIn,
                              uid: int = Depends(require_user)):
    err(410, "UPGRADE_REQUIRED",
        "协作申请入口已并入统一山头申请：请从「占山为王 → 申请成为负责人 / 加入山寨」提交。")
    message = body.message.strip()
    if len(message) < 8:
        err(422, "APPLICATION_MESSAGE_TOO_SHORT", "请至少写 8 个字说明维护计划")
    board = q1("""SELECT b.id, pt.id AS point_id, pt.code, pt.maintainer_id
        FROM boards b JOIN points pt ON pt.mountain_id = b.mountain_id AND pt.type = 'peak'
        WHERE b.id = :bid AND b.board_type = 'summit' ORDER BY pt.id LIMIT 1""", bid=board_id)
    if not board:
        err(404, "BOARD_NOT_FOUND", "山顶留言板不存在")
    if not q1("""SELECT 1 AS ok FROM points pt LEFT JOIN claims cl
          ON cl.code = pt.code AND cl.status = 'active'
        WHERE pt.mountain_id = (SELECT mountain_id FROM boards WHERE id = :bid)
          AND (pt.maintainer_id IS NOT NULL OR cl.id IS NOT NULL) LIMIT 1""", bid=board_id):
        err(409, "BOARD_UNMAINTAINED", "这块板尚无人维护，请使用山头认领入口")
    if _is_maintainer_of(board, uid):
        err(409, "ALREADY_MAINTAINER", "你已经是这块板的维护人")
    existing = q1("""SELECT * FROM board_collaboration_applications
        WHERE board_id = :bid AND applicant_id = :uid AND status IN ('pending', 'approved')
        ORDER BY id DESC LIMIT 1""", bid=board_id, uid=uid)
    if existing:
        return _collaboration_out(existing)
    try:
        with engine.begin() as conn:
            row = conn.execute(text("""INSERT INTO board_collaboration_applications
                (board_id, applicant_id, message) VALUES (:bid, :uid, :message)
                RETURNING *"""), {"bid": board_id, "uid": uid,
                                  "message": message}).mappings().one()
    except IntegrityError:
        row = q1("""SELECT * FROM board_collaboration_applications
            WHERE board_id = :bid AND applicant_id = :uid AND status IN ('pending', 'approved')
            ORDER BY id DESC LIMIT 1""", bid=board_id, uid=uid)
        if not row:
            raise
    return _collaboration_out(row)


@app.get("/api/admin/collaboration-applications", response_model=list[CollaborationOut], tags=["维护协作"])
def list_collaboration_applications(status: Literal["pending", "approved", "rejected", "revoked"] = "pending",
                                    uid: int = Depends(require_collaboration_reviewer)):
    return [_collaboration_out(r) for r in q("""SELECT ca.*, m.name AS board_name,
            u.nickname AS applicant_name
        FROM board_collaboration_applications ca
        JOIN boards b ON b.id = ca.board_id
        LEFT JOIN mountains m ON m.id = b.mountain_id
        JOIN users u ON u.id = ca.applicant_id
        WHERE ca.status = :status ORDER BY ca.created_at LIMIT 100""", status=status)]


@app.post("/api/admin/collaboration-applications/{application_id}/review",
          response_model=CollaborationOut, tags=["维护协作"])
def review_collaboration_application(application_id: int, body: CollaborationReviewIn,
                                     uid: int = Depends(require_collaboration_reviewer)):
    err(410, "UPGRADE_REQUIRED",
        "旧协作审核入口已停用：新的成员身份只由统一申请审核授予。")
    row = q1("SELECT * FROM board_collaboration_applications WHERE id = :id", id=application_id)
    if not row:
        err(404, "APPLICATION_NOT_FOUND", "协作申请不存在")
    allowed = (row["status"] == "pending" and body.decision in ("approved", "rejected")) or (
        row["status"] == "approved" and body.decision == "revoked")
    if not allowed:
        err(409, "INVALID_APPLICATION_TRANSITION", "当前申请状态不能执行此操作")
    if row["applicant_id"] == uid:
        err(403, "SELF_REVIEW_FORBIDDEN", "不能审核自己的申请")
    with engine.begin() as conn:
        updated = conn.execute(text("""UPDATE board_collaboration_applications
            SET status = :status, reviewer_id = :uid, review_note = :note, reviewed_at = now()
            WHERE id = :id AND status = :old RETURNING *"""),
            {"status": body.decision, "uid": uid, "note": body.note.strip(),
             "id": application_id, "old": row["status"]}).mappings().first()
        if updated:
            _audit(conn, uid, "collaboration.review", "collaboration_application", application_id,
                   {"status": row["status"]}, {"status": updated["status"]},
                   reason=body.note.strip(), board_id=row["board_id"])
    if not updated:
        err(409, "APPLICATION_CHANGED", "申请状态已变化，请刷新后重试")
    return _collaboration_out(updated)


@app.get("/api/ads", response_model=list[AdOut], tags=["广告"],
         summary="全站广告流：已过审且在有效期内的，首页与路书页的轮播位用")
def list_ads(limit: int = 12):
    rows = q(AD_SELECT + """
        WHERE a.status = 'approved' AND a.ends_at > now()
          AND u.password_hash IS NOT NULL
        ORDER BY a.weight DESC, a.reviewed_at DESC NULLS LAST, a.id DESC""")
    seen = set()
    items = []
    for row in rows:
        board_key = row["mountain_id"] or -row["point_id"]
        if board_key in seen:
            continue
        seen.add(board_key)
        items.append(_ad_out(row))
        if len(items) >= limit:
            break
    return items


@app.get("/api/points/{code}/ads", response_model=AdsOut, tags=["广告"],
         responses=ERR_404, summary="某个山头的广告位：公开部分 + 我自己的投放状态与额度")
def point_ads(code: str, authorization: str | None = Header(default=None)):
    pt = q1("SELECT id, code, maintainer_id FROM points WHERE code = :c", c=code)
    if not pt:
        err(404, "POINT_NOT_FOUND", "点位不存在")
    point_ids = _board_point_ids(pt["id"])
    uid = None
    if authorization and authorization.lower().startswith("bearer "):
        try:
            uid = require_user(authorization)
        except HTTPException:
            uid = None
    live = q(AD_SELECT + """
        WHERE a.point_id = ANY(:ids) AND a.status = 'approved' AND a.ends_at > now()
          AND u.password_hash IS NOT NULL
        ORDER BY a.reviewed_at DESC NULLS LAST, a.id DESC LIMIT 1""", ids=point_ids)
    out = AdsOut(items=[_ad_out(r) for r in live])
    if _is_maintainer_of(pt, uid):
        out.isMaintainer = True
        mine = q(AD_SELECT + """
            WHERE a.point_id = ANY(:ids) AND a.author_id = :u
            ORDER BY a.id DESC LIMIT 20""", ids=point_ids, u=uid)
        out.mine = [_ad_out(r) for r in mine]
        used = q1("""SELECT count(*) AS n FROM summit_ads
                      WHERE point_id = ANY(:ids) AND status = 'approved'
                        AND ends_at > now()""", ids=point_ids)["n"]
        out.quota = AdQuota(level=1, levelName="每板一位", used=min(used, 1), total=1)
    return out


@app.post("/api/points/{code}/ads", response_model=AdOut, tags=["广告"],
          responses={**ERR_401, **ERR_404,
                     403: {"description": "不是这个山头的维护人"}},
          summary="投广告（维护人）：提交后进待审队列，过审才上架")
def create_ad(code: str, body: AdIn, uid: int = Depends(require_user)):
    pt = q1("""SELECT pt.id, pt.code, pt.maintainer_id FROM points pt WHERE pt.code = :c""",
            c=code)
    if not pt:
        err(404, "POINT_NOT_FOUND", "点位不存在")
    point_ids = _board_point_ids(pt["id"])
    if not _is_maintainer_of(pt, uid):
        err(403, "NOT_MAINTAINER", "只有这个山头的维护人（或山大王）能投广告")
    with engine.begin() as conn:
        conn.execute(text("SELECT id FROM points WHERE id = ANY(:ids) ORDER BY id FOR UPDATE"),
                     {"ids": point_ids})
        aid = conn.execute(text("""
            INSERT INTO summit_ads (point_id, author_id, title, body, image, link, duration_days, ends_at)
            VALUES (:p, :u, :t, :b, :img, :l, :d, now() + make_interval(days => :d))
            RETURNING id"""),
            {"p": pt["id"], "u": uid, "t": body.title, "b": body.body,
             "img": body.image, "l": body.link, "d": body.days}).scalar()
    return _ad_out(q1(AD_SELECT + " WHERE a.id = :i", i=aid))


@app.post("/api/points/{code}/ads/drafts", response_model=AdOut, tags=["广告"],
          responses={**ERR_401, **ERR_404, 403: {"description": "不是本板维护人"}},
          summary="维护人保存广告草稿，不进入审核或公开展示")
def create_ad_draft(code: str, body: AdDraftIn, uid: int = Depends(require_user)):
    pt = q1("SELECT id, code, maintainer_id FROM points WHERE code = :c", c=code)
    if not pt:
        err(404, "POINT_NOT_FOUND", "点位不存在")
    if not _is_maintainer_of(pt, uid):
        err(403, "NOT_MAINTAINER", "只有本板维护人能保存广告草稿")
    with engine.begin() as conn:
        aid = conn.execute(text("""INSERT INTO summit_ads
            (point_id, author_id, title, body, image, link, duration_days, status, ends_at)
            VALUES (:p, :u, :t, :b, :img, :l, :d, 'draft', now() + make_interval(days => :d))
            RETURNING id"""),
            {"p": pt["id"], "u": uid, "t": body.title.strip(), "b": body.body,
             "img": body.image, "l": body.link, "d": body.days}).scalar_one()
    return _ad_out(q1(AD_SELECT + " WHERE a.id = :i", i=aid))


def _editable_ad(conn, code: str, ad_id: int, uid: int):
    pt = conn.execute(text("SELECT id, code, maintainer_id FROM points WHERE code = :c"),
                      {"c": code}).mappings().first()
    if not pt:
        err(404, "POINT_NOT_FOUND", "点位不存在")
    if not _is_maintainer_of(pt, uid):
        err(403, "NOT_MAINTAINER", "只有本板维护人能编辑广告")
    row = conn.execute(text("""SELECT id, author_id, status FROM summit_ads
        WHERE id = :i AND point_id = ANY(:ids) FOR UPDATE"""),
        {"i": ad_id, "ids": _board_point_ids(pt["id"])}).mappings().first()
    if not row:
        err(404, "AD_NOT_FOUND", "本板没有这条广告")
    if row["author_id"] != uid:
        err(403, "NOT_AD_AUTHOR", "只能修改自己提交的素材")
    if row["status"] not in ("draft", "rejected"):
        err(409, "AD_NOT_EDITABLE", "待审或已通过的版本不能修改")
    return row


@app.patch("/api/points/{code}/ads/{ad_id}", response_model=AdOut, tags=["广告"],
           summary="修改草稿或被驳回的广告，回到草稿状态")
def edit_ad_draft(code: str, ad_id: int, body: AdDraftIn,
                  uid: int = Depends(require_user)):
    with engine.begin() as conn:
        _editable_ad(conn, code, ad_id, uid)
        conn.execute(text("""UPDATE summit_ads SET title = :t, body = :b, image = :img,
            link = :l, duration_days = :d, status = 'draft', reject_reason = NULL,
            reviewed_by = NULL, reviewed_at = NULL, promoted = false
            WHERE id = :i"""),
            {"t": body.title.strip(), "b": body.body, "img": body.image,
             "l": body.link, "d": body.days, "i": ad_id})
    return _ad_out(q1(AD_SELECT + " WHERE a.id = :i", i=ad_id))


@app.post("/api/points/{code}/ads/{ad_id}/submit", response_model=AdOut, tags=["广告"],
          summary="将草稿提交系统审核")
def submit_ad_draft(code: str, ad_id: int, uid: int = Depends(require_user)):
    with engine.begin() as conn:
        _editable_ad(conn, code, ad_id, uid)
        row = conn.execute(text("SELECT title, duration_days FROM summit_ads WHERE id = :i"),
                           {"i": ad_id}).mappings().one()
        if len(row["title"].strip()) < 2:
            err(400, "AD_TITLE_REQUIRED", "提交审核前请填写至少两个字的标题")
        conn.execute(text("""UPDATE summit_ads SET status = 'pending', starts_at = now(),
            ends_at = now() + make_interval(days => duration_days)
            WHERE id = :i"""), {"i": ad_id})
    return _ad_out(q1(AD_SELECT + " WHERE a.id = :i", i=ad_id))


@app.get("/api/admin/ads", response_model=list[AdOut], tags=["广告"],
         responses=ERR_401, summary="审核队列（运营）：待审的广告")
def admin_ads(status: str = "pending", limit: int = 50, uid: int = Depends(require_ad_reviewer)):
    rows = q(AD_SELECT + """
        WHERE a.status = :st ORDER BY a.id LIMIT :limit""", st=status, limit=limit)
    return [_ad_out(r) for r in rows]


@app.post("/api/admin/ads/{ad_id}/review", response_model=AdOut, tags=["广告"],
          responses={**ERR_401, **ERR_404, 403: {"description": "不能审自己投的广告"}},
          summary="审核广告（运营）：通过 / 驳回（附理由）")
def review_ad(ad_id: int, body: AdReviewIn, uid: int = Depends(require_ad_reviewer)):
    with engine.begin() as conn:
        row = conn.execute(text("SELECT id, point_id, author_id, status, promoted FROM summit_ads WHERE id = :i FOR UPDATE"),
                           {"i": ad_id}).mappings().first()
        if not row:
            err(404, "AD_NOT_FOUND", "广告不存在")
        if row["author_id"] == uid:
            err(403, "SELF_REVIEW_FORBIDDEN", "不能审核自己提交的广告")
        if row["status"] != "pending":
            err(409, "ALREADY_REVIEWED", "这条已经审过了")
        if body.approve:
            point_ids = _board_point_ids(row["point_id"])
            conn.execute(text("SELECT id FROM points WHERE id = ANY(:ids) ORDER BY id FOR UPDATE"),
                         {"ids": point_ids})
            conn.execute(text("""UPDATE summit_ads SET status = 'expired', promoted = false
                WHERE point_id = ANY(:ids) AND status = 'approved' AND id <> :i"""),
                {"ids": point_ids, "i": ad_id})
        conn.execute(text("""UPDATE summit_ads
            SET status = :st, reviewed_by = :u, reviewed_at = now(), reject_reason = :r,
                promoted = :pr,
                starts_at = CASE WHEN :approve THEN now() ELSE starts_at END,
                ends_at = CASE WHEN :approve THEN now() + make_interval(days => duration_days)
                               ELSE ends_at END
            WHERE id = :i"""),
            {"st": "approved" if body.approve else "rejected", "u": uid,
             "r": None if body.approve else (body.reason or "不符合投放规范"),
             "pr": bool(body.approve and body.promote),
             "approve": body.approve,
             "i": ad_id})
        _audit(conn, uid, "ad.review", "summit_ad", ad_id,
               {"status": row["status"], "promoted": row["promoted"]},
               {"status": "approved" if body.approve else "rejected",
                "promoted": bool(body.approve and body.promote)},
               reason="审核通过" if body.approve else (body.reason or "不符合投放规范"),
               point_id=row["point_id"])
    return _ad_out(q1(AD_SELECT + " WHERE a.id = :i", i=ad_id))


@app.post("/api/admin/ads/{ad_id}/promote", response_model=AdOut, tags=["广告"],
          responses={**ERR_401, **ERR_404, 409: {"description": "只有已上架的广告能调位置"}},
          summary="运营：把已上架的广告提到第一屏 / 退回留言区")
def promote_ad(ad_id: int, promote: bool = True, uid: int = Depends(require_ad_reviewer)):
    with engine.begin() as conn:
        row = conn.execute(text("""SELECT id, point_id, author_id, status, ends_at, promoted
            FROM summit_ads WHERE id = :i FOR UPDATE"""), {"i": ad_id}).mappings().first()
        if not row:
            err(404, "AD_NOT_FOUND", "广告不存在")
        if row["author_id"] == uid:
            err(403, "SELF_REVIEW_FORBIDDEN", "不能提升自己提交的广告")
        if row["status"] != "approved" or row["ends_at"] <= datetime.now(timezone.utc):
            err(409, "NOT_APPROVED", "只有已上架的广告能调位置")
        conn.execute(text("UPDATE summit_ads SET promoted = :p WHERE id = :i"),
                     {"p": promote, "i": ad_id})
        if bool(row["promoted"]) != promote:
            _audit(conn, uid, "ad.promote", "summit_ad", ad_id,
                   {"promoted": bool(row["promoted"])}, {"promoted": promote},
                   reason="提升首屏" if promote else "退回默认位", point_id=row["point_id"])
    return _ad_out(q1(AD_SELECT + " WHERE a.id = :i", i=ad_id))


class TrackIn(BaseModel):
    name: str | None = Field(default=None, description="不填就用文件名")
    text: str = Field(description="轨迹文件的原文；前端 FileReader 读出来直接发")
    filename: str | None = None


@app.post("/api/tracks", tags=["我的轨迹"], responses={**ERR_401, 400: {"description": "读不出轨迹"}},
          summary="上传一条轨迹（GPX / KML）→ 识别出这条线上的山顶，作为拼图候选")
def upload_track(body: TrackIn, uid: int = Depends(require_user)):
    """用户上传自己的轨迹。

    **只当候选，不算打卡。** 识别出来的山顶在拼图里是灰的，只有到现场扫码才点亮——
    上传 ≠ 去过，这条在数据层就分开（`user_tracks.peaks` vs `visits`）。
    解析复用和线路同一套管线（抽稀 → 找山顶 → 分段），所以形状完全一致。
    """
    fn = (body.filename or body.name or "track").strip()
    src = "kml" if fn.lower().endswith(".kml") else "gpx"
    if not re.search(r"<(trkpt|rtept|coordinates)\b", body.text):
        err(400, "NOT_A_TRACK", "这个文件里没有轨迹点")
    with tempfile.NamedTemporaryFile("w", suffix="." + src, delete=False,
                                     encoding="utf-8") as fh:
        fh.write(body.text)
        tmp = fh.name
    if "/srv/pipeline" not in sys.path:
        sys.path.insert(0, "/srv/pipeline")
    try:
        import build  # pipeline/build.py：和生成我们线路用的是同一套
        res = build.pickup(pathlib.Path(tmp))
    except Exception as e:                       # noqa: BLE001
        err(400, "TRACK_PARSE_FAILED", f"读不出这条轨迹：{e}")
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass
    if not res:
        err(400, "TRACK_TOO_SHORT", "轨迹太短（至少 500 m、10 个点），或者是空的")
    peaks = res.get("peaks") or []
    app_guess = None
    m = re.search(r"<creator[^>]*>([^<]+)</creator>", body.text)
    if m:
        c = m.group(1).lower()
        for k in ("garmin", "coros", "suunto", "strava", "huawei", "zepp", "amap", "xingzhe"):
            if k in c:
                app_guess = k
                break
    with engine.begin() as conn:
        tid = conn.execute(text("""INSERT INTO user_tracks
            (user_id, name, source, source_app, distance_m, gain_m, loss_m, point_count,
             path, profile, peaks, segments)
            VALUES (:u, :n, :s, :a, :d, :g, :l, :pc,
                    CAST(:path AS jsonb), CAST(:prof AS jsonb),
                    CAST(:peaks AS jsonb), CAST(:segs AS jsonb))
            RETURNING id"""),
            {"u": uid, "n": body.name or fn.rsplit(".", 1)[0], "s": src, "a": app_guess,
             "d": int(res["km"] * 1000), "g": res["up"], "l": res["down"],
             "pc": res.get("points"), "path": json.dumps(res["path"]),
             "prof": json.dumps(res["profile"]), "peaks": json.dumps(peaks),
             "segs": json.dumps(res.get("segments") or [])}).scalar()
    return {"id": tid, "name": body.name or fn.rsplit(".", 1)[0], "source": src,
            "sourceApp": app_guess, "km": res["km"], "up": res["up"], "down": res["down"],
            "peakCount": len(peaks), "peaks": peaks,
            "note": "已摆进拼图，灰色待点亮——到现场扫码才会亮"}


@app.get("/api/me/tracks", tags=["我的轨迹"], responses=ERR_401,
         summary="我上传的轨迹（它们识别出的山顶 = 拼图的灰色候选）")
def my_tracks(uid: int = Depends(require_user)):
    rows = q("""SELECT id, name, source, source_app, distance_m, gain_m, point_count,
                       peaks, created_at FROM user_tracks
                WHERE user_id = :uid AND status = 'ready'
                ORDER BY created_at DESC LIMIT 50""", uid=uid)
    return [{"id": r["id"], "name": r["name"], "source": r["source"],
             "sourceApp": r["source_app"], "km": round((r["distance_m"] or 0) / 1000, 1),
             "up": r["gain_m"], "pointCount": r["point_count"],
             "peaks": r["peaks"] or [], "at": r["created_at"].isoformat()} for r in rows]


@app.get("/api/me/route-progress", tags=["我"], responses=ERR_401,
         summary="山径拼图：一座山一格，格里是山脚 + 山顶两个扫码点")
def route_progress(uid: int = Depends(require_user)):
    """**一格 = 一座山，不是一格一个扫码点。**

    一个山头天然有两个扫码输入点：**山脚**和**山顶**。
    只扫了其中一个 → 这格点亮，但没有登顶时间；
    两个都扫了 → 这格记下**登顶用时**（山顶那次 − 同一天山脚那次）。
    格子上要能显示三个维度：**打卡人 / 打卡时间 / 打卡次数**。

    同一天的山脚和山顶自动配对算用时；一天里爬两个顶，两个格各自算各自的。
    """
    routes = q("""SELECT DISTINCT r.id, r.slug, r.name FROM visits v
                  JOIN points p ON p.id = v.point_id
                  JOIN routes r ON r.id = p.route_id
                  WHERE v.user_id = :uid""", uid=uid)
    out = []
    for r in routes:
        pts = q("""SELECT id, code, name, type, index_in_route, altitude
                   FROM points WHERE route_id = :rid AND status = 'published'
                     AND type IN ('peak', 'trailhead')
                   ORDER BY index_in_route""", rid=r["id"])
        start = next((p for p in pts if p["type"] == "trailhead"), None)
        peaks = [p for p in pts if p["type"] == "peak"]

        # 我的打卡：按天配对，同一天先山脚后山顶就是一次登顶
        myrows = q("""SELECT point_id, created_at, visit_date FROM visits
                      WHERE user_id = :uid AND point_id = ANY(:ids)
                      ORDER BY created_at""", uid=uid,
                   ids=[p["id"] for p in pts] or [0])
        by_point = {}
        for v in myrows:
            by_point.setdefault(v["point_id"], []).append(v)
        start_by_date = {}
        if start:
            for v in by_point.get(start["id"], []):
                start_by_date.setdefault(v["visit_date"], v["created_at"])

        summits = []
        for p in peaks:
            mine = by_point.get(p["id"], [])
            recs = []
            for v in mine:
                s0 = start_by_date.get(v["visit_date"])
                use = None
                if s0 and v["created_at"] > s0:
                    secs = int((v["created_at"] - s0).total_seconds())
                    use = f"{secs // 3600}:{secs % 3600 // 60:02d}"
                recs.append({"at": v["created_at"].isoformat(), "time": use})
            times = [x["time"] for x in recs if x["time"]]
            summits.append({
                "code": p["code"], "name": p["name"], "altitude": p["altitude"],
                "index": p["index_in_route"], "href": "#/peaks/p-" + p["code"],
                # 两个扫码输入点。山脚是整条线路共用的那一个
                "start": {**({"code": start["code"],
                              "mine": len(by_point.get(start["id"], [])),
                              "lastAt": (by_point[start["id"]][-1]["created_at"].isoformat()
                                         if by_point.get(start["id"]) else None)}
                            if start else {}), "label": "山脚"},
                "top": {"code": p["code"], "mine": len(mine), "label": "山顶",
                        "lastAt": mine[-1]["created_at"].isoformat() if mine else None},
                # 打卡人 / 打卡时间 / 打卡次数 —— 格子上要显示的三样
                "climber": "我" if mine else None,
                "count": len(mine),
                "times": recs,
                "climbTime": min(times) if times else None,
            })
        done = [s for s in summits if s["climbTime"]]
        out.append({
            "routeSlug": r["slug"], "routeName": r["name"],
            "visited": sum(1 for s in summits if s["count"]), "total": len(peaks),
            "complete": bool(done), "climbTime": min((s["climbTime"] for s in done),
                                                     default=None),
            "summits": summits,
        })
    # 有完整记录的排前面，其次按点亮的座数，最后按名字——不然 15 个顶只亮 1 个的
    # 线路会把只亮 3 个但都完整的线路压到下面去
    out.sort(key=lambda x: (not x["complete"], -x["visited"], x["routeName"]))
    return out


@app.get("/api/visits/recent", tags=["打卡"],
         summary="最近的打卡流水（谁 · 在哪座山 · 什么时候）")
def recent_visits(days: int = 7, limit: int = 30):
    rows = q("""SELECT u.nickname AS who, v.created_at AS at, v.seq,
                       v.duration_sec,
                       coalesce(r.name, pt.name) AS place,
                       r.slug AS route_slug, pt.code,
                       pt.type
                FROM visits v
                JOIN users  u  ON u.id = v.user_id
                JOIN points pt ON pt.id = v.point_id
                LEFT JOIN routes r ON r.id = pt.route_id
                WHERE v.created_at > now() - make_interval(days => :days)
                ORDER BY v.created_at DESC
                LIMIT :limit""", days=days, limit=limit)
    out = []
    for r in rows:
        d = dict(r)
        secs = d.pop("duration_sec")
        d["time"] = f"{secs // 3600}:{secs % 3600 // 60:02d}" if secs else None
        d["at"] = d["at"].isoformat()
        # 前端点流水的每一行要能跳回去：线路点 → 路书，自建点位 → 山头详情
        d["href"] = ("#/trails/" + d["route_slug"]) if d["route_slug"] else ("#/peaks/p-" + d["code"])
        out.append(d)
    return out


# ==================== 打卡 ====================

# ==================== 游客（不登录也能打卡）====================
# 规则：游客**只能看（路书 / 山头 / 留言）+ 打卡**，打卡产出的是
# "带时间戳的到此一游凭证"。想留言、想给自己起个称呼，都要走注册流程，
# 所以这里**没有任何 UGC 写入口** —— 匿名内容带来的审核风险从根上没有。

class GuestOut(BaseModel):
    token: str
    createdAt: str


class GuestVisitIn(BaseModel):
    code: str = Field(description="点位编号，二维码里印的就是它")
    source: Literal["scan", "nearby", "manual"] = "scan"
    clientUuid: str | None = None
    occurredAt: datetime | None = None
    lat: float | None = None
    lng: float | None = None
    accuracyM: int | None = None


class GuestArrivalDraftIn(BaseModel):
    code: str
    privateNote: str | None = Field(default=None, max_length=500)
    publicCommentDraft: str | None = Field(default=None, max_length=200)


class GuestVisitOut(BaseModel):
    visitId: int | None = None
    seq: int = Field(description="第 N 位在这里留下痕迹的人")
    visitedAt: str = Field(description="到访时间戳（ISO；客户端按本地时区显示）")
    isFirstToday: bool = Field(description="同一设备 / 同一点位 / 同一天只记一次")
    pointCode: str
    peakName: str | None = None
    altitude: int | None = None
    routeName: str | None = None
    idxInRoute: int | None = Field(default=None, description="这条线路上的第几个点位")
    totalInRoute: int | None = None


def _guest_of(token: str | None):
    if not token:
        return None
    return q1("SELECT id, nickname, merged_user_id FROM guests WHERE token = :t", t=token)


@app.post("/api/guest/arrival-draft", tags=["游客"],
          responses={**ERR_404, 401: {"description": "缺少或无效的游客令牌"}},
          summary="保存游客的私人纪念或未发布留言草稿")
def save_guest_arrival_draft(body: GuestArrivalDraftIn,
                             x_guest_token: str | None = Header(default=None)):
    g = _guest_of(x_guest_token)
    if not g or g["merged_user_id"]:
        err(401, "GUEST_TOKEN_REQUIRED", "游客身份无效，请重新打开扫码页面")
    note = body.privateNote.strip() if body.privateNote else None
    comment = body.publicCommentDraft.strip() if body.publicCommentDraft else None
    if not note and not comment:
        err(400, "DRAFT_EMPTY", "请先写下私人纪念或留言草稿")
    pt = q1("SELECT id FROM points WHERE code = :c", c=body.code.strip().upper())
    if not pt:
        err(404, "POINT_NOT_FOUND", "这个点位不存在")
    with engine.begin() as conn:
        conn.execute(text("""INSERT INTO guest_arrival_drafts
              (guest_id, point_id, private_note, public_comment_draft)
            VALUES (:g, :p, :n, :c)
            ON CONFLICT (guest_id, point_id) DO UPDATE SET
              private_note = COALESCE(EXCLUDED.private_note, guest_arrival_drafts.private_note),
              public_comment_draft = COALESCE(EXCLUDED.public_comment_draft, guest_arrival_drafts.public_comment_draft),
              updated_at = now()"""),
            {"g": g["id"], "p": pt["id"], "n": note, "c": comment})
        conn.execute(text("UPDATE guests SET last_seen_at = now() WHERE id = :g"), {"g": g["id"]})
    return {"saved": True, "private": bool(note), "commentDraft": bool(comment)}


@app.get("/api/guest/arrival-draft", tags=["游客"],
         responses={401: {"description": "缺少或无效的游客令牌"}},
         summary="恢复此游客在该点位保存的私人纪念与留言草稿")
def get_guest_arrival_draft(code: str,
                            x_guest_token: str | None = Header(default=None)):
    g = _guest_of(x_guest_token)
    if not g or g["merged_user_id"]:
        err(401, "GUEST_TOKEN_REQUIRED", "游客身份无效，请重新打开扫码页面")
    row = q1("""SELECT d.private_note AS "privateNote",
                     d.public_comment_draft AS "publicCommentDraft"
                FROM guest_arrival_drafts d JOIN points p ON p.id = d.point_id
               WHERE d.guest_id = :g AND p.code = :c""",
             g=g["id"], c=code.strip().upper())
    return dict(row) if row else {"privateNote": None, "publicCommentDraft": None}


@app.get("/api/me/arrival-drafts", tags=["我"], responses=ERR_401,
         summary="取回账号下的私人纪念与未发布留言草稿")
def my_arrival_drafts(uid: int = Depends(require_user)):
    return q("""SELECT d.point_id AS "pointId", p.code, p.name,
                      d.private_note AS "privateNote",
                      d.public_comment_draft AS "publicCommentDraft",
                      d.updated_at AS "updatedAt"
                 FROM account_arrival_drafts d JOIN points p ON p.id = d.point_id
                WHERE d.user_id = :uid ORDER BY d.updated_at DESC""", uid=uid)


@app.put("/api/me/arrival-drafts", tags=["我"], responses={**ERR_401, **ERR_404},
         summary="保存账号下的私人纪念或未发布留言草稿")
def save_account_arrival_draft(body: GuestArrivalDraftIn,
                               uid: int = Depends(require_user)):
    note = body.privateNote.strip() if body.privateNote else None
    comment = body.publicCommentDraft.strip() if body.publicCommentDraft else None
    if not note and not comment:
        err(400, "DRAFT_EMPTY", "请先写下私人纪念或留言草稿")
    point = q1("SELECT id FROM points WHERE code = :c", c=body.code.strip().upper())
    if not point:
        err(404, "POINT_NOT_FOUND", "点位不存在")
    with engine.begin() as conn:
        conn.execute(text("""INSERT INTO account_arrival_drafts
                (user_id, point_id, private_note, public_comment_draft)
            VALUES (:u, :p, :n, :c)
            ON CONFLICT (user_id, point_id) DO UPDATE SET
              private_note = COALESCE(EXCLUDED.private_note, account_arrival_drafts.private_note),
              public_comment_draft = COALESCE(EXCLUDED.public_comment_draft, account_arrival_drafts.public_comment_draft),
              updated_at = now()"""),
            {"u": uid, "p": point["id"], "n": note, "c": comment})
        if comment:
            conn.execute(text("""DELETE FROM arrival_publish_receipts
                WHERE user_id = :u AND point_id = :p"""), {"u": uid, "p": point["id"]})
    return {"saved": True, "private": bool(note), "commentDraft": bool(comment)}


def _moderate_public_text(uid: int, content: str):
    user = q1("SELECT wx_openid FROM users WHERE id=:u AND deleted_at IS NULL", u=uid)
    try:
        moderator.check(content, user["wx_openid"] if user else None)
    except ModerationError as exc:
        err(exc.status, exc.code, exc.message)


@app.post("/api/me/arrival-drafts/{code}/publish", tags=["我"],
          responses={**ERR_401, 404: {"description": "点位或草稿不存在"}},
          summary="由用户明确发布该点位的留言草稿")
def publish_arrival_draft(code: str, uid: int = Depends(require_user)):
    point = q1("SELECT id FROM points WHERE code = :c", c=code.strip().upper())
    if not point:
        err(404, "POINT_NOT_FOUND", "点位不存在")
    with engine.begin() as conn:
        draft = conn.execute(text("""SELECT id, public_comment_draft
            FROM account_arrival_drafts
            WHERE user_id = :u AND point_id = :p FOR UPDATE"""),
            {"u": uid, "p": point["id"]}).mappings().first()
        if not draft or not draft["public_comment_draft"]:
            receipt = conn.execute(text("""SELECT comment_id FROM arrival_publish_receipts
                WHERE user_id = :u AND point_id = :p"""),
                {"u": uid, "p": point["id"]}).scalar_one_or_none()
            if receipt is not None:
                return {"published": True, "commentId": receipt, "alreadyPublished": True}
            err(404, "COMMENT_DRAFT_NOT_FOUND", "没有待发布的留言草稿")
        _moderate_public_text(uid, draft["public_comment_draft"])
        comment_id = conn.execute(text("""INSERT INTO comments (point_id, user_id, text)
            VALUES (:p, :u, :t) RETURNING id"""),
            {"p": point["id"], "u": uid, "t": draft["public_comment_draft"]}).scalar_one()
        conn.execute(text("""INSERT INTO arrival_publish_receipts (user_id, point_id, comment_id)
            VALUES (:u, :p, :c)
            ON CONFLICT (user_id, point_id) DO UPDATE SET comment_id = EXCLUDED.comment_id"""),
            {"u": uid, "p": point["id"], "c": comment_id})
        conn.execute(text("""DELETE FROM account_arrival_drafts
            WHERE id = :id AND private_note IS NULL"""), {"id": draft["id"]})
        conn.execute(text("""UPDATE account_arrival_drafts
            SET public_comment_draft = NULL, updated_at = now()
            WHERE id = :id AND private_note IS NOT NULL"""), {"id": draft["id"]})
    return {"published": True, "commentId": comment_id}


@app.post("/api/guest", response_model=GuestOut, tags=["游客"],
          responses={400: {"description": "游客令牌格式无效"},
                     429: {"description": "新建游客身份过于频繁"}},
          summary="领一个游客身份（客户端存 localStorage）：不登录也能打卡")
def new_guest(request: Request, x_guest_token: str | None = Header(default=None)):
    if x_guest_token and not re.fullmatch(r"(?:[0-9a-f]{36}|[0-9a-f]{48})", x_guest_token):
        err(400, "INVALID_GUEST_TOKEN", "游客令牌格式无效")
    tok = x_guest_token or os.urandom(24).hex()
    existing = q1("SELECT created_at FROM guests WHERE token = :t", t=tok)
    if existing:
        return GuestOut(token=tok, createdAt=existing["created_at"].isoformat())
    ip_key = _auth_bucket_key("guest-ip", _request_ip(request))
    if _auth_rate_limited([ip_key], limit=30, minutes=60):
        err(429, "RATE_LIMITED", "游客身份请求过于频繁，请稍后再试")
    _auth_record_attempt([ip_key], minutes=60)
    with engine.begin() as conn:
        conn.execute(text("""INSERT INTO guests (token) VALUES (:t)
            ON CONFLICT (token) DO NOTHING"""), {"t": tok})
        row = conn.execute(text("SELECT created_at FROM guests WHERE token = :t"),
                           {"t": tok}).first()
    return GuestOut(token=tok, createdAt=row[0].isoformat())


@app.post("/api/guest/visit", response_model=GuestVisitOut, tags=["游客"],
          responses={**ERR_404, 401: {"description": "缺少或无效的游客令牌"},
                     429: {"description": "打卡过于频繁"}},
          summary="游客打卡：只记时间戳与序号，不要求登录")
def guest_visit(body: GuestVisitIn, request: Request,
                x_guest_token: str | None = Header(default=None)):
    g = _guest_of(x_guest_token)
    if not g or g["merged_user_id"]:
        err(401, "GUEST_TOKEN_REQUIRED", "先领一个游客身份（POST /api/guest）")
    keys = _rate_check(request, "visit", f"g:{g['id']}")
    pt = q1("""SELECT pt.id, pt.code, pt.name, pt.altitude, pt.index_in_route,
                      pt.total_in_route, r.name AS route_name
                 FROM points pt LEFT JOIN routes r ON r.id = pt.route_id
                WHERE pt.code = :c""", c=body.code.strip().upper())
    if not pt:
        err(404, "POINT_NOT_FOUND", "这个点位不存在")
    with engine.begin() as conn:
        conn.execute(text("UPDATE guests SET last_seen_at = now() WHERE id = :g"), {"g": g["id"]})
        row, first = record_visit(conn, identity_type="guest", identity_id=g["id"],
            point_id=pt["id"], source=body.source, client_uuid=body.clientUuid,
            occurred_at=body.occurredAt, lat=body.lat, lng=body.lng,
            accuracy_m=body.accuracyM)
        try:
            with conn.begin_nested():
                reconcile_efforts(conn, "guest", g["id"], row["visit_date"])
        except Exception:
            logging.exception("guest effort reconciliation failed")
    _rate_hit(keys)
    return GuestVisitOut(visitId=row["id"], seq=row["seq"],
                         visitedAt=row["occurred_at"].isoformat(), isFirstToday=first,
                         pointCode=pt["code"], peakName=pt["name"], altitude=pt["altitude"],
                         routeName=pt["route_name"], idxInRoute=pt["index_in_route"],
                         totalInRoute=pt["total_in_route"])


class MergeOut(BaseModel):
    mergedVisits: int
    dropped: int = Field(description="同一天同一点位、账号里本来就有的，删掉游客那条")
    mergedDrafts: int = 0
    message: str


@app.post("/api/me/merge-guest", response_model=MergeOut, tags=["游客"],
          responses={**ERR_401, 404: {"description": "游客令牌无效"}},
          summary="注册后把游客记录并到账号下（不做这一步，用户会觉得白打卡了）")
def merge_guest(x_guest_token: str | None = Header(default=None),
                uid: int = Depends(require_user)):
    g = _guest_of(x_guest_token)
    if not g:
        err(404, "GUEST_NOT_FOUND", "游客身份无效或已被别的账号并走")
    with engine.begin() as conn:
        merged = _merge_guest_records(conn, x_guest_token, uid)
    return MergeOut(**merged,
                    message=f"已把 {merged['mergedVisits']} 条到此一游记录并入你的账号")

class VisitItem(BaseModel):
    pointId: int
    name: str | None = Field(default=None, description="点位名；空 = 名称待定")
    seq: int
    at: datetime
    level: Literal["easy", "mid", "hard", "hidden"] | None = None
    code: str | None = Field(default=None, description="点位编号")
    routeSlug: str | None = Field(default=None, description="所属线路；用来跟榜单的行对上")
    time: str | None = Field(default=None, description="这次登顶用时，没记过则为 null")


@app.get("/api/me/visits", response_model=list[VisitItem], tags=["我"],
         responses=ERR_401, summary="我去过的地方")
def my_visits(limit: int = 100, uid: int = Depends(require_user)):
    # 带上 routeSlug / code：前端要拿它跟"热门登顶榜"的行对上，
    # 才知道山径拼图里哪几格该点亮（只有 pointId 是数不出"去过哪座山"的）
    rows = q("""SELECT v.point_id AS "pointId", p.name, v.seq, v.created_at AS at, p.level,
                       p.code, r.slug AS "routeSlug", v.duration_sec
                FROM visits v JOIN points p ON p.id = v.point_id
                LEFT JOIN routes r ON r.id = p.route_id
                WHERE v.user_id = :uid ORDER BY v.created_at DESC LIMIT :limit""",
             uid=uid, limit=limit)
    out = []
    for r in rows:
        d = dict(r)
        secs = d.pop("duration_sec")
        d["time"] = f"{secs // 3600}:{secs % 3600 // 60:02d}" if secs else None
        out.append(VisitItem(**d))
    return out

@app.post("/api/points/{point_id}/visit", response_model=VisitOut, tags=["打卡"],
          responses={**ERR_401, **ERR_404, 429: {"description": "打卡过于频繁"}},
          summary="打卡（同一人 / 同一点位 / 同一天只计一次）")
def do_visit(body: VisitIn, request: Request, point_id: int = Path(ge=1),
             uid: int = Depends(require_user)):
    """去重靠数据库唯一约束 (user_id, point_id, visit_date)，不靠代码判断。
    同日重复请求返回已存在的 seq，且 isFirstVisit=false。
    """
    keys = _rate_check(request, "visit", f"u:{uid}")
    point = q1("""SELECT pt.code, pt.name, pt.altitude, pt.index_in_route,
                      pt.total_in_route, r.name AS route_name
               FROM points pt LEFT JOIN routes r ON r.id = pt.route_id
               WHERE pt.id = :id""", id=point_id)
    if not point:
        err(404, "POINT_NOT_FOUND", "点位不存在")
    with engine.begin() as conn:
        row, is_first = record_visit(conn, identity_type="user", identity_id=uid,
            point_id=point_id, source=body.source, client_uuid=body.clientUuid,
            occurred_at=body.occurredAt, lat=body.lat, lng=body.lng,
            accuracy_m=body.accuracyM)
        try:
            with conn.begin_nested():
                reconcile_efforts(conn, "user", uid, row["visit_date"])
        except Exception:
            logging.exception("account effort reconciliation failed")
    mine = q1("SELECT count(*) AS n FROM visits WHERE user_id=:uid AND point_id=:pid",
              uid=uid, pid=point_id)
    _rate_hit(keys)
    return VisitOut(visitId=row["id"], seq=row["seq"], isFirstVisit=is_first, myVisitCount=mine["n"],
                    message=f"这是该点位第 {row['seq']} 条到访记录",
                    visitedAt=row["occurred_at"], pointCode=point["code"], peakName=point["name"],
                    altitude=point["altitude"], routeName=point["route_name"],
                    idxInRoute=point["index_in_route"], totalInRoute=point["total_in_route"])


# ==================== 留言 ====================

class RecentBoardItem(BaseModel):
    kind: Literal["summit", "junction", "segment"]
    name: str
    text: str
    at: str
    target: str


@app.get("/api/community/recent", response_model=list[RecentBoardItem], tags=["留言"],
         summary="首页三类留言板各一条近期内容")
def recent_board_activity():
    items = []
    for kind, point_type in (("summit", "peak"), ("junction", "junction")):
        row = q1("""SELECT c.text, c.created_at, pt.code,
                           coalesce(nullif(pt.name, ''), '名称待定') AS name
                      FROM comments c JOIN points pt ON pt.id = c.point_id
                      JOIN users author ON author.id = c.user_id
                     WHERE pt.type = :type AND pt.status = 'published'
                       AND pt.geom IS NOT NULL AND c.status = 'normal'
                     ORDER BY c.created_at DESC, c.id DESC LIMIT 1""", type=point_type)
        if row:
            page = "peaks" if kind == "summit" else "junctions"
            items.append(RecentBoardItem(kind=kind, name=row["name"], text=row["text"],
                                         at=row["created_at"].isoformat(),
                                         target=f"#/{page}/p-{row['code']}"))
    row = q1("""SELECT c.text, c.created_at, r.name, r.slug
                  FROM comments c JOIN route_segments rs ON rs.id = c.segment_id
                  JOIN users author ON author.id = c.user_id
                  JOIN routes r ON r.id = rs.route_id
                 WHERE c.status = 'normal'
                 ORDER BY c.created_at DESC, c.id DESC LIMIT 1""")
    if row:
        items.append(RecentBoardItem(kind="segment", name=row["name"], text=row["text"],
                                     at=row["created_at"].isoformat(),
                                     target=f"#/trails/{row['slug']}"))
    return items

class CommentIn(BaseModel):
    text: str = Field(min_length=1, max_length=200, description="纯文本，v1 不收图片")


class CommentListOut(BaseModel):
    items: list[CommentOut]
    nextCursor: int | None = None


class VoteIn(BaseModel):
    value: Literal["like", "bad"] | None = Field(default=None, description="null 表示取消投票")


_COMMENT_SQL = """SELECT (SELECT count(*) FROM comment_replies cr WHERE cr.comment_id=c.id) AS reply_count, c.id, c.text, c.like_count, c.bad_count, c.status, c.pinned, c.hidden_reason, c.created_at,
                         u.nickname, EXISTS (
                           SELECT 1 FROM points responsible
                           JOIN mountain_members mm
                             ON mm.mountain_id = responsible.mountain_id
                           WHERE responsible.id = ANY(:ids)
                             AND mm.user_id = c.user_id AND mm.status = 'active'
                         ) AS is_maintainer
                  FROM comments c
                  JOIN users  u  ON u.id = c.user_id
                  WHERE c.point_id = ANY(:ids) AND c.status <> 'hidden'"""

# 排序固定：维护人置顶 → 净分(赞-踩) → 时间。前端不要再排。
_COMMENT_ORDER = """ ORDER BY c.pinned DESC, is_maintainer DESC, (c.like_count - c.bad_count) DESC,
                              c.created_at DESC, c.id DESC """


def _comment_by_id(cid: int) -> "CommentOut":
    point = q1("SELECT point_id FROM comments WHERE id = :cid", cid=cid)
    if not point:
        err(404, "COMMENT_NOT_FOUND", "留言不存在")
    point_ids = _board_point_ids(point["point_id"]) if point["point_id"] else []
    row = q1("""SELECT c.id, c.text, c.like_count, c.bad_count, c.status, c.pinned,
                       c.hidden_reason, c.created_at,
                       u.nickname, EXISTS (
                         SELECT 1 FROM points responsible
                         JOIN mountain_members mm
                           ON mm.mountain_id = responsible.mountain_id
                         WHERE responsible.id = ANY(:ids)
                           AND mm.user_id = c.user_id AND mm.status = 'active'
                       ) AS is_maintainer
                FROM comments c
                JOIN users  u  ON u.id = c.user_id
                WHERE c.id = :cid""", cid=cid, ids=point_ids)
    if not row:
        err(404, "COMMENT_NOT_FOUND", "留言不存在")
    return CommentOut(**dict(row))


@app.get("/api/points/{point_id}/comments", response_model=CommentListOut, tags=["留言"],
         summary="留言列表（维护人置顶 → 净分 → 时间）")
def list_comments(point_id: int, limit: int = 20, cursor: int | None = None):
    sql = _COMMENT_SQL + (" AND c.id < :cursor" if cursor else "") + _COMMENT_ORDER + " LIMIT :limit"
    rows = q(sql, ids=_board_point_ids(point_id), limit=limit, cursor=cursor)
    items = [CommentOut(**dict(r)) for r in rows]
    return CommentListOut(items=items, nextCursor=items[-1].id if len(items) == limit else None)


# Legacy comments keep their route segment origin; reads use the stable segment board.
def _segment_board_ids(segment_id: int) -> list[int]:
    rows = q("""SELECT peer.id FROM route_segments src
        JOIN route_segment_links link ON link.route_id = src.route_id
            AND link.route_segment_no = src.no
            AND link.direction = CASE src.kind WHEN 'climb' THEN 'ascending'
                WHEN 'desc' THEN 'descending' ELSE 'traverse' END
        JOIN route_segment_links peer_link ON peer_link.trail_segment_id = link.trail_segment_id
        JOIN route_segments peer ON peer.route_id = peer_link.route_id
            AND peer.no = peer_link.route_segment_no
            AND peer_link.direction = CASE peer.kind WHEN 'climb' THEN 'ascending'
                WHEN 'desc' THEN 'descending' ELSE 'traverse' END
        WHERE src.id = :sid ORDER BY peer.id""", sid=segment_id)
    return [r["id"] for r in rows] or [segment_id]


_SEG_SQL = """SELECT c.id, c.text, c.like_count, c.bad_count, c.status, c.created_at,
                     u.nickname, false AS is_maintainer
              FROM comments c JOIN users u ON u.id = c.user_id
              WHERE c.segment_id = ANY(:ids) AND c.status <> 'hidden'"""
# 分段没有维护人，只按净分 → 时间排
_SEG_ORDER = """ ORDER BY (c.like_count - c.bad_count) DESC,
                          c.created_at DESC, c.id DESC """


@app.get("/api/segments/{sid}/comments", response_model=CommentListOut, tags=["留言"],
         summary="某一段路上的留言（维护人置顶 → 净分 → 时间）")
def list_seg_comments(sid: int, limit: int = 20):
    if not q1("SELECT 1 AS ok FROM route_segments WHERE id = :sid", sid=sid):
        err(404, "SEGMENT_NOT_FOUND", "分段不存在")
    rows = q(_SEG_SQL + _SEG_ORDER + " LIMIT :limit",
             ids=_segment_board_ids(sid), limit=limit)
    return CommentListOut(items=[CommentOut(**dict(r)) for r in rows], nextCursor=None)


@app.post("/api/segments/{sid}/comments", response_model=CommentOut, tags=["留言"],
          status_code=201, responses={**ERR_401, **ERR_404,
                                     409: {"description": "十分钟内重复了同样的一句"},
                                     429: {"description": "留言过于频繁"}},
          summary="在某一段路上留言（同一账号十分钟内不接受完全相同的原文）")
def add_seg_comment(body: CommentIn, request: Request, sid: int = Path(ge=1),
                    uid: int = Depends(require_user)):
    if not q1("SELECT 1 AS x FROM route_segments WHERE id = :i", i=sid):
        err(404, "SEGMENT_NOT_FOUND", "分段不存在")
    keys = _rate_check(request, "comment", f"u:{uid}")
    # 注意：局部变量不能叫 text —— 会把 sqlalchemy 的 text() 遮蔽掉（踩过）
    body_text = body.text.strip()
    _reject_duplicate_comment(uid, body_text, segment_id=sid)
    _moderate_public_text(uid, body_text)
    with engine.begin() as conn:
        cid = conn.execute(text("""INSERT INTO comments (segment_id, user_id, text)
            VALUES (:sid, :uid, :txt) RETURNING id"""),
            {"sid": sid, "uid": uid, "txt": body_text}).scalar()
    _rate_hit(keys)
    row = q1(_SEG_SQL + " AND c.id = :cid", ids=_segment_board_ids(sid), cid=cid)
    return CommentOut(**dict(row))


@app.post("/api/points/{point_id}/comments", response_model=CommentOut, tags=["留言"],
          status_code=201, responses={**ERR_401, **ERR_404,
                                     409: {"description": "十分钟内重复了同样的一句"},
                                     429: {"description": "留言过于频繁"}},
          summary="在某一点位留言（岔路情报同此接口；同一账号十分钟内不接受完全相同的原文）")
def add_comment(body: CommentIn, request: Request, point_id: int = Path(ge=1),
                uid: int = Depends(require_user)):
    if not q1("SELECT 1 AS x FROM points WHERE id = :id", id=point_id):
        err(404, "POINT_NOT_FOUND", "点位不存在")
    keys = _rate_check(request, "comment", f"u:{uid}")
    body_text = body.text.strip()      # 同上：不要遮蔽 sqlalchemy.text
    _reject_duplicate_comment(uid, body_text, point_id=point_id)
    _moderate_public_text(uid, body_text)
    with engine.begin() as conn:
        cid = conn.execute(text("""INSERT INTO comments (point_id, user_id, text)
            VALUES (:pid, :uid, :txt) RETURNING id"""),
            {"pid": point_id, "uid": uid, "txt": body_text}).scalar()
    _rate_hit(keys)
    return _comment_by_id(cid)


@app.get("/api/comments/{comment_id}/replies", tags=["留言"])
def list_comment_replies(comment_id: int):
    if not q1("SELECT id FROM comments WHERE id=:id AND status <> 'hidden'", id=comment_id):
        err(404, "COMMENT_NOT_FOUND", "留言不存在")
    return [dict(r) for r in q("""SELECT r.id, r.text, r.created_at, u.nickname
        FROM comment_replies r JOIN users u ON u.id=r.user_id
        WHERE r.comment_id=:id ORDER BY r.created_at, r.id""", id=comment_id)]


@app.post("/api/comments/{comment_id}/replies", status_code=201, tags=["留言"])
def add_comment_reply(comment_id: int, body: CommentIn, request: Request,
                      uid: int = Depends(require_user)):
    if not q1("SELECT id FROM comments WHERE id=:id AND status <> 'hidden'", id=comment_id):
        err(404, "COMMENT_NOT_FOUND", "留言不存在")
    body_text = body.text.strip()
    if not body_text:
        err(422, "EMPTY_REPLY", "请填写回复内容")
    keys = _rate_check(request, "comment", f"u:{uid}")
    _moderate_public_text(uid, body_text)
    with engine.begin() as conn:
        conn.execute(text("""INSERT INTO comment_replies(comment_id,user_id,text)
            VALUES (:cid,:uid,:body)"""), {"cid":comment_id,"uid":uid,"body":body_text})
    _rate_hit(keys)
    return {"ok": True}


@app.post("/api/comments/{comment_id}/vote", response_model=CommentOut, tags=["留言"],
          responses={**ERR_401, **ERR_404},
          summary="赞 / 踩 / 取消。bad>=3 且 bad>like 时置 flagged（只灰不删）")
def vote(comment_id: int, body: VoteIn, uid: int = Depends(require_user)):
    if not q1("SELECT 1 AS x FROM comments WHERE id = :id", id=comment_id):
        err(404, "COMMENT_NOT_FOUND", "留言不存在")
    with engine.begin() as conn:
        if body.value is None:
            conn.execute(text("DELETE FROM comment_votes WHERE comment_id=:cid AND user_id=:uid"),
                         {"cid": comment_id, "uid": uid})
        else:
            conn.execute(text("""INSERT INTO comment_votes (comment_id, user_id, value)
                VALUES (:cid, :uid, :v)
                ON CONFLICT (comment_id, user_id) DO UPDATE SET value = EXCLUDED.value"""),
                {"cid": comment_id, "uid": uid, "v": body.value})
        conn.execute(text("""UPDATE comments SET
              like_count = (SELECT count(*) FROM comment_votes WHERE comment_id=:cid AND value='like'),
              bad_count  = (SELECT count(*) FROM comment_votes WHERE comment_id=:cid AND value='bad')
            WHERE id=:cid"""), {"cid": comment_id})
        conn.execute(text("""UPDATE comments SET status =
              CASE WHEN bad_count >= 3 AND bad_count > like_count THEN 'flagged' ELSE 'normal' END
            WHERE id=:cid AND status <> 'hidden'"""), {"cid": comment_id})
    return _comment_by_id(comment_id)


# ==================== 短链 ====================

@app.get("/p/{code}", tags=["短链"], summary="二维码里印的就是它",
         status_code=302, response_class=RedirectResponse,
         responses={302: {"description": "跳转到落地页（微信内将优先跳小程序）"},
                    404: {"description": "编号不存在"}})
def short_link(code: str, request: Request):
    """按 UA 分流。现在两端都回 H5 落地页；小程序上线后微信内优先跳小程序。"""
    row = q1("SELECT point_id FROM short_links WHERE code = :c", c=code)
    if not row:
        err(404, "POINT_NOT_FOUND", f"编号 {code} 不存在")
    # 冻结不拦：牌子还在山上，扫了才可能复活
    ua = request.headers.get("user-agent", "")
    with engine.begin() as conn:
        conn.execute(text("""INSERT INTO scans (point_id, code, ua)
            VALUES (:pid, :code, :ua)"""), {"pid": row["point_id"], "code": code, "ua": ua[:300]})
    return RedirectResponse(url=f"/app/#/arrive/p-{code}", status_code=302)


# ==================== 埋点 ====================

@app.get("/api/qr/{code}.svg", tags=["短链"], summary="生成可扫的二维码（矢量，印刷用）",
         response_class=Response,
         responses={200: {"content": {"image/svg+xml": {}}, "description": "SVG 二维码"},
                    404: {"description": "编号不存在"},
                    503: {"description": "服务端没装 qrcode 依赖"}})
def qr_svg(code: str, box: int = 10, border: int = 2):
    """二维码里编码的是 PUBLIC_BASE_URL + /p/{code}。
    编号不存在时 404——避免印出一张扫不开的废码。"""
    if not HAS_QR:
        err(503, "QR_UNAVAILABLE", "服务端缺少 qrcode 依赖，重建镜像后可用")
    if not q1("SELECT 1 AS x FROM short_links WHERE code = :c", c=code):
        err(404, "POINT_NOT_FOUND", f"编号 {code} 不存在，不能生成二维码")
    # 冻结不阻止生成二维码：牌子已印出去，拦着没意义
    url = f"{PUBLIC_BASE}/p/{code}"
    img = qrcode.make(url, image_factory=qrcode.image.svg.SvgPathImage,
                      box_size=box, border=border)
    buf = io.BytesIO()
    img.save(buf)
    return Response(buf.getvalue(), media_type="image/svg+xml",
                    headers={"Cache-Control": "public, max-age=86400"})


@app.get("/api/qr/{code}/target", tags=["短链"], summary="二维码里编码的内容（自检用）")
def qr_target(code: str) -> QrTargetOut:
    if not q1("SELECT 1 AS x FROM short_links WHERE code = :c", c=code):
        err(404, "POINT_NOT_FOUND", "编号不存在")
    return QrTargetOut(code=code, encodes=f"{PUBLIC_BASE}/p/{code}")

@app.post("/api/events", status_code=202, tags=["埋点"],
          response_model=EventsOut,
          responses={400: {"description": "事件缺少 name"}},
          summary="扫码 / 打卡 / 留言 / 打开，三个验证指标都从这里出")
def track(payload: dict | list[dict], request: Request,
          authorization: str | None = Header(default=None)) -> EventsOut:
    rows = payload if isinstance(payload, list) else [payload]
    if len(rows) > 50:
        err(400, "TOO_MANY_EVENTS", "单次最多上报 50 条事件")
    ip_key = _auth_bucket_key("events-ip", _request_ip(request))
    if _auth_rate_limited([ip_key], limit=1200, minutes=60):
        err(429, "RATE_LIMITED", "事件上报过于频繁")
    uid = None
    if authorization and authorization.lower().startswith("bearer "):
        try:
            uid = require_user(authorization)
        except HTTPException:
            pass
    with engine.begin() as conn:
        for e in rows:
            name = str(e.get("name") or "").strip()
            if not name:
                err(400, "BAD_EVENT", "事件缺少 name")
            conn.execute(text("""INSERT INTO events (user_id, name, props) VALUES (:u, :n, :p)"""),
                         {"u": uid, "n": name, "p": json.dumps(e.get("props") or {}, ensure_ascii=False)})
    _auth_record_attempt([ip_key], minutes=60)
    return EventsOut(accepted=len(rows))


# ==================== 静态页面 ====================

class ClaimIn(BaseModel):
    target_key: str = Field(description="点位标识，如 sanfeng-2")
    target_name: str
    kind: Literal["peak", "junction"] = "peak"
    nickname: str = Field(min_length=1, max_length=20)
    contact: str | None = Field(default=None, max_length=60,
                                description="微信号或手机号，用于邮寄物料")


class ClaimOut(BaseModel):
    code: str
    target_name: str
    nickname: str
    qrUrl: str = Field(description="可直接下载打印的二维码")
    shortLink: str
    scanCount: int = Field(description="已有多少次扫码")
    scanDays: int = Field(default=0, description="扫码分布在多少个不同日子")
    needForKit: int = Field(description="还差几次扫码可申领物料")
    canClaimKit: bool = Field(description="扫码满 40 次、分布满 7 天、且有维护动作")
    tier: str = Field(default="new", description="new / warm / ready")
    state: str = Field(default="trial",
                       description="trial 试用 / watching 观察 / active 已通过 / frozen 已冻结")
    trialPeople: int = Field(default=0, description="试用期内已有多少个不同的人扫码")
    trialDaysLeft: int = Field(default=7, description="试用期还剩几天")
    monthPeople: int = Field(default=0, description="首月累计多少个不同的人扫码（满月考核用）")
    monthNeed: int = Field(default=30, description="满月失效线；达到 100 才够格投物料")


# ── 物料门槛：为什么是这三个数 ──────────────────────────────
# 一套物料（打孔卡 + 喷漆 + 邮寄）约 80–100 元。一次扫码按 2 元的用户价值折算，
# 40 次 ≈ 回本，所以门槛定 40。但"扫码次数"单独用会被刷、也不衡量维护质量，
# 所以叠两个附加条件：① 扫码分布在 ≥7 个不同日子（防一天刷完）
# ② 山大王本人有 ≥1 次维护动作。10 次是正反馈档，让人早点看到有人来过。
KIT_THRESHOLD = 40       # 解锁物料申领
HINT_THRESHOLD = 10      # 正反馈档
KIT_DAYS = 7             # 扫码要分布在这么多天

# ── 试用期：领码起的头 7 天，不到 3 个人扫码就失效 ──────────────
# 这是"只判一次"的门槛，不是滚动窗口。目的：逼山大王在领码当周就动起来——
# 贴出去、让朋友扫。第一周就有人来的点位，才值得后面投物料。
# 去重按「人」算：登录用户看 user_id，匿名扫码看 ip_hash（一个人扫 3 次不算 3 个人）。
TRIAL_DAYS = 7           # 试用期长度
MIN_PEOPLE = 3           # 试用期内至少这么多个不同的人

# ── 山大王等级：按名下所有点位的累计去重扫码人数升级，等级决定能认领几个点位 ──
# 初级只给 3 个——够认领自己常走的两三条线，但不够"圈地占坑"。
# 升级同时看量和质：高等级要求有维护记录（留言/核验），防刷量升上去的人不干活。
KING_LEVELS = [
    {"lv": 1, "name": "初级",   "need": 0,    "quota": 3,  "kept": 0},
    {"lv": 2, "name": "常客",   "need": 300,  "quota": 8,  "kept": 3},
    {"lv": 3, "name": "山主",   "need": 1000, "quota": 20, "kept": 10},
    {"lv": 4, "name": "巡山使", "need": 3000, "quota": 99, "kept": 30},
]


def _king_stats(uid: int):
    """名下点位的累计去重扫码人数 + 维护记录数。"""
    people = q1("""SELECT count(DISTINCT coalesce(s.user_id::text, s.ip_hash)) AS n
                   FROM scans s JOIN claims c ON c.code = s.code
                   WHERE c.user_id = :uid AND c.status = 'active'""", uid=uid)["n"]
    kept = q1("""SELECT count(*) AS n FROM comments cm
                 JOIN points p  ON p.id = cm.point_id
                 JOIN claims cl ON cl.code = p.code
                 WHERE cl.user_id = :uid""", uid=uid)["n"]
    return people, kept


def _king_level(uid: int):
    """当前等级、下一级、已用配额、累计人数、维护数。冻结的点位不占配额。"""
    people, kept = _king_stats(uid)
    cur = KING_LEVELS[0]
    for L in KING_LEVELS:
        if people >= L["need"] and kept >= L["kept"]:
            cur = L
    codes = [r["code"] for r in q("""SELECT code FROM claims
                                     WHERE user_id = :uid AND status = 'active'""", uid=uid)]
    used = sum(1 for c in codes if c and _claim_state(c) != "frozen")
    nxt = next((L for L in KING_LEVELS if L["lv"] == cur["lv"] + 1), None)
    return cur, nxt, used, people, kept

# ── 满月考核：领码 1 个月内不到门槛也失效 ────────────────────
# 注意：这是「扫码人数」，不是「经过人数」。扫码率通常只有 1–5%，
# 所以 100 人/月 ≈ 每天 3–4 人扫码 ≈ 实际经过 100–400 人/天 —— 已经是景区级。
# 北京野山点位绝大多数到不了，所以分档而不是一刀切：
#   ≥100 人/月  优先投物料、进官方标牌名单
#   30–100      保留观察，不发物料
#   <30         失效（连续一个月每天不到 1 个人扫，这个牌子就是死的）
MONTH_DAYS = 30
MONTH_MIN = 30           # 失效线
MONTH_HOT = 100          # 热门线：够格投物料


def _claim_state(code: str):
    """返回 trial 试用中 / watching 观察中 / active 已通过 / frozen 已冻结 / None。"""
    c = q1("""SELECT created_at FROM claims
              WHERE code = :c AND status = 'active'""", c=code)
    if not c:
        return None
    try:
        t0 = c["created_at"]
        days = q1("""SELECT extract(day from now() - (:t)::timestamptz)::int AS d""",
                  t=t0)["d"]
        if days < TRIAL_DAYS:
            return "trial"                        # 第一周内，没到判定时间
        n7 = _people_between(code, t0, TRIAL_DAYS)
        if n7 < MIN_PEOPLE:
            return _frozen_or_revived(code)       # 第一周没人来 → 冻结
        if days < MONTH_DAYS:
            return "watching"                     # 第一周过了，等满月再审
        n30 = _people_between(code, t0, MONTH_DAYS)
        if n30 < MONTH_MIN:
            return _frozen_or_revived(code)       # 满月不够 → 冻结
        return "active" if n30 >= MONTH_HOT else "watching"
    except Exception:                            # noqa: BLE001
        return "trial"


def _frozen_or_revived(code: str) -> str:
    """冻结不是作废——牌子还在山上。最近 7 天又有 ≥3 个不同的人扫码就复活。"""
    n = q1("""SELECT count(DISTINCT coalesce(user_id::text, ip_hash)) AS n
              FROM scans WHERE code = :c AND created_at > now() - interval '7 days'""",
           c=code)["n"]
    return "watching" if n >= MIN_PEOPLE else "frozen"


def _people_between(code, t0, days: int) -> int:
    """某段时间内，有多少个**不同的人**扫过。一个人扫 3 次算 1 个人。"""
    return q1("""SELECT count(DISTINCT coalesce(user_id::text, ip_hash)) AS n
                 FROM scans WHERE code = :c
                   AND created_at <= (:t)::timestamptz + (:d * interval '1 day')""",
              c=code, t=t0, d=days)["n"]


def _ct0(code):
    c = q1("""SELECT created_at FROM claims WHERE code = :c AND status = 'active'""", c=code)
    return c["created_at"] if c else None


def _trial_progress(code: str):
    """试用期进度：已经有多少个不同的人来扫过，还剩几天。"""
    c = q1("""SELECT created_at FROM claims
              WHERE code = :c AND status = 'active'""", c=code)
    if not c:
        return 0, TRIAL_DAYS
    n = q1("""SELECT count(DISTINCT coalesce(user_id::text, ip_hash)) AS n
              FROM scans WHERE code = :c
                AND created_at <= (:t)::timestamptz + interval '7 days'""",
           c=code, t=c["created_at"])["n"]
    left = q1("""SELECT greatest(0, 7 - extract(day from now() - (:t)::timestamptz))::int AS d""",
              t=c["created_at"])["d"]
    return n, left


def _expired_page(code: str):
    return Response(
        "<!doctype html><html lang=zh-CN><meta charset=utf-8>"
        "<meta name=viewport content='width=device-width,initial-scale=1'>"
        "<body style=\"max-width:430px;margin:0 auto;padding:52px 22px;"
        "font:15px/1.8 -apple-system,BlinkMacSystemFont,'PingFang SC',sans-serif;"
        "color:#22242E;background:#F7F3EC;min-height:100vh\">"
        "<div style='font-size:20px;font-weight:800'>到此一游</div>"
        f"<div style='font-size:11px;letter-spacing:2px;color:#FF714E;font-weight:700;"
        f"margin:4px 0 24px'>HIKERS</div>"
        "<div style='background:#FFF1EC;border-left:4px solid #FF714E;border-radius:12px;"
        "padding:16px 18px'><b>这个点位的二维码已经失效</b><br>"
        "<span style='color:#6B6E7E;font-size:13.5px'>已经连续 7 天没有 3 个人来扫码了。"
        "可能是这条路最近没人走，也可能是标牌掉了。</span></div>"
        f"<div style='margin-top:20px;font-size:13px;color:#6B6E7E'>编号 <code>{code}</code><br>"
        "如果你是这里的山大王，重贴一张牌、或者让朋友来扫一次，它就会自动恢复。</div>"
        "<a href='/' style='display:inline-block;margin-top:22px;background:#3455F5;color:#fff;"
        "font-weight:700;text-decoration:none;padding:12px 22px;border-radius:12px'>去首页看看</a>"
        "</body></html>", media_type="text/html", status_code=410)


def _scan_stats(code: str):
    n = q1("SELECT count(*) AS n FROM scans WHERE code = :c", c=code)["n"]
    d = q1("SELECT count(DISTINCT created_at::date) AS d FROM scans WHERE code = :c",
           c=code)["d"]
    return n, d


def _next_code() -> str:
    """编号：区域码 + 递增序号。无语义，因为标牌印出去就不能改。"""
    n = q1("SELECT count(*) AS n FROM short_links")["n"] + 1041
    for i in range(50):
        code = "BJ-%04d" % (n + i)
        if not q1("SELECT 1 AS x FROM short_links WHERE code = :c", c=code):
            return code
    err(500, "CODE_EXHAUSTED", "编号生成失败，请重试")


def _ensure_point_mountain(conn, point_id: int, code: str, name: str | None,
                           altitude: int | None = None):
    mountain_id = conn.execute(text("SELECT mountain_id FROM points WHERE id = :p"),
                               {"p": point_id}).scalar()
    if mountain_id is None:
        mountain_id = conn.execute(text("""INSERT INTO mountains
            (stable_key, name, altitude, name_status)
            VALUES (:key, :name, :alt, :status)
            ON CONFLICT (stable_key) DO UPDATE SET stable_key = EXCLUDED.stable_key
            RETURNING id"""), {"key": "point:" + code, "name": name, "alt": altitude,
                                  "status": "candidate" if name else "unconfirmed"}).scalar_one()
        conn.execute(text("UPDATE points SET mountain_id = :m WHERE id = :p"),
                     {"m": mountain_id, "p": point_id})
    conn.execute(text("""INSERT INTO boards (board_type, mountain_id)
        VALUES ('summit', :m) ON CONFLICT (mountain_id) DO NOTHING"""), {"m": mountain_id})


@app.post("/api/claims", response_model=ClaimOut, tags=["占山为王"],
          responses={**ERR_401, 409: {"description": "这个点位已经有人认领了"}},
          summary="申请成为山头主：填信息 → 立即拿到编号与二维码")
def create_claim(body: ClaimIn, uid: int = Depends(require_user)):
    err(410, "UPGRADE_REQUIRED",
        "自建山头不再当场发布：请走「占山为王 → 统一申请」，审核通过后才会创建点位、"
        "短链与二维码并获得负责人身份。")
    if q1("SELECT 1 AS x FROM claims WHERE target_key = :k", k=body.target_key):
        err(409, "ALREADY_CLAIMED", "这个点位已经有人认领了")
    lv, _nx, used, _p, _k = _king_level(uid)
    if used >= lv["quota"]:
        err(403, "QUOTA_FULL",
            f"{lv['name']}山大王最多认领 {lv['quota']} 个点位（已用 {used} 个）。"
            "名下点位被更多人扫码即可升级，升级后能认领更多。")
    code = _next_code()
    with engine.begin() as conn:
        pid = conn.execute(text("""INSERT INTO points
            (code, type, name, level, status)
            VALUES (:code, :type, :name, 'mid', 'published')
            ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
            RETURNING id"""),
            {"code": code, "type": body.kind, "name": body.target_name}).scalar()
        if body.kind == "peak":
            _ensure_point_mountain(conn, pid, code, body.target_name)
        conn.execute(text("INSERT INTO short_links (code, point_id) VALUES (:c, :p)"),
                     {"c": code, "p": pid})
        conn.execute(text("""INSERT INTO claims
            (user_id, target_key, target_name, kind, nickname, contact, code)
            VALUES (:uid, :k, :n, :kind, :nick, :ct, :code)"""),
            {"uid": uid, "k": body.target_key, "n": body.target_name, "kind": body.kind,
             "nick": body.nickname, "ct": body.contact, "code": code})
    return _claim_out(code, body.target_name, body.nickname)


class MasterIn(BaseModel):
    target_code: str = Field(description="要维护的点位编号，例如 SF-01")
    nickname: str | None = None
    contact: str | None = None


class MasterOut(BaseModel):
    pointCode: str
    targetName: str
    nickname: str | None
    message: str = Field(description="给用户看的一句话：版主不发二维码")


@app.post("/api/claims/master", response_model=MasterOut, tags=["占山为王"],
          responses={**ERR_401, 410: {"description": "入口已下线，改走维护申请"}},
          summary="（已下线）成为版主：改走 POST /api/master-applications，3 天审核")
def become_master(body: MasterIn, uid: int = Depends(require_user)):
    """2026-10-16 起，接管留言板改成"申请 + 3 天审核"。

    保留这个路径只是为了给老客户端一个能读懂的答复：它不再即时授权，
    也不再写 maintainer_id。新入口是 POST /api/master-applications
    （要写理由、期待与每月频次），审核通过后才授予维护权。
    """
    err(410, "MASTER_ENDPOINT_RETIRED",
        "这个入口已经下线：现在要提交维护申请（写清为什么申请、成为维护人后的期待、"
        "一个月能去几次），3 天审核期，通过后才生效")


def _claim_out(code: str, name: str, nickname: str) -> ClaimOut:
    n, days = _scan_stats(code)
    # 维护动作：他本人在这个点位上留过言（真做事，比"自己发内容"更能预测靠谱）
    kept = q1("""SELECT count(*) AS n FROM comments c JOIN points p ON p.id = c.point_id
                 WHERE p.code = :c""", c=code)["n"]
    st0 = _claim_state(code) or "trial"
    # 冻结（或还在试用期）不能申领物料和正式卡纸——这是冻结唯一的实际后果
    ready = (n >= KIT_THRESHOLD and days >= KIT_DAYS and kept > 0
             and st0 not in ("frozen", "trial"))
    return ClaimOut(code=code, target_name=name, nickname=nickname,
                    qrUrl=f"{PUBLIC_BASE}/api/qr/{code}.svg",
                    shortLink=f"{PUBLIC_BASE}/p/{code}",
                    scanCount=n, scanDays=days, needForKit=max(0, KIT_THRESHOLD - n),
                    canClaimKit=ready,
                    tier="ready" if ready else ("warm" if n >= HINT_THRESHOLD else "new"),
                    state=st0,
                    trialPeople=_trial_progress(code)[0],
                    trialDaysLeft=_trial_progress(code)[1],
                    monthPeople=_people_between(code, _ct0(code), MONTH_DAYS) if _ct0(code) else 0,
                    monthNeed=MONTH_MIN)


@app.get("/api/claims/{target_key}", response_model=ClaimOut, tags=["占山为王"],
         responses={404: {"description": "还没人认领"}})
def get_claim(target_key: str):
    c = q1("""SELECT code, target_name, nickname FROM claims
              WHERE target_key = :k AND status = 'active'""", k=target_key)
    if not c:
        err(404, "NOT_CLAIMED", "这个点位还没人认领")
    return _claim_out(c["code"], c["target_name"], c["nickname"])


class KingOut(BaseModel):
    level: int
    levelName: str
    quota: int
    used: int
    people: int = Field(description="名下所有点位的累计去重扫码人数")
    kept: int = Field(description="维护记录数（留言 / 核验）")
    nextName: str | None = None
    nextNeedPeople: int | None = None
    nextNeedKept: int | None = None
    nextQuota: int | None = None
    canClaimMore: bool


class NewPointIn(BaseModel):
    """用户自己创建山头。字段刻意少——多了没人填。
    必填只有三项：名称、一句话介绍、昵称。位置能取到就自动带上。"""
    name: str = Field(min_length=1, max_length=30, description="这座山 / 这个点位叫什么")
    intro: str = Field(min_length=4, max_length=200,
                       description="一句话介绍：怎么走、什么样。它同时会成为第一条留言")
    nickname: str = Field(min_length=1, max_length=20)
    kind: Literal["peak", "junction", "trailhead"] = "peak"
    lat: float | None = Field(default=None, description="取到定位就带上")
    lng: float | None = None
    area: str | None = Field(default=None, max_length=40,
                             description="取不到定位时，填大致位置，例如「门头沟 妙峰山附近」")
    altitude: int | None = None
    contact: str | None = Field(default=None, max_length=60,
                                description="微信号，将来寄物料用")
    gpx: str | None = Field(default=None,
                            description="GPX 原文。必填——没有轨迹不能建点位")


# ── GPX 解析与校验 ────────────────────────────────────────────
def _parse_gpx(text: str):
    """返回 [(lat, lng, ele|None), ...]。兼容 GPX trkpt 和 KML coordinates。"""
    pts = []
    for m in re.finditer(r"<(?:trkpt|rtept)\b[^>]*?lat=\"([-\d.]+)\"[^>]*?lon=\"([-\d.]+)\""
                         r"[^>]*?>([\s\S]*?)</(?:trkpt|rtept)>", text, re.S):
        e = re.search(r"<ele>\s*([-\d.]+)", m.group(3))
        pts.append((float(m.group(1)), float(m.group(2)), float(e.group(1)) if e else None))
    if not pts:
        inner = re.search(r"<coordinates>([\s\S]*?)</coordinates>", text, re.I)
        if inner:
            for pair in inner.group(1).split():
                v = pair.split(",")
                if len(v) >= 2:
                    try:
                        pts.append((float(v[1]), float(v[0]), float(v[2]) if len(v) > 2 else None))
                    except ValueError:
                        pass
    return pts


def _gpx_summary(pts):
    """距离、累计爬升、归一化路径。累计爬升按原始高程 + 3 m 滞回。"""
    R = 6371000.0
    r = math.pi / 180
    dist = 0.0
    for i in range(1, len(pts)):
        a, b = pts[i - 1], pts[i]
        dlat, dlng = (b[0] - a[0]) * r, (b[1] - a[1]) * r
        x = (math.sin(dlat / 2) ** 2 +
             math.cos(a[0] * r) * math.cos(b[0] * r) * math.sin(dlng / 2) ** 2)
        dist += 2 * R * math.asin(math.sqrt(x))
    up, ref = 0.0, None
    for p in pts:
        if p[2] is None:
            continue
        if ref is None:
            ref = p[2]
            continue
        d = p[2] - ref
        if d >= 3:
            up += d
            ref = p[2]
        elif d <= -3:
            ref = p[2]
    lats = [p[0] for p in pts]
    lngs = [p[1] for p in pts]
    mnx, mxx, mny, mxy = min(lngs), max(lngs), min(lats), max(lats)
    dx, dy = (mxx - mnx) or 1e-6, (mxy - mny) or 1e-6
    s = max(dx, dy)
    path = []
    for p in pts:
        path.append([round((p[1] - mnx + (s - dx) / 2) / s, 5),
                     round(1 - (p[0] - mny + (s - dy) / 2) / s, 5)])
    return dist, up, path


def _nearest_m(pts, lat, lng):
    """点位声明的位置离轨迹最近多少米——太远说明这条轨迹根本不经过这里。"""
    R = 6371000.0
    r = math.pi / 180
    best = 9e9
    for p in pts:
        dlat, dlng = (p[0] - lat) * r, (p[1] - lng) * r
        x = (math.sin(dlat / 2) ** 2 +
             math.cos(lat * r) * math.cos(p[0] * r) * math.sin(dlng / 2) ** 2)
        best = min(best, 2 * R * math.asin(math.sqrt(x)))
    return best


MAX_OFF_TRACK_M = 500      # 点位距轨迹超过这个距离就拒绝
MIN_TRACK_PTS = 10         # 轨迹点太少说明是随便画的


@app.post("/api/points", response_model=ClaimOut, tags=["占山为王"],
          status_code=201,
          responses={**ERR_401, 403: {"description": "配额已满"}},
          summary="自己创建一个山头，成为它的山大王")
def create_point(body: NewPointIn, uid: int = Depends(require_user)):
    """先发码、后核验——冷启动阶段最重要的是让点位先长出来。
    配额与认领共用一套等级（初级 3 个）。"""
    lv, _nx, used, _p, _k = _king_level(uid)
    if used >= lv["quota"]:
        err(403, "QUOTA_FULL",
            f"{lv['name']}山大王最多持有 {lv['quota']} 个点位（已用 {used} 个）。"
            "名下点位被更多人扫码即可升级。")
    # ── 必须有轨迹：没有 GPX 不能建点位 ──
    if not body.gpx or "<trkpt" not in body.gpx and "<coordinates>" not in body.gpx:
        err(400, "GPX_REQUIRED",
            "必须上传 GPX 轨迹文件。有轨迹才能证明你真的走过，也才能算出路书。")
    pts = _parse_gpx(body.gpx)
    if len(pts) < MIN_TRACK_PTS:
        err(400, "GPX_TOO_SHORT",
            f"轨迹只有 {len(pts)} 个点，至少要 {MIN_TRACK_PTS} 个。"
            "请上传完整的记录文件，不要自己画。")
    with_ele = sum(1 for p in pts if p[2] is not None)
    if with_ele < len(pts) * 0.5:
        err(400, "GPX_NO_ELE",
            "轨迹里没有海拔数据，算不出爬升。换一个带海拔的记录文件。")
    dist, up, path = _gpx_summary(pts)
    if body.lat is not None and body.lng is not None:
        off = _nearest_m(pts, body.lat, body.lng)
        if off > MAX_OFF_TRACK_M:
            err(400, "POINT_OFF_TRACK",
                f"你填的位置离这条轨迹最近也有 {int(off)} 米，"
                f"超过 {MAX_OFF_TRACK_M} 米。要么位置填错了，要么传错了轨迹。")
    code = _next_code()
    name = body.name.strip()
    if body.area:
        # 同名山头全国都有，地区一律写进名字——「老君山（洛阳）」。
        # 之前只在没坐标时才加，导致有定位的点位在列表里看不出是哪一个。
        name = name + "（" + body.area.strip() + "）"
    _moderate_public_text(uid, name + "\n" + (body.nickname or "") + "\n" + body.intro.strip())
    # 海拔没填就从轨迹里取最高点：GPX 里本来就有高程，不该让用户再抄一遍
    altitude = body.altitude
    if altitude is None:
        eles = [p[2] for p in pts if p[2] is not None]
        altitude = round(max(eles)) if eles else None
    with engine.begin() as conn:
        pid = conn.execute(text("""INSERT INTO points
            (code, type, name, level, altitude, status, geom,
             track_path, track_km, track_up, track_points)
            VALUES (:code, :type, :name, 'mid', :alt, 'published',
                    /* 取不到定位也能建点位：只填大致位置时 lat/lng 为 NULL，
                       参数必须显式转类型，否则 Postgres 猜不出 $5 是什么类型 */
                    CASE WHEN CAST(:lat AS double precision) IS NULL THEN NULL
                         ELSE ST_SetSRID(ST_MakePoint(CAST(:lng AS double precision),
                                                      CAST(:lat AS double precision)), 4326) END,
                    CAST(:path AS jsonb), :tkm, :tup, :tpts)
            RETURNING id"""),
            {"code": code, "type": body.kind, "name": name, "alt": altitude,
             "lat": body.lat, "lng": body.lng, "path": json.dumps(path),
             "tkm": round(dist / 1000, 2), "tup": round(up), "tpts": len(pts)}).scalar()
        if body.kind == "peak":
            _ensure_point_mountain(conn, pid, code, name, altitude)
        conn.execute(text("INSERT INTO short_links (code, point_id) VALUES (:c, :p)"),
                     {"c": code, "p": pid})
        conn.execute(text("""INSERT INTO claims
            (user_id, target_key, target_name, kind, nickname, contact, code)
            VALUES (:uid, :k, :n, :kind, :nick, :ct, :code)"""),
            {"uid": uid, "k": "point:" + code, "n": name, "kind": body.kind,
             "nick": body.nickname, "ct": body.contact, "code": code})
        # 那句介绍直接成为这个点位的第一条留言
        conn.execute(text("""INSERT INTO comments (point_id, user_id, text)
            VALUES (:pid, :uid, :txt)"""),
            {"pid": pid, "uid": uid, "txt": body.intro.strip()})
    return _claim_out(code, name, body.nickname)


@app.get("/api/me/king", response_model=KingOut, tags=["占山为王"],
         responses=ERR_401, summary="我的等级与可认领配额")
def my_king(uid: int = Depends(require_user)):
    lv, nxt, used, people, kept = _king_level(uid)
    return KingOut(level=lv["lv"], levelName=lv["name"], quota=lv["quota"], used=used,
                   people=people, kept=kept,
                   nextName=nxt["name"] if nxt else None,
                   nextNeedPeople=nxt["need"] if nxt else None,
                   nextNeedKept=nxt["kept"] if nxt else None,
                   nextQuota=nxt["quota"] if nxt else None,
                   canClaimMore=used < lv["quota"])
# 挂在最后，避免覆盖 /api 路由。前端产物来自仓库 app/（同一套设计令牌）。
import pathlib  # noqa: E402

_theme = pathlib.Path(os.getenv("THEME_DIR", "/srv/theme"))
if _theme.is_dir():
    app.mount("/theme", StaticFiles(directory=str(_theme)), name="theme")
_webapp = pathlib.Path(os.getenv("WEBAPP_DIR", "/srv/webapp"))
if not _webapp.is_dir():
    _webapp = pathlib.Path(__file__).resolve().parents[2] / "app"
if _webapp.is_dir():
    app.mount("/app", StaticFiles(directory=str(_webapp), html=True), name="webapp")
    # /theme/*.css 里的 url() 是按"站点根 = app/"写的（../images/home/…、
    # ../fonts/zmx-*.woff2、../assets/decor/…）。样式表挂在 /theme 下，
    # 浏览器会把它解析成 /images/…、/fonts/…、/assets/…，所以这几条必须挂在根上，
    # 否则 SPA 和正式页面的英雄图、手写字库、装饰全都 404，页面看着像"另一个版本"。
    for _prefix in ("images", "fonts", "assets"):
        _dir = _webapp / _prefix
        if _dir.is_dir():
            app.mount(f"/{_prefix}", StaticFiles(directory=str(_dir)), name=f"app-{_prefix}")
_static = pathlib.Path(os.getenv("STATIC_DIR", "/srv/web"))
if not _static.is_dir():
    _static = pathlib.Path(__file__).resolve().parents[2] / "app" / "web"
if _static.is_dir():
    @app.get("/", include_in_schema=False)
    def index_page():
        """根地址跳到主线前端 /app/。

        旧的静态多页前端（home/routes/places/me/admin/index.html）已于 2026-10-15
        封存到 archive/frontend-b-static/，不再由本服务提供；解除封存需用户明确许可，
        见 archive/README.md。此处保留 STATIC_DIR 挂载是为了 /privacy.html、
        /terms.html、/rules.html、/robots.txt 与 /terrain/。
        """
        return RedirectResponse(url="/app/", status_code=302)

    app.mount("/", StaticFiles(directory=str(_static), html=True), name="web")
