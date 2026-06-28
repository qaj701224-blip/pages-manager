# ADR 0002: Auth 错误诊断模型

Status: Proposed

Date: 2026-06-19

Last updated: 2026-06-23

## 背景

XD Cell auth 同时服务浏览器登录、子站 SSO 跳转和 CLI 登录。近期 `xd-cell login` 排障暴露出一个问题：当错误码过粗时，同一个用户现象可能被误判为 callback URL 过期或重放，但实际还需要排查 SSO profile 形态、员工状态、CLI login 配对关系，以及 OAuth state 的一次性消费时机。

当前 auth 侧主要返回或渲染 `code`、`message`，部分场景带 `action`。这个模型简单且兼容，但会把多个不同失败阶段压缩成同一个错误：

- `OAUTH_STATE_INVALID` 可能是 state 格式错误、找不到 state、state 过期、state 已消费、secret mismatch 或环境不匹配。
- `SSO_EXCHANGE_FAILED` 可能是 token endpoint 失败、token 响应错误、缺少 access token、profile endpoint 失败、profile JSON 无效或 profile normalize 失败。
- `SSO_PROFILE_INACTIVE` 可能是明确 disabled / left，也可能是员工状态 unknown，或权威用户状态拒绝把用户恢复为 active。
- `CLI_LOGIN_INVALID`、`CLI_LOGIN_CONSUMED` 和 `CLI_LOGIN_CONFIRM_FAILED` 可能隐藏 login transaction 过期、secret mismatch、device code mismatch、已消费 transaction 或 Durable Object 状态异常。

直接大规模修改公开 `code` 会破坏 CLI、脚本和 agent；继续只依赖粗粒度 `code`，用户支持和线上排障会继续靠猜。与此同时，生产 `pages-auth` 已关闭 Cloudflare invocation logs，诊断模型不能默认依赖普通 Worker 日志输出细粒度原因。

## 决策

采用四层诊断架构：

```text
状态机 / 外呼 / 存储
  -> AuthDiagnosticEvent 内部事件
  -> PublicAuthError 公开投影
  -> JSON / HTML / CLI 展示
```

核心原则：

- 保留 `error.code`、`error.message` 和 `error.action` 作为稳定兼容层。
- 新增公开安全的 `reason`、`step`、`requestId`、`retryable` 和 allowlist `details`，但这些字段都属于公开投影。
- 细粒度 `internalReason` 和 `internalStep` 只属于内部诊断事件、内部 DO/service binding envelope、受控 debug sink 和测试替身，不进入公网错误响应、浏览器 HTML、CLI 普通文本、CLI JSON 或用户入口 public docs/API 示例。
- Durable Object 和 service binding 边界返回可映射的内部诊断 envelope，endpoint 负责把内部诊断投影为公开错误。
- 生产环境默认只依赖低基数指标、request correlation 和受控 debug sink，不依赖 invocation logs 承载 auth 细节。
- 公开投影的安全性按整体组合判断：新增的 `reason`、`step`、`message`、`action`、`retryable` 和 `details` 不能在既有 `code` / HTTP status 之外继续泄露 token / transaction 是否存在、是否已消费、是否匹配或属于哪个用户。
- 兼容期可以保留已经公开的旧 `code`，包括已经能区分 consumed 状态的 legacy code；新增字段不得扩大旧 code 已经存在的 oracle。后续可以单独评审是否折叠或废弃过细旧 code。

公开 JSON 错误示例：

```json
{
  "error": {
    "code": "SSO_EXCHANGE_FAILED",
    "reason": "sso_profile_unavailable",
    "step": "sso.profile",
    "message": "SSO profile is unavailable.",
    "action": "Retry login. If it keeps failing, contact the Pages platform owner with requestId.",
    "requestId": "req_xxx",
    "retryable": false
  }
}
```

内部诊断事件示例：

```json
{
  "event": "auth.error",
  "requestId": "req_xxx",
  "traceId": "trace_xxx",
  "environment": "production",
  "method": "GET",
  "host": "auth.pages.xd.team",
  "pathname": "/.xd-pages/auth/callback",
  "code": "SSO_EXCHANGE_FAILED",
  "publicReason": "sso_profile_unavailable",
  "publicStep": "sso.profile",
  "internalReason": "profile_json_invalid",
  "internalStep": "sso.profile.parse",
  "status": 502,
  "retryable": false,
  "safeDetails": {
    "providerEndpointType": "sso_profile",
    "hasCode": true,
    "hasState": true
  }
}
```

