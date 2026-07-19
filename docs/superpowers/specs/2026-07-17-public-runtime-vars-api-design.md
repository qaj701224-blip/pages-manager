# XD Cell 公网 Runtime Vars API 设计

## 背景

`pages-api` 已支持通过 `PUT/DELETE /.xd-pages/api/sites/{site}/secrets` 独立管理站点级 Worker secret。普通 runtime vars 目前只能随 Worker deploy 提交，或由 Console 内部 API 逐项修改。受控集成如果只需要调整非敏感运行时配置，仍必须重新构造完整发布请求。

本设计为 vars 增加与 secrets 对称的公网管理 API。该 API 仍属于 CLI-managed 管理面：公网可达不代表匿名访问，也不重新公开 OpenAPI 文档路由。

## 目标

- 支持通过公网 Bearer API 新增、修改和删除单个站点级 runtime var。
- 复用 secrets API 的站点 slug、认证、授权和错误响应模式。
- 有 active WFP Worker 时立即同步 plain-text bindings；没有可同步 Worker 时应用于下一次 Worker deploy。
- 保持 deploy 省略 `vars` 时沿用当前站点配置、显式 `{}` 时清空配置的现有语义。
- 不在公网 API 响应中回显 var value。

## 非目标

- 不新增 vars 的 GET 或 list API。
- 不支持批量 patch、批量 replace 或 compare-and-swap 请求参数。
- 拒绝具有 token、secret、password、credential、cookie、private key 和 API/access key 等敏感语义的 var name，并要求调用方把敏感值放入 Worker secret。API 不尝试从任意 string value 中识别 secret。
- 不修改 Console 内部 API 的 URL 或 session 鉴权边界。
- 不修改 runtime binding 限额或 deploy multipart 协议；WFP provider 仅增加内部取消信号，不扩大公开 API。
- 不公开 `/openapi.json` 或 `/.xd-pages/api/openapi.json`。

## API 契约

新增与 secrets 同级的路径：

```text
PUT    /.xd-pages/api/sites/{site}/vars
DELETE /.xd-pages/api/sites/{site}/vars
```

`{site}` 是站点 slug，与 secrets API 保持一致。

PUT 请求：

```json
{
  "name": "API_BASE",
  "value": "https://api.example.com"
}
```

PUT 同时承担新增和修改。请求体必须是只含 `name`、`value` 的 JSON object；两者均为必填 string。name 在校验前 trim，value 保持原值，不做 trim。

DELETE 请求：

```json
{
  "name": "API_BASE"
}
```

请求体必须是只含 `name` 的 JSON object。删除不存在的 var 保持幂等，返回成功删除 metadata。缺少字段、额外字段或字段类型错误统一返回 `RUNTIME_VAR_INVALID`；JSON 语法错误、非 object 或 array 返回 `INVALID_JSON`。

成功响应不回显 value：

```json
{
  "var": {
    "site": "demo",
    "name": "API_BASE",
    "revision": 2,
    "updated": true,
    "appliesTo": "active_worker"
  }
}
```

删除响应：

```json
{
  "var": {
    "site": "demo",
    "name": "API_BASE",
    "deleted": true,
    "appliesTo": "next_deployment"
  }
}
```

`appliesTo` 只取 `active_worker` 或 `next_deployment`。PUT 的 `revision` 使用持久层当前 revision；重复写入相同值可以返回当前 revision，不要求生成新 revision。

## 认证与授权

请求继续由 `authenticateApiRequest` 验证 CLI token 或 access key。站点查找、不可见站点的 404 行为和 secrets API 相同：

- 个人站点只允许 owner 管理。
- 团队站点只允许 publisher 或 admin 管理。
- access key 必须具有 `deploy:site` 或 `*` scope，且 owner/site scope 必须覆盖目标站点。
- viewer、只读 access key、跨 owner/team 或跨 site scope 请求必须 fail closed。

权限不足使用 `DEPLOY_FORBIDDEN`，不新增独立的 var 管理 scope。

## 数据流

