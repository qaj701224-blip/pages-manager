# DB Schema V0

## 定位

这是 `pages-manager` 员工多站点自动发布平台的 MVP 数据库合同。

目标不是一次性把所有字段设计到终局，而是先把不能靠 KV、GitHub issue、Slack thread 或 Cloudflare KV 替代的真相源落到 MySQL。

MVP 约定：

- DB 使用 MySQL 8.x。
- ORM 使用 Drizzle。
- 主键统一用字符串 ID，建议格式为 `<prefix>_<ksuid|ulid>`。
- 所有表必须有 `created_at`、`updated_at`。
- 需要软删除的业务对象使用 `deleted_at`。
- Secret 明文不入 DB，DB 只保存 `secret_ref` 或 hash。
- GitHub / Slack webhook 的幂等约束必须落 DB。

## ID Prefix

| 对象 | Prefix |
| --- | --- |
| User | `usr_` |
| Employee | `emp_` |
| ExternalIdentityBinding | `xid_` |
| ServiceAccount | `svc_` |
| ApiToken | `tok_` |
| PolicyVersion | `policy_` |
| PromptVersion | `prompt_` |
| SiteOwnerScope | `scope_` |
| SiteProject | `site_` |
| SiteAccessPolicy | `access_` |
| SiteAdminGrant | `grant_` |
| PublishingJob | `job_` |
| JobStage | `stage_` |
| JobStageAttempt | `attempt_` |
| AgentRun | `agent_` |
| ProjectIndexSnapshot | `idxsnap_` |
| ProjectIndexItem | `idxitem_` |
| SlackEvent | `sevt_` |
| SlackMessageBatch | `smb_` |
| SlackSession | `sess_` |
| SessionMemory | `mem_` |
| IssueLink | `issuelink_` |
| TrustedSlackBotPolicy | `tsbp_` |
| IntegrationBinding | `int_` |
| SiteCheckRun | `check_` |
| GitHubWebhookDelivery | `ghdeliv_` |
| ReviewRun | `review_` |
| ReviewAgentComment | `rac_` |
| DeployRecord | `deploy_` |
| CloudflareResourcePool | `cfpool_` |
| JobEvent | `event_` |
| AuditLog | `audit_` |

## Identity

### `users`

平台登录和操作人真相源。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `usr_...` |
| `email` | varchar(255) | 公司邮箱 |
| `name` | varchar(255) | 展示名 |
| `status` | enum | `active | disabled | deleted` |
| `is_platform_admin` | boolean | 平台管理员 |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(email)`。
- `status=disabled` 的用户不能创建新 job，但历史记录保留。

### `employees`

员工归属主体。不是网站，也不是登录态。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `emp_...` |
| `user_id` | varchar(64) nullable | 对应 user；离职后可为空或 disabled |
| `employee_no` | varchar(128) nullable | 工号 |
| `slug` | varchar(80) | URL / path 中使用 |
| `display_name` | varchar(255) | 展示名 |
| `status` | enum | `active | inactive | archived` |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(slug)`。
- `unique(employee_no)`，允许 nullable。

### `external_identity_bindings`

