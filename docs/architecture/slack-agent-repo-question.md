# Slack Agent Repo Question

本文件是 [slack-agent-runtime.md](./slack-agent-runtime.md) 的 repo 只读问答拆分页。Slack session、turn 协议和 notifier 细节仍以 runtime 文档为准。

## 产品定位

Platform Dev 场景必须支持“先问清楚当前实现，再决定是否改代码”。用户问“sessions 怎么保存的”“这个 workflow 哪里触发”“为什么这里没有 PR”等咨询类问题时，Slack Agent 应通过模型语义判断返回 `intent=repo_question` / `toolCall.name=answer_repo_question`，由 gateway 在当前仓库内执行受控只读检索后回答。

产品规则：

- 不创建 `PlatformDevItem`，不展示“确认平台需求”卡片。
- 不发送“正在整理需求...”占位；只用 reaction 表示处理中。
- 回答必须基于 repo 检索结果，并列出最相关文件路径。
- 如果检索不足以回答，应说明“我没有找到足够依据”，而不是编造。
- 如果用户随后明确说“按这个改 / 创建 issue / 修复它”，才转入 Platform Dev Lane。
- 语义归类由 Slack Agent 的模型输出负责；gateway 不用字符串关键词替模型做产品判断，只校验工具名、权限、幂等和 side effect 是否需要确认。代码中的 deterministic 规则只服务本地测试、smoke 和模型不可用兜底。

## 工具边界

- 只允许读当前 repo 的受控 snapshot。
- 禁止读取 `.env*`、secret、token、私钥、证书、cookie、本地部署配置和 `node_modules`。
- 单轮递归检索必须限制文件数、单文件大小、总读取量和输出长度。
- 回答不能包含原始 secret、完整日志或大段源码；只返回摘要、关键依据和文件引用。
- 写 Issue、写 comment、重试 workflow、创建 PR、合并和部署仍必须走按钮或确认卡。

## 运行形态

```text
Slack 用户提问
  -> Slack Agent 通过模型输出 repo_question / answer_repo_question
  -> gateway 执行受控 repo snapshot search/read
  -> gateway 将裁剪后的 evidence 交给 Slack Agent repo-answer 生成自然回答
  -> gateway 回 Slack；模型不可用时使用本地确定性摘要兜底
  -> 用户可继续追问，或明确要求创建修复需求
```

当前实现使用受控递归检索：排除 `.git`、`node_modules`、`.env*`、secret/token/cookie/private-key 相关路径和构建产物，只读取受支持的文本文件，按问题词、路径和内容打分选择少量依据文件。gateway 只把文件路径、行号和短 excerpt 发给 `apps/slack-agent` 的 `/internal/slack-agent/repo-answer`，由模型基于 evidence 生成回答；如果该接口未配置或失败，则返回本地确定性摘要。ECS 镜像 / 远端构建目录必须包含 `apps`、`packages`、`docs`、`scripts` 和 `.github`，否则线上无法回答 workflow / 文档类问题。

企业级目标应继续升级为 repo index + 多轮 search/read，让 Agent 可以先检索、再读取更具体文件、再回答。无论底层检索如何演进，对用户都保持同一心智：问问题得到答案，提改造才创建 issue。
