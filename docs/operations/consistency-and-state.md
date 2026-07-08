# XD Cell 一致性与状态机

> 本文从 `docs/pages-v2-wfp-architecture.md` 拆分而来，用于控制单篇文档长度。

### Router 读取路径

`site_routes` 是权威路由表。`pages-router` 通过 hostname 解析 route，但不应每个请求都查 D1。发布或策略变更后，`pages-api` 生成 `route_snapshot:{hostname}`，结构见上文 `KV 与 Cache 数据结构`。

router 查找顺序：

```text
1. L1 memory cache 中的 route pointer + snapshot，TTL 5-30 秒
2. KV route pointer，再读 pointer 指向的 immutable route snapshot
3. D1 site_routes 权威表
```

KV snapshot 只能加速读取，不能成为权限和路由的唯一来源。权限敏感字段必须以 D1 为权威。

### 缓存失效

核心靠版本号，不靠“删除所有缓存”：

```text
site.policyVersion
user.sessionVersion
accessKey.version
jwks.kid
```

写入顺序必须是：

```text
1. 先提交 D1 / Durable Object 权威变更。
2. 再生成新的 immutable KV route snapshot / policy snapshot。
3. 再写 route pointer 指向新的 `routeGeneration` + `policyVersion` snapshot，写入前做单调版本保护。
4. 最后让 router L1 cache 自然过期，或对 strict 事件触发主动刷新。
```

例子：用户被移出 ACL。

```text
1. pages-api 在 D1 更新 site_members。
2. pages-api 将 site_routes.policy_version += 1。
3. pages-api 写入新的 immutable route snapshot。
4. pages-api 写入新的 route pointer。
5. pages-router 的旧 L1 snapshot 最多在 TTL 窗口内存在。
6. 旧 site_session 中的 policyVersion 与新 pointer/snapshot 不匹配时，router 要求重新鉴权或拒绝。
```

站点 `disabled`、删除、封禁和 access key 吊销属于更敏感操作。它们应在 D1/DO 写入成功后立即写入 tombstone pointer 或 bump `strictUntil`，让 router 不再使用旧 snapshot；如业务要求接近实时生效，router 对这些状态走 strict check，直接查 D1 或 DO。

### 一致性等级

不同路径允许不同一致性成本：

| 等级        | 适用场景                                   | 一致性策略                                |
| ----------- | ------------------------------------------ | ----------------------------------------- |
| `fast`      | 普通 `internal` / `org` 页面访问           | 本地 JWT + L1/KV snapshot，允许短传播窗口 |
| `sensitive` | `acl` / `owner` 站点访问                   | 更短 snapshot TTL，版本不匹配时强制刷新   |
| `strict`    | disabled、删除、封禁、access key 创建/吊销 | 直接查 D1/DO，不能只信缓存                |

目标不是让所有子站请求都强一致，而是把强一致成本用在会影响安全边界的路径上。

### 故障处理矩阵

router 遇到缓存、权威存储或 dispatch 异常时，必须按 cache tier 明确处理，不能由实现者临场决定：

| 场景                         | `fast`                                                 | `sensitive`                        | `strict`                 |
| ---------------------------- | ------------------------------------------------------ | ---------------------------------- | ------------------------ |
| L1 miss                      | 读 KV / D1                                             | 读 KV / D1                         | 读 D1/DO                 |
| KV miss                      | 查 D1 并回填 snapshot                                  | 查 D1 并回填 snapshot              | 查 D1/DO，不依赖 KV      |
| snapshot 过期但结构合法      | `internal` 可短暂 max-stale；`org` 需重新检查 session  | 强制刷新；刷新失败则拒绝或重新登录 | 不使用 stale             |
| pointer generation 领先      | 刷新 snapshot；失败则按 D1/DO 可用性决策               | 强制刷新；失败则拒绝或重新登录     | 查 D1/DO                 |
| tombstone / strictUntil 命中 | 不使用 stale，直接查 D1/DO 或拒绝                      | 不使用 stale，直接查 D1/DO 或拒绝  | 拒绝或查 D1/DO           |
| snapshot malformed           | fail closed                                            | fail closed                        | fail closed              |
| hostname 与 environment 不符 | fail closed                                            | fail closed                        | fail closed              |
| D1/DO 超时                   | `internal` 可返回短暂 503 或 max-stale；受保护站点拒绝 | 拒绝或 503，不扩大权限             | 拒绝或 503               |
| dispatch 404 / worker 缺失   | 返回平台 502/503，写审计                               | 返回平台 502/503，写审计           | 返回平台 502/503，写审计 |
| disabled / deleted           | 不 dispatch                                            | 不 dispatch                        | 不 dispatch              |

`max-stale` 只能用于不扩大访问权限的 `internal` 路径，并且必须同时满足 snapshot 未超过 `staleUntil`、没有 tombstone、没有 `strictUntil` 命中、有审计标记和告警指标。任何 malformed、串环境、保留 host/path mismatch 都必须 fail closed。

