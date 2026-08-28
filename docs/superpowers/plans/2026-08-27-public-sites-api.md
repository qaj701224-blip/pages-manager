# Public Sites API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> 对应设计：`docs/superpowers/specs/2026-08-27-public-sites-api-design.md`

**Goal:** 为 Cindy `xd-sites` 插件交付认证的 `GET /.xd-pages/api/public/sites`，稳定返回当前用户拥有或可访问的 active 站点最小投影。

**Architecture:** 新的 Public transport 负责严格 query/cursor、既有 Bearer 认证、目录专用 actor 授权、best-effort 部门 hydration 和最小响应投影。新的 Store repository 用单条 D1 CTE 查询 active/latest-route 站点并在 SQL 中完成 owner、有效团队、internal/org、email/department ACL 访问判断；分页使用 `effective_updated_at DESC, id DESC` keyset。Console directory 与 `/sites` 管理对象均不复用，避免 transport 边界和敏感字段串线。

**Tech Stack:** Cloudflare Workers、D1/SQLite、JavaScript ESM、Node.js `node:test`、OpenAPI 3.1 source contract。

---

## 文件结构

- Create: `apps/pages-api/src/transport/public/public-sites-handler.js` — HTTP method/query、cursor、认证、hydration、响应投影与错误映射。
- Create: `apps/pages-api/src/infrastructure/store/repositories/public-sites-repository.js` — 单 SQL 可访问目录查询与 keyset。
- Create: `apps/pages-api/src/infrastructure/store/row-mappers/public-sites.js` — D1 row 到安全内部 Public Site record 的纯映射。
- Create: `apps/pages-api/src/public-sites.test.js` — 真实 SQLite-backed D1、Bearer、router、投影、过滤与分页集成测试。
- Modify: `apps/pages-api/src/domain/sites/authorization.js` / `.test.js` — Public Sites actor capability。
- Modify: `apps/pages-api/src/infrastructure/store/create-store.js`、`store-support.js` — 注册 repository 与 mapper。
- Modify: `apps/pages-api/test-support/pages-store-fixture.js` — 仅增加 latest-route/时间边界所需的窄测试 helper。
- Modify: `apps/pages-api/src/transport/router.js` / `router.test.js` / `index.test.js` — 只分发精确 Public Sites 路径。
- Modify: `apps/pages-api/src/connection-auth.test.js` — Cindy connection assertion 端到端调用。
- Modify: `apps/pages-api/src/openapi.js` / `openapi.test.js` — 稳定 schema、query、响应和错误码。
- Modify: `docs/api-boundary.md`、`docs/architecture/xd-cell-console.md` 与对应文档测试 — 记录 Cindy/Public/Console 边界。

### Task 1：锁定 actor 授权与严格 cursor 合约

**Files:**

- Modify: `apps/pages-api/src/domain/sites/authorization.test.js`
- Modify: `apps/pages-api/src/domain/sites/authorization.js`
- Create: `apps/pages-api/src/transport/public/public-sites-handler.js`
- Create: `apps/pages-api/src/transport/public/public-sites-handler.test.js`

- [ ] **Step 1: 写 actor matrix 失败测试**

在 `authorization.test.js` 增加表驱动断言：CLI user、Cindy-like personal access key、unscoped personal `read:site`/`*` 为 `true`；deploy-only、team owner、site-scoped、无 userId、未知 actor 为 `false`。

```js
assert.equal(
  actorCanReadPublicSites({
    type: 'access_key',
    userId: 'usr_1',
    ownerType: 'user',
    siteId: null,
    scopes: ['read:site'],
    source: 'cindy_connection',
  }),
  true
);
```

- [ ] **Step 2: 运行授权测试并确认先失败**

Run: `node --test apps/pages-api/src/domain/sites/authorization.test.js`

Expected: FAIL，提示 `actorCanReadPublicSites` 尚未导出。

- [ ] **Step 3: 实现目录专用授权函数**

```js
export function actorCanReadPublicSites(actor) {
  if (!actor || typeof actor.userId !== 'string' || !actor.userId.trim()) return false;
  if (actor.type !== 'access_key') return true;
  if ((actor.ownerType || 'user') === 'team' || actor.siteId) return false;
  const scopes = Array.isArray(actor.scopes) ? actor.scopes : [];
  return scopes.includes('read:site') || scopes.includes('*');
}
```

- [ ] **Step 4: 写 query/cursor 失败测试**

测试通过 handler 导出的纯 helper 锁定：默认/边界 limit、未知与重复参数、空/超长/非 base64url cursor、wrong version/scope/environment、非 canonical ISO、非法 site id，以及 `local` encode/decode 往返。

