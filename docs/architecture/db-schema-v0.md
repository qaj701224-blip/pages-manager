# DB Schema V0

## 定位

这是当前 `pages-manager` gateway 运行态数据库合同。代码以 `apps/gateway/src/db/schema.js` 和 `apps/gateway/drizzle/migrations/` 为准。

当前约定：

- MySQL 是最终状态真相源。
- Redis 只做 lease、queue、短期 dedupe 和 rate limit。
- Drizzle schema 是 DDL 来源。
- Gateway 不再提供文件 store、内存 store、SQLite 或 PVC snapshot runtime。
- `apps/gateway/src/db/gateway-store.js` 的 `Map` 只是单进程缓存，不是跨请求事实源。

## 当前 DB 代码结构

| 文件                                    | 职责                                                                                     |
| --------------------------------------- | ---------------------------------------------------------------------------------------- |
| `apps/gateway/src/db/schema.js`         | Drizzle schema                                                                           |
| `apps/gateway/src/db/config.js`         | 解析 `DATABASE_URL` 或 `MYSQL_ADDR` / `MYSQL_USER` / `MYSQL_PASSWORD` / `MYSQL_DATABASE` |
| `apps/gateway/src/db/client.js`         | 创建 MySQL pool                                                                          |
| `apps/gateway/src/db/redis.js`          | Redis / BullMQ 连接参数                                                                  |
| `apps/gateway/src/db/gateway-store.js`  | MySQL-backed runtime store                                                               |
| `apps/gateway/src/db/sql.js`            | SQL helper、JSON 序列化、upsert helper                                                   |
| `apps/gateway/src/db/rows/*.js`         | DB row 与业务对象互转                                                                    |
| `apps/gateway/src/db/repositories/*.js` | 每组表的 repository 方法                                                                 |
| `apps/gateway/drizzle/migrations/`      | committed migrations                                                                     |
| `apps/gateway/scripts/setup-db.js`      | 幂等建库 / migration                                                                     |
| `apps/gateway/scripts/migrate.js`       | 执行 Drizzle migration                                                                   |

## 产品数据模型

产品层统一使用 `work item` 表达“Slack 里正在推进的一件事”，但数据库不把所有业务强行塞进一张大表。当前模型是：

| Work item kind | 主表 | 业务语义 | 默认交付物 |
| -------------- | ---- | -------- | ---------- |
| `site_publishing` | `publishing_jobs` | 员工个人站点发布 / 修改 | staging preview |
| `platform_dev` | `platform_dev_items` | `pages-manager` 自身研发 issue / PR | issue / PR / merge 通知 |

共享表通过 `work_item_kind + work_item_id` 关联两条 lane。保留 `publishing_job_id` 字段是为了兼容现有 Site Publishing 代码，但新增能力不能继续只依赖 `publishing_job_id`。

当前实现状态：

- `publishing_jobs`、`job_events`、`slack_events`、`slack_sessions`、`session_memories`、`issue_links`、`agent_runs`、`agent_run_events`、`github_webhook_deliveries`、`review_agent_comments`、`site_check_runs`、`slack_job_status_messages`、`slack_notification_dedupes`、`audit_logs`、`external_api_call_logs` 已在 schema / migration 中存在。
- `platform_dev_items`、`platform_dev_events`、`work_item_links`、`work_item_gates`、`work_item_followups`、`slack_work_item_status_messages` 已作为 Platform Dev Lane 的运行表新增。
- `slack_events`、`slack_sessions`、`agent_runs`、`agent_run_events`、`slack_notification_dedupes` 和 `external_api_call_logs` 已具备 `work_item_kind + work_item_id` 或 Platform Dev 关联字段。
- 后续如果要统一 Site Publishing 与 Platform Dev 的 CI 明细，可以再新增 `ci_check_runs`；当前 Platform Dev CI / review 回写先落主表、事件和 Slack 进度消息。

目标原则：

