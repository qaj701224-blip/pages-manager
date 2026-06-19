# ADR 0002: Auth 错误诊断模型

Status: Proposed

Date: 2026-06-19

## 背景

XD Pages auth 同时服务浏览器登录和 CLI 登录。近期 `pages login` 排障暴露出一个问题：当错误码过粗时，同一个用户现象可能被误判为 callback URL 过期或重放，但实际还需要排查 SSO profile 形态、员工状态、CLI login 配对关系，以及 OAuth state 的一次性消费时机。

当前 auth 侧主要返回或渲染 `code`、`message`，部分场景带 `action`。这个模型简单且兼容，但会把多个不同失败阶段压缩成同一个错误：

- `OAUTH_STATE_INVALID` 可能是 state 格式错误、找不到 state、state 过期、state 已消费、secret mismatch 或环境不匹配。
- `SSO_EXCHANGE_FAILED` 可能是 token endpoint 失败、token 响应错误、缺少 access token、profile endpoint 失败、profile JSON 无效或 profile normalize 失败。
- `SSO_PROFILE_INACTIVE` 可能是明确 disabled / left，也可能是员工状态 unknown，或权威用户状态拒绝把用户恢复为 active。
- `CLI_LOGIN_INVALID` 和 `CLI_LOGIN_CONFIRM_FAILED` 可能隐藏 login transaction 过期、secret mismatch、device code mismatch、已消费 transaction 或 Durable Object 状态异常。

如果直接大规模修改现有公开 `code`，CLI、脚本和 agent 可能被破坏；如果继续只依赖粗粒度 `code`，用户支持和线上排障会继续靠猜。

## 决策

保留 `error.code`、`error.message` 和 `error.action` 作为稳定兼容层。在 auth 和 CLI 登录错误中新增可选、结构化、安全的诊断字段。公开响应和内部日志必须区分：公开响应只能返回不会形成枚举 oracle 的粗粒度 `reason`，细粒度原因使用 `internalReason`，只进入受控结构化日志和测试替身。

```json
{
  "error": {
    "code": "SSO_EXCHANGE_FAILED",
    "reason": "sso_profile_unavailable",
    "step": "sso.profile.fetch",
    "message": "SSO profile request failed.",
    "action": "Retry login. If it keeps failing, contact the Pages platform owner with requestId.",
    "requestId": "req_xxx",
    "retryable": false
  }
}
```

字段职责：

- `code`：稳定、低基数的公开错误类。现有 CLI、SDK、脚本和 agent 可以继续基于它分支。
- `reason`：公开安全诊断原因。必须是低基数枚举式字符串，不能暴露 state / login / confirm token 是否存在、是否已消费、是否用户不匹配等可被利用的细节。
- `internalReason`：内部细粒度诊断原因。只能进入受控结构化日志、mock logger 测试和内部排障查询，不能进入浏览器 HTML、公开 JSON 响应、CLI 普通文本或 public docs 示例。
- `step`：失败阶段，使用小写点分层级，例如 `oauth.state.consume`、`sso.token.fetch`、`sso.profile.normalize`、`cli.confirm.consume`。公开响应中的 `step` 也必须保持粗粒度，不能单独泄露 token 存在性或匹配关系。
- `requestId`：请求关联 ID。`pages-auth` 入口应为每个请求生成服务端 request context；可以把可信边界内的 `CF-Ray` / trace header 作为 `traceId` 或派生来源，但不能直接信任客户端传入的任意 ID。相同 `requestId` 应进入 JSON/HTML 错误、response header、结构化日志，并通过内部 DO/service binding header 透传，保证 endpoint、Durable Object 和 CLI poll/confirm 日志可串联。
- `message`：面向人类的简短摘要，不能承载 secret 值或 provider payload。
- `action`：用户、agent 或平台维护者可执行的下一步。
- `retryable`：可选布尔值，用于自动化或用户侧重试判断。
- `details`：可选 allowlist 对象，只放 route-specific schema 允许的安全元数据，例如 `httpStatus`、`providerEndpointType`、`stateAgeBucket` 或布尔 presence flag。禁止嵌套原始对象、数组、headers、body、URL、profile 字段、邮箱、userId、accountId、employeeNum、departments 或其它 PII。

JSON API 返回诊断字段时应放在 `error` envelope 内；浏览器 HTML 只展示公开安全子集；CLI JSON 输出应保留公开诊断字段；CLI 普通文本只展示摘要、`code`、公开 `reason`、`requestId` 和 `action`。浏览器 auth 错误页也应使用同一模型：展示用户安全摘要、可操作下一步、`code`、公开 `reason` 和 `requestId`。不能对所有 OAuth、SSO、profile 或 CLI confirm 失败都统一提示“链接过期或已使用过”。

