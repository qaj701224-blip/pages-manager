# Slack Agent Policy Skill

本文定义如何把 Slack Agent 当前内联 system prompt 收敛为生产级 policy skill。它是 [slack-agent-runtime.md](./slack-agent-runtime.md)、[slack-agent-repo-question.md](./slack-agent-repo-question.md) 和 [agent-policy-and-prompts.md](./agent-policy-and-prompts.md) 的落地规格。

Slack 中查看 Review Agent 具体评论、blocker 和建议的只读能力单独见 [slack-review-results-summary.md](./slack-review-results-summary.md)。本文只维护通用 policy package、tool contract 和 prompt 组织规则。

> 当前状态：Site Publishing Lane 已静态冻结。`site-publishing` lane 和相关 toolCall 名称只为兼容已有 prompt、历史 session 与审计记录；Gateway 命中个人站点新建、确认、续接、切换、retry、reopen、追加诊断或转人工写入时统一返回退休提示。历史 Site Publishing 列表、诊断、Review 和 timeline 只读；Platform Dev Lane 的同名通用工具继续按原合同运行。

目标不是写一段更长的 prompt，而是把 Slack Agent 的产品语义、权限边界、工具合同、反例样本和测试矩阵变成可版本化、可 review、可测试的 prompt package。Slack Agent 可以决定“下一步请求 gateway 做什么”，但不能因为 skill 存在而获得任何执行权限。

## 现状与问题

当前 `apps/slack-agent/src/analysis.js` 已经包含三类规则：

- deterministic fallback：通过关键词和正则推断 `lane`、`intent`、`toolCall`、`issueType`、`areas` 和 `risk`。
- inline system prompt：在 `buildSlackAgentMessages()` 中用字符串列出角色边界、toolCall 枚举、确认按钮、repo question、诊断、危险操作拒绝和 JSON 输出要求。
- model output normalization：`normalizeModelAnalysis()` 把模型输出和 fallback 合并，并在 `repo_question` / `architecture_question` / `platform_question` 时强制只读 toolCall。

Gateway 侧也有二次收口：

- `slackAgentToolCallForTurn()` 会把 repo 问题强制转成 `answer_repo_question`。
- `handleSlackAgentToolCall()` 只执行白名单 toolCall。
- `shouldAskBeforeCreatingIssue()` / `shouldAskBeforeCreatingPlatformIssue()` 要求自然语言创建类请求先展示确认卡。
- work item 工具会重新按当前 Slack 用户、当前 session 和可见 issue / PR 范围查询，不信任模型传来的用户范围。

这些约束方向正确，但生产维护上有几个缺口：

- 规则集中在一段内联字符串里，review 时难判断某句话改变了哪个产品行为。
- 正则 fallback 和 prompt 规则容易漂移，例如 repo 咨询、平台需求、诊断和 followup 的优先级不一致。
- 缺少可复用的 policy shard，Repo Question、诊断、Platform Dev Lane、Site Publishing Lane 之间的共同边界被复制到多个位置。
- 缺少会话上下文产品能力。当前 turn payload 主要传当前文本、`slackSession`、`sessionMemory` 和 `issueLinks`，但没有把最近 N 条用户 / bot 消息、上一条 bot 卡片摘要、刚展示的 issue / PR 列表和当前焦点对象作为一等上下文。
- 指代解析不足时，用户说“只有这一个么”“上一条”“刚才那个”“继续”会被当成孤立输入，导致 Agent 反问已经在 thread 里明确的信息，或者把内部意图摘要当作可见回复。
- 缺少 golden cases 作为行为护栏，真实 Slack 语句只能靠新增零散单测覆盖。
- 没有 prompt package 版本，`AgentRun` 记录难以复盘“当时模型看到的是哪套规则”。

因此需要生产级 policy skill。

## 设计原则

1. Skill 只表达理解规则和输出合同，不表达执行权限。
2. Gateway 继续是权限、幂等、session、用户归属、状态机和 side effect 的唯一执行边界。
3. Prompt package 是运行时输入的一部分，应可版本化、可记录、可回放。
4. Deterministic fallback 只服务测试、smoke 和模型不可用兜底，不应成为主要产品语义引擎。
5. Slack Agent 必须先像能读 thread 的协作助理，再像能触发流程的机器人。默认读懂当前对话、上一条 bot 回复、刚展示的卡片和当前焦点对象，必要时再进入结构化流程。
6. Prompt compiler 负责组合固定 policy、当前 session context、conversation context、tool contract 和用户消息，不在业务代码里拼一大段散文。
7. Golden cases 是和 prompt package 同等重要的交付物。没有 golden case 的语义变更不应合入。
8. 所有用户可见文案使用产品语义：任务、阶段、Issue、PR、Preview、Workflow、失败原因、建议操作。普通回复不能暴露 gateway、worker、MySQL、job id、session id、status card、callback 等内部实现。

## 推荐目录

建议在 `apps/slack-agent/src/policy/` 下放运行时 policy package 源码，文档和测试跟随源码维护：

```text
apps/slack-agent/src/policy/
  index.js
  package.js
  compiler.js
  schema.js
  fragments/
    role.md
    lanes.md
    intent-priority.md
    tool-contract.md
    safety.md
    output-schema.md
    product-language.md
    conversation-context.md
    repo-question.md
    diagnostics.md
    platform-dev.md
    site-publishing.md
  golden-cases.js
```

职责：

- `package.js`：导出 `SLACK_AGENT_POLICY_PACKAGE_VERSION` 和 fragment 清单。
- `compiler.js`：输入 `fallbackAnalysis`、`sessionContext`、`sessionMemory`、`conversationContext`、`issueLinks` 和当前 Slack 文本，输出 `messages`。
- `schema.js`：导出模型 JSON 输出 schema、lane/intent/toolCall 枚举和 normalization helper。
- `fragments/*.md`：只放面向模型的稳定规则，不放动态 session 内容。
- `golden-cases.js`：真实 Slack 语句、上下文和期望结构化输出。

