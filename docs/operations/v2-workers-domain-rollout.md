# v2 workers.xd.team 域名共存上线流程

## 文档定位

本文记录 XD Cell v2 新站点默认域名从 `{slug}.pages.xd.team` 切到 `{slug}.workers.xd.team`，并与 v1 legacy `workers.xd.team` 链路共存的上线流程。

本文是 operations runbook，不是 ADR、spec 或历史 plan：

- ADR 用来记录长期不可轻易反转的架构决策；本主题的核心决策仍是“v2 以 CLI-managed API 为边界，router fail-closed，v1 legacy 只维护旧链路”。
- spec / plan 适合记录一次实现设计和任务拆分；本文关注跨 PR、跨环境、跨 Cloudflare 实测的上线门禁。
- 本文应作为 PR 和上线工单的门禁引用；具体实现 PR 仍需同步 handler、tests、CLI、skill、OpenAPI 开发合约和相关领域文档。

当前目标代码事实是：

- v2 新站点由 `apps/pages-api` 创建，默认 hostname 为 `{slug}.workers.xd.team` 或 `{slug}-staging.workers.xd.team`。
- v1 legacy 由 `apps/server` 服务 `{name}.workers.xd.team` 和 `{name}-staging.workers.xd.team`。
- 存量 v2 `pages.xd.team` hostname 仍是合法访问入口；重新部署、回滚和访问策略更新必须读取并保留既有 `site_routes.hostname`。

## 上线目标

最终目标：

```text
v1 legacy production: <name>.workers.xd.team              -> v1 per-site exact route
v1 legacy staging:    <name>-staging.workers.xd.team      -> v1 per-site exact route
v2 production:        <slug>.workers.xd.team              -> pages-router wildcard fallback
v2 staging:           <slug>-staging.workers.xd.team      -> pages-router-staging wildcard fallback
v2 legacy host:       <slug>.pages.xd.team                -> 保留既有 v2 站点访问
v2 legacy staging:    <slug>-staging.pages.xd.team        -> 保留既有 v2 staging 访问
```

生产切换后，只有新建 v2 站点默认发 `workers.xd.team` hostname；存量 `pages.xd.team` v2 站点继续服务，重新部署、回滚或修改访问策略时必须沿用既有 `site_routes.hostname`，不做隐式迁移。

## 核心上线原则

- 生产部署只允许人工触发 `Deploy XD Cell Production`，不得因为本域名切换增加 push / PR 自动 production deploy。
- staging 和 production 的 Worker、D1、KV、route、domain、slot pool、dispatch namespace 和 signing key 必须物理隔离。
- hostname 归属的权威逻辑放在 v2 D1；v1 只通过内部接口或 service binding 调用，不在 v1 引入新的权威 schema。
- router 和 auth 必须保持 fail-closed。未知 host、未知 route、环境不匹配、visibility/ACL 异常都不得 fall open。
- router 不读取 v1 `SITES` KV 做访问判定。v1 KV 只能作为 v1 自身存储、回填来源或诊断线索。
- Cloudflare route specificity 和 partial zone wildcard 能力必须在 staging 实测通过后才能推进 production cutover。

## v1 同名站点 takeover

v2 `POST /.xd-pages/api/sites` 和 `POST /.xd-pages/api/deployments` 共用同一条内部 takeover 编排，不新增用户请求字段，也不区分 CLI 与部署 API 调用方。只有普通 v2 创建先遇到 hostname claim 冲突，且当前 claim 是目标环境的 active v1 claim 时，才读取当前环境绑定的 `V1_SITES` KV。

takeover 必须同时满足：SSO 强认证 actor 有可信邮箱、KV token 的 `pages_<email>` 后缀与 actor 邮箱规范化后一致、KV 中的 `scriptName` 与 v1 claim 的 `owner_ref` 一致、hostname 与环境前缀校验通过。校验失败沿用通用 `HOSTNAME_CLAIM_CONFLICT`，不返回邮箱、token、Worker 名称或 v1 metadata。

`HOSTNAME_CLAIM_CONFLICT` 还覆盖已属 v2、邮箱不匹配和 v1 metadata 异常等不可公开区分的确定性占用；公开响应标记 `retryable=false`，调用方不得用同一账号和 slug 盲目重试。该标记不改变归属门禁，也不向普通用户披露占用方。

通过校验后，pages-api 使用已有 runtime `CF_API_TOKEN`、`CF_ACCOUNT_ID` 和 `CF_ZONE_ID_NEW`：先严格确认 Worker 名称等于目标环境推导出的 `pages-<slug>` / `pages-staging-<slug>`，并排除平台保留 Worker，再分页读取完整 route 列表。目标 exact route 存在时必须唯一、必须绑定该 Worker，删除失败仍 fail closed；route 列表、绑定或环境不可信时不会继续 takeover。

