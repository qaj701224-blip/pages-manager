# XD Cell 数据模型

> 本文从 `docs/pages-v2-wfp-architecture.md` 拆分而来，用于控制单篇文档长度。

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
| 普通 Worker slot 池状态            | D1                             | route snapshot         | 扩容与分配必须强一致              |
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
  user_id             -- SSO profile userId
  account             -- 当前系统推送帐号
  account_id          -- SSO profile accountId
  email
  realname            -- SSO profile realname
  employeenum         -- SSO profile employeenum
  employee_status     -- active / disabled / left / unknown
  session_version     -- 用户级 session 失效版本
  last_login_at
  created_at
  updated_at
```

`user_id` 直接对应 SSO profile 中稳定且不可复用的 `userId`。如果未来某个环境只能拿到邮箱，需要在风险清单中标记“邮箱复用/变更”问题，不能静默把邮箱当 `user_id`。

#### sites

```sql
sites
  id                  -- site_xxx
  slug                -- 用户可见站点名
  owner_user_id
  default_visibility  -- internal / org / acl / owner / disabled
  execution_mode_override -- null / wfp / normal-worker-slot；仅平台维护者可写
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
  hostname            -- foo.workers.xd.team；存量 v2 route 也可能是 foo.pages.xd.team
  site_id
  environment         -- production / staging
  runtime             -- worker / disabled
  execution_provider  -- wfp / normal-worker-slot
  worker_name         -- WFP user worker name 或普通 Worker slot name
  dispatch_type       -- dispatch-namespace / service-binding
  dispatch_binding_name -- slot 模式为 SITE_SLOT_001；WFP 模式为 null
  slot_id             -- slot 模式引用 worker_slots.id；WFP 模式为 null
  active_version_id
  visibility          -- internal / org / acl / owner / disabled
  policy_version
  route_generation    -- active version / workerName 切换代数
  route_status        -- active / disabled / deleted
  cache_tier          -- fast / sensitive / strict
  created_at
  updated_at
```

`site_routes` 是 router 的权威解析表。`visibility` 和 `policy_version` 属于安全边界字段，不能只存在 KV snapshot。`runtime` 表示路由是否进入用户代码，`execution_provider` 表示用户代码部署在哪类执行面；这样未来从 slot 切换到 WFP 时，不需要改变用户侧 API。

#### site_versions

```sql
site_versions
  id                  -- ver_xxx
  site_id
  deployment_id
  worker_name
  runtime             -- worker
  execution_provider  -- wfp / normal-worker-slot
  dispatch_type       -- dispatch-namespace / service-binding
  dispatch_binding_name -- slot 模式记录激活时 binding；WFP 模式为 null
  slot_id             -- slot 模式记录占用 slot；WFP 模式为 null
  artifact_ref        -- 当前执行面 provider 引用，例如 wfp://... 或 slot://...
  content_hash
  deployment_shape    -- assets-only / worker-only / worker-with-assets
  requested_fallback  -- auto / index / not-found
  resolved_fallback   -- index / not-found / null
  routing_mode        -- assets-only / worker-only / worker-first
  worker_entry
  assets_config_json
  worker_modules_json
  asset_manifest_json
  canonical_content_hash
  var_names_json
  secret_names_json
  runtime_config_snapshot_json
  artifact_availability
  created_by
  created_at
```

版本记录必须 immutable。回滚只更新 `site_routes.active_version_id`，不修改历史 version 内容。

#### site_vars / site_secrets

```sql
site_vars
  id
  environment
  site_id
  name
  value               -- 非敏感明文 runtime var
  revision
  created_by
  created_at
  updated_at
  deleted_at

site_secrets
  id
  environment
  site_id
  name
  encrypted_value     -- secret value 加密后存储
  revision
  created_by
  created_at
  updated_at
  deleted_at
