# pages-api Provider 部署诊断字段设计

## 动机 / 背景

`DEPLOYMENT_UPLOAD_FAILED` 能说明失败发生在上传阶段，但不能说明 WFP 的哪一个子请求失败。`worker-with-assets` 至少包含 assets upload session、assets 文件上传和最终 Worker multipart `PUT` 三个外部调用；当前 pages-api 在 `apps/pages-api/src/deployments.js` 中把 Provider 异常统一转换为公开错误码，并只把通用原因写入 D1。

本设计增加脱敏的 Provider 诊断，使管理员可以按 deployment ID 判断失败子操作、HTTP 状态和 Cloudflare 错误码，同时保持现有 CLI/API 错误契约和敏感信息边界不变。

## 目标与非目标

目标：

- 保留公开错误码 `DEPLOYMENT_UPLOAD_FAILED`，不改变普通 CLI 的错误协议。
- 在现有 `failure_diagnostics_json` 的 `schemaVersion: 1` 对象中增加可选 `provider` 字段。
- 区分 WFP 上传子操作：`assets_upload_session`、`assets_upload`、`worker_put`。
- 保存脱敏的 HTTP 状态、Provider 错误码、错误摘要和请求关联 ID，供 Admin Console/审计回查。
- 对没有 Provider 结构化信息的旧 Provider 或测试注入实现保持兼容。

非目标：

- 不把 Provider 诊断返回给普通部署查询或普通 CLI。
- 不保存完整 Cloudflare response body、请求 URL、请求头、Authorization、token、secret、资产内容或 multipart 数据。
- 不改变重试策略、部署状态机或 route 提交逻辑。
- 不为历史 D1 记录回填不存在的 Provider 原始信息。

## 方案

### 存储结构

现有顶层字段保持不变；失败记录在有信息时增加：

```json
{
  "schemaVersion": 1,
  "stage": "upload_worker",
  "executionProvider": "wfp",
  "deploymentShape": "worker-with-assets",
  "plannedVersionId": "ver_...",
  "plannedWorkerName": "pages-v2-...",
  "uploadCompleted": false,
  "verifyCompleted": false,
  "routePointerCommitted": false,
  "trafficImpact": "old_version_retained",
  "retryable": true,
  "operatorAction": "retry_deploy",
  "cause": {
    "code": "DEPLOYMENT_UPLOAD_FAILED",
    "class": "provider_upload_error"
  },
  "provider": {
    "name": "cloudflare_wfp",
    "operation": "assets_upload_session",
    "httpStatus": 400,
    "code": "10090",
    "message": "脱敏后的错误摘要",
    "requestId": "a2df..."
  }
}
```

`provider` 是可选对象，字段也按实际可用信息可选。`operation` 的允许值为：

- `assets_upload_session`：创建 assets 上传会话。
- `assets_upload`：向 Cloudflare assets endpoint 上传一个或多个 bucket。
- `worker_put`：提交 Worker multipart 内容及 metadata/bindings/assets 配置。

### 错误信息采集

`packages/wfp-client` 在每个外部请求边界附加 operation，`WfpApiError` 保留：

- `status`：响应 HTTP 状态。
- `code`：客户端分类码或 Cloudflare 第一个错误码。
- `message`：现有 token-redacted 错误摘要。
- `requestId`：响应中的 `cf-ray` 或等价请求关联 ID（如存在）。
- `operation`：上述固定子操作。

pages-api 捕获 Provider 异常时，将这些字段映射为 `failureDiagnostics.provider`。没有这些属性时不写空值，保证注入 Provider 和旧记录兼容。

### 脱敏和大小限制

- `message` 最多 512 个字符；保留现有 API token 替换逻辑，并拒绝写入请求体/响应体。
- `code` 只保存字符串化的单个错误码，不保存完整错误数组。
- `requestId` 只保存响应头中的关联 ID，不保存完整 URL 或认证信息。
- `httpStatus` 只接受有限整数状态码。
- 诊断对象通过现有 D1 JSON 序列化路径写入；不新增表或迁移。

### 可见性

- `GET /deployments/:id` 的普通响应继续隐藏 `failureDiagnostics`。
- Admin Console 继续读取完整诊断，并可展示 Provider 子操作和状态。
- 生命周期 webhook 继续不携带 Provider 诊断。

## 测试计划

1. `packages/wfp-client`：模拟三个 WFP 子请求分别失败，断言 `WfpApiError` 带正确 operation、status、code、message 和 requestId；断言 token 不出现在 message/诊断字段中。
2. `apps/pages-api`：模拟 upload 抛出结构化 WFP 错误，断言 D1 `failureDiagnostics.provider` 正确落库；无结构化字段时断言旧诊断结构不变。
3. Admin Console/API：断言管理员可看到 provider 字段，普通 deployment 查询和 webhook 不暴露它。
4. 回归现有 pages-api、wfp-client 测试。

## 风险与回滚

风险主要是错误摘要可能包含 Provider 返回的内部细节。通过字段白名单、长度限制和现有 token 脱敏控制；不改变公开错误响应。若诊断写入导致异常，可移除 `provider` 映射，旧 schema 仍可正常读取。

## Self-review Checklist

- [x] 保持 `schemaVersion: 1` 兼容扩展。
- [x] Provider 诊断仅管理员可见。
- [x] 不记录 token、secret、请求体或完整 URL。
- [x] 覆盖 assets session、assets upload、worker PUT 三个实际子操作。
- [x] 不改变部署状态机和重试行为。
