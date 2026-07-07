# XD Cell Console 产品与架构讨论稿

## 状态

本文是 `apps/pages-console` 的产品需求和架构讨论稿，用于对齐 XD Cell 个人控制台、站点目录、团队协作和 admin 后台的第一版方向。本文不代表已经进入实现阶段；实现前还需要基于本文拆出 implementation plan。

相关专题文档：

- [权限、团队与数据模型设计](2026-06-30-xd-cell-console-permissions-data-design.md)
- [低保真布局草图](2026-06-30-xd-cell-console-wireframes.md)

已确认约束：

- 产品名保持 **XD Cell**。
- `apps/pages-console` 采用 **Cloudflare Worker with Assets + 轻 BFF**。
- 第一版个人控制台不支持从网页上传并发布站点；发布仍通过 `xd-cell deploy` / CI / AI / agent 受控入口完成。
- 第一版不设计独立“回滚记录”菜单；当前只展示部署记录、版本历史和 deployment 状态。
- 首页是站点目录，不做额外营销 hero、说明区、CLI 快速开始区或最近更新区。
- 不新增站点标题、分类、简介等展示配置；目录退化展示 slug、hostname 和基础 tag。
- Access Key 默认有效期为 3 个月，最长有效期为 1 年。
- UI 信息架构参考 skill-hub：顶部全局栏 + 页面内左侧导航；workspace 与 admin lane 共用品牌框架，但菜单和权限不同。

## 背景

当前 XD Cell 主入口仍以 CLI 和 agent 发布为主。随着站点数量、团队协作、部门资产、访问策略和执行面治理增加，平台需要一个可视化入口：

- 普通用户发现和访问自己有权限看的站点。
- 普通用户管理自己或团队名下站点的访问策略、凭证和运行配置。
- 团队 admin 管理成员、团队 Access Keys 和团队设置。
- 平台管理员排查路由、hostname claim、部署失败、执行面容量和审计事件。
- staging 环境只对平台管理员开放，用于预览、排障和上线前验证。

skill-hub 可作为 UI 和信息架构参考：它已经验证了“首页/目录 + 工作台 + admin mode”的组织方式。但 XD Cell 不能照搬 skill-hub 的 Fastify API、Nginx Web 服务和 MySQL 业务模型；XD Cell 的真相源仍是 `pages-api`、`pages-auth`、`pages-router` 和 D1/KV/DO/Cloudflare WFP 体系。

## v1 legacy 与路由边界

`workers.xd.team` 同时涉及历史 v1 链路和 v2 子站后缀。按照当前项目边界，`apps/server` 是 v1 legacy，只维护旧 `workers.xd.team` 管理 API / route 行为；新的 console 不能把 v1 `apps/server` 作为能力来源，也不能复用 v1 `X-Pages-Token` / `/deploy` 语义。

本设计中的 `workers.xd.team/`、`/workspace/*` 和 `/admin/*` 是 v2 console 产品入口规划。落地时必须单独处理 route 迁移和兼容：

- `workers.xd.team/*` 作为 console host route 指向 `apps/pages-console`，优先级必须高于 `*.workers.xd.team/*` 用户站点 wildcard route。
- `*.workers.xd.team/*` 继续由 `apps/pages-router` 承载用户站点。
- v1 `apps/server` 旧入口只能作为 legacy 维护目标；如仍需保留旧管理 API，应放在既有 API host 或明确的 legacy host，不和 console host route 混用。
- `staging.workers.xd.team/*` 作为 staging console host route；`*-staging.workers.xd.team/*` 继续由 staging router 承载用户站点。
- console 上线前必须验证 console host route、wildcard route、reserved slug 和 hostname claim 互不抢占。

## 域名与入口

### Production

| 入口                                  | 用途                                 | 访问规则                                                                     |
| ------------------------------------- | ------------------------------------ | ---------------------------------------------------------------------------- |
| `https://workers.xd.team/`            | XD Cell 首页 / 站点目录 / 类营销入口 | 必须先通过公司网络 / VPN / 办公网 IP allowlist；未登录只展示可匿名评估的内容 |
| `https://workers.xd.team/workspace/*` | 个人控制台                           | 必须先通过 console IP allowlist，并且必须登录                                |
| `https://workers.xd.team/admin/*`     | 平台管理员控制台                     | 必须先通过 console IP allowlist，并且必须登录且是平台管理员                  |
| `https://{site}.workers.xd.team/*`    | 用户站点                             | 由 `pages-router` 执行 IP allowlist、visibility、SSO、ACL                    |

