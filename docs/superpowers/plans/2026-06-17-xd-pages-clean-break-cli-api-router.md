# XD Pages Clean Break Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一次性收敛 XD Pages 的用户侧 CLI、API、router、visibility、ACL 和本地状态契约，去掉 staging 空数据阶段不需要背负的旧兼容心智。

**Architecture:** v1 `workers.xd.team` 继续不动；本计划只改 `pages.xd.team` 相关的 XD Pages 新架构代码。staging D1 schema 已 apply，`worker_slots` 已存在，但没有正式业务站点、route、ACL 或用户数据；本计划不改已 apply migration、不做数据迁移，通过 API/router/CLI 契约 clean break。

**Tech Stack:** Cloudflare Workers, D1, KV route snapshot, Node.js `node:test`, pnpm, Wrangler.

---

## Final Contract

User-facing product name is always `XD Pages`. Do not use `XD Pages V2` in CLI help, OpenAPI, public docs, readme, skill text, Slack alert copy, or user-facing errors. Internal filenames, branches, resource names, and architecture notes may still mention v2 where useful.

Visibility values are:

```text
internal  公司网络内免登录访问
org       公司网络内，需公司 SSO active 用户
acl       公司网络内，需命中邮箱 ACL，active owner 隐式可访问
owner     公司网络内，仅 active owner 可访问
disabled  暂停访问，任何人不可访问
```

`public` is reserved for a future network exposure model, for example:

```json
{
  "exposure": "public",
  "access": "acl"
}
```

First release does not accept `public` as a visibility value. Unknown visibility values fail closed.

CLI user-facing environments are only:

```text
production
staging
```

`custom` remains a hidden development reserve and must only allow loopback endpoints. `local` is removed from the user-facing CLI environment model.

CLI local state lives under:

```text
macOS/Linux: ~/.xd-pages/
Windows:     %APPDATA%\.xd-pages\
```

Directory shape:

```text
profileDir/
  profile.json       非敏感元信息
  credentials.json   fallback secret store，仅 fallback 时存在
  config.json        可选；开发保留项和 CLI 偏好
  cache/             可选缓存
  logs/              可选本地调试日志
```

`--config <file>` is explicit one-shot input. It is not local state, is not auto-discovered, and must not be written into `profileDir`.

## Task 1: Documentation Contract

**Files:**
- Modify: `docs/pages-v2-wfp-architecture.md`
- Modify: `docs/人工配置待办.md`

- [ ] **Step 1: Replace user-facing product name**

Search:

```bash
rg -n "XD Pages v2|XD Pages V2|Pages v2|pages v2" docs/pages-v2-wfp-architecture.md docs/人工配置待办.md
```

Expected: current matches exist.

Edit user-facing prose to say `XD Pages`. Keep internal/resource-only phrases when they clearly refer to implementation resources, branch names, or file names.

- [ ] **Step 2: Rewrite visibility section**

In `docs/pages-v2-wfp-architecture.md`, update the visibility tables and router policy section to list only:

```text
internal | org | acl | owner | disabled
```

Add this explicit router decision order:

```text
if visibility == disabled:
  deny

if visibility == internal:
  allow anonymous after IP allowlist

require site_session
require employeeStatus == active

if userId == ownerUserId:
  allow

if visibility == org:
  allow

if visibility == owner:
  deny non-owner

if visibility == acl:
  allow if any ACL email entry matches

otherwise:
  deny
```

- [ ] **Step 3: Rewrite CLI local state section**

Replace `.pages.json` as automatic project binding with:

```text
pages deploy <dir> <site>
pages deploy --config <file>
```

Document:

```text
--config <file>:
  explicit one-shot input
  no auto-discovery
  no write-back
  no profileDir mutation
  no token/access key/secret fields
```

- [ ] **Step 4: Update staging checklist**

In `docs/人工配置待办.md`, update smoke examples:

```bash
pages deploy ./dist <site> --env staging --visibility org
pages deploy ./dist <site> --env staging --access-key <access-key> --json
```

