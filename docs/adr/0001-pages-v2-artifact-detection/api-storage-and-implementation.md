# ADR 0001: API、存储与实施策略

> 本文从 `docs/adr/0001-pages-v2-artifact-detection.md` 拆分而来；原路径保留为 ADR 索引。

## API 与存储模型

目标公开 API 不应要求用户或 AI 提交 `deploymentShape`。但 CLI 与 API 之间需要有一个可校验的内部协议，否则服务端无法在缺少本地检测信号的情况下完整重现 CLI 的判断。

长期边界：

- 用户和 AI-facing request 不暴露 `artifactKind` 或 `deploymentShape` 输入。
- CLI 本地 detector 生成完整 `publishPlan` proposal。
- CLI 把 `publishPlan` proposal 随 multipart payload 发给 pages-api。
- pages-api 不盲信 proposal，也不重新猜用户目录；它根据实际上传的 multipart parts 校验 proposal，并归一化为服务端权威 `decision`。
- API response、存储和 provider 只使用服务端归一化后的 `decision`。

这样可以同时满足两个要求：

- CLI 可以利用本地目录、控制文件、配置来源、ignored paths 等信号做友好判断。
- 服务端仍然是安全边界，能拒绝 manifest 与文件不一致、Worker entry 缺失、hash 不匹配、fallback 与 payload 不兼容等请求。

推荐统一使用 multipart/form-data wire format：

- `metadata`：唯一 JSON 字段，包含 `schemaVersion`、`siteSlug`、`requestedFallback`、`sourceSummary`、`publishPlan`、`assetManifest`、`workerMainModuleName`、`workerModules`、`controlSignals`、`contentHash` 等用户意图、计划和校验信息。
- `worker-main`：可选 Blob，用户 Worker main module。
- `worker-module-*`：可选 Blob，用户 Worker 依赖模块。
- `asset-file-*`：可选 Blob，静态资源文件。

`metadata.schemaVersion` 从 `1` 开始，服务端对未知版本 fail closed。`sourceSummary`、`controlSignals` 和 deployments 审计字段只能保存相对 source 的 sanitized path、信号和统计信息，不保存绝对路径、用户主目录、环境变量值或原始配置内容。

`publishPlan` 是 CLI 与 pages-api 的内部 proposal，不是公开用户配置，也不应出现在 AI skill 的推荐输入示例中：

```json
{
  "deploymentShape": "worker-with-assets",
  "requestedFallback": "auto",
  "resolvedFallback": "not-found",
  "routingMode": "worker-first",
  "workerEntry": "_worker.js",
  "workerMainModuleName": "_worker.js",
  "assetsConfig": {
    "notFoundHandling": "404-page"
  }
}
```

Manifest 使用数组而不是 path-keyed object，避免 JSON duplicate key 在解析前丢失：

```json
{
  "assetManifest": [
    {
      "path": "/assets/app.js",
      "partName": "asset-file-0",
      "hash": "sha256:...",
      "size": 12345,
      "contentType": "text/javascript"
    }
  ],
  "workerMainModuleName": "_worker.js",
  "workerModules": [
    {
      "moduleName": "_worker.js",
      "partName": "worker-main",
      "hash": "sha256:...",
      "size": 4567,
      "contentType": "application/javascript+module"
    }
  ],
  "controlSignals": [
    {
      "path": "_redirects",
      "kind": "redirects",
      "hash": "sha256:...",
      "effect": "fallback-index"
    }
  ]
}
```

第一阶段如果只支持单文件 bundled Module Worker，应只允许 `workerModules` 中声明 `worker-main` 这一项；多模块 Worker bundle 可以保留为协议扩展，但实现未支持时必须返回 `WORKER_ENTRY_REQUIRES_BUNDLE` 或专门的 unsupported error。支持多模块后，`workerMainModuleName` 和 `workerModules[].moduleName` 必须直接转换为 Cloudflare metadata 的 main module 与 module part name，不能从 multipart filename 猜测。

服务端根据实际 payload 校验并归一化：

| payload | resolved deploymentShape |
| --- | --- |
| 只有 assets | `assets-only` |
| 只有 worker module | `worker-only` |
| 同时有 worker module 和 assets | `worker-with-assets` |

关键校验规则：