### 发布状态机

v2 发布不能简单理解为“上传 Worker 后写 active version”。发布状态机必须先决定内部 execution mode，再通过对应 provider 完成上传和 verify，最后用同一套 active route / route snapshot 切换流程生效。

```text
1. pages-api 校验 actor、scope、site 权限、idempotency key 和 payload limit。
2. 规范化并校验发布 artifact：
     custom Worker: JSON artifactBundle，包含 mainModule / modules。
     static / SPA: multipart assetManifest + file-* 文件，不接受 generated-worker bundle。
3. 计算 effective execution mode：
     site.execution_mode_override ?? PAGES_EXECUTION_MODE。
4. D1 创建 deployments(status=pending)。
5. status=uploading。
6. 调用 execution provider：
     wfp:
       每次发布都使用新 user Worker 名称，custom Worker 上传 user Worker 到目标环境 dispatch namespace。
       static / SPA 先走 Cloudflare Assets upload session 上传文件，再部署一个薄 assets Worker。
       artifact_ref 形如 wfp://{namespace}/{workerName}。
     normal-worker-slot:
       找到或分配该站点的 available slot。
       custom Worker 覆盖对应 ordinary Worker slot 代码。
       static / SPA 先走普通 Worker assets upload session 上传文件，再覆盖对应 ordinary Worker slot。
       artifact_ref 形如 slot://{environment}/{slotId}/{workerName}。
7. status=uploaded。
8. provider verify：
     wfp: 通过 Cloudflare WFP API 读取新 user Worker。
     normal-worker-slot: 通过 Cloudflare ordinary Worker API 或 slot health endpoint 做最小 verify。
9. status=verified。
10. 创建 immutable site_versions，记录 runtime、execution_provider、dispatch_type、slot_id、artifact_ref 和 content_hash。
11. status=activating。
12. 用 D1 transaction / CAS 更新 site_routes:
     active_version_id = newVersion
     worker_name = newWorkerName
     execution_provider = effective provider
     dispatch_type / dispatch_binding_name / slot_id = provider 返回的 dispatch target
     route_generation += 1
     policy_version 按需更新
13. 写 route snapshot / route pointer 指向新的 `routeGeneration` + `policyVersion`。
14. status=succeeded，返回 url、deploymentId、versionId。公开响应不返回 `worker_name`、`execution_provider`、slot id、service binding 或 dispatch namespace；这些只存在于 D1 权威表、route snapshot 和平台审计中。
15. 如果上一版是 WFP user Worker，写入 `deployment_resource_cleanup_tasks(status=pending)`，等待 route / KV / router L1 cache drain window 后由 Admin Console 或 Cron Trigger 删除旧 Worker。
```

失败处理：

- 1-8 失败：保留旧 active version，不创建新 active route。
- 9 之后、route 激活前失败：保留旧 active version；已创建但未激活的 version 保留为非 active 历史记录或由 reconciliation 标记。
- route 激活必须用上一版 route 的 `active_version_id`、`route_generation` 和 `policy_version` 做 CAS；如果并发 deploy / policy change 已更新 route，本次操作返回 `ROUTE_ACTIVATION_CONFLICT`，清理本次上传的执行面资源，保留并发成功的 route。
- route 激活成功但 snapshot / pointer 写入失败：当前实现立即恢复 previous route，并把 deployment 标记为 `failed`，避免 router 看到 D1 与 KV 指针不一致的半激活状态。route pointer 写入 KV 是 router 可见的提交点；如果 KV pointer 已提交但 DO 自身 pointer state 写入失败，操作仍应视为提交成功，由 reconciliation 修复 DO state，不能回滚 D1。
- `succeeded` 写入失败：deployment 可由 reconciliation job 修正为 `succeeded` 或 `failed_with_active_route`。
- 已上传但未激活的 user Worker / assets：部署失败路径会 best-effort 删除；删除结果和阶段写入 deployment 诊断。删除失败时通过失败诊断和 cleanup task/admin 工具补救，不能反向切换 route。
- 已成功切走的上一版 WFP user Worker：不在请求路径立即删除。先创建 cleanup task，`cleanup_after` 超过 drain window 且确认 active route 不再引用 `worker_name` / `version_id` 后再删除；GC 失败只更新 cleanup task，不把成功发布改成失败。
- deployment 失败记录必须写 `failure_stage` 和脱敏 `failure_diagnostics_json`。普通部署查询最多暴露 `failureStage`；Admin Console 可查看完整诊断，用于判断 `retry_deploy`、等待 drain、检查 Cloudflare 凭证或人工处理 orphan。

新发布流程不把 rollback 作为安全机制：用户可见切换点是 route snapshot pointer，Worker 上传和 D1 route 更新都不是 router 可见提交。历史 rollback API 仍需遵守同一套 active route / snapshot CAS 约束，但后续新设计应优先通过重新发布一个新 WFP Worker 修复问题。