```js
const cursor = encodePublicSitesCursor({
  environment: 'local',
  updatedAt: '2026-08-27T01:02:03.000Z',
  id: 'site_local_1',
});
assert.deepEqual(decodePublicSitesCursor(cursor, 'local'), {
  updatedAt: '2026-08-27T01:02:03.000Z',
  id: 'site_local_1',
});
```

- [ ] **Step 5: 实现 Worker-compatible query/cursor helper**

实现 `parsePublicSitesQuery(url, environment)`、`encodePublicSitesCursor()`、`decodePublicSitesCursor()`：仅使用 `TextEncoder`、fatal `TextDecoder`、`btoa`、`atob`；cursor encoded length 最大 2048，payload 精确包含 `v/scope/environment/updatedAt/id`。

- [ ] **Step 6: 运行纯测试并提交**

Run: `node --test apps/pages-api/src/domain/sites/authorization.test.js apps/pages-api/src/transport/public/public-sites-handler.test.js`

Expected: PASS。

```bash
git add apps/pages-api/src/domain/sites/authorization.js apps/pages-api/src/domain/sites/authorization.test.js \
  apps/pages-api/src/transport/public/public-sites-handler.js \
  apps/pages-api/src/transport/public/public-sites-handler.test.js
git commit -m "feat(pages-api): 定义 Public Sites 授权与游标合约"
```

### Task 2：实现 fail-closed 的单 SQL Public Sites 查询

**Files:**

- Create: `apps/pages-api/src/infrastructure/store/row-mappers/public-sites.js`
- Create: `apps/pages-api/src/infrastructure/store/repositories/public-sites-repository.js`
- Modify: `apps/pages-api/src/infrastructure/store/store-support.js`
- Modify: `apps/pages-api/src/infrastructure/store/create-store.js`
- Modify: `apps/pages-api/test-support/pages-store-fixture.js`
- Modify: `apps/pages-api/src/public-sites.test.js`

- [ ] **Step 1: 写真实 D1 结果集失败测试**

用 `createTestPagesStore()`、`createSite()`、`createSiteVersion()`、`activateSiteVersion()` 种植以下站点并直接调用 `listPublicSitesForUser()`：个人 Owner、有效团队 member、internal、org、email ACL、fresh department ACL 均返回且去重；ACL miss、removed member、inactive/deleted/cross-env team、disabled/未知 visibility、team-owned owner、latest disabled route、dangling/null version、deleted site、其它环境均排除。

同时断言 `departmentAclEnabled: false` 时即使 `users.department_path` 有旧值也不命中，`true` 才命中。

- [ ] **Step 2: 写 keyset 与投影失败测试**

种植相同 effective timestamp 的多个 ID，以及 route timestamp 晚于 site timestamp 的记录；断言排序为 `updatedAt DESC, id DESC`、Store 返回 `limit + 1`、cursor 后一页无重复/遗漏，且内部 record 只有：

```js
{
  id,
  title,
  slug,
  slugRevision,
  slugRoutingSyncedRevision,
  environment,
  ownerType,
  hostname,
  visibility,
  createdAt,
  updatedAt,
}
```

- [ ] **Step 3: 运行 Store 集成测试并确认先失败**

Run: `node --test apps/pages-api/src/public-sites.test.js`

Expected: FAIL，提示 Store 方法尚不存在。

- [ ] **Step 4: 实现最小 row mapper 并注册 repository**

```js
export function mapPublicSite(row) {
  return {
    id: row.id,
    title: row.title || null,
    slug: row.slug,
    slugRevision: Number(row.slug_revision),
    slugRoutingSyncedRevision: Number(row.slug_routing_synced_revision),
    environment: row.environment,
    ownerType: row.owner_type,
    hostname: row.route_hostname,
    visibility: row.route_visibility,
    createdAt: row.created_at,
    updatedAt: row.effective_updated_at,
  };
}
```

在 `create-store.js` 的 `storeMethodCollections` 注册 `publicSitesRepositoryMethods`。

- [ ] **Step 5: 实现 CTE 查询**

`listPublicSitesForUser({ environment, viewerUserId, limit = 50, cursor = null, departmentAclEnabled = false })` 在 Store 内限制 `limit` 到 `1..100`，绑定 `limit + 1`。CTE 必须包含：

```sql
JOIN site_routes AS route ON route.id = (
  SELECT latest.id FROM site_routes AS latest
  WHERE latest.site_id = sites.id AND latest.environment = sites.environment
  ORDER BY latest.updated_at DESC, latest.id DESC LIMIT 1
)
JOIN site_versions AS active_version
  ON active_version.id = route.active_version_id
 AND active_version.site_id = sites.id
```

