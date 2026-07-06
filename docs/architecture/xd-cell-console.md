# XD Cell Console

本文是 XD Cell Console 当前实现边界。历史设计和评审过程保留在 `docs/superpowers/specs/2026-06-30-xd-cell-console-*.md` 与 `docs/superpowers/plans/2026-07-01-xd-cell-console-implementation.md`，但运行态以本文、代码和测试为准。

## 产品定位

XD Cell Console 是 v2 控制台，面向站点目录、个人工作台、团队协作、站点详情和平台管理员后台。

入口：

| 环境                         | 入口                                  | 权限                                                                                                   |
| ---------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| production 首页 / 站点目录   | `https://workers.xd.team/`            | 公司网络 IP allowlist 内可访问；未登录只展示 `internal` 站点                                           |
| production 工作台            | `https://workers.xd.team/workspace/*` | 公司网络 IP allowlist + 登录用户                                                                       |
| production 管理员后台        | `https://workers.xd.team/admin/*`     | 公司网络 IP allowlist + 平台管理员                                                                     |
| staging 首页 / 工作台 / 后台 | `https://staging.workers.xd.team/*`   | 公司网络 IP allowlist + 平台管理员；auth login/callback 仅豁免 session/admin gate，不豁免 IP allowlist |

第一版不支持从网页上传并发布站点。Console 可以创建站点记录、hostname claim 和 owner 关系，但不上传 artifact、不创建 deployment；站点 artifact 发布仍通过 CLI / CI / AI / agent 等受控入口完成。`publisher` 表示可创建团队站点记录并通过这些受控入口发布站点，后续增加浏览器上传不会改变该角色语义。

第一版不新增站点标题、分类、简介概念。目录卡片使用 slug、hostname、owner、visibility 和状态 tag 展示；如果站点没有额外 metadata，不做补充字段。

## 架构

`apps/pages-console` 使用 Cloudflare Worker with Assets + 轻 BFF：

```text
Browser
  -> workers.xd.team / staging.workers.xd.team
  -> pages-console Worker with Assets
      - IP allowlist
      - browser session cookie
      - CSRF / Origin / Referer
      - staging / admin gate
      - static assets
      - /api/console/* BFF proxy
  -> service binding
      - pages-auth.internal
      - pages-api.internal
```

BFF 只负责浏览器边界和少量聚合，不保存业务真相源。用户、团队、站点、Access Key、Webhook、审计和管理员授权的真相源都在 `apps/pages-api` 的 D1-backed store；登录 code 和 SSO 交换在 `apps/pages-auth`。

前端是 React SPA，使用 `react-router-dom` 的 `BrowserRouter`。Console 内部导航使用客户端路由；登录桥接、退出和真实站点外链仍使用浏览器原生导航。Worker with Assets 继续负责深链刷新和首次 HTML 请求的 fallback，因此 `/workspace/*`、`/admin/*`、站点详情和团队详情可以直接打开。

所有 Console 流量都必须先经过 `@xd/ip-guard`：

- 页面 HTML。
- 静态 assets。
- `/login` 前端路由。
- `/api/console/auth/login` 和 `/api/console/auth/callback`。
- `/api/console/*` BFF API。

IP allowlist 不替代身份鉴权。`/workspace/*` 仍要求登录，`/admin/*` 和 staging 非 auth bridge 路径仍要求平台管理员。

## 登录、Session 与鉴权

Console 登录使用 `pages-auth` 生成一次性 console login code：

```text
1. Browser -> pages-console /api/console/auth/login
2. pages-console -> pages-auth.internal /.xd-pages/internal/console/login-code
3. pages-auth 完成 SSO 后生成 console code
4. Browser -> pages-console /api/console/auth/callback?code=...
5. pages-console -> pages-auth.internal /.xd-pages/internal/console/exchange
6. pages-auth 消费一次性 code，只返回用户身份、邮箱、员工状态、sessionVersion、environment 和 returnTo
7. pages-console 用当前 console host 签发 `purpose=console_session` 的 JWT：
   - production audience：`workers.xd.team`
   - staging audience：`staging.workers.xd.team`
8. pages-console 把 JWT 写入当前 console host 的 host-only HttpOnly cookie
```

