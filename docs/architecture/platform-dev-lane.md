# Platform Dev Lane

Platform Dev Lane 让 Slack 可以创建和跟踪 `pages-manager` 自身的开发需求。它和 Site Publishing Lane 完全分离：前者处理平台代码、文档、CI、GitHub 自动化和运行时改造；后者处理员工个人站点内容发布。

## 产品目标

用户在 Slack 里描述平台改造需求后，系统负责：

1. 判断需求属于个人站点发布还是平台自身开发。
2. 整理标题、摘要、类型、范围、风险和是否允许自动开发。
3. 在用户确认后创建 GitHub issue。
4. 对高风险需求等待人工确认；对低 / 中风险且适合自动开发的需求启动平台开发执行器。
5. 跟踪 PR、CI、Review 和合并状态，并把进度回写到原 Slack 对话。

用户不需要理解 gateway、worker、webhook、MySQL、PublishingJob 或内部 message binding。Slack 上只展示“需求摘要、当前进度、下一步动作和 GitHub 链接”。

Platform Dev Lane 的长期产品定位不是命令式表单，而是平台研发任务的诊断入口。用户可以问“这个任务现在怎么样”“为什么 issue 没创建成功”“issue 创建了为什么 PR 没出来”“能不能重试”，Slack Agent 应返回可操作的诊断报告，而不是暴露底层服务、队列、数据库或 callback 细节。

## Lane 分流

Site Publishing Lane：

- 目标是员工个人站点。
- 数据模型是 `PublishingJob`。
- 自动 PR 只能改 `sites/<employeeSlug>/<siteSlug>/`。
- 后续会生成 preview。

Platform Dev Lane：

- 目标是 `pages-manager` 自身。
- 数据模型是 `PlatformDevItem`。
- repo 全目录可以被人工或受控 agent 修改，但必须受 issue type、risk gate、CI、Review 和 GitHub Rulesets 约束。
- 不生成 Cloudflare preview，不触发站点发布 workflow。

Slack Agent 输出必须包含：

```json
{
  "lane": "platform-dev",
  "intent": "create_platform_issue",
  "toolCall": { "name": "confirm_platform_issue", "args": {} },
  "issueType": "type:dev",
  "areas": ["area:gateway", "area:github"],
  "risk": "risk:medium",
  "agentEligible": true,
  "requiresHumanGate": false
}
```

## Issue 类型和风险

类型：

- `type:dev`：平台功能开发。
- `type:bug`：平台 bug 修复。
- `type:docs`：架构、宣讲、使用文档。
- `type:feedback`：意见收集，不默认进入自动开发。
- `type:question`：问题咨询，不默认进入自动开发。
- `type:ci`：CI/CD 或 GitHub Actions 改造，默认高风险。
- `type:ops`：ECS、K8s、Docker、部署脚本、运行时配置，默认高风险。
- `type:security`：权限、token、secret、认证授权，默认高风险。

风险：

- `risk:low`：文档或低影响局部代码改动。
- `risk:medium`：gateway、worker、Slack、GitHub 自动化、DB 状态机等常规平台改动。
- `risk:high`：CI/CD、部署、K8s、ECS、Dockerfile、secret、生产行为、权限模型或 schema 迁移。

高风险需求必须先创建 issue 并等待人工确认，不能直接启动自动开发。

人工确认入口在 Slack 进度消息中展示：

- “批准自动开发”：把 `work_item_gates` 的 risk gate 置为 `approved`，`PlatformDevItem.gateStatus=approved`，然后启动 `platform-agent.yml`。
- “不进入自动开发”：把 gate 置为 `rejected`，`PlatformDevItem` 进入 `closed_unmerged`，保留 GitHub issue 作为需求记录。

按钮 value 只携带 work item id / session id / gate type；gateway 必须重新从 MySQL 读取 item 和 gate，并校验当前 Slack 用户归属，不能信任按钮里的风险或范围字段。

## 状态机

```text
received
  -> issue_creating
  -> issue_created
  -> gate_pending | agent_queued | agent_running
  -> branch_committed
  -> pr_created
  -> ci_running
  -> ci_failed | review_waiting | review_blocked | ready_to_merge
  -> merged | closed_unmerged
```

终态：

- `merged`
- `closed_unmerged`
- `failed`
- `cancelled`

`gate_pending` 只对需要人工确认的需求出现。`ci_failed` 和 `review_blocked` 可以回到 `agent_queued` 或 `agent_running` 继续修复。

## 数据模型

核心表：

- `platform_dev_items`：平台开发工单主表。
- `platform_dev_events`：平台工单状态事件。
- `work_item_links`：统一绑定 Slack session、issue、PR 和 work item。
- `work_item_gates`：人工确认、风险 gate 和审核结论。
- `work_item_followups`：Slack 后续补充。
- `slack_work_item_status_messages`：平台进度消息 message binding。

