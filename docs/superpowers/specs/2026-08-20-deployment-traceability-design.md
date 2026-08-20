# 部署全链路可溯源设计

## 动机 / 背景

当前 `deployments.failure_stage` 和 `failure_diagnostics_json` 能记录部署创建后的最终失败阶段；最近增加的 Provider 诊断还可以区分 WFP 的 assets session、assets upload、Worker PUT 和 Worker GET。可是，这些信息仍不足以满足“任意关键环节失败都能溯源”的要求：

- deployment D1 记录创建前的认证、multipart、hash、权限和 artifact 校验失败没有 deployment ID；
- 入站 Cloudflare Ray ID、D1 deployment ID 和出站 Provider request ID 没有统一关联；
- OfficeNet、settings、Worker 删除、placeholder、normal-worker-slot 和 cleanup 等调用没有统一 Provider operation；
- 只保存最终失败快照，没有阶段时间线、耗时、重试和补偿结果；
- 部分恢复、清理和最终状态写回失败会被 best-effort 逻辑吞掉。

## 目标

1. 为每个部署请求建立稳定的 `traceId`，并把它与入站 Ray ID、deployment ID 和 Provider request ID 关联。
2. 让 deployment D1 记录创建前的失败也能通过 trace ID 查询到结构化 intake 事件。
3. 记录部署关键阶段的开始、结束、失败、补偿和耗时；终态字段继续保留为快速摘要。
4. 为部署链路中所有 Cloudflare/WFP 调用提供固定 operation、HTTP 状态、客户端码、Provider code/message/request ID 的安全诊断。
5. 单独记录清理、恢复和状态持久化失败，不能覆盖原始失败，也不能静默丢失。
6. 管理员 Console 可以按 deployment ID 查看阶段时间线和可操作的失败信息；普通用户 API、Webhook 和日志不得泄露 token、secret、请求体或完整 URL。

## 非目标

- 不改变部署的重试、CAS、旧版本保留和 route 提交流程语义。
- 不把完整 Cloudflare response body、Authorization、API token、Assets JWT、secret、用户资产或请求 URL 写入 D1、Console 或普通响应。
- 不为历史记录伪造不存在的 Provider 信息；历史记录只能显示已有的终态摘要。
- 不把 Cloudflare 日志作为唯一真相源；D1 事件记录是管理员排查的主要入口，日志只作为状态写入失败时的兜底。

## 设计

### 1. 关联上下文

部署请求进入 `pages-api` 时生成内部 `traceId`（固定前缀、随机且不可由用户任意注入），同时读取并规范化入站 `cf-ray` 作为 `inboundRayId`。上下文只在服务端内部传播：

```text
traceId
  ├─ inboundRayId                 pages-api 入站边缘请求
  ├─ deploymentId                 D1 deployments（创建成功后）
  ├─ versionId / workerName       计划或已创建的执行资源
  └─ providerRequestId            Cloudflare 出站响应关联 ID
```

部署 API 的成功和错误响应都返回 `X-Deployment-Trace-Id` 响应头，便于 CLI、XD Sites 和 Cloudflare 控制台之间人工关联；响应 body 仍不暴露内部资源信息。D1 `deployments` 增加可选 `trace_id`，旧记录为空时保持兼容。

### 2. `deployment_events` 时间线

新增 D1 表保存不可变阶段事件。`deployment_id` 允许为空，以覆盖 D1 deployment 记录创建前的 intake 失败；deployment 创建成功后，后续事件必须带上 deployment ID。

```text
deployment_events
- id TEXT PRIMARY KEY
- environment TEXT NOT NULL
- trace_id TEXT NOT NULL
- deployment_id TEXT
- site_id TEXT
- attempt INTEGER NOT NULL DEFAULT 1
- stage TEXT NOT NULL
- operation TEXT
- status TEXT NOT NULL
  -- started | succeeded | failed | compensated | skipped
- started_at TEXT NOT NULL
- completed_at TEXT
- duration_ms INTEGER
- error_code TEXT
- error_message TEXT
- diagnostics_json TEXT
- created_at TEXT NOT NULL
```

索引：

- `(environment, deployment_id, started_at)`：按 deployment 查看时间线；
- `(environment, trace_id, started_at)`：按请求关联 intake 和后续事件；
- `(environment, site_id, created_at)`：按站点排查失败趋势。

`diagnostics_json` 只允许安全的白名单字段：`causeClass`、`httpStatus`、`clientCode`、`providerCode`、`providerMessage`、`providerRequestId`、`routePointerCommitted`、`trafficImpact`、`cleanupStatus`、`operatorAction` 等。事件写入失败不能改变部署结果，但必须输出带 `traceId`/`deploymentId` 的结构化 Worker 日志。

### 3. 阶段边界

部署和回滚至少记录以下阶段：

```text
intake
auth_and_site_resolution
payload_validation
deployment_record
runtime_config
provider_upload
provider_verify
runtime_config_commit
version_create
route_policy_lock
office_net
route_activate
route_snapshot
deployment_state_persist
cleanup_or_compensation
webhook_delivery
```