- `publishing_jobs` 只表示 Site Publishing Lane。
- `platform_dev_items` 只表示 Platform Dev Lane。
- Slack session、Agent run、Slack 进度消息绑定、通知去重、外部 API 日志、audit log 都必须能绑定 `site_publishing` 或 `platform_dev`。
- GitHub issue / PR lookup 必须能从 `repo_full_name + issue_number / pr_number` 找到对应 work item。
- 高风险 gate、多轮补充、PR merge / close 回写必须落 MySQL，不能只靠 Redis、Slack message 或 GitHub UI。

## 当前表与后续完善项

### `platform_dev_items`

Platform Dev Lane 的主状态表。它服务 `pages-manager` 自身研发工作流，不等同于 Site Publishing Lane 的 `publishing_jobs`。

当前字段：

| 字段 | 类型 / 枚举 | 说明 |
| ---- | ----------- | ---- |
| `id` | `varchar(64)` | 主键，建议前缀 `pdev_` |
| `source` | `slack | api | admin | system` | 来源 |
| `requested_by_type` | `varchar(64)` | 发起人类型，当前 Slack 入口使用 `user` |
| `requested_by_id` | `varchar(255)` | 发起人稳定 id，例如 `slack:T:U` |
| `idempotency_key` | `varchar(255)` | Slack confirm / API 调用幂等键 |
| `title` | `varchar(255)` | GitHub issue / PR 标题来源 |
| `summary` | `text` | 需求摘要 |
| `issue_type` | `type:dev | type:bug | type:docs | type:feedback | type:question | type:ci | type:ops | type:security` | 产品分类 |
| `areas_json` | `json` | `area:*` 列表 |
| `risk` | `risk:low | risk:medium | risk:high` | 当前风险等级 |
| `agent_eligible` | `boolean` | 是否可进入自动开发候选 |
| `requires_human_gate` | `boolean` | 当前是否需要人工 gate |
| `status` | enum | 见下方状态机 |
| `requester_profile_json` | `json` | 发起人 profile 快照，脱敏保存 |
| `slack_thread_json` | `json` | team / channel / thread / requester 快照 |
| `slack_session_id` | `varchar(64)` | 首个来源 session |
| `slack_session_key` | `varchar(255)` | 来源 session key |
| `github_issue_number` | `int` | GitHub issue number |
| `github_issue_url` | `varchar(1024)` | GitHub issue URL |
| `github_pr_number` | `int` | PR number |
| `github_pr_url` | `varchar(1024)` | PR URL |
| `branch_name` | `varchar(255)` | Platform Agent 分支 |
| `base_ref` | `varchar(128)` | 默认 `master` |
| `head_sha` | `char(40)` | 当前 PR head SHA |
| `gate_status` | `not_required | pending | approved | rejected | expired` | 当前风险 gate 状态 |
| `gate_reason` | `text` | gate 原因或决策说明 |
| `error_code` | `varchar(128)` | 失败码 |
| `error_message` | `text` | 面向维护者的错误摘要，脱敏 |
| `created_at` | `datetime(3)` | 创建时间 |
| `updated_at` | `datetime(3)` | 更新时间 |

状态建议：

```text
received
triaging
issue_creating
issue_created
gate_pending
agent_queued
agent_running
branch_committed
pr_created
ci_running
ci_failed
review_waiting
review_blocked
ready_to_merge
merged
closed_unmerged
failed
cancelled
```

状态含义：

| 状态 | 用户可见含义 | 允许的下一步 |
| ---- | ------------ | ------------ |
| `received` | 已接收 Slack 确认 | `triaging` / `issue_creating` |
| `triaging` | 正在分类和整理 issue | `issue_creating` / `gate_pending` |
| `issue_creating` | 正在创建 GitHub issue | `issue_created` / `failed` |
| `issue_created` | issue 已创建 | `gate_pending` / `agent_queued` / `agent_running` |
| `gate_pending` | 等待风险确认 | `agent_queued` / `closed_unmerged` / `cancelled` |
| `agent_queued` | Coding Agent 已排队 | `agent_running` / `failed` |
| `agent_running` | 正在生成平台代码改动 | `branch_committed` / `pr_created` / `failed` |
| `branch_committed` | 分支已提交 | `pr_created` / `failed` |
| `pr_created` | PR 已创建 | `ci_running` / `review_waiting` / `review_blocked` / `ready_to_merge` |
| `ci_running` | CI 运行中 | `review_waiting` / `ci_failed` |
| `ci_failed` | CI 阻塞 | `agent_queued` / `agent_running` |
| `review_waiting` | 等待 review | `review_blocked` / `ready_for_review` |
| `review_blocked` | review 阻塞 | `agent_queued` / `agent_running` / `ci_running` |
| `ready_to_merge` | 技术上可合并，但仍需人类 merge | `merged` / `closed_unmerged` |
| `merged` | PR 已合并 | 终态 |
| `closed_unmerged` | issue / PR 已关闭未合并 | 终态 |
| `failed` | 自动化失败 | 可人工恢复到 `waiting_triage` 或 `agent_queued` |
| `cancelled` | 用户或维护者取消 | 终态 |

