# Provider 部署诊断接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkboxes for tracking.

**Goal:** 将 WFP 上传和验证子请求的结构化 Provider 错误安全地写入 `failure_diagnostics_json.provider`，并在管理员 Console 展示，保持普通部署 API、Webhook 和旧注入 Provider 兼容。

**Architecture:** `packages/wfp-client` 在 assets session、assets bucket upload、Worker PUT 和 Worker GET verify 四个边界生成带白名单 operation 的 `WfpApiError` 元数据；`apps/pages-api/src/deployments.js` 只从结构化错误中提取允许字段，构造可选的 `provider` 诊断对象；管理员 Console 通过 Admin API 展示同一组字段。网络异常使用固定客户端错误码，不保存底层异常原文。

**Tech Stack:** Node.js `node:test`、Cloudflare Workers-compatible `fetch`/`Response`/`Headers`、D1 JSON diagnostics、pnpm workspace。

---

### Task 1: 为 WFP 请求元数据建立失败测试

**Files:**

- Modify: `packages/wfp-client/src/index.test.js`
- Reference: `packages/wfp-client/src/index.js:16-24,349-383,509-707`

- [x] **Step 1: 写 HTTP Provider 错误测试**

模拟 `success:false` 和 `errors:[{code:10090,message:'...'}]`，响应头加入 `cf-ray`，覆盖 assets session、assets bucket upload、worker PUT，断言 `operation`、`status`、`code`、`providerCode`、`providerRequestId` 和脱敏后的 `providerMessage`。资产上传测试必须让 session 返回 JWT，并确认 JWT 不出现在错误字段中。

- [x] **Step 2: 写网络异常与非法 JSON 测试**

`fetch()` 抛异常时断言 `WFP_NETWORK_ERROR`、operation 存在且没有 status/providerCode/providerRequestId；非法 JSON 时断言 `WFP_API_INVALID_JSON`、响应状态和 request ID 保留，并确认不会被误包装成网络错误。

- [x] **Step 3: 写字段边界测试并运行红灯**

覆盖对象/布尔 provider code、控制字符、超长 code/message/request ID、`x-request-id` fallback。运行 `pnpm --filter @xd/wfp-client test`，确认新增断言因字段尚未实现而失败。

### Task 2: 实现 WFP 结构化错误元数据

**Files:**

- Modify: `packages/wfp-client/src/index.js:16-24,49-130,349-383,509-707`
- Test: `packages/wfp-client/src/index.test.js`

- [x] **Step 1: 扩展 `WfpApiError`**

保留 `code` 的客户端分类语义，新增可选 `operation`、`providerCode`、`providerMessage`、`providerRequestId`，仅挂载已经规范化的值。

- [x] **Step 2: 给上传和验证边界传入固定 operation**

固定映射：`assets-upload-session -> assets_upload_session`、asset bucket POST -> `assets_upload`、最终 Worker PUT -> `worker_put`、验证 Worker GET -> `worker_get`。请求包装器的 operation 参数对其他旧调用保持可选。

- [x] **Step 3: 采集并规范化响应元数据**

按 `cf-ray`、`x-request-id` 顺序读取响应头，只接受 `[A-Za-z0-9._:/-]{1,128}`；只读取 `errors[0]` 的原始 string/number code，过滤控制字符并截断 64 字符；message 去控制字符、替换 API token 和当前 session JWT，截断 512 字符。

- [x] **Step 4: 只包装 fetch 前置网络异常**

仅将 `fetch(new Request(...))` 放入网络异常 `try/catch`；`readJson()` 抛出的 `WfpApiError` 原样透传。非法 JSON 使用 `WFP_API_INVALID_JSON` 并保留响应状态/request ID。

- [x] **Step 5: 运行 WFP 测试**

运行 `pnpm --filter @xd/wfp-client test`，确认新增元数据、网络异常、JWT 脱敏和现有测试全部通过。

### Task 3: 为 pages-api 映射建立失败测试

**Files:**

- Modify: `apps/pages-api/src/deployments.test.js`
- Reference: `apps/pages-api/src/deployments.js:505-546,2300-2337`

- [x] **Step 1: 写结构化 upload failure 测试**

在现有上传失败 fixture 中注入带 `code/status/operation/providerCode/providerMessage/providerRequestId` 的 WFP 错误，断言 D1 的 `failureDiagnostics.provider` 具有固定 `name: 'cloudflare_wfp'` 和规范化字段；普通 deployment GET 仍隐藏诊断。

