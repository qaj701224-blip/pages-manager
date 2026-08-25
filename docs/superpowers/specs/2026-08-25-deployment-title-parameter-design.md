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

multipart metadata 解析必须在原始 JSON 对象上使用 `Object.hasOwn(metadata, "title")` 区分缺省与显式 `null`，并把该存在性一直传到 deployment intake。只有字段存在时，intake 才调用现有 `normalizeSiteMetadataPatch({ title }, { environment })` 复用 NFC、trim、字符和长度校验，最终输出 `requestedTitleProvided` 与规范化后的 `requestedTitle`。显式 `undefined`、空字符串、仅空白、超长或包含禁止控制字符的值返回 `400 SITE_TITLE_INVALID`，且不得创建 deployment、站点或修改 metadata。

所有显式提供 `title` 的请求都受 `SITE_METADATA_MUTATIONS_ENABLED` 限制，包括使用既有 Idempotency-Key 的 replay。title 校验先于 feature flag，因此显式非法 title 即使在开关关闭时仍返回 `400 SITE_TITLE_INVALID`；合法 title 在开关不是精确字符串 `true` 时返回 `503 SITE_METADATA_MUTATIONS_DISABLED`。两种错误都发生在站点解析、request hash 和 deployment claim/replay 判断之前，且不创建 deployment 或修改 metadata。未提供 `title` 的部署完全不检查该开关，既有无 title 请求仍可按原路径 replay。

`title` 的字段存在性和值必须进入 canonical request hash，但不能改变未携带 title 的历史请求哈希。实现使用显式条件字段：省略时不向 hash input 增加任何 title 字段；显式提供时增加类似 `titleIntent: { provided: true, value: requestedTitle }` 的 tagged value，不得仅依赖 `undefined` 被 canonical JSON 过滤的隐式行为。这样省略、`null` 和规范化字符串三态不同，同时升级前后相同的无 title 请求仍可用原 Idempotency-Key replay。在同一 idempotency scope 可被重新解析的前提下，相同 Idempotency-Key 携带不同 title 时返回既有 `IDEMPOTENCY_CONFLICT`，不能先修改名称再报冲突；规范化后相同的 title 视为同一请求。新站点在 site creation 前硬中断时的 scope 限制见“写入时序”。

## 写入时序

部署先完成全部 multipart/制品校验和 title/feature flag 校验，再执行站点解析、授权、request hash 计算和现有 deployment idempotency claim。

- 自动创建站点：把 `requestedTitleProvided ? requestedTitle : null` 放入 pending site creation，在站点创建事务中直接写入。该 `siteInput` 必须原样经过普通 `createSite` 和 legacy v1 takeover 的 `createSiteByTakingOverV1Claim` 两条分支，不能在 takeover 时丢失 title。
- 已有站点：仅当 `requestedTitleProvided` 为真时，在新 deployment 记录建立后、provider upload 前调用现有 `updateSiteMetadata` application use case，source 记为 `deploy`；以其 site commit lease、重新授权和 D1 CAS 保证不会越权或覆盖并发变更。
- 幂等 replay 不重复应用 title，避免成功部署后用户另行改名时被旧请求覆盖。

title 是独立站点 metadata。请求已经取得新的 deployment idempotency claim 后，title 更新成功即持久化；后续制品上传或激活失败不回滚 title。这与自动建站后部署失败时站点记录仍保留的现有行为一致，也避免把非路由字段卷入复杂的 Worker/route 补偿事务。

已有站点的 title mutation 在 claim 后同步失败时，必须先使用现有 deployment failure completion 尝试把该 deployment 置为 `failed`，写入对应公开 `errorCode`、`failureStage = "site_metadata"` 和不包含 title 原文的脱敏 diagnostics；只有 failed 状态持久化成功后才返回映射后的 metadata 错误，provider upload 不得启动。若两次 failed 状态写入都失败，则写 recovery marker 并返回 `503 DEPLOYMENT_STATE_WRITE_FAILED`；此时 deployment 可能暂时保持 `pending` 或其它非终态，不能返回原 metadata 错误并伪装成已可靠收口。

D1 `commitSiteMetadata` batch 是 title 的提交点，后续 site/route readback 或响应构造不属于该事务。若 batch 成功后这些步骤失败，deployment 仍按 `SITE_METADATA_UPDATE_FAILED` 失败收口，但 title 可能已经持久化且不回滚；调用方必须先查询当前站点，再决定是否用新的 Idempotency-Key 重试。

在请求仍通过当前 feature flag、认证、站点解析和授权的前提下，同一 Idempotency-Key 的 replay 返回已保存的 deployment 状态，不重新执行 title mutation；若这些前置检查不再通过，则沿用 `SITE_METADATA_MUTATIONS_DISABLED`、认证或 `SITE_NOT_FOUND` 等入口错误，同样不得重新执行 mutation。因而 metadata mutation 已失败的请求必须检查当前站点状态后使用新的 Idempotency-Key 重试；已成功修改 title、但后续上传或激活失败的请求也不会在 replay 时再次覆盖用户后来做出的名称修改。

