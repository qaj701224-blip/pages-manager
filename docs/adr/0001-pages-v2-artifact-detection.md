# ADR 0001: XD Pages artifact detection 设计

## 状态

Accepted。

本文沉淀 XD Pages 发布产物识别和打包语义的长期规则。后续演进应保持本文定义的用户心智和架构边界：用户提供发布来源，平台解释并执行发布方式，公开接口不暴露底层产物枚举。

## 背景

XD Pages 的理想发布体验应该是：

```bash
pages deploy ./dist example-site
```

用户只需要指定要发布的目录和站点名。CLI 自动识别目录形态、校验风险、打包上传，并在有歧义时给出可操作提示，而不是要求用户理解平台内部的产物枚举。

这个模型需要把两个问题拆开：

- 发布来源里有什么：静态资源、Worker module，或两者都有。
- 静态资源未命中时怎么办：返回 `/index.html`，还是返回 404 或自定义 404 页面。

如果把这两个问题压缩成公开枚举，用户和 AI 会被迫先判断“站点类型”。这不仅增加心智负担，也会让 Worker with Assets 这种自然形态变得别扭：目录里既有 Worker，又有图片、CSS、HTML，平台应该把它作为 Worker-first + Assets 发布，而不是要求用户在几个相互重叠的类型里猜一个。

因此，XD Pages 的公开模型必须以“发布来源 + 回退行为 + 可选 Worker 入口”为中心，并由 CLI/API/provider 共同维护 resolved decision。

## 决策

- 用户和 AI-facing 输入只保留 `source`、`fallback`、`worker.entry`。
- 公开输入不要求用户或 AI 选择部署形态。`deploymentShape` 只允许出现在 preflight resolved output、服务端内部上传计划和存储记录中。
- 公开契约和 runtime 内部模型都不使用 `artifactKind`。迁移可以读取旧式 `artifact_kind` 列作为输入，但最终存储和 provider 协议必须使用 resolved metadata。
- 自动判断拆成两层：先从 `source` 和 `worker.entry` 解析部署形态，再从 `fallback` 和目录信号解析资源 fallback。
- Worker with Assets 作为独立目标能力设计，不能伪装成现有 `worker` 或 `static/spa`。
- 不为实验参数或内部枚举设计长期兼容层。

## 设计目标

- 普通用户只需要理解“发布目录”。
- AI 和 CI 可以通过稳定 JSON preflight 判断发布结果，不需要猜人类文案。
- 人类用户可以通过阶段性进度输出理解 deploy 正在做什么。
- AI/CI 可以先使用 `detect` 或 `deploy --dry-run --json` 做无副作用决策，再决定是否真实发布。
- 用户不需要把站点归类为静态站、SPA 或 Worker；平台只解释 resolved decision。
- 支持长期自然扩展到 Worker with Assets。
- 自动判断规则保守、可解释、可覆盖。
- 公开契约保持一套清晰模型，不把实现细节固化为长期 API。

## 非目标

- 不在本设计中定义完整 Worker bundler 或 TypeScript 编译能力。
- 不在第一阶段读取和执行完整 `wrangler.toml`。即使未来读取，也只读取安全的发布形态字段，不继承 routes、secrets、bindings 等平台敏感配置。
- 不通过扫描用户 Worker 代码内容判断它是否会调用 `env.ASSETS.fetch(request)`。这类检查只能作为 warning，不能作为形态判断依据。
- 不把目录内普通 `worker.js` / `worker.mjs` 自动当作 Worker 入口。
- 不允许用户自定义 Cloudflare assets binding 名。XD Pages 固定使用 `ASSETS`。

## 用户可见模型

用户和 AI-facing 文档中只保留三个概念：

```text
source: 要发布的目录或文件
fallback: auto | index | not-found
worker.entry: 可选，自定义 Worker 入口
```

CLI 不提供 `--artifact-kind` 作为用户参数，配置文件也不接受 `artifactKind` 作为发布意图字段。README、skill、普通 CLI help、OpenAPI 示例和 AI 指南都应使用 `source`、`fallback`、`worker.entry`。

### 普通路径

```bash
pages deploy ./dist example-site
```

CLI 自动识别发布形态和 fallback。普通目录即使置信度低，也默认按 `fallback: not-found` 继续给出可操作 warning；只有非法输入、Worker 入口歧义、超出限制或无法安全打包时才失败。

### 高级覆盖

```bash
pages deploy ./dist example-site --fallback index
pages deploy ./dist example-site --fallback not-found
```