外部身份绑定。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `xid_...` |
| `provider` | enum | `slack | github_enterprise | sso` |
| `provider_team_or_org` | varchar(255) | Slack team id / GitHub org |
| `provider_user_id` | varchar(255) | Slack user id / GitHub user id |
| `provider_login` | varchar(255) nullable | GitHub login / Slack display |
| `user_id` | varchar(64) | 内部 user |
| `employee_id` | varchar(64) nullable | 可直接关联员工 |
| `status` | enum | `active | revoked` |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(provider, provider_team_or_org, provider_user_id)`。
- `index(user_id)`。
- `index(employee_id)`。

### `service_accounts`

CI、内部系统或受信 SlackBot 映射的调用主体。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `svc_...` |
| `name` | varchar(255) | 名称 |
| `status` | enum | `active | disabled` |
| `owner_user_id` | varchar(64) nullable | 负责维护的人 |
| `created_at` / `updated_at` | datetime | 时间戳 |

### `api_tokens`

Internal API token，只存 hash。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `tok_...` |
| `actor_type` | enum | `user | service_account` |
| `actor_id` | varchar(64) | user 或 service account |
| `token_hash` | varchar(255) | token hash |
| `scopes_json` | json | 权限范围 |
| `allowed_owner_scope_ids_json` | json nullable | 可操作 owner scope |
| `allowed_site_project_ids_json` | json nullable | 可操作站点 |
| `expires_at` | datetime nullable | 过期时间 |
| `last_used_at` | datetime nullable | 最近使用 |
| `status` | enum | `active | revoked` |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(token_hash)`。
- API 返回 token 时只能返回一次明文，之后不可再读明文。

## Policies And Prompts

### `policy_versions`

公司规则、权限规则、secret 处理规则和站点隔离规则的版本快照。表里不保存 token 明文，只保存规则内容 hash 和来源引用。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `policy_...` |
| `policy_key` | varchar(128) | 例如 `company-publishing-policy` |
| `version` | varchar(64) | 语义版本或 commit-based 版本 |
| `content_hash` | varchar(255) | 规则内容 hash |
| `source_ref` | varchar(512) | repo path + commit SHA 或 artifact ref |
| `status` | enum | `draft | active | retired` |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(policy_key, version)`。
- `unique(policy_key, content_hash)`。

### `prompt_versions`

Slack Agent / Coding Agent 的 prompt 模板版本快照。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `prompt_...` |
| `agent_kind` | enum | `slack_agent | coding_agent` |
| `prompt_key` | varchar(128) | 例如 `slack-agent-system` |
| `version` | varchar(64) | 语义版本或 commit-based 版本 |
| `content_hash` | varchar(255) | prompt 内容 hash |
| `source_ref` | varchar(512) | repo path + commit SHA 或 artifact ref |
| `status` | enum | `draft | active | retired` |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(agent_kind, prompt_key, version)`。
- `unique(agent_kind, prompt_key, content_hash)`。

## Site Ownership

### `site_owner_scopes`

站点归属域。MVP 主要是个人员工域，后续可扩展 team。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `scope_...` |
| `kind` | enum | `personal | team` |
| `employee_id` | varchar(64) nullable | personal scope 对应员工 |
| `team_key` | varchar(128) nullable | 后续 team scope |
| `slug` | varchar(80) | path 中的 owner slug |
| `display_name` | varchar(255) | 展示名 |
| `max_sites` | int | 配额，默认可较大但不能无限无约束 |
| `status` | enum | `active | archived` |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(slug)`。
- `unique(kind, employee_id)`，personal scope 适用。

### `site_projects`

一个员工名下的一个具体网站。员工可以有多个。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `site_...` |
| `owner_scope_id` | varchar(64) | 归属域 |
| `employee_id` | varchar(64) nullable | 冗余方便查询，personal scope 下必填 |
| `site_slug` | varchar(80) | owner scope 内唯一 |
| `site_name` | varchar(128) | Cloudflare hostname 前缀 |
| `title` | varchar(255) | 展示标题 |
| `repo_full_name` | varchar(255) | GitHub Enterprise repo |
| `repo_path` | varchar(512) | `sites/<employee>/<site>` |
| `production_hostname` | varchar(255) | 生产域名 |
| `preview_hostname_pattern` | varchar(255) | preview 域名模式 |
| `current_deploy_id` | varchar(64) nullable | 当前生产部署 |
| `resource_pool_id` | varchar(64) | Cloudflare resource pool |
| `default_access_mode` | enum | `public | company | allowlist` |
| `status` | enum | `active | archived | deleted` |
| `created_at` / `updated_at` / `deleted_at` | datetime | 时间戳 |

约束：

- `unique(owner_scope_id, site_slug)`。
- `unique(site_name)`。
- `unique(production_hostname)`。
- `unique(repo_full_name, repo_path)`。
- `index(employee_id)`。

### `site_access_policies`

控制已发布网站内容访问，不控制管理界面。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `access_...` |
| `site_project_id` | varchar(64) | 站点 |
| `environment` | enum | `preview | production` |
| `mode` | enum | `public | company | allowlist` |
| `allowlist_json` | json nullable | 用户、邮箱、群组、IP/CIDR |
| `version` | int | 策略版本 |
| `status` | enum | `active | disabled` |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(site_project_id, environment, status)` 对 active 记录应只有一条，可用应用层或 partial-like 约束模拟。

