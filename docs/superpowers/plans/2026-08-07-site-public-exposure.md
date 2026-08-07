# 站点公网 Exposure 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不改变现有 CLI、用户 API 请求/响应和 v1 legacy 行为的前提下，为 XD Cell v2 增加 Admin-only 的站点公网 exposure，并保证 Router、Runtime Gateway、WFP Worker binding、迁移和失败补偿保持 fail-closed。

**Architecture:** 使用与现有 visibility 正交的 `exposure` + `accessMode` policy。普通用户继续提交 visibility，兼容层将 `internal` 映射为 `anonymous`；Admin 独立修改 exposure。D1 保存 authority policy，KV route snapshot/pointer 表示 Router-effective policy；Admin、deploy/rollback、runtime binding sync 和 pointer repair 通过站点级 commit lease 串行化，最终用完整 route tuple CAS。

**Tech Stack:** Cloudflare Workers、D1 SQLite migrations、KV immutable route snapshots、Cloudflare Workers for Platforms、Node `node:test`、React Console、现有 OpenAPI/CLI 文档和 GitHub Actions staging/production workflows。

---

## 范围检查与文件边界

这是一个跨 schema、API、Router、WFP 和 Console 的单一访问策略功能；这些部分共享同一个 `SiteAccessPolicy` 和 `policyVersion` 提交流程，拆成彼此独立的计划会丢失并发和 fail-closed 约束。因此保留为一个分阶段、每阶段可测试的实现计划。

实现时遵循以下文件边界：

- 共享策略语义：新增 `packages/pages-access-policy/`，避免 pages-api 与 pages-router 各自维护 enum/映射。
- 数据和提交协调：`apps/pages-api/src/schema.js`、`migrations/0019_site_access_policy.sql`、`store.js`、`test-store.js`。
- Snapshot 与 API 投影：`route-snapshot.js`、`sites.js`、`console.js`、`admin.js`、`openapi.js`。
- Router：`apps/pages-router/src/index.js`、`access-policy.js`，只读取 snapshot，不新增 D1 binding。
- WFP/部署：`packages/wfp-client/src/index.js`、`apps/pages-api/src/wfp-provider.js`、`deployments.js`、runtime config sync。
- Console UI：`apps/pages-console/src/ui/api.js`、`AdminSites.jsx`、`SiteDetail.jsx`、对应 model/test/style 文件。
- 文档和发布：`docs/security/`、`docs/architecture/`、`docs/operations/`、`docs/api-boundary.md`、CLI help/README、`.github/workflows/` 与对应脚本测试。

## 任务执行约定

- 每个任务先写 focused failing test，再写最小实现；任务完成后单独提交。
- 不修改 `apps/server` v1 链路。
- 不新增 CLI `--public`/`--exposure` flag；普通用户 handler 对显式 `exposure` 字段统一返回 `SITE_EXPOSURE_ADMIN_REQUIRED`，合法旧请求保持原样。
- 不新增版本级 `XD_OFFICE_NET` capability 记录；Admin/deploy/rollback 通过受控 WFP settings 读取、移除和现场验证。

### Task 1: 建立共享 Access Policy 合约

**Files:**

- Create: `packages/pages-access-policy/package.json`
- Create: `packages/pages-access-policy/src/index.js`
- Test: `packages/pages-access-policy/src/index.test.js`
- Modify: `apps/pages-api/package.json`
- Modify: `apps/pages-router/package.json`

- [ ] **Step 1: 写失败测试，锁定 enum、兼容映射和 fail-closed 归一化**

```js
test('maps legacy visibility to canonical access mode', () => {
  assert.equal(accessModeFromVisibility('internal'), 'anonymous');
  assert.equal(accessModeFromVisibility('org'), 'org');
  assert.equal(accessModeFromVisibility('acl'), 'acl');
  assert.equal(accessModeFromVisibility('owner'), 'owner');
  assert.equal(accessModeFromVisibility('disabled'), 'disabled');
});

test('unknown visibility never maps to anonymous or org implicitly', () => {
  assert.equal(accessModeFromVisibility('public'), null);
  assert.equal(accessModeFromVisibility(''), null);
  assert.equal(accessModeFromVisibility(null), null);
});

test('snapshot policy only allows public exposure explicitly', () => {
  assert.deepEqual(normalizeExposure(undefined), 'internal');
  assert.deepEqual(normalizeExposure('invalid'), 'internal');
  assert.deepEqual(normalizeSnapshotPolicy({ exposure: 'public', accessMode: 'org' }), {
    exposure: 'public',
    accessMode: 'org',
  });
});
```

- [ ] **Step 2: 运行测试确认共享包尚不存在**

Run: `node --test packages/pages-access-policy/src/index.test.js`

Expected: FAIL because the package and exported functions do not exist.

- [ ] **Step 3: 写最小共享实现**