## 字段职责

- `code`：稳定、低基数的公开错误类。现有 CLI、SDK、脚本和 agent 可以继续基于它分支。
- `reason`：公开安全诊断原因。必须是低基数枚举式字符串，不能暴露 state、login、confirm token 是否存在、是否已消费、是否匹配、是否属于某个用户等可被利用的细节。同一路由下的 unknown、expired、consumed、mismatch 和 environment mismatch 默认应投影成相同公开组合，除非已有公开 `code` 兼容要求必须保留。
- `step`：公开安全失败阶段。使用小写点分层级，例如 `oauth.state`、`sso.token`、`sso.profile`、`cli.poll`、`cli.confirm`。公开 `step` 不能单独泄露 token 存在性或匹配关系。
- `requestId`：服务端生成的请求关联 ID。公网入口必须忽略客户端传入的 `X-Request-Id`、`traceparent`、`CF-Platform-Trace-Id` 或其它 correlation header，不能反射用户提供的 ID。相同 `requestId` 应进入公开错误、response header 和内部诊断事件；DO/service binding header 透传随内部诊断 envelope 在后续阶段补齐。
- `traceId`：可信边界内的链路 ID，可由 Cloudflare 提供的 `CF-Ray`、受信 service binding header 或服务端随机 ID 派生。公网入口不能把用户传入的 trace header 当作可信 `traceId`。`traceId` 默认不需要公开给用户。
- `internalReason`：内部细粒度诊断原因。只进入内部诊断事件、DO/service binding error envelope、受控 debug sink 和测试替身。
- `internalStep`：内部失败阶段，允许比公开 `step` 更细，例如 `oauth.state.consume`、`sso.profile.parse`、`cli.confirm.token.verify`。
- `message`：面向人类的简短摘要，不能承载 secret 值或 provider payload。
- `action`：用户、agent 或平台维护者可执行的下一步。
- `retryable`：可选布尔值，用于自动化或用户侧重试判断。
- `details`：公开 allowlist 对象，只放 route-specific schema 明确批准、且用户或合法调用方已经知道的输入形态，例如 `httpStatus` 或 `providerEndpointType`。默认不得放服务端状态推导出的 `stateAgeBucket`、transaction presence、token match 结果、digest 或任何能缩小 state / login / confirm transaction 状态空间的字段。
- `safeDetails`：内部 allowlist 对象，可放内部诊断需要的安全元数据，例如 `stateAgeBucket`、presence map、服务端生成的 keyed HMAC digest 或 provider endpoint type。`safeDetails` 仍禁止嵌套原始对象、数组、headers、body、URL、profile 字段、邮箱、userId、accountId、employeeNum、departments 或其它 PII。

JSON API 返回诊断字段时应放在 `error` envelope 内；浏览器 HTML 只展示公开安全子集；CLI JSON 输出保留公开诊断字段；CLI 普通文本只展示摘要、`code`、公开 `reason`、`requestId` 和 `action`。浏览器 auth 错误页的目标模型是展示用户安全摘要、可操作下一步、`code`、公开 `reason` 和 `requestId`；当前过渡切片先展示 `code` 和 `requestId`，具体 `reason` 与分场景文案随 endpoint 投影后续补齐。后续实现不能对所有 OAuth、SSO、profile 或 CLI confirm 失败都统一提示“链接过期或已使用过”。

## DO 和 service binding 边界

OAuth state、site code、CLI login 和 auth session 的 Durable Object 是一次性消费和强一致状态机边界。目标架构中这些边界都应返回可映射的内部诊断，而不是只返回 `STATE_INVALID`。当前过渡切片不要求一次性改完 DO/service binding envelope；在内部诊断切片落地前，endpoint 可以保留旧 generic fallback，但 PR 描述和测试不能宣称这些路径已有完整内部诊断。

内部错误 envelope 示例：

```json
{
  "error": {
    "code": "STATE_INVALID",
    "message": "State transition is invalid.",
    "internalReason": "already_consumed",
    "internalStep": "oauth.state.consume",
    "requestId": "req_xxx"
  }
}
```

DO/service binding 规则：

