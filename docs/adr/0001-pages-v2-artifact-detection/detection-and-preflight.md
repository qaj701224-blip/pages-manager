# ADR 0001: 自动判断、Preflight 与 JSON 输出

> 本文从 `docs/adr/0001-pages-v2-artifact-detection.md` 拆分而来；原路径保留为 ADR 索引。

## 自动判断规则

推荐长期顺序：

```text
显式配置 > Worker 形态 > 已知静态导出 > 明确 rewrite 到 index.html > 单入口 app shell > assets + fallback: not-found
```

### 1. 显式配置优先

如果 CLI flag 或配置文件声明了 `fallback` 或 `worker.entry`，应优先使用配置。自动检测仍应收集信号并在冲突时输出 warning，例如：

- 配置声明 `fallback: "index"`，但目录包含大量 route HTML 和 `404.html`。
- 配置声明 `worker.entry`，但入口不存在。
- 配置未声明 `worker.entry`，但目录中存在顶层 `_worker.js`。

显式配置不等于静默忽略风险。CLI 应输出 reason、warning 和 recommended action。

### 2. Worker 形态识别

Worker 的自动识别要保守，避免把前端构建产物误判成 Worker。

建议规则：

- 单文件目标 `*.js` / `*.mjs`：识别为 `worker-only`。
- 单文件目标 `*.ts`：报错，除非未来 CLI 支持本地编译。
- 目录目标中存在顶层 `_worker.js` 且没有其它静态文件：识别为 `worker-only`。
- 目录目标中存在顶层 `_worker.js` 且有其它静态文件：识别为 `worker-with-assets`。
- 目录目标中的普通 `worker.js` / `worker.mjs` 不自动识别为 Worker 入口。
- 非 `_worker.js` 入口必须通过 `worker.entry` 显式声明。

`worker.entry` 必须指向已可上传的 bundled Module Worker；如果仍需要本地打包、转译或解析外部 import，preflight 应失败并给出明确错误。

原因：

- Cloudflare Pages Advanced mode 的官方约定是顶层 `_worker.js`。
- `worker.js` / `worker.mjs` 在前端产物里可能是 Web Worker、service worker、普通 bundle 或库文件。
- `worker-with-assets` 发布时必须把控制文件从 asset manifest 排除，避免把 Worker 源码或平台控制文件当静态资源暴露。

### 3. 控制文件与 manifest 排除

以下文件是控制平面输入，可作为判断或未来 metadata 输入，但不应作为普通静态资源进入 asset manifest：

- `worker.entry` 指向的文件。
- 顶层 `_worker.js`。
- 顶层 `_headers`。
- 顶层 `_redirects`。
- 顶层 `_routes.json`。
- `.assetsignore`。
- `pages.config.json`。

通用忽略目录和文件包括 `.git`、`node_modules`、`.DS_Store`。如果后续支持 `.assetsignore`，它只影响 assets manifest，不影响 Worker entry 的存在性校验，也不能解除安全 denylist。

为了避免用户误把项目根目录当作发布目录导致 secret 变成公开静态资源，CLI 和 pages-api 都必须执行同一套 canonical path 与 denylist 校验。服务端不能只相信 CLI 已经排除危险文件。

必须拒绝或作为 `danger` 要求显式确认的路径包括：

- `.env`、`.env.*`、`.dev.vars`、`.dev.vars.*`。
- `wrangler.toml`、`wrangler.*.toml`。
- `*.pem`、`*.key`、SSH key、私钥和证书类文件。
- 常见云厂商、GitHub、Cloudflare token 或 credential 文件。
- `.github/**`、`.gitlab-ci.yml`、CI 配置和部署脚本，除非后续明确允许作为静态内容。
- 通过 symlink 指向 `source` 外部的文件或目录。

`.well-known/**` 是合法公开静态路径，不应因为以点开头被一刀切拒绝。denylist 应基于规范化后的相对路径、basename 和危险扩展名判断，不允许通过 `..`、重复分隔符、大小写变体或 symlink 逃逸绕过。

控制文件的处理原则：