```js
export const EXPOSURES = Object.freeze(['internal', 'public']);
export const ACCESS_MODES = Object.freeze(['anonymous', 'org', 'acl', 'owner', 'disabled']);
export const LEGACY_VISIBILITIES = Object.freeze(['internal', 'org', 'acl', 'owner', 'disabled']);

const ACCESS_MODE_SET = new Set(ACCESS_MODES);

export function accessModeFromVisibility(value) {
  if (value === 'internal') return 'anonymous';
  if (value === 'org' || value === 'acl' || value === 'owner' || value === 'disabled') return value;
  return null;
}

export function visibilityFromAccessMode(value) {
  if (value === 'anonymous') return 'internal';
  return ACCESS_MODE_SET.has(value) ? value : null;
}

export function normalizeExposure(value) {
  return value === 'public' ? 'public' : 'internal';
}

export function isValidAccessMode(value) {
  return ACCESS_MODE_SET.has(value);
}

export function normalizeSnapshotPolicy({ exposure, accessMode } = {}) {
  return { exposure: normalizeExposure(exposure), accessMode: isValidAccessMode(accessMode) ? accessMode : null };
}
```

- [ ] **Step 4: 添加 workspace 依赖并运行共享包测试**

在两个 app 的 `dependencies` 中加入 `"@xd/pages-access-policy": "workspace:*"`，然后运行：

```bash
pnpm install
node --test packages/pages-access-policy/src/index.test.js
```

Expected: 所有共享 policy tests PASS；不得改变现有包的 export。

- [ ] **Step 5: Commit**

```bash
git add packages/pages-access-policy apps/pages-api/package.json apps/pages-router/package.json pnpm-lock.yaml
git commit -m "feat: 增加站点访问策略共享合约"
```

### Task 2: D1 additive migration 与兼容期读写

**Files:**

- Create: `apps/pages-api/migrations/0019_site_access_policy.sql`
- Modify: `apps/pages-api/src/schema.js`
- Modify: `apps/pages-api/src/store.js`
- Modify: `apps/pages-api/src/test-store.js`
- Test: `apps/pages-api/src/store-contract.test.js`
- Test: `apps/pages-api/src/store.test.js`

- [ ] **Step 1: 先写 migration/backfill 和旧 binary 兼容测试**

覆盖以下输入和结果：

```js
assert.equal(row.default_exposure, 'internal');
assert.equal(row.default_access_mode, 'anonymous'); // legacy internal
assert.equal(route.exposure, 'internal');
assert.equal(route.access_mode, 'org'); // legacy org
assert.equal(normalizeLegacyRoute({ visibility: 'public' }).accessMode, null);
```

测试还要插入一个 accessMode 为 null、visibility 为 `org` 的 compatibility row，验证新 reader 从 visibility 派生并返回 `org`；插入未知 visibility 后验证不会生成可 public 的 snapshot。

- [ ] **Step 2: 运行 focused store 测试确认新字段不存在**

Run: `node --test apps/pages-api/src/store-contract.test.js apps/pages-api/src/store.test.js`

Expected: 新增 migration/字段断言 FAIL，现有 visibility contract tests 保持 PASS。

- [ ] **Step 3: 写 `0019` migration 和 schema source-of-truth**

在 `sites`、`site_routes` 增加：

```sql
ALTER TABLE sites ADD COLUMN default_exposure TEXT NOT NULL DEFAULT 'internal';
ALTER TABLE sites ADD COLUMN default_access_mode TEXT;
ALTER TABLE site_routes ADD COLUMN exposure TEXT NOT NULL DEFAULT 'internal';
ALTER TABLE site_routes ADD COLUMN access_mode TEXT;

UPDATE sites
SET default_access_mode = CASE default_visibility
  WHEN 'internal' THEN 'anonymous'
  WHEN 'org' THEN 'org'
  WHEN 'acl' THEN 'acl'
  WHEN 'owner' THEN 'owner'
  WHEN 'disabled' THEN 'disabled'
  ELSE NULL
END;

UPDATE site_routes
SET access_mode = CASE visibility
  WHEN 'internal' THEN 'anonymous'
  WHEN 'org' THEN 'org'
  WHEN 'acl' THEN 'acl'
  WHEN 'owner' THEN 'owner'
  WHEN 'disabled' THEN 'disabled'
  ELSE NULL
END;
```

`schema.js` 的 create-schema 版本同步到 19，但不要在本次 migration 把旧 visibility 列 drop/rename；unknown visibility 保持 NULL accessMode 并由应用 fail closed。

- [ ] **Step 4: 实现 compatibility reader 和双写**

在 `store.js` 和 `test-store.js` 共用同一语义：兼容期读取时以 legacy visibility 派生 accessMode；新写路径同一 batch 更新 canonical fields 与 legacy projection。禁止任何 user mutation 用 exposure 输入覆盖当前 exposure。

