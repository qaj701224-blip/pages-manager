# XD Cell 资源与部署

> 本文从 `docs/pages-v2-wfp-architecture.md` 拆分而来，用于控制单篇文档长度。

## Cloudflare 资源模型

### production

```text
pages-api
pages-auth
pages-router
pages-kv-gateway
target WFP dispatch namespace: xd-cell-workers-production
normal Worker slot pool: pages-v2-production-slot-001..N
D1 authority: production pages metadata
Durable Objects: production auth/session coordination
KV/cache: production router snapshots
audit store: production audit
system API: api.pages.xd.team
system auth: auth.pages.xd.team
default site domain: {name}.workers.xd.team
legacy v2 site domain: {name}.pages.xd.team
site data KV: pages-shared-data
```

### staging

```text
pages-api-staging
pages-auth-staging
pages-router-staging
pages-kv-gateway-staging
target WFP dispatch namespace: xd-cell-workers-staging
normal Worker slot pool: pages-v2-staging-slot-001..N
D1 authority: staging pages metadata
Durable Objects: staging auth/session coordination
KV/cache: staging router snapshots
audit store: staging audit
system API: api-staging.pages.xd.team
system auth: auth-staging.pages.xd.team
default site domain: {name}-staging.workers.xd.team
legacy v2 site domain: {name}-staging.pages.xd.team
site data KV: pages-shared-data-staging
```

staging 与 production 必须继续物理隔离：

- 不同 Worker 名称。
- 不同 WFP dispatch namespace。
- 不同普通 Worker slot 池和 service binding。
- 不同 KV/D1/R2。
- 不同 signing key。
- 不同 SSO redirect URI。
- Cloudflare 和 ECS runtime production 不允许 push/PR 自动部署；ECS runtime 手动部署边界见 `docs/operations/ecs-manual-deploy.md`。

默认路由方案也必须物理隔离：

```text
api.pages.xd.team/*             -> pages-api
auth.pages.xd.team/*            -> pages-auth
api-staging.pages.xd.team/*     -> pages-api-staging
auth-staging.pages.xd.team/*    -> pages-auth-staging
*.pages.xd.team/*               -> pages-router
*-staging.pages.xd.team/*       -> pages-router-staging
*.workers.xd.team/*             -> pages-router
*-staging.workers.xd.team/*     -> pages-router-staging
```

`pages-router` 只能绑定 production D1/KV/DO、production WFP dispatch namespace、production slot service binding 和 production signing key；`pages-router-staging` 只能绑定 staging 资源。业务 router 不允许同时持有两套环境的权威存储、dispatch namespace、slot binding 或 signing secret。

## 资源申请与环境配置

v2 上线前需要把 Cloudflare 资源、心动 SSO 应用和 GitHub Actions 配置一次性梳理清楚。文档、代码和 CI 中只能出现占位名称，不能写真实 account id、zone id、namespace id、client secret 或 token。

WFP 是最终执行面目标；router template 始终静态声明当前环境的 WFP dispatch namespace binding。`PAGES_EXECUTION_MODE` 是平台内部历史执行面开关，当前 production / staging 都固定为 `wfp`。普通 Worker slot 兼容层只维护存量 active route，不再扩容：用户 CLI、`--config`、AI skill 和 deploy API 都不暴露 execution provider 或 runtime 选择参数。

`pages-kv-gateway`、`pages-kv-gateway-staging`、`pages-shared-data`、`pages-shared-data-staging` 原先只是 v1 预留；确认未投入使用且 KV key count 为 0 后，直接划归 v2。v1 `workers.xd.team` 不再提供 Pages KV，`apps/server` 不签发 KV capability，也不在 v1 deploy workflow 中部署 gateway。

### Cloudflare 资源申请清单

production 和 staging 分开申请或创建：

| 类型                       | production                                                                            | staging                                                                                                               | 说明                                                                                                       |
| -------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| Workers                    | `pages-api`、`pages-auth`、`pages-router`、`pages-kv-gateway`                         | `pages-api-staging`、`pages-auth-staging`、`pages-router-staging`、`pages-kv-gateway-staging`                         | 系统 Worker 物理隔离                                                                                       |
| WFP dispatch namespace     | `xd-cell-workers-production`                                                          | `xd-cell-workers-staging`                                                                                             | 当前默认执行面；router 静态绑定对应环境 namespace                                                          |
| 普通 Worker slot 池        | `pages-v2-production-slot-001..N`                                                     | `pages-v2-staging-slot-001..N`                                                                                        | 历史兼容执行面，只保留旧 route 排空和管理员删除                                                            |
| D1 database                | `pages_metadata_production`                                                           | `pages_metadata_staging`                                                                                              | 权威业务库                                                                                                 |
| KV namespace               | `pages_router_cache_production`                                                       | `pages_router_cache_staging`                                                                                          | route/policy/JWKS snapshot                                                                                 |
| KV namespace               | `pages-shared-data`                                                                   | `pages-shared-data-staging`                                                                                           | v2 Pages KV 站点数据；现有空 namespace 直接划归 v2                                                         |
| Durable Object namespaces  | production bindings                                                                   | staging bindings                                                                                                      | OAuth、CLI login、session、policy 协调                                                                     |
| Routes / custom domains    | `api.pages.xd.team`、`auth.pages.xd.team`、`*.workers.xd.team/*`、`*.pages.xd.team/*` | `api-staging.pages.xd.team`、`auth-staging.pages.xd.team`、`*-staging.workers.xd.team/*`、`*-staging.pages.xd.team/*` | 由 v2 wrangler template 声明，部署创建/更新 Cloudflare 绑定；`workers` wildcard 必须让 v1 exact route 优先 |
| Advanced certificate / DCV | `*.workers.xd.team`、`*.pages.xd.team`                                                | 同证书覆盖或独立策略                                                                                                  | 参考 partial zone 约束，单独验证 `workers` 与 `pages` 子域                                                 |

需要在阶段 0 做 Cloudflare route / DNS / certificate spike，验证 `workers` / `pages` wildcard、DCV、`*-staging.workers.xd.team/*` 和 `*-staging.pages.xd.team/*` route 优先级。API/Auth 固定域名和 router wildcard route 写入 v2 wrangler template，系统 Worker 部署时创建/更新 Cloudflare 绑定；partial zone 下 DNSPod CNAME、DCV 委派和证书状态仍需人工确认。新增 `*.workers.xd.team/*` v2 wildcard 时，必须确认 v1 exact route 仍优先。

如果 Cloudflare route 层无法独立匹配 staging 子站，fallback 只能是一个无业务 secret 的 `pages-edge-router-thin`：

```text
*.workers.xd.team/* -> pages-edge-router-thin
  foo.workers.xd.team         -> service binding: pages-router
  foo-staging.workers.xd.team -> service binding: pages-router-staging
*.pages.xd.team/* -> pages-edge-router-thin
  foo.pages.xd.team           -> service binding: pages-router
  foo-staging.pages.xd.team   -> service binding: pages-router-staging
```

`pages-edge-router-thin` 只做 hostname 解析和 service binding 转发，不持有 D1/KV/DO、dispatch namespace、slot binding、session/internal signing key、Cloudflare API token 或 SSO secret。它的 L1 cache 只能缓存“hostname -> target service”这类非敏感分流结果，且 production/staging target 必须有 fail-closed 测试覆盖。

### Execution Mode 与普通 Worker slot 兼容层

平台内部支持两种 execution mode：

| mode                 | 用途                                                                              | 用户可见性 | 上线建议                      |
| -------------------- | --------------------------------------------------------------------------------- | ---------- | ----------------------------- |
| `wfp`                | 目标模式，部署到 Workers for Platforms dispatch namespace                         | 不可见     | production / staging 当前默认 |
| `normal-worker-slot` | 兼容模式，部署到预创建普通 Worker slot，并由 router 通过静态 service binding 调用 | 不可见     | 仅用于历史 route 排空         |

唯一核心开关是 wrangler template 中随 Git 提交的运行时 var：

```text
PAGES_EXECUTION_MODE=wfp
```

router template 同时固定声明当前环境的 `PAGES_DISPATCH` binding。`normal-worker-slot` 已进入 legacy drain：平台不再扩容普通 Worker slot，也不再把新的发布或 rollback 写回 slot 执行面。