后续如果希望非 JS 运行时复用，也可以把 `fragments/` 放到 `apps/slack-agent/policy/`，由构建步骤复制进包内。第一阶段不需要引入复杂构建。

## 存放与部署读取规则

必须区分“设计文档”和“运行时 policy package”：

- `docs/architecture/slack-agent-policy-skill.md` 是给人和后续开发看的架构规格，不是 Slack Agent 运行时输入。
- Slack Agent 生产运行时只能读取 `apps/slack-agent/src/policy/` 下的 policy package。
- Golden cases 可以放在 `apps/slack-agent/src/policy/golden-cases.js` 或 `tests/apps/slack-agent/golden-cases.js`；如果放在 `src/`，生产代码不能在请求路径 import 测试用例。
- `docs/` 里的内容即使被 Docker image 复制进去，也不能作为 prompt 真相源；否则会让运行时 prompt 和测试 schema 分离。

ECS 当前构建路径会把 `apps/` 和 `docs/` 都复制进镜像：`Dockerfile.node-service` 和 `scripts/deploy-ecs.sh` 生成的 offline Dockerfile 都包含 `COPY apps ./apps` 与 `COPY docs ./docs`。因此如果 policy package 放在 `apps/slack-agent/src/policy/`，并由 `analysis.js` / `compiler.js` import 或读取，部署到 ECS 后 Slack Agent 可以读到。

但可读不等于会生效。必须满足：

- `buildSlackAgentMessages()` 调用 `compileSlackAgentPolicy()`。
- `compileSlackAgentPolicy()` 从 `apps/slack-agent/src/policy/` 取 fragment 和 schema。
- 如果 fragment 是 JS 字符串模块，必须被 ESM import。
- 如果 fragment 是 `.md` 文件，必须用 `import.meta.url` 解析相对路径，不能依赖进程 cwd。
- ECS health / smoke 测试必须验证 `/internal/slack-agent/turn` 返回的 analysis 带 `policyVersion`。
- 打包或 Dockerfile 未来如果改成只复制构建产物，必须显式把 `apps/slack-agent/src/policy/fragments/**` 纳入产物，并加测试防止遗漏。

推荐第一版用 JS 模块保存 fragment，例如 `fragments/role.js` 导出字符串，避免生产环境读取 Markdown 文件的路径和打包风险。需要给人看的长文档仍保留在 `docs/architecture/`。

## Policy Package 结构

`package.js` 应导出稳定对象：

```js
export const SLACK_AGENT_POLICY_PACKAGE_VERSION = 'slack-agent-policy-2026-06-24.1';

export const SLACK_AGENT_POLICY_PACKAGE = {
  version: SLACK_AGENT_POLICY_PACKAGE_VERSION,
  skills: [
    'core',
    'safety',
    'tool-contract',
    'product-language',
    'output-schema',
    'conversation-context',
    'work-item-continuation',
    'repo-question',
    'diagnostics',
    'platform-dev',
    'site-publishing',
    'product-design',
  ],
};
```

版本规则：

- 任何会影响模型决策、可见文案或 JSON 输出的 fragment 改动，都要 bump 版本。
- 只改注释、拼写、测试 helper，不需要 bump。
- `AgentRun` 应记录 `policyPackageVersion`，便于线上误判复盘。
- 模型日志可以记录 fragment 名称和版本，不要记录 secret 或完整用户隐私上下文。

## Runtime Skill Registry

当前运行态不再把所有规则永久拼成一段大 prompt。`apps/slack-agent/src/policy/skills.js` 定义可组合 skill，`compileSlackAgentPolicy()` 每轮根据当前文本、deterministic fallback、`sessionContext`、`conversationContext` 和 `issueLinks` 选择本轮需要的 skill。

Always-on skill：

- `core`：角色、lane 和 side effect 边界。
- `safety`：secret、跨用户、批量破坏和日志边界。
- `tool-contract`：允许的 toolCall 和 gateway 执行边界。
- `product-language`：用户可见文案约束。
- `output-schema`：JSON 输出合同。

Context / lane skill：

- `conversation-context`：上一条消息、当前焦点、列表追问、复读和可见范围。
- `work-item-continuation`：`这个 issue / 接着改 / 改为 / 不再修改 X / 换成 Y` 续接当前任务。
- `repo-question`：仓库只读问答、实现方案咨询和 evidence 限制。
- `diagnostics`：状态、失败、日志、workflow、重试和转人工入口。
- `platform-dev`：明确平台研发需求、风险、area 和手动自动开发触发边界。
- `site-publishing`：个人站点创建、preview follow-up 和站点归属 hint。
- `product-design`：产品视角、方案评审、用户心智和是否偏离初衷。

选择规则：

- `selectedSkills` 会写入 Slack Agent user payload，便于线上复盘模型当轮看到的产品策略。
- 语义上仍由模型基于 selected skills 决策；deterministic selector 只决定本轮 prompt 应该带哪些技能，不能绕过 gateway 权限。
- `work-item-continuation` 是防重复 issue 的关键 skill：只要当前 thread/session 有 active 或 recoverable work item，用户的“这个 / 刚才 / 接着 / 改为”默认续接当前任务。
- `failed` 的 Platform Dev Item 如果仍有关联 Issue，会保留为 recoverable context；同一 Slack thread 的补充会更新原 Issue 并重试，不会新建 Issue。
- 如果用户明确说“另开一个 / 新建另一个 / 创建新的 issue”，才允许在当前 thread 进入新的创建确认。

