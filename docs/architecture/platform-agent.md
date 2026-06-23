# Platform Agent

本文是 `Platform Agent` workflow 和 `scripts/platform-agent-coding.mjs` 的当前行为真相源。它描述平台代码自动开发 executor 的能力边界，不覆盖个人站点发布 executor。

## 入口

`Platform Agent` 由 `.github/workflows/platform-agent.yml` 手动 dispatch 或由 gateway 调度。workflow 会从可信 checkout 复制 `scripts/platform-agent-coding.mjs`，再在目标 base ref 上创建或复用 `feat/` 分支。

executor 只负责在工作区产生平台代码改动和 `.pages-artifacts/platform-agent-report.json`。后续 workflow 会跑 secret scan、`pnpm lint`、`pnpm test`，再提交分支并打开或更新 PR。agent 不直接合并 `master`。

## 模型执行协议

`platform-agent-coding.mjs` 默认按工具循环执行。启动时 executor 会按文件名排序读取 `scripts/platform-agent-skills/*.md`，并把这些短文档作为 `preloadedSkills` 放进初始模型上下文。该目录用于预制 coding skill，例如项目规则、代码地图和验证策略；新增或修改 skill 时必须同步本文档或就近说明。

gateway / worker 可以通过 workflow inputs 向 executor 传入 `reviewContext`、`memoryContext` 和 `statusContext`。workflow 会映射为 `REVIEW_CONTEXT`、`MEMORY_CONTEXT`、`STATUS_CONTEXT` 环境变量，executor 会截断后放进初始模型上下文，并在 report 里只记录是否收到这些上下文。Review Agent 的 blocking comment 会被写入 Slack session memory，并在自动修复轮次传给 Platform Agent。

模型每轮必须返回 JSON object，支持的 action 是：

| action        | 作用                                                                                              |
| ------------- | ------------------------------------------------------------------------------------------------- |
| `search`      | 用 `rg` 搜索仓库内容，排除 `.git`、`.pages-artifacts`、`node_modules`、`.env*` 和 `wrangler.toml` |
| `read_file`   | 读取 repo-relative 文件片段，默认单次最多 220 行                                                  |
| `apply_patch` | 应用 unified git diff；执行前校验 diff 路径                                                       |
| `run_command` | 运行受限命令：`node`、`pnpm`、`npm`、`npx`、`rg`、`git`                                           |
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

executor 不向模型开放 shell。`run_command` 必须使用 `cmd` 加 `args` 数组，且 `git` 只允许 `diff`、`status`、`show`、`ls-files`、`grep` 子命令。子进程环境会移除名称中包含 token、secret、key、password、cookie、auth、credential 的变量；工具输出也会对当前进程中的敏感变量值做基础脱敏和截断。

以下路径不能读写或提交：

- `.env`、`.env.*`、任意目录下的 `.env` / `.env.*`
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