索引建议：

- `platform_dev_items_idempotency_uk`：`source + requested_by_type + requested_by_id + idempotency_key`
- `platform_dev_items_issue_uk`：`repo_full_name + github_issue_number`
- `platform_dev_items_pr_idx`：`repo_full_name + pr_number`
- `platform_dev_items_session_idx`：`slack_session_id + updated_at`
- `platform_dev_items_requester_idx`：`requested_by_type + requested_by_id + updated_at`
- `platform_dev_items_status_idx`：`status + updated_at`
- `platform_dev_items_type_risk_idx`：`issue_type + risk + updated_at`
- `platform_dev_items_parent_idx`：`parent_item_id + updated_at`
- `platform_dev_items_workflow_idx`：`workflow_run_id`

### `platform_dev_events`（计划新增）

Platform Dev Lane 的事件表。任何用户可见状态、GitHub webhook、Agent callback、gate 变化、Slack 回写失败都应该产生事件。

字段建议：

| 字段 | 说明 |
| ---- | ---- |
| `id` | 主键，建议前缀 `pdevent_` |
| `platform_dev_item_id` | 关联 `platform_dev_items.id` |
| `event_type` | `status_changed | issue_created | gate_requested | gate_approved | agent_started | pr_created | ci_updated | review_updated | merged | closed | slack_notified | failed` |
| `status` | 事件发生后的 item status |
| `actor_type` | `slack_user | github_user | agent | system | webhook` |
| `actor_id` | actor id，脱敏 |
| `agent_run_id` | 关联 Agent run |
| `github_delivery_id` | GitHub webhook delivery |
| `workflow_run_id` | Actions run id |
| `message` | 用户可理解摘要 |
| `metadata_json` | 脱敏 metadata |
| `dedupe_key` | 幂等键 |
| `created_at` | 创建时间 |

唯一键：

```text
platform_dev_item_id + dedupe_key
```

事件写入规则：

- 状态变更必须先更新主表，再写事件；失败时整体重试，不能只写事件不改状态。
- GitHub webhook 事件的 `dedupe_key` 使用 `repo + delivery_id + event + action`。
- executor callback 事件的 `dedupe_key` 使用 `platform_dev_item_id + stage + head_sha + attempt`。
- Slack 通知失败也写事件，但不能回滚主状态。

### `work_item_links`（计划新增）

替代当前 job-only 的 `issue_links`，用于把 Slack session、GitHub issue / PR、preview、branch 统一绑定到 work item。

字段建议：

```text
id
slack_session_id
work_item_kind              -- site_publishing | platform_dev
work_item_id
repo_full_name
github_issue_number
github_issue_url
pr_number
pr_url
branch_name
preview_url                 -- 只对 site_publishing 有值
head_sha
relationship                -- primary | mentioned | followup | duplicate
status                      -- active | closed | detached
created_at
updated_at
```

索引建议：

- `work_item_links_session_item_uk`：`slack_session_id + work_item_kind + work_item_id + relationship`
- `work_item_links_issue_idx`：`repo_full_name + github_issue_number`
- `work_item_links_pr_idx`：`repo_full_name + pr_number`
- `work_item_links_session_idx`：`slack_session_id + updated_at`
- `work_item_links_item_idx`：`work_item_kind + work_item_id + updated_at`

产品规则：