- multipart 只能有一个 `metadata` 字段；重复顶层字段、重复 `partName`、重复 asset path、重复 module name 都必须失败。
- `metadata.publishPlan.deploymentShape` 必须与 multipart parts 推导出的 shape 一致。
- `metadata.publishPlan.routingMode` 必须与 shape 一致：`assets-only`、`worker-only`、`worker-first`。
- `worker-only` 的 `resolvedFallback` 必须为 `null`。如果请求显式设置了 `fallback: index` 或 `fallback: not-found`，应失败并返回 `FALLBACK_REQUIRES_ASSETS`，而不是静默忽略。
- 带 assets 的请求必须把 `requestedFallback` 解析为 `resolvedFallback: index | not-found`。
- `workerMainModuleName` 是 Worker main module 名；单文件 Worker 的 `worker_entry` 存储为该 module name，目录 assets-only 时为 `null`。
- `workerModules` 中的 module name 不能重复，且必须与上传 Blob 一一对应。
- `assetManifest` 中的 asset path 不能重复，必须全部有对应 `asset-file-*` Blob，且 Blob hash、size、content type 必须匹配。
- `assetManifest` 不得包含 Worker entry、`_worker.js`、`_headers`、`_redirects`、`_routes.json`、`.assetsignore`、`pages.config.json` 等控制文件。
- `assetManifest` 和所有上传 path 必须通过同一套 canonical path 与 denylist 校验，不能包含 secret、项目配置、CI 配置或 symlink 逃逸文件。
- 影响 auto decision 的控制文件必须以 sanitized `controlSignals` 形式提交并纳入 canonical hash；否则服务端只能把它们当作 warning 参考，不能用作 authoritative decision 依据。
- `contentHash` 只能作为客户端 hint；服务端必须基于实际 bytes、module names、asset paths、content types、resolved decision、assets config 和 `run_worker_first` 重新计算 canonical idempotency hash。
- multipart 中重复字段、未知 module、未知 asset 或声明未上传的 part 都应失败，不做猜测。

API response 可以返回 resolved decision，供 CLI/AI 解释发布结果：

```json
{
  "decision": {
    "deploymentShape": "worker-with-assets",
    "requestedFallback": "auto",
    "resolvedFallback": "not-found",
    "routingMode": "worker-first"
  }
}
```

存储层也应使用 resolved model。`site_versions` 是可回滚发布快照，应保存最终可复现 provider metadata：

```text
deployment_shape: assets-only | worker-only | worker-with-assets
requested_fallback: auto | index | not-found
resolved_fallback: index | not-found | null
routing_mode: assets-only | worker-first | worker-only
worker_entry: string | null
assets_config_json: object | null
worker_modules_json: object | null
asset_manifest_json: object | null
canonical_content_hash: string
artifact_ref: string
worker_name: string | null
execution_provider: string
runtime: string
dispatch_type: string | null
dispatch_binding_name: string | null
slot_id: string | null
artifact_availability: active | retained | expired | missing
created_by: string
created_at: string
```

这些字段是在现有 provider pointer 字段基础上增加 resolved metadata，不是用 manifest/hash 替换 provider 引用。当前 `artifact_ref` 仅表示已 materialize 的执行面 provider 引用，例如 WFP user Worker 或普通 Worker slot 指针。R2/source artifact store 属于 DR 0003 的长期候选；若只保存 provider artifact pointer，rollback 只能回到仍被 provider 保留的 artifact。如果要支持过期后重建 rollback，需要另行设计 R2 或对象存储保存原始 bytes。

`deployments` 应保存本次请求摘要、操作者、环境、warnings、decision 快照、canonical request hash、stage、provider error code、previous_version_id、sanitized source summary 和 terminal response，用于审计和排障。API 响应不得返回敏感内部 provider 资源 ID、token、secret 或完整本地路径。

如果存储中存在旧式 `artifact_kind` 字段，应优先迁移为上述 resolved metadata，而不是继续围绕 `artifact_kind = static/spa/worker` 扩展新语义。

Cloudflare provider 应从 resolved decision 派生 metadata：

- `ASSETS` 是 XD Cell 固定保留 binding 名。
- `resolvedFallback: "index"` 映射到 `assets.not_found_handling = "single-page-application"`。
- `resolvedFallback: "not-found"` 映射到 `assets.not_found_handling = "404-page"`。
- `worker-with-assets` 设置 `assets.run_worker_first = true`。
- `assets-only` 使用 asset-first/default 行为；如果平台生成薄 Worker 调用 `env.ASSETS.fetch(request)`，也必须保持 asset-first 等价语义。
- asset manifest 不包含 Worker entry 和控制文件。

## CLI deploy 流程

`xd-cell deploy` 应围绕 preflight 和 upload plan 重排流程，避免先做服务端副作用再发现本地产物不可发布。

