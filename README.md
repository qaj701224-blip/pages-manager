# Pages — 内部站点托管服务

基于 Cloudflare Workers 的轻量 Web 托管平台。零基础设施（无 ECS / Nginx / OSS），管理服务本身也是一个 CF Worker，通过 CF API 直接管理站点 Worker 的生命周期。

## 架构

### 完整流程

```
┌──────────┐    ① 分发 skill 文件
│  管理员   │──────────────────────► pages-deploy.skill.md → 团队成员
└──────────┘

┌──────────┐    ② 首次使用                    ┌──────────────────┐
│  用户    │──► AI 读取 skill ───────────────► │  api.workers     │
│ (运营/   │    │                              │  .xd.team        │
│  开发)   │    │  curl /openapi.json          │                  │
└──────────┘    │  • 同步 deploy.sh            │  返回 API spec   │
                │  • 同步 manage.sh            │  + 脚本源码      │
                │  → 写入 ~/.xd-pages/         │  + IP 限制代码   │
                │                              └──────────────────┘
                │  设置 Token
                │  • 询问邮箱 → 生成 pages_邮箱
                │  • 保存到 AI 记忆
                │
                │    ③ 部署站点
                │  检查 .pages.json ── 存在 → 复用已有站点名（更新）
                │                   └─ 不存在 → 询问用户想要的名字
                │
                │  自动判断类型
                │  • 有 _worker.js     → worker
                │  • Vue/React/Angular → spa
                │  • 纯 HTML/文档      → static
                │
                │  执行部署
                │    │
                │    ▼
                │  归属检查（token 比对）── 被占用 → 409 提示换名
                │    │ 通过
                │    ▼
                │  ┌────────────────────────────────────┐
                │  │     Cloudflare API 三步部署          │
                │  │  SHA-256 指纹 → 注册上传会话         │
                │  │  按批次上传文件（跳过已存在的）        │
                │  │  部署 Worker（自动注入 MIME + IP 限制）│
                │  └────────────────────────────────────┘
                │    │
                │    ▼
                │  绑定域名 + 启用 workers.dev
                │  写入 KV 元数据 + 项目目录 .pages.json
                │    │
                │    ▼
                │  ✅ 返回:
                │     • https://{name}.workers.xd.team
                │     • https://pages-{name}.xd-cf-2022.workers.dev (备用)
                │
                │
┌───────────────────────────────────────────────────┐
│                   自动更新机制                      │
│                                                   │
│  管理员更新服务端 → 部署 → openapi.json 更新       │
│                              │                    │
│                    AI 每次会话自动 fetch            │
│                              ▼                    │
│               • 脚本自动覆盖更新                    │
│               • API 规则即时生效                    │
│               • IP 白名单同步                      │
│               • 版本变化时提醒用户更新 skill 文件    │
│                                                   │
│  唯一需要手动更新的：skill 文件本身（流程变化时）    │
└───────────────────────────────────────────────────┘
```

## 站点类型

| preset   | 行为                                   | 适用场景                     |
| -------- | -------------------------------------- | ---------------------------- |
| `static` | 按路径匹配文件，404 返回 404 页面      | HTML 报告、文档站、数据看板  |
| `spa`    | 路径未匹配时回退到 `index.html`        | Vue / React / Angular 等 SPA |
| `worker` | 使用上传的 `_worker.js` 作为自定义入口 | SSR、API 代理、动态渲染      |

## Pages KV

Pages KV 是 v1 站点级 KV 能力，部署时必须显式传 `kv=true` 才会开启；未传、`false` 或 `kv=false` 都是关闭，非法 `kv` 值会被拒绝。`kv=true` 仅支持 `spa` 和 `worker` preset，`static + kv=true` 会被拒绝。

SPA 浏览器代码使用 `@xd/pages-sdk/browser`：

```ts
import { createPagesClient } from '@xd/pages-sdk/browser';

const pages = createPagesClient();
const config = await pages.kv.get('app/config', { type: 'json' });
await pages.kv.put('drafts/123', { title: 'hello' });
await pages.kv.delete('drafts/123');
```

浏览器 SDK 只访问同源 POST runtime endpoint：

- `POST /.xd-pages/runtime/v1/kv/get`
- `POST /.xd-pages/runtime/v1/kv/put`
- `POST /.xd-pages/runtime/v1/kv/delete`

自定义 Worker 使用 `@xd/pages-sdk/worker`：

```js
import { createPagesRuntime } from '@xd/pages-sdk/worker';

export default {
  async fetch(request, env) {
    const pages = createPagesRuntime({ env });
    return Response.json(await pages.kv.get('app/config'));
  },
};
```

worker preset 的 `_worker.js` 如果 import npm 包（包括 `@xd/pages-sdk/worker`），业务构建必须先 bundle/打包成可直接运行的 Worker module，再上传给 pages-manager；pages-manager 不会打包 `_worker.js`。

安全边界：

- 公开 assets 不会让 KV runtime 公开；v1 runtime KV 仍受平台 IP 白名单保护。
- v1 browser KV 是站点级能力，不是用户级隔离，不要存高度敏感数据。
- worker preset 开启 `kv=true` 后，owner `_worker.js` 会收到本站 KV 能力；owner 代码可以误用或泄露自己的能力，平台只强制跨站前缀隔离。

## 使用方式

### CLI 脚本

