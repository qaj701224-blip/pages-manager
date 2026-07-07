# Normal Worker Drain Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire `normal-worker-slot` as a provisioning/deployment path while preserving active legacy routes and letting admins delete idle ordinary Workers safely.

**Architecture:** New deployments are WFP-only. Router config renders service bindings only for active legacy normal Worker routes. Admin Console owns idle normal Worker deletion through admin-only API checks and D1 audit state.

**Tech Stack:** Node.js ESM, `node:test`, Cloudflare Workers, D1 store helpers, React console UI.

---

### Task 1: Freeze Normal Slot Workflow

**Files:**
- Modify: `.github/workflows/deploy-pages-v2.yml`
- Modify: `.github/workflows/deploy-pages-v2-staging.yml`
- Modify: `.github/workflows/expand-pages-router-slots.yml`
- Modify: `scripts/workflows.test.js`

- [x] Add failing workflow tests that reject `prepare`, `activate`, `cleanup`, and `operation=expand`.
- [x] Replace deploy workflow slot prepare/activate steps with read-only legacy binding computation.
- [x] Convert the slot maintenance workflow to read-only audit, or remove write operations.
- [x] Run `node --test scripts/workflows.test.js`.

### Task 2: Render Only Active Legacy Bindings

**Files:**
- Modify: `scripts/render-pages-v2-wrangler.mjs`
- Modify: `scripts/render-pages-v2-wrangler.test.js`
- Modify: `scripts/provision-pages-v2-slots.mjs`
- Modify: `scripts/provision-pages-v2-slots.test.js`

- [x] Add failing renderer test for a sparse `PAGES_NORMAL_WORKER_SLOT_BINDINGS_JSON` list.
- [x] Add failing audit script test that reads only active `normal-worker-slot` routes.
- [x] Render explicit service bindings and keep empty binding output valid in WFP mode.
- [x] Run `node --test scripts/render-pages-v2-wrangler.test.js scripts/provision-pages-v2-slots.test.js`.

### Task 3: Enforce WFP-Only Deployments

**Files:**
- Modify: `apps/pages-api/src/execution-provider.js`
- Modify: `apps/pages-api/src/deployments.js`
- Modify: `apps/pages-api/src/deployments.test.js`

- [x] Add failing test that a site override of `normal-worker-slot` still deploys through WFP.
- [x] Add failing test that rollback to a normal-slot version is rejected.
- [x] Make deploy provider selection ignore legacy normal-slot overrides for new writes.
- [x] Run focused deployment tests.

### Task 4: Add Admin Normal Workers API

**Files:**
- Modify: `apps/pages-api/src/admin.js`
- Modify: `apps/pages-api/src/store.js`
- Modify: `apps/pages-api/src/test-store.js`
- Modify: `apps/pages-api/src/admin.test.js`
- Add migration if persistent audit/status columns are needed.

- [x] Add failing admin list/delete tests for active vs idle Worker slots.
- [x] Add store helpers for listing legacy slot health and marking idle Workers `retired`.
- [x] Implement admin-only endpoints under `/api/console/admin/normal-workers`.
- [x] Run `node --test apps/pages-api/src/admin.test.js apps/pages-api/src/store.test.js`.

### Task 5: Add Console Entry

**Files:**
- Modify: `apps/pages-console/src/ui/pages/Admin.jsx`
- Add: `apps/pages-console/src/ui/pages/AdminNormalWorkers.jsx`
- Modify: `apps/pages-console/src/ui/api.js`
- Modify: `apps/pages-console/src/ui/admin-management-actions.test.js`

- [x] Add failing source tests for navigation, API helpers, and delete action guard text.
- [x] Implement table view with Active / Idle / Cleanup pending / Missing / Orphan / Retired labels.
- [x] Wire delete action to the admin API.
- [x] Run `node --test apps/pages-console/src/ui/admin-management-actions.test.js`.

### Task 6: Verify

- [x] Run focused tests for scripts, pages-api, and pages-console.
- [x] Run `pnpm lint` if time and dependency state allow.
- [x] Document any intentionally deferred follow-up.