## Prompt Compiler

`buildSlackAgentMessages()` 应迁移为 prompt compiler，目标输出仍是 OpenAI-compatible `messages`：

```js
export function buildSlackAgentMessages(input, fallbackAnalysis) {
  const policy = compileSlackAgentPolicy({
    package: SLACK_AGENT_POLICY_PACKAGE,
    fallbackAnalysis,
    sessionContext: sessionContextFromInput(input),
    sessionMemory: input.sessionMemory || null,
    conversationContext: input.conversationContext || null,
    issueLinks: compactIssueLinks(input.issueLinks),
    slackText: input.text || input.event?.text || '',
    employeeSlugHint: input.employeeSlug || input.employee_slug || null,
    siteSlugHint: input.siteSlug || input.site_slug || null,
  });

  return [
    { role: 'system', content: policy.system },
    { role: 'user', content: JSON.stringify(policy.userPayload) },
  ];
}
```

Compiler 规则：

- system message 只包含稳定 policy fragments 和输出合同。
- user message 只包含本轮动态数据：Slack 文本、fallbackAnalysis、sessionContext、sessionMemory、conversationContext、issueLinks、slug hints。
- `visibleReply` 必须继续放在 JSON object 第一字段，方便准流式输出。
- 不把 token、secret、cookie、API key、原始日志、完整源码或 Slack bot token 放进任何 prompt。
- `employeeSlugHint` 和 `siteSlugHint` 只是 hint；真实归属由 gateway 根据 Slack 身份派生。
- `issueLinks` 默认只取最近或最相关的有限条目，避免把历史 PR/preview 全量塞进 prompt。
- `conversationContext` 默认只取最近 N 条脱敏消息和结构化卡片摘要，不取完整 Slack block JSON。

## Conversation Context 能力

Policy skill 只能在已有上下文上做语义判断；如果 runtime 没有提供 thread/session 历史，prompt 再好也会像“每轮失忆”。因此生产目标必须把会话上下文作为 Slack Agent 的一等输入。

`conversationContext` 建议结构应持久化在 `session_memories.conversation_context_json`，不要只存在内存 fixture：

```json
{
  "recentTurns": [
    {
      "role": "user | assistant | system",
      "text": "用户或 bot 可见文本，已脱敏并截断",
      "messageTs": "1710000000.000100",
      "kind": "plain | agent_reply | work_item_card | confirmation_card | repo_answer | diagnosis"
    }
  ],
  "lastAssistantMessage": {
    "text": "上一条 bot 可见文本或卡片摘要",
    "kind": "work_item_card",
    "referents": [{ "kind": "issue", "number": 88, "label": "Issue #88" }]
  },
  "focus": {
    "kind": "issue | pr | work_item | preview | message | none",
    "number": 88,
    "label": "Issue #88",
    "source": "last_work_item_list | active_session | last_card | explicit_user_reference",
    "scope": "current_session"
  },
  "currentFocus": {
    "kind": "issue | pr | work_item | preview | message | none",
    "number": 88,
    "source": "last_work_item_list"
  },
  "lastWorkItemList": {
    "scope": "current_session",
    "total": 1,
    "shown": [{ "kind": "issue", "number": 88, "label": "Issue #88" }]
  }
}
```

数据来源：

- `slack_events.payload_redacted_json` 可提供最近用户消息，但只取当前 session / thread 范围。
- `slack_agent_reply_messages.text_snapshot` 可提供上一条 Agent 可见回复。
- `session_memories.lastAgentResponse` 可作为轻量兜底，但不能替代 `conversation_context_json` 里的结构化卡片摘要。
- work item list、确认卡、诊断卡和 repo answer 在写 Slack 前应同时写入 `sessionMemory` 或单独的 conversation snapshot，保留“用户刚看见了什么”的结构化摘要。
- `slack_sessions.activeWorkItemKind`、`activeWorkItemId`、`activeIssueNumber`、`activePrNumber`、`activePreviewUrl` 是当前焦点的强信号。

MySQL 持久化要求：

- `apps/gateway/src/db/schema.js` 新增 `session_memories.conversation_context_json`。
- `apps/gateway/src/db/rows/slack-row.js` 的 `memoryToRow()` / `rowToMemory()` 必须读写 `conversationContext`。
- Drizzle migration 必须包含该字段。
- `tests/helpers/gateway-store-fixture.js` 也必须保存同样结构，避免测试能过但线上 MySQL 读回丢失。
- 如果短期复用现有 JSON 字段，必须在文档和代码里标明过渡路径，并在迁移完成前保留测试覆盖。

最小可接受能力：

- 能读取当前 thread/session 最近 N 条消息，默认 N=10，可配置。
- 能知道上一条 bot 可见消息和上一条 bot 卡片展示了哪些 Issue / PR / Preview。
- 能维护当前焦点对象，例如刚展示的 `Issue #88`、刚切换的 PR、刚生成的 preview。
- 能把“这个 / 刚才那个 / 只有这一个么 / 上一条 / 继续 / 复读”解析到 conversation context。
- 上下文不足时，回复必须说明可见范围，而不是泛泛反问。例如：“我当前会话里只看到 #88；如果你指 GitHub 上分配给你的所有 open issue，我可以继续查。”
- 简单动作要直接执行：用户说“复读上一条消息”，就复读 `lastAssistantMessage.text`；不要回复“用户要求复读当前会话中的上一条消息”。

范围表达规则：

- “我的 issue / 我的 PR / 我的任务”默认先解释当前查询范围。
- 如果返回的是当前 session 范围，应说“当前会话里我看到...”。
- 如果只查了系统可见 active work items，应说“当前可继续任务里...”。
- 如果用户追问“只有这一个么”，默认沿用上一轮 `lastWorkItemList.scope` 回答，并提供扩大查询范围的动作。
- 当用户可能指 GitHub assignee / author / mentions / 当前 session 时，不要把所有含义混成一个列表；先回答当前已查范围，再提供下一步查询。

