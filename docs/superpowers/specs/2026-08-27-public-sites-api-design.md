# Cindy Public Sites API 设计

## 背景

Cindy `xd-sites` 插件需要展示“公开站点”列表。这里的“公开站点”是产品中的统一站点目录，表示当前用户拥有或当前身份可访问的站点；它不等于站点网络策略中的 `exposure=public`。

现有 `GET /.xd-pages/api/sites` 是管理视图，只返回当前凭证所属个人或团队范围内的站点，并携带 route、active version、policy generation、runtime 和 cache tier 等控制面字段。Console 已有内部目录查询，但它通过 `pages-console -> pages-api.internal` 的 BFF session lane 调用，不能接受 Cindy connection assertion，也不能直接作为 Public API 暴露。

本设计新增独立、必须认证的 Public API：

```http
GET /.xd-pages/api/public/sites
```

它为 Cindy 和其它具备用户身份的只读凭证提供稳定、最小化、可分页的站点目录，不改变 `/sites` 的管理语义。

## 目标

1. 为 Cindy `xd-sites` 提供当前环境的 active 站点目录。
2. 结果包含当前用户拥有的个人站点、所在团队的站点，以及按 `internal`、`org` 或 ACL 对当前用户可访问的站点。
3. 使用专用 Public Site 投影，返回展示、导航和更新时间所需字段，不暴露管理或 provider 内部状态。
4. 复用现有 Access Key / Cindy connection assertion 认证，并要求具备完整用户上下文和 `read:site` 能力。
5. 提供确定性排序和有界游标分页，避免组织级目录无限增长。
6. 同步开发期 OpenAPI、API 边界文档和 focused tests。

## 非目标

- 不修改 `GET /.xd-pages/api/sites` 的查询范围或响应结构。
- 不把 `/public/sites` 变成匿名 API；路径中的 `public` 表示 Public API lane，不表示无需认证。
- 不按 `site_routes.exposure=public` 过滤；网络 reachability 与 identity visibility 保持独立。
- 不增加或修改 `xd-cell` CLI 命令、CLI help 或 pages-skill 用户入口。
- 不复用或公开 `/.xd-pages/api/console/directory` 内部路由。
- 不返回 owner 姓名、邮箱、部门路径、团队 ID、ACL 条目或成员列表。
- 不返回 route ID、active version ID、runtime、provider、dispatch、generation、cache tier 或 capability。
- 不新增 D1 表或 migration。
- 不公开 `/openapi.json`。

## 方案比较与决策

### 方案一：独立 `/public/sites` 与最小投影（采用）

新增专用 handler、查询和响应 schema。它与 `/sites` 共享站点基础字段，但不共享完整管理投影。

优点：目录和管理职责清晰；可为非 Owner 返回最小信息；不会扩大 `/sites` 既有语义。缺点：新增一个 API 合约和查询路径。

### 方案二：`/sites?scope=accessible`

在现有管理列表上增加查询参数。

优点：端点更少。缺点：同一路径会随参数改变授权范围和对象敏感度，容易让既有调用方把“可访问”误判为“可管理”，也难以保持响应字段最小化。

### 方案三：新路径复用 `/sites` 完整对象

优点：实现和客户端复用最直接。缺点：向只有浏览权限的用户暴露 route、version、runtime 和策略 generation 等控制面状态，不符合最小披露原则。

## 名词与访问语义

### “公开站点”

“公开站点”是 Cindy UI 的产品名称。本 API 返回“当前认证用户可发现的 active 站点”，不保证调用者当前网络一定可以打开站点：`exposure=internal` 的站点仍可能受到 Router 公司网络/VPN 门禁。

### 结果集

查询固定使用当前 Worker 的 `config.environment`，不接受 query、body 或 connection claim 指定环境。站点必须满足：

- `sites.deleted_at IS NULL`；
- 存在当前环境的最新 route；
- route 的 `route_status = active`；
- route 存在 active version；
- 当前有效 visibility 必须是 `internal`、`org`、`acl` 或 `owner` 之一；`disabled` 和任何未知值都 fail closed；
- Owner 类型必须是 `user` 或 `team`；team-owned 站点的团队必须与站点同环境、`status = active`、`deleted_at IS NULL`，否则无论 visibility 为何都 fail closed；
- 且满足下列任一关系：
  - 个人 Owner 是当前用户；
  - Owner 是当前用户仍为 active member 的有效团队；
  - visibility 为 `internal`；
  - visibility 为 `org`；
  - visibility 为 `acl`，且 allow entry 命中当前用户的规范化邮箱；
  - visibility 为 `acl`，且 allow entry 命中当前用户已落库的完整部门路径或其父部门路径；
  - visibility 为 `owner`，且当前用户是个人 Owner。