- Slack “继续 issue #123”通过 `repo_full_name + github_issue_number` 找到 link，再校验当前 Slack 用户是否有权限。
- Slack “我的任务”从 `work_item_links` 和两个主表 union 出站点发布任务与平台研发任务。
- `issue_links` 可以保留为 Site Publishing 的兼容表，但新代码应优先读写 `work_item_links`。

### `work_item_gates`

高风险确认不能只靠 Slack 按钮文本或 GitHub label。所有会影响自动开发、merge、production deploy、secret / 权限策略的确认都需要落库。

当前字段：

```text
id
work_item_kind              -- site_publishing | platform_dev
work_item_id
gate_type                   -- risk | ci_cd | ops | security | manual
status                      -- not_required | pending | approved | rejected | expired
reason
decided_by
decided_at
metadata_json
created_at
updated_at
```

索引建议：

- `work_item_gates_item_idx`：`work_item_kind + work_item_id + status + updated_at`
- `work_item_gates_pending_idx`：`status + gate_type + updated_at`
- `work_item_gates_source_idx`：`source + updated_at`

产品规则：

- `risk:high` 的 Platform Dev item 进入 Coding Agent 前必须存在 `gate_type=risk,status=approved`。
- `.github/**`、`k8s/**`、Dockerfile、部署脚本、secret、production deploy 相关改动至少需要 `gate_type=risk`；如果 PR 已经产生，还需要 GitHub required review。
- Slack 进度消息展示最近一个 pending gate 和操作人，不展示 secret 或内部 token。

### `work_item_followups`（计划新增）

同一 Slack thread 在 Agent running 时会继续收到补充。补充不能只放 Redis 队列，否则服务重启后会丢失用户意图。

字段建议：

```text
id
work_item_kind
work_item_id
slack_session_id
team_id
channel_id
thread_ts
message_ts
slack_user_id
text_redacted
summary
status                      -- queued | applied | superseded | rejected | failed
target_round_no
dedupe_key
created_at
updated_at
applied_at
```

索引建议：

- `work_item_followups_item_status_idx`：`work_item_kind + work_item_id + status + created_at`
- `work_item_followups_slack_uk`：`team_id + channel_id + message_ts`

产品规则：

- 当 item 处于 `agent_running` / `fixing` 时，新消息写 `queued`。
- 当前 round 结束后，worker 按创建时间合并 queued followups，追加 GitHub issue comment，再触发下一轮 fix。
- 用户删除或撤回 Slack 消息不自动删除 followup；只能写一条 `superseded` 或 `cancelled` 事件，保留审计。

### `publishing_jobs`

发布任务主表。保存 Slack / API 来源、目标站点、状态、issue、PR、preview 和 requester profile。

`publishing_jobs` 仍然表示 Site Publishing Lane。不要把 Platform Dev Lane 的平台代码 PR 强行塞成“发布任务”，否则会把站点 preview、allowed path、production deploy 等语义错误套到平台开发 issue 上。

关键索引：

- `publishing_jobs_idempotency_uk`
- `publishing_jobs_status_updated_idx`
- `publishing_jobs_target_idx`
- `publishing_jobs_slack_session_idx`
- `publishing_jobs_issue_idx`
- `publishing_jobs_pr_idx`

### `job_events`

发布任务状态事件。用于 job detail、Slack 状态和排障。

关键索引：

- `job_events_job_created_idx`
- `job_events_status_created_idx`

### `slack_events`

Slack Events / Interactivity 幂等表。记录 event、处理状态、结果类型、忽略原因、payload hash 和关联 job/session。

当前已支持 work item 关联字段：

```text
work_item_kind
work_item_id
platform_dev_item_id        -- 兼容查询，可选；有 work_item 字段后不再作为主关联
```

`result_type` 已扩展：

```text
platform_issue_created
platform_issue_updated
platform_followup_appended
platform_status_returned
gate_requested
gate_resolved
```

关键索引：

- `slack_events_team_event_uk`
- `slack_events_processing_idx`
- `slack_events_result_idx`
- `slack_events_session_idx`
- `slack_events_job_idx`
- `slack_events_work_item_idx`：`work_item_kind + work_item_id + created_at`

### `slack_sessions`

Slack 会话表。隔离键是：

