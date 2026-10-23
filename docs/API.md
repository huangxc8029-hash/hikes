# 到此一游 · API 契约 v1（1.0 范围）

> **2026-10-13 契约状态**：产品对象以 [PRODUCT.md](PRODUCT.md) 为准。旧接口仍用于当前 H5 兼容；山顶稳定身份与共板读取已由迁移 013、017、018 接入。新权限细则见 PERMISSIONS.md（部分实施）。

这份契约跟跨端方案无关：小程序 / H5 / 维护台共用一套。
所有接口前缀 `/api`，返回 JSON。示例用 ```json 代码块标注。

## 通用约定

**鉴权目标**：线路、点位及公开留言可匿名读取；游客打卡使用游客令牌；账号写操作使用用户令牌；维护、审核和广告提升还需资源范围及独立能力校验。原“除微信登录与短链外一律登录”已废弃。当前接口的具体鉴权和登录／续期实现必须逐项核对，不能把角色名或有效 JWT 当作管理员权限。

**成功**：直接返回数据体，不套 `{code, data}`。

**失败**：
```json
{ "error": { "code": "POINT_NOT_FOUND", "message": "点位不存在" } }
```
状态码语义化：400 参数错 / 401 未登录 / 403 无权限 / 404 不存在 / 409 冲突 / 429 限流 / 500 服务端错。

**分页**：游标式 `?cursor=&limit=20`，返回 `{ items, nextCursor }`。不用 offset——
留言会不断新增，offset 会重复。

**打卡幂等**：账号与游客均由数据库约束按“身份＋点位＋日期”去重；同日重试返回首次写入的序号和时间。当前接口不接收 `Idempotency-Key`。游客客户端先以安全随机数生成并本地持久化令牌，`POST /api/guest` 用 `X-Guest-Token` 幂等确认；旧版 36 位及新版 48 位十六进制令牌均兼容。真机弱网仍待验收。

**写接口限流（2026-10-14 起）**：按**滚动一小时**计数，身份桶（账号或游客）与来源 IP 桶各自独立，任一超限即返回 429 `RATE_LIMITED`。每次超限往 `rate_limit_events` 写一行审计（作用域、命中的桶、身份、IP 的 SHA-256、路径、时间），并打一行日志方便告警。

| 作用域 | 接口 | 每身份/小时 | 每 IP/小时 |
| --- | --- | --- | --- |
| `comment` | `POST /api/points/{id}/comments`、`POST /api/segments/{sid}/comments`（岔路情报同此） | 10 | 30 |
| `visit` | `POST /api/points/{id}/visit`、`POST /api/guest/visit` | 60 | 120 |
| `report` | `POST /api/reports` | 10 | 30 |

其它已有阈值：注册 10 次/小时（按 IP）；登录失败 5 次/15 分钟（按 IP 与账号双桶）；`POST /api/guest` 新建游客身份 30 次/小时（按 IP）。阈值可用环境变量覆盖（`RATE_LIMIT_{COMMENT|VISIT|REPORT}_PER_{IDENTITY|IP}_HOUR`），留空或非数字即回落到上表默认值，变量说明见 `deploy/.env.example`。**校验失败和重复提交不占额度**：只有真正写入成功的那一次才计数。广告提交的限流随广告一起冻结。

**重复内容**：打卡靠数据库唯一约束（身份＋点位＋日期）幂等；留言没有天然唯一键，所以同一账号、同一目标、十分钟内**原文完全相同**的留言会被明确拒绝（409 `COMMENT_DUPLICATE`），不重复落库。

**公开读取限流（2026-10-14 起）**：匿名可读的 `GET /api/*` 与二维码短链 `GET /p/{code}` 按来源 IP 双窗口限流——**每分钟 120 次、每小时 2000 次**；超限返回 429 `RATE_LIMITED` 并记一条 `rate_limit_events`（scope=`read`）。一小时内被拒 **200 次**以上会升级为**临时封禁**：该来源的公开读取在一小时内返回 403 `READ_BLOCKED`。阈值可用 `RATE_LIMIT_READ_PER_MINUTE_IP`、`RATE_LIMIT_READ_PER_HOUR_IP`、`RATE_LIMIT_READ_BLOCK_AFTER_TRIPS` 覆盖，留空或非数字回落默认值。

被排除的路径（有各自的鉴权或属于运维）：`/api/me/*`、`/api/admin/*`、`/api/auth/*`、`/health`、`/docs`，以及全部静态页面与样式。正常浏览与扫码踩不到：一次页面加载只打几个公开接口，远低于每分钟 120 次；只有批量拉接口才会撞上。`/robots.txt` 明确不允许爬虫直接打 `/api/`，用户协议第 10 节写了自动化访问的边界。

**同山共板**：`GET /api/points/{code}` 返回 `mountainId`、`boardId`、`boardPointCodes`。同一山峰的不同二维码保持各自编号、线路与到访记录，`GET /api/points/{pointId}/comments`、山顶维护状态及点位广告读取同一块山顶板。`GET /api/me/follows` 对同山关注去重、汇总留言数；`GET /api/me/notifications` 包含同山其他入口的留言，维护人身份也按共板判断。只有地理资料审核员可调用 `POST /api/admin/mountains/link`，提交 `sourceCode`、`targetCode`、可核查的 `evidence`；跨线路身份不自动猜测合并。维护人冲突返回 409，合并留审计记录。

**首页近期内容**：`GET /api/community/recent` 从山顶、岔路、路段留言各取最多一条，返回 `kind/name/text/at/target`。只纳入正常发布、正式注册账号的留言；点位留言还要求点位已发布且有坐标。没有符合条件的内容就返回空数组，不回退到演示数据。

**路段共板**：`GET /api/routes/{slug}` 的 `segments` 返回旧分段 `id`、稳定 `trail_segment_id` 和 `board_id`。留言写入时仍保留旧分段来源；`GET /api/segments/{id}/comments` 按稳定路段身份汇总读取。只有审核确认同一路径及方向后才能复用同一稳定路段，当前不自动合并。

---

## 1. 认证

### POST /api/auth/wechat（微信小程序）

小程序先调用 `wx.login()`，只把短时有效的 `code` 发给服务端。服务端从环境变量
`WECHAT_APP_ID`、`WECHAT_APP_SECRET` 读取凭据并请求微信 `code2Session`，绝不把
`AppSecret` 或 `session_key` 返回给客户端。可带 `X-Guest-Token`，微信身份创建/更新、
JWT 签发和游客打卡/草稿合并在同一个数据库事务中完成。当前该端点只支持小程序 code，
H5 网页授权仍需单独实现。

```json
// 请求
{ "code": "081Abc..." }
// 响应
{ "token": "eyJ...", "tokenType": "Bearer", "userId": 1,
  "mergedVisits": 2, "mergedDrafts": 1 }
```

JWT 有效期 7 天；昵称通过 `GET /api/me/account` 读取。未配置服务器凭据时返回
503 `WECHAT_LOGIN_NOT_CONFIGURED`，微信服务临时不可用返回 502；不使用开发登录降级。

### POST /api/auth/register / POST /api/auth/login（用户名密码）

当前 H5 使用用户名密码账号，邮箱可选。密码至少 12 位，以 Argon2 哈希保存；登录按来源 IP 和规范化用户名双限流，注册按 IP 限流。两个接口都可带 `X-Guest-Token`：账号创建／登录与游客到访及草稿合并处在同一数据库事务中，返回 `token`、`userId`、`mergedVisits` 与 `mergedDrafts`。登录成功后仍停留在原扫码点位。

```json
{ "username": "trail_friend", "password": "至少 12 位的密码", "nickname": "山友", "email": "可选" }
```

注册限流：同一 IP 每小时最多 10 次；登录失败：同一 IP 或账号 15 分钟内最多 5 次。用户提交留言草稿后必须再次明确调用 `POST /api/me/arrival-drafts/{code}/publish` 才会公开。

### 游客扫码（当前实现）

游客令牌由客户端保存在本设备；无需账号即可完成点位打卡。私人纪念与尚未公开的留言草稿分别存储，游客草稿只有在登录后调用合并接口才转入账号，不会自动变成公开留言。

| 方法与路径 | 用途 | 鉴权 |
| --- | --- | --- |
| `POST /api/guest` | 创建或确认游客身份，返回同一 `token` | 可选 `X-Guest-Token`（推荐客户端先持久化） |
| `POST /api/guest/visit` | 按 `code` 打卡，返回 `seq`、`visitedAt`、`isFirstToday` | `X-Guest-Token` |
| `POST /api/guest/arrival-draft` | 保存 `privateNote`（最多 500 字）和/或 `publicCommentDraft`（最多 200 字） | `X-Guest-Token` |
| `GET /api/guest/arrival-draft?code=...` | 恢复当前设备在该点位的草稿 | `X-Guest-Token` |
| `POST /api/me/merge-guest` | 合并游客打卡和两类草稿 | 用户 JWT + `X-Guest-Token` |
| `GET /api/me/arrival-drafts` | 取回账号下的私人纪念与未发布留言草稿 | 用户 JWT |
| `PUT /api/me/arrival-drafts` | 保存账号下的私人纪念或未发布留言草稿 | 用户 JWT |
| `POST /api/me/arrival-drafts/{code}/publish` | 用户明确发布某点位的留言草稿；重复请求返回同一 `commentId` 和 `alreadyPublished: true` | 用户 JWT |

发布回执由 `019_arrival_publish_receipts.sql` 持久化。新建该点位的公开草稿会清除旧回执；私人纪念不因发布而清空。现有数据库需单独执行 019 迁移（新库初始化会自动执行）。

`/api/auth/dev-login` 只供显式开发配置使用，不能用于公开认证。

### GET /api/me
```json
{ "id": "u_1", "nickname": "阿甘", "visitedCount": 12, "claimedPoints": 1 }
```

---

## 2. 短链（服务端路由，不是 API）

### GET /p/{code}
二维码里印的就是这个。按 UA 分流：

| 环境 | 行为 |
| --- | --- |
| 微信内 + 已配小程序 | 跳小程序中转页（路径固定 `pages/scan?c={code}`，参数可变） |
| 微信内 / 系统浏览器 | 302 到 H5 `/#/p/{code}` |
| 桌面浏览器 | "用手机扫码"页 + 二维码 + 编号输入框 |

`{code}` 一旦生成不可变——这是标牌不用重印的前提。

---

## 3. 点位

### GET /api/peaks?limit=&route=
山头列表。**一次返回两支来源，靠 `origin` 区分**——线路 GPX 自动识别的山顶（`route`）
和用户自己上传 GPX 建的点位（`user`）。两者都是 GPX 算出来的，前端就是一个列表。

```json
[{ "id": 21, "origin": "route", "code": null,
   "route_slug": "donglingshan", "route_name": "东灵山主峰",
   "idx": 1, "km": 5.98, "altitude": 2287, "rise": 594,
   "name": null, "lat": 40.03, "lng": 115.45,
   "city": "北京 · 门头沟", "level": "hard", "weekly_heat": 0 },
 { "id": 3, "origin": "user", "code": "BJ-1042",
   "route_slug": null, "route_name": null,
   "idx": 0, "km": 21.09, "altitude": 1180, "rise": 1949,
   "name": "鹰嘴崖（门头沟 妙峰山）", "lat": 40.05, "lng": 116.1,
   "city": null, "level": "mid", "weekly_heat": 0 }]
```

前端 key 规则：`origin=route` 用 `route_slug + '-' + idx`，`origin=user` 用 `p-{code}`。
`route` 参数只筛某条线路，此时只返回该线路的 `route` 山顶。

**自建点位的海拔**在 `POST /api/points` 时自动取轨迹最高点（用户没填的话），
所以自建点位一样能进按海拔排序的榜单。**地区一律写进名字**——「老君山（洛阳）」。

### GET /api/peaks/hot?limit=10

> 以下为旧模型接口说明，等待山峰独立模型迁移；不能据此定义新的山头身份。
热门登顶榜。**一座山头（主峰）一行**，按打卡热度 + 用户关注度排。

「山头」= 一条线路上**最难那条爬升段所通向的那个顶**（`point` 行），不是线路本身。
`name` 为空是正常状态（真名要实地采）→ 界面显示「名称待定」；
`route_name` 用来在卡片上做一行「@三峰连穿」的小字注释。

### GET /api/summits?limit=100

> 以下线路级卡片与热度口径为待替换旧契约；新产品按独立山峰聚合，用时按具体登顶路段区分。
山头列表：一条线路一张卡，卡是它的主峰；用户自建山头也在里面（`routeSlug` 为 null）。
字段与 hot 一致，另加 `pointId` / `code`（这个山头自己的编号，二维码印的就是它）。

```json
[{ "rank": 1, "target_key": "sanfeng", "kind": "trail", "name": "三峰连穿",
   "route_slug": "sanfeng", "code": null, "city": "北京 · 海淀 / 门头沟",
   "altitude": 1257, "peak_count": 5,
   "seg_rise": 971, "seg_km": 4.92,
   "heat7": 14, "heat30": 40, "visitors": 24, "wants": 13,
   "fastest_time": "01:53", "fastest_holder": "演示山友19", "score": 108 }]
```

```text
score = heat7 × 3 + heat30 + wants × 2
```

- `seg_rise` / `seg_km` = **单段爬升 / 单段距离**，取全线最难的**爬升**段（`kind='climb'`）。
  不取下降段：白八拉最难那段是 −557 m 的下坡，标成"爬升 −557"没人看得懂。
- `visitors` = 近 30 天**去重人数**，卡片上的"打卡人数"就是它。
- `fastest_time` / `fastest_holder` = 打卡记录里 `duration_sec` 最小那条；没人记过则为 null。
- **打卡热度**：线路行按"挂在这条线路上的点位"归集——`route_peaks` 没有独立点位行，
  扫码打到的是线路上的那个点，所以热度天然是线路级的；自建山头就是它自己那个点位。
- **关注度**：`wants` 表里想去 / 收藏过它的人。线路行会把 `slug` 和 `slug-{idx}`
  两种 key 都算进去——用户可能从线路页收藏，也可能从某个山顶页收藏。
- 自建山头行**只收 `route_id IS NULL` 的点位**。挂在线路上的点位是那条线的扫码点，
  热度已经算进线路那一行了，再列一次就是同一座山上两次榜。
- `target_key` 直接当路由用：`kind=trail` → `#/trails/{target_key}`，`kind=peak` → `#/peaks/{target_key}`。

### POST /api/wants · DELETE /api/wants
关注 / 想去。**必须落库**——热门登顶榜的"关注度"数的是这张表，只存在 localStorage 里服务端算不出来。

```json
// POST 请求体；重复调用幂等，成功返回 204
{ "kind": "trail", "target_key": "sanfeng" }
```

`DELETE /api/wants?kind=trail&target_key=sanfeng` → 204。
`GET /api/me/wants` → `[{ "kind": "trail", "targetKey": "sanfeng", "at": "..." }]`。

前端只在 key 能对上真身时才上报（线路 slug / 山顶 `slug-idx` / 自建点位 `p-{code}`）；
岔路还是本地 mock id，不上报，免得往表里写脏数据。

### GET /api/visits/recent?days=7&limit=30
最近的打卡流水，热门登顶榜「所有」弹层里那一列。按时间倒序。

```json
[{ "who": "演示山友18", "at": "2026-10-12T07:48:00+00:00", "seq": 1,
   "place": "三峰连穿", "route_slug": "sanfeng", "code": "DEMO-SANFEN",
   "type": "peak", "time": "6:16", "href": "#/trails/sanfeng" }]
```

`place` 取线路名（挂在某条线路上的点位），自建点位取自己的名字；
`href` 直接给前端跳转用：线路点 → 路书，自建点位 → 山头详情。`time` 是本次用时，没记过则为 null。

### GET /api/points/{code}
落地页首屏所需的全部数据，一次返回。

```json
{
  "id": "pt_1", "code": "QSD02", "type": "junction",
  "name": "林道岔口", "routeName": "溪谷森林步道",
  "indexInRoute": 2, "totalInRoute": 5,
  "level": "mid", "altitude": null,
  "guide": { "arrow": "↰", "title": "左转上山，别跟右边那条宽路",
             "desc": "右侧是林场作业道", "next": "下一段 · 溪谷平台 1.8 km" },
  "visitCount": 176,
  "myVisit": { "seq": 128, "count": 2 },
  "comments": { "count": 12, "preview": [ "Comment", "Comment" ] },
  "topComment": "Comment"
}
```
`myVisit` 未到访为 `null`。`topComment` 是落地页第一屏要展示的那一条。

---

## 4. 打卡

### POST /api/points/{id}/visit
```json
// 请求
{ "source": "scan", "clientTime": "2026-10-11T05:20:00Z" }
// 响应
{ "seq": 129, "isFirstVisit": false, "myVisitCount": 3,
  "isNewRecord": false, "message": "你是第 129 位在这里留下痕迹的人" }
```
**去重规则**：同一用户 + 同一点位 + 同一天只计一次（返回已存在的 seq），跨天才 +1。

### POST /api/claims/master
**成为版主**：不发编号、不发二维码，只把这个山头的线上留言板接管下来。

```json
// 请求
{ "target_code": "SF-01", "nickname": "阿甘", "contact": "wx: agan" }
// 响应
{ "pointCode": "SF-01", "targetName": "名称待定", "nickname": "阿甘",
  "message": "你成了这个山头的版主。没有二维码这一说——二维码是标牌上的事。你手上的是它的留言板。" }
```

和 `POST /api/claims`（山大王）的区别：**不消耗山大王配额、不发编号、不发二维码**。
二维码是标牌上的事，得实地印、实地贴；版主做的是线上那一半。
重复认领返回 409 `ALREADY_MAINTAINED`。

### GET /api/me/route-progress
山径拼图的数据源：我打卡过的线路 × 每条线路上的点位。

```json
[{ "routeSlug": "sanfeng", "routeName": "三峰连穿",
   "visited": 2, "total": 6, "complete": true, "climbTime": "3:26",
   "points": [{ "code": "SF-S", "name": null, "type": "trailhead", "index": 0,
                "altitude": null, "mine": 1, "lastAt": "...", "href": "#/peaks/p-SF-S" },
              { "code": "SF-01", "name": null, "type": "peak", "index": 1,
                "altitude": 1092, "mine": 1, "href": "#/peaks/p-SF-01" }] }]
```

- `mine` 是我在这个点位的打卡次数；0 = 没去过，前端画灰色。
- `complete` = 山脚 + 这条线上任意一个顶都打过卡。
- `climbTime` = 山顶那次打卡 − 山脚那次打卡，只有 `complete` 时才有。
- **没打卡的点位也照常返回**，前端要靠它画灰格。

### GET /api/me/visits?cursor=&limit=
（响应里带 `code` 与 `routeSlug`——山径拼图靠它判断哪几格该点亮，
光有 `pointId` 是数不出"去过哪座山"的。）
```json
{ "items": [{ "pointId": "pt_1", "name": "林道岔口", "seq": 128,
  "at": "2026-09-21T03:12:00Z", "level": "mid" }], "nextCursor": null }
```

---

## 5. 留言

### GET /api/points/{id}/comments?cursor=&limit=20
**排序规则固定，前端不要再排**：
1. 维护人的留言置顶
2. 然后按净分 `like - bad` 降序
3. 同分按时间倒序

```json
{
  "items": [{
    "id": "c_1", "text": "下雨天石阶很滑，我走的左侧土路。",
    "user": { "id": "u_2", "nickname": "小鱼" },
    "role": "member", "like": 4, "bad": 1, "myVote": null,
    "status": "normal", "at": "2026-10-10T09:00:00Z"
  }],
  "nextCursor": null
}
```
`role` 取 `member | maintainer`；`myVote` 取 `null | "like" | "bad"`。

**`status = flagged` 的触发条件：`bad >= 3 且 bad > like`。**
不删除，只灰度显示——路况信息过时了需要留痕。

### POST /api/points/{id}/comments
```json
{ "text": "上面风大，记得带件外套。" }
```
v1 **只收纯文本，最多 200 字**，图片走 v1.1。

### POST /api/comments/{id}/vote
```json
{ "value": "like" }
```
`value` 取 `"like" | "bad" | null`，`null` 表示取消投票。

---

## 6. 路书

### GET /api/routes?cursor=&level=&q=
```json
{ "items": [{ "id": "rt_1", "name": "三峰连穿",
  "sub": "大觉寺·鹫峰·阳台山·妙峰山",
  "km": 21.1, "up": 1948, "down": 1951, "level": "hard",
  "peakCount": 5, "segmentCount": 6, "visitCount": 86 }],
  "nextCursor": null }
```
`up` / `down` 用**原始高程 + 3 m 滞回**计算，不用平滑后的高程（踩过的坑）。

### GET /api/routes/{id}
```json
{
  "id": "rt_1", "name": "三峰连穿", "km": 21.1, "up": 1948, "down": 1951,
  "level": "hard",
  "path": [[0.12, 0.44]],
  "profile": [0.0, 0.03],
  "peaks": [{ "index": 0, "km": 4.9, "altitude": 1092, "rise": 971 }],
  "segments": [{
    "no": 1, "fromKm": 0.0, "toKm": 4.9, "km": 4.9, "rise": 971, "pct": 20,
    "level": "hard", "kind": "climb",
    "difficulty_applicable": true, "not_applicable": null,
    "up_m": 1002, "down_m": 31, "max_rise_m": 971, "max_drop_m": 0,
    "source": "auto", "confirmed": false, "commentCount": 2
  }]
}
```
`path` / `profile` 是归一化 0–1 的数组，前端直接喂给 `<RouteMap>` 画 SVG，
服务端不做投影——**换地图方案时前端不用改后端**。

**段难度可以为 null，这不是缺数据**：难度描述的是"爬上去有多难"，
下坡与平缓段不适用。定级判据是 `max_rise_m ≥ 200 m`（段内最大连续爬升）
或净坡度 `pct > 3%`；两者都不满足时 `level` 为 `null`、`difficulty_applicable`
为 `false`，`not_applicable` 说明原因（`descent` 净下坡 / `gentle` 平缓）。
爬升为什么用"最长连续爬升"而不是累计爬升或净高差，见
[PIPELINES.md](./PIPELINES.md)。整条线路没有可定级爬升时，
`hardest_level` 同样是 `null`，前端显示"未评级"。

**`source`（auto/manual）和 `confirmed` 是必须的**：自动算出来的是基础判断，
维护人确认后才算正式数据。

---

## 7. 埋点

### POST /api/events
```json
{ "name": "scan_landing", "props": { "pointCode": "QSD02" }, "ts": 1760000000000 }
```
批量上报传数组。三个验证问题全靠它：

小程序批量上报每次最多 50 条；带有效 Bearer JWT 时服务端填写 `events.user_id`，未登录事件保持匿名。小程序只发送事件名与来源等白名单字段。接口按来源 IP 限制每小时请求次数。

- **会不会扫码** → `scan_landing` 去重人数
- **会不会留言** → `comment` / `visit` 人数比
- **会不会反复打开** → `app_open` 的 7 日回访率（按 user_id 去重）

---

## 8. 山顶广告（当前实现）

山顶板每板固定一个展示位，不按维护人等级扩容。`GET /api/points/{code}/ads` 对游客只返回当前已审核且未过期的最多一条；本板维护人还可见自己提交的草稿、待审、驳回、已上架与过期版本。`quota.used/total` 表示展示位占用（0/1 或 1/1），不是可提交素材数。

| 方法与路径 | 用途 | 权限 |
| --- | --- | --- |
| `POST /api/points/{code}/ads/drafts` | 保存可不完整的私有草稿 | 本板维护人 |
| `PATCH /api/points/{code}/ads/{id}` | 修改本人草稿或被驳回版本，回到草稿 | 本板维护人且是作者 |
| `POST /api/points/{code}/ads/{id}/submit` | 草稿提交系统审核；标题至少两字 | 本板维护人且是作者 |
| `POST /api/points/{code}/ads` | 兼容旧客户端，直接提交待审素材 | 本板维护人 |
| `GET /api/admin/ads?status=pending` | 查看审核队列 | 系统广告审核员 |
| `POST /api/admin/ads/{id}/review` | 通过或附理由驳回；通过后替换本板旧展示 | 系统广告审核员，禁止自审 |
| `POST /api/admin/ads/{id}/promote` | 提升首屏或撤回 | 系统广告审核员，禁止操作自己的广告 |

迁移 `020_ad_draft_versions.sql` 增加 `draft` 状态及投放天数。草稿、待审和驳回版本不公开；旧已上架素材在新版本审核完成前继续展示。此节目前只覆盖山顶点位板，岔路和路段板的统一广告身份仍待实现。

### 山顶板协作（021 迁移）

| 接口 | 用途 | 权限 |
| --- | --- | --- |
| `GET /api/me/collaboration-applications` | 我的申请与审核结果 | 本人 |
| `POST /api/boards/{board_id}/collaboration-applications` | 申请已有人维护的山顶板；同板待审/已通过重复提交返回原申请 | 注册用户，非本板维护人 |
| `GET /api/admin/collaboration-applications?status=pending` | 平台待审队列 | `collaboration_reviewer` |
| `POST /api/admin/collaboration-applications/{id}/review` | `approved`、`rejected` 或已通过后的 `revoked`，附至少 8 字依据 | `collaboration_reviewer`，禁止自审 |

协作者获批后出现在 `/api/me/summits`，`role=collaborator`。服务端仅允许其隐藏同一山顶板的留言；点位编辑、广告提交和广告审核不随此角色开放。撤销立即失效。审核记录保存在申请行，关键操作另记入审计表；隐藏留言的申诉与恢复接口见下文。

### 维护审计（022 迁移）

`POST /api/comments/{id}/hide` 接受 `{ "reason": "至少 8 字的处置理由" }`；维护人或协作者隐藏他人留言必须提供，作者隐藏自己的留言可省略。点位编辑、留言隐藏、协作审批/撤销、广告审批及展示位置调整同步写入 `maintenance_audit_logs`。日志只供平台数据库审计，不作为公开用户内容。

### 隐藏留言申诉（023 迁移）

| 接口 | 用途 | 权限 |
| --- | --- | --- |
| `GET /api/me/hidden-comments` | 查看自己被隐藏的山顶留言，以及恢复后的处置结果 | 原作者 |
| `POST /api/comments/{id}/appeals` | 提交本次隐藏的申诉，`reason` 为 8–500 字；重复请求返回原记录 | 原作者，不能申诉自己隐藏的内容 |
| `GET /api/admin/comment-appeals?status=pending` | 查看待复核留言和申诉说明 | `content_reviewer` |
| `POST /api/admin/comment-appeals/{id}/review` | `restored` 或 `rejected`，附 8–500 字理由 | `content_reviewer`，禁止原作者或隐藏执行人复核 |

恢复时使用隐藏审计中的原状态（`normal` 或 `flagged`），不清除原始投票；申诉复核与留言状态变化同事务写审计。旧版无隐藏审计的留言恢复为 `normal`。申诉和审核结果仅作者及平台可读，不进入公开留言流。

## 9. 举报与处置（2026-10-14 新增，迁移 `0002_content_reports`）

非公开输入：谁提交、提交了什么、处理结果，只对本人和系统内容审核员可见。"岔路情报"就是岔路点位上的留言，走同一个接口；广告举报随广告一起冻结，不在本节。

### POST /api/reports
```json
// 请求
{ "targetType": "comment", "targetId": 88, "reason": "abuse", "detail": "含辱骂内容" }
// 响应 201
{ "id": 12, "targetType": "comment", "targetId": 88, "reason": "abuse",
  "detail": "含辱骂内容", "status": "pending", "handleReason": null,
  "actionTaken": null, "createdAt": "2026-10-14T12:00:00Z", "duplicate": false }
```

- 身份：账号令牌（`Authorization: Bearer`）或游客令牌（`X-Guest-Token`）；两者都没有返回 401 `REPORT_IDENTITY_REQUIRED`。游客举报同样是"可受限提交、不直接公开"。
- `reason` 取 `spam | abuse | false_info | privacy | illegal | other`；`detail` 可选，2–200 字。
- 对象校验：目标不存在 404 `COMMENT_NOT_FOUND`；目标已隐藏 409 `REPORT_TARGET_NOT_REPORTABLE`；举报自己的留言 409 `REPORT_SELF`。
- 去重：同一身份对同一对象的**待处理**举报只保留一条；重复提交返回 200、`duplicate: true` 和原记录 id（幂等，不新建、不再计一次额度）。
- 限流：每身份 10 条/小时、每 IP 30 条/小时（与「通用约定 → 写接口限流」同一套阈值），超限 429 `RATE_LIMITED` 并记一条 `rate_limit_events`。校验失败和重复提交不占额度。

### GET /api/admin/reports?status=pending&limit=50
系统内容审核员（`content_reviewer`）专用，其他身份 403。返回举报及其目标上下文：留言原文、留言状态、点位编号与名称、举报人昵称（游客显示"游客"）。`status` 取 `pending | accepted | rejected`。

### POST /api/admin/reports/{id}/review
```json
{ "decision": "accepted", "reason": "举报成立，内容不适合公开展示", "action": "hide" }
```

- `decision` 取 `accepted | rejected`；`reason` 必填 8–500 字，举报人与审计都要能看懂；`action` 取 `none | hide`，只在 `accepted` 时生效。
- 不能处置自己提交的举报 → 403 `SELF_REVIEW_FORBIDDEN`；再处置已处理过的举报 → 409 `REPORT_ALREADY_HANDLED`。
- `accepted + hide` 会把该留言置为 `hidden` 并写 `comment.hide` 审计，所以原作者仍可走留言申诉（见第 10 节）；同时写 `report.review` 审计。两条审计与举报状态在同一事务内完成。

### GET /api/me/reports
返回本人提交过的举报及处置结果（最新 50 条）。看不到别人的举报。

---

## 10. 账号注销（2026-10-14 新增，迁移 `0004_account_deletion`）

注销不是 `DELETE users`：审计表对操作者是 `RESTRICT`（审核痕迹必须留住），而留言对作者是 `CASCADE`（物理删会把公开路况一起带走）。所以注销做的是**删个人数据 + 匿名化账号行**。

### POST /api/me/delete-account
```json
// 请求（二选一重新验证身份）
{ "code": "微信 wx.login() 返回的一次性 code", "confirm": "注销" }
// 或密码账号
{ "password": "……", "confirm": "注销" }
// 响应 200
{ "deletedAt": "2026-10-14T13:00:00Z",
  "removed": { "tracks": 1, "visits": 1, "wants": 1, "drafts": 1, "votes": 1,
               "publishReceipts": 0, "appeals": 0, "collaborationApplications": 0,
               "claims": 0, "roles": 0, "letters": 0, "maintainedPoints": 0 },
  "kept": { "comments": 1, "reports": 1, "auditLogs": 1, "reviews": 0,
            "unlinkedScans": 0, "mergedGuests": 0, "adVersions": 0 },
  "message": "账号已注销：……" }
```

- `confirm` 必须原样写「注销」，否则 400 `CONFIRM_REQUIRED`。微信小程序账号提交新的 `wx.login()` code，服务端通过 code2Session 核对其 OpenID 与当前 JWT 账号一致；密码账号仍可用密码验证。已注销过返回 409 `ACCOUNT_DELETED`。
- **删除**：位置轨迹、到访记录、想去、私人纪念与留言草稿、发布回执、赞踩、自己作为作者的申诉、自己作为申请人的协作申请、认领记录、系统角色，以及他所维护点位的 `maintainer_id`。
- **保留但去掉身份**：公开留言正文、举报记录、审计行、审核记录。它们仍指向这行用户，但 `username / nickname / email / avatar / password_hash / wx_openid / wx_unionid` 全部置空，页面显示为「山友」。
- 注销后：旧 JWT 立刻失效（`require_user` 每次校验 `deleted_at`，返回 401 `ACCOUNT_DELETED`）；登录不可能成功（没有用户名与密码）；同一用户名可以重新注册，但那是**新账号**，不继承任何历史。
- 本地验收：`bash server/tests/account_deletion_drill.sh`（12 项，含"审计行仍在""留言正文保留但作者匿名"）。

---


## V3 新增接口（2026-10-16，drill 覆盖见 docs/V3_ACCEPTANCE.md）

约定：新字段一律 camelCase；错误结构沿用 `error.code` / `error.message`；旧字段保持兼容。

### 打卡（升级，不是新接口）

- `POST /api/points/{point_id}/visit`、`POST /api/guest/visit`
  - 新增可选请求字段：`clientUuid`（每次本机动作的 UUID，重试复用）、`occurredAt`（现场时间，必须带时区）、
    `source: scan | nearby | manual`、`lat` / `lng` / `accuracyM`（`source=nearby` 时必填）。
  - 旧客户端不传新字段时按服务器当前时间记账，行为不变。
  - 新增响应字段：`visitId`、`recordedAt`、`isFirstToday`（游客接口沿用 `isFirstToday`）、`effortStatus`；
    原有 `seq` / `visitedAt` / `peakName` / `message` 等继续返回。
  - `seq` 是**该点位入账的记录序号**，不是去重人数。
  - 错误：`CLIENT_UUID_REUSED`(409，同一 UUID 换了内容)、`VISIT_TIME_IN_FUTURE`(422，超前 5 分钟以上)、
    `VISIT_TOO_OLD`(422，超过 30 天的补传)、`OUTSIDE_CHECKIN_RADIUS`(422)、`LOCATION_INACCURATE`(422，精度 >50 m)、
    `LOCATION_REQUIRED`(422)、`POINT_LOCATION_MISSING`(422)、`GPS_NOT_ENABLED`(422)。
  - 定位打卡的坐标只用于当场校验：不进 URL、不进访问日志、不进公开响应，30 天后被作业清空。

### POST /api/points/nearby

```json
// 请求（POST：坐标不进 URL）
{ "lat": 39.99, "lng": 116.17, "accuracyM": 12 }
// 响应 200：最多 20 个、只在**真实可打卡半径**内、已发布且有点位坐标的点位，按距离升序
[ { "pointId": 12, "code": "CNP-003", "name": "香山", "kind": "peak",
    "routeId": 3, "routeName": "香八拉", "mountainId": 8, "mountainName": "香山",
    "distanceM": 84, "checkinRadiusM": 100, "canCheckIn": true, "siblingCount": 1 } ]
```

- 公开接口，按 IP 限流；**不记录到访**。响应里没有精确坐标。
- 山顶半径 100 米，山脚 / 岔路 150 米；列表与 `source=nearby` 打卡用同一套半径，
  因此列表里出现的点一定能打卡，不会出现"看得到、打不上"。
- 同一山头、同一类型在半径内只返回最近的一个（`siblingCount` 是同组候选数），
  避免同一起点上的多条赛事线路把列表挤满。

### 山脚候选核验（维护台）

`GET /api/me/trailhead-candidates`：返回当前用户有权处理的山脚候选（`status=draft`）。
山头负责人只看到自己山头的候选；平台地理审核员（`place_curator`）能处理全部。
候选来自线路轨迹起点，字段含 `id / code / name / routeName / mountainName / lat / lng /
needsMountain / canReview`。

`POST /api/points/{id}/trailhead-review`：

```json
{ "decision": "publish", "name": "大觉寺山脚", "lat": 40.0514, "lng": 116.1006,
  "mountainId": 70, "note": "现场核对" }
```

- `decision=publish`：必须有名称为 2 字以上、坐标和所属山头，发布后才会进入附近打卡。
- `decision=reject`：标为不是山脚，不再出现在待核验队列，保持草稿状态。
- 权限：该山头负责人或平台地理审核员；无山头归属的候选只有平台审核员能处理。

### GET /api/mountains/{mountain_id}/courses

返回该山的登顶路线：`[{ id, name, startPointId, endPointId, rankingEnabled }]`。
`rankingEnabled=false` 表示这条路线还不能区分路径，只留个人参考用时。

### GET /api/efforts/leaderboard?courseId=&window=week|month|year|all

```json
{ "courseId": 12, "window": "week", "sampleSize": 9, "rankingAvailable": true,
  "leaders": [ { "nickname": "小鱼", "durationS": 2400, "date": "2026-10-13", "rank": 1 } ],
  "myBest": { "nickname": "我", "durationS": 2600, "date": "2026-10-14", "rank": 3, "percentile": 66 } }
```

- 窗口按**终点现场时间**、Asia/Shanghai（周一为一周起点）切分；每人每窗口只算最快一次。
- `sampleSize < 8` 或路线未开榜时 `rankingAvailable=false`、`leaders` 为空（不给名次与百分位）。
- 名次＝更快人数 + 1（同秒并列同名次）；百分位＝更慢人数 / 有效人数 × 100（同用时不算更慢）。
- 公开响应只有昵称、日期、用时；没有精确时刻、没有坐标。带 `Authorization` 时额外返回自己的成绩。
- 只有"账号 + 开启上榜 + 路线已开榜 + 两端证据合格 + 实时提交"的成绩才进榜；游客与离线补传只做参考。

### GET / PATCH /api/me/leaderboard-settings

`{ "enabled": true }`。关闭后立即退出榜单与分母（不需要等下一次重算）。

### GET /api/me/visit-receipts 、GET /api/guest/visit-receipts

- 参数：`limit`（默认 20，上限 50）、`cursor`（上一页最后一条的 `visitId`；按 `(occurredAt, id)` 取更早的）。
- 每条：`{ visitId, code, name, kind, seq, visitedAt, recordedAt, durationS, effortReason }`；
  `effortReason` 为 `null` 或 `too_fast | offline_submission | guest | weak_evidence | course_unverified`。
- 已合并的游客身份单独用游客令牌读会返回 401。

### GET /api/me/mountain-summary 、GET /api/guest/mountain-summary

`limit` 默认 3（首页用），最多 50。每条：`{ mountainId, name, visitorCount, myLastVisitedAt }`。
`visitorCount` 按 mountain_id 去重后的身份数（游客跨设备无法识别为同一真人，页面注明是"记录身份去重"）。
没有 mountain_id 的点位不进这张表。

### GET / POST /api/me/letters 、GET / DELETE /api/me/letters/{id}

- `POST`：`{ text: ≤2000 字, mode: date|checkin|open, years: 1|3|5（date 必填）, pointId（checkin 必填） }`。
  非法组合返回 422（`LETTER_YEARS_REQUIRED` / `LETTER_POINT_REQUIRED` / `LETTER_MODE_CONFLICT` / `LETTER_EMPTY`）。
  date 模式按上海时间算到期（闰日落到目标年 2 月末）。
- 列表/读取：`{ id, mode, pointId, pointCode, pointName, status, unlockAt, createdAt }`，
  **只有已解锁才带 `text`**；未解锁的正文在任何响应里都不下发。
- checkin 模式要求写信之后在该点位有新的有效到访（`occurred_at > created_at`）才解锁，离线补传入账后同样生效。
- 越权一律 404；删除后不可访问；没有"改模式"入口，封存不能绕过。

### 统一山头身份（2026-10-17 起）

山头是权限边界，**不是点位编号**。同一山头的起点、顶点、二维码共享一块留言板和一组
在任成员。旧 `points.maintainer_id`、`claims` 与协作申请只作为历史兼容/审计字段保留，
不再能绕过统一审核授予身份。旧入口 `POST /api/claims`、`POST /api/master-applications`、
旧协作申请与旧审核接口统一返回 `410 UPGRADE_REQUIRED`。

#### 目标解析

- `targetKind=existing`：传 `mountainId`（或 `pointCode`），服务端补齐稳定山头。
- `targetKind=new`：传 `newPointType`（`peak|junction`）、`newName`、`newRegion`、
  `newLocationText`，可选 `newLat/newLng/newAltitude/newIntro/newGpxRef`。
- 没有在任负责人：`intent=owner`，申请成为负责人。
- 有负责人但没有山寨：`intent=join`，提交后是 `waiting_clan` 加入意向。
- 有已成立山寨：`intent=join`，进入正式加入申请；负责人意见只是参考，平台审核后才创建成员。
- 两人竞争同一座山：先通过一人；其余申请变 `pending_confirmation`，必须申请人本人
  `confirm-join` 才继续，不能自动成为成员。

状态：`draft → pending → needs_info → approved / rejected`，另有
`withdrawn / expired / waiting_clan / pending_confirmation`。3 天只是处理目标，
到期不自动失效、不自动通过。

#### 申请与草稿

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/mountains/search?q=&cursor=&limit=` | 服务端全库检索；未审核新山头不出现 |
| `POST` | `/api/me/king-application-drafts` | 创建账号私有草稿 |
| `GET/PUT` | `/api/me/king-application-drafts/{id}` | 读取/保存草稿；PUT 带 `version` 做乐观锁 |
| `POST` | `/api/king-applications` | 提交；带 `id` 可在原申请上重新提交 |
| `GET` | `/api/me/king-applications` | 我的全部申请、草稿与状态 |
| `GET` | `/api/king-applications/{id}` | 详情；联系方式只对申请人与审核员可见 |
| `POST` | `/api/king-applications/{id}/withdraw` | 本人撤回待审/需补充/待确认申请 |
| `POST` | `/api/king-applications/{id}/resubmit` | 在需补充的原申请上再次提交 |
| `POST` | `/api/king-applications/{id}/confirm-join` | 本人确认从竞争申请转为加入 |

提交校验：为什么申请 20–1000 字、经营计划 20–2000 字、维护频率 1–30 次/月。
新山头名称、地区和准确位置必填；新山头在通过前不创建公开山头、点位、短链或二维码。
每次保存/重交保留 `king_application_versions` 快照；版本冲突返回
`409 VERSION_CONFLICT`，不会覆盖别人的修改。

#### 平台审核

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/admin/king-applications?status=` | 统一审核队列 |
| `POST` | `/api/admin/king-applications/{id}/review` | `approved|rejected|needs_info` |
| `GET` | `/api/admin/clans?status=` | 山寨组建队列 |
| `POST` | `/api/admin/clans/{id}/review` | 成立/驳回山寨 |
| `POST` | `/api/admin/cover-submissions/{id}/review` | 通过/驳回封面 |

审核说明至少 6 字；禁止自审（`SELF_REVIEW_FORBIDDEN`）。审批与授权、审计、通知在
同一事务内完成。同一山头审核使用事务级 advisory lock，再锁申请行；并发双批准只有一次
成功，另一次返回 409，数据库还有 `uq_mountain_active_owner` 唯一索引兜底。
新山头审批会一次性创建 `mountains / points / boards / short_links / claims(历史兼容)`
与负责人成员关系，任一步失败整笔回滚。

#### 我管理的留言版

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/me/managed-boards` | 按山头汇总角色、待处理留言、申请提醒、未读 |
| `GET` | `/api/me/managed-boards/{mountainId}` | 详情、隐藏留言、申请、成员、操作记录 |
| `POST` | `/api/boards/{boardId}/notices` | 负责人/成员发布置顶公告 |
| `POST` | `/api/comments/{id}/pin` | 置顶/取消置顶 |
| `POST` | `/api/points/{id}/suggestions` | 成员提交资料修改建议 |

权限每请求由后端按 `mountain_members(status='active')` 判定：负责人可编辑介绍与广告素材；
负责人和成员都可发布路况/公告、置顶、带理由隐藏；成员不能直接改他人原文、打卡记录或读私信。
退出、移除或移交后立即失效，不依赖重新登录。

#### 山寨、移交与退出

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/mountains/{id}/clan` | 山寨、成员与招募状态 |
| `POST` | `/api/mountains/{id}/clan-applications` | 负责人组建山寨，平台审核 |
| `POST` | `/api/clans/{id}/join-applications` | 提交加入申请 |
| `POST` | `/api/clan-join-applications/{id}/owner-opinion` | 负责人意见，不直接授权 |
| `POST` | `/api/clan-join-applications/{id}/review` | 平台最终通过/驳回 |
| `POST` | `/api/clans/{id}/recruiting` | 负责人暂停/重开招募 |
| `POST` | `/api/clans/{id}/leave` | 成员退出；负责人须先移交 |
| `POST` | `/api/mountains/{id}/transfer-applications` | 负责人发起移交 |
| `POST` | `/api/transfers/{id}/accept` | 接任人本人确认 |
| `POST` | `/api/transfers/{id}/decline` | 接任人本人拒绝；现任负责人不变 |
| `POST` | `/api/transfers/{id}/review` | 平台最终审核 |
| `POST` | `/api/mountains/{id}/member-removal-applications` | 负责人申请移除成员 |
| `POST` | `/api/admin/mountains/{id}/takeover` | 负责人失联时平台接管 |

山寨不另建留言板；成员共享原留言、二维码与打卡记录。移交、移除、接管都保留历史内容与二维码。

#### 路书封面

- `POST /api/routes/{slug}/cover-submissions`：`multipart/form-data`，字段 `file`、
  `photographer`、可选 `shotAt/caption`、`licenseConfirmed=true`。只收 JPEG/PNG/WebP，
  原图上限 10MB；服务端重新编码为 JPEG（最长边 1920px）并生成 640px 缩略图，
  重编码同时清除 EXIF/GPS，不接收 SVG 或任意 URL。
- 待审/驳回封面不会出现在公开路书；只有 `approved` 才返回 `coverUrl`。
- `GET /api/routes/{slug}/cover`、`GET /api/me/cover-submissions`、
  `POST /api/me/cover-submissions/{id}/withdraw`。
- `POST /api/routes/{slug}/cover-recommendations?submission_id=`：只有关联线路的
  山头在任成员可推荐；推荐不等于通过，管理员审核后才替换公开封面。
- 新封面通过时旧封面标为 `deleted` 并清理旧文件；被替换/撤回的存储键不再公开。
- 开发环境使用 `server/media/`；生产必须挂载持久化存储，本机目录不是生产方案。

### 保养作业（不是 HTTP 接口）

`server/jobs/reconcile_efforts.py`、`server/jobs/purge_visit_coordinates.py`：
重算近期成绩、清空 30 天前的原始坐标；每次运行写一行 `job_runs`（`status`: running/ok/failed）。

---

## 附：核心枚举

- `Level`：`easy | mid | hard | hidden` —— **hidden 只能人工设定，不自动产生**
- `PointType`：`peak | junction | trailhead`
- `Role`：`member | maintainer`
- `ReportReason`（举报原因）：`spam | abuse | false_info | privacy | illegal | other`
- `ReportStatus`（举报状态）：`pending | accepted | rejected`

## 2026-10-13 新模型迁移清单（待实现，不是可调用契约）

- 山峰身份独立于线路；线路与点位／路段多对多、有顺序关系。旧 `route_slug + idx` 不能作为跨线路山峰的长期唯一身份。
- 三类 board 绑定山峰、岔路和路段；完整线路引用板，不建立第四种线路板。路段明确起终点、方向及路径版本。
- 完整线路返回轨迹、长度、爬升、平均／参考用时与口径；路段返回难度、方向、登顶用时与核验信息。
- `GET /api/me/route-progress`、山头榜、关注、最近流水与评论需统一身份映射并保护历史数据；旧短链保留。
- 每板一个广告槽；广告版本审核与首屏提升分离；用户、协作者、维护人与系统操作需服务端权限验证。
- 游客打卡、游客草稿、账号合并、用户名密码注册／登录、账号草稿取回及用户明确发布接口已实现；013–015 已在当前 Docker 数据库应用，API 联测通过。新环境部署、真机/弱网及恢复测试仍待做。
- 邮箱验证、邮件找回密码、独立登出/撤销 token 尚未实现；`/api/auth/dev-login` 仅供受控开发环境，不属于正式认证。
