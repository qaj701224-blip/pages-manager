# XD Cell 路由与访问边界

> 本文从 `docs/pages-v2-wfp-architecture.md` 拆分而来，用于控制单篇文档长度。

## 域名和路由

production 和 staging 使用显式环境域名，不通过 query、header 或同一个 API host 切环境：

| 用途               | production             | staging                        |
| ------------------ | ---------------------- | ------------------------------ |
| 控制面 API         | `api.pages.xd.team`    | `api-staging.pages.xd.team`    |
| 认证服务           | `auth.pages.xd.team`   | `auth-staging.pages.xd.team`   |
| 新建子站默认域名  | `{name}.workers.xd.team` | `{name}-staging.workers.xd.team` |
| 既有 v2 子站域名  | `{name}.pages.xd.team` | `{name}-staging.pages.xd.team` |
| 目标 WFP namespace | `xd-cell-workers-production` | `xd-cell-workers-staging`      |
| 普通 Worker slot   | `pages-v2-production-slot-*` | `pages-v2-staging-slot-*` |

长期路由目标：

```text
api.pages.xd.team/*             -> pages-api
auth.pages.xd.team/*            -> pages-auth
api-staging.pages.xd.team/*     -> pages-api-staging
auth-staging.pages.xd.team/*    -> pages-auth-staging
*-staging.pages.xd.team/*       -> pages-router-staging
*.pages.xd.team/*               -> pages-router
*-staging.workers.xd.team/*     -> pages-router-staging
*.workers.xd.team/*             -> pages-router
```

v1 legacy 仍通过每个站点的 exact route 服务 `{name}.workers.xd.team/*`。v2 只绑定 workers wildcard fallback，不手工创建每个 v2 站点的 workers exact route；Cloudflare route specificity 必须保证 v1 exact route 优先于 v2 wildcard。v2 部署必须继续保留 `*.pages.xd.team/*`，用于存量 v2 `pages.xd.team` 站点。

需要确认 Cloudflare 侧 wildcard route / custom domain 绑定策略：

- `pages-router` 需要稳定接收 production `*.pages.xd.team` 和 `*.workers.xd.team` 子站。
- `pages-router-staging` 需要稳定接收 `*-staging.pages.xd.team` 和 `*-staging.workers.xd.team`。
- `api.pages.xd.team`、`auth.pages.xd.team`、`api-staging.pages.xd.team`、`auth-staging.pages.xd.team` 以及 workers family 下的平台保留 host 都不能被用户站点占用。
- 平台保留路径使用 `/.xd-pages/*`，避免与用户站点业务路径冲突。

router 必须根据 hostname 推导环境，并校验 route record：

```text
foo.pages.xd.team          -> environment=production
foo.workers.xd.team        -> environment=production
foo-staging.pages.xd.team  -> environment=staging
foo-staging.workers.xd.team -> environment=staging
```

环境推导结果必须与 `site_routes.environment`、execution provider、dispatch target、D1/DO/KV binding 和 signing key 一致，不一致时 fail closed。

如果 Cloudflare route 层无法优雅拆分 `*-staging.pages.xd.team` 与普通 production 子站，可以先使用 `pages-edge-router-thin` 作为统一入口，再通过 service binding 转发到环境专属 router。禁止让一个业务 router 同时绑定 production 和 staging 的 D1/DO/KV、dispatch namespace、slot binding 或 signing key。

`pages-edge-router-thin` 的 hostname 分流必须使用显式 allowlist 和严格 parser：

| host pattern                                  | target                               |
| --------------------------------------------- | ------------------------------------ |
| `api.pages.xd.team` / `auth.pages.xd.team`    | fail closed，应该由 exact route 处理 |
| `api-staging.pages.xd.team` / `auth-staging.pages.xd.team` | fail closed，应该由 exact route 处理 |
| workers family 平台保留 host                  | fail closed，应该由 exact route 或 v1 处理 |
| `{slug}-staging.pages.xd.team` / `{slug}-staging.workers.xd.team` | `pages-router-staging` |
| `{slug}.pages.xd.team` / `{slug}.workers.xd.team` | `pages-router`                    |
| 保留 slug、非法 host、非受信后缀              | fail closed                          |

thin router 不能根据 query、header、cookie 或用户输入切环境。