## 推荐 reason 映射

第一期实现优先保留现有 `code`，通过新增公开 `reason` 和内部 `internalReason` 表达细节；不要为了每个内部失败都新增公开 `code`。本节是初始映射建议，不要求第一个实现 PR 一次覆盖所有枚举；但新增行为时必须遵守公开/内部原因分层。

公开 `reason` 示例：

- `oauth_state_invalid_or_expired`
- `sso_token_unavailable`
- `sso_profile_unavailable`
- `sso_profile_invalid`
- `sso_user_inactive`
- `sso_user_sync_failed`
- `auth_session_unavailable`
- `cli_login_invalid_or_expired`
- `cli_login_already_consumed`
- `cli_login_confirm_invalid`
- `cli_login_confirm_forbidden`

内部 `internalReason` 示例：

这些内部 reason 只描述诊断分类，不自动引入新的准入策略。比如 `profile_missing_email` 或 `profile_subject_untrusted` 只有在对应实现明确新增该校验并补齐测试时才可使用；XD Pages 不应借错误诊断重新引入本地邮箱域或固定字符串人群门禁。

`OAUTH_STATE_INVALID`：

- `malformed`
- `unknown_state`
- `environment_mismatch`
- `secret_mismatch`
- `expired`
- `already_consumed`

`SSO_EXCHANGE_FAILED`：

- `token_request_failed`
- `token_response_error`
- `access_token_missing`
- `profile_request_failed`
- `profile_request_forbidden`
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

`CLI_LOGIN_INVALID`：

- `missing_login_id`
- `missing_login_secret`
- `unknown_login_id`
- `secret_mismatch`
- `expired`
- `environment_mismatch`
- `already_consumed`
- `unexpected_status`

`CLI_LOGIN_CONSUMED`：

- `already_consumed`

`CLI_LOGIN_ENV_MISMATCH`：

- `environment_mismatch`

`CLI_LOGIN_CONFIRM_FAILED`：

- `device_code_mismatch`
- `login_expired`
- `login_already_confirmed`
- `login_already_consumed`
- `state_write_failed`

`CLI_LOGIN_CONFIRM_INVALID`：

- `missing_login_id`
- `missing_device_code`
- `missing_confirm_token`
- `malformed_request`

`CLI_LOGIN_CONFIRM_ORIGIN_FORBIDDEN`：

- `origin_missing`
- `origin_not_allowed`
- `referer_not_allowed`

`CLI_LOGIN_CONFIRM_TOKEN_FORBIDDEN`：

- `confirm_token_missing`
- `confirm_token_expired`
- `confirm_token_login_mismatch`
- `confirm_token_user_mismatch`

## 安全与隐私约束

诊断字段必须按 safe-by-default 设计，不能先 dump 异常再事后脱敏。

下列值的原文禁止出现在错误响应 body / headers、HTML 错误、诊断日志、trace attributes、文档示例或错误测试快照中。协议成功响应中的 challenge / confirmation 字段可以按设计返回给合法调用方，例如 CLI login start 返回给 CLI 的 `loginSecret` / `deviceCode`、确认页表单中的 `confirmToken`；但这些值仍不得进入错误响应、日志或 trace。

- OAuth authorization code 或 SSO authorization code
- 完整 OAuth `state`
- SSO `access_token`、refresh token、`id_token` 或 JWT
- `client_secret`
- PKCE `code_verifier`
- OIDC `nonce`
- `loginSecret` 或 `login_secret`
- `deviceCode` 或 `device_code`
- `confirmToken`、`confirm_token` 或 CSRF token
- `Authorization`、`Cookie` 或 `Set-Cookie`
- CLI token、`X-Pages-Token` / `PAGES_TOKEN`、site auth code、access key、session token、signed capability
- OAuth、SSO token、SSO profile、callback、redirect、return 或 referer URL 的完整 query string
- `redirect_uri`、`return_to`、`Location` header、provider `error_description`
- 原始或 normalize 后的 SSO profile payload 和 profile PII，例如 email、userId、accountId、employeeNum、departments
- Cloudflare account id、zone id、KV namespace id 或 Worker secrets

结构化 auth 日志必须使用 allowlist 字段。推荐的安全字段包括 `requestId`、`traceId`、`event`、`step`、`outcome`、`code`、公开 `reason`、内部 `internalReason`、HTTP status、耗时、environment、method、host、pathname、已知参数 presence map，例如 `has_code` / `has_state`，以及服务端生成的非敏感 ID 或 keyed HMAC digest。不要记录原始或截断后的 state / login / confirm transaction 标识，也不要记录用户可控的未知 query key 名。记录 SSO 外呼时，应记录 provider endpoint 类型，例如 `sso_token` 或 `sso_profile`，而不是完整 provider URL。