- 内部 envelope 可以包含 `internalReason` 和 `internalStep`，但不能包含 secret、token、完整 state、login secret、device code、confirm token、cookie、query string 或 profile PII。
- 调用 DO 的 endpoint 必须把内部诊断重新投影为公开错误；不得把 DO envelope 原样返回公网。
- DO helper 和测试替身应共享同一套内部 reason 枚举，避免 endpoint 通过字符串正则猜错误原因。
- 如果 DO 只能返回旧 `STATE_INVALID`，endpoint 可以保留兼容 fallback，但新测试不能把 fallback 当作目标行为。
- 内部诊断切片应优先覆盖 OAuth state 和 CLI login；site code 与 AuthSessionDO 可以继续按兼容 fallback 过渡。未实现内部 envelope 的 PR 不得宣称这些路径已有完整内部诊断。

## 公开 reason 映射

第一期实现优先保留现有 `code`，通过新增公开 `reason` 和内部 `internalReason` 表达细节；不要为了每个内部失败都新增公开 `code`。公开 reason 必须宁可折叠，也不要形成枚举 oracle。

公开 `reason` 初始集合：

- `oauth_request_invalid`
- `oauth_state_invalid_or_expired`
- `sso_token_unavailable`
- `sso_profile_unavailable`
- `sso_profile_invalid`
- `sso_user_inactive`
- `sso_user_sync_failed`
- `auth_session_unavailable`
- `cli_login_unavailable`
- `cli_login_invalid_or_expired`
- `cli_login_confirm_invalid`
- `cli_login_confirm_forbidden`
- `cli_login_confirm_unavailable`

`CLI_LOGIN_CONSUMED` 是当前实现已经公开的兼容 `code`，但新增公开 `reason` 不应继续暴露 consumed 状态。建议将它公开投影为 `cli_login_invalid_or_expired`，内部事件使用 `internalReason=already_consumed`。

推荐公开投影：

| 公开 code | 公开 reason | 公开 step |
| --- | --- | --- |
| `OAUTH_AUTHORIZE_INVALID` | `oauth_request_invalid` | `oauth.authorize` |
| `OAUTH_CALLBACK_INVALID` | `oauth_request_invalid` | `oauth.callback` |
| `OAUTH_STATE_INVALID` | `oauth_state_invalid_or_expired` | `oauth.state` |
| `SSO_EXCHANGE_FAILED` | `sso_token_unavailable` 或 `sso_profile_unavailable` | `sso.token` 或 `sso.profile` |
| `SSO_PROVIDER_UNCONFIGURED` | `sso_token_unavailable` | `sso.provider` |
| `SSO_PROFILE_INVALID` | `sso_profile_invalid` | `sso.profile` |
| `SSO_PROFILE_INACTIVE` | `sso_user_inactive` | `sso.user` |
| `SSO_USER_SYNC_FAILED` | `sso_user_sync_failed` | `sso.user_sync` |
| `AUTH_SESSION_CREATE_FAILED` | `auth_session_unavailable` | `auth.session` |
| `AUTH_SESSION_REQUIRED` | `auth_session_unavailable` | `auth.session` |
| `CLI_LOGIN_UNAVAILABLE` | `cli_login_unavailable` | `cli.start` |
| `CLI_LOGIN_INVALID` | `cli_login_invalid_or_expired` | `cli.poll` |
| `CLI_LOGIN_CONSUMED` | `cli_login_invalid_or_expired` | `cli.poll` |
| `CLI_LOGIN_ENV_MISMATCH` | `cli_login_invalid_or_expired` | `cli.poll` |
| `CLI_TOKEN_SIGN_FAILED` | `cli_login_unavailable` | `cli.poll` |
| `CLI_LOGIN_CONFIRM_INVALID` | `cli_login_confirm_invalid` | `cli.confirm` |
| `CLI_LOGIN_CONFIRM_ORIGIN_FORBIDDEN` | `cli_login_confirm_forbidden` | `cli.confirm` |
| `CLI_LOGIN_CONFIRM_TOKEN_FORBIDDEN` | `cli_login_confirm_forbidden` | `cli.confirm` |
| `CLI_LOGIN_CONFIRM_FAILED` | `cli_login_confirm_unavailable` | `cli.confirm` |
| `CLI_LOGIN_CONFIRM_CREATE_FAILED` | `cli_login_confirm_unavailable` | `cli.confirm` |

## 内部 reason 映射

