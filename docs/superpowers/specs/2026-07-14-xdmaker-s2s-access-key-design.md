# XDMaker S2S Access Key 设计

## 背景

XDMaker 桌面端已通过 xdt-api 完成飞书 SSO。为了避免用户再次执行 XD Cell 浏览器登录，xdt-api 需要以服务端身份向 `pages-api` 代换一个短期、用户归属的 XD Cell access key，再由 XDMaker 仅通过捆绑的 `@xd-cell/cli` 发布作品。

XD Cell 当前使用心动 SSO，飞书 `open_id` 与现有 SSO 用户标识不是同一标识。本设计以规范化邮箱作为两个身份源之间的关联键，继续使用同一张 `users` 表，并保留用户最初进入 XD Cell 的来源。

## 目标

- 在 `pages-api` 提供受控的 XDMaker S2S 发放与吊销接口。
- xdt-api 可以为已完成飞书 SSO 的用户换取 24 小时个人 owner-scoped access key。
- XDMaker 用户尚未进入 XD Cell 时，可由受信的 xdt-api 身份信息创建同表用户。
- 后续心动 SSO 登录按邮箱关联同一用户，不改变 XD Cell 内部 `user_id`。
- XDMaker access key 与当前个人 owner-scoped access key 具有相同站点和团队权限，并可首次部署即建站。
- XDMaker access key 在 Console 中可见且可由用户撤销。
- 发放、替换、吊销、拒绝和异常行为具备限频与审计记录。

## 非目标

- 不让 XDMaker 或普通用户绕过 CLI 直接调用部署 HTTP API。
- 不把飞书 `open_id` 当作 XD Cell `user_id`，也不把它与心动 SSO 标识互换。
- 不新建 XDMaker 专用用户表。
- 不接受 XDMaker 上报的部门、员工编号、团队或管理员信息。
- 不改变普通个人或团队 access key 的现有生命周期和权限。
- 不新增 S2S 专用 IP allowlist，也不取消 `pages-api` 的现有 `IP_ALLOWLIST`。
- 不自动部署 production；先完成 staging 联调，再由现有手动 workflow 发布 production。

## 总体架构

```text
XDMaker client
  -> xdt-api（校验自身 JWT 与飞书登录态）
  -> pages-api S2S endpoint（现有 IP_ALLOWLIST + HMAC + nonce）
  -> users / access_keys / audit_events
  <- 仅本次响应返回 access key 明文
  <- xdt-api 原路透传，不落库
  -> XDMaker safeStorage
  -> 子进程环境变量
  -> @xd-cell/cli
  -> pages-api 现有 CLI-managed deploy API
```

S2S endpoint 是受控内部集成面，不是普通用户 API。XDMaker 客户端仍不能获得 HMAC secret，也不能自行请求 S2S endpoint。

## API 合约

### 发放

```http
POST /.xd-pages/api/s2s/tokens
Content-Type: application/json
X-XD-Cell-S2S-Client: xdmaker
X-XD-Cell-S2S-Key-Id: <rotation-key-id>
X-XD-Cell-S2S-Timestamp: <unix-seconds>
X-XD-Cell-S2S-Nonce: <random-nonce>
X-XD-Cell-S2S-Signature: <base64url-hmac-sha256>
```

```json
{
  "email": "user@example.test",
  "feishu_open_id": "ou_example",
  "display_name": "Example User",
  "replaces_key_id": "ak_optional_previous"
}
```

- `email`、`feishu_open_id`、`display_name` 必填；`replaces_key_id` 可选。
- 邮箱执行 trim、转小写并校验格式；服务端不接收或推导部门。
- 每次成功调用都创建一个新 key，不返回同一用户的现役 key。
- 多设备可以各自持有一把 key。
- `replaces_key_id` 只能引用同环境、同用户、`issued_source = xdmaker_s2s` 的 key。新 key 成功写入后，在同一个数据库批次中吊销旧 key。
- 响应和所有错误都带 `Cache-Control: no-store`。

成功响应：

```json
{
  "token": "<plaintext-returned-once>",
  "key_id": "ak_example",
  "expires_at": "2026-07-15T08:00:00.000Z",
  "source": "xdmaker_s2s",
  "actor": {
    "user_id": "usr_example",
    "email": "user@example.test",
    "display_name": "Example User",
    "created_source": "xdmaker"
  }
}
```

access key 明文只存在于 Worker 当前请求内存和本次响应中。D1 只保存现有 access key hash 与 pepper metadata。

### 吊销

```http
POST /.xd-pages/api/s2s/tokens/revoke
```

使用相同 HMAC headers，请求体二选一：

```json
{ "key_id": "ak_example" }
```

```json
{ "email": "user@example.test" }
```