## 系统命名空间、保留路径与门禁

v2 必须统一系统 API、认证 API、子站访问、平台 callback、runtime endpoint 和用户 Worker 路由的边界。原则是：

```text
平台 host 不能被用户站点占用。
平台路径先由 pages-router / pages-auth 处理，不能默认 dispatch 到 User Worker。
系统 API 按风险分级门禁。
User Worker 永远不可信，入站/出站 header 与 cookie 必须清洗。
```

### 保留 Host 与站点名

以下 host 为平台保留：

```text
api.pages.xd.team
api-staging.pages.xd.team
auth.pages.xd.team
auth-staging.pages.xd.team
admin.pages.xd.team
admin-staging.pages.xd.team
router.pages.xd.team
router-staging.pages.xd.team
kv-gateway.pages.xd.team
kv-gateway-staging.pages.xd.team
api.workers.xd.team
api-staging.workers.xd.team
auth.workers.xd.team
auth-staging.workers.xd.team
router.workers.xd.team
router-staging.workers.xd.team
kv-gateway.workers.xd.team
kv-gateway-staging.workers.xd.team
*.internal.pages.xd.team
```

以下 slug 也应作为站点名保留字，production 和 staging 都不能注册：

```text
api
api-staging
auth
auth-staging
admin
admin-staging
manager
manager-staging
router
router-staging
kv-gateway
kv-gateway-staging
pages
login
logout
callback
oauth
sso
internal
```

production 还应保留 `-staging` 后缀，避免用户创建看起来像 staging 的 production 站点，例如 `foo-staging.workers.xd.team`。保留名校验应在 `pages-api` 的创建和重命名路径统一执行，不能只放在 CLI。

### 保留路径

所有平台路径统一放在 `/.xd-pages/` 下：

```text
/.xd-pages/auth/login
/.xd-pages/auth/callback
/.xd-pages/auth/logout
/.xd-pages/runtime/*
/.xd-pages/api/*
/.xd-pages/health
/.xd-pages/metadata
```

`pages-router` 收到 `/.xd-pages/*` 时必须先进入平台路由，默认不 dispatch 到 User Worker。允许 dispatch 的例外必须显式列在代码和测试中，例如某个 generated runtime adapter。

用户站点业务路径不要使用 `/.xd-pages/`。如果用户上传静态文件或 Worker 路由占用该前缀，平台路径优先。

### Canonical Endpoint Map

系统 API 和平台 callback 使用固定 host + 固定路径，避免 CLI、router 和 v1 文档各自发明路径：

| host                         | endpoint                     | 用途                        | 公开性                         |
| ---------------------------- | ---------------------------- | --------------------------- | ------------------------------ |
| `api.pages.xd.team`          | `/skill.md`、`/readme.md`    | agent / 用户文档            | public-docs                    |
| `api.pages.xd.team`          | `/.xd-pages/api/session`     | 浏览器态 API session 换发   | auth-flow，需 auth 一次性 code |
| `api.pages.xd.team`          | `/.xd-pages/api/sites`       | 站点列表和管理              | user-api                       |
| `api.pages.xd.team`          | `/.xd-pages/api/deployments` | 发布、版本、回滚            | deploy-api                     |
| `api.pages.xd.team`          | `/.xd-pages/api/access-keys` | access key 创建、吊销       | user-api，创建/查看需 recent   |
| `api.pages.xd.team`          | `/.xd-pages/api/admin/*`     | 审计、管理员操作            | admin-api                      |
| `auth.pages.xd.team`         | `/.xd-pages/auth/login`      | 浏览器登录入口              | auth-flow                      |
| `auth.pages.xd.team`         | `/.xd-pages/auth/callback`   | SSO OAuth callback          | auth-flow                      |
| `auth.pages.xd.team`         | `/.xd-pages/auth/logout`     | 平台登出                    | auth-flow                      |
| `auth.pages.xd.team`         | `/.xd-pages/cli/login/start` | CLI login transaction 创建  | auth-flow                      |
| `auth.pages.xd.team`         | `/.xd-pages/cli/login/poll`  | CLI login 轮询              | auth-flow，需 login secret     |
| `{slug}.workers.xd.team` / `{slug}.pages.xd.team` | `/.xd-pages/auth/callback`   | 子站 site_session 补发      | auth-flow，由 router 处理      |
| `{slug}.workers.xd.team` / `{slug}.pages.xd.team` | `/.xd-pages/runtime/*`       | generated runtime / SDK API | subsite runtime，平台优先      |
| `api-staging.pages.xd.team`  | 同 production API path       | staging API                 | 只能返回 staging 环境配置      |
| `auth-staging.pages.xd.team` | 同 production auth path      | staging auth                | 只能使用 staging SSO redirect  |