### `site_admin_grants`

控制谁能管理站点。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `grant_...` |
| `site_project_id` | varchar(64) | 站点 |
| `actor_type` | enum | `user | employee | service_account` |
| `actor_id` | varchar(64) | 被授权主体 |
| `role` | enum | `owner | admin | maintainer | viewer` |
| `granted_by_user_id` | varchar(64) nullable | 授权人 |
| `status` | enum | `active | revoked` |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(site_project_id, actor_type, actor_id)`。
- `index(actor_type, actor_id)`。

## Publishing Workflow

### `publishing_jobs`

一次发布请求的总状态。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `job_...` |
| `source` | enum | `slack | api | admin | system` |
| `idempotency_key` | varchar(255) | 来源幂等 key |
| `requested_by_type` | enum | `user | employee | service_account` |
| `requested_by_id` | varchar(64) | 发起者 |
| `site_project_id` | varchar(64) nullable | 目标站点，创建前可为空 |
| `owner_scope_id` | varchar(64) | 归属域 |
| `employee_id` | varchar(64) nullable | personal scope 下使用 |
| `employee_slug` | varchar(80) | 冗余快照 |
| `site_slug` | varchar(80) | 冗余快照 |
| `intent` | enum | `create_site | update_site | delete_site | rollback_site` |
| `approval_mode` | enum | `draft | manual_required | trusted_auto` |
| `status` | enum | 见状态机 |
| `title` | varchar(255) | 需求标题 |
| `summary` | text | 结构化摘要 |
| `error_code` | varchar(128) nullable | 失败码 |
| `error_message` | text nullable | 可展示错误 |
| `issue_number` | int nullable | GitHub issue |
| `pr_number` | int nullable | GitHub PR |
| `branch_name` | varchar(255) nullable | 受控分支 |
| `index_snapshot_id` | varchar(64) nullable | 本次 job 固定使用的项目索引快照 |
| `preview_url` | varchar(1024) nullable | preview |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(source, requested_by_type, requested_by_id, idempotency_key)`。
- `index(site_project_id, created_at)`。
- `index(status, updated_at)`。

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

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `stage_...` |
| `publishing_job_id` | varchar(64) | job |
| `stage_type` | enum | `summarize | issue | project_index | agent | precheck | commit_pr | review_monitor | fix | preview_deploy | merge | deploy | notify` |
| `status` | enum | `pending | running | succeeded | failed | skipped | cancelled` |
| `current_attempt_id` | varchar(64) nullable | 当前有效 attempt |
| `started_at` / `finished_at` | datetime nullable | 时间 |
| `error_code` / `error_message` | varchar/text nullable | 错误 |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(publishing_job_id, stage_type)`。
- `index(status, updated_at)`。

### `job_stage_attempts`

一次阶段执行尝试。所有 retry 必须新建 attempt。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `attempt_...` |
| `job_stage_id` | varchar(64) | stage |
| `publishing_job_id` | varchar(64) | 冗余 |
| `attempt_no` | int | 从 1 开始 |
| `executor_type` | enum | `gateway_local | worker | github_actions | k8s_job` |
| `executor_ref` | varchar(255) nullable | workflow run id / k8s job name |
| `callback_nonce_hash` | varchar(255) | callback nonce hash |
| `status` | enum | `pending | running | succeeded | failed | expired | ignored` |
| `input_json` | json nullable | 输入快照 |
| `output_json` | json nullable | 输出快照 |
| `started_at` / `finished_at` | datetime nullable | 时间 |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(job_stage_id, attempt_no)`。
- `unique(executor_type, executor_ref)`，允许 nullable 例外。
- gateway 只接受 `job_stages.current_attempt_id` 对应 attempt 的 callback。

