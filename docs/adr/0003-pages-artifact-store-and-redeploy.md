# DR 0003: XD Pages artifact store 与可重建发布设计

## 状态

Proposed。

本文是长期候选设计，不是当前 MVP 已接受范围。优先级暂定为低：只有当 XD Pages 决定对外承诺“成功发布的历史版本在保留期内可重建回滚”，或需要执行面迁移时保留历史版本可恢复性，才应推进实现。

当前 MVP 可以继续把历史回滚定义为 provider best-effort：provider artifact 或旧执行目标仍可用时允许快速回滚；不可用时返回明确错误，不为了历史回滚保留普通 Worker slot。

本文讨论 XD Pages 发布 artifact 的长期保存、索引和重新部署语义。目标是评估是否让一次成功上传的发布内容成为平台可重建的版本输入，而不是只保存执行面的 provider pointer。

## 背景

当前发布链路在 `pages-api` 中接收 CLI 上传的 assets 和 Worker modules，校验 hash 后直接调用 execution provider 上传到 Cloudflare Workers for Platforms 或普通 Worker slot。D1 保存站点、版本、路由、发布者、可见性、ACL、provider artifact ref 和 resolved deployment metadata。

这个模型能完成首次部署和部分回滚，但它把发布内容的长期可用性交给执行面：

- WFP 或 Cloudflare Assets 中的 artifact 如果仍然存在，可以通过 provider pointer 回滚。
- 普通 Worker slot 会在新版本成功后释放旧 slot；旧 slot 被复用后，历史版本无法仅靠 `slot://...` 指针恢复。
- 如果 provider artifact 被删除、过期、迁移或因为执行模式切换不可用，平台没有原始 bytes 重新 materialize 该版本。

因此，如果 XD Pages 需要稳定承诺历史版本可重建，就需要一个平台自有的 artifact store，把用户上传的发布内容保存为不可变输入。执行 provider 只负责把某个 artifact materialize 到当前执行面；它不再是发布内容的唯一真相源。

## 采纳条件

本设计不应因为普通 Worker slot 的过渡实现而自动进入 MVP。只有满足下列条件之一时，才建议推进：

- 产品层明确承诺历史版本在保留期内可回滚或可重建。
- 普通 Worker slot 非 active 版本会快速释放，但仍希望历史版本不因 slot 释放而失去恢复能力。
- 需要从 `normal-worker-slot` 迁移到 WFP，且迁移时希望复用历史版本的发布内容。
- 需要降低对 provider artifact 生命周期的依赖，支持未来 provider 或 materializer 演进。

如果当前阶段只做小规模试点，且可以接受历史回滚是 provider best-effort，本设计应延期。

## 候选决策

- 使用 R2 保存 immutable artifact bytes 和 manifest。
- 继续使用 D1 作为控制面权威索引，保存站点、版本、权限、路由、发布者、provider ref、artifact ref 和状态。
- 如果进入实现，最小可行版本只处理 artifact 保存和可重建发布，不引入个人配置、环境变量、secret 或 binding 版本化。
- `site_versions` 仍是版本索引入口；R2 artifact store 是内容存储，不替代 D1 查询和授权。
- 采纳本设计后，回滚语义长期改为“从历史 artifact materialize 一个可执行目标，再切换 route”，而不是依赖旧执行面 slot 或 provider artifact 必须仍然存在。
- 普通 Worker slot 的历史回滚机制降级为可选快速路径。slot 本身不再承担保留历史版本的职责。

## 设计目标

- 用户和 AI 不需要理解 R2、D1、slot、dispatch namespace 或 provider pointer。
- 采纳本设计后，成功发布的版本在保留期内可被平台重建。
- 回滚、重新部署、执行模式迁移都使用同一套 artifact 输入。
- R2 只保存内容和少量对象 metadata；关系查询、授权、审计和 active route 仍走 D1。
- 如果未来实现，首个实现保持轻量，不提前设计完整个人配置系统。
- 不把执行 provider 的生命周期暴露成用户可见语义。

## 非目标

- 不在本设计中实现个人配置、站点环境变量、secret、binding 或 team-level 配置版本。
- 不让用户 Worker 直接访问平台 artifact R2 bucket。
- 不把 R2 当作权限、ACL、route 或审计数据库。
- 不承诺无限期保留 artifact；保留周期和 GC 策略可后续单独定义。
- 不要求第一版支持跨环境 artifact 复制；staging 和 production 仍必须物理隔离。

