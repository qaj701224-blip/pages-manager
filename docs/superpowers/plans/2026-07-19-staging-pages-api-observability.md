# Pages API Staging Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persistently enable 100% Workers Observability logs for `pages-api-staging` without changing production or other Worker templates.

**Architecture:** Keep the deployment path unchanged and express the setting directly in the existing Pages API staging Wrangler template. Lock the rendered output with the existing staging template test so later deploy changes cannot silently remove Observability.

**Tech Stack:** Wrangler TOML, Node.js `node:test`, pnpm.

---

### Task 1: Enable staging Pages API Observability

**Files:**
- Modify: `scripts/render-pages-v2-wrangler.test.js:202`
- Modify: `apps/pages-api/wrangler.staging.template.toml:1`

- [x] **Step 1: Replace the staging no-Observability assertion with the required block**

In `scripts/render-pages-v2-wrangler.test.js`, change the staging Pages API assertion to:

```js
assert.match(config, /\[observability\.logs\]\nenabled = true\nhead_sampling_rate = 1/);
```

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
node --test scripts/render-pages-v2-wrangler.test.js
```

Expected: FAIL in `staging pages-api config renders explicit staging template values` because the rendered staging template does not contain `[observability.logs]`.

- [x] **Step 3: Add the minimal staging Wrangler configuration**

After `workers_dev = false` in `apps/pages-api/wrangler.staging.template.toml`, add:

```toml
[observability.logs]
enabled = true
head_sampling_rate = 1
```

- [x] **Step 4: Run the focused test and verify GREEN**

Run:

```bash
node --test scripts/render-pages-v2-wrangler.test.js
```

Expected: all render tests pass.

### Task 2: Repository verification and PR update

**Files:**
- Verify: `apps/pages-api/wrangler.staging.template.toml`
- Verify: `scripts/render-pages-v2-wrangler.test.js`
- Include: `docs/superpowers/specs/2026-07-19-staging-pages-api-observability-design.md`
- Include: `docs/superpowers/plans/2026-07-19-staging-pages-api-observability.md`

- [x] **Step 1: Run repository verification**

Run:

```bash
pnpm lint
pnpm test
git diff --check
```

Expected: lint has zero errors, all tests pass, and the diff check is clean.

- [ ] **Step 2: Commit the implementation**

Run:

```bash
git add apps/pages-api/wrangler.staging.template.toml \
  scripts/render-pages-v2-wrangler.test.js \
  docs/superpowers/plans/2026-07-19-staging-pages-api-observability.md
git commit -m "fix(pages-api): 启用 staging observability 日志"
```

- [ ] **Step 3: Push the existing PR branch**

Run:

```bash
git push origin codex/public-runtime-vars-api
```

Expected: PR #145 updates without changing its base branch or draft state.

- [ ] **Step 4: Verify staging after deployment**

Wait for `Sync Master PR To Staging` and `Deploy XD Cell Staging` to pass. Confirm `pages-api-staging` Observability is enabled, start a live query for `pages_runtime_config_failure`, then run one temporary vars PUT followed by DELETE cleanup.