`workers.xd.team` 必须是平台 reserved host / console host route，不能被当成用户站点 slug。`staging`、`admin`、`workspace`、`api`、`auth` 等 slug 必须保留。

### Staging

| 入口                                          | 用途                   | 访问规则                                          |
| --------------------------------------------- | ---------------------- | ------------------------------------------------- |
| `https://staging.workers.xd.team/`            | Staging Console 首页   | 必须先通过 console IP allowlist，并且仅平台管理员 |
| `https://staging.workers.xd.team/workspace/*` | Staging workspace 视图 | 必须先通过 console IP allowlist，并且仅平台管理员 |
| `https://staging.workers.xd.team/admin/*`     | Staging Admin Mode     | 必须先通过 console IP allowlist，并且仅平台管理员 |
| `https://{site}-staging.workers.xd.team/*`    | staging 用户站点       | 由 staging `pages-router` 执行访问策略            |

staging console 顶部必须常驻环境提示：

```text
Staging · 仅平台管理员 · 与 production 数据和执行资源物理隔离
```

## 未登录首页展示规则

`workers.xd.team` 未登录时可以展示“可见内容”，但整个 console host 必须先经过公司网络 / VPN / 办公网 IP allowlist；未通过 IP allowlist 的请求直接 403，不进入登录、session、BFF API 或静态资源处理。通过 IP allowlist 后，只能展示当前请求无需用户身份即可判断允许访问的站点。第一版建议：

- 展示 `internal` 站点目录。`internal` 仍受公司网络 / VPN / 办公网 IP allowlist 保护，不代表公网公开。
- `pages-console` / BFF 必须对所有 console 页面、静态资源和 `/api/console/*` 执行公司网络、VPN 或办公网 IP allowlist；不允许变成公网目录。
- 不展示 `org`、`acl`、`owner` 站点，因为未登录时无法判断用户身份和 ACL 命中。
- 对未登录目录输出做最小化：slug、hostname、owner 展示名、visibility 和状态 tag；不展示内部 route id、version id、worker name、provider、secret、部署错误细节。
- 首页 `internal` 站点可以展示 owner / team display name，便于用户判断来源；但不展示邮箱、内部 user id、team id、route id 或 provider 信息。

登录后首页展示用户“有权限访问”的站点，包括：

- 个人拥有的站点。
- 所属自建团队的站点。
- 所属部门团队的站点。
- ACL 命中的站点。
- `org` 站点。
- `internal` 站点。

内容访问权限和管理权限分开：一个用户能访问站点内容，不代表能管理站点。

## 产品信息架构

### 顶部全局栏

顶部全局栏参考 skill-hub 的全局导航，但第一版保持更轻：

- `XD Cell`：回到 `workers.xd.team/`。
- `Sites`：站点目录。
- `工作台`：进入 `/workspace`。
- 右侧功能：主题、语言、通知、登录 / 用户菜单。
- 用户菜单：登录状态、账号信息、Access Keys、退出；平台管理员在这里看到 `管理员后台`，进入 `/admin`。

首页顶部不把 Admin 做成常驻一级导航。管理员后台入口收在用户菜单中，避免普通用户把 XD Cell 理解成一个治理后台产品。

### 首页 / 站点目录

首页类似“内部产品入口 + 站点发现页”，不是纯控制台。顶部栏下方直接展示站点目录瀑布流，不额外放营销 hero、说明区、CLI 快速开始区或最近更新区。首页不承载高风险管理动作。

目录不依赖额外展示配置；如果某些展示字段缺失，卡片可以退化为只展示 slug、hostname 和基础 tag。卡片只展示平台已有或明确需要的字段：

- slug。
- hostname。
- owner display name：个人或团队名；可缺省。
- owner tag：`个人` / `团队`。
- visibility tag：`internal` / `org` / `acl` / `owner`。
- status tag：active、deployment failed 等用户可见状态。
- 最近部署时间或更新时间。

目录筛选第一版只保留：

- 归属：全部可见、个人、团队。
- 访问策略：`internal`、`org`、`acl`、`owner`。
- 状态：active、deployment failed 等用户可见状态。

