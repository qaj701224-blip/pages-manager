# Pages v2 Workers for Platforms 架构设计

## 状态

本文是 `pages-manager` v2 架构草案，用于在 `pages.xd.team` 新建一套带统一身份、发布鉴权、子站 SSO、多租户执行隔离和统一审计的平台。

设计目标是先明确 v1 / v2 边界。v1 `*.workers.xd.team` 保持不动，继续由现有 `apps/server` 和旧发布链路服务；v2 使用全新的 `*.pages.xd.team` 域名、资源和代码目录，不做历史站点迁移、不认领 v1 资产、不接管 v1 route。

参考资料：

- `docs/xd-sso.md`：心动统一身份认证 OAuth 接入说明的本地临时参考；该文件不随 v2 PR 提交，上线前删除或改为全量脱敏摘要
- Cloudflare Workers for Platforms：`https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/`
- Dynamic Dispatch：`https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/dynamic-dispatch/`
- Outbound Workers：`https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/configuration/outbound-workers/`

## 背景

域名和产品边界先固定为：

```text
v1 / existing: *.workers.xd.team
  - 当前线上服务继续可访问。
  - 现有 README、API、skill、apps/server 行为不因 v2 改动而变化。
  - X-Pages-Token 仍只属于 v1 归属标记，不升级为 v2 强认证。

v2 / greenfield: *.pages.xd.team
  - 新建 Workers for Platforms 架构。
  - 新建 API、Auth、Router、D1/KV/DO、dispatch namespace 和 SSO redirect URI。
  - 用户要使用 v2 时重新发布到 pages.xd.team，不从 workers.xd.team 自动迁移。
```

当前 `pages-manager` 的核心模型是：

```text
管理 API Worker
  -> Cloudflare API 创建/更新每个站点自己的普通 Worker
  -> 为每个站点绑定 route
  -> 用 X-Pages-Token 做站点归属标记
  -> 子站默认靠 IP allowlist 限制访问
```

这个模型适合轻量内部托管，但不适合长期承载任意用户 Worker 代码：

- `X-Pages-Token` 只是归属标记，不是强认证。
- 子站访问控制分散在生成 Worker 或用户 `_worker.js` 中，难以统一策略。
- 每个站点都是普通 account Worker，路由、策略和审计都随站点数量变复杂。
- 用户 Worker 默认不可信时，平台需要统一清洗请求、注入身份、限制能力和审计行为。
- 如果支持上千个 Worker，应该避免每个请求回管理 Worker，也应避免为每个站点维护复杂的一等 Worker/route 状态。

下一代目标是把平台拆成控制面、数据面和执行面：

```text
Control Plane: 登录、发布、站点管理、ACL、版本、审计
Data Plane:    子站请求快路径、SSO gate、策略判断、动态分发
Runtime Plane: 用户 Worker 执行、能力网关、资源隔离
```

## 目标

- 发布站点必须有强认证，支持人类用户、CI 和 agent。
- 发布内容可选择访问可见性。
- 平台登录接入心动 SSO。
- 子站点支持公司统一 SSO 登录和站点级访问策略。
- 支持用户上传任意 Worker 代码，用户 Worker 默认不可信。
- 支持上千个 Worker，数据面请求不回管理 API Worker。
- 使用 Workers for Platforms 承载用户 Worker，平台 Gateway/Router 统一处理鉴权、审计、header 清洗和动态分发。
- v2 作为 `pages.xd.team` 上的新平台独立上线，不影响 v1 `workers.xd.team`。

## 非目标

- 不在第一阶段实现完整管理 UI。
- 不在第一阶段做复杂组织架构同步；先以 SSO profile 中的用户标识、邮箱和显式 ACL 为准。
- 不把心动 SSO 的 `clientSecret` 下发到 CLI、浏览器或用户 Worker。
- 不让用户 Worker 直接持有平台级 Cloudflare API token、全局 KV/R2/D1 binding 或 SSO access token。
- 不做历史站点迁移、资产认领、v1 redirect 或 v1 route 接管；v1 站点继续按原域名访问。

## 当前普通 Workers API 与 Workers for Platforms 的差异

| 维度     | 当前普通 Workers API                                         | v2 Workers for Platforms                                                      |
| -------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| 用户代码 | 每个站点是一个 account-level Worker script，例如 `pages-foo` | 每个站点是 dispatch namespace 中的 user Worker                                |
| 路由     | 每个站点维护独立 route，例如 `foo.workers.xd.team/*`         | `*.pages.xd.team` wildcard route 进入 `pages-router`，由 router 动态 dispatch |
| 鉴权     | 分散在生成 Worker、用户 Worker 或 IP allowlist 中            | 统一在 `pages-router` 做 visibility、SSO、ACL 和 header 注入                  |
| 审计     | 管理操作容易审计，子站访问审计分散                           | router 统一记录访问审计，控制面记录管理审计                                   |
| 隔离     | 每站 Worker 独立，但平台治理分散                             | user Worker 作为不可信租户代码运行在 dispatch namespace                       |
| 扩展性   | 站点数量增加时 route/script 管理成本上升                     | 更适合大量用户 Worker 和平台化治理                                            |
| 快路径   | 请求直接进站点 Worker；若要统一 SSO，需每站包装或中心转发    | 请求进 router，本地验 session 后动态 dispatch，不回管理 API                   |

## 核心术语

后续 schema、JWT、header、CLI 和 `.pages.json` 统一使用这些名字：

| 术语         | 含义                                               | 是否可变 | 是否可作为安全边界 |
| ------------ | -------------------------------------------------- | -------- | ------------------ |
| `slug`       | 用户可见站点名，例如 `foo`                         | 可变     | 否                 |
| `siteId`     | 平台内部站点主键，例如 `site_xxx`                  | 不可变   | 可用于授权关系     |
| `siteUuid`   | 站点数据隔离锚点，删除后重建必须变化               | 不可变   | 是                 |
| `routeId`    | 某个 hostname 到站点版本的路由记录                 | 不可变   | 可用于审计         |
| `versionId`  | 一次 immutable 发布版本                            | 不可变   | 可用于回滚和审计   |
| `workerName` | WFP dispatch namespace 中的 user Worker 运行时名字 | 可派生   | 否，需结合 route   |

文档里出现 `site` 时，如果是用户输入或 CLI 展示，应理解为 `slug`；如果是服务端授权、审计或存储隔离，必须显式写 `siteId` 或 `siteUuid`。实现中不能把 `slug` 当作 KV/R2/D1 数据隔离锚点。

## 目标目录

建议 v2 新建目录；现有 `apps/server` 继续作为 v1 控制面，不参与 v2 请求路径：

```text
apps/
  server/            # v1 管理 API，继续服务 *.workers.xd.team
  pages-api/         # v2 控制面 API：deploy/list/site/version/access/audit
  pages-auth/        # v2 SSO 与 session：OAuth callback、CLI login、access key
  pages-router/      # v2 数据面入口：*.pages.xd.team + WFP dynamic dispatch
  kv-gateway/        # 继续作为平台 KV 能力网关

packages/
  auth/              # cookie、session JWT、SSO profile、ACL 校验
  runtime-contract/  # Gateway -> User Worker 的内部 JWT/header contract
  wfp-client/        # Workers for Platforms API 封装
  audit/             # 审计事件 schema 和脱敏 helper
```

目录名可以在实现阶段微调，但边界不要混在一个大 Worker 中。

## 总体架构

```mermaid
flowchart TD
  CLI["pages CLI / Agent"] --> API["apps/pages-api<br/>Control Plane"]
  Browser["Browser"] --> Router["apps/pages-router<br/>Data Plane"]
  Router --> Auth["apps/pages-auth<br/>SSO / Session"]
  API --> Auth
  API --> WFP["Cloudflare WFP API<br/>Dispatch Namespace"]
  Router --> Dispatch["Dispatch Namespace Binding"]
  Dispatch --> UserWorker["User Worker<br/>untrusted code"]
  UserWorker --> KV["apps/kv-gateway<br/>Capability Gateway"]
  API --> Authority["D1 Authority<br/>sites / routes / versions / ACL"]
  Router --> Snapshot["KV / Cache<br/>compiled route snapshot"]
  Snapshot --> Authority
  Auth --> DO["Durable Objects<br/>session / oauth / cli coordination"]
  DO --> Authority
  API --> Audit["D1 / analytics<br/>audit index"]
  Router --> Audit
```

### 控制面

`pages-api` 只处理管理类请求：

- 发布站点、创建版本、回滚版本。
- 查询站点、删除站点、设置可见性和 ACL。
- 生成、吊销和轮换 CLI token / access key。
- 写管理审计。
- 调用 Cloudflare Workers for Platforms API 部署 user Worker。

控制面可以被 CLI、agent 或未来管理 UI 调用。控制面请求必须有强认证，不能再依赖 `X-Pages-Token`。

### 认证面

`pages-auth` 处理平台身份：

- 接入心动 SSO OAuth authorization code flow。
- 用服务端保存的 `clientSecret` 换取 SSO `access_token`。
- 调用 SSO profile 接口获取用户身份。
- 签发平台 `auth_session`、站点 `site_session`、CLI login result。
- 管理 access key；service token 作为后续机器人身份单独设计。

`clientSecret` 只能存在于 Worker secret 或安全配置中，不能进入浏览器、CLI、用户 Worker、日志或公开文档。

### 数据面

`pages-router` 是子站访问入口：

- 绑定 `*.pages.xd.team`。
- 按 hostname 查找站点 metadata 和当前 active version。
- 根据站点 visibility 判断是否需要登录。
- 本地校验站点 session，不回 `pages-api`。
- 为 user Worker 注入短期内部认证 JWT 和可信用户上下文。
- 清洗请求中的平台保留 header。
- 调用 dispatch namespace 中的 user Worker。
- 清洗 user Worker 返回的响应，防止覆盖平台 cookie/header。
- 写访问审计或采样审计。

### 执行面

用户上传的 Worker 代码部署到 Workers for Platforms dispatch namespace。平台通过 `pages-router` 动态选择 user Worker。

用户 Worker 默认不可信：

- 不持有平台 SSO token。
- 不持有 Cloudflare API token。
- 不持有全局 KV/R2/D1 binding。
- 不可信任浏览器传入的 `CF-Platform-*` / `X-Pages-*` header。
- 如需平台能力，通过受限 binding、gateway 或 capability 使用。

## Cloudflare 资源模型

### production

```text
pages-api
pages-auth
pages-router
pages-kv-gateway
dispatch namespace: pages-production
D1 authority: production pages metadata
Durable Objects: production auth/session coordination
KV/cache: production router snapshots
audit store: production audit
system API: api.pages.xd.team
system auth: auth.pages.xd.team
site domain: {name}.pages.xd.team
```

### staging

```text
pages-api-staging
pages-auth-staging
pages-router-staging
pages-kv-gateway-staging
dispatch namespace: pages-staging
D1 authority: staging pages metadata
Durable Objects: staging auth/session coordination
KV/cache: staging router snapshots
audit store: staging audit
system API: api-staging.pages.xd.team
system auth: auth-staging.pages.xd.team
site domain: {name}-staging.pages.xd.team
```

staging 与 production 必须继续物理隔离：

- 不同 Worker 名称。
- 不同 dispatch namespace。
- 不同 KV/D1/R2。
- 不同 signing key。
- 不同 SSO redirect URI。
- production 不允许 push/PR 自动部署。

默认路由方案也必须物理隔离：

