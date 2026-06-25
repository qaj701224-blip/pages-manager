# Slack Review Results Summary

本文定义 Slack Agent 在 Slack 里回答“review 说了什么 / 需要改哪里 / 有哪些 blocker”的产品和代码规格。它补齐现有 `create issue -> create PR -> @codex review -> Review gate -> Slack status` 链路中的“Review 结果可读化”能力。

本文只描述 Slack 侧查看 Review 结果的只读能力。Review gate、Review Agent allowlist、site-check 和 preview 放行规则仍以 [github-automation.md](./github-automation.md#review-agent-gate) 为准。

## 背景

当前主链路已经具备：

- Slack 创建个人站点或平台需求 issue。
- worker / GitHub Actions 创建 PR。
- `pages-agent.yml` 和 `platform-agent.yml` 在 PR 创建后通过 `@codex review` 触发 Review Agent。
- gateway 通过 GitHub webhook 记录 Review Agent comment / review / check output。
- Review gate 根据 `blocking`、`suggestion`、`note`、`unknown` 和 site-check 决定是否放行 preview 或进入修复。
- Slack 状态卡能表达“等待 Review”“Review 要求修复”“site-check waiting”“可合并”“Preview 已触发”等阶段。

但 Slack 用户还不能自然地问：

```text
review 说了什么？
有哪些 blocker？
需要改哪里？
review 结果呢？
这些建议具体是什么？
```

现有状态摘要只告诉用户“Review 要求修复 / Review 已通过 / 等待 site-check / 可合并”，没有把已入库的 Review Agent 评论按优先级、文件位置和可执行结论组织出来。

## 目标体验

Slack Agent 应把 Review 结果当成当前任务的只读诊断能力，而不是让用户自己打开 PR 翻评论。

示例一：有 blocking 评论。

```text
用户：review 说了什么？

Agent：Review 目前有 2 条需要先处理的问题，PR 还不能继续放行。

1. apps/gateway/src/slack/work-items.js:128
   列表查询没有沿用上一轮范围，可能导致“只有这一个么”又回到 active 默认范围。

2. apps/slack-agent/src/policy/skills.js
   tool contract 里缺少 review 结果查询能力，模型无法稳定选择只读查询。

另外还有 1 条建议，不阻塞当前流程。完整讨论可以打开 PR。
```

示例二：没有 blocking，但 site-check 还没过。

```text
用户：review 过了吗？

Agent：Review Agent 没有发现阻塞问题，但 site-check 还在等待，所以还没有进入 Preview。

Review 结果：0 个 blocker，1 条建议，1 条说明。
下一步：等 site-check 完成；如果它失败，我会把失败阶段更新到当前对话。
```

如果 site-check 已经完成且结论不是成功，即使还没有 Review Agent comment，Slack 摘要也必须明确返回 site-check 未通过，不能退回“还没有收到 Review Agent 结果”。

示例三：Review 尚未返回。

```text
用户：review 结果呢？

Agent：我还没有看到这个 PR 的 Review Agent 结果。当前 PR 已创建，正在等待 review 或 site-check 回写。
```

## 非目标

第一阶段不要做成 Slack 内完整 GitHub review UI：

- 不展示完整评论正文、完整 diff、完整 patch 或全部 inline thread。
- 不在 Slack 里 resolve thread。
- 不在 Slack 里触发 merge、approve、dismiss review 或生产部署。
- 不主动重新触发 `@codex review`。如需 retry，应走既有诊断 / 重试确认入口。
- 不查询当前 Slack 用户不可见的 PR、其它 session、其它人的任务。
- 不绕过 Review gate。摘要只解释 gate 当前事实，不改变放行规则。

## Tool Contract

新增只读 tool：

```json
{
  "name": "summarize_review_results",
  "intents": ["summarize_review_results", "list_review_results"],
  "dialogAct": "run_tool",
  "sideEffect": "read",
  "confirmation": "none",
  "cardKind": "diagnosis",
  "args": {
    "kind": "current | issue | pr | unknown",
    "number": "positive_integer | null",
    "includeResolved": "boolean",
    "maxItems": "positive_integer"
  }
}
```

默认参数：

- `kind=current`。
- `includeResolved=false`。
- `maxItems=5`，最大不超过 10。

命名说明：

- Slack 产品入口以 `summarize_review_results` 为主，默认给结论和高优先级摘要。
- `list_review_results` 可以作为 alias，但 gateway 最终归一到 `summarize_review_results`。
- 这个 tool 是只读诊断能力，不写 GitHub、不写 Issue、不触发 workflow。

## Intent 识别

Slack Agent 应识别这些表达：

- `review 说了什么`
- `review 结果呢`
- `review 过了吗`
- `有哪些 blocker`
- `有哪些 blocking comment`
- `需要改哪里`（仅在已有 Review 结果或当前 PR 处于 Review 阻塞上下文时）
- `Review Agent 提了什么`
- `codex review 结果`
- `PR review 状态`
- `这些建议具体是什么`

语义优先级：

1. 明确批量破坏请求仍优先拒绝。
2. 明确“review 说了什么 / blocker / Review Agent 提了什么”优先进入 `summarize_review_results`，不要落到泛化 `diagnose_current_work_item`。
3. “为什么卡住 / workflow 失败 / 能不能重试”仍走 `diagnose_current_work_item`。
4. 用户说“按 review 改 / 修掉 review 意见”是 follow-up / fix 意图，走 `record_followup`，不要只读摘要。
5. “需要改哪里”这类裸问题必须结合上下文判断：已有 Review 摘要或当前 PR 被 Review 阻塞时才走 `summarize_review_results`；普通 preview / 设计修改上下文应走 `record_followup`。
6. 用户没有当前 PR 且没有明确编号时，只读回答“当前会话还没有关联 PR”，不要创建新 issue。

示例输出：

```json
{
  "visibleReply": "我来整理当前 PR 的 Review 结果。",
  "lane": "platform-dev",
  "intent": "summarize_review_results",
  "toolCall": {
    "name": "summarize_review_results",
    "args": {
      "kind": "current",
      "includeResolved": false,
      "maxItems": 5
    }
  },
  "needsClarification": false
}
```

## Scope Resolution

Slack Agent 负责语义路由；gateway 执行 tool 时必须重新解析目标 PR，不信任模型传来的用户、session 或 repo 范围。

gateway intake 只提取显式事实，不用宽泛自然语言正则决定 review intent：

- Slack user / team / channel / thread。
- 显式 `PR #123`、`Issue #88`、`#123`。
- 明确命令和危险批量操作。

参数合并优先级固定为：

1. 用户原文里的显式 PR / Issue 编号。
2. 当前 Slack session / current focus。
3. `conversationContext` / `lastWorkItemList`。
4. Slack Agent 推断参数。

解析顺序：

1. 如果用户原文或 args 明确 `kind=pr` 且带编号，查当前 Slack 用户可见任务中是否有该 PR。
2. 如果用户原文或 args 明确 `kind=issue` 且带编号，查当前 Slack 用户可见任务中该 issue 关联的 PR。
3. 否则使用当前 Slack session 的 active work item。
4. 如果当前 focus 是 issue，但 issue 已有关联 PR，使用关联 PR。
5. 如果上一条任务列表只有一个带 PR 的 item，可作为弱 focus。
6. 都找不到时，返回无 PR 的用户可见提示。

可见性规则：

- Site Publishing Lane 只允许查询当前 Slack 用户创建或当前 session 绑定的 `PublishingJob`。
- Platform Dev Lane 只允许查询当前 Slack 用户创建、当前 session 绑定或当前用户可见的 `PlatformDevItem`。
- 即使用户给出 `PR #123`，gateway 也必须确认该 PR 属于当前用户可见范围。
- 不允许跨 Slack team、跨 session 或按任意 GitHub assignee 全局查询。

## Data Sources

第一阶段只使用已经入库的事实，不实时抓 GitHub 评论。

必须读取：

- `review_agent_comments`：Review Agent comment / review / check output。
- `site_check_runs`：site-check 当前状态。
- `publishing_jobs` 或 `platform_dev_items`：当前任务状态、PR 编号、PR URL、head SHA、issue 编号。

已有 repository 方法：

- `listReviewAgentComments(repoFullName, prNumber, { headSha })`
- `listReviewAgentCommentsForPrNumber(prNumber, { repoFullName, headSha })`
- `reviewGateForPr(repoFullName, prNumber, { headSha })`
- `siteCheckGateForPr(repoFullName, prNumber, { headSha })`
- `previewGateForPr(repoFullName, prNumber, { headSha })`

可选读取：

- `session_memories.requirements.platformReview.lastSummary`：平台任务已经保存的 review context。
- `agent_run_events`：解释最近阶段，但不作为 review 评论真相源。

不要读取：

- GitHub PR diff 全文。
- 未脱敏原始日志。
- 当前用户不可见的 PR 评论。
- 本地 `gh pr view` 输出作为运行时真相源。

## Result Model

gateway 内部可以构造标准结构，供文本和 Block Kit 共用：

```js
{
  workItemKind: 'site_publishing' | 'platform_dev',
  workItemId: '...',
  repoFullName: 'xindong/pages-manager',
  prNumber: 123,
  prUrl: 'https://github.com/xindong/pages-manager/pull/123',
  headSha: '...',
  conclusion: 'blocked' | 'passed' | 'waiting_review' | 'waiting_site_check' | 'unknown',
  gate: {
    blockingCount: 2,
    unknownCount: 0,
    suggestionCount: 1,
    noteCount: 1,
    siteCheckPassed: false,
    siteCheckStatus: 'completed',
    siteCheckConclusion: 'success'
  },
  comments: [
    {
      id: 'review_...',
      classification: 'blocking' | 'suggestion' | 'note' | 'unknown',
      sourceType: 'review_summary' | 'inline_comment' | 'issue_comment' | 'check_run',
      status: 'open' | 'resolved' | 'dismissed' | 'deleted' | 'outdated',
      path: 'apps/gateway/src/slack/work-items.js',
      line: 128,
      bodySummary: '列表查询没有沿用上一轮范围...',
      reviewAgentLogin: 'chatgpt-codex-connector[bot]',
      updatedAt: '...',
      url: 'https://github.com/...'
    }
  ],
  omitted: {
    blocking: 0,
    suggestions: 3,
    notes: 5,
    resolved: 2
  }
}
```

`bodySummary` 规则：

- 从已脱敏正文生成，最长 180 字。
- 去掉 Markdown 图片、长代码块、HTML、重复空白和引用嵌套。
- 保留文件路径、行号、错误类别和 Review Agent 明确给出的动作。
- 不输出完整 diff hunk。
- 不输出 secret-like 文本；最终回复仍要走 `redactSecretLikeText()`。

## Classification And Ordering

展示顺序：

1. `blocking`
2. `unknown`
3. `suggestion`
4. `note`

同级排序：

1. `inline_comment` 优先于 `review_summary`，因为它更接近具体改动位置。
2. 有 `path` / `line` 的优先。
3. 最新 `updatedAt` 优先。

默认只展示 open comment。`includeResolved=true` 时可以附带已解决 / dismissed / outdated 的计数，但第一阶段仍不展示全文。

`unknown` 处理：

- Review gate 中 `unknown` 不放行 preview。
- Slack 摘要里应把 `unknown` 表达为“我无法判断是否阻塞，需要人工确认”，不要说成通过。
- 如果只有 `unknown`，结论为 `unknown`，建议打开 PR 或转人工。

## Slack Output

文本应保持短、可执行：

- 第一段给结论。
- 第二段列最多 5 条关键评论。
- 末尾给下一步。
- 有 PR URL 时提供“查看 PR”按钮。

推荐文案模板：

```text
Review 目前有 {blockingCount} 条需要先处理的问题，PR 还不能继续放行。

1. {path}:{line}
   {bodySummary}

2. {path}
   {bodySummary}

另外还有 {suggestionCount} 条建议、{noteCount} 条说明。完整讨论可以打开 PR。
```

结论映射：

| conclusion | Slack 文案 |
| --- | --- |
| `blocked` | `Review 目前有 N 条需要先处理的问题，PR 还不能继续放行。` |
| `passed` | `Review Agent 没有发现阻塞问题。` |
| `waiting_site_check` | `Review Agent 没有发现阻塞问题，但 site-check 还没通过。` |
| `waiting_review` | `我还没有看到这个 PR 的 Review Agent 结果。` |
| `unknown` | `Review 结果里有无法判断是否阻塞的内容，需要人工确认。` |

按钮：

- `查看 PR`：有 `prUrl` 时展示。
- `查看 Workflow`：site-check 失败且有 `detailsUrl` 时展示。
- `追加诊断到 Issue`：复用诊断能力，需要按钮确认。
- `转人工排查`：复用诊断能力，需要按钮确认。

不要在这张卡上放：

- `合并 PR`
- `批准 review`
- `resolve comment`
- `重新触发 review`
- `生产部署`

## Policy Package Changes

需要在 `apps/slack-agent/src/policy/` 增加或修改：

- `schema.js`
  - `SLACK_AGENT_INTENTS` 增加 `summarize_review_results`。
  - `SLACK_AGENT_TOOL_NAMES` 通过 workflow-core 自动包含 `summarize_review_results`。
- `skills.js`
  - `diagnostics` skill 增加 review result 只读查询规则。
  - `tool-contract` skill 增加 `summarize_review_results`。
  - `product-language` skill 增加 Review 摘要文案边界。
- `package.js`
  - bump `SLACK_AGENT_POLICY_PACKAGE_VERSION`。
- `analysis.js`
  - deterministic fallback 增加 review result query 正则。
  - `toolCallForIntent()` 映射到 `summarize_review_results`。
  - `shouldForceIntentToolCall()` 包含该 intent。

Review 查询相关 skill 文案建议：

```text
当用户问“review 说了什么 / review 结果呢 / 有哪些 blocker”时，intent 返回 summarize_review_results，toolCall.name 返回 summarize_review_results。它是只读能力，只整理当前用户可见 PR 已入库的 Review Agent 评论和 site-check 状态，不触发新 review，不 resolve comment，不 merge。“需要改哪里”只有在已有 Review 上下文时才归入这个能力。
```

## Gateway Changes

需要在 gateway 增加 handler：

- `slackAgentToolCallForTurn()`
  - 识别 `summarize_review_results` 和 alias。
  - 合并 tool args 时用户显式 PR / Issue 编号优先于 Slack Agent 推断。
- `handleSlackAgentToolCall()`
  - 新增 case `summarize_review_results`。
- `classifySlackIntake()`
  - 只提取显式对象和命令，不用 review 自然语言正则直接返回 `summarize_review_results`。
- 新增模块建议：
  - `apps/gateway/src/slack/review-results.js`

模块职责：

- `resolveReviewResultsTarget(store, body, slackSession, args)`
- `buildReviewResultsSummary(store, env, item, options)`
- `formatSlackReviewResultsText(summary)`
- `buildSlackReviewResultsBlocks(slackSession, summary)`

执行步骤：

1. 解析当前 Slack actor。
2. 解析当前 work item / PR。
3. 校验可见性。
4. 读取 review gate、site-check gate、comments。
5. 过滤、排序、截断和脱敏。
6. 生成文本和 card。
7. 写入 `sessionMemory.lastAgentResponse` 和 `conversationContext`，方便后续“这些建议具体是什么 / 按第一条改”续接。
8. 记录 `AgentRun.reportJson`，包含 counts、conclusion、prNumber、headSha，不记录完整评论正文。

## Workflow Core Changes

`packages/workflow-core/src/index.js` 应增加 capability：

```js
summarize_review_results: {
  name: 'summarize_review_results',
  intents: ['summarize_review_results', 'list_review_results'],
  dialogAct: 'run_tool',
  sideEffect: 'read',
  confirmation: 'none',
  cardKind: 'diagnosis',
  args: {
    kind: ['current', 'issue', 'pr', 'unknown'],
    number: 'positive_integer',
    includeResolved: 'boolean',
    maxItems: 'positive_integer'
  },
  description: 'Summarize visible Review Agent comments and site-check state for the current PR.'
}
```

同时同步：

- `SLACK_AGENT_CAPABILITY_NAMES`
- tests for capability lookup。

## Persistence

第一阶段不需要新增表。现有表已经足够：

- `review_agent_comments`
- `site_check_runs`
- `publishing_jobs`
- `platform_dev_items`
- `session_memories`

但建议把最近一次 Review 摘要写入 session memory：

```js
requirements: {
  reviewResults: {
    prNumber: 123,
    headSha: '...',
    conclusion: 'blocked',
    blockingCount: 2,
    suggestionCount: 1,
    noteCount: 1,
    lastSummary: 'Review 目前有 2 条需要先处理的问题...',
    updatedAt: '2026-06-24T00:00:00.000Z'
  }
}
```

用途：

- 支持用户追问“第一条是什么意思 / 那些建议呢 / 按 review 改”。
- 支持 Slack Agent conversation context 识别“这些建议”。
- 不作为 Review gate 真相源；gate 仍读 `review_agent_comments` 和 `site_check_runs`。

## Tests

必须覆盖：

1. Slack Agent 把“review 说了什么”识别为 `summarize_review_results`。
2. “有哪些 blocker”识别为 `summarize_review_results`。
3. “按 review 改”识别为 `record_followup`，不是只读摘要。
4. 当前会话没有 PR 时返回可见提示，不创建 issue。
5. 当前用户不可见 PR 编号被拒绝。
6. 有 blocking comments 时，摘要列出 blocking，结论为 `blocked`。
7. 只有 suggestion / note 且 site-check passed 时，结论为 `passed`。
8. Review passed 但 site-check missing / pending 时，结论为 `waiting_site_check`。
9. 没有 Review Agent comments 时，结论为 `waiting_review`。
10. 有 unknown comments 时，结论为 `unknown` 且不说通过。
11. inline comment 带 path / line；summary comment 没有 path 时显示 PR 级别。
12. 评论正文脱敏，secret-like 文本不出现在 Slack 输出。
13. maxItems 生效，超出部分只显示计数。
14. `AgentRun.reportJson` 不保存完整评论正文。
15. `sessionMemory.requirements.reviewResults` 写入最近摘要。

建议测试文件：

- `tests/apps/slack-agent/index.test.js`
- `tests/apps/gateway/index.test.js`
- `tests/apps/gateway/platform-dev-lane.test.js`
- `tests/packages/workflow-core/index.test.js`

## Rollout

建议分两步落地：

1. 只读摘要 MVP
   - capability / policy / deterministic fallback。
   - gateway handler。
   - 文本输出和 PR 按钮。
   - 单元测试覆盖。
2. 续接增强
   - 把最近 Review 摘要写入 conversation context。
   - 支持“第一条 / 第二条 / 这些建议”指代。
   - 支持“按 review 改”把摘要附进 follow-up fix context。

上线后重点观察：

- 用户是否还会去问“具体哪里要改”。
- `unknown` 分类是否过多。
- Slack 输出是否过长。
- 是否有跨用户 PR 查询被拒绝的审计记录。
- Review summary 是否帮助减少人工打开 PR 的次数。

## Acceptance Criteria

- 用户在有关联 PR 的 Slack thread 里问“review 说了什么”，不会只返回泛化状态摘要。
- 有 Review Agent blocking comment 时，Slack 能列出最多 5 条关键问题、文件路径和行号。
- 有 suggestion / note 时，Slack 能说明“不阻塞”并显示计数。
- Review 尚未返回时，Slack 明确说明当前看不到 Review Agent 结果。
- Review 通过但 site-check 未完成时，Slack 不误报可以 preview。
- 不能查看其它 Slack 用户或其它 session 的 PR review。
- 不输出完整 diff、完整原始评论、secret、内部日志或 provider debug 信息。
- 不提供 merge、resolve、approve、production deploy 按钮。
- 相关能力在 policy package、workflow-core capability 和 gateway handler 中保持一致。