```js
function readCompatibilityAccessMode(route) {
  const fromVisibility = accessModeFromVisibility(route.visibility);
  if (fromVisibility) return fromVisibility;
  return isValidAccessMode(route.accessMode) ? route.accessMode : null;
}
```

当 visibility 与 accessMode 不一致时记录安全诊断并按 visibility 派生；当 visibility 非法时不得创建 public snapshot。

- [ ] **Step 5: 写 migration/compatibility 回归测试并运行**

Run:

```bash
node --test apps/pages-api/src/store-contract.test.js apps/pages-api/src/store.test.js
```

Expected: migration backfill、旧 visibility-only insert/update、unknown fail-closed、双写和 TestStore/D1 一致性全部 PASS。

- [ ] **Step 6: Commit**

```bash
git add apps/pages-api/migrations/0019_site_access_policy.sql apps/pages-api/src/schema.js apps/pages-api/src/store.js apps/pages-api/src/test-store.js apps/pages-api/src/store-contract.test.js apps/pages-api/src/store.test.js
git commit -m "feat(pages-api): 增加站点 exposure policy 字段"
```

### Task 3: Site commit lease、统一 policy mutation 与 pointer repair

**Files:**

- Modify: `apps/pages-api/migrations/0019_site_access_policy.sql`
- Modify: `apps/pages-api/src/schema.js`
- Modify: `apps/pages-api/src/store.js`
- Modify: `apps/pages-api/src/test-store.js`
- Modify: `apps/pages-api/src/route-snapshot.js`
- Test: `apps/pages-api/src/store.test.js`
- Test: `apps/pages-api/src/route-snapshot.test.js`

- [ ] **Step 1: 写 lease/CAS/policy mutation 的失败测试**

测试必须覆盖：同一 `(environment, siteId)` 不能同时拿到两个 lease；租约续期后 fencing token 单调增加；丢锁后 CAS 失败；Admin 只改 exposure 保留 accessMode/ACL；user 只改 accessMode/ACL 保留 exposure；同值但 pointer 落后时执行 repair 而不 bump policyVersion。

```js
await assert.rejects(
  store.activateSitePolicy({ expectedPolicyVersion: oldVersion, leaseId: staleLease }),
  /SITE_POLICY_CONFLICT/
);
assert.equal(repaired.policyVersion, oldVersion);
assert.equal(repaired.pointerConfirmed, true);
```

- [ ] **Step 2: 增加 `site_policy_locks` 表和 Store/TestStore 对称 lease API**

在 `0019` 增加 `(environment, site_id)` 主键、`lock_id`、`fencing_token`、`expires_at`、`acquired_at`、`updated_at` 字段：

```sql
CREATE TABLE IF NOT EXISTS site_policy_locks (
  environment TEXT NOT NULL,
  site_id TEXT NOT NULL,
  lock_id TEXT NOT NULL,
  fencing_token INTEGER NOT NULL,
  acquired_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (environment, site_id)
);
```

实现以下接口并保持参数一致：

```js
withSiteCommitLock(environment, siteId, callback, options = {})
acquireSiteCommitLock(environment, siteId, options = {})
renewSiteCommitLock(environment, siteId, lockId, options = {})
releaseSiteCommitLock(environment, siteId, lockId)
```

lease 只覆盖最终 revalidation、D1 activation、snapshot/pointer 和补偿；上传在锁外完成。固定锁顺序为 `site commit lease -> runtime-config lock -> route pointer serializer`。

- [ ] **Step 3: 实现 `updateSiteAccessPolicy` 和 `repairRouteSnapshot`**

`updateSiteAccessPolicy` 接受：

```js
{
  environment,
  siteId,
  actorUserId,
  exposure,       // optional: Admin-only
  accessMode,     // optional: user/Admin preserve rule
  aclEntries,
  expected: { policyVersion, routeGeneration, activeVersionId, runtimeConfigGeneration },
  lease: { lockId, fencingToken },
  auditEvent
}
```

在一个 D1 batch 内完成 accessMode、ACL、exposure、legacy projection、updatedAt、cache tier、单次 policyVersion bump 和 `policy_committed/pending_activation` audit。SQL 条件必须包含完整 expected tuple 和 lease fencing token；同值 policy 不 bump。

`repairRouteSnapshot` 在 D1/pointer 值相同但 pointer 缺失或落后时重写同一 policyVersion；若 pointer tuple 更高，先用更高 policyVersion 提交安全 internal repair，禁止低版本覆盖。

- [ ] **Step 4: 扩展 route snapshot builder 为 v3**

`route-snapshot.js` 输出：

```js
{
  schemaVersion: 3,
  exposure: route.exposure === 'public' ? 'public' : 'internal',
  accessMode: readCompatibilityAccessMode(route),
  visibility: visibilityFromAccessMode(readCompatibilityAccessMode(route)),
  policyVersion: route.policyVersion,
  routeGeneration: route.routeGeneration,
  // existing route fields remain unchanged
}
```