```text
api.pages.xd.team/*             -> pages-api
auth.pages.xd.team/*            -> pages-auth
api-staging.pages.xd.team/*     -> pages-api-staging
auth-staging.pages.xd.team/*    -> pages-auth-staging
*.pages.xd.team/*               -> pages-router
*-staging.pages.xd.team/*       -> pages-router-staging
```

`pages-router` 只能绑定 production D1/KV/DO、production dispatch namespace 和 production signing key；`pages-router-staging` 只能绑定 staging 资源。业务 router 不允许同时持有两套环境的权威存储、dispatch namespace 或 signing secret。

## 资源申请与环境配置

v2 上线前需要把 Cloudflare 资源、心动 SSO 应用和 GitHub Actions 配置一次性梳理清楚。文档、代码和 CI 中只能出现占位名称，不能写真实 account id、zone id、namespace id、client secret 或 token。

### Cloudflare 资源申请清单

production 和 staging 分开申请或创建：

| 类型                       | production                                                    | staging                                                                                       | 说明                                          |
| -------------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Workers                    | `pages-api`、`pages-auth`、`pages-router`、`pages-kv-gateway` | `pages-api-staging`、`pages-auth-staging`、`pages-router-staging`、`pages-kv-gateway-staging` | 系统 Worker 物理隔离                          |
| WFP dispatch namespace     | `pages-production`                                            | `pages-staging`                                                                               | 用户 Worker 隔离                              |
| D1 database                | `pages_metadata_production`                                   | `pages_metadata_staging`                                                                      | 权威业务库                                    |
| KV namespace               | `pages_router_cache_production`                               | `pages_router_cache_staging`                                                                  | route/policy/JWKS snapshot                    |
| KV namespace               | `pages_site_data_production`                                  | `pages_site_data_staging`                                                                     | Pages KV 站点数据                             |
| Durable Object namespaces  | production bindings                                           | staging bindings                                                                              | OAuth、CLI login、session、policy 协调        |
| Routes / custom domains    | `api.pages.xd.team`、`auth.pages.xd.team`、`*.pages.xd.team`  | `api-staging.pages.xd.team`、`auth-staging.pages.xd.team`、`*-staging.pages.xd.team`          | 新建 v2 route，不修改 v1 `workers.xd.team`    |
| Advanced certificate / DCV | `*.pages.xd.team`                                             | 同证书覆盖或独立策略                                                                          | 参考 partial zone 约束，单独验证 `pages` 子域 |

需要在阶段 0 做 Cloudflare route / DNS / certificate spike，验证 `pages` 与 `*.pages` CNAME、DCV 和 `*-staging.pages.xd.team/*` route 优先级。该 spike 只能新增 `pages.xd.team` 相关资源，不能修改 v1 `workers.xd.team` DNS、证书或 route。

如果 Cloudflare route 层无法独立匹配 staging 子站，fallback 只能是一个无业务 secret 的 `pages-edge-router-thin`：

```text
*.pages.xd.team/* -> pages-edge-router-thin
  foo.pages.xd.team         -> service binding: pages-router
  foo-staging.pages.xd.team -> service binding: pages-router-staging
```

`pages-edge-router-thin` 只做 hostname 解析和 service binding 转发，不持有 D1/KV/DO、dispatch namespace、session/internal signing key、Cloudflare API token 或 SSO secret。它的 L1 cache 只能缓存“hostname -> target service”这类非敏感分流结果，且 production/staging target 必须有 fail-closed 测试覆盖。

### 心动 SSO 应用配置

production、staging 和 local 建议使用三个独立 SSO 应用，至少也要使用三组独立 redirect URI。OAuth 入口和 callback 都应落到 `pages-auth`，不能落到 `pages-api`，否则控制面会被迫持有 SSO client secret 和 session signing secret。

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

本地开发使用单独的 local SSO 应用：

```text
local app:
  应用名称：xd_pages_local
  用户访问入口：http://xd-pages.127.0.0.1.nip.io:8787/.xd-pages/auth/authorize
  SSO认证重定向地址：http://xd-pages.127.0.0.1.nip.io:8787/.xd-pages/auth/callback
```

local SSO 的 `SSO_CLIENT_ID` 和 `SSO_CLIENT_SECRET` 只能放本地 ignored env，例如当前仓库已忽略的 `.env`、`.dev.vars`，或只放 shell 环境变量；不得写入本文档、Git、CLI config、`.pages.json` 或测试快照。若使用 `.env.local`、`.dev.vars.local` 等新文件名，必须先确认它们已被 `.gitignore` 覆盖。若本地调试凭证曾被公开粘贴到 issue、PR、聊天记录或日志，应按公司规范轮换。

本地联调可以先使用公司分配的 OAuth local app。建议只在本机 shell 或已被 `.gitignore` 覆盖的 `.dev.vars` 中配置真实值：

```bash
export PAGES_ENV=local
export PUBLIC_AUTH_BASE=http://xd-pages.127.0.0.1.nip.io:8787
export SSO_REDIRECT_URI=http://xd-pages.127.0.0.1.nip.io:8787/.xd-pages/auth/callback
export SSO_CLIENT_ID=<local-sso-client-id>
export SSO_CLIENT_SECRET=<local-sso-client-secret>
```

`xd-pages.127.0.0.1.nip.io` 用于让 OAuth redirect URI 具备稳定 host，同时仍解析到本机 `127.0.0.1`。本地 callback 路径也统一使用平台保留路径 `/.xd-pages/auth/callback`，避免和用户站点路由冲突。M2 代码当前只实现 production/staging 的 host 校验；接入 local SSO 前需要补齐 `PAGES_ENV=local` 的 host allowlist 和 cookie/session 测试，或明确本地只使用 mock SSO。

需要配置：

```text
SSO_CLIENT_ID
SSO_CLIENT_SECRET
SSO_AUTHORIZATION_URL
SSO_TOKEN_URL
SSO_PROFILE_URL
SSO_REDIRECT_URI
SSO_ALLOWED_USER_SCOPE
```

`SSO_CLIENT_SECRET` 必须是 Worker secret / GitHub Environment Secret，不能放 `vars`、wrangler template、CLI config 或文档示例。

### Worker bindings

#### pages-api

```text
vars:
  PAGES_ENV
  PUBLIC_API_BASE
  PUBLIC_AUTH_BASE
  PUBLIC_SITE_SUFFIX
  ROUTER_CACHE_KV_BINDING_NAME
  WFP_DISPATCH_NAMESPACE
  AUTH_JWKS_URL
  ROUTER_JWKS_URL

bindings:
  D1: PAGES_METADATA
  KV: ROUTER_CACHE
  service: PAGES_AUTH
  service: PAGES_ROUTER

secrets:
  CF_API_TOKEN
  CLOUDFLARE_ACCOUNT_ID
  CLOUDFLARE_ZONE_ID
```

`CF_API_TOKEN` 是 `pages-api` 运行时调用 Cloudflare API / Workers for Platforms API 的 Worker secret，不得注入 user Worker。`CLOUDFLARE_API_TOKEN` 只用于 Wrangler / GitHub Actions 部署，不能作为 Worker runtime secret 注入。

`pages-api` 不能持有 `auth_session`、`site_session` 或 `internal_worker_jwt` 的 signing secret。控制面如需校验用户态 token，只能使用 verify-only JWKS / public key，或通过 `PAGES_AUTH` service binding 完成一次性 code / session 校验；不能在 API Worker 中签发子站 session 或 router internal JWT。

#### pages-auth

```text
vars:
  PAGES_ENV
  PUBLIC_AUTH_BASE
  PUBLIC_API_BASE
  SESSION_SIGNING_ACTIVE_KID
  SESSION_SIGNING_KEYS
  SSO_AUTHORIZATION_URL
  SSO_TOKEN_URL
  SSO_PROFILE_URL
  SSO_REDIRECT_URI

bindings:
  D1: PAGES_METADATA
  Durable Objects: OAUTH_STATE, CLI_LOGIN, USER_SESSION

secrets:
  SSO_CLIENT_ID
  SSO_CLIENT_SECRET
  SESSION_SIGNING_SECRET_*
```

`SSO_CLIENT_ID` 是否作为 secret 取决于公司规范；如果不敏感可放 vars，但保持 secret 更保守。

#### pages-router

```text
vars:
  PAGES_ENV
  PUBLIC_AUTH_BASE
  PUBLIC_API_BASE
  PUBLIC_SITE_SUFFIX
  ROUTE_CACHE_TTL_SECONDS
  ROUTER_IP_ALLOWLIST_CIDRS
  INTERNAL_JWT_ACTIVE_KID
  INTERNAL_JWT_KEYS
  SESSION_SIGNING_ACTIVE_KID
  SESSION_SIGNING_KEYS

bindings:
  D1: PAGES_METADATA
  KV: ROUTER_CACHE
  dispatch namespace: PAGES_DISPATCH
  service: PAGES_AUTH
  Durable Objects: SITE_POLICY, USER_SESSION

secrets:
  INTERNAL_JWT_SECRET_*
  SESSION_SIGNING_SECRET_*
```

router 不需要 Cloudflare API token。router 只能 dispatch 到当前环境的 namespace。`ROUTER_IP_ALLOWLIST_CIDRS` 是第一版强制配置；缺失或格式错误时 router 必须 fail closed。

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

沿用现有 capability key registry 思路，但 production/staging 必须使用不同 key registry 和不同 secret。

### GitHub Actions 配置

GitHub Environments 应至少有：

```text
staging
production
```

`vars` 只放非敏感配置：

```text
PAGES_ENV
PUBLIC_API_BASE
PUBLIC_AUTH_BASE
PUBLIC_SITE_SUFFIX
ROUTER_IP_ALLOWLIST_CIDRS
SESSION_SIGNING_ACTIVE_KID
SESSION_SIGNING_KEYS
INTERNAL_JWT_ACTIVE_KID
INTERNAL_JWT_KEYS
PAGES_CAP_JWT_ACTIVE_KID
PAGES_CAP_JWT_KEYS
SSO_AUTHORIZATION_URL
SSO_TOKEN_URL
SSO_PROFILE_URL
SSO_REDIRECT_URI
```

`secrets` 放所有敏感配置和真实资源 id：

```text
CLOUDFLARE_ACCOUNT_ID
CLOUDFLARE_ZONE_ID
CLOUDFLARE_API_TOKEN
CF_API_TOKEN
SSO_CLIENT_ID
SSO_CLIENT_SECRET
SESSION_SIGNING_SECRET_*
INTERNAL_JWT_SECRET_*
PAGES_CAP_JWT_SECRET_*
D1_DATABASE_ID_*
KV_NAMESPACE_ID_*
DO_NAMESPACE_ID_*
WFP_DISPATCH_NAMESPACE
```

如果公司规范认为 Cloudflare account id、zone id、D1/KV id 非 secret，也仍建议在本 public repo 标准下放 GitHub Environment Secret，避免公开输出真实资源标识。

### 配置校验

部署脚本必须 fail closed：

- production workflow 只能手动触发。
- staging workflow 可以由 `staging` 分支触发。
- `PAGES_ENV=production` 时，API/auth/site suffix 必须是 production 域名。
- `PAGES_ENV=staging` 时，API/auth/site suffix 必须是 staging 域名。
- signing key registry 中的 active kid 必须能找到对应 secret。
- `WFP_DISPATCH_NAMESPACE` 必须与 `PAGES_ENV` 匹配，不能 staging/prod 串用。
- D1、KV、Durable Object binding 必须指向当前环境资源。
- `ROUTER_IP_ALLOWLIST_CIDRS` 必须存在、可解析、只包含公司批准的内网/VPN/办公出口 CIDR；缺失时部署或启动必须 fail closed。
- `CF_API_TOKEN` 只能注入 `pages-api` runtime；`CLOUDFLARE_API_TOKEN` 只能出现在 GitHub Actions / Wrangler 部署环境。
- `pages-router` 和 `pages-router-staging` 的 wrangler 配置不能同时出现两套环境 binding 或两套 signing key。
- 如果启用 `pages-edge-router-thin`，它只能配置 service binding，不能配置 D1/KV/DO、dispatch namespace 或 signing secret。
- Worker 生成的 wrangler 配置不能残留 `__PLACEHOLDER__`。
- `public-docs` 输出的 base URL 必须与当前 Worker 环境一致。