## 影响范围

第一期应保持窄范围，优先覆盖用户和 bot 最常遇到的登录主链路：

- `apps/pages-auth/src/oauth-endpoints.js`：OAuth callback、state 消费、SSO token exchange、SSO profile fetch / normalize、user sync、session create。
- `apps/pages-auth/src/cli-endpoints.js`：CLI login poll 和 confirm 错误。
- `apps/pages-auth/src/index.js`、OAuth state / CLI login Durable Object storage 和相关 helper：保证 DO 边界能返回可映射的内部诊断，而不是把 expired / consumed / mismatch 全部压成 generic storage failure。
- `apps/pages-auth/src/http.js` 和浏览器页面 helper：新增兼容的错误 envelope 字段和用户安全 HTML 细节。
- `apps/pages-cli/src/api-client.js` 和 CLI 输出格式化：保留并展示可选 `reason`、`step` 和 `requestId`，尤其是 JSON 输出。
- auth request context 和结构化日志 helper：生成并透传 `requestId` / `traceId`，提供测试替身，避免 endpoint、DO 和 CLI poll/confirm 各自生成不同关联 ID。

第二期可以把同一模型扩展到 `pages-api` 控制面 auth 错误，以及 `pages-router` 的 site session / access failure。

第三期可以再引入共享 error registry，统一 `pages-auth`、`pages-api`、`pages-router`、CLI、OpenAPI 和 public docs。registry 必须渐进引入，不能成为第一期登录诊断修复的前置大重构。

## 兼容性

本决策是 additive 的：

- 不删除或重命名现有 `error.code`、`error.message` 或 `error.action`。
- 不要求旧客户端理解 `reason`、`step`、`requestId`、`retryable` 或 `details`。
- 在对应实现发布前，不要在 public OpenAPI 或用户文档里宣称这些可选诊断字段已可用。
- 错误示例中不要编码环境专属 secret、provider URL 或私有资源 id。
- 本 ADR 不实现运行时代码变更，也不改变当前线上错误响应；后续实现 PR 应按阶段修改对应代码和测试。

如果某个实现需要新增公开 `code`，必须说明为什么 `code + reason` 不足，并在同一个变更里更新 CLI、测试和文档。

## 测试要求

Auth 诊断的行为变更必须包含 focused `node:test`，同时覆盖分类准确性和敏感信息不泄露：

- callback state 失败在底层存储能提供信息时，内部日志应区分 expired、already consumed、malformed 和 mismatch；公开响应应折叠为不会形成 oracle 的 `reason`；
- SSO token endpoint 失败、token 响应错误、profile endpoint 401/403、profile endpoint 5xx、profile JSON 无效、缺少 profile 标识字段，应映射到不同的安全内部 `internalReason`，并输出稳定公开 `reason`；
- unknown employee status 必须 fail closed，但要和明确 disabled / left 区分；
- CLI poll 和 confirm 失败在内部应区分 expired login、consumed login、secret mismatch、device code mismatch、confirmation token mismatch；公开响应不能暴露 token 是否存在或是否匹配；
- CLI 客户端侧测试应确认 `ApiError` 保留公开 `reason`、`step`、`requestId`，`--json` 输出这些可选字段，普通文本只展示安全摘要；
- 实现 request correlation 后，浏览器和 JSON 错误响应应包含 `code`、可操作 `action` 和 request correlation；
- 错误响应 body / headers、诊断日志、trace attributes 和错误快照不得包含 OAuth authorization code、完整 `state`、SSO tokens、`client_secret`、`loginSecret`、`deviceCode`、`confirmToken`、cookies 或完整 query strings；
- 公开响应快照只能断言公开 `reason`；细粒度 `internalReason` 只能通过 mock logger 或受控日志测试断言。

## 后果

收益：

- 支持同学可以区分 callback 重放、SSO profile 问题、员工状态问题和 CLI 配对问题。
- bot 和 CLI 用户可以获得可操作错误，而不需要解析模糊文案。
- 现有消费者继续兼容，因为 `code`、`message` 和 `action` 保持稳定。
- `requestId` 让浏览器、CLI、Worker log 和 Durable Object 失败更容易串联。

代价：

- 错误处理会更显式，需要为关键失败阶段补测试。
- 项目需要持续维护诊断字段的 denylist 和 allowlist 纪律。
- 未来全局 registry 可能有价值，但过早推进会让第一期登录修复变大、变慢、风险更高。
