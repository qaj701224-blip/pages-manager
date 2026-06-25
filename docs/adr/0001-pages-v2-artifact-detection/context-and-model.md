# ADR 0001: 背景、决策与用户模型

> 本文从 `docs/adr/0001-pages-v2-artifact-detection.md` 拆分而来；原路径保留为 ADR 索引。

## 状态

Accepted。

本文沉淀 XD Pages 发布产物识别和打包语义的长期规则。后续演进应保持本文定义的用户心智和架构边界：用户提供发布来源，平台解释并执行发布方式，公开接口不暴露底层产物枚举。

## 背景

XD Pages 的理想发布体验应该是：

```bash
xd-cell deploy ./dist example-site
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

CLI 不提供 `--artifact-kind` 作为用户参数，配置文件也不接受 `artifactKind` 作为发布意图字段。README、skill、普通 CLI help、开发期 OpenAPI 示例和 AI 指南都应使用 `source`、`fallback`、`worker.entry`。

### 普通路径

```bash
xd-cell deploy ./dist example-site
```

CLI 自动识别发布形态和 fallback。普通目录即使置信度低，也默认按 `fallback: not-found` 继续给出可操作 warning；只有非法输入、Worker 入口歧义、超出限制或无法安全打包时才失败。

### 高级覆盖

```bash
xd-cell deploy ./dist example-site --fallback index
xd-cell deploy ./dist example-site --fallback not-found
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
xd-cell deploy
```

也可以显式指定配置文件：

```bash
xd-cell deploy --config ./pages.config.json
```

`worker.entry` 是相对 `source` 根目录的路径。上面的配置表示 Worker 入口文件是 `./dist/worker.mjs`。`worker.entry` 必须留在 `source` 目录内，不能使用绝对路径，也不能通过 `..` 指向目录外文件。

命令式也允许单独设置高级参数，适合 CI、AI 或一次性发布：

```bash
xd-cell deploy ./dist example-site --worker-entry worker.mjs
xd-cell deploy ./dist example-site --fallback index
xd-cell deploy ./dist example-site --fallback not-found
```

`--worker-entry worker.mjs` 同样相对 `source` 根目录解析，即 `./dist/worker.mjs`。命令行参数只是覆盖发布意图，不会写回配置文件。

配置文件只表达发布意图，不保存 token、access key、Cloudflare 资源 ID 或部署状态。标准配置文件名为 `pages.config.json`；CLI 可以读取当前工作目录下的 `pages.config.json`，也可以通过 `--config <file>` 显式指定。优先级固定为：

```text
CLI positional args / flags > explicit --config file > auto-discovered ./pages.config.json > auto detection
```

同一次命令只读取一个配置文件。显式 `--config <file>` 与自动发现的 `./pages.config.json` 不做合并，避免同一个字段来自两个配置源。

目标环境选择不属于发布意图。普通用户和 AI-facing 配置只表达站点名、source、fallback 与 Worker 入口；目标环境应由 CLI 发行渠道、本地 profile 或受控 CI/维护流程决定。CLI 可以为了兼容保留内部环境切换能力，但普通 help、README、skill、开发期 OpenAPI 示例和 `pages.config.json` 示例都不提示环境字段，避免把平台部署维度变成用户心智。

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
