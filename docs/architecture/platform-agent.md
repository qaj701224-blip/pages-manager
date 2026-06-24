# Platform Agent

本文是 `Platform Agent` workflow 和 `scripts/platform-agent-coding.mjs` 的当前行为真相源。它描述平台代码自动开发 executor 的能力边界，不覆盖个人站点发布 executor。

## 入口

`Platform Agent` 由 `.github/workflows/platform-agent.yml` 手动 dispatch 或由 gateway 调度。workflow 会从可信 checkout 复制 `scripts/platform-agent-coding.mjs`，再在目标 base ref 上创建或复用 `feat/` 分支。

executor 只负责在当前 repo 工作区产生平台代码改动和 `.pages-artifacts/platform-agent-report.json`。后续 workflow 只读取这个工作区的 `git diff`，跑 secret scan、`pnpm lint`、`pnpm test`，再提交分支并打开或更新 PR。agent 不直接合并 `master`。

## 模型执行协议

`platform-agent-coding.mjs` 默认按工具循环执行。启动时 executor 会按文件名排序读取 `scripts/platform-agent-skills/*.md`，并把这些短文档作为 `preloadedSkills` 放进初始模型上下文。该目录用于预制 coding skill，例如项目规则、代码地图和验证策略；新增或修改 skill 时必须同步本文档或就近说明。

gateway / worker 可以通过 workflow inputs 向 executor 传入 `prNumber`、`headSha`、`reviewContext`、`memoryContext`、`statusContext` 和 `followupContext`。workflow 会映射为 `PR_NUMBER`、`HEAD_SHA`、`REVIEW_CONTEXT`、`MEMORY_CONTEXT`、`STATUS_CONTEXT`、`FOLLOWUP_CONTEXT` 环境变量，executor 会截断后放进初始模型上下文，并在 report 里只记录是否收到这些上下文。Review Agent 的 blocking / unknown comment 会被写入 Slack session memory，并在自动修复轮次传给 Platform Agent；Slack / issue follow-up 会作为 `followupContext` 传入，让 fix round 知道本轮为什么修。

模型每轮必须返回 JSON object，支持的 action 是：

| action        | 作用                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `search`      | 用 `rg` 搜索仓库内容，排除 `.git`、`.pages-artifacts`、`node_modules`、`.env*` 和 `wrangler.toml` |
| `read_file`   | 读取 repo-relative 文件片段，默认单次最多 220 行                                                  |
| `apply_patch` | 应用 unified git diff；执行前校验 diff 路径                                                       |
| `run_command` | 运行受限只读命令：版本查询和少量只读 `git` 子命令                                                 |
| `git_diff`    | 返回当前工作区 diff 摘要                                                                          |
| `git_status`  | 返回 `git status --short`                                                                         |
| `finish`      | 结束循环，写 report，并要求工作区已有可提交改动                                                   |

为了兼容旧模型输出，executor 仍接受一次性完整文件 JSON：

```json
{
  "files": [
    {
      "path": "repo/relative/path",
      "content": "complete file content"
    }
  ],
  "summary": "short summary",
  "tests": ["test command"]
}
```

旧格式仍会走相同的路径、secret、文档同步和 Markdown 行数校验。

## 安全边界

executor 不向模型开放 shell。`run_command` 必须使用 `cmd` 加 `args` 数组；`node`、`pnpm`、`npm`、`npx` 只允许版本查询，`git` 只允许 `diff`、`status`、`show`、`ls-files`、`grep` 这类只读子命令，并拒绝 credential / config / remote / submodule / worktree 等敏感或变更参数。子进程环境会移除名称中包含 token、secret、key、password、cookie、auth、credential 的变量；工具输出也会对当前进程中的敏感变量值做基础脱敏和截断。完整 `pnpm lint` / `pnpm test` 只由 workflow 在清空 agent callback / coding token env 后执行。

以下路径不能读写或提交：

- `.env`、`.env.*`、`*.env`、任意目录下的 `.env` / `.env.*` / `*.env`
- `.pages.json`
- `wrangler.toml`
- `.git/`
- `node_modules/`
- `.pages-artifacts/`
- `dist/`
- `build/`

以下路径属于高风险，只有 `risk:high` 且 gate approved 时才能修改：

- `.github/`
- `k8s/`
- `deploy/`
- `docker/`
- `Dockerfile`
- `scripts/deploy*`
- `scripts/k8s*`
- `scripts/put-*`
- 路径中包含 `/deploy` 或 `/k8s`

workflow 不把 `AGENT_CODE_API_KEY`、`PAGES_CALLBACK_TOKEN` 或 `GITHUB_TOKEN` 放进 job 级环境。coding agent、callback、push / PR 等步骤按需注入对应 token；运行模型产物检查时会显式清空这些敏感 env，避免生成代码在 `pnpm lint` / `pnpm test` 中读取自动化凭据。

每次 patch 或命令执行后，executor 会重新扫描当前改动路径和文件内容。发现 forbidden path、高风险未批准路径或 secret-looking 内容时，工具 observation 会把错误返回给模型；模型可以继续修复。`finish` 时仍会做最终校验。

## 文档一致性

平台代码、workflow、脚本或行为改动必须同步文档。executor 在最终 `finish` 或旧格式文件落盘前会检查：如果本次改动包含非文档文件，也必须包含文档改动。

普通 Markdown 文档必须保持在 700 行以内。`docs/superpowers/` 是历史计划记录，不作为当前行为真相源，行数规则不约束该目录。

## 报告与失败

成功时 executor 写入 `.pages-artifacts/platform-agent-report.json`，包含：

- `platformDevItemId`
- issue type、area、risk 和 gate 状态
- `generatedFiles`
- `toolMode`
- 工具 `steps`
- `summary`
- `tests`
- `modelName`
- `contextReceived`

模型响应无有效 action、旧格式文件无效、超过最大轮次、`finish` 时无仓库改动等情况会写 `.pages-artifacts/platform-agent-debug.json`。debug 文件只记录响应形状和 token 用量等诊断信息，不写入模型产出的完整文件内容。