console session cookie 属性：

```text
Name: xd_cell_session
Path: /
Max-Age: 604800
HttpOnly
Secure
SameSite=Lax
无 Domain，保持 host-only
```

cookie value 是 pages-console 使用既有 `PAGES_SESSION_JWT_*` key registry 签发的 JWT。pages-console 不维护独立 signing secret，也不会设置 `Domain=.xd.team` 共享 cookie；读取时用当前请求 hostname 校验 audience，同时校验 issuer、purpose、environment、过期时间和 HMAC 签名。

`xd_cell_session` 是单一 Console 用户 session，只表达“这个浏览器是谁”。它不是管理员 session，也不是权限真相源。Console session JWT 不依赖 pages-auth 的平台管理员判断；staging callback、`/admin/*` 和 admin API 的权限判断都必须回到 pages-api 的当前用户状态和 `platform_admins` 真相源。

Console 鉴权分两层：

1. `pages-console` Worker 处理浏览器边界：
   - 所有流量先过 host allowlist、IP allowlist。
   - 写 API 过 CSRF、Origin / Referer 校验。
   - `/workspace/*` 首次 HTML 请求要求存在有效签名 session。
   - `/admin/*` 和 staging 需要平台管理员的首次 HTML 请求，会调用 `pages-api.internal/.xd-pages/api/console/auth/session` 做一次权威校验后再决定是否返回 app shell。
   - `staging.workers.xd.team` 的登录 callback 在写入 cookie 前，会先用 pages-auth 返回的身份调用 pages-api 做平台管理员校验；非管理员不会得到 staging console session。
   - `/api/console/*` BFF API 不再固定先调用 `/auth/session`。BFF 只验证 cookie 签名并转发身份 header；production 目录 API 缺少 cookie 时可以匿名转发，缺少 cookie 的受保护 API 由 pages-api 返回 401。

2. `pages-api` 处理业务和权限真相源：
   - 只接受 host 为 `pages-api.internal` 且带 `X-Console-BFF: pages-console` 的 Console 内部请求。
   - 每个 Console 业务 endpoint 都回表校验用户存在、`employeeStatus=active`、`sessionVersion` 未过期。
   - Admin endpoint 回查 `platform_admins` 当前授权，不信任 `X-Console-Admin`。
   - Workspace、团队、站点、Access Key endpoint 按 owner、team member、site permission 和 role 判断具体权限。
   - staging BFF 会对内部 API 加 `X-Console-Require-Admin: true`，由 pages-api 在同一次业务请求里校验平台管理员。

因此旧 session 会在用户禁用、离职、`session_version` 变化、平台管理员授权变化、登出或 signing key 轮换后失效。页面层的用户菜单可以短 TTL cache `/api/console/auth/session` 结果用于体验优化，但安全边界以 pages-api 的每个业务 endpoint 为准。

### 与 CLI / Router 的鉴权差异

| 入口 | 调用方 | 凭据 | 鉴权位置 | 适用场景 |
| ---- | ------ | ---- | -------- | -------- |
| CLI public API | `xd-cell` CLI、CI、agent | `Authorization: Bearer <cli_token 或 access_key>` | `pages-api.authenticateApiRequest()` 校验 CLI token 或 Access Key，再生成 actor | 发布、创建/管理 access key、读取部署状态 |
| Console BFF API | 浏览器同源请求 `workers.xd.team/api/console/*` | host-only `xd_cell_session` cookie | `pages-console` 验 cookie 签名和浏览器安全边界，`pages-api` endpoint 回表做用户/session/角色/管理员权威校验 | 站点目录、工作台、团队、admin 后台 |
| 子站 Router | 访问 `<site>.pages.xd.team` | `__Host-pages_site_session` cookie | `pages-router` 签发并校验 host-bound site session，再校验 freshness、policyVersion、sessionVersion 和 visibility/ACL | 高频子站访问 |