Remove `--slug`, `--save-config`, `.pages.json`, `public` visibility, and user-facing `local` SSO/CLI examples from the active staging checklist. If local SSO reference remains useful, mark it as developer-only and not part of the user CLI contract.

- [ ] **Step 5: Verify docs no longer expose old user contract**

Run:

```bash
rg -n "XD Pages v2|--slug|--save-config|\\.pages\\.json|visibility public|`public`|PAGES_ACCESS_KEY=.*pages deploy|pages env use .*local" docs/pages-v2-wfp-architecture.md docs/人工配置待办.md
```

Expected: no matches for active user-facing contract. Internal warnings such as "`public` is future exposure" are acceptable only if phrased as future/non-first-release.

## Task 2: API Visibility and Whoami Contract

**Files:**
- Modify: `apps/pages-api/src/sites.js`
- Modify: `apps/pages-api/src/index.js`
- Create: `apps/pages-api/src/whoami.js`
- Test: `apps/pages-api/src/sites.test.js`
- Test: `apps/pages-api/src/auth.test.js` or `apps/pages-api/src/whoami.test.js`

- [ ] **Step 1: Write failing visibility tests**

Add tests that create/update sites with `internal` and reject `public`.

Example assertions:

```js
assert.equal(internalBody.site.defaultVisibility, 'internal');
assert.equal(publicBody.error.code, 'SITE_VISIBILITY_INVALID');
assert.match(publicBody.error.action, /internal、org、acl、owner 或 disabled/);
```

Run:

```bash
pnpm --dir apps/pages-cli test
pnpm test -- apps/pages-api/src/sites.test.js
```

If the repo test runner does not support file filtering through `pnpm test --`, use:

```bash
node --test apps/pages-api/src/sites.test.js
```

Expected: new tests fail because API still accepts `public` and rejects `internal`.

- [ ] **Step 2: Implement API visibility clean break**

Change:

```js
const VISIBILITIES = new Set(['public', 'org', 'acl', 'owner', 'disabled']);
```

to:

```js
const VISIBILITIES = new Set(['internal', 'org', 'acl', 'owner', 'disabled']);
```

Update all `Use public, org, acl, owner, or disabled.` messages to Chinese user-facing actions:

```text
请使用 internal、org、acl、owner 或 disabled。
```

Default new-site visibility remains `org`.

- [ ] **Step 3: Write failing whoami tests**

Add `GET /.xd-pages/api/auth/whoami` tests for:

```text
cli_token -> actor.type=user, userId, environment, credentialType=cli_token
access_key -> actor.type=access_key, accessKeyId, siteId, scopes, environment, credentialType=access_key
deploy-only access key -> accepted by whoami without read:site
invalid token -> existing auth error shape
```

The response must not include token plaintext, key hash, pepper id, access key secret, or Cloudflare resource ids.

Expected failure: route does not exist.

- [ ] **Step 4: Implement `whoami` endpoint**

Create `apps/pages-api/src/whoami.js`:

```js
import { authenticateApiRequest } from './auth.js';
import { jsonOk } from './http.js';

export async function handleWhoamiApi(request, env, config, store) {
  if (new URL(request.url).pathname !== '/.xd-pages/api/auth/whoami') return null;
  if (request.method !== 'GET') {
    return new Response(JSON.stringify({ error: { code: 'METHOD_NOT_ALLOWED', message: 'Method not allowed.' } }), {
      status: 405,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  const auth = await authenticateApiRequest(request, env, store, config, readNow(env));
  if (!auth.ok) {
    return new Response(JSON.stringify({ error: auth.error }), {
      status: auth.error.status,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  return jsonOk({
    environment: config.environment,
    actor: publicActor(auth.actor),
  });
}

function publicActor(actor) {
  if (actor.type === 'access_key') {
    return {
      type: 'access_key',
      credentialType: 'access_key',
      accessKeyId: actor.tokenId,
      userId: actor.userId,
      siteId: actor.siteId || null,
      scopes: actor.scopes,
    };
  }
  return {
    type: 'user',
    credentialType: 'cli_token',
    userId: actor.userId,
    scopes: actor.scopes,
  };
}

function readNow(env) {
  return typeof env?.nowIso === 'function' ? env.nowIso() : new Date().toISOString();
}
```