exact route 安全解除后，pages-api 再次读取 KV 并比较已验证 target，然后由 D1 单批事务把原 v1 claim CAS 更新为 v2 claim，并同时创建 site、route、owner member 和审计事件；CAS 失败会整体回滚。KV 复核或 D1 提交失败时，只有原 active v1 claim snapshot 仍完全一致才恢复同一 pattern / Worker 的 exact route；claim 已经被并发请求提交为 v2 时不得恢复旧 route。

D1 成功后才清理 Worker：解除 exact route 前读取的完整 route 列表没有其它引用时使用非 force DELETE 删除脚本；仍有其它 route 引用或脚本删除失败时保留 Worker，并写入 `v1_worker_script` cleanup task。scheduled/admin runner 必须从 task 的 v2 site 重新按环境和 slug 推导 Worker 名称、再次分页确认没有任何 route 引用，才可使用非 force DELETE 删除，不能信任 task 中任意 Worker 名称。随后删除 `V1_SITES` 的 slug key；KV 删除失败不回滚已提交的 v2 站点，而是写入 `v1_sites_kv_record` cleanup task，由 scheduled/admin runner 只删除同环境的 KV key。Worker 或 KV cleanup task 创建失败同样不能反向把已提交的 v2 站点改成失败，遗留资源进入人工 reconciliation。

上线验证至少覆盖：同邮箱成功接管、不同邮箱无任何 Cloudflare DELETE、Worker 名称与 slug 不一致拒绝、平台保留 Worker 拒绝、共享 Worker route 只删除目标 exact route 并继续部署、route/Worker 绑定不一致拒绝、route 查询或删除失败保留 v1 claim、KV 复核或 D1 CAS 失败且 claim 未变时恢复原 route、并发请求已提交 v2 时不恢复旧 route、Worker/KV 删除失败后 cleanup task 成功重试，以及 staging/production 的 KV、zone、Worker 前缀不串环境。

## 手动资源 / 配置确认

大部分资源已经存在或由 wrangler template 部署创建，不需要手工新建新的 D1/KV。当前已知前提：

- GitHub Actions production / staging environment 中所需 vars 和 secrets 已在同一环境内可用。
- DNSPod 与证书侧 `*.workers.xd.team` 已可用。

结论：本次上线不需要额外手工申请 GitHub environment 变量 / secret、DNSPod 记录或 wildcard 证书；人工工作集中在 route 权限与绑定实测、可选 service binding 配置、回填目标环境确认和 cutover gate。

上线前只保留以下人工复核和实测项：

### Cloudflare / DNS

- Cloudflare partial zone 下 staging 可以绑定并命中 `*-staging.workers.xd.team/*` Workers route。
- production 可以绑定 `*.workers.xd.team/*` Workers route；部署时必须保留既有 `*.pages.xd.team/*` route。
- v1 per-site exact route 仍由 v1 deploy/delete 管理；v2 不手工创建每个站点的 workers route，只绑定 router wildcard。
- `CLOUDFLARE_API_TOKEN` 具备 wrangler deploy 新增 / 更新 v2 router routes 的权限。
- v1 runtime `CF_API_TOKEN` 具备 list/create/update/delete Workers routes 的权限；delete route 是本次新增能力，不能只验证原来的 bind route。

### GitHub environments

- production / staging environment 中现有 v2 vars 继续从同一个 GitHub Actions environment 读取：`CLOUDFLARE_ACCOUNT_ID`、`PAGES_V2_D1_DATABASE_ID`、`PAGES_V2_ROUTE_SNAPSHOTS_KV_ID`、`IP_ALLOWLIST`。
- v1 workflow 使用的 `SITES_KV_NAMESPACE_ID`、`CF_ZONE_ID_NEW`、`CF_API_TOKEN` 也从同一个 GitHub Actions environment 读取，不写入代码或文档。
- 如果 v1 调 pages-api claim 接口使用 service binding，不需要新增 shared secret，但要在 v1 wrangler template / deploy workflow 中配置对应 service binding。
- 如果因为环境限制改用内部 HTTP 调用，必须新增内部鉴权 secret，并只放 GitHub environment secret / Worker secret；优先选择 service binding。

### 回填执行环境

- 回填必须能读取目标环境的 v1 `SITES` KV 和 v2 `site_routes` D1；staging 回填只能读 staging 资源，production 回填只能读 production 资源。
- 回填脚本和 conflict-check artifact 可以包含 hostname、slug、v1 `scriptName`、v2 `siteId` / `routeId` 等定位字段；不能包含 v1 `token`、完整 KV JSON、KV namespace id、D1 database id、Cloudflare account / zone id 或任何 secret。
- production 回填前人工确认当前没有正在运行的 v1 deploy / v2 create；如果不能冻结入口，回填脚本必须用 insert-if-absent 并在结束后重跑一次差异检查。