首页目录只展示 active 且当前请求可访问的站点。`disabled` 站点只在 owner workspace 或 admin 站点管理中展示；`deleted / held` 属于平台治理状态，只在 admin 站点管理、Hostname Claims 或 Ops 运维中展示。

团队站点中，如果 owner team 是部门团队，卡片额外显示 `部门团队` tag；但站点归属仍然只有 `个人` 和 `团队` 两类。

### Workspace 菜单

路径：`workers.xd.team/workspace/*`。

左侧菜单参考 skill-hub workspace：顶部展示用户头像、姓名、邮箱；下方按组分区。第一版不设置单独的工作台首页或概览页。`/workspace` 默认进入个人站点列表；用户需要查看团队资产时再切到团队站点或协作 / 团队。

站点：

- 个人站点。
- 团队站点。

最近访问、已禁用、已删除 / hostname held 不作为左侧菜单项；它们放在个人站点和团队站点页面内，作为状态筛选、排序或分组。团队站点是跨团队聚合列表，支持按团队过滤；单个团队详情页不重复展示站点列表。

站点列表字段：

- slug / hostname。
- 归属：个人 / 团队。
- owner display name。
- visibility。
- 状态 tag。
- active version。
- deployment shape。
- 最近部署状态。
- 更新时间。

协作：

- 团队。

参考 skill-hub workspace 和 GitHub team 组织方式，协作区只放“团队”一个主入口；部门团队是团队的 subtype，用 tag 显示，不作为独立一级菜单。

设置：

- 账号设置。
- Access Keys。

Workspace `Access Keys` 是当前用户可管理 key 的跨 owner 索引，默认创建 user-owned key；team-owned key 从对应团队详情创建。

### 站点详情

用户从个人站点或团队站点列表进入某个站点后，左侧切换为当前站点上下文。部署记录、访问控制和运行配置都属于站点详情，不放在 Workspace 全局侧边栏。

站点详情菜单：

- `概览`：站点基础信息、owner、hostname、visibility、当前 active version、最近部署状态。
- `部署记录`：当前站点的 deployments、版本历史、失败排查；第一版不单独提供回滚记录。
- `访问控制`：当前站点 visibility、ACL 邮箱 / 部门路径、访问诊断。
- `运行配置`：原 `Runtime`，展示 Vars、Secrets、Worker SDK / KV / Data 能力状态。
- `设置`：站点基础设置、危险操作确认。

访问控制边界：

- 访问策略修改只允许站点 owner user 或 owner team `admin` 执行。
- `publisher` 只能查看访问策略摘要和诊断结果。
- 高风险变更，例如改成 `internal`、删除 ACL、禁用站点，应要求明确确认；后续可以接 recent login。

运行配置边界：

- Vars：可查看和编辑非敏感变量。
- Secrets：只展示 name、revision、updatedAt；允许 put/delete，但永不显示 value。
- Secrets put/delete 属于高风险配置，只允许站点 owner user 或 owner team `admin` 执行。
- `publisher` 第一版只允许编辑非敏感 Vars 等低风险配置。
- Worker SDK：展示当前站点是否使用 runtime helper / data capability。
- KV / Data 能力：只展示能力状态和文档入口；不做跨用户数据浏览。

导航边界：

- `/workspace/sites/personal`：个人站点聚合列表。
- `/workspace/sites/team`：团队站点聚合列表，支持按团队过滤。
- `/workspace/sites/:siteId`：站点详情默认页，等价于站点概览。
- `/workspace/sites/:siteId/deployments`：当前站点部署记录。
- `/workspace/sites/:siteId/access`：当前站点访问控制。
- `/workspace/sites/:siteId/config`：当前站点运行配置。
- `/workspace/sites/:siteId/settings`：当前站点设置。

### 团队详情

团队详情页不是普通 Workspace 菜单加内容 tabs。用户从 `协作 / 团队` 进入某个团队后，左侧切换为当前团队上下文；团队名下直接放一级导航，不再增加分组标题。顶部全局栏仍保持 XD Cell 全局导航。

团队详情菜单：

- `成员`：团队成员、角色 viewer / publisher / admin、成员来源 tag；团队详情默认页。
- `Access Keys`：团队归属 key；仅 team admin 可创建、撤销和查看 key metadata。
- `设置`：团队级配置和危险操作入口；不承载成员列表、站点列表或 Access Key 列表。