- 第一阶段可以只把 `_headers`、`_redirects`、`_routes.json` 作为检测信号和 ignored path 输出。
- 如果 Cloudflare Workers Assets wire format 后续支持对应 metadata，应通过控制平面上传，而不是把这些文件公开为静态路径。
- 如果用户提供了当前不支持的控制文件，CLI 应输出 warning，说明文件不会作为公开 asset 上传，也不会生效为对应规则。
- 如果控制文件会影响 `resolvedFallback`，CLI 必须把对应的 sanitized control signal 放进 `metadata.controlSignals` 并纳入 canonical hash；否则这些文件只能产生 warning，不能作为服务端可验证的 authoritative decision 依据。

### 4. 已知静态导出优先 assets + fallback: not-found

以下信号更偏静态多页面站点，应选择 `fallback: not-found`：

- 多个 HTML 页面，例如 `about.html`、`docs/index.html`、嵌套路由 `*/index.html`。
- 存在 `404.html`。
- 存在 `sitemap.xml`、大量文档页、报告页结构。
- Next static export 形态，例如 `_next` 与多个 route HTML。
- Astro 静态输出形态，例如 `_astro` 与多页面结构。

这些目录通常不需要入口回退。把它们误判成 `fallback: index` 会导致未知路径返回 200 和首页内容，不利于文档站、报告站和 SEO/链接正确性。

### 5. 明确 rewrite 到 index.html 识别 index fallback

如果目录或相邻配置中存在明确 rewrite/fallback 规则，可高置信识别为 `fallback: index`。例如：

- `_redirects` 中有 `/* /index.html 200`。
- `vercel.json` 中有 catch-all rewrite 到 `/index.html`。
- `staticwebapp.config.json` 中有 navigation fallback 到 `/index.html`。
- XD Pages 自己配置中声明 `fallback: "index"`。

这是比“存在 index.html”更可靠的入口回退信号。`_redirects` 可用于判断，但不上传为静态资源。

### 6. 单入口 app shell 可识别 index fallback

当目录只有根 `index.html`，没有其它 route HTML，并且存在单入口 app shell 特征时，可以识别为 `fallback: index`。

可作为辅助信号：

- 根 `index.html` 引用少量 hashed JS/CSS chunk。
- 存在 Vite、CRA、Vue CLI、Angular 等常见单入口构建结构。
- 没有 `404.html`、多页面 HTML、静态导出路由。

这些信号不应单独决定入口回退，但组合起来可以给出高或中等置信度。若置信度不足，应输出 warning，说明如何覆盖。

### 7. 低置信默认 assets + fallback: not-found

真正无法判断时，默认 `fallback: not-found` 更保守：

- 不会让未知路径误返回首页 200。
- 适合报告、文档、静态 HTML、导出页面等低交互站点。
- 如果用户实际需要前端入口回退，深链刷新 404 时可以通过 `fallback: index` 修正。

为了用户体验，CLI 应在低置信场景给出清晰提示：

```text
识别为文件型静态站点。若刷新深层路径时需要返回 /index.html，请设置 fallback: index。
```

## Preflight 与 JSON 输出

为了让 AI/CI 自然使用，应新增无副作用诊断：

```bash
pages detect ./dist --json
pages detect --config ./pages.config.json --json
pages deploy ./dist example-site --dry-run --json
```

### `pages detect`

`detect` 是轻量识别命令，只做本地目录识别和配置解析：

- 不登录。
- 不访问网络。
- 不创建站点。
- 不上传文件。
- 不读取 secret。
- 不计算完整内容 hash。
- 不生成可上传 payload。
- 支持与 deploy 相同的 `--config`、`--fallback`、`--worker-entry` 覆盖参数。

适合 AI 在发布前判断目录，或 CI 在构建后给出可解释诊断。`detect` 和 `deploy` 必须复用同一个 detector，避免 “detect 显示一种结果、deploy 实际另一种结果”。如果需要确认文件数量、大小、hash 和可上传 payload，应使用 `pages deploy --dry-run`。

### `pages deploy --dry-run`

默认执行本地 preflight 和打包预演，但不产生服务端副作用：