基础 WHERE 必须要求当前环境、site 未删除、latest route active、visibility allowlist、有效 owner type，并让所有 team-owned site 都要求同环境 active 未删除 team。可访问 OR 使用 personal owner、internal/org、有效 team member、email ACL、由 `departmentAclEnabled` 门控的 department ACL；全部用 `EXISTS`，不使用 `LIKE`，不选择 ACL subject 或 owner identity。

cursor 存在时才追加固定片段：

```sql
WHERE effective_updated_at < ?
   OR (effective_updated_at = ? AND id < ?)
ORDER BY effective_updated_at DESC, id DESC
LIMIT ?
```

- [ ] **Step 6: 增加窄 test fixture helper**

`updateTestSite()` 增加 `updatedAt` 列映射；新增 `insertTestRoute()`，只用于构造同站点的更新 route，参数全部显式绑定，不向生产代码暴露 raw database。

- [ ] **Step 7: 运行 Store/contract 测试并提交**

Run: `node --test apps/pages-api/src/public-sites.test.js apps/pages-api/src/store-contract.test.js`

Expected: PASS。

```bash
git add apps/pages-api/src/infrastructure/store apps/pages-api/test-support/pages-store-fixture.js \
  apps/pages-api/src/public-sites.test.js
git commit -m "feat(pages-api): 查询用户可访问的 active 站点"
```

### Task 3：接通 Public handler、router、hydration 与稳定响应

**Files:**

- Modify: `apps/pages-api/src/transport/public/public-sites-handler.js`
- Modify: `apps/pages-api/src/public-sites.test.js`
- Modify: `apps/pages-api/src/transport/router.js`
- Modify: `apps/pages-api/src/transport/router.test.js`
- Modify: `apps/pages-api/src/index.test.js`

- [ ] **Step 1: 写 HTTP 授权和响应失败测试**

覆盖：无认证 401；CLI user、Cindy-compatible个人 read key、个人 `*` key 200；deploy-only、team key、site-scoped key 403 且 hydration/目录查询未调用；非 GET 405；未知/重复 query 400；repository 异常 503；精确字段与 `Cache-Control: no-store`。

成功响应精确为：

```js
{
  sites: [{
    id: 'site_1',
    title: null,
    displayName: 'docs',
    slug: 'docs',
    environment: 'production',
    routingStatus: 'ready',
    hostname: 'docs.workers.xd.team',
    url: 'https://docs.workers.xd.team',
    owner: { type: 'user' },
    visibility: 'org',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-27T00:00:00.000Z',
  }],
  pagination: { nextCursor: null },
}
```

并否定 `route`、owner id/email、team id、ACL、activeVersion、runtime/provider/dispatch/generation/cache/token/deletedAt。

- [ ] **Step 2: 写 hydration stale-path 失败测试**

覆盖 fresh department path 启用 ACL；stale path hydration 成功后重读并启用；hydration unavailable、返回失败状态或抛异常时传 `departmentAclEnabled: false`，仍返回其它 internal/org 项但不返回 department ACL 项。

- [ ] **Step 3: 实现 handler 顺序与错误映射**

顺序固定为 method/query → `authenticateApiRequest()` → `actorCanReadPublicSites()` → 权威 user/hydration → Store → mapper/cursor。授权通过后只在 `user.email && user.departmentPath && !shouldHydrateUserDepartment(user, env)` 时启用 department ACL。

Store/权威 user 读取异常返回：

```js
jsonError(
  'PUBLIC_SITES_UNAVAILABLE',
  'Public sites are temporarily unavailable.',
  503,
  'Retry shortly.'
)
```

- [ ] **Step 4: 精确注册 router**

```js
if (url.pathname === '/.xd-pages/api/public/sites') {
  const store = readStore(context);
  if (!store) return storeUnavailableResponse();
  return handlePublicSitesApi(request, env, config, store);
}
```

不要使用 `/public` 的 `startsWith`。测试 `/public/sites-extra`、`/public/sites/extra`、`/public/anything` 都是 404 且不进入 Public handler；Console BFF headers 不能代替 Bearer。

- [ ] **Step 5: 运行 transport/integration 测试并提交**

Run:

```bash
node --test \
  apps/pages-api/src/public-sites.test.js \
  apps/pages-api/src/transport/public/public-sites-handler.test.js \
  apps/pages-api/src/transport/router.test.js \
  apps/pages-api/src/index.test.js
```