### `agent_runs`

Agent 执行记录。Slack Agent 的 intent / summary、Coding Agent 的 initial / fix 都需要落这里，方便追踪使用了哪个 prompt / policy、读取了哪些输入、产出了什么结果。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `agent_...` |
| `agent_kind` | enum | `slack_agent | coding_agent` |
| `publishing_job_id` | varchar(64) nullable | job；Slack Agent 在创建 job 前可为空 |
| `slack_session_id` | varchar(64) nullable | Slack Agent 会话 |
| `job_stage_attempt_id` | varchar(64) nullable | attempt；Coding Agent 必填 |
| `index_snapshot_id` | varchar(64) nullable | 本轮 agent 使用的项目索引快照 |
| `run_type` | enum | `slack_intent | slack_summary | initial | fix` |
| `round_no` | int | Slack Agent 可按 session 递增；Coding initial 为 0，fix 从 1 开始 |
| `provider` | varchar(128) nullable | 模型供应商或 adapter，例如 `company-agent | deterministic` |
| `model` | varchar(255) nullable | 实际请求的模型名 |
| `model_api_style` | varchar(128) nullable | `company-openai-compatible | deterministic` |
| `prompt_version_id` | varchar(64) nullable | prompt 版本 |
| `prompt_version` | varchar(64) | 冗余快照 |
| `prompt_hash` | varchar(255) | prompt 内容 hash |
| `policy_version_id` | varchar(64) nullable | policy bundle 版本 |
| `policy_version` | varchar(64) | 冗余快照 |
| `policy_hash` | varchar(255) | policy bundle hash |
| `input_summary_hash` | varchar(255) | 输入摘要 hash，不能保存 secret 明文 |
| `output_hash` | varchar(255) nullable | 结构化输出 hash |
| `output_patch_hash` | varchar(255) nullable | Coding Agent patch hash |
| `allowed_path` | varchar(512) nullable | Coding Agent 可写路径快照 |
| `base_sha` | varchar(64) nullable | 输入基线 |
| `head_sha` | varchar(64) nullable | 输出 commit |
| `branch_name` | varchar(255) nullable | PR branch |
| `lease_expires_at` | datetime nullable | Slack Agent session lease 或 executor lease 到期时间 |
| `started_at` / `completed_at` | datetime nullable | 运行开始 / 结束时间 |
| `status` | enum | `pending | running | completed | patch_generated | committed | failed | timed_out | cancelled` |
| `review_agent_comment_ids_json` | json nullable | fix 输入 |
| `report_json` | json nullable | agent 报告 |
| `created_at` / `updated_at` | datetime | 时间戳 |

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

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `idxsnap_...` |
| `repo_full_name` | varchar(255) | GitHub Enterprise repo |
| `base_sha` | varchar(64) | 索引对应的 commit SHA |
| `index_type` | enum | `full | site | template | job_context` |
| `scope_path` | varchar(512) nullable | 例如 `sites/zhangsan/profile` |
| `artifact_ref` | varchar(1024) nullable | 大索引文件、context bundle 或 artifact 地址 |
| `manifest_hash` | varchar(255) | manifest hash |
| `status` | enum | `pending | indexing | ready | failed` |
| `error_code` / `error_message` | varchar/text nullable | 错误 |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(repo_full_name, base_sha, index_type, scope_path)`。
- `index(status, updated_at)`。

### `project_index_items`

索引快照里的条目。MVP 可以先保存 manifest 和 metadata，不强制引入向量数据库。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `idxitem_...` |
| `snapshot_id` | varchar(64) | `ProjectIndexSnapshot` |
| `path` | varchar(1024) | repo path 或逻辑路径 |
| `item_type` | enum | `site_config | site_source | template | schema | issue | pr | review_comment | build_report` |
| `content_hash` | varchar(255) | 内容 hash |
| `metadata_json` | json nullable | 摘要、语言、大小、引用关系等 |
| `artifact_ref` | varchar(1024) nullable | 大内容引用 |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(snapshot_id, path, item_type, content_hash)`。
- `index(snapshot_id, item_type)`。