- 识别部署形态和 fallback。
- 计算 hash、文件数、大小。
- 检查文件数量和大小限制。
- 检查 worker entry 是否存在、是否歧义。
- 不登录。
- 不访问网络。
- 不读取 secret。
- 不创建 site。
- 不创建 deployment。
- 不上传 assets 或 Worker bundle。
- 输出 `remoteChecked: false`。

`--dry-run` 的默认含义是“本地可打包、不会发布”，不是“远端一定可发布”。权限、slug 可用性、服务端配额、Cloudflare 路由冲突等只有远端校验或真实 deploy 才能确认。因此本地 dry-run 不应输出误导性的 `canDeploy: true`，而应区分本地能力和远端能力。

如果未来需要验证站点权限、slug 可用性或服务端限制，应增加单独的只读远端校验开关，例如 `--check-remote`，并在 JSON 中输出 `remoteChecked: true`。这类远端校验仍不得创建站点、创建 deployment 或上传文件。

部署流程必须保证：preflight 在任何创建站点、上传文件、写 deployment 之前完成。

### JSON 输出约束

`--json` 是 AI/CI 契约，必须遵守：

- stdout 只输出一个完整 JSON object。
- 不在 stdout 混入进度、人类提示、彩色控制符或日志。
- fatal error 也使用同一 JSON envelope，并以非 0 exit code 退出。
- warnings、signals、progress 摘要都放入 JSON 字段，不依赖 stderr。
- `--json` 永不进入交互式 prompt。需要确认的 `danger` warning 在 JSON 模式下转为 `CONFIRMATION_REQUIRED` error，除非显式传 `--yes`。
- stderr 只保留给底层运行时不可避免的诊断；平台自身默认不主动向 stderr 写人类文案。
- 如果未来 CI 需要长任务 heartbeat，应通过显式参数启用，例如 `--progress=stderr`，并只向 stderr 输出 JSONL progress，不破坏 stdout 单 JSON 契约。
- JSON response 不包含 `artifactKind`，也不接受 AI 从响应中反推出下一次要传 `artifactKind`。

### JSON envelope

机器输出必须使用稳定 schema，避免 AI 解析人类文案。`detect`、`dry-run` 和真实 `deploy` 共用基础 envelope：

```json
{
  "ok": true,
  "schemaVersion": 1,
  "type": "preflight",
  "mode": "dry-run",
  "target": {
    "source": "./dist",
    "kind": "directory",
    "requestedFallback": "auto",
    "workerEntry": null
  },
  "decision": {
    "deploymentShape": "assets-only",
    "requestedFallback": "auto",
    "resolvedFallback": "index",
    "routingMode": "assets-only",
    "confidence": "high",
    "source": "auto"
  },
  "uploadPlanSummary": {
    "contentHash": "sha256:...",
    "fileCount": 42,
    "sizeBytes": 123456,
    "assetControlFilesExcluded": ["_redirects"]
  },
  "checks": {
    "localDetectionPassed": true,
    "packageChecked": true,
    "canPackage": true,
    "remoteChecked": false,
    "canDeploy": null,
    "canDeployScope": "local"
  },
  "sideEffects": {
    "willDeploy": false,
    "siteCreated": false,
    "deploymentCreated": false,
    "filesUploaded": false,
    "routeChanged": false
  },
  "signals": [
    {
      "code": "ROOT_INDEX_HTML_FOUND",
      "path": "index.html"
    },
    {
      "code": "SINGLE_HTML_ENTRY"
    }
  ],
  "diagnostics": {
    "warnings": [],
    "errors": []
  }
}
```

字段含义：

- `mode`：`detect | dry-run | deploy`。
- `decision`：resolved decision，所有模式都应包含 `deploymentShape`、`requestedFallback`、`resolvedFallback`、`routingMode`。
- `uploadPlanSummary`：只在 `dry-run` 和真实 `deploy` 中出现；`detect` 不输出该字段。
- `checks.localDetectionPassed`：本地输入、配置、目录扫描和规则判断是否通过。
- `checks.packageChecked`：是否执行了打包预演。`detect` 为 `false`。
- `checks.canPackage`：是否能生成可上传 payload。`detect` 为 `null`，`dry-run` 和真实 deploy 为 `true | false`。
- `checks.remoteChecked`：是否做过只读远端校验或真实远端阶段。
- `checks.canDeploy`：只有远端校验覆盖权限、站点、配额、路由等条件后才能是 `true | false`；纯本地 `detect` 和 `dry-run` 必须是 `null`，即使本地失败也不把远端可发布性写成 `false`。
- `checks.canDeployScope`：`none | local | remote-readonly | remote-deploy`。
- `sideEffects.willDeploy`：是否计划产生服务端副作用。`detect` 和 `dry-run` 永远是 `false`。