`pages-auth` 是 SSO、auth session、CLI token 和一次性 handoff code 服务。子站 Router 和 Console BFF 都把 pages-auth 的一次性 code 视为登录交接材料，然后在各自 host 边界内签发并验证自己的 host-bound session。各 Worker 复用既有 `PAGES_SESSION_JWT_*` key registry，不新增 Console 专属 secret。`pages-api` public lane 和 console internal lane 分离：CLI 不能伪造 `X-Console-*` 进入 internal console API，Console 浏览器也不持有 CLI Bearer token。

## 功能导航

顶部栏：

- `XD Cell` 品牌。
- `Sites`：站点目录首页。
- `工作台`：登录后进入个人站点。
- 主题、语言、通知。
- 登录 / 用户菜单。
- 平台管理员的 `管理员后台` 入口位于用户菜单内，不作为普通用户可见的一级导航。

站点目录：

- 未登录时，在 IP allowlist 内只展示 `internal` 且 active 可访问的站点。
- 登录后展示当前用户可访问的目录内容。
- internal 站点可显示 owner；用户 owner 显示姓名/邮箱，团队 owner 显示团队名和团队类型 tag，不泄露内部 team id。

工作台：

- `个人站点`：当前用户名下站点。
- `团队站点`：当前用户所在团队的站点，支持按团队过滤。
- `团队`：团队列表与团队详情。
- `Access Keys`：用户可管理的 Personal Access Token 索引和创建入口。

不提供独立工作台首页；`/workspace` 默认进入个人站点。

团队详情：

- `成员`：团队成员和角色管理。
- `Access Keys`：Team Access Token 创建和撤销。
- `设置`：自建团队 admin 可编辑名称、描述，或删除团队；部门团队信息不可编辑。

团队详情不展示站点列表。团队站点统一在工作台的 `团队站点` 页面展示，跨团队过滤。

站点详情：

- `概览`。
- `部署记录`。
- `访问控制`。
- `运行配置`：非敏感 Vars 和 Secrets metadata；secret value 不回显。
- `设置`：站点基础信息和危险操作。删除站点必须二次确认；站点归属转移单独设计，不和普通表单保存混在一起。

## 团队与权限

团队分为自建团队和部门团队，二者都属于 `team` owner 模型。部门团队可以显示 `department` tag，名称和描述来自 XDS 部门路径，不允许团队内编辑。

SSO 登录成功后，平台可按邮箱调用 XDS 部门接口获取部门路径，并将其作为默认部门团队。部门团队自动成员首次关联时默认 `admin`，后续由团队自己调整权限。平台管理员可合并部门团队，用于处理部门名称变化导致的重复团队。

团队角色目标语义：

站点级操作必须统一按下表语义实现；新增访问控制、运行配置、删除站点或归属转移能力时，需要同步 API、CLI、Console 和测试，避免出现 CLI 与 Console 权限不一致。

| 角色        | 语义       | 权限                                                                                  |
| ----------- | ---------- | ------------------------------------------------------------------------------------- |
| `viewer`    | 只读成员   | 查看团队、团队站点、部署记录和基础配置                                                |
| `publisher` | 站点管理者 | 创建团队站点、发布和更新团队站点、管理访问控制、运行配置、删除站点、转移站点归属      |
| `admin`     | 团队管理员 | 继承 `publisher`；额外管理团队成员、角色、Team Access Token、团队设置和团队删除前盘点 |

`publisher` 是站点资产管理角色，不等同于控制台网页上传发布。第一版仍不支持从控制台上传 artifact；发布入口仍是 CLI / CI / AI / agent 等受控链路。`admin` 只表示团队治理权限，团队成员管理、角色调整、Team Access Token 创建 / 撤销、团队设置和团队删除等 admin 操作暂时只支持 Console 登录态，不通过 Access Token 暴露。

删除团队不做软删除。删除前必须盘点资产，团队名下站点需要手动删除或转移，Team Access Token 需要撤销。平台不会在删除团队时自动删除站点、route、deployment、hostname claim、KV/data 或审计记录。