```text
team_id + primary_slack_user_id + session_key
```

保存当前 active job、issue、PR、preview、thread / DM surface 和 active context 过期时间。

当前已支持：

```text
active_work_item_kind       -- site_publishing | platform_dev
active_work_item_id
active_platform_dev_item_id -- 兼容查询，可选
```

保留 `active_job_id`，但它只代表 Site Publishing Lane。`active_issue_number` / `active_pr_number` 只是 UI 快捷信息，不能当作权限事实。

关键索引：

- `slack_sessions_scope_uk`
- `slack_sessions_user_active_idx`
- `slack_sessions_active_job_idx`
- `slack_sessions_active_work_item_idx`：`active_work_item_kind + active_work_item_id`

### `session_memories`

Slack Agent 会话记忆。当前保存 summary、requirements、pending questions、preferences、last preview feedback 和 last agent response。

后续可以把记忆进一步拆成 lane-aware 结构：

```text
requirements_json           -- 通用需求摘要
platform_context_json       -- Platform Dev 的 issue type / area / risk / open questions
site_context_json           -- Site Publishing 的 employee/site/preview feedback
last_work_item_kind
last_work_item_id
```

`last_preview_feedback` 只服务 Site Publishing，不应复用于 Platform Dev。

关键索引：

- `session_memories_session_uk`

### `issue_links`

Slack session 与 PublishingJob / issue / PR / preview 的关联。支持一个 job 被多个 Slack session 显式关联。

这是 Site Publishing 兼容表。目标态新功能应写 `work_item_links`；`issue_links` 在迁移期继续由 `publishing_jobs` 代码使用。读路径可以按顺序查询：

```text
work_item_links
issue_links                  -- fallback for existing Site Publishing jobs
```

关键索引：

- `issue_links_session_job_uk`
- `issue_links_job_idx`
- `issue_links_session_idx`
- `issue_links_issue_idx`
- `issue_links_pr_idx`

### `agent_runs`

Slack Agent / 后续 Coding Agent 的单轮运行记录。当前用于记录 provider、model、prompt / policy version、输入输出 hash、lease、timeout 和错误。

当前已支持：

```text
work_item_kind
work_item_id
platform_dev_item_id        -- 可选兼容查询
lane                        -- site_publishing | platform_dev | support
run_purpose                 -- analyze | create_issue | code | fix | summarize_feedback | gate_check
```

规则：

- Slack Agent run 可以只有 `slack_session_id`，没有 work item。
- Site Publishing Coding Agent run 必须有 `work_item_kind=site_publishing,work_item_id=publishing_jobs.id`。
- Platform Dev Coding Agent run 必须有 `work_item_kind=platform_dev,work_item_id=platform_dev_items.id`。
- 同一 Platform Dev item 同时只能有一个 `agent_kind=platform_coding_agent,status=running`。

关键索引：

- `agent_runs_job_idx`
- `agent_runs_session_idx`
- `agent_runs_lease_idx`
- `agent_runs_work_item_idx`：`work_item_kind + work_item_id + created_at`
- `agent_runs_platform_active_idx`：`agent_kind + status + work_item_kind + work_item_id`

### `agent_run_events`

Agent 对用户或系统可见的事件。当前用于 Slack Agent / job progress 记录。

当前已支持：

```text
work_item_kind
work_item_id
platform_dev_item_id
visibility                  -- user | maintainer | internal
```

Platform Dev 的用户可见进度应该进入 `platform_dev_events` 或 `agent_run_events`，但 Slack 进度消息以主状态表和 `platform_dev_events` 为准。`agent_run_events` 主要记录 Agent 内部阶段、摘要、错误和准流式输出。

关键索引：

- `agent_run_events_dedupe_uk`
- `agent_run_events_job_idx`
- `agent_run_events_run_idx`
- `agent_run_events_work_item_idx`：`work_item_kind + work_item_id + created_at`

### `github_webhook_deliveries`

GitHub webhook delivery 幂等表。

唯一键：

```text
repo_full_name + delivery_id
```

### `review_agent_comments`

GitHub Review Agent comment / review / summary 的归一化记录。

唯一键：

```text
repo_full_name + github_comment_node_id
```

