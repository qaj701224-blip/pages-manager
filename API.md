# XD Pages API

XD Pages 的发布入口是 `pages` CLI。普通用户、AI agent 和 CI 不需要手写部署 HTTP 请求；CLI 会自动识别目录、打包资源、上传文件并把服务端返回的部署结果解释给用户。

## Base URL

生产：

```text
https://api.pages.xd.team
```

staging：

```text
https://api-staging.pages.xd.team
```

## 推荐入口

```bash
pages login
pages detect ./dist --json
pages deploy ./dist demo --dry-run --json
pages deploy ./dist demo --visibility org
pages status demo
pages open demo
pages rollback demo <version-id>
```

CI 或 AI agent 可以使用发布 token：

```bash
pages deploy ./dist demo --token <token> --json
```

配置文件只保存非敏感发布意图：

```json
{
  "site": "demo",
  "source": "./dist",
  "fallback": "auto",
  "worker": {
    "entry": "./worker.mjs"
  }
}
```

保存为项目根目录的 `pages.config.json` 后，可以直接运行 `pages deploy`；也可以用 `--config <file>` 显式指定其它配置文件。命令行位置参数和 flag 会覆盖配置文件里的同名发布意图。

`fallback` 表达静态资源未命中时的行为：`auto` 由 CLI 自动判断，`index` 返回 `/index.html`，`not-found` 返回 404 或自定义 404 页面。

## 管理 API

管理 API 供 CLI 调用。除 `/openapi.json`、`/skill.md`、`/readme.md` 外，接口需要认证并受公司网络 / VPN / 办公网出口 IP allowlist 约束。

重要规则：

- 认证和上传协议由 CLI 管理，用户和 AI 不手写认证 header。
- 不把发布 token、CLI token、cookie、SSO code 或 secret 写入项目文件、日志、README、截图或聊天消息。
- 站点名使用小写字母、数字和连字符。
- 部署请求带 `Idempotency-Key`，重试同一请求会返回同一部署结果，内容变化需要新的 key。
- 发布请求的 multipart payload 是 CLI 内部协议，不作为用户或 AI 的手写 API。

## 常用端点

### GET `/openapi.json`

返回当前环境 OpenAPI 文档。

### POST `/.xd-pages/api/deployments`

创建部署。请求体由 CLI 生成，不建议手写。

服务端会校验上传 payload，并返回部署、版本、路由和解析后的 fallback。响应可能包含：

```json
{
  "deployment": { "id": "dep_example", "status": "succeeded" },
  "version": { "id": "ver_example" },
  "route": { "hostname": "demo.pages.xd.team" },
  "decision": {
    "requestedFallback": "auto",
    "resolvedFallback": "index"
  }
}
```

真实 JSON 还会包含给 CLI 和 CI 使用的机器可读解析字段；普通用户不需要手写或选择这些字段。

### GET `/.xd-pages/api/deployments/{id}`

查询部署状态。发布 token 需要具备读取站点权限。

### POST `/.xd-pages/api/versions/{id}/rollback`

回滚到一个已存在版本。请求体可包含 `siteSlug` 作为防误操作校验。

### GET / PATCH `/.xd-pages/api/sites/{id}`

查询或更新站点策略。可见性支持 `internal`、`org`、`acl`、`owner`、`disabled`。

### ACL 端点

- `GET / .xd-pages/api/sites/{id}/acl`
- `PUT / .xd-pages/api/sites/{id}/acl`
- `POST / .xd-pages/api/sites/{id}/acl/entries`
- `DELETE / .xd-pages/api/sites/{id}/acl/entries`

ACL subject 支持邮箱和完整部门路径；部门授权包含子部门。

## Pages KV

旧版 Pages KV 已退休。需要 runtime helper 或 KV 相关能力时，按 `@xd/pages-sdk` 和当前平台文档接入，不要使用旧部署参数。