```

`site_vars` 和 `site_secrets` 都是站点级当前 runtime config。Worker deploy 会读取当前启用项并物化为本版本 Worker bindings；`site_versions.runtime_config_snapshot_json` 记录本版本当时使用的 var value/revision 和 secret name/revision/valueHash。secret valueHash 使用平台 pepper/HMAC 生成，只用于内部版本审计和一致性校验，不是明文、裸 digest 或公开响应字段。`xd-cell.config.json` 中的 `vars` 会在 Worker deploy 时同步到 `site_vars`；配置省略 `vars` 时沿用站点当前值，显式空对象清空。secret value 只通过 `xd-cell secrets put/delete` 管理。

#### worker_slots

```sql
worker_slots
  id                  -- slot_xxx
  environment         -- production / staging
  slot_number         -- 1..N
  worker_name         -- pages-v2-production-slot-001
  binding_name        -- SITE_SLOT_001
  status              -- provisioning / available_pending_router / available / assigned / disabled / cleanup_pending
  assigned_site_id
  assigned_route_id
  assigned_at
  last_deployed_version_id
  last_seen_at
  health_status       -- unknown / healthy / unhealthy
  notes
  created_at
  updated_at
```

唯一约束：

```text
unique(environment, slot_number)
unique(environment, binding_name)
unique(environment, worker_name)
```

`worker_slots` 是普通 Worker slot 池的权威表。`pages-api` 分配 slot 时必须在 D1 transaction / CAS 中把 `available` 改成 `assigned`，并写入目标 `site_id`、`route_id` 和 `version_id`。同一站点后续 deploy 不覆盖当前 active slot，而是分配新的 available slot；新 route 激活并写入 snapshot 后，旧 slot 立即进入 cleanup 流程。删除站点或清理失败后，slot 先进入或保持 `cleanup_pending`；清理完成后才回到 `available`。

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
  subject_type        -- email / department；group 为未来预留
  subject_value       -- 邮箱；或完整部门路径，例如 心动/技术平台部
  access_role         -- viewer / editor
  effect              -- allow；第一版不支持 deny
  created_by
  created_at
```

第一版 ACL 采用 allow-only + OR 叠加：

```text
allow if:
  user.email in ACL(email)
  OR user.department_path == ACL(department)
  OR user.department_path startsWith ACL(department) + "/"
```

同一站点可添加多条 ACL entry，例如“指定多个邮箱”和“指定一个部门路径”。命中任意一条 allow entry 即可访问；没有命中则拒绝。用户侧指定某个人时必须填写邮箱，不填写 SSO `userId`、`accountId`、工号、企微 ID 或其它内部身份字段。

第一版不支持 `deny`、排除用户、`AND` 条件、部门内角色条件、嵌套表达式或策略语言。当前公开 API 开放 `email` 和 `department`；`group` 和内部 `user` subject type 先保留为未来方向，不阻塞 MVP。`owner`、session subject、审计归因仍使用平台内部 `userId`，但不作为用户可填写的 ACL subject。

`department` 第一版使用组织目录返回的部门路径字符串，并按路径前缀包含子部门。因为部门名称/path 可能调整，平台必须把组织目录查询结果作为短 TTL 的会话属性，不把站点 KV 当作用户数据库；后续如果组织系统能提供稳定、不可复用 department id 和成员快照版本，应优先迁移到稳定 id。成员变更或部门路径变化至少要能通过重新登录、site_session 过期或后续目录刷新让权限生效。`group` 等更复杂主体等组织目录语义稳定后再评审。

#### access_keys

```sql
access_keys
  id                  -- ak_xxx
  environment
  owner_user_id
  key_hash
  pepper_id
  name
  scopes_json         -- 当前存储字段；逻辑权限映射为 read / publish
  site_id             -- null 表示 all 范围；非 null 表示当前单站点 selected_sites 范围
  owner_type          -- user / team
  owner_id            -- user_id / team_id
  created_by_user_id
  expires_at
  last_used_at
  revoked_at
  revoked_by_user_id
  revoked_reason
  created_at
```

access key 明文只在创建时显示一次，之后只存 hash。key 的权限、作用范围、owner 归属和站点限制必须在 `pages-api` 权威校验，不能只靠 CLI 自觉。

access key 生成与存储规则：

- 使用 CSPRNG 生成至少 192-bit 随机值。
- 明文格式可以带非敏感前缀和环境提示，例如 `xdp_prod_...`、`xdp_stg_...`，但服务端不能只靠前缀判权。
- 存储使用 HMAC-SHA-256 + server-side pepper，并记录 `pepper_id` 以支持轮换。
- 校验使用常量时间比较。
- 默认创建 all 范围 + expiry 的 PAT 或 TAT；用户可在创建时改为 selected sites 以限制到指定站点。
  当前表结构用 `site_id` 表达单站点限制；后续如果支持多选站点，应迁移为 `access_key_site_scopes` join table 或等价结构。
