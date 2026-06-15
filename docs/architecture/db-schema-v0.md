# DB Schema V0

## 定位

这是 `pages-manager` 员工多站点自动发布平台的 MVP 数据库合同。

目标不是一次性把所有字段设计到终局，而是先把不能靠 KV、GitHub issue、Slack thread 或 Cloudflare KV 替代的真相源落到 MySQL。

MVP 约定：

- DB 使用 MySQL 8.x。
- ORM 使用 Drizzle。
- MVP 正式运行态必须使用 MySQL + Redis + Drizzle；现有文件 / 内存 store 只能作为历史过渡代码、单元测试 fixture 或一次性迁移输入。
- 主键统一用字符串 ID，建议格式为 `<prefix>_<ksuid|ulid>`。
- 可变业务表必须有 `created_at`、`updated_at`；append-only event / audit / call log 表可以只保留 `created_at`。
- 需要软删除的业务对象使用 `deleted_at`。
- Secret 明文不入 DB，DB 只保存 `secret_ref` 或 hash。
- GitHub / Slack webhook 的幂等约束必须落 DB。

## xdclaw DB 架构参考

`pages-manager` 的 DB / Redis / Drizzle 落地必须参考本机 `xdclaw` 的这些规则，但不复用 `xdclaw` 的业务 schema：

- gateway 是无状态、多副本入口；持久元数据使用外置 MySQL，不使用 SQLite、JSON 文件、单 pod PVC 或进程内 Map / Set 作为跨请求真相源。
- Redis 保存 in-flight flow、session lease、pub/sub、短 TTL dedupe、queue 和 rate limit；Redis 不是最终状态真相源。
- 本地开发也要求可用 MySQL 与 Redis，并提供幂等 `setup-db` 脚本：创建 DB（如账号有权限）并执行 drizzle migrate。
- Drizzle schema 改动必须通过 `drizzle-kit generate` 生成 migration SQL、snapshot 和 journal 条目；不得手写 migration 文件或手动编辑 `_journal.json`。
- migration journal 的 `when` 必须严格单调递增，否则 Drizzle 可能静默跳过后续 migration。

`pages-manager` 对应要求：

- 新增 `apps/gateway/src/db/schema.*` 或等价路径作为 Drizzle schema 唯一来源。
- 新增 `apps/gateway/drizzle/migrations/` 或等价路径保存 append-only migrations。
- 新增 `pnpm db:setup` / `pnpm db:migrate`，CI 和本地 smoke 都通过它初始化 MySQL。
- 含 migration 的 PR 应只包含 schema / migration 相关改动，避免业务代码 revert 时破坏 migration 历史。
- 旧 `FileBackedGatewayStore` JSON snapshot 如需保留，只能由一次性 migration script 读取并导入 MySQL，不能继续作为 runtime backend。

## Redis 边界

Redis key 只保存短期运行态：

| Key 形态                              | 用途                                                                | TTL / 生命周期                 |
| ------------------------------------- | ------------------------------------------------------------------- | ------------------------------ |
| `slack:event:<teamId>:<eventId>`      | Slack event 短 TTL 幂等缓存，DB 仍写 `slack_events`                 | 1 到 7 天                      |
| `github:delivery:<repo>:<deliveryId>` | GitHub webhook 短 TTL 幂等缓存，DB 仍写 `github_webhook_deliveries` | 1 到 7 天                      |
| `slack-session-lease:<sessionId>`     | Slack Agent 单 session 并发 lease                                   | 数分钟                         |
| `job-attempt-lease:<attemptId>`       | 阶段 attempt 调度 lease                                             | 数分钟到任务 timeout           |
| `queue:worker:*`                      | worker / retry / notifier 队列                                      | 由 BullMQ / queue adapter 管理 |

Redis 中的任何 key 都不能是唯一事实来源。Redis 丢失时，gateway 必须能从 MySQL 恢复 job、session、issue/PR 关联、deploy 和 audit 状态。

## MySQL / Drizzle 落地细则

这些规则用于把本文件转换成 Drizzle schema 和 migration SQL：

- 不依赖 MySQL nullable unique 表达业务幂等。凡是唯一键里有 nullable 业务字段的表，必须增加非空 `idempotency_key` / `dedupe_key` / `scope_key` 等规范化字段承载唯一约束。
- 组合唯一索引里不要直接放 `varchar(512)` / `varchar(1024)` 这类长路径或长 dedupe key；保留原文列用于展示，同时用 `*_hash`（SHA-256 lowercase hex，`char(64)`）进入唯一索引。
- MySQL 不支持 partial unique。凡是“同一范围只允许一条 active 记录”的表，使用 nullable `active_unique_key` 或 generated column 表达；`status=active` 时为固定值 `active`，其它状态为 `NULL`。
- JSON 字段只保存脱敏后的结构化快照、摘要、hash 或 ref；Slack / GitHub / Cloudflare 原始 payload、prompt 原文和 response 原文默认不直接入普通业务表。
- Job 列表、Job Detail 和日志排障常用查询必须有组合索引，不能只靠单列 id 查询。
- 所有外部入口、callback、webhook、外部 API 调用和 JobEvent 都应带 `request_id` 或可推导的 correlation id，便于排障视图从 job / Slack / GitHub / K8s log 之间跳转。
- 时间字段统一使用 UTC `datetime(3)`；`created_at` 只写入一次，`updated_at` 由应用层或 DB hook 统一维护。
- ID、hash、Git SHA、Slack / GitHub 外部 ID、dedupe key hash 等字段必须大小写敏感，Drizzle schema 中应显式使用 binary / case-sensitive collation 或等价约束。
- 关系约束优先使用 DB foreign key 或明确的应用层引用策略；禁止 cascade delete 业务历史。审计、日志、webhook delivery 和 external call log 即使父对象软删也必须保留。
- Drizzle schema 是唯一 DDL 来源；SQL migration 必须由 `drizzle-kit generate` 产出并进入 append-only migration 目录。

## 当前实现结构

DB 代码结构按 `xdclaw/gateway/src/db` 的方式收口到 gateway 内部的 `db` 目录，但不复用 `xdclaw` 的业务表：

| 文件                                   | 职责                                                                                            |
| -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/gateway/src/db/config.js`        | 解析 `DATABASE_URL`，同时兼容 `MYSQL_ADDR` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` |
| `apps/gateway/src/db/client.js`        | 创建 MySQL pool 和 Drizzle client，保持 gateway 可横向扩容                                      |
| `apps/gateway/src/db/schema.js`        | Drizzle schema 的唯一 DDL 来源                                                                  |
| `apps/gateway/src/db/gateway-store.js` | MySQL-backed runtime store，直接读写关系表，替代内存 / 文件 / snapshot                          |
| `apps/gateway/src/db/redis.js`         | Redis client 与 BullMQ 连接参数，Redis 只做短期运行态和队列                                     |
| `apps/gateway/scripts/setup-db.js`     | 幂等创建数据库并运行 migration                                                                  |
| `apps/gateway/scripts/migrate.js`      | 调用 `drizzle-orm/mysql2/migrator` 执行 committed migrations                                    |

运行态边界：

- `PAGES_STORE_BACKEND=mysql` 时，gateway 使用 `MySqlGatewayStore`。
- `publishing_jobs`、`job_events`、`slack_events`、`slack_sessions`、`session_memories`、`issue_links`、`agent_runs`、`agent_run_events`、`github_webhook_deliveries`、`review_agent_comments`、`slack_job_status_messages`、`slack_notification_dedupes` 是当前控制面真相源。
- `gateway_store_snapshots` 不存在，也不允许作为 runtime bridge；旧 file/PVC store 只保留给单元测试、历史排障或一次性导入脚本。
- handler / Slack session / Slack notifier 必须按 async store 调用编写；MySQL store 返回 Promise，不能把进程内 Map 当跨请求事实源。

## SQL / Drizzle 实施计划

本文件先把 SQL 计划写清楚，但实现时不在文档里手写最终 SQL。最终 DDL 必须由 Drizzle schema 生成，并随实现 PR 一起提交生成物。

### 文件和命令

| 项目               | 计划                                                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Drizzle schema     | `apps/gateway/src/db/schema.ts`；如果 PR 不引入 TypeScript，则使用等价 `schema.js`，但必须保持 Drizzle 为唯一 DDL 来源 |
| Drizzle config     | `apps/gateway/drizzle.config.ts` 或等价 ESM config，`dialect=mysql`，`out=./drizzle/migrations`                        |
| Generated SQL      | `apps/gateway/drizzle/migrations/*.sql`，由 `drizzle-kit generate --config drizzle.config.ts` 生成                     |
| Snapshot / journal | `apps/gateway/drizzle/migrations/meta/*`，随 SQL 一起提交，不能手动编辑 `_journal.json`                                |
| Runtime migrate    | `apps/gateway/scripts/migrate.*`，调用 `drizzle-orm/mysql2/migrator`                                                   |
| Local setup        | `apps/gateway/scripts/setup-db.*`，幂等创建 DB（有权限时）并执行 migrate                                               |
| Root scripts       | `pnpm db:generate`、`pnpm db:migrate`、`pnpm db:setup` 只做 workspace delegate                                         |