1. `handleSitesApi` 完成 Bearer 认证并匹配 vars 路径。
2. 按 slug 查找当前 actor 可管理的站点，复用 secrets 的站点管理权限。
3. 校验 JSON、binding name、非敏感命名规则、string value 和 8 KiB 单值上限。
4. 调用新的 store 单项 mutation，在取得站点 runtime config lock 后读取当前 vars、secrets 和 generation，计算 PUT 或 DELETE 后的完整 bindings，并校验 64 个 runtime bindings 总上限及 var/secret 同名冲突。
5. 在同一个 lock ownership 下写入 vars、增加 generation 并释放 lock，返回已提交的完整 vars snapshot 和 generation。调用方不得在锁外先读完整 vars 再调用 `replaceSiteVars`，避免并发单项修改互相覆盖。
6. 如果站点存在 active WFP Worker，在同一个站点级 runtime config lock 下读取最新 vars，再调用 `replacePlainTextBindings`。secret PUT/DELETE 的 provider 同步也使用这个锁，并在锁内读取 store 最新 secret 状态后决定实际 PUT 或 DELETE，避免 WFP settings 的 GET/PATCH 读改写与 secret API 并发时删除或复活 secret。兼容不提供该锁能力的 store 时，vars 同步继续使用 generation 最多稳定化三次。
7. 没有 active WFP Worker 时标记为 `next_deployment`；稳定同步完成时标记为 `active_worker`。
8. 返回不包含 value 的 mutation metadata。

新的 store mutation、site secret mutation 和 active Worker provider 同步必须共用 runtime config lock。`runtime_config_lock_id` 是 fencing token，`runtime_config_lock_expires_at` 提供 60 秒租约；provider callback 持锁期间每 20 秒续租，并以 15 秒硬超时限制单次 Cloudflare 请求。续租失去 fencing 时立即 abort 当前 WFP GET/PATCH 或 secret PUT/DELETE；Worker 异常终止后下一请求可接管过期锁，旧 token 不能释放新锁或提交 D1 runtime binding 写入。未过期 lock 被其它 mutation 或 provider 同步持有时 fail closed，并返回可重试的 `RUNTIME_CONFIG_CHANGED`；secret PUT 在提交时校验当前 vars 的名称和总 binding 数量，vars 和 secrets 的冲突/配额判断因此属于同一个原子 runtime config 决策。secret DELETE 始终允许删除现有 binding，不能因为删除前已经同名冲突或超额而拒绝清理。

`AbortSignal` 只能终止客户端等待，不能证明 Cloudflare 已撤销一个服务端已接收的写；WFP settings/secret API 目前也没有 generation CAS。因此 timeout 或续租失败必须返回失败，调用方通过重试同一 mutation 或下一次 deploy 按 store 当前状态收敛，不能把客户端 abort 描述为 provider 侧 fencing 保证。

该调整不改变 secrets 的公网 URL、请求结构或成功响应结构。secret PUT 新增 `RUNTIME_BINDING_NAME_CONFLICT`（400）和 `RUNTIME_BINDINGS_LIMIT_EXCEEDED`（413）错误，以便在 vars 同名或总配额超限时 fail closed；OpenAPI、handler 映射和回归测试必须同步。secret DELETE 不新增这两个校验错误。

公网 handler 与 Console handler 应复用同一组 vars 校验、原子 mutation 和 active Worker 稳定化同步 helper；认证上下文和响应 formatter 可以保持各自边界，避免 Console response 兼容性变化。

## 错误与一致性

公开错误保持结构化 `jsonError`：

- `INVALID_JSON`（400）：请求体 JSON 语法错误、不是 object 或是 array。
- `RUNTIME_VAR_INVALID`（400）：缺少/增加字段、name、非敏感命名或 value 类型不合法。
- `RUNTIME_BINDING_NAME_RESERVED`（400）：使用平台保留 binding name。
- `RUNTIME_VARS_LIMIT_EXCEEDED`（413）：单个 var value 超过 8 KiB，或 vars 数量超过 64。
- `RUNTIME_BINDINGS_LIMIT_EXCEEDED`（413）：vars 与 secrets 总数超过 64。
- `RUNTIME_BINDING_NAME_CONFLICT`（400）：var 与现有 site secret 同名。
- `SITE_NOT_FOUND`：站点不存在或当前凭证不可见。
- `DEPLOY_FORBIDDEN`：actor 可见但无发布级管理权限。
- `RUNTIME_CONFIG_CHANGED`（409）：runtime config lock、revision 或 active Worker 稳定化发生并发冲突，调用方可重试。
- `RUNTIME_CONFIG_UNSUPPORTED`：持久层能力不可用。
- `RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED`：D1 已提交，但 active Worker 同步失败；响应必须明确要求重试，不能返回成功。