- PAT 代表用户，权限按用户当前状态、个人资产 owner 关系和团队成员角色动态计算。TAT 代表团队，由团队 admin 创建和撤销；创建者离开团队不自动影响 TAT。
- Access Token 第一版不承载团队 admin 能力；团队成员、角色、Team Access Token、团队设置和团队删除等操作必须走 Console 登录态。

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
  "returnTo": "https://foo.workers.xd.team/path",
  "siteHost": "foo.workers.xd.team",
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

- CLI `xd-cell login` 轮询。
- 浏览器 SSO 成功后写入登录结果。
- CLI 领取 token 后标记 `consumedAt`，防止重复领取。

CLI login 必须使用 `login_id + login_secret` 双值模型。`login_id` 可以出现在浏览器 URL 和轮询路径中；`login_secret` 只保存在 CLI 进程内，用于 poll/consume 时证明请求方就是发起登录的 CLI。服务端只保存 `loginSecretHash`，比较时使用常量时间比较。登录结果只能领取一次，TTL 建议 5-10 分钟，并对 poll/consume 失败次数限流和审计。

首版浏览器登录 URL 由 `pages-auth` 返回，形如：

```text
https://auth.pages.xd.team/.xd-pages/auth/authorize?cli_login_id={loginId}
```

`cli_login_id` 可以出现在浏览器 URL 中。`device_code` 不能出现在 authorize URL、日志或 Referer 中；它只显示在 CLI 终端，并由用户在 SSO 成功后的浏览器确认页手动输入。`login_secret` 不进入 URL、日志或浏览器，只在 CLI poll 时随请求体提交。

为防止攻击者生成登录链接诱导他人授权，CLI login 还必须有 device confirmation：

- CLI 在终端显示短码，例如 `12345678`，并展示 environment、auth host 和请求 scope。
- 浏览器 SSO 成功后，页面必须明确提示“正在授权 xd-cell CLI”，并要求用户手动输入终端短码，再确认 environment、auth host 和 scope。
- 浏览器确认表单必须带服务端签发的短 TTL confirm token，绑定 `cli_login_id` 和当前登录用户；确认 POST 必须校验 exact `Origin` / same-origin fetch metadata，防止其它平台受信子站 CSRF 自动确认。
- 用户未确认短码前，`CliLoginDO` 不能写入 completed user，也不能让 CLI 领取 token。
- 后续如果改成本机 loopback callback，也应配合 PKCE / nonce，把浏览器回调绑定到本地 CLI。

首版保留设备码是为了给“浏览器 SSO 登录”和“发起登录的 CLI 进程”建立显式配对证明，避免攻击者生成 CLI login URL 后诱导已登录用户点击并把 CLI token 领走。设备码不能进入 URL 或日志，只能显示在发起登录的终端中。

已知体验问题：当前浏览器轮询登录链路容易受到浏览器已有 `auth_session`、SSO callback 新建 session、并发登录窗口等因素影响。如果 confirmation token 过度绑定某一次 `auth_session.sid`，同一用户也可能因为 session id 轮换而确认失败。实现层应把 CLI confirmation token 绑定到 `loginId` 和当前登录用户，保留同源校验和短 TTL；不应把 sid 当作唯一可用的配对条件。