Wire it in `apps/pages-api/src/index.js` before sites/access-keys/deployments:

```js
if (url.pathname.startsWith('/.xd-pages/api/auth/')) {
  const store = createPagesStore(env);
  const response = await handleWhoamiApi(request, env, config, store);
  if (response) return response;
}
```

Use existing `jsonError` helper for method errors if preferred, but preserve JSON error shape.

- [ ] **Step 5: Run API tests**

Run:

```bash
node --test apps/pages-api/src/*.test.js
```

Expected: all API tests pass.

## Task 3: Router Access Policy

**Files:**
- Modify: `apps/pages-router/src/access-policy.js`
- Test: `apps/pages-router/src/access-policy.test.js`
- Test: `apps/pages-router/src/index.test.js`

- [ ] **Step 1: Write failing router policy tests**

Replace public tests with:

```js
test('internal visibility allows anonymous access after router IP allowlist', () => {
  assert.deepEqual(evaluateAccessPolicy(route({ visibility: 'internal' }), null), {
    ok: true,
    user: null,
  });
});

test('unknown visibility fails closed', () => {
  assert.deepEqual(evaluateAccessPolicy(route({ visibility: 'public' }), null), {
    ok: false,
    code: 'SITE_POLICY_INVALID',
    status: 403,
  });
});

test('active owner is implicitly allowed for acl visibility', () => {
  const aclRoute = route({
    visibility: 'acl',
    ownerUserId: 'owner_1',
    acl: [],
  });
  assert.equal(evaluateAccessPolicy(aclRoute, activeUser({ userId: 'owner_1' })).ok, true);
});
```

Expected: tests fail because `internal` is invalid and owner bypass is missing.

- [ ] **Step 2: Implement router decision order**

Change `PROTECTED_VISIBILITIES` to:

```js
const PROTECTED_VISIBILITIES = new Set(['org', 'acl', 'owner']);
```

Use this order in `evaluateAccessPolicy`:

```js
if (visibility === 'disabled') return denied('SITE_DISABLED', 403);
if (visibility === 'internal') return { ok: true, user: identity || null };
if (!PROTECTED_VISIBILITIES.has(visibility)) return denied('SITE_POLICY_INVALID', 403);

// existing session freshness checks

if (identity.employeeStatus !== 'active') return denied('SITE_ACCESS_FORBIDDEN', 403);
if (identity.userId === route.ownerUserId) return { ok: true, user: identity };
if (visibility === 'org') return { ok: true, user: identity };
if (visibility === 'owner') return denied('SITE_ACCESS_FORBIDDEN', 403);
return aclAllows(route.acl, identity) ? { ok: true, user: identity } : denied('SITE_ACCESS_FORBIDDEN', 403);
```

Do not allow owner through `disabled`.

- [ ] **Step 3: Keep department ACL internal-only or remove from exposed tests**

If department matching remains in router as future-capable internal logic, update test names so they do not imply public API support. Public API first release only accepts `email`.

- [ ] **Step 4: Run router tests**

Run:

```bash
node --test apps/pages-router/src/*.test.js
```

Expected: all router tests pass.

## Task 4: OpenAPI and Public Docs

**Files:**
- Modify: `apps/pages-api/src/openapi.js`
- Modify: `apps/pages-api/src/public-docs.js`
- Test: `apps/pages-api/src/openapi.test.js`
- Test: `apps/pages-api/src/index.test.js`

- [ ] **Step 1: Write failing public contract tests**

Assert OpenAPI:

```js
assert.equal(spec.info.title, 'XD Pages API');
assert.deepEqual(spec.components.schemas.SiteVisibility.enum, ['internal', 'org', 'acl', 'owner', 'disabled']);
assert.doesNotMatch(JSON.stringify(spec), /XD Pages v2|--slug|--save-config|\\.pages\\.json|public.+公司网络/);
```