v2 CLI 只使用 `/.xd-pages/api/*`。开发期 API 合约源码位于 `apps/pages-api/src/openapi.js`，不作为 public route 暴露。`/deploy`、`/list`、`/site` 等路径属于 v1 `api.workers.xd.team`，不在 v2 `api.pages.xd.team` 上兼容或转发。

浏览器访问 `api.pages.xd.team` 时收不到 `auth.pages.xd.team` 的 `__Host-pages_auth_session`。因此 API host 不直接使用 `auth_session` cookie：

- CLI 和 CI 调 API 使用 `Authorization: Bearer <cli_token/access_key>`。
- 未来管理 UI 如需浏览器态 API，先由 `auth.pages.xd.team` 通过一次性 code / service binding 换发 `api.pages.xd.team` 下的 host-only `__Host-pages_api_session`。
- `api_session` 必须 `Secure; HttpOnly; SameSite=Lax; Path=/`，并配套 Origin / Referer allowlist、CSRF token、CORS fail-closed。
- 禁止为了让 API 收到登录态而把平台 session 改成 `.pages.xd.team` 父域 cookie。

### API 门禁等级

系统 API 按等级处理：

| 等级           | 示例                                                            | 认证                                    | 额外要求                                                                       |
| -------------- | --------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| `public-docs`  | `/skill.md`、`/readme.md`、`/.xd-pages/health` | 无                                      | 只返回非敏感配置，不能暴露 secret、token、内部资源 id，不能返回串环境 API 地址 |
| `auth-flow`    | `/.xd-pages/auth/*`、`/.xd-pages/cli/login/*`                   | SSO state / auth_session / login secret | redirect allowlist、CSRF state、一次性 code、poll/consume 限流                 |
| `user-api`     | `/.xd-pages/api/sites`、`/.xd-pages/api/access-keys`            | CLI token、access key 或 api_session    | scope + owner/collaborator 校验                                                |
| `deploy-api`   | `/.xd-pages/api/deployments`、`/.xd-pages/api/versions`         | CLI token 或 access key                 | scope、site 权限、payload 限制、idempotency、审计                              |
| `admin-api`    | `/.xd-pages/api/admin/*`、`/.xd-pages/api/audit/*`              | admin session                           | recent login、管理员角色、强审计                                               |
| `internal-api` | service binding only                                            | service binding 或内部签名              | 不暴露公网路由                                                                 |

`public-docs` 端点必须根据请求 host 动态生成环境相关地址。`api-staging.pages.xd.team/skill.md` 和 `/readme.md` 只能返回 staging API、auth 和子站域名示例；production 端点只能返回 production 地址。

v2 发布 API 不能依赖 `X-Pages-Token`。`X-Pages-Token` 只属于 v1 归属标记，不进入 v2 鉴权模型。

access key 的建站边界收口在 `deploy-api`。以下为目标安全边界，尚未完全落地的能力必须在实现时补齐
权限测试和审计测试。Access Token 分为 PAT（Personal Access Token）和
TAT（Team Access Token）；站点限定只是 Token 的作用范围。PAT 带 `teamId` 时必须重新校验 Token
所属用户当前是否为该团队 `publisher` / `admin`，TAT 带 `teamId` 时必须与 Token 归属团队一致。
限定站点范围的 Token 只能部署选中的站点，不能创建新站点。`deploy-api` 可以在同一事务内完成
“归属转移 + 发布”，但必须同时校验源 owner 和目标 owner 的站点管理权限，并写审计。`user-api`
的普通建站 endpoint 不接受 access key；团队成员、角色、Team Access Token、团队设置和团队删除等
admin 操作不通过 access key 暴露。

### Router IP Allowlist

