# XD Cell 公网 CLI 与 S2S API 防护设计

## 背景

`xd-cell` CLI 需要从公网调用 `pages-api`，现有 XDMaker S2S issue/revoke 接口也已经接入公网调用。API 本身已有 token、access key、session、scope 和 owner/team 鉴权；公司出口 IP allowlist 不再作为 `pages-api` 的访问控制，但继续用于部署后子站的 router 门禁和现有 Console 网络边界。

## 目标

- `pages-api` 的所有对外管理 API method/path 都从公网 IP allowlist 中放行；API 访问控制统一依赖各 handler 的鉴权和授权。
- 公网 `pages-api` 请求只接受 HTTPS；HTTP 请求在 Worker 入口直接拒绝。
- 保持现有 CLI token、access key 和 S2S HMAC 鉴权、授权、限频与业务行为不变。
- 用完整的正反路由矩阵防止公开范围意外扩大。

## 非目标

- 不修改 access key 的创建、查询和吊销接口权限。
- 不修改 `pages-router` 对已部署子站的 `ROUTER_IP_ALLOWLIST_CIDRS` 门禁。
- 不修改 `pages-console` 的现有公司网络 IP 门禁、session、管理员权限或 CSRF 行为。
- 不修改 access key scope 或现有权限能力。
- 不修改 S2S URL、method、headers、HMAC canonical input、body、response、错误码、timestamp window、nonce 或限频。
- 不修改 Cloudflare WAF、Redirect、Rate Limiting 或其它控制台规则。
- 不自动部署 staging 或 production。

## 请求入口顺序

Worker 对请求按以下顺序处理：

1. 读取并校验环境配置。
2. 对非本地请求校验 URL scheme；不是 `https:` 时返回 `HTTPS_REQUIRED`，不重定向，也不进入 IP、认证或业务 handler。
3. 处理 health 和公开文档。
4. 进入现有 API handler；所有对外管理 API 路径都不再执行来源 IP 校验。

本地环境继续允许 HTTP，避免破坏本地开发。`pages-api.internal` 等 service binding host 继续由 internal host 边界保护，但请求仍使用 HTTPS。

HTTP 请求返回固定 JSON 错误，不使用 301、302、307 或 308。这样不会让带签名或 bearer credential 的 POST 请求产生重放、签名路径变化或客户端重定向差异。完整响应固定为 HTTP `400`：`{"error":{"code":"HTTPS_REQUIRED","message":"HTTPS is required.","action":"Use an https:// API URL."}}`，并带 `Cache-Control: no-store`。所有现有 HTTPS 请求保持原响应。

## 公网路由边界

所有对外管理 API 路径都可从公网到达，但不代表匿名访问。CLI、access key、session 和 S2S handler 继续执行各自的认证、scope、owner/team、用户状态、HMAC、timestamp、nonce 和限频校验；internal host 与 Console BFF lane 仍只通过 service binding 访问。未知路径继续返回 `NOT_FOUND`，不能因公网放行而泄露 handler 或内部资源信息。

## S2S 滥用防护

公网化后，未通过 HMAC 签名的 S2S 请求不逐条写入 D1 deny audit，避免攻击者利用公开的 client/key id 触发数据库写放大。通过签名后的重放、限频和业务拒绝继续记录现有审计。该调整不改变任何 HTTP status、公开错误码或成功响应。

## 测试策略

- 表驱动覆盖每个公开 CLI/S2S method/path 的正例。
- 覆盖错误 method、相似前缀、额外 segment、未转义点号可误匹配的路径和 S2S revoke。
- 确认 access key、transfer、rollback 和其它管理 API 在公司出口外不再返回 `IP_NOT_ALLOWED`，而是进入各自的鉴权/授权结果。
- 确认 production/staging 外部 HTTP 请求返回 `HTTPS_REQUIRED`，且不会调用 store 或业务 handler。
- 确认 local HTTP 请求行为不变；router 和 Console 的 production/staging IP allowlist 测试继续通过。
- 运行 pages-api focused tests、`pnpm lint` 和完整 `pnpm test`。

## 发布与回滚

代码合并后仍由现有 GitHub Actions 手动部署 staging 和 production。staging 验证包含公网 HTTPS API 调用、S2S issue/revoke、HTTP 拒绝、router 子站 IP 门禁和 Console 公司网络门禁。回滚只需回退 Worker 版本；本设计不依赖 Cloudflare 控制台规则变更。