## 存储与一致性模型

v2 不应把 KV 当成站点 metadata 或 session 的唯一事实来源。推荐分层：

```text
D1:
  系统权威业务库，保存 users、sites、routes、versions、ACL、access keys、audit index。

Durable Objects:
  强一致协调点，处理 OAuth state、一次性 code、CLI login、session 刷新/吊销、策略失效协调。

KV:
  编译后的快路径读缓存，例如 route snapshot、policy snapshot、JWKS/public key cache。

Cache / Worker 内存:
  pages-router 的 L1 超短 TTL 缓存，降低同一边缘重复读取。

JWT Cookie:
  快路径本地验签 envelope，不作为不可吊销的唯一权威状态。
```

选择原则：

| 数据类型                           | 权威存储                       | 快路径                 | 说明                              |
| ---------------------------------- | ------------------------------ | ---------------------- | --------------------------------- |
| 用户、站点、版本、成员、ACL        | D1                             | KV snapshot + L1 cache | 关系型数据，需要查询和审计        |
| 路由表、active version、visibility | D1                             | route snapshot         | 权限相关，KV 只做缓存             |
| OAuth state、一次性 code           | Durable Objects                | 无                     | 必须防重放、单次消费              |
| CLI login polling                  | Durable Objects                | 无                     | 同一 login transaction 需要强一致 |
| auth/session 刷新与吊销            | Durable Objects + D1 index     | JWT 本地验签           | DO 协调，D1 记录索引和审计        |
| JWKS / public signing keys         | D1 或配置                      | KV / Cache             | 可缓存，靠 `kid` 轮换             |
| 审计事件                           | D1 index + 后续 analytics sink | 可异步批量写           | 禁止写入 secret 和 token          |

### D1 权威表

以下是逻辑 schema，字段类型在实现建表脚本时再细化。约定：

- 主键使用不暴露内部含义的 ID，例如 `usr_`、`site_`、`route_`、`ver_`、`dep_`。
- 时间统一存 ISO string 或 epoch milliseconds，但同一个库内必须一致。
- CLI token 和 access key 只存 hash，不存明文。
- JSON 字段只放低频变更或结构不稳定的扩展信息；核心查询字段必须列化。

#### users

```sql
users
  id                  -- usr_xxx
  sso_subject         -- 心动 SSO 稳定用户标识
  email
  name
  employee_status     -- active / disabled / left / unknown
  session_version     -- 用户级 session 失效版本
  last_login_at
  created_at
  updated_at
```

`sso_subject` 应优先使用 SSO profile 中稳定且不可复用的用户 ID。如果只能拿到邮箱，需要在风险清单中标记“邮箱复用/变更”问题。

#### sites

```sql
sites
  id                  -- site_xxx
  slug                -- 用户可见站点名
  owner_user_id
  default_visibility  -- public / org / acl / owner
  site_uuid           -- 存储隔离锚点，删除后重建必须变化
  created_at
  updated_at
  deleted_at
```

`slug` 可变或可复用，不能作为数据隔离锚点；`site_uuid` 用于 KV/R2/D1 等站点数据隔离。

#### site_routes

```sql
site_routes
  id                  -- route_xxx
  hostname            -- foo.pages.xd.team
  site_id
  environment         -- production / staging
  runtime             -- wfp / disabled
  worker_name         -- WFP user worker name
  active_version_id
  visibility          -- public / org / acl / owner / disabled
  policy_version
  route_generation    -- active version / workerName 切换代数
  route_status        -- active / disabled / deleted
  cache_tier          -- fast / sensitive / strict
  created_at
  updated_at
```

`site_routes` 是 router 的权威解析表。`visibility` 和 `policy_version` 属于安全边界字段，不能只存在 KV snapshot。

#### site_versions

```sql
site_versions
  id                  -- ver_xxx
  site_id
  deployment_id
  worker_name
  runtime             -- wfp
  artifact_kind       -- static / spa / worker
  artifact_ref        -- WFP script id 或 R2 prefix
  content_hash
  created_by
  created_at
```

版本记录必须 immutable。回滚只更新 `site_routes.active_version_id`，不修改历史 version 内容。

#### deployments

```sql
deployments
  id                  -- dep_xxx
  site_id
  version_id
  actor_user_id
  actor_type          -- user / access_key / system
  source              -- cli / agent / api
  visibility
  status              -- pending / uploaded / verified / activating / succeeded / failed / rolled_back
  idempotency_key
  idempotency_scope   -- env + actor/access_key + site_id + operation
  request_hash        -- canonical request hash
  terminal_response_json
  previous_version_id
  error_code
  error_message
  created_at
  completed_at
```

部署记录用于审计和故障排查。`error_message` 必须脱敏，不能保存 Cloudflare token、capability 或用户上传内容。

幂等性规则：

- 唯一键为 `(environment, actor_id 或 access_key_id, site_id, operation, idempotency_key)`。
- 首次请求保存 canonical request hash。
- 同 key + 同 hash：如果已有终态，重放 terminal response；如果非终态，返回同一个 deployment。
- 同 key + 不同 hash：返回 409，不能创建新 version 或新 deployment。
- deploy 和 rollback 都必须遵守该规则。

#### site_members

```sql
site_members
  site_id
  user_id
  role                -- owner / collaborator / viewer
  created_by
  created_at
```

`owner` 至少保留一名。删除 owner 或转移 owner 属于高风险操作，需要 recent login。

#### site_acl_entries

```sql
site_acl_entries
  id                  -- acl_xxx
  site_id
  subject_type        -- user / email / group / department
  subject_value       -- user id、邮箱、外部 group id 或 department id
  access_role         -- viewer / editor
  effect              -- allow；第一版不支持 deny
  created_by
  created_at
```

第一版 ACL 采用 allow-only + OR 叠加：

```text
allow if:
  user.id in ACL(user)
  OR user.email in ACL(email)
  OR user.groups intersects ACL(group)
  OR user.departments intersects ACL(department)
```

同一站点可添加多条 ACL entry，例如“指定多个人”或“指定人 + 部门”。命中任意一条 allow entry 即可访问；没有命中则拒绝。

第一版不支持 `deny`、排除用户、`AND` 条件、部门内角色条件、嵌套表达式或策略语言。如果没有组织/群组接口，可以只启用 `user` 和 `email`；`group`、`department` 先保留 schema，不阻塞 MVP。

`group` / `department` 只有在组织系统能提供稳定、不可复用 ID、成员快照版本和可控刷新 TTL 后才启用。启用后，成员变更必须能触发 `policyVersion` 或 `sessionVersion` 失效；否则仍只允许 `user` / `email`。

#### access_keys

```sql
access_keys
  id                  -- ak_xxx
  owner_user_id
  key_hash
  name
  scopes              -- JSON array，例如 ["deploy:site"]
  site_id             -- null 表示用户级 key；非 null 表示限定站点
  expires_at
  last_used_at
  revoked_at
  created_at
```

access key 明文只在创建时显示一次，之后只存 hash。key 的 scope 和 site 限制必须在 `pages-api` 权威校验，不能只靠 CLI 自觉。

access key 生成与存储规则：

- 使用 CSPRNG 生成至少 192-bit 随机值。
- 明文格式可以带非敏感前缀和环境提示，例如 `xdp_prod_...`、`xdp_stg_...`，但服务端不能只靠前缀判权。
- 存储使用 HMAC-SHA-256 + server-side pepper，并记录 `pepper_id` 以支持轮换。
- 校验使用常量时间比较。
- 默认创建 site-scoped + expiry 的 key；user-level key 需要 recent login、显式确认和强审计。

#### auth_sessions_index

```sql
auth_sessions_index
  sid
  user_id
  issued_at
  last_seen_at
  expires_at
  absolute_expires_at
  revoked_at
  auth_time
  user_agent_hash
  ip_hash
```

D1 中的 session index 用于查询、审计和批量吊销。实际刷新/吊销竞争由 Durable Object 协调。

#### audit_events

```sql
audit_events
  id                  -- aud_xxx
  trace_id
  event_type
  actor_user_id
  actor_type          -- user / access_key / system / anonymous
  site_id
  route_id
  version_id
  decision            -- allow / deny / redirect / error
  status_code
  ip_hash
  user_agent_hash
  metadata_json       -- 脱敏扩展字段
  created_at
```

`audit_events` 可以先作为 D1 index，后续再接入专门的 analytics sink。D1 中只保留便于检索和关联的字段，事件 body 必须脱敏。

### Durable Object 状态

Durable Objects 不存大批量业务数据，只处理强一致协调。

#### OAuthStateDO

Object id：

```text
oauth_state:{state_id}
```

状态：

```json
{
  "stateId": "st_xxx",
  "returnTo": "https://foo.pages.xd.team/path",
  "siteHost": "foo.pages.xd.team",
  "createdAt": "2026-06-15T00:00:00.000Z",
  "expiresAt": "2026-06-15T00:10:00.000Z",
  "consumedAt": null
}
```

用途：

- 防 CSRF。
- 绑定 `return_to`。
- 保证 OAuth callback 只消费一次。

#### CliLoginDO

Object id：

```text
cli_login:{login_id}
```

状态：

```json
{
  "loginId": "login_xxx",
  "loginSecretHash": "sha256:...",
  "deviceCodeHash": "sha256:...",
  "requestedScopes": ["deploy:site"],
  "environment": "production",
  "status": "pending",
  "userId": null,
  "pollAttempts": 0,
  "createdAt": "2026-06-15T00:00:00.000Z",
  "expiresAt": "2026-06-15T00:10:00.000Z",
  "completedAt": null,
  "consumedAt": null
}
```

用途：

- CLI `pages login` 轮询。
- 浏览器 SSO 成功后写入登录结果。
- CLI 领取 token 后标记 `consumedAt`，防止重复领取。

CLI login 必须使用 `login_id + login_secret` 双值模型。`login_id` 可以出现在浏览器 URL 和轮询路径中；`login_secret` 只保存在 CLI 进程内，用于 poll/consume 时证明请求方就是发起登录的 CLI。服务端只保存 `loginSecretHash`，比较时使用常量时间比较。登录结果只能领取一次，TTL 建议 5-10 分钟，并对 poll/consume 失败次数限流和审计。

为防止攻击者生成登录链接诱导他人授权，CLI login 还必须有 device confirmation：

- CLI 在终端显示短码，例如 `ABCD-1234`，并展示 environment、auth host 和请求 scope。
- 浏览器 SSO 成功后，页面必须明确提示“正在授权 pages CLI”，并要求用户确认同一个短码、environment、auth host 和 scope。
- 用户未确认短码前，`CliLoginDO` 不能写入 completed user，也不能让 CLI 领取 token。
- 后续如果改成本机 loopback callback，也应配合 PKCE / nonce，把浏览器回调绑定到本地 CLI。

#### UserSessionDO

Object id：

```text
user_session:{user_id}
```

状态：

```json
{
  "userId": "usr_xxx",
  "sessionVersion": 3,
  "revokedBefore": "2026-06-15T00:00:00.000Z",
  "recentAuthTime": "2026-06-15T00:00:00.000Z"
}
```