若 accessMode 无法从合法 visibility/access_mode 得到，返回策略错误，不生成可绕过 IP 的 snapshot。

- [ ] **Step 5: 运行 Store/Snapshot focused tests并提交**

```bash
node --test apps/pages-api/src/store.test.js apps/pages-api/src/route-snapshot.test.js apps/pages-api/src/store-contract.test.js
git add apps/pages-api/migrations/0019_site_access_policy.sql apps/pages-api/src/schema.js apps/pages-api/src/store.js apps/pages-api/src/test-store.js apps/pages-api/src/route-snapshot.js apps/pages-api/src/store.test.js apps/pages-api/src/route-snapshot.test.js
git commit -m "feat(pages-api): 增加站点策略租约与统一提交"
```

### Task 4: Pages API 用户兼容路径与 Admin exposure API

**Files:**

- Modify: `apps/pages-api/src/sites.js`
- Modify: `apps/pages-api/src/console.js`
- Modify: `apps/pages-api/src/admin.js`
- Modify: `apps/pages-api/src/openapi.js`
- Test: `apps/pages-api/src/sites.test.js`
- Test: `apps/pages-api/src/console.test.js`
- Test: `apps/pages-api/src/admin.test.js`
- Test: `apps/pages-api/src/openapi.test.js`

- [ ] **Step 1: 先写 API 兼容和权限失败测试**

覆盖：现有 visibility 请求/响应完全不变；普通 user/console 请求显式带 exposure 返回 `SITE_EXPOSURE_ADMIN_REQUIRED`；Admin 非法 exposure、缺 reason、非 platform admin、无 active route 和同值幂等都有明确错误/响应。

```js
const response = await requestUserApi('/sites/site_1', {
  method: 'PATCH',
  body: { visibility: 'internal', exposure: 'public' },
});
assert.equal(response.status, 403);
assert.equal((await response.json()).error.code, 'SITE_EXPOSURE_ADMIN_REQUIRED');
```

- [ ] **Step 2: 修改用户 visibility/ACL handlers 只提交 accessMode/ACL**

`sites.js`、`console.js`、`deployments.js`、`admin.js` 中所有用户可达路径统一调用 `updateSiteAccessPolicy` 的 preserve-exposure 分支；响应继续由 `visibilityFromAccessMode` 序列化 `defaultVisibility`/`route.visibility`。不新增 CLI flag 和用户 API 字段。

- [ ] **Step 3: 增加 Admin-only exposure endpoint**

在 Console BFF/admin 路由注册：

```http
PATCH /.xd-pages/api/console/admin/sites/{siteId}/exposure
{
  "exposure": "public|internal",
  "reason": "required only when enabling public"
}
```

开启流程必须是 `attempted audit -> site lease -> active Worker OfficeNet remove/verify -> D1 CAS policy commit -> v3 snapshot/pointer -> exact pointer read-back -> effective_success`。关闭流程保留 accessMode/ACL；pointer 未确认时返回 partial failure，不宣称关闭成功。

- [ ] **Step 4: 增加 durable stage audit 和错误码**

使用现有 `audit_events.trace_id` 作为 operationId；stage event id 采用 `operationId:stage`，使内部 retry 幂等。补充 `SITE_EXPOSURE_INVALID`、`SITE_EXPOSURE_REASON_REQUIRED`、`SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED`、`SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED`、`ROUTE_POLICY_REPAIR_REQUIRED` 等错误映射。metadata 只记录 policy/version/effective 状态，不泄露 Worker settings、资源 ID 或 token。

- [ ] **Step 5: 增加 Admin list 的服务端 exposure filter 和分页**

修改 `admin.js` 与 `store.js` 的 `listAdminSites`，读取 `exposure=public|internal`、稳定 limit 和 cursor；查询条件必须仍包含 environment 与 `deleted_at IS NULL`，排序使用 `updated_at DESC, id DESC`，响应继续是 `{ sites }` 并新增非敏感 exposure/effective state 投影。对非法 filter 返回 400，不把过滤退回前端最多 200 条内存列表。

```js
const query = new URL(request.url).searchParams.get('exposure');
if (query !== null && query !== 'public' && query !== 'internal') {
  return jsonError('SITE_EXPOSURE_INVALID', 'Site exposure filter is invalid.', 400);
}
```

- [ ] **Step 6: 更新 OpenAPI 开发期合约并运行 API tests**

```bash
node --test apps/pages-api/src/sites.test.js apps/pages-api/src/console.test.js apps/pages-api/src/admin.test.js apps/pages-api/src/openapi.test.js
```

Expected: 旧 visibility contract PASS；Admin exposure 和 audit stage tests PASS；`openapi.js` 只描述新增 Admin endpoint，不把 exposure 加入 CLI-managed user API。

- [ ] **Step 7: Commit**

