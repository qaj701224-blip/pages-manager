# 部署 API 可选 title 设计

## 背景与目标

站点已经支持通过 metadata API 独立设置、修改和清空 `title`，但部署 API 的 multipart `metadata` 目前只读取站点定位、可见性、runtime config 和制品信息。调用方即使显式传入 `title` 也会被忽略。

本增量让 `POST /.xd-pages/api/deployments` 的 metadata 支持可选 `title`，并保持字段存在性语义：

- 不包含 `title`：不修改已有站点名称；新站点保持 `title = null`。
- `title` 为字符串：复用 metadata API 的 NFC、trim、字符和 1–80 Unicode code point 校验后设置名称。
- `title: null`：显式清空名称。

本次只扩展部署 API；CLI 参数和 `xd-cell.config.json` 不新增字段。现有 CLI 不发送 `title`，因此部署时继续保持站点名称不变。

## 方案选择

采用“部署请求显式携带时，复用现有 title-only metadata mutation”的方案。

未采用以下方案：

- 只在首次建站时写入：无法满足已有站点在部署时显式更新名称。
- 部署完成后由调用方额外请求 metadata API：需要两次请求，且调用方容易遗漏第二步。
- 每次部署都从 slug 推导名称：会覆盖用户在 Console 或 metadata API 中维护的名称。

## 请求与校验

部署 intake 必须使用 `Object.hasOwn(metadata, "title")` 区分缺省与显式 `null`，并输出 `requestedTitleProvided` 与规范化后的 `requestedTitle`。显式 `undefined`、空字符串、仅空白、超长或包含禁止控制字符的值返回 `400 SITE_TITLE_INVALID`，且不得创建 deployment、站点或修改 metadata。

只有显式提供 `title` 时才检查 `SITE_METADATA_MUTATIONS_ENABLED`。开关不是精确字符串 `true` 时返回 `503 SITE_METADATA_MUTATIONS_DISABLED`；未提供 `title` 的既有部署不受影响。

`title` 的字段存在性和值必须进入 canonical request hash：省略与 `null` 不等价，相同 Idempotency-Key 携带不同 title 时返回既有 `IDEMPOTENCY_CONFLICT`，不能先修改名称再报冲突。

## 写入时序

部署先完成全部 multipart/制品校验、站点解析、授权、request hash 计算和 deployment idempotency claim。

- 自动创建站点：把规范化 title 放入 pending site creation，在站点创建事务中直接写入。
- 已有站点：仅当 `requestedTitleProvided` 为真时，在新 deployment 记录建立后、provider upload 前调用现有 `updateSiteMetadata` application use case，source 记为 `deploy`；以其 site commit lease、重新授权和 D1 CAS 保证不会越权或覆盖并发变更。
- 幂等 replay 不重复应用 title，避免成功部署后用户另行改名时被旧请求覆盖。

title 是独立站点 metadata。请求已经取得新的 deployment idempotency claim 后，title 更新成功即持久化；后续制品上传或激活失败不回滚 title。这与自动建站后部署失败时站点记录仍保留的现有行为一致，也避免把非路由字段卷入复杂的 Worker/route 补偿事务。

title-only mutation 不修改 slug、hostname、route generation、snapshot、runtime data namespace、active version 或访问策略。

## 错误与响应

- title 校验失败：`400 SITE_TITLE_INVALID`。
- feature flag 关闭：`503 SITE_METADATA_MUTATIONS_DISABLED`。
- 站点在写入前失去权限或被删除：保持不可枚举的 `404 SITE_NOT_FOUND`。
- 并发冲突：`409 SITE_METADATA_CONFLICT`。
- 其它写入错误：`500 SITE_METADATA_UPDATE_FAILED`。

成功响应沿用部署响应；调用方可从站点查询接口读取最终 `title` / `displayName`。不增加内部 route、claim 或 provider 字段。

## 测试与文档

- intake：缺省、字符串、`null`、非法 title；缺省时不受 feature flag 影响。
- idempotency：title 参与 request hash；相同 key 的不同 title 冲突，冲突前不修改名称。
- 新站点：显式字符串/null 正确进入 site creation；缺省保持 null。
- 已有站点：显式字符串设置、null 清空；缺省不调用 metadata mutation。
- 权限/CAS：沿用 metadata use case 的 access-key scope、Owner/团队角色和 commit-time reauthorization 测试。
- 回归：title-only 部署不改变 slug、route、snapshot、runtime namespace；失败映射保持可操作。
- 同步 OpenAPI、`docs/api-boundary.md` 与 pages-api README；继续不公开 `/openapi.json`。