```text
production:
  PAGES_NORMAL_WORKER_SLOT_MIN_AVAILABLE=1
  PAGES_NORMAL_WORKER_SLOT_EXPAND_BY=2

staging:
  PAGES_NORMAL_WORKER_SLOT_MIN_AVAILABLE=20
  PAGES_NORMAL_WORKER_SLOT_EXPAND_BY=20

PAGES_NORMAL_WORKER_SLOT_MAX_TOTAL=100
PAGES_NORMAL_WORKER_SLOT_CLEANUP_RETENTION_SECONDS=0
```

这些值不是用户发布参数，也不是 GitHub Environment Var；保留它们只用于历史兼容和测试。部署脚本 `scripts/provision-pages-v2-slots.mjs <environment> bindings` 会在 router 部署前读取 D1 `site_routes`，只输出当前 active legacy route 仍需要的 `PAGES_NORMAL_WORKER_SLOT_BINDINGS_JSON`。`scripts/render-pages-v2-wrangler.mjs` 据此渲染稀疏 service binding 列表，不再按 `max(worker_slots.slot_number)` 连续绑定 `SITE_SLOT_001..N`。没有 active legacy route 时，router wrangler 不生成任何 `SITE_SLOT_*` binding。

`PAGES_EXECUTION_MODE` 不放 GitHub Environment Vars；当前 production / staging 默认值直接以 `wfp` 写在 `apps/pages-api/wrangler.*.template.toml` 和 `apps/pages-router/wrangler.*.template.toml`。站点级 `execution_mode_override=normal-worker-slot` 不再影响新的发布，存量站点重新 deploy 也进入 WFP。router 的 WFP dispatch namespace binding 不由这个 mode 动态生成，而是随 production / staging template 静态配置。只要仍有 active route 指向 `service-binding` slot，部署脚本必须继续提供该 route 对应的显式 service binding；空闲 Worker 不再被绑定，管理员可在 Console 删除。

不建议再增加 `DEFAULT_EXECUTION_PROVIDER`、`ALLOWED_EXECUTION_PROVIDERS`、`NORMAL_WORKER_NEW_DEPLOY_ENABLED` 这类组合开关。原因是这些开关会把“默认值、允许值、是否新建普通 Worker”拆成多个状态，容易出现互相矛盾的配置。第一版用一个 mode 表达平台当前策略；更细粒度的灰度或站点例外写入 D1 权威表，由管理员 API 或后台任务管理，不暴露给普通用户。

执行模式选择规则：

```text
effectiveMode =
  site.execution_mode_override === "wfp"
    ? "wfp"
    : env.PAGES_EXECUTION_MODE
```

`site.execution_mode_override` 保留为历史数据字段；新的发布只接受 `wfp` 作为有效执行面。普通用户 `xd-cell deploy` 不允许指定 provider；CLI help、`--config`、OpenAPI 和 AI skill 都只描述“发布到 XD Cell”，不描述 WFP、slot、dispatch namespace 或 service binding。

slot 兼容层不是用户可选 provider，它只是历史 route 排空手段。

#### normal-worker-slot 设计

普通 Worker slot 池是 WFP 切换前留下的兼容执行面，只用于继续服务尚未排空的旧 active route：

```text
SITE_SLOT_001 -> pages-v2-production-slot-001
SITE_SLOT_002 -> pages-v2-production-slot-002
...
```

staging 使用独立命名，例如：

```text
SITE_SLOT_001 -> pages-v2-staging-slot-001
```

新的发布和 rollback 不再分配普通 Worker slot。存量 slot route 的访问仍由 router 通过 route snapshot 中的 `dispatch.bindingName` 调用静态 service binding。存量站点重新发布后会切到 WFP；normal-slot 历史版本不可作为 rollback 目标。

空闲 ordinary Worker 由 Admin Console 的 `Legacy Normal Workers` 页面管理。删除前必须确认 D1 active route 没有引用该 `slot_id` 或 `active_version_id`；删除成功后 D1 `worker_slots.status` 标记为 `retired`，不删除历史 row。当前 workflow 只保留只读审计：

```text
scripts/provision-pages-v2-slots.mjs <environment> bindings
```

如果 Cloudflare 因当前 router 配置中仍存在 service binding 而拒绝删除 Worker，管理员应等待下一次手动 router deploy 移除空闲 binding 后重试；这不影响 router，因为只有 active route 会访问对应 binding。

slot 状态由 D1 权威表管理：

| 状态                       | 含义                                                                     | 是否可分配 |
| -------------------------- | ------------------------------------------------------------------------ | ---------- |
| `provisioning`             | 历史扩容流程正在创建普通 Worker                                          | 否         |
| `available_pending_router` | Worker 已创建，但 router 尚未部署包含对应 service binding 的版本         | 否         |
| `available`                | Worker 和 router binding 均就绪                                          | 是         |
| `assigned`                 | 已被某个站点版本占用，通常是 active 版本；非 active 旧版本会尽快进入清理 | 否         |
| `disabled`                 | 手动停用或健康检查失败                                                   | 否         |
| `cleanup_pending`          | 站点删除后等待清理或保留期结束                                           | 否         |
| `delete_pending`           | Cloudflare 删除受当前绑定关系阻挡，等待下一次 router deploy 后重试       | 否         |
| `retired`                  | 已由管理员删除或退役，保留审计记录                                       | 否         |

`pages-api` 不再为新的部署分配 `available` slot。`available` 只表示历史 Worker 仍存在且当前没有 active route 引用，可由管理员删除。

router deploy 只计算 active legacy route binding，不创建新的普通 Worker：

```text
XD Cell deploy workflow <environment>
  1. 执行 D1 migration，确保 worker_slots 表存在。
  2. scripts/provision-pages-v2-slots.mjs <environment> bindings
     - 读取 active `service-binding` route。
     - 输出 PAGES_NORMAL_WORKER_SLOT_BINDINGS_JSON=[{bindingName, workerName}]。
  3. render-pages-v2-wrangler.mjs 用显式列表渲染 active route 需要的 SITE_SLOT_*。
  4. 部署对应环境 router，并注入 router secrets。
```

`expand-pages-router-slots.yml` 已改为只读 legacy normal worker audit workflow。它可以生成 router wrangler artifact 供人工检查，但不得创建、清理、删除或部署 Cloudflare Worker。

普通 Worker slot 与 WFP 的主要差别只在执行面 dispatch：

- WFP：`pages-router` 通过 dispatch namespace 按 user Worker name 获取执行目标。
- slot：`pages-router` 通过 route snapshot 中的 `dispatch.bindingName` 调静态 service binding。

其它架构保持一致：SSO、ACL、route snapshot、KV gateway capability、审计、header/cookie 清洗和发布状态机都走同一套平台逻辑。当前新增站点和存量站点重新发布都使用 `wfp`；router 只为仍 active 的 legacy slot route 保留 service binding。

### 心动 SSO 应用配置

production 和 staging 使用独立 SSO 应用，至少也要使用两组独立 redirect URI。OAuth 入口和 callback 都应落到 `pages-auth`，不能落到 `pages-api`，否则控制面会被迫持有 SSO client secret 和 session signing secret。

```text
production app:
  应用名称：xd_pages
  用户访问入口：https://auth.pages.xd.team/.xd-pages/auth/authorize
  SSO认证重定向地址：https://auth.pages.xd.team/.xd-pages/auth/callback

staging app:
  应用名称：xd_pages_staging
  用户访问入口：https://auth-staging.pages.xd.team/.xd-pages/auth/authorize
  SSO认证重定向地址：https://auth-staging.pages.xd.team/.xd-pages/auth/callback
```

本地开发可使用单独的 local SSO 应用，但这是开发保留项，不属于用户侧 CLI 环境列表：

```text
local app:
  应用名称：xd_pages_local
  用户访问入口：http://xd-pages.127.0.0.1.nip.io:8787/.xd-pages/auth/authorize
  SSO认证重定向地址：http://xd-pages.127.0.0.1.nip.io:8787/.xd-pages/auth/callback
```