```bash
git add apps/pages-api/src/sites.js apps/pages-api/src/console.js apps/pages-api/src/admin.js apps/pages-api/src/store.js apps/pages-api/src/openapi.js apps/pages-api/src/sites.test.js apps/pages-api/src/console.test.js apps/pages-api/src/admin.test.js apps/pages-api/src/store.test.js apps/pages-api/src/openapi.test.js
git commit -m "feat(pages-api): 增加 Admin exposure 管理接口"
```

### Task 5: Route Snapshot v3 与 Router fail-closed 请求顺序

**Files:**

- Modify: `apps/pages-router/src/index.js`
- Modify: `apps/pages-router/src/access-policy.js`
- Test: `apps/pages-router/src/index.test.js`
- Test: `apps/pages-router/src/access-policy.test.js`
- Test: `apps/pages-api/src/route-snapshot.test.js`

- [ ] **Step 1: 写新请求顺序测试**

覆盖：v2 只允许 internal exposure；v3 explicit public 可在无 IP 时继续；internal/缺失/非法 exposure 仍执行 IP；未知 schema、非法 accessMode、visibility/accessMode 不一致 fail closed；route/snapshot 损坏时不暴露具体内部配置。

```js
assert.equal(await requestWithoutIp(publicV3Route), 200);
assert.equal(await requestWithoutIp(internalV3Route), 403);
assert.equal(lookupCount, 1); // new router reads trusted snapshot before deciding IP
assert.equal(dispatchCount, 0); // fail-closed policy never dispatches
```

- [ ] **Step 2: 将 IP 判断移动到可信 snapshot 读取之后**

保持 environment/hostname validation 在前；然后调用现有 `readUsableRoute`，只在 `schemaVersion === 3 && exposure === 'public'` 时跳过 `enforceIPAllowlist`。缺失/非法 exposure 归一化为 internal；v2 固定 internal；非法 accessMode 或 projection mismatch 不 dispatch。

- [ ] **Step 3: 更新 access-policy 为 accessMode 语义**

```js
if (route.accessMode === 'disabled') return denied('SITE_DISABLED');
if (route.accessMode === 'anonymous') return allowedAnonymous();
if (!PROTECTED_ACCESS_MODES.has(route.accessMode)) return denied('SITE_POLICY_INVALID');
// existing session freshness, employee status, owner and ACL checks follow
```

anonymous 请求携带过期/不匹配 session 时降级 anonymous，不向 User Worker 注入 stale user identity；protected mode 继续要求有效 fresh session。

- [ ] **Step 4: 保持 auth callback 使用同一 policy evaluation**

普通请求和 `/.xd-pages/auth/callback` 都使用 normalized route policy；public+org/acl/owner 仍跳 SSO，public+disabled 仍拒绝，public+anonymous 不要求 session。

- [ ] **Step 5: 运行 Router tests 并提交**

```bash
node --test apps/pages-router/src/access-policy.test.js apps/pages-router/src/index.test.js
git add apps/pages-router/src/index.js apps/pages-router/src/access-policy.js apps/pages-router/src/index.test.js apps/pages-router/src/access-policy.test.js apps/pages-api/src/route-snapshot.test.js
git commit -m "feat(pages-router): 按 exposure 与 accessMode 执行访问控制"
```

### Task 6: Public Runtime Gateway 同源防护

**Files:**

- Modify: `apps/pages-router/src/index.js`
- Modify: `apps/pages-router/src/index.test.js`
- Test: `apps/pages-router/src/index.test.js`

- [ ] **Step 1: 写 runtime request validation tests**

对 public route 逐项断言拒绝：非 POST、非 JSON、缺 `X-XD-Pages-Runtime: 1`、缺 Origin、`Origin: null`、兄弟子域、其它 origin、OPTIONS、错误 Fetch Metadata。断言同源 JSON POST、Worker SDK service binding 和纯 API Worker 业务路由不受影响。

```js
assert.equal(await runtimeRequest({ origin: undefined }).then((r) => r.status), 403);
assert.equal(await runtimeRequest({ origin: 'https://site.workers.xd.team' }).then((r) => r.status), 200);
assert.equal(await runtimeRequest({ origin: 'https://other.workers.xd.team' }).then((r) => r.status), 403);
```

- [ ] **Step 2: 实现 platform runtime validator**

只对 Router 截获的 `/.xd-pages/runtime/*` 路径执行：POST、`application/json`（允许 charset）、精确 runtime header、normalized same-origin、可选 Fetch Metadata (`same-origin`, `cors`, `empty`)；不支持 OPTIONS，不添加 CORS allow headers。Origin 校验使用当前 hostname/scheme，不接受 `null`。

- [ ] **Step 3: 收紧 user-scope runtime capability**

在无有效 identity 时拒绝 user-scope get/set/delete；site-scope anonymous 只保留当前阶段接受的直接 HTTP 风险。清理 gateway response 的全部 `Access-Control-*` header。

- [ ] **Step 4: 运行 runtime focused tests 并提交**