`detect --json` 示例：

```json
{
  "ok": true,
  "schemaVersion": 1,
  "type": "preflight",
  "mode": "detect",
  "decision": {
    "deploymentShape": "assets-only",
    "requestedFallback": "auto",
    "resolvedFallback": "not-found",
    "routingMode": "assets-only",
    "confidence": "medium",
    "source": "auto"
  },
  "checks": {
    "localDetectionPassed": true,
    "packageChecked": false,
    "canPackage": null,
    "remoteChecked": false,
    "canDeploy": null,
    "canDeployScope": "none"
  },
  "sideEffects": {
    "willDeploy": false
  },
  "signals": [],
  "diagnostics": {
    "warnings": [],
    "errors": []
  }
}
```

Diagnostic 对象结构：

```json
{
  "code": "LOW_CONFIDENCE_ASSETS_DIRECTORY",
  "severity": "warning",
  "stage": "detect-source",
  "message": "Detected an assets directory with low confidence.",
  "actionCode": "SET_FALLBACK_INDEX_IF_HISTORY_ROUTER",
  "action": "If this is a client-side routed app, set fallback to index.",
  "canRetry": false,
  "canContinue": true,
  "requiresConfirmation": false,
  "details": {
    "candidates": ["index", "not-found"],
    "selected": "not-found"
  }
}
```

Fatal error 示例：

```json
{
  "ok": false,
  "schemaVersion": 1,
  "type": "preflight",
  "mode": "dry-run",
  "checks": {
    "localDetectionPassed": false,
    "packageChecked": false,
    "canPackage": null,
    "remoteChecked": false,
    "canDeploy": null,
    "canDeployScope": "local"
  },
  "sideEffects": {
    "willDeploy": false
  },
  "diagnostics": {
    "warnings": [],
    "errors": [
      {
        "code": "WORKER_ENTRY_AMBIGUOUS",
        "severity": "error",
        "stage": "detect-source",
        "message": "Multiple worker entry candidates were found.",
        "actionCode": "SET_WORKER_ENTRY",
        "action": "Set worker.entry in pages.config.json or pass --worker-entry.",
        "canRetry": false,
        "canContinue": false,
        "requiresConfirmation": false,
        "details": {
          "candidates": ["_worker.js", "functions/worker.mjs"]
        }
      }
    ]
  }
}
```

Warning 语义：

- `severity: "info"`：提示信息，不影响发布。
- `severity: "warning"`：可继续，但必须给出可操作建议。
- `severity: "danger"`：可能产生明显违背用户预期的结果；非 JSON 交互式终端必须要求确认，非交互式、CI 和 `--json` 默认失败，除非显式传 `--yes`。

真实 deploy 在上传前必须先展示 warning，并在需要确认时停下。所有 diagnostic 都要有 `stage`、`actionCode` 和人类可读 `action`，AI 可以读 code，人类可以直接读建议。未确认的 `danger` warning 会转换成 `CONFIRMATION_REQUIRED` error，exit 1，且不产生服务端副作用。

应触发 `danger` 或 fatal error 的典型场景：

- `--fallback index` 但目录没有根 `index.html`：fatal `FALLBACK_INDEX_REQUIRES_INDEX_HTML`。
- 排除控制文件和 denylist 文件后没有任何可发布 asset：fatal `PACKAGE_NO_PUBLIC_ASSETS_AFTER_EXCLUDES`。
- 文件不可读、symlink 循环或 symlink 指向 source 外部：fatal。
- 将已有站点从静态资源目录切换为 Worker-first：`danger` `DEPLOYMENT_SHAPE_CHANGE`。
- 将已有站点找不到文件行为从返回 `/index.html` 切换为 404，或反向切换：`danger` `FALLBACK_BEHAVIOR_CHANGE`。
- 发现 denylist 文件在 source 中：默认 fatal；如果未来允许 `--yes` 覆盖，也必须要求服务端再次校验并记录审计。