Assert public docs mention:

```text
pages deploy <dir> <site>
--access-key <key>
--config <file>
```

Expected: tests fail with old copy.

- [ ] **Step 2: Update user-facing docs output**

Update title and description:

```js
title: 'XD Pages API'
description: 'Control plane API for XD Pages.'
```

Update examples:

```bash
pages login
pages deploy ./dist demo --visibility org
pages deploy ./dist demo --env staging --access-key <access-key> --json
pages deploy --config pages.config.json
```

Remove `.pages.json`, `--save-config`, `PAGES_ACCESS_KEY=... pages deploy`, and `XD Pages v2` from user-facing generated docs.

- [ ] **Step 3: Run public docs tests**

Run:

```bash
node --test apps/pages-api/src/openapi.test.js apps/pages-api/src/index.test.js
```

Expected: tests pass.

## Task 5: CLI Config, ProfileDir, and Local State

**Files:**
- Modify: `apps/pages-cli/src/config.js`
- Modify: `apps/pages-cli/src/profile.js`
- Modify: `apps/pages-cli/src/secret-store.js`
- Create: `apps/pages-cli/src/command-config.js`
- Test: `apps/pages-cli/src/config.test.js`
- Test: `apps/pages-cli/src/profile.test.js`
- Test: `apps/pages-cli/src/secret-store.test.js`

- [ ] **Step 1: Write failing config/profile tests**

Expected profile dirs:

```js
assert.equal(resolveProfileDir({ platform: 'darwin', homedir: () => '/Users/alice' }), '/Users/alice/.xd-pages');
assert.equal(resolveProfileDir({ platform: 'linux', homedir: () => '/home/alice' }), '/home/alice/.xd-pages');
assert.equal(resolveProfileDir({ platform: 'win32', env: { APPDATA: 'C:\\\\Users\\\\Alice\\\\AppData\\\\Roaming' } }), 'C:\\\\Users\\\\Alice\\\\AppData\\\\Roaming\\\\.xd-pages');
```

Expected CLI environments:

```js
assert.deepEqual(Object.keys(FIXED_ENVIRONMENTS), ['production', 'staging']);
assert.throws(() => resolveEnvironment('local'), /Pages CLI environment is invalid/);
```

Expected `custom` remains accepted only as hidden development reserve:

```js
assert.equal(resolveEnvironment('custom'), 'custom');
```

- [ ] **Step 2: Implement profileDir clean break**

Change `resolveProfileDir` to:

```js
if (platform === 'win32') return path.join(env.APPDATA || path.join(homedir(), 'AppData', 'Roaming'), '.xd-pages');
return path.join(homedir(), '.xd-pages');
```

Do not use `XDG_CONFIG_HOME` for this CLI contract.

- [ ] **Step 3: Remove user-facing `local` from CLI config**

Remove `local` from `FIXED_ENVIRONMENTS`. Keep `custom` support in `resolveEnvironment` but do not expose it in help or `env list`.

Production/staging endpoints remain hardcoded and cannot be overridden.

- [ ] **Step 4: Add explicit one-shot config file reader**

Create `apps/pages-cli/src/command-config.js` with:

```js
export async function readCommandConfig(filePath, { cwd = process.cwd() } = {}) {
  if (!filePath) return null;
  const absolutePath = path.resolve(cwd, filePath);
  const parsed = JSON.parse(await readFile(absolutePath, 'utf8'));
  return validateCommandConfig(parsed);
}
```

Allowed fields:

```text
environment
site
dir
visibility
artifactKind
```

Reject secret-looking keys recursively using the same pattern as profile/project config. Reject v1 `workers.xd.team` strings. Reject unknown fields to keep AI/CI contract deterministic.

- [ ] **Step 5: Run CLI config tests**

Run:

```bash
node --test apps/pages-cli/src/config.test.js apps/pages-cli/src/profile.test.js apps/pages-cli/src/secret-store.test.js
```

Expected: tests pass.

## Task 6: CLI Command Shape and Auth

