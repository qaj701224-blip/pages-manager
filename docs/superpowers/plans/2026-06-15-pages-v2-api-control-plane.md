# Pages v2 API Control Plane Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the v2-only `apps/pages-api` control plane for sites, access keys, deployments, versions, rollback, D1 authority records, route snapshots, audit records, and OpenAPI skeleton.

**Architecture:** `pages-api` is a new Worker app and does not change v1 `apps/server`. The app exposes only `/.xd-pages/api/*` and `/.xd-pages/health`, rejects legacy `X-Pages-Token`, authenticates via CLI token or access key, writes authoritative records to D1-compatible storage, and writes route snapshot records through an injectable cache adapter. Real Cloudflare Workers for Platforms upload remains a later M5 provider, but M3 persists immutable versions and route state so M5 can replace the fake uploader without changing public API contracts.

**Tech Stack:** Cloudflare Workers, JavaScript ESM, `node:test`, Web Crypto, D1-compatible prepared statements, `@xd/worker-kit`.

---

## Scope Notes

- Do not stage or commit `docs/xd-sso.md`.
- Do not change v1 `apps/server` behavior or v1 `*.workers.xd.team` docs.
- `apps/pages-api` may use in-memory/test adapters where Cloudflare D1 is unavailable in unit tests, but production-facing modules must keep a D1-style interface.
- Access key plaintext is returned only from create.
- Deploy and rollback must enforce `Idempotency-Key`.
- M3 should not upload to real WFP yet; it creates records and route snapshots with a provider seam for M5.

## File Map

- Create `apps/pages-api/package.json`: workspace package metadata.
- Create `apps/pages-api/wrangler.template.toml`: v2 API Worker template with placeholder D1/KV/service bindings and no real ids.
- Create `apps/pages-api/src/http.js`: JSON helpers, safe errors, body parsing, routing helpers.
- Create `apps/pages-api/src/config.js`: environment validation for production/staging/local.
- Create `apps/pages-api/src/id.js`: prefixed ID generation and validation.
- Create `apps/pages-api/src/crypto.js`: request hashing, HMAC access-key hashing, safe compare.
- Create `apps/pages-api/src/schema.js`: D1 schema SQL and migration statements.
- Create `apps/pages-api/src/store.js`: D1-compatible repository and transaction-friendly operations.
- Create `apps/pages-api/src/test-store.js`: deterministic in-memory repository used by unit tests.
- Create `apps/pages-api/src/auth.js`: legacy token rejection, CLI token verification via `PAGES_AUTH` service binding/test verifier, access-key verification.
- Create `apps/pages-api/src/sites.js`: sites list/create/get route handlers.
- Create `apps/pages-api/src/access-keys.js`: access key create/list/revoke handlers.
- Create `apps/pages-api/src/deployments.js`: deploy create/get and rollback handlers.
- Create `apps/pages-api/src/route-snapshot.js`: immutable route snapshot and pointer generation.
- Create `apps/pages-api/src/openapi.js`: v2-only OpenAPI skeleton.
- Create `apps/pages-api/src/index.js`: Worker entrypoint and route dispatch.
- Create focused `*.test.js` files next to each module.

---

### Task 1: API Worker Skeleton

**Files:**

- Create: `apps/pages-api/package.json`
- Create: `apps/pages-api/wrangler.template.toml`
- Create: `apps/pages-api/src/http.js`
- Create: `apps/pages-api/src/config.js`
- Create: `apps/pages-api/src/index.js`
- Test: `apps/pages-api/src/index.test.js`
- Test: `apps/pages-api/src/config.test.js`

- [ ] **Step 1: Write failing skeleton tests**

```js
// apps/pages-api/src/index.test.js
import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.js';

test('health returns pages-api service and environment', async () => {
  const response = await worker.fetch(new Request('https://api.pages.xd.team/.xd-pages/health'), {
    PAGES_ENV: 'production',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'ok',
    service: 'pages-api',
    environment: 'production',
  });
});

test('unknown endpoints return safe JSON errors', async () => {
  const response = await worker.fetch(new Request('https://api.pages.xd.team/.xd-pages/api/missing'), {
    PAGES_ENV: 'production',
  });
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.match(body.error.action, /Check the endpoint/);
});
```

