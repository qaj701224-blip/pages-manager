# ADR 0001: 取舍、测试与参考资料

> 本文从 `docs/adr/0001-pages-v2-artifact-detection.md` 拆分而来；原路径保留为 ADR 索引。

## 被拒方案

### 保留 `artifactKind` 但降级为内部字段

拒绝。只要 CLI、开发期 OpenAPI 合约、skill 或 AI 文档继续出现 `artifactKind`，用户和 AI 就会被迫选择 `static/spa/worker`。这会把实现细节继续固化为产品概念。

如果实现内部需要短暂识别旧测试脚本的 `--artifact-kind`，也只能作为开发迁移工具，不能进入 README、开发期 OpenAPI 合约、skill、普通 help 或 AI 示例。

### 新增第四种 `artifactKind = worker-with-assets`

拒绝。它能修补当前能力缺口，但会让 artifact 枚举继续扩张，并且仍然没有解决 `static` / `spa` 本质只是 fallback 差异的问题。

### 使用 `fallback: spa | 404` 作为公开枚举

拒绝。`spa` 描述的是站点类型，会让用户和 AI 回到“我应该选择哪类站点”的心智；`404` 描述的是 HTTP 状态码，不是配置行为。`index | not-found` 更直接描述“没有真实文件时返回什么”，心智更轻，也更适合作为长期公开配置。

### 长期保留兼容转换层

拒绝。长期兼容层会把错误心智带进正式 API。内部测试数据应一次性迁移或重建。

### 目录内自动识别 `worker.js` / `worker.mjs`

拒绝。这些文件名在前端产物中常见，可能是 Web Worker、service worker、普通 bundle 或库文件。目录自动识别只认顶层 `_worker.js`，其它入口必须显式配置。

### 只要有 `index.html` 就启用入口回退

拒绝。Next static export、Astro、文档站、报告页和多页面站点都可能有根 `index.html`，但不应把未知路径 fallback 到首页。

### 服务端完全重新检测 CLI 本地目录

拒绝。服务端拿不到完整本地上下文，例如 ignored paths、配置来源、目录结构信号和控制文件语义。服务端应校验 CLI 提交的 `publishPlan` proposal 与实际上传 payload 是否一致，并归一化为 authoritative decision，而不是试图重新执行一套不完整的本地 detector。

### 服务端盲信 CLI 的 `publishPlan`

拒绝。CLI 不是安全边界。pages-api 必须根据实际 multipart parts、hash、manifest、module names、asset config 和 fallback 规则重新校验并计算 authoritative decision 与 canonical hash。

## 后果与取舍

- 这是一次面向正式化的破坏性设计：内部测试脚本、测试数据和临时 API 字段可能需要修改或重建。
- 用户心智更简单：普通路径只剩 `pages deploy ./dist example-site`。
- AI 更稳定：不再需要猜 `static/spa/worker` 或 `assets-only/worker-only/worker-with-assets` 输入值。
- 实现复杂度上升：CLI/API/provider 都需要围绕 resolved decision 和 multipart upload plan 重新整理。
- Worker with Assets 更明确：它是 worker-first，用户 Worker 必须主动调用 `env.ASSETS.fetch(request)` 服务静态资源。
- 一旦公开发布，应通过新的 ADR 再定义任何新增兼容策略。

## 测试建议

需要 focused `node:test` 覆盖：