内部 reason 只描述诊断分类，不自动引入新的准入策略。比如 `profile_missing_email` 或 `profile_subject_untrusted` 只有在对应实现明确新增该校验并补齐测试时才可使用；XD Cell 不应借错误诊断重新引入本地邮箱域或固定字符串人群门禁。

`OAUTH_STATE_INVALID`：

- `malformed`
- `unknown_state`
- `environment_mismatch`
- `secret_mismatch`
- `expired`
- `already_consumed`
- `storage_unavailable`

`SSO_EXCHANGE_FAILED`：

- `token_request_failed`
- `token_response_error`
- `access_token_missing`
- `profile_request_failed`
- `profile_request_forbidden`
- `profile_response_error`
- `profile_json_invalid`
- `profile_normalization_failed`

`SSO_PROFILE_INVALID`：

- `profile_missing_user_id`
- `profile_missing_email`
- `profile_subject_untrusted`

`SSO_PROFILE_INACTIVE`：

- `employee_status_disabled`
- `employee_status_left`
- `employee_status_unknown`
- `employee_status_missing_after_sync`
- `authoritative_user_inactive`

`SSO_USER_SYNC_FAILED`：

- `d1_unavailable`
- `d1_write_failed`
- `user_upsert_conflict`
- `synced_profile_invalid`

`AUTH_SESSION_CREATE_FAILED`：

- `session_do_unavailable`
- `session_record_create_failed`
- `session_jwt_sign_failed`

`CLI_LOGIN_INVALID` / `CLI_LOGIN_CONSUMED` / `CLI_LOGIN_ENV_MISMATCH`：

- `missing_login_id`
- `missing_login_secret`
- `unknown_login_id`
- `secret_mismatch`
- `expired`
- `environment_mismatch`
- `already_consumed`
- `unexpected_status`
- `storage_unavailable`
- `jwt_sign_failed`

`CLI_LOGIN_CONFIRM_FAILED`：

- `device_code_mismatch`
- `login_expired`
- `login_already_confirmed`
- `login_already_consumed`
- `state_write_failed`
- `storage_unavailable`

`CLI_LOGIN_CONFIRM_INVALID`：

- `missing_login_id`
- `missing_device_code`
- `missing_confirm_token`
- `malformed_request`

`CLI_LOGIN_CONFIRM_ORIGIN_FORBIDDEN`：

- `origin_missing`
- `origin_not_allowed`
- `referer_not_allowed`
- `sec_fetch_site_not_allowed`

`CLI_LOGIN_CONFIRM_TOKEN_FORBIDDEN`：

- `confirm_token_missing`
- `confirm_token_expired`
- `confirm_token_login_mismatch`
- `confirm_token_user_mismatch`
- `confirm_token_invalid`

## 可观测性出口

Auth 诊断有三类出口，不能混用：

1. 公开错误投影：JSON、HTML、CLI。只包含公开字段。
2. 低基数指标：失败计数、公开 `code`、公开 `reason`、公开 `step`、HTTP status、environment、endpoint 类型。用于 dashboard 和告警。
3. 受控 debug sink：内部诊断事件，允许 `internalReason` 和 `internalStep`，但必须使用 allowlist 字段，并可在生产通过采样、开关或短期排障窗口控制。

可观测性切片需要一个最小诊断出口合约，而不是先绑定具体后端：

- 提供 `emitAuthDiagnostic(event)` 这类中心 helper，所有 endpoint 和 DO fallback 通过它提交 allowlist 事件。
- 测试环境可注入 mock sink 断言事件；没有生产 sink 时 helper 可以 no-op，但必须保留 requestId 和 event builder 单测。
- 生产是否持久化由显式开关、采样率和环境配置控制；默认保留期、访问权限和导出方式必须在启用持久 sink 前写清。
- metrics label 只能使用低基数字段：公开 `code`、公开 `reason`、公开 `step`、HTTP status、environment、endpoint type。禁止把 `requestId`、`traceId`、`internalReason`、host、pathname、query key、transaction digest 或用户代理原文放进 metrics label。

生产 `pages-auth` 不应依赖 Cloudflare invocation logs 来承载细粒度 auth 诊断。后续如果需要持久化查询，应优先使用内部 audit/debug 表、队列或平台受控 analytics sink，并明确保留周期、访问权限和脱敏规则。未启用任何持久 sink 时，`requestId` 只能用于短期 debug 窗口和用户支持关联，不能承诺可长期查询。

## 安全与隐私约束

诊断字段必须按 safe-by-default 设计，不能先 dump 异常再事后脱敏。