示例：

```text
用户：目前我的 issue 有哪几个？
Agent：当前会话里我看到 1 个相关 issue：Issue #88。如果你问的是 GitHub 上分配给你的所有 open issue，我可以继续按 assignee 查询。

用户：只有这一个么？
Agent：就当前会话记录来看，只有 Issue #88。要不要我再查 GitHub 上你名下的 open issues？

用户：复读上一条消息
Agent：就当前会话记录来看，只有 Issue #88。要不要我再查 GitHub 上你名下的 open issues？
```

这个能力不是简单 prompt 要求。后续开发必须同时改 gateway payload、session memory 写入和 golden cases。

## Fragment 内容

### role.md

必须说明：

- Slack Agent 是 pages-manager 的需求理解和任务管家。
- 负责自然语言理解、澄清、session 续接、任务摘要、repo 咨询入口、诊断入口和 toolCall 请求。
- 不生成 patch，不改仓库文件，不创建 branch，不创建 PR，不 merge，不部署，不读取或索要 token。
- Platform Dev 的 GitHub issue、comment、workflow 重试和 issue / PR 恢复由 gateway / worker 在确认和权限收口后执行；Site Publishing 写路径已冻结，不再创建或推进发布任务。

### lanes.md

必须定义 lane：

- `site-publishing`：识别员工个人站点创建、修改和 preview followup，并让 Gateway 返回统一退休提示；不再派发站点执行器。
- `platform-dev`：pages-manager 自身研发需求、bug、CI/CD、gateway、worker、Slack、GitHub、数据库、架构文档、部署脚本。
- `repo-question`：询问当前实现、代码位置、数据保存、workflow 触发、架构边界、影响分析、实现方案咨询。
- `unknown`：信息不足或无法安全分类。

Lane 不是权限授权。`platform-dev` 仍影响 Gateway 展示确认卡、保存 draft 和派发 worker；`site-publishing` 只用于稳定识别退休请求和历史上下文。

### intent-priority.md

必须把优先级写成明确序列，模型按从高到低判断：

1. 危险批量破坏请求：`unsupported_destructive_request`。
2. 明确关闭当前 Slack 会话：`close_session`。
3. 复读、上一条消息、刚才那条：`repeat_previous_message`。
4. 查询/切换/恢复 work item：`list_work_items`、`switch_work_item`、`reopen_work_item`。
5. 当前任务状态、失败、日志、workflow、为什么卡住：`diagnose_work_item`。
6. pages-manager 当前实现或方案咨询：`repo_question` 或 `architecture_question`。
7. 已有 active work item 上的修改意见：`modify_existing_preview` 或 `append_requirement`。
8. 明确要求创建或修改个人站点：`create_or_update_site`。
9. 明确要求创建平台研发需求：`create_platform_issue`。
10. 信息不足：`clarify`。

关键规则：

- 语气判断优先于关键词。“如果要支持 X 应该怎么做”“会不会影响 workflow”“从产品角度看方案是什么”是咨询，不是创建 issue。
- 只有“帮我实现 / 请修改 / 直接创建 issue / 按这个方案创建需求 / 开始改”才进入创建类确认。
- 有 active work item 且用户说“改成 / 加一个 / 继续调整 / preview 不满意”，优先 followup，不要新建任务。
- “关闭所有 issue / 删除我名下所有 PR / archive all my PRs”必须拒绝，不要理解为 close session 或 list。

### tool-contract.md

允许的 toolCall 名称：

| toolCall                           | 用途                     | 直接 side effect                                                                     | 确认要求                         |
| ---------------------------------- | ------------------------ | ------------------------------------------------------------------------------------ | -------------------------------- |
| `list_my_work_items`               | 查询当前用户任务         | 只读                                                                                 | 不需要                           |
| `switch_work_item`                 | 切换当前会话 active item | Platform Dev 更新 session；Site Publishing 返回退休提示                              | 需要明确编号                     |
| `reopen_work_item`                 | 恢复已关闭 issue / PR    | Platform Dev 写 GitHub；Site Publishing 返回退休提示                                 | 需要明确编号，gateway 校验可恢复 |
| `diagnose_current_work_item`       | 当前任务诊断             | 只读摘要                                                                             | 不需要                           |
| `request_retry_work_item`          | 请求重试                 | Platform Dev 写状态 / workflow；Site Publishing 返回退休提示                         | 必须按钮确认                     |
| `request_append_diagnosis_comment` | 追加诊断 comment         | Platform Dev 写 GitHub comment；Site Publishing 返回退休提示                         | 必须按钮确认                     |
| `request_human_triage`             | 转人工排查               | Platform Dev 写状态 / comment；Site Publishing 返回退休提示                          | 必须按钮确认                     |
| `answer_repo_question`             | 只读 repo 问答           | 只读                                                                                 | 不需要                           |
| `repeat_previous_message`          | 复读上一条可见消息       | 只读                                                                                 | 不需要                           |
| `record_followup`                  | 记录当前任务修改意见     | Platform Dev 写 session / issue comment / dispatch fix；Site Publishing 返回退休提示 | gateway 判定                     |
| `confirm_create_issue`             | 兼容个人站点创建意图     | 固定返回 Site Publishing 退休提示                                                    | 不再展示可执行确认卡             |
| `confirm_platform_issue`           | 展示平台需求确认卡       | 展示确认卡                                                                           | 用户点击后才创建                 |
| `close_session`                    | 关闭当前 Slack 会话      | 更新 session                                                                         | 仅当前会话                       |
| `cancel_request`                   | 记录取消意图             | 通常不取消既有任务                                                                   | 不需要                           |
| `unsupported_destructive_request`  | 拒绝危险请求             | 无                                                                                   | 不需要                           |