目标顺序：

```text
读取 CLI 参数和 pages.config.json
解析 source、site、fallback、worker.entry
执行本地 preflight
生成 publishPlan 和 uploadPlan
输出 warning，并在需要时要求确认
解析 credential 并创建 API client
确认或创建站点
上传 deployment payload
等待或查询部署结果
输出 URL、deployment、resolved decision
```

关键要求：

- preflight 必须发生在登录、创建站点、创建 deployment、上传文件之前。
- `xd-cell detect`、`xd-cell deploy --dry-run` 和真实 `xd-cell deploy` 必须复用同一套 detector。
- `xd-cell deploy --dry-run` 和真实 `xd-cell deploy` 必须复用同一套 publishPlan / uploadPlan 生成器。
- `hash`、manifest、文件大小统计应尽量在同一次目录扫描中完成，避免重复读取大目录。
- `publishPlan` 应包含 resolved proposal：`deploymentShape`、`requestedFallback`、`resolvedFallback`、`routingMode`、`workerEntry`、`assetsConfig`。
- `uploadPlan` 是 CLI 内部打包计划，包含 `publishPlan`、`contentHash`、asset manifest、asset files 和 worker modules。
- CLI JSON 只输出 `uploadPlanSummary`，不把完整本地路径、文件 bytes 或敏感环境信息泄露到机器输出中。
- 真实 deploy 只负责把 uploadPlan 转换成 API payload，不再重新推断发布形态；最终以 API 返回的 authoritative `decision` 为准。
- 非 JSON 模式必须输出人类可读进度；JSON 模式只输出机器可读结果。
- JSON 模式成功响应必须包含 resolved decision、uploadPlanSummary 和 diagnostics，不得返回 `artifactKind`。
- Warning 应在真正上传前出现；fatal error 不得产生服务端副作用。
- `danger` warning 在非 JSON 交互式终端必须确认；非交互式、CI 和 JSON 模式默认失败，除非显式传 `--yes`。
- 远端阶段失败要输出 stage、稳定 error code、是否可重试、是否已经创建 deployment 或绑定 route。

## pages-api 改造责任

pages-api 不应依赖用户或 AI 传入的 `artifactKind` 或 `deploymentShape`。CLI 可以在内部协议中提交 `publishPlan` proposal，但服务端必须根据请求 payload 校验、归一化并生成 authoritative decision。

需要改造：

- Request 统一为 multipart/form-data，允许同时携带 metadata、worker module 和 assets。
- metadata 承载用户意图、`publishPlan` proposal 和校验字段，例如 `schemaVersion`、`siteSlug`、`requestedFallback`、`sourceSummary`、`publishPlan`、`assetManifest[]`、`workerMainModuleName`、`workerModules[]`、`controlSignals[]`、`contentHash`。
- 服务端对未知 `metadata.schemaVersion` fail closed，并遍历全部 multipart entries，拒绝重复字段、重复 partName、上传未声明和声明未上传。
- 服务端根据实际 multipart parts 派生 `deploymentShape`：只有 assets 为 `assets-only`，只有 worker 为 `worker-only`，两者都有为 `worker-with-assets`。
- 服务端校验 proposal 与实际 payload 一致；不一致时返回稳定错误，不做静默修正。
- 服务端根据 `requestedFallback` 和 payload 派生 `resolvedFallback`。`worker-only` 必须是 `null`；带 assets 时只能是 `index` 或 `not-found`。
- 显式 fallback 与 `worker-only` 冲突时返回 `FALLBACK_REQUIRES_ASSETS`。
- 服务端必须校验 asset manifest 与上传文件完全一致，且不包含 Worker entry 和控制文件。
- 服务端必须执行 canonical path、denylist 和 symlink 逃逸校验，防止 secret 或项目控制文件被上传成公开 asset。
- 服务端必须校验 `controlSignals`，只有纳入请求 metadata 和 canonical hash 的 sanitized control signal 才能参与 authoritative decision。
- 服务端必须校验 Worker entry 和 modules 是可上传的 Module Worker；不在 API 内做隐式 bundling。
- idempotency request hash 必须由服务端 canonical 计算，覆盖 raw bytes、module names、asset paths、content types、resolved decision、fallback、routingMode、worker entry、asset config 和 `run_worker_first`。
- deployment/version 响应应返回 resolved decision，供 CLI 和 AI 解释最终发布方式。
- 存储层应把可回滚发布快照写入 `site_versions`，在现有 provider pointer 字段基础上增加 `deployment_shape`、`requested_fallback`、`resolved_fallback`、`routing_mode`、`worker_entry`、`assets_config_json`、`worker_modules_json`、`asset_manifest_json`、`canonical_content_hash` 和 artifact availability。
- `deployments` 应保存请求摘要、warnings、decision 快照、canonical request hash、stage、provider error code、previous_version_id、sanitized source summary 和 terminal response，用于审计与排障。
- Cloudflare provider 根据 resolved decision 生成 Worker metadata、`ASSETS` binding、assets config 和 `run_worker_first`。
- `assets-only` 使用 asset-first/default 行为；`worker-with-assets` 才使用 `run_worker_first = true`。
- API 错误应返回稳定 code 和可操作 action，不再要求用户选择 `static/spa/worker`。