```bash
node --test apps/pages-router/src/index.test.js apps/kv-gateway/src/index.test.js
git add apps/pages-router/src/index.js apps/pages-router/src/index.test.js apps/kv-gateway/src/index.js apps/kv-gateway/src/index.test.js
git commit -m "feat(pages-router): 增加公网 runtime 同源防护"
```

### Task 7: WFP OfficeNet 受控移除与 public-aware 部署/回滚

**Files:**

- Modify: `packages/wfp-client/src/index.js`
- Test: `packages/wfp-client/src/index.test.js`
- Modify: `apps/pages-api/src/wfp-provider.js`
- Test: `apps/pages-api/src/sites.test.js`
- Modify: `apps/pages-api/src/deployments.js`
- Test: `apps/pages-api/src/deployments.test.js`

- [ ] **Step 1: 写 WFP binding 操作测试**

测试读取完整 settings 后只移除 `{ type: 'vpc_network', name: 'XD_OFFICE_NET' }`，保留 service/assets/plain/secret 绑定；缺 settings bindings、PATCH 失败、读回仍存在分别返回可操作错误。不能把其它 `vpc_network` 绑定误删。

- [ ] **Step 2: 增加 provider binding helper**

在 `packages/wfp-client` 增加精确的 `removeOfficeNetBinding(scriptName, options)` helper，只移除名称为 `XD_OFFICE_NET` 且类型为 `vpc_network` 的 binding，保留现有 `updateUserWorkerBindings` 的 plain-text 行为。`apps/pages-api/src/wfp-provider.js` 暴露同名 `removeOfficeNetBinding` 和 `verifyOfficeNetAbsent`，所有 settings PATCH 必须由 pages-api site lease 包裹。

- [ ] **Step 3: 修改部署候选 Worker 的 binding 生成**

部署上传前读取 desired exposure，但 activation 前必须在 site lease 内重新读取 exposure/route tuple。public 候选不注入 `XD_OFFICE_NET`；internal 候选保持既有 `userWorkerVpcNetworkBindings`。候选上传成功但 CAS 失败时不要直接删除可能已被 pointer 使用的 Worker，交给现有 cleanup/reconcile task。

- [ ] **Step 4: 修改 activation/rollback CAS**

在 `deployments.js` 的 active route activation 和 rollback 路径中，将 exposure、routeGeneration、policyVersion、activeVersionId、runtimeConfigGeneration 和 lease fencing token 纳入 CAS；public target 现场读取并移除/验证 OfficeNet，验证失败返回 conflict/OfficeNet error，不切 route。

- [ ] **Step 5: 覆盖 Admin/deploy/rollback/runtime stale GET/PATCH 交错测试**

使用确定性 interleaving：runtime provider 在 settings GET 后暂停；Admin 移除并确认 OfficeNet、提交 public；恢复 runtime PATCH；断言 stale PATCH 被 site lease/fencing 拒绝或进入 reconcile，最终 active Worker 不含 OfficeNet。再覆盖 lease 在 provider call 中过期的路径。

- [ ] **Step 6: 运行 WFP/deployment tests 并提交**

```bash
node --test packages/wfp-client/src/index.test.js apps/pages-api/src/deployments.test.js apps/pages-api/src/sites.test.js
git add packages/wfp-client/src/index.js packages/wfp-client/src/index.test.js apps/pages-api/src/wfp-provider.js apps/pages-api/src/deployments.js apps/pages-api/src/deployments.test.js apps/pages-api/src/sites.test.js apps/pages-api/src/execution-provider.js
git commit -m "feat(deploy): public Worker 不注入 OfficeNet"
```

### Task 8: Runtime var/secret sync 纳入 site lease

**Files:**

- Modify: `apps/pages-api/src/sites.js`
- Modify: `apps/pages-api/src/console.js`
- Modify: `apps/pages-api/src/store.js`
- Modify: `apps/pages-api/src/test-store.js`
- Test: `apps/pages-api/src/sites.test.js`
- Test: `apps/pages-api/src/console.test.js`

- [ ] **Step 1: 写锁顺序和 active target 漂移测试**

断言 runtime config path 获取 `site commit lease -> runtime-config lock`；provider 调用前后 active `workerName`, `activeVersionId`, `routeGeneration`, `runtimeConfigGeneration` 不一致时返回 `RUNTIME_CONFIG_CHANGED` 并进入 reconcile，不把旧 Worker 成功当作当前 Worker 同步成功。

- [ ] **Step 2: 修改 plain-text full settings PATCH**

将 `syncActiveWfpPlainTextBindings` 的现有 `withRuntimeConfigLock` 外层包入 `withSiteCommitLock`；provider GET/PATCH 全程在两个锁内，调用前后重新读取 route/exposure。锁顺序禁止反向获取，lease 丢失时中止 PATCH 或标记 reconcile。

- [ ] **Step 3: 修改 secret PUT/DELETE target resolution**