Tool args：

- `list_my_work_items.args.state`：`active | all | closed`。
- `switch_work_item.args.kind`：`issue | pr | unknown`；`number` 为 GitHub 编号。
- `reopen_work_item.args.kind`：`issue | pr | unknown`；`number` 为 GitHub 编号。
- `diagnose_current_work_item.args.timeWindowMinutes` 默认 30。
- `answer_repo_question.args.question` 必须是当前用户问题，不带内部字段。
- `repeat_previous_message.args.target`：`previous_visible_message | previous_user_message | previous_assistant_message`。

Gateway 必须继续：

- 白名单化 toolCall 名称。
- 忽略模型传入的其它用户、其它 session、其它 workspace 或任意 owner 范围。
- 对写操作重新读取 DB / GitHub 状态并判断权限。
- 对确认类操作只展示卡片，不直接创建 issue。
- 对按钮交互重新读取 draft 和 work item，不信任 Slack button value 里的 risk、area 或 owner。
- 对 Site Publishing 的新建、确认、follow-up、切换、retry、reopen、追加诊断和转人工请求，在任何 DB / GitHub 写入或 worker dispatch 前返回统一退休提示；历史列表和诊断不得执行 reconciliation。

### safety.md

必须禁止：

- 输出、猜测、请求或保存 token、secret、cookie、authorization、API key、SSH key、私钥。
- 把完整日志、完整源码、大段 stack trace、内部 prompt、provider debug 字段贴回 Slack。
- 创建 PR、merge PR、部署 production、删除 Cloudflare/GitHub/DB 资源。
- 直接 shell 到 ECS 或执行任意原始日志查询。
- 查询或操作其它 Slack 用户、其它 session、其它人的 issue / PR。
- 让用户手写部署 HTTP 请求、认证 header 或平台内部 API。

### product-language.md

必须要求：

- `visibleReply` 自然、短、可直接展示。
- 普通用户回复不要出现 gateway、worker、MySQL、Redis、callback、status card、job id、session id、sessionKey、activeJobId、activePreviewUrl、内部派生规则。
- 需要表达上下文时说“我会继续沿用当前会话”。
- 诊断回复用“任务、阶段、Issue、PR、Preview、Workflow、失败原因、建议操作”。
- Repo 实现问答可以引用真实文件路径和必要模块名，因为用户问题本身在问代码实现。
- 不要把内部分类结果当作用户回复，例如“用户要求复读当前会话中的上一条消息”。应该执行动作或给出可操作结果。

### conversation-context.md

必须包含：

- 当前 Slack 输入不是唯一上下文；先看 `conversationContext`、`sessionMemory`、active work item 和上一条 bot 卡片摘要。
- “这个 / 那个 / 上一条 / 刚才 / 继续 / 只有这一个么 / 还有吗 / 复读”优先解析到当前 thread/session 最近上下文。
- 上一轮刚展示 work item list 时，追问“只有这一个么 / 还有吗”默认沿用上一轮列表范围。
- 用户说“上一条消息”默认指当前 thread 中上一条可见消息；如果同时存在上一条用户消息和上一条 bot 消息，应按用户措辞区分，仍不清楚时只问一个选择题。
- 用户要求复读、总结或解释上一条消息时，直接基于 `lastAssistantMessage` 或 `recentTurns` 执行，不输出 intent 摘要。
- 当上下文不足时，要说明当前能看到的范围和下一步可查范围。

`repeat_previous_message` 解析规则：

- “我上一条消息” -> 最近一条 `role=user` 且不是当前输入的 visible turn。
- “你上一条消息” -> 最近一条 `role=assistant` 的 visible turn。
- “上一条消息 / 刚才那条” -> 当前输入之前最近一条 visible turn。
- 找不到时回复：“当前会话里我没有找到可复读的上一条消息。”不要编造。

### work-item-continuation.md

必须包含：

- 当前 session、conversation focus、issueLinks 或上一条任务卡片指向一个任务时，“这个 issue / 接着改 / 改为 / 不再修改 X / 换成 Y”默认续接当前任务。
- 续接当前任务时返回 `append_requirement` 或 `modify_existing_preview`，toolCall 返回 `record_followup`，不要返回 `confirm_platform_issue`。
- `failed` 的 Platform Dev Item 只要仍关联当前 Issue，就是 recoverable context；补充需求应写回同一个 Issue 并请求新一轮处理。
- `merged`、`closed_unmerged`、`cancelled` 不再默认续接；用户需要通过列表或明确编号恢复/查看。
- 用户明确说“另开一个 / 新建另一个 / 创建新的 issue”时，才允许在当前 thread 进入新的创建确认。

### output-schema.md

模型必须只返回 JSON object，不返回 Markdown 或代码块。字段：

```json
{
  "visibleReply": "我来查一下当前实现。",
  "lane": "site-publishing | platform-dev | repo-question | unknown",
  "intent": "create_or_update_site | modify_existing_preview | append_requirement | create_platform_issue | platform_feedback | repo_question | architecture_question | list_work_items | switch_work_item | reopen_work_item | diagnose_work_item | repeat_previous_message | status_query | cancel_request | close_session | unsupported_destructive_request | clarify",
  "toolCall": {
    "name": "answer_repo_question",
    "args": {
      "question": "当前实现是怎样的？"
    }
  },
  "workItemState": "active | all | closed",
  "employeeSlug": "hint-only",
  "siteSlug": "hint-only",
  "issueType": "type:dev | type:bug | type:docs | type:feedback | type:question | type:ci | type:ops | type:security",
  "areas": ["area:gateway"],
  "risk": "risk:low | risk:medium | risk:high",
  "agentEligible": false,
  "autoDevStatus": "pending",
  "title": "简短标题",
  "summary": "简短摘要",
  "approvalMode": "manual_required",
  "needsClarification": false,
  "clarifyingQuestion": "",
  "contextResolution": {
    "used": true,
    "source": "last_work_item_list | active_session | last_assistant_message | recent_messages | none",
    "resolvedReferents": ["Issue #88"],
    "scope": "current_session"
  },
  "sourceMessages": []
}
```