## Slack

### `slack_events`

Slack event / command / interaction 幂等入口。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `sevt_...` |
| `team_id` | varchar(64) | Slack workspace |
| `dedupe_key` | varchar(255) | 非空幂等 key |
| `event_id` | varchar(255) nullable | event callback |
| `trigger_id` | varchar(255) nullable | command/interaction |
| `channel_id` | varchar(64) nullable | channel |
| `thread_ts` | varchar(64) nullable | thread |
| `event_ts` | varchar(64) nullable | event ts |
| `source_type` | enum | `user | bot | system` |
| `slack_user_id` | varchar(64) nullable | 真人 |
| `bot_user_id` | varchar(64) nullable | bot |
| `publishing_job_id` | varchar(64) nullable | 关联 job |
| `status` | enum | `received | summarized | job_created | ignored | failed` |
| `retry_num` | int nullable | Slack retry header |
| `retry_reason` | varchar(255) nullable | Slack retry reason |
| `payload_json` | json | 原始 payload 快照 |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(team_id, dedupe_key)`。
- `index(publishing_job_id)`。

### `slack_message_batches`

Slack thread 原文和摘要。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `smb_...` |
| `slack_event_id` | varchar(64) | 来源事件 |
| `team_id` / `channel_id` / `thread_ts` | varchar | Slack 定位 |
| `source_type` | enum | `user | bot | mixed` |
| `source_bot_user_id` | varchar(64) nullable | bot 来源 |
| `messages_json` | json | 原文快照 |
| `summary_json` | json | 结构化摘要 |
| `status` | enum | `pending | summarized | failed` |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `index(slack_event_id)`。
- `index(team_id, channel_id, thread_ts)`。

### `slack_sessions`

Slack Agent 的常驻会话状态。`apps/slack-agent` 服务本身长期运行在服务器/K8s 上；这张表保存 Slack 用户名下的多个持久 session、memory、权限上下文和 issue / PR / preview 关联。常驻不代表每个用户独占一个模型进程，模型供应商 API 由 `apps/slack-agent` 在每轮消息处理时按需调用。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `sess_...` |
| `team_id` | varchar(64) | Slack workspace |
| `primary_slack_user_id` | varchar(64) | Slack 发起人 |
| `session_key` | varchar(255) | 同一用户下的 session 定位，例如 `thread:C1:171...`、`dm:current`、`job:job_xxx` |
| `conversation_key` | varchar(255) | `team+primary_slack_user_id+session_key` |
| `session_title` | varchar(255) nullable | 便于用户选择的短标题 |
| `channel_id` | varchar(64) nullable | 最近一次消息所在 channel |
| `thread_ts` | varchar(64) nullable | 最近一次消息所在 thread |
| `dm_channel_id` | varchar(64) nullable | 最近一次 DM channel |
| `surface_context_json` | json nullable | 最近若干 Slack surface / thread / event 定位，不作为会话隔离键 |
| `primary_user_id` | varchar(64) nullable | 绑定后的内部 user |
| `owner_scope_id` | varchar(64) nullable | 当前会话归属域 |
| `active_publishing_job_id` | varchar(64) nullable | 当前 job |
| `active_issue_number` | int nullable | 当前 issue |
| `active_pr_number` | int nullable | 当前 PR |
| `active_preview_url` | varchar(1024) nullable | 最近 preview |
| `last_intent` | varchar(128) nullable | 最近识别意图 |
| `last_event_ts` | varchar(64) nullable | 最近 Slack event ts |
| `last_active_at` | datetime nullable | 最近有效用户消息时间 |
| `active_context_expires_at` | datetime nullable | active job / issue / preview 默认续接过期时间 |
| `waiting_clarification_expires_at` | datetime nullable | 等待澄清过期时间 |
| `closed_at` | datetime nullable | 用户主动关闭时间 |
| `archived_at` | datetime nullable | session 归档时间 |
| `status` | enum | `active | waiting_clarification | paused | expired | closed | archived` |
| `metadata_json` | json nullable | 非敏感扩展信息 |
| `created_at` / `updated_at` | datetime | 时间戳 |

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

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `mem_...` |
| `slack_session_id` | varchar(64) | session |
| `summary` | text nullable | 会话摘要 |
| `requirements_json` | json nullable | 结构化需求 |
| `pending_questions_json` | json nullable | 待澄清问题 |
| `preferences_json` | json nullable | 用户偏好 |
| `last_preview_feedback` | text nullable | 最近 preview 修改意见 |
| `last_agent_response` | text nullable | 最近 Agent 回复摘要 |
| `updated_by_agent_run_id` | varchar(64) nullable | 更新来源 |
| `version` | int | 从 1 开始递增 |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(slack_session_id)` 保存当前 memory。
- `index(updated_by_agent_run_id)`。
- memory 中不能保存 token、secret 或可复原的私密凭据。