Exit code 规则：

- `detect --json`：`checks.localDetectionPassed: true` 且没有 error 时 exit 0；存在 error 时 exit 1。
- `deploy --dry-run --json`：永远不发布；`checks.localDetectionPassed: true` 且 `checks.canPackage: true` 且没有 error 时 exit 0；存在 error 时 exit 1。
- 非 dry-run deploy：必须先通过同一套 preflight；preflight fatal error 时不得产生任何服务端副作用。

真实 deploy 的 JSON 输出也应包含同一套 resolved decision 摘要，避免 AI 发布后仍只能看到 opaque deployment 对象：

```json
{
  "ok": true,
  "schemaVersion": 1,
  "type": "deploy",
  "mode": "deploy",
  "site": "example-site",
  "url": "https://example-site.pages.xd.team",
  "decision": {
    "deploymentShape": "assets-only",
    "requestedFallback": "auto",
    "resolvedFallback": "index",
    "routingMode": "assets-only"
  },
  "uploadPlanSummary": {
    "contentHash": "sha256:...",
    "fileCount": 42,
    "sizeBytes": 123456
  },
  "checks": {
    "localDetectionPassed": true,
    "packageChecked": true,
    "canPackage": true,
    "remoteChecked": true,
    "canDeploy": true,
    "canDeployScope": "remote-deploy"
  },
  "sideEffects": {
    "willDeploy": true,
    "siteCreated": false,
    "deploymentCreated": true,
    "filesUploaded": true,
    "routeChanged": true
  },
  "diagnostics": {
    "warnings": [],
    "errors": []
  },
  "deployment": {},
  "version": {},
  "route": {}
}
```

真实 deploy 失败也必须返回统一 error envelope：

```json
{
  "ok": false,
  "schemaVersion": 1,
  "type": "deploy",
  "mode": "deploy",
  "stage": "upload-assets",
  "site": "example-site",
  "decision": {
    "deploymentShape": "assets-only",
    "requestedFallback": "auto",
    "resolvedFallback": "index",
    "routingMode": "assets-only"
  },
  "checks": {
    "localDetectionPassed": true,
    "packageChecked": true,
    "canPackage": true,
    "remoteChecked": true,
    "canDeploy": false,
    "canDeployScope": "remote-deploy"
  },
  "sideEffects": {
    "willDeploy": true,
    "siteCreated": false,
    "deploymentCreated": true,
    "filesUploaded": false,
    "routeChanged": false
  },
  "diagnostics": {
    "warnings": [],
    "errors": [
      {
        "code": "ASSET_UPLOAD_FAILED",
        "severity": "error",
        "stage": "upload-assets",
        "message": "Failed to upload static assets.",
        "actionCode": "RETRY_DEPLOY",
        "action": "Retry the deploy. If it fails again, check the network and service status.",
        "canRetry": true,
        "canContinue": false,
        "requiresConfirmation": false,
        "details": {
          "failedFileCount": 3
        }
      }
    ]
  }
}
```

`stage` 使用稳定枚举，例如 `read-config`、`detect-source`、`package`、`authenticate`、`prepare-site`、`upload-assets`、`upload-worker`、`deploy-worker`、`bind-route`、`verify`。

JSON 输出不得包含 `artifactKind`。用户和 AI-facing JSON 可以包含 `deploymentShape`，但它只能出现在 resolved decision 中，用于解释平台判断，不作为下一次请求的输入字段。

### 人类可读进度输出

非 JSON 模式下，`pages deploy` 必须输出阶段性进度，避免长时间 hash、打包、上传或 Cloudflare 部署时看起来像卡住。

通道规则：

- 非 JSON 的进度、warning、确认提示和错误详情输出到 stderr。
- 非 JSON 的最终 URL 和成功摘要输出到 stdout。
- JSON 模式 stdout 只输出一个 JSON object；默认不输出人类进度。

建议输出阶段按发布形态条件化：