后续优化方向：把默认登录路径升级为本机 loopback callback + PKCE。CLI 本地启动临时 callback server，浏览器完成 SSO 后直接回调 CLI，服务端通过 PKCE / nonce 绑定本地进程；设备码保留为 SSH、远程开发机、无浏览器环境或 loopback 不可用时的 fallback。这样可以减少手动输入，同时不降低 CLI token 领取安全性。

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
{env}:route_snapshot:{hostname}:{route_generation}:{policy_version}
{env}:policy_snapshot:{site_id}:{policy_version}
{env}:jwks:{kid}
```

#### route snapshot

```json
{
  "schemaVersion": 2,
  "hostname": "foo.workers.xd.team",
  "siteId": "site_123",
  "siteUuid": "su_123",
  "slug": "foo",
  "routeId": "route_123",
  "environment": "production",
  "runtime": "worker",
  "executionProvider": "normal-worker-slot",
  "workerName": "pages-v2-production-slot-007",
  "dispatch": {
    "type": "service-binding",
    "slotId": "slot_007",
    "bindingName": "SITE_SLOT_007"
  },
  "kv": {
    "enabled": true,
    "scopes": ["kv:get", "kv:set", "kv:delete"]
  },
  "activeVersionId": "ver_42",
  "contentHash": "sha256:...",
  "deploymentShape": "assets-only",
  "resolvedFallback": "index",
  "routingMode": "assets-only",
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

WFP 模式的 route snapshot 只替换执行面 dispatch 信息，其它鉴权、KV、审计字段保持一致：

```json
{
  "schemaVersion": 2,
  "runtime": "worker",
  "executionProvider": "wfp",
  "workerName": "foo_v42",
  "dispatch": {
    "type": "dispatch-namespace"
  },
  "kv": {
    "enabled": true,
    "scopes": ["kv:get", "kv:set", "kv:delete"]
  }
}
```

staging snapshot 必须使用 staging hostname 和 `environment=staging`，例如 `foo-staging.workers.xd.team`；存量 v2 staging host 也可能是 `foo-staging.pages.xd.team`。router 发现 hostname 后缀与 snapshot environment 不一致时必须拒绝。

为了让发布 / 回滚的 generation 可比较，route snapshot 采用两层 key：

```text
{env}:route_pointer:{hostname} -> { routeId, routeGeneration, policyVersion, snapshotKey, updatedAt }
{env}:route_snapshot:{hostname}:{routeGeneration}:{policyVersion} -> immutable snapshot body
```

router 的 L1 cache 必须缓存 pointer 和 snapshot。当前实现以 D1 `site_routes` 为权威：发布 / 回滚先用 D1 CAS 切换 active route，再写 immutable snapshot 和 route pointer；如果 snapshot / pointer 写入失败且 KV pointer 尚未提交，API 立即恢复 previous route 并让操作失败。KV route pointer 是 router 可见的提交点；一旦 pointer 已写入，后续 DO state 写入失败不能再让控制面回滚 D1，只能由 reconciliation 修复 DO state 或重建 pointer。写 route pointer 前必须读取现有 pointer 做单调版本保护，禁止较低 `routeGeneration` 或同 generation 较低 `policyVersion` 覆盖更新的 pointer。ACL / visibility 这类 policy-only 变更不应冒充发布 generation，但必须 bump `policyVersion` 并生成新的 immutable snapshot key，避免覆盖旧 snapshot。router 发现 pointer generation 或 policyVersion 大于 L1 snapshot 时，必须刷新 snapshot；pointer 缺失或 malformed 时按故障矩阵 fail closed 或查 D1。

#### policy snapshot

```json
{
  "schemaVersion": 1,
  "siteId": "site_123",
  "policyVersion": 12,
  "visibility": "acl",
  "allowedUsers": ["usr_123"],
  "allowedEmails": ["user@example.com"],
  "allowedDepartments": ["dept_123"],
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
  "aud": "site:foo.workers.xd.team",
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
  "aud": "worker:foo.workers.xd.team",
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
- `aud` 必须绑定用途和 host，例如 `pages:production`、`site:foo.workers.xd.team`、`worker:foo.workers.xd.team`。
- `kid` 必须来自当前环境 key registry；production token 不能被 staging key 验证，反之亦然。
- 高风险一次性 token 或能力 token 应包含 `jti`，用于审计、限流或必要时吊销。

`auth_session` 由 `pages-auth` 签发，`site_session` 和 `internal_worker_jwt` 由 `pages-router` 签发。三者可以共享 key registry 结构，但必须通过 `iss`、`aud`、`kid` 和环境绑定区分用途，不能让某类 token 被另一类 token 的校验逻辑接受。

`internal_worker_jwt` 默认不包含真实邮箱、姓名、部门名等直接 PII。User Worker 默认只能拿到稳定但不暴露身份细节的 `sub` / scoped user id。只有站点显式启用 profile disclosure scope，且访问策略允许时，router 才能注入邮箱等 profile 字段，并必须在 route snapshot、审计和 SDK contract 中记录该披露级别。