### `issue_links`

Slack session、PublishingJob、GitHub issue / PR / preview 的关联表。用于用户在 Slack 里继续说“这个 preview 不满意，继续改”时续接同一个任务。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `issuelink_...` |
| `slack_session_id` | varchar(64) | session |
| `publishing_job_id` | varchar(64) | job |
| `repo_full_name` | varchar(255) | GitHub Enterprise repo |
| `issue_number` | int | GitHub issue |
| `pr_number` | int nullable | GitHub PR |
| `branch_name` | varchar(255) nullable | 受控 branch |
| `preview_url` | varchar(1024) nullable | 最近 preview |
| `head_sha` | varchar(64) nullable | 最近 PR head |
| `relationship` | enum | `primary | followup | superseded` |
| `status` | enum | `active | closed | superseded` |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(publishing_job_id)`。
- `index(slack_session_id, status)`。
- `index(repo_full_name, issue_number)`。
- 复用 issue / PR 前必须校验 actor 对 `owner_scope_id` / `site_project_id` 有管理权限。

### `trusted_slack_bot_policies`

控制另一个 SlackBot 消息能否触发任务。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `tsbp_...` |
| `team_id` | varchar(64) | Slack workspace |
| `bot_user_id` | varchar(64) | bot user |
| `app_id` | varchar(64) nullable | Slack app |
| `mode` | enum | `evidence_only | require_human_confirm | service_account` |
| `service_account_id` | varchar(64) nullable | service account |
| `allowed_channel_ids_json` | json nullable | channel allowlist |
| `allowed_owner_scope_ids_json` | json nullable | owner scope allowlist |
| `status` | enum | `active | disabled` |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(team_id, bot_user_id)`。

## Integrations

### `integration_bindings`

