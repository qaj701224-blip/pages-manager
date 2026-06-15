# Pages v2 WFP Publish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the M3 fake deployment record path with a real Workers for Platforms publishing provider that uploads user Worker artifacts before activating route snapshots.

**Architecture:** Add `packages/wfp-client` as the only module that knows Cloudflare Workers for Platforms REST endpoints. `apps/pages-api` calls this provider after idempotency creation and before route activation: pending -> uploading -> uploaded -> verified -> activating -> succeeded. CLI sends a deterministic artifact bundle so `pages-api` can upload custom Worker modules or generated static/SPA Workers without exposing Cloudflare credentials to users.

**Tech Stack:** Cloudflare Workers, JavaScript ESM, Node `node:test`, Fetch API, FormData/Blob, D1-compatible store.

---

## Scope Notes

- Do not stage or commit `docs/xd-sso.md`.
- Do not change v1 `apps/server`.
- Cloudflare API token exists only in `pages-api` runtime and never in CLI, User Worker, docs, `.pages.json`, tests, or snapshots.
- `pages-api` must validate `WFP_DISPATCH_NAMESPACE` against `PAGES_ENV`.
- Route activation happens only after WFP upload and verify succeed.
- Failed upload/verify must leave previous active route unchanged.
- Rollback does not re-upload; it reuses existing immutable version and active route switch path.

## File Map

- Create `packages/wfp-client/package.json`.
- Create `packages/wfp-client/src/index.js`: WFP config validation, multipart upload, script get/delete helpers.
- Create `packages/wfp-client/src/index.test.js`.
- Create `apps/pages-api/src/wfp-provider.js`: injectable provider wrapper used by deployments.
- Modify `apps/pages-api/src/deployments.js`: read artifact bundle, upload before version creation/activation, add status transitions and failure handling.
- Modify `apps/pages-api/src/deployments.test.js`: upload/verify/activation ordering, failure behavior, env isolation.
- Modify `apps/pages-cli/src/artifact.js`: build artifact bundles for worker/static/spa.
- Modify `apps/pages-cli/src/commands.js`: send artifact bundle to deployments API.
- Modify CLI tests.
- Update docs for M5 behavior and env vars.

---

### Task 1: WFP Client Package

**Files:**

- Create: `packages/wfp-client/package.json`
- Create: `packages/wfp-client/src/index.js`
- Test: `packages/wfp-client/src/index.test.js`

- [ ] **Step 1: Write failing tests**

Tests cover:

- production requires `WFP_DISPATCH_NAMESPACE=pages-production`.
- staging requires `WFP_DISPATCH_NAMESPACE=pages-staging`.
- missing `CF_ACCOUNT_ID` / `CF_API_TOKEN` fail closed.
- upload uses `PUT https://api.cloudflare.com/client/v4/accounts/{account}/workers/dispatch/namespaces/{namespace}/scripts/{script}`.
- upload uses multipart `metadata` with `main_module`, `compatibility_date`, `tags`.
- API errors are redacted and do not include token.

- [ ] **Step 2: Run RED**

Run: `node --test packages/wfp-client/src/index.test.js`

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement WFP client**

Implement `readWfpConfig`, `createWfpClient`, `uploadUserWorker`, `getUserWorker`, `deleteUserWorker`, `WfpApiError`, and script-name validation.

- [ ] **Step 4: Run tests**

Run: `node --test packages/wfp-client/src/index.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/wfp-client
git commit -m "feat(wfp): 增加 Workers for Platforms client"
```

### Task 2: API Deployment Provider And Status Machine

**Files:**

- Create: `apps/pages-api/src/wfp-provider.js`
- Modify: `apps/pages-api/src/deployments.js`
- Test: `apps/pages-api/src/deployments.test.js`

- [ ] **Step 1: Write failing tests**

Tests cover:

- deploy calls provider upload before route activation.
- verify failure marks deployment failed and route remains previous state.
- upload failure marks deployment failed and no version is activated.
- successful deployment final state is `succeeded` and version artifactRef is `wfp://{namespace}/{workerName}`.
- production/staging namespace mismatch fails before upload.

- [ ] **Step 2: Run RED**

Run: `node --test apps/pages-api/src/deployments.test.js`