持久层更新和 Cloudflare Worker 同步无法组成跨系统事务，沿用 secrets API 的既有语义：store commit 成功后 provider 同步失败返回 502，重试同一个 PUT/DELETE 用于收敛 active Worker。共享 provider sync lock 避免较旧的 WFP settings PATCH 与 secret PUT/DELETE 交错覆盖；锁内读取最新 store 状态，确保旧请求也向当前配置收敛。下一次正常 Worker deploy 始终从站点当前 runtime config 重建 bindings。

非预期的 store mutation 或 provider sync 异常必须向 Workers `console.error` 写入一条结构化诊断日志。日志 schema 是闭集，只允许 `event=pages_runtime_config_failure`、`operation`、`environment`、`siteId`、`stage`、`reason` 和 `errorCode`；所有动态字段在记录前都按允许值校验，不匹配时写 `unknown`。`environment` 只取 `production`、`staging`、`local`；`siteId` 只接受长度不超过 69 且匹配 `^site_[a-z0-9]{1,64}$` 的值；`operation` 只取 `var_put`、`var_delete`、`secret_put`、`secret_delete`、`plain_text_sync`、`secret_sync`；`stage` 只取 `capability_check`、`lock_acquire`、`route_state_read`、`bindings_read`、`revision_read`、`mutation_batch`、`post_commit_read`、`provider_setup`、`provider_sync`、`unknown`；`reason` 只取 `capability_unavailable`、`schema_missing`、`constraint_failed`、`database_busy`、`store_operation_failed`、`provider_configuration_failed`、`provider_request_failed`、`unknown`；`errorCode` 只取公开的 `RUNTIME_CONFIG_UNSUPPORTED`、`RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED`、`SECRET_ACTIVE_WORKER_SYNC_FAILED` 或 `unknown`。

`apps/pages-api/src/store.js` 只在重新抛出非预期异常前附加上述安全 `stage/reason` 内部标记，不直接写日志；公网 handler、Console handler 和共享 provider sync helper 作为日志归属边界，每次失败最多记录一条。capability 缺失虽然没有原始异常，也必须记录 `capability_check/capability_unavailable`。禁止把原始 `Error`、`cause` 或任意 object 作为额外 `console.error` 参数，也不得包含 constructor/name/code/message/stack、站点 slug、var name/value、secret、Bearer token、请求 header、SQL 或 bind 参数。预期的输入校验、配额、名称冲突和 runtime config 并发冲突不记为异常。日志写入必须由 `try/catch` 隔离；`console.error` 自身失败时，既有 HTTP 状态、错误码和无 value 响应保持不变。

## 实现边界

- `apps/pages-api/src/sites.js`：增加公网 vars 路由、授权入口、mutation handler、无 value 响应 formatter、共享 provider sync lock、兼容 store 的 generation 稳定化同步和脱敏异常诊断；复用 active Worker 定位逻辑，并映射 secret PUT 新增的冲突/配额错误。
- `apps/pages-api/src/console.js`：复用共同的 vars mutation 和稳定化同步 helper，不改变 Console URL、认证和既有 response contract。
- `apps/pages-api/src/store.js`：增加持有 runtime config lock 的原子单项 var mutation和 provider callback wrapper，并让 vars/secrets mutation 与 provider 同步对同一个 lock、generation、名称冲突和总配额 fail closed；非预期 mutation 异常只附加闭集 `stage/reason` 内部标记。
- `apps/pages-api/migrations/0015_runtime_config_lock_lease.sql`：增加 runtime config lock 租约到期时间，允许异常终止后的安全接管。
- `apps/pages-api/src/wfp-provider.js`、`packages/wfp-client/src/index.js`：把 lock callback 的 `AbortSignal` 传递到 WFP settings 和 secret 请求，使 provider 超时或续租失败能终止网络操作。
- `apps/pages-api/src/store.test.js`：覆盖不同名称的并发 PUT 不丢更新，以及 vars/secret 并发竞争只允许一个合法结果提交。
- `apps/pages-api/src/openapi.js`：增加 vars request schema、path、responses 和公开错误码，并给现有 secret PUT 补充冲突/配额错误；secret 成功响应保持不变。
- `apps/pages-api/src/sites.test.js`：覆盖公网正向行为、权限、校验、并发和 provider 同步失败。
- `apps/pages-api/src/openapi.test.js`：锁定新增合约和错误码。
- `docs/api-boundary.md`、受影响的 CLI/skill 文档：只同步能力边界；不把 OpenAPI 变成用户入口，也不指导普通用户手写认证 header。

