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

## 当前表

### `publishing_jobs`

发布任务主表。保存 Slack / API 来源、目标站点、状态、issue、PR、preview 和 requester profile。

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

关键索引：

- `slack_events_team_event_uk`
- `slack_events_processing_idx`
- `slack_events_result_idx`
- `slack_events_session_idx`
- `slack_events_job_idx`

### `slack_sessions`

Slack 会话表。隔离键是：

```text
team_id + primary_slack_user_id + session_key
```

保存当前 active job、issue、PR、preview、thread / DM surface 和 active context 过期时间。

关键索引：

- `slack_sessions_scope_uk`
- `slack_sessions_user_active_idx`
- `slack_sessions_active_job_idx`

### `session_memories`

Slack Agent 会话记忆。当前保存 summary、requirements、pending questions、preferences、last preview feedback 和 last agent response。

关键索引：

- `session_memories_session_uk`

### `issue_links`

Slack session 与 PublishingJob / issue / PR / preview 的关联。支持一个 job 被多个 Slack session 显式关联。

关键索引：

- `issue_links_session_job_uk`
- `issue_links_job_idx`
- `issue_links_session_idx`
- `issue_links_issue_idx`
- `issue_links_pr_idx`

### `agent_runs`

Slack Agent / 后续 Coding Agent 的单轮运行记录。当前用于记录 provider、model、prompt / policy version、输入输出 hash、lease、timeout 和错误。

关键索引：

- `agent_runs_job_idx`
- `agent_runs_session_idx`
- `agent_runs_lease_idx`

### `agent_run_events`

Agent 对用户或系统可见的事件。当前用于 Slack Agent / job progress 记录。

关键索引：

- `agent_run_events_dedupe_uk`
- `agent_run_events_job_idx`
- `agent_run_events_run_idx`

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

### `site_check_runs`

GitHub `check_run` / site-check 结果。

唯一键：

```text
repo_full_name + check_run_node_id
```

Preview gate 会按 PR number + head SHA 查询当前有效 check。

### `slack_job_status_messages`

Slack 主状态卡绑定表。当前按 `job_id + scope_key` 绑定 Slack `channel + thread_ts + message_ts`。

`scope_key=session:<slack_session_id>` 表示该卡片属于某个 Slack 会话 / thread。

### `slack_notification_dedupes`

Slack 通知去重表。

唯一键：

```text
job_id + dedupe_key
```

### `audit_logs`

审计日志。记录 actor、action、target、request id 和脱敏 metadata。

### `external_api_call_logs`

外部 API 调用摘要日志。用于记录 Slack、GitHub、Cloudflare、模型网关等调用的脱敏 request / response summary、耗时和错误。

## Repository 拆分

当前 `MySqlGatewayStore` 通过 `bindMysqlRepositoryMethods` 组合 repository：

| Repository               | 表                                                        |
| ------------------------ | --------------------------------------------------------- |
| `publishing-jobs.js`     | `publishing_jobs`、`job_events`                           |
| `slack-deliveries.js`    | `slack_events`                                            |
| `slack-sessions.js`      | `slack_sessions`、`session_memories`、`issue_links`       |
| `slack-notifications.js` | `slack_job_status_messages`、`slack_notification_dedupes` |
| `github-deliveries.js`   | `github_webhook_deliveries`                               |
| `review-gates.js`        | `review_agent_comments`、`site_check_runs`                |
| `agent-runs.js`          | `agent_runs`、`agent_run_events`                          |

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
