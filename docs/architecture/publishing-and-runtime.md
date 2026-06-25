# XD Pages 发布与运行时模型

> 本文从 `docs/pages-v2-wfp-architecture.md` 拆分而来，用于控制单篇文档长度。

## 站点可见性模型

建议第一版支持：

| visibility | 含义                       | 是否需要登录 | 典型用途             |
| ---------- | -------------------------- | ------------ | -------------------- |
| `internal` | 公司网络内免登录访问       | 否           | 内部报告、demo       |
| `org`      | 公司 SSO active 用户可访问 | 是           | 默认内部站点         |
| `acl`      | 指定邮箱可访问，owner 隐式可访问 | 是      | 项目私有预览         |
| `owner`    | active owner 可访问        | 是           | 管理预览、敏感站点   |
| `disabled` | 暂停访问                   | 不适用       | 下线、风控、事故处理 |

发布权限与访问权限必须分开：

```text
deploy permission: 谁能发布、覆盖、回滚、删除
access permission: 谁能访问子站内容
```

默认建议：

- 新站点默认 `org`，比 `internal` 更安全。
- CLI 支持显式 `--visibility internal|org|acl|owner|disabled`。

第一版所有 visibility 都受 `pages-router` IP allowlist 约束。`internal` 只是跳过 SSO/ACL，不跳过公司网络限制。public 保留给未来公网 exposure，不是第一版 visibility。

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
- 将站点可见性改为 `internal` 或未来公网 exposure。

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

`site_session` 仍需要可控失效。首版采用“较长 cookie TTL + 较短身份 freshness”的方式：cookie 可以按 `SITE_SESSION_IDLE_TTL_SECONDS` 存活，但受保护站点还必须满足 `SITE_SESSION_FRESHNESS_TTL_SECONDS`，默认和最大值都按 15 分钟处理；超过该窗口后 router 会带 `SITE_SESSION_STALE` 回到 auth 重新基于 SSO profile 补发。建议 claims 或 DO/D1 session record 中包含：

```text
sub: user id
siteId: site id
sid: site session id
policyVersion: site access policy version
sessionVersion: user/site session invalidation version
userCheckedAt: 本次 SSO/profile 派生身份的确认时间
iat / exp
```

`pages-router` 默认本地验签，并对比 route snapshot 中的 `policyVersion`。当站点 ACL、visibility、owner、用户状态或封禁状态变化时，通过 `policyVersion` 或 `sessionVersion` 让旧 session 快速失效。版本状态来自 L1/KV route snapshot；只有 `strict` 路径才直接查 D1 或 Durable Object。

用户级吊销不能只依赖 route snapshot。router 至少需要一种 user revocation 快路径：

- 首版必须校验 `userCheckedAt` freshness，避免离职/禁用状态最多滞留到完整 `site_session` TTL。
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

CLI 只适配 `pages.xd.team` 平台。它不发布、不管理、不回退兼容旧版 `workers.xd.team` 站点；旧版继续使用现有 API、skill 和发布流程。

当前 CLI 落地为 `apps/pages-cli` workspace package，npm 包名为 `@xd-cell/cli`，bin 名称为 `xd-cell`。CLI 只负责本地 UX、凭据读取、显式配置读取、artifact hash 和调用 API/Auth；不会直连 Cloudflare，也不会绕过 `pages-api` 的权限判断。

CLI 使用 XD Pages 平台签发的 token，不直接持有心动 SSO `access_token`：