### SSO / auth

- 不需要新增 SSO provider redirect URI；SSO callback 仍回到 `auth.pages.xd.team` 或 `auth-staging.pages.xd.team`。
- 需要实测 auth 生成的 site callback 可以跳回 workers host，且 `__Host-pages_site_session` 是 host-only cookie。

### 回滚能力

- 能通过一次 production deploy 关回新站点默认 suffix。
- 能通过 wrangler / Cloudflare dashboard 单独移除 v2 `*.workers.xd.team/*` wildcard route。
- D1 migration 不做破坏性 rollback；回滚以关开关、撤 route、暂停 claim enforcement 为主。

## hostname claim 数据模型

`hostname_claims` 是 hostname / slug 占用的权威账本，不替代 v1 `SITES` KV 或 v2 `sites` / `site_routes` 业务数据。claim 表只保存非敏感定位信息；v1 `SITES` 里的 `token`、完整 KV JSON、Cloudflare account / zone id 和真实 secret 不得写入 claim 表或冲突表。

建议字段：

```sql
CREATE TABLE hostname_claims (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  hostname TEXT NOT NULL,
  normalized_slug TEXT NOT NULL,
  hostname_family TEXT NOT NULL,
  owner_system TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  owner_ref TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL,
  acquired_at TEXT NOT NULL,
  lease_expires_at TEXT,
  released_at TEXT,
  reuse_hold_until TEXT,
  release_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX idx_hostname_claims_hostname
  ON hostname_claims(hostname);

CREATE INDEX idx_hostname_claims_environment_slug_live
  ON hostname_claims(environment, normalized_slug)
  WHERE status IN ('pending', 'active', 'held', 'conflicted');
```

字段语义：

- `hostname` 是真实访问域名，例如 `test.workers.xd.team` 或 `test.pages.xd.team`。
- `normalized_slug` 是跨 suffix 的站点名，例如 production `test.workers.xd.team`、production `test.pages.xd.team` 都归一为 `test`；staging `test-staging.workers.xd.team` 也归一为 `test`。
- `hostname_family` 区分 `workers`、`pages` 或其它系统保留 host family，用于迁移期审计和 slug 互斥判断。
- `owner_system` 只能是 `v1`、`v2` 或 `system`；`owner_id` 对 v1 默认使用 `v1:<environment>:<name>`，v2 使用 `site_id`。它用于诊断、幂等和各系统内部 release 校验，不作为 v1/v2 跨系统归属证明。
- `owner_ref` 只做诊断定位，v1 可写 `scriptName`，v2 可写 `site_routes.id`。
- `status` 取值为 `pending`、`active`、`released`、`held`、`conflicted`。同一 hostname 复用时优先更新原 claim 行的状态，不通过重复插入绕过唯一约束。
- `pending` 只用于 v1 新建这类无法和 Cloudflare / KV 放进同一事务的外部操作；v1 在 Cloudflare deploy、route bind、`SITES.put` 全部成功后确认成 `active`，过期 pending 由 reconciliation 处理。
- `reuse_hold_until` 是删除后的短暂复用保护，不是长期观察期。它只用于避免 v1 exact route、Worker script、KV/D1 删除尚未全部确认时立刻把 hostname 分配给另一方；如果 release 时已同步确认 Cloudflare route/script 和业务源数据都清理完成，可以把 hold 设得很短。
- `normalized_slug` 不是唯一 key，而是同名站点释放组。存量 legacy v1/v2 如果已经分别占用 `workers` / `pages` 两个不同 hostname，回填允许同时写入 active claim，保证两边原 host 都能继续 deploy / rollback / policy update；这不要求跨系统 owner 一致。
- 新增 claim 仍必须检查同一 `environment + normalized_slug` 下是否存在任意其它 live claim。也就是说，存量 legacy v1/v2 同 slug 可以共存，但不能新增第三个 claim，也不能在部署后再创建同 slug、不同 hostname 的站点。只有同 slug 组内所有 claim 都 release / delete，且 reuse hold 到期后，该 slug 才重新可用。

v1 `SITES` KV 回填示例：

```json
{
  "test": {
    "name": "test",
    "scriptName": "pages-test",
    "token": "<redacted-v1-token>",
    "createdAt": "2026-05-14T02:43:13.845Z",
    "updatedAt": "2026-05-14T03:28:17.995Z"
  }
}
```

对应 claim：

```text
environment: production
hostname: test.workers.xd.team
normalized_slug: test
hostname_family: workers
owner_system: v1
owner_id: v1:production:test
owner_ref: pages-test
status: active
source: backfill_v1_sites
acquired_at: 2026-05-14T02:43:13.845Z
```