团队详情不展示站点列表。团队站点统一在 Workspace 的 `团队站点` 页面展示，并支持按团队过滤。不单独设置模糊的“团队资产”页。第一版团队资产拆成明确功能：团队站点和团队 Access Keys；未来如果有 KV/data 等更多资产，再增加资产汇总页。

团队设置页内容：

- 团队信息编辑：自建团队 admin 可编辑团队名称、团队描述。
- 部门团队信息：部门团队的名称、描述、部门路径、XDS 同步信息均只读，不允许团队 admin 在这里编辑。
- 删除团队：自建团队 admin 可删除团队；删除前必须要求明确确认，并先完成团队资产盘点。只有团队名下站点已经删除或转移、Access Keys 已撤销后，才允许删除团队记录。部门团队删除、合并或资产转移仅平台管理员在 admin 后台处理。

删除团队前的资产盘点规则：

- 如果团队仍拥有 active / disabled / held 站点，不允许直接删除团队。
- 团队站点必须由团队 admin 手动处理：显式转移给其他团队或个人 owner，或者显式删除站点并进入 hostname held 流程。
- 删除团队流程只做资产盘点和阻止，不自动删除或自动转移团队站点。
- 如果团队仍存在未撤销、未过期的 team-owned Access Key，不允许直接删除团队。
- 团队 admin 必须先撤销 team-owned Access Keys；历史 key metadata 和使用记录保留用于审计。
- 删除团队不会自动删除站点、route、deployment、hostname claim、KV/data 或审计记录；站点等资产必须在删除团队前完成删除或转移，Access Keys 必须先撤销。
- 团队删除后，该团队不再参与权限计算，不再出现在普通团队列表；历史审计事件保留 team id / team name 快照用于追溯。
- 整个删除流程必须写审计日志，记录资产盘点结果、已转移 / 已删除 / 已撤销对象、actor 和删除时间。

导航边界：

- `/workspace/teams`：团队列表页，仍使用 Workspace 侧边栏。
- `/workspace/teams/:teamId`：单个团队详情默认页，重定向或等价于团队成员页。
- `/workspace/teams/:teamId/members`：团队成员。
- `/workspace/teams/:teamId/access-keys`：团队 Access Keys。
- `/workspace/teams/:teamId/settings`：团队设置。
- 面包屑使用 `工作台 / 团队 / <团队名> / <功能>`，用于表达当前已经进入团队上下文。

## Admin 菜单

路径：`workers.xd.team/admin/*`。仅平台管理员可访问。

左侧菜单参考 skill-hub Admin Mode，但收敛为“运营、审核 / 管理、审计”三组，并对齐 XD Cell 当前 Cloudflare 基础设施。

### 运营

- Dashboard · 平台概览。
- Ops 运维。

Dashboard · 平台概览：

- 站点数、团队数、用户数、部署数、失败部署数。
- production / staging 环境状态。
- 最近失败部署、最近 router 拒绝事件、最近高风险管理员操作。

Ops 运维：

- Cloudflare Workers for Platforms 状态：dispatcher、worker slots、script count、binding 状态。
- Route Snapshot 状态：生成时间、发布状态、staging / production 差异提示。
- Hostname Claims：claim 状态、冲突、deleted / held hostnames、保留 slug / host。
- WFP Workers / Runtime Bindings：只读诊断，不直接编辑 Cloudflare account / zone / Worker 资源。
- KV / D1 / Durable Object / queue 等平台依赖健康状态，只展示状态和诊断入口。
- API / Auth / Router / Console service binding 健康检查。
- staging / production 隔离检查提示。

Ops 运维的数据来源必须收口在 `pages-api` 的内部诊断 endpoint、部署 workflow 写入的只读快照，或经过单独评审的后台健康检查任务。`pages-console` BFF 不直接调用 Cloudflare account / zone API，也不持有 Cloudflare API token。

### 审核 / 管理

- 用户。
- 站点管理。
- 团队管理。

这里的“审核 / 管理”表示平台治理、异常排查和高风险操作审查，不表示第一版存在发布审批队列。

用户：

- 全部用户。
- 查看 SSO / XDS 同步信息。
- 设置或取消平台管理员。

站点管理：