站点网络范围由 route snapshot 的 `exposure` 决定：`internal` 继续受公司网络 IP allowlist 保护，只有可信的 schema v3 snapshot 显式声明 `exposure=public` 时才允许从公网继续访问。旧 v2 snapshot、字段缺失或非法 exposure 一律按 `internal` 处理，不能绕过 IP 门禁。

执行顺序：

```text
1. 校验 environment、hostname 和平台保留路径。
2. 读取并验证 route pointer / snapshot，只解析决定网络范围所需的可信策略。
3. schema v3 且 exposure=public：跳过公司网络 IP allowlist；其它情况必须命中当前环境 allowlist。
4. 通过网络范围判断后，再校验 route 可用性、accessMode、SSO/ACL 和 dispatch target。
5. snapshot 缺失、损坏、版本未知或 accessMode 非法时 fail closed，不 dispatch 到 User Worker。
```

IP allowlist 规则：

- production 和 staging 使用独立 allowlist 配置，可以相同但必须显式配置，不能共享隐式默认值。
- allowlist 来源应是 Worker runtime `vars` 或配置快照，例如 `ROUTER_IP_ALLOWLIST_CIDRS`，不能由用户站点或 `--config` 控制。
- 需要正确解析 Cloudflare 提供的客户端 IP；如果请求不经过 Cloudflare 标准链路或无法可信取得客户端 IP，必须 fail closed。
- allowlist 变更属于高风险操作，需要审计、配置校验和快速回滚。
- legacy `visibility=internal` 表示匿名/免登录 access mode，不再承担网络范围语义；互联网是否可达只看 Admin 管理的 exposure。
- Platform Admin 开启 public 时必须填写理由并确认，平台先移除并验证当前 Worker 不含 `XD_OFFICE_NET`，再提交 D1 policy 和 route snapshot。
- 当前阶段 Admin exposure 变更不要求 recent login；关闭 public 只恢复 Router IP 门禁，不立即恢复 `XD_OFFICE_NET`，后续 internal 完整部署才会重新注入。

### 子站访问门禁

子站访问由 `pages-router` 根据 route snapshot 和必要的 strict check 决策：

| exposure | 网络范围 |
| -------- | -------- |
| `internal` | 仅公司内网、VPN、办公出口或明确允许的公司代理出口可达 |
| `public` | 互联网可达；仍继续执行 accessMode、SSO、ACL 和 disabled 判断 |

外部 CLI/API 继续使用 visibility，Router 内部按以下兼容映射执行 accessMode：

| visibility | accessMode | router 行为 |
| ---------- | ---------- | ----------- |
| `internal` | `anonymous` | 在允许的网络范围内免登录访问 |
| `org` | `org` | 需要有效 `site_session`，且用户 employee status 为 active；没有时走 SSO |
| `acl` | `acl` | 需要有效 `site_session`，并命中 allow-only 邮箱或部门 ACL；active owner 隐式可访问 |
| `owner` | `owner` | 需要 active owner 身份 |
| `disabled` | `disabled` | 直接拒绝，不 dispatch 到 User Worker |

router 必须先处理网络范围和身份门禁，再 dispatch 到 User Worker。User Worker 不能自行决定是否绕过平台门禁。未知 visibility，包括旧的 public，必须 fail closed；schema v3 accessMode 缺失、非法或与 visibility 投影不一致也必须 fail closed。

推荐判定顺序：

```text
if exposure != public and request IP not in allowlist:
  deny

if accessMode == disabled:
  deny

if accessMode == anonymous:
  allow anonymous

require site_session
require employeeStatus == active

if userId == ownerUserId:
  allow

if accessMode == org:
  allow

if accessMode == owner:
  deny non-owner

if accessMode == acl:
  allow if any ACL email or department path entry matches

otherwise:
  deny
```

`org`、`acl` 和 `owner` 都不是“只要登录过就永久可访问”。签发或刷新 `site_session` 时必须确认用户仍是允许访问的人：