每个阶段至少有一个终态事件。Provider 上传阶段的失败事件必须写实际子操作（例如 `assets_upload_session`、`assets_upload`、`worker_put`）；同一个阶段可通过 `attempt` 区分重试。route snapshot、OfficeNet 和 D1 状态写回的错误必须保留安全的根因分类和补偿结果。

### 4. Provider operation 统一

`@xd/wfp-client` 的 operation 白名单扩展为部署可能调用的所有 Cloudflare 边界，至少包括：

- `assets_upload_session`
- `assets_upload`
- `worker_put`
- `worker_get`
- `worker_settings_get`
- `worker_settings_patch`
- `worker_delete`
- `worker_secret_put`
- `worker_secret_delete`
- `worker_subdomain_disable`
- `worker_placeholder_put`

每个 operation 统一产生 `WfpApiError`。normal-worker-slot 复用相同的安全错误规范化规则；注入 Provider 如果没有结构化字段，则只记录阶段和 `causeClass`，不得伪造 Cloudflare 诊断。

### 5. 补偿与状态持久化

失败处理必须区分：

```json
{
  "originalFailure": { "stage": "provider_upload", "code": "..." },
  "compensation": {
    "status": "succeeded | failed | not_needed | unknown",
    "operation": "worker_delete",
    "providerRequestId": "..."
  },
  "trafficImpact": "old_version_retained"
}
```

清理失败不能覆盖原始部署失败；如果清理需要异步重试，则创建或更新 cleanup task，并在事件中记录 task ID。最终 `succeeded`/`failed` 状态写回 D1 失败时，必须写带 trace/deployment ID 的日志和事件；不能静默合成结果而不留证据。reconciliation 仍可修正 D1 状态，但修正动作也要写事件。

### 6. Admin API / Console

管理员部署详情返回：

- deployment 基本信息和终态摘要；
- `traceId`、inbound Ray ID（如有）；
- 按时间排序的阶段事件；
- Provider operation、HTTP、客户端码、Provider 码、摘要和 request ID；
- 清理/恢复结果、traffic impact 和 operator action。

普通 deployment 查询继续隐藏完整事件和 Provider 诊断；生命周期 webhook 不携带事件详情。Console 先在失败部署详情中展示时间线，列表页只显示阶段和简短摘要，避免大响应和敏感信息泄露。

## 错误与降级策略

- D1 deployment 创建前失败：写 `deployment_events` 的 `intake` 事件；若事件表也不可用，则返回 trace header 并写结构化日志。
- D1 事件写入失败：不改变用户看到的原始错误，日志必须包含 `traceId`、`deploymentId`、stage 和安全错误分类。
- Provider 没有 response：记录 `WFP_NETWORK_ERROR`，不伪造 HTTP/provider 字段。
- Provider 返回非法 JSON：记录 `WFP_API_INVALID_JSON`、HTTP 状态和 request ID（若有）。
- 补偿失败：保留原始失败，标记 `compensation.status=failed`，必要时创建 cleanup task 和告警。
- 诊断字段超过长度、包含控制字符或疑似凭证：丢弃该字段，不丢弃整条失败事件。

## 验证方案

1. Schema/store：覆盖 migration、事件插入/读取、deployment/trace 双索引和旧数据库兼容。
2. pages-api：为每个阶段写失败测试，验证事件顺序、失败摘要、补偿结果和 D1 写失败日志。
3. WFP client：覆盖所有 operation 的 HTTP 错误、非法 JSON、网络错误、request ID fallback 和敏感信息脱敏。
4. API 边界：验证 trace header；普通 API/Webhook 不暴露事件；管理员 API 可读取事件。
5. Console：验证阶段时间线、Provider 字段、长消息换行和空事件状态。
6. 回归执行 `pnpm lint`、`pnpm test`、`git diff --check`，并在 staging 产生一次成功和一次受控失败部署，确认 D1、Cloudflare 日志和 Console 可以用同一 trace/deployment ID 串联。

## 风险与回滚

- 新表写入是 best-effort，事件写失败不会阻断部署；可通过关闭事件写入开关回滚观测层，不影响既有状态机。
- `deployments.trace_id` 和新表均为向后兼容新增字段；回滚 pages-api 后旧代码忽略这些字段。
- Provider operation 扩展只增加错误元数据，不改变公开错误码；发现脱敏风险时可暂时移除 Provider message，保留 code/request ID。

## Self-review Checklist

- [x] 覆盖 D1 创建前和创建后的失败路径。
- [x] 保留现有 `failure_stage`/`failure_diagnostics_json` 作为终态摘要。
- [x] 明确 trace、deployment、version、Provider request ID 的关系。
- [x] 明确补偿失败和状态写回失败的记录规则。
- [x] 明确普通用户、Webhook、Console 管理员的可见性边界。
- [x] 没有把 token、secret、请求体或完整 URL 纳入存储契约。
- [x] 验证方案覆盖测试、staging 受控失败和回滚。