下列值的原文禁止出现在错误响应 body / headers、HTML 错误、诊断事件、metrics labels、trace attributes、文档示例或错误测试快照中。协议成功响应中的 challenge / confirmation 字段可以按设计返回给合法调用方，例如 CLI login start 返回给 CLI 的 `loginSecret` / `deviceCode`、确认页表单中的 `confirmToken`；但这些值仍不得进入错误响应、诊断事件、metrics 或 trace。

- OAuth authorization code 或 SSO authorization code
- 完整 OAuth `state`
- SSO `access_token`、refresh token、`id_token` 或 JWT
- `client_secret`
- PKCE `code_verifier`
- OIDC `nonce`
- `loginSecret` 或 `login_secret`
- `deviceCode` 或 `device_code`
- `confirmToken`、`confirm_token` 或 CSRF token
- `loginId`、`cli_login_id`、`stateId`、`sid`、`jti` 或其它 OAuth / CLI / session transaction 标识符原文
- `Authorization`、`Cookie` 或 `Set-Cookie`
- CLI token、`X-Pages-Token` / `PAGES_TOKEN`、site auth code、access key、session token、signed capability
- OAuth、SSO token、SSO profile、callback、redirect、return 或 referer URL 的完整 query string
- `redirect_uri`、`return_to`、`Location` header、provider `error`、`error_description` 或 `error_uri`
- 原始或 normalize 后的 SSO profile payload 和 profile PII，例如 email、userId、accountId、account、realname、employeeNum、employeenum、departments
- 原始客户端 IP、完整 User-Agent 或其它可直接识别个人/设备的请求指纹
- Cloudflare account id、zone id、KV namespace id 或 Worker secrets

诊断事件必须使用 allowlist 字段。推荐安全字段包括 `requestId`、`traceId`、`event`、公开 `step`、内部 `internalStep`、`outcome`、`code`、公开 `reason`、内部 `internalReason`、HTTP status、耗时、environment、method、host、pathname、已知参数 presence map，例如 `hasCode` / `hasState`，以及为诊断专门生成的 keyed HMAC digest。除 `requestId` / `traceId` 这类 correlation ID 外，不要记录任何原始或截断后的 state / login / confirm transaction 标识，也不要记录用户可控的未知 query key 名。记录 SSO 外呼时，应记录 provider endpoint 类型，例如 `sso_token` 或 `sso_profile`，而不是完整 provider URL。

后续实现应把 denylist / allowlist 规则集中到可复用 helper，供 URL redaction、diagnostic sink、trace attributes 和错误快照测试共用。字段匹配必须覆盖大小写和 snake_case / camelCase 常见别名。

## 影响范围

落地应保持窄范围，覆盖用户和 bot 最常遇到的登录主链路。当前过渡切片先建立安全投影和关联能力：

- `apps/pages-auth/src/http.js`：新增公开 error envelope 扩展点、`X-Request-Id` header 和安全字段投影。
- `apps/pages-auth/src/index.js`：生成 request context，并向 endpoint 传递 `requestId`；DO/service binding header 透传随内部诊断 envelope 在后续阶段补齐。
- `apps/pages-auth/src/oauth-endpoints.js`：浏览器 OAuth 错误页先展示 `code` 和服务端 `requestId`；JSON 错误先接入 OAuth callback、state、SSO 和 user sync 的公开 `reason` / `step` 投影。浏览器分场景文案和公开 `reason` 展示后续补齐。
- `apps/pages-cli/src/api-client.js` 和 `apps/pages-cli/src/main.js`：保留并展示公开 `reason`、`step`、`requestId`、`retryable` 和 allowlist `details`，尤其是 JSON 输出；普通文本只追加安全摘要。
- URL redaction helper：诊断场景删除完整 query string 和 fragment，不保留未知 query key；避免 provider 当前 GET/query 协议把 code、client secret、access token 或 return URL 泄露到错误快照。

非目标和延后项：