- 全部站点。
- 按 owner、visibility、状态、deployment shape、hostname held 过滤。
- 查看站点基础信息、owner、路由、部署状态、访问策略摘要。
- 高风险治理动作必须走明确确认和审计。

团队管理：

- 全部团队，包括自建团队和部门团队。
- 部门团队 tag / 筛选。
- 设置 team admin。
- 团队合并。
- 资产转移。

### 审计

- Webhook。
- 审计日志。

Webhook：

- 平台管理员创建和管理出站 Webhook 订阅。
- 每个 Webhook 包含名称、Webhook URL、订阅事件、启用状态、创建人和最近投递状态。
- 第一版参考 skill-hub，只做平台级订阅，不做普通用户或团队自助订阅。
- Webhook URL 是 POST 目标；创建、编辑和每次投递前都必须校验 URL scheme 和解析后的目标地址，只允许 `https://`，并阻止内网地址、localhost、link-local、metadata endpoint 等 SSRF 风险目标。第一版建议禁止 HTTP redirect；如后续允许 redirect，每一跳 target 都必须重新执行同样校验。
- 第一版不额外提供 signing secret 或 HMAC 签名，Webhook URL 本身按 bearer secret 处理，类似 Slack Incoming Webhook。列表、详情、日志和审计导出必须脱敏 URL，只展示 host 和末尾少量字符。
- 投递请求带 `X-XD-Cell-Event`、`X-XD-Cell-Delivery`、`X-XD-Cell-Timestamp`，用于接收方识别事件和做幂等；这些 header 不作为强身份认证。
- 默认投递 XD Cell 标准 payload。平台先构造稳定 payload，再统一脱敏和字段白名单过滤；如果订阅配置了受限模板，则以脱敏后的标准 payload 作为输入渲染模板，再投递渲染结果。
- 受限模板是可选转换层，用于 Slack Incoming Webhook 等需要特定 JSON 结构的目标；不配置模板时直接投递标准 payload。模板只支持白名单变量替换，不支持 JS、任意表达式、网络请求、访问数据库或读取内部未脱敏字段。
- 创建和编辑 Webhook 时展示标准 payload 示例；选择或编辑模板时展示渲染预览。模板保存前必须通过 JSON 校验和变量白名单校验。
- 支持查看最近投递记录：event type、delivery id、target URL host、是否使用模板、template revision、render status、HTTP status、attempt、next retry at、deliveredAt、失败摘要。
- 不展示完整 payload、完整 Webhook URL、token、cookie 或敏感 metadata。

Webhook 订阅事件第一版建议：

- `site.created` / `site.deleted`。
- `deployment.created` / `deployment.succeeded` / `deployment.failed`。
- `site.visibility_changed`。
- `team.created` / `team.member_changed`。
- `access_key.created` / `access_key.revoked`。

平台接收到的 GitHub / Slack / executor callback 属于入站事件诊断，不属于这里的 Webhook 订阅功能。后续如需要展示入站事件接收状态，应放在 Ops 运维或审计日志的诊断视图中，而不是放在 Webhook 订阅菜单。

审计日志：

- 管理员操作。
- 团队成员、角色、合并、资产转移。
- Access Key 创建 / 撤销。
- visibility / ACL / secret name 变更。
- Router 拒绝事件。
- 支持导出脱敏记录。

第一版 admin 不做：

- 跨用户模拟登录。
- 查看 secret value。
- 直接编辑 Cloudflare account / zone / Worker 资源。
- 绕过 pages-api 的 production 部署。

## `apps/pages-console` 架构

主方案：Cloudflare Worker with Assets + 轻 BFF。

```text
Browser
  -> workers.xd.team / staging.workers.xd.team
  -> apps/pages-console
       - IP allowlist guard
       - serve static assets
       - console session
       - CSRF / Origin checks
       - /api/console/*
       - admin / staging gates
       -> service binding: pages-auth
       -> service binding: pages-api
```

### Console Worker 职责

- 托管 React/Vite 静态资产。
- SPA fallback。
- 对所有页面、静态资源和 `/api/console/*` 执行 IP allowlist；未通过时直接 403，不读取 cookie、不重定向、不调用 service binding。
- 处理 console 登录桥接和 host-only HttpOnly session。
- 暴露同源 `/api/console/*` 给浏览器。
- 通过 service binding 调 `pages-api` / `pages-auth`。
- 执行 Origin / Referer / CSRF 校验。
- 执行 staging admin gate 和 `/admin` admin gate。
- 聚合适合 UI 的只读数据。