用于 Review gate 判断 `blocking | suggestion | note | unknown`。

目标态需要新增：

```text
work_item_kind
work_item_id
platform_dev_item_id
lane
```

归属规则：

- 先用 `repo_full_name + pr_number` 查 `work_item_links`。
- 查不到时 fallback 到 `publishing_jobs.pr_number`。
- Platform Dev PR 的 review comment 不参与 site preview gate，但会影响 `review_status` 和 `ready_to_merge`。

### `site_check_runs`

GitHub `check_run` / site-check 结果。

唯一键：

```text
repo_full_name + check_run_node_id
```

Preview gate 会按 PR number + head SHA 查询当前有效 check。

`site_check_runs` 只服务 Site Publishing Lane。Platform Dev Lane 的 CI 汇总建议新增独立表或复用通用 `ci_check_runs`：

```text
ci_check_runs
  id
  work_item_kind
  work_item_id
  repo_full_name
  pr_number
  check_run_id
  check_run_node_id
  check_name
  status
  conclusion
  head_sha
  details_url
  output_summary
  created_at
  updated_at
```

企业级目标应新增 `ci_check_runs`，让 Platform Dev 与 Site Publishing 都能用统一 check 归一化能力。只把 CI 汇总写入 `platform_dev_items.ci_status` 和 `platform_dev_events.metadata_json` 只能作为临时过渡，不能作为上线后的完整合同。

### `slack_job_status_messages`

Slack 进度消息绑定表。当前按 `job_id + scope_key` 绑定 Slack `channel + thread_ts + message_ts`。

`scope_key=session:<slack_session_id>` 表示该卡片属于某个 Slack 会话 / thread。

当前已新增 `slack_work_item_status_messages`，用于 Platform Dev 进度消息；Site Publishing 兼容保留 `slack_job_status_messages`：

```text
id
work_item_kind              -- site_publishing | platform_dev
work_item_id
slack_session_id
scope_key                   -- session:<id> | item | thread:<channel>:<thread_ts>
channel
thread_ts
message_ts
stage
status
last_render_hash
created_at
updated_at
```

索引：

- `slack_work_item_status_messages_item_scope_uk`：`work_item_kind + work_item_id + scope_key`
- `slack_work_item_status_messages_session_idx`：`slack_session_id + updated_at`
- `slack_work_item_status_messages_channel_idx`：`channel + message_ts`

迁移期保留 `slack_job_status_messages`；Site Publishing 可以后续由 repository adapter 同步到新表。

### `slack_notification_dedupes`

Slack 通知去重表。

唯一键：

```text
job_id + dedupe_key
```

当前已扩展 `slack_notification_dedupes` 的 work item 字段：

```text
id
work_item_kind
work_item_id
job_id                      -- 兼容字段，仅 site_publishing
dedupe_key
created_at
```

唯一键：

```text
work_item_kind + work_item_id + dedupe_key
```

通知去重不能只按 Slack message ts，因为同一个 GitHub webhook 可能需要更新进度消息和追加一条 thread 消息。

### `audit_logs`

审计日志。记录 actor、action、target、request id 和脱敏 metadata。

Platform Dev 必须至少记录：

- `platform_issue.confirmed`
- `platform_issue.created`
- `platform_gate.requested`
- `platform_gate.approved`
- `platform_gate.rejected`
- `platform_agent.dispatched`
- `platform_pr.created`
- `platform_pr.merged`
- `platform_pr.closed`
- `platform_item.cancelled`

### `external_api_call_logs`

外部 API 调用摘要日志。用于记录 Slack、GitHub、Cloudflare、模型网关等调用的脱敏 request / response summary、耗时和错误。

目标态需要新增：

```text
work_item_kind
work_item_id
platform_dev_item_id
```

所有 GitHub issue/PR、Slack Web API、Agent Gateway、Actions dispatch 调用都应该写摘要日志。日志不能保存 secret、完整 prompt、完整 diff 或用户敏感原文。

## Repository 拆分

当前 `MySqlGatewayStore` 通过 `bindMysqlRepositoryMethods` 组合 repository：

