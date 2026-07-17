# Public Runtime Vars API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add authenticated public `PUT/DELETE /.xd-pages/api/sites/{site}/vars` endpoints that mutate one non-sensitive runtime var without exposing values and safely synchronize the active Worker.

**Architecture:** Extend both production and test stores with a lock-scoped single-var mutation returning the committed vars snapshot and runtime generation. Make secret PUT share the same runtime-config lock and quota/name validation, then add public handlers that reuse existing site management authorization and stabilize active-Worker synchronization by checking generation after each provider call. Keep the Console URL and response contract unchanged while switching it to the same mutation path.

**Tech Stack:** Cloudflare Workers, JavaScript ES modules, D1 SQL, `node:test`, OpenAPI 3.1, pnpm.

---

## File Map

- `apps/pages-api/src/runtime-config.js`: shared runtime binding validation and stable error codes.
- `apps/pages-api/src/store.js`: production D1 lock, atomic var mutation, secret lock integration, generation snapshots.
- `apps/pages-api/src/test-store.js`: test-store implementation of the same mutation contract.
- `apps/pages-api/src/store.test.js`: D1 atomicity, lock, quota, conflict, and concurrency regression tests.
- `apps/pages-api/src/sites.js`: public vars routing, request parsing, authorization, error mapping, response filtering, active-Worker stabilization.
- `apps/pages-api/src/sites.test.js`: public API behavior, authorization, validation, non-disclosure, sync, and negative-method tests.
- `apps/pages-api/src/console.js`: reuse the atomic mutation and stabilized sync while preserving Console responses.
- `apps/pages-api/src/console.test.js`: Console compatibility and sync regressions.
- `apps/pages-api/src/openapi.js`: development contract schemas, vars path, and secret PUT error additions.
- `apps/pages-api/src/openapi.test.js`: exact OpenAPI contract and no-GET assertions.
- `docs/api-boundary.md`: controlled-integration boundary without publishing endpoint instructions.

### Task 1: Add Atomic Single-Var Store Mutation

**Files:**
- Modify: `apps/pages-api/src/runtime-config.js:11-70`
- Modify: `apps/pages-api/src/store.js:3088-3291`
- Modify: `apps/pages-api/src/test-store.js:1721-1798`
- Test: `apps/pages-api/src/store.test.js:1166-1496`

- [ ] **Step 1: Write failing tests for the store contract**

Add tests that call a new `mutateSiteVar` method and assert its exact result:

```js
const result = await store.mutateSiteVar({
  environment: 'production',
  siteId: 'site_1',
  operation: 'put',
  name: 'API_BASE',
  value: 'https://api.example.com',
  actorId: 'usr_1',
  updatedAt: '2026-06-15T00:00:00.000Z',
  createId: () => 'var_api_base',
});

assert.equal(result.record.name, 'API_BASE');
assert.equal(result.record.revision, 1);
assert.equal(result.generation, 1);
assert.deepEqual(result.vars.map(({ name, value }) => ({ name, value })), [
  { name: 'API_BASE', value: 'https://api.example.com' },
]);
```

Cover PUT create, PUT update, idempotent PUT, DELETE, idempotent DELETE, revision preservation, and a held lock returning `SITE_VAR_REVISION_CONFLICT`. Add a deterministic interleaving test in which two different names are computed under the store lock and both survive; do not simulate concurrency by reading vars in the handler.

- [ ] **Step 2: Run the focused store test and confirm failure**

Run:

```bash
node --test apps/pages-api/src/store.test.js
```

Expected: FAIL because `store.mutateSiteVar` is not defined.

- [ ] **Step 3: Add shared vars snapshot helpers**

Export these helpers from `runtime-config.js` and use them in store and handler code:

```js
export function runtimeVarsObject(records = []) {
  return Object.fromEntries(records.map((record) => [record.name, record.value]));
}

export function runtimeVarObjectsEqual(left = {}, right = {}) {
  const leftNames = Object.keys(left).sort();
  const rightNames = Object.keys(right).sort();
  return (
    leftNames.length === rightNames.length &&
    leftNames.every((name, index) => name === rightNames[index] && left[name] === right[name])
  );
}
```