secret PUT/DELETE 虽不重写完整 bindings，也在 site lease 内解析 active Worker；deploy 切换 Worker 时重放最新 runtime config 或返回可重试 409。保留现有 runtime-config generation CAS 和错误码。

- [ ] **Step 4: 运行 runtime config tests 并提交**

```bash
node --test apps/pages-api/src/sites.test.js apps/pages-api/src/console.test.js apps/pages-api/src/store.test.js
git add apps/pages-api/src/sites.js apps/pages-api/src/console.js apps/pages-api/src/store.js apps/pages-api/src/test-store.js apps/pages-api/src/sites.test.js apps/pages-api/src/console.test.js
git commit -m "fix(pages-api): 串行化 runtime binding 与 exposure 提交"
```

### Task 9: Admin Console exposure 展示与操作

**Files:**

- Modify: `apps/pages-console/src/ui/api.js`
- Modify: `apps/pages-console/src/ui/pages/AdminSites.jsx`
- Modify: `apps/pages-console/src/ui/pages/SiteDetail.jsx`
- Modify: `apps/pages-console/src/ui/site-display-model.js`
- Modify: `apps/pages-console/src/ui/site-detail-model.js`
- Modify: `apps/pages-console/src/ui/styles.css`
- Test: `apps/pages-console/src/ui/api.test.js`
- Test: `apps/pages-console/src/ui/site-display-model.test.js`
- Test: `apps/pages-console/src/ui/site-detail-model.test.js`
- Test: `apps/pages-console/src/ui/site-detail-interaction.test.js`
- Test: `apps/pages-console/src/ui/site-settings-model.test.js`

- [ ] **Step 1: 写 model/API tests**

覆盖 exposure badge/filter (`all/public/internal`)、pending/degraded effective state、public+anonymous 风险摘要、Admin reason/confirmation payload、错误码映射。Workspace 详情只读展示 exposure，不把 public 加入 visibility select。

- [ ] **Step 2: 增加 Admin API client 方法**

在 `api.js` 增加 `adminSiteApi.updateExposure(siteId, { exposure, reason })`，只调用 Admin endpoint；不得修改现有 `siteApi.updateAccess` 请求体。

- [ ] **Step 3: 增加列表 exposure filter 和详情独立卡片**

复用现有 `.list-toolbar`、`.checkbox-row`、`.field`、`.form-note`、`.form-error`、`AppDialog`/`ConfirmDialog`。visibility select 仍只显示 `internal/org/acl/owner/disabled`。public+anonymous 明确显示“互联网匿名访问”，OfficeNet 移除影响写入确认文案。

- [ ] **Step 4: 运行 Console focused tests 并提交**

```bash
node --test apps/pages-console/src/ui/api.test.js apps/pages-console/src/ui/site-display-model.test.js apps/pages-console/src/ui/site-detail-model.test.js apps/pages-console/src/ui/site-detail-interaction.test.js apps/pages-console/src/ui/site-settings-model.test.js
git add apps/pages-console/src/ui/api.js apps/pages-console/src/ui/pages/AdminSites.jsx apps/pages-console/src/ui/pages/SiteDetail.jsx apps/pages-console/src/ui/site-display-model.js apps/pages-console/src/ui/site-detail-model.js apps/pages-console/src/ui/styles.css apps/pages-console/src/ui/api.test.js apps/pages-console/src/ui/site-display-model.test.js apps/pages-console/src/ui/site-detail-model.test.js apps/pages-console/src/ui/site-detail-interaction.test.js apps/pages-console/src/ui/site-settings-model.test.js
git commit -m "feat(pages-console): 增加站点公网 exposure 管理界面"
```

### Task 10: 文档、CLI help、OpenAPI 边界和发布顺序

**Files:**

- Modify: `docs/security/routing-and-access.md`
- Modify: `docs/architecture/publishing-and-runtime.md`
- Modify: `docs/architecture/data-model.md`
- Modify: `docs/operations/resources-and-deployment.md`
- Modify: `docs/operations/observability-and-rollout.md`
- Modify: `docs/architecture/xd-cell-console.md`
- Modify: `docs/api-boundary.md`
- Modify: `apps/pages-cli/src/commands/shared.js`
- Modify: `apps/pages-cli/README.md`
- Modify: `apps/pages-api/src/public-docs.js`
- Modify: `pages-deploy.skill.md`
- Modify: `.github/workflows/deploy-pages-v2.yml`
- Modify: `.github/workflows/deploy-pages-v2-staging.yml`
- Test: `scripts/pages-v2-docs.test.js`
- Test: `scripts/public-docs.test.js`
- Test: `scripts/workflows.test.js`

- [ ] **Step 1: 更新安全和架构真相源**

写明 exposure/accessMode 正交模型、Router 先读可信 snapshot 再决定 IP、旧 v2 snapshot 固定 internal、unknown exposure/accessMode fail closed、public runtime 只做严格同源防护、OfficeNet 不变量和 D1/pointer degraded 状态。