## 资源职责

### R2

R2 是 artifact content store，保存用户上传后经过校验的不可变发布内容。

建议对象布局：

```text
artifacts/v1/blobs/sha256/<sha256>
artifacts/v1/manifests/<canonicalContentHash>.json
```

blob key 按内容 hash 寻址。manifest key 按 canonical deployment content hash 寻址。manifest 是 artifact 的提交点：只有 manifest 写入成功，才认为该 artifact 可被重建。

manifest 至少包含：

```json
{
  "schemaVersion": 1,
  "canonicalContentHash": "sha256:...",
  "deploymentShape": "assets-only",
  "requestedFallback": "auto",
  "resolvedFallback": "not-found",
  "routingMode": "assets-only",
  "workerEntry": null,
  "assets": [
    {
      "path": "index.html",
      "blobHash": "sha256:...",
      "size": 1234,
      "contentType": "text/html"
    }
  ],
  "workerModules": [],
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

R2 object metadata 可以保存 `contentType`、`size`、`sha256`、`schemaVersion` 等局部信息，但不能依赖 metadata 完成站点维度查询。按站点、发布者、权限、active version、保留策略查找时必须走 D1。

### D1

D1 仍是 control plane authority，负责：

- 站点、版本、route、ACL 和 visibility。
- 发布者、deployment 状态、idempotency 和审计。
- 当前 active version 和 route generation。
- provider materialization 结果，例如 `worker_name`、`execution_provider`、`dispatch_type`、`slot_id`、`artifact_ref`。
- source artifact 指针和可用性状态。

最小实现可以不新增独立 artifact 表，而是在 `site_versions` 上保存或推导 source artifact：

```text
source_artifact_ref = r2://artifacts/v1/manifests/<canonicalContentHash>.json
source_artifact_hash = <canonicalContentHash>
source_artifact_availability = available | missing | expired
```

如果希望进一步降低 schema 改动，第一版也可以只使用已有 `canonical_content_hash` 推导 R2 manifest key，并继续用 `artifact_availability` 表达是否可重建。后续需要配额、引用计数、GC、跨站 dedupe 统计时，再增加独立 `artifacts` 表。

## 用户可见契约

采纳本设计后，用户和 AI 仍不应该感知 artifact store。公开契约只表达：

```bash
xd-cell deploy ./dist example-site
xd-cell rollback example-site ver_xxx
```

公开文档、CLI help、skill 和 OpenAPI 不暴露 R2、D1、manifest、slot、dispatch namespace、provider pointer 或 source artifact ref。状态查询可以表达 `rollbackAvailable` 和用户可理解的原因，例如 `version-expired` 或 `version-unavailable`；内部再映射到 provider artifact 和 source artifact 的可用性。

MVP 不建议暴露 `pages redeploy`、artifact 查询、artifact 下载或 artifact 管理 API。`redeploy` 在本设计中只是内部 materialization 能力。

## 发布流程

如果采纳本设计，长期发布流程调整为：

```text
1. pages-api 校验 actor、scope、site 权限、idempotency key 和 payload limit。
2. 读取 multipart 上传内容，校验 publish plan、asset manifest 和 worker modules。
3. 计算 canonicalContentHash。
4. 将所有 asset bytes 和 Worker module bytes 写入 R2 blob，并记录 hash。
5. 写入 R2 manifest；manifest 成功后 artifact 进入 available 状态。
6. 调用 execution provider，把该 artifact materialize 成 WFP user Worker 或普通 Worker slot。
7. provider verify。
8. 在 D1 创建 immutable site_version，记录 source artifact、provider artifact ref、resolved metadata 和发布者。
9. 通过 D1 CAS 激活 route，并写 route snapshot / pointer。
10. 返回 deploymentId、versionId 和站点 URL。
```

写入顺序必须保证：

- provider 上传前，artifact 已经在 R2 中可重建。
- route 激活前，provider verify 已成功。
- D1 version 创建失败时，已写入 R2 的 artifact 可以由 reconciliation 或 GC 延迟清理。
- R2 manifest 写入失败时，本次 deploy 失败，不进入 provider 上传阶段。
- R2 与 D1 没有跨服务事务，必须接受 orphan artifact 和 dangling reference，并由 reconciliation 修复或清理。

## 回滚与重新部署

### 快速回滚

如果目标 version 的 provider artifact 仍然可用，平台可以继续使用现有快速路径：

```text
target version provider ref 可用
  -> 直接切换 active route 到目标 provider target
