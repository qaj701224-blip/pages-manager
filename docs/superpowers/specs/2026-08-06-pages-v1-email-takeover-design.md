# XD Cell v2 按邮箱无感接管 v1 同名站点设计

## 背景

XD Cell v1 legacy 站点仍可能同时占用以下资源：

- v2 D1 `hostname_claims` 中 `owner_system = 'v1'` 的 hostname claim。
- Cloudflare exact route：`<slug>.workers.xd.team/*` 或 staging 对应 route。
- Cloudflare Worker script：production 默认 `pages-<slug>`，staging 使用对应环境前缀。
- v1 `SITES` KV 中以 slug 为 key 的站点 metadata，其中 `token = 'pages_<email>'` 是历史归属标记。

v1 公网管理 API 已退休，但历史站点资源仍保留。v2 用户通过 SSO、CLI login access key 或 Cindy connection assertion 获得可信 `actor.email`。当前用户创建或部署同名 v2 站点时，`store.createSite` 因 v1 claim 返回 `HOSTNAME_CLAIM_CONFLICT`，用户无法自助迁移。

本设计允许 `pages-api` 在确认 v2 actor 邮箱与 v1 token 邮箱一致时，直接清理该 v1 站点资源、把 claim 原子转换为 v2 所有权，并继续原有 v2 创建或部署流程。该行为完全由服务端完成，不修改调用方协议，用户无感。

## 目标

- v2 认证 actor 使用与 v1 站点 token 相同的邮箱创建或部署同名站点时，自动接管并继续正常 v2 流程。
- 同时覆盖 `POST /.xd-pages/api/sites` 和 `POST /.xd-pages/api/deployments`，不依赖调用方类型或 CLI 特殊重试。
- `pages-api` 直接绑定 v1 `SITES` KV 并调用 Cloudflare API，不依赖 `apps/server` 运行时。
- 复用 pages-api 已有的 `CF_ACCOUNT_ID`、`CF_API_TOKEN` 和 zone 配置权限，staging / production 资源严格隔离。
- 所有破坏性清理只针对经过 hostname、environment、claim、KV metadata、script 和 route 多重校验的单个 v1 站点。
- Cloudflare、D1 或 KV 任一步失败后都能安全重试，不发生跨用户接管或错误资源删除。
- takeover 成功响应与普通 v2 创建、部署响应保持一致，不要求用户确认或传入新参数。

## 非目标

- 不恢复 v1 公网 API，也不修改 `apps/server` 的 `410 LEGACY_API_RETIRED` 行为。
- 不批量迁移 v1 站点，不扫描或主动清理未被 v2 用户请求的 v1 资源。
- 不迁移 v1 站点内容、历史版本、访问策略或 metadata 到 v2；新请求上传的内容成为 v2 首个版本。
- 不允许管理员、团队身份或其它凭据绕过邮箱验证。
- 不把 v1 token、完整 KV JSON、邮箱或 Cloudflare 原始错误写入公开响应、hostname claim 或普通日志。
- 不新增 CLI flag、确认提示、独立 takeover endpoint 或公开 OpenAPI 路径。

## 外部行为

现有 API 请求和成功响应不变。调用方不需要知道 takeover 是否发生。

### 站点创建

当 `POST /.xd-pages/api/sites` 创建的 hostname 被 live v1 claim 占用时，pages-api 尝试 takeover。成功后返回现有 `201` site envelope；失败时按本文错误语义返回。

### 部署

`POST /.xd-pages/api/deployments` 按既有协议解析、校验内容并解析目标站点。目标 slug 不存在 v2 site、但被 live v1 claim 占用时，pages-api 在 pending site creation 阶段执行同一 takeover 流程。成功后继续建立 deployment、上传新 v2 artifact 并激活 route，最终响应与普通部署一致。

当前 `xd-cell deploy` 对 user credential 会先调用 sites API 再调用 deployments API；其它调用方可以直接调用 deployments API。因此两个入口必须共用同一 takeover service，不能只在其中一个 handler 实现。

### 不可接管冲突

以下情况继续表现为 `HOSTNAME_CLAIM_CONFLICT`，不得向调用方区分“邮箱不匹配”“KV 缺失”或其它 owner 细节：

- claim 不是 v1 所有权。
- actor 没有可验证邮箱。
- v1 KV 记录不存在、格式不合法或 token 不是严格支持的 legacy token 格式。
- canonical email 不一致。
- claim、hostname、slug、scriptName 或 environment 之间不一致。

## 认证与邮箱匹配