local SSO 的 `SSO_CLIENT_ID` 和 `SSO_CLIENT_SECRET` 只能放本地 ignored env，例如当前仓库已忽略的 `.env`、`.dev.vars`，或只放 shell 环境变量；不得写入本文档、Git、CLI config、`--config` 文件或测试快照。若使用 `.env.local`、`.dev.vars.local` 等新文件名，必须先确认它们已被 `.gitignore` 覆盖。若本地调试凭证曾被公开粘贴到 issue、PR、聊天记录或日志，应按公司规范轮换。

本地联调可以先使用公司分配的 OAuth local app。建议只在本机 shell 或已被 `.gitignore` 覆盖的 `.dev.vars` 中配置真实值；CLI 用户侧 `xd-cell env list` 不展示 local：

```bash
export PAGES_ENV=local
export PUBLIC_AUTH_BASE=http://xd-pages.127.0.0.1.nip.io:8787
export SSO_REDIRECT_URI=http://xd-pages.127.0.0.1.nip.io:8787/.xd-pages/auth/callback
export SSO_CLIENT_ID=<local-sso-client-id>
export SSO_CLIENT_SECRET=<local-sso-client-secret>
```

`xd-pages.127.0.0.1.nip.io` 用于让 OAuth redirect URI 具备稳定 host，同时仍解析到本机 `127.0.0.1`。本地 callback 路径也统一使用平台保留路径 `/.xd-pages/auth/callback`，避免和用户站点路由冲突。`pages-auth` 配置层可支持 `PAGES_ENV=local` 供开发调试；router 首版仍只服务 production/staging 站点域名，本地如需完整子站访问链路需要单独补 local router host allowlist 与 cookie/session 测试。

需要配置：

```text
SSO_CLIENT_ID
SSO_CLIENT_SECRET
SSO_AUTHORIZATION_URL
SSO_TOKEN_URL
SSO_PROFILE_URL
```

`SSO_REDIRECT_URI` 是 Git 可审查的环境常量，当前写在 auth wrangler template 中；`SSO_CLIENT_SECRET` 必须是 Worker secret / GitHub Environment Secret，不能放 `vars`、wrangler template、CLI config 或文档示例。

生产和 staging 的 `SSO_AUTHORIZATION_URL`、`SSO_TOKEN_URL`、`SSO_PROFILE_URL` 必须使用 HTTPS；只有 `PAGES_ENV=local` 允许 HTTP 本地 SSO mock。心动 SSO 当前 OAuth 接口形态是：

```text
GET /cas/oauth2.0/authorize?response_type=code&client_id=...&redirect_uri=...
GET /cas/oauth2.0/accessToken?code=...&client_id=...&client_secret=...&redirect_uri=...&grant_type=authorization_code
GET /cas/oauth2.0/profile?access_token=...
```

因为 provider 要求 `client_secret` 和 `access_token` 出现在 query 中，平台代码、测试、日志和错误响应必须做强脱敏：不得记录完整 token/profile 请求 URL，不得把 `client_secret`、OAuth code、access token、CAS `st`、`tgtId` 或 cookie-like ticket 写入日志、文档、审计和用户可见错误。

心动 SSO profile 当前联调返回形态可用下列伪造样例表达；样例仅用于字段契约说明，不能使用真实账号、真实票据或真实员工信息：

```json
{
  "account": "demo.user@example.test",
  "accountId": "acct_demo_001",
  "ad_account": "demo.user",
  "authWay": "13",
  "email": "demo.user@example.test",
  "employee_status": "1",
  "employeenum": "demo.user",
  "fs_email": "demo.user@example.test",
  "fs_id": "fs_demo_001",
  "isPublicAccount": false,
  "job_number": "1001",
  "loginTime": 1781595126585,
  "permissions": [],
  "realname": "示例用户",
  "roles": [],
  "sort": "0",
  "st": "ST-demo-redacted",
  "tgtId": "TGT-demo-redacted",
  "userId": "usr_xindong_123",
  "wechat_work": "ww_demo_001",
  "service": "http://xd-pages.127.0.0.1.nip.io:8787/.xd-pages/auth/callback",
  "id": "demo.user@example.test",
  "client_id": "xd_pages_local"
}
```

`pages-auth` 第一版只把 profile 归一化为平台身份所需的最小字段：

| 平台字段         | SSO 来源                                       | 说明                                                                                                                                              |
| ---------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `user_id`        | `userId`，后备 `id` / `sub`                    | `users` 表主键，优先使用稳定且不可复用的 SSO `userId`；不要优先用邮箱。                                                                           |
| `email`          | `email`                                        | 统一转小写，用于展示、审计和邮箱 ACL。                                                                                                            |
| `realname`       | `realname` / `name`                            | 员工姓名，仅用于管理展示、审计可读性和问题排查，不作为权限判断。                                                                                  |
| `account`        | `account`                                      | 当前系统推送帐号，受 SSO 后台应用设置影响；用于身份排查和后续目录对齐，不作为权限判断。                                                           |
| `account_id`     | `accountId` / `account_id`                     | 当前系统推送帐号对应 ID；用于身份排查和后续目录对齐，不作为权限判断。                                                                             |
| `employeenum`    | `employeenum` / `employeeNum` / `employee_num` | 员工账号；用于身份排查和后续组织目录对齐，不作为权限判断。                                                                                        |
| `employeeStatus` | `employee_status` / `employeeStatus`           | `1` / `active` 映射为 `active`；`0` / `disabled` / `inactive` 映射为 `disabled`；`left` / `leave` / `departed` 映射为 `left`；其它为 `unknown`。  |
| `departments`    | `departments`                                  | 仅接受完整部门路径数组，并在目录 hydration 不可用时作为 site code / session 的回退；原始 `departmentIds` / `department_ids` 不作为部门 ACL 路径。 |
| `sessionVersion` | `sessionVersion` / `session_version`           | 缺失时平台默认 `1`。                                                                                                                              |

`account`、`account_id`、`employeenum`、`realname` 可以进入 `users` 表，因为它们是常用身份排查字段，且不改变权限判断。`users` 表不再同时保存 `id` 和 `sso_subject` 两个等价字段，避免同一 SSO `userId` 出现两套名字。`fs_id`、`wechat_work`、`ad_account`、`job_number` 暂不进入核心 `users` 表；如果后续要长期使用，应单独设计 `user_identities` 或组织目录同步表。`st`、`tgtId` 是 CAS ticket 类敏感字段，不能持久化到平台业务库，也不能透传给 User Worker。

### Worker bindings

#### pages-api

```text
vars:
  PAGES_ENV
  PAGES_EXECUTION_MODE
  PUBLIC_API_BASE
  PUBLIC_AUTH_BASE
  PUBLIC_SITE_SUFFIX
  WFP_DISPATCH_NAMESPACE
  WFP_COMPATIBILITY_DATE
  PAGES_USER_WORKER_VPC_TUNNEL_ID
  CF_API_BASE_URL
  IP_ALLOWLIST
  ACCESS_KEY_ACTIVE_PEPPER_ID
  ACCESS_KEY_PEPPERS
  CLI_ACCESS_KEY_TTL_SECONDS
  CINDY_CONNECTION_ISSUERS
  CINDY_CONNECTION_AUDIENCE

bindings:
  D1: PAGES_METADATA
  KV: ROUTE_SNAPSHOTS, V1_SITES
  Durable Objects: ROUTE_POINTER_LOCKS
  VPC Network: XD_OFFICE_NET（配置 Tunnel ID 时）

secrets:
  CF_ACCOUNT_ID
  CF_API_TOKEN
  CF_ZONE_ID_NEW
  SITE_SECRET_ENCRYPTION_KEY
  WEBHOOK_URL_ENCRYPTION_KEY
  SLACK_PAGES_ALERT_WEBHOOK_URL
  XDS_OPENAI_TOKEN
  PAGES_V1_SITES_KV_NAMESPACE_ID（可选）
  ACCESS_KEY_PEPPER_*
```

`PAGES_EXECUTION_MODE` 是平台内部执行模式开关，当前 production / staging template 都设为 `wfp`。它是 Git 可审查的架构配置，不是 GitHub Environment Var，不能由 CLI、`--config` 或用户请求覆盖。`pages-api` 运行时读取这个值决定新发布部署到哪个内部执行面；slot provision 脚本读取这个值决定是否继续扩普通 Worker slot。`pages-router` 的 `PAGES_DISPATCH` dispatch namespace binding 是 production / staging template 静态配置，不由这个开关动态生成。第一版不提供 `auto` fallback；如果后续要做灰度自动回退，必须同时设计 router 双绑定、部署状态机和失败回滚语义。

