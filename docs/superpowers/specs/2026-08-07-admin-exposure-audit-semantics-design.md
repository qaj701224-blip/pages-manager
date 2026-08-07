# Admin Exposure 审计与失败语义设计

## 背景

Admin 开启站点公网访问时，当前链路会先移除并确认当前 Worker 的 `XD_OFFICE_NET`，再提交站点 exposure policy 和 route snapshot。staging 验证发现，`policy_committed` 审计事件直接把缺失的可空字段绑定为 `undefined`，Cloudflare D1 拒绝该参数，导致 policy batch 回滚并返回通用 `SITE_EXPOSURE_UPDATE_FAILED`。此时站点仍是 `internal`，但 Worker 可能已经失去 OfficeNet 能力。

同时，当前 `effective_success` 审计写入失败会把已经确认生效的公网操作返回为 503，造成“实际成功、接口失败”的歧义。

## 目标

1. 所有 D1 审计绑定参数都使用 `null` 或合法值，不再传递 `undefined`。
2. 保持 OfficeNet 作为公网能力的安全屏障：在 snapshot 尚未确认前，router 不会看到 public exposure。
3. 将审计分为权威审计和观测审计，避免已生效操作因观测审计失败被报告为失败。
4. 不改变现有 CLI 或普通用户 API 的 visibility/access_mode 请求和响应语义。

## 非目标

- 本次不引入 `pending_public` 数据状态或崩溃恢复队列。
- 本次不让普通用户或 CLI 修改 exposure。
- 本次不恢复因 OfficeNet 已被移除而丢失的 Worker 能力；该场景通过 internal redeploy 修复。

## 审计分层

### 权威审计

- `attempted`：操作开始前写入。写入失败时不执行外部变更。
- `policy_committed`：与 `site_routes`、`sites`、ACL 变化处于同一个 D1 batch。任一失败，policy mutation 整体回滚；保留 fail-closed 行为。

`auditEventStatement()` 是统一归一化边界：`traceId`、`versionId`、`ipHash`、`userAgentHash` 等可空字段缺失时绑定 `null`。

### 观测审计

- `effective_success`：snapshot pointer 和 payload 确认后写入，只描述最终生效结果。
- “确认”必须同时满足：`readRouteSnapshotState()` 返回 `state: "exact"`，pointer 的 hostname、routeGeneration、policyVersion 和 snapshot key 与提交后的 route 完全对应，且 snapshot payload 与当前完整 route/version/ACL 规范化比较相等。
- 如果 `effective_success` 写入失败，不回滚已经确认的 exposure，也不返回 503；Admin endpoint 仍返回 HTTP 200，响应保留原有 access 字段并附加 `auditStatus: "unconfirmed"`。
- 同时输出固定事件 `SITE_EXPOSURE_AUDIT_UNCONFIRMED` 的 `console.warn` 结构化日志，只包含 `operationId`、`siteId`、`environment` 和归一化错误码；不记录原始异常 message、provider response 或 secret。该固定事件可由现有日志告警规则计数，不新增 metrics 基础设施。
- 成功写入时响应附加 `auditStatus: "confirmed"`。
- 观测审计失败不能写成 `decision=deny` 的 failed 操作，因为 authority 和 effective state 已经成功。

### 失败审计

`office_net_removed_verified`、`office_net_not_applicable`、`reconciled`、`failed`、`partial_failed`、`compensated_failure` 和 `compensation_failed` 记录继续 best-effort。`office_net_not_applicable` 只用于 assets-only 或 normal-worker-slot 等本来没有 WFP OfficeNet 绑定的部署形态，不得伪报为已移除并验证。`pending_activation` 必须与 policy mutation 和 `policy_committed` 一起写入同一个 D1 transaction；它表示 authority 已提交、Router snapshot 尚未确认，不是 snapshot 阶段临时追加的事件。它们不能覆盖原始 `policy_committed` 事件，也不能掩盖真正的安全结果。每个请求的事件 ID 固定为 `${operationId}:${stage}`，同一 operationId/stage 重试必须幂等。

## 执行链路

```text
attempted audit
  -> read active route/version
  -> remove + verify XD_OFFICE_NET (or record not_applicable when no WFP binding exists)
  -> D1 policy mutation + policy_committed audit (atomic: route/site/ACL/cache/legacy projection,
     policyVersion CAS and lease fencing)
  -> pending_activation (already committed in the same D1 batch)
  -> write + read-back route snapshot
  -> effective_success audit (observational)
```

保留“先移除 OfficeNet、再提交 public policy”的安全屏障。这样进程在中途崩溃时最多造成 Worker 能力降级，不会在 Worker 仍带 OfficeNet 时把 authority 提交成 public。若 policy batch 失败，D1 route/site/ACL 不变，返回失败；若 policy 已提交但 snapshot 写入或 exact read-back 失败，必须按当前 route expected tuple 条件以更高 policyVersion 补偿回 internal，再写 safe internal snapshot。无论补偿成功还是失败，这次 public 请求都不能写 `effective_success` 或返回成功：补偿成功返回 HTTP 503 `ROUTE_POLICY_REPAIR_REQUIRED`、`effectiveExposure: "internal"`；补偿失败同样返回 503，并将 `effectiveExposure` 标为实测值或 `unknown`。补偿失败时还要清理当前 pointer（仅在 pointer 仍指向本次快照时）。

阶段事件约束：成功完成 OfficeNet 删除并二次读取确认后记录 `office_net_removed_verified`；`policy_committed` 同批必然同时写入 `pending_activation`，表示 authority 已提交、snapshot 尚未 exact；补偿完成且 internal snapshot exact 时记录 `compensated_failure`；补偿或 pointer 清理无法确认时记录 `compensation_failed`；后续 repair job 或人工 reconciliation 确认 authority/effective 收敛后记录 `reconciled`。这些事件均通过同一 `operationId` 关联，不能把原始 `policy_committed` 改写成失败。

## 测试要求

1. D1 generic audit statement 的严格 bind 回归测试：省略 `traceId`、`versionId`、`ipHash`、`userAgentHash` 等可空字段时不会出现 `undefined`，而是绑定 `null`；其它 audit INSERT 变体继续通过现有测试。
2. Admin exposure 的 `effective_success` 审计写入失败测试：response HTTP status 仍为 200，`auditStatus` 为 `unconfirmed`，不产生 `decision=deny` 的 failed 审计，并记录固定安全 warning code。
3. Snapshot exact 确认测试覆盖 hostname、routeGeneration、policyVersion、snapshot key 和 payload 任一不匹配时不得记录 `effective_success`。
4. policy batch 测试断言 route/site/ACL/cache/legacy projection、CAS 和 lease fencing 与 `policy_committed` 同批原子提交；snapshot compensation 测试断言补偿使用更高 policyVersion 且不会覆盖后续 writer。
5. `office_net_removed_verified`、`pending_activation`、`compensated_failure`、`compensation_failed`、`reconciled` 与其它 `${operationId}:${stage}` 事件重复写入保持幂等；普通 CLI/API visibility/access_mode 测试保持通过。
6. 运行 focused tests、`pnpm lint`、`pnpm test` 和 `git diff --check`。