单次 SQL 查询使用 OR 条件表达可访问关系，因此同一站点天然只返回一次，不在 transport 层拼接多份结果。个人 Owner 可看到有效 visibility 下自己的站点；团队成员可看到团队拥有且 visibility 为 `internal`、`org` 或 `acl` 的站点。团队站点的 `owner` visibility 和任何未知 visibility 都必须排除，不依赖数据库值始终合法的假设。

`config.environment` 可为 `production`、`staging` 或本地开发使用的 `local`。公开部署只运行前两种环境；`local` 仍进入响应和 cursor 校验，保证本地 Worker 与测试使用同一合约。

`internal` 与 `org` 目录项只对已经通过本 API 认证的 active 用户返回；本接口不提供匿名目录。

### 部门 ACL

Public handler 在查询前对当前用户执行与 Console 一致的 best-effort 部门 hydration：

- 已有新鲜部门路径时直接使用权威 `users` 记录；
- 缺失或过期时可复用现有 XDS hydration；
- hydration 不可用或失败时，请求仍可返回其它可见站点；
- 没有可信完整部门路径时，部门 ACL 必须 fail closed；
- handler 只在部门路径已新鲜或 hydration 成功并重新读取权威用户记录后，向 Store 传入 `departmentAclEnabled = true`；异常或仍 stale 时即使旧路径还在库中也不得用于本次查询；
- 不读取 Cindy assertion 中的额外 role、department 或 identities claim。

## 认证与授权

请求复用 `authenticateApiRequest()`。通过认证后还必须满足 Public Sites 专用能力检查：

| 凭证 | 结果 |
| --- | --- |
| Cindy connection assertion | 允许；现有固定 scope 包含 `read:site` |
| CLI login 用户凭证 | 允许；具备完整用户上下文和 `*` |
| 未绑定单站点的个人 Access Key，含 `read:site` 或 `*` | 允许 |
| 仅含 `deploy:site` 的 Access Key | 拒绝 |
| Team Access Key | 拒绝 |
| site-scoped Access Key | 拒绝 |
| 用户不存在、非 active 或 session version 失效 | 沿用现有认证拒绝 |

授权不依赖 `actor.source === cindy_connection`，而依赖“active 人类用户上下文 + 目录读取能力”。这样不会把 API 合约绑定到单个客户端名称，同时避免 team/site credential 枚举组织目录。

Public Sites 授权 helper 必须显式检查：

- actor 能解析到非空 `userId`；
- Access Key 的 `ownerType` 不是 `team`；
- Access Key 没有 `siteId`；
- Access Key scopes 包含 `read:site` 或 `*`；
- 非 Access Key 用户 actor 继续使用其现有完整用户权限。

## API 合约

### 请求

```http
GET /.xd-pages/api/public/sites?limit=50&cursor=<opaque>
Authorization: Bearer <credential>
```

查询参数：

- `limit`：可选整数，范围 `1..100`，默认 `50`；重复参数、空值、小数、符号或范围外值均拒绝。
- `cursor`：可选、非空、最长 2048 个 ASCII 字符的 opaque base64url cursor；重复参数、超长值或解析失败均拒绝。
- 未知查询参数返回 400，避免客户端误以为筛选已生效。

### 成功响应

```json
{
  "sites": [
    {
      "id": "site_xxx",
      "title": null,
      "displayName": "2026q2-qbr",
      "slug": "2026q2-qbr",
      "environment": "production",
      "routingStatus": "ready",
      "hostname": "2026q2-qbr.workers.xd.team",
      "url": "https://2026q2-qbr.workers.xd.team",
      "owner": {
        "type": "user"
      },
      "visibility": "org",
      "createdAt": "2026-07-01T08:00:00.000Z",
      "updatedAt": "2026-07-27T08:00:00.000Z"
    }
  ],
  "pagination": {
    "nextCursor": null
  }
}
```

空结果返回 `sites: []` 和 `pagination.nextCursor: null`。

### Public Site 字段

| 字段 | 语义 |
| --- | --- |
| `id` | 稳定站点标识，用于客户端去重；不是 provider resource ID |
| `title` | 可选展示名称；未设置为 `null` |
| `displayName` | 服务端计算的 `title || slug` |
| `slug` | 当前 canonical slug |
| `environment` | 当前 API Worker 环境，只能是 `production`、`staging` 或本地开发使用的 `local` |
| `routingStatus` | 当前 slug 路由是否已收敛，`ready` 或 `pending` |
| `hostname` | 当前 route canonical hostname，供列表展示 |
| `url` | 使用 HTTPS 和当前 hostname 构造的绝对 URL |
| `owner.type` | `user` 或 `team`；不返回 owner 身份信息 |
| `visibility` | 当前 route 的有效 visibility，不返回 default visibility |
| `createdAt` | `sites.created_at` 的 ISO 8601 时间 |
| `updatedAt` | `sites.updated_at` 与当前 route `updated_at` 中较晚的 ISO 8601 时间 |

