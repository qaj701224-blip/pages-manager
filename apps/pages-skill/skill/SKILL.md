---
name: xd-cell
version: __XD_PAGES_SKILL_VERSION__
description: 围绕 `@xd-cell/skill` 内置的 `@xd-cell/cli` 和外部 Worker SDK 文档指引使用 XD Cell：发布站点、查看部署、配置访问规则，并在 Worker 代码中接入 runtime helper。适用于用户要求部署静态站点、SPA 构建产物、自定义 Worker，使用 xd-cell CLI，管理 XD Cell 托管站点，或接入 XD Cell Worker runtime helper 的场景。
---

# XD Cell

使用 `@xd-cell/skill` 调用内置 `@xd-cell/cli` 发布和管理 XD Cell 站点。业务自定义 Worker 需要 runtime helper 时，按 `references/sdk.md` 文档式引导安装并读取外部 npm 包 `@xd-cell/worker-sdk`；skill 只维护版本兼容和使用边界说明，不复制 Worker SDK 领域产物。

始终使用本 skill 内置 CLI 和内置文档处理发布与管理操作，确保会话使用的是随最新 `xd-cell` skill 发布的 CLI 能力。

## 起步流程

1. 每个会话首次使用本 skill 时，先读取 `references/update.md` 做版本自检。
2. 读取 `manifest.json` 确认本 skill 内置 CLI 版本和外部 Worker SDK 推荐版本。
3. 发布和管理操作使用内置 CLI：`node tools/xd-cell-cli/main.js`。
4. 执行具体操作前先运行对应的 `help`，以 CLI 输出作为参数和用法的权威来源。
5. 不要优先使用环境里的 `xd-cell`，避免使用到旧版本 CLI。
6. 只有命中 Worker SDK 触发条件时，才先读 `references/sdk.md`。
7. 处理登录、API token 或生成配置时，按 `references/cli.md` 的 CLI 流程执行。

## Worker SDK 触发条件

需要编写、迁移或修改业务自定义 Worker，并且 Worker 运行时要访问 XD Cell 托管资源时，才使用 Worker SDK：

- 读写平台托管 KV / runtime data，例如 `runtime.kv.get()`、`runtime.kv.put()`、`runtime.kv.delete()`。
- 读取平台 router 注入的业务上下文，例如通过 `readContext(request)` 获取站点、版本、用户或 trace 信息。
- 将旧草案 SDK/import 迁移到 `@xd-cell/worker-sdk`。
- 业务希望用接近 Cloudflare Worker KV 的心智访问平台资源，而不直接处理 gateway、capability 或底层 binding。

以下场景不要引入 Worker SDK：

- 只是发布静态站点、SPA、查看状态、打开站点或配置访问控制。
- 项目没有自定义 Worker 入口。
- 浏览器端代码想直接访问平台 KV。
- 需要登录、发布、OpenAPI client、token 管理或尚未公开的 D1/R2 能力。

## 使用原则

- 内置 CLI 能完成的操作，使用内置 CLI。
- 不要引导用户把内置 CLI 全局安装；全局副本可能滞后于当前 skill。
- 不主动切换目标环境；普通发布让 CLI 使用默认目标，内部测试环境按维护流程处理。
- 凭证只通过 CLI 支持的登录流程或 `--token <token>` 传入。
- 不要把 API token、CLI token、cookie、SSO code 或 secret 写入源码、配置、日志、文档、截图或聊天内容。
- agent 或 CI 场景可以使用 `XD_CELL_API_TOKEN` 或 CLI help 中支持的一次性 token 参数；需要解析输出时使用 CLI help 中支持的 JSON 输出参数。

## 内置工具

- CLI 入口：`node tools/xd-cell-cli/main.js`
- 内部依赖：随 skill 包内置 `@xd-cell/cli` 构建产物。
- 外部依赖：通过文档引导安装 `@xd-cell/worker-sdk`；skill 构建不内置 `tools/worker-sdk`。