- [ ] **Step 4: Implement `mutateSiteVar` in `D1PagesStore`**

Use this public method shape in `store.js`:

```js
async mutateSiteVar(input) {
  const now = input.updatedAt || this.now();
  const lockId = input.lockId || randomStoreId('runtime_lock');
  const lock = await this.acquireRuntimeConfigLockStatement(input.environment, input.siteId, lockId, now).run();
  if (lock?.meta?.changes !== 1) throw new Error('SITE_VAR_REVISION_CONFLICT');

  let released = false;
  try {
    const routeState = await this.getRuntimeConfigRouteState(input.environment, input.siteId);
    if (!routeState || routeState.runtimeConfigLockId !== lockId) throw new Error('SITE_VAR_REVISION_CONFLICT');
    const liveVars = await this.listEnabledSiteVars(input.environment, input.siteId);
    const liveSecrets = await this.listEnabledSiteSecrets(input.environment, input.siteId);
    const nextVars = runtimeVarsObject(liveVars);
    if (input.operation === 'put') nextVars[input.name] = input.value;
    else delete nextVars[input.name];
    validateRuntimeBindingQuotas(nextVars, liveSecrets);

    const changed = !runtimeVarObjectsEqual(runtimeVarsObject(liveVars), nextVars);
    if (!changed) {
      const release = await this.releaseRuntimeConfigLockStatement(input.environment, input.siteId, lockId, now).run();
      released = release?.meta?.changes === 1;
      if (!released) throw new Error('SITE_VAR_REVISION_CONFLICT');
      const record = liveVars.find((item) => item.name === input.name) || { name: input.name };
      return { record, vars: liveVars, generation: routeState.runtimeConfigGeneration, changed: false };
    }

    const liveByName = new Map(liveVars.map((record) => [record.name, record]));
    const existing = liveByName.get(input.name) || null;
    const statements = [];
    if (input.operation === 'put') {
      const revision = (await this.nextSiteVarRevision(input.environment, input.siteId, input.name)) + 1;
      const statement = existing
        ? this.siteVarUpdateStatement({ ...input, existing, revision, lockId, updatedAt: now })
        : this.siteVarInsertStatement({
            ...input,
            id: input.createId ? input.createId(input.name) : randomStoreId('var'),
            revision,
            createdBy: input.actorId || input.createdBy,
            createdAt: now,
            updatedAt: now,
            lockId,
          });
      this.pushRuntimeChangeStatement(statements, statement);
    } else {
      this.pushRuntimeChangeStatement(
        statements,
        this.siteVarDeleteStatement({ ...input, existing, lockId, deletedAt: now })
      );
    }
    this.pushRuntimeChangeStatement(
      statements,
      this.bumpRuntimeConfigGenerationAndReleaseLockStatement(input.environment, input.siteId, now, lockId)
    );
    await this.db.batch(statements);
    released = true;
    const records = await this.listEnabledSiteVars(input.environment, input.siteId);
    return {
      record: records.find((record) => record.name === input.name) || { name: input.name },
      vars: records,
      generation: routeState.runtimeConfigGeneration + 1,
      changed: true,
    };
  } finally {
    if (!released) {
      await this.releaseRuntimeConfigLockStatement(input.environment, input.siteId, lockId, now).run().catch(() => {});
    }
  }
}
```

Extract the existing guarded update and delete SQL from `replaceSiteVars` into `siteVarUpdateStatement` and `siteVarDeleteStatement`, then call those builders from both methods. Every mutation statement and the generation/release statement must still be followed by `runtimeChangeGuardStatement`; do not call `replaceSiteVars` from inside the held lock. For DELETE, return the no-op branch before constructing `siteVarDeleteStatement` when `existing` is null.

Import `validateRuntimeBindingQuotas` from `runtime-config.js`. Map its `RUNTIME_BINDING_NAME_CONFLICT` and `RUNTIME_BINDINGS_LIMIT_EXCEEDED` exceptions unchanged so handlers can return stable errors.