Expected: FAIL on missing provider behavior.

- [ ] **Step 3: Implement provider path**

Use `env.WFP_PROVIDER` in tests; otherwise create a real WFP client from runtime env. Deployment flow:

```text
create deployment pending
update uploading
provider.upload(...)
update uploaded
provider.verify(...)
update verified
create immutable version
update activating
activate route + write snapshot
update succeeded
```

If any step before route activation fails, do not create active route. If snapshot write fails after activation, restore previous route as M3 already does.

- [ ] **Step 4: Run tests**

Run: `node --test apps/pages-api/src/deployments.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/pages-api/src/wfp-provider.js apps/pages-api/src/deployments.js apps/pages-api/src/deployments.test.js
git commit -m "feat(api): 接入 WFP 发布状态机"
```

### Task 3: CLI Artifact Bundle

**Files:**

- Modify: `apps/pages-cli/src/artifact.js`
- Modify: `apps/pages-cli/src/artifact.test.js`
- Modify: `apps/pages-cli/src/commands.js`
- Modify: `apps/pages-cli/src/commands.test.js`

- [ ] **Step 1: Write failing tests**

Tests cover:

- worker file bundle sends module content and main module.
- static/spa directory bundle generates a Worker module with embedded file map and fallback behavior.
- `.pages.json`, `.git`, `node_modules` remain excluded.
- deploy request body includes `artifactBundle` but not local absolute paths.

- [ ] **Step 2: Run RED**

Run: `node --test apps/pages-cli/src/artifact.test.js apps/pages-cli/src/commands.test.js`

Expected: FAIL.

- [ ] **Step 3: Implement bundle builder**

Implement `buildArtifactBundle(targetPath, artifactKind)` returning:

```json
{
  "kind": "worker|static|spa",
  "mainModule": "worker.mjs",
  "modules": [{ "name": "worker.mjs", "content": "...", "type": "application/javascript+module" }]
}
```

For static/SPA, generate a module that serves embedded base64 assets. This is an initial WFP-compatible path; larger asset-store/R2 optimization remains a later scale task without changing CLI command shape.

- [ ] **Step 4: Run tests**

Run: `node --test apps/pages-cli/src/artifact.test.js apps/pages-cli/src/commands.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/pages-cli/src/artifact.js apps/pages-cli/src/artifact.test.js apps/pages-cli/src/commands.js apps/pages-cli/src/commands.test.js
git commit -m "feat(cli): 上传 WFP artifact bundle"
```

### Task 4: Docs And Verification

**Files:**

- Modify: `docs/pages-v2-wfp-architecture.md`
- Modify: `docs/superpowers/specs/2026-06-15-pages-v2-full-implementation-design.md`

- [ ] **Step 1: Update docs**

Document WFP env vars, namespace validation, publish state machine, artifact bundle shape, and current static/SPA generated-worker implementation.

- [ ] **Step 2: Run full verification**

Run:

```bash
pnpm test
pnpm lint
pnpm exec prettier --check apps/pages-api apps/pages-cli packages/wfp-client docs/pages-v2-wfp-architecture.md docs/superpowers/specs/2026-06-15-pages-v2-full-implementation-design.md docs/superpowers/plans/2026-06-15-pages-v2-wfp-publish.md
git ls-files --error-unmatch docs/xd-sso.md
```

Expected:

- `pnpm test`: PASS.
- `pnpm lint`: PASS.
- Prettier check: PASS.
- `git ls-files --error-unmatch docs/xd-sso.md`: FAIL, confirming the local SSO reference is not tracked.

- [ ] **Step 3: Commit**

```bash
git add docs/pages-v2-wfp-architecture.md docs/superpowers/specs/2026-06-15-pages-v2-full-implementation-design.md docs/superpowers/plans/2026-06-15-pages-v2-wfp-publish.md
git commit -m "docs(wfp): 记录 WFP 发布闭环"
```

## Self-Review

- Spec coverage: M5 upload, verify-before-activate, namespace isolation, CLI artifact transfer, rollback reuse, and failure behavior are covered.
- No placeholders: concrete files, tests, and commands are listed.
- Security: Cloudflare credentials remain `pages-api` only; v1 remains untouched.