### Console Worker 不做

- 不保存业务真相源。
- 不绕过 `pages-api` 的权限判断。
- 不直接持有 Cloudflare API token。
- 不把 CLI token / access key 暴露给浏览器。
- 不把 secret value 返回给浏览器。

### 为什么不选纯前端直连 `pages-api`

纯前端直连会要求 `pages-api` 面向浏览器开放更多 CORS、CSRF、cookie session 和错误处理面。当前 XD Cell 文档已经明确管理 API 是 CLI-managed boundary，浏览器态 API 需要额外 session 交换和 host-only cookie。轻 BFF 可以把浏览器安全、admin gate、staging gate 和 UI 聚合收口在 `pages-console`，同时保持业务授权在 `pages-api`。

## API 与数据缺口

为了支持 console，需要新增或扩展以下能力。具体 endpoint 命名在 implementation plan 中再定。

Console session：

- `pages-auth` 支持 console login code / session exchange。
- `pages-console` 签发 `workers.xd.team` host-only HttpOnly console session。
- session 包含 user id、environment、admin role、issuedAt、expiresAt。
- session 必须支持失效：用户退出、用户禁用、平台管理员授权变化、`users.session_version` 变化或环境 signing key 轮换后，旧 session 不得继续获得管理权限。

站点目录：

- 未登录目录：只在 console IP allowlist 内返回 internal 可展示站点的最小 metadata。
- 登录后目录：返回用户可访问站点。
- 支持 owner、team、visibility、deployment shape、status 筛选。

站点管理：

- 站点详情只读聚合。
- deployment / version / failure summary 查询。
- `publisher` 是发布权限。Console 可创建站点记录、hostname claim 和 owner 关系，但不上传 artifact、不创建 deployment；artifact 发布仍通过 CLI / CI / AI / agent 等受控入口完成。第一版不表示控制台网页上传发布。
- visibility / ACL 管理。
- Vars / Secrets 管理，Secret value 永不返回浏览器。
- 运行配置能力状态查询。

团队：

- teams 表。
- team_members 表。
- sites 增加 owner type / owner id，或通过兼容字段迁移到资产 owner 模型。
- 部门团队自动创建 / 加入。
- 团队详情和成员管理。

Access Keys：

- Access Key 支持 user-owned 和 team-owned。
- user-owned key 的可见和可操作范围来自创建用户对站点的当前权限。
- team-owned key 的可见和可操作范围来自 team owner 权限；创建者必须是该团队 admin，且创建入口在团队详情。
- 创建时必须选择 scope 和 expiresAt；默认 expiresAt 为创建时间 + 3 个月，最长有效期 1 年。
- Access Key plaintext 只在创建响应显示一次，之后仅保存 hash。

Admin：

- Dashboard 平台概览聚合。
- Ops 运维诊断：WFP、worker slots、Route Snapshot、Hostname Claims、runtime bindings、KV / D1 / DO / queue 依赖健康。
- Ops 数据来自 `pages-api` 内部诊断、部署快照或后台健康检查任务；每个诊断块必须展示 `checkedAt` 和 `source`，避免把过期快照误读成实时状态。`pages-console` 不直接持有 Cloudflare API token。
- 用户管理：全部用户查询、平台管理员设置。
- 站点管理：全部站点查询和治理摘要。
- 团队管理：全部团队、部门团队筛选、team admin 设置、团队合并、资产转移。
- Webhook 出站订阅管理和投递记录查询。
- 审计日志查询和脱敏导出。

目录聚合：

- 第一版目录只聚合现有站点、路由、部署、owner user / team 数据，不新增站点展示元数据模型。
- 字段包括 slug、hostname、owner display name、owner type、team type tag、visibility、route status、latest deployment status。

## 分阶段建议

### Phase 1：目录 + 只读控制台

- `apps/pages-console` 基础 Worker with Assets。
- 首页和站点目录。
- 登录态 workspace。
- 个人站点只读列表；为团队站点列表保留菜单和空态。
- 如果 owner 模型已完成迁移，可只读展示团队站点和 owner team tag；部门团队自动创建和成员管理不放在 Phase 1。
- 站点详情只读骨架：概览、部署记录、访问控制和运行配置的只读展示。
- 不做 Web 上传发布。