`fallback` 只表达静态资源未命中时的行为：

- `auto`：由 CLI 自动判断。
- `index`：未命中资源返回 `/index.html`。
- `not-found`：未命中路径返回 404，优先使用 `404.html`。

如果用户需要自定义 Worker 入口，优先使用配置文件表达可重复发布的意图：

```json
{
  "site": "example-site",
  "source": "./dist",
  "fallback": "auto",
  "worker": {
    "entry": "./worker.mjs"
  }
}
```

这个文件可以保存为项目根目录的 `pages.config.json`，然后直接发布：

```bash
pages deploy
```

也可以显式指定配置文件：

```bash
pages deploy --config ./pages.config.json
```

`worker.entry` 是相对 `source` 根目录的路径。上面的配置表示 Worker 入口文件是 `./dist/worker.mjs`。`worker.entry` 必须留在 `source` 目录内，不能使用绝对路径，也不能通过 `..` 指向目录外文件。

命令式也允许单独设置高级参数，适合 CI、AI 或一次性发布：

```bash
pages deploy ./dist example-site --worker-entry worker.mjs
pages deploy ./dist example-site --fallback index
pages deploy ./dist example-site --fallback not-found
```

`--worker-entry worker.mjs` 同样相对 `source` 根目录解析，即 `./dist/worker.mjs`。命令行参数只是覆盖发布意图，不会写回配置文件。

配置文件只表达发布意图，不保存 token、access key、Cloudflare 资源 ID 或部署状态。标准配置文件名为 `pages.config.json`；CLI 可以读取当前工作目录下的 `pages.config.json`，也可以通过 `--config <file>` 显式指定。优先级固定为：

```text
CLI positional args / flags > explicit --config file > auto-discovered ./pages.config.json > auto detection
```

同一次命令只读取一个配置文件。显式 `--config <file>` 与自动发现的 `./pages.config.json` 不做合并，避免同一个字段来自两个配置源。

目标环境选择不属于发布意图。普通用户和 AI-facing 配置只表达站点名、source、fallback 与 Worker 入口；目标环境应由 CLI 发行渠道、本地 profile 或受控 CI/维护流程决定。CLI 可以为了兼容保留内部环境切换能力，但普通 help、README、skill、OpenAPI 示例和 `pages.config.json` 示例都不提示环境字段，避免把平台部署维度变成用户心智。

## 内部模型

长期应把判断拆成两层：

```text
部署形态:
  assets-only
  worker-only
  worker-with-assets

resolved fallback:
  index
  not-found
  null

routing mode:
  assets-only
  worker-first
  worker-only
```

`deploymentShape` 是平台 resolved decision，不是用户输入。`requestedFallback` 保留用户输入值 `auto | index | not-found`；`resolvedFallback` 保留平台最终值 `index | not-found | null`。

对应关系：

| 用户意图 | resolved deploymentShape | resolvedFallback | 目标处理 |
| --- | --- | --- | --- |
| 发布普通静态目录 | `assets-only` | `not-found` | 上传 assets，未命中返回 404 或自定义 404 页面 |
| 发布前端应用入口回退 | `assets-only` | `index` | 上传 assets，未命中导航路径返回 `/index.html` |
| 发布纯 Worker 文件 | `worker-only` | `null` | 上传 Worker module，不绑定 assets |
| 发布带静态资源的 Worker 目录 | `worker-with-assets` | `not-found` 或 `index` | 上传 Worker module 和 assets，并绑定 `ASSETS` |

`routingMode` 是给 provider 和存储使用的执行语义：

| deploymentShape | routingMode | 说明 |
| --- | --- | --- |
| `assets-only` | `assets-only` | 静态资源优先；如果实现上需要薄 Worker，也必须与 asset-first 行为等价 |
| `worker-only` | `worker-only` | 纯 Worker 处理所有请求，不存在 assets fallback |
| `worker-with-assets` | `worker-first` | 用户 Worker 先运行，只有 Worker 主动调用 `env.ASSETS.fetch(request)` 才会服务 assets |

## Cloudflare 映射

XD Pages 的 `fallback` 映射到 Cloudflare Workers Static Assets 的 assets 配置，不是 Worker 路由 fallback：

| XD Pages resolvedFallback | Cloudflare `assets.not_found_handling` |
| --- | --- |
| `index` | `single-page-application` |
| `not-found` | `404-page` |
| `null` | 不上传 assets config |