Normalization 规则：

- 缺失 `toolCall` 时可以按 `intent` 推导。
- `repo_question`、`architecture_question`、`platform_question` 必须强制 `answer_repo_question`。
- 明确 `lane=site-publishing` 或绑定历史 Site Publishing session 时，即使 `needsClarification=true`，Gateway 也直接返回退休提示，不继续追问。
- 其它 lane 在 `needsClarification=true` 时，gateway 不执行 `confirm_platform_issue`、`record_followup`、`switch_work_item`、`reopen_work_item`。
- 所有 Platform Dev issue 默认只创建 GitHub issue，不自动开发；必须由发起人在进度卡点击“自动开发”后才启动。
- `issueType=type:ci | type:ops | type:security` 默认 `risk=risk:high`。
- `contextResolution` 是可选审计字段，进入 `AgentRun.reportJson`，不直接展示给用户。

### repo-question.md

必须包含：

- 当前实现、代码位置、数据保存、workflow 触发、架构细节、影响分析、实现方案咨询，都先走只读 repo question。
- Repo question 不创建 `PlatformDevItem`，不展示平台需求确认卡。
- gateway 执行受控 `repo_tree / repo_search / repo_read`，排除 `.env*`、secret、token、私钥、`node_modules`、构建产物和大文件。
- 普通咨询默认不出现“创建需求”入口；生成改造方案后，用户明确确认才转 Platform Dev Lane。
- 回答必须基于 repo evidence，不足时说明限制。

### diagnostics.md

必须包含：

- “为什么失败 / 卡在哪 / issue 创建了 PR 没出来 / 查日志 / workflow 怎么样 / 能不能重试”优先诊断当前 work item。
- 自然语言里提到“重试 / 追加诊断 / 转人工”时，先返回诊断摘要和受控按钮，不直接执行写操作。
- 历史 Site Publishing 诊断只展示状态和 Issue / PR / Preview / Workflow 链接，不做 GitHub reconciliation，也不展示重试、追加诊断或转人工写按钮。
- 默认时间窗 30 分钟。
- 只返回摘要、关键错误、request id、内部日志链接和建议动作，不贴原始日志。

### platform-dev.md

必须包含：

- 只有明确要求“修改 pages-manager / 修复平台 bug / 创建平台 issue / 按方案实现”才进入 `platform-dev`。
- 必须输出 `issueType`、`areas`、`risk`、`agentEligible`、`autoDevStatus`。
- `area` 常用值：`area:gateway`、`area:worker`、`area:github`、`area:ci`、`area:db`、`area:slack-agent`、`area:slack-notifier`、`area:slack`、`area:docs`、`area:ops`、`area:platform`。
- CI/CD、部署、ECS、k8s、schema、权限、secret、production 相关默认高风险，但仍由同一个“自动开发”按钮手动触发。

### site-publishing.md

必须包含：

- 新建、修改、preview followup、确认、retry、reopen 和恢复个人站点任务都属于已冻结的 Site Publishing Lane。
- Agent 应保留 `lane=site-publishing` 分类和必要的站点摘要，Gateway 统一返回“站点自动发布能力已停止服务，新的发布任务不会再创建或继续执行。”，不展示可执行确认卡。
- 如果 session 绑定历史 PublishingJob，只允许列表、状态、Review 和 timeline 查询；不得切换为 active、reconcile GitHub 状态、写 comment 或 dispatch worker。
- 员工多站点、`employeeSlug`、`siteSlug` 和 `sites/<employeeSlug>/<siteSlug>/` 规则只用于解释历史数据与 dormant workflow，不代表入口仍可执行。
- Platform Dev 需求必须继续分类到 `platform-dev`，不能因 Site Publishing 退休而一并拒绝。

### product-design.md

必须包含：

- “从产品角度 / 用户角度 / 是否偏离初衷 / 方案是否合理 / 是否应该这样做”默认是咨询，不是创建需求。
- 可以给出建议、边界和取舍；需要改代码时必须等用户明确说“开始修改 / 创建需求 / 帮我实现”。
- 文案保持克制，用户心智围绕任务、Issue、PR、Preview、Workflow、失败原因和建议操作，不暴露底座服务。

## Golden Cases

`golden-cases.js` 应覆盖每个 lane、intent、toolCall 和关键反例。每条 case 至少包含：

```js
{
  name: 'consultative implementation question stays repo question',
  input: {
    text: '如果要支持 Slack Agent 读取当前 repo 代码，应该怎么实现？',
    slackSession: null,
    sessionMemory: null,
    issueLinks: [],
  },
  expect: {
    lane: 'repo-question',
    intent: 'repo_question',
    toolCall: { name: 'answer_repo_question' },
    needsClarification: false,
  },
}
```

必须覆盖：