- 按 `key_id` 只允许吊销该用户来源为 `xdmaker_s2s` 的 key。
- 按邮箱吊销当前环境中该用户全部未吊销的 XDMaker key，不影响 Console/CLI 创建的普通 access key。
- 吊销是幂等操作。目标不存在、已吊销或已过期时仍返回 200 和 `revoked_count: 0`，便于登出与封禁流程安全重试。
- 响应不包含 token、hash、pepper、签名或原请求体。

### 稳定错误码

| HTTP | code | 语义 |
| --- | --- | --- |
| 400 | `S2S_REQUEST_INVALID` | JSON、字段、邮箱、nonce 或互斥参数无效 |
| 401 | `S2S_AUTH_REQUIRED` | HMAC headers 缺失 |
| 401 | `S2S_CLIENT_INVALID` | client 或 key id 不在当前环境 registry |
| 401 | `S2S_TIMESTAMP_INVALID` | timestamp 超出正负 5 分钟窗口 |
| 401 | `S2S_SIGNATURE_INVALID` | HMAC 不匹配 |
| 409 | `S2S_REPLAY_DETECTED` | nonce 已使用 |
| 409 | `S2S_IDENTITY_CONFLICT` | 邮箱、飞书标识或心动 SSO 标识指向不同用户 |
| 409 | `S2S_REPLACEMENT_KEY_INVALID` | `replaces_key_id` 不属于同一用户或来源 |
| 403 | `S2S_USER_INACTIVE` | 已有用户不是 `active` |
| 429 | `S2S_RATE_LIMITED` | 用户或 client 超过发放频率，响应带 `Retry-After` |
| 500 | `S2S_STORE_UNAVAILABLE` | 用户、key、nonce 或审计无法原子持久化 |

现有全局 `IP_NOT_ALLOWED` 仍先于上述 S2S 鉴权执行。

## S2S 鉴权与防重放

HMAC canonical input 固定为 UTF-8 文本：

```text
xd-cell-s2s-v1
POST
/.xd-pages/api/s2s/tokens
<unix-seconds>
<nonce>
<lowercase-hex-sha256-of-raw-body>
```

吊销 endpoint 使用自己的原始 pathname。请求不允许 query string。服务端先读取有大小上限的 raw body，计算 SHA-256，再以 `HMAC-SHA256` 校验 base64url signature；比较必须 constant-time。

`S2S_CLIENT_KEYS` registry 把 `(client_id, key_id)` 映射到 Worker secret 环境变量名。每个 client 最多同时配置两把有效 key，支持先加新 key、切换 xdt-api、再移除旧 key的轮换窗口。staging 和 production 使用不同 registry、不同 secret 与不同 D1 数据。

`s2s_nonces` 以 `(environment, client_id, nonce)` 为唯一键。签名通过后原子占用 nonce，并保存接收时间与 10 分钟过期时间；重复插入返回 `S2S_REPLAY_DETECTED`。scheduled handler 清理过期 nonce。timestamp 窗口与 nonce 唯一约束共同防止串环境和并发重放。

## 用户模型与身份关联

继续使用 `users` 表，新增：

```text
feishu_open_id TEXT NULL
created_source TEXT NOT NULL DEFAULT 'xd_sso'
```

约束：

- `lower(email)` 全局唯一，作为飞书 SSO 与心动 SSO 的关联键。
- 非空 `feishu_open_id` 全局唯一。
- `created_source` 取 `xd_sso` 或 `xdmaker`，表示首次建档来源，后续登录不覆盖。
- 现有用户回填 `created_source = xd_sso`。
- migration 前先检查大小写无关的重复邮箱；有冲突时停止 migration，由平台人工确认合并，禁止自动猜测。

S2S 用户解析顺序：

1. 规范化邮箱并分别查询邮箱和 `feishu_open_id`。
2. 两者命中不同用户时 fail closed，返回 `S2S_IDENTITY_CONFLICT`。
3. 邮箱命中且飞书字段为空时，把 `feishu_open_id` 绑定到该用户；已绑定相同值则复用。
4. 邮箱命中的用户只有 `employee_status = active` 才能发 key；`disabled`、`left`、`unknown` 都不被 XDMaker 请求重新激活。
5. 邮箱未命中时，信任 xdt-api 背书的信息，创建新的内部 `usr_*`，状态设为 `active`，`created_source = xdmaker`，不填部门、员工编号或心动 SSO 字段。
6. 已有心动 SSO 用户保留平台权威姓名；XDMaker 只在新建用户或现有姓名为空时写入 `display_name`。

