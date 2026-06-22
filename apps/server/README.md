# apps/server

`apps/server` 是 pages-manager v1 legacy 管理 API Worker，服务旧 `workers.xd.team` 链路。

当前主线是 XD Pages v2，位于 `apps/pages-*` 和 `packages/*`。本目录只做必要维护、bugfix 和安全修复；新能力不要写回 v1。

## 维护入口

- 源码：`src/`
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

生产部署只允许通过 GitHub Actions 手动触发 `Deploy Production`。不要让 v1 workflow 因 v2 代码或文档变更自动部署。