用途：

- 协调 `auth_session` 刷新。
- 用户被禁用或管理员踢下线时 bump `sessionVersion`。
- 判断高风险操作是否满足 recent login。

#### SitePolicyDO

Object id：

```text
site_policy:{site_id}
```

状态：

```json
{
  "siteId": "site_xxx",
  "policyVersion": 12,
  "strictUntil": null,
  "lastInvalidatedAt": "2026-06-15T00:00:00.000Z"
}
```

用途：

- 协调站点 ACL / visibility / disabled 变更。
- 对 `disabled`、封禁等 strict 事件提供权威校验入口。
- 避免多个并发管理操作生成错乱的 `policyVersion`。

D1 是 `site_routes.policy_version`、`route_generation` 和最终 access policy 的 source of truth。`SitePolicyDO` 只做并发 lock / lease、短期 strict flag 和失效协调；如果 DO 状态与 D1 不一致，以 D1 为准，并由 reconciliation job 重建 DO / KV snapshot。

### KV 与 Cache 数据结构

KV key 必须带环境前缀，避免 staging/prod 串环境：

```text
{env}:route_pointer:{hostname}
{env}:route_snapshot:{hostname}
{env}:route_snapshot:{route_id}:{route_generation}
{env}:policy_snapshot:{site_id}:{policy_version}
{env}:jwks:{kid}
```

#### route snapshot

```json
{
  "schemaVersion": 1,
  "hostname": "foo.pages.xd.team",
  "siteId": "site_123",
  "siteUuid": "su_123",
  "slug": "foo",
  "routeId": "route_123",
  "environment": "production",
  "runtime": "wfp",
  "workerName": "foo_v42",
  "activeVersionId": "ver_42",
  "visibility": "org",
  "policyVersion": 12,
  "routeGeneration": 42,
  "strictUntil": null,
  "staleUntil": "2026-06-15T00:02:00.000Z",
  "tombstoneGeneration": null,
  "routeStatus": "active",
  "cacheTier": "fast",
  "updatedAt": "2026-06-15T00:00:00.000Z"
}
```

staging snapshot 必须使用 staging hostname 和 `environment=staging`，例如 `foo-staging.pages.xd.team`。router 发现 hostname 后缀与 snapshot environment 不一致时必须拒绝。

为了让发布 / 回滚的 generation 可比较，route snapshot 采用两层 key：

```text
{env}:route_pointer:{hostname} -> { routeId, routeGeneration, snapshotKey, updatedAt }
{env}:route_snapshot:{routeId}:{routeGeneration} -> immutable snapshot body
```

router 的 L1 cache 必须缓存 pointer 和 snapshot。发布或回滚时先写 immutable snapshot，再用 D1 transaction / CAS 更新 `site_routes.route_generation`，最后写 route pointer。router 发现 pointer generation 大于 L1 snapshot generation 时，必须刷新 snapshot；pointer 缺失或 malformed 时按故障矩阵 fail closed 或查 D1。

#### policy snapshot

```json
{
  "schemaVersion": 1,
  "siteId": "site_123",
  "policyVersion": 12,
  "visibility": "acl",
  "allowedUsers": ["usr_123"],
  "allowedEmails": ["user@example.com"],
  "allowedGroups": [],
  "updatedAt": "2026-06-15T00:00:00.000Z"
}
```

第一版应控制 policy snapshot 大小。如果 ACL 很大，router 应走 `sensitive` 或 `strict` 路径查 D1/DO，不把大量成员列表塞进 KV。

#### L1 memory cache

`pages-router` 进程内可以缓存：

```text
route snapshot: 5-30 秒
public signing keys: 5-10 分钟
negative route lookup: 5-30 秒
```

L1 cache 不可作为权限依据，只是减少同一边缘反复读 KV/D1。

### Cookie 与 JWT 数据结构

#### auth_session cookie

Claims：

```json
{
  "iss": "https://auth.pages.xd.team",
  "aud": "pages:production",
  "sid": "sid_xxx",
  "sub": "usr_xxx",
  "sessionVersion": 3,
  "authTime": 1780000000,
  "iat": 1780000000,
  "exp": 1782592000
}
```

#### site_session cookie

Claims：

```json
{
  "iss": "https://router.pages.xd.team",
  "aud": "site:foo.pages.xd.team",
  "sid": "ssid_xxx",
  "sub": "usr_xxx",
  "site": "site_123",
  "route": "route_123",
  "policyVersion": 12,
  "sessionVersion": 3,
  "iat": 1780000000,
  "exp": 1780604800
}
```

#### internal_worker_jwt

Claims：

```json
{
  "iss": "https://router.pages.xd.team",
  "aud": "worker:foo.pages.xd.team",
  "sub": "usr_xxx",
  "email": null,
  "profileDisclosure": "minimal",
  "site": "site_123",
  "route": "route_123",
  "version": "ver_42",
  "roles": ["viewer"],
  "iat": 1780000000,
  "exp": 1780000060,
  "trace_id": "tr_xxx"
}
```

JWT 只使用占位示例。真实 token、真实用户邮箱和真实 signing secret 不得写入文档、测试或日志。

JWT 验证清单：

- 必须校验 `iss`、`aud`、`exp`、`nbf`/`iat`、`kid`、签名算法和环境绑定。
- `iss` 应使用环境相关 issuer，例如 `https://auth.pages.xd.team`、`https://router.pages.xd.team`、`https://auth-staging.pages.xd.team` 或 `https://router-staging.pages.xd.team`，不能只校验短字符串。
- `aud` 必须绑定用途和 host，例如 `pages:production`、`site:foo.pages.xd.team`、`worker:foo.pages.xd.team`。
- `kid` 必须来自当前环境 key registry；production token 不能被 staging key 验证，反之亦然。
- 高风险一次性 token 或能力 token 应包含 `jti`，用于审计、限流或必要时吊销。

`auth_session` 由 `pages-auth` 签发，`site_session` 和 `internal_worker_jwt` 由 `pages-router` 签发。三者可以共享 key registry 结构，但必须通过 `iss`、`aud`、`kid` 和环境绑定区分用途，不能让某类 token 被另一类 token 的校验逻辑接受。

`internal_worker_jwt` 默认不包含真实邮箱、姓名、部门名等直接 PII。User Worker 默认只能拿到稳定但不暴露身份细节的 `sub` / scoped user id。只有站点显式启用 profile disclosure scope，且访问策略允许时，router 才能注入邮箱等 profile 字段，并必须在 route snapshot、审计和 SDK contract 中记录该披露级别。

### Router 读取路径

`site_routes` 是权威路由表。`pages-router` 通过 hostname 解析 route，但不应每个请求都查 D1。发布或策略变更后，`pages-api` 生成 `route_snapshot:{hostname}`，结构见上文 `KV 与 Cache 数据结构`。

router 查找顺序：

```text
1. L1 memory cache 中的 route pointer + snapshot，TTL 5-30 秒
2. KV route pointer，再读 pointer 指向的 immutable route snapshot
3. D1 site_routes 权威表
```

KV snapshot 只能加速读取，不能成为权限和路由的唯一来源。权限敏感字段必须以 D1 为权威。

### 缓存失效

核心靠版本号，不靠“删除所有缓存”：

```text
site.policyVersion
user.sessionVersion
accessKey.version
jwks.kid
```

写入顺序必须是：

```text
1. 先提交 D1 / Durable Object 权威变更。
2. 再生成新的 immutable KV route snapshot / policy snapshot。
3. 再写 route pointer 指向新的 routeGeneration。
4. 最后让 router L1 cache 自然过期，或对 strict 事件触发主动刷新。
```

例子：用户被移出 ACL。

```text
1. pages-api 在 D1 更新 site_members。
2. pages-api 将 site_routes.policy_version += 1。
3. pages-api 写入新的 immutable route snapshot。
4. pages-api 写入新的 route pointer。
5. pages-router 的旧 L1 snapshot 最多在 TTL 窗口内存在。
6. 旧 site_session 中的 policyVersion 与新 pointer/snapshot 不匹配时，router 要求重新鉴权或拒绝。
```

站点 `disabled`、删除、封禁和 access key 吊销属于更敏感操作。它们应在 D1/DO 写入成功后立即写入 tombstone pointer 或 bump `strictUntil`，让 router 不再使用旧 snapshot；如业务要求接近实时生效，router 对这些状态走 strict check，直接查 D1 或 DO。

### 一致性等级

不同路径允许不同一致性成本：

| 等级        | 适用场景                                   | 一致性策略                                |
| ----------- | ------------------------------------------ | ----------------------------------------- |
| `fast`      | 普通 `public` / `org` 页面访问             | 本地 JWT + L1/KV snapshot，允许短传播窗口 |
| `sensitive` | `acl` / `owner` 站点访问                   | 更短 snapshot TTL，版本不匹配时强制刷新   |
| `strict`    | disabled、删除、封禁、access key 创建/吊销 | 直接查 D1/DO，不能只信缓存                |

目标不是让所有子站请求都强一致，而是把强一致成本用在会影响安全边界的路径上。

### 故障处理矩阵

router 遇到缓存、权威存储或 dispatch 异常时，必须按 cache tier 明确处理，不能由实现者临场决定：

| 场景                         | `fast`                                               | `sensitive`                        | `strict`                 |
| ---------------------------- | ---------------------------------------------------- | ---------------------------------- | ------------------------ |
| L1 miss                      | 读 KV / D1                                           | 读 KV / D1                         | 读 D1/DO                 |
| KV miss                      | 查 D1 并回填 snapshot                                | 查 D1 并回填 snapshot              | 查 D1/DO，不依赖 KV      |
| snapshot 过期但结构合法      | `public` 可短暂 max-stale；`org` 需重新检查 session  | 强制刷新；刷新失败则拒绝或重新登录 | 不使用 stale             |
| pointer generation 领先      | 刷新 snapshot；失败则按 D1/DO 可用性决策             | 强制刷新；失败则拒绝或重新登录     | 查 D1/DO                 |
| tombstone / strictUntil 命中 | 不使用 stale，直接查 D1/DO 或拒绝                    | 不使用 stale，直接查 D1/DO 或拒绝  | 拒绝或查 D1/DO           |
| snapshot malformed           | fail closed                                          | fail closed                        | fail closed              |
| hostname 与 environment 不符 | fail closed                                          | fail closed                        | fail closed              |
| D1/DO 超时                   | `public` 可返回短暂 503 或 max-stale；受保护站点拒绝 | 拒绝或 503，不扩大权限             | 拒绝或 503               |
| dispatch 404 / worker 缺失   | 返回平台 502/503，写审计                             | 返回平台 502/503，写审计           | 返回平台 502/503，写审计 |
| disabled / deleted           | 不 dispatch                                          | 不 dispatch                        | 不 dispatch              |

`max-stale` 只能用于不扩大访问权限的 public 路径，并且必须同时满足 snapshot 未超过 `staleUntil`、没有 tombstone、没有 `strictUntil` 命中、有审计标记和告警指标。任何 malformed、串环境、保留 host/path mismatch 都必须 fail closed。

### 发布与回滚状态机

WFP 发布不能简单理解为“上传 Worker 后写 active version”。推荐状态机：