- [ ] **Step 2: 保持 CLI/API 表面兼容，只改解释文字**

保留 `--visibility internal|org|acl|owner|disabled`、配置字段和请求/响应；把 `internal` 的说明改成匿名 access mode，不加入 `--public` 或 `--exposure`。公开文档不得把 exposure 当作普通用户 API 字段。

- [ ] **Step 3: 调整 staging/production 发布顺序测试**

先部署 Router v2/v3 双读，再 migration/API，再开放 Admin mutation；若 workflow 当前 pages-api 早于 Router，拆成两个受控阶段。保持 production 仍只能手动触发，不新增 push/PR 自动部署。

- [ ] **Step 4: 运行文档/workflow tests 并提交**

```bash
node --test scripts/pages-v2-docs.test.js scripts/public-docs.test.js scripts/workflows.test.js
git add docs apps/pages-cli/src/commands/shared.js apps/pages-cli/README.md apps/pages-api/src/public-docs.js pages-deploy.skill.md .github/workflows/deploy-pages-v2.yml .github/workflows/deploy-pages-v2-staging.yml scripts/pages-v2-docs.test.js scripts/public-docs.test.js scripts/workflows.test.js
git commit -m "docs: 同步公网 exposure 行为与发布顺序"
```

### Task 11: 端到端回归、迁移收口和验证

**Files:**

- Test: `apps/pages-api/src/admin.test.js`
- Test: `apps/pages-api/src/deployments.test.js`
- Test: `apps/pages-router/src/index.test.js`
- Test: `apps/pages-router/src/access-policy.test.js`
- Test: `apps/pages-console/src/ui/site-detail-interaction.test.js`
- Test: `scripts/pages-v2-docs.test.js`
- Test: `scripts/workflows.test.js`

- [ ] **Step 1: 跑 policy 组合矩阵**

验证 `internal/public × anonymous/org/acl/owner/disabled`：只有 explicit public 绕过 IP；disabled 永远拒绝；protected access modes 仍走 SSO/employee/ACL；public+anonymous 浏览器 runtime 同源可用、跨源拒绝。

```bash
node --test packages/pages-access-policy/src/index.test.js apps/pages-router/src/access-policy.test.js apps/pages-router/src/index.test.js
```

- [ ] **Step 2: 跑 OfficeNet 和故障补偿矩阵**

验证移除失败、移除成功但 D1 失败、D1 public 后 snapshot 失败、internal pointer repair、Admin/deploy/runtime 交错、lease loss、CAS conflict。确认没有任何路径在 pointer 未确认时记录 `effective_success`。

```bash
node --test apps/pages-api/src/admin.test.js apps/pages-api/src/deployments.test.js apps/pages-api/src/sites.test.js packages/wfp-client/src/index.test.js
```

- [ ] **Step 3: 跑全仓库验证**

```bash
pnpm lint
pnpm test
```

Expected: 全部 PASS；失败时先按失败测试定位，不修改无关目录。确认 `git status --short` 只包含计划执行产生的目标文件，不包含 secret、`.env`、真实 Cloudflare resource ID 或用户 token。

- [ ] **Step 4: 做 staging 手动验证清单**

在 staging 依次验证：Router 双读、旧 visibility 调用、Admin 开关 public、public+anonymous/org/acl/owner/disabled、runtime exact Origin、OfficeNet 移除与业务 `OFFICE_NET_UNAVAILABLE`、关闭 public/pointer repair、public deploy/rollback、runtime var stale PATCH、紧急关闭路径。production 只在 staging 通过后按现有手动 workflow 发布。

- [ ] **Step 5: Commit verification evidence**

```bash
git status --short
git log --oneline -12
```

记录测试命令和结果；不把日志中的 token、cookie、Worker settings 或 Cloudflare resource ID 写入文档或提交。

## Plan Self-Review Checklist

- [ ] Spec coverage: exposure/accessMode、visibility 兼容、Admin 权限/reason、runtime 同源、OfficeNet、lease/CAS、snapshot/pointer、audit、UI、docs、rollout 和 tests 均有对应任务。
- [ ] Placeholder scan: 计划没有未决占位符；每个实现步骤给出明确文件、函数边界、测试命令或代码片段。
- [ ] Type consistency: `exposure` 只取 `internal|public`；`accessMode` 只取 `anonymous|org|acl|owner|disabled`；legacy `visibility=internal` 只映射为 `anonymous`；Admin/user mutation 的字段保留规则在所有任务中一致。
- [ ] Compatibility: 没有新增 CLI flag、没有把 exposure 加入用户 API 合约、没有触碰 v1 legacy。
- [ ] Safety: invalid/unknown exposure 不得跳 IP；invalid accessMode 不 dispatch；D1/pointer 未收敛时阻断部署和 OfficeNet 恢复；OfficeNet stale GET/PATCH 由 site lease 串行化。
