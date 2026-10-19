# 上线部署

> Vercel + Supabase 的逐步部署见
> [DEPLOY_VERCEL_SUPABASE.md](DEPLOY_VERCEL_SUPABASE.md)。本文件保留 Docker/自托管方案。

## 一、服务器准备

香港/新加坡节点（免备案）。最低 2 核 4G、40G 盘。

```bash
# 装 docker（Ubuntu/Debian）
curl -fsSL https://get.docker.com | sh
```

## 二、跑起来

```bash
git clone <仓库> && cd hikes/deploy
cp .env.example .env && vi .env      # 至少改 POSTGRES_PASSWORD / JWT_SECRET / PUBLIC_BASE_URL
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml exec api alembic upgrade head   # 建表/升级，空库也走这条
```

**建表和升级统一走 alembic**（2026-10-14 起）。Docker 启动不再自动执行 SQL，`docker compose up` 之后必须跑一次 `alembic upgrade head`，否则表不存在；不能把“重启 Compose”当作迁移。生产 API 挂载当前 `/app/` 页面，不使用旧静态原型替代。`021_board_collaboration.sql` 增加按板协作申请及独立审核角色；`022_maintenance_audit.sql` 增加维护操作审计；`023_comment_appeals.sql` 增加留言申诉。运营账号需由数据库管理员明确授予对应审核角色，不能由维护人或注册流程自动授予。

### 统一山大王与路书封面（0015–0017，2026-10-17 起）

`alembic upgrade head` 会继续执行：

- `0015_king_domain`：申请目标/草稿字段、`mountain_members`（同山唯一在任负责人）、
  山寨、移交、通知、留言置顶/隐藏理由、封面投稿；回填历史负责人/成员，冲突写入
  `king_migration_conflicts`。
- `0016_king_review_fields`：负责人意见、申请人确认时间、资料修改建议、成员移除申请。
- `0017_cover_recommendations`：关联山头成员对封面的推荐记录（推荐不等于通过）。

升级后先核对：

```bash
docker compose -f docker-compose.prod.yml exec db psql -U hikes -d hikes -c \
  "SELECT version_num FROM alembic_version;
   SELECT count(*) FROM mountain_members;
   SELECT count(*) FROM king_migration_conflicts WHERE resolved_at IS NULL;"
```

冲突清单非空时先人工处理，不自动覆盖负责人。旧接口 `POST /api/claims`、
`POST /api/master-applications`、旧协作申请/审核已返回 410，回滚前端也不能重新开放。

封面上传依赖 `Pillow` 与 `python-multipart`（见 `server/requirements.txt`），镜像必须重建。
生产必须给 API 配置持久化存储并设置 `ROUTE_MEDIA_ROOT`（例如对象存储挂载点）；
本机 `server/media/` 只是开发目录，不能作为上线存储。新通过封面会替换旧公开封面，
旧文件由接口清理；撤回/驳回不进入公开地址。

### V3 表结构（0010–0013）与保养作业（2026-10-16 起）

`alembic upgrade head` 会依次带上 V3 的四个修订：

- `0010_visit_evidence`：到访增加现场时间 `occurred_at`、服务器时间 `recorded_at`、证据等级、精度与坐标；
  旧行按 `created_at` 回填并标 `legacy`（不自动获得排名资格）；新增 `visit_submission_receipts`（打卡幂等回执）。
- `0011_ascent_courses`：新增 `ascent_courses`（人工核实的上登路线）与 `segment_efforts`（成绩）。
- `0012_private_letters`：`letters` 支持 `date / checkin / open` 三种解锁模式，旧日期按上海零点转换；新增用户级上榜开关。
- `0013_v3_job_runs`：`job_runs` 记录保养作业每次运行的 ok/failed 与时间。

**升级顺序**：先扩表迁移（上面的 0010–0013，都是加列/加表，不会删数据），再上兼容代码。
迁移前照第 6 节做一次备份；回退方式是恢复备份 + 退回上一个 git tag，不要用破坏性 downgrade。

保养作业由 `deploy/docker-compose.prod.yml` 里的 `v3-jobs` 服务承担（每小时一轮）：

