# XD Cell Console 实施计划

> **给 agent 执行者:** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans` 按任务执行。所有步骤使用 checkbox（`- [ ]`）追踪，不要跳过测试和 review 检查点。

**目标:** 新增 `apps/pages-console`，实现 XD Cell 站点目录、个人工作台、站点详情、团队协作和平台管理员后台，并补齐 `pages-api` / `pages-auth` 需要的控制面能力。

**架构:** `apps/pages-console` 使用 Cloudflare Worker with Assets + 轻 BFF。BFF 负责浏览器 session、CSRF/Origin 校验、staging/admin gate 和 UI 聚合；业务真相源和权限判断仍在 `pages-api` / `pages-auth`。第一版可以先交付只读目录和工作台，再逐步启用团队、Access Key、Admin 和 Webhook。

**技术栈:** Cloudflare Workers、Worker with Assets、React + Vite、JavaScript ESM、D1 schema/store、service binding、`node:test`、现有 `@xd/worker-kit`、现有 `packages/ip-guard`。

---

## 资料来源

- `docs/superpowers/specs/2026-06-30-xd-cell-console-product-design.md`
- `docs/superpowers/specs/2026-06-30-xd-cell-console-permissions-data-design.md`
- `docs/superpowers/specs/2026-06-30-xd-cell-console-wireframes.md`
- `docs/architecture/publishing-and-runtime.md`
- `docs/architecture/github-automation.md`
- `docs/architecture/db-schema.md`

## 范围与非目标

- 第一版不支持从网页上传并发布站点；`publisher` 表示可通过 CLI / CI / AI / agent 等受控入口发布。
- 不新增站点标题、分类、简介概念；目录卡片只展示 slug、hostname、owner、visibility 和状态 tag。
- 不增加工作台首页；`/workspace` 默认进入个人站点。
- 不增加团队详情里的站点列表；团队站点在 Workspace 的团队站点列表里跨团队过滤。
- Admin Webhook 是平台级出站订阅，不是 GitHub / Slack / executor callback 入站诊断。
- 不把 v1 `apps/server` 作为新能力来源；只在路由和部署文档需要时确认不冲突。

## 文件地图

新增 `apps/pages-console`：

- `apps/pages-console/package.json`：包名、脚本和前端依赖。
- `apps/pages-console/vite.config.js`：Vite 构建配置。
- `apps/pages-console/index.html`：React 入口 HTML。
- `apps/pages-console/src/worker/index.js`：Worker 入口、静态资源 fallback、BFF API 路由、staging/admin gate。
- `apps/pages-console/src/worker/session.js`：console session cookie 签名、解析和清理。
- `apps/pages-console/src/worker/security.js`：host allowlist、IP allowlist、CSRF、Origin/Referer 校验。
- `apps/pages-console/src/worker/pages-api-client.js`：调用 `pages-api` service binding。
- `apps/pages-console/src/worker/pages-auth-client.js`：调用 `pages-auth` service binding。
- `apps/pages-console/src/ui/**`：React 页面、组件、样式和 UI helper。

修改 `apps/pages-auth`：

- `apps/pages-auth/src/console-session.js`：console login code 创建和消费。
- `apps/pages-auth/src/oauth-state.js`：支持 `kind=console` 的 OAuth state。
- `apps/pages-auth/src/oauth-endpoints.js`：SSO callback 后生成 console login code。
- `apps/pages-auth/src/do-storage.js` / `apps/pages-auth/src/index.js`：内部 console exchange action 和路由。

修改 `apps/pages-api`：

- `apps/pages-api/migrations/0011_console_foundation.sql`：console 基础数据模型。
- `apps/pages-api/src/schema.js`：`SCHEMA_VERSION` 从 10 升到 11。
- `apps/pages-api/src/console.js`：console 只读聚合 API。
- `apps/pages-api/src/teams.js`：团队、成员、团队设置 API。
- `apps/pages-api/src/org-directory.js`：XDS list-by-email client 和响应归一化。
- `apps/pages-api/src/platform-admins.js`：平台管理员 grant/revoke/check。
- `apps/pages-api/src/admin.js`：Admin dashboard、ops、用户、站点、团队、审计和团队合并。
- `apps/pages-api/src/webhooks.js`：出站 Webhook 订阅、模板和投递记录。
- `apps/pages-api/src/webhook-payload.js`：标准 payload 与受限模板渲染。
- `apps/pages-api/src/webhook-dispatcher.js`：SSRF 校验、投递、重试时间计算。
- `apps/pages-api/src/store.js` / `apps/pages-api/src/test-store.js`：D1 与 in-memory store 方法补齐。

部署与工具：

- `apps/pages-console/wrangler.production.template.toml`
- `apps/pages-console/wrangler.staging.template.toml`
- `scripts/render-pages-v2-wrangler.mjs`
- `.github/workflows/deploy-pages-v2.yml`
- `.github/workflows/deploy-pages-v2-staging.yml`

## 横向安全约束

- `pages-console` BFF 调 `pages-api` console API 必须使用 service binding 到 `https://pages-api.internal`。
- `pages-api` 读取 `X-Console-*` 身份 header 前，必须先确认请求 host 是 `pages-api.internal` 且包含 BFF 标识，例如 `X-Console-BFF: pages-console`。
- 公网 `api.pages.xd.team` 请求即使伪造 `X-Console-User-Id` / `X-Console-Admin`，也必须在授权前被拒绝。
- `pages-console` Worker 所有页面、静态资源和 `/api/console/*` BFF API 都必须先经过 `@xd/ip-guard` IP allowlist；公网 IP 请求在登录、session、admin gate、CSRF、service binding 调用之前返回 403。
- `staging.workers.xd.team` 在 IP allowlist 后，除 auth login/callback 的 session / admin gate 例外外，所有页面和静态资源都要求平台管理员 session。
- `workers.xd.team/` 未登录站点目录只展示 `internal` 站点；该能力仍处于 console IP allowlist 内，不提供公网匿名目录。
- Access Key plaintext 只在创建时返回一次；secret value、token、完整 Webhook URL、provider resource id 不出现在列表、日志、审计导出或错误响应中。
- Webhook URL 作为 bearer secret 处理；第一版不额外提供 signing secret 或 HMAC 签名。创建后 API、列表、日志和审计记录不得返回完整 URL。
- Webhook 创建、编辑、每次投递都必须执行 SSRF 校验，只允许 `https://`，禁止 localhost、私网、link-local、metadata endpoint，第一版不跟随 redirect。
- `workers.xd.team` / `staging.workers.xd.team` 以及 `admin`、`workspace`、`api`、`auth`、`staging` 等平台 reserved slug / hostname 不能被创建或 claim 为用户站点。

---

## 任务 1： 搭建 `apps/pages-console` Worker with Assets

**文件:**

- 新建：`apps/pages-console/package.json`
- 新建：`apps/pages-console/vite.config.js`
- 新建：`apps/pages-console/index.html`
- 新建：`apps/pages-console/src/worker/index.js`
- 新建：`apps/pages-console/src/ui/main.jsx`
- 新建：`apps/pages-console/src/ui/App.jsx`
- 新建：`apps/pages-console/src/ui/styles.css`
- 测试：`apps/pages-console/src/worker/index.test.js`

- [ ] **步骤 1：写 Worker 冒烟测试**

覆盖：

- `https://workers.xd.team/` 返回 app shell。
- `https://workers.xd.team/workspace/published` 返回 app shell，由前端路由接管。
- `/api/console/missing` 返回 JSON 404，`Cache-Control: no-store`。
- `https://staging.workers.xd.team/` 返回 app shell；IP allowlist、session 和 staging admin gate 在任务 2 / 10 接入。

- [ ] **步骤 2：运行 RED 测试**

```bash
node --test apps/pages-console/src/worker/index.test.js
```

预期：失败，因为 Worker 文件尚不存在。

- [ ] **步骤 3：实现最小 Worker 和 UI**

要求：

- Worker 先处理 `/api/console/*`。
- 其他路径走 `env.ASSETS.fetch(request)`。
- 本任务只搭建 Worker with Assets 和 API 404 骨架；所有路径 IP allowlist 在任务 2 接入，staging admin gate 在任务 10 接入。
- 初始 UI 只显示 `XD Cell`，不要做营销 hero 或上传入口。

`apps/pages-console/package.json` 要使用可复现依赖，不允许 `"latest"`：

```json
{
  "name": "@xd-cell/pages-console",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "vite build",
    "test": "node --test \"src/**/*.test.js\""
  },
  "dependencies": {
    "@xd/ip-guard": "workspace:*",
    "lucide-react": "^0.468.0",
    "react": "^19.1.0",
    "react-dom": "^19.1.0"
  },
  "devDependencies": {
    "@vitejs/plugin-react": "^5.0.0",
    "vite": "^7.0.0",
    "wrangler": "catalog:"
  }
}
```

如果实现时仓库已经把前端依赖迁入 `pnpm-workspace.yaml` catalog，则使用 `catalog:`，但 catalog 里的版本必须固定。

- [ ] **步骤 4：验证**

```bash
node --test apps/pages-console/src/worker/index.test.js
pnpm --filter @xd-cell/pages-console build
```

预期：通过，`apps/pages-console/dist/client` 存在。

- [ ] **步骤 5：提交**

```bash
git add apps/pages-console
git commit -m "feat(pages-console): 添加控制台 Worker 基础"
```

## 任务 2： 浏览器安全和 BFF session helper

**文件:**

- 新建：`apps/pages-console/src/worker/security.js`
- 新建：`apps/pages-console/src/worker/session.js`
- 修改：`apps/pages-console/src/worker/index.js`
- 测试：`apps/pages-console/src/worker/security.test.js`
- 测试：`apps/pages-console/src/worker/session.test.js`

- [ ] **步骤 1：写失败测试**

`security.test.js` 覆盖：

- 只允许 `workers.xd.team` 和 `staging.workers.xd.team`。
- 所有 console 流量都必须经过 `@xd/ip-guard`：`/`、`/workspace/*`、`/admin/*`、静态资源、`/api/console/auth/login`、`/api/console/auth/callback`、`/api/console/directory`。
- `CF-Connecting-IP` 不在 `env.IP_ALLOWLIST` 内时，在读取 session、执行 admin gate、CSRF 校验或调用 `pages-api` / `pages-auth` service binding 之前返回 403。
- IP allowlist 外请求 `https://workers.xd.team/`、`/assets/app.js`、`/api/console/auth/login`、`/api/console/directory` 都返回 403。
- IP allowlist 内请求 `/api/console/auth/login` 才继续进入 auth bridge；任务 4 接入 service binding。
- `CF-Connecting-IP` 在 `env.IP_ALLOWLIST` 内时，请求才继续进入后续登录、session、admin gate、CSRF 和 BFF 聚合逻辑。
- IP allowlist 通过后仍不能替代身份鉴权：`/workspace/*` 继续要求用户 session，`/admin/*` 和 `staging.workers.xd.team/*` 继续要求平台管理员 session。
- 写请求缺少同源 `Origin` / `Referer` / CSRF token 时拒绝。
- 同源写请求且 `X-CSRF-Token` 与 `xd_cell_csrf` cookie 匹配时允许。

`session.test.js` 覆盖：

- session cookie 是 host-only，包含 `HttpOnly` / `Secure` / `SameSite=Lax`，不设置 `Domain`。
- 有效签名可以读出 `userId` 和 `isPlatformAdmin`。
- 篡改签名返回 `null`。

- [ ] **步骤 2：运行 RED 测试**

```bash
node --test apps/pages-console/src/worker/security.test.js apps/pages-console/src/worker/session.test.js
```

预期：失败，因为 helper 尚不存在。

- [ ] **步骤 3：实现 helper**

`security.js` 导出：

- `isAllowedConsoleHost(url)`
- `assertConsoleNetworkAllowed(request, env)`
- `assertSafeWriteRequest(request)`
- `isWriteMethod(method)`

`session.js` 导出：

- `serializeConsoleSessionCookie(session, secret)`
- `readConsoleSession(request, secret)`
- `clearConsoleSessionCookie()`

实现要求：

- 使用 Web Crypto HMAC SHA-256。
- `base64url(text)` 用 UTF-8 编码、`btoa`、替换 `+` / `/` 并去掉 `=`。
- `hmacSha256(value, secret)` 返回 hex。
- 使用 constant-time hex 比较；不要用普通 `!==` 比较签名。
- 可复用 `apps/pages-auth/src/id.js` 的 constant-time 模式。
- 过期、格式错误或签名错误时返回 `null`。
- `assertConsoleNetworkAllowed` 使用 `@xd/ip-guard` 的 `isAllowedIP(request.headers.get('CF-Connecting-IP'), env.IP_ALLOWLIST)`。
- IP allowlist 是 console Worker 入口级限制，不区分是否登录；通过后登录后的 `/workspace/*`、`/admin/*` 仍分别要求用户 session / 平台管理员 session。

- [ ] **步骤 4：接入 Worker**

Worker 处理任何 console 请求时，先执行 `assertConsoleNetworkAllowed(request, env)`；失败返回 403 JSON，且不读取 cookie、不做重定向、不调用 `pages-api` / `pages-auth` service binding：

```json
{ "error": { "code": "IP_DENIED" } }
```

网络校验通过后，所有非 GET `/api/console/*` 再执行 `assertSafeWriteRequest`；失败返回 403 JSON：

```json
{ "error": { "code": "CSRF_ORIGIN_INVALID" } }
```

- [ ] **步骤 5：验证并提交**

```bash
node --test apps/pages-console/src/worker/*.test.js
git add apps/pages-console/src/worker
git commit -m "feat(pages-console): 增加浏览器安全与 session helper"
```

## 任务 3： `pages-auth` 控制台登录交换

**文件:**

- 新建：`apps/pages-auth/src/console-session.js`
- 修改：`apps/pages-auth/src/do-storage.js`
- 修改：`apps/pages-auth/src/oauth-state.js`
- 修改：`apps/pages-auth/src/oauth-endpoints.js`
- 修改：`apps/pages-auth/src/index.js`
- 测试：`apps/pages-auth/src/console-session.test.js`
- 测试：`apps/pages-auth/src/oauth-state.test.js`
- 测试：`apps/pages-auth/src/index.test.js`

- [ ] **步骤 1：写失败测试**

覆盖：

- `kind=console` 的 OAuth state 不需要 `siteHost`，只保存相对 `returnTo`。
- console login code 只能消费一次。
- `returnTo` 只允许 `/`、`/workspace*`、`/admin*`，拒绝绝对 URL 和 `//evil`。
- public host 不能访问 `/.xd-pages/internal/console/*`。

- [ ] **步骤 2：运行 RED 测试**

```bash
node --test apps/pages-auth/src/console-session.test.js apps/pages-auth/src/oauth-state.test.js
```

预期：失败。

- [ ] **步骤 3：实现 console session code**

要求：

- 使用 `createOpaqueToken('ost')` / `createOpaqueToken('sec')`，不要引入新的随机 ID helper。
- `createConsoleLoginCode(record, input)` 在 OAuth state consumed 后创建 code。
- `consumeConsoleLoginCode(code, record, options)` 校验 state id、secret hash、过期时间和 consumed 状态。
- user 输出只包含 `userId`、`email`、`employeeStatus`、`sessionVersion`。

- [ ] **步骤 4：接入 OAuth 和内部路由**

新增内部路由：

- `POST /.xd-pages/internal/console/login-code`
- `POST /.xd-pages/internal/console/exchange`

行为：

- `login-code` 生成 `/.xd-pages/auth/authorize?console=1&return_to=<relative path>` 的 authorize URL。
- OAuth callback 如果 state 是 `kind=console`，生成 console login code，并跳回：
  - production：`https://workers.xd.team/api/console/auth/callback?code=...`
  - staging：`https://staging.workers.xd.team/api/console/auth/callback?code=...`
- `exchange` 消费 code，返回 `{ userId, email, employeeStatus, environment, returnTo, isPlatformAdmin }`。
- 所有内部 console endpoint 必须要求 host 为 `pages-auth.internal`。

- [ ] **步骤 5：验证并提交**

```bash
node --test apps/pages-auth/src/console-session.test.js apps/pages-auth/src/oauth-state.test.js apps/pages-auth/src/index.test.js
git add apps/pages-auth/src
git commit -m "feat(pages-auth): 增加控制台登录交换"
```

## 任务 4： `pages-console` 登录桥接

**文件:**

- 新建：`apps/pages-console/src/worker/pages-auth-client.js`
- 修改：`apps/pages-console/src/worker/index.js`
- 修改：`apps/pages-console/src/worker/session.js`
- 测试：`apps/pages-console/src/worker/index.test.js`

- [ ] **步骤 1：写失败测试**

覆盖：

- `/api/console/auth/login?returnTo=/workspace` 调用 `PAGES_AUTH` 并 302 到 authorize URL。
- `/api/console/auth/callback?code=...` 交换 code 后设置 host-only console cookie，并跳回相对 `returnTo`。
- staging callback 交换成功后如果 `isPlatformAdmin=false`，返回 403，清除 cookie，不提供 app 内容。
- logout 清除 session cookie。

- [ ] **步骤 2：实现 `pages-auth-client.js`**

导出：

- `createConsoleLogin(env, returnTo)`
- `exchangeConsoleCode(env, code)`

所有请求通过 service binding 访问 `https://pages-auth.internal/.xd-pages/internal/console/*`，并设置 `Host: pages-auth.internal`。

- [ ] **步骤 3：实现 BFF auth 路由**

新增：

- `GET /api/console/auth/login`
- `GET /api/console/auth/callback`
- `POST /api/console/auth/logout`

staging gate 规则：

- `staging.workers.xd.team/api/console/auth/login` 和 `/api/console/auth/callback` 在 IP allowlist 内无 session 可访问；它们只豁免 session / admin gate，不豁免 IP allowlist。
- callback 交换 code 后必须检查 `isPlatformAdmin=true`。
- 非平台管理员返回 403 并执行 `clearConsoleSessionCookie()`。
- 其他 `staging.workers.xd.team/*` 路径都要求平台管理员 session。

- [ ] **步骤 4：验证并提交**

```bash
node --test apps/pages-console/src/worker/*.test.js
git add apps/pages-console/src/worker
git commit -m "feat(pages-console): 接入控制台登录桥接"
```

## 任务 5： `pages-api` Console 只读聚合 API

本任务先建立 console read-only API 边界和 user-owned 兼容查询。团队 owner、部门团队和 team role 权限在任务 7 接入后，回补本任务的 store 查询和测试。

**文件:**

- 新建：`apps/pages-api/src/console.js`
- 修改：`apps/pages-api/src/index.js`
- 修改：`apps/pages-api/src/store.js`
- 修改：`apps/pages-api/src/test-store.js`
- 测试：`apps/pages-api/src/console.test.js`

- [ ] **步骤 1：写失败测试**

覆盖：

- 未登录目录只返回 `internal` 站点的最小 metadata，不返回 `ownerUserId`、route id、provider id、token、secret。
- `/workspace/sites` 没有 console session 时返回 401。
- 公网 `https://api.pages.xd.team/.xd-pages/api/console/*` 即使伪造 `X-Console-*` header，也在授权前被拒绝。
- 当前 schema 下 user-owned 站点可以通过兼容字段返回；team-owned 结果先返回空数组，任务 7 接入 owner_type / owner_id 后补齐。

测试 helper 应构造两类请求：

- 内部请求：`https://pages-api.internal/.xd-pages/api/console/...`，包含 `Host: pages-api.internal` 和 `X-Console-BFF: pages-console`。
- 公网伪造请求：`https://api.pages.xd.team/.xd-pages/api/console/...`，包含伪造 `X-Console-User-Id` / `X-Console-Admin`，预期 404 或 403。

- [ ] **步骤 2：实现 `console.js`**

路由：

- `GET /.xd-pages/api/console/directory`
- `GET /.xd-pages/api/console/workspace/sites?owner=personal|team`
- `GET /.xd-pages/api/console/sites/:siteId`
- `GET /.xd-pages/api/console/sites/:siteId/deployments`
- `GET /.xd-pages/api/console/sites/:siteId/access`
- `GET /.xd-pages/api/console/sites/:siteId/config`

要求：

- 只有 host 为 `pages-api.internal` 且 `X-Console-BFF: pages-console` 时才读取 `X-Console-*` 身份 header。
- 不把 console API 暴露成公网 `api.pages.xd.team` 端点。
- 响应不得包含 provider resource ID、token、secret、内部 route ID、完整部署错误细节。
- team-owned site、部门团队和团队权限判断留给任务 7；本任务不要临时引入不完整的团队权限模型。

- [ ] **步骤 3：实现 store 方法**

新增：

- `listConsoleDirectorySites({ environment, viewerUserId })`
- `listWorkspaceSites({ environment, userId, ownerFilter })`
- `getConsoleSiteDetail({ environment, userId, siteId })`
- `listConsoleSiteDeployments({ environment, userId, siteId })`

实现边界：

- 使用现有 user-owned site 字段保持兼容。
- `ownerFilter=team` 在任务 7 前可以返回空列表，但 API shape 必须稳定。
- 任务 7 完成后，把 team-owned 查询、owner display name 和 role-based management permission 合并进这些方法。

- [ ] **步骤 4：验证并提交**

```bash
node --test apps/pages-api/src/console.test.js apps/pages-api/src/index.test.js
git add apps/pages-api/src/console.js apps/pages-api/src/console.test.js apps/pages-api/src/index.js apps/pages-api/src/store.js apps/pages-api/src/test-store.js
git commit -m "feat(pages-api): 增加控制台只读聚合 API"
```

## 任务 6： 目录和 Workspace UI

**文件:**

- 新建：`apps/pages-console/src/worker/pages-api-client.js`
- 修改：`apps/pages-console/src/worker/index.js`
- 测试：`apps/pages-console/src/worker/index.test.js`
- 新建：`apps/pages-console/src/ui/api.js`
- 新建：`apps/pages-console/src/ui/components/TopNav.jsx`
- 新建：`apps/pages-console/src/ui/components/Sidebar.jsx`
- 新建：`apps/pages-console/src/ui/pages/SitesDirectory.jsx`
- 新建：`apps/pages-console/src/ui/pages/WorkspaceSites.jsx`
- 修改：`apps/pages-console/src/ui/App.jsx`
- 修改：`apps/pages-console/src/ui/styles.css`
- 测试：`apps/pages-console/src/ui/api.test.js`

- [ ] **步骤 1：写 API helper 测试**

覆盖：

- `fetchJson('/api/console/directory')` 返回 JSON。
- API 错误时抛出 `error.code`。
- 写请求自动带 CSRF header。

- [ ] **步骤 2：实现 BFF -> pages-api proxy**

`pages-api-client.js` 导出：

- `callPagesApiConsole(env, request, { session, path })`

Worker BFF 路由：

- `GET /api/console/directory` -> `GET https://pages-api.internal/.xd-pages/api/console/directory`
- `GET /api/console/workspace/sites` -> `GET https://pages-api.internal/.xd-pages/api/console/workspace/sites`
- `GET /api/console/sites/:siteId/*` -> 对应 `/.xd-pages/api/console/sites/:siteId/*`

要求：

- 通过 service binding 调用 `env.PAGES_API.fetch`，设置 `Host: pages-api.internal` 和 `X-Console-BFF: pages-console`。
- 有 session 时传 `X-Console-User-Id`、`X-Console-Email`、`X-Console-Admin`；无 session 时不传用户身份 header。
- 不透传浏览器传入的 `X-Console-*` header。
- BFF response 统一 `Cache-Control: no-store`。
- IP allowlist、session gate、CSRF 已在任务 2 / 4 的 Worker 前置逻辑处理；本步骤不要绕过。

`index.test.js` 覆盖：

- `/api/console/directory` 调用 `PAGES_API` service binding，而不是公网 `api.pages.xd.team`。
- 浏览器伪造 `X-Console-Admin: true` 不会被透传到 `pages-api`。
- pages-api 返回 401 / 403 时 BFF 保留 JSON error code。

- [ ] **步骤 3：实现 UI**

顶部栏：

- 左侧：`XD Cell`、`Sites`、`工作台`。
- 右侧：主题、语言、通知、登录/用户菜单。
- 平台管理员在用户菜单里看到 `管理员后台`，不是全局一级导航。

首页 / 站点目录：

- 直接站点瀑布流。
- 站点目录只在 console IP allowlist 内可访问；未登录时只展示 `internal` 可见内容。
- 卡片展示 slug、hostname、owner、visibility tag、status tag。
- 不展示标题、分类、简介，不展示 hero、CLI quickstart、上传入口。

Workspace：

- 站点：个人站点、团队站点。
- 协作：团队。
- 设置：账号设置、Access Keys。
- `/workspace` 默认进入个人站点。

- [ ] **步骤 4：验证并提交**

```bash
node --test apps/pages-console/src/worker/index.test.js apps/pages-console/src/ui/api.test.js
pnpm --filter @xd-cell/pages-console build
git add apps/pages-console/src/worker apps/pages-console/src/ui
git commit -m "feat(pages-console): 实现目录和工作台基础界面"
```

## 任务 7： 团队 owner 模型和部门团队基础

**文件:**

- 新建：`apps/pages-api/migrations/0011_console_foundation.sql`
- 修改：`apps/pages-api/src/schema.js`
- 修改：`apps/pages-api/src/store.js`
- 修改：`apps/pages-api/src/test-store.js`
- 修改：`apps/pages-api/src/console.js`
- 测试：`apps/pages-api/src/console.test.js`
- 新建：`apps/pages-api/src/teams.js`
- 测试：`apps/pages-api/src/teams.test.js`
- 测试：`apps/pages-api/src/schema.test.js`

- [ ] **步骤 1：写失败测试**

覆盖：

- 首次部门 hydration 创建 `teamType=department` 团队，自动成员默认 `admin`。
- 手动移除部门自动成员后，同部门再次 hydration 不自动恢复。
- 用户部门从 `XD/Web` 变为 `XD/Platform` 时，旧部门 `department_auto` membership 设置 `removed_at`，新部门 membership 默认 `admin`。
- 自建团队仍有站点或 active team-owned Access Key 时禁止删除。
- `listWorkspaceSites({ ownerFilter: 'team' })` 返回用户所属团队的 team-owned 站点。
- `getConsoleSiteDetail` 对 team-owned site 按 team role 计算管理权限。

- [ ] **步骤 2：更新 schema**

新增或扩展：

- `users.department_path`
- `users.department_checked_at`
- `teams(environment, team_type, name, description, department_path, status, merged_into_team_id, merged_at, merged_by_user_id, merge_reason, deleted_at)`
- `team_members(team_id, user_id, role, membership_source, department_path, role_overridden_at, removed_at, removed_by_user_id, restored_at, restored_by_user_id)`
- `sites.owner_type`
- `sites.owner_id`
- `platform_admins` 表壳，行为在任务 10 接入。

保持 `sites.owner_user_id` 迁移兼容。`SCHEMA_VERSION` 从 10 升到 11。

- [ ] **步骤 3：实现 store 方法**

新增：

- `findOrCreateDepartmentTeam({ environment, departmentPath })`
- `hydrateDepartmentMembership({ environment, userId, departmentPath })`
- `removeTeamMember({ teamId, userId, actorUserId })`
- `restoreTeamMember({ teamId, userId, actorUserId })`
- `getTeamMember({ teamId, userId, includeRemoved })`
- `listTeamsForUser({ environment, userId })`
- `createTeam({ environment, teamType, name, description, createdByUserId })`
- `deleteCustomTeam({ teamId, actorUserId })`
- `countTeamBlockingAssets({ teamId })`
- `listTeamOwnedSitesForUser({ environment, userId, ownerFilter })`
- `getUserSiteTeamRole({ environment, userId, siteId })`

规则：

- 部门自动成员首次加入默认 `admin`。
- 手动角色覆盖后，后续 hydration 不刷回默认 `admin`。
- `removed_at` tombstone 阻止同部门自动恢复。
- 部门路径变化时，旧 `department_auto` membership 立即 removed，新部门按首次关联处理。
- 跨部门长期协作第一版用 `team_type=custom`，不要让部门团队承载。
- 自建团队删除是硬删除，但必须先完成资产盘点：无 active/disabled/held 站点，无 active team-owned Access Key。
- 部门团队不能在 workspace settings 删除。

回补任务 5 的 console 聚合 API：

- `listWorkspaceSites({ ownerFilter: 'team' })` 查询用户所属团队站点，支持跨团队过滤。
- `listConsoleDirectorySites` 登录后可以返回用户可访问的 team-owned / department-team-owned 站点。
- `getConsoleSiteDetail` 返回 owner type、owner display name、team tag 和当前用户 management role。

- [ ] **步骤 4：实现团队 API**

新增：

- `GET /.xd-pages/api/console/teams`
- `GET /.xd-pages/api/console/teams/:teamId`
- `GET /.xd-pages/api/console/teams/:teamId/members`
- `PATCH /.xd-pages/api/console/teams/:teamId/members/:userId`
- `DELETE /.xd-pages/api/console/teams/:teamId/members/:userId`
- `PATCH /.xd-pages/api/console/teams/:teamId/settings`
- `DELETE /.xd-pages/api/console/teams/:teamId`

- [ ] **步骤 5：验证并提交**

```bash
node --test apps/pages-api/src/teams.test.js apps/pages-api/src/schema.test.js apps/pages-api/src/console.test.js
git add apps/pages-api/migrations/0011_console_foundation.sql apps/pages-api/src/schema.js apps/pages-api/src/store.js apps/pages-api/src/test-store.js apps/pages-api/src/console.js apps/pages-api/src/console.test.js apps/pages-api/src/teams.js apps/pages-api/src/teams.test.js
git commit -m "feat(pages-api): 增加团队 owner 与部门团队模型"
```

## 任务 8： XDS 部门信息 hydration

**文件:**

- 新建：`apps/pages-api/src/org-directory.js`
- 修改：`apps/pages-api/src/internal.js`
- 修改：`apps/pages-api/src/store.js`
- 修改：`apps/pages-api/src/test-store.js`
- 修改：`apps/pages-auth/src/oauth-endpoints.js`
- 测试：`apps/pages-api/src/org-directory.test.js`
- 测试：`apps/pages-auth/src/oauth-endpoints.test.js`

- [ ] **步骤 1：写 XDS client 测试**

覆盖：

- XDS item 归一化为 `{ email, userId, name, employeeStatus, departmentPath }`。
- `signXdsRequest({ ts, nonce, token })` 生成 40 位 SHA-1 hex 签名，返回值不包含 token。
- `fetchOrgUsersByEmail` 使用 POST body `{ emails }`。
- XDS HTTP 非 2xx 抛 `XDS_REQUEST_FAILED`。
- XDS JSON `code !== 0` 抛 `XDS_RESPONSE_FAILED`。
- 不传 `nowSeconds` / `nonce` 时默认使用 `Date.now()` 和 `crypto.randomUUID()`。

- [ ] **步骤 2：实现 `org-directory.js`**

导出：

- `signXdsRequest({ ts, nonce, token })`
- `normalizeXdsUserItem(item)`
- `fetchOrgUsersByEmail({ emails, token, fetchImpl = fetch, nowSeconds, nonce })`

默认：

- `nowSeconds = () => Math.floor(Date.now() / 1000)`
- `nonce = () => crypto.randomUUID()`

安全要求：

- `XDS_OPENAI_TOKEN` 只来自 Worker secret / GitHub Actions secret / 本地 ignored env。
- 不记录 token、请求签名 header、原始 XDS 响应、完整个人资料。
- hydration 失败不阻断 SSO 登录。

- [ ] **步骤 3：接入内部 hydration route**

新增 `POST /.xd-pages/internal/users/hydrate-department`：

- 只允许 `Host: pages-api.internal`。
- 读取 `{ userId, email, environment }`。
- 有 `env.XDS_OPENAI_TOKEN` 时调用 XDS。
- 更新 `users.department_path` 和 `users.department_checked_at`。
- 调用 `hydrateDepartmentMembership`。
- XDS 不可用时返回 `{ hydration: { status: 'unavailable' } }`，不暴露 provider 细节。

修改 `apps/pages-auth/src/oauth-endpoints.js`：

- `syncSsoUserProfile` 成功后调用 hydration route。
- hydration 失败不使 SSO callback 失败。
- console 后续可显示“部门团队信息暂不可用”。

- [ ] **步骤 4：验证并提交**

```bash
node --test apps/pages-api/src/org-directory.test.js apps/pages-api/src/teams.test.js apps/pages-auth/src/oauth-endpoints.test.js
git add apps/pages-api/src/org-directory.js apps/pages-api/src/org-directory.test.js apps/pages-api/src/internal.js apps/pages-api/src/store.js apps/pages-api/src/test-store.js apps/pages-auth/src/oauth-endpoints.js apps/pages-auth/src/oauth-endpoints.test.js
git commit -m "feat(pages-api): 接入 XDS 部门团队 hydration"
```

## 任务 9： 站点详情和团队上下文 UI

**文件:**

- 新建：`apps/pages-console/src/ui/pages/SiteDetail.jsx`
- 新建：`apps/pages-console/src/ui/pages/Teams.jsx`
- 修改：`apps/pages-console/src/ui/App.jsx`
- 修改：`apps/pages-console/src/ui/styles.css`

- [ ] **步骤 1：实现站点上下文路由**

路由：

- `/workspace/sites/:siteId`
- `/workspace/sites/:siteId/deployments`
- `/workspace/sites/:siteId/access`
- `/workspace/sites/:siteId/config`
- `/workspace/sites/:siteId/settings`

站点上下文侧栏：

- `← 所有站点`
- site slug
- hostname
- visibility/status tag
- `概览`、`部署记录`、`访问控制`、`运行配置`、`设置`

不要使用 `RunTime` 命名；使用 `运行配置`。

- [ ] **步骤 2：实现团队上下文路由**

路由：

- `/workspace/teams`
- `/workspace/teams/:teamId`
- `/workspace/teams/:teamId/members`
- `/workspace/teams/:teamId/access-keys`
- `/workspace/teams/:teamId/settings`

团队上下文侧栏：

- `← 所有团队`
- team name
- `部门团队` tag
- `成员`、`Access Keys`、`设置`

团队详情不展示站点列表。

- [ ] **步骤 3：验证并提交**

```bash
pnpm --filter @xd-cell/pages-console build
git add apps/pages-console/src/ui
git commit -m "feat(pages-console): 增加站点和团队上下文页面"
```

## 任务 10： 平台管理员授权和 Admin Shell

**文件:**

- 新建：`apps/pages-api/src/platform-admins.js`
- 修改：`apps/pages-api/src/schema.js`
- 修改：`apps/pages-api/src/store.js`
- 修改：`apps/pages-api/src/test-store.js`
- 修改：`apps/pages-console/src/worker/index.js`
- 新建：`apps/pages-console/src/ui/pages/Admin.jsx`
- 测试：`apps/pages-api/src/platform-admins.test.js`
- 测试：`apps/pages-console/src/worker/index.test.js`

- [ ] **步骤 1：写平台管理员测试**

覆盖：

- grant/revoke 按 environment 隔离。
- grant/revoke 写审计。
- 非平台管理员不能访问 `/admin/*`。
- staging 除 auth login/callback 外都要求平台管理员 session；auth login/callback 只豁免 session / admin gate，所有静态资源和 auth 路径仍必须先通过 IP allowlist。
- staging callback 对非平台管理员返回 403 并清 cookie。

- [ ] **步骤 2：实现平台管理员模型**

新增 store 方法：

- `grantPlatformAdmin({ environment, userId, grantedByUserId, grantReason })`
- `revokePlatformAdmin({ environment, userId, revokedByUserId, revokeReason })`
- `isPlatformAdmin({ environment, userId })`
- `listPlatformAdmins({ environment })`

- [ ] **步骤 3：实现 Admin shell**

Admin 左侧导航：

- 运营：`Dashboard`、`Ops 运维`
- 审核 / 管理：`用户`、`站点管理`、`团队管理`
- 审计：`Webhook`、`审计日志`

Admin 入口只在用户菜单里出现，不放顶部全局导航。

- [ ] **步骤 4：验证并提交**

```bash
node --test apps/pages-api/src/platform-admins.test.js apps/pages-console/src/worker/index.test.js
pnpm --filter @xd-cell/pages-console build
git add apps/pages-api/src apps/pages-console/src
git commit -m "feat(console): 增加平台管理员后台入口"
```

## 任务 11： 出站 Webhook 模型和受限模板

**文件:**

- 新建：`apps/pages-api/src/webhook-payload.js`
- 新建：`apps/pages-api/src/webhooks.js`
- 修改：`apps/pages-api/src/schema.js`
- 修改：`apps/pages-api/src/store.js`
- 修改：`apps/pages-api/src/test-store.js`
- 测试：`apps/pages-api/src/webhook-payload.test.js`
- 测试：`apps/pages-api/src/webhooks.test.js`

- [ ] **步骤 1：写 payload 测试**

覆盖：

- 标准 payload 只包含白名单字段。
- `providerResourceId`、token、secret、内部 route id 不进入 payload。
- Slack Incoming Webhook 示例可通过受限模板渲染 `{ text: "..." }`。
- 非白名单变量抛 `WEBHOOK_TEMPLATE_VARIABLE_FORBIDDEN`。
- 缺失变量在字符串位置渲染为空字符串，非字符串位置抛 `WEBHOOK_TEMPLATE_MISSING_VALUE`。
- 创建 subscription 后响应只返回 `urlHost`、`urlMasked`、`urlFingerprint`，不返回完整 Webhook URL。
- `listWebhookSubscriptions`、`listWebhookDeliveries`、审计日志和错误响应都不包含完整 Webhook URL。
- store 层不保存明文完整 URL；使用 `url_secret_ref` 或加密密文保存投递目标，同时保存 `url_host`、`url_fingerprint` 和 masked tail 供 UI 展示。

- [ ] **步骤 2：实现 `webhook-payload.js`**

导出：

- `buildStandardWebhookPayload(event)`
- `validateRestrictedTemplate(template)`
- `renderRestrictedTemplate(template, payload)`
- `payloadHash(payload)`

模板限制：

- 只支持 `{{path}}`。
- 不支持 JS、表达式、helper、循环、条件、网络请求、数据库访问。
- 模板必须是 JSON object / array / string / number / boolean / null。

- [ ] **步骤 3：实现 Webhook schema/store/API**

表：

- `webhook_subscriptions`
- `webhook_deliveries`

`webhook_subscriptions` URL 字段要求：

- `url_secret_ref` 或 `encrypted_url_ciphertext`：二选一，保存投递需要的目标 URL。若当前基础设施没有通用 secret store，第一版使用加密密文，但密钥只能来自 Worker secret。
- `url_host`：只保存 hostname，用于列表和过滤。
- `url_fingerprint`：保存 URL 的 SHA-256 或 HMAC-SHA-256 指纹，用于幂等和排查，不可逆。
- `url_masked`：只保存脱敏展示值，例如 `https://hooks.slack.com/.../abcd`，不要保存 query string 或完整 path。
- 不新增 signing secret；Webhook URL 自身按 bearer secret 处理。

store 方法：

- `createWebhookSubscription(input)`
- `updateWebhookSubscription(id, patch)`
- `listWebhookSubscriptions({ environment })`
- `recordWebhookDelivery(input)`
- `updateWebhookDelivery(id, patch)`
- `listWebhookDeliveries({ environment, subscriptionId })`

API：

- `GET /.xd-pages/api/console/admin/webhooks`
- `POST /.xd-pages/api/console/admin/webhooks`
- `PATCH /.xd-pages/api/console/admin/webhooks/:id`
- `DELETE /.xd-pages/api/console/admin/webhooks/:id`
- `GET /.xd-pages/api/console/admin/webhooks/:id/deliveries`

`DELETE` 表示禁用 subscription，保留投递历史和审计记录。

API 响应要求：

- `POST` 创建成功后不返回完整 URL，只返回 `id`、`name`、`urlHost`、`urlMasked`、`urlFingerprint`、订阅事件和 payload mode。
- `GET` / `PATCH` / delivery 列表不返回 `url_secret_ref`、`encrypted_url_ciphertext`、完整 URL 或 raw payload。
- 只有 dispatcher 内部读取 secret ref / 解密密文得到完整 URL；读取后不得写入日志或错误响应。

- [ ] **步骤 4：验证并提交**

```bash
node --test apps/pages-api/src/webhook-payload.test.js apps/pages-api/src/webhooks.test.js apps/pages-api/src/schema.test.js
git add apps/pages-api/src/webhook-payload.js apps/pages-api/src/webhook-payload.test.js apps/pages-api/src/webhooks.js apps/pages-api/src/webhooks.test.js apps/pages-api/src/schema.js apps/pages-api/src/store.js apps/pages-api/src/test-store.js apps/pages-api/migrations/0011_console_foundation.sql
git commit -m "feat(pages-api): 增加出站 Webhook 订阅模型"
```

## 任务 12： Webhook 投递、SSRF 防护和重试记录

**文件:**

- 新建：`apps/pages-api/src/webhook-dispatcher.js`
- 测试：`apps/pages-api/src/webhook-dispatcher.test.js`
- 修改：`apps/pages-api/src/webhooks.js`

- [ ] **步骤 1：写 dispatcher 测试**

覆盖：

- 拒绝 `http://`。
- 拒绝 localhost、127.0.0.1、10/8、172.16/12、192.168/16、169.254/16、metadata endpoint。
- 拒绝 IPv6 loopback、link-local、unique-local。
- `fetch` 使用 `redirect: 'manual'`，手动处理 3xx，不跟随跳转。
- 每次投递都重新校验 URL。
- 投递 header 包含：
  - `X-XD-Cell-Event`
  - `X-XD-Cell-Delivery`
  - `X-XD-Cell-Timestamp`

- [ ] **步骤 2：实现 dispatcher**

导出：

- `assertSafeWebhookUrl(url, { resolveHost })`
- `dispatchWebhook({ url, eventType, deliveryId, payload, fetchImpl, resolveHost })`
- `nextRetryAt(attemptCount, now)`

要求：

- 不记录完整 URL 或 payload。
- 从 `url_secret_ref` 或加密密文取出完整 URL 后，只在当前投递函数调用内使用，不传给审计、列表响应或错误摘要。
- `nextRetryAt` 有有限次数，最多 5 次。
- 第一版可 inline 调用 dispatcher，但要保持函数边界，未来可迁移到 Cloudflare Queues。

- [ ] **步骤 3：接入投递记录**

`webhooks.js` 内部函数流程：

1. 构建标准 payload。
2. 统一脱敏和字段白名单过滤。
3. 有受限模板时渲染模板。
4. 渲染失败时记录 `render_status=failed`，不发出站请求。
5. 记录 pending delivery。
6. 调用 dispatcher。
7. 更新 delivery status、HTTP status、attempt count、nextRetryAt。

- [ ] **步骤 4：验证并提交**

```bash
node --test apps/pages-api/src/webhook-dispatcher.test.js apps/pages-api/src/webhooks.test.js
git add apps/pages-api/src/webhook-dispatcher.js apps/pages-api/src/webhook-dispatcher.test.js apps/pages-api/src/webhooks.js apps/pages-api/src/webhooks.test.js
git commit -m "feat(pages-api): 增加 Webhook 投递与重试记录"
```

## 任务 13： Admin Webhook UI

**文件:**

- 新建：`apps/pages-console/src/ui/pages/AdminWebhooks.jsx`
- 修改：`apps/pages-console/src/ui/pages/Admin.jsx`
- 修改：`apps/pages-console/src/ui/api.js`
- 修改：`apps/pages-console/src/ui/styles.css`

- [ ] **步骤 1：实现列表和空态**

空态：

- 图标
- `还没有 Webhook`
- 帮助文本
- `新建 Webhook`

列表：

- 名称
- target host
- enabled status
- subscribed events
- payload mode
- last delivery status
- actions

- [ ] **步骤 2：实现创建 / 编辑弹窗**

字段：

- 名称
- Webhook URL
- 订阅事件 chips
- Payload mode segmented control：`标准 payload` / `受限模板`
- 标准 payload 预览
- 受限模板 JSON textarea
- 渲染预览和校验错误

不要让用户写 JS。

- [ ] **步骤 3：实现投递记录面板**

展示：

- event type
- delivery id
- target host
- payload mode
- template revision
- render status
- HTTP status
- attempt count
- deliveredAt / nextRetryAt
- redacted error summary

- [ ] **步骤 4：验证并提交**

```bash
pnpm --filter @xd-cell/pages-console build
git add apps/pages-console/src/ui
git commit -m "feat(pages-console): 增加 Admin Webhook 管理界面"
```

## 任务 14： Admin 治理视图和部门团队合并

**文件:**

- 新建：`apps/pages-api/src/admin.js`
- 新建：`apps/pages-api/src/admin.test.js`
- 修改：`apps/pages-api/src/index.js`
- 新建：`apps/pages-console/src/ui/pages/AdminDashboard.jsx`
- 新建：`apps/pages-console/src/ui/pages/AdminOps.jsx`
- 新建：`apps/pages-console/src/ui/pages/AdminUsers.jsx`
- 新建：`apps/pages-console/src/ui/pages/AdminSites.jsx`
- 新建：`apps/pages-console/src/ui/pages/AdminTeams.jsx`
- 新建：`apps/pages-console/src/ui/pages/AdminAudit.jsx`
- 修改：`apps/pages-console/src/ui/pages/Admin.jsx`

- [ ] **步骤 1：写 Admin API 测试**

覆盖：

- 非平台管理员访问 dashboard 返回 403。
- 部门团队合并会把 source team 的站点、active team-owned Access Key、active `department_auto` membership 转移到 target team。
- source team 标记为 `merged`，写入 `merged_into_team_id`、`merged_at`、`merged_by_user_id`、`merge_reason`。
- 审计 metadata 只记录 source/target team id 和 count，不记录完整成员列表或 secret metadata。

- [ ] **步骤 2：实现 Admin endpoints**

路由：

- `/dashboard`：站点数、用户数、团队数、部署数、失败部署摘要。
- `/ops`：只读运维诊断，每个 block 有 `checkedAt` 和 `source`。
- `/users`：用户列表和平台管理员状态。
- `/sites`：全部站点、过滤、治理摘要。
- `/teams`：全部团队、部门团队过滤、合并预览。
- `POST /teams/:sourceTeamId/merge`：平台管理员合并部门团队。
- `/audit`：审计事件，导出响应已脱敏。

禁止返回 secret value、provider resource id、完整 Webhook URL、token、raw payload。

- [ ] **步骤 3：实现 store merge 方法**

新增：

- `previewDepartmentTeamMerge({ sourceTeamId, targetTeamId })`
- `mergeDepartmentTeams({ sourceTeamId, targetTeamId, actorUserId, reason })`
- `listAdminTeams({ environment, teamType, status })`
- `listAuditEvents({ environment, filters })`

合并规则：

- source / target 都必须是同 environment 的 `teamType=department`。
- source 不能已经 `merged` 或 `deleted`。
- 转移必须在一个事务内完成。

- [ ] **步骤 4：实现 Admin UI**

保持运维工具风格：信息密度高、克制、便于扫描。不要做营销 hero，不要卡片套卡片。

- [ ] **步骤 5：验证并提交**

```bash
node --test apps/pages-api/src/admin.test.js
pnpm --filter @xd-cell/pages-console build
git add apps/pages-api/src/admin.js apps/pages-api/src/admin.test.js apps/pages-api/src/index.js apps/pages-console/src/ui
git commit -m "feat(console): 增加 Admin 治理视图与团队合并"
```

## 任务 15： 运行配置和站点管理写能力

**文件:**

- 修改：`apps/pages-api/src/console.js`
- 修改：`apps/pages-api/src/sites.js`
- 修改：`apps/pages-api/src/runtime-config.js`
- 测试：`apps/pages-api/src/console.test.js`
- 测试：`apps/pages-api/src/sites.test.js`
- 修改：`apps/pages-console/src/ui/pages/SiteDetail.jsx`

- [ ] **步骤 1：写权限测试**

覆盖：

- `publisher` 可以编辑非敏感 Vars。
- `publisher` 不能修改 visibility / ACL / secrets / 删除 / 转移。
- `admin` 可以修改 visibility / ACL / secrets。
- secret value 永不出现在响应里。
- 创建站点或 claim hostname 时拒绝 reserved slug / hostname：`admin`、`workspace`、`api`、`auth`、`staging`、`www`、`assets`、`static`、`internal`、`_xd`、`.xd-pages`、`workers.xd.team`、`staging.workers.xd.team`。

- [ ] **步骤 2：实现写接口**

浏览器同源 BFF 路由：

- `POST /api/console/workspace/sites`
- `PATCH /api/console/sites/:siteId/access`
- `PUT /api/console/sites/:siteId/config/vars/:name`
- `DELETE /api/console/sites/:siteId/config/vars/:name`
- `PUT /api/console/sites/:siteId/config/secrets/:name`
- `DELETE /api/console/sites/:siteId/config/secrets/:name`

`pages-api` internal endpoints：

- `POST /.xd-pages/api/console/workspace/sites`
- `PATCH /.xd-pages/api/console/sites/:siteId/access`
- `PUT /.xd-pages/api/console/sites/:siteId/config/vars/:name`
- `DELETE /.xd-pages/api/console/sites/:siteId/config/vars/:name`
- `PUT /.xd-pages/api/console/sites/:siteId/config/secrets/:name`
- `DELETE /.xd-pages/api/console/sites/:siteId/config/secrets/:name`

所有写接口同时依赖：

- BFF CSRF / Origin / Referer 校验。
- `pages-api` 站点权限校验。
- 站点创建和 hostname claim 统一调用 `assertNotReservedSiteSlugOrHostname(value)`；拒绝时返回 `SITE_SLUG_RESERVED`，提示换一个业务站点名。
- 不把 console 写接口挂到公网 `api.pages.xd.team`；仍只允许 `pages-api.internal` + `X-Console-BFF: pages-console`。

- [ ] **步骤 3：更新 UI**

- 权限不足时展示只读摘要。
- 隐藏或禁用无权限操作。
- secret 只展示 name、revision、updatedAt，不展示 value。

- [ ] **步骤 4：验证并提交**

```bash
node --test apps/pages-api/src/console.test.js apps/pages-api/src/sites.test.js
pnpm --filter @xd-cell/pages-console build
git add apps/pages-api/src apps/pages-console/src/ui/pages/SiteDetail.jsx
git commit -m "feat(console): 增加站点配置管理能力"
```

## 任务 16： Access Key owner 模型扩展

**文件:**

- 修改：`apps/pages-api/src/access-keys.js`
- 修改：`apps/pages-api/src/store.js`
- 修改：`apps/pages-api/src/schema.js`
- 测试：`apps/pages-api/src/access-keys.test.js`
- 修改：`apps/pages-console/src/ui/pages/Teams.jsx`
- 修改：`apps/pages-console/src/ui/pages/WorkspaceSites.jsx`

- [ ] **步骤 1：写 Access Key 测试**

覆盖：

- user-owned key 每次使用都重新计算当前用户权限。
- team-owned key 只能由 team admin 创建。
- 创建者离开团队后，team-owned key 不自动失效。
- 默认有效期 3 个月。
- 最大有效期 1 年。
- staging key 不能调用 production，production key 不能调用 staging。
- plaintext 只在创建响应出现一次，列表和日志不展示。

- [ ] **步骤 2：更新 schema/store/API**

扩展字段：

- `owner_type = user | team`
- `owner_id`
- `created_by_user_id`
- `revoked_by_user_id`
- `revoked_reason`

保持 `owner_user_id` 迁移兼容。

- [ ] **步骤 3：更新 UI**

- Workspace Access Keys 默认创建 user-owned key。
- Team detail Access Keys 创建 team-owned key。
- 创建成功只展示一次 plaintext，并提示保存后不可再查看。

- [ ] **步骤 4：验证并提交**

```bash
node --test apps/pages-api/src/access-keys.test.js
pnpm --filter @xd-cell/pages-console build
git add apps/pages-api/src/access-keys.js apps/pages-api/src/access-keys.test.js apps/pages-api/src/store.js apps/pages-api/src/schema.js apps/pages-console/src/ui
git commit -m "feat(api): 扩展 Access Key owner 模型"
```

## 任务 17： 部署模板和路由预留

**文件:**

- 新建：`apps/pages-console/wrangler.production.template.toml`
- 新建：`apps/pages-console/wrangler.staging.template.toml`
- 修改：`scripts/render-pages-v2-wrangler.mjs`
- 修改：`scripts/render-pages-v2-wrangler.test.js`
- 修改：`.github/workflows/deploy-pages-v2.yml`
- 修改：`.github/workflows/deploy-pages-v2-staging.yml`

- [ ] **步骤 1：写部署测试**

覆盖：

- production console Worker name 和 staging 不同。
- production route 是 `workers.xd.team/*`。
- staging route 是 `staging.workers.xd.team/*`。
- production / staging 模板都包含 `IP_ALLOWLIST = "__IP_ALLOWLIST__"`。
- `scripts/render-pages-v2-wrangler.mjs` 支持 `apps/pages-console`，并要求 `CLOUDFLARE_ACCOUNT_ID` 和 `IP_ALLOWLIST`。
- renderer 对 `apps/pages-console` 继续校验 `IP_ALLOWLIST` 字符集，不允许 unresolved placeholder。
- production workflow 仍然只允许 `workflow_dispatch`。
- push/PR 不会触发 production deploy。
- production / staging workflow component choices 包含 `pages-console`。
- production / staging workflow 给 pages-console renderer 注入 `IP_ALLOWLIST: ${{ vars.IP_ALLOWLIST }}`。
- `workers.xd.team/*` 不抢占 `*.workers.xd.team/*` 用户站点 wildcard route。
- reserved slug / hostname 不能被用户站点创建或 claim，至少覆盖 `admin`、`workspace`、`api`、`auth`、`staging`、`workers.xd.team`、`staging.workers.xd.team`。

- [ ] **步骤 2：增加 wrangler 模板**

production：

- `PAGES_ENV=production`
- `IP_ALLOWLIST=__IP_ALLOWLIST__`
- 绑定 production `pages-api`
- 绑定 production `pages-auth`
- assets 目录
- route `workers.xd.team/*`

staging：

- `PAGES_ENV=staging`
- `IP_ALLOWLIST=__IP_ALLOWLIST__`
- 绑定 staging `pages-api`
- 绑定 staging `pages-auth`
- assets 目录
- route `staging.workers.xd.team/*`

模板里不得写真实 Cloudflare account id、zone id、KV id、D1 id 或 secret。

- [ ] **步骤 3：更新 workflow**

把 `pages-console` 加入现有 v2 部署链路：

- production `component` choices 增加 `pages-console`，但 production 仍只允许 `workflow_dispatch`。
- staging `component` choices 增加 `pages-console`。
- staging push paths 增加 `apps/pages-console/**`。
- 两个 workflow 增加 generate / deploy pages-console 步骤，使用 `node scripts/render-pages-v2-wrangler.mjs apps/pages-console <environment>`。
- 生成 pages-console wrangler 时注入 `CLOUDFLARE_ACCOUNT_ID` 和 `IP_ALLOWLIST`。

- [ ] **步骤 4：验证并提交**

```bash
node --test scripts/render-pages-v2-wrangler.test.js tests/workflows/*.test.js
git add apps/pages-console/wrangler.production.template.toml apps/pages-console/wrangler.staging.template.toml scripts/render-pages-v2-wrangler.mjs scripts/render-pages-v2-wrangler.test.js .github/workflows/deploy-pages-v2.yml .github/workflows/deploy-pages-v2-staging.yml
git commit -m "build(console): 增加控制台 Worker 部署配置"
```

## 任务 18： 文档和最终验收

**文件:**

- 修改：`docs/README.md`，仅当 console 文档成为当前真相源时。
- 修改：`docs/architecture/README.md`，仅当新增架构真相源时。
- 修改：`docs/api-boundary.md`，如果 console browser API boundary 被该文档承载。
- 修改：`apps/pages-api/src/openapi.js`，如果开发期 API 合约需要同步。

- [ ] **步骤 1：更新文档索引**

`docs/superpowers/` 仍作为设计和计划历史，不默认成为当前行为真相源。只有定稿架构文档才加入 `docs/README.md` 真相源矩阵。

- [ ] **步骤 2：跑 聚焦测试**

```bash
node --test apps/pages-api/src/*.test.js apps/pages-auth/src/*.test.js apps/pages-console/src/**/*.test.js
```

预期：通过。

- [ ] **步骤 3：跑根检查**

```bash
pnpm lint
pnpm test
```

预期：通过。

- [ ] **步骤 4：手工验收清单**

在 PR description 记录：

- `workers.xd.team/*` console route 不抢 `*.workers.xd.team/*` 用户站点 wildcard route。
- `workers.xd.team/*` 和 `staging.workers.xd.team/*` 的所有 console 页面、静态资源和 `/api/console/*` 在 IP allowlist 外返回 403。
- `staging.workers.xd.team/*` 除 auth login/callback 的 session / admin gate 例外外要求平台管理员；这些例外仍必须先通过 IP allowlist。
- `/workspace/*` 要求登录。
- `/admin/*` 要求平台管理员。
- 浏览器写 API 强制 CSRF / Origin / Referer。
- 未登录首页目录在 console IP allowlist 内只返回 `internal` 站点，在 IP allowlist 外返回 403。
- 公网 `api.pages.xd.team` 不能伪造 `X-Console-*`。
- reserved slug / hostname 不能创建或 claim 为用户站点。
- Webhook URL 不在日志/API 响应里完整出现。
- Webhook dispatcher 拒绝内网、metadata target 和 redirect。
- secret value、Access Key plaintext 不出现在列表、日志和审计导出。
- production 部署仍然只允许手动触发。

- [ ] **步骤 5：提交文档**

```bash
git add docs apps/pages-api/src/openapi.js
git commit -m "docs(console): 更新 XD Cell 控制台实现边界"
```

---

## 自检结论

- 覆盖 Worker with Assets + 轻 BFF、目录、Workspace、站点详情、团队、Admin、Access Key、XDS、Webhook、部署隔离。
- 明确非目标：无网页上传发布、无站点分类/标题/简介、无工作台首页、Admin Webhook 不是入站诊断。
- 已把安全边界前置：console 全流量 IP allowlist、internal-only console API、staging admin gate、constant-time session、SSRF、secret redaction、生产手动部署。
- Webhook 第一版使用 inline internal dispatch + 持久化投递记录；函数边界保留，后续可迁移 Cloudflare Queues。