后续心动 SSO 登录时，`upsertUserFromSso` 先按现有 `user_id` 查找，再按规范化邮箱关联。若邮箱已对应 XDMaker 创建的用户，则在该行补充 `account`、`account_id`、员工状态和组织信息，并返回原内部 `user_id` 供 session/JWT 使用。若心动 SSO 标识和邮箱分别指向不同用户，则拒绝登录同步并进入审计，不迁移站点或 key。

## Access Key 模型与权限

`access_keys` 新增：

```text
issued_source TEXT NOT NULL DEFAULT 'legacy'
issued_session_version INTEGER NULL
```

- 普通历史 key 回填 `issued_source = legacy`，现有创建入口后续分别记录 `cli` 或 `console`。
- S2S key 固定 `issued_source = xdmaker_s2s`。
- S2S key 固定 24 小时 TTL、`owner_type = user`、`owner_id = user_id`、`site_id = null`。
- scopes 固定为 `deploy:site`、`read:site`、`rollback:site`。
- `issued_session_version` 记录发放时的 `users.session_version`。仅该字段非空的 key 在认证时要求版本仍一致；SSO webhook 或管理员 bump version 后，旧 S2S key 立即失效。普通存量 key 的现有语义不变。

现有 deploy API 已支持 `site_id = null` 的个人 owner-scoped access key 在首次部署事务中创建个人站点，也支持该用户以 publisher/admin 身份向团队发布。因此 S2S 不新增建站 endpoint，也不新增特殊权限分支。

Console 的 access key 列表响应增加 `issuedSource`，个人 Access Keys 页面把 `xdmaker_s2s` 显示为 `XDMaker` 来源标签。列表仍不返回明文或 hash，现有撤销按钮直接复用 owner 校验后的 revoke API。用户从 Console 撤销后，xdt-api 后续按同一 `key_id` 吊销仍按幂等成功处理。

## 发放与吊销数据流

发放：

1. 现有 `IP_ALLOWLIST` 门禁。
2. 限制 raw body 大小，校验 HMAC、timestamp、client/key registry。
3. 检查 client 频率并原子占用 nonce。
4. 校验请求体，按邮箱/飞书标识解析或创建用户。
5. 检查用户 10 分钟内的成功发放次数。
6. 在内存生成 access key 明文与 hash。
7. 用一个 D1 batch 写入用户绑定或新用户、access key、可选旧 key 吊销和审计事件。
8. batch 完全成功后返回一次明文；任一步失败都不返回 token。

吊销：

1. 执行相同 IP、HMAC、timestamp、nonce 与 client 限频。
2. 按 key id 或规范化邮箱只选择当前环境的 `xdmaker_s2s` key。
3. 原子更新所有目标 key 的 `revoked_at`、`revoked_reason = xdmaker_s2s_revoke` 并写审计。
4. 返回 `revoked_count` 与被吊销的 `key_ids`；不返回其它 key metadata。

## 限频、异常检测与审计

首版固定门限，避免为单一集成增加动态配置系统：

- 每个用户最多 5 次成功发放 / 10 分钟。
- 每个 S2S client 最多 300 个通过 HMAC 的请求 / 10 分钟，发放与吊销合并计数。
- 第 3 次用户发放开始记录高频异常；超过第 5 次拒绝。
- Asia/Shanghai 00:00–06:00 的成功发放记录非常规时段异常，但不单独阻断。

审计事件至少包括：

- `s2s.user.create`
- `s2s.user.link_feishu`
- `s2s.access_key.issue`
- `s2s.access_key.replace`
- `s2s.access_key.revoke`
- `s2s.request.deny`
- `s2s.anomaly.detect`

事件记录 environment、client id、S2S key id、目标内部 user id、access key id、decision、status code、reason 和时间。禁止记录 token 明文、key hash、pepper、HMAC secret、signature、raw body、飞书 `open_id` 或完整 nonce。限频拒绝、identity conflict 和异常检测使用现有安全告警出口 best-effort 通知；告警失败不得让已经持久化成功的发放变成 5xx。

## 文件与组件边界

- `apps/pages-api/src/s2s-auth.js`：raw body hash、registry、canonical request、HMAC、timestamp 与 nonce 校验。
- `apps/pages-api/src/s2s-tokens.js`：请求校验、用户解析、发放、替换、吊销、限频与公开响应。
- `apps/pages-api/src/access-keys.js`：抽取并复用现有 access key 生成/格式化能力，保留普通入口行为。
- `apps/pages-api/src/store.js`、`test-store.js`：邮箱/飞书关联、nonce、S2S key 原子写入与审计。
- `apps/pages-api/src/auth.js`：对带 `issued_session_version` 的 key 执行 freshness 检查。
- `apps/pages-api/src/index.js`：在 bearer-token 业务路由之前注册 S2S endpoint，继续复用全局 IP 门禁。
- `apps/pages-api/src/openapi.js`：记录受控内部集成合约和稳定错误码；仍不公开 `/openapi.json`。
- `apps/pages-console/src/ui/access-keys-model.js`、`pages/AccessKeys.jsx`：显示 XDMaker 来源并复用撤销交互。
- deployment scripts/workflows：校验和注入 S2S registry 中引用的 secrets，不提交真实值。