`CF_ACCOUNT_ID` 和 `CF_API_TOKEN` 是 `pages-api` 运行时调用 Cloudflare API / Workers for Platforms API 或 ordinary Worker deploy API 的配置，只能注入 `pages-api`。`CF_API_TOKEN` 不得注入 router、auth、user Worker、CLI、`--config` 文件或公开文档。`CLOUDFLARE_API_TOKEN` 只用于 Wrangler / GitHub Actions 部署，不能作为 Worker runtime secret 注入。

`pages-api` 的 API 路由不按来源 IP 限制，所有 API 请求都必须使用 HTTPS，并由各 handler 执行 token、access key、session、scope 和 owner/team 校验。`IP_ALLOWLIST` 仍由现有模板注入 `pages-api` 作为兼容配置，部署期间继续要求提供，但 Worker 不读取它，也不把它作为请求门禁。子站默认/internal exposure 的 IP 门禁由 `pages-router` 的 `ROUTER_IP_ALLOWLIST_CIDRS` 执行；只有可信 schema v3/v4 serve snapshot 显式声明 public 才绕过该门禁。`pages-console` 继续读取 `IP_ALLOWLIST`，在 session、管理员权限和 CSRF 校验之外先限制公司网络来源。

`WFP_DISPATCH_NAMESPACE` 必须与 `PAGES_ENV` 强绑定：production 只能是 `xd-cell-workers-production`，staging 只能是 `xd-cell-workers-staging`。`packages/wfp-client` 的 `readWfpConfig` 会在运行时做这层校验，部署脚本也应做静态校验。`WFP_COMPATIBILITY_DATE` 当前在 wrangler template 中固定为 `2026-06-15`，保证 Worker 模块语义可复现；需要升级时走 PR 修改模板。`CF_API_BASE_URL` 默认是 `https://api.cloudflare.com/client/v4`；production / staging 即使配置该值，也必须保持 host 为 `api.cloudflare.com`，避免把 `CF_API_TOKEN` 发往非 Cloudflare API host。local/test 才允许使用其它 HTTPS host 做 mock。

`PAGES_USER_WORKER_VPC_TUNNEL_ID` 是可选的办公网 Tunnel ID。部署 workflow 从 GitHub Environment Variable `vars.PAGES_USER_WORKER_VPC_TUNNEL_ID` 注入，wrangler template 只保留 `__PAGES_USER_WORKER_VPC_TUNNEL_ID__` 占位符，不在 Git 中提交具体 Cloudflare resource id。为空时不向 WFP User Worker 注入 VPC Network binding；非空时仅 internal exposure 的 `worker-only` 和 `worker-with-assets` 发布会获得固定 binding `XD_OFFICE_NET`，`assets-only` 不绑定。Public Worker 不注入该 binding；Admin 开启 public 时会先移除并读回确认当前 active Worker 已无 `XD_OFFICE_NET`。关闭 public 不立即恢复 binding，后续 internal 完整部署才按配置重新注入。

同一个 `PAGES_USER_WORKER_VPC_TUNNEL_ID` 也用于给 `pages-api` 和 `pages-auth` 自身渲染 `XD_OFFICE_NET` VPC Network binding。两个 Worker 调用 XDS / OA `list-by-email` 时都必须使用 `env.XD_OFFICE_NET.fetch(...)`；如果 `XDS_OPENAI_TOKEN` 或 `XD_OFFICE_NET` binding 缺失，部门 hydration 返回 `unavailable`，登录和控制台会话继续完成，但不会更新用户部门路径或部门团队关系。SSO profile 明确提供的完整 `departments` 路径数组与已落库路径会合并作为当前登录的回退；XDS hydration 成功时以最新目录路径为准。原始部门 ID 不参与 ACL，没有可信完整路径时部门 ACL 继续 fail closed。不得 fallback 到全局公网 `fetch` 调用 XDS。

`XDS_OPENAI_TOKEN` 只作为 GitHub Environment secret 以及 `pages-api` / `pages-auth` Worker secret 存在；真实值不能进入 wrangler template、日志、响应、测试 fixture 输出或文档示例值。SSO 登录成功后，`pages-auth` 会直接按邮箱查询 XDS 部门路径，并通过共享 D1 store 更新 `users.department_path` / `department_checked_at`，同时创建或迁移部门团队成员关系。`pages-api` 也保留 internal hydration endpoint 和 Console session best-effort hydration，用于控制台链路补偿；两条链路复用同一 XDS client、同一 VPC binding 和同一 store 语义。

已经落库但没有部门信息的用户，当前不会由部署流程自动批量回填；他们下一次通过 `pages-auth` 完成 SSO 登录时会触发同一条 hydration 链路并补齐部门信息。长期不登录的历史用户会保持 `department_path = NULL`，依赖部门路径的 ACL 按 fail closed 处理。若后续需要一次性修复历史数据，应新增受控的内部 backfill 脚本或管理任务，复用同一 XDS client 和 `XD_OFFICE_NET` VPC binding，分页读取用户邮箱后写回，不在 workflow 中直接拼接临时 curl。

`ACCESS_KEY_PEPPERS` 是 access key HMAC pepper registry，格式为 `pepperId:secretEnvName`，例如 `pepper_2026_06:ACCESS_KEY_PEPPER_202606`。`ACCESS_KEY_ACTIVE_PEPPER_ID` 指向当前签发新 access key 使用的 pepper id。registry 只包含 secret env 名，可以写入 wrangler template 和 workflow 接受 Git 审查；真实 pepper 值只能作为 `ACCESS_KEY_PEPPER_*` Worker secret 注入 `pages-api`，不能写进 wrangler template、GitHub vars、CLI config、`--config` 文件或文档示例。

`pages-api` 不持有 `auth_session`、`site_session` 或 `internal_worker_jwt` 的 signing secret，也没有指向 `pages-auth` 的 service binding。公开 API 只接受 access key 或 Cindy connection assertion；Console BFF 由 `pages-console` 验证 session 后，通过 `pages-api.internal` service binding 转发受控身份 headers。`pages-api` 不能签发子站 session 或 router internal JWT。

#### pages-auth

```text
vars:
  PAGES_ENV
  PUBLIC_AUTH_BASE
  PUBLIC_API_BASE
  PAGES_SESSION_JWT_ACTIVE_KID
  PAGES_SESSION_JWT_KEYS
  SSO_AUTHORIZATION_URL
  SSO_TOKEN_URL
  SSO_PROFILE_URL
  SSO_CLIENT_ID
  SSO_REDIRECT_URI

bindings:
  D1: PAGES_METADATA
  Durable Objects: OAUTH_STATES, CLI_LOGINS, AUTH_SESSIONS
  service: PAGES_API
  VPC Network: XD_OFFICE_NET（配置 Tunnel ID 时）

secrets:
  SSO_CLIENT_SECRET
  PAGES_SESSION_JWT_SECRET_*
```

production / staging 的 `SSO_AUTHORIZATION_URL`、`SSO_TOKEN_URL`、`SSO_PROFILE_URL` 和 `SSO_CLIENT_ID` 是稳定、非 secret 的 SSO 应用拓扑配置，当前直接写在 `pages-auth` wrangler template 中并通过 PR 审查：production client id 为 `xd_pages`，staging client id 为 `xd_pages_staging`。`SSO_CLIENT_SECRET` 必须通过 secret 注入，不能写入 template、GitHub Vars、文档示例、CLI config 或 `--config` 文件。`PAGES_SESSION_JWT_KEYS` 是 `kid:alg:secretEnvName` registry，真实密钥值只存在于对应 secret env。