- `xd-cell login` 打开浏览器，完成 SSO 后 CLI 轮询登录结果。
- `xd-cell login --env staging` 登录 staging；默认登录 production。
- `xd-cell login --token <token>` 先调用 `/.xd-pages/api/auth/whoami` 验证该 access key 有效，再保存到本地 secret store。
- 其它需要访问 API 的命令支持全局 `--token <token>`；它只用于本次命令，不保存、不读取本地登录态。
- CLI token 支持过期、scope、吊销和本地安全存储。
- CI 默认使用 `access key`，不使用个人浏览器 session。`service token` 只有在后续需要组织级机器人身份时再单独设计，不混入 MVP。
- CLI token、access key 和本地 profile 必须按 environment 隔离保存，staging token 不能调用 production API。
- CLI 用户侧内置环境只展示 production/staging：`api.pages.xd.team`、`api-staging.pages.xd.team`、`auth.pages.xd.team`、`auth-staging.pages.xd.team` 和 `*.pages.xd.team`。`custom` 作为隐藏开发保留项，只允许 loopback endpoint；`local` 不进入用户侧 CLI 环境列表。
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
  active env、最近登录时间、credentialType 和开发保留项等非敏感 profile 元数据。

Command config:
  仅通过 --config <file> 显式传入；一次性生效，不属于本地状态。
```

#### Secret store

优先使用系统安全存储：

```text
macOS: Keychain
Linux: Secret Service / libsecret（当前实现通过 secret-tool opt-in）
Windows: 后续可接 Credential Manager / DPAPI；当前实现必须走安全 fallback ACL 检查
CI: environment variables
fallback:
  macOS/Linux: ~/.xd-pages/credentials.json, chmod 0600
  Windows: %APPDATA%\.xd-pages\credentials.json, ACL 当前用户 only
```

secret key 必须带 environment：

```text
xd-pages:production
xd-pages:staging
xd-pages:custom
```

Windows fallback 文件没有 `chmod 0600` 语义，CLI 必须检查 ACL：只允许当前 Windows 用户读写，不允许 `Everyone` 或普通 `Users` 组读取。不满足时拒绝读取 secret，或提示用户执行修复命令。

access key 有两种使用方式：

```bash
xd-cell login --token <token>
xd-cell deploy ./dist foo --token <token> --json
```

本地 CLI 不应自动从环境变量或普通命令持久化 access key。只有用户明确执行 `xd-cell login --token <token>` 这类登录命令时，才允许在 `whoami` 验证后写入 secret store，并且输出不得回显 key 明文。普通 API 命令传 `--token <token>` 时，只用于本次请求，不读取本地 secret store，也不写入 profile。access key 不能创建站点；CI / agent 使用 access key 部署时显式传站点名，由 `pages-api` 在当前 environment 内解析到内部 `siteId` 后再做 access key scope 校验。access key 的 scope、site 限制和过期时间仍以 `pages-api` 权威记录为准。

#### Global config

全局 profile 只存非敏感信息。路径固定为：

```text
macOS/Linux: ~/.xd-pages/profile.json
Windows: %APPDATA%\.xd-pages\profile.json
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
xd-cell env list
xd-cell env staging
```

用户侧 `xd-cell env list` 只展示 `production` / `staging`。`custom` 是开发保留项，可以由测试或开发命令显式启用，但不在普通 help 和用户文档主路径中展示。内置 `production` / `staging` 是固定环境，不能被本地 profile、环境变量或普通 override 改写。`custom` 只允许指向 loopback：

- 本机开发：`localhost` / `127.0.0.1` / `::1`，可使用 HTTP。

如果后续要允许公司专用测试域，必须由 CLI 内置或受信发布配置提供 allowlist；用户本地 profile 不能自行扩大 allowlist。custom env 不能作为旧版 `workers.xd.team` 兼容入口，也不能指向任意第三方 host。

env 安全规则：

- production/staging 不可变，固定指向 `api.pages.xd.team`、`auth.pages.xd.team`、`api-staging.pages.xd.team`、`auth-staging.pages.xd.team` 和对应 site suffix。
- 登录前必须展示将要打开的 auth host、API host、environment 和请求 scope。
- API host 变化后，旧 token 不自动复用；credential key 以 environment 隔离。
- 如果 API/auth/site suffix 指向 `workers.xd.team` 或不在 custom env allowlist 中，CLI 应直接拒绝，并提示用户该 host 不属于 XD Pages CLI 信任域。

#### Command config `--config <file>`

XD Pages CLI 不自动读取、不自动生成隐式项目绑定文件，也不提供 `pages link/unlink` 作为项目绑定心智。站点名必须显式来自 positional 参数或显式 `--config <file>`。这样用户、CI 和 AI agent 都不会被项目目录里的隐藏状态影响。

`--config <file>` 是一次性输入，不属于本地状态：

- CLI 不自动发现。
- 不写入 `profileDir`。
- 不更新 `profile.json` 或 `config.json`。
- 不等价于项目绑定。
- 只影响本次命令。
- CLI 参数优先于 config 文件。
- 文件中禁止出现 token、access key、cookie、secret、Cloudflare 资源 id、SSO secret 或 signed capability。

建议 schema：

```json
{
  "environment": "production",
  "site": "foo",
  "source": "./dist",
  "visibility": "org",
  "fallback": "auto",
  "worker": {
    "entry": "./worker.mjs"
  }
}
```

`--config` 文件是用户或 agent 自己管理的输入文件；平台 CLI 不承诺保存、更新或迁移该文件。

CLI 日常命令契约建议：

```bash
xd-cell login [--env staging] [--token <token>] [--no-open]
xd-cell auth status [--env staging]
xd-cell auth whoami [--env staging]
xd-cell auth logout [--env staging]
xd-cell deploy ./dist foo --visibility org
xd-cell deploy --config pages.config.json
xd-cell deploy ./dist foo --token <token> --json
xd-cell status foo
xd-cell rollback foo ver_xxx
xd-cell open foo [--print]
xd-cell sites list
xd-cell sites info foo
xd-cell env list
xd-cell env staging
```

配置优先级从高到低：

```text
显式 CLI 参数
  > 显式 --config <file>
  > profile.json 的 activeEnvironment
  > CLI 内置 production 默认值