兼容扩展：

- `slack_events` 增加 `work_item_kind`、`work_item_id`、`platform_dev_item_id`。
- `slack_sessions` 增加 `active_work_item_kind`、`active_work_item_id`。
- `agent_runs` / `agent_run_events` 增加 `work_item_kind`、`work_item_id`。
- `slack_notification_dedupes` 支持 work item 维度幂等。

运行态仍以 MySQL 为真相源。Redis 只用于 lease、短期幂等和队列，不保存最终状态。

## GitHub 自动化

平台 issue 使用独立 marker：

```text
PlatformDevItem: pdev_xxx
```

issue body 必须包含：

- Lane: `platform-dev`
- IssueType
- Areas
- Risk
- AgentEligible
- RequiresHumanGate
- Slack thread 来源
- 自动化边界

`platform-agent.yml` 是独立 workflow：

- 只由 `workflow_dispatch` 触发。
- 不持有 Cloudflare、Aliyun、Kube、ACK 或 production deploy secret。
- 允许使用 GitHub token 创建平台 PR。
- 使用 `AGENT_CODE_API_KEY` 作为外部 coding agent 凭据。
- 运行 `pnpm lint` 和 `pnpm test`。
- 做基础 secret scan。
- 通过 `/internal/executor-callback` 回写 `agent_running`、`pr_created` 或失败。
- 无代码变更视为失败，不会把空 PR 或空执行当成成功。

## Slack 体验

确认前：

- 展示平台需求标题、摘要、类型、范围、风险。
- 按钮是“确认创建平台需求”。
- 高风险时明确说明“先创建 issue，等待人工确认后再进入自动开发”。

处理中：

- Slack 只展示用户可理解的进度：创建 issue、等待人工确认、自动开发中、PR 已创建、CI 验证中、等待 Review、可合并、已合并或失败。
- 不展示内部服务名、DB 表名、webhook、worker 或 message binding 实现。

后续补充：

- 当前实现会保留 work item link 和 session memory。
- 平台 followup 进入 `work_item_followups` 后，由后续平台 agent 修复循环消费。

诊断查询：

- 默认围绕当前 Slack thread / PlatformDevItem / issue / PR 查询，不提供任意项目范围的日志搜索。
- 可展示当前状态、最近阶段、Issue、PR、CI / Workflow、失败原因和下一步建议。
- 可以解释常见断点：issue 未创建、issue 已创建但 agent 未启动、agent 已运行但 PR 未创建、PR 创建后 CI 失败、review 阻塞、callback 过期或状态机拒绝旧事件。
- 可以摘要受控日志和 GitHub Actions 状态，但 Slack 文案必须使用产品语义；不要把 `pages-gateway`、`pages-worker`、MySQL 表名、内部 token 名或 status card binding 当作用户可见解释。
- 日志摘要必须受当前用户、当前 session 和 work item 归属约束，默认查最近 30 分钟，扩大时间窗或追加诊断到 issue 需要确认。

执行权限：

- 默认开放：状态查询、关联关系查询、timeline、断点解释、受控日志摘要、GitHub Actions 状态、下一步建议。
- 需要确认：创建平台 issue、追加诊断 comment、重试失败的 worker 流程、重新 dispatch workflow、恢复已关闭任务。
- 必须拒绝或转人工：创建 PR、合并 PR、生产部署、删除资源、批量关闭 issue / PR、读取 secret、任意 ECS 原始日志查询、直接 shell 到 ECS。

推荐诊断回复：

```text
这个平台任务卡在 PR 创建前。
当前状态：Issue 已创建
Issue：#123
最近阶段：Workflow 已请求启动
失败原因：GitHub Actions dispatch 返回 403，可能是 token 缺少 workflow 权限。
关联日志：最近 30 分钟有 1 条匹配错误。
建议操作：可以重试，或把诊断结果追加到 Issue。
```

推荐按钮：

- 查看 Issue。
- 查看 Workflow。
- 重试。
- 追加诊断到 Issue。
- 转人工排查。

## 验收标准

- Slack 平台需求不会创建 `PublishingJob`。
- 个人站点发布路径仍只改 `sites/<employeeSlug>/<siteSlug>/`，且 preview 逻辑不变。
- 平台 issue 创建后能通过 marker 被 GitHub webhook 找回。
- 平台 PR 的 CI / Review / merge 只更新 Platform Dev Lane，不触发 pages preview。
- 高风险需求不会在人工 gate 前启动 `platform-agent.yml`。
- 高风险 gate 的批准 / 拒绝会写入 `work_item_gates`，并同步更新 Slack 进度消息。
- 所有行为有单元测试或集成测试覆盖。
- Slack 诊断回复不泄露 gateway / worker / MySQL / callback / status card 等底座细节，只展示任务阶段、链接、失败原因和建议操作。