```js
// apps/pages-api/src/config.test.js
import assert from 'node:assert/strict';
import test from 'node:test';

import { readApiConfig } from './config.js';

test('reads production pages API config', () => {
  assert.deepEqual(readApiConfig({ PAGES_ENV: 'production' }), {
    environment: 'production',
    apiBaseUrl: 'https://api.pages.xd.team',
    authBaseUrl: 'https://auth.pages.xd.team',
    siteDomainSuffix: 'pages.xd.team',
  });
});

test('rejects invalid environment', () => {
  assert.throws(() => readApiConfig({ PAGES_ENV: 'preview' }), /PAGES_ENV/);
});
```

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test apps/pages-api/src/index.test.js apps/pages-api/src/config.test.js`

Expected: FAIL with module-not-found errors for `apps/pages-api`.

- [ ] **Step 3: Implement minimal skeleton**

Implement `jsonOk`, `jsonError`, `readJsonBody`, `readApiConfig`, health routing, and safe 404 errors.

- [ ] **Step 4: Run skeleton tests**

Run: `node --test apps/pages-api/src/index.test.js apps/pages-api/src/config.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/pages-api
git commit -m "feat(api): 增加 pages-api 控制面骨架"
```

### Task 2: Schema And Store

**Files:**

- Create: `apps/pages-api/src/schema.js`
- Create: `apps/pages-api/src/store.js`
- Create: `apps/pages-api/src/test-store.js`
- Test: `apps/pages-api/src/schema.test.js`
- Test: `apps/pages-api/src/store.test.js`

- [ ] **Step 1: Write failing schema/store tests**

Tests must assert that schema SQL contains all M3 tables and that the test store enforces unique site slug per environment, immutable versions, access-key hash-only storage, and deployment idempotency conflict detection.

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test apps/pages-api/src/schema.test.js apps/pages-api/src/store.test.js`

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement schema and repository adapters**

Create SQL migration statements for `users`, `sites`, `site_routes`, `site_versions`, `deployments`, `site_members`, `site_acl_entries`, `access_keys`, `auth_sessions_index`, and `audit_events`. Implement a D1-style repository plus a deterministic in-memory repository used by tests.

- [ ] **Step 4: Run schema/store tests**

Run: `node --test apps/pages-api/src/schema.test.js apps/pages-api/src/store.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/pages-api/src/schema.js apps/pages-api/src/schema.test.js apps/pages-api/src/store.js apps/pages-api/src/store.test.js apps/pages-api/src/test-store.js
git commit -m "feat(api): 增加 D1 权威存储模型"
```

### Task 3: Auth Boundary

**Files:**

- Create: `apps/pages-api/src/auth.js`
- Create: `apps/pages-api/src/crypto.js`
- Create: `apps/pages-api/src/id.js`
- Test: `apps/pages-api/src/auth.test.js`
- Test: `apps/pages-api/src/crypto.test.js`

- [ ] **Step 1: Write failing auth tests**

Tests must cover: `X-Pages-Token` rejection, missing bearer token returns `PAGES_AUTH_REQUIRED`, CLI token verifier accepts `purpose=cli_token` and `aud=pages-api`, access-key auth stores/compares only HMAC hash, revoked/expired access keys are rejected, and plaintext access key is never returned from list records.

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test apps/pages-api/src/auth.test.js apps/pages-api/src/crypto.test.js`

Expected: FAIL because modules do not exist.

- [ ] **Step 3: Implement auth helpers**

Implement `authenticateApiRequest(request, env, store, config)`, `hashAccessKey`, `verifyAccessKey`, `canonicalRequestHash`, `newId(prefix)`, and constant-time compare helpers. CLI token verification should call `env.verifyCliToken(token)` in tests or `env.PAGES_AUTH.fetch()` in production-like code; API must not hold auth/session signing secrets.

- [ ] **Step 4: Run auth tests**

Run: `node --test apps/pages-api/src/auth.test.js apps/pages-api/src/crypto.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/pages-api/src/auth.js apps/pages-api/src/auth.test.js apps/pages-api/src/crypto.js apps/pages-api/src/crypto.test.js apps/pages-api/src/id.js
git commit -m "feat(api): 增加强认证边界"
```

### Task 4: Sites API

**Files:**

- Create: `apps/pages-api/src/sites.js`
- Modify: `apps/pages-api/src/index.js`
- Test: `apps/pages-api/src/sites.test.js`
- Test: `apps/pages-api/src/index.test.js`

- [ ] **Step 1: Write failing sites tests**

Tests must cover `GET /.xd-pages/api/sites`, `POST /.xd-pages/api/sites`, `GET /.xd-pages/api/sites/{id}`, owner membership creation, production slug rejecting `-staging`, invalid visibility rejection, duplicate slug conflict, and no legacy token compatibility.

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test apps/pages-api/src/sites.test.js apps/pages-api/src/index.test.js`

Expected: FAIL because sites routes do not exist.

- [ ] **Step 3: Implement sites routes**

Implement create/list/get with `siteId`, `siteUuid`, `routeId`, default route creation, owner membership, and audit events. Responses must never include v1 token fields.

- [ ] **Step 4: Run sites tests**

Run: `node --test apps/pages-api/src/sites.test.js apps/pages-api/src/index.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/pages-api/src/sites.js apps/pages-api/src/sites.test.js apps/pages-api/src/index.js apps/pages-api/src/index.test.js
git commit -m "feat(api): 增加站点控制面接口"
```

### Task 5: Access Keys API

**Files:**

- Create: `apps/pages-api/src/access-keys.js`
- Modify: `apps/pages-api/src/index.js`
- Test: `apps/pages-api/src/access-keys.test.js`

- [ ] **Step 1: Write failing access-key tests**