```

这适合 WFP 保留不可变 user Worker，或某些 provider 支持稳定历史 artifact 的场景。

### 可重建回滚

如果 provider artifact 不可用，但 R2 source artifact 仍然存在，平台应走可重建路径：

```text
target version source artifact 可用
  -> 从 R2 读取 manifest 和 blobs
  -> 重新调用 provider materialize
  -> 创建新的 deployment 和 immutable site_version
  -> 切换 active route 到新 provider target
```

推荐把可重建回滚实现为一次新的 deployment 操作，保留原始 target version 的来源关系：

```text
operation = rollback
rollbackSourceVersionId = oldVersion
newVersion.sourceArtifactHash = oldVersion.sourceArtifactHash
newVersion.createdBy = actor
```

这样可以避免修改历史 version 的 provider 字段，也能完整记录“谁在什么时间把旧 artifact 重新部署到了当前执行面”。

### 重新部署

重新部署不是回滚到旧 route，而是把某个 artifact 再次 materialize：

```text
pages redeploy <site> --version <versionId>
```

当前不建议暴露该 CLI 命令，只在 API/provider 内部形成能力。后续如果引入个人配置版本，重新部署会自然扩展为：

```text
artifact version + latest config version -> new materialized deployment
```

## Worker slot 回滚机制是否还需要

如果采纳 R2 + D1 artifact store，普通 Worker slot 不应该再作为历史版本保留机制。

原因：

- slot 是稀缺执行容量，不适合作为版本归档。
- slot 被复用后，`slot://...` 只能说明当时部署到哪个执行目标，不能证明现在还能恢复该代码。
- 为了保留回滚而长期占用旧 slot，会增加容量、binding、清理和告警复杂度。
- artifact store 已经提供更稳定、更通用的历史输入，适用于 WFP、slot 和未来 provider。

因此，slot 相关机制应保留这些职责：

- 当前 active route 的执行目标。
- 新版本 materialization 的临时或长期承载位置。
- provider artifact 仍可用时的快速回滚路径。
- 兼容 WFP 未开通或灰度期间的执行 provider。

slot 机制不再承担这些职责：

- 不为了历史回滚保留非 active slot。
- 不把 `slot://...` 视为可重建 artifact 的唯一依据。
- 不因旧 slot 已释放就让历史版本永久不可恢复；只要 R2 source artifact 可用，就应允许可重建回滚。

采纳本设计后，旧的 `ROLLBACK_VERSION_UNAVAILABLE` 语义需要调整：

- 如果 provider artifact 不可用且 source artifact 也不可用，返回 `ROLLBACK_VERSION_UNAVAILABLE`。
- 如果 provider artifact 不可用但 source artifact 可用，走可重建回滚。
- 如果 R2 读取失败是临时平台故障，返回可重试的 5xx，而不是把版本标记为不可回滚。

## 实现优先级

本设计优先级低于发布链路稳定性、Worker with Assets 正确性、CLI 友好输出、权限/可见性和基础运维告警。当前阶段不应为了实现 artifact store 推迟这些更直接影响用户发布体验的工作。

如果未来决定进入实现，最小闭环必须包含“保存”和“重建”两部分，不能只保存 R2 artifact 却不支持从 artifact materialize：

- 增加 R2 bucket binding，staging 和 production 物理隔离。
- 在 deploy 时保存 blobs 和 manifest。
- 在 `site_versions` 中保存或可推导 source artifact ref。
- 调整 rollback availability 判断：先检查 provider ref，失败后检查 R2 source artifact。
- 支持从 R2 artifact 重建 provider upload 输入。
- 至少覆盖一个从 R2 artifact 重建并激活 route 的内部测试路径。
- 保持 CLI 用户命令不变。
- 不实现个人配置版本化。
- 暂不自动删除 artifact，但必须定义保留策略、手动清理流程和观测指标。

MVP 可以暂不新增独立 D1 artifact 表。只有在需要以下能力时再引入：

