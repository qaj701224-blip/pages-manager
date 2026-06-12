# Pages Worker API

内部静态站点托管服务。通过 HTTP API 将本地文件发布到 `{name}.workers.xd.team`。

## Base URL

```
https://api.workers.xd.team
```

## 访问控制

管理 API 仅限公司内网 IP 访问（基于 `CF-Connecting-IP` 白名单）。

`X-Pages-Token` / `PAGES_TOKEN` 是站点归属标记，不是强认证。`/deploy`、`/list`、`/site/:name` 查询和删除都必须携带 token。

- `/deploy` 必须携带 `X-Pages-Token: pages_你的邮箱` 请求头，或使用 `token` 表单字段作为备选方式；未携带 token 会返回 `400`。
- 同名站点已有 owner token 时，只有携带原 token 的请求可以覆盖部署；携带不同 token 会返回 `409`。
- `/list` 必须携带 token，只返回当前 token 名下站点，且不会返回 token 字段。
- `/site/:name` 查询和删除必须携带 token，只允许操作当前 token 名下站点；token 不匹配会返回 `403`，查询响应不会返回站点 token。

---

## 端点

### POST /deploy

部署站点。上传文件并发布到 `{name}.workers.xd.team`。

**Content-Type**: `multipart/form-data`

**Token 归属**:

部署必须携带部署者 token，优先通过 `X-Pages-Token` 请求头传递，例如 `pages_zhangsan@xd.com`。也可用表单字段 `token` 作为备选方式。同一 token 可重复覆盖自己的同名站点；如果同名站点已由其他 token 创建，使用不同 token 会返回 `409`。

**表单字段**:

| 字段     | 类型   | 必须 | 说明                                                  |
| -------- | ------ | ---- | ----------------------------------------------------- |
| `name`   | string | 是   | 站点名称，规则: `/^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/` |
| `preset` | string | 否   | `static`（默认）/ `spa` / `worker`                    |
| `token`  | string | 否   | 部署者 token，备选方式；优先使用必填的 `X-Pages-Token` 请求头 |
| `kv`     | string | 否   | Pages KV 开关，仅支持 `true` / `false`；`kv=true` 只支持 `spa` 和 `worker` |
| `file-*` | file   | 是   | 要部署的文件，`filename` 为相对路径                   |

**preset 说明**:

| preset   | 行为                                           | 适用场景                     |
| -------- | ---------------------------------------------- | ---------------------------- |
| `static` | 按路径匹配文件，404 返回 404 页面              | HTML 报告、文档站            |
| `spa`    | 路径未匹配时回退到 `index.html`                | Vue / React / Angular 等 SPA |
| `worker` | 使用上传的 `_worker.js` 作为自定义 Worker 脚本 | SSR、API 代理、动态渲染      |

**Pages KV**:

`kv=true` 显式开启站点级 KV，仅支持 `spa` 和 `worker` preset。未传、`false` 或 `kv=false` 都是关闭；非法 `kv` 值会返回 `400`；`static + kv=true` 会被拒绝。

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

`worker preset` 的 `_worker.js` 如果 import npm 包（包括 `@xd/pages-sdk/worker`），业务构建必须先 bundle/打包成可直接运行的 Worker module，再上传给 pages-manager；pages-manager 不会打包 `_worker.js`。

安全边界：

- 公开 assets 不会让 KV runtime 公开；v1 runtime KV 仍受平台 IP 白名单保护。
- v1 browser KV 是站点级能力，不是用户级隔离，不要存高度敏感数据。
- worker preset 开启 `kv=true` 后，owner `_worker.js` 会收到本站 KV 能力；owner 代码可以误用或泄露自己的能力，平台只强制跨站前缀隔离。

**worker preset 说明**:

使用 `worker` preset 时，表单中必须包含一个 `filename=_worker.js` 的文件。该文件作为 Worker 入口脚本部署，可通过 `env.ASSETS` 访问同时上传的其他静态文件。

如果 `_worker.js` import npm 包，业务构建必须先 bundle/打包；pages-manager 不会对 `_worker.js` 做依赖打包。

`_worker.js` 基本结构:

```js
export default {
  async fetch(request, env) {
    // 自定义逻辑：服务端请求、动态渲染等
    const data = await fetch('https://api.example.com/data').then((r) => r.json());

    // 返回动态 HTML
    return new Response(`<h1>${data.title}</h1>`, {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    });

    // 或回退到静态资源
    // return env.ASSETS.fetch(request);
  },
};
```

**成功响应** `200`:

```json
{
  "status": "ok",
  "name": "q2-report",
  "url": "https://q2-report.workers.xd.team",
  "fileCount": 42,
  "preset": "static",
  "kv": false
}
```

**错误响应** `400`:

```json
{ "error": "无效的站点名称。要求: 小写字母、数字、连字符，2-50 字符" }
```

缺少部署者 token 时：

```json
{
  "error": "缺少部署者 token",
  "field": "token",
  "hint": "请通过 X-Pages-Token 请求头或 token 表单字段提供部署者 token"
}
```

**错误响应** `409`:

同名站点已归属于其他 token，当前请求 token 不匹配。

```json
{
  "error": "站点名称已被占用",
  "field": "name",
  "name": "q2-report",
  "hint": "该名称已被其他部署者使用，请换一个名称或使用原 token"
}
```

**curl 示例**:

```bash
# 部署静态站点
curl -X POST https://api.workers.xd.team/deploy \
  -H "X-Pages-Token: pages_zhangsan@xd.com" \
  -F "name=q2-report" \
  -F "preset=static" \
  -F "file-0=@dist/index.html;filename=index.html" \
  -F "file-1=@dist/style.css;filename=style.css"

# 部署 SPA（Vue/React 构建产物）
curl -X POST https://api.workers.xd.team/deploy \
  -H "X-Pages-Token: pages_zhangsan@xd.com" \
  -F "name=my-app" \
  -F "preset=spa" \
  -F "kv=true" \
  -F "file-0=@dist/index.html;filename=index.html" \
  -F "file-1=@dist/assets/index.js;filename=assets/index.js" \
  -F "file-2=@dist/assets/style.css;filename=assets/style.css"

# 部署自定义 Worker（SSR）
curl -X POST https://api.workers.xd.team/deploy \
  -H "X-Pages-Token: pages_zhangsan@xd.com" \
  -F "name=my-ssr" \
  -F "preset=worker" \
  -F "file-0=@_worker.js;filename=_worker.js" \
  -F "file-1=@public/favicon.ico;filename=favicon.ico"
```

---

### GET /list

列出当前 token 名下的已部署站点。必须通过 `X-Pages-Token` 请求头或 `token` 查询参数提供部署者 token；响应不会返回站点 token、`siteUuid`、`siteGeneration` 等内部字段。

**成功响应** `200`:

```json
{
  "sites": [
    {
      "name": "q2-report",
      "url": "https://q2-report.workers.xd.team",
      "preset": "static",
      "ipRestrict": true,
      "kvEnabled": false,
      "updatedAt": "2026-05-13T10:00:00.000Z"
    }
  ],
  "filtered": true
}
```

---

### GET /site/:name

查询当前 token 名下的单个站点详情。必须通过 `X-Pages-Token` 请求头或 `token` 查询参数提供部署者 token；token 不匹配时返回 `403`。成功响应不会返回站点 token。
响应只返回公开字段，不返回 `siteUuid`、`siteGeneration` 等内部 KV 隔离字段。

**成功响应** `200`:

```json
{
  "name": "q2-report",
  "preset": "static",
  "scriptName": "pages-q2-report",
  "url": "https://q2-report.workers.xd.team",
  "fileCount": 42,
  "ipRestrict": true,
  "kvEnabled": false,
  "createdAt": "2026-05-13T10:00:00.000Z",
  "updatedAt": "2026-05-13T12:00:00.000Z"
}
```

**错误响应** `404`:

```json
{ "error": "站点不存在" }
```

---

### DELETE /site/:name

删除当前 token 名下的站点及其 Worker。必须通过 `X-Pages-Token` 请求头或 `token` 查询参数提供部署者 token；token 不匹配时返回 `403`。

**成功响应** `200`:

```json
{
  "status": "ok",
  "name": "q2-report",
  "message": "站点 q2-report 已删除"
}
```

**错误响应** `404`:

```json
{ "error": "站点不存在" }
```

---

### GET /health

健康检查。

**响应** `200`:

```json
{ "status": "ok" }
```

---

## 错误格式

所有错误响应统一格式:

```json
{
  "error": "错误描述",
  "errors": [{ "code": 10000, "message": "详细信息" }]
}
```

`errors` 字段仅在 Cloudflare API 返回错误时存在。

## 约束

- **站点名称**: 小写字母、数字、连字符，2-50 字符，首尾不能是连字符
- **部署 URL**: `https://{name}.workers.xd.team`
- **Worker 名称**: `pages-{name}`（内部使用，用户不需要关心）
- **重复部署**: 同一 token 可直接覆盖自己的同名站点，无需先删除；已有 owner token 的站点不允许不同 token 覆盖