- 单文件 `.js` / `.mjs` 识别为 `worker-only`。
- 单文件 `.ts` 在未支持编译时失败。
- 目录顶层 `_worker.js` 识别为 Worker。
- `_worker.js` + assets 识别为 `worker-with-assets`，且 entry 不进入 asset manifest。
- 目录内普通 `worker.js` / `worker.mjs` 不自动识别为 Worker entry。
- `_redirects`、`_headers`、`_routes.json` 等控制文件可作为信号但不进入 asset manifest。
- 多 HTML / `404.html` / 文档站结构识别为 `resolvedFallback: "not-found"`。
- 明确 rewrite 到 `/index.html` 识别为 `resolvedFallback: "index"`。
- 单入口 app shell 识别为 `resolvedFallback: "index"`，并带 signals。
- 低置信目录默认 `resolvedFallback: "not-found"` 并输出 warning。
- `pages detect --json` 不输出 `uploadPlanSummary`，`checks.packageChecked: false`，`checks.canPackage: null`。
- `pages deploy --dry-run --json` 不创建 site、不创建 deployment、不上传文件。
- `pages deploy --dry-run --json` 输出 `checks.remoteChecked: false`、`checks.canDeploy: null`、`checks.canDeployScope: "local"`，不误称远端可发布。
- `pages detect --json` 与 `pages deploy --dry-run --json` 在相同 config/flags 下输出一致 decision。
- `pages detect` 支持 `--config`、`--fallback`、`--worker-entry`，并正确报告 config source。
- 非 JSON `pages deploy` 输出阶段性进度。
- 长阶段输出 heartbeat 或计数更新。
- 非 JSON dry-run 明确说明不会创建站点、不会创建 deployment、不会上传文件、不会检查远端权限或 slug。
- JSON deploy 成功响应包含 resolved decision、uploadPlanSummary、checks、sideEffects 和 diagnostics，且不包含 `artifactKind`。
- JSON fatal error 使用统一 envelope，包含 `diagnostics.errors[].stage`、`code`、`actionCode`、`action`、`canRetry` 和结构化 `details`。
- `--json` 遇到需要确认的 `danger` warning 时返回 `CONFIRMATION_REQUIRED`，不进入交互式 prompt。
- 非 JSON 输出遵守 stdout/stderr 通道规则。
- `worker-with-assets` 派生 `routingMode: "worker-first"` 和固定 `ASSETS` binding。
- `assets-only` 不设置 `run_worker_first = true`，或薄 Worker 行为等价于 asset-first。
- `worker-only` 显式设置 fallback 时失败并返回 `FALLBACK_REQUIRES_ASSETS`。
- pages-api 校验 `publishPlan` proposal 与 multipart payload 一致。
- pages-api 拒绝未知 `metadata.schemaVersion`。
- pages-api 拒绝重复顶层字段、重复 partName、重复 asset path、重复 module name、manifest 声明但未上传、上传但未声明的 part。
- CLI 和 pages-api 都拒绝 denylist 文件、不可读文件、symlink 逃逸和控制文件公开上传。
- 影响 auto decision 的 `controlSignals` 纳入 canonical hash；未上传 control signal 不能作为 authoritative decision 依据。
- pages-api 使用服务端 canonical hash，覆盖 raw bytes、module names、asset paths、content types、resolved decision 和 assets config。
- `site_versions` 保存 resolved provider metadata，rollback 能恢复 Worker/assets/fallback/routingMode。
- CLI、配置和公开 API 不接受 `artifactKind` 作为用户意图字段。
- 公开 API request 不接受用户或 AI 传入 `deploymentShape`；CLI 内部协议中的 `publishPlan` 只能作为 proposal，服务端必须校验并归一化。

## 文档更新原则

实现前：

- 只保留本文作为设计文档。
- 不改用户-facing README、API 边界文档、开发期 OpenAPI 合约、skill 的行为说明。

实现后：

- 用户文档只讲 `source`、`fallback`、`worker.entry`。
- AI skill 使用 `pages detect --json` 和 `pages deploy --dry-run --json` 作为推荐诊断路径。
- 不再教 AI 选择 `static/spa/worker`。
- 开发期 OpenAPI request schema 不暴露 `artifactKind`、用户输入 `deploymentShape` 或内部 `publishPlan.deploymentShape`。
- 开发期 OpenAPI response 可以暴露 resolved decision，用于解释系统最终如何发布。

## 参考资料

- [Cloudflare Workers Static Assets](https://developers.cloudflare.com/workers/static-assets/)
- [Cloudflare Workers Static Assets routing](https://developers.cloudflare.com/workers/static-assets/routing/)
- [Cloudflare Workers Static Assets binding](https://developers.cloudflare.com/workers/static-assets/binding/)
- [Cloudflare Pages Advanced mode `_worker.js`](https://developers.cloudflare.com/pages/functions/advanced-mode/)
- [Next.js Static Exports](https://nextjs.org/docs/app/guides/static-exports)
- [Vite build options](https://vite.dev/config/build-options)
- [Vue CLI deployment](https://cli.vuejs.org/guide/deployment)
- [Angular deployment](https://angular.dev/tools/cli/deployment)
- [SvelteKit single-page apps](https://svelte.dev/docs/kit/single-page-apps)