```bash
# 作业是否在跑、最近一次结果
docker compose -f docker-compose.prod.yml exec db psql -U hikes -d hikes -c \
  "SELECT name, status, started_at, finished_at, detail FROM job_runs ORDER BY started_at DESC LIMIT 8"

# 手动跑一次（排查用）
docker compose -f docker-compose.prod.yml exec v3-jobs python /srv/jobs/reconcile_efforts.py
docker compose -f docker-compose.prod.yml exec v3-jobs python /srv/jobs/purge_visit_coordinates.py
```

- `reconcile_efforts`：重扫近 31 天的身份×业务日，补齐/重算成绩（"终点先到、起点后到"、合并后重算都靠它）。
- `purge_visit_coordinates`：清空 30 天前到访的原始坐标与精度，保留"校验通过"这个结论。
- 榜单或配对失败**不会**让打卡失败；作业失败只写一行 `failed` 台账并打印堆栈，容器不退。

### 迁移台账与升级（2026-10-14 起）

```bash
cd deploy
docker compose -f docker-compose.prod.yml exec api alembic current      # 现在到哪一版
docker compose -f docker-compose.prod.yml exec api alembic history      # 版本序列
docker compose -f docker-compose.prod.yml exec api alembic upgrade head # 升到最新
docker compose -f docker-compose.prod.yml exec db \
  psql -U hikes -d hikes -c "SELECT version, action, applied_by, applied_at FROM migration_log ORDER BY id DESC LIMIT 10"
```

- 台账是两张表：`alembic_version`（当前版本）和 `migration_log`（每次升级的版本、动作、执行者、时间）。
- 空库：`upgrade head` 按顺序执行基线和后续 Alembic 修订。
- 已有库：逐个文件检查哨兵对象，**缺哪个补哪个**。停在 018 的旧库也只补 019–023，不重复建表、不删数据、不动留言与到访记录。
- 失败：任何修订抛错即整版回滚，`alembic_version` 不前进，退出码非 0。看到非 0 就是没升上去，不要继续后面的步骤，先查日志。
- 库被手工改坏（哨兵对象缺失但版本已登记）会在升级时报错并列出缺失的迁移，先人工核对再继续。
- 数据库迁移脚本已冻结为历史记录：以后所有表结构变更都在 `server/migrations/versions/` 新增修订，不要往 `server/db/` 加 SQL 文件。规则见 `server/migrations/README.md`。
- **回滚不靠 downgrade**：回退方式是用第 6 节的备份把库恢复到发布前的状态，再把应用退回上一个 git tag。`0001_baseline` 的 `downgrade()` 直接报错，防止有人用它删表。

邮箱注册上线前，设置 `SMTP_HOST`、`SMTP_PORT`、`SMTP_USER`、`SMTP_PASSWORD`、`MAIL_FROM`、`PUBLIC_BASE_URL`；按邮件服务商要求选择 `SMTP_STARTTLS=1`（默认）或 `SMTP_SSL=1`。升级后由数据库管理员按 [PERMISSIONS.md](PERMISSIONS.md) 将 `platform_admin` 授予可信账号，再从 `/app/platform-admin.html` 管理审核员。未配置 SMTP 时，邮件注册会返回服务不可用，不会发放未经验证的账号令牌。

## 三、导入线路数据

```bash
# ① 本地先跑分级与底图（产物入库前必须存在；明细见 docs/PIPELINES.md）
python3 ../pipeline/build.py
PYTHONPATH=/private/tmp/hikes-terrain-deps python3 ../pipeline/build_terrain.py --skip-existing

# ② 表结构到最新，再导三类产物（一个脚本，--all 按顺序全导）
docker compose -f docker-compose.prod.yml exec api \
  alembic upgrade head
docker compose -f docker-compose.prod.yml exec api \
  python /srv/seeds/seed_routes.py --all
docker compose -f docker-compose.prod.yml exec api \
  python /srv/seeds/seed_race_checkpoints.py

# ③ 生成线路山顶二维码点位；首次导入线路后执行
docker compose -f docker-compose.prod.yml exec api \
  python /srv/seeds/backfill_peak_points.py
```

> 演示扫码点 `QS-TEST01` 只在需要时创建：`seed_routes.py --file /srv/routes-data/routes.json --demo-point`
> （首页"扫码打卡"、二维码与短链验收用它，所以保留但默认不建）。

## 四、验证