`hostname_claim_conflicts` 是不丢数据的阻断冲突诊断队列，不是所有同 slug 情况都写入该表。建议字段：

```sql
CREATE TABLE hostname_claim_conflicts (
  id TEXT PRIMARY KEY,
  environment TEXT NOT NULL,
  hostname TEXT NOT NULL,
  normalized_slug TEXT NOT NULL,
  candidate_system TEXT NOT NULL,
  candidate_owner_id TEXT NOT NULL,
  candidate_ref TEXT,
  candidate_hostname TEXT,
  reason TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  resolved_at TEXT,
  resolution TEXT
);
```

冲突处理规则：

- 可以自动 resolve：同源同 owner 重复回填、已 release 且 reuse hold 已过并确认源数据不存在、重复运行回填产生的完全相同候选。
- 可由脚本二次确认后批量 resolve：v1 KV 有记录但 exact route / Worker script 缺失，或 Cloudflare route 存在但 KV 缺失。这类必须输出脱敏摘要，不能静默删除线上资源。
- 必须人工处理：同一 hostname 被不同 owner 声称；v1 KV、Cloudflare route、Worker script 三者不一致且无法判断真实线上入口。
- v1 和 v2 已有 live 数据且 `normalized_slug` 相同、hostname 不同，是 legacy coexistence，不写入 `hostname_claim_conflicts`，也不阻断回填 apply。同 hostname 多 owner 或同系统同 slug 多 owner 仍默认写入 blocking conflict。
- 阻断冲突存在时，对应 hostname 不写入 active claim；v1 deploy / v2 create 对同 hostname 或同 `normalized_slug` 的新增申请返回 409，直到冲突被 resolve。

## 快速上线流程

当前用户量较小，可以不做独立双写观察阶段。实现仍按 PR 1、PR 2、PR 3 三段拆分，便于 review 和回滚；上线时允许 PR 2 + PR 3 合并到同一个 production 发布窗口，一次手动部署完成 delete/reuse hold 与 workers 默认域切换。

PR 2 + PR 3 一次部署的硬门禁是 `.github/workflows/hostname-claims-conflict-check.yml`。这个 workflow 有两种运行方式：

1. 先手动触发 `Hostname Claims Conflict Check`，选择目标 `environment`，`apply=false` 做 dry-run。
2. workflow 只读导出目标环境 v1 `SITES` KV 的脱敏字段和 v2 未删除站点对应的全部 `site_routes`，包括 disabled route。
3. workflow 运行 `scripts/hostname-claims-backfill.mjs` 生成 `claims.sql`、`conflicts.sql`、`slug-coexistence.json` 和 `summary.json` artifact；dry-run 不 apply SQL、不 deploy、不写 Cloudflare 资源。
4. 只有 summary 中 blocking 冲突数量为 0，且 v1/v2 数量与预期一致时，才能执行初次写入 D1。
5. `slugCoexistence` 可以大于 0；它表示存量 v1/v2 同 slug 但不同 hostname 的共存组。上线前通过 `slug-coexistence.json` 人工抽样确认这些站点两边都应保留，不能把它当成 `HOSTNAME_CLAIM_CONFLICT`。
6. 确认 dry-run 结果后，重新触发同一个 workflow，保持相同 `environment`，勾选 `apply=true`。workflow 会重新导出实时 v1/v2 数据，并且只有 blocking 冲突仍为 0 时才把 `claims.sql` 写入目标 D1。
7. D1 写入完成后再手动触发 v1 / v2 production deploy；deploy workflow 仍不自动触发。
8. blocking 冲突不为 0 时停止 cutover；先按 `hostname_claim_conflicts` 的 owner/hostname 摘要处理数据，不允许带同 hostname 多 owner 冲突部署 workers wildcard。

这条门禁替代长时间 shadow/observe，但不删除 `record_only` / `enforce` 开关。异常时可以把 v1 claim gate 临时降级到 `record_only` 继续收集审计，同时停止新增 workers v2 站点或撤下 v2 workers wildcard。

### PR 1: 建立 hostname_claims 并接入创建路径

目标：先从现有 v1 / v2 数据建立 hostname 账本，然后让 v1 deploy 和 v2 create 立即以 claim 为准。

代码范围：