- 个人站点新建：`创建一个个人网站，突出项目经历` -> `lane=site-publishing`，Gateway 返回 `site_publishing_retired`，不展示确认卡。
- 已有 preview 修改：`这个 preview 不满意，把标题改成中文` + 历史 Site job -> Gateway 返回 `site_publishing_retired`，不记录 follow-up。
- 我的任务：`我的 PR` -> `list_my_work_items(state=active)`，可见回复说明查询范围。
- 历史任务：`查看我已关闭的发布任务` -> `list_my_work_items(state=closed)`。
- 切换历史 Site PR / Issue：`继续 PR #68` 或 `继续 issue #60` -> Gateway 返回 `site_publishing_retired`，不更新 session 绑定。
- 恢复历史 Site PR：`reopen PR #68` -> Gateway 返回 `site_publishing_retired`，不读取或写入 GitHub 状态。
- Platform Dev 的切换与恢复继续使用 `switch_work_item` / `reopen_work_item` 原合同。
- 上一轮列表追问：上一条 bot 展示 `Issue #88`，用户问 `只有这一个么？` -> 沿用 `lastWorkItemList.scope=current_session` 回答，不反问。
- 范围扩大建议：用户问 `只有这一个么？` 且上一轮是当前会话列表 -> 回复“当前会话只有 #88”，并建议继续查 GitHub open issues。
- 上一条消息：用户说 `复读上一条消息` -> 直接复读 `lastAssistantMessage.text`，不输出 intent 摘要。
- 用户上一条消息：用户说 `你复读一下我上一条消息`，上一条用户消息是 `只有这一个么？` -> `repeat_previous_message(target=previous_user_message)`，回复原文。
- Bot 上一条消息：用户说 `你上一条消息是什么` -> `repeat_previous_message(target=previous_assistant_message)`。
- 指代解析：用户说 `继续这个`，上一条卡片只有 `PR #68` -> `switch_work_item(kind=pr, number=68)`。
- 指代歧义：上一条卡片同时有 `Issue #88` 和 `PR #90`，用户说 `继续这个` -> `needsClarification=true`，只问一个选择题。
- 批量破坏：`关闭我名下的所有 issue` -> `unsupported_destructive_request`。
- 诊断：`为什么 issue 创建了 PR 没出来？帮我查一下日志` -> `diagnose_current_work_item`。
- Repo 咨询：`sessions 是怎么保存的？` -> `repo_question`。
- 咨询里带修改词：`如果后续要修改 CI workflow，会影响原先 CF 那条线吗？` -> `repo_question`。
- 明确平台需求：`帮我实现 Slack Agent 的 repo 只读问答` -> `create_platform_issue` / `confirm_platform_issue`。
- 平台反馈：`Slack Agent 经常误判，记录一个反馈` -> `platform_feedback` 或 `create_platform_issue` with `type:feedback`，确认后先创建 issue，等待进度卡手动触发自动开发。
- CI 高风险：`修改 pages-manager 的 CI workflow 和 ECS 部署脚本` -> `risk:high`、`autoDevStatus=pending`。
- 取消意图：`取消` -> `cancel_request`，不直接取消已有 issue。
- 关闭当前会话：`这个 preview 不用了` -> `close_session`。

Golden case 测试应同时跑：

- deterministic fallback 输出。
- prompt compiler 内容是否包含必要 fragment。
- normalization 后输出是否符合 schema。
- gateway tool routing 是否和模型输出保持一致。
- `conversationContext` 是否被带进 prompt，且指代类 case 不退化为泛泛澄清。

模型集成测试可用 fixture 模拟 company gateway 返回，不需要真实联网。

## 迁移计划

### Phase 1：文档和测试护栏

- 新增本文档。
- 从现有 `tests/apps/slack-agent/index.test.js` 抽出 golden cases。
- 增加 `SLACK_AGENT_POLICY_PACKAGE_VERSION` 常量，并在已有 `agent_runs.policy_version` 字段记录该版本；不新增 DB 列。
- 定义 `conversationContext` 输入结构和 fixture，但第一阶段可以只由测试构造，不改变线上 payload。
- 保持 `buildSlackAgentMessages()` 现有输出文案基本不变。

### Phase 2：Prompt fragments

- 创建 `apps/slack-agent/src/policy/fragments/`。
- 把 `analysis.js` 中内联 system prompt 按 fragment 迁移。
- 新增 compiler 单测，断言 system prompt 包含所有 required fragment。
- `analysis.js` 只保留 deterministic fallback、normalization 和对 compiler 的调用。
- 第一版 fragment 可以以 JS 字符串数组落地，避免 Node ESM 读取 Markdown 文件带来打包差异；如果改成 `.md` 文件读取，必须补 ECS / Actions 产物包含检查。

### Phase 3：Schema 和 normalization 收敛

- 把 lane、intent、toolCall、issueType、area、risk 枚举移到 `policy/schema.js`。
- Gateway 的 `apps/gateway/src/slack/intents.js` 与 Slack Agent schema 共享或通过测试保持一致。
- `slackAgentToolName()` aliases 继续保留，但新 toolCall 必须先进 schema 和 golden cases。

### Phase 4：Runtime observability

- `AgentRun` 记录 `policyPackageVersion`、`modelProvider`、`modelName`、`intent`、`toolCall.name`、`needsClarification`。
- prompt 日志继续脱敏，只记录必要摘要。
- 增加误判复盘字段：fallback intent、model intent、final toolCall。
- `apps/gateway/src/slack/agent-run-records.js` 的 `slackAgentRunModelPatch()` 应把 `policyVersion` 带入 `completeAgentRun()` patch；值来自 Slack Agent analysis，不由 gateway 猜。

### Phase 5：Conversation context runtime