只返回 active route，因此不增加恒为 `active` 的 `status`。删除站点已被查询排除，因此不返回恒为 `null` 的 `deletedAt`。

### 与 `/sites` 的差异

`/sites` 继续是管理视图，返回 `defaultVisibility`、完整 `route` 和站点生命周期时间。`/public/sites` 是发现视图：

- 查询范围更宽，可包含非本人所有但当前可访问的站点；
- 只返回当前有效 `visibility`；
- 把 `hostname` 和 `url` 作为稳定导航字段；
- 保留 UI 所需的 `createdAt` / `updatedAt`；
- 不返回管理、部署和 provider 内部字段。

## 排序与游标

目录按 `updatedAt DESC, id DESC` 排序。这里的 `updatedAt` 使用响应字段的同一计算规则，保证 UI 显示时间与服务端排序一致。

查询读取 `limit + 1` 条记录：

- 不超过 `limit` 时，`nextCursor = null`；
- 多出一条时只返回前 `limit` 条，并用最后一条返回记录生成 `nextCursor`。

cursor payload 至少包含：

```json
{
  "v": 1,
  "scope": "public-sites",
  "environment": "production",
  "updatedAt": "2026-07-27T08:00:00.000Z",
  "id": "site_xxx"
}
```

cursor 对客户端保持 opaque。服务端在解码前限制 encoded cursor 最长 2048 个 ASCII 字符，再验证版本、scope、environment（含 `local`）、ISO 时间和 site ID；其它环境或其它 endpoint 的 cursor 返回 400。cursor 不承载授权信息，不替代每次请求的认证和可访问条件复核，因此无需签名；调用方篡改 cursor 最多改变自己的翻页位置，不能扩大结果集。

翻页条件使用严格 keyset：

```text
effective_updated_at < cursor.updatedAt
OR (effective_updated_at = cursor.updatedAt AND sites.id < cursor.id)
```

目录在翻页期间发生更新时遵循普通 keyset pagination 语义：客户端可能在下一次完整刷新前看不到移动到已读页之前的记录，但不会因 offset 漂移产生大范围重复或跳页。

## 架构与数据流

### Transport

新增聚焦的 Public Sites handler，并在 router 中只对精确路径 `/.xd-pages/api/public/sites` 分发：

1. 验证请求方法和 query。
2. 调用 `authenticateApiRequest()`。
3. 执行 Public Sites 专用 actor 能力检查。
4. best-effort hydration 当前用户部门信息。
5. 调用 store 的 Public Sites 查询。
6. 构造最小响应投影和下一页 cursor。

路径必须精确匹配；`/.xd-pages/api/public/*` 的其它路径继续返回 404。除 GET 外返回 405。

### Store

在 sites repository 与测试 store 中增加独立的 Public Sites 查询方法。它接收：

- `environment`；
- `viewerUserId`；
- `limit`；
- 可选 keyset cursor。

查询只选择构造 Public Site 所需的站点、最新 route 和 owner type 字段。Owner/ACL 表只用于授权条件，不把 subject value、用户邮箱、部门路径、团队 ID 或成员信息返回 transport。

不直接复用 `listSitesForUser()`：该方法表达 owner/team 管理范围，不能覆盖 org/ACL 目录语义。不直接复用 Console transport；Public 与 Console 保持独立认证和 response mapper。

### Response mapper

Public Site mapper 是独立的纯函数，并用精确字段测试锁定。它可以复用现有 `siteMetadataRoutingStatus()`，但不能展开完整 route 或 Console owner display projection。

## 错误语义

| HTTP | code | 场景 |
| ---: | --- | --- |
| 400 | `PUBLIC_SITES_QUERY_INVALID` | limit、cursor、重复或未知 query 参数无效 |
| 401 | 现有认证错误 | 缺失、无效或过期 Access Key / Cindy assertion |
| 403 | `PUBLIC_SITES_FORBIDDEN` | 缺少用户上下文或 `read:site`，或使用 team/site-scoped key |
| 405 | `METHOD_NOT_ALLOWED` | 非 GET 请求 |
| 500 | `API_STORE_UNAVAILABLE` | D1 binding 不可用 |
| 503 | `PUBLIC_SITES_UNAVAILABLE` | 目录查询暂时失败 |