SSO callback 在签发 `auth_session`、`site_session` code 或确认 CLI login 之前，必须先成功换取 SSO profile，再写入共享 D1 `PAGES_METADATA` 中的 `users` 权威记录，并以写入后的权威用户状态决定是否签发 session。SSO profile 成功返回代表用户已通过 `xd_pages` / `xd_pages_staging` 应用授权；XD Cell 不再用本地邮箱域或 `xindong` 字符串二次缩窄允许人群。即使 SSO profile 显示用户已 disabled / left，也要先同步并 bump `sessionVersion`，再返回 403。若 D1 中用户已经是 `disabled` / `left`，一次并发或滞后的 `active` / `unknown` profile 不能把用户恢复为 active；恢复 active 需要后续明确的组织目录同步或管理员流程。这样 `xd-cell login` 成功后，控制面 `users` 表已经有 active 用户状态；用户离职或禁用后，CLI access key 也会被 API 层的用户状态与 `sessionVersion` 校验拒绝。

`xd-cell login` 的凭证由 pages-auth 在 CLI login poll 确认后，经 `PAGES_API` service binding 调 pages-api 内部端点 `/.xd-pages/internal/cli-access-keys` 换发一把 `issued_source='cli_login'` 的个人 access key（scope `*`、默认 TTL 1 年、`CLI_ACCESS_KEY_TTL_SECONDS=0` 表示永不过期），poll 响应契约保持不变，旧版 CLI 无感。因此 v2 的 service binding 依赖关系如下：

- 方向是单向 `pages-auth -> pages-api`（换发 access key），`pages-api` 不反向依赖 `pages-auth`。
- 非 access-key / 非 Cindy assertion 的 Bearer（包括历史 CLI JWT）由 `pages-api` 直接拒绝为 `CLI_TOKEN_INVALID`，提示重新登录。
- 部署顺序：`pages-api` 必须先于 `pages-auth` 部署，保证 `/.xd-pages/internal/cli-access-keys` 端点先在线，否则 `DEPLOY_COMPONENT=all` 的窗口期内 `xd-cell login` 会返回 502。`deploy-pages-v2.yml` / `deploy-pages-v2-staging.yml` 已按此顺序编排。

#### pages-router

```text
vars:
  PAGES_ENV
  PUBLIC_AUTH_BASE
  PUBLIC_API_BASE
  PUBLIC_SITE_SUFFIX
  ROUTE_CACHE_TTL_SECONDS
  ROUTER_IP_ALLOWLIST_CIDRS
  ROUTER_JWKS_URL
  PAGES_SESSION_JWT_ISSUER
  PAGES_SESSION_JWT_ACTIVE_KID
  PAGES_SESSION_JWT_KEYS
  PAGES_CAP_JWT_ACTIVE_KID
  PAGES_CAP_JWT_KEYS
  SITE_SESSION_IDLE_TTL_SECONDS
  SITE_SESSION_FRESHNESS_TTL_SECONDS
  INTERNAL_WORKER_JWT_TTL_SECONDS

bindings:
  KV: ROUTE_SNAPSHOTS
  dispatch namespace: PAGES_DISPATCH
  service: active legacy SITE_SLOT_*
  service: PAGES_AUTH
  service: XD_PAGES_KV_GATEWAY

secrets:
  PAGES_SESSION_JWT_SECRET_*
  PAGES_CAP_JWT_SECRET_*
```

router 不需要 Cloudflare API token。router 只能 dispatch 到当前环境的 WFP namespace 或当前环境预绑定的 slot service binding。`ROUTER_IP_ALLOWLIST_CIDRS` 仍是 internal/default 路径的强制配置；缺失或格式错误时非 public 请求必须 fail closed，可信 public snapshot 不依赖该 allowlist 放行。当前实现用统一的 `PAGES_SESSION_JWT_*` registry 签发和校验 `site_session` 与 `internal_worker_jwt`，通过 `PAGES_SESSION_JWT_ISSUER`、`purpose`、`aud`、`kid` 和 `env` 区分用途。

router wrangler template 静态声明当前环境的 `PAGES_DISPATCH` dispatch namespace。渲染阶段从部署脚本输出读取 `PAGES_NORMAL_WORKER_SLOT_BINDINGS_JSON` 来生成旧 active slot route 所需的稀疏 `SITE_SLOT_*` service binding。空闲 Worker 不参与 router binding；管理员删除空闲 Worker 后不需要立即触发 router deploy，下一次手动 router deploy 会自然移除已经不再 active 的 binding。

#### pages-kv-gateway

```text
vars:
  PAGES_ENV
  PAGES_CAP_JWT_ACTIVE_KID
  PAGES_CAP_JWT_KEYS

bindings:
  KV: SITE_DATA

secrets:
  PAGES_CAP_JWT_SECRET_*
```

沿用现有 capability key registry 思路；registry 名称可以随 Git 固定，但 production/staging 的真实 `PAGES_CAP_JWT_SECRET_*` 值必须来自不同 GitHub Environment Secret。

### GitHub Actions 配置

GitHub Environments 应至少有：

```text
staging
production
```

配置项按三层处理：

1. 可随 Git 提交、可审查的架构常量写在 v2 `wrangler.*.template.toml` 或 v2 deploy workflow 中。
2. 不可随 public Git 提交、但安全要求正常的环境配置放 GitHub Environment `vars`。
3. token、client secret、签名密钥、pepper 等高敏配置放 GitHub Environment `secrets`。

当前随 Git 提交的非敏感常量包括：

```text
PAGES_ENV
PAGES_EXECUTION_MODE
PAGES_NORMAL_WORKER_SLOT_EXPAND_BY
PUBLIC_API_BASE
PUBLIC_AUTH_BASE
PUBLIC_SITE_SUFFIX
SLACK_PAGES_ALERT_MENTION_USER_ID
SSO_AUTHORIZATION_URL
SSO_REDIRECT_URI
SSO_TOKEN_URL
SSO_PROFILE_URL
SSO_CLIENT_ID
WFP_DISPATCH_NAMESPACE
WFP_COMPATIBILITY_DATE
PAGES_USER_WORKER_VPC_TUNNEL_ID
ACCESS_KEY_ACTIVE_PEPPER_ID
ACCESS_KEY_PEPPERS
CINDY_CONNECTION_ISSUERS
CINDY_CONNECTION_AUDIENCE
PAGES_SESSION_JWT_ISSUER
PAGES_SESSION_JWT_ACTIVE_KID
PAGES_SESSION_JWT_KEYS
PAGES_CAP_JWT_ACTIVE_KID
PAGES_CAP_JWT_KEYS
OAUTH_STATE_TTL_SECONDS
CLI_LOGIN_TTL_SECONDS
AUTH_SESSION_IDLE_TTL_SECONDS
AUTH_SESSION_ABSOLUTE_TTL_SECONDS
SITE_SESSION_IDLE_TTL_SECONDS
SITE_SESSION_ABSOLUTE_TTL_SECONDS
SITE_SESSION_FRESHNESS_TTL_SECONDS
ROUTE_CACHE_TTL_SECONDS
INTERNAL_WORKER_JWT_TTL_SECONDS
```

`CF_API_BASE_URL` 只用于本地测试或特殊网络环境；生产和 staging 默认不配置，使用 Cloudflare 官方 API base。若生产或 staging 因代理需求必须覆盖，也只能覆盖到 `https://api.cloudflare.com/client/v4` 这一官方 host，不能指向任意第三方域名。

GitHub Environment `vars` 放非敏感但不可随 public Git 提交的环境配置：

```text
CLOUDFLARE_ACCOUNT_ID
IP_ALLOWLIST
PAGES_V2_D1_DATABASE_ID
PAGES_V2_ROUTE_SNAPSHOTS_KV_ID
PAGES_V2_SITE_DATA_KV_ID
ROUTER_IP_ALLOWLIST_CIDRS
```

v2 wrangler template 声明 API/Auth custom domain 和 router route。`pages-router` / `pages-router-staging` 的 route 使用 `zone_name = "xd.team"`，因此 workflow 不需要额外引入 `CLOUDFLARE_ZONE_ID`，但 `CLOUDFLARE_API_TOKEN` 必须具备部署 Worker、创建/更新 Worker route 和 custom domain 绑定的权限。DNSPod CNAME 与证书 DCV 不由当前 workflow 自动管理。

GitHub Environment `secrets` 放高敏配置，以及明确不公开的 v1 存量资源标识：