- `METHOD_NOT_ALLOWED`、`INVALID_JSON`、`NOT_FOUND`、`AUTH_ENV_INVALID` 等通用协议错误第一期只需要接入 `requestId`、安全 envelope 和泄漏测试，不必强行新增细粒度 auth `reason`。
- `apps/pages-auth/src/cli-endpoints.js` 的 CLI login poll / confirm 当前先通过 `code` 默认映射输出公开 `reason` / `step`，consumed/env mismatch 的公开 reason 折叠为 `cli_login_invalid_or_expired`；更细的内部 reason 细分在后续内部诊断切片补齐。
- `SITE_CODE_CONSUME_INVALID`、`SITE_CODE_INVALID`、`CLI_TOKEN_INVALID` 等内部 service binding 接口错误第一期保持 fail-closed 和 no-store；如需新增诊断字段，必须先确认调用方不会把内部 envelope 透传到公网。
- DO/service binding 的 requestId 透传、内部 error envelope 和 site code / AuthSessionDO 的完整内部 reason 可在第二期补齐；第一期实现若只保留 generic fallback，需要在测试和 PR 描述里明确标记。
- auth 诊断事件 helper、mock sink、metrics 和受控 debug sink 属于可观测性切片；未实现前只能声明 requestId 可用于短期用户支持关联，不能承诺可查询内部诊断事件。

推荐拆成小 PR 顺序落地，避免一次性破坏现有精确断言：

1. 安全投影基础：redaction/allowlist helper、`jsonError` 公开可选字段、`X-Request-Id`、浏览器错误页 requestId、CLI 透传公开诊断字段；旧 `code/message/action` 保持不变。
2. 内部诊断基础：新增诊断对象、OAuth state / CLI login DO internal envelope，同时保留旧 `STATE_INVALID` fallback。
3. endpoint 公开投影：OAuth callback 与 CLI poll/confirm 接入公开 `reason` / `step`，折叠 consumed/env mismatch，不扩大旧 code 已有 oracle。
4. 浏览器错误页：展示公开 `reason` 和分场景可操作 action，并保持 `Cache-Control: no-store`、`Referrer-Policy` 和 HTML escaping。
5. 可观测性：接入 `emitAuthDiagnostic(event)`、低基数指标或受控 debug sink；如果没有持久 sink，本阶段只能声明短期 debug 能力。

兼容矩阵：

| 输入 / 旧行为 | 兼容要求 | 新增行为 |
| --- | --- | --- |
| 旧 DO 只返回 `STATE_INVALID` | endpoint 保留旧 fallback，不抛未处理异常 | 可记录 `internalReason=unknown` 或 `storage_unavailable` |
| `OAUTH_STATE_INVALID` | 公开 `code` 保持 | 新增公开 `reason=oauth_state_invalid_or_expired` |
| `CLI_LOGIN_INVALID` | 公开 `code` 保持 | 新增公开 `reason=cli_login_invalid_or_expired` |
| `CLI_LOGIN_CONSUMED` | 兼容期公开 `code` 可保持 | 新增公开 `reason` 不暴露 consumed，内部用 `already_consumed` |
| `CLI_LOGIN_ENV_MISMATCH` | 兼容期公开 `code` 可保持 | 新增公开 `reason` 不暴露 env mismatch，内部用 `environment_mismatch` |
| 旧 CLI `ApiError(code/message/action)` | 旧字段继续可用，不补 `null` 字段 | 新字段存在时才输出；未知 `details` 丢弃 |

第二期可以把同一模型扩展到 `pages-api` 控制面 auth 错误，以及 `pages-router` 的 site session / access failure。扩展前必须复核 `pages-api` 不公开 `/openapi.json` 的边界，以及 router visibility / ACL 的 fail-closed 行为。

第三期可以再引入共享 error registry，统一 `pages-auth`、`pages-api`、`pages-router`、CLI、OpenAPI 和 public docs。registry 必须渐进引入，不能成为第一期登录诊断修复的前置大重构。

## 兼容性

本决策是 additive 的：

- 不删除或重命名现有 `error.code`、`error.message` 或 `error.action`。
- 不要求旧客户端理解 `reason`、`step`、`requestId`、`retryable` 或 `details`。
- 当前已经公开的 `CLI_LOGIN_CONSUMED` code 可以保留兼容，但新增公开 reason 应折叠为 `cli_login_invalid_or_expired`。
- 在对应实现发布前，不要在开发期 OpenAPI 合约或用户文档里宣称这些可选诊断字段已可用。
- 错误示例中不要编码环境专属 secret、provider URL、Cloudflare 资源 id 或真实内部账号信息。
- 本 ADR 不要求一次性落完所有运行时代码变更；实现 PR 应按阶段修改对应代码和测试。本变更可以同步落地第一阶段的 request context、公开 error envelope 扩展点和安全投影基础。
- `pages-auth` staging 和 production 的诊断 sink、metrics、auth base 和示例必须物理或配置隔离；staging 验证不能写入 production debug 资源。
- 字段实际发布后，才同步 `apps/pages-api/src/openapi.js` 开发期合约、CLI help、README、skill 或用户文档；同步前这些字段只存在于 ADR 和内部实现测试。