Expected: PASS。

```bash
git add apps/pages-api/src/transport apps/pages-api/src/public-sites.test.js apps/pages-api/src/index.test.js
git commit -m "feat(pages-api): 暴露认证的 Public Sites API"
```

### Task 4：同步 Cindy、OpenAPI 与边界文档

**Files:**

- Modify: `apps/pages-api/src/connection-auth.test.js`
- Modify: `apps/pages-api/src/openapi.js`
- Modify: `apps/pages-api/src/openapi.test.js`
- Modify: `docs/api-boundary.md`
- Modify: `docs/architecture/xd-cell-console.md`
- Modify: `scripts/public-docs.test.js`
- Modify: `scripts/pages-v2-docs.test.js`

- [ ] **Step 1: 写 Cindy assertion 端到端失败测试**

复用 `connection-auth.test.js` 的 `signAssertion()`、JWKS cache 和 `connectionEnv()`，种植 active staging site 后请求 `/.xd-pages/api/public/sites`，断言 200、按断言映射的 user 查询且不依赖 assertion 的额外 role/department claim。

- [ ] **Step 2: 写 OpenAPI 失败测试**

锁定 `PublicSiteOwner`、`PublicSite`、`PublicSitesPagination`、`PublicSitesResponse` 均 `additionalProperties: false`；Public Site required 精确包含 12 个字段，visibility 不含 disabled，environment 含 production/staging/local。锁定 limit/cursor 约束、200 `$ref`、400/401/403/405/500/503 和 `x-error-codes`。

- [ ] **Step 3: 实现 OpenAPI schema/path**

`GET /.xd-pages/api/public/sites` 描述必须说明 endpoint 需要认证、`public` 不是匿名/网络 exposure、固定当前环境、允许 Cindy/CLI/personal read key、拒绝 deploy-only/team/site-scoped key。200 引用 `#/components/schemas/PublicSitesResponse`。

- [ ] **Step 4: 更新文档而不扩展 CLI/skill**

`docs/api-boundary.md` 增加领域说明而不改造成 endpoint reference；`xd-cell-console.md` 明确 Console directory 与 Cindy Public Sites 的不同认证/响应边界。文档不得出现真实 token、owner identity、ACL subject 或 provider resource id；README、CLI、pages-skill、生成的 public docs 保持不变。

- [ ] **Step 5: 运行合约与文档测试并提交**

Run:

```bash
node --test \
  apps/pages-api/src/connection-auth.test.js \
  apps/pages-api/src/openapi.test.js \
  scripts/public-docs.test.js \
  scripts/pages-v2-docs.test.js \
  tests/pages-api-architecture.test.js
```

Expected: PASS。

```bash
git add apps/pages-api/src/connection-auth.test.js apps/pages-api/src/openapi.js \
  apps/pages-api/src/openapi.test.js docs/api-boundary.md docs/architecture/xd-cell-console.md \
  scripts/public-docs.test.js scripts/pages-v2-docs.test.js
git commit -m "docs(pages-api): 固化 Cindy Public Sites 合约"
```

### Task 5：完整验证与完成审计

- [ ] **Step 1: 安装锁定依赖（仅在 workspace links 缺失时）**

Run: `pnpm install --frozen-lockfile`

Expected: exit 0，`pnpm-lock.yaml` 无 diff。

- [ ] **Step 2: 运行 focused 测试**

```bash
node --test \
  apps/pages-api/src/public-sites.test.js \
  apps/pages-api/src/transport/public/public-sites-handler.test.js \
  apps/pages-api/src/domain/sites/authorization.test.js \
  apps/pages-api/src/connection-auth.test.js \
  apps/pages-api/src/openapi.test.js \
  apps/pages-api/src/transport/router.test.js \
  apps/pages-api/src/index.test.js \
  apps/pages-api/src/store-contract.test.js \
  scripts/public-docs.test.js \
  scripts/pages-v2-docs.test.js \
  tests/pages-api-architecture.test.js
```

Expected: 全部 PASS。

- [ ] **Step 3: 运行仓库级验证**

Run: `pnpm lint`

Expected: exit 0。

Run: `pnpm test`

Expected: exit 0。

- [ ] **Step 4: 做完成审计**

Run: `git diff --check && git status --short`

逐项核对：精确路由、认证矩阵、active/有效团队/ACL fail-closed、stale department 门控、最小字段、effective timestamp/keyset、Cindy、OpenAPI、文档、无 CLI/skill 漂移、无 secret/provider ID。任何未由测试或源码直接证明的项目都视为未完成并继续修复。