## 配置与 secret 轮换

- `S2S_CLIENT_KEYS` 是非敏感 registry，只保存 `client_id:key_id:secret_env_name` 映射。
- `S2S_SECRET_*` 是 Worker secrets，由 staging/production GitHub Environment 分开管理。
- `scripts/put-pages-v2-secrets.sh` 只按 allowlisted secret env name 注入，不打印 secret value。
- staging 的 xdt-api 固定出口 CIDR追加到现有 staging `IP_ALLOWLIST`；production 同理，不创建 `XDMaker_IP_ALLOWLIST` 一类专用变量。
- 轮换顺序为：平台增加第二把 key -> xdt-api 切换 header key id -> 观察无旧 key 流量 -> 平台移除旧 key。
- shared secret 的实际交换由双方使用现有受控渠道人工完成，不写入仓库、issue、PR 或日志。

## 测试策略

### 鉴权与入口

- 现有 IP allowlist 仍先于 S2S HMAC 生效。
- canonical request、raw body hash、base64url HMAC 和 constant-time 比较有独立测试。
- 缺 header、未知 client/key、过期 timestamp、错误 signature、query string、重复 nonce 均 fail closed。
- staging/production registry、nonce 和 access key 不能串环境。

### 用户关联

- 邮箱大小写归一化后复用已有用户。
- 新邮箱创建 `created_source = xdmaker` 的 active 用户。
- 飞书标识首次绑定、相同值复用、不同用户冲突均覆盖。
- `disabled`、`left`、`unknown` 用户不能被 S2S 重新激活。
- 后续心动 SSO 按邮箱复用 XDMaker 用户并保留原 `user_id`。
- migration schema 和重复邮箱 fail-closed 前置检查得到覆盖。

### Key 与权限

- 每次发放产生不同 key，TTL 恰为 24 小时，明文只返回一次且不入库。
- key 为个人 owner scope、无 site scope，三个固定 scopes 完整。
- `replaces_key_id` 原子吊销同用户旧 XDMaker key，拒绝跨用户、跨来源和跨环境 key。
- 用户 `session_version` 变化后 S2S key 失效，普通历史 key 行为不变。
- XDMaker key 可通过现有 deploy API 首次建个人站，并按现有团队 membership 发布。
- xdt-api 按 key 或邮箱吊销只影响 XDMaker key；重复吊销幂等。
- Console 列表显示 XDMaker 来源且能通过现有按钮撤销。

### 限频、审计与泄漏检查

- 用户和 client 门限、`Retry-After`、非常规时段和高频异常均覆盖边界测试。
- 发放、替换、吊销、拒绝、identity conflict 和异常均写入当前 environment 的审计。
- 响应、审计、错误与测试 snapshot 不包含 token、hash、secret、signature、raw body、完整 nonce 或飞书 `open_id`。
- 运行 pages-api/pages-console focused tests、schema tests、workflow/script tests、`pnpm lint` 和 `pnpm test`。

## 文档同步

- `docs/api-boundary.md`：说明 XDMaker 仍遵守 CLI-managed deploy boundary，S2S 仅是受控凭证发放面。
- `docs/architecture/publishing-and-runtime.md`：把 owner-scoped access key 首次建站从“目标态”修正为当前真实行为，并记录 XDMaker source/freshness。
- `docs/operations/resources-and-deployment.md`：补充 registry、secret、现有 IP allowlist 扩展、轮换与 staging 联调步骤。
- 不在 `/skill.md`、`/readme.md` 或 `apps/pages-skill` 暴露 S2S endpoint、HMAC headers 或 secret 配置；普通用户入口仍是 CLI。

## 上线与回滚

1. staging 先应用 migration，检查邮箱唯一约束、secret registry 和现有 allowlist。
2. 部署 pages-api/pages-console staging，与 xdt-api 联调发放、CLI 首次建站、列表显示、Console/xdt-api 双路径吊销和 sessionVersion 失效。
3. 观察限频、审计与告警，不在 staging 验证通过前配置 production secret。
4. production migration 与部署继续通过 `Deploy XD Cell Production` 手动触发。

回滚时先从 registry 移除 xdt-api client 或轮换掉当前 secret，立即停止新发放；已发 key 可按 `issued_source = xdmaker_s2s` 批量吊销。代码可以回滚，但新增 nullable/defaulted columns 和 nonce table 保留，避免 destructive schema rollback。普通 CLI token、普通 access key 和现有部署链路不受影响。
