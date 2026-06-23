# Slack Agent Repo Question

本文件是 [slack-agent-runtime.md](./slack-agent-runtime.md) 的 repo 只读问答拆分页。Slack session、turn 协议和 notifier 细节仍以 runtime 文档为准。

## 产品定位

Platform Dev 场景必须支持“先问清楚当前实现，再决定是否改代码”。用户问“sessions 怎么保存的”“这个 workflow 哪里触发”“为什么这里没有 PR”等咨询类问题时，Slack Agent 应通过模型语义判断返回 `intent=repo_question` / `toolCall.name=answer_repo_question`，由 gateway 在当前仓库内执行受控只读检索后回答。

产品规则：

- 不创建 `PlatformDevItem`，不展示“确认平台需求”卡片。
- 不发送“正在整理需求...”占位；只用 reaction 表示处理中。
- 回答必须基于 Agent 主导的 repo 调研计划和 gateway 返回的 repo evidence，并列出最相关文件路径。
- 如果检索不足以回答，应说明“我没有找到足够依据”，而不是编造。
- 普通咨询默认只展示“继续深挖 / 查看依据 / 生成改造方案”，不展示“创建需求”入口。
- 只有用户明确说“按这个改 / 创建 issue / 修复它”，或点击“生成改造方案”后确认“按方案创建需求”，才转入 Platform Dev Lane。
- 语义归类由 Slack Agent 的模型输出负责；gateway 不用字符串关键词替模型做产品判断，只校验工具名、权限、幂等和 side effect 是否需要确认。代码中的 deterministic 规则只服务本地测试、smoke 和模型不可用兜底。
- Slack Agent 可以针对当前 repo snapshot 主导调研，但 Slack 不是 IDE，不直接贴完整源码。对用户表达为“基于当前相关 repo evidence”，并在依据不足时说明限制。

## 工具边界

- 只允许读当前 repo 的受控 snapshot。
- 禁止读取 `.env*`、secret、token、私钥、证书、cookie、本地部署配置和 `node_modules`。
- `repo_tree` 可以暴露安全路径列表和目录概览；`repo_search` 可以扫描全量安全 snapshot；`repo_read` 只能读取安全文本文件的有限片段。
- 单轮调研必须限制文件数、单文件大小、总读取量和输出长度。
- 回答不能包含原始 secret、完整日志或大段源码；只返回摘要、关键依据和文件引用。
- 写 Issue、写 comment、重试 workflow、创建 PR、合并和部署仍必须走按钮或确认卡。

## 运行形态

```text
Slack 用户提问
  -> Slack Agent 通过模型输出 repo_question / answer_repo_question
  -> gateway 提供安全 repo_tree 给 Slack Agent
  -> Slack Agent 调用 repo-plan 决定 repo_search query 和 repo_read path
  -> gateway 执行受控 repo_search / repo_read
  -> gateway 将裁剪后的 evidence 和调研计划交给 Slack Agent repo-answer
  -> gateway 回 Slack；模型不可用时使用本地确定性摘要兜底
  -> 用户可继续深挖、查看依据、生成改造方案
  -> 用户确认后才转 Platform Dev Lane 创建需求
```

当前实现有两个内部 Agent 接口：

- `/internal/slack-agent/repo-plan`：输入用户问题、上一轮上下文和安全 repo tree；输出 `queries`、`readPaths`、`mode` 和下一步建议。它只负责调研计划，不回答用户。
- `/internal/slack-agent/repo-answer`：输入用户问题、调研计划和 gateway 裁剪后的 evidence；输出面向 Slack 的简洁调研报告。

gateway 执行受控 repo 工具：排除 `.git`、`node_modules`、`.env*`、secret/token/cookie/private-key 相关路径和构建产物，只读取受支持的文本文件，按 Agent query、历史 evidence、路径和内容打分选择依据文件。gateway 只把文件路径、行号和短 excerpt 发给 `apps/slack-agent`；如果 Agent 接口未配置或失败，则返回本地确定性摘要。ECS 镜像 / 远端构建目录必须包含 `apps`、`packages`、`docs`、`scripts` 和 `.github`，否则线上无法回答 workflow / 文档类问题。

`session_memories.repo_question_context_json` 保存同一 Slack session 的 repo 问答上下文。它只记录最近问题、答案摘要、evidence path、有限 evidence snippet、模式和时间，不保存完整源码或原始日志。二次追问时 gateway 会把上一轮问题、摘要和 evidence path 作为上下文交给 `/repo-plan` 和 `/repo-answer`，并优先把上一轮 evidence 及其相邻模块纳入候选检索。

每次 repo 问答回复会带三个默认受控动作：

- 继续深挖：仍是只读查询，扩大 evidence 数量和 excerpt 数量，把结果发回当前 Slack thread。
- 查看依据：展示本轮有限代码片段或文件路径，帮助用户理解回答来源；不展开完整文件。
- 生成改造方案：仍是只读查询，要求 Agent 输出目标、改动位置、步骤、测试和风险。只有这个方案回复里才出现“按方案创建需求”入口。

“按方案创建需求”只把上一轮方案整理成 Platform Dev confirmation card；真正创建 GitHub issue 仍需用户点击确认按钮。这样用户可以先完成咨询和调研，再决定是否进入自动开发。

ECS 运行时必须设置 `PAGES_REPO_ROOT=/app`，让 gateway 从容器内完整 repo snapshot 检索。否则如果进程 cwd 落在某个 package 目录，repo 问答会只能看到局部代码，导致回答缺失 workflow / docs / scripts 证据。

后续如果引入持久化 repo index、embedding 或代码图谱，也必须保持同一产品心智：Agent 主导调研，gateway 执行安全读操作；问问题得到答案，生成方案后才出现创建需求入口，确认后才进入 Issue / PR / 自动开发。