## Access Keys

Access Key 目标模型按归属分为两类：

> 当前实现仍可能使用 `scopes_json` / `site_id` 等旧字段表达权限和单站点限制。后续实现多站点范围、deploy 复合归属转移和独立 transfer API 时，以本节模型为准，并保留向后兼容迁移。

- Personal Access Token，简称 PAT：从工作台 `Access Keys` 创建，`ownerType=user`，代表某个用户；权限按用户当前状态、个人资产 owner 关系和团队成员角色动态计算。
- Team Access Token，简称 TAT：从团队详情 `Access Keys` 创建，`ownerType=team`，代表某个团队；只有团队 `admin` 可创建和撤销。创建者后续离开团队不自动影响 TAT，但团队失效、Token 到期或撤销后必须失效。

site-scoped 不再作为第三种 Token 类型，而是 PAT / TAT 创建时的作用范围：

- 默认范围为 `all`：PAT 可作用于用户个人站点，以及用户在目标团队具备 `publisher` / `admin` 角色的团队站点；TAT 可作用于该团队名下站点。
- 可选范围为 `selected_sites`：只允许操作显式选择的站点。限定站点范围的 Token 不能创建新站点，也不能通过 deploy 隐式改变未选中站点的归属。

Token 权限第一版只暴露站点级能力，不暴露团队 admin 能力：

| 权限      | 语义                                                                                     |
| --------- | ---------------------------------------------------------------------------------------- |
| `read`    | 查看 Token 作用范围内的站点、部署记录和必要 metadata                                      |
| `publish` | 站点管理能力：发布、创建可管理站点、修改站点访问控制和运行配置、删除站点、转移站点归属 |

有效期创建时设置，默认 3 个月，最大 1 年。plaintext 只在创建成功时返回一次；列表、日志、审计和错误响应都不能展示 plaintext。

`publish` 可以在部署事务内复合资产变更，也可以通过独立站点归属转移接口单独执行：

- PAT 不带 `teamId` 发布新 slug 时创建个人站点；带 `teamId` 且用户在目标团队是 `publisher` / `admin` 时创建团队站点。
- TAT 发布新 slug 时创建该团队站点；如果请求显式指定 `teamId`，必须与 TAT 的 `ownerId` 一致。
- 已有站点 owner 与 deploy 请求目标 owner 不一致时，API 必须按同一套站点管理权限判断源 owner 和目标 owner；通过后可先转移归属再发布，并在 API 响应、审计和 CLI JSON 输出中明确 `fromOwner` / `toOwner`。
- PAT 可将团队站点转到个人名下，前提是用户对源团队有 `publisher` / `admin` 权限且 Token 有 `publish`。TAT 暂不支持把团队站点转给个人；该场景应由有权限的团队成员使用 PAT 或 Console 登录态执行。
- TAT 可管理本团队站点，也可在后续支持团队到团队的转移；目标团队接收规则必须显式校验，不得仅凭源团队 Token 单方面完成跨团队资产迁移。

普通建站 API 不直接对 Access Token 开放；Access Token 创建新站点只允许发生在部署事务内。团队 admin 操作不进入 Access Token 能力面，仍由 Console 登录态完成并写审计。

staging key 不能调用 production，production key 不能调用 staging。

## 管理员后台

管理员后台入口为用户菜单中的 `管理员后台`。

菜单：

- 运营：`Dashboard · 平台概览`、`Ops 运维`。
- 审核 / 管理：`用户`、`站点管理`、`团队管理`。
- 审计：`Webhook`、`审计日志`。

管理员后台只允许平台管理员访问。平台管理员可授予或撤销其他用户的平台管理员权限；权限变化会通过 session 校验立即影响 Console 管理权限。

## 出站 Webhook

Admin Webhook 是平台级出站订阅，不是 GitHub / Slack / executor callback 的入站诊断。GitHub / Slack / executor callback 的原始接收、验签和业务处理仍以 `apps/gateway` 及其 MySQL-backed store 为真相源。