外部集成配置和 secret 引用。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `int_...` |
| `provider` | enum | `slack | github_enterprise | cloudflare | review_agent` |
| `scope_type` | enum | `platform | owner_scope | site_project` |
| `scope_id` | varchar(64) nullable | platform 可为空 |
| `config_json` | json | 非敏感配置 |
| `secret_ref` | varchar(255) nullable | secret 引用 |
| `status` | enum | `active | disabled` |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(provider, scope_type, scope_id)`。

## Site Check

### `site_check_runs`

`site-check` / `pages-site-policy` 的确定性检查记录。Preview gate 不能只看 workflow 结论字符串，必须绑定到同一个 PR head SHA 的持久化检查结果。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `check_...` |
| `publishing_job_id` | varchar(64) | job |
| `site_project_id` | varchar(64) nullable | 站点 |
| `repo_full_name` | varchar(255) | GitHub Enterprise repo |
| `pr_number` | int | PR |
| `head_sha` | varchar(64) | 被检查 commit |
| `base_sha` | varchar(64) nullable | PR base |
| `allowed_path` | varchar(512) | 单一站点目录 |
| `check_source` | enum | `pages_agent_precheck | pull_request_required | preview_gate` |
| `status` | enum | `pending | running | passed | failed | stale` |
| `pages_site_policy_status` | enum | `pending | passed | failed | skipped` |
| `path_allowlist_status` | enum | `pending | passed | failed` |
| `schema_status` | enum | `pending | passed | failed` |
| `secret_scan_status` | enum | `pending | passed | failed` |
| `file_policy_status` | enum | `pending | passed | failed` |
| `build_status` | enum | `pending | passed | failed | skipped` |
| `changed_files_json` | json | PR / patch 文件列表 |
| `report_artifact_ref` | varchar(1024) nullable | check report artifact |
| `error_code` / `error_message` | varchar/text nullable | 错误 |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(repo_full_name, pr_number, head_sha, check_source)`。
- `index(publishing_job_id, status)`。
- `index(site_project_id, updated_at)`。
- Preview gate 只接受 `check_source=pull_request_required` 且 `status=passed` 的当前 PR head SHA。
- `pages_site_policy_status=failed`、`path_allowlist_status=failed`、`secret_scan_status=failed` 都不能自动修复后直接放行，必须重新生成新的 `site_check_runs`。

## GitHub And Review

### `github_webhook_deliveries`

GitHub Enterprise webhook 幂等。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `ghdeliv_...` |
| `repo_full_name` | varchar(255) | repo |
| `delivery_id` | varchar(255) | GitHub delivery id |
| `event_name` | varchar(128) | event |
| `action` | varchar(128) nullable | action |
| `payload_hash` | varchar(255) | payload hash |
| `status` | enum | `received | processed | ignored | failed` |
| `processed_at` | datetime nullable | 处理时间 |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(repo_full_name, delivery_id)`。

### `review_runs`

一次 review 轮次。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `review_...` |
| `publishing_job_id` | varchar(64) | job |
| `repo_full_name` | varchar(255) | repo |
| `pr_number` | int | PR |
| `head_sha` | varchar(64) | 被 review 的 commit |
| `source` | enum | `deterministic | github_review_agent | human | mixed` |
| `status` | enum | `pending | passed | changes_requested | commented | failed` |
| `started_at` / `finished_at` | datetime nullable | 时间 |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(repo_full_name, pr_number, head_sha, source)`。

### `review_agent_comments`

GitHub Review Agent comment 归一化记录。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `rac_...` |
| `publishing_job_id` | varchar(64) | job |
| `review_run_id` | varchar(64) nullable | review run |
| `repo_full_name` | varchar(255) | repo |
| `pr_number` | int | PR |
| `github_review_id` | varchar(255) nullable | review id |
| `github_comment_id` | varchar(255) nullable | REST id |
| `github_comment_node_id` | varchar(255) | GraphQL node id 或稳定 fallback |
| `source_type` | enum | `review_summary | inline_comment | issue_comment | check_run` |
| `review_agent_login` | varchar(255) | bot login/app slug |
| `check_run_name` | varchar(255) nullable | check 名 |
| `path` | varchar(1024) nullable | 文件路径 |
| `line` | int nullable | 行号 |
| `diff_hunk` | text nullable | diff hunk |
| `body` | text | comment 内容 |
| `body_hash` | varchar(255) | body hash |
| `classification` | enum | `blocking | suggestion | note | unknown` |
| `status` | enum | `open | resolved | outdated | dismissed | deleted` |
| `first_seen_delivery_id` | varchar(255) | 首次 webhook |
| `last_seen_delivery_id` | varchar(255) | 最近 webhook |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(repo_full_name, github_comment_node_id)`。
- `index(publishing_job_id, classification, status)`。
- `unknown` 不能自动修复，也不能进入 `trusted_auto` 放行。

## Deploy

### `cloudflare_resource_pools`

平台级 Cloudflare 资源池。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `cfpool_...` |
| `environment` | enum | `preview | production` |
| `name` | varchar(128) | 资源池名 |
| `zone_name` | varchar(255) | zone |
| `edge_worker_name` | varchar(255) | 多租户 Edge Worker |
| `config_kv_namespace` | varchar(255) | 平台级 KV namespace |
| `assets_bucket` | varchar(255) nullable | R2/assets bucket |
| `route_pattern` | varchar(255) | route |
| `status` | enum | `active | disabled` |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(environment, name)`。
- 不为每站点默认创建 KV namespace。