```bash
curl -s https://你的域名/health
# 期望：{"ok":true,"postgis":"3.4 ...","routes":12,"segments":75,...}

curl -sI https://你的域名/p/QS-TEST01 | head -1
# 期望：302；示例点位需先确认已导入

curl -s https://你的域名/api/qr/QS-TEST01/target
# 期望：encodes 指向你的正式域名，不是 localhost
```

**最后一步必须做**：用手机扫一次真实二维码，确认能跳到落地页并能打卡。

## 五、上线检查表

| # | 检查项 | 怎么确认 |
| --- | --- | --- |
| 1 | `.env` 不在版本库里 | `git ls-files \| grep -c '^deploy/.env$'` 应为 0 |
| 2 | `JWT_SECRET` 是随机串，不是示例值 | `grep JWT_SECRET .env` |
| 3 | `ALLOW_DEV_LOGIN` 没有设置 | `grep ALLOW_DEV_LOGIN .env` 应无结果 |
| 4 | 数据库端口没有对外暴露 | `docker compose ps` 里 db 没有端口映射 |
| 5 | `PUBLIC_BASE_URL` 是正式域名 | `curl /api/qr/{code}/target` |
| 6 | 二维码编码的是正式域名 | 同上，不能出现 localhost |
| 7 | 备份容器在跑，且当天有 dump | `ls deploy/backups/` |
| 8 | **真的恢复过一次** | 见第六节 |
| 9 | 手机扫码能打开落地页 | 拿手机扫 |
| 10 | 打卡后刷新数据还在 | 打卡 → 刷新 → 记录仍在 |

## 六、恢复演练（必须真做一次）

没恢复过的备份等于没有备份。2026-10-13 已在本地 Docker 对当前开发库演练 `pg_dump -Fc` → 临时库 `pg_restore --exit-on-error`，`routes/points/boards/visits/comments` 行数一致；2026-10-14 复演一次并补齐证据：dump 797,075 字节（1 秒）、`pg_restore --exit-on-error` 恢复 2 秒无报错，`routes=157 / points=1642 / boards=3054 / mountains=1484 / trail_segments=1570 / visits=156 / comments=5 / users=25` 与源库逐项相等；再把 `DATABASE_URL` 指向恢复库启了一次应用读取（`/health` 200，路线列表与线路详情正常）。演练库当场删除，开发库未受影响。

这两次都是**本地**演练，**不等于生产环境演练通过**；生产窗口内仍要按下面步骤真做一次。

```bash
# 新的空库
docker compose -f docker-compose.prod.yml exec db \
  psql -U hikes -c "CREATE DATABASE hikes_restore;"

# 从最近的 dump 恢复
ls deploy/backups/                       # 挑一个
docker compose -f docker-compose.prod.yml exec backup \
  pg_restore -h db -U hikes -d hikes_restore /backups/<文件>.dump

# 核对行数
docker compose -f docker-compose.prod.yml exec db \
  psql -U hikes -d hikes_restore -c "SELECT count(*) FROM routes;"

# 核对完删掉
docker compose -f docker-compose.prod.yml exec db \
  psql -U hikes -c "DROP DATABASE hikes_restore;"
```

## 七、已知的未完成项

- **正式账号**：用户名密码注册/登录已实现；微信登录不在当前 H5 上线范围。生产必须关闭 `/api/auth/dev-login`。邮箱验证与找回密码仍未完成。
- **无内容审核**：留言是明文入库的，UGC 合规要求先过机审。正式对外开放前必须补。
- **HTTPS 未配**：nginx 里 443 那段是注释，证书就绪后启用。
- **限流**：注册/登录、新建游客身份、留言/情报、打卡、举报均已按身份＋IP 双桶限流（阈值与环境变量见 `docs/API.md`「写接口限流」），本地已有可重复验收脚本 `server/tests/rate_limit_drill.sh`；**公开读取限流、批量抓取识别与压测尚未做**，反爬不能算验收通过。
- **迁移台账**：2026-10-14 起改用 alembic（`alembic_version` + `migration_log`），本地已验证空库、已有库、半升级库和失败回滚四条路径；生产环境首次执行 `alembic upgrade head` 才算验收通过。
- **api 镜像是否装了 alembic 还没验**：本地 Docker Hub 抽风、镜像没重建成功，当前开发容器里的 alembic 是临时 `pip install` 进去的。下次能拉镜像时跑一次 `docker compose build api && docker compose exec api alembic current` 确认。
