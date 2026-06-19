# XD Pages User Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add secure `pages.data.site` and `pages.data.user` runtime data APIs while preserving legacy site-level `pages.kv` compatibility.

**Architecture:** Extend the runtime protocol with explicit data site/user paths and storage key builders. Router signs path-matched site/user data capabilities. Gateway enforces `dataScope` and operation scopes before deriving site or user KV prefixes. Browser and Worker SDKs expose `pages.data.site/user`, with `pages.kv` as a deprecated site alias.

**Tech Stack:** Cloudflare Workers, Node.js `node:test`, TypeScript SDK built with `tsc`, pnpm workspace.

---

## File Structure

- `packages/pages-runtime-protocol/src/index.js`: Add data path constants, new error codes, operation/scope helpers, and `buildUserStorageKey`.
- `packages/pages-runtime-protocol/src/index.test.js`: Protocol tests for paths, scopes, and storage key isolation.
- `apps/kv-gateway/src/auth.js`: Validate new capability claims and path-matched data scopes while preserving legacy `/kv/*`.
- `apps/kv-gateway/src/auth.test.js`: Capability validation tests.
- `apps/kv-gateway/src/index.js`: Route legacy KV, site data, and user data operations to shared handlers with explicit data scope.
- `apps/kv-gateway/src/index.test.js`: Gateway security tests for scope mismatch, anonymous behavior, body spoofing, and storage prefixes.
- `apps/pages-router/src/index.js`: Route new runtime paths, sign site/user capabilities, inject separate Worker capability headers, and mark legacy responses deprecated.
- `apps/pages-router/src/index.test.js`: Router tests for runtime path mapping and capability claims.
- `apps/pages-router/src/platform-path.test.js`: Ensure new runtime paths remain reserved platform paths.
- `apps/pages-sdk/src/protocol.ts`: Mirror runtime protocol constants and helpers for SDK builds.
- `apps/pages-sdk/src/types.ts`: Add `PagesDataStore`, `PagesDataClient`, and deprecated `kv` aliases.
- `apps/pages-sdk/src/browser.ts`: Expose `pages.data.site/user` and deprecated `pages.kv`.
- `apps/pages-sdk/src/worker.ts`: Expose site/user data stores, read separate capability headers, and forbid env fallback for user data.
- `apps/pages-sdk/src/adapter-core.ts`: Route new data paths for custom Worker browser adapters while preserving legacy site paths.
- `apps/pages-sdk/src/internal/runtime-source.ts`: Update inlined runtime constants.
- `apps/pages-sdk/test/*.test.js`: SDK behavior and type tests.
- `apps/pages-sdk/README.md`, `apps/pages-skill/skill/references/sdk.md`, demo files, and architecture docs: Update public examples.

## Task 1: Protocol Constants and Storage Helpers

**Files:**
- Modify: `packages/pages-runtime-protocol/src/index.js`
- Modify: `packages/pages-runtime-protocol/src/index.test.js`

- [ ] **Step 1: Write failing protocol tests**

Add tests that assert:

```js
assert.equal(RUNTIME.DATA_SITE_GET_PATH, '/.xd-pages/runtime/v1/data/site/get');
assert.equal(RUNTIME.DATA_USER_SET_PATH, '/.xd-pages/runtime/v1/data/user/set');
assert.equal(GATEWAY.DATA_SITE_DELETE_PATH, '/v1/data/site/delete');
assert.equal(GATEWAY.DATA_USER_GET_PATH, '/v1/data/user/get');
assert.equal(ERROR_CODES.USER_REQUIRED, 'USER_REQUIRED');
assert.equal(scopeForDataOperation('site', 'get'), 'data:site:get');
assert.equal(scopeForDataOperation('user', 'delete'), 'data:user:delete');
```

Add storage tests:

```js
const siteKey = buildStorageKey({ siteSlug: 'q2-report', siteUuid, userKey: 'prefs/theme' });
const userKey = buildUserStorageKey({ siteSlug: 'q2-report', siteUuid, userId: 'usr_123', userKey: 'prefs/theme' });
assert.equal(siteKey, `s/q2-report--${siteUuid}/k/cHJlZnMvdGhlbWU`);
assert.equal(userKey, `s/q2-report--${siteUuid}/u/usr_123/k/cHJlZnMvdGhlbWU`);
assert.notEqual(siteKey, userKey);
```

- [ ] **Step 2: Run protocol tests and verify RED**

Run: `node --test packages/pages-runtime-protocol/src/index.test.js`

Expected: FAIL because new constants/functions are not exported.

- [ ] **Step 3: Implement protocol helpers**

Add constants, `USER_REQUIRED`, `validateUserId`, `buildUserStorageKey`, and `scopeForDataOperation(scope, operation)` in `packages/pages-runtime-protocol/src/index.js`. User IDs accept stable internal ids matching `/^[A-Za-z0-9_-]{1,128}$/`; emails are not required and are not special-cased.

- [ ] **Step 4: Run protocol tests and verify GREEN**

Run: `node --test packages/pages-runtime-protocol/src/index.test.js`

Expected: PASS.

## Task 2: Gateway Capability and Data Scope Enforcement

**Files:**
- Modify: `apps/kv-gateway/src/auth.js`
- Modify: `apps/kv-gateway/src/auth.test.js`
- Modify: `apps/kv-gateway/src/index.js`
- Modify: `apps/kv-gateway/src/index.test.js`

- [ ] **Step 1: Write failing gateway auth tests**

Add tests proving:

```js
await assert.rejects(
  verifyCapability(`Bearer ${siteDataToken}`, testEnv(), {
    requiredScope: 'data:user:get',
    requiredDataScope: 'user',
    now,
  }),
  /data scope/i
);
```

and:

```js
const verified = await verifyCapability(`Bearer ${legacyToken}`, testEnv(), {
  requiredScope: 'kv:get',
  requiredDataScope: 'legacy-site',
  now,
});
assert.equal(verified.dataScope, 'site');
```

- [ ] **Step 2: Write failing gateway behavior tests**

Add tests proving:

- `/v1/data/user/get` with site capability returns `CAPABILITY_SCOPE_DENIED`.
- `/v1/data/site/get` with user capability returns `CAPABILITY_SCOPE_DENIED`.
- `/v1/kv/get` with user capability returns `CAPABILITY_SCOPE_DENIED`.
- `/v1/data/user/get` ignores body `userId: "usr_evil"` and reads `claims.sub`.
- anonymous user get returns `{ ok: true, found: false, value: null }`.
- anonymous user set/delete returns `USER_REQUIRED`.
- legacy `/v1/kv/get` still reads the site-level storage key and returns deprecation headers.

- [ ] **Step 3: Run gateway tests and verify RED**

Run: `node --test apps/kv-gateway/src/auth.test.js apps/kv-gateway/src/index.test.js`

Expected: FAIL because data scope routing and user storage are missing.

- [ ] **Step 4: Implement gateway auth validation**

Update `verifyCapability` to accept `requiredDataScope`. Validate `apiVersion` when present, normalize legacy `/kv/*` claims to site scope only for `requiredDataScope: 'legacy-site'`, validate `dataScope`, `anonymous`, and `sub`.

- [ ] **Step 5: Implement gateway data routes**

Define route entries for legacy KV, `data/site`, and `data/user`. Use `buildStorageKey` for site/legacy and `buildUserStorageKey` for authenticated user. Return `USER_REQUIRED` for anonymous user set/delete. Return null envelope for anonymous user get. Add deprecation headers to legacy responses.

- [ ] **Step 6: Run gateway tests and verify GREEN**

Run: `node --test apps/kv-gateway/src/auth.test.js apps/kv-gateway/src/index.test.js`

Expected: PASS.

## Task 3: Router Runtime Paths and Capability Signing