| Repository               | 表                                                        |
| ------------------------ | --------------------------------------------------------- |
| `platform-dev.js` | `platform_dev_items`、`platform_dev_events`、`work_item_links`、`work_item_gates` |
| `publishing-jobs.js`     | `publishing_jobs`、`job_events`                           |
| `slack-deliveries.js`    | `slack_events`                                            |
| `slack-sessions.js`      | `slack_sessions`、`session_memories`、`issue_links`       |
| `slack-notifications.js` | `slack_job_status_messages`、`slack_notification_dedupes` |
| `github-deliveries.js`   | `github_webhook_deliveries`                               |
| `review-gates.js`        | `review_agent_comments`、`site_check_runs`                |
| `agent-runs.js`          | `agent_runs`、`agent_run_events`                          |

### Repository API

`platform-dev.js` 当前提供：

```text
createPlatformDevItem(input)
getPlatformDevItem(itemId)
findPlatformDevItemByIssueNumber(issueNumber)
findPlatformDevItemByPrNumber(prNumber, options)
listPlatformDevItems(options)
patchPlatformDevItem(itemId, patch)
updatePlatformDevItem(itemId, status, patch)
failPlatformDevItem(itemId, errorCode, errorMessage)
insertPlatformDevEvents(events)
listPlatformDevEvents(itemId)
linkWorkItemToSlackSession(workItem, session, linkPatch)
linkPlatformDevItemToSlackSession(item, session)
findWorkItemLinkByIssueNumber(issueNumber)
findWorkItemLinkByPrNumber(prNumber)
listWorkItemLinksForSlackSession(slackSessionId)
listWorkItemsForSlackUser(teamId, slackUserId, options)
ensureWorkItemGate(input)
getWorkItemGate(workItemKind, workItemId, gateType)
decideWorkItemGate(workItemKind, workItemId, gateType, decision)
```

共享 repository 的改造原则：

- 新增 `recordSlackWorkItemStatusMessage`，旧 `recordSlackJobStatusMessage` 只做 Site Publishing wrapper。
- 新增 `hasSlackWorkItemNotification` / `recordSlackWorkItemNotification`，旧 job 版本调用新版本。
- `createAgentRun` 接受 `workItemKind/workItemId/lane/runPurpose`。
- `recordAgentRunEvent` 接受 `workItemKind/workItemId/visibility`。
- `recordSlackDelivery` 接受 `workItemKind/workItemId`。

## 关键查询路径

### Slack “我的任务”

产品返回必须按 lane 分组：

```text
active:
  Platform Dev: issue_created, waiting_human_gate, agent_queued, agent_running, pr_created, ci_failed, review_blocked, ready_for_review, ready_to_merge
  Site Publishing: received ... preview_deployed

closed:
  Platform Dev: merged, closed_unmerged, cancelled, failed
  Site Publishing: approved, merged, deployed, cancelled, failed
```

查询策略：

1. 按 Slack user 查 `slack_sessions`。
2. 用 session id 查 `work_item_links`。
3. 分别批量读取 `platform_dev_items` 和 `publishing_jobs`。
4. 过滤权限和状态，按 `updated_at` 倒序返回。

不要只查 `publishing_jobs.requested_by_id`，否则 Platform Dev 和多人协作 thread 会漏任务。

### GitHub webhook 归属

Issue / PR / check webhook 的归属顺序：

1. `work_item_links(repo_full_name, issue_number/pr_number)`。
2. `platform_dev_items(repo_full_name, github_issue_number/pr_number)`。
3. `publishing_jobs(issue_number/pr_number)` 兼容 fallback。
4. 找不到则只记录 delivery，不推进状态。

### Slack thread 续接

自然语言补充的归属顺序：

1. 当前 `slack_sessions.active_work_item_kind + active_work_item_id`。
2. 同一 thread 最近 active `work_item_links`。
3. 明确提到的 issue / PR number。
4. 无法定位时进入 Slack Agent 澄清，不创建新 item。

### 高风险 gate

进入 Platform Dev Coding Agent 前：

```text
if risk=high or requires_human_gate=true:
  require work_item_gates(kind=platform_dev,item_id,gate_type=risk,status=approved)
```