## 实施策略

### 阶段一：建立内部 detector 和 preflight

- 增加 detector 模块，返回结构化 decision、signals、warnings、errors。
- 新增轻量 `xd-cell detect --json`，只做配置解析和本地识别，不计算 hash 或生成 uploadPlan。
- 新增 `xd-cell deploy --dry-run --json`，做完整本地打包预演但不登录、不联网、不产生服务端副作用。
- `detect`、`dry-run` 和真实 deploy 复用同一套 detector；`dry-run` 和真实 deploy 复用同一套 publishPlan 和 uploadPlan。
- 实现后的 deploy 成功 JSON 中附带 authoritative decision 和 `uploadPlanSummary`。
- 为非 JSON deploy 增加阶段性进度输出。
- 为长阶段增加 heartbeat、计数或大小进度。
- 建立统一 JSON envelope、diagnostic object、warning severity、sideEffects 和 exit code 规则。
- 不更新 README、API 边界文档、开发期 OpenAPI 合约或 skill 为尚未上线能力背书。

### 阶段二：统一 CLI 配置和用户输入

- CLI 和配置只接受 `source`、`fallback`、`worker.entry`。
- 移除用户可见的 `--artifact-kind` 和 `artifactKind` 配置入口。
- CLI help 移除 `static/spa/worker` 产物类型引导，改为讲默认自动判断、`fallback` 和 `worker.entry`。
- 配置文件禁止 token、access key、Cloudflare 资源 ID 和部署状态。

### 阶段三：统一 API 与存储

- API request 使用统一 multipart payload，CLI 提交 `publishPlan` proposal，服务端校验并归一化 authoritative decision。
- API response 返回 resolved decision。
- metadata 使用 `schemaVersion: 1`、数组形式的 `assetManifest` / `workerModules` 和 sanitized `controlSignals`。
- CLI 和 pages-api 共享 canonical path、denylist 与 symlink 逃逸校验。
- 数据库存储在现有 provider pointer 基础上增加 `deployment_shape`、`requested_fallback`、`resolved_fallback`、`routing_mode`、`worker_entry`、`assets_config_json`、`worker_modules_json`、`asset_manifest_json`、`canonical_content_hash` 和 artifact availability。
- 清理围绕 `artifact_kind = static/spa/worker` 的分支命名，保留语义但不保留旧概念。
- 用服务端 canonical hash 替代依赖客户端 `contentHash` 的幂等判断。
- 对内部测试数据做一次性迁移或重建，不引入长期兼容转换层。

### 阶段四：支持 Worker with Assets

- 扩展服务端校验和 Cloudflare provider 上传逻辑。
- 顶层 `_worker.js` + 静态文件目录自动识别为 `worker-with-assets`。
- 配置 `worker.entry` + assets 目录也支持 `worker-with-assets`。
- 确保 Worker entry 和控制文件不被作为静态文件暴露。
- 对 `worker-with-assets` 输出 warning，提示用户 Worker 需要调用 `env.ASSETS.fetch(request)` 才能服务静态资源。
- 确保 `assets-only` 与 `worker-with-assets` 的 provider routingMode 分离，只有后者使用 `run_worker_first = true`。

### 阶段五：更新公开文档和默认判断

实现、测试和部署路径完成后，再同步更新 README、API 边界文档、开发期 OpenAPI 合约、pages-deploy.skill.md 和 CLI help。

默认判断使用本文定义的细粒度规则替代“目录根有 `index.html` 就启用入口回退”的旧规则：

- 已知静态导出优先 `fallback: not-found`。
- 明确 rewrite 到 `/index.html` 或单入口 app shell 才自动 `fallback: index`。
- 低置信默认 `fallback: not-found` 并给提示。