Tests must cover `POST /.xd-pages/api/access-keys`, `GET /.xd-pages/api/access-keys`, `DELETE /.xd-pages/api/access-keys/{id}`, one-time plaintext return, hash-only persisted record, scope/site validation, expiry, revoke, and no plaintext in list/delete responses.

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test apps/pages-api/src/access-keys.test.js`

Expected: FAIL because routes do not exist.

- [ ] **Step 3: Implement access-key routes**

Generate at least 192-bit random key material, prefix it with environment hint, store HMAC-SHA-256 with `pepper_id`, and list only metadata.

- [ ] **Step 4: Run access-key tests**

Run: `node --test apps/pages-api/src/access-keys.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/pages-api/src/access-keys.js apps/pages-api/src/access-keys.test.js apps/pages-api/src/index.js
git commit -m "feat(api): 增加 access key 管理"
```

### Task 6: Deployments, Versions, Rollback, Route Snapshots

**Files:**

- Create: `apps/pages-api/src/deployments.js`
- Create: `apps/pages-api/src/route-snapshot.js`
- Modify: `apps/pages-api/src/index.js`
- Test: `apps/pages-api/src/deployments.test.js`
- Test: `apps/pages-api/src/route-snapshot.test.js`

- [ ] **Step 1: Write failing deployment tests**

Tests must cover `POST /.xd-pages/api/deployments`, `GET /.xd-pages/api/deployments/{id}`, `POST /.xd-pages/api/versions/{id}/rollback`, required `Idempotency-Key`, same key + same request hash returning the same deployment, same key + different request hash returning 409, immutable version creation, route generation bump, active version switch, route snapshot write, and rollback preserving historical version records.

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test apps/pages-api/src/deployments.test.js apps/pages-api/src/route-snapshot.test.js`

Expected: FAIL because routes do not exist.

- [ ] **Step 3: Implement deployment and rollback routes**

Implement M3 fake uploader/status flow that creates `succeeded` deployments and versions, then writes an immutable snapshot and pointer through `env.ROUTE_SNAPSHOTS` or a test adapter. Keep provider call isolated so M5 can replace it with real WFP upload.

- [ ] **Step 4: Run deployment tests**

Run: `node --test apps/pages-api/src/deployments.test.js apps/pages-api/src/route-snapshot.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/pages-api/src/deployments.js apps/pages-api/src/deployments.test.js apps/pages-api/src/route-snapshot.js apps/pages-api/src/route-snapshot.test.js apps/pages-api/src/index.js
git commit -m "feat(api): 增加部署版本和回滚接口"
```

### Task 7: OpenAPI And Full Verification

**Files:**

- Create: `apps/pages-api/src/openapi.js`
- Modify: `apps/pages-api/src/index.js`
- Test: `apps/pages-api/src/openapi.test.js`
- Modify: `docs/pages-v2-wfp-architecture.md` only if API path details changed during implementation.

- [ ] **Step 1: Write failing OpenAPI tests**

Tests must assert `GET /.xd-pages/api/openapi.json` returns only v2 `api.pages.xd.team` / `api-staging.pages.xd.team` servers, includes sites/access-keys/deployments/versions endpoints, and does not contain `workers.xd.team`, `X-Pages-Token`, real Cloudflare ids, or SSO secrets.

- [ ] **Step 2: Run tests to verify RED**

Run: `node --test apps/pages-api/src/openapi.test.js`

Expected: FAIL because OpenAPI route does not exist.

- [ ] **Step 3: Implement OpenAPI skeleton**

Expose a minimal but accurate OpenAPI document generated from `readApiConfig`.

- [ ] **Step 4: Run focused and full checks**

Run:

```bash
node --test apps/pages-api/src/**/*.test.js
pnpm test
pnpm lint
pnpm exec prettier --check apps/pages-api docs/pages-v2-wfp-architecture.md docs/superpowers/plans/2026-06-15-pages-v2-api-control-plane.md
git ls-files --error-unmatch docs/xd-sso.md
```

Expected: first four commands PASS; final command FAIL because `docs/xd-sso.md` remains untracked.

- [ ] **Step 5: Review and commit**

Use a subagent review or local code-review pass focused on P0/P1 security issues: secret leakage, v1 compatibility leaks, environment mixing, idempotency holes, access-key plaintext leaks, and docs/OpenAPI mismatch.

```bash
git add apps/pages-api docs/superpowers/plans/2026-06-15-pages-v2-api-control-plane.md
git commit -m "docs(api): 记录 pages v2 控制面实施计划"
```

## Self-Review

- Spec coverage: covers M3 schema, sites, deployments, versions, rollback, access keys, D1 authority, KV route snapshot, v2-only OpenAPI, and legacy token rejection.
- Placeholder scan: no `TBD`, `TODO`, or secret values are included.
- Type consistency: uses `siteId`, `siteUuid`, `routeId`, `versionId`, `deploymentId`, `accessKeyId`, `policyVersion`, and `routeGeneration` consistently with the architecture document.
- Risk: real WFP upload is intentionally deferred to M5, but M3 preserves the deployment/version/route state machine boundary needed for M5.