### Phase 2：站点管理能力

- visibility / ACL 管理。
- vars / secrets 管理。
- user-owned access key 管理。
- 部署失败排查增强和发布权限校验；部署记录只读展示已在 Phase 1 建立。
- `publisher` 可以通过 CLI / CI / AI / agent 等受控入口发布既有站点并编辑低风险配置；控制台网页上传发布不在本阶段。访问策略、secrets、删除和资产转移仍要求 `admin`。

### Phase 3：团队与部门团队

- 自建团队。
- 成员和角色管理。
- 部门团队自动创建 / 加入。
- 团队站点聚合列表和团队过滤。
- `publisher` 可以通过 CLI / CI / AI / agent 等受控入口创建团队站点；依赖 owner team 模型、团队角色和团队站点 owner 迁移完成。
- team-owned access key。

### Phase 4：Admin 治理

- Dashboard 平台概览。
- Ops 运维：Cloudflare / WFP / Route Snapshot / Hostname Claims。
- 用户管理：全部用户和平台管理员设置。
- 站点管理：全部站点。
- 团队管理：自建团队、部门团队、团队合并和资产转移。
- Webhook 出站订阅和审计日志。

## 实施验收要点

路由与环境：

- production console host route 不抢占 `*.workers.xd.team/*` 用户站点 wildcard route。
- staging console host route 不抢占 `*-staging.workers.xd.team/*` 用户站点 wildcard route。
- reserved slug：`staging`、`admin`、`workspace`、`api`、`auth` 不能被创建为用户站点。
- staging / production 的 session、API、D1、KV、DO、WFP namespace、signing key 必须隔离。
- `apps/pages-console` production / staging wrangler 模板必须配置 `IP_ALLOWLIST = "__IP_ALLOWLIST__"`，由 v2 renderer 从 GitHub Actions `vars.IP_ALLOWLIST` 注入。
- production / staging v2 deploy workflow 都必须包含 pages-console generate/deploy 步骤；production 仍只能由 `workflow_dispatch` 手动触发。

安全：

- `workers.xd.team/*` 和 `staging.workers.xd.team/*` 的所有 console 页面、静态资源和 `/api/console/*` 必须先经过公司网络 / VPN / 办公网 IP allowlist；未通过时直接 403。
- 未登录目录只在 console IP allowlist 内返回 internal 站点的最小 metadata。
- `/workspace/*` 必须登录；`/admin/*` 必须平台管理员；`staging.workers.xd.team/*` 除 auth login/callback 的 session / admin gate 例外外必须平台管理员。auth login/callback 仍必须先通过 IP allowlist。
- BFF 所有写请求必须校验 CSRF / Origin / Referer。
- console session 必须在退出登录、用户禁用、平台管理员授权变化、`users.session_version` 变化或 signing key 轮换后失效。
- Secret value、Access Key plaintext、CLI token、provider resource id 不得出现在列表、日志、审计导出或错误响应中；Access Key plaintext 只在创建响应显示一次。

权限与审计：

- `publisher` 可以创建团队站点记录，并通过受控入口发布团队站点，但不允许修改访问策略、管理 secrets、创建 team access key、删除站点或转移资产。
- 平台管理员不自动成为所有资产 owner；admin lane 治理动作必须写审计。
- 团队删除前必须阻止仍拥有站点或有效 team-owned Access Key 的团队删除。
- 部门团队自动成员初次加入默认 `admin` 是已确认策略；UI 必须醒目标识 `department_auto` 成员来源，并提示团队可以后续自行调整角色。手动调整后的角色或移除状态必须优先于后续 XDS hydration，避免用户被自动刷回 `admin`。
- 部门 ACL 无法确认用户部门时 fail closed。

文档与实现边界：

- `pages-console` 不保存业务真相源，不直接持有 Cloudflare API token。
- 新增 console API 必须通过 `pages-api` / `pages-auth` 的受控能力实现，不绕过 v2 管理边界。
- CLI、skill、README、API 边界文档如涉及用户可见行为，需要与最终实现同步。

## 待讨论问题

- 首页 internal 站点可以显示 owner；是否需要额外的站点隐藏开关留到后续单独讨论。
