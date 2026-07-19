# Runtime Config Error Diagnostics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one safe structured Workers log for each unexpected runtime config store or provider failure without changing public API responses or exposing request values.

**Architecture:** A focused diagnostics module owns the closed log schema, safe enum fallback, store error stage marker, and `console.error` isolation. D1 store methods attach only safe stage/reason metadata before rethrowing; public and Console handlers plus shared provider sync helpers own the single log emission boundary.

**Tech Stack:** JavaScript ES modules, Cloudflare Workers, D1 prepared statements, `node:test`, pnpm.

---

### Task 1: Safe diagnostics module

**Files:**
- Create: `apps/pages-api/src/runtime-config-diagnostics.js`
- Create: `apps/pages-api/src/runtime-config-diagnostics.test.js`

- [x] **Step 1: Write failing closed-schema and logger-isolation tests**

Test `logRuntimeConfigFailure()` with malicious values for every field and a logger that captures its sole string argument. Assert the parsed object has exactly `event`, `operation`, `environment`, `siteId`, `stage`, `reason`, and `errorCode`; invalid fields become `unknown`. Add a second test whose logger throws and assert the helper does not throw.

```js
const logs = [];
logRuntimeConfigFailure(
  { logRuntimeConfigFailure: (line) => logs.push(line) },
  {
    operation: 'var_put\nSECRET_VALUE',
    environment: 'staging\nAuthorization',
    siteId: 'site_1\nTOKEN',
    stage: 'mutation_batch\nSQL',
    reason: 'schema_missing\nSTACK',
    errorCode: 'RUNTIME_CONFIG_UNSUPPORTED\nCAUSE',
  }
);
assert.deepEqual(JSON.parse(logs[0]), {
  event: 'pages_runtime_config_failure',
  operation: 'unknown',
  environment: 'unknown',
  siteId: 'unknown',
  stage: 'unknown',
  reason: 'unknown',
  errorCode: 'unknown',
});
```

- [x] **Step 2: Run the diagnostics test and verify RED**

Run: `node --test apps/pages-api/src/runtime-config-diagnostics.test.js`

Expected: FAIL because `runtime-config-diagnostics.js` does not exist.

- [x] **Step 3: Implement the closed schema and internal marker**

Implement these exports:

```js
export function logRuntimeConfigFailure(env, input) {}
export function markRuntimeConfigError(error, { stage, reason } = {}) {}
export function readRuntimeConfigErrorDiagnostic(error, fallback = {}) {}
```

Use fixed `Set` allowlists from the approved design. `logRuntimeConfigFailure()` must call `JSON.stringify()` on a newly constructed plain object and pass only that string to `env.logRuntimeConfigFailure` in tests or `console.error` in production, inside `try/catch`. Use a private module `Symbol` for store diagnostics. `markRuntimeConfigError()` may inspect an error message internally to map `no such table/column`, constraint, and busy/locked failures, but it must never copy the message, Error, cause, stack, constructor, name, code, SQL, or bind parameters into the diagnostic object or log.

- [x] **Step 4: Run the diagnostics tests and verify GREEN**

Run: `node --test apps/pages-api/src/runtime-config-diagnostics.test.js`

Expected: all diagnostics tests pass.

### Task 2: D1 mutation stage propagation

**Files:**
- Modify: `apps/pages-api/src/store.js`
- Modify: `apps/pages-api/src/store.test.js`

- [x] **Step 1: Write failing stage propagation tests**

Wrap `fakeRuntimeConfigDb()` so `batch()` throws an Error whose message and cause contain secret sentinels. Assert `mutateSiteVar()` rethrows the same public error semantics while `readRuntimeConfigErrorDiagnostic(error)` returns only:

```js
{ stage: 'mutation_batch', reason: 'store_operation_failed' }
```

Add focused checks for lock acquisition (`lock_acquire`), missing schema classification (`schema_missing`), and audited secret mutation batch failures.

- [x] **Step 2: Run store tests and verify RED**

Run: `node --test apps/pages-api/src/store.test.js`

Expected: new diagnostic assertions fail because store errors have no safe stage marker.

- [x] **Step 3: Mark stages without changing error messages**

In `mutateSiteVar()`, `putSiteSecretWithAudit()`, and `deleteSiteSecretWithAudit()`, track these fixed stages immediately before each awaited boundary:

```js
let diagnosticStage = 'lock_acquire';
diagnosticStage = 'route_state_read';
diagnosticStage = 'bindings_read';
diagnosticStage = 'revision_read';
diagnosticStage = 'mutation_batch';
diagnosticStage = 'post_commit_read';
```