- D1 migration 增加 `hostname_claims`，以 `hostname` 作为唯一权威 key。
- store helper 支持 `acquire`、`confirm pending` 和失败新建的 `release pending`，覆盖幂等、同主体重入、他方冲突和 released hostname retry。
- acquire 必须靠 hostname 唯一约束保证真实访问域名原子占用；同 slug 组锁由同一 D1 batch / transaction 内的 live claim 查询保证，不能只在外层调用方做松散 SELECT。
- claim enforcement 必须有环境级开关，至少支持 `record_only` 和 `enforce`。可以缩短 record-only 时间，但不能删除这条能力；回填、normalize 或内部调用出错时必须能临时切回只记录不拒绝。
- v1 通过 `HOSTNAME_CLAIMS` service binding 调用 pages-api internal endpoint `https://pages-api.internal/.xd-pages/internal/hostname-claims/acquire`。wrangler 生成器默认 `HOSTNAME_CLAIMS_MODE=record_only`；staging binding 指向 `pages-api-staging`，production binding 指向 `pages-api`。production 正式上线后，`Deploy Production` workflow 必须显式设置 `HOSTNAME_CLAIMS_MODE=enforce`，否则 v1 会在 claim 冲突或 service binding 写入失败时继续部署，跨 v1/v2 同 slug 互斥无法 fail closed。
- 新增一次性回填脚本或内部管理命令：
  - 输入必须来自目标环境的脱敏导出：v1 `SITES` KV 只保留 `name`、`scriptName`、时间等非 secret 字段；v2 D1 只导出未删除站点对应的 `site_routes` 字段。
  - 读取 v1 导出，生成 `<name>.workers.xd.team` 或 `<name>-staging.workers.xd.team` claim。
  - 读取 v2 所有未删除站点对应的 `site_routes`，生成当前 `{slug}.pages.xd.team` / `{slug}-staging.pages.xd.team` claim；不能只读取 active route，`disabled` 站点同样占用 hostname。
  - 生成 insert-if-hostname-absent SQL，不覆盖已有 claim；同 hostname 多 owner 必须输出 `hostname_claim_conflicts` SQL 和摘要，并默认 fail closed。
  - 发现同 `normalized_slug`、不同 hostname 的存量 v1/v2 候选时，写入两条 hostname claim，并在 summary 中增加 `slugCoexistence` 计数；同系统多 owner 的同 slug 候选写入 blocking conflict。
- v1 deploy 在 Cloudflare 上传 / `bindRoute` 前检查 v2 统一 slug/reserved 规则，并 `acquire(hostname, 'v1', owner_id)`。新建成功写入 `SITES` KV 后确认 pending claim 为 active；Cloudflare / route / `SITES.put` 失败时只释放本次新建的 pending claim，更新已有 v1 站点失败不得释放原 active claim。
- v2 create 必须把 claim、`sites`、`site_routes`、`site_members` 放在同一个 D1 batch / transaction 中提交。v2 不采用“先 acquire 再补偿 release”的外部操作模型；只有 v1 因为涉及 Cloudflare route / KV 需要 pending lease 和 reconciliation。
- 内部接口只供 v1 / pages-api 内部链路使用，不能变成公开用户 API。

人工配置 / 上线 gate：

- staging apply migration。
- staging 先以 `record_only` 模式跑 v1 deploy / v2 create 冒烟，确认会记录预期 claim 决策。
- staging 跑回填，确认 claim 行数与 v1 `SITES` + v2 未删除站点对应 `site_routes` 对齐。
- blocking 冲突清单为空；如果不为空，先人工处理冲突，不进入下一步。`slugCoexistence` 不要求为 0，但必须人工确认属于预期存量共存。
- staging 验证：v1 新 deploy、v2 新 create、v1/v2 同名互斥 409。
- production apply migration 前确认 production 回填命令使用 production v1 KV 和 production v2 D1，不读取 staging 资源。
- production 先 dry-run 回填并复核摘要：v1 数量、v2 数量、claim 数量、blocking 冲突数量和 `slugCoexistence` 数量。
- production dry-run 通过后，用同一个 `Hostname Claims Conflict Check` 勾选 `apply=true` 写入 D1；workflow 会重新导出实时数据并再次校验 blocking 冲突为 0。

### PR 2: 删除回收和 hostname 释放

开启 claim 冲突拒绝，并补齐 v1 / v2 的 hostname 释放语义。

代码范围：

- v1 deploy 和 v2 create 遇到他方 live claim 返回 409，错误提示可操作。
- v1 delete 删除 Worker script 和 KV 前后，还必须解绑 Cloudflare route，并 release claim 进入 reuse hold。
- v1 route unbind 必须只删除精确 `${hostname}/*`。删除前必须查询 Cloudflare route，确认 pattern 精确匹配、当前绑定 script 等于预期 v1 per-site `scriptName`，且 scriptName 带 v1 环境前缀；拒绝删除 wildcard route、平台保留 Worker、pages-router route 或任何绑定不匹配的 route。
- v2 新增站点 delete 或等价管理路径，写 `sites.deleted_at`、回收 `site_routes` hostname 占用，并 release claim 进入 reuse hold。
- reuse hold 时长必须明确写入文档和测试。

人工配置 / 上线 gate：

