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

高风险需求必须先创建 issue 并等待人工确认，不能直接启动自动开发。创建时 worker 只负责确保 GitHub issue 和返回 `gate_pending` callback；真正的 Platform Agent dispatch 必须等 gate 已批准后由 gateway 从当前 MySQL 状态触发。

人工确认入口在 Slack 进度消息中展示：

- “批准自动开发”：把 `work_item_gates` 的 risk gate 置为 `approved`，`PlatformDevItem.gateStatus=approved`。如果 item 已在 `gate_pending`，gateway 推进到 `agent_queued` 并启动 `platform-agent.yml`；如果 item 仍是 `received`，只记录批准，等待正在运行的 issue 创建回调到达后再推进，避免重复启动 worker。
- “不进入自动开发”：把 gate 置为 `rejected`，`PlatformDevItem` 进入 `closed_unmerged`，保留 GitHub issue 作为需求记录。

批准高风险自动开发必须 fail-closed。gateway 只有在 `PAGES_PLATFORM_GATE_APPROVERS` 或 `PAGES_PLATFORM_GATE_APPROVER_IDS` 配置了当前 Slack 用户时才接受批准；值支持 `U123` 或 `slack:T1:U123`。未配置维护者 allowlist 时，同一需求发起人也不能批准，高风险 item 必须保持 `gate_pending`，不能 dispatch worker。

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

`gate_pending` 只对需要人工确认的需求出现。`ci_failed` 和 `review_blocked` 可以回到 `agent_queued` 或 `agent_running` 继续修复。`failed` 表示某一轮自动化失败，但有关联 PR 的工单仍可被受控恢复：用户 follow-up 会先回到 `agent_queued`，Review Agent 的 blocking / unknown comment 会先进入 `review_blocked`，再由 gateway dispatch `mode=fix` 的 Platform Agent；后续 workflow 的 `agent_running` callback 会桥接成 `failed -> agent_queued -> agent_running`，避免重试卡死在旧失败态。

## 数据模型

核心表：

- `platform_dev_items`：平台开发工单主表。
- `platform_dev_events`：平台工单状态事件。
- `work_item_links`：统一绑定 Slack session、issue、PR 和 work item。
- `work_item_gates`：人工确认、风险 gate 和审核结论。
- `work_item_followups`：Slack 后续补充。
- `slack_work_item_status_messages`：平台进度消息 message binding。

`platform_dev_items`、初始 `platform_dev_events` 和需要的 `work_item_gates` 必须在同一个 MySQL transaction 内创建；同一 idempotency key 的重试不能留下只有 item、没有事件或 gate 的半成品。

兼容扩展：

- `slack_events` 增加 `work_item_kind`、`work_item_id`、`platform_dev_item_id`。
- `slack_sessions` 增加 `active_work_item_kind`、`active_work_item_id`。
- `agent_runs` / `agent_run_events` 增加 `work_item_kind`、`work_item_id`。
- `slack_notification_dedupes` 支持 work item 维度幂等。

`platform_dev_items` 还会持久化自动修复循环需要恢复的上下文：

- `review_context`
- `memory_context`
- `status_context`
- `followup_context`
- `review_summary`

这些字段不是临时内存缓存，而是 MySQL 真相源的一部分。Review Agent 的 blocking / unknown comment、Slack follow-up 和失败后重试都依赖它们跨 webhook、跨进程和跨轮次恢复 fix round。

运行态仍以 MySQL 为真相源。Redis 只用于 lease、短期幂等和队列，不保存最终状态。

## GitHub issue / PR 闭环

Platform Agent 创建 PR 时会在 PR body 写入 `Closes #<issue>`，用于在 PR 合并到仓库默认分支时让 GitHub 自动关闭关联 issue。

需要注意两点：

- GitHub 的 auto-close 只在合并到默认分支时生效。把 PR 合并到测试分支或 feature 分支时，即使 body 里有 `Closes #<issue>`，issue 也可能不会被 GitHub 自动关闭。
- gateway 在处理 `issues.closed` webhook 时，如果对应 `PlatformDevItem` 已经是 `merged`，只会同步 issue 编号和 URL，不会把状态回退成 `closed_unmerged`。这样可以避免“PR 已合并，但后到达的 issue closed webhook 又把平台工单打回未合并关闭态”。

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
- Codex CLI 主路径和 legacy JSON fallback 都使用 `AGENT_GATEWAY_URL` + `AGENT_CODE_API_KEY`，保持同一套 company agent gateway 凭据。
- Codex CLI 在进入真实 coding round 前先执行 runner 的 `--codex-preflight`，用同一套 provider 参数校验 CLI 版本、TOML 配置、base URL 和必需凭据。
- 运行 `pnpm lint` 和 `pnpm test`。
- 做基础 secret scan，并按包含未跟踪文件的 changed-file 列表逐个读取内容扫描；`.pages-artifacts/**` 只作为 callback / report 临时目录，`.pages-trusted/**` 只作为可信 helper checkout，二者不参与目标仓库 diff、secret scan 或 commit。
- 通过 `/internal/executor-callback` 回写 `agent_running`、`pr_created` 或失败。
- 无代码变更视为失败，不会把空 PR 或空执行当成成功。
- 不直接合并 `master` / `main`；平台 PR 必须继续受 Review、CI 和 GitHub Rulesets gate 约束。