除新增 nullable lock lease 列和 WFP 请求取消能力外，不修改其它 D1 业务 schema 或 Cloudflare deployment workflow。

## 测试策略

- CLI token owner、团队 publisher/admin 和匹配 `deploy:site` access key 可以 PUT/DELETE。
- viewer、read-only access key、跨站点和跨 owner/team 请求被拒绝。
- PUT 新值、覆盖旧值、重复相同值和 DELETE 不存在值均有确定响应。
- 非法 JSON、额外字段、非 string value、敏感名称、保留名称、超长 value、数量上限和 secret 同名冲突均 fail closed。
- active WFP Worker 收到完整 vars replacement；无 active Worker、assets-only route 或不支持同步的 provider 返回 `next_deployment`。
- 两个不同名称的并发 PUT 不互相丢失；vars 与 secret 的并发同名或超额 mutation 不能同时提交。
- secret PUT 在当前 vars 同名或总配额已满时返回明确错误；secret DELETE 即使面对历史冲突或超额配置也能成功清理。
- 真实 WFP settings GET/PATCH 与 secret PUT/DELETE 并发时不会删除新 secret 或复活已删除 secret；旧 secret 请求按 store 最新状态收敛。
- D1 锁竞争 fail closed，调用方收到 409 后重试可保留两个不同名 binding，且每次提交只增加一次 generation。
- 过期 D1 lock 可由新 fencing token 接管；旧 holder 不能释放新锁或提交 runtime binding 写入，未过期租约不可抢占。
- provider 操作在 15 秒超时或续租失去 fencing 时收到 abort 并返回失败；测试不把客户端取消等同于 provider 侧 CAS。
- 不提供共享锁的兼容 store 中，两次 provider 同步逆序完成时由 generation 稳定化保证 active Worker 最终等于 store；持续竞争返回 409。
- store 并发冲突返回 409；provider 同步失败返回 502，且响应不包含 var value、secret、token 或 provider detail。
- 非预期 store/provider 异常只记录一次结构化安全字段；测试使用 slug、var name/value、secret、header 以及恶意 `Error` name/code/message/stack/cause 哨兵，断言日志字段和值都属于允许集合且不包含任何哨兵、原始错误、SQL 或 bind 参数。
- capability 缺失和各 store/provider 异常阶段产生对应安全分类；输入校验、配额、名称冲突和 runtime config 并发冲突不产生日志；`console.error` 抛错时公开状态码和响应体完全不变。
- `GET /.xd-pages/api/sites/{site}/vars` 返回 405 且不泄露配置或 value；OpenAPI path 不包含 GET operation。
- 现有 deploy vars、secrets API 和 Console runtime config 测试保持通过。
- 运行 pages-api focused tests、`pnpm lint` 和完整 `pnpm test`。

## 发布与回滚

该改动不自动部署。合并后通过现有 GitHub Actions 手动对 staging 应用 D1 migration 并部署 Worker，验证 Bearer API 权限、active Worker 即时同步、过期锁恢复和下一次 deploy 继承，再按既有流程手动处理 production。Worker 回滚不会删除新增 nullable lease 列；已保存的 vars 继续由现有 deploy 和 Console 路径读取。