本增量不为 deployment pipeline 新增跨请求 resume。已有站点路径在 claim 后被硬终止时，沿用现有 pending deployment 语义：旧 key 的 replay 返回该 pending 记录，不补跑 title；中断发生在 mutation 前时名称未修改，发生在 mutation 提交后时名称已持久化。新站点路径还有更早的现有限制：pending site 的随机 `siteId` 在 claim 前生成，若 claim 后、site creation 前中断，重试可能生成新 `siteId` 而无法命中原 scope/claim，因此不能承诺旧 key 一定 replay 原 pending deployment。调用方需查询站点与 deployment 的实际状态，确认后使用新的 Idempotency-Key 重试。本限制必须写入运维文档，不能宣称 title mutation 或 pending site creation 具备跨进程 exactly-once 保证。

recovery marker 只在后续已授权、且能解析到同一既有站点的 deploy/rollback 启动阶段尝试恢复；deployment GET 不触发恢复。站点已删除、权限失效或仍处于 pending site creation 时不能承诺自动收敛，需保留 repair 诊断供运维处理。

title-only mutation 不修改 slug、hostname、route generation、snapshot、runtime data namespace、active version 或访问策略。

## 错误与响应

- title 校验失败：`400 SITE_TITLE_INVALID`。
- feature flag 关闭：`503 SITE_METADATA_MUTATIONS_DISABLED`。
- 站点在写入前失去权限或被删除：保持不可枚举的 `404 SITE_NOT_FOUND`。
- 并发冲突：`409 SITE_METADATA_CONFLICT`。
- 其它写入错误：`500 SITE_METADATA_UPDATE_FAILED`。

后三类错误都发生在 deployment claim 之后。failed 状态写入成功且重试仍通过当前 feature flag、认证、站点解析和授权时，同 hash、同 key replay 返回 `HTTP 200` 的 deployment envelope，而不是重放首次 `4xx/5xx`，且不会重试 mutation；前置检查失败时返回对应入口错误。首次 metadata 错误的响应 action 应明确要求检查站点状态并使用新的 Idempotency-Key 重试。failed 状态无法持久化时改为 `503 DEPLOYMENT_STATE_WRITE_FAILED`，deployment 可暂时保持非终态，并按上一节的 recovery marker 边界处理。

成功响应沿用部署响应；调用方可从站点查询接口读取最终 `title` / `displayName`。不增加内部 route、claim 或 provider 字段。

## 测试与文档

- multipart/intake：原始字段存在性不丢失；覆盖缺省、字符串、`null`、显式非法 title；缺省时不受 feature flag 影响；非法 title 与关闭的 feature flag 同时出现时稳定返回 `SITE_TITLE_INVALID`。
- idempotency：显式 title 以 tagged value 参与 request hash；省略 title 保持上线前的 canonical hash；在同一可重建 scope 内，省略、`null` 和不同规范化 title 互相冲突，规范化后相同的 title 可 replay，所有冲突均发生在名称修改前。覆盖 flag 开启且认证/解析/授权通过时 same-hash 请求 `200` replay、different-hash 请求 `409`；flag 关闭时任何显式 title 请求（包括 replay/conflict）都返回 `SITE_METADATA_MUTATIONS_DISABLED`，省略 title 的请求不受影响。
- 新站点：显式字符串/null 正确进入普通 site creation 和 legacy v1 takeover；缺省保持 null。
- 已有站点：显式字符串设置、null 清空；缺省不调用 metadata mutation。
- 权限/CAS：沿用 metadata use case 的 access-key scope、Owner/团队角色和 commit-time reauthorization 测试。
- 失败收口：`SITE_NOT_FOUND`、`SITE_METADATA_CONFLICT`、`SITE_METADATA_UPDATE_FAILED` 都在 provider 调用前尝试把 deployment 标记为 failed，并保存 `failureStage = "site_metadata"`；成功后，在当前 flag、认证、站点解析和授权仍通过时，同 key `200` replay 不再次 mutation，新 key 可以重试；failed 状态持久化失败时返回 `DEPLOYMENT_STATE_WRITE_FAILED` 并验证 recovery marker，不断言原记录已经 terminal。
- 提交边界：模拟 metadata batch 已提交、readback 失败，确认 title 保留、deployment 失败且同 key 不重放 mutation。
- 中断语义：分别覆盖已有站点 claim 后、mutation 前以及 mutation 后、upload 前的行为；对新站点 claim 后、site creation 前的既有随机 siteId/scope 限制作回归记录，不宣称跨进程 exactly-once 或稳定 replay。
- 回归：title-only 部署不改变 slug、route、snapshot、runtime namespace；失败映射保持可操作。
- 同步 OpenAPI、`docs/api-boundary.md`、`docs/operations/consistency-and-state.md` 与 pages-api README；继续不公开 `/openapi.json`，并在一致性文档记录 hard termination 下沿用的 pending deployment 限制。