- staging 跑通创建、删除、reuse hold 内拒绝、reuse hold 后复用。
- v1 已存在时 v2 同名创建被拒；v2 已存在时 v1 同名 deploy 被拒。
- v1 delete 后 exact route 不再悬挂遮蔽 v2 wildcard。
- production 开启前确认 v1 delete route unbind 使用 production zone，且不会删除 v2 wildcard route。PR 2 可以和 PR 3 同一个 production deploy 落地，但必须等 conflict-check workflow 显示 blocking 冲突为 0。

### PR 3: 放开 workers.xd.team 并切默认域

先在 staging 让 v2 router/auth/CLI 支持 workers host，实测通过后在 production 手动 cutover。

代码范围：

- `pages-router` host classifier 接受 production `{slug}.workers.xd.team` 和 staging `{slug}-staging.workers.xd.team`。
- `pages-auth` OAuth state 和 site session host 校验复用同一分类规则。
- CLI 解除对 v2 workers host 的硬拒，但仍禁止指向 v1 `api.workers.xd.team` 作为 v2 API。
- `pages-router-staging` 增加 `*-staging.workers.xd.team/*` route。
- wrangler renderer 加环境串线保护：production 不得含 staging workers route，staging 不得含裸 production workers wildcard。
- `config.js` / `hostnameForSlug` 或等价配置只把新建 v2 站点默认 hostname 切到 `workers.xd.team`。
- v2 deploy / rollback / policy update 必须继续读取当前 site route，并沿用既有 hostname；不得在重新部署时把存量 `pages.xd.team` 站点迁到 `workers.xd.team`。
- 文档、skill、README、CLI help 和 OpenAPI 开发合约同步新默认域。

staging 必测：

- v1 exact route `foo-staging.workers.xd.team/*` 优先于 v2 wildcard，既有 v1 staging 站点不被抢走。
- 无 v1 exact route 的新 workers staging host 能进入 v2 router。
- partial zone CNAME setup 下 Cloudflare 能绑定并稳定服务 `*-staging.workers.xd.team/*` route。
- workers host 未命中 v2 route 时返回 404 fail-closed。
- SSO callback 和 `__Host-` site session cookie 在 workers host 正常工作。
- `internal`、`org`、`acl`、`owner`、`disabled` 在 workers host 与 pages host 行为一致。

人工配置 / 上线 gate：

- 上述 staging 实测全绿。
- 既有 v1 workers 站点抽样无影响。
- router/auth 安全测试覆盖 workers host。
- production router 新增 `*.workers.xd.team/*` 时必须保留 `*.pages.xd.team/*`。
- production cutover 前必须运行 `Hostname Claims Conflict Check`，确认 claim 回填输入与当前 production KV/D1 对齐、blocking 冲突数量为 0，且 `slugCoexistence` 全部属于预期存量共存。
- 手动触发 `Deploy XD Cell Production`，每个组件部署后立即冒烟；异常即停，不继续后续步骤。

## cutover 后的 v1 deploy 流程

上线完成后，v1 legacy deploy 仍继续服务存量 `workers.xd.team` 链路，但它不能再只依赖 `apps/server` 自己的 `SITES` KV 和 `isReservedSiteName`。v1 deploy 必须把 hostname 归属和 slug 保留规则交给 v2 权威逻辑兜底。

目标流程：

1. 读取 v1 deploy 请求，按现有规则取得 `name`、`X-Pages-Token`、preset、文件和环境。
2. 先做本地快速校验：`name` 只能是小写字母、数字和连字符，长度与 v2 `validateSiteSlug` 保持一致；缺 token、非法名字和明显保留名在触碰 KV / Cloudflare 前返回。
3. 调 v2 内部校验能力，使用与 `packages/pages-runtime-protocol` `validateSiteSlug(name, { environment })` 同源的规则检查 v2 保留 slug。v1 的 `apps/server/src/lib/site-names.js` 只能作为快速拒绝缓存，不能作为最终保留名真相源。
4. 读取 v1 `SITES` KV。如果站点已存在且 token 不匹配，沿用 v1 409；如果同 token 更新，继续走幂等更新。
5. 计算 v1 hostname：production 为 `${name}.workers.xd.team`，staging 为 `${name}-staging.workers.xd.team`。
6. 在 Cloudflare 上传和 `bindRoute` 前调用 v2 claim `acquire(hostname, 'v1', owner_id)`，新建 v1 站点先写 `pending` lease。
   - `owner_id` 必须是非 secret 的稳定 v1 站点标识，例如 v1 site name 或迁移后生成的 v1 site id，不能存 `PAGES_TOKEN`。
   - 同一 v1 站点 active claim 返回 ok。
   - 被 v2 或其它 v1 站点 active claim 占用时返回 409，提示换名或使用原 owner。
   - reuse hold 未过时返回 409，并给出可操作 retry 信息。