```text
CLOUDFLARE_API_TOKEN
CF_API_TOKEN
PAGES_V1_SITES_KV_NAMESPACE_ID
SSO_CLIENT_SECRET
PAGES_SESSION_JWT_SECRET_*
PAGES_CAP_JWT_SECRET_*
ACCESS_KEY_PEPPER_*
```

Cloudflare account id、zone id、D1/KV namespace id 不是凭证，v2 workflow 通常按 `vars` 读取；它们仍然不应写进 public repo。`PAGES_V1_SITES_KV_NAMESPACE_ID` 是例外：为避免公开 v1 存量资源标识，它只从 GitHub Environment `secrets` 可选注入 pages-api，取值直接引用 v1 既有 secret `SITES_KV_NAMESPACE_ID`（不新增 GitHub secret），production 与 staging 环境各自解析各自的值；namespace 未配置时关闭 v1 盘点。v1 退役的 route 解绑复用必配 runtime secret `CF_ZONE_ID_NEW`，缺失时清单保持只读但关闭 v1 退役。`PAGES_EXECUTION_MODE`、`WFP_DISPATCH_NAMESPACE`、`CINDY_CONNECTION_ISSUERS` 和 `CINDY_CONNECTION_AUDIENCE` 名称与取值本身不是凭证，但它们是强架构/环境边界，必须按 environment 固定在 template 并通过 PR 评审；issuer 白名单只保存受信 https origin,不保存任何密钥(验签用的是 Cindy 公开 JWKS)。

当前 `deploy-pages-v2.yml` / `deploy-pages-v2-staging.yml` 的 GitHub Environment 配置应按 workflow 实际名称填写：

| 名称                              | 类型   | 使用方                                      | 说明                                                                                                                             |
| --------------------------------- | ------ | ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `CLOUDFLARE_ACCOUNT_ID`           | var    | v2 系统 Worker wrangler 渲染和部署          | 用于 `account_id` 与 Wrangler 部署 env；workflow 会把同一个值作为 runtime secret `CF_ACCOUNT_ID` 注入 `pages-api`                |
| `IP_ALLOWLIST`                    | var    | `pages-console` / `pages-api` wrangler 渲染 | Console 公司网络门禁；注入 `pages-api` 时仅为兼容配置，API Worker 不读取                                                         |
| `PAGES_V2_D1_DATABASE_ID`         | var    | `pages-api` / `pages-auth` wrangler 渲染    | 当前环境的 D1 metadata database id                                                                                               |
| `PAGES_V2_ROUTE_SNAPSHOTS_KV_ID`  | var    | `pages-api` / `pages-router` wrangler 渲染  | 当前环境的 route snapshot KV namespace id                                                                                        |
| `PAGES_V2_SITE_DATA_KV_ID`        | var    | `pages-kv-gateway` wrangler 渲染            | 当前环境的 Pages KV site data namespace id；production / staging 必须不同                                                        |
| `PAGES_USER_WORKER_VPC_TUNNEL_ID` | var    | `pages-api` / `pages-auth` wrangler 渲染    | 当前环境的办公网 Tunnel ID；用于 User Worker VPC binding，也用于 `pages-api` / `pages-auth` 通过 `XD_OFFICE_NET` 调用 XDS / OA   |
| `ROUTER_IP_ALLOWLIST_CIDRS`       | var    | `pages-router` wrangler 渲染                | 必填，router 缺失或无效时 fail closed                                                                                            |
| `CLOUDFLARE_API_TOKEN`            | secret | Wrangler 部署                               | 只能用于 GitHub Actions / Wrangler，不注入 Worker runtime；权限需覆盖 Worker 部署、Worker route 和 custom domain 绑定            |
| `CF_API_TOKEN`                    | secret | `pages-api` runtime                         | 通过 `scripts/put-pages-v2-secrets.sh apps/pages-api` 注入，供 Cloudflare Workers / WFP API 调用                                 |
| `PAGES_V1_SITES_KV_NAMESPACE_ID`  | secret | `pages-api` runtime                         | 当前环境 v1 SITES KV namespace id；可选，缺失时 v1 盘点返回 `V1_SITES_UNSUPPORTED`，production / staging 必须不同                |
| `SLACK_PAGES_ALERT_WEBHOOK_URL`   | secret | `pages-api` runtime                         | Slack Incoming Webhook URL；用于 slot 容量耗尽等平台运维告警，只注入 `pages-api`，不能写入 wrangler template、GitHub Vars 或文档 |
| `WEBHOOK_URL_ENCRYPTION_KEY`      | secret | `pages-api` runtime                         | 平台 Webhook 订阅目标 URL 加密 key；独立于站点级 secret key，只注入 `pages-api`                                                  |
| `XDS_OPENAI_TOKEN`                | secret | `pages-api` / `pages-auth` runtime          | XDS / OA `list-by-email` 签名 token，只注入需要部门 hydration 的系统 Worker；请求必须通过 `XD_OFFICE_NET` VPC Network binding    |
| `SSO_CLIENT_SECRET`               | secret | `pages-auth` runtime                        | OAuth token exchange secret，只注入 auth Worker                                                                                  |
| `ACCESS_KEY_PEPPER_*`             | secret | `pages-api` runtime                         | 必须覆盖 `ACCESS_KEY_PEPPERS` registry 中每个 `secretEnvName`                                                                    |
| `PAGES_SESSION_JWT_SECRET_*`      | secret | `pages-auth` / `pages-router` runtime       | 必须覆盖 `PAGES_SESSION_JWT_KEYS` registry 中每个 `secretEnvName`                                                                |
| `PAGES_CAP_JWT_SECRET_*`          | secret | `pages-router` / `pages-kv-gateway` runtime | 必须覆盖 `PAGES_CAP_JWT_KEYS` registry 中每个 `secretEnvName`                                                                    |

v2 平台部署使用独立 workflow：`deploy-pages-v2.yml` 在 GitHub Actions 中显示为 `Deploy XD Cell Production`，只允许 `workflow_dispatch` 手动部署 production；`deploy-pages-v2-staging.yml` 显示为 `Deploy XD Cell Staging`，支持手动部署，也可以在 `staging` 分支的 v2 app / package / render script 相关文件变更时自动部署。它们只处理 v2 系统 Worker：`pages-api`、`pages-auth`、`pages-router`、`pages-kv-gateway`、`pages-console`，不部署 v1 `apps/server`、ACK、用户站点或发布执行器。`component=all` 的依赖顺序必须是：先执行 D1 migrations，再部署 `pages-kv-gateway` 和 `pages-router` 两个协议 consumer，然后部署 `pages-api` producer，随后部署持有 `PAGES_API` service binding 的 `pages-auth`，最后构建部署 `pages-console`。为避免单组件操作绕过协议顺序，选择 `component=pages-api` 时也会先从同一 commit 重新部署 `pages-kv-gateway` 和 `pages-router`；选择 consumer 本身仍只部署所选组件。

v2 runtime secret 注入使用 `scripts/put-pages-v2-secrets.sh <app>`。它会在部署前用 `DRY_RUN=1` 校验 registry 和必需 secret 是否齐全，部署后再写入 Worker secret。`pages-api` 注入 `CF_ACCOUNT_ID`、`CF_API_TOKEN`、`SLACK_PAGES_ALERT_WEBHOOK_URL`、`SITE_SECRET_ENCRYPTION_KEY`、`WEBHOOK_URL_ENCRYPTION_KEY`、`XDS_OPENAI_TOKEN` 和 `ACCESS_KEY_PEPPER_*`；如果配置了 `PAGES_V1_SITES_KV_NAMESPACE_ID`，也会作为可选 secret 注入，清空时脚本会删除 Worker 上的旧值；已废弃的 `PAGES_V1_ZONE_ID` 会被脚本持续清理残留。`pages-auth` 注入 `SSO_CLIENT_SECRET`、`XDS_OPENAI_TOKEN` 和 `PAGES_SESSION_JWT_SECRET_*`；`pages-router` 注入 `PAGES_SESSION_JWT_SECRET_*` 和 `PAGES_CAP_JWT_SECRET_*`；`pages-kv-gateway` 只注入 `PAGES_CAP_JWT_SECRET_*`；`pages-console` 注入 `PAGES_SESSION_JWT_SECRET_*`。

