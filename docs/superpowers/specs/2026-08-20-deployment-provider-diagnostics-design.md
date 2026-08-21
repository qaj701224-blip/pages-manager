# pages-api Provider 部署诊断字段设计

## 动机 / 背景

`DEPLOYMENT_UPLOAD_FAILED` 和 `DEPLOYMENT_VERIFY_FAILED` 能说明失败阶段，但不能说明 WFP 的哪一个子请求失败。`worker-with-assets` 至少包含 assets upload session、assets 文件上传、最终 Worker multipart `PUT` 和验证 Worker 的 `GET` 四个外部调用；当前 pages-api 在 `apps/pages-api/src/deployments.js` 中把 Provider 异常统一转换为公开错误码，并只把通用原因写入 D1。

本设计增加脱敏的 Provider 诊断，使管理员可以按 deployment ID 判断失败子操作、HTTP 状态和 Cloudflare 错误码，同时保持现有 CLI/API 错误契约和敏感信息边界不变。

## 目标与非目标

目标：

- 保留公开错误码 `DEPLOYMENT_UPLOAD_FAILED`，不改变普通 CLI 的错误协议。
- 在现有 `failure_diagnostics_json` 的 `schemaVersion: 1` 对象中增加可选 `provider` 字段。
- 区分 WFP 上传和验证子操作：`assets_upload_session`、`assets_upload`、`worker_put`、`worker_get`。
- 保存脱敏的 HTTP 状态、Provider 错误码、错误摘要和请求关联 ID，供 Admin API/审计回查。
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
    "clientCode": "WFP_API_ERROR",
    "providerCode": "10090",
    "providerMessage": "脱敏后的错误摘要",
    "providerRequestId": "a2df..."
  }
}
```

`provider` 是可选对象；只有捕获到结构化 WFP 错误时才写入。对象内字段也按实际可用信息可选：网络异常没有 HTTP 状态、Provider 错误码或 Provider 请求 ID，但仍可记录操作和客户端分类码。`name` 仅在 `executionProvider === "wfp"` 时由服务端固定映射为 `cloudflare_wfp`，不能来自异常对象或用户输入。`operation` 的允许值为：

- `assets_upload_session`：创建 assets 上传会话。
- `assets_upload`：向 Cloudflare assets endpoint 上传一个或多个 bucket。
- `worker_put`：提交 Worker multipart 内容及 metadata/bindings/assets 配置。
- `worker_get`：读取已上传 Worker，作为部署验证步骤。

### 错误信息采集

`packages/wfp-client` 在上传流程的三个外部请求边界和验证流程的 Worker `GET` 边界附加固定 operation。`WfpApiError` 保留现有 `code` 语义，并新增结构化字段：

- `status`：响应 HTTP 状态；只有整数 `100..599` 才允许映射到诊断。
- `code`：客户端分类码，例如 `WFP_API_ERROR`、`WFP_API_INVALID_JSON` 或 `WFP_NETWORK_ERROR`，映射为 `provider.clientCode`，不能改作 Provider 错误码。
- `providerCode`：Cloudflare 响应 `errors[0].code` 的原始 string/number 字符串化值，最多 64 个字符；对象、数组、布尔值、控制字符值或包含当前请求 token 的值直接省略；只取第一个错误码。
- `providerMessage`：Cloudflare 响应 `errors[0].message` 的脱敏摘要，最多 512 个字符；没有 Provider 响应时不写入。
- `providerRequestId`：出站请求响应头中的 `cf-ray`，缺失时再读 `x-request-id`；这是 Cloudflare API 出站请求的关联 ID，不是 pages-api 入站日志里的 `cf-ray`，没有响应头、值包含当前请求 token 或值不符合 `[A-Za-z0-9._:/-]{1,128}` 时不写入。
- `operation`：上述固定子操作；非部署验证 WFP 方法可以不设置此字段，不纳入本次部署失败诊断契约。

`fetch()` 在收到响应前抛出的异常也要在请求包装层转换为 `WfpApiError`，使用 `code: WFP_NETWORK_ERROR` 和固定摘要 `Cloudflare WFP request failed before receiving a response.`。不得伪造 `status`、`providerCode` 或 `providerRequestId`，也不得把底层异常原文写入 D1。响应不是合法 JSON 时使用 `WFP_API_INVALID_JSON`，保留响应状态和可用的 `providerRequestId`。

pages-api 捕获 Provider 异常时，将这些字段映射为 `failureDiagnostics.provider`。没有这些属性时不写空值，保证注入 Provider 和旧记录兼容。

### 脱敏和大小限制

- `providerMessage` 最多 512 个字符；只取第一个 Provider 错误，去除控制字符并保留现有 API token 替换逻辑。
- `providerCode` 只保存原始 string/number 字符串化的单个错误码，不保存完整错误数组；如果响应回显当前 API token 或 assets session JWT，则省略。
- `providerRequestId` 只保存响应头中的短关联 ID，不保存完整 URL 或认证信息；如果响应头回显当前 API token 或 assets session JWT，则省略。
- `clientCode` 只允许 `WFP_API_ERROR`、`WFP_API_INVALID_JSON`、`WFP_NETWORK_ERROR`，不把任意异常文本当作分类码。
- `operation` 只允许 `assets_upload_session`、`assets_upload`、`worker_put`、`worker_get`；不接受异常对象中的任意字符串。
- `httpStatus` 只接受 `100..599` 的整数状态码。
- 完整 response body、请求体、URL、Authorization 和底层网络异常原文不得进入 `failure_diagnostics_json`。
- 诊断对象通过现有 D1 JSON 序列化路径写入；不新增表或迁移。

### 可见性

- `GET /deployments/:id` 的普通响应继续隐藏 `failureDiagnostics`。
- Admin API 继续读取完整诊断；管理员 Console 的站点部署详情和失败部署概览展示 Provider 字段。普通 deployment 查询和生命周期 webhook 继续不携带 Provider 诊断。
- 生命周期 webhook 继续不携带 Provider 诊断。

## 测试计划

1. `packages/wfp-client`：模拟 assets session、assets upload、worker PUT 和 Worker GET 四个子请求分别返回 Provider 错误，断言 `WfpApiError` 带正确 operation、status、client code、provider code、provider message 和出站 request ID；断言 token 不出现在任何诊断字段中。
2. `packages/wfp-client`：覆盖网络异常和非法 JSON；断言不伪造 HTTP 状态或 Provider code，并保留可用的 operation/request ID。
3. `apps/pages-api`：模拟 upload 和 verify 抛出结构化 WFP 错误，断言 D1 `failureDiagnostics.provider` 正确落库；无结构化字段时断言旧诊断结构不变。
4. Admin API/Console：断言管理员 API 和 Console 可看到 provider 字段；普通 deployment 查询和 webhook 不暴露它。
5. 回归现有 pages-api、wfp-client 测试。

## 风险与回滚

风险主要是错误摘要可能包含 Provider 返回的内部细节。通过只取首个错误、字段白名单、长度限制、控制字符过滤和 token 脱敏控制；不改变公开错误响应。若诊断写入导致异常，可移除 `provider` 映射，旧 schema 仍可正常读取。

## Self-review Checklist

- [x] 保持 `schemaVersion: 1` 兼容扩展。
- [x] Provider 诊断仅管理员可见。
- [x] 不记录 token、secret、请求体或完整 URL。
- [x] 覆盖 assets session、assets upload、worker PUT、Worker GET 四个实际子操作。
- [x] 不改变部署状态机和重试行为。
- [x] 区分 `clientCode`、`providerCode`、`providerMessage`，不覆盖现有 WFP 客户端错误码语义。
- [x] 明确出站 Provider request ID 与 pages-api 入站 Ray ID 的边界。
- [x] 覆盖响应错误、非法 JSON 和网络异常三类请求失败。
- [x] 明确 Provider 诊断只在 Admin API 和管理员 Console 展示，普通 API/Webhook 不暴露。