```text
1. pages-api 校验 actor、scope、site 权限、idempotency key 和 payload limit。
2. D1 创建 deployments(status=pending) 和 immutable site_versions。
3. 上传 user Worker / assets 到目标环境的 WFP dispatch namespace。
4. status=uploaded。
5. 对新 Worker 做最小健康检查或 manifest 校验。
6. status=verified。
7. 先写 immutable route snapshot candidate。
8. 用 D1 transaction / CAS 更新 site_routes:
     active_version_id = newVersion
     worker_name = newWorkerName
     route_generation += 1
     policy_version 按需更新
9. status=activating。
10. 写 route pointer 指向新的 routeGeneration。
11. status=succeeded，返回 url、deploymentId、versionId。
```

失败处理：

- 1-7 失败：保留旧 active version，不改 route pointer。
- 8 成功但 10 失败：以 D1 为权威，后台重建 pointer；router 发现 D1 generation 高于 pointer 时刷新或返回短暂 503。
- 10 成功但 11 失败：deployment 可由 reconciliation job 修正为 `succeeded` 或 `failed_with_active_route`。
- 已上传但未激活的 user Worker / assets 标记为 orphan，延迟 GC，不立即删除，避免误删正在回滚的版本。

回滚不是修改历史 version 内容，而是复用同一套 active route 切换流程，把 `active_version_id` 和 `worker_name` 切回目标 version，并 bump `route_generation`。所有 deploy / rollback 必须写审计。

## 域名和路由

production 和 staging 使用显式环境域名，不通过 query、header 或同一个 API host 切环境：

| 用途               | production             | staging                        |
| ------------------ | ---------------------- | ------------------------------ |
| 控制面 API         | `api.pages.xd.team`    | `api-staging.pages.xd.team`    |
| 认证服务           | `auth.pages.xd.team`   | `auth-staging.pages.xd.team`   |
| 子站域名           | `{name}.pages.xd.team` | `{name}-staging.pages.xd.team` |
| dispatch namespace | `pages-production`     | `pages-staging`                |

长期路由目标：

```text
api.pages.xd.team/*             -> pages-api
auth.pages.xd.team/*            -> pages-auth
api-staging.pages.xd.team/*     -> pages-api-staging
auth-staging.pages.xd.team/*    -> pages-auth-staging
*-staging.pages.xd.team/*       -> pages-router-staging
*.pages.xd.team/*               -> pages-router
```

当前 v1 `workers` 和 `*.workers` DNS / route / certificate 保持不动。v2 需要在 DNSPod 和 Cloudflare 侧新增 `pages` 与 `*.pages` CNAME、证书 DCV、custom domain / route 绑定；所有验证都只针对 `pages.xd.team`，不能改动 `workers.xd.team`。

需要确认 Cloudflare 侧 wildcard route / custom domain 绑定策略：

- `pages-router` 需要稳定接收 production 子站。
- `pages-router-staging` 需要稳定接收 `*-staging.pages.xd.team`。
- `api.pages.xd.team`、`auth.pages.xd.team`、`api-staging.pages.xd.team` 和 `auth-staging.pages.xd.team` 应作为平台保留域名，不能被用户站点占用。
- 平台保留路径使用 `/.xd-pages/*`，避免与用户站点业务路径冲突。

router 必须根据 hostname 推导环境，并校验 route record：

```text
foo.pages.xd.team          -> environment=production
foo-staging.pages.xd.team  -> environment=staging
```

环境推导结果必须与 `site_routes.environment`、dispatch namespace、D1/DO/KV binding 和 signing key 一致，不一致时 fail closed。

如果 Cloudflare route 层无法优雅拆分 `*-staging.pages.xd.team` 与普通 production 子站，可以先使用 `pages-edge-router-thin` 作为统一入口，再通过 service binding 转发到环境专属 router。禁止让一个业务 router 同时绑定 production 和 staging 的 D1/DO/KV、dispatch namespace 或 signing key。

`pages-edge-router-thin` 的 hostname 分流必须使用显式 allowlist 和严格 parser：

| host pattern                                  | target                               |
| --------------------------------------------- | ------------------------------------ |
| `api.pages.xd.team`                           | fail closed，应该由 exact route 处理 |
| `auth.pages.xd.team`                          | fail closed，应该由 exact route 处理 |
| `api-staging.pages.xd.team`                   | fail closed，应该由 exact route 处理 |
| `auth-staging.pages.xd.team`                  | fail closed，应该由 exact route 处理 |
| `{slug}-staging.pages.xd.team`                | `pages-router-staging`               |
| `{slug}.pages.xd.team`                        | `pages-router`                       |
| 保留 slug、非法 host、非 `pages.xd.team` 后缀 | fail closed                          |

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

production 还应保留 `-staging` 后缀，避免用户创建看起来像 staging 的 production 站点，例如 `foo-staging.pages.xd.team`。保留名校验应在 `pages-api` 的创建和重命名路径统一执行，不能只放在 CLI。

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

系统 API 和平台 callback 使用固定 host + 固定路径，避免 CLI、OpenAPI、router 和 v1 文档各自发明路径：

| host                         | endpoint                     | 用途                        | 公开性                         |
| ---------------------------- | ---------------------------- | --------------------------- | ------------------------------ |
| `api.pages.xd.team`          | `/openapi.json`              | production OpenAPI          | public-docs                    |
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
| `{slug}.pages.xd.team`       | `/.xd-pages/auth/callback`   | 子站 site_session 补发      | auth-flow，由 router 处理      |
| `{slug}.pages.xd.team`       | `/.xd-pages/runtime/*`       | generated runtime / SDK API | subsite runtime，平台优先      |
| `api-staging.pages.xd.team`  | 同 production API path       | staging API                 | 只能返回 staging 环境配置      |
| `auth-staging.pages.xd.team` | 同 production auth path      | staging auth                | 只能使用 staging SSO redirect  |

v2 OpenAPI 和 CLI 只使用 `/.xd-pages/api/*`。`/deploy`、`/list`、`/site` 等路径属于 v1 `api.workers.xd.team`，不在 v2 `api.pages.xd.team` 上兼容或转发。

浏览器访问 `api.pages.xd.team` 时收不到 `auth.pages.xd.team` 的 `__Host-pages_auth_session`。因此 API host 不直接使用 `auth_session` cookie：

- CLI 和 CI 调 API 使用 `Authorization: Bearer <cli_token/access_key>`。
- 未来管理 UI 如需浏览器态 API，先由 `auth.pages.xd.team` 通过一次性 code / service binding 换发 `api.pages.xd.team` 下的 host-only `__Host-pages_api_session`。
- `api_session` 必须 `Secure; HttpOnly; SameSite=Lax; Path=/`，并配套 Origin / Referer allowlist、CSRF token、CORS fail-closed。
- 禁止为了让 API 收到登录态而把平台 session 改成 `.pages.xd.team` 父域 cookie。

### API 门禁等级

系统 API 按等级处理：

| 等级           | 示例                                                            | 认证                                    | 额外要求                                                                       |
| -------------- | --------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------ |
| `public-docs`  | `/openapi.json`、`/skill.md`、`/readme.md`、`/.xd-pages/health` | 无                                      | 只返回非敏感配置，不能暴露 secret、token、内部资源 id，不能返回串环境 API 地址 |
| `auth-flow`    | `/.xd-pages/auth/*`、`/.xd-pages/cli/login/*`                   | SSO state / auth_session / login secret | redirect allowlist、CSRF state、一次性 code、poll/consume 限流                 |
| `user-api`     | `/.xd-pages/api/sites`、`/.xd-pages/api/access-keys`            | CLI token、access key 或 api_session    | scope + owner/collaborator 校验                                                |
| `deploy-api`   | `/.xd-pages/api/deployments`、`/.xd-pages/api/versions`         | CLI token 或 access key                 | scope、site 权限、payload 限制、idempotency、审计                              |
| `admin-api`    | `/.xd-pages/api/admin/*`、`/.xd-pages/api/audit/*`              | admin session                           | recent login、管理员角色、强审计                                               |
| `internal-api` | service binding only                                            | service binding 或内部签名              | 不暴露公网路由                                                                 |

`public-docs` 端点必须根据请求 host 动态生成环境相关地址。`api-staging.pages.xd.team/openapi.json` 只能返回 staging API、auth 和子站域名示例；production 端点只能返回 production 地址。

v2 发布 API 不能依赖 `X-Pages-Token`。`X-Pages-Token` 只属于 v1 归属标记，不进入 v2 鉴权模型。

### Router IP Allowlist

第一版 `pages-router` 和 `pages-router-staging` 必须先做公司网络 IP allowlist，再进入 visibility、SSO、ACL 和 dispatch 判断。默认策略是：**子站只能从公司内网、VPN、办公出口或明确允许的公司代理出口访问**。

执行顺序：

```text
1. 校验 request IP 是否命中当前环境 allowlist。
2. 不命中：直接 403，不读取站点 ACL，不跳 SSO，不 dispatch 到 User Worker。
3. 命中：继续 hostname/env 校验、route snapshot、visibility、SSO/ACL。
```

IP allowlist 规则：

- production 和 staging 使用独立 allowlist 配置，可以相同但必须显式配置，不能共享隐式默认值。
- allowlist 来源应是 Worker runtime `vars` 或配置快照，例如 `ROUTER_IP_ALLOWLIST_CIDRS`，不能由用户站点或 `.pages.json` 控制。
- 需要正确解析 Cloudflare 提供的客户端 IP；如果请求不经过 Cloudflare 标准链路或无法可信取得客户端 IP，必须 fail closed。
- allowlist 变更属于高风险操作，需要审计、配置校验和快速回滚。
- 第一版的 `public` 只表示“公司网络内匿名可访问”，不表示互联网公开。

如果未来需要真正公网公开站点，应新增显式 visibility，例如 `internet_public`，并单独评审 WAF、滥用防护、缓存、审计和法务/合规要求；不要复用第一版 `public`。

### 子站访问门禁

子站访问由 `pages-router` 根据 route snapshot 和必要的 strict check 决策：

| visibility | router 行为                                                             |
| ---------- | ----------------------------------------------------------------------- |
| `public`   | 命中 router IP allowlist 后可匿名访问，仍记录访问审计或采样审计         |
| `org`      | 需要有效 `site_session`，且用户 employee status 为 active；没有时走 SSO |
| `acl`      | 需要有效 `site_session`，并命中任意一条 allow-only ACL                  |
| `owner`    | 需要 owner 或 collaborator 身份                                         |
| `disabled` | 直接拒绝，不 dispatch 到 User Worker                                    |

router 必须先处理门禁，再 dispatch 到 User Worker。User Worker 不能自行决定是否绕过平台门禁。

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

## 站点可见性模型

建议第一版支持：

| visibility | 含义                        | 是否需要登录 | 典型用途             |
| ---------- | --------------------------- | ------------ | -------------------- |
| `public`   | 公司网络内匿名可访问        | 否           | 内部报告、demo       |
| `org`      | 公司 SSO 用户可访问         | 是           | 默认内部站点         |
| `acl`      | 指定用户、邮箱或组可访问    | 是           | 项目私有预览         |
| `owner`    | owner / collaborator 可访问 | 是           | 管理预览、敏感站点   |
| `disabled` | 暂停访问                    | 不适用       | 下线、风控、事故处理 |

发布权限与访问权限必须分开：

```text
deploy permission: 谁能发布、覆盖、回滚、删除
access permission: 谁能访问子站内容
```

默认建议：

- 新站点默认 `org`，比 `public` 更安全。
- CLI 支持显式 `--visibility public|org|acl|owner`。

第一版所有 visibility 都受 `pages-router` IP allowlist 约束。`public` 只是跳过 SSO/ACL，不跳过公司网络限制。

## SSO 登录链路

### 首次访问受保护子站