- 在 gateway 组装 Slack Agent payload 前构造 `conversationContext`。
- 增加 `session_memories.conversation_context_json`、row mapping、migration 和 fixture 支持。
- 从 `slack_events` 读取当前 session / thread 最近用户消息；只传脱敏和截断后的文本。
- 从 `slack_agent_reply_messages` 或 `session_memories.lastAgentResponse` 读取上一条 bot 可见回复。
- work item list、确认卡、诊断卡、repo answer 写 Slack 前，同步写结构化摘要到 session memory，例如 `lastWorkItemList`、`lastAssistantMessage`、`focus`。
- 收到用户消息后先把当前 user turn 追加到 `recentTurns`；最终 `replyText` 生成后再追加 assistant turn。
- 不把完整 Slack block JSON、完整日志或完整源码写进 prompt；只写用户可见摘要和 referents。
- 增加 `repeat_previous_message` tool handler，并为“只有这一个么 / 复读上一条消息 / 继续这个”增加 gateway + Slack Agent 集成测试。

### Phase 6：减少 gateway 关键词分支

- 保留 gateway 的 help / ping / empty / Slack 签名 / 幂等 / dangerous bulk destructive hard block。
- 自然语言的查询、切换、恢复、诊断、followup 主要依赖 Slack Agent toolCall。
- Gateway 仍保留模型不可用兜底，但兜底行为必须由 golden cases 覆盖。

## 文件级实施步骤

后续开发按以下顺序落地，避免一次 PR 同时改 prompt、schema、DB 和 gateway 行为：

1. 新建 `apps/slack-agent/src/policy/package.js`，只导出版本和 fragment 顺序。
2. 新建 `apps/slack-agent/src/policy/schema.js`，搬运 lane、intent、toolCall、issueType、area、risk 枚举；暂时不要删除 gateway 侧枚举。
3. 新建 `apps/slack-agent/src/policy/compiler.js`，把当前 `buildSlackAgentMessages()` 的 system 文本等价迁移进去。
4. 修改 `apps/slack-agent/src/analysis.js`，让 `buildSlackAgentMessages()` 调 compiler；保持函数签名不变，避免影响 `model-provider.js`。
5. 在 analysis 结果中追加 `policyVersion`，值为 `SLACK_AGENT_POLICY_PACKAGE_VERSION`。
6. 修改 `apps/gateway/src/slack/agent-run-records.js`，让 `slackAgentRunModelPatch()` 同步 `policyVersion`。
7. 新建 `apps/gateway/src/slack/conversation-context.js`，从 session、memory、recent deliveries、reply messages 和 work item links 组装脱敏上下文。
8. 修改 `apps/gateway/src/slack/agent-turn.js` 的 `slackAgentRequestPayload()`，传入 `conversationContext`。
9. 在 `session_memories` 增加 `conversation_context_json`，同步改 schema、row mapping、migration 和 fixture。
10. 在 `conversationContext` 中保存 `lastAssistantMessage`、`lastWorkItemList`、`currentFocus` 和 `recentTurns`。
11. 增加 `repeat_previous_message` intent、toolCall alias 和 gateway handler。
12. 抽出 `tests/apps/slack-agent/golden-cases.js`，让现有 deterministic 单测复用 case。
13. 增加 gateway 侧 routing 测试，验证模型即使返回冲突 toolCall，repo question 仍只读、危险批量仍拒绝。
14. 增加 conversation context 测试，覆盖“只有这一个么”“复读上一条消息”“继续这个”。
15. 最后再考虑删除 `analysis.js` 内重复的 prompt 字符串和重复枚举。

兼容要求：

- `/internal/slack-agent/turn` 响应 schema 保持兼容，只允许新增字段。
- `/internal/slack-agent/analyze` 如果仍保留测试入口，也要带同样的 `policyVersion`。
- 现有 deterministic provider 继续可用，便于本地测试和模型不可用兜底。
- `policyVersion` 缺失时，gateway 不应失败；只在 `AgentRun` 记录里留空。
- Platform Dev 确认卡和按钮行为保持不变；Site Publishing 确认卡与写按钮统一替换为退休提示，并由对应 golden / Gateway 回归用例覆盖。
- `conversationContext` 缺失时，Slack Agent 可以退回原行为，但指代类输入应说明上下文不足和可见范围。

## 回滚策略

如果上线后发现模型误判率上升，回滚优先级如下：

1. 通过配置或代码把 compiler 切回旧 inline prompt 文本，保持 schema 和 tests 不动。
2. 保留 `policyVersion` 记录，方便区分旧 prompt 和新 package 的线上结果。
3. 不回滚 gateway 侧权限收口；任何误判都只能影响可见回复或确认卡，不能绕过 side effect 防线。
4. 把误判 Slack 文本加入 golden cases，再重新调整 fragment。

## 开发验收清单

- 文档索引已链接本文。
- `apps/slack-agent/src/policy/` 存在 package、compiler、schema、fragments 和 golden cases。
- `buildSlackAgentMessages()` 不再内联长 system prompt。
- 所有 fragment 改动都有 golden case 或现有 case 覆盖。
- Slack Agent payload 包含脱敏后的 `conversationContext`。
- 上一条 bot 消息、最近 work item list 和当前 focus 能进入 prompt。
- “只有这一个么”“复读上一条消息”“继续这个”有端到端或近端集成测试。
- `pnpm test -- tests/apps/slack-agent/index.test.js` 通过。
- Gateway tool routing 测试覆盖 repo question、Platform Dev confirmation、dangerous bulk、diagnosis、switch、reopen，以及 Site Publishing 全部写入口的退休 guard。
- `AgentRun.policy_version` 能记录 policy package version。
- 没有任何 prompt、日志、测试 fixture 输出真实 secret、token、cookie 或内部凭据。

## 非目标

- 不把 Slack Agent 变成 Coding Agent。
- 不让 Slack Agent 直接读取 GitHub / Cloudflare / Slack write token。
- 不绕过 gateway 确认卡、按钮交互、权限校验或状态机。
- 不要求用户使用 `/issue`、`issue:`、`page:` 等命令。
- 不把 repo 问答变成 IDE 级源码浏览器；它仍是基于受控 evidence 的 Slack 咨询能力。