### `deploy_records`

preview / production 部署记录。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `deploy_...` |
| `site_project_id` | varchar(64) | 站点 |
| `publishing_job_id` | varchar(64) | job |
| `environment` | enum | `preview | production` |
| `repo_full_name` | varchar(255) | repo |
| `pr_number` | int nullable | PR |
| `merge_commit_sha` | varchar(64) nullable | production 必填 |
| `head_sha` | varchar(64) nullable | preview 可用 |
| `github_delivery_id` | varchar(255) nullable | merge webhook |
| `resource_pool_id` | varchar(64) | resource pool |
| `deploy_id` | varchar(128) | external deploy id |
| `url` | varchar(1024) | 访问地址 |
| `manifest_key` | varchar(1024) nullable | manifest 路径 |
| `assets_prefix` | varchar(1024) nullable | assets 前缀 |
| `status` | enum | `pending | deploying | deployed | failed | rolled_back` |
| `error_code` / `error_message` | varchar/text nullable | 错误 |
| `created_at` / `updated_at` | datetime | 时间戳 |

约束：

- `unique(site_project_id, environment, merge_commit_sha)`，production 使用。
- `unique(site_project_id, environment, head_sha)`，preview 可用。
- production deploy 不能从 floating branch 构建。

## Events And Audit

### `job_events`

给控制台、Slack notifier 和排障使用。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `event_...` |
| `publishing_job_id` | varchar(64) | job |
| `stage_type` | varchar(128) nullable | 阶段 |
| `event_type` | varchar(128) | 事件类型 |
| `level` | enum | `info | warning | error` |
| `message` | text | 可展示消息 |
| `data_json` | json nullable | 结构化数据 |
| `created_at` | datetime | 时间 |

索引：

- `index(publishing_job_id, created_at)`。

### `audit_logs`

不可替代的审计记录。

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | varchar(64) pk | `audit_...` |
| `actor_type` | enum | `user | employee | service_account | system` |
| `actor_id` | varchar(64) nullable | actor |
| `action` | varchar(128) | 动作 |
| `resource_type` | varchar(128) | 资源类型 |
| `resource_id` | varchar(64) | 资源 ID |
| `request_id` | varchar(128) nullable | 请求 ID |
| `ip` | varchar(64) nullable | 来源 IP |
| `user_agent` | varchar(512) nullable | UA |
| `data_json` | json nullable | 审计数据 |
| `created_at` | datetime | 时间 |

索引：

- `index(resource_type, resource_id, created_at)`。
- `index(actor_type, actor_id, created_at)`。

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
11. event/audit: `job_events`, `audit_logs`

## Open Questions Before Implementation

- `User` 是否从公司 SSO 同步，还是 MVP 管理员手动导入。
- `Employee` 的 `slug` 来源：邮箱前缀、工号系统，还是管理员指定。
- MySQL 是否使用 `json` 字段，还是 JSON 文本加应用层校验。
- `deleted_at` 是否需要出现在所有业务表，MVP 可先只给 `site_projects`。