Webhook 投递模型：

```text
XD Cell event
  -> 标准 payload
  -> 平台脱敏敏感字段
  -> 可选受限模板转换
  -> 投递到 webhookUrl
  -> 记录 delivery metadata
```

第一版只支持订阅 `site.deployed`。其它平台事件需要等 pages-api 真实产生并投递对应事件后再开放到 Admin Webhook 配置。

第一版不提供额外 signing secret 或 HMAC 签名。`webhookUrl` 自身按 bearer secret 处理：

- 创建后不在列表、详情、投递记录或审计中展示完整 URL。
- URL 存储使用加密密文或受控 secret 存储。
- 创建、编辑和每次投递都执行 SSRF 校验。
- 只允许 `https://`。
- 禁止 localhost、私网、link-local、metadata endpoint。
- 第一版不跟随 redirect。

受限模板是可选能力。未配置模板时投递标准 payload；配置模板后，标准 payload 先按模板转换，再投递。模板只允许引用 allowlisted 字段，输出必须是 JSON object，大小有限制，不能执行代码或读取环境变量。

## 部署边界

`apps/pages-console` 有独立 wrangler 模板：

| 环境       | Worker                  | Route                       | Service binding                           |
| ---------- | ----------------------- | --------------------------- | ----------------------------------------- |
| production | `pages-console`         | `workers.xd.team/*`         | `pages-api`、`pages-auth`                 |
| staging    | `pages-console-staging` | `staging.workers.xd.team/*` | `pages-api-staging`、`pages-auth-staging` |

Console route 是 exact host route，不能使用 `*.workers.xd.team/*`，避免抢占用户站点 wildcard。用户站点仍由 `pages-router` / `pages-router-staging` 处理。

部署要求：

- production 只允许 `workflow_dispatch` 手动触发。
- staging 可手动触发，也可由 staging 分支中 v2 相关路径变化触发。
- renderer 必须注入 `CLOUDFLARE_ACCOUNT_ID`、`IP_ALLOWLIST`、`PAGES_SESSION_JWT_ACTIVE_KID` 和 `PAGES_SESSION_JWT_KEYS`。
- `pages-console` Worker with Assets 必须设置 `assets.run_worker_first = true`，保证页面、静态资源、登录桥接和 BFF API 都先经过 IP allowlist、staging/admin gate，再由 Worker 决定是否调用 `env.ASSETS.fetch()`。
- Console 登录态复用既有 `PAGES_SESSION_JWT_*` key registry：pages-console 在自身 host 边界内签发 `purpose=console_session`、host-bound audience 的 JWT，并只保存在自身 host-only `xd_cell_session` cookie 中。
- `PAGES_SESSION_JWT_SECRET_*` 通过 Worker secret 注入，不进入 wrangler 模板、日志或文档示例；不再维护独立的 console session secret。
- production / staging 的 Worker、service binding、route、D1/KV 和 signing key 不得混用。

## 安全检查点

- `api.pages.xd.team` 公网请求即使伪造 `X-Console-*` header，也不能进入 console internal API。
- `pages-api` 只接受 host 为 `pages-api.internal` 且带 `X-Console-BFF: pages-console` 的 console BFF 请求。
- 浏览器写 API 必须通过 CSRF token 和同源 Origin / Referer 校验。
- `/workspace/*` 缺少有效 session 时跳转登录或返回 401。
- `/admin/*` 缺少 session 时跳转登录或返回 401；已登录但非平台管理员时返回 403 或展示无权限页。
- staging 非 auth bridge 路径缺少 session 时返回 401；已登录但非平台管理员时返回 403。
- secret value、Access Key plaintext、完整 Webhook URL、Cloudflare resource id、provider resource id 不得出现在列表、日志、审计导出或错误响应中。
- reserved slug / hostname 不能被用户站点创建或 claim，包括 `admin`、`workspace`、`api`、`auth`、`staging`、`workers.xd.team`、`staging.workers.xd.team`。