进入 ready-to-merge 前：

```text
require CI success
require review_status != blocked
require no pending high-risk gate
require human merge outside Slack automation
```

Slack 只能记录 gate approval 或请求人工处理，不能执行 merge。

## Migration 落地状态

### Phase A：DB 合同

- 已新增 `platform_dev_items`、`platform_dev_events`。
- 已新增 `work_item_links`、`work_item_gates`、`work_item_followups`。
- 已给共享表新增 nullable `work_item_kind`、`work_item_id`：
  - `slack_events`
  - `agent_runs`
  - `agent_run_events`
  - `external_api_call_logs`
- 已新增 `slack_work_item_status_messages`。
- 已扩展 `slack_notification_dedupes` 的 work item 唯一键。

这一步不删除任何旧字段，不影响现有 Site Publishing。

### Phase B：写双轨状态

- Platform Dev 创建后写 `work_item_links(kind=platform_dev)`。
- Platform Dev 进度消息绑定写 `slack_work_item_status_messages`。
- Slack notification dedupe 已有 work item 版本，旧 job API 继续可读。
- Agent run / Agent run event / Slack delivery 已支持 `work_item_kind/work_item_id`。
- Site Publishing 仍保留 `issue_links` 和 `slack_job_status_messages` 兼容路径；后续可以继续统一到 work item 表。

### Phase C：Platform Dev 闭环

- Slack confirm platform issue 写 `platform_dev_items`。
- worker 创建 GitHub issue 后写 `work_item_links(kind=platform_dev)`。
- `platform-agent.yml` callback 只使用 `platformDevItemId` 或 `workItemKind/workItemId`，不再伪造 `publishingJobId`。
- GitHub webhook 按新归属顺序推进 Platform Dev 状态。

### Phase D：读路径收敛

- “我的任务”、状态查询、followup、Slack buttons 全部走 work item API。
- 旧 `issue_links` 只作为历史 Site Publishing fallback。
- 新代码禁止把 Platform Dev item 写进 `publishing_jobs`。

### Phase E：清理旧依赖

等没有旧 Site Publishing runtime 直接依赖后，考虑：

- 将 `slack_job_status_messages` 只保留为 view / 兼容表。
- 将 job-only notification API 标记 deprecated。
- 将 Agent / Slack / external log 的 `publishing_job_id` 降级为兼容字段。

## 运行态配置

主约定：

```text
MYSQL_ADDR=<host>:3306
MYSQL_USER=<user>
MYSQL_PASSWORD=<secret>
MYSQL_DATABASE=<database>
REDIS_URL=redis://...
PAGES_STORE_BACKEND=mysql
PAGES_QUEUE_BACKEND=redis
```

`DATABASE_URL` 仍可被代码解析，但 ECS / K8s 主配置应使用拆分 MySQL 变量，方便对齐 Secret key。

## Migration 规则

- 使用 `pnpm db:generate` 生成 migration。
- 使用 `pnpm db:migrate` 执行 migration。
- 使用 `pnpm db:setup` 初始化空库。
- 不手写或修改历史 migration / `_journal.json`。
- schema 和 migration 变更应尽量独立，方便 review 和回滚。

## Redis 边界

Redis 只保存短期运行态：

| Key 形态                | 用途                            |
| ----------------------- | ------------------------------- |
| `slack:event:*`         | Slack event 短 TTL dedupe       |
| `github:delivery:*`     | GitHub webhook 短 TTL dedupe    |
| `slack-session-lease:*` | 同一 session 的 AgentRun lease  |
| `job-attempt-lease:*`   | 阶段 attempt lease              |
| `queue:*`               | worker / notifier / retry queue |

Redis 丢失时，gateway 必须能从 MySQL 恢复 job、session、issue/PR 关联、review、preview 和审计状态。

## xdclaw 参考

参考 xdclaw 的原则：

- gateway 无状态、多副本。
- MySQL 保存持久元数据。
- Redis 只做短期协调。
- migration 由 Drizzle 管理。

不复用：

- xdclaw 的业务 DB schema。
- xdclaw 的 Secret。
- xdclaw 的 namespace。
- OpenClawInstance / operator / instance-manager 模型。