```

凭证优先级从高到低：

```text
显式 --token <token>，仅本次命令生效
  > 当前 environment 的本地 secret store
  > 提示用户 xd-cell login
```

### API 边界

本文不维护 endpoint reference，也不作为 API 合约真相源。v2 API 使用边界见 `docs/api-boundary.md`；开发期 API 合约源码以 `apps/pages-api/src/openapi.js`、对应 handler 和 focused `node:test` 为准。

API 设计必须保持这些架构约束：

- 用户和 AI agent 通过 `xd-cell` CLI / skill 使用平台，不手写部署 HTTP 请求。
- 所有部署、回滚和 mutation 类请求必须有强认证、权限校验和幂等保护。
- access key scope 必须在 API 层强制执行；`deploy:site`、`rollback:site`、`read:site` 不能互相越权。
- ACL 读取和策略管理首版只允许用户 CLI token / 未来 api_session，不允许 access key。
- v2 pages-api 不公开 `/openapi.json`；v1 `apps/server` 的 `/openapi.json` 只属于旧 `workers.xd.team` 链路。

`/.xd-pages/internal/consume-site-code` 和 `/.xd-pages/internal/verify-cli-token` 不是公开 API。它们只能通过 Worker service binding 访问，并要求请求 host 为 `pages-auth.internal`；即使路径相同，公网 `auth.pages.xd.team` / `auth-staging.pages.xd.team` 访问也必须返回 404。`pages-api` 只能通过 `PAGES_AUTH` binding 校验 CLI token，不能持有签发或验签用的私密 signing secret。SSO callback 的用户同步由 `pages-auth` 直接写共享 D1 `users` 表，避免 auth/api 双向 service binding；如后续保留 `pages-api.internal/.xd-pages/internal/users/upsert`，也只能作为内部维护入口，不能暴露公网。

统一错误响应：

```json
{
  "error": {
    "code": "PAGES_AUTH_REQUIRED",
    "message": "Login required.",
    "requestId": "req_xxx",
    "action": "Run `xd-cell login` and retry."
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
xd-cell login
  -> CLI 调 pages-auth /.xd-pages/cli/login/start
  -> CLI 本地保存 login_secret，服务端生成 login_id 和短码并只保存 loginSecretHash
  -> CLI 展示短码、environment、auth host、scope
  -> 打开浏览器到 pages-auth 登录页，URL 只包含 cli_login_id，不包含短码和 login_secret
  -> 用户通过心动 SSO 登录
  -> 浏览器确认页要求用户手动输入终端短码
  -> CLI 带 login_secret 轮询 /.xd-pages/cli/login/poll
  -> 获取 xd-cell CLI token

xd-cell deploy ./dist foo --visibility org
  -> CLI 调 pages-api /.xd-pages/api/deployments
  -> CLI 计算 artifact hash
     custom Worker: JSON 发送 artifactBundle，读取入口模块内容
     static / SPA: multipart 发送 assetManifest 和 file-* 文件，filename 保留相对路径
  -> pages-api 校验 CLI token 和发布权限
  -> pages-api 规范化发布 artifact
     custom Worker: 校验 artifactBundle kind/mainModule/modules
     static / SPA: 校验 assetManifest、路径安全和文件集合
     contentHash + artifact 元数据参与 idempotency request hash
  -> pages-api 按 PAGES_EXECUTION_MODE 上传到内部执行面
  -> pages-api verify 后创建 immutable version
  -> pages-api 通过发布状态机切换 active route 和 route snapshot
  -> 返回 https://foo.pages.xd.team

xd-cell deploy ./dist foo --visibility org --env staging
  -> CLI 调 api-staging.pages.xd.team
  -> pages-api-staging 写 staging D1 / 当前执行面
  -> 返回 https://foo-staging.pages.xd.team
```

### CI / Agent

```text
xd-cell deploy ./dist foo --token <token> --json
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

XD Pages AI skill 最终只负责调用 CLI：

```text
用户 -> AI -> xd-cell CLI -> pages-api
```

不再让 AI 直接拼接 API、猜测 token、解释复杂 OpenAPI 或手写 multipart 请求。现有旧版 skill / 文档继续服务 `workers.xd.team`，不因 XD Pages CLI 改造而改变行为。

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

当前 SDK 提供 `readPlatformContext(request)` 读取 router 注入的最小上下文，并校验 `CF-Platform-*` headers 与 `internal_worker_jwt` claims 的一致性。它不会返回 raw JWT 或 capability；User Worker 不能把该 helper 的返回值当作平台能力，也不能用它绕过 gateway scope。由于第一版 internal JWT 使用 router 持有的 HS256 session key，User Worker 侧不持有验签 secret；未来如果升级为非对称签名和 JWKS，再把该 helper 升级为真正的 cryptographic verify。

## XD Pages Data 与平台能力

现有 `apps/kv-gateway` 代码改为 v2-owned data gateway，不再由 v1 `apps/server` 签发或部署：

```text
User Worker / generated SPA runtime
  -> capability
  -> pages-kv-gateway
  -> SITE_DATA KV namespace
```

第一版统一开放 `get` / `set` / `delete` 三个动作。对外 API 命名使用 `set`，不使用 `put`；gateway 内部仍可以调用 Cloudflare KV 的 `put()` 实现写入。

Worker SDK 路径：

```text
Browser request
  -> pages-router
  -> User Worker
     headers:
       CF-Platform-Auth: <internal_worker_jwt>
       CF-Platform-Data-Site-Capability: <short_lived_site_data_capability>
       CF-Platform-Data-User-Capability: <short_lived_user_data_capability>
       CF-Platform-KV-Capability: <deprecated_short_lived_site_data_capability>
     binding:
       XD_PAGES_KV_GATEWAY
  -> pages-kv-gateway
  -> SITE_DATA KV
```

普通 Worker slot 和 WFP user Worker 都使用同一套 SDK contract。slot 模式下，slot Worker 的上传 metadata 写入 `XD_PAGES_KV_GATEWAY` service binding；WFP 模式下，user Worker 上传到 dispatch namespace 时同样写入 gateway service binding。User Worker 不长期保存 capability，router 每次 dispatch 前按 route snapshot 和请求上下文分别签发短 TTL site data capability 与 user data capability。`pages.data.site` 可以使用请求级 site data capability 或受控 env site capability；如果只有 legacy capability，`pages.data.site` 只能作为 site-level 兼容 fallback 走 legacy `/kv/*` 路径。`pages.data.user` 必须只使用当前请求注入的 user data capability。legacy `CF-Platform-KV-Capability` 只服务 deprecated `pages.kv` / `/kv/*` site-level 兼容路径。

`pages-kv-gateway` 必须校验：

- capability `iss`、`aud`、`kid`、签名算法和环境。
- `exp` / `nbf` / `iat`，TTL 应控制在几十秒到几分钟内，默认按请求级短 TTL。
- `siteUuid`、`routeId`、`versionId`、`dataScope`、`apiVersion`、scope 和 method/path 是否匹配。
- `data:site:get` / `data:user:get` 只能读，`data:site:set` / `data:user:set` 只能写，`data:site:delete` / `data:user:delete` 只能删。
- legacy `kv:get` / `kv:set` / `kv:delete` 只能落到 site-level 兼容路径。
- key prefix 只能落在平台推导出的当前站点 namespace 下。

`pages-router` 从 route snapshot 现有 `kv.scopes` 派生 `data:*` scope：`kv:get` 对应 `data:*:get`，`kv:set` 对应 `data:*:set`，`kv:delete` 对应 `data:*:delete`。只读站点不能因为改用 `/data/site/*` 或 `/data/user/*` 新路径获得写权限。

Browser SDK 不把 gateway token 暴露给浏览器，而是走 router 保留路径 proxy。router 返回浏览器前必须清理所有平台 capability/header，包括 `Authorization`、`CF-Platform-*`、`X-Pages-*`、`X-XD-Pages-*` 和 `Set-Cookie`。新代码使用 `pages.data.site` / `pages.data.user`：

```text
pages.data.site.get(key)    -> POST   /.xd-pages/runtime/v1/data/site/get    { key, type }
pages.data.site.set(key,v)  -> POST   /.xd-pages/runtime/v1/data/site/set    { key, value, type, expirationTtl? }
pages.data.site.delete(key) -> POST   /.xd-pages/runtime/v1/data/site/delete { key }

pages.data.user.get(key)    -> POST   /.xd-pages/runtime/v1/data/user/get    { key, type }
pages.data.user.set(key,v)  -> POST   /.xd-pages/runtime/v1/data/user/set    { key, value, type, expirationTtl? }
pages.data.user.delete(key) -> POST   /.xd-pages/runtime/v1/data/user/delete { key }
```

`/.xd-pages/runtime/v1/kv/*` 是 deprecated legacy site-level 兼容路径，只等价于 `pages.data.site`，不能根据 body 里的 `scope` 或 `userId` 切换到 user data。
legacy runtime 响应只对浏览器暴露标准 `Deprecation` header；`X-XD-Pages-*` 仍按平台私有头清理。

`pages-router` 收到 runtime data 请求时先走平台门禁、site_session / visibility / ACL 校验、CSRF / Origin 策略和 payload 限制，再由 router 生成 gateway capability 并调用 `pages-kv-gateway`。浏览器请求永远不能直接访问 `kv-gateway.pages.xd.team`，也不能看到 gateway capability。

v2 需要调整：

- capability issuer 使用 v2 身份，例如 `pages-v2`，不能继续使用 v1 `pages-manager`。
- capability 的 subject 应绑定 site UUID、version 或 worker identity。
- user data capability 可以包含最小化的稳定 `userId` / `anonymous` subject，用于 gateway 推导 user data 前缀；不得包含 email、SSO token、session token 或其它 PII。
- 浏览器仍不能直接拿 gateway token 或 capability。

### site data 与 user data

`pages.data.site` 是站点级能力，安全边界是 `siteUuid`：

```text
site data:
  s/{slug}--{siteUuid}/k/{key}
```

`slug` 只用于可读性和排查，不能作为隔离锚点；删除同名站点后新建站点必须得到新的 `siteUuid`，因此不会继承旧 KV 前缀。这适合存站点配置、共享草稿、轻量状态和站点级缓存，但不应被当作用户数据库。业务代码自行约定 `users/{userId}/...` 前缀不能形成平台级隔离，因为 userId 可能来自浏览器、业务参数或不可信 Worker 代码。

用户级数据隔离由 `pages.data.user` 显式表达：

```ts
pages.data.site.get('app/config');
pages.data.user.get('settings');
```

对应存储前缀由平台推导：

```text
site data:
  s/{slug}--{siteUuid}/k/{key}

user data:
  s/{slug}--{siteUuid}/u/{userId}/k/{key}
```

`userId` 必须来自 `pages-router` 注入的签名身份，不能由浏览器、SDK 调用方或 User Worker 自行传入，也不能使用 email。第一版 user data 只支持当前登录用户自己的 `get` / `set` / `delete`，不支持 list、管理员读取他人数据、团队空间或共享用户组空间。匿名 `pages.data.user.get()` 返回 `null`；匿名 `set` / `delete` 返回 `USER_REQUIRED`。

## 静态站点和 SPA

静态站点和 SPA 是 XD Pages 的默认发布形态。第一版不再使用 generated-worker，不把 dist 文件 base64 内嵌到 `worker.mjs`。CLI 采用文件级 multipart 上传，服务端内部使用 Cloudflare Assets upload session 和薄 assets Worker 承载静态资源。

```text
xd-cell deploy ./dist foo
  -> CLI 遍历 dist，排除 .git、node_modules、.DS_Store 和显式配置文件
  -> CLI 自动解析 deploymentShape、requestedFallback、resolvedFallback、routingMode
  -> CLI 生成 publishPlan、assetManifest 和 contentHash
  -> CLI 以 multipart/form-data 上传：
       metadata = JSON({ publishPlan, assetManifest[], workerModules[], contentHash, ... })
       asset-file-0 / asset-file-1 / ...，每个 filename 是相对路径
       worker-main（如果有自定义 Worker entry）
  -> pages-api 校验 publishPlan、manifest、partName、hash、fallback 与文件路径
  -> execution provider 调 Cloudflare assets-upload-session
  -> 上传缺失 asset bucket
  -> assets-only 部署薄 Worker：fetch(request, env) => env.ASSETS.fetch(request)
  -> worker-with-assets 部署用户 Worker + ASSETS binding，并启用 worker-first routing
```

custom Worker 发布时，CLI 读取用户指定的 `.js` / `.mjs` 文件内容作为 module，通过 multipart worker module 上传。`.ts` 入口第一版不直接上传；在接入 bundler / transpile 前，CLI 必须给出 `WORKER_TYPESCRIPT_UNSUPPORTED` 这类明确错误，避免把 TypeScript 当作 JavaScript module 部署。multipart metadata 和文件内容不能包含本地绝对路径、CLI token、access key、Cloudflare 资源 id 或 `--config` 文件内容。

`pages-api` 不从用户环境读取文件，也不把 Cloudflare 凭证下发给 CLI。worker artifact 的 JSON body 上限是 1 MiB；static / SPA 的 CLI 侧第一版限制为原始文件总量不超过 50 MiB、文件数不超过 5000。超限时 CLI 提前失败。DR 0003 讨论的 R2 + D1 artifact store 是长期候选能力；当前发布链路仍以 provider materialization 和 D1 版本索引为准，用户命令保持 `xd-cell deploy ./dist foo`。

这条路径不提供“失败后回退 generated-worker”。如果 asset upload session、asset bucket 上传或 Worker assets binding 失败，发布必须失败并返回明确错误，避免同一命令在不同部署中产生不同运行形态。

无论采用哪种路径，对用户暴露的心智保持一致：

```text
xd-cell deploy ./dist foo
```

用户不需要理解 execution provider、dispatch namespace、slot、asset store、gateway 或 Cloudflare binding。