### Platform Agent 运行流

Platform Agent 是真实 repo-editing coding runner，不是只生成 JSON patch 的一次性脚本。workflow 只负责编排：checkout、准备上下文、调用 runner、校验 diff、提交和推送。实际代码或文档编辑必须发生在 checkout 工作区里，workflow 后续统一通过 `git diff`、commit 和 push 处理。

运行步骤：

1. gateway / worker dispatch `platform-agent.yml`，传入 `mode`、工单、issue、PR、review、follow-up、memory 和 status 上下文。
2. workflow checkout 目标分支，准备受控 helper 和临时 artifact 目录。
3. `platform-agent-runner` 在 `.pages-artifacts/**` 写入 task、context、status 和 backend 输入文件。
4. runner 在 repo checkout 内调用 coding backend。backend 必须直接编辑工作区文件，不能只返回游离的 patch 或报告。
5. runner 运行验证命令，并在失败时把错误摘要、当前 diff 和上下文继续交给 backend 做 fix round。
6. runner 输出报告 artifact，包含 backend、轮次、验证结果、失败原因、changed files 和可回传摘要。
7. workflow 对工作区做 changed-file 枚举、secret scan、lint/test 结果归档、commit、push 和 callback。

Codex CLI backend 是主路径。它在当前 checkout 中执行，读取 runner 生成的任务和上下文文件，按普通 coding agent 方式修改仓库文件，并通过验证 / 修复循环收敛。Codex CLI provider 使用 `AGENT_GATEWAY_URL` 归一化后的 `/v1` base URL、`AGENT_CODE_API_KEY` 和 `wire_api="responses"`，并通过 `model_providers.<id>={...}` TOML inline table 注入 provider 配置；runner 会复用同一段配置构造逻辑做 `debug models --bundled` preflight，防止无效 provider id、坏 TOML 或缺失凭据进入长任务。实际执行时 Codex CLI 使用 `--ignore-user-config`，避免 runner 机器上的个人 Codex 配置污染自动化。company agent gateway 必须兼容 `/v1/responses`。`scripts/platform-agent-coding.mjs` 保留为 legacy JSON backend / fallback，只能用于受限场景；它的局限是更偏一次性 JSON 输出，不能完整表达多轮 repo 编辑、真实命令验证、复杂冲突处理和已有工作区状态，因此不能作为 Platform Agent 的长期主路径。

fix round 必须带上当前 PR 上下文。GitHub webhook 收到 Review Agent 的 blocking / unknown comment，或收到用户后续 follow-up 后，gateway 可以 dispatch `platform-agent.yml(mode=fix)`。该 dispatch 必须携带 `prNumber`、`headSha`、`reviewContext`、`memoryContext`、`statusContext` 和 `followupContext`，让 runner 明确本轮是修复 review 阻塞、处理不确定评论，还是消化 Slack / issue follow-up。上述上下文会先落到 `platform_dev_items`，再由 worker dispatch 读出并传入 workflow；不能只停留在 webhook 进程内存里。fix round 仍然只把生成改动留在 repo 工作区，由 workflow 的标准 diff、commit、push 路径落到 PR 分支。

本阶段测试配置固定使用开发分支：`PAGES_PLATFORM_WORKFLOW_REF=feat/slack-preview-gateway`，`PAGES_PLATFORM_BASE_REF=feat/slack-preview-gateway`。该配置只用于 Platform Agent 架构变更验证，不能被解释为允许自动合并到 `master` / `main`。若显式未传 `PAGES_PLATFORM_BASE_REF`，worker 默认跟随 `PAGES_PLATFORM_WORKFLOW_REF`，避免 workflow 代码和 checkout / PR base 混用。

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
- 对已绑定 active PlatformDevItem 的 Slack thread，gateway 还会本地兜底识别“继续修改 / 改为 / 补充 / 不再修改”等 follow-up 语义；即使远端 Slack Agent 未配置，或误把这类续改分析成新的 create intent，也会优先续接当前工单，而不是重新创建 issue。

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