错误继续使用现有 `{ error: { code, message, action } }` envelope。不得在错误或日志中输出 token、assertion claims、ACL subject、SQL 或内部资源 ID。

部门 hydration 失败不是 503；它只导致本次无法通过部门 ACL 获得额外目录项，并保持 fail closed。

## OpenAPI 与文档

`apps/pages-api/src/openapi.js` 新增：

- `PublicSiteOwner`；
- `PublicSite`；
- `PublicSitesPagination`；
- `PublicSitesResponse`；
- `GET /.xd-pages/api/public/sites`。

所有新 schema 使用 `additionalProperties: false`，标记 required 字段，并记录 endpoint 必须认证、`public` 不表示匿名、query limit/cursor 约束和错误码。开发期 OpenAPI 仍不作为 HTTP route 暴露。

同步更新：

- `docs/api-boundary.md`：Cindy connection assertion 可调用的目录能力和凭证限制；
- `docs/architecture/xd-cell-console.md`：Console 目录与 Cindy Public Sites 的共同结果语义及不同认证边界；
- 对应 OpenAPI、architecture 和 public-docs boundary tests。

本次不增加 CLI/skill 命令，因此不修改 CLI help 或 pages-skill 操作说明。

## 测试策略

### 授权

- Cindy assertion 成功并按用户身份查询。
- CLI 用户与具备 `read:site` / `*` 的非 site-scoped 个人 key 成功。
- deploy-only、team key、site-scoped key 返回 403，且 store 查询未执行。
- 无认证、无效 assertion、inactive user 和 stale credential 沿用现有错误。

### 结果集

- 返回当前用户个人 Owner 的 active 站点。
- 返回当前用户仍为 active member 的有效团队站点；所有 team-owned 站点都要求团队 active、未删除且与站点同环境。
- 返回 active `internal`、`org`、email ACL 和 department ACL 站点。
- `visibility=owner` 的站点只对个人 Owner 返回。
- 排除 ACL 未命中、已移除团队成员、inactive/deleted/跨环境团队、`disabled`/未知 visibility、团队拥有的 `owner` visibility、非 active route、没有 active version、deleted 和其它环境站点。
- 多种条件同时命中的站点只出现一次。
- 部门 hydration 成功后可命中部门 ACL；失败时部门 ACL fail closed、其它目录项仍返回。

### 响应与信息披露

- 精确断言 Public Site 字段和 `updatedAt` 取 site/route 较晚时间。
- 用户 Owner 与团队 Owner 都只返回 `owner.type`。
- 响应不包含 `route`、owner ID/email、ACL、active version、runtime、provider、dispatch、policy/generation、cache tier、token 或 deletedAt。
- `hostname` / `url`、`visibility`、`routingStatus` 与当前 route 一致。

### 分页

- 默认 limit、边界 limit、limit + 1 截断和稳定排序。
- 同时间记录使用 ID tie-breaker，不重复、不漏掉静态数据集中的记录。
- next cursor 终止条件正确。
- malformed、超长、wrong scope、wrong version、wrong environment、重复和未知 query 参数返回 400；`local` 环境的响应与 cursor 可正常往返。
- 第二页重新执行授权和可访问条件，cursor 不能绕过 ACL 或环境隔离。

### 合约与回归

- OpenAPI schema、path、query、response 和错误码测试。
- 公网 API host 可调用新路径；Console internal host/header 不能替代 Public auth。
- 现有 `/sites`、Console directory、部署和访问策略测试保持通过。
- 运行 focused `node:test`、`pnpm lint` 和 `pnpm test`。

## 风险与回滚

- **目录枚举扩大**：通过 active 用户认证、read scope、人类 owner 限制、site/team key 拒绝和最小字段投影控制。
- **ACL fail-open**：只使用权威用户表的邮箱/部门路径，department hydration 失败时不返回部门 ACL 站点。
- **控制面字段泄漏**：Public Site 使用独立 mapper 和精确否定字段测试，不复用 `/sites` 完整对象。
- **分页不稳定**：使用与响应一致的 effective updatedAt 和 ID keyset，不使用 offset。
- **“public”语义误解**：OpenAPI 和 API boundary 明确 endpoint 必须认证，且不等价于 `exposure=public`。

回滚时移除 router 分支、Public handler、OpenAPI path 和文档入口；保留独立只读 repository 方法不会改变现有行为，也可以一并删除。`/sites`、Console directory、D1 schema 和站点访问策略不需要回滚。