- [x] **Step 2: 写兼容与白名单测试**

普通 `Error('upload failed')` 的旧诊断必须完全不新增 provider；非法 operation/client code/provider code/request ID 必须省略对应字段；非 WFP execution provider 不得写入 `cloudflare_wfp`。

- [x] **Step 3: 写 Admin/Webhook 可见性回归测试**

断言 Admin API 可以看到 provider，普通 deployment 查询和 lifecycle webhook 不携带 provider。运行：

```bash
node --test apps/pages-api/src/deployments.test.js apps/pages-api/src/admin.test.js apps/pages-api/src/webhook-payload.test.js
```

预期新增断言在映射尚未实现时失败。

### Task 4: 实现 pages-api 诊断映射

**Files:**

- Modify: `apps/pages-api/src/deployments.js:519-535,2300-2337`
- Test: `apps/pages-api/src/deployments.test.js`

- [x] **Step 1: 添加白名单映射 helper**

仅当 execution provider 为 `wfp` 且 operation/client code 通过固定白名单时，生成：

```js
{
  name: 'cloudflare_wfp',
  operation,
  httpStatus,
  clientCode,
  providerCode,
  providerMessage,
  providerRequestId,
}
```

字段先做类型、字符集和长度校验；空对象返回 `undefined`；不复制 error.message、detail、stack 或 URL。

- [x] **Step 2: 传入 `buildDeploymentFailureDiagnostics`**

在 `provider.upload` 和 `provider.verify` catch 中调用 helper，将结果作为可选 `provider` 字段加入 schemaVersion 1 对象；普通错误保持旧对象字段等价。

- [x] **Step 3: 运行 pages-api focused tests**

运行上面的 `node --test` 命令，确认结构化诊断、兼容性、Admin 可见性和 Webhook 隔离通过。

### Task 5: 接入 verify_worker 和管理员 Console 展示

**Files:**

- Modify: `packages/wfp-client/src/index.js`, `packages/wfp-client/src/index.test.js`
- Modify: `apps/pages-api/src/deployments.js`, `apps/pages-api/src/deployments.test.js`
- Modify: `apps/pages-console/src/ui/site-display-model.js`, `apps/pages-console/src/ui/pages/SiteDetail.jsx`, `apps/pages-console/src/ui/pages/AdminDashboard.jsx`, `apps/pages-console/src/ui/styles.css`
- Test: `apps/pages-console/src/ui/site-display-model.test.js`, `apps/pages-console/src/ui/admin-management-actions.test.js`

- [x] **Step 1: 记录 Worker GET verify 的结构化错误**

`getUserWorker()` 使用 `worker_get` operation，覆盖 HTTP 错误、网络错误和非法 JSON；保持 token、request body 和底层异常原文不进入诊断。

- [x] **Step 2: 将 verify_worker 失败写入 D1**

保留公开 `DEPLOYMENT_VERIFY_FAILED`，在 `failure_stage=verify_worker` 下复用 Provider 白名单映射；普通 deployment GET 仍隐藏完整诊断。

- [x] **Step 3: 展示管理员诊断字段**

站点部署详情展示 Provider、操作、HTTP 状态、客户端码、Provider 码、摘要和 request ID；管理员失败部署概览提供同样字段的紧凑列。

- [x] **Step 4: 运行 Console focused tests**

```bash
node --test apps/pages-console/src/ui/site-display-model.test.js \
  apps/pages-console/src/ui/admin-management-actions.test.js \
  apps/pages-console/src/ui/site-detail-interaction.test.js
```

### Task 6: 全量验证

**Files:**

- Verify: `packages/wfp-client/src/index.js`
- Verify: `apps/pages-api/src/deployments.js`
- Verify: `docs/superpowers/specs/2026-08-20-deployment-provider-diagnostics-design.md`

- [x] **Step 1: 检查 diff 和敏感信息**

```bash
git diff --check
git diff --stat
git diff -- packages/wfp-client/src/index.js apps/pages-api/src/deployments.js
```

确认没有 Authorization、token、secret、完整 URL、请求体或用户资产进入诊断。

- [x] **Step 2: 运行 lint 和全量测试**

```bash
pnpm lint
pnpm test
```

- [x] **Step 3: 记录实际验证结果**

记录 focused tests、lint、全量测试的实际退出码和失败数；未运行或失败的命令明确说明。
