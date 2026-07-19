# Pages API Staging Observability 设计

## 背景

`pages-api` 的 production Wrangler 模板已显式启用 Workers Observability logs，但 staging 模板没有对应配置。当前 staging runtime vars API 排障依赖 `pages_runtime_config_failure` 结构化日志；仅在 Cloudflare Dashboard 手动开启会形成环境配置漂移，并可能在后续部署后失去预期状态。

## 目标

- 在 `pages-api-staging` 持久启用 Workers Observability logs。
- staging 使用 `head_sampling_rate = 1`，确保单次诊断请求不会因采样丢失。
- 保持 production 和其它 Worker 模板不变。

## 改动

在 `apps/pages-api/wrangler.staging.template.toml` 的顶层配置中增加：

```toml
[observability.logs]
enabled = true
head_sampling_rate = 1
```

配置位置与 `apps/pages-api/wrangler.production.template.toml` 保持一致。现有 staging 部署 workflow 渲染并部署该模板，不增加新的 Cloudflare 操作步骤。

## 验证

- 在 `scripts/render-pages-v2-wrangler.test.js` 的 Pages API staging 渲染测试中断言生成配置包含完整 Observability block。
- 运行该 focused test、`pnpm lint` 和 `pnpm test`。
- staging 部署后在 Cloudflare Dashboard 的 `pages-api-staging` Observability 页面确认 logs 已启用，并用 `pages_runtime_config_failure` 过滤一次真实 PUT 请求。

## 风险与回滚

100% 采样会增加 staging 日志量和对应成本，但 staging 流量有限，且当前需要可靠捕获单次失败。回滚时移除 staging 模板中的 Observability block 并重新部署 `pages-api-staging`；production 不受影响。