Catch only to call `markRuntimeConfigError(error, { stage: diagnosticStage })` and rethrow it. Preserve existing expected error messages and best-effort lock release behavior.

- [x] **Step 4: Run store tests and verify GREEN**

Run: `node --test apps/pages-api/src/store.test.js`

Expected: all store tests pass.

### Task 3: Public and Console mutation logs

**Files:**
- Modify: `apps/pages-api/src/sites.js`
- Modify: `apps/pages-api/src/sites.test.js`
- Modify: `apps/pages-api/src/console.js`
- Modify: `apps/pages-api/src/console.test.js`

- [x] **Step 1: Write failing handler log tests**

For public PUT/DELETE and Console mutation handlers, cover:

```js
const lines = [];
env.logRuntimeConfigFailure = (line) => lines.push(line);
store.mutateSiteVar = async () => {
  const error = new Error('SECRET_VALUE SQL Authorization Bearer');
  error.name = 'SECRET_NAME';
  error.code = 'SECRET_CODE';
  error.cause = new Error('SECRET_CAUSE');
  throw markRuntimeConfigError(error, { stage: 'mutation_batch', reason: 'store_operation_failed' });
};
```

Assert the existing 503 body is unchanged, exactly one safe log is emitted, and the serialized log contains none of the request/header/error sentinels. Add capability-missing logging, expected quota/conflict/409 zero-log coverage, and a logger-throws case whose response remains byte-for-byte unchanged.

- [x] **Step 2: Run handler tests and verify RED**

Run: `node --test apps/pages-api/src/sites.test.js apps/pages-api/src/console.test.js`

Expected: new log assertions fail because handlers do not emit diagnostics.

- [x] **Step 3: Add one log at each handler ownership boundary**

Before capability 503 responses call `logRuntimeConfigFailure()` with `capability_check/capability_unavailable`. In mutation catches, first build the existing response; only when it is a 5xx response, read the safe store diagnostic and log `RUNTIME_CONFIG_UNSUPPORTED`. Do not pass the original Error to the logger and do not log expected 4xx/409 responses.

- [x] **Step 4: Run handler tests and verify GREEN**

Run: `node --test apps/pages-api/src/sites.test.js apps/pages-api/src/console.test.js`

Expected: all handler tests pass with unchanged response bodies.

### Task 4: Provider sync logs and verification

**Files:**
- Modify: `apps/pages-api/src/sites.js`
- Modify: `apps/pages-api/src/sites.test.js`

- [x] **Step 1: Extend existing provider failure tests and verify RED**

Extend the active Worker provider setup and request failure tests to assert exactly one log with `provider_setup/provider_configuration_failed` or `provider_sync/provider_request_failed`, the correct public 502 error code, and no provider/error/request sentinels. Assert runtime config lock conflicts still return 409 without an error log.

Run: `node --test apps/pages-api/src/sites.test.js`

Expected: provider log assertions fail.

- [x] **Step 2: Add provider log calls and verify GREEN**

In `syncActiveWfpPlainTextBindings()` and `syncActiveWfpSecret()`, emit one safe log only on existing unexpected 502 paths. Preserve the current 409 lock-conflict branches and all response text.

Run: `node --test apps/pages-api/src/sites.test.js`

Expected: all sites tests pass.

- [x] **Step 3: Run repository verification**

Run:

```bash
node --test apps/pages-api/src/runtime-config-diagnostics.test.js apps/pages-api/src/store.test.js apps/pages-api/src/sites.test.js apps/pages-api/src/console.test.js
pnpm lint
pnpm test
git diff --check
```

Expected: all tests pass, lint has zero errors, and diff check is clean.

- [ ] **Step 4: Commit and push**

```bash
git add apps/pages-api/src/runtime-config-diagnostics.js \
  apps/pages-api/src/runtime-config-diagnostics.test.js \
  apps/pages-api/src/store.js apps/pages-api/src/store.test.js \
  apps/pages-api/src/sites.js apps/pages-api/src/sites.test.js \
  apps/pages-api/src/console.js apps/pages-api/src/console.test.js \
  docs/superpowers/plans/2026-07-19-runtime-config-error-diagnostics.md
git commit -m "fix(pages-api): 增加 runtime config 异常诊断"
git push origin codex/public-runtime-vars-api
```

- [ ] **Step 5: Re-test staging after deployment**

Use the existing staging access key only as an ephemeral Bearer credential. PUT a unique temporary var on the latest active staging site, always issue DELETE for cleanup, and verify the response contains no value. If PUT still fails, use the new `pages_runtime_config_failure` log fields to identify the exact stage/reason without exposing request data.