**Files:**
- Modify: `apps/pages-cli/src/args.js`
- Modify: `apps/pages-cli/src/commands.js`
- Modify: `apps/pages-cli/src/login.js`
- Modify: `apps/pages-cli/src/api-client.js`
- Modify: `apps/pages-cli/src/main.js`
- Test: `apps/pages-cli/src/args.test.js`
- Test: `apps/pages-cli/src/commands.test.js`
- Test: `apps/pages-cli/src/login.test.js`
- Test: `apps/pages-cli/src/main.test.js`

- [ ] **Step 1: Write failing positional command tests**

Add tests for:

```text
pages deploy ./dist demo
pages deploy ./dist
pages deploy ./dist demo extra
pages status demo
pages sites info demo
```

Expected:

```text
deploy requires exactly <dir> <site> unless --config provides missing fields
status requires exactly <site>
sites info requires exactly <site>
extra positional args return USAGE_INVALID
```

- [ ] **Step 2: Write failing `.pages.json` removal tests**

Create a temp cwd containing `.pages.json` with a different site and assert:

```js
await executeCommand(['deploy', '.', 'explicit-site'], ...);
```

uses `explicit-site`, does not read `.pages.json`, and does not write `.pages.json`.

- [ ] **Step 3: Write failing `--config` tests**

Given `pages.config.json`:

```json
{
  "environment": "staging",
  "site": "demo",
  "dir": "./dist",
  "visibility": "org",
  "artifactKind": "spa"
}
```

Assert:

```bash
pages deploy --config pages.config.json
```

deploys `./dist` to `demo` in staging.

Assert CLI args override config:

```bash
pages deploy ./build demo2 --config pages.config.json --env production --visibility internal
```

uses `./build`, `demo2`, `production`, `internal`.

- [ ] **Step 4: Write failing one-shot `--access-key` tests**

For API commands:

```bash
pages deploy ./dist demo --access-key xdpak_staging_ak_1_secret --env staging
```

Assert:

```text
Authorization: Bearer xdpak_staging_ak_1_secret
secretStore.get was not called
secretStore.set was not called
```

For login:

```bash
pages login --access-key xdpak_staging_ak_1_secret --env staging
```

Assert it calls `GET /.xd-pages/api/auth/whoami` before saving.

For local commands:

```bash
pages version --access-key x
pages env list --access-key x
```

Assert they fail or ignore according to the final contract. Recommended: fail with `ACCESS_KEY_NOT_USED`.

- [ ] **Step 5: Implement command parser support for subcommands**

Support:

```text
pages auth login
pages auth status
pages auth whoami
pages auth logout
pages sites list
pages sites info <site>
```

Keep `pages login` as alias for `pages auth login`.

- [ ] **Step 6: Implement credential resolution**

Resolution order:

```text
--access-key explicit one-shot
> secret store for active environment
> PAGES_CREDENTIAL_REQUIRED
```

Do not read `PAGES_ACCESS_KEY` as a preferred user contract. If temporary env support is kept for CI compatibility, hide it from help and make `--access-key` higher priority.

- [ ] **Step 7: Implement JSON output contract**

Success JSON should include:

```json
{
  "ok": true,
  "schemaVersion": 1,
  "environment": "production"
}
```

Command-specific fields may include `site`, `deployment`, `version`, `route`, `url`, but must not include token/access key plaintext.

Error JSON should include:

```json
{
  "ok": false,
  "schemaVersion": 1,
  "error": {
    "code": "SITE_REQUIRED",
    "message": "...",
    "action": "..."
  }
}
```

- [ ] **Step 8: Update CLI help**

User-facing help should show:

```text
pages login
pages login --access-key <key>
pages auth status
pages auth whoami
pages auth logout
pages deploy <目录> <站点名>
pages deploy --config <file>
pages status <站点名>
pages sites list
pages sites info <站点名>
pages open <站点名>
pages rollback <站点名> <version-id>
```

Do not show `XD Pages v2`, `local`, `custom`, `.pages.json`, `--save-config`, `--slug`, or `--site` in normal help.