建议脚本形状：

```text
apps/gateway/package.json
  drizzle:generate = drizzle-kit generate --config drizzle.config.ts
  drizzle:migrate  = node/tsx scripts/migrate.*
  setup-db         = node/tsx scripts/setup-db.*

root package.json
  db:generate = pnpm --filter @xd/gateway drizzle:generate
  db:migrate  = pnpm --filter @xd/gateway drizzle:migrate
  db:setup    = pnpm --filter @xd/gateway setup-db
```

环境变量沿用当前 K8s 设计：

```text
MYSQL_ADDR=mysql.internal:3306
MYSQL_USER=pages_manager
MYSQL_PASSWORD=...
MYSQL_DATABASE=pages_manager_preview
REDIS_URL=redis://...
PAGES_STORE_BACKEND=mysql
PAGES_QUEUE_BACKEND=redis
```

运行态 Deployment 使用 `MYSQL_ADDR` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE`，
与 `xdclaw` 的 MySQL 配置形态保持一致；代码仍兼容 `DATABASE_URL`，但 ACK/K8s 路径不以它作为主约定。

### ACK preview 资源隔离

早期 ACK preview 可以临时复用 xdclaw preview 已有的 RDS MySQL 与 Redis/Tair
实例，用来避免在验证 Slack -> issue -> coding -> preview 链路前新增付费实例。
这只是基础设施复用，不是业务 schema 复用：

- `pages-manager` 必须使用独立 MySQL database：`pages_manager_preview`。
- `pages-manager` 必须使用独立 Redis DB：当前约定为 `/11`。
- `pages-manager-preview` namespace 必须维护自己的 `database-secret` 和
  `redis-secret`；Deployment 不得直接引用 `xdclaw-system/xdclaw-secrets`。
- 临时阶段可以复制共享实例的 host、port、user、password 到
  `pages-manager-preview` 的 Secret，但 `MYSQL_DATABASE` 不能是 `xdclaw`。
- 如果临时复用的是 xdclaw 的 MySQL 用户，要把它视为权限过大的 smoke
  配置，不能作为长期安全边界。
- 如果共享 MySQL 用户不能访问 `pages_manager_preview`，不能退而求其次把
  pages-manager 表建到 `xdclaw` database 里；这会破坏 schema 和运维边界。

长期方案需要二选一：

- 同一个 RDS 实例内创建 `pages_manager_preview` 专用 MySQL 用户，只授权
  `pages_manager_preview.*`。
- 或为 pages-manager 创建独立 RDS / Redis 实例。

在暂时不找运维且 RDS 授权不足的情况下，可以用
`pages-manager-preview` namespace 内的 MySQL / Redis StatefulSet 作为短期
smoke 数据面，但它仍然必须通过 `database-secret` / `redis-secret` 注入，
并且后续需要迁回托管 RDS/Redis 或专用授权。

### PR 拆分

| PR   | 内容                                                                                                         | 约束                                         |
| ---- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------- |
| PR0a | 引入 `drizzle-orm`、`mysql2`、`drizzle-kit`、Redis client / queue 依赖，补 `drizzle.config.*` 和空 db client | 不切换 runtime store                         |
| PR0b | 按本文件落 `schema.*`，运行 `drizzle-kit generate`，提交 generated SQL、snapshot、journal                    | 只包含 schema / migration，不混业务代码      |
| PR0c | 增加 `setup-db` / `migrate` 脚本、K8s Secret 注入、CI / smoke 初始化 MySQL                                   | 不再使用 PVC 作为运行态真相源                |
| PR0d | 实现 MySQL-backed runtime store，直接读写关系表；不引入 snapshot bridge                                      | 不迁移旧 file/PVC 测试数据                   |
| PR0e | runtime 默认切到 `mysql + redis`，移除 `PAGES_GATEWAY_STORE_FILE`、`pages-gateway-data` PVC 和 `/data` mount | 本地 smoke、staging、production 都走同一基座 |

### Generated SQL 批次

Drizzle 会自动命名 migration 文件，不要求人工指定文件名。PR 描述必须把生成文件映射到下面的批次，方便 review SQL：

1. identity: `users`, `employees`, `external_identity_bindings`, `service_accounts`, `api_tokens`
2. policy/prompt: `policy_versions`, `prompt_versions`
3. site: `site_owner_scopes`, `site_projects`, `site_access_policies`, `site_admin_grants`
4. workflow: `publishing_jobs`, `job_stages`, `job_stage_attempts`, `agent_runs`
5. project index: `project_index_snapshots`, `project_index_items`
6. slack: `slack_events`, `slack_message_batches`, `slack_sessions`, `session_memories`, `issue_links`, `trusted_slack_bot_policies`
7. integrations: `integration_bindings`
8. site check: `site_check_runs`
9. github/review: `github_webhook_deliveries`, `review_runs`, `review_agent_comments`
10. deploy: `cloudflare_resource_pools`, `deploy_records`
11. event/audit/logs: `job_events`, `audit_logs`, `runtime_log_pointers`, `external_api_call_logs`

### SQL Review Checklist

- 所有表使用 InnoDB、`utf8mb4`；ID / hash / Git SHA / 外部 ID / dedupe hash 字段显式大小写敏感。
- 所有业务主键是 `varchar(64)` 字符串 ID，不使用 auto-increment 业务主键。
- 幂等唯一约束不依赖 nullable 业务字段；长路径 / 长 dedupe key 使用 `*_hash char(64)` 入唯一索引。
- `datetime(3)` 字段使用 UTC；append-only event / audit / call log 不强制 `updated_at`。
- 外键或应用层引用策略必须清楚；业务历史表禁止 cascade delete。
- SQL 中不能出现 secret、token、真实 Cloudflare 资源 id 或真实内部账号数据。
- `drizzle-kit push` 只允许一次性本地 scratch 验证，不进入 CI、staging、production，也不能替代 committed migration。
- 如果确需手改数据迁移 SQL，先用 `drizzle-kit generate` 生成骨架，再在同一个新 migration 文件里追加 DML 注释；不能编辑历史 migration 或 `_journal.json`。
- JSON snapshot 导入 MySQL 是一次性脚本，不属于长期 runtime，也不替代 Drizzle schema migration。

## ID Prefix

| 对象                    | Prefix       |
| ----------------------- | ------------ |
| User                    | `usr_`       |
| Employee                | `emp_`       |
| ExternalIdentityBinding | `xid_`       |
| ServiceAccount          | `svc_`       |
| ApiToken                | `tok_`       |
| PolicyVersion           | `policy_`    |
| PromptVersion           | `prompt_`    |
| SiteOwnerScope          | `scope_`     |
| SiteProject             | `site_`      |
| SiteAccessPolicy        | `access_`    |
| SiteAdminGrant          | `grant_`     |
| PublishingJob           | `job_`       |
| JobStage                | `stage_`     |
| JobStageAttempt         | `attempt_`   |
| AgentRun                | `agent_`     |
| ProjectIndexSnapshot    | `idxsnap_`   |
| ProjectIndexItem        | `idxitem_`   |
| SlackEvent              | `sevt_`      |
| SlackMessageBatch       | `smb_`       |
| SlackSession            | `sess_`      |
| SessionMemory           | `mem_`       |
| IssueLink               | `issuelink_` |
| TrustedSlackBotPolicy   | `tsbp_`      |
| IntegrationBinding      | `int_`       |
| SiteCheckRun            | `check_`     |
| GitHubWebhookDelivery   | `ghdeliv_`   |
| ReviewRun               | `review_`    |
| ReviewAgentComment      | `rac_`       |
| DeployRecord            | `deploy_`    |
| CloudflareResourcePool  | `cfpool_`    |
| JobEvent                | `event_`     |
| AuditLog                | `audit_`     |
| RuntimeLogPointer       | `logptr_`    |
| ExternalApiCallLog      | `extcall_`   |
| AdminSavedLogQuery      | `savedlog_`  |

## Identity

### `users`

平台登录和操作人真相源。

| 字段                        | 类型           | 说明                            |
| --------------------------- | -------------- | ------------------------------- |
| `id`                        | varchar(64) pk | `usr_...`                       |
| `email`                     | varchar(255)   | 公司邮箱                        |
| `name`                      | varchar(255)   | 展示名                          |
| `status`                    | enum           | `active \| disabled \| deleted` |
| `is_platform_admin`         | boolean        | 平台管理员                      |
| `created_at` / `updated_at` | datetime       | 时间戳                          |

约束：

- `unique(email)`。
- `status=disabled` 的用户不能创建新 job，但历史记录保留。

### `employees`

员工归属主体。不是网站，也不是登录态。

| 字段                        | 类型                  | 说明                               |
| --------------------------- | --------------------- | ---------------------------------- |
| `id`                        | varchar(64) pk        | `emp_...`                          |
| `user_id`                   | varchar(64) nullable  | 对应 user；离职后可为空或 disabled |
| `employee_no`               | varchar(128) nullable | 工号                               |
| `slug`                      | varchar(80)           | URL / path 中使用                  |
| `display_name`              | varchar(255)          | 展示名                             |
| `status`                    | enum                  | `active \| inactive \| archived`   |
| `created_at` / `updated_at` | datetime              | 时间戳                             |

约束：

- `unique(slug)`。
- `unique(employee_no)`，允许 nullable；只用于非空工号去重，不承载流程幂等。

### `external_identity_bindings`

外部身份绑定。

| 字段                        | 类型                  | 说明                                |
| --------------------------- | --------------------- | ----------------------------------- |
| `id`                        | varchar(64) pk        | `xid_...`                           |
| `provider`                  | enum                  | `slack \| github_enterprise \| sso` |
| `provider_team_or_org`      | varchar(255)          | Slack team id / GitHub org          |
| `provider_user_id`          | varchar(255)          | Slack user id / GitHub user id      |
| `provider_login`            | varchar(255) nullable | GitHub login / Slack display        |
| `user_id`                   | varchar(64)           | 内部 user                           |
| `employee_id`               | varchar(64) nullable  | 可直接关联员工                      |
| `status`                    | enum                  | `active \| revoked`                 |
| `created_at` / `updated_at` | datetime              | 时间戳                              |

约束：

- `unique(provider, provider_team_or_org, provider_user_id)`。
- `index(user_id)`。
- `index(employee_id)`。

### `service_accounts`

CI、内部系统或受信 SlackBot 映射的调用主体。

| 字段                        | 类型                 | 说明                 |
| --------------------------- | -------------------- | -------------------- |
| `id`                        | varchar(64) pk       | `svc_...`            |
| `name`                      | varchar(255)         | 名称                 |
| `status`                    | enum                 | `active \| disabled` |
| `owner_user_id`             | varchar(64) nullable | 负责维护的人         |
| `created_at` / `updated_at` | datetime             | 时间戳               |

### `api_tokens`

Internal API token，只存 hash。

| 字段                            | 类型              | 说明                      |
| ------------------------------- | ----------------- | ------------------------- |
| `id`                            | varchar(64) pk    | `tok_...`                 |
| `actor_type`                    | enum              | `user \| service_account` |
| `actor_id`                      | varchar(64)       | user 或 service account   |
| `token_hash`                    | varchar(255)      | token hash                |
| `scopes_json`                   | json              | 权限范围                  |
| `allowed_owner_scope_ids_json`  | json nullable     | 可操作 owner scope        |
| `allowed_site_project_ids_json` | json nullable     | 可操作站点                |
| `expires_at`                    | datetime nullable | 过期时间                  |
| `last_used_at`                  | datetime nullable | 最近使用                  |
| `status`                        | enum              | `active \| revoked`       |
| `created_at` / `updated_at`     | datetime          | 时间戳                    |

约束：

- `unique(token_hash)`。
- API 返回 token 时只能返回一次明文，之后不可再读明文。

## Policies And Prompts

### `policy_versions`

公司规则、权限规则、secret 处理规则和站点隔离规则的版本快照。表里不保存 token 明文，只保存规则内容 hash 和来源引用。

| 字段                        | 类型           | 说明                                   |
| --------------------------- | -------------- | -------------------------------------- |
| `id`                        | varchar(64) pk | `policy_...`                           |
| `policy_key`                | varchar(128)   | 例如 `company-publishing-policy`       |
| `version`                   | varchar(64)    | 语义版本或 commit-based 版本           |
| `content_hash`              | varchar(255)   | 规则内容 hash                          |
| `source_ref`                | varchar(512)   | repo path + commit SHA 或 artifact ref |
| `status`                    | enum           | `draft \| active \| retired`           |
| `created_at` / `updated_at` | datetime       | 时间戳                                 |

约束：

- `unique(policy_key, version)`。
- `unique(policy_key, content_hash)`。

### `prompt_versions`

Slack Agent / Coding Agent 的 prompt 模板版本快照。

| 字段                        | 类型           | 说明                                   |
| --------------------------- | -------------- | -------------------------------------- |
| `id`                        | varchar(64) pk | `prompt_...`                           |
| `agent_kind`                | enum           | `slack_agent \| coding_agent`          |
| `prompt_key`                | varchar(128)   | 例如 `slack-agent-system`              |
| `version`                   | varchar(64)    | 语义版本或 commit-based 版本           |
| `content_hash`              | varchar(255)   | prompt 内容 hash                       |
| `source_ref`                | varchar(512)   | repo path + commit SHA 或 artifact ref |
| `status`                    | enum           | `draft \| active \| retired`           |
| `created_at` / `updated_at` | datetime       | 时间戳                                 |

约束：

- `unique(agent_kind, prompt_key, version)`。
- `unique(agent_kind, prompt_key, content_hash)`。

## Site Ownership

### `site_owner_scopes`

站点归属域。MVP 主要是个人员工域，后续可扩展 team。

| 字段                        | 类型                  | 说明                                                           |
| --------------------------- | --------------------- | -------------------------------------------------------------- |
| `id`                        | varchar(64) pk        | `scope_...`                                                    |
| `kind`                      | enum                  | `personal \| team`                                             |
| `employee_id`               | varchar(64) nullable  | personal scope 对应员工                                        |
| `team_key`                  | varchar(128) nullable | 后续 team scope                                                |
| `owner_unique_key`          | varchar(160)          | personal 使用 `emp:<employee_id>`，team 使用 `team:<team_key>` |
| `slug`                      | varchar(80)           | path 中的 owner slug                                           |
| `display_name`              | varchar(255)          | 展示名                                                         |
| `max_sites`                 | int                   | 配额，默认可较大但不能无限无约束                               |
| `status`                    | enum                  | `active \| archived`                                           |
| `created_at` / `updated_at` | datetime              | 时间戳                                                         |

约束：

- `unique(slug)`。
- `unique(owner_unique_key)`，避免 `employee_id` / `team_key` nullable unique 语义不一致。

### `site_projects`

一个员工名下的一个具体网站。员工可以有多个。

| 字段                                       | 类型                 | 说明                                |
| ------------------------------------------ | -------------------- | ----------------------------------- |
| `id`                                       | varchar(64) pk       | `site_...`                          |
| `owner_scope_id`                           | varchar(64)          | 归属域                              |
| `employee_id`                              | varchar(64) nullable | 冗余方便查询，personal scope 下必填 |
| `site_slug`                                | varchar(80)          | owner scope 内唯一                  |
| `site_name`                                | varchar(128)         | Cloudflare hostname 前缀            |
| `title`                                    | varchar(255)         | 展示标题                            |
| `repo_full_name`                           | varchar(255)         | GitHub Enterprise repo              |
| `repo_path`                                | varchar(512)         | `sites/<employee>/<site>`           |
| `repo_path_hash`                           | char(64)             | `repo_path` 的 SHA-256 hex          |
| `production_hostname`                      | varchar(255)         | 生产域名                            |
| `preview_hostname_pattern`                 | varchar(255)         | preview 域名模式                    |
| `current_deploy_id`                        | varchar(64) nullable | 当前生产部署                        |
| `resource_pool_id`                         | varchar(64)          | Cloudflare resource pool            |
| `default_access_mode`                      | enum                 | `public \| company \| allowlist`    |
| `status`                                   | enum                 | `active \| archived \| deleted`     |
| `created_at` / `updated_at` / `deleted_at` | datetime             | 时间戳                              |

约束：

- `unique(owner_scope_id, site_slug)`。
- `unique(site_name)`。
- `unique(production_hostname)`。
- `unique(repo_full_name, repo_path_hash)`。
- `index(employee_id)`。

### `site_access_policies`

控制已发布网站内容访问，不控制管理界面。

| 字段                        | 类型                             | 说明                                             |
| --------------------------- | -------------------------------- | ------------------------------------------------ |
| `id`                        | varchar(64) pk                   | `access_...`                                     |
| `site_project_id`           | varchar(64)                      | 站点                                             |
| `environment`               | enum                             | `preview \| production`                          |
| `mode`                      | enum                             | `public \| company \| allowlist`                 |
| `allowlist_json`            | json nullable                    | 用户、邮箱、群组、IP/CIDR                        |
| `version`                   | int                              | 策略版本                                         |
| `status`                    | enum                             | `active \| disabled`                             |
| `active_unique_key`         | varchar(16) generated / nullable | `status=active` 时为 `active`，其它状态为 `NULL` |
| `created_at` / `updated_at` | datetime                         | 时间戳                                           |

约束：

- `unique(site_project_id, environment, active_unique_key)` 确保同一站点同一环境只有一条 active 策略。
- `index(site_project_id, environment, updated_at)`。

### `site_admin_grants`

控制谁能管理站点。

| 字段                        | 类型                 | 说明                                     |
| --------------------------- | -------------------- | ---------------------------------------- |
| `id`                        | varchar(64) pk       | `grant_...`                              |
| `site_project_id`           | varchar(64)          | 站点                                     |
| `actor_type`                | enum                 | `user \| employee \| service_account`    |
| `actor_id`                  | varchar(64)          | 被授权主体                               |
| `role`                      | enum                 | `owner \| admin \| maintainer \| viewer` |
| `granted_by_user_id`        | varchar(64) nullable | 授权人                                   |
| `status`                    | enum                 | `active \| revoked`                      |
| `created_at` / `updated_at` | datetime             | 时间戳                                   |

约束：

- `unique(site_project_id, actor_type, actor_id)`。
- `index(actor_type, actor_id)`。

## Publishing Workflow

### `publishing_jobs`

一次发布请求的总状态。

| 字段                        | 类型                   | 说明                                                           |
| --------------------------- | ---------------------- | -------------------------------------------------------------- |
| `id`                        | varchar(64) pk         | `job_...`                                                      |
| `source`                    | enum                   | `slack \| api \| admin \| system`                              |
| `idempotency_key`           | varchar(255)           | 来源幂等 key                                                   |
| `request_id`                | varchar(128) nullable  | 入口请求 / Slack / API correlation id                          |
| `requested_by_type`         | enum                   | `user \| employee \| service_account`                          |
| `requested_by_id`           | varchar(64)            | 发起者                                                         |
| `site_project_id`           | varchar(64) nullable   | 目标站点，创建前可为空                                         |
| `owner_scope_id`            | varchar(64)            | 归属域                                                         |
| `employee_id`               | varchar(64) nullable   | personal scope 下使用                                          |
| `employee_slug`             | varchar(80)            | 冗余快照                                                       |
| `site_slug`                 | varchar(80)            | 冗余快照                                                       |
| `intent`                    | enum                   | `create_site \| update_site \| delete_site \| rollback_site`   |
| `approval_mode`             | enum                   | `draft \| manual_required \| trusted_auto`                     |
| `status`                    | enum                   | 见状态机                                                       |
| `title`                     | varchar(255)           | 需求标题                                                       |
| `summary`                   | text                   | 结构化摘要                                                     |
| `requester_profile_json`    | json nullable          | 发起人快照，例如 Slack display name、real name、email、user id |
| `error_code`                | varchar(128) nullable  | 失败码                                                         |
| `error_message`             | text nullable          | 可展示错误                                                     |
| `issue_number`              | int nullable           | GitHub issue                                                   |
| `pr_number`                 | int nullable           | GitHub PR                                                      |
| `branch_name`               | varchar(255) nullable  | 受控分支                                                       |
| `index_snapshot_id`         | varchar(64) nullable   | 本次 job 固定使用的项目索引快照                                |
| `preview_url`               | varchar(1024) nullable | preview                                                        |
| `created_at` / `updated_at` | datetime               | 时间戳                                                         |

约束：

- `unique(source, requested_by_type, requested_by_id, idempotency_key)`。
- `index(site_project_id, created_at)`。
- `index(site_project_id, updated_at)`。
- `index(owner_scope_id, updated_at)`。
- `index(employee_id, created_at)`。
- `index(status, updated_at)`。
- `index(source, created_at)`。
- `index(request_id)`。
- `index(issue_number)`。
- `index(pr_number)`。

状态枚举：

```text
received
summarizing
issue_creating
issue_created
indexing
generating_page
patch_generated
branch_committed
pr_created
reviewing
changes_requested
fixing
previewing
preview_deployed
approved
merging
merged
deploying
deployed
failed
cancelled
```

### `job_stages`

每个 job 的阶段状态。

| 字段                           | 类型                  | 说明                                                                                                                                            |
| ------------------------------ | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                           | varchar(64) pk        | `stage_...`                                                                                                                                     |
| `publishing_job_id`            | varchar(64)           | job                                                                                                                                             |
| `stage_type`                   | enum                  | `summarize \| issue \| project_index \| agent \| precheck \| commit_pr \| review_monitor \| fix \| preview_deploy \| merge \| deploy \| notify` |
| `status`                       | enum                  | `pending \| running \| succeeded \| failed \| skipped \| cancelled`                                                                             |
| `current_attempt_id`           | varchar(64) nullable  | 当前有效 attempt                                                                                                                                |
| `started_at` / `finished_at`   | datetime nullable     | 时间                                                                                                                                            |
| `error_code` / `error_message` | varchar/text nullable | 错误                                                                                                                                            |
| `created_at` / `updated_at`    | datetime              | 时间戳                                                                                                                                          |

约束：

- `unique(publishing_job_id, stage_type)`。
- `index(status, updated_at)`。

### `job_stage_attempts`

一次阶段执行尝试。所有 retry 必须新建 attempt。

| 字段                         | 类型                  | 说明                                                                                        |
| ---------------------------- | --------------------- | ------------------------------------------------------------------------------------------- |
| `id`                         | varchar(64) pk        | `attempt_...`                                                                               |
| `job_stage_id`               | varchar(64)           | stage                                                                                       |
| `publishing_job_id`          | varchar(64)           | 冗余                                                                                        |
| `attempt_no`                 | int                   | 从 1 开始                                                                                   |
| `executor_type`              | enum                  | `gateway_local \| worker \| github_actions \| k8s_job`                                      |
| `executor_ref`               | varchar(255) nullable | workflow run id / k8s job name                                                              |
| `executor_ref_key`           | varchar(320)          | 非空唯一键；有 executor_ref 时为 `<executor_type>:<executor_ref>`，否则 `none:<attempt_id>` |
| `callback_nonce_hash`        | varchar(255)          | callback nonce hash                                                                         |
| `status`                     | enum                  | `pending \| running \| succeeded \| failed \| expired \| ignored`                           |
| `input_json`                 | json nullable         | 输入快照                                                                                    |
| `output_json`                | json nullable         | 输出快照                                                                                    |
| `started_at` / `finished_at` | datetime nullable     | 时间                                                                                        |
| `created_at` / `updated_at`  | datetime              | 时间戳                                                                                      |

约束：

- `unique(job_stage_id, attempt_no)`。
- `unique(executor_ref_key)`，避免依赖 nullable `executor_ref` 的 MySQL unique 语义。
- `unique(callback_nonce_hash)`。
- gateway 只接受 `job_stages.current_attempt_id` 对应 attempt 的 callback。

### `agent_runs`

Agent 执行记录。Slack Agent 的 intent / summary、Coding Agent 的 initial / fix 都需要落这里，方便追踪使用了哪个 prompt / policy、读取了哪些输入、产出了什么结果。

| 字段                            | 类型                  | 说明                                                                                                  |
| ------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| `id`                            | varchar(64) pk        | `agent_...`                                                                                           |
| `agent_kind`                    | enum                  | `slack_agent \| coding_agent`                                                                         |
| `publishing_job_id`             | varchar(64) nullable  | job；Slack Agent 在创建 job 前可为空                                                                  |
| `slack_session_id`              | varchar(64) nullable  | Slack Agent 会话                                                                                      |
| `job_stage_attempt_id`          | varchar(64) nullable  | attempt；Coding Agent 必填                                                                            |
| `index_snapshot_id`             | varchar(64) nullable  | 本轮 agent 使用的项目索引快照                                                                         |
| `run_type`                      | enum                  | `slack_intent \| slack_summary \| initial \| fix`                                                     |
| `round_no`                      | int                   | Slack Agent 可按 session 递增；Coding initial 为 0，fix 从 1 开始                                     |
| `provider`                      | varchar(128) nullable | 模型供应商或 adapter，例如 `company-agent \| deterministic`                                           |
| `model`                         | varchar(255) nullable | 实际请求的模型名                                                                                      |
| `model_api_style`               | varchar(128) nullable | `company-openai-compatible \| deterministic`                                                          |
| `prompt_version_id`             | varchar(64) nullable  | prompt 版本                                                                                           |
| `prompt_version`                | varchar(64)           | 冗余快照                                                                                              |
| `prompt_hash`                   | varchar(255)          | prompt 内容 hash                                                                                      |
| `policy_version_id`             | varchar(64) nullable  | policy bundle 版本                                                                                    |
| `policy_version`                | varchar(64)           | 冗余快照                                                                                              |
| `policy_hash`                   | varchar(255)          | policy bundle hash                                                                                    |
| `input_summary_hash`            | varchar(255)          | 输入摘要 hash，不能保存 secret 明文                                                                   |
| `output_hash`                   | varchar(255) nullable | 结构化输出 hash                                                                                       |
| `output_patch_hash`             | varchar(255) nullable | Coding Agent patch hash                                                                               |
| `allowed_path`                  | varchar(512) nullable | Coding Agent 可写路径快照                                                                             |
| `base_sha`                      | varchar(64) nullable  | 输入基线                                                                                              |
| `head_sha`                      | varchar(64) nullable  | 输出 commit                                                                                           |
| `branch_name`                   | varchar(255) nullable | PR branch                                                                                             |
| `lease_expires_at`              | datetime nullable     | Slack Agent session lease 或 executor lease 到期时间                                                  |
| `started_at` / `completed_at`   | datetime nullable     | 运行开始 / 结束时间                                                                                   |
| `status`                        | enum                  | `pending \| running \| completed \| patch_generated \| committed \| failed \| timed_out \| cancelled` |
| `review_agent_comment_ids_json` | json nullable         | fix 输入                                                                                              |
| `report_json`                   | json nullable         | agent 报告                                                                                            |
| `created_at` / `updated_at`     | datetime              | 时间戳                                                                                                |

约束：

- Coding Agent 使用 `unique(publishing_job_id, run_type, round_no)`。
- Slack Agent 使用 `index(slack_session_id, created_at)`，同一 session 可多次分类/摘要。
- `index(publishing_job_id, status)`。
- Slack Agent 单轮默认 120 秒 timeout，session lease 默认 180 秒；同一 `slack_session_id` 同时只能有一个 running Slack Agent run。
- 如果使用模型供应商 thread / assistant id，只能作为 `report_json` 中的非敏感缓存引用，默认 24 小时失效；`SessionMemory` 才是会话真相源。
- Coding Agent run 默认 30 分钟 timeout，失败或超时后必须创建新的 `JobStageAttempt` / `AgentRun` retry，不能复用原 run。
- `agent_kind=coding_agent` 时必须有 `publishing_job_id`、`job_stage_attempt_id`、`allowed_path`。
- `agent_kind=slack_agent` 时必须有 `slack_session_id`，且不能写 `output_patch_hash`。

## Project Index

### `project_index_snapshots`

一次项目索引快照。用于固定某次 `PublishingJob` / `AgentRun` 看到的 repo、模板、站点和 review 上下文。

| 字段                           | 类型                   | 说明                                                     |
| ------------------------------ | ---------------------- | -------------------------------------------------------- |
| `id`                           | varchar(64) pk         | `idxsnap_...`                                            |
| `repo_full_name`               | varchar(255)           | GitHub Enterprise repo                                   |
| `base_sha`                     | varchar(64)            | 索引对应的 commit SHA                                    |
| `index_type`                   | enum                   | `full \| site \| template \| job_context`                |
| `scope_path`                   | varchar(512) nullable  | 例如 `sites/zhangsan/profile`                            |
| `scope_key`                    | varchar(512)           | 规范化唯一键；全量索引用 `__root__`，其它用 `scope_path` |
| `scope_key_hash`               | char(64)               | `scope_key` 的 SHA-256 hex                               |
| `artifact_ref`                 | varchar(1024) nullable | 大索引文件、context bundle 或 artifact 地址              |
| `manifest_hash`                | varchar(255)           | manifest hash                                            |
| `status`                       | enum                   | `pending \| indexing \| ready \| failed`                 |
| `error_code` / `error_message` | varchar/text nullable  | 错误                                                     |
| `created_at` / `updated_at`    | datetime               | 时间戳                                                   |

约束：

- `unique(repo_full_name, base_sha, index_type, scope_key_hash)`。
- `index(status, updated_at)`。

### `project_index_items`

索引快照里的条目。MVP 可以先保存 manifest 和 metadata，不强制引入向量数据库。

| 字段                        | 类型                   | 说明                                                                                                |
| --------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| `id`                        | varchar(64) pk         | `idxitem_...`                                                                                       |
| `snapshot_id`               | varchar(64)            | `ProjectIndexSnapshot`                                                                              |
| `path`                      | varchar(1024)          | repo path 或逻辑路径                                                                                |
| `path_hash`                 | char(64)               | `path` 的 SHA-256 hex                                                                               |
| `item_type`                 | enum                   | `site_config \| site_source \| template \| schema \| issue \| pr \| review_comment \| build_report` |
| `content_hash`              | varchar(255)           | 内容 hash                                                                                           |
| `metadata_json`             | json nullable          | 摘要、语言、大小、引用关系等                                                                        |
| `artifact_ref`              | varchar(1024) nullable | 大内容引用                                                                                          |
| `created_at` / `updated_at` | datetime               | 时间戳                                                                                              |

约束：

- `unique(snapshot_id, path_hash, item_type, content_hash)`。
- `index(snapshot_id, item_type)`。

## Slack

### `slack_events`

Slack event / command / interaction 幂等入口。

| 字段                        | 类型                   | 说明                                                                                                                        |
| --------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `id`                        | varchar(64) pk         | `sevt_...`                                                                                                                  |
| `team_id`                   | varchar(64)            | Slack workspace                                                                                                             |
| `dedupe_key`                | varchar(255)           | 非空幂等 key                                                                                                                |
| `event_id`                  | varchar(255) nullable  | event callback                                                                                                              |
| `trigger_id`                | varchar(255) nullable  | command/interaction                                                                                                         |
| `request_id`                | varchar(128) nullable  | gateway 请求 correlation id                                                                                                 |
| `channel_id`                | varchar(64) nullable   | channel                                                                                                                     |
| `thread_ts`                 | varchar(64) nullable   | thread                                                                                                                      |
| `event_ts`                  | varchar(64) nullable   | event ts                                                                                                                    |
| `source_type`               | enum                   | `user \| bot \| system`                                                                                                     |
| `slack_user_id`             | varchar(64) nullable   | 真人                                                                                                                        |
| `bot_user_id`               | varchar(64) nullable   | bot                                                                                                                         |
| `publishing_job_id`         | varchar(64) nullable   | 关联 job                                                                                                                    |
| `processing_status`         | enum                   | `received \| processing \| processed \| ignored \| failed`                                                                  |
| `result_type`               | enum nullable          | `none \| agent_replied \| clarification_requested \| job_created \| followup_appended \| status_returned \| session_closed` |
| `ignored_reason`            | varchar(128) nullable  | 忽略原因，如 bot event、unsupported subtype、duplicate event                                                                |
| `error_code`                | varchar(128) nullable  | 可展示错误码                                                                                                                |
| `error_message`             | text nullable          | 脱敏后的可展示错误                                                                                                          |
| `retry_num`                 | int nullable           | Slack retry header                                                                                                          |
| `retry_reason`              | varchar(255) nullable  | Slack retry reason                                                                                                          |
| `processing_started_at`     | datetime nullable      | 开始处理时间                                                                                                                |
| `processing_finished_at`    | datetime nullable      | 结束处理时间                                                                                                                |
| `payload_redacted_json`     | json                   | 脱敏后的 payload 快照                                                                                                       |
| `payload_hash`              | varchar(255)           | 原始 payload hash                                                                                                           |
| `raw_payload_ref`           | varchar(1024) nullable | 原始 payload 加密归档引用；MVP 默认为空                                                                                     |
| `created_at` / `updated_at` | datetime               | 时间戳                                                                                                                      |

约束：

- `unique(team_id, dedupe_key)`。
- `index(publishing_job_id)`。
- `index(request_id)`。
- `index(team_id, channel_id, thread_ts, created_at)`。
- `index(processing_status, created_at)`。
- `index(result_type, created_at)`。
- 普通查询只能读取 `payload_redacted_json`；原始 payload 如需保留，必须通过加密归档和审计读取。
- 重复 Slack retry 命中唯一键时，不新建行；只更新 retry metadata 和必要的 `updated_at`，并通过既有行返回处理结果。
- `processing_status` 是技术处理生命周期；`result_type` 是业务结果。两者不能混用，避免出现“业务已创建 job 但处理状态失败”这类互相矛盾的状态。
- `ignored_reason` 必须稳定枚举化，排障视图依赖它区分 `ignored_bot_event`、`ignored_subtype`、`unsupported_event`、`duplicate_event`、`unauthorized_actor`、`session_conflict`。

### `slack_message_batches`

Slack thread 脱敏消息快照和摘要；原文只通过 hash / 加密归档引用定位。

| 字段                                   | 类型                   | 说明                               |
| -------------------------------------- | ---------------------- | ---------------------------------- |
| `id`                                   | varchar(64) pk         | `smb_...`                          |
| `slack_event_id`                       | varchar(64)            | 来源事件                           |
| `team_id` / `channel_id` / `thread_ts` | varchar                | Slack 定位                         |
| `source_type`                          | enum                   | `user \| bot \| mixed`             |
| `source_bot_user_id`                   | varchar(64) nullable   | bot 来源                           |
| `messages_redacted_json`               | json                   | 脱敏后的消息快照                   |
| `messages_hash`                        | varchar(255)           | 原始消息集合 hash                  |
| `raw_messages_ref`                     | varchar(1024) nullable | 原始消息加密归档引用；MVP 默认为空 |
| `summary_json`                         | json                   | 结构化摘要                         |
| `status`                               | enum                   | `pending \| summarized \| failed`  |
| `created_at` / `updated_at`            | datetime               | 时间戳                             |

约束：

- `index(slack_event_id)`。
- `index(team_id, channel_id, thread_ts)`。
- 普通排障页面只能展示 `messages_redacted_json` 和 `summary_json`；未脱敏原文读取必须走 `AuditLog`。

### `slack_sessions`

Slack Agent 的常驻会话状态。`apps/slack-agent` 服务本身长期运行在服务器/K8s 上；这张表保存 Slack 用户名下的多个持久 session、memory、权限上下文和 issue / PR / preview 关联。常驻不代表每个用户独占一个模型进程，模型供应商 API 由 `apps/slack-agent` 在每轮消息处理时按需调用。

| 字段                               | 类型                   | 说明                                                                            |
| ---------------------------------- | ---------------------- | ------------------------------------------------------------------------------- |
| `id`                               | varchar(64) pk         | `sess_...`                                                                      |
| `team_id`                          | varchar(64)            | Slack workspace                                                                 |
| `primary_slack_user_id`            | varchar(64)            | Slack 发起人                                                                    |
| `session_key`                      | varchar(255)           | 同一用户下的 session 定位，例如 `thread:C1:171...`、`dm:current`、`job:job_xxx` |
| `conversation_key`                 | varchar(255)           | `team+primary_slack_user_id+session_key`                                        |
| `session_title`                    | varchar(255) nullable  | 便于用户选择的短标题                                                            |
| `channel_id`                       | varchar(64) nullable   | 最近一次消息所在 channel                                                        |
| `thread_ts`                        | varchar(64) nullable   | 最近一次消息所在 thread                                                         |
| `dm_channel_id`                    | varchar(64) nullable   | 最近一次 DM channel                                                             |
| `surface_context_json`             | json nullable          | 最近若干 Slack surface / thread / event 定位，不作为会话隔离键                  |
| `primary_user_id`                  | varchar(64) nullable   | 绑定后的内部 user                                                               |
| `owner_scope_id`                   | varchar(64) nullable   | 当前会话归属域                                                                  |
| `active_publishing_job_id`         | varchar(64) nullable   | 当前 job                                                                        |
| `active_issue_number`              | int nullable           | 当前 issue                                                                      |
| `active_pr_number`                 | int nullable           | 当前 PR                                                                         |
| `active_preview_url`               | varchar(1024) nullable | 最近 preview                                                                    |
| `last_intent`                      | varchar(128) nullable  | 最近识别意图                                                                    |
| `last_event_ts`                    | varchar(64) nullable   | 最近 Slack event ts                                                             |
| `last_active_at`                   | datetime nullable      | 最近有效用户消息时间                                                            |
| `active_context_expires_at`        | datetime nullable      | active job / issue / preview 默认续接过期时间                                   |
| `waiting_clarification_expires_at` | datetime nullable      | 等待澄清过期时间                                                                |
| `closed_at`                        | datetime nullable      | 用户主动关闭时间                                                                |
| `archived_at`                      | datetime nullable      | session 归档时间                                                                |
| `status`                           | enum                   | `active \| waiting_clarification \| paused \| expired \| closed \| archived`    |
| `metadata_json`                    | json nullable          | 非敏感扩展信息                                                                  |
| `created_at` / `updated_at`        | datetime               | 时间戳                                                                          |

约束：

- `unique(team_id, primary_slack_user_id, session_key)`。
- `unique(team_id, conversation_key)`。
- `index(primary_slack_user_id, last_active_at)`。
- `index(primary_user_id, updated_at)`。
- `index(owner_scope_id, updated_at)`。
- `conversation_key` 必须包含用户和 session，不能只按 channel / thread 生成共享会话。
- 不同 Slack user 的 session memory 不能串用。
- 同一用户的多个 session / 任务通过 `session_key`、`issue_links` 和 owner scope 权限校验隔离；不能只因为同一用户发消息就自动操作任意旧 issue。

默认过期策略：

- active context 12 小时无用户消息后过期，状态可转为 `expired` 或清空 active context。
- waiting clarification 1 天无回复后转 `paused`。
- 过期但未归档的 session 14 天内可作为 recent 候选让用户选择。
- session 90 天无活动后可转 `archived` 或做 memory 压缩。
- 用户主动说关闭、结束、不用了或归档时，立即写 `closed_at` 并清空 active context。

### `session_memories`

Slack Agent 的会话记忆。MVP 保存当前摘要即可；后续可以追加 memory history 表。

| 字段                        | 类型                 | 说明                  |
| --------------------------- | -------------------- | --------------------- |
| `id`                        | varchar(64) pk       | `mem_...`             |
| `slack_session_id`          | varchar(64)          | session               |
| `summary`                   | text nullable        | 会话摘要              |
| `requirements_json`         | json nullable        | 结构化需求            |
| `pending_questions_json`    | json nullable        | 待澄清问题            |
| `preferences_json`          | json nullable        | 用户偏好              |
| `last_preview_feedback`     | text nullable        | 最近 preview 修改意见 |
| `last_agent_response`       | text nullable        | 最近 Agent 回复摘要   |
| `updated_by_agent_run_id`   | varchar(64) nullable | 更新来源              |
| `version`                   | int                  | 从 1 开始递增         |
| `created_at` / `updated_at` | datetime             | 时间戳                |

约束：

- `unique(slack_session_id)` 保存当前 memory。
- `index(updated_by_agent_run_id)`。
- memory 中不能保存 token、secret 或可复原的私密凭据。

### `issue_links`

Slack session、PublishingJob、GitHub issue / PR / preview 的关联表。用于用户在 Slack 里继续说“这个 preview 不满意，继续改”时续接同一个任务。

| 字段                        | 类型                   | 说明                                |
| --------------------------- | ---------------------- | ----------------------------------- |
| `id`                        | varchar(64) pk         | `issuelink_...`                     |
| `slack_session_id`          | varchar(64)            | session                             |
| `publishing_job_id`         | varchar(64)            | job                                 |
| `repo_full_name`            | varchar(255)           | GitHub Enterprise repo              |
| `issue_number`              | int                    | GitHub issue                        |
| `pr_number`                 | int nullable           | GitHub PR                           |
| `branch_name`               | varchar(255) nullable  | 受控 branch                         |
| `preview_url`               | varchar(1024) nullable | 最近 preview                        |
| `head_sha`                  | varchar(64) nullable   | 最近 PR head                        |
| `relationship`              | enum                   | `primary \| followup \| superseded` |
| `status`                    | enum                   | `active \| closed \| superseded`    |
| `created_at` / `updated_at` | datetime               | 时间戳                              |

约束：

- `unique(publishing_job_id)`。
- `index(slack_session_id, status)`。
- `index(repo_full_name, issue_number)`。
- `index(repo_full_name, pr_number)`。
- `index(publishing_job_id, updated_at)`。
- 复用 issue / PR 前必须校验 actor 对 `owner_scope_id` / `site_project_id` 有管理权限。

### `trusted_slack_bot_policies`

控制另一个 SlackBot 消息能否触发任务。

| 字段                           | 类型                 | 说明                                                        |
| ------------------------------ | -------------------- | ----------------------------------------------------------- |
| `id`                           | varchar(64) pk       | `tsbp_...`                                                  |
| `team_id`                      | varchar(64)          | Slack workspace                                             |
| `bot_user_id`                  | varchar(64)          | bot user                                                    |
| `app_id`                       | varchar(64) nullable | Slack app                                                   |
| `mode`                         | enum                 | `evidence_only \| require_human_confirm \| service_account` |
| `service_account_id`           | varchar(64) nullable | service account                                             |
| `allowed_channel_ids_json`     | json nullable        | channel allowlist                                           |
| `allowed_owner_scope_ids_json` | json nullable        | owner scope allowlist                                       |
| `status`                       | enum                 | `active \| disabled`                                        |
| `created_at` / `updated_at`    | datetime             | 时间戳                                                      |

约束：

- `unique(team_id, bot_user_id)`。

## Integrations

### `integration_bindings`

外部集成配置和 secret 引用。

| 字段                        | 类型                  | 说明                                                        |
| --------------------------- | --------------------- | ----------------------------------------------------------- |
| `id`                        | varchar(64) pk        | `int_...`                                                   |
| `provider`                  | enum                  | `slack \| github_enterprise \| cloudflare \| review_agent`  |
| `scope_type`                | enum                  | `platform \| owner_scope \| site_project`                   |
| `scope_id`                  | varchar(64) nullable  | platform 可为空                                             |
| `scope_key`                 | varchar(128)          | 规范化唯一键；platform 使用 `platform`，其它使用 `scope_id` |
| `config_json`               | json                  | 非敏感配置                                                  |
| `secret_ref`                | varchar(255) nullable | secret 引用                                                 |
| `status`                    | enum                  | `active \| disabled`                                        |
| `created_at` / `updated_at` | datetime              | 时间戳                                                      |

约束：

- `unique(provider, scope_type, scope_key)`。

## Site Check

### `site_check_runs`

`site-check` / `pages-site-policy` 的确定性检查记录。Preview gate 不能只看 workflow 结论字符串，必须绑定到同一个 PR head SHA 的持久化检查结果。

| 字段                           | 类型                   | 说明                                                            |
| ------------------------------ | ---------------------- | --------------------------------------------------------------- |
| `id`                           | varchar(64) pk         | `check_...`                                                     |
| `publishing_job_id`            | varchar(64)            | job                                                             |
| `site_project_id`              | varchar(64) nullable   | 站点                                                            |
| `repo_full_name`               | varchar(255)           | GitHub Enterprise repo                                          |
| `pr_number`                    | int                    | PR                                                              |
| `head_sha`                     | varchar(64)            | 被检查 commit                                                   |
| `base_sha`                     | varchar(64) nullable   | PR base                                                         |
| `allowed_path`                 | varchar(512)           | 单一站点目录                                                    |
| `check_source`                 | enum                   | `pages_agent_precheck \| pull_request_required \| preview_gate` |
| `status`                       | enum                   | `pending \| running \| passed \| failed \| stale`               |
| `pages_site_policy_status`     | enum                   | `pending \| passed \| failed \| skipped`                        |
| `path_allowlist_status`        | enum                   | `pending \| passed \| failed`                                   |
| `schema_status`                | enum                   | `pending \| passed \| failed`                                   |
| `secret_scan_status`           | enum                   | `pending \| passed \| failed`                                   |
| `file_policy_status`           | enum                   | `pending \| passed \| failed`                                   |
| `build_status`                 | enum                   | `pending \| passed \| failed \| skipped`                        |
| `changed_files_json`           | json                   | PR / patch 文件列表                                             |
| `report_artifact_ref`          | varchar(1024) nullable | check report artifact                                           |
| `error_code` / `error_message` | varchar/text nullable  | 错误                                                            |
| `created_at` / `updated_at`    | datetime               | 时间戳                                                          |

约束：

- `unique(repo_full_name, pr_number, head_sha, check_source)`。
- `index(publishing_job_id, status)`。
- `index(site_project_id, updated_at)`。
- Preview gate 只接受 `check_source=pull_request_required` 且 `status=passed` 的当前 PR head SHA。
- `pages_site_policy_status=failed`、`path_allowlist_status=failed`、`secret_scan_status=failed` 都不能自动修复后直接放行，必须重新生成新的 `site_check_runs`。

## GitHub And Review

### `github_webhook_deliveries`

GitHub Enterprise webhook 幂等。

| 字段                        | 类型                  | 说明                                         |
| --------------------------- | --------------------- | -------------------------------------------- |
| `id`                        | varchar(64) pk        | `ghdeliv_...`                                |
| `repo_full_name`            | varchar(255)          | repo                                         |
| `delivery_id`               | varchar(255)          | GitHub delivery id                           |
| `request_id`                | varchar(128) nullable | gateway 请求 correlation id                  |
| `event_name`                | varchar(128)          | event                                        |
| `action`                    | varchar(128) nullable | action                                       |
| `payload_hash`              | varchar(255)          | payload hash                                 |
| `status`                    | enum                  | `received \| processed \| ignored \| failed` |
| `processed_at`              | datetime nullable     | 处理时间                                     |
| `created_at` / `updated_at` | datetime              | 时间戳                                       |

约束：

- `unique(repo_full_name, delivery_id)`。
- `index(request_id)`。

### `review_runs`

一次 review 轮次。

| 字段                         | 类型              | 说明                                                            |
| ---------------------------- | ----------------- | --------------------------------------------------------------- |
| `id`                         | varchar(64) pk    | `review_...`                                                    |
| `publishing_job_id`          | varchar(64)       | job                                                             |
| `repo_full_name`             | varchar(255)      | repo                                                            |
| `pr_number`                  | int               | PR                                                              |
| `head_sha`                   | varchar(64)       | 被 review 的 commit                                             |
| `source`                     | enum              | `deterministic \| github_review_agent \| human \| mixed`        |
| `status`                     | enum              | `pending \| passed \| changes_requested \| commented \| failed` |
| `started_at` / `finished_at` | datetime nullable | 时间                                                            |
| `created_at` / `updated_at`  | datetime          | 时间戳                                                          |

约束：

- `unique(repo_full_name, pr_number, head_sha, source)`。

### `review_agent_comments`

GitHub Review Agent comment 归一化记录。

| 字段                        | 类型                   | 说明                                                             |
| --------------------------- | ---------------------- | ---------------------------------------------------------------- |
| `id`                        | varchar(64) pk         | `rac_...`                                                        |
| `publishing_job_id`         | varchar(64) nullable   | job；Review Agent comment 可能早于 `pr_created` callback 到达    |
| `review_run_id`             | varchar(64) nullable   | review run                                                       |
| `repo_full_name`            | varchar(255)           | repo                                                             |
| `pr_number`                 | int                    | PR                                                               |
| `head_sha`                  | varchar(64) nullable   | 被 review 的 commit；可先保存 7-40 位短 SHA，绑定 job 后补全     |
| `github_review_id`          | varchar(255) nullable  | review id                                                        |
| `github_comment_id`         | varchar(255) nullable  | REST id                                                          |
| `github_comment_node_id`    | varchar(255)           | GraphQL node id 或稳定 fallback                                  |
| `dedupe_key`                | varchar(512)           | 规范化幂等键；node id 不可用时用 source/path/line/body hash 组合 |
| `dedupe_key_hash`           | char(64)               | `dedupe_key` 的 SHA-256 hex                                      |
| `source_type`               | enum                   | `review_summary \| inline_comment \| issue_comment \| check_run` |
| `review_agent_login`        | varchar(255)           | bot login/app slug                                               |
| `check_run_name`            | varchar(255) nullable  | check 名                                                         |
| `path`                      | varchar(1024) nullable | 文件路径                                                         |
| `line`                      | int nullable           | 行号                                                             |
| `diff_hunk`                 | text nullable          | diff hunk                                                        |
| `body`                      | text                   | comment 内容                                                     |
| `body_hash`                 | varchar(255)           | body hash                                                        |
| `classification`            | enum                   | `blocking \| suggestion \| note \| unknown`                      |
| `status`                    | enum                   | `open \| resolved \| outdated \| dismissed \| deleted`           |
| `first_seen_delivery_id`    | varchar(255)           | 首次 webhook                                                     |
| `last_seen_delivery_id`     | varchar(255)           | 最近 webhook                                                     |
| `created_at` / `updated_at` | datetime               | 时间戳                                                           |

约束：

- `unique(repo_full_name, dedupe_key_hash)`。
- `index(repo_full_name, github_comment_node_id)`。
- `index(repo_full_name, pr_number, head_sha)`。
- `index(publishing_job_id, classification, status)`。
- `unknown` 不能自动修复，也不能进入 `trusted_auto` 放行。
- `publishing_job_id` 允许先为空；`pr_created` callback 或 reconciler 绑定 `repo_full_name + pr_number + head_sha` 后再回填。不能因为暂时找不到 job 就丢弃已验证的 Review Agent comment。
- `head_sha` 匹配允许短 SHA 前缀匹配，但 job、PR link 和 deploy record 最终应保存完整 40 位 SHA。

## Deploy

### `cloudflare_resource_pools`

平台级 Cloudflare 资源池。

| 字段                        | 类型                  | 说明                    |
| --------------------------- | --------------------- | ----------------------- |
| `id`                        | varchar(64) pk        | `cfpool_...`            |
| `environment`               | enum                  | `preview \| production` |
| `name`                      | varchar(128)          | 资源池名                |
| `zone_name`                 | varchar(255)          | zone                    |
| `edge_worker_name`          | varchar(255)          | 多租户 Edge Worker      |
| `config_kv_namespace`       | varchar(255)          | 平台级 KV namespace     |
| `assets_bucket`             | varchar(255) nullable | R2/assets bucket        |
| `route_pattern`             | varchar(255)          | route                   |
| `status`                    | enum                  | `active \| disabled`    |
| `created_at` / `updated_at` | datetime              | 时间戳                  |

约束：

- `unique(environment, name)`。
- 不为每站点默认创建 KV namespace。

### `deploy_records`

preview / production 部署记录。

| 字段                           | 类型                   | 说明                                                        |
| ------------------------------ | ---------------------- | ----------------------------------------------------------- |
| `id`                           | varchar(64) pk         | `deploy_...`                                                |
| `idempotency_key`              | varchar(255)           | 非空幂等键，按 environment + site + commit/head 生成        |
| `site_project_id`              | varchar(64)            | 站点                                                        |
| `publishing_job_id`            | varchar(64)            | job                                                         |
| `environment`                  | enum                   | `preview \| production`                                     |
| `repo_full_name`               | varchar(255)           | repo                                                        |
| `pr_number`                    | int nullable           | PR                                                          |
| `merge_commit_sha`             | varchar(64) nullable   | production 必填                                             |
| `head_sha`                     | varchar(64) nullable   | preview 可用                                                |
| `github_delivery_id`           | varchar(255) nullable  | merge webhook                                               |
| `resource_pool_id`             | varchar(64)            | resource pool                                               |
| `deploy_id`                    | varchar(128)           | external deploy id                                          |
| `url`                          | varchar(1024)          | 访问地址                                                    |
| `manifest_key`                 | varchar(1024) nullable | manifest 路径                                               |
| `assets_prefix`                | varchar(1024) nullable | assets 前缀                                                 |
| `status`                       | enum                   | `pending \| deploying \| deployed \| failed \| rolled_back` |
| `error_code` / `error_message` | varchar/text nullable  | 错误                                                        |
| `created_at` / `updated_at`    | datetime               | 时间戳                                                      |

约束：

- `unique(idempotency_key)`。
- `unique(resource_pool_id, deploy_id)`。
- `index(site_project_id, environment, status, updated_at)`。
- production 幂等键使用 `production:<site_project_id>:<merge_commit_sha>`，不能从 floating branch 构建。
- preview 幂等键使用 `preview:<site_project_id>:<head_sha>:<pr_number>`，避免 nullable unique 失效。

## Events And Audit

### `job_events`

给控制台、Slack notifier 和排障使用。

| 字段                   | 类型                  | 说明                       |
| ---------------------- | --------------------- | -------------------------- |
| `id`                   | varchar(64) pk        | `event_...`                |
| `publishing_job_id`    | varchar(64)           | job                        |
| `stage_type`           | varchar(128) nullable | 阶段                       |
| `job_stage_id`         | varchar(64) nullable  | stage id                   |
| `job_stage_attempt_id` | varchar(64) nullable  | attempt id                 |
| `event_type`           | varchar(128)          | 事件类型                   |
| `level`                | enum                  | `info \| warning \| error` |
| `message`              | text                  | 可展示消息                 |
| `request_id`           | varchar(128) nullable | 关联请求 ID                |
| `data_json`            | json nullable         | 结构化数据                 |
| `created_at`           | datetime              | 时间                       |

索引：

- `index(publishing_job_id, created_at)`。
- `index(job_stage_attempt_id, created_at)`。

### `audit_logs`

不可替代的审计记录。

| 字段            | 类型                  | 说明                                            |
| --------------- | --------------------- | ----------------------------------------------- |
| `id`            | varchar(64) pk        | `audit_...`                                     |
| `actor_type`    | enum                  | `user \| employee \| service_account \| system` |
| `actor_id`      | varchar(64) nullable  | actor                                           |
| `action`        | varchar(128)          | 动作                                            |
| `resource_type` | varchar(128)          | 资源类型                                        |
| `resource_id`   | varchar(64)           | 资源 ID                                         |
| `request_id`    | varchar(128) nullable | 请求 ID                                         |
| `ip`            | varchar(64) nullable  | 来源 IP                                         |
| `user_agent`    | varchar(512) nullable | UA                                              |
| `data_json`     | json nullable         | 审计数据                                        |
| `created_at`    | datetime              | 时间                                            |

索引：

- `index(resource_type, resource_id, created_at)`。
- `index(actor_type, actor_id, created_at)`。

### `runtime_log_pointers`

记录 job / stage / attempt 与外部运行日志位置的关系，不保存 K8s stdout / GitHub log 全文。

| 字段                             | 类型                   | 说明                                                      |
| -------------------------------- | ---------------------- | --------------------------------------------------------- |
| `id`                             | varchar(64) pk         | `logptr_...`                                              |
| `dedupe_key`                     | varchar(512)           | 非空幂等键，规范化外部日志定位                            |
| `dedupe_key_hash`                | char(64)               | `dedupe_key` 的 SHA-256 hex                               |
| `publishing_job_id`              | varchar(64)            | job                                                       |
| `job_stage_id`                   | varchar(64) nullable   | stage                                                     |
| `job_stage_attempt_id`           | varchar(64) nullable   | attempt                                                   |
| `source_type`                    | enum                   | `k8s \| github_actions \| cloudflare \| slack \| gateway` |
| `namespace`                      | varchar(255) nullable  | K8s namespace                                             |
| `workload_name`                  | varchar(255) nullable  | deployment / job / pod owner                              |
| `pod_name`                       | varchar(255) nullable  | pod                                                       |
| `container_name`                 | varchar(255) nullable  | container                                                 |
| `workflow_run_id`                | varchar(255) nullable  | GitHub Actions run                                        |
| `external_url`                   | varchar(1024) nullable | GitHub / Cloudflare / logging backend URL                 |
| `query_hint`                     | varchar(1024) nullable | logs API 默认查询词，如 job id / attempt id / thread      |
| `first_seen_at` / `last_seen_at` | datetime nullable      | 该日志位置首次 / 最近出现时间                             |
| `created_at` / `updated_at`      | datetime               | 时间戳                                                    |

约束：

- `unique(dedupe_key_hash)`。
- `index(publishing_job_id, source_type, updated_at)`。
- `index(job_stage_attempt_id, updated_at)`。
- 这张表只保存日志定位和查询 hint；日志全文仍通过 K8s logs API、GitHub Actions log 或外部日志系统按权限读取。

### `external_api_call_logs`

记录 Slack / GitHub / Cloudflare / model provider 等外部 API 调用摘要，服务排障和重试决策。

| 字段                           | 类型                  | 说明                                                             |
| ------------------------------ | --------------------- | ---------------------------------------------------------------- |
| `id`                           | varchar(64) pk        | `extcall_...`                                                    |
| `provider`                     | enum                  | `slack \| github_enterprise \| cloudflare \| model_provider`     |
| `operation`                    | varchar(128)          | API 语义操作，如 `chat.postMessage` / `create_pr`                |
| `method`                       | varchar(16) nullable  | HTTP method                                                      |
| `resource_type`                | varchar(128) nullable | 关联资源类型                                                     |
| `resource_id`                  | varchar(64) nullable  | 关联资源 ID                                                      |
| `publishing_job_id`            | varchar(64) nullable  | job                                                              |
| `agent_run_id`                 | varchar(64) nullable  | agent run                                                        |
| `job_stage_attempt_id`         | varchar(64) nullable  | attempt                                                          |
| `request_id`                   | varchar(255) nullable | 对方或本方 request id                                            |
| `dedupe_key`                   | varchar(512) nullable | 有幂等语义时填写，避免重复记录                                   |
| `dedupe_key_hash`              | char(64) nullable     | `dedupe_key` 的 SHA-256 hex；无幂等语义时为空                    |
| `dedupe_unique_key`            | varchar(80)           | 非空唯一键；有 dedupe key 时为 `dedupe:<hash>`，否则 `call:<id>` |
| `status_code`                  | int nullable          | HTTP status                                                      |
| `ok`                           | boolean               | 是否成功                                                         |
| `error_code` / `error_message` | varchar/text nullable | 可展示错误                                                       |
| `duration_ms`                  | int nullable          | 调用耗时                                                         |
| `request_hash`                 | varchar(255) nullable | 脱敏前 request hash                                              |
| `response_hash`                | varchar(255) nullable | 脱敏前 response hash                                             |
| `redacted_request_json`        | json nullable         | 脱敏 request 摘要                                                |
| `redacted_response_json`       | json nullable         | 脱敏 response 摘要                                               |
| `created_at`                   | datetime              | 时间                                                             |

约束：

- `unique(provider, dedupe_unique_key)`，避免依赖 nullable `dedupe_key_hash` 的 MySQL unique 语义。
- `index(publishing_job_id, provider, created_at)`。
- `index(agent_run_id, created_at)`。
- `index(job_stage_attempt_id, created_at)`。
- 不能保存 token、cookie、authorization header、prompt 原文或未脱敏 response 原文。

## V0 Migration Order

1. identity: `users`, `employees`, `external_identity_bindings`, `service_accounts`, `api_tokens`
2. policy/prompt: `policy_versions`, `prompt_versions`
3. site: `site_owner_scopes`, `site_projects`, `site_access_policies`, `site_admin_grants`
4. workflow: `publishing_jobs`, `job_stages`, `job_stage_attempts`, `agent_runs`
5. project index: `project_index_snapshots`, `project_index_items`
6. slack: `slack_events`, `slack_message_batches`, `slack_sessions`, `session_memories`, `issue_links`, `trusted_slack_bot_policies`
7. integrations: `integration_bindings`
8. site check: `site_check_runs`
9. github/review: `github_webhook_deliveries`, `review_runs`, `review_agent_comments`
10. deploy: `cloudflare_resource_pools`, `deploy_records`
11. event/audit/logs: `job_events`, `audit_logs`, `runtime_log_pointers`, `external_api_call_logs`

## Open Questions Before Implementation

- `User` 是否从公司 SSO 同步，还是 MVP 管理员手动导入。
- `Employee` 的 `slug` 来源：邮箱前缀、工号系统，还是管理员指定。
- 哪些 JSON 字段在排障高频查询后需要提升成普通列或 generated column。
- `deleted_at` 是否需要出现在所有业务表，MVP 可先只给 `site_projects`。