- artifact 级配额和账单统计。
- 引用计数和安全 GC。
- 跨站点内容 dedupe 查询。
- artifact 生命周期状态机。
- 按 artifact 查所有引用版本。

## Manifest 重建字段

manifest 不能只记录文件 bytes 和 hash，还必须记录足够重建执行语义的字段。候选字段包括：

- `canonicalizationVersion`
- `materializerVersion`
- `deploymentShape`
- `requestedFallback`
- `resolvedFallback`
- `routingMode`
- `assetsConfig`
- `workerEntry`
- `workerMainModuleName`
- Worker module content type
- `compatibilityDate`
- `compatibilityFlags`
- 平台 binding contract version

这些字段用于避免未来 provider adapter 或平台 wrapper 变化时，同一份 bytes 被重建成不同运行语义。

## 保留与可用性

本设计不是长期归档服务。即使未来采纳，也应定义保留窗口：

- active version 的 source artifact 不应被 GC。
- 历史 succeeded version 可以按最近 N 个版本或 T 天保留。
- staging 可以使用更短保留期。
- 过期后 rollback 返回用户可理解的不可用原因。

内部建议区分：

```text
provider_artifact_availability = active | retained | missing | expired
source_artifact_availability = available | missing | expired | gc_pending
```

公开响应不暴露这些内部状态，只表达 `rollbackAvailable` 和用户可理解的原因。

## 运维与安全要求

如果未来采纳，需要同时补齐：

- R2 bucket、wrangler binding、staging/production 物理隔离和部署 checklist。
- R2 write/read failure、object count、total bytes、per-site version count、orphan manifest/blob、manifest 引用 missing blob 等指标。
- reconciliation：清理 D1 version 创建失败留下的 orphan artifact，标记 D1 指向 missing manifest 的历史版本。
- artifact 按内部敏感数据处理；不提供公开下载 API，不把 Worker module 内容或静态文件正文写入日志。
- artifact 可能包含用户误打包的敏感文件；平台继续依赖路径 denylist、大小限制和上传校验，但不承诺内容脱敏。

## 后续扩展

个人配置和 secret 如果未来需要支持，应作为独立版本输入设计：

```text
materialized deployment = artifactVersion + configVersion + routePolicyVersion + providerAdapterVersion
```

其中：

- artifactVersion 来自 R2 artifact store。
- configVersion 来自 D1 或专门配置 store，只保存非 secret 值和 secret refs，不保存 plaintext secret。
- routePolicyVersion 来自站点 visibility、ACL、headers、routing policy。
- providerAdapterVersion 表示当前 materialization 逻辑版本，便于未来 provider 迁移和审计。

这个扩展不改变普通用户的发布入口。用户仍然只需要：

```bash
xd-cell deploy ./dist example-site
```

## 风险与缓解

| 风险 | 说明 | 缓解 |
| --- | --- | --- |
| R2 写入成功但 D1 version 创建失败 | 产生 orphan artifact | reconciliation / GC 延迟清理；manifest 中不保存敏感用户输入 |
| D1 version 存在但 R2 manifest 缺失 | 历史版本不可重建 | 标记 `artifactAvailability=missing`，回滚返回明确错误 |
| R2 临时不可用 | deploy / rebuild rollback 失败 | 返回可重试 5xx，不切换 active route |
| artifact 泄露 | 用户静态资源和 Worker module 被长期保存 | R2 bucket 不公开，用户 Worker 无 binding；管理 API 鉴权后访问 |
| 保留成本增长 | artifact 不做 GC 会增加 R2 存储成本 | 不作为当前 MVP 必做项；未来实现时定义保留窗口、指标和手动清理 |
| staging/prod 串环境 | artifact 被跨环境读取或部署 | R2 bucket、D1、provider namespace 全部环境隔离 |

## 与 DR 0001 的关系

DR 0001 定义“如何判断和表达发布产物”。本文讨论“判断后的发布内容如何长期保存并可重建”，但不改变 DR 0001 的已采纳规则。

两者边界如下：

- DR 0001 的 `deploymentShape`、`resolvedFallback`、`routingMode` 进入 R2 manifest 和 D1 version metadata。
- 本文不改变用户输入模型，不重新引入 `artifactKind`。
- 本文不改变 fallback 自动判断规则，只把 resolved decision 固化为可重建 artifact 的一部分。