- [ ] **Step 9: Run CLI tests**

Run:

```bash
node --test apps/pages-cli/src/*.test.js
```

Expected: all CLI tests pass.

## Task 7: ACL Surface Area

**Files:**
- Modify: `apps/pages-api/src/sites.js`
- Modify: `apps/pages-api/src/openapi.js`
- Test: `apps/pages-api/src/sites.test.js`
- Test: `apps/pages-router/src/access-policy.test.js`

- [ ] **Step 1: Write failing API ACL tests**

Assert API accepts:

```json
{ "subjectType": "email", "subjectValue": "User@XD.com" }
```

and stores:

```json
{ "subjectType": "email", "subjectValue": "user@xd.com" }
```

Assert API rejects:

```json
{ "subjectType": "department", "subjectValue": "研发/平台" }
{ "subjectType": "department_name", "subjectValue": "平台" }
{ "subjectType": "user", "subjectValue": "usr_1" }
```

Expected: department may already be rejected in API; ensure tests document first-release contract.

- [ ] **Step 2: Keep router future-capable but public API email-only**

If router still supports department entries in snapshots, leave it as internal future-capable logic. OpenAPI and API validation must say first release public API only accepts `email`.

- [ ] **Step 3: Run ACL tests**

Run:

```bash
node --test apps/pages-api/src/sites.test.js apps/pages-router/src/access-policy.test.js
```

Expected: tests pass.

## Task 8: Full Verification and Staging Readiness

**Files:**
- No new source file ownership.

- [ ] **Step 1: Search for stale user-facing contract**

Run:

```bash
rg -n "XD Pages v2|XD Pages V2|--slug|--save-config|\\.pages\\.json|visibility public|`public`|pages env use .*local|--env <production\\|staging\\|local|PAGES_ACCESS_KEY=.*pages deploy" apps/pages-api apps/pages-cli apps/pages-router docs/pages-v2-wfp-architecture.md docs/人工配置待办.md
```

Expected: no user-facing stale contract. Internal-only references must be reviewed manually.

- [ ] **Step 2: Run package tests**

Run:

```bash
node --test apps/pages-api/src/*.test.js
node --test apps/pages-router/src/*.test.js
node --test apps/pages-cli/src/*.test.js
```

Expected: all pass.

- [ ] **Step 3: Run repo verification**

Run:

```bash
pnpm lint
pnpm test
```

Expected: both pass.

- [ ] **Step 4: Staging deploy order**

After merge/push, deploy:

```text
D1 migrations
pages-auth-staging
pages-api-staging
pages-kv-gateway-staging
normal worker slot prepare
pages-router-staging
normal worker slot activate
```

Use `Deploy XD Pages Staging` with `component=all` for first staging verification so service bindings and slot bindings are created in dependency order. Single-component deploys are only for follow-up fixes after dependencies are known to exist.

- [ ] **Step 5: Staging smoke**

Run with staging credentials:

```bash
pages login --env staging
pages auth whoami --env staging
pages deploy ./dist smoke-clean-break --env staging --visibility org --json
pages sites info smoke-clean-break --env staging --json
pages status smoke-clean-break --env staging --json
```

Then verify:

```text
internal visibility works from allowlisted IP without SSO
org redirects to SSO and allows active user
acl allows owner even with empty ACL
disabled denies owner and non-owner
public is rejected by API and fail-closed by router if it appears in a malformed snapshot
```

## Self-Review

- Spec coverage: plan covers product naming, visibility clean break, owner bypass, email-only ACL, `whoami`, CLI positional commands, explicit `--config`, one-shot `--access-key`, profileDir, hidden custom, removal of user-facing local, docs, OpenAPI, and staging verification.
- Placeholder scan: no implementation step relies on "TBD" or unspecified behavior; each task has concrete files and test commands.
- Type consistency: visibility values are consistently `internal | org | acl | owner | disabled`; CLI config fields are consistently `environment | site | dir | visibility | artifactKind`; local state path is consistently `~/.xd-pages` and `%APPDATA%\.xd-pages`.