**Files:**
- Modify: `apps/pages-router/src/index.js`
- Modify: `apps/pages-router/src/index.test.js`
- Modify: `apps/pages-router/src/platform-path.test.js`

- [ ] **Step 1: Write failing router tests**

Add tests proving:

- Browser `/.xd-pages/runtime/v1/data/site/get` proxies to `/v1/data/site/get` and signs `dataScope: "site"`.
- Browser `/.xd-pages/runtime/v1/data/user/get` proxies to `/v1/data/user/get` and signs `dataScope: "user"`.
- Protected unauthenticated routes redirect before gateway, so user get does not return null on protected sites.
- Dispatched user Worker receives `CF-Platform-Data-Site-Capability` and `CF-Platform-Data-User-Capability`.
- Legacy `/.xd-pages/runtime/v1/kv/get` still proxies to `/v1/kv/get` and response includes deprecation headers.

- [ ] **Step 2: Run router tests and verify RED**

Run: `node --test apps/pages-router/src/index.test.js apps/pages-router/src/platform-path.test.js`

Expected: FAIL because new paths and headers are missing.

- [ ] **Step 3: Implement router path map**

Extend runtime path mapping to include data site/user paths. Carry a `dataScope` metadata value with each mapping.

- [ ] **Step 4: Implement capability signing by data scope**

Replace generic KV scopes for new paths with `data:site:*` and `data:user:*` derived from route snapshot `kv.scopes` (`kv:get -> data:*:get`, `kv:set -> data:*:set`, `kv:delete -> data:*:delete`). Keep legacy `kv:*` scopes for legacy `/kv/*`. Add `apiVersion: 2`, `dataScope`, `sub`, and `anonymous` claims.

- [ ] **Step 5: Inject separate Worker capability headers**

On dispatch, inject `CF-Platform-Data-Site-Capability` and `CF-Platform-Data-User-Capability`. Keep `CF-Platform-KV-Capability` temporarily as a deprecated site capability for old Worker SDK users.

- [ ] **Step 6: Run router tests and verify GREEN**

Run: `node --test apps/pages-router/src/index.test.js apps/pages-router/src/platform-path.test.js`

Expected: PASS.

## Task 4: Browser SDK Data API

**Files:**
- Modify: `apps/pages-sdk/src/protocol.ts`
- Modify: `apps/pages-sdk/src/types.ts`
- Modify: `apps/pages-sdk/src/browser.ts`
- Modify: `apps/pages-sdk/test/browser.test.js`
- Modify: `apps/pages-sdk/test/types.test.js`

- [ ] **Step 1: Write failing browser SDK tests**

Add tests proving:

- `createPagesClient().data.site.get('app/config')` posts to `/.xd-pages/runtime/v1/data/site/get`.
- `createPagesClient().data.user.set('draft', value)` posts to `/.xd-pages/runtime/v1/data/user/set`.
- `createPagesClient().kv.get('app/config')` still posts to legacy `/.xd-pages/runtime/v1/kv/get`.
- Type tests accept `client.data.site` and `client.data.user`, and mark `client.kv` as available.

- [ ] **Step 2: Build and run SDK browser tests and verify RED**

Run: `pnpm --filter @xd/pages-sdk build && node --test apps/pages-sdk/test/browser.test.js apps/pages-sdk/test/types.test.js`

Expected: FAIL because `data` is missing.

- [ ] **Step 3: Implement browser SDK data stores**

Create a shared store factory that takes get/set/delete paths. Return `{ data: { site, user }, kv: legacySiteStore }`. Add TypeScript `@deprecated` JSDoc for `kv`.

- [ ] **Step 4: Build and run SDK browser tests and verify GREEN**

Run: `pnpm --filter @xd/pages-sdk build && node --test apps/pages-sdk/test/browser.test.js apps/pages-sdk/test/types.test.js`

Expected: PASS.

## Task 5: Worker SDK Data API and Adapter

