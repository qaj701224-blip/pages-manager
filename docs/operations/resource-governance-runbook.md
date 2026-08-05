# 资源治理运行手册

本文是 pages-api 与 pages-console 资源治理的运维入口。所有操作都必须指定目标环境，并使用该环境的 pages-api 管理面；production 与 staging 的 D1、KV、Worker namespace 和 hostname 不得交叉使用。

## 1. WFP Orphan Scan

在 Admin Console 打开 `Deployment Cleanups → Orphan Scan`，点击“开始扫描”。扫描只读取当前环境的 dispatch namespace，并与 D1 中的 active route、可回滚版本和 cleanup task 对账。

上游 scripts 清单端点没有正式的分页契约。客户端会防御性解析 `result`，仅当 `result_info` 完全缺失时才接受 undocumented 单页结果；只要 `result_info` 存在，就必须包含合法的原生正整数 `page` / `total_pages`。随后读取 namespace 详情的 `script_count` 做完整性校验。首次数量不一致会自动重试一次；仍不一致时返回 `completeness: "incomplete"`、`scannedCount` 与 `namespaceScriptCount`。

`incomplete` 结果只能查看、筛选和重新扫描，不能触发 backfill。未来任何回收决策都必须基于 `completeness: "complete"` 的扫描结果；不允许通过手工改请求绕过这个门禁。

扫描条数由 Worker 环境变量 `PAGES_WFP_ORPHAN_SCAN_MAX_WORKERS` 限制，默认上限为 10,000。达到上限时接口返回 `WORKER_ORPHAN_SCAN_LIMIT_EXCEEDED`，不会静默截断清单。确认上游 namespace 确实需要更大上限后，再在目标环境调整该变量并重试。

## 2. Orphan backfill 与排空速度

在完整扫描结果中选择 `orphan candidate` 或具体原因筛选结果，点击“Backfill cleanup”。无筛选时不提供全库全选；每批最多 100 个 Worker。页面会展示名称预览，并要求输入 `BULK BACKFILL <数量>` 确认。

服务端会逐名重新校验环境前缀、active route 引用和现有 pending/failed/running cleanup task。通过校验的 Worker 写入 `deployment_resource_cleanup_tasks`，站点已删除的版本使用 `site_deleted_backfill`，其余使用 `orphan_backfill`。客户端提交的 Worker 名称不作为归属证明。

Cron 默认每 15 分钟小批量执行到期任务。排空速度可按以下顺序调优：

1. 观察 Dashboard 的 Pending、Failed 和最老 Pending 积压时长。
2. 在目标环境逐步提高 `DEPLOYMENT_CLEANUP_CRON_LIMIT`，每次调整后确认 Cloudflare API 限流和失败率没有上升。
3. 需要立即处理时，在 Cleanup Tasks 的 failed 筛选中点击“重试全部 failed”；该操作调用 `POST /admin/deployment-cleanups/run-due`，单次 `limit` 不超过 50。
4. 对仍失败的任务先检查 failure stage、drain window 和当前 route 引用，再重试；不要绕过 cleanup task 直接删除 WFP Worker。

示例响应（占位值）：

```json
{
  "summary": { "requested": 2, "created": 1, "skipped": 1 },
  "results": [
    { "workerName": "pages-v2-example", "status": "created" },
    { "workerName": "pages-v2-active", "status": "skipped", "reason": "active_route_reference" }
  ]
}
```

## 3. Legacy v1 站点退役

`GET /admin/v1-sites` 同时返回 KV 站点和 account Worker 对账结果。KV 有记录的站点可以由运营人员人工判断是否仍在使用；`unknown`（Worker 没有对应 KV 站点）和 `platform_reserved`（平台保留清单命中）只展示，永远不可选、不可退役。

平台保留清单内置包含 `pages-api`、`pages-auth`、`pages-router`、`pages-console`、`pages-kv-gateway`、`pages-manager` 及各自 staging 变体；通过 `PAGES_V1_RESERVED_WORKER_NAMES` 可按逗号追加环境专属名称。修改清单后必须同时复核 production 与 staging 前缀，避免误保护或误放行。

单站点退役：

1. 在列表行点击退役，输入站点名称确认。
2. pages-api 只从 KV metadata 解析 account Worker 名称，不接受请求中的 Worker 名称。
3. 服务端依次校验保留清单和环境前缀、删除 account Worker、解绑精确 hostname route、删除 KV key、释放 hostname claim。
4. 任一步失败都 fail-closed，响应会标明失败阶段；不要继续手工执行后续步骤，先处理该阶段的不一致。

批量退役：

- 只对当前筛选结果执行“全选当前筛选结果”；没有筛选时不提供全库全选。
- 每批最多 100 个，服务端并发上限为 5。
- 确认弹窗显示数量和名称预览；执行后逐项显示成功或失败，失败项可单独重试。

route 解绑必须满足：hostname 是完整的 `.workers.xd.team` 域名、route pattern 精确为 `${hostname}/*`、当前绑定脚本与 KV metadata 中解析出的脚本完全一致。wildcard route、其它 zone、平台 Worker 或脚本不匹配时必须拒绝。

## 4. apps/server 下线衔接

在 `/apps/server` 部署路径正式下线前，先冻结 v1 新部署入口并完成一轮 v1 站点盘点。下线后 v1 清单视为冻结快照：正常使用的站点保留，只有人工确认不再使用的站点通过上述 pages-api 管理面退役。不要重新启用旧部署路径来绕过保留清单、hostname claim 或审计。

下线切换至少记录以下检查结果：

- production 与 staging 的 v1 KV、account Worker 和 hostname route 数量分别对齐；
- `unknown` 与 `platform_reserved` Worker 均已人工确认仅展示；
- 活跃站点均有明确的迁移或保留结论；
- 退役失败项已经记录阶段结果，并进入后续人工处理队列。

## 5. Dashboard 与审计

Dashboard 只执行轻量 D1 查询：Pending、Failed 和最老 Pending 积压时长。Orphan 数与 v1 站点数按需扫描，Dashboard 对应卡片显示占位符，不得把未知值显示为零。

每次 backfill、WFP cleanup run-due 和 v1 退役都必须保留管理员审计事件。审计 metadata 只写 actor、站点名、Worker 名称和阶段结果等非敏感定位字段，不写入上游原始 metadata 或任何凭据。