takeover 只依赖已经通过 `authenticateApiRequest` 的 actor。支持条件是 `actor.email` 存在且可 canonicalize；不按 `actor.type`、CLI、Cindy 或其它调用方来源分支。

邮箱 canonicalization 规则保持保守：

- string trim 后转小写。
- 必须是 pages-api 已接受并持久化的用户邮箱格式。
- 不移除 `+tag`，不折叠 Gmail dot，不做域名别名推断。
- v1 token prefix 必须精确为小写 `pages_`；prefix 后的 email 与 actor email 分别 canonicalize 后比较。

team access key 当前 `actor.email = null`，因此不能自动接管。user CLI login access key、user-owned access key 和通过验证的 Cindy connection actor 都可使用其已解析邮箱。站点创建 API 当前只允许 user actor，原有授权边界不变；部署 API 仍遵循现有 actor scope 和 owner 规则。

v1 token 是弱历史标记，不能用于普通认证；本设计仅在“强认证 v2 actor 主动请求同 slug”且全部资源定位信息一致时把它作为迁移归属证据。

## 模块边界

新增专用目录，避免把 v1 清理、Cloudflare 调用和 handler 流程耦合在同一个文件：

```text
apps/pages-api/src/legacy-v1/
├── takeover.js
├── ownership.js
├── cloudflare-cleanup.js
└── takeover.test.js
```

各模块职责：

- `takeover.js`：流程编排和状态收敛。输入是 `env`、`store`、actor、environment、slug、hostname 和待创建的 v2 site 数据；输出只区分 `not_needed`、`taken_over`、结构化公开错误。
- `ownership.js`：读取 `env.V1_SITES`、校验 v1 metadata schema、canonicalize email、比较 legacy token，并生成不包含 token 的已验证 cleanup target。
- `cloudflare-cleanup.js`：封装 Cloudflare route/script 查询和删除；只接受 ownership 模块产出的已验证 target，并执行独立的破坏性安全门禁。
- `store.js`：提供 claim 查询和 `createSiteByTakingOverV1Claim` 原子 mutation，不读取 KV、不调用 Cloudflare。
- `sites.js`、`deployments.js`：只调用共享 takeover service 并映射结果，不包含 v1 token、route 或 script 清理细节。
- `config.js`：读取 takeover 所需 runtime 配置和环境前缀；缺失配置只在实际出现 v1 takeover 候选时 fail closed，不影响普通 v2 请求。

`apps/pages-api` 不直接 import `apps/server/src`。现有 v1 helper 可以作为行为参考，但实现留在 `legacy-v1/`，使未来删除 v1 takeover 时可以移除完整目录和少量接入点。暂不建立新的共享 package，因为 v1 公网 API 已退休，跨 app 复用不再是长期需求。

## Takeover 前置条件

只有同时满足以下条件才进入破坏性清理：

1. 当前 environment 下不存在 active v2 同 slug site。
2. 目标 hostname 与 `hostnameForSlug(slug, config)` 完全一致。
3. `hostname_claims` 存在目标 hostname 的 active claim，且：
   - `environment` 与当前环境一致。
   - `normalized_slug` 与请求 slug 一致。
   - `hostname_family = 'workers'`。
   - `owner_system = 'v1'`。
   - `status = 'active'`。`pending`、`held`、`conflicted` 都属于不确定或过渡状态，不执行自动破坏性接管。
4. actor 有可 canonicalize 的 email。
5. `V1_SITES.get(slug, 'json')` 返回合法对象，其 name（若存在）、URL hostname（若存在）和 scriptName 均与目标资源一致。
6. v1 token 严格匹配 actor canonical email。
7. scriptName 同时满足：
   - 与 claim `owner_ref` 一致；若历史 claim 没有 `owner_ref`，只允许使用 KV 中的 scriptName。
   - 匹配当前环境的精确 v1 worker 命名规则。
   - 不属于 pages-api、pages-router、pages-auth、pages-manager、kv-gateway 或 normal-worker slot 等平台保留名称 / 前缀。

任一前置条件不满足都不得调用 Cloudflare DELETE。

## Cloudflare 清理安全门禁

`cloudflare-cleanup.js` 使用 pages-api 已有 `CF_ACCOUNT_ID`、`CF_API_TOKEN` 和当前环境 zone id。Cloudflare 操作必须保留以下限制：