如果某个实现需要新增公开 `code`，必须说明为什么 `code + reason` 不足，并在同一个变更里更新 CLI、测试和文档。

## 测试要求

Auth 诊断的行为变更必须包含 focused `node:test`，同时覆盖分类准确性和敏感信息不泄露。不同落地切片按实际修改范围选择对应测试，不要求安全投影基础 PR 一次补齐 DO envelope、debug sink 或所有 endpoint reason 映射。

安全投影基础测试：

- redaction / allowlist helper 覆盖大小写、snake_case / camelCase 别名和完整 query string。
- `jsonError` / browser error helper 应只输出公开字段，永不输出 `internalReason` 或 `internalStep`。
- request context 应生成服务端 `requestId`，忽略公网 correlation header，并在 JSON/HTML 错误响应和 `X-Request-Id` header 中保持一致。
- JSON 错误保持 `Content-Type: application/json` 和 `Cache-Control: no-store`；HTML 错误保持 `Content-Type: text/html`、`Cache-Control: no-store`、`Referrer-Policy` 和 HTML escaping；错误响应不得意外带 `Location`。
- `ApiError` 保留公开 `reason`、`step`、`requestId`、`retryable` 和 allowlist `details`，旧 `code/message/action` 仍可单独工作。
- `--json` 保持现有 `schemaVersion`，只在字段存在时输出可选诊断字段，不补 `null` 或空对象；未知 `details` 字段丢弃。
- 普通文本只展示安全摘要，负向断言不包含 `internalReason`、`internalStep`、secret、token、完整 query string 或 provider payload。

后续内部诊断和 endpoint 投影测试：

- diagnostic event builder 只输出 allowlist 字段，metrics event builder 只输出低基数 label。
- mock sink 可断言 `internalReason` / `internalStep`，但公开 error builder 永不输出它们。
- DO/service binding 返回内部诊断时，endpoint 应正确投影为公开 `reason`，并且不能把内部 envelope 原样返回公网。
- callback state 失败在底层存储能提供信息时，内部诊断应区分 expired、already consumed、malformed 和 mismatch；公开响应应折叠为不会形成 oracle 的整体组合。
- SSO token endpoint 失败、token 响应错误、profile endpoint 401/403、profile endpoint 5xx、profile JSON 无效、缺少 profile 标识字段，应映射到不同的安全内部 `internalReason`，并输出稳定公开 `reason`。
- unknown employee status 必须 fail closed，但要和明确 disabled / left 在内部诊断中区分。
- CLI poll 和 confirm 失败在内部应区分 expired login、consumed login、secret mismatch、device code mismatch、confirmation token mismatch；公开响应不能新增暴露 token 是否存在或是否匹配的组合。

所有层的错误响应 body / headers、诊断事件、metrics labels、trace attributes 和错误快照不得包含 OAuth authorization code、完整 `state`、SSO tokens、`client_secret`、`loginSecret`、`deviceCode`、`confirmToken`、cookies 或完整 query strings。公开响应快照只能断言公开 `reason`；细粒度 `internalReason` 只能通过 mock diagnostic sink、DO internal envelope 或受控内部测试断言。

## 后果

收益：

- 支持同学可以区分 callback 重放、SSO profile 问题、员工状态问题和 CLI 配对问题。
- bot 和 CLI 用户可以获得可操作错误，而不需要解析模糊文案。
- 现有消费者继续兼容，因为 `code`、`message` 和 `action` 保持稳定。
- `requestId` 让浏览器、CLI、endpoint、Durable Object 和受控诊断事件更容易串联。
- 诊断不再依赖生产 invocation logs，和当前 `pages-auth` 运维配置一致。

代价：

- 错误处理会更显式，需要为关键失败阶段补测试。
- 后续 DO/service binding 内部诊断切片会触及状态机 helper。
- 项目需要持续维护诊断字段的 denylist、allowlist 和公开/内部投影纪律。
- 未来全局 registry 可能有价值，但过早推进会让第一期登录修复变大、变慢、风险更高。
