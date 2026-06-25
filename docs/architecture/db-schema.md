# DB Schema

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

## 表结构详表

表级字段、索引和迁移期兼容说明已拆到 [db-schema-tables.md](./db-schema-tables.md)，保持本文件聚焦运行态合同、repository 分层、关键查询和 migration 规则。

当前运行态表按职责分为：

- Platform Dev Lane：`platform_dev_items`、`platform_dev_events`、`work_item_links`、`work_item_gates`、`work_item_followups`、`slack_work_item_status_messages`。
- Site Publishing Lane：`publishing_jobs`、`job_events`、`issue_links`、`slack_job_status_messages`。
- 共享运行态：`slack_events`、`slack_sessions`、`session_memories`、`agent_runs`、`agent_run_events`、`github_webhook_deliveries`、`review_agent_comments`、`site_check_runs`、`slack_notification_dedupes`、`audit_logs`、`external_api_call_logs`。

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