XD Pages 暂不把 Cloudflare 的 `not_found_handling = "none"` 暴露给用户。`html_handling` 使用 Cloudflare 默认行为，除非后续 ADR 单独定义更细规则。

`worker-with-assets` 使用 Worker-first 语义：

- 顶层 `_worker.js` 借用 Cloudflare Pages Advanced mode 心智：Worker 接管请求。
- 显式 `worker.entry` + assets 也按同一语义处理。
- Cloudflare metadata 中应设置 `run_worker_first = true`。
- 用户 Worker 需要自行调用 `env.ASSETS.fetch(request)` 才会服务静态资源。
- `fallback` 只影响 `env.ASSETS.fetch(request)` 内部的资产未命中处理，不表示 Worker 未处理请求时平台自动 fallback。

`assets-only` 没有用户 Worker。平台可以生成薄 Worker 代理 `env.ASSETS.fetch(request)`，但这是实现细节，不暴露给用户。`assets-only` 不应继承 `worker-with-assets` 的 `run_worker_first = true` 语义；如果底层必须使用薄 Worker，也必须保证行为等价于静态资源优先。

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

- `ASSETS` 是 XD Pages 固定保留 binding 名。
- `resolvedFallback: "index"` 映射到 `assets.not_found_handling = "single-page-application"`。
- `resolvedFallback: "not-found"` 映射到 `assets.not_found_handling = "404-page"`。
- `worker-with-assets` 设置 `assets.run_worker_first = true`。
- `assets-only` 使用 asset-first/default 行为；如果平台生成薄 Worker 调用 `env.ASSETS.fetch(request)`，也必须保持 asset-first 等价语义。
- asset manifest 不包含 Worker entry 和控制文件。

## CLI deploy 流程

`pages deploy` 应围绕 preflight 和 upload plan 重排流程，避免先做服务端副作用再发现本地产物不可发布。

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
- `pages detect`、`pages deploy --dry-run` 和真实 `pages deploy` 必须复用同一套 detector。
- `pages deploy --dry-run` 和真实 `pages deploy` 必须复用同一套 publishPlan / uploadPlan 生成器。
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
- 新增轻量 `pages detect --json`，只做配置解析和本地识别，不计算 hash 或生成 uploadPlan。
- 新增 `pages deploy --dry-run --json`，做完整本地打包预演但不登录、不联网、不产生服务端副作用。
- `detect`、`dry-run` 和真实 deploy 复用同一套 detector；`dry-run` 和真实 deploy 复用同一套 publishPlan 和 uploadPlan。
- 实现后的 deploy 成功 JSON 中附带 authoritative decision 和 `uploadPlanSummary`。
- 为非 JSON deploy 增加阶段性进度输出。
- 为长阶段增加 heartbeat、计数或大小进度。
- 建立统一 JSON envelope、diagnostic object、warning severity、sideEffects 和 exit code 规则。
- 不更新 README、API.md、OpenAPI 或 skill 为尚未上线能力背书。

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

实现、测试和部署路径完成后，再同步更新 README、API.md、OpenAPI、pages-deploy.skill.md 和 CLI help。

默认判断使用本文定义的细粒度规则替代“目录根有 `index.html` 就启用入口回退”的旧规则：

- 已知静态导出优先 `fallback: not-found`。
- 明确 rewrite 到 `/index.html` 或单入口 app shell 才自动 `fallback: index`。
- 低置信默认 `fallback: not-found` 并给提示。

## 被拒方案

### 保留 `artifactKind` 但降级为内部字段

拒绝。只要 CLI、OpenAPI、skill 或 AI 文档继续出现 `artifactKind`，用户和 AI 就会被迫选择 `static/spa/worker`。这会把实现细节继续固化为产品概念。

如果实现内部需要短暂识别旧测试脚本的 `--artifact-kind`，也只能作为开发迁移工具，不能进入 README、OpenAPI、skill、普通 help 或 AI 示例。

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
- 不改用户-facing README、API.md、OpenAPI、skill 的行为说明。

实现后：

- 用户文档只讲 `source`、`fallback`、`worker.entry`。
- AI skill 使用 `pages detect --json` 和 `pages deploy --dry-run --json` 作为推荐诊断路径。
- 不再教 AI 选择 `static/spa/worker`。
- OpenAPI request schema 不暴露 `artifactKind`、用户输入 `deploymentShape` 或内部 `publishPlan.deploymentShape`。
- OpenAPI response 可以暴露 resolved decision，用于解释系统最终如何发布。

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