**Files:**
- Modify: `apps/pages-sdk/src/worker.ts`
- Modify: `apps/pages-sdk/src/adapter-core.ts`
- Modify: `apps/pages-sdk/src/internal/runtime-source.ts`
- Modify: `apps/pages-sdk/test/worker.test.js`
- Modify: `apps/pages-sdk/test/adapter.test.js`
- Modify: `apps/pages-sdk/test/inline.test.js`

- [ ] **Step 1: Write failing Worker SDK tests**

Add tests proving:

- `runtime.data.site.get` uses `CF-Platform-Data-Site-Capability`.
- `runtime.data.site.get` can fall back to `env.XD_PAGES_DATA_SITE_CAPABILITY`; if only legacy `env.XD_PAGES_KV_CAPABILITY` exists, it uses the legacy `/v1/kv/*` path as a site-level compatibility fallback.
- `runtime.data.user.get` uses only `CF-Platform-Data-User-Capability`.
- `runtime.data.user.get` rejects when only env static capability exists.
- `runtime.kv` remains legacy site-level.

- [ ] **Step 2: Write failing adapter tests**

Add tests proving custom Worker `handlePagesRuntimeRequest` handles new data site/user runtime paths and still handles legacy KV paths.

- [ ] **Step 3: Build and run Worker SDK tests and verify RED**

Run: `pnpm --filter @xd/pages-sdk build && node --test apps/pages-sdk/test/worker.test.js apps/pages-sdk/test/adapter.test.js apps/pages-sdk/test/inline.test.js`

Expected: FAIL because new data API and paths are missing.

- [ ] **Step 4: Implement Worker SDK data stores**

Add separate capability readers. Site store may use request site header, then env site capability, then legacy env capability through the legacy KV path. User store must only use request user header. Use gateway data paths for new stores when a data capability exists and legacy KV paths for deprecated `kv`.

- [ ] **Step 5: Update adapter runtime dispatch**

Map new data paths to the matching `runtime.data.site` or `runtime.data.user` store. Keep legacy paths mapped to `runtime.kv`.

- [ ] **Step 6: Build and run Worker SDK tests and verify GREEN**

Run: `pnpm --filter @xd/pages-sdk build && node --test apps/pages-sdk/test/worker.test.js apps/pages-sdk/test/adapter.test.js apps/pages-sdk/test/inline.test.js`

Expected: PASS.

## Task 6: Docs, Demo, and Public References

**Files:**
- Modify: `apps/pages-sdk/README.md`
- Modify: `apps/pages-skill/skill/references/sdk.md`
- Modify: `demo/xd-pages-kv-smoke/src/app.js`
- Modify: `docs/pages-v2-wfp-architecture.md`

- [ ] **Step 1: Update public examples**

Replace primary `pages.kv` examples with `pages.data.site` and add a short `pages.data.user` example. Keep one migration note that says `pages.kv` is deprecated and equivalent to `pages.data.site`.

- [ ] **Step 2: Search for stale examples**

Run: `rg -n "pages\\.kv|site\\.kv|user\\.kv|runtime/v1/kv" apps/pages-sdk apps/pages-skill demo/xd-pages-kv-smoke docs/pages-v2-wfp-architecture.md`

Expected: Only migration notes, legacy protocol explanations, and tests should mention old paths/API.

## Task 7: Full Verification

**Files:**
- No code changes expected.

- [ ] **Step 1: Run focused data test set**

Run: `pnpm --filter @xd/pages-sdk build && node --test packages/pages-runtime-protocol/src/index.test.js apps/kv-gateway/src/auth.test.js apps/kv-gateway/src/index.test.js apps/pages-router/src/index.test.js apps/pages-router/src/platform-path.test.js apps/pages-sdk/test/browser.test.js apps/pages-sdk/test/worker.test.js apps/pages-sdk/test/adapter.test.js apps/pages-sdk/test/inline.test.js apps/pages-sdk/test/types.test.js`

Expected: PASS.

- [ ] **Step 2: Run lint**

Run: `pnpm lint`

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run: `pnpm test`

Expected: PASS.