- [ ] **Step 5: Implement the same contract in `TestPagesStore`**

Add `mutateSiteVar(input)` using a per-site promise queue or synchronous lock marker so concurrent test calls serialize exactly like D1. It must call `validateRuntimeBindingQuotas`, preserve revision history, bump `runtimeConfigGeneration` only on changes, and return `{ record, vars, generation, changed }` with cloned records.

- [ ] **Step 6: Run store tests**

Run:

```bash
node --test apps/pages-api/src/store.test.js
```

Expected: PASS, including existing `replaceSiteVars` tests.

- [ ] **Step 7: Commit the atomic store mutation**

```bash
git add apps/pages-api/src/runtime-config.js apps/pages-api/src/store.js apps/pages-api/src/test-store.js apps/pages-api/src/store.test.js
git commit -m "feat(pages-api): 支持原子修改单个 runtime var"
```

### Task 2: Make Secret PUT Share Runtime Lock and Binding Validation

**Files:**
- Modify: `apps/pages-api/src/store.js:2893-3069`
- Modify: `apps/pages-api/src/test-store.js:1641-1708`
- Modify: `apps/pages-api/src/sites.js:65-185`
- Test: `apps/pages-api/src/store.test.js:1498-1745`
- Test: `apps/pages-api/src/sites.test.js:881-1245`

- [ ] **Step 1: Write failing conflict, quota, and cleanup tests**

Add D1 and test-store cases with an existing var named `API_BASE`:

```js
await assert.rejects(
  store.putSiteSecretWithAudit({
    id: 'sec_1',
    auditId: 'aud_1',
    environment: 'production',
    siteId: 'site_1',
    siteSlug: 'guide',
    name: 'API_BASE',
    value: 'secret-value',
    actorId: 'usr_1',
    actorType: 'user',
    routeId: 'route_1',
  }),
  /RUNTIME_BINDING_NAME_CONFLICT/
);
```

Add a 64-binding total quota case expecting `RUNTIME_BINDINGS_LIMIT_EXCEEDED`. Seed an intentionally conflicting/over-limit historical state directly in the fixture and verify `deleteSiteSecretWithAudit` still deletes it. Add a held runtime lock case expecting `SITE_SECRET_REVISION_CONFLICT` and no secret/audit/generation partial write.

- [ ] **Step 2: Run focused tests and confirm failure**

```bash
node --test apps/pages-api/src/store.test.js apps/pages-api/src/sites.test.js
```

Expected: FAIL because secret PUT does not yet use the shared lock or validate current vars.

- [ ] **Step 3: Wrap secret PUT/DELETE in the shared lock**

Refactor `putSiteSecretWithAudit` to acquire the same per-site runtime lock before reading vars/secrets. Build the candidate secret set, then call:

```js
validateRuntimeBindingQuotas(runtimeVarsObject(liveVars), candidateSecrets);
```

Guard the secret write, generation bump/lock release, and audit insert with `runtimeChangeGuardStatement('SITE_SECRET_REVISION_CONFLICT')` so D1 batch failure rolls back. Preserve encryption, revision, and audit redaction behavior. `deleteSiteSecretWithAudit` must use the lock for serialization but skip post-delete quota/name rejection so it can repair invalid historical state.

- [ ] **Step 4: Map new public secret PUT errors**

In `sites.js`, extend the secret PUT catch block:

```js
if (error?.message === 'RUNTIME_BINDING_NAME_CONFLICT') {
  return jsonError(
    'RUNTIME_BINDING_NAME_CONFLICT',
    'Runtime binding names conflict.',
    400,
    'Use unique names for vars and site secrets.'
  );
}
if (error?.message === 'RUNTIME_BINDINGS_LIMIT_EXCEEDED') {
  return jsonError(
    'RUNTIME_BINDINGS_LIMIT_EXCEEDED',
    'Runtime bindings exceed platform limits.',
    413,
    'Reduce vars or site secrets and retry.'
  );
}
```

Keep the existing secret success envelope and DELETE behavior unchanged.