- route pattern 只能是由已验证 hostname 构造的 `${hostname}/*`。
- pattern 必须是单个精确 hostname，不含 wildcard，且 hostname 必须属于当前环境的 `workers.xd.team` 命名规则。
- 删除 route 前先列出 zone routes；找到 exact route 时，其绑定 script 必须等于已验证 scriptName，否则返回安全冲突并拒绝删除。
- exact route 不存在视为已清理，允许幂等重试。
- 删除 Worker 前查询或执行 DELETE；Cloudflare 明确返回 not found 视为已清理。
- Worker 删除只能针对已验证 v1 scriptName，不能接受调用方提供的任意 script。
- route/script 的其它 4xx、5xx、网络错误或无法解析的响应均 fail closed。
- 不能删除 wildcard router route、custom domain、KV namespace、D1、v2 Worker、normal-worker slot 或其它 slug 的资源。

清理顺序是 exact route → Worker。先移除 exact route，避免已删除 Worker 仍被更具体的 route 命中而遮蔽 v2 wildcard router。

## 数据流与一致性

### 普通无冲突路径

1. handler 按现有方式解析 actor、slug、owner、visibility 和 hostname。
2. store 不存在 live v1 claim 时，直接执行现有 `createSite`。
3. 不读取 v1 KV，不调用 Cloudflare，不改变普通部署性能和错误语义。

### v1 takeover 路径

1. handler 或 pending site creation 调用 `takeoverV1Site`。
2. takeover service 查询 exact hostname claim。不是 live v1 claim时返回 `not_needed`，调用方进入原有 createSite 路径，由 store 的现有冲突门禁作最终裁决。
3. ownership 模块读取 v1 KV，校验 actor email、token 和完整资源定位信息。
4. Cloudflare 模块幂等删除 exact route，再幂等删除 Worker。
5. store 执行 `createSiteByTakingOverV1Claim` 单个 D1 batch：
   - 再次确认不存在 active v2 同 slug site。
   - CAS 校验原 claim 的 hostname、environment、slug、owner system、owner id、owner ref 和允许状态仍与已验证 snapshot 一致。
   - 把原 claim 原地更新为新的 v2 claim，设置 `owner_system = 'v2'`、`owner_id = site.id`、`owner_ref = route.id`、`status = 'active'`、`source = 'v1_email_takeover'`，清空 release / hold 字段。
   - 插入 `sites`、`site_routes`、owner `site_members`。
   - 写入不含邮箱、token 和完整 KV metadata 的 audit event，记录 actor user id、hostname、v1 owner id / ref 和 takeover result。
6. D1 batch 成功后删除 `V1_SITES` 的 slug key。
7. 返回普通 created site，deployment 路径继续上传和发布。

D1 batch 必须通过 guard statement 或等价机制确保 claim CAS 未命中时整个 batch 失败；不能先把 claim release 再调用普通 `createSite`，否则并发请求可能在空窗期抢占 hostname。

### KV 删除失败

D1 已完成 v2 接管后，v1 KV 只剩历史残留，不再具有 hostname 权威性。此时 KV 删除失败不能回滚已创建的 v2 site，也不能向用户报告部署失败并诱导重复创建。

处理方式：

- takeover service 创建 `deployment_resource_cleanup_tasks`，`resource_type = 'v1_sites_kv_record'`，`resource_ref` 只保存 slug，不保存 token 或 KV JSON。
- scheduled cleanup runner 增加该 resource type 的处理分支，只删除当前 environment 对应 `V1_SITES` key。
- 创建 cleanup task 失败时记录脱敏结构化错误并继续返回成功；残留 KV 不再能触发 takeover，因为 claim 已属于 v2。
- 管理端 cleanup API 必须为新 resource type 增加独立 allowlist 和执行器，不能把 slug 当作 Worker name 传入现有 WFP cleanup 路径。

## 并发行为

- 两个同邮箱请求并发 takeover：都可能完成幂等 Cloudflare检查；只有一个请求能通过 D1 claim CAS 并创建 v2 site。另一个重新读取 site 后按原有站点权限 / idempotency 语义收敛，不能再次覆盖 owner。
- 不同邮箱请求并发：邮箱不匹配的请求在 Cloudflare 删除前失败；匹配邮箱请求可以继续。
- takeover 与平台人工修复并发：D1 claim snapshot CAS 是最终门禁。claim 任意 owner/status/ref 变化都会拒绝提交。
- Cloudflare route 在验证后被其它操作改绑：DELETE 必须使用 route id 前重新确认 API 返回的绑定信息；若 Cloudflare API 不支持条件删除，则检测到不一致或删除结果不确定时 fail closed，并依赖人工检查。
- KV 在 ownership 验证后变化：D1 CAS 不能证明 KV 未变化，因此 D1 batch 前再次读取 KV 并比较验证用的 token、scriptName 和关键定位字段；变化时拒绝接管。