- `employee_status=active` 才能访问 `org` 站点。
- `employee_status=unknown`、`disabled`、`left` 默认拒绝，或进入 strict 校验后仍不能确认则拒绝。
- SSO profile 的原始状态必须映射为规范值；未知原始值必须映射为 `unknown`，不能因为字段非空就当作 active。
- 受保护站点需要 profile freshness。推荐 `org` / `acl` / `owner` 的 SSO profile freshness 不超过 15 分钟；超过 freshness 时必须重新查 SSO profile、刷新本地 user 状态，或拒绝访问。
- 用户禁用、离职、管理员踢下线、SSO profile 显示状态变化时，必须 bump `user.sessionVersion`，并让旧 `auth_session` / `site_session` 在可接受窗口内失效。
- 推荐受保护站点的 user status 快路径缓存 TTL 为 5-15 分钟；高风险站点或 `strict` 事件直接查 `UserSessionDO` / D1。

离职/禁用状态发现机制至少要有一种：

- SSO / 组织系统 webhook 主动通知并批量 bump `sessionVersion`。
- 定时同步员工状态，发现变更后吊销 session。
- 每次登录、session 刷新和 profile freshness 过期时强制重查 SSO profile。

如果三种都不可用，`org` 可见性不能宣称接近实时吊销，只能按 profile freshness SLA 管理风险。

### Header 与 Cookie 保留区

入站 dispatch 前，`pages-router` 必须删除浏览器或上游伪造的保留 header：

```text
CF-Platform-*
X-Pages-*
X-XD-Pages-*
```

同时必须重写传给 User Worker 的 `Cookie` header，删除所有平台保留 cookie：

```text
__Host-pages_*
__Secure-pages_*
```

`__Host-pages_site_session` 与未来的其它平台 session/capability cookie 只能由 router 自己消费，不能被 dispatch 给 User Worker。用户业务 cookie 可以保留，但如果解析失败、重复 cookie 名冲突或命中平台保留前缀，必须 fail closed 或删除可疑项并记录安全审计。

然后由 router 注入新的可信 header：

```text
CF-Platform-Auth
CF-Platform-User
CF-Platform-Email
CF-Platform-Site-Id
CF-Platform-Site-Slug
CF-Platform-Version
CF-Platform-Trace-Id
```

User Worker 响应返回后，router 必须删除或覆盖平台保留 cookie/header：

```text
Set-Cookie: __Host-pages_*
Set-Cookie: __Secure-pages_*
CF-Platform-*
X-Pages-*
X-XD-Pages-*
```

router 还必须解析 User Worker 返回的所有 `Set-Cookie`：

- 默认只允许 host-only cookie。
- 拒绝或删除任何 `Domain=.pages.xd.team`、`Domain=pages.xd.team`、平台保留 host、跨环境 host 或其它父域 cookie。
- 拒绝用户 Worker 设置 `__Host-pages_*`、`__Secure-pages_*`、`CF-Platform-*`、`X-Pages-*` 相关保留 cookie/header。

这样可以防止不可信 User Worker 覆盖平台 session、伪造身份、污染 sibling 子站或污染下游审计。

### Callback 与 Redirect 防护

所有登录和回调流程都必须防 open redirect：

- `return_to` 只能是当前站点 host 或平台 allowlist host。
- `state` 必须由平台生成，绑定 `return_to`、site host、过期时间和一次性消费状态。
- OAuth callback 只能消费一次，过期后必须重新开始登录。
- callback 成功后跳回 `/.xd-pages/auth/callback`，再由 router 302 到原始路径。
- SSO `access_token`、refresh token、平台 session 和 CLI token 永远不能进入 URL、fragment、query、Referer 或浏览器可持久化存储。
- OAuth code 只允许出现在 SSO callback query 中，必须短 TTL、一次性消费，并在日志、错误上报和追踪系统中脱敏。
- token exchange 优先使用服务端 POST；如果 SSO 接口只能 GET，服务端必须禁止记录完整 URL/query，并对 `code`、`client_secret`、`access_token` 等参数做强脱敏。

### Rate Limit 与 Payload Limit

门禁还应包含基础滥用防护：

- `auth-flow`：限制同 IP / 同 user 的登录启动和 callback 失败次数。
- `deploy-api`：限制上传体积、文件数量、单文件大小、并发部署数。
- `user-api`：限制 access key 创建、删除、ACL 修改频率。
- `subsite`：按站点和用户做可选访问限流，避免单站影响平台。

限流状态可以按风险选择 Durable Objects、D1 记录或边缘缓存；高风险管理操作必须可审计。