7. claim acquire 成功后才执行 v1 Cloudflare deploy、exact route bind 和 `SITES.put`。
8. `SITES.put` 成功后确认 claim 为 `active`。如果新建站点在 Cloudflare deploy / bind / `SITES.put` 失败，必须 best-effort release 刚 acquire 的 pending claim，并写 audit / log 供 reconciliation 处理。更新已有 v1 站点失败时不得释放原 active claim。
9. v1 delete 必须先确认 token ownership，再按“精确 route + 绑定 script 匹配”规则解绑 exact route、删除 script、删除 `SITES` KV，并 release claim 进入 reuse hold。

这条流程的目标是：上线后任何新 v1 deploy 都不会占用 v2 保留 slug，也不会绕过 `hostname_claims` 与 v2 新站点抢同一个 `workers.xd.team` hostname。

## cutover 后的数据流

### v1 deploy / update

1. v1 收到 deploy 请求并解析 `name`、`X-Pages-Token`、preset 和文件。
2. v1 做本地快速校验和 v2 统一 slug/reserved 校验。
3. v1 读取 `SITES` KV：
   - 已存在且 token 匹配：视为同一 v1 站点更新。
   - 已存在且 token 不匹配：沿用 v1 409，不触碰 Cloudflare 或 claim。
   - 不存在：视为新建。
4. v1 计算 hostname，并在 Cloudflare deploy / route bind 前调用 claim `acquire`。新建站点写 pending lease；更新同 exact hostname 的站点幂等通过。
5. claim 成功后，v1 执行 Cloudflare Worker upload、exact route bind、`SITES.put`，最后确认 claim 为 active。
6. 新建失败时 best-effort release 刚 acquire 的 pending claim，并写 audit / reconciliation 记录；更新已有站点失败时不得释放原 active claim。

### v2 create / deploy / rollback / policy update

1. v2 create 收到 slug 和 visibility，先走 `validateSiteSlug`。
2. v2 create 计算新默认 hostname，并把 claim acquire、`sites`、`site_routes` 和成员关系放在同一个 D1 batch / transaction 中提交。
3. v2 create 失败时整个 D1 batch / transaction 回滚；不留下半成品 claim。
4. v2 deploy、rollback、policy update 不重新计算默认 hostname，只读取既有 `site_routes.hostname` 并沿用。存量 `pages.xd.team` 站点重新部署后仍保留老域名。
5. v2 站点已存在但 claim 缺失时，不能静默迁移 hostname；应进入 reconciliation，补齐原 hostname claim 或阻断危险操作。

### v1 delete

1. v1 先校验 token ownership。
2. v1 根据 KV 记录定位 `name` / `scriptName`。
3. v1 查询 Cloudflare route 并只解绑精确 `${hostname}/*`，且 route 当前绑定 script 必须等于该站点 KV 中的 `scriptName`。任何 wildcard、平台保留 Worker、router route 或 script 不匹配都必须拒删并进入人工处理。
4. v1 删除 Worker script 和 `SITES` KV。
5. v1 release claim 进入 reuse hold；release 必须校验 owner 匹配，不能释放他方 claim。

### v2 delete

1. v2 校验 actor 权限。
2. v2 写 `sites.deleted_at`，并回收或失效 `site_routes` 当前 hostname。
3. v2 release claim 进入 reuse hold；release 必须校验 `owner_system='v2'` 且 `owner_id=site_id`。
4. reuse hold 内 v1/v2 同名新建都返回 409；只有同 slug 组内所有 live / held claim 都释放且 reuse hold 到期后，才允许重新 acquire。

## 上线后验证

生产冒烟至少覆盖：

- 新建 v2 测试站点，返回 URL 为 `<slug>.workers.xd.team`，且可访问。
- 存量 `pages.xd.team` v2 站点可访问。
- 存量 `pages.xd.team` v2 站点重新部署后仍返回原 `pages.xd.team` hostname，不被隐式迁移到 `workers.xd.team`。
- 存量 v1 `workers.xd.team` 站点可访问，未被 v2 wildcard 遮蔽。
- v1/v2 跨版本同名创建双向 409。
- 未登录访问受保护站点被拦截或跳转 SSO，登录后按 visibility / ACL 放行。
- 删除测试站点后，reuse hold 内复用被拒；Cloudflare route 不悬挂到已删除 Worker。
- `ROUTE_NOT_FOUND`、router 4xx/5xx、claim 冲突率、auth 失败率无异常尖峰。
- claim acquire / release 写入 audit 或等价运维审计。

## 回滚策略

优先回滚行为，不回滚 D1 schema：

