# server · 到此一游后端

## 一条命令起全栈

```bash
cd server
docker compose up --build
docker compose exec api alembic upgrade head   # 建表/升级；空库第一次必须跑
```

- API：http://localhost:8000 · 接口文档 http://localhost:8000/docs
- Postgres + PostGIS：localhost:5432（hikes / hikes / hikes）
- 建表不再由 Docker 启动时执行 SQL 完成（2026-10-14 起），统一走 `alembic upgrade head`；
  `db/001`–`023` 是基线修订读取的历史脚本，升级台账见 `migrations/README.md`

### 微信小程序登录配置

在部署 API 的环境中设置 `WECHAT_APP_ID` 和 `WECHAT_APP_SECRET`。本地 Docker Compose
会从 `server/.env` 读取这两个变量；该文件不要提交到 Git。AppSecret 只放在 API 服务器，
小程序只提交 `wx.login()` 返回的一次性 code。未配置时 `/api/auth/wechat` 返回明确的
`WECHAT_LOGIN_NOT_CONFIGURED`，不会降级到开发登录。

## 导入种子数据（三峰连穿）

```bash
docker compose exec api python /srv/seeds/seed.py
```

数据来自 `app/js/route-sanfeng.js`——那是 pipeline 已经算好的分级结果
（真实 GPX，100 m 重采样 → 平滑 → 找山顶 → 分段定级）。
等 `pipeline/` 工程化之后，这个脚本改成直接调 pipeline，不再读前端产物。

## 怎么验证（W1 验收）

```bash
curl -s localhost:8000/health
```

应该看到 `postgis` 版本、以及 `segments: 6` `peaks: 5` `routes: 1` `points: 1`。

```bash
curl -s localhost:8000/api/routes/sanfeng | head -c 400
```

应该看到 6 段（每段带 `level` / `pct` / `kind` / `source: auto` / `confirmed: false`）
和 5 个山顶（带 `altitude` 和 `rise`）。

```bash
curl -s localhost:8000/api/points/QS-P1092
```

应该看到点位详情 + `visitCount`。

```bash
curl -s -X POST localhost:8000/api/points/1/visit \
  -H 'Content-Type: application/json' -H 'X-User-Id: 1' -d '{"source":"scan"}'
```

第一次返回 `seq: 1`，**再执行一次返回同样的 seq 且 `isFirstVisit: false`**——
这就是"一天一次"去重生效的证明。

（`X-User-Id` 用 seed 打印出来的演示用户 id，默认是 1。）

## 仍需后续完善

- 生产部署需配置 `WECHAT_APP_ID`、`WECHAT_APP_SECRET` 和正式 `JWT_SECRET`
- 短链路由 `GET /p/{code}`（表已经建好）
- 留言接口 + 赞/踩（表已经建好）
- 埋点接口 `POST /api/events`
- ~~迁移改用 alembic~~：2026-10-14 已完成，见 `migrations/README.md`
- **`seq` 的并发安全**：现在用 `max(seq)+1` 算，并发打卡可能撞号。
  1 万用户以下实际很难触发，但 W2 要改成点位级序列或加行锁。