```bash
# 部署静态站点
PAGES_TOKEN=pages_zhangsan@xd.com bash scripts/deploy.sh my-report ./dist

# 部署 SPA
PAGES_TOKEN=pages_zhangsan@xd.com bash scripts/deploy.sh my-app ./dist --preset spa

# 部署自定义 Worker（目录需包含 _worker.js）
PAGES_TOKEN=pages_zhangsan@xd.com bash scripts/deploy.sh my-ssr ./project --preset worker

# 管理
PAGES_TOKEN=pages_zhangsan@xd.com bash scripts/manage.sh list
PAGES_TOKEN=pages_zhangsan@xd.com bash scripts/manage.sh info my-report
PAGES_TOKEN=pages_zhangsan@xd.com bash scripts/manage.sh delete my-report
```

### HTTP API

直接调用管理服务 API，详见 [API.md](./API.md)。

```bash
curl -X POST https://api.workers.xd.team/deploy \
  -H "X-Pages-Token: pages_zhangsan@xd.com" \
  -F "name=my-report" \
  -F "preset=static" \
  -F "file-0=@dist/index.html;filename=index.html"
```

### AI Skill

AI 读取 [pages-deploy.skill.md](./pages-deploy.skill.md) 后自动执行部署:

```
用户: 把当前目录下的 dist 文件夹发布到 pages，名字叫 q2-report
AI:   ✅ 已发布: https://q2-report.workers.xd.team
```

## 域名规则

```
{name}.workers.xd.team
```

| 站点名      | 访问地址                             |
| ----------- | ------------------------------------ |
| `q2-report` | `https://q2-report.workers.xd.team`  |
| `my-app`    | `https://my-app.workers.xd.team`     |
| `demo-api`  | `https://demo-api.workers.xd.team`   |

站点名规则: `/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/`

## 安全

- **IP 白名单**: 管理 API（除 `/openapi.json`、`/skill.md`、`/readme.md` 公开端点外）限制公司内网 IP 访问（CF-Connecting-IP），真实白名单由 `IP_ALLOWLIST` 在部署环境中配置；static/spa 子站会自动注入限制，worker 子站会注入 `env.IP_ALLOWLIST`，需在 `_worker.js` 中调用检查逻辑
- **Token**: `X-Pages-Token` 用于站点归属标记，不是强认证；`/deploy`、`/list`、`/site/:name` 查询和删除必须携带 token，`/list` 和 `/site/:name` 查询不会返回 token 字段
- **Secret**: `CF_API_TOKEN` 是运行时高权限 token，必须通过 `wrangler secret put CF_API_TOKEN` 设置，不提交到 Git
- **后续**: 可叠加 Cloudflare Access (SSO) 实现身份认证

## 基础设施

### 使用

| 组件         | 说明                                                    |
| ------------ | ------------------------------------------------------- |
| CF 账户      | 通过部署环境变量 `CLOUDFLARE_ACCOUNT_ID` 配置            |
| 域名         | `workers.xd.team`（xd.team partial zone，DNS 在 DNSPod）|
| 管理 Worker  | `pages-manager`，绑定 `api.workers.xd.team`             |
| Workers KV   | 站点元数据存储，namespace ID 由环境变量配置              |
| CF API Token | Workers Scripts Write + Workers Routes Write + KV Write |

### 不需要

| 砍掉           | 替代方案                  |
| -------------- | ------------------------- |
| ~~ECS~~        | 管理服务 → CF Worker      |
| ~~Nginx~~      | 静态/SPA → Workers Assets |
| ~~OSS~~        | 文件存储 → Workers Assets |
| ~~ALB~~        | 负载均衡 → CF Edge        |
| ~~通配符证书~~ | → CF Advanced Certificate |

## 文件结构

```
pages-manager/
├── README.md
├── API.md
├── pages-deploy.skill.md
├── pnpm-workspace.yaml
├── apps/
│   ├── server/
│   │   ├── wrangler.template.toml
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.js
│   │       ├── router.js
│   │       ├── lib/
│   │       │   ├── cf-api.js
│   │       │   └── public-config.js
│   │       └── handlers/
│   │           ├── deploy.js
│   │           ├── site.js
│   │           ├── list.js
│   │           └── health.js
│   └── xdads-302/
│       ├── wrangler.template.toml
│       ├── package.json
│       └── index.js
├── packages/
│   ├── ip-guard/
│   └── worker-kit/
├── scripts/
│   ├── gen-wrangler.sh
│   ├── deploy.sh
│   ├── manage.sh
│   └── migrate-domain.sh
└── demos/
```

## 开发与部署

```bash
pnpm install

# 本地开发管理 Worker
pnpm --dir apps/server dev

# 生成本地 Wrangler 配置后部署管理 Worker
CLOUDFLARE_ACCOUNT_ID=example-account-id \
SITES_KV_NAMESPACE_ID=example-kv-namespace-id \
IP_ALLOWLIST=127.0.0.1,::1 \
scripts/gen-wrangler.sh apps/server production
pnpm --dir apps/server deploy
```

真实 `apps/server/wrangler.toml`、`apps/xdads-302/wrangler.toml`、`.dev.vars`、`.env` 和 `.pages.json` 不提交到 Git。GitHub Actions 部署时会根据 Environment Secrets 生成 `apps/server/wrangler.toml`。

## 路线图

| 阶段     | 内容                                             | 状态      |
| -------- | ------------------------------------------------ | --------- |
| **v1**   | 管理 Worker + static/spa preset + CLI + AI Skill | ✅ 已完成 |
| **v1.5** | worker preset（自定义 Worker / SSR）             | ✅ 已完成 |
| **v2**   | Cloudflare Access + SSO                          | 待开发    |
| **v3**   | 管理面板 (Web UI)                                | 待定      |
