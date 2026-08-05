# apps/server

`apps/server` 是 pages-manager v1 legacy 管理 API Worker。代码已进入墓碑模式，不再执行部署、查询或删除站点等管理操作。

当前主线是 XD Cell v2，位于 `apps/pages-*` 和 `packages/*`。本目录只保留退休响应、健康检查和历史实现；新能力不要写回 v1，也不做 v1 到 v2 的自动迁移。

## 当前 HTTP 行为

- `GET /health`、`HEAD /health`：返回 `200`，供部署和运行探针使用。
- 其它所有路径和方法：在 IP 白名单、请求体解析、Router 和业务 handler 前返回 `410 Gone`。
- 稳定错误码：`LEGACY_API_RETIRED`。
- 退休响应为 JSON，并带 `Cache-Control: no-store`，避免回滚或文案修正时被中间缓存继续复用。
- 用户引导只放在响应的 `message` 字段中：Cindy 用户改用 `xd-sites` 插件，找不到插件时先更新 Cindy；其它客户端改用 `https://skills.xindong.com/skills/xd-cell`。

原 v1 Router、handler、Cloudflare helper 和 Markdown 内容作为 dormant historical code 保留，不再是可调用能力。

## 资源保留边界

退休 API 不等于删除已有站点或 Cloudflare 资源。不得因本目录退休而删除或解绑：

- `pages-manager` API Worker 和 `api.workers.xd.team` Custom Domain
- API route、`SITES` KV
- 旧站点 Worker、exact route、DNS 和 hostname claim
- 现有站点内容、归属 metadata 和历史 token 数据

详细上线顺序见 [`docs/operations/legacy-api-and-site-publishing-retirement.md`](../../docs/operations/legacy-api-and-site-publishing-retirement.md)。

## 维护入口

- 源码：`src/`
- 生产退休入口：`src/index.js`、`src/retirement.js`
- dormant v1 Router 装配：`src/legacy.js`
- 路由处理器：`src/handlers/`
- Cloudflare API 与公共 helper：`src/lib/`
- wrangler 模板：`wrangler.template.toml`
- v1 DNS 文档：`docs/cloudflare-partial-zone-cname.md`
- v1 DNS 修复记录：`docs/dns-fix-workers-xd-team.md`

## 本地命令

从仓库根目录执行：

```bash
pnpm --dir apps/server test
```

生产生效仍需通过 GitHub Actions 手动触发 `Deploy Production`。部署前必须先完成 Site Publishing Lane 冻结和活动任务排空；不要让 v1 workflow 因 push、PR、v2 代码或文档变更自动部署。