```text
1. Browser -> https://foo.pages.xd.team/
2. pages-router 校验客户端 IP 命中公司 allowlist
3. pages-router 读取 route snapshot，发现需要登录
4. pages-router 检查当前 host 的 site_session，未命中
5. 302 -> pages-auth 登录入口，带 return_to 和 state
6. pages-auth 检查 auth_session
7. 无 auth_session 时跳转心动 SSO authorize
8. 心动 SSO callback -> pages-auth
9. pages-auth 服务端换 access_token 并读取 profile
10. pages-auth 签发 auth_session
11. pages-auth 生成一次性 code，302 回 foo 的平台 callback
12. pages-router 校验 code/state，签发 foo host 下的 site_session
13. pages-router 302 回原始 return_to
14. 再次请求 foo，pages-router 本地验 site_session
15. pages-router 注入内部 JWT，dispatch 到 user Worker
```

平台 callback 路径建议：

```text
/.xd-pages/auth/callback
```

不要使用 `/callback`，避免与用户站点业务路由冲突。

### 后续访问快路径

```text
1. Browser -> https://foo.pages.xd.team/
2. pages-router 校验客户端 IP 命中公司 allowlist
3. pages-router 本地校验 site_session
4. pages-router 读取 L1/KV route snapshot
5. pages-router 对比 site_session.policyVersion 和 route snapshot.policyVersion
6. pages-router 生成 30-60 秒内部 JWT
7. dispatch 到 foo 对应 user Worker
8. 返回响应
```

后续访问不应回 `pages-api` 或 `pages-auth`，除非：

- session 过期。
- 站点策略进入 `strict` 校验路径。
- 用户或站点被封禁。
- 命中风控或高风险操作。

## Cookie 与 Token

### auth_session

```text
Host: auth.pages.xd.team
Cookie: __Host-pages_auth_session
属性: Secure; HttpOnly; SameSite=Lax; Path=/
idle TTL: 14 天
absolute TTL: 30 天
续期: 支持滑动续期
用途: 证明用户已通过心动 SSO 登录 pages 平台
```

该 cookie 不下发到子站域名，也不下发到 `api.pages.xd.team`。`auth_session` 可以做得相对长，减少用户重新扫码或重新认证的频率；但它不应是完全不可吊销的纯 stateless JWT。推荐由 Durable Object 协调发行、刷新和吊销，并在 D1 保存可查询索引。session 记录至少包含 `sid`、`userId`、`issuedAt`、`lastSeenAt`、`expiresAt`、`absoluteExpiresAt`、`revokedAt` 和 `authTime`。

如果需要浏览器态管理 API，必须单独签发 `api.pages.xd.team` host-only `api_session`，不能把 `auth_session` 改成父域 cookie。

高风险操作仍应要求 recent login，例如：

- 删除站点。
- 创建或查看 access key。
- 修改 owner、collaborators 或 ACL。
- 将站点可见性改为 `public`。

### site_session

```text
Host: foo.pages.xd.team
Cookie: __Host-pages_site_session
属性: Secure; HttpOnly; SameSite=Lax; Path=/
idle TTL: 1-3 天
absolute TTL: 7 天
续期: 支持滑动续期
用途: 子站访问快路径本地校验
```

该 cookie 只在当前子站 host 生效，避免一个子站的站点 session 被其他子站复用。`site_session` 比内部 JWT 长很多，是为了让受保护子站的日常访问尽量停留在 `pages-router` 快路径，不频繁跳回 `pages-auth` 补发。

`site_session` 仍需要可控失效。建议 claims 或 DO/D1 session record 中包含：

```text
sub: user id
siteId: site id
sid: site session id
policyVersion: site access policy version
sessionVersion: user/site session invalidation version
iat / exp
```

`pages-router` 默认本地验签，并对比 route snapshot 中的 `policyVersion`。当站点 ACL、visibility、owner、用户状态或封禁状态变化时，通过 `policyVersion` 或 `sessionVersion` 让旧 session 快速失效。版本状态来自 L1/KV route snapshot；只有 `strict` 路径才直接查 D1 或 Durable Object。

用户级吊销不能只依赖 route snapshot。router 至少需要一种 user revocation 快路径：

- 在受保护站点访问时，短 TTL 缓存 `userId -> sessionVersion / employee_status`，来源是 `UserSessionDO` 或 D1 index。
- 当 `site_session.sessionVersion` 小于用户最新 `sessionVersion`，必须拒绝或重新登录。
- 对禁用、离职、封禁、管理员踢下线这类事件，最大生效窗口应由配置控制，并在监控中暴露。

### internal_worker_jwt

```text
传递位置: Gateway -> User Worker 的平台保留 header
生命周期: 30-60 秒
用途: 让 User Worker 验证请求来自 pages-router，并读取可信用户上下文
```

完整 claims 结构见上文 `Cookie 与 JWT 数据结构`。真实实现不得在文档、测试或日志中使用真实用户邮箱、真实 token 或真实 secret。

`internal_worker_jwt` 不是平台 API 或 gateway 的通用 bearer capability。它只用于让 User Worker 验证“本次请求来自 pages-router，并携带可信用户上下文”。任何平台能力调用仍必须使用独立 capability，并校验 `aud`、`siteId`/`siteUuid`、`routeId`、scope、method/path，必要时绑定 `jti` 防重放。

### CLI 本地状态与配置

CLI 只适配 v2 `pages.xd.team` 平台。它不发布、不管理、不回退兼容 v1 `workers.xd.team` 站点；v1 继续使用现有 API、skill 和发布流程。

当前 v2 CLI 落地为 `apps/pages-cli` workspace package，bin 名称为 `pages`。CLI 只负责本地 UX、项目绑定、凭据读取、artifact hash 和调用 v2 API/Auth；不会直连 Cloudflare，也不会绕过 `pages-api` 的权限判断。

v2 CLI 使用 pages 平台签发的 token，不直接持有心动 SSO `access_token`：

- `pages login` 打开浏览器，完成 SSO 后 CLI 轮询登录结果。
- `pages login --env staging` 登录 staging；默认登录 production。
- `pages login --access-key <key>` 只在用户显式传入 access key 时保存该 access key；普通 deploy 默认也可直接读取 `PAGES_ACCESS_KEY`。
- CLI token 支持过期、scope、吊销和本地安全存储。
- CI 默认使用 `access key`，不使用个人浏览器 session。`service token` 只有在后续需要组织级机器人身份时再单独设计，不混入 MVP。
- CLI token、access key 和本地 profile 必须按 environment 隔离保存，staging token 不能调用 production API。
- CLI 内置环境只能指向 v2 production/staging：`api.pages.xd.team`、`api-staging.pages.xd.team`、`auth.pages.xd.team`、`auth-staging.pages.xd.team` 和 `*.pages.xd.team`。
- CLI 不得静默调用 `api.workers.xd.team`，也不得把 v2 deploy 发布到 `*.workers.xd.team`。

凭证边界：

| 凭证            | 使用者           | 典型存储                          | 权限模型                           |
| --------------- | ---------------- | --------------------------------- | ---------------------------------- |
| `auth_session`  | 浏览器平台登录   | auth host HttpOnly cookie         | 用户登录态，不直接用于 CLI deploy  |
| `site_session`  | 浏览器访问子站   | 子站 host HttpOnly cookie         | 子站访问，不用于管理 API           |
| `CLI token`     | 本地 CLI         | OS secret store                   | 用户身份 + scope + env             |
| `access key`    | CI / agent       | CI secret 或用户显式保存的 secret | 可限定 site/scope/expiry           |
| `service token` | 未来机器人身份   | 组织级 secret store / CI secret   | 暂不进入 MVP                       |
| `internal JWT`  | router -> Worker | 请求内短期 header                 | 请求身份 envelope，不是 capability |

CLI 本地状态分三层：

```text
Secret store:
  CLI token、refresh token、用户明确保存的 access key。

Global config:
  默认 env、custom env、最近登录时间等非敏感 profile 元数据。

Project binding:
  当前目录绑定的 site/env/url/version，不保存任何凭证。
```

#### Secret store

优先使用系统安全存储：

```text
macOS: Keychain
Linux: Secret Service / libsecret（当前实现通过 secret-tool opt-in）
Windows: 后续可接 Credential Manager / DPAPI；当前实现必须走安全 fallback ACL 检查
CI: environment variables
fallback:
  macOS/Linux: $XDG_CONFIG_HOME/xd-pages/credentials.json 或 ~/.config/xd-pages/credentials.json, chmod 0600
  Windows: %APPDATA%\xd-pages\credentials.json, ACL 当前用户 only
```

secret key 必须带 environment：

```text
xd-pages:production
xd-pages:staging
xd-pages:local
xd-pages:custom
```

Windows fallback 文件没有 `chmod 0600` 语义，CLI 必须检查 ACL：只允许当前 Windows 用户读写，不允许 `Everyone` 或普通 `Users` 组读取。不满足时拒绝读取 secret，或提示用户执行修复命令。

access key 默认只通过环境变量传入：

```bash
PAGES_ACCESS_KEY=... pages deploy ./dist --name foo
```

本地 CLI 不应自动从环境变量持久化 access key。只有用户明确执行 `pages login --access-key <key>` 这类命令时，才允许写入 secret store，并且输出不得回显 key 明文。access key 的 scope、site 限制和过期时间仍以 `pages-api` 权威记录为准。

#### Global config

全局 profile 只存非敏感信息。当前实现路径：

```text
macOS/Linux: $XDG_CONFIG_HOME/xd-pages/profile.json 或 ~/.config/xd-pages/profile.json
Windows: %APPDATA%\xd-pages\profile.json
```

示例：

```json
{
  "activeEnvironment": "production",
  "environments": {
    "production": {
      "credentialType": "cli_token",
      "lastLoginAt": "2026-06-15T00:00:00.000Z"
    },
    "custom": {
      "environment": "custom",
      "apiBaseUrl": "http://127.0.0.1:8787",
      "authBaseUrl": "http://127.0.0.1:8787",
      "siteDomainSuffix": "127.0.0.1.nip.io"
    }
  }
}
```

profile 只用于本地显示和用户体验，服务端不能信任。真实权限只看 CLI token、access key 和服务端存储。profile 禁止出现 token、access key、cookie、Cloudflare id、SSO secret 或 capability。

CLI 可以支持：

```bash
pages env list
pages env use staging
pages env set custom --api http://127.0.0.1:8787 --auth http://127.0.0.1:8787
```

内置 `production` / `staging` 是 v2 固定环境，不能被本地 profile、环境变量或普通 override 改写。`local` 也是固定本地 SSO 开发入口：`http://xd-pages.127.0.0.1.nip.io:8787`。需要更灵活调试时使用 `custom`。当前 M4 实现先只允许 custom 指向 loopback：

- 本机开发：`localhost` / `127.0.0.1` / `::1`，可使用 HTTP。

如果后续要允许公司专用 v2 测试域，必须由 CLI 内置或受信发布配置提供 allowlist；用户本地 profile 不能自行扩大 allowlist。custom env 不能作为 v1 `workers.xd.team` 兼容入口，也不能指向任意第三方 host。

env 安全规则：

- production/staging 不可变，固定指向 `api.pages.xd.team`、`auth.pages.xd.team`、`api-staging.pages.xd.team`、`auth-staging.pages.xd.team` 和对应 site suffix。
- 登录前必须展示将要打开的 auth host、API host、environment 和请求 scope。
- API host 变化后，旧 token 不自动复用；credential key 以 environment 隔离。
- 如果 API/auth/site suffix 指向 `workers.xd.team` 或不在 custom env allowlist 中，CLI 应直接拒绝，并提示用户该 host 不属于 v2 CLI 信任域。

#### Project binding `.pages.json`