## 错误语义

- `HOSTNAME_CLAIM_CONFLICT`（409）：不可接管、claim 不是 active v1 claim、邮箱不匹配、actor 无 email、v1 metadata 不足或资源定位不一致。响应沿用现有通用文案，不泄露 v1 owner。
- `V1_TAKEOVER_CONFIG_UNAVAILABLE`（503）：实际出现可候选 v1 claim，但 `V1_SITES`、account、zone 或 token 配置不可用。
- `V1_TAKEOVER_CLEANUP_FAILED`（503）：安全校验已通过，但 Cloudflare route / Worker 查询或删除失败。action 提示重试或联系平台维护者，不返回 Cloudflare detail。
- `V1_TAKEOVER_STATE_CHANGED`（409）：资源清理后 D1 claim 或 KV snapshot 已变化，无法安全提交。调用方使用新的 Idempotency-Key 重试。
- `SITE_SLUG_CONFLICT`（409）：D1 中已有有效 v2 同 slug site，保持现有语义。

公开响应不得包含 actor email、legacy token、scriptName、claim owner id/ref、route id、Cloudflare error、KV metadata 或资源是否真实存在。内部日志使用闭集字段，仅包含 event、environment、slug、stage、result、actorUserId 和安全错误码；不记录邮箱、token、原始 Error message/stack、HTTP header 或 Cloudflare payload。

## 配置与部署

pages-api Wrangler 模板新增：

```toml
[[kv_namespaces]]
binding = "V1_SITES"
id = "__V1_SITES_KV_NAMESPACE_ID__"
```

同时显式提供当前环境的 zone id 和 v1 Worker 命名配置。配置名称以实现时现有 config 约定为准，但必须区分 production / staging，并由模板固化安全默认：

- production hostname：`<slug>.workers.xd.team`
- staging hostname：`<slug>-staging.workers.xd.team`
- production script：`pages-<slug>`
- staging script：使用当前 v1 staging workflow 已配置的前缀

GitHub Actions 的 `Generate Pages API Wrangler config` 从对应 environment 的现有 v1 `SITES_KV_NAMESPACE_ID` 传入渲染脚本。pages-api 继续复用已注入的 `CF_ACCOUNT_ID`、`CF_API_TOKEN`，并把现有 `CF_ZONE_ID_NEW` 作为 Worker secret 注入；不把 Wrangler 使用的 `CLOUDFLARE_API_TOKEN` 暴露给 Worker runtime，也不把真实 zone id 写入模板或仓库。

`scripts/render-pages-v2-wrangler.mjs` 负责：

- pages-api 生成时要求 v1 KV namespace id 非空；secret 注入脚本单独要求 `CF_ZONE_ID_NEW` 非空。
- staging / production 只接受各自 environment 输入。
- 输出 binding 但不打印真实 id。
- 相应脚本测试断言模板替换完整、无 secret 或未替换 placeholder。

该改动不增加 push / PR production 自动部署。staging 和 production 仍通过现有手动 Pages v2 deployment workflow 发布。

## 审计与可观测性

成功 takeover 写入 D1 audit event，建议 event type 为 `site.v1_takeover`，metadata 只包含：

- environment
- siteId
- hostname
- previousOwnerSystem 固定 `v1`
- previousOwnerId
- previousOwnerRef（可为空）
- source 固定 `v1_email_takeover`

不保存 email、token 或完整 v1 metadata。失败日志采用阶段分类：`claim_read`、`ownership_verify`、`route_cleanup`、`worker_cleanup`、`d1_takeover`、`kv_cleanup`；预期邮箱不匹配不作为异常日志，防止利用日志枚举用户。

建议增加计数型 observability event：attempted、succeeded、ownership_denied、cleanup_failed、state_changed、kv_cleanup_deferred。事件字段必须是闭集且脱敏。

## 测试策略

### Ownership 单元测试

- actor email 与 `pages_<email>` 精确匹配可生成 cleanup target。
- email trim / lowercase 后匹配；`+tag`、dot 和域别名不被折叠。
- prefix 错误、邮箱不一致、team actor 无 email、非对象 KV、缺少 token 或 scriptName 均拒绝。
- 任何公开错误和日志不包含 token 或 email。

### Cloudflare 清理单元测试

- exact route 绑定预期 v1 Worker 时按 route → Worker 顺序删除。
- route / Worker 不存在时幂等成功。
- wildcard route、跨环境 hostname、错误 script、平台保留 Worker、route 绑定不一致时零 DELETE。
- Cloudflare 4xx、5xx、网络异常和非法 payload fail closed，并脱敏错误。

