# Public CLI And S2S API Implementation Plan

> **For agentic workers:** Execute this plan task-by-task with test-first changes and review checkpoints.

**Goal:** Allow all authenticated callers of public `pages-api` management routes, including XD Cell CLI and XDMaker S2S, to call their current endpoints from the public internet over HTTPS without changing credentials or protocol behavior. Keep existing IP allowlist enforcement on `pages-router` subsite access and `pages-console`.

**Architecture:** Reject non-HTTPS requests at the `pages-api` Worker entry, then route all API paths through their existing authentication and authorization handlers. Public S2S requests continue through the existing HMAC/timestamp/nonce/rate-limit handler, internal hosts keep their service-binding boundary, `pages-router` remains responsible for subsite IP allowlist enforcement, and `pages-console` keeps its current network gate.

**Tech Stack:** Cloudflare Workers, JavaScript, `node:test`, pnpm.

---

### Task 1: Lock The Public API And HTTPS Contract With Tests

**Files:**
- Modify: `apps/pages-api/src/index.test.js`

- [ ] Replace the old expectation that an off-network CLI request returns `IP_NOT_ALLOWED` with an authenticated off-network `GET /.xd-pages/api/sites` request that succeeds.
- [ ] Replace the old expectation that an off-network signed S2S request is rejected by IP with an expectation that the unchanged request reaches the existing handler and returns `201`.
- [ ] Add coverage showing an off-network management path such as `GET /.xd-pages/api/access-keys` reaches authentication and returns `PAGES_AUTH_REQUIRED`, not `IP_NOT_ALLOWED`.
- [ ] Add coverage showing production HTTP returns `HTTPS_REQUIRED` before auth/store access and local HTTP remains available.
- [ ] Run `node --test apps/pages-api/src/index.test.js` and confirm the new public-lane assertions fail against the current blanket IP guard.

### Task 2: Implement HTTPS-Only API Entry

**Files:**
- Modify: `apps/pages-api/src/index.js`

- [ ] Reject non-HTTPS requests with the fixed `HTTPS_REQUIRED` response before legacy-token, IP, auth, store, or business handling.
- [ ] Keep public docs, health, local mode, and internal-host behavior unchanged.
- [ ] Remove `pages-api` request-time IP enforcement; do not change `pages-router` IP enforcement.
- [ ] Run `node --test apps/pages-api/src/index.test.js` and confirm all API paths use authentication rather than source-IP checks.

### Task 2A: Reduce Unauthenticated S2S Audit Amplification

**Files:**
- Modify: `apps/pages-api/src/s2s-auth.js`
- Modify: `apps/pages-api/src/s2s-tokens.js`
- Test: `apps/pages-api/src/s2s-tokens.test.js`

- [ ] Skip per-request D1 audit writes until the request passes HMAC verification, even when it uses a registered `clientId/keyId`.
- [ ] Keep replay, rate-limit, and authenticated business-deny audits unchanged.
- [ ] Run `node --test apps/pages-api/src/s2s-tokens.test.js` and confirm all existing S2S contract tests pass.

### Task 3: Synchronize Security And Operations Documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `README.md`
- Modify: `docs/api-boundary.md`
- Modify: `docs/architecture/publishing-and-runtime.md`
- Modify: `docs/operations/resources-and-deployment.md`
- Modify: `apps/pages-api/src/openapi.js`

- [ ] Document that all `pages-api` API routes are public-network reachable, authenticated, and HTTPS-only.
- [ ] Document that IP allowlist enforcement remains on `pages-router` subsite access and `pages-console`, not `pages-api` API requests.
- [ ] Remove the obsolete claim that S2S must pass the company IP allowlist while preserving all HMAC and compatibility requirements.
- [ ] Keep the router/site IP allowlist documentation unchanged.

### Task 4: Verify The Change

**Files:**
- Test: `apps/pages-api/src/index.test.js`
- Test: `apps/pages-api/src/s2s-auth.test.js`
- Test: `apps/pages-api/src/s2s-tokens.test.js`
- Test: `apps/pages-api/src/openapi.test.js`

- [ ] Run the focused Pages API tests.
- [ ] Run `pnpm lint`.
- [ ] Run `pnpm test`.
- [ ] Review the final diff for accidental route expansion, environment mixing, or S2S contract changes.