`.pages.json` 是项目目录和远端站点的本地映射，不是身份凭证。它可以提升 CLI 和 AI 的上下文体验：

- 避免每次部署都询问站点名。
- 防止当前目录误部署到不相关站点。
- 让 `pages open`、`pages status`、`pages rollback` 有默认目标。
- 让 AI skill 读取项目绑定，而不是猜测站点名。

`.pages.json` 是否提交到业务项目 Git 由业务项目自己决定；但它必须始终保持非敏感。本仓库的 demo `.pages.json` 仍不提交。

`.pages.json` 只描述 v2 `pages.xd.team` 站点绑定。CLI 读取到 `workers.xd.team` URL 或 v1 API 配置时必须 fail closed，不能把旧项目配置“自动升级”为 v2，也不能反向操作 v1 站点。

当前 M4 实现使用 flat v1 binding，表示“当前目录在某个 environment 下的默认绑定”：

```json
{
  "version": 1,
  "environment": "production",
  "siteId": "site_xxx",
  "slug": "foo",
  "defaultArtifactKind": "spa",
  "lastDeploymentId": "dep_xxx",
  "lastVersionId": "ver_xxx",
  "updatedAt": "2026-06-15T00:00:00.000Z"
}
```

CLI 显式指定 `--env staging` 时，如果当前 `.pages.json` 是 production 绑定，不能复用 production `siteId` 调 staging API；它应当使用 slug 创建或绑定 staging 站点，或提示用户补充目标。未来如果需要同一目录同时持有 production/staging 两套绑定，应升级为 `version: 2` 的 multi-env schema，并保留迁移测试。

`.pages.json` 禁止存：

- CLI token。
- access key。
- SSO access token。
- Cloudflare token、account id、zone id、KV namespace id。
- cookie、session、signed capability。

CLI 日常命令契约建议：

```bash
pages login [--env staging] [--access-key <key>] [--no-open]
pages deploy ./dist --slug foo --visibility org
pages status [--site site_xxx] [--deployment dep_xxx]
pages rollback ver_xxx
pages open [--print]
pages env list
pages env use staging
pages env set custom --api http://127.0.0.1:8787 --auth http://127.0.0.1:8787
```

配置优先级从高到低：

```text
显式 CLI 参数
  > 环境变量，例如 PAGES_CLI_ENV / PAGES_ACCESS_KEY
  > 当前目录 .pages.json 的 environment/siteId/slug
  > profile.json 的 activeEnvironment/custom env
  > CLI 内置 production 默认值
```

如果远端站点被重命名、删除或当前用户失去权限，CLI 必须停止自动部署，提示用户重新 `pages bind` 或选择新的 site；不能用旧 `.pages.json` 静默创建同名新站。

`.pages.json` 的 `version` 必须随不兼容变更递增。CLI 读取未知 version 时不能静默忽略，应提示升级 CLI 或重新绑定项目。

### 最小 API 契约

完整 OpenAPI 可在实现阶段展开，但 v2 架构需要先固定这些契约：

| Method   | Path                                    | Auth                                   | 幂等性 / 状态                                         |
| -------- | --------------------------------------- | -------------------------------------- | ----------------------------------------------------- |
| `POST`   | `/.xd-pages/cli/login/start`            | 无                                     | 返回 `loginId`、浏览器 URL；CLI 保存 `loginSecret`    |
| `POST`   | `/.xd-pages/cli/login/poll`             | `loginId + loginSecret`                | pending / completed / expired；completed 只能消费一次 |
| `GET`    | `/.xd-pages/api/sites`                  | CLI token / api_session                | 分页返回当前 actor 可见站点，不返回 token             |
| `POST`   | `/.xd-pages/api/deployments`            | CLI token / access key                 | 必须带 `Idempotency-Key`；返回 deployment 状态        |
| `GET`    | `/.xd-pages/api/deployments/{id}`       | CLI token / access key                 | 用于轮询 deploy 状态                                  |
| `POST`   | `/.xd-pages/api/versions/{id}/rollback` | CLI token / access key                 | 必须带 `Idempotency-Key`；走同一发布状态机            |
| `POST`   | `/.xd-pages/api/access-keys`            | api_session + recent login             | 明文只返回一次                                        |
| `DELETE` | `/.xd-pages/api/access-keys/{id}`       | api_session + recent login / CLI token | 吊销后进入 strict 失效路径                            |

所有带 `Idempotency-Key` 的 API 都必须保存 request hash。同 key 不同 request hash 返回 409；同 key 同 hash 返回原 deployment 状态或 terminal response。

统一错误响应：

```json
{
  "error": {
    "code": "PAGES_AUTH_REQUIRED",
    "message": "Login required.",
    "requestId": "req_xxx",
    "action": "Run `pages login` and retry."
  }
}
```

错误响应必须给出可操作 `action`，但不能包含 secret、token、完整 SSO URL query、Cloudflare 资源 id 或用户上传内容。

## Gateway -> User Worker Header 约定

`pages-router` 调用 user Worker 前注入：

```text
CF-Platform-Auth: <internal_worker_jwt>
CF-Platform-User: <user-id>
CF-Platform-Site-Id: <site-id>
CF-Platform-Site-Slug: <slug>
CF-Platform-Version: <version-id>
CF-Platform-Trace-Id: <trace-id>
```

`CF-Platform-Email`、`CF-Platform-Name`、`CF-Platform-Groups` 等 profile header 默认不注入。只有站点显式申请并通过平台策略允许的 profile disclosure scope 后，router 才能注入对应 header；这些字段必须同时出现在 `internal_worker_jwt` 的受控 claims 中，避免 header 与 JWT 不一致。

安全规则：

- 入站请求中已有的 `CF-Platform-*`、`X-Pages-*` 必须删除。
- dispatch 给 User Worker 前必须移除 `__Host-pages_*`、`__Secure-pages_*` 等平台 cookie，不能把 `site_session`、`auth_session`、capability cookie 或未来平台 cookie 暴露给 User Worker。
- 只有 `pages-router` 可以生成 `CF-Platform-Auth`。
- User Worker 可以读取这些 header，但不能把它们当作浏览器身份来源。
- SDK 可以提供 `verifyPlatformRequest(request, env)`，帮助 user Worker 验内部 JWT。
- User Worker 响应中的平台保留 cookie/header 必须被 router 删除或覆盖。

## 发布链路

### 人类用户

```text
pages login
  -> CLI 调 pages-auth /.xd-pages/cli/login/start
  -> CLI 本地生成 login_secret 和短码，仅把 hash/证明传给服务端
  -> CLI 展示短码、environment、auth host、scope
  -> 打开浏览器到 pages-auth 登录页
  -> 用户通过心动 SSO 登录
  -> 浏览器确认同一个短码、environment、auth host、scope
  -> CLI 带 login_secret 轮询 /.xd-pages/cli/login/poll
  -> 获取 pages CLI token

pages deploy ./dist --name foo --visibility org
  -> CLI 调 pages-api /.xd-pages/api/deployments
  -> pages-api 校验 CLI token 和发布权限
  -> pages-api 构建站点版本 metadata
  -> pages-api 上传 user Worker 到 WFP dispatch namespace
  -> pages-api 通过发布状态机切换 active version 和 route snapshot
  -> 返回 https://foo.pages.xd.team

pages deploy ./dist --name foo --visibility org --env staging
  -> CLI 调 api-staging.pages.xd.team
  -> pages-api-staging 写 staging D1 / dispatch namespace
  -> 返回 https://foo-staging.pages.xd.team
```

### CI / Agent

```text
PAGES_ACCESS_KEY=... pages deploy ./dist --name foo
```

access key 要求：

- 可限定 owner、site、scope、过期时间。
- 可吊销。
- 不得在日志输出。
- 不得等价于全局管理员权限。
- 明文只显示一次，存储时使用 hash/HMAC + server-side pepper。
- 校验时使用常量时间比较，并记录 `last_used_at`、来源 env、site/scope 决策。
- key 格式应带非敏感前缀和环境提示，例如 `xdp_prod_...`、`xdp_stg_...`，但不能仅靠前缀判权。

### AI Skill

v2 AI skill 最终只负责调用 v2 CLI：

```text
用户 -> AI -> pages CLI -> pages-api
```

不再让 AI 直接拼接 API、猜测 token、解释复杂 OpenAPI 或手写 multipart 请求。现有 v1 skill / 文档继续服务 `workers.xd.team`，不因 v2 CLI 改造而改变行为。

## 用户 Worker 运行边界

用户 Worker 默认不可信。

平台必须保证：

- 不把平台 secret 作为 binding 注入 user Worker。
- 不把 SSO `access_token`、auth session、site session 传入 user Worker。
- 不让 user Worker 直接访问全局 metadata store、session store 或 audit store。
- 用户 Worker 的平台能力通过最小权限 binding 或 gateway 暴露。
- 第一版如果尚未接入 Outbound Worker，只能承诺最小化披露和平台能力直连保护；不能宣称可阻止恶意 User Worker 外传其已可见的数据。

用户 Worker 可获得：

- 当前请求。
- 当前站点有限 metadata。
- 平台注入的短期身份 JWT；claims 必须最小化，避免不必要 PII。
- 站点级 KV/R2/D1 等能力的受限 gateway。

baseline egress policy：

- 平台 runtime / SDK 不得自动把 `CF-Platform-*`、`X-Pages-*`、`Cookie`、`Authorization`、`internal_worker_jwt` 或任何平台 capability 带到外部请求。
- User Worker 可能显式外传它已经可见的数据；因此 internal JWT claims 必须最小化，平台 capability 必须独立签发、短 TTL、限定 scope，并避免把敏感平台 secret 暴露给 User Worker。
- 禁止 User Worker 直连平台内控 host 的强制执行需要 Outbound Worker、egress proxy 或受控 fetch/gateway。未接入前，平台能力必须通过 service binding 或 capability gateway 暴露，并对访问平台保留 host 的尝试做审计/告警。
- 高风险 egress、异常失败率和访问平台保留 host 的尝试必须进入审计或安全告警。
- 后续引入 Outbound Worker 后，再强制执行 allowlist/denylist、数据外传检测、每站点 subrequest 限额和封禁策略。

## Pages KV 与平台能力

现有 `apps/kv-gateway` 的方向可以保留：

```text
User Worker / generated SPA runtime
  -> capability
  -> kv-gateway
  -> 真实 KV namespace
```

v2 需要调整：

- capability 的 subject 应绑定 site UUID、version 或 worker identity。
- capability 不包含用户身份；用户身份由 `CF-Platform-Auth` 表示。
- 浏览器仍不能直接拿 gateway token 或 capability。

### site scope 与 user scope

当前 Pages KV 是站点级能力，安全边界是 `siteUuid`：

```text
site.kv:
  s/{siteUuid}/k/{key}
```

这适合存站点配置、共享草稿、轻量状态和站点级缓存，但不应被当作用户数据库。业务代码自行约定 `users/{userId}/...` 前缀不能形成平台级隔离，因为 userId 可能来自浏览器、业务参数或不可信 Worker 代码。

如果未来需要用户级数据隔离，应在 SDK/API 层显式引入 `user` scope：

```ts
pages.site.kv.get('app/config');
pages.user.kv.get('settings');
```

对应存储前缀由平台推导：

```text
site.kv:
  s/{siteUuid}/k/{key}

user.kv:
  s/{siteUuid}/u/{userId}/k/{key}
```

`userId` 必须来自 `pages-router` 注入的 `CF-Platform-Auth` 签名身份，不能由浏览器、SDK 调用方或 User Worker 自行传入。第一版 user scope 只建议支持当前登录用户自己的 `get` / `put` / `delete`，不支持 list、管理员读取他人数据、团队空间或共享用户组空间。