`SLACK_PAGES_ALERT_MENTION_USER_ID` 是 `pages-api` wrangler template 中固定的非敏感告警接收人 id，用于 legacy slot 容量告警正文里的单次 Slack mention。`PAGES_NORMAL_WORKER_SLOT_EXPAND_BY` 只作为历史兼容配置和测试输入保留，当前 router 部署不再用它新增 slot。

`SITE_METADATA_MUTATIONS_ENABLED` 是两个 pages-api 环境模板中 Git 可审查的止损开关，默认均为 `false`，且只有精确 `true` 才开放名称/URL mutation；显式携带 `title` 的部署（包括 replay）同样受此开关限制，省略 `title` 的部署不受影响。它不是 GitHub Environment Var，也不影响 metadata 读取、兼容 writer 或 scheduled reconciliation。本期缩略图延期，不新增 R2 binding。

站点 metadata 首次 rollout 必须拆成两阶段：先应用 `0021_site_metadata.sql`，依次部署兼容的 kv-gateway、pages-router、flag 关闭的 pages-api、pages-console 与 CLI；在 staging 验证 v2/v3/v4 reader、连续 rename、旧地址不跳转且经过 pointer 清理与 5 分钟 hold 后可复用、runtime data 和 deploy/rollback 后，再分别修改对应环境模板打开 flag。production 仍只通过 `Deploy XD Cell Production` 手动发布。新版 pages-api 上线后，任意 deploy、rollback、访问策略或 runtime config snapshot 刷新都可能写出首个 schema v4 pointer；从这一刻起，即使尚未发生 slug rename，也不得降级到不认识 schema v4 / namespace v2 的旧 pages-router 或 pages-kv-gateway。若尚未发生 slug rename 且必须回滚 producer，只回滚 pages-api，并保留新版 pages-router 和 pages-kv-gateway。首次 slug rename 后 pages-api、pages-router 与 pages-kv-gateway 均只能 roll forward；异常时关闭 flag，不能恢复不认识 `dataNamespace` 或旧 pointer 清理状态的旧 writer。

### 配置校验

部署脚本必须 fail closed：

- v2 系统 Worker 的拓扑配置以环境显式模板为准：`apps/pages-api/wrangler.production.template.toml`、`apps/pages-api/wrangler.staging.template.toml`、`apps/pages-auth/wrangler.production.template.toml`、`apps/pages-auth/wrangler.staging.template.toml`、`apps/pages-router/wrangler.production.template.toml`、`apps/pages-router/wrangler.staging.template.toml`、`apps/kv-gateway/wrangler.production.template.toml`、`apps/kv-gateway/wrangler.staging.template.toml`。`pages-kv-gateway` 不复用 v1 旧生成链路。
- v2 使用 `node scripts/render-pages-v2-wrangler.mjs <app> <production|staging>` 渲染最终 `wrangler.toml`。渲染器只做 `__PLACEHOLDER__` 占位符替换、必填项检查和环境串用校验；Worker 名、域名、service binding、dispatch namespace 等拓扑值直接写在对应环境模板里，避免把 v2 环境逻辑藏进 shell 分支。
- `apps/pages-api/migrations/` 是 v2 D1 authority schema 的显式迁移源。部署 `pages-auth` 或 `pages-api` 前必须先执行对应环境的 `wrangler d1 migrations apply`，确保 `users`、`sites`、`site_routes`、`site_versions`、`site_vars`、`site_secrets`、`worker_slots`、`deployments` 等表结构先于 Worker 代码上线。
- `scripts/gen-wrangler.sh` 继续服务 v1 `apps/server` 和 `apps/xdads-302`；`apps/kv-gateway` 的旧 v1 部署链路应退役，v2 gateway 不复用这条旧生成链路。
- production workflow 只能手动触发。
- staging workflow 可以由 `staging` 分支触发。
- `PAGES_ENV=production` 时，API/auth/site suffix 必须是 production 域名。
- `PAGES_ENV=staging` 时，API/auth/site suffix 必须是 staging 域名。
- signing key registry 中的 active kid 必须能找到对应 secret。
- `CINDY_CONNECTION_ISSUERS` 必须是逗号分隔的 https origin 列表；`CINDY_CONNECTION_AUDIENCE` 必须是 `<orgSlug>:<plugin-slug>` 格式；production 的 issuer 列表不得包含 dev issuer(`auth-dev.*`)。renderer 必须 fail closed。
- `PAGES_EXECUTION_MODE` 必须在 `pages-api` 和 `pages-router` 对应环境 template 中各出现一次，只能是 `normal-worker-slot` 或 `wfp`；不得从 GitHub Environment Vars 注入。
- `SITE_METADATA_MUTATIONS_ENABLED` 必须在 production/staging pages-api template 中显式存在并默认关闭；启用时必须按上述 consumer-before-producer 顺序完成当前环境验收。
- `WFP_DISPATCH_NAMESPACE` 必须与 `PAGES_ENV` 匹配，不能 staging/prod 串用。
- `PAGES_USER_WORKER_VPC_TUNNEL_ID` 是 `pages-api` / `pages-auth` 的可选渲染 token，必须从 GitHub Environment Variable 注入；未配置时渲染为空字符串，且不会渲染 `XD_OFFICE_NET` VPC Network binding。
- `XDS_OPENAI_TOKEN` 必须作为 GitHub Environment secret 注入 `pages-api` 和 `pages-auth` runtime；真实值不得写入 vars、wrangler template、日志或文档示例值。
- `pages-api` / `pages-auth` 的 XDS / OA 请求必须通过 `XD_OFFICE_NET` VPC Network binding；缺少 binding 时部门 hydration 返回 `unavailable`，不得 fallback 到公网 `fetch`。
- router template 必须静态配置当前环境 WFP dispatch namespace：production 为 `xd-cell-workers-production`，staging 为 `xd-cell-workers-staging`。
- 当前 production / staging `PAGES_EXECUTION_MODE` 必须为 `wfp`；部署脚本不得自动扩展普通 Worker slot，只能通过 `PAGES_NORMAL_WORKER_SLOT_BINDINGS_JSON` 渲染 active legacy route 仍需要的显式 service binding。
- `CF_ACCOUNT_ID` / `CF_API_TOKEN` 必须只出现在 `pages-api` runtime；router/auth/thin router 不能持有。
- production / staging 的 `CF_API_BASE_URL` 必须是 `https://api.cloudflare.com/client/v4`，不能把 `CF_API_TOKEN` 发送到其它 host。
- `SLACK_PAGES_ALERT_WEBHOOK_URL` 必须作为 GitHub Environment secret 注入 `pages-api`，不能放 GitHub Vars、wrangler template 或日志；告警发送失败不得影响用户部署响应。
- `WEBHOOK_URL_ENCRYPTION_KEY` 必须作为 GitHub Environment secret 注入 `pages-api`，只用于平台 Webhook 订阅目标 URL 加密；不得复用 `SITE_SECRET_ENCRYPTION_KEY`。
- D1、KV、Durable Object binding 必须指向当前环境资源。
- `pages-api` API 请求必须使用 HTTPS；不得再把 `IP_ALLOWLIST` 作为 API 请求门禁。
- `pages-console` 仍必须配置有效的 `IP_ALLOWLIST`，并在读取 session、调用 service binding 或返回静态资源前执行公司网络门禁。
- Cindy connection 断言按请求经 JWKS 验签,不新增专用 IP allowlist;受信 issuer 白名单先于取键。
- `ROUTER_IP_ALLOWLIST_CIDRS` 必须存在、可解析、只包含公司批准的内网/VPN/办公出口 CIDR；缺失时 internal/default 子站访问必须 fail closed。
- `CF_API_TOKEN` 只能注入 `pages-api` runtime；`CLOUDFLARE_API_TOKEN` 只能出现在 GitHub Actions / Wrangler 部署环境。
- `pages-router` 和 `pages-router-staging` 的 wrangler 配置不能同时出现两套环境 binding 或两套 signing key。
- slot service binding 必须与当前环境一致，例如 production router 只能绑定 `pages-v2-production-slot-*`，staging router 只能绑定 `pages-v2-staging-slot-*`。
- 如果启用 `pages-edge-router-thin`，它只能配置 service binding，不能配置 D1/KV/DO、dispatch namespace、slot binding 或 signing secret。
- Worker 生成的 wrangler 配置不能残留 `__PLACEHOLDER__`。
- `public-docs` 输出的 base URL 必须与当前 Worker 环境一致。