```text
读取配置...
检查发布目录...
识别发布方式...
打包资源...
计算内容哈希...
准备站点...
上传资源...
发布站点配置...
部署 Worker...        # 仅 worker-only / worker-with-assets
绑定路由...
验证结果...
发布完成
```

输出应遵守：

- 每个可能超过数秒的阶段开始时都输出一行。
- 长阶段需要 heartbeat 或计数更新；例如每 10 秒输出一次当前文件数、字节数、重试次数或等待中的远端阶段。
- 每个阶段完成时可以输出简短结果，例如 `检查发布目录完成：42 files / 12.4 MB`。
- 文件扫描、资源上传这类可计数阶段应输出数量或大小，例如 `上传资源 42 files / 12.4 MB...`。
- 最终输出人类标签，例如 `发布类型：静态资源目录`、`发布类型：Worker + 静态资源`、`回退策略：返回 /index.html`。不要把 `assets-only`、`worker-first` 作为主要人类文案。
- Warning 应在真正上传前集中展示，并说明是否继续。
- Fatal error 应包含稳定 error code 和下一步建议。
- `--json` 模式只输出机器可读 JSON，不混入人类进度文本。
- `pages deploy --dry-run` 的人类输出必须明确说明：这是本地预演，不会创建站点、不会创建 deployment、不会上传文件，也没有检查远端权限和 slug 可用性。
- 真实 deploy 如果通过 preflight 后在远端阶段失败，必须说明失败阶段、是否可重试、是否已经产生 deployment 或 route 变更。

人类输出样例：

```text
$ pages detect ./dist
发布目录：./dist
识别结果：静态资源目录
找不到文件时：返回 404.html 或 404
置信度：medium
提示：如果这是前端路由应用，请设置 fallback: index。
```

```text
$ pages deploy ./dist example-site --dry-run
本地预演，不会创建站点、不会创建 deployment、不会上传文件，也不会检查远端权限或站点名。
检查发布目录完成：42 files / 12.4 MB
识别结果：静态资源目录
找不到文件时：返回 /index.html
本地打包预演通过。
```

```text
$ pages deploy ./dist example-site
读取配置...
检查发布目录完成：42 files / 12.4 MB
识别结果：静态资源目录
找不到文件时：返回 /index.html
上传资源：42 files / 12.4 MB
发布完成：https://example-site.pages.xd.team
```

建议错误码：

- `DETECT_TARGET_NOT_FOUND`
- `DETECT_EMPTY_DIRECTORY`
- `DETECT_UNREADABLE_FILE`
- `DETECT_SYMLINK_OUTSIDE_SOURCE`
- `WORKER_TYPESCRIPT_UNSUPPORTED`
- `WORKER_ENTRY_NOT_FOUND`
- `WORKER_ENTRY_AMBIGUOUS`
- `WORKER_ENTRY_REQUIRES_BUNDLE`
- `FALLBACK_REQUIRES_ASSETS`
- `FALLBACK_INDEX_REQUIRES_INDEX_HTML`
- `PACKAGE_NO_PUBLIC_ASSETS_AFTER_EXCLUDES`
- `PACKAGE_DENYLISTED_FILE`
- `PACKAGE_FILE_COUNT_LIMIT_EXCEEDED`
- `PACKAGE_BUNDLE_TOO_LARGE`
- `CONFIRMATION_REQUIRED`
- `REMOTE_PERMISSION_DENIED`
- `REMOTE_SITE_OWNERSHIP_CONFLICT`
- `ASSET_UPLOAD_FAILED`
- `WORKER_DEPLOY_FAILED`
- `ROUTE_BIND_FAILED`

建议 warning code：

- `LOW_CONFIDENCE_ASSETS_DIRECTORY`
- `INDEX_HTML_ONLY_INDEX_FALLBACK_INFERENCE`
- `EXPLICIT_CONFIG_OVERRIDES_SIGNALS`
- `STATIC_EXPORT_SIGNALS_FOUND`
- `IGNORED_PATHS_PRESENT`
- `WORKER_WITH_ASSETS_REQUIRES_ASSETS_FETCH`
- `UNSUPPORTED_CONTROL_FILE_PRESENT`
- `DEPLOYMENT_SHAPE_CHANGE`
- `FALLBACK_BEHAVIOR_CHANGE`
