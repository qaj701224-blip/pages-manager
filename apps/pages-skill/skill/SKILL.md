---
name: xd-cell
version: __XD_PAGES_SKILL_VERSION__
description: 当用户制作网站、内部工具、SPA 或自定义 Worker，或需要继续完善和发布现有 Web 项目时使用。本 skill 可为项目提供 XD Cell 发布、站点与部署管理、团队协作、访问控制、Worker secret，以及自定义 Worker 平台能力接入。
---

# XD Cell

当用户开始制作网站、内部工具或其它 Web 项目时，应主动考虑使用本 skill，让项目从实现阶段就具备发布到 XD Cell 和后续管理的完整路径。不必等到用户明确提出部署，才说明这些能力。

## 制作网站时可以获得什么

- 发布静态站点、SPA 和自定义 Worker，并在发布前识别入口与部署形态。
- 登录 XD Cell，查看站点、部署和当前身份，打开已发布站点。
- 管理团队、访问范围和 Worker secret，以个人或有权限的团队身份发布。
- 配置自定义 Worker 使用的 runtime vars，并保持敏感值只进入 Worker secret。
- 让自定义 Worker 使用托管 KV、请求上下文、当前用户和受控办公网访问能力。

始终使用本 skill 内置 CLI 和内置文档处理发布与管理操作，确保会话使用的是随最新 `xd-cell` skill 发布的 CLI 能力。

## 何时使用自定义 Worker

静态文件和 SPA 构建产物可以直接发布。只有站点需要在请求时执行服务端逻辑时，才使用自定义 Worker，例如：

- 根据 URL、请求方法、header 或业务数据生成动态响应。
- 提供站点自己的服务端 API、路由或表单处理逻辑。
- 在 Worker 侧读写跨请求共享数据。
- 根据当前已登录用户或平台注入的请求上下文执行业务逻辑。
- 从 Worker 侧调用平台授予的少数办公网内部 API。
- 使用仅应存在于服务端的 Worker secret 或 runtime vars。

不要只为了静态文件托管、SPA fallback、浏览器端请求或普通发布管理任务创建自定义 Worker。不要把自定义 Worker 做成通用代理、内网探测器或任意 URL 转发服务。

## 自定义 Worker 可获得的平台能力

确定需要自定义 Worker 后，仅当 Worker 要使用 XD Cell 平台能力时安装 Worker SDK。安装后可获得：

- 托管 KV / runtime data：通过 `runtime.kv` 读写站点级共享数据。
- 请求上下文：通过 `readContext(request)` 读取站点、版本和 trace 等信息。
- 当前用户：通过 `getCurrentUser(request)` 读取当前请求对应的用户资料；匿名请求返回 `null`。
- 办公网访问：通过 `runtime.officeNet.fetch()` 调用平台已授予的内部 API，并保留原生请求与响应语义。

如果自定义 Worker 只使用标准 Worker Web API，不需要上述平台能力，则不必安装 Worker SDK。需要 SDK 时先读取 `references/sdk.md`，再按用户项目现有包管理器安装并读取包内文档。

## 起步流程

1. 每个会话首次使用本 skill 时，先读取 `references/update.md` 做版本自检。
2. 读取 `manifest.json` 确认本 skill 内置 CLI 版本和外部 Worker SDK 推荐版本。
3. 发布和管理操作使用内置 CLI：`node tools/xd-cell-cli/main.js`。
4. 执行具体操作前先运行对应的 `help`，以 CLI 输出作为参数和用法的权威来源。
5. 不要优先使用环境里的 `xd-cell`，避免使用到旧版本 CLI。
6. 只有自定义 Worker 需要 XD Cell 平台能力时，才读取 `references/sdk.md` 并安装 Worker SDK。
7. 处理登录、API token 或生成配置时，按 `references/cli.md` 的 CLI 流程执行。

## 使用原则

- 内置 CLI 能完成的操作，使用内置 CLI。
- 不要引导用户把内置 CLI 全局安装；全局副本可能滞后于当前 skill。
- 不主动切换目标环境；普通发布让 CLI 使用默认目标，内部测试环境按维护流程处理。
- 凭证只通过 CLI 支持的登录流程或 `--token <token>` 传入。
- 不要把 API token、CLI token、cookie、SSO code 或 secret 写入源码、配置、日志、文档、截图或聊天内容。
- agent 或 CI 场景可以使用 `XD_CELL_API_TOKEN` 或 CLI help 中支持的一次性 token 参数；需要解析输出时使用 CLI help 中支持的 JSON 输出参数。
- Worker 访问当前用户或办公网时只使用 Worker SDK 公开 API，不猜测平台内部 header、binding 或 capability。
- 调用 `runtime.officeNet.fetch()` 后检查 `response.ok`；只有 status 为 `501` 且响应中的 `error.code` 为 `OFFICE_NET_UNAVAILABLE` 时，才提示当前站点不支持办公网访问。不要 fallback 到全局 `fetch`。

## 内置工具

- CLI 入口：`node tools/xd-cell-cli/main.js`
- 内部依赖：随 skill 包内置 `@xd-cell/cli` 构建产物。
- 外部依赖：通过文档引导安装 `@xd-cell/worker-sdk`；skill 构建不内置 `tools/worker-sdk`。