### Store 测试

- v1 claim CAS 成功时原地转为 v2 owner，并与 site、route、member、audit 同批提交。
- claim owner/status/ref/environment/slug 任一变化时整批无写入。
- 已有 v2 同 slug site 时不覆盖。
- 两个并发 snapshot 只有一个成功。
- takeover 不经过 reuse hold，也不产生 hostname 无 owner 的中间状态。

### Handler / deployment 测试

- sites API 同邮箱 v1 conflict 自动接管并返回普通 `201`。
- deployments API 直调时同样自动接管并成功发布。
- 当前 CLI 的 sites → deployments 两段调用不需要新增参数。
- 邮箱不匹配仍返回通用 `HOSTNAME_CLAIM_CONFLICT`，且没有 Cloudflare DELETE。
- team access key、无 email actor 和非 v1 claim fail closed。
- Cloudflare 清理失败返回 `503`，KV 和 claim 保留，重试可继续。
- Cloudflare 已清理、D1 CAS 失败时返回 state changed，不产生 v2 site。
- D1 成功、KV 删除失败时用户请求成功并创建 cleanup task；scheduled runner 后续删除残留 key。
- 成功 takeover 后首次 v2 deployment 使用正常 router wildcard，旧 exact route 不再遮蔽。

### 配置和回归测试

- production / staging Wrangler 分别绑定正确的 v1 KV namespace 和 zone，不串环境。
- secrets 脚本继续验证 `CF_API_TOKEN`，真实值不进入仓库或生成日志。
- 普通无冲突创建 / 部署不访问 `V1_SITES` 或 Cloudflare cleanup API。
- 现有 hostname claim、站点创建、部署 idempotency、cleanup task 和 v1 retirement 测试保持通过。
- 运行 focused `node:test`、`pnpm lint` 和完整 `pnpm test`。

## 文档同步

- 更新 `docs/operations/legacy-api-and-site-publishing-retirement.md`：v1 公网 API 仍退休，存量资源默认保留；唯一例外是经 v2 强认证邮箱匹配触发的单站点 takeover。
- 更新 `docs/operations/v2-workers-domain-rollout.md`：补充 v1 exact route 自动清理、claim 原子转换、失败重试和 staging 验证门禁。
- 必要时更新 `docs/api-boundary.md`：该行为属于现有 create/deploy API 的内部冲突恢复，不新增用户手写 API 或公开 OpenAPI 入口。
- 同步 `apps/pages-api/src/openapi.js` 和合约测试中的 create / deploy 错误响应；不新增 OpenAPI 路径，也不公开 `/openapi.json`。
- CLI 和 skill 无需增加用户操作说明；可在错误排障文档中说明不可接管 conflict 仍需更换 slug 或联系管理员。

## 发布与回滚

上线顺序：

1. 合入代码、Wrangler 模板、渲染脚本、workflow 和文档，运行完整 CI。
2. 手动部署 staging pages-api，使其绑定 staging v1 KV 和 staging Cloudflare 资源。
3. 在 staging 准备可删除的 v1 测试站点，分别验证同邮箱成功、不同邮箱拒绝、route/script 不一致拒绝、半清理重试和 KV cleanup task。
4. 确认 v2 wildcard router 命中新站点，v1 exact route 与 Worker 已消失。
5. 手动部署 production pages-api；不需要重新启用或部署 v1 API。

Worker 回滚时，已有 v2 takeover 不回迁 v1，也不重建已删除的 v1 Worker / route。回滚后的 pages-api 不再自动处理新的 v1 conflict，但现有 v2 site 和 claim 保持有效。`V1_SITES` binding 和新增 cleanup resource type 可以暂时保留；若要彻底移除，应先确认没有 pending `v1_sites_kv_record` cleanup task。

## 验收标准

- 同邮箱用户通过现有 `xd-cell deploy <slug>` 可以无感覆盖 v1 同名站点并访问新的 v2 内容。
- 不同邮箱或无法证明邮箱的 actor 永远不能触发任何 v1 资源删除。
- exact route、Worker、KV 和 hostname claim 最终全部收敛到 v2 状态。
- 任意单步故障后重试不会删除其它站点、泄露 owner 信息或产生两个 v2 owner。
- pages-api 不依赖 `apps/server` 运行时，v1 Worker 后续下线不影响 takeover。
- legacy 清理代码集中在独立目录，handler、store 和配置层保持清晰边界。
