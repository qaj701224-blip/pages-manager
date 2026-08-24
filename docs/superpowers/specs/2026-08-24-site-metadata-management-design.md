# 站点名称、slug 与缩略图管理设计

## 背景

XD Cell v2 当前把 `sites.slug` 同时用作站点展示名称、访问地址的一部分和部分 runtime data key 的组成部分。Console 的目录卡片与详情页直接展示 slug，站点也没有平台托管缩略图。公开管理 API 的站点 `PATCH` 只修改访问策略，Console 的 settings 接口只处理 Owner 转移。

产品需要对齐 Codex Sites 的基础站点管理体验：站点具有独立的展示名称与缩略图，访问 URL 可以改名；名称、slug、缩略图可以分别修改。修改 slug 不应重新部署内容，旧 URL 应跳转到最新 URL，同时站点身份、权限、版本、runtime config 和 runtime data 必须连续。

本设计是一项纵向能力：虽然涉及 pages-api、pages-router、kv-gateway、pages-console 和 CLI 兼容，但它们共同完成一次站点元数据修改，不拆成彼此独立的产品功能。

参考行为：[Codex Sites — Change a Site URL](https://learn.chatgpt.com/docs/sites#change-a-site-url)。本项目只对齐“显示名称、缩略图、URL 改名与旧地址跳转”能力，不复制其完整界面或未公开实现。

## 目标

- UI 使用“名称”，API 使用 `title` 表示可选展示名称；现有 `name` / `siteSlug` 语义保持为 slug。
- `title`、`slug`、缩略图均可单独修改，一个字段失败不要求用户重做其它字段。
- 认证 Public API、Workspace Console 与 Admin Console 使用同一 application use case 和一致校验。
- slug 改名不创建 deployment 或 site version，不调用 WFP 上传/部署接口。
- 新 URL 在修改成功时可访问；站点存续期间所有历史 URL 以 `308` 跳到当前 URL，并保留 path 与 query。
- slug 改名后保持 `site.id`、`site_uuid`、Owner、成员、ACL、默认访问策略、active version、runtime vars/secrets 和 runtime data 不变。
- 缩略图由平台私有 R2 bucket 托管，不暴露 R2 object key 或公开 bucket URL。
- staging 与 production 的 D1、KV、R2、domain 和 Worker 继续物理隔离。

## 非目标

- 不修改 v1 `apps/server`。
- 不支持自定义域名、alias 手工管理或删除单个历史 alias。
- 不自动抓取站点截图，不裁剪、压缩或转码图片。
- 不新增 CLI 元数据编辑命令；CLI 本次只处理旧 slug 的兼容和提示。
- 不把 OpenAPI 文档开放为公网 `/openapi.json`。
- 不改变站点内容版本、发布历史、Worker 名称或 Cloudflare execution provider。

## 术语与字段语义

| 概念 | 字段 | 是否可变 | 用途 |
| --- | --- | --- | --- |
| 站点身份 | `site.id`、`siteUuid` | 否 | 权限、版本、审计和内部关联 |
| 展示名称 | `title` | 是，可清空 | Console 主标题；为空时回退到 slug |
| 当前地址名 | `slug` | 是 | 当前 canonical hostname 与 CLI 定位 |
| 数据命名空间 | `dataNamespace` | 否 | runtime data/KV key 前缀 |
| 历史地址 | slug alias | 站点存续期间保留 | 旧 hostname 到当前 hostname 的跳转 |
| 缩略图版本 | `thumbnail.revision` | 每次上传更换 | 缓存失效，不等同于 R2 object key |

UI 中统一称“名称”和“站点 URL”。API 不新增 `name` 字段，以免与 `xd-cell.config.json.name` 的既有 slug 语义冲突。

## 数据模型

新增 D1 migration `0021_site_metadata.sql`，并同步 `schema.js`、row mapper、D1 contract 和测试 store。

### `sites` 新字段

- `title TEXT NULL`：经过规范化的展示名称；`NULL` 表示使用 slug 展示。
- `data_namespace TEXT`：slug 格式的不可变 runtime data namespace。
- `slug_revision INTEGER NOT NULL DEFAULT 1`：只在 canonical slug 变化时递增，用于 alias 快照收敛。
- `slug_routing_synced_revision INTEGER NOT NULL DEFAULT 1`：canonical 与全部 alias pointer 最后一次共同确认的 slug revision。

迁移先增加字段，再把所有存量有效及已删除站点的 `data_namespace` 回填为迁移时的 `slug`，并把两个 revision 初始化为 `1`。兼容期 reader 对异常空值回退到 `site.slug`，新 writer 创建站点时必须显式写入非空 `data_namespace`。

迁移与新 writer 切换之间，旧 pages-api 仍可能创建 `data_namespace IS NULL` 的站点。为消除这个窗口，slug rename 在持有 site commit lease 后先读取旧 canonical slug；若 namespace 为空，必须在同一个 rename D1 transaction 中把它固化为“修改前的 slug”，再更新 canonical slug。非空 namespace 永远不得修改。这样即使站点由旧 writer 创建并已产生 KV 数据，第一次 rename 仍使用原数据前缀。

### `site_slug_aliases`

新增表：

```text
id                    TEXT PRIMARY KEY
environment           TEXT NOT NULL
site_id               TEXT NOT NULL
slug                   TEXT NOT NULL
hostname               TEXT NOT NULL
synced_slug_revision   INTEGER NOT NULL DEFAULT 0
last_synced_at         TEXT NULL
created_at             TEXT NOT NULL
retired_at             TEXT NULL
```

建立 active alias 的 `(environment, slug)` 与 `hostname` partial unique index，并建立 `(site_id, retired_at)` 查询索引。当前 canonical slug 仍保存在 `sites.slug`，不在 alias 表重复保存。

`hostname_claims` 继续作为 v1/v2 hostname 占用冲突的统一保护：

- 改名时为新 hostname 建立或复用属于同一 site 的 active claim。
- 旧 hostname 的 claim 保持 active，并新增 active alias。
- 改回本 site 的历史 slug 时，将该 alias 退役并把旧 canonical slug 变为 active alias；不创建重复 claim。
- 其它 site、v1 资源或尚处于 reuse hold 的 claim 一律返回冲突，不透露占用方。
- 删除站点时，退役该 site 的全部 alias，并把该 site 的全部 hostname claim 进入现有 hold/release 生命周期，而不只处理当前 hostname。

历史 alias 在站点存续期间不自动过期。站点删除后没有有效跳转目标，因此旧地址停止跳转，并遵循现有 hostname reuse hold 规则。

### `site_thumbnails`

缩略图 pointer 独立成表，避免把 provider 细节混入 `sites`：

```text
site_id          TEXT PRIMARY KEY
environment      TEXT NOT NULL
object_key       TEXT NOT NULL
revision         TEXT NOT NULL
media_type       TEXT NOT NULL
byte_size        INTEGER NOT NULL
etag             TEXT NOT NULL
created_by       TEXT NOT NULL
created_at       TEXT NOT NULL
updated_at       TEXT NOT NULL
```

R2 object key 由服务端生成，形如 `<environment>/sites/<site-id>/<revision>.<ext>`；不包含用户输入的 title 或 slug。Public API、Console 响应和审计均不得返回 `object_key`、bucket 名或其它 provider resource id。

缩略图不属于 site version：deploy、rollback、Owner 转移和 slug 修改不会改变它。删除站点时清除 pointer，并异步删除当前对象。

## 应用边界

新增三个聚焦 application use case：

1. `updateSiteMetadata`：校验并部分更新 `title` / `slug`，协调 hostname claim、alias、route snapshot 和审计。
2. `putSiteThumbnail`：校验图片、先写不可变 R2 object，再原子交换 D1 pointer。
3. `deleteSiteThumbnail`：清除 D1 pointer，并在提交后异步删除旧对象。

Public API、Workspace Console 和 Admin Console 只负责认证、授权、输入/响应适配，不各自实现业务规则。基础设施通过窄 port 暴露 metadata transaction、route snapshot 与 thumbnail object store，避免 handler 直接编排 D1/R2。

## 名称规则

- `title` 是 `string | null`；字段缺失表示不修改，显式 `null` 表示清空。
- 字符串按 Unicode NFC 规范化并去除首尾空白。
- 规范化后长度为 1–80 个 Unicode code point。
- 拒绝 C0/C1 control、换行及 Unicode line/paragraph separator。
- 空字符串不隐式代表清空，返回 `SITE_TITLE_INVALID`；调用方应发送 `null`。
- React 只按文本渲染，不支持 HTML 或 Markdown。
- 展示名称统一计算为 `title || slug`；API 仍返回原始 `title: null`，避免丢失“尚未设置”的语义。

title-only 修改只更新 `sites.title` / `sites.updated_at` 和审计，不修改 route、snapshot、deployment 或 version。

## slug 改名规则

- 复用现有 slug normalization 与 `@xd/pages-runtime-protocol` 校验：2–50 位小写字母、数字和连字符，首尾为字母或数字，并执行 production/staging 保留名检查。
- 字段缺失表示不修改；规范化后与当前 slug 相同为幂等 no-op。
- 目标 slug 若属于其它 live site、历史 alias、v1 claim 或 reuse hold，统一返回 `SITE_SLUG_CONFLICT`。
- 改回本 site 的历史 alias 合法。
- 单次 metadata 请求同时包含 `title` 与 `slug` 时，D1 变更在一个事务中提交；Console 为满足独立编辑体验，每个控件只发送自身字段。

### 一致性流程

slug 修改复用现有 site commit lease，与 deploy、rollback、delete 和访问策略变更串行。锁内重新读取 site、route、active version、ACL 和 aliases，并使用 fencing token / expected route tuple 防止旧写覆盖新状态。

D1 batch 一次完成：

1. 获取或建立目标 hostname claim。
2. 新增旧 canonical alias，或在回退历史地址时交换 active alias。
3. 更新 `sites.slug` 并递增 `sites.slug_revision`；已初始化的 `data_namespace` 不变。若它因迁移窗口仍为空，先以修改前的 slug 完成一次性固化。
4. 更新同一 `site_routes` 行的 hostname，递增一次 `route_generation`；保留 route id、active version、runtime、worker、dispatch、visibility、exposure、policy version 与 runtime config generation。
5. 将 `sites.slug_routing_synced_revision` 和所有 active alias 的 `synced_slug_revision` 保持为旧值，表示 canonical 与 aliases 待发布。
6. 写入 `site_metadata_updated` 审计事件。

D1 是 metadata authority，KV pointer 是 Router-effective 状态。D1 commit 后同步执行：

1. 为新 canonical hostname 写入并读回确认 schema v4 serve snapshot。
2. 为每个 active alias 写入 schema v4 redirect snapshot，目标始终是最新 canonical hostname，而不是上一个 alias。
3. 每个 alias pointer 确认后更新对应 alias 的 `synced_slug_revision` / `last_synced_at`。
4. canonical 与当前 revision 的全部 active alias 都确认后，以 slug revision CAS 把 `sites.slug_routing_synced_revision` 更新为当前 `slug_revision`；旧 reconcile 不得把更新后的 rename 错标为 ready。

`routingStatus` 由 `slug_routing_synced_revision === slug_revision` 推导为 `ready`，否则为 `pending`。只有 canonical 与全部 alias pointer 都确认后，含 slug 的 mutation 才返回 `200`。如果 D1 已提交但 KV 写入未完全成功，返回 `202`，并使用 `ctx.waitUntil` 重试；现有每 15 分钟 scheduled handler 增加有界 alias reconciliation，处理全局或 alias revision 未收敛的站点。客户端以同一目标 slug 重试时也必须执行 repair，而不能因字段同值直接 no-op。title-only 请求不被既有 pending rename 阻塞：title 提交成功时返回 `200`，但返回的 site 仍如实携带 `routingStatus: "pending"`。

这种顺序允许短暂出现“旧地址仍服务原内容”或“新地址尚未可用”，但不会把请求发到其它站点。API 不得在 pointer 未确认时返回已完全生效。reconcile 只写当前 D1 authority 指向的 hostname，并保持幂等。

slug 修改不写 `deployments` / `site_versions`，不上传 artifact，也不调用 WFP provider。

## Router 快照与跳转

route snapshot 升级到 schema version 4，并继续读取 v2/v3：

- serve snapshot 新增 `kind: "serve"` 和 `dataNamespace`；`siteId` 明确为不可变的 `sites.id`，`slug` 是当前 canonical slug。
- redirect snapshot 使用 `kind: "redirect"`，至少包含 `environment`、旧 `hostname`、不可变 `siteId`、`targetHostname`、`routeGeneration` 和 `policyVersion`。
- pointer key 格式保持不变，仍按 environment + hostname 隔离。

Router 读取 redirect 时，沿 snapshot 解析到最终 serve snapshot，最多 16 跳并检测 hostname 循环。每一跳及最终 snapshot 必须 environment 一致，且 `siteId` 与首个 redirect 一致；目标缺失、跨环境、跨站点、循环或超限均 fail closed。这样即使删除后 canonical hostname 被其它站点复用，遗留 pointer 也不会把旧地址导向其它站点。

Router 依据最终 serve snapshot 的 exposure 决定 IP allowlist：internal 仍先执行公司网络门禁，public 可跳过该门禁。redirect 本身不签发 session、不执行 user Worker、不生成 runtime capability；目标站点继续执行 SSO、ACL、owner 等完整访问控制。因此不会以 alias 绕过现有访问策略，也避免用户在旧、新 hostname 各登录一次。

成功响应为：

```http
HTTP/1.1 308 Permanent Redirect
Location: https://<current-hostname><original-path>?<original-query>
Cache-Control: no-store
```

Location 只能由已验证的 snapshot hostname 生成；保留原始 path 与 query，不包含 fragment，不接受请求 header 或 query 提供 redirect target。Router 应直接返回最终 canonical hostname，避免稳定状态出现跳转链。

站点删除时清理 canonical 与全部 alias pointer；即使清理暂时失败，最终 site-id 校验和 deleted/inactive canonical snapshot也必须阻止跨站或继续执行旧 Worker。

## runtime data 连续性

当前 KV capability 把 `route.slug` 写入名为 `siteId` 的 claim，Gateway 再用它生成 `s/<slug>--<siteUuid>/...`。直接改 slug 会切换前缀，因此必须先拆分：

- route v4 snapshot 携带不可变 `siteId`、不可变 `dataNamespace` 和当前 `slug`。
- Router 新签发的 capability 中，`siteId` 为实际 site id，`dataNamespace` 为存量回填值，并增加独立的 `namespaceVersion: 2`。既有 Data API 的 `apiVersion` 语义保持不变，legacy runtime endpoint 也使用同一 namespace version 字段。
- KV Gateway 的新 reader 同时接受两种短期 token：
  - 新 token：校验 `siteId` 格式和 `dataNamespace` 的 slug 格式，使用 `dataNamespace` 构造 key。
  - 旧 token：缺少 `dataNamespace` 时继续把旧 `siteId` 当作 namespace。
- 站点级与用户级 key、list prefix、cursor context 和内部 metadata 全部改为显式使用 `dataNamespace`；新 metadata 可另记真实 site id。
- 旧 token TTL 目前最多 60 秒，兼容 reader 至少保留一个完整发布窗口，不通过一次原子切换假定所有 token 已失效。
- 旧 list cursor 使用其旧 `siteId === dataNamespace` 规则校验；新 cursor 提升 cursor version，并写入独立 `siteId` 与 `dataNamespace`。现有 cursor 没有时间有效期，因此旧 cursor reader 在对应加密 key 仍被接受期间永久保留，不能仅按发布日期删除；未来若要移除，必须先单独引入 cursor expiry/版本退役契约。改名不得改变有效 cursor 的 namespace。

因此 slug 改名前后的读写继续命中同一 `s/<dataNamespace>--<siteUuid>/...` 前缀，不复制或迁移用户 KV 数据。

## 缩略图存储与校验

pages-api 新增私有 R2 binding `SITE_THUMBNAILS`。production 与 staging 使用不同 bucket；bucket 不配置公开域名，pages-console 不直接持有 R2 binding。

上传规则：

- 接受原始 request body，`Content-Type` 仅允许 `image/png`、`image/jpeg`、`image/webp`。
- 最大 2 MiB；有 `Content-Length` 时先拒绝超限，读取时仍实施硬上限。
- 同时校验格式 magic bytes，不能只信任扩展名或 header。
- 空 body、损坏/不匹配格式、SVG、GIF 和其它类型均拒绝。
- 本期不校验像素尺寸；Console 以 16:9 `object-fit: cover` 展示，并提示推荐 1200×675。

上传使用不可变 object key：

1. 校验完整 body 后以新 revision 写 R2，并设置准确 content type。
2. R2 成功后在 D1 transaction 中 upsert `site_thumbnails` pointer 与审计。
3. D1 失败时 best-effort 删除新对象，返回 503；旧 pointer 不变。
4. D1 成功后通过 `ctx.waitUntil` 删除旧对象；失败只造成不可达 orphan，不影响读路径，并记录结构化告警供运维清理。

删除先在 D1 transaction 中移除 pointer 并写审计，再异步删除旧对象。无 pointer 的 DELETE 为幂等成功。对象清理失败不得恢复已删除 pointer。

读取通过 pages-api 流式返回当前 pointer 对象，设置正确的 `Content-Type`、由 revision 生成的 `ETag`、`X-Content-Type-Options: nosniff` 和 `Cache-Control: private, max-age=300`。D1 有 pointer 但 R2 object 缺失时返回 `SITE_THUMBNAIL_UNAVAILABLE`，记录告警，UI 使用本地占位图。占位图不写入 R2。

## API 合约

所有下列 Public API 都是公网可达但必须认证的管理 API，不是匿名 API。同步更新 `apps/pages-api/src/openapi.js`、contract tests 与 `docs/api-boundary.md`；仍不提供公网 OpenAPI endpoint。

### Public API

```http
PATCH /.xd-pages/api/sites/{siteId}/metadata
Content-Type: application/json

{ "title": "产品文档" }
{ "slug": "product-docs" }
{ "title": null }
```

body 只允许 `title`、`slug`，至少出现一个字段。缺失字段保持不变。成功返回 `200 { site }`，其中 `site.routingStatus` 为 `ready`。D1 已提交而 route 尚在修复时只使用以下一种 202 成功响应形态，不返回标准 error envelope：

```json
{
  "site": { "id": "site_x", "slug": "product-docs", "routingStatus": "pending" },
  "warning": {
    "code": "SITE_METADATA_ROUTING_PENDING",
    "message": "Site metadata was saved and routing is still being synchronized.",
    "action": "Retry this request or wait for routing reconciliation."
  }
}
```

```http
PUT    /.xd-pages/api/sites/{siteId}/thumbnail
GET    /.xd-pages/api/sites/{siteId}/thumbnail
DELETE /.xd-pages/api/sites/{siteId}/thumbnail
```

PUT body 为图片二进制，成功返回 `200 { thumbnail }`；DELETE 返回 `204`。GET 要求站点读权限并支持 `If-None-Match` / `304`。

站点 list/detail/metadata mutation 响应增加：

```json
{
  "title": "产品文档",
  "displayName": "产品文档",
  "slug": "product-docs",
  "routingStatus": "ready",
  "thumbnail": {
    "url": "/.xd-pages/api/sites/site_x/thumbnail?v=thumb_revision",
    "revision": "thumb_revision",
    "mediaType": "image/webp",
    "updatedAt": "2026-08-24T00:00:00.000Z"
  }
}
```

所有站点 list/detail/mutation projection 都返回 `routingStatus: "ready" | "pending"`。未设置时 `title` 与 `thumbnail` 为 `null`，`displayName` 为当前 slug。响应不得包含 `dataNamespace`、R2 key/bucket、hostname claim 或 provider metadata。

读取沿用 `read:site` / 现有兼容读 scope；修改沿用站点管理权限和 `deploy:site` / `*` scope。site-scoped access key 只能修改绑定 site。个人站点仅 Owner 可改；团队站点的 publisher/admin 可改。

### Console BFF API

Workspace：

```text
PATCH     /api/console/sites/{siteId}/metadata
PUT|GET|DELETE /api/console/sites/{siteId}/thumbnail
GET       /api/console/directory/sites/{siteId}/thumbnail
```

Admin：

```text
PATCH     /api/console/admin/sites/{siteId}/metadata
PUT|GET|DELETE /api/console/admin/sites/{siteId}/thumbnail
```

Workspace mutation 要求 Owner 或团队 publisher/admin；Admin mutation 要求 platform admin。所有非 GET 请求继续经过 pages-console 的 same-origin 与 CSRF 校验。Admin 与 Workspace handler 调用同一 use case，只传入不同授权结果和 audit source。

directory thumbnail GET 使用与 directory 列表相同的可见性判定：未登录访问只可读取本来可出现在匿名 directory 中的 internal 站点；登录用户还可读取其 org/ACL/owned/team-visible 站点。pages-console 的公司网络门禁始终先执行。不能仅凭 site id 绕过目录可见性。

Console projection 生成自身 `/api/console/...` URL；pages-console 流式代理 binary response，不返回 R2 地址。带 revision query 用于浏览器 cache busting，服务端忽略该 query 的资源选择，始终读取 D1 当前 pointer。现有 BFF 的统一 `Cache-Control: no-store` 逻辑需要只对 JSON/敏感响应保留；thumbnail binary response 应保留 pages-api 设置的 private cache 与 ETag header。

### 错误语义

| code | status | 含义 |
| --- | ---: | --- |
| `SITE_METADATA_INVALID` | 400 | body 非对象、无可修改字段或含未知字段 |
| `SITE_TITLE_INVALID` | 400 | title 类型、长度或字符不合法 |
| `SITE_SLUG_INVALID` / `SITE_SLUG_RESERVED` | 400 | 沿用现有 slug 校验 |
| `SITE_SLUG_CONFLICT` | 409 | 当前 slug、alias、v1 claim 或 hold 冲突 |
| `SITE_METADATA_CONFLICT` | 409 | 并发 mutation / lease fencing 冲突 |
| `SITE_METADATA_ROUTING_PENDING` | 202 | 仅出现在上述 warning 成功体；D1 已提交，Router pointer 正在修复 |
| `SITE_THUMBNAIL_INVALID` | 400 | 空文件或 magic bytes 不合法/不匹配 |
| `SITE_THUMBNAIL_TOO_LARGE` | 413 | 超过 2 MiB |
| `SITE_THUMBNAIL_CONTENT_TYPE_INVALID` | 415 | 不支持的 media type |
| `SITE_THUMBNAIL_NOT_FOUND` | 404 | 未设置缩略图 |
| `SITE_THUMBNAIL_UNAVAILABLE` | 503 | pointer 存在但对象读取失败 |
| `SITE_THUMBNAIL_STORE_UNAVAILABLE` | 503 | R2 写入或 pointer 交换失败 |
| `SITE_METADATA_MUTATIONS_DISABLED` | 503 | rollout/止损开关尚未开启 |

不存在或无权访问的站点继续统一返回 `SITE_NOT_FOUND`，避免枚举。错误、日志和响应不得包含 token、session、R2 object key/bucket、Cloudflare resource id 或图片 body。

## Console 体验

- Directory、Workspace、站点详情与 Admin 站点视图以 `displayName` 为主标题，slug / URL 为次要信息。
- 未设置缩略图或图片加载失败时使用本地占位图；不触发自动上传。
- Settings 将“名称”“站点 URL”“缩略图”拆为三个独立控件、保存状态与错误区域。
- 名称可清空，清空后立即回退显示 slug。
- URL 保存前展示新 hostname，并明确“旧地址会永久跳转；本地 `xd-cell.config.json.name` 需同步更新”。
- 缩略图选择后先本地预览；只接受 PNG/JPEG/WebP，前端预检 2 MiB，服务端仍重复校验；提供独立“移除缩略图”。
- mutation 成功后只刷新对应 metadata；`202` 时显示“设置已保存，地址正在生效”，并轮询 detail 中持久化的 `site.routingStatus`，直到 `ready`，不把它显示为完全失败。
- 各控件在自身请求中禁用，不能因缩略图上传失败回滚已保存的 title 或 slug。

## CLI 旧 slug 兼容

`xd-cell.config.json.name` 继续表示 slug，不做破坏性重命名。服务端部署解析增加 alias-aware lookup：传入历史 slug 时解析到同一 site id，绝不创建新站点或新数据命名空间，最终 route 使用 canonical hostname。

部署成功响应增加当前 site 的 `{ id, slug }` 投影。CLI 比较请求 slug 与 canonical slug：

- human 输出一次明确警告并提示更新 config；发布完成 URL 使用响应 route hostname。
- JSON 输出保留既有 `site` 字段兼容，同时增加 `canonicalSite` 和结构化 warning。
- CLI 不自动改写用户文件。

其它只基于 list 做本地精确匹配的 CLI 子命令本期仍要求当前 slug；错误提示应说明站点可能已改名并建议运行 `xd-cell sites list`。Public API 内部按 slug 操作的入口应使用 alias-aware resolution，避免旧配置误创建站点。

## 审计与可观测性

- metadata 成功提交记录 `site_metadata_updated`，metadata 仅含 changed fields、旧/新 slug、是否清空 title、source 和 slug revision。
- thumbnail 上传/删除记录 `site_thumbnail_updated` / `site_thumbnail_deleted`，只记录 revision、media type、byte size 和 source，不记录 object key 或图片内容。
- slug snapshot 同步记录成功、pending、reconciled 与 terminal failure 计数；日志带 site id、environment、slug revision 和 trace id。
- rename、thumbnail 与 reconciler 指标按 environment 分开，至少覆盖请求数、冲突、pending、修复成功/失败和 R2 错误。
- title-only、thumbnail-only 操作不伪造 deployment 事件。

## 配置与环境隔离

- `apps/pages-api/wrangler.production.template.toml` 与 staging template 增加 `SITE_THUMBNAILS` R2 binding。
- `scripts/render-pages-v2-wrangler.mjs` 为 pages-api 要求 `SITE_THUMBNAILS_R2_BUCKET`，部署 workflow 从非敏感 GitHub var `PAGES_V2_SITE_THUMBNAILS_R2_BUCKET` 注入。
- pages-api 增加 `SITE_METADATA_MUTATIONS_ENABLED` feature flag；只有精确值 `true` 才注册 metadata/thumbnail mutation，关闭时返回 `503 SITE_METADATA_MUTATIONS_DISABLED`。读取与兼容 writer 不受该开关影响。
- production/staging 必须配置不同 bucket name；render/config inventory/workflow tests 断言不能缺失或串用。
- pages-router 与 kv-gateway 不获得缩略图 bucket 权限。
- R2 bucket 必须关闭 public access，生命周期规则只作为 orphan 成本控制，不能删除仍有 D1 pointer 的对象。

## 兼容发布顺序

该能力不能依赖一次同时生效的多 Worker 发布：

1. 应用 additive D1 migration，回填 `data_namespace`；旧应用可继续运行。
2. 先发布 KV Gateway dual-reader，使其接受旧 claim 与新 `siteId + dataNamespace` claim。
3. 发布能读取 v2/v3/v4、识别 redirect 且 fail closed 的 Router；此时 pages-api 仍只写旧 serve snapshot。
4. 创建并绑定 staging/production 独立私有 R2 bucket，部署 pages-api 兼容基线：新建站点写 `data_namespace`，所有 snapshot 写入都携带 namespace，删除逻辑认识 aliases，但 metadata mutation feature flag 仍关闭。
5. 部署 pages-console 与 CLI 兼容输出，先在 staging 完成端到端验证，再手动触发 production workflow。
6. 确认没有旧 pages-api 实例、抽查空 namespace 为零且 Router/Gateway compatibility 已生效后，再打开 metadata mutation feature flag。

若现有 workflow 的部署顺序不能保证 consumer-before-producer，则拆为两个 production release；不能在旧 Router/Gateway 仍在线时开始写 v4 snapshot 或新 capability。production 仍只允许手动部署。

回滚规则：新 Gateway dual-reader、新 Router v4 reader 和 pages-api 兼容 writer 共同构成不可降低的兼容基线。feature flag 开启前可以禁用新 UI/API，但不能回滚到会省略 `dataNamespace` snapshot、按新 slug 生成 KV namespace 或只清理 canonical hostname 的旧 pages-api。启用首次 slug rename 后，Gateway、Router 与 pages-api 均只允许 roll-forward 修复；Console 可独立回滚。紧急止损优先关闭 mutation flag，不能恢复旧 writer。

## 测试与验收

### 数据与应用测试

- migration/schema 覆盖 title、data namespace 回填、alias unique constraint、thumbnail pointer 和环境隔离。
- title set/change/clear、slug-only、thumbnail-only 和组合 metadata 请求均保持未提交字段不变。
- title-only 不改变 route generation；slug-only 只增加一次 route generation，不新增 deployment/version，不调用 provider。
- 改名保持 site id/uuid、Owner、成员、ACL、active version、vars/secrets 与 data namespace。
- A→B→C 的 A/B 都直接指向 C；C→A 可提升本 site 历史 alias；其它 site 不能占用 A/B。
- 并发 rename/create/deploy/delete 由 claim、lease 和 fencing 阻止丢失更新。
- snapshot 部分失败返回 202，同值重试与 scheduled reconciliation 可收敛。
- canonical 未同步、部分 alias 未同步和 stale reconcile CAS 均能正确维持 `routingStatus=pending`；全部 pointer 确认后 list/detail 变为 ready。
- 删除站点退役全部 alias、hold 全部 claim、清理全部 pointer 与缩略图 pointer。

### Router 与 Gateway 测试

- Router 继续读取 v2/v3 serve snapshot，读取 v4 serve/redirect snapshot。
- 308 保留 encoded path 与 query，Location 只能指向验证过的同环境 hostname。
- redirect chain、loop、跨环境、跨 site、target missing/reused 均 fail closed。
- internal redirect 不绕过 IP allowlist；最终目标继续执行 SSO、org、ACL、owner、disabled 策略。
- rename 前后的站点/用户 runtime data 使用同一 KV prefix；旧 capability 在 TTL 内仍可用，新 capability 使用真实 site id 与 data namespace。
- 旧、新 list cursor 的 namespace 校验均不会因 slug 修改越权或串站。

### API、Console 与存储测试

- Public API 未认证、scope 不足、跨 site access key、team viewer 与不存在站点均按契约拒绝。
- Console mutation 覆盖 CSRF、Owner、team publisher/admin、team viewer 和 platform admin。
- directory thumbnail 复用目录可见性，不能通过猜测 site id 读取隐藏缩略图。
- R2 校验覆盖三种允许格式、伪造 content type、空 body、超限、写失败、D1 失败清理、替换与幂等删除。
- 响应不包含 object key/bucket/data namespace；GET 正确处理 Content-Type、ETag、304、private cache 与 missing object。
- UI 覆盖 displayName fallback、placeholder、三个独立 pending/error 状态和 202 提示。
- CLI 使用历史 slug 发布到原 site，输出 canonical warning，且不会创建新 site。
- render、config inventory、workflow 和 docs tests 覆盖两个环境的独立 R2 配置。

最后运行相关 focused `node:test`、`pnpm lint` 和 `pnpm test`。staging 验收至少包括：上传/替换/删除缩略图、连续两次 rename、旧地址 308 path/query、当前地址内容、访问策略、deploy/rollback、runtime data 改名前后读写，以及 Admin/Workspace 权限矩阵。

## 完成标准

- 用户可在 Public API、Workspace Console 和 Admin Console 分别修改 title、slug、thumbnail。
- 任一字段可独立保存，API 与 UI 对空值、格式、大小、权限和冲突的行为一致。
- 活跃站点 rename 不产生 deployment/version，所有历史 hostname 最终直接 308 到当前 hostname。
- 改名前后的内容、权限、版本、runtime config 和 runtime data 连续，且无跨站、跨环境或 fail-open 路径。
- 缩略图仅经授权的 API/BFF 读取，R2 私有且不泄露 provider identifier。
- OpenAPI、CLI/skill 帮助、Console 文案、部署配置和测试与真实行为同步。
