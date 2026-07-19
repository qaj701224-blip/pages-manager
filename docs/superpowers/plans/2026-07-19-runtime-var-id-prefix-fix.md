# Runtime Var ID Prefix Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复公网与 Console runtime vars 对长 binding name 返回 503 的问题，并准确标记同步 D1 statement 构造失败。

**Architecture:** vars handler 不再负责数据库记录 ID，统一由 `D1PagesStore` 的现有 `randomStoreId('var')` 生成。D1 store 在保持 quota、revision 和错误优先级不变的前提下，把 statement factory 的同步异常标记为闭集阶段 `statement_build`。

**Tech Stack:** JavaScript ES modules、Cloudflare Workers D1、`node:test`、pnpm。

---

### Task 1: Runtime var ID ownership

**Files:**
- Modify: `apps/pages-api/src/sites.test.js`
- Modify: `apps/pages-api/src/console.test.js`
- Modify: `apps/pages-api/src/sites.js`
- Modify: `apps/pages-api/src/console.js`

- [ ] **Step 1: Write failing public and Console regression tests**

For each handler, wrap the test store's real mutation method so the wrapper executes an optional handler-provided factory before delegating:

```js
const mutateSiteVar = store.mutateSiteVar.bind(store);
store.mutateSiteVar = async (input) => {
  input.createId?.(input.name);
  return mutateSiteVar(input);
};
```

PUT `CODEX_STAGING_VARS_DIAG_20260719_02` through the public route and `LONG_RUNTIME_CONFIGURATION_NAME` through the Console route. Assert status 200 and the expected name/revision. Old code must return 503 because the callback reaches `newId()` with an invalid name-derived prefix.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test --test-name-pattern='long runtime var names' apps/pages-api/src/sites.test.js apps/pages-api/src/console.test.js
```

Expected: both new tests fail with status 503 instead of 200.

- [ ] **Step 3: Remove handler-owned ID factories**

Delete only these properties from the two `store.mutateSiteVar()` calls:

```js
createId: (bindingName) => nextId(env, `var${bindingName.toLowerCase().replace(/[^a-z0-9]/g, '') || 'runtime'}`),
```

The D1 store already falls back to:

```js
input.createId ? input.createId(input.name) : randomStoreId('var')
```

- [ ] **Step 4: Verify GREEN**

Run the command from Step 2. Expected: both tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/pages-api/src/sites.js apps/pages-api/src/sites.test.js apps/pages-api/src/console.js apps/pages-api/src/console.test.js
git commit -m "fix(pages-api): 修复长名称 runtime var 写入"
```

### Task 2: Statement build diagnostics

**Files:**
- Modify: `apps/pages-api/src/runtime-config-diagnostics.js`
- Modify: `apps/pages-api/src/runtime-config-diagnostics.test.js`
- Modify: `apps/pages-api/src/store.js`
- Modify: `apps/pages-api/src/store.test.js`

- [ ] **Step 1: Write failing closed-schema and store tests**

Add `statement_build` to the expected safe stages in diagnostics tests. In store tests inject a sentinel failure from these factories and assert the same error is rethrown with:

```js
assert.deepEqual(readRuntimeConfigErrorDiagnostic(error), {
  stage: 'statement_build',
  reason: 'store_operation_failed',
});
```

Cover var PUT (`siteVarInsertStatement`), var DELETE (`siteVarDeleteStatement`), audited secret PUT (`siteSecretInsertStatement`), and audited secret DELETE (the matching `db.prepare()` call). Do not include SQL, binding values, or Error messages in emitted diagnostics.

- [ ] **Step 2: Verify RED**

Run:

```bash
node --test apps/pages-api/src/runtime-config-diagnostics.test.js apps/pages-api/src/store.test.js
```

Expected: new assertions report `revision_read`, `bindings_read`, or `unknown` instead of `statement_build`.

- [ ] **Step 3: Implement the closed stage and mark statement factories**

Add the fixed value to `STAGES`:

```js
'statement_build',
```

In `mutateSiteVar()`, `putSiteSecretWithAudit()`, and `deleteSiteSecretWithAudit()`, set:

```js
diagnosticStage = 'statement_build';
```

immediately before each synchronous statement factory. Preserve existing quota validation order. Set `diagnosticStage = 'mutation_batch'` only after all statements have been constructed and immediately before awaiting `run()` or `batch()`.

- [ ] **Step 4: Verify GREEN**

Run the command from Step 2. Expected: all diagnostics and store tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/pages-api/src/runtime-config-diagnostics.js apps/pages-api/src/runtime-config-diagnostics.test.js apps/pages-api/src/store.js apps/pages-api/src/store.test.js
git commit -m "fix(pages-api): 准确标记 runtime statement 构造失败"
```

### Task 3: Repository and staging verification

**Files:**
- No additional code files.

- [ ] **Step 1: Run focused tests**

```bash
node --test apps/pages-api/src/runtime-config-diagnostics.test.js apps/pages-api/src/store.test.js apps/pages-api/src/sites.test.js apps/pages-api/src/console.test.js
```

Expected: all focused tests pass.

- [ ] **Step 2: Run repository checks**

```bash
pnpm lint
pnpm test
git diff --check
```

Expected: lint has zero errors, all tests pass, and diff check is clean.

- [ ] **Step 3: Push and verify staging**

Push `codex/public-runtime-vars-api`, wait for PR staging sync/deploy, then PUT `CODEX_STAGING_VARS_DIAG_20260719_02` with the authorized staging access key. Expected: HTTP 200, response omits the value, and DELETE cleanup returns HTTP 200.