该能力不阻塞 v2 WFP/SSO 主架构。推荐顺序：

1. 先完成 SSO、`pages-router` 和内部 JWT。
2. 再扩展 `kv-gateway` capability 与 key prefix。
3. 再在 SDK 中暴露 `pages.site.kv` / `pages.user.kv`。
4. 最后补访问审计、文档和上线说明。

## 静态站点和 SPA

v2 需要验证 Workers for Platforms 对 static/spa assets 的支持边界；这不影响 v1 Workers Assets 发布链路。

建议实现时准备两种路径：

1. 如果 WFP user Worker 可满足 assets 需求，则继续由平台生成 static/spa user Worker。
2. 如果 assets 与 WFP 组合不满足需求，则将静态资产放入 R2 或专用 asset store，由 generated user Worker 或 router asset layer 读取。

无论采用哪种路径，对用户暴露的心智保持一致：

```text
pages deploy ./dist --name foo
```

用户不需要理解 dispatch namespace、asset store、gateway 或 Cloudflare binding。

## 审计

管理审计由 `pages-api` 写入：

- login
- deploy
- rollback
- delete
- visibility change
- ACL change
- access key create/revoke

访问审计由 `pages-router` 写入或采样写入：

- request id / trace id
- site
- version
- user id / anonymous
- decision: allow / deny / redirect
- visibility
- IP hash 或脱敏 IP
- user agent 摘要
- status code

禁止记录：

- Cookie
- Authorization
- SSO access token
- CLI token
- access key
- internal_worker_jwt
- 请求 body 中的业务敏感内容

## 监控、告警与容量保护

第一版至少需要这些指标：

- route snapshot age、L1/KV hit ratio、D1 fallback rate。
- router IP allowlist deny count、unknown client IP count、allowlist config version。
- strict check latency / error rate。
- dispatch success rate、dispatch 404/5xx、user Worker CPU/subrequest 超限。
- WFP deploy success/failure、deploy duration、orphan worker count。
- SSO login start/callback failure、CLI login poll/consume failure。
- cross-env guard trip、reserved host/path mismatch。
- audit write backlog、audit dropped/sampled count。

基础容量保护：

- `deploy-api`：限制上传总大小、文件数量、单文件大小、并发部署数和 WFP API retry/backoff。
- `subsite`：按 site/user/IP 做可选限流，避免单站影响平台。
- `kv-gateway`：按 siteUuid、capability scope 和 key prefix 做读写限流。
- `audit`：允许采样访问审计，但管理审计和 deny/security 事件不能静默丢弃。

阶段 0 需要确认目标阈值：站点数、版本数、单站 QPS、部署并发、资产大小、审计保留周期和告警渠道。阈值没确认前，文档只能作为设计草案，不能作为容量承诺。

### Reconciliation 与清理

需要一个后台 reconciliation job 或管理员工具，负责修复最终一致性和清理资源：

| 对象                        | 职责                                                                                    |
| --------------------------- | --------------------------------------------------------------------------------------- |
| route snapshot              | 对比 D1 `route_generation`、KV pointer 和 immutable snapshot，修复缺失或过期 pointer    |
| deployment                  | 修正卡在 `activating` / `uploaded` 的状态，补齐 terminal response                       |
| orphan user worker / assets | mark-and-sweep 清理，保留 active version、rollback window、非终态 deployment 和审计引用 |
| key registry                | 检查 active/draining/retired key 与最大 token TTL 是否匹配                              |

key rotation 生命周期：

```text
publish -> activate -> drain -> retire
```

重叠窗口至少覆盖最大 token TTL + route/JWKS KV TTL。retire 前必须确认没有仍需验证该 `kid` 的 session、internal JWT、capability 或 rollback window。

## 平稳上线阶段

### 阶段 0：设计与资源验证

- 确认 Workers for Platforms 可用性、配额、billing 和 staging 资源。
- 新增并验证 `pages` / `*.pages` DNS、证书 DCV 和 Cloudflare route；确认不影响 v1 `workers` / `*.workers`。
- 验证 Cloudflare route：`*-staging.pages.xd.team/*` 是否稳定进入 `pages-router-staging`，且 API/auth exact route 优先级正确。
- 如果 route spike 不满足要求，验证 `pages-edge-router-thin` fallback，确认它不持有业务 secret。
- 确认 SSO redirect URI。
- 确认 static/spa assets 在 WFP 下的实现路径。
- 确认 SSO profile 是否包含稳定 user id、邮箱和 employee status。
- 确认公司内网、VPN、办公出口和必要代理出口的 CIDR 清单，并确定维护/回滚流程。
- `docs/xd-sso.md` 只作为本地临时参考，不进入提交；上线前删除该文件，或替换为不含 token-like 示例、真实 host query、危险日志和硬编码口令的脱敏摘要。
- 增加 workflow 静态校验：production 不允许 push/PR 自动部署，token 名称、route pattern、resource id、binding 环境必须匹配。

### 阶段 1：新控制面与 CLI 登录

- 新增 `pages-auth`。
- 新增 `pages-api` 的登录态校验和 access key。
- v2 CLI 支持 `pages login`、`login_id + login_secret` 轮询和 `PAGES_ACCESS_KEY`。
- v2 AI skill 改为只调用 v2 CLI。
- 现有 `apps/server` 继续服务 v1 `workers.xd.team`，v2 不改 v1 API、skill、README 或发布行为。

### 阶段 2：WFP 发布 MVP（可上线受保护站点的最小闭环）

- 新增 `pages-router`。
- 新增 `pages-router-staging`，production/staging router 物理隔离。
- 新增 WFP dispatch namespace。
- `pages deploy --runtime wfp` 发布试点站点。
- 支持 `public` 和 `org` visibility。
- 支持 router IP allowlist 强限制；未命中公司网络直接 403。
- 支持站点级 `site_session`、员工 active 状态校验、header/cookie 清洗和 `internal_worker_jwt`。
- 支持发布/回滚状态机、route snapshot generation 和基础故障矩阵。
- 支持最小化披露、平台能力 gateway 和 egress 审计；强制 egress 阻断进入阶段 4。
- 支持访问审计。

### 阶段 3：子站 SSO 与 ACL

- 支持 `acl` 和 `owner` visibility。
- 支持 collaborators。
- 支持 group ACL（如果 SSO/组织接口可用）。
- 完成更细的 user/session revocation、risk policy 和管理 UI 入口。

### 阶段 4：执行面治理

- Outbound Worker / 强制 egress policy。
- 更细的资源限制。
- 更完善的审计查询。
- 管理 UI。

## 风险和约束

| 风险                        | 说明                             | 缓解                                                                 |
| --------------------------- | -------------------------------- | -------------------------------------------------------------------- |
| SSO clientSecret 泄露       | OAuth 换 token 需要 secret       | 只放 Worker secret，不进 CLI/浏览器/日志                             |
| session 不可吊销            | 纯本地 JWT 验证性能好但吊销慢    | 短 TTL + sid + 高风险操作查状态                                      |
| staging/prod 串环境         | route 或 binding 选错影响 P0     | 双 router 物理隔离，thin router 不持有 secret                        |
| 子站公网暴露                | `public` 容易被误解为互联网公开  | router 强制 IP allowlist，第一版仅公司网络可访问                     |
| 用户 Worker 伪造身份        | 浏览器可伪造普通 header          | router 清洗入站 header，并注入签名内部 JWT                           |
| User Worker 覆盖平台 cookie | 不可信代码可返回 Set-Cookie      | router 清洗平台保留 cookie/header                                    |
| User Worker 设置父域 cookie | 可污染 sibling 子站或平台 host   | 只允许 host-only cookie，拒绝父域 Domain                             |
| internal JWT 被当能力凭证   | User Worker 可复制短期 JWT       | 平台能力使用独立 capability，不信 internal JWT                       |
| v1/v2 心智混淆              | 用户可能以为 v2 会接管旧域名     | 文档、CLI help、错误提示和 skill 明确 `workers` 是 v1、`pages` 是 v2 |
| assets 承载方式不确定       | WFP 与 Workers Assets 组合需验证 | 阶段 0 做 spike，准备 R2/asset store 备选                            |
| 新 wildcard 配置风险        | `*.pages.xd.team` 是 v2 核心入口 | staging 验证、DNS/证书/route 静态校验、快速回滚                      |
| production 自动部署风险     | 当前项目要求生产手动部署         | CI 继续保持 production manual                                        |

## 需要进一步确认的问题

1. 心动 SSO 是否能提供稳定用户唯一 ID、邮箱和员工状态；离职或禁用状态是否会实时体现在 profile。
2. 是否有组织/部门/群组接口可用于 `acl` 的 group 规则。
3. Workers for Platforms 在当前账号是否已开通，以及 dispatch namespace、user worker、outbound worker 的配额和计费。
4. WFP user Worker 是否可直接承载 static/spa assets 模型；如果不能，优先选择 R2 还是独立 asset store。
5. 访问审计的保留周期、查询方式和敏感字段脱敏标准。
6. CLI custom env 的开放范围：是否允许用户 override v2 内置 production/staging，还是只允许新增 v2 local/custom；无论哪种方式都不用于 v1 兼容。
7. Cloudflare route 是否支持 `*-staging.pages.xd.team/*` 稳定优先于 `*.pages.xd.team/*`；如果不支持，是否接受 `pages-edge-router-thin`。
8. SSO token endpoint 是否支持 POST；如果只能 GET，日志脱敏链路是否可验证。
9. SSO profile 中 employee status 原始值到 `active / disabled / left / unknown` 的映射表和 freshness SLA。
10. MVP 是否必须强制 egress 阻断；如果必须，需要把 Outbound Worker 提前到阶段 2。
11. 公司内网/VPN/办公出口 CIDR 的权威来源、更新频率和紧急回滚流程。

## 第一版验收标准

- 用户必须登录后才能发布 WFP 站点。
- production/staging 由不同 router Worker 和不同资源承载；如果使用 thin router，它不能持有业务 secret。
- pages-router 第一版必须强制 IP allowlist；未命中公司网络的请求直接 403，且不 dispatch 到 User Worker。
- `pages deploy --visibility org` 发布的站点，未登录访问会跳转 SSO。
- `org` 站点只允许 active employee 访问；disabled/left/unknown 默认拒绝或 strict 校验后拒绝。
- 登录后访问受保护子站不回 `pages-api`。
- User Worker 收到签名内部 JWT，不能依赖浏览器 cookie。
- 浏览器伪造的 `CF-Platform-*` / `X-Pages-*` header 会被删除。
- User Worker 不能设置平台保留 cookie 或父域 cookie。
- `internal_worker_jwt` 不被平台 API / gateway 当作通用 capability。
- 发布和回滚遵循状态机，失败不会覆盖旧 active version。
- CLI login 需要用户在浏览器确认终端短码、environment、auth host 和 scope。
- API host 不直接依赖 auth host 的 `auth_session`；浏览器态 API 使用独立 host-only `api_session`。
- `public` 站点在公司网络内无需登录可访问，但仍有站点 metadata 和审计；第一版不支持互联网公开子站。
- CLI 支持浏览器登录和 access key 两种模式。
- CLI 只支持 v2 `pages.xd.team`，不能静默调用 `api.workers.xd.team`，也不能发布或管理 `*.workers.xd.team` 站点。
- v1 `workers.xd.team` 站点、API、skill 和发布链路不受 v2 改动影响。
- 文档、测试和日志不包含真实 secret、真实 token 或真实 Cloudflare 资源 id。