### Release gate 与 smoke checklist

提交前必须完成本地和 CI 静态验证：

```bash
git diff --check
! git ls-files --error-unmatch '*sso*.md' # 期望失败，表示本地 SSO 参考未被跟踪
node --test scripts/render-pages-v2-wrangler.test.js scripts/pages-v2-secrets.test.js scripts/workflows.test.js
pnpm lint
pnpm test
```

staging 首次部署前必须完成：

1. GitHub `staging` Environment 已配置上表中的 vars/secrets，且真实 D1/KV/secret 值不出现在仓库、日志或文档中。
2. Cloudflare 已创建 staging D1、staging route snapshot KV、staging site data KV 和 `xd-cell-workers-staging` dispatch namespace；`pages-api-staging`、`pages-auth-staging`、`pages-router-staging`、`pages-kv-gateway-staging` 以及对应 route/custom domain 由 workflow 的 wrangler deploy 创建/更新。partial zone 的 DNSPod CNAME 和证书 DCV 已提前准备或确认可生效。当前 staging template 为 `PAGES_EXECUTION_MODE=wfp`，workflow 只渲染 active legacy route 的显式 slot binding，不再扩容 slot 池。
3. staging D1 已先执行 `0008_runtime_bindings.sql`、`0009_runtime_config_generation.sql` 和 `0010_site_vars.sql`，再部署新的 `pages-api-staging`。
4. GitHub `staging` Environment 已配置 `SITE_SECRET_ENCRYPTION_KEY` 和 `WEBHOOK_URL_ENCRYPTION_KEY`，且 workflow 能通过 `wrangler secret put` 注入到 `pages-api-staging`；真实值不得写入 vars、模板正文或日志。
5. SSO staging 应用 redirect URI 指向 `https://auth-staging.pages.xd.team/.xd-pages/auth/callback`，不指向 `api-staging.pages.xd.team`。
6. 手动或由 `staging` 分支触发 XD Cell staging 部署 workflow（当前 workflow 文件为 `deploy-pages-v2-staging.yml`），先用 `component=all` 验证四个系统 Worker 一起部署；单组件部署只用于已确认依赖兼容的修复。
7. workflow 中四个 `DRY_RUN=1 scripts/put-pages-v2-secrets.sh ...` 步骤先通过，再执行真正 secret 注入。
8. `https://api-staging.pages.xd.team/.xd-pages/health` 返回 staging `pages-api` 状态，且 `/skill.md`、`/readme.md` 只返回 staging API/auth/domain，不出现 production 地址，不把 v2 新建子站误描述为 `pages.xd.team` 默认后缀。
9. `xd-cell login --env staging` 能完成 SSO、device code 手动确认和 CLI access key 保存。
10. `xd-cell deploy --env staging` 至少验证 static、SPA 和 custom `.js/.mjs` Worker 三类 artifact；`.ts` Worker 入口在未接入 bundler 前必须 fail closed。
11. 验证 `xd-cell secrets put/delete <site> <name>`、带 `vars` 的 Worker deploy、后续不传 `vars` 的 Worker deploy 沿用站点级 vars、显式空 `vars` 的 Worker deploy 会清空站点级 vars；后续不传 secret 的 deploy 仍能注入站点级 enabled secrets，删除 secret 后下一次 Worker deploy 不再注入。
12. staging 子站访问验证 internal/public exposure × `internal`(anonymous)、`org`、`acl`、`owner`、`disabled`；确认只有可信 public snapshot 绕过 IP，public runtime 跨源请求被拒绝，Public Worker 无 `XD_OFFICE_NET`，关闭 public 不即时恢复 binding，后续 internal deploy 才恢复。
13. v1 `api.workers.xd.team`、旧 exact route、旧 skill 和旧发布 workflow 不受 staging v2 部署影响；v2 `*.workers.xd.team/*` wildcard 不抢占 v1 exact route。

### Cindy Connections 断言鉴权联调附加清单

1. staging / production 部署 workflow 会在 D1 migration 前强制检查大小写无关的重复邮箱，并且只向日志输出冲突组数量。发现冲突时 workflow 会停止；运维人员通过受控 D1 会话执行以下明细查询，确定保留用户，逐表审计并迁移所有 `users.user_id` 引用，删除重复用户后重新执行部署。禁止 workflow 自动猜测或删除用户：

   ```sql
   SELECT lower(trim(email)), COUNT(*)
   FROM users
   GROUP BY lower(trim(email))
   HAVING COUNT(*) > 1;
   ```

2. 先应用 `0016_cindy_connection_users.sql` 与 `0017_drop_s2s_guards.sql` migration，再部署 `pages-api`；staging 模板信 dev + 两个生产 issuer，production 模板只信两个生产 issuer。dev 与生产是两套独立签名密钥（kid 不同）。
3. 验收反例（staging 联调必须全过）：过期断言拒、错 `aud` 拒、坏签名拒、`alg` 降级为 HS256/none 拒、轮换出新 kid 后重拉 JWKS 能通过；另验 `typ` / `iss` / `ctx` / `orgSlug` 不匹配拒。
4. staging smoke 顺序：Cindy dev 实例（或手工签发的断言）直接携带 Bearer JWT 调 whoami / sites / deployments -> 首次断言自动落库（`created_source=cindy`，`cindy_membership_id` 绑定） -> 尝试用断言创建 access key 必须 403 -> 用户 `employee_status` 置非 active 后断言返回 403。
5. 联调记录只保留脱敏的 membershipId、`jti`、内部 user id、状态码和时间；不得记录断言原文或 JWKS 之外的 payload 字段。

production 发布或升级前必须完成：

1. staging smoke checklist 全部通过，并确认 Cloudflare route / DNS / certificate 已覆盖 v2 `workers.xd.team` 新默认后缀和存量 `pages.xd.team` route，且 v1 exact route 优先级不变。
2. GitHub `production` Environment 已配置独立 production D1/KV、执行面资源、SSO app、JWT secret、access key pepper、`SITE_SECRET_ENCRYPTION_KEY`、`WEBHOOK_URL_ENCRYPTION_KEY`、Console IP allowlist 和 router IP allowlist。production router template 必须固定绑定 `xd-cell-workers-production` dispatch namespace；production template 中的 `PAGES_EXECUTION_MODE` 必须为 `wfp`，router 只保留 active legacy route 仍需要的显式 slot binding。
3. XD Cell production 部署 workflow（当前 workflow 文件为 `deploy-pages-v2.yml`）只能通过 `workflow_dispatch` 触发；push/PR 不得触发 production。
4. 已有 v2 production 环境的本次 metadata 协议升级使用 `component=all`，由 workflow 按 D1 migration -> kv-gateway -> router -> pages-api -> pages-auth -> pages-console 的顺序部署：先上线 route/runtime 协议 consumer，再上线写入 v4 snapshot 的 pages-api，同时保持 pages-api 先于依赖它的 pages-auth；`0008_runtime_bindings.sql`、`0009_runtime_config_generation.sql`、`0010_site_vars.sql` 和 `0021_site_metadata.sql` 必须先于 `pages-api` 新版本生效。该顺序假设现有 `pages-auth` 已可供 router service binding 使用，不是空账号的 bootstrap 流程；全新环境必须在关闭外部流量和 metadata flag 的前提下，先按 pages-api -> pages-auth、kv-gateway -> router 建立 service binding 目标，再运行 `component=all` 收敛到 consumer-before-producer 基线。
5. 发布后先验证 `api.pages.xd.team/.xd-pages/health`、`auth.pages.xd.team` 登录入口和一个受控试点站点。
6. metadata 兼容基线上线前，可重新 dispatch 协议兼容的已知好 commit。新版 pages-api 可能写出首个 schema v4 pointer 后，不得整套回滚旧 workflow，也不得单独回滚 pages-router 或 pages-kv-gateway；尚未发生 slug rename 时如需回滚 producer，只部署旧 pages-api 并保留新版 consumers，首次 slug rename 后三个组件均只允许 roll forward。pages-console 可独立回滚。任何情况都不得通过修改 v1 `workers.xd.team` route 回滚 v2。