- [ ] **Step 5: Run store and sites tests**

```bash
node --test apps/pages-api/src/store.test.js apps/pages-api/src/sites.test.js
```

Expected: PASS with no secret value in responses or audit records.

- [ ] **Step 6: Commit shared runtime locking**

```bash
git add apps/pages-api/src/store.js apps/pages-api/src/test-store.js apps/pages-api/src/store.test.js apps/pages-api/src/sites.js apps/pages-api/src/sites.test.js
git commit -m "fix(pages-api): 统一 runtime bindings 并发约束"
```

### Task 3: Add Public Vars Handlers and Stabilized Worker Sync

**Files:**
- Modify: `apps/pages-api/src/sites.js:18-270,816-880,1125-1128`
- Test: `apps/pages-api/src/sites.test.js:881-1245`

- [ ] **Step 1: Write failing public API tests**

Add tests for:

```js
const providerCalls = [];
const provider = {
  replacePlainTextBindings: async (input) => providerCalls.push(input),
};
const put = await worker.fetch(
  putJsonRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/vars', {
    name: ' API_BASE ',
    value: 'https://api.example.com',
  }),
  testEnv(store, { WFP_PROVIDER: provider })
);

assert.equal(put.status, 200);
assert.deepEqual(await put.json(), {
  var: {
    site: 'guide',
    name: 'API_BASE',
    revision: 1,
    updated: true,
    appliesTo: 'active_worker',
  },
});
```

Cover DELETE, idempotent DELETE, no active Worker (`next_deployment`), assets-only versions, provider 502, malformed/non-object/array JSON, missing/extra fields, non-string value, sensitive/reserved/invalid names, 8 KiB limit, binding conflict, total quota, and response non-disclosure. Add owner, team publisher/admin, viewer, read-only key, wrong-site key, and owner-scoped `deploy:site` access-key authorization cases. Assert authenticated GET returns 405 and never contains stored values.

- [ ] **Step 2: Run the sites test and confirm failure**

```bash
node --test apps/pages-api/src/sites.test.js
```

Expected: FAIL because `/sites/{site}/vars` is unmatched or returns 405/404.

- [ ] **Step 3: Add strict request normalization and routing**

In `handleSitesApi`, match vars before the generic site ID route:

```js
const varsSiteSlug = matchSiteVars(url.pathname);
if (varsSiteSlug) {
  if (request.method === 'PUT') return putSiteVar(request, env, config, store, auth.actor, varsSiteSlug);
  if (request.method === 'DELETE') return deleteSiteVar(request, env, config, store, auth.actor, varsSiteSlug);
  return methodNotAllowed();
}
```

Use exact-key checking for PUT (`name`, `value`) and DELETE (`name`). Trim only `name`, then validate through `normalizeRuntimeVars({ [name]: value })`. Return `INVALID_JSON` only for malformed/non-object/array bodies; map missing, extra, or invalid fields to `RUNTIME_VAR_INVALID`.

Rename `getSecretManageableSiteBySlug` to `getRuntimeManageableSiteBySlug` and reuse it for vars and secrets so authorization remains identical.

- [ ] **Step 4: Add mutation error mapping and value-free responses**

Call `store.mutateSiteVar` and map errors to the spec. Format only public metadata:

```js
function formatVar(siteSlug, record, { deleted, appliesTo }) {
  return {
    site: siteSlug,
    name: record.name,
    ...(!deleted && record.revision ? { revision: Number(record.revision) } : {}),
    ...(deleted ? { deleted: true } : { updated: true }),
    appliesTo,
  };
}
```

Do not return `value`, internal IDs, timestamps, provider names, worker names, or route metadata.

- [ ] **Step 5: Stabilize active Worker sync by generation**

Replace the one-shot plain-text sync with a bounded helper:

```js
async function resolveActiveWfpWorker(store, config, site) {
  const route = await store.getRouteBySiteId(site.id, config.environment);
  if (!route || route.routeStatus !== 'active' || !route.activeVersionId) return null;
  const version = await store.getSiteVersion(route.activeVersionId, config.environment);
  if (!version || (!isWfpRoute(route) && !isWfpVersion(version))) return null;
  if (!versionRequiresWorker(version)) return null;
  const workerName = route.workerName || version.workerName;
  return workerName ? { workerName } : null;
}

export async function syncActiveWfpPlainTextBindings(store, env, config, site, snapshot) {
  const target = await resolveActiveWfpWorker(store, config, site);
  if (!target) return { appliesTo: 'next_deployment' };
  const provider = createWfpDeploymentProvider(env, config);
  let current = snapshot;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await provider.replacePlainTextBindings({ workerName: target.workerName, vars: runtimeVarsObject(current.vars) });
    const routeState = await store.getRuntimeConfigRouteState(config.environment, site.id);
    if (Number(routeState?.runtimeConfigGeneration || 0) === Number(current.generation || 0)) {
      return { appliesTo: 'active_worker' };
    }
    current = {
      vars: await store.listEnabledSiteVars(config.environment, site.id),
      generation: Number(routeState?.runtimeConfigGeneration || 0),
    };
  }
  return jsonError('RUNTIME_CONFIG_CHANGED', 'Runtime config changed while syncing.', 409, 'Retry the runtime config change.');
}
```

Preserve existing provider-unavailable and provider-call failures as `RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED` 502. Add a deferred-promise test where generation 1 finishes after generation 2; assert a final generation-2 provider call restores the Worker to the store snapshot.

- [ ] **Step 6: Run public vars tests**

```bash
node --test apps/pages-api/src/sites.test.js
```

Expected: PASS, including authorization and reverse-completion sync tests.

- [ ] **Step 7: Commit the public vars API**

```bash
git add apps/pages-api/src/sites.js apps/pages-api/src/sites.test.js
git commit -m "feat(pages-api): 开放 runtime vars 管理 API"
```

### Task 4: Reuse Atomic Mutation from Console

**Files:**
- Modify: `apps/pages-api/src/console.js:485-520,762-829`
- Test: `apps/pages-api/src/console.test.js:985-1332`

- [ ] **Step 1: Add Console compatibility and concurrency tests**

Keep the existing response including `value`, `revision`, `updatedAt`, and `appliesTo`. Add two concurrent PUTs for different names and assert both remain in `GET /config`:

```js
const [apiBase, featureFlag] = await Promise.all([
  worker.fetch(internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/vars/API_BASE', {
    userId: 'usr_me',
    method: 'PUT',
    body: { value: 'https://api.example.com' },
  }), testEnvironment),
  worker.fetch(internalConsoleJsonRequest('/.xd-pages/api/console/sites/site_mine/config/vars/FEATURE_FLAG', {
    userId: 'usr_me',
    method: 'PUT',
    body: { value: 'on' },
  }), testEnvironment),
]);
assert.equal(apiBase.status, 200);
assert.equal(featureFlag.status, 200);
assert.deepEqual(
  (await store.listEnabledSiteVars('production', 'site_mine')).map(({ name, value }) => ({ name, value })),
  [
    { name: 'API_BASE', value: 'https://api.example.com' },
    { name: 'FEATURE_FLAG', value: 'on' },
  ]
);
```

The reverse provider completion case remains owned by the public sync helper test in Task 3 because Console calls the same exported helper.

- [ ] **Step 2: Run Console tests before the change**

```bash
node --test apps/pages-api/src/console.test.js
```

Expected: the new concurrent test FAILS because Console currently reads outside the store lock.

- [ ] **Step 3: Switch Console PUT/DELETE to `store.mutateSiteVar`**

Replace `nextVarsForPut`, `nextVarsForDelete`, `currentVarsObject`, and the Console-local `replaceSiteVars` wrapper with:

```js
const mutation = await store.mutateSiteVar({
  environment: config.environment,
  siteId: site.id,
  operation: 'put',
  name: normalized.name,
  value: normalized.value,
  actorId: session.userId,
  updatedAt: readNow(env),
  createId: (bindingName) => nextId(env, `var${bindingName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'runtime'}`),
});
const syncResult = await syncActiveWfpPlainTextBindings(store, env, config, site, mutation);
```