- 默认域名开关可关回 `pages.xd.team`，停止新增 workers v2 站点。
- `*.workers.xd.team/*` v2 wildcard route 可单独撤下；撤下后 workers v2 新站点应 fail closed，不得串到 v1 或其它 Worker。
- claim enforcement 可临时降级为只记录不拒绝，但必须保留 audit，用于后续冲突清理。
- `record_only` / `enforce` 开关必须可按环境切换；production 异常时优先切回 `record_only`，不做 destructive schema rollback。
- 已 apply 的 D1 表保留，不做破坏性 migration rollback。
- 每个 production deploy step 都要有对应撤销动作，并在 staging 演练。

## 精简 Checklist

Checklist 只记录每步必须完成的内容和人工配置项，不要求长时间观察。

### PR 1 checklist

- [ ] migration 建 `hostname_claims`，`hostname` 唯一，并为同环境 live `normalized_slug` 建普通索引用于新增门禁查询。
- [ ] helper / 内部接口支持 acquire、confirm pending、失败新建 release pending 和幂等重入。
- [ ] claim enforcement 支持 `record_only` / `enforce` 环境开关。
- [ ] 回填脚本读取脱敏 v1 `SITES` 导出和 v2 未删除站点对应 `site_routes` 导出，生成 insert-if-hostname-absent SQL 和冲突 SQL；同 hostname 多 owner、同系统同 slug 多 owner 默认 fail closed，legacy v1/v2 `workers` / `pages` pair 记为 `slugCoexistence`。
- [ ] v1 deploy 使用 v2 统一 slug/reserved 校验，并在 Cloudflare deploy 前 acquire claim。
- [ ] v1 新建成功后 confirm active，Cloudflare / route / `SITES.put` 失败时 best-effort release pending；更新已有站点失败不得 release 原 claim。
- [ ] v2 create 把 claim、site、route、member 放入同一个 D1 batch / transaction。
- [ ] staging migration + 回填 + v1/v2 新建互斥测试通过。
- [ ] production migration + 回填前确认使用 production KV/D1；dry-run 后 blocking 冲突数量为 0，`slugCoexistence` 已按预期存量共存人工复核；再用 `apply=true` 写入 D1。

### PR 2 + PR 3 一次部署 checklist

- [ ] v1 delete 只解绑精确 `${hostname}/*`，并校验 route 当前绑定 script 等于预期 v1 per-site `scriptName`。
- [ ] v1 delete 删除 script/KV、release claim 进入 reuse hold。
- [ ] v2 delete 或管理删除路径回收 `site_routes`、写 `deleted_at`、release claim。
- [ ] reuse hold 时长写入代码、测试和用户提示。
- [ ] staging 跑通 delete -> reuse hold 拒绝 -> reuse hold 后复用。
- [ ] production route unbind 拒删 wildcard / 平台保留 Worker / router route，不影响 v2 wildcard。
- [ ] router/auth/CLI 支持 v2 workers host，但 CLI 不允许把 v2 API 指向 v1 `api.workers.xd.team`。
- [ ] staging wrangler route 增 `*-staging.workers.xd.team/*`。
- [ ] production wrangler route 增 `*.workers.xd.team/*`，保留 `*.pages.xd.team/*`。
- [ ] renderer 校验 production / staging workers route 不串环境。
- [ ] 默认新站点 hostname 切到 workers suffix。
- [ ] 存量 v2 站点 deploy / rollback / policy update 沿用原 `site_routes.hostname`。
- [ ] docs / skill / README / CLI help / OpenAPI 开发合约同步。
- [ ] 手动运行 `Hostname Claims Conflict Check` dry-run，artifact 中 v1/v2 输入脱敏、`summary.json` blocking 冲突数为 0，且 `slugCoexistence` 只包含预期存量共存。
- [ ] production D1 已通过 `Hostname Claims Conflict Check` 的 `apply=true` 写入初始 `hostname_claims`。
- [ ] production v1 `Deploy Production` 使用 `HOSTNAME_CLAIMS_MODE=enforce` 生成并部署 `pages-manager`，Wrangler 日志中可见 `env.HOSTNAME_CLAIMS_MODE ("enforce")`。
- [ ] staging 实测 exact route 优先于 wildcard、partial zone wildcard 可用、auth/cookie 正常、ACL fail-closed。
- [ ] production 冒烟新 v2 workers 站点、存量 v1 workers 站点、存量 v2 pages 站点，以及存量 v2 pages 站点重新部署后仍保留老域名。

## PR 切分建议

推荐保留 3 份 PR 便于 review：PR 1 先建立账本和创建路径保护，PR 2 + PR 3 可以一起完成并在同一个 production 手动部署窗口上线。即使一次部署，也必须保留代码里的 `record_only` / `enforce` 开关、reuse hold、精确 route unbind 保护和 conflict-check workflow 门禁，确保 migration / 回填 / claim enforcement / route cutover 可以异常即停。