Catch `SITE_VAR_REVISION_CONFLICT`, binding conflict, and quota errors using the same public error codes. Preserve Console formatting and do not change its session, role, host, or URL checks.

- [ ] **Step 4: Run Console and public API tests**

```bash
node --test apps/pages-api/src/console.test.js apps/pages-api/src/sites.test.js
```

Expected: PASS with unchanged existing Console response snapshots.

- [ ] **Step 5: Commit Console reuse**

```bash
git add apps/pages-api/src/console.js apps/pages-api/src/console.test.js
git commit -m "refactor(pages-api): 复用 runtime vars 原子修改链路"
```

### Task 5: Update OpenAPI and API Boundary Documentation

**Files:**
- Modify: `apps/pages-api/src/openapi.js:305-331,590-654`
- Test: `apps/pages-api/src/openapi.test.js:20-152`
- Modify: `docs/api-boundary.md:7-30`

- [ ] **Step 1: Write failing OpenAPI assertions**

Add assertions for `SiteVarPutRequest`, `SiteVarDeleteRequest`, PUT/DELETE operations, no GET operation, no response value schema, and exact error codes. Assert secret PUT includes `RUNTIME_BINDING_NAME_CONFLICT` and `RUNTIME_BINDINGS_LIMIT_EXCEEDED`, while secret DELETE does not.

- [ ] **Step 2: Run the OpenAPI test and confirm failure**

```bash
node --test apps/pages-api/src/openapi.test.js
```

Expected: FAIL because the vars schemas/path do not exist.

- [ ] **Step 3: Add OpenAPI schemas and path**

Mirror the secret request structure with `additionalProperties: false`:

```js
SiteVarPutRequest: {
  type: 'object',
  required: ['name', 'value'],
  additionalProperties: false,
  properties: {
    name: { type: 'string', description: 'Non-sensitive Worker plain-text binding name.' },
    value: { type: 'string', description: 'Non-sensitive plain-text value. Never returned by this API.' },
  },
},
SiteVarDeleteRequest: {
  type: 'object',
  required: ['name'],
  additionalProperties: false,
  properties: { name: { type: 'string' } },
},
```

Define only PUT and DELETE under `/.xd-pages/api/sites/{site}/vars`. Include 400, 403, 404, 409, 413, 502, and 503 response descriptions matching handler behavior.

- [ ] **Step 4: Update the boundary document without publishing raw API instructions**

Add one sentence under the development contract: controlled integrations may use authenticated site-level vars/secrets mutation endpoints, while ordinary users and agents continue to use `xd-cell`; OpenAPI remains non-public. Do not add curl examples or authentication-header construction.

- [ ] **Step 5: Run OpenAPI and documentation checks**

```bash
node --test apps/pages-api/src/openapi.test.js
git diff --check
```

Expected: PASS and no whitespace errors.

- [ ] **Step 6: Commit contract and documentation**

```bash
git add apps/pages-api/src/openapi.js apps/pages-api/src/openapi.test.js docs/api-boundary.md
git commit -m "docs(pages-api): 同步 runtime vars API 合约"
```

### Task 6: Full Verification

**Files:**
- Verify only; fix only regressions caused by Tasks 1-5.

- [ ] **Step 1: Run all pages-api focused tests**

```bash
node --test "apps/pages-api/src/*.test.js"
```

Expected: all tests PASS.

- [ ] **Step 2: Run repository lint**

```bash
pnpm lint
```

Expected: exit code 0.

- [ ] **Step 3: Run the full repository test suite**

```bash
pnpm test
```

Expected: exit code 0 with no failed tests.

- [ ] **Step 4: Inspect final diff and security boundaries**

```bash
git diff master...HEAD --check
git diff master...HEAD -- apps/pages-api/src docs/api-boundary.md
```

Confirm no secret values, credentials, internal provider IDs, production deployment triggers, OpenAPI public route, or GET/list vars capability were added.
