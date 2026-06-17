# Pages v2 Auth Service Endpoints Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the existing `apps/pages-auth` primitives into a testable v2 auth service boundary for OAuth login, CLI login, local SSO development, and Durable Object-backed one-time transactions.

**Architecture:** Keep `pages-auth` as the only component that knows SSO client credentials and signs auth/CLI session tokens. Public HTTP handlers validate environment and request shape, then delegate strong-consistency state transitions to Durable Objects or test adapters. This milestone still does not integrate `pages-api` or `pages-router` into the live flow; it creates the service endpoints they will call next.

**Tech Stack:** Cloudflare Worker module syntax, Durable Object classes, Web Crypto helpers from the current `apps/pages-auth`, Node `node:test`, `@xd/worker-kit` JSON responses.

---

## Scope

In scope:

- Add `PAGES_ENV=local` support for `pages-auth` only, using `xd-pages.127.0.0.1.nip.io:8787`.
- Add safe HTTP helpers and env parsing for auth endpoints.
- Add stored state helpers that read/write OAuth state, CLI login, and auth session records through a narrow storage interface.
- Expand `OAuthStateDO`, `CliLoginDO`, and `AuthSessionDO` from shells into fetch-addressable state machines.
- Add public `pages-auth` endpoints:
  - `GET /.xd-pages/auth/authorize`
  - `GET /.xd-pages/auth/callback`
  - `POST /.xd-pages/cli/login/start`
  - `POST /.xd-pages/cli/login/poll`
- Keep OAuth token exchange provider-agnostic and testable with injected `env.fetchSsoToken` / `env.fetchSsoProfile` hooks before wiring real SSO HTTP details.
- Ensure OAuth code, SSO access token, session JWT, CLI token, and secrets never appear in URL redirects, logs, or JSON error responses.

Out of scope:

- Real pages-api browser session exchange.
- Router-issued site_session from auth one-time code.
- WFP deployment.
- CLI binary implementation.
- Management UI for device-code confirmation. The confirm step may be a JSON endpoint or internal helper in this milestone, but must preserve device-code semantics.

`docs/xd-sso.md` is local reference only and must remain untracked/uncommitted.

## File Structure

Create:

```text
apps/pages-auth/src/config.js
apps/pages-auth/src/config.test.js
apps/pages-auth/src/http.js
apps/pages-auth/src/http.test.js
apps/pages-auth/src/do-storage.js
apps/pages-auth/src/do-storage.test.js
apps/pages-auth/src/cli-endpoints.js
apps/pages-auth/src/cli-endpoints.test.js
apps/pages-auth/src/oauth-endpoints.js
apps/pages-auth/src/oauth-endpoints.test.js
```

Modify:

```text
apps/pages-auth/src/cli-login.js
apps/pages-auth/src/cli-login.test.js
apps/pages-auth/src/cookies.js
apps/pages-auth/src/cookies.test.js
apps/pages-auth/src/index.js
apps/pages-auth/src/index.test.js
apps/pages-auth/src/jwt.js
apps/pages-auth/src/jwt.test.js
apps/pages-auth/wrangler.template.toml
docs/pages-v2-wfp-architecture.md
```

Responsibilities:

- `config.js`: validate `production` / `staging` / `local`, compute public auth base, callback URL, auth host, TTLs.
- `http.js`: no-store JSON errors, JSON body parsing, safe redirects, query redaction helpers.
- `do-storage.js`: storage-backed wrappers around `oauth-state.js`, `cli-login.js`, and `session-record.js`.
- `cli-endpoints.js`: start/poll endpoints, browser confirm helper, CLI token issuance.
- `oauth-endpoints.js`: authorize/callback endpoint logic, SSO hook invocation, auth_session cookie issuance.
- `index.js`: route public paths to endpoint modules and export concrete DO classes.

## Shared Rules

- Public endpoints always set `Cache-Control: no-store`.
- Error envelopes are `{ error: { code, message, action? } }`.
- Error responses must not include OAuth `code`, `state`, `access_token`, `client_secret`, JWT, cookie values, login secret, or Cloudflare resource ids.
- Redirect targets must be exact allowlisted origins. For site OAuth state, `return_to` must already pass `createOAuthState`.
- Local env is only for `pages-auth` development:

```text
PAGES_ENV=local
PUBLIC_AUTH_BASE=http://xd-pages.127.0.0.1.nip.io:8787
SSO_REDIRECT_URI=http://xd-pages.127.0.0.1.nip.io:8787/.xd-pages/auth/callback
```

- Production/staging SSO config remains:

```text
production:
  PUBLIC_AUTH_BASE=https://auth.pages.xd.team
  SSO_REDIRECT_URI=https://auth.pages.xd.team/.xd-pages/auth/callback

staging:
  PUBLIC_AUTH_BASE=https://auth-staging.pages.xd.team
  SSO_REDIRECT_URI=https://auth-staging.pages.xd.team/.xd-pages/auth/callback
```

## Task 1: Auth Config and Local Env Support

**Files:**

- Create: `apps/pages-auth/src/config.js`
- Create: `apps/pages-auth/src/config.test.js`
- Modify: `apps/pages-auth/src/cli-login.js`
- Modify: `apps/pages-auth/src/cli-login.test.js`
- Modify: `apps/pages-auth/src/cookies.js`
- Modify: `apps/pages-auth/src/cookies.test.js`
- Modify: `apps/pages-auth/src/jwt.js`
- Modify: `apps/pages-auth/src/jwt.test.js`

- [ ] **Step 1: Write failing config tests**

Create `apps/pages-auth/src/config.test.js` with tests for:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { readAuthConfig } from './config.js';

test('reads production auth config from placeholders-safe env', () => {
  const config = readAuthConfig({
    PAGES_ENV: 'production',
    PUBLIC_AUTH_BASE: 'https://auth.pages.xd.team',
    PUBLIC_API_BASE: 'https://api.pages.xd.team',
    SSO_REDIRECT_URI: 'https://auth.pages.xd.team/.xd-pages/auth/callback',
    OAUTH_STATE_TTL_SECONDS: '300',
    CLI_LOGIN_TTL_SECONDS: '600',
    AUTH_SESSION_IDLE_TTL_SECONDS: '1209600',
    AUTH_SESSION_ABSOLUTE_TTL_SECONDS: '2592000',
  });

  assert.equal(config.environment, 'production');
  assert.equal(config.authBase, 'https://auth.pages.xd.team');
  assert.equal(config.authHost, 'auth.pages.xd.team');
  assert.equal(config.oauthStateTtlSeconds, 300);
  assert.equal(config.cliLoginTtlSeconds, 600);
});

test('reads local auth config for SSO development', () => {
  const config = readAuthConfig({
    PAGES_ENV: 'local',
    PUBLIC_AUTH_BASE: 'http://xd-pages.127.0.0.1.nip.io:8787',
    PUBLIC_API_BASE: 'http://xd-pages.127.0.0.1.nip.io:8787',
    SSO_REDIRECT_URI: 'http://xd-pages.127.0.0.1.nip.io:8787/.xd-pages/auth/callback',
  });

  assert.equal(config.environment, 'local');
  assert.equal(config.authHost, 'xd-pages.127.0.0.1.nip.io');
  assert.equal(config.authBase, 'http://xd-pages.127.0.0.1.nip.io:8787');
});

test('rejects cross-environment auth base and callback', () => {
  assert.throws(
    () =>
      readAuthConfig({
        PAGES_ENV: 'production',
        PUBLIC_AUTH_BASE: 'https://auth-staging.pages.xd.team',
        SSO_REDIRECT_URI: 'https://auth.pages.xd.team/.xd-pages/auth/callback',
      }),
    /auth base/i
  );
  assert.throws(
    () =>
      readAuthConfig({
        PAGES_ENV: 'staging',
        PUBLIC_AUTH_BASE: 'https://auth-staging.pages.xd.team',
        SSO_REDIRECT_URI: 'https://auth.pages.xd.team/.xd-pages/auth/callback',
      }),
    /redirect/i
  );
});
```

- [ ] **Step 2: Run config tests and verify RED**

Run:

```bash
node --test apps/pages-auth/src/config.test.js
```

Expected: FAIL with module-not-found for `config.js`.

- [ ] **Step 3: Implement `config.js`**

Implement:

```js
const ENV_CONFIG = {
  production: {
    authBase: 'https://auth.pages.xd.team',
    callbackUrl: 'https://auth.pages.xd.team/.xd-pages/auth/callback',
  },
  staging: {
    authBase: 'https://auth-staging.pages.xd.team',
    callbackUrl: 'https://auth-staging.pages.xd.team/.xd-pages/auth/callback',
  },
  local: {
    authBase: 'http://xd-pages.127.0.0.1.nip.io:8787',
    callbackUrl: 'http://xd-pages.127.0.0.1.nip.io:8787/.xd-pages/auth/callback',
  },
};

export function readAuthConfig(env) {
  const environment = readEnvironment(env?.PAGES_ENV);
  const expected = ENV_CONFIG[environment];
  const authBase = normalizeOrigin(env?.PUBLIC_AUTH_BASE || expected.authBase);
  const callbackUrl = normalizeUrl(env?.SSO_REDIRECT_URI || expected.callbackUrl);

  if (authBase !== expected.authBase) throw new Error('Auth base does not match Pages environment');
  if (callbackUrl !== expected.callbackUrl) throw new Error('SSO redirect URI does not match Pages environment');

  return {
    environment,
    authBase,
    authHost: new URL(authBase).hostname,
    apiBase: normalizeOrigin(env?.PUBLIC_API_BASE || authBase),
    ssoRedirectUri: callbackUrl,
    oauthStateTtlSeconds: readPositiveInteger(env?.OAUTH_STATE_TTL_SECONDS, 300),
    cliLoginTtlSeconds: readPositiveInteger(env?.CLI_LOGIN_TTL_SECONDS, 600),
    authSessionIdleTtlSeconds: readPositiveInteger(env?.AUTH_SESSION_IDLE_TTL_SECONDS, 1_209_600),
    authSessionAbsoluteTtlSeconds: readPositiveInteger(env?.AUTH_SESSION_ABSOLUTE_TTL_SECONDS, 2_592_000),
  };
}
```

Include private helpers for `readEnvironment`, `normalizeOrigin`, `normalizeUrl`, and positive integer parsing. Reject credentials, fragments, non-http(s), and trailing path in `PUBLIC_AUTH_BASE`.

- [ ] **Step 4: Add local support to JWT, cookies, and CLI login primitives**

Update allowed environments from `production | staging` to `production | staging | local` for:

- `jwt.js`
- `cli-login.js`
- `cookies.js` auth host only

Add tests:

```js
assert.equal(isAuthSessionHost('xd-pages.127.0.0.1.nip.io', 'local'), true);
```

`site_session` host support remains production/staging only unless a later router-local plan adds local site host classification.

- [ ] **Step 5: Verify**

Run:

```bash
node --test apps/pages-auth/src/config.test.js apps/pages-auth/src/cli-login.test.js apps/pages-auth/src/cookies.test.js apps/pages-auth/src/jwt.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/pages-auth/src/config.js apps/pages-auth/src/config.test.js apps/pages-auth/src/cli-login.js apps/pages-auth/src/cli-login.test.js apps/pages-auth/src/cookies.js apps/pages-auth/src/cookies.test.js apps/pages-auth/src/jwt.js apps/pages-auth/src/jwt.test.js
git commit -m "feat(auth): 支持 pages-auth 本地 SSO 环境"
```

## Task 2: Safe HTTP Helpers

**Files:**

- Create: `apps/pages-auth/src/http.js`
- Create: `apps/pages-auth/src/http.test.js`

- [ ] **Step 1: Write failing HTTP tests**

Create `apps/pages-auth/src/http.test.js` covering:

- `jsonError(code, message, status)` returns no-store JSON envelope.
- `readJsonBody(request, maxBytes)` rejects non-JSON, invalid JSON, and oversized body.
- `safeRedirect(url, status)` only accepts absolute http/https URLs without credentials/fragments.
- `redactUrl(url)` removes `code`, `state`, `access_token`, `client_secret`, `login_secret`, and `token`.

- [ ] **Step 2: Run HTTP tests and verify RED**

Run:

```bash
node --test apps/pages-auth/src/http.test.js
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement `http.js`**

Export:

```js
export function jsonOk(data, status = 200) {}
export function jsonError(code, message, status, action) {}
export async function readJsonBody(request, { maxBytes = 4096 } = {}) {}
export function safeRedirect(location, status = 302) {}
export function redactUrl(value) {}
```

Implementation requirements:

- Always set `Cache-Control: no-store`.
- Always set JSON `Content-Type` through `jsonResponse`.
- `safeRedirect` sets `Referrer-Policy: no-referrer`.
- `readJsonBody` does not echo body content in thrown errors.

- [ ] **Step 4: Verify and commit**

```bash
node --test apps/pages-auth/src/http.test.js
git add apps/pages-auth/src/http.js apps/pages-auth/src/http.test.js
git commit -m "feat(auth): 增加安全 HTTP 辅助函数"
```

## Task 3: Durable Object Storage State Machines

**Files:**

- Create: `apps/pages-auth/src/do-storage.js`
- Create: `apps/pages-auth/src/do-storage.test.js`
- Modify: `apps/pages-auth/src/index.js`
- Modify: `apps/pages-auth/src/index.test.js`

- [ ] **Step 1: Write failing storage tests**

Tests should use a fake storage object with async `get`, `put`, and `delete`. Cover:

- OAuth state create stores one record and consume updates `consumedAt`.
- OAuth state cannot be consumed twice.
- CLI login create stores pending record.
- CLI login confirm requires matching device code and writes confirmed user.
- CLI login consume requires login secret and only succeeds once.
- Auth session record create/refresh/revoke persists session lifecycle.
- DO fetch methods return no-store JSON and never include `secretHash`.

- [ ] **Step 2: Run storage tests and verify RED**

Run:

```bash
node --test apps/pages-auth/src/do-storage.test.js
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement storage functions**

Export storage functions:

```js
export async function createStoredOAuthState(storage, input) {}
export async function consumeStoredOAuthState(storage, publicState, options) {}
export async function createStoredCliLogin(storage, input) {}
export async function confirmStoredCliLogin(storage, input, options) {}
export async function consumeStoredCliLogin(storage, input, options) {}
export async function createStoredSession(storage, input) {}
export async function refreshStoredSession(storage, sid, options) {}
export async function revokeStoredSession(storage, sid, options) {}
```

Use fixed storage keys:

```text
record
session:{sid}
```

Do not return `secretHash` to public endpoint callers.

- [ ] **Step 4: Implement DO fetch shells**

Update `OAuthStateDO`, `CliLoginDO`, and `AuthSessionDO` to route internal JSON actions to the storage functions. Unknown paths return `NOT_FOUND`; invalid JSON returns `INVALID_JSON`; all responses are no-store.

- [ ] **Step 5: Verify and commit**

```bash
node --test apps/pages-auth/src/do-storage.test.js apps/pages-auth/src/index.test.js
git add apps/pages-auth/src/do-storage.js apps/pages-auth/src/do-storage.test.js apps/pages-auth/src/index.js apps/pages-auth/src/index.test.js
git commit -m "feat(auth): 增加 auth durable object 状态机"
```

## Task 4: CLI Login Public Endpoints

**Files:**

- Create: `apps/pages-auth/src/cli-endpoints.js`
- Create: `apps/pages-auth/src/cli-endpoints.test.js`
- Modify: `apps/pages-auth/src/index.js`
- Modify: `apps/pages-auth/src/index.test.js`

- [ ] **Step 1: Write failing CLI endpoint tests**

Cover:

- `POST /.xd-pages/cli/login/start` returns `loginId`, `loginSecret`, `deviceCode`, `browserUrl`, `expiresAt`.
- Browser URL points to current environment `PUBLIC_AUTH_BASE`, not API host.
- Response does not include `secretHash`.
- `POST /.xd-pages/cli/login/poll` returns pending before confirmation.
- Poll with wrong secret does not consume transaction.
- Poll after confirmation returns a signed `cliToken` once and then rejects repeated poll.
- CLI token has purpose `cli_token`, audience `pages-cli`, subject user id, safe `jti`, and env binding.

- [ ] **Step 2: Run CLI endpoint tests and verify RED**

Run:

```bash
node --test apps/pages-auth/src/cli-endpoints.test.js
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement endpoints**

Export:

```js
export async function handleCliLoginStart(request, env, config) {}
export async function handleCliLoginPoll(request, env, config) {}
export function buildCliLoginBrowserUrl(config, loginId) {}
```

Use DO binding when present:

```js
const id = env.CLI_LOGINS.idFromName(loginId);
const stub = env.CLI_LOGINS.get(id);
```

In tests, allow `env.createCliLoginRecord`, `env.consumeCliLoginRecord`, and `env.confirmCliLoginRecord` hooks so the endpoint can be verified without Miniflare.

- [ ] **Step 4: Wire routes in `index.js`**

Add:

```text
POST /.xd-pages/cli/login/start
POST /.xd-pages/cli/login/poll
```

Reject other methods with `METHOD_NOT_ALLOWED`.

- [ ] **Step 5: Verify and commit**

```bash
node --test apps/pages-auth/src/cli-endpoints.test.js apps/pages-auth/src/index.test.js apps/pages-auth/src/*.test.js
git add apps/pages-auth/src/cli-endpoints.js apps/pages-auth/src/cli-endpoints.test.js apps/pages-auth/src/index.js apps/pages-auth/src/index.test.js
git commit -m "feat(auth): 增加 CLI 登录服务端点"
```

## Task 5: OAuth Authorize and Callback Endpoints

**Files:**

- Create: `apps/pages-auth/src/oauth-endpoints.js`
- Create: `apps/pages-auth/src/oauth-endpoints.test.js`
- Modify: `apps/pages-auth/src/index.js`
- Modify: `apps/pages-auth/src/index.test.js`
- Modify: `apps/pages-auth/wrangler.template.toml`

- [ ] **Step 1: Write failing OAuth endpoint tests**

Cover:

- `GET /.xd-pages/auth/authorize?site_host=demo.pages.xd.team&return_to=https://demo.pages.xd.team/` redirects to SSO authorization URL.
- Redirect URL contains `client_id`, exact `redirect_uri`, `response_type=code`, and opaque `state`.
- Redirect URL does not contain client secret or raw return_to secret material beyond safe state.
- Open redirect return_to is rejected before SSO redirect.
- Callback without `code` or `state` returns safe `OAUTH_CALLBACK_INVALID`.
- Callback consumes state once, calls SSO hooks, signs auth_session cookie, and redirects to state returnTo.
- Callback error responses redact OAuth code/state.

- [ ] **Step 2: Run OAuth endpoint tests and verify RED**

Run:

```bash
node --test apps/pages-auth/src/oauth-endpoints.test.js
```

Expected: FAIL with module-not-found.

- [ ] **Step 3: Implement provider-agnostic OAuth endpoint logic**

Export:

```js
export async function handleOAuthAuthorize(request, env, config) {}
export async function handleOAuthCallback(request, env, config) {}
export function buildSsoAuthorizeUrl(config, publicState) {}
```

Use env hooks first:

```js
await env.fetchSsoToken({ code, redirectUri: config.ssoRedirectUri });
await env.fetchSsoProfile({ accessToken });
```

If hooks are absent, return `SSO_PROVIDER_UNCONFIGURED` instead of attempting a live network call in this milestone.

- [ ] **Step 4: Wire routes and template**

Add routes:

```text
GET /.xd-pages/auth/authorize
GET /.xd-pages/auth/callback
```

Ensure `wrangler.template.toml` includes placeholders:

```text
SSO_REDIRECT_URI
SSO_ALLOWED_USER_SCOPE
```

Keep `SSO_CLIENT_SECRET` out of vars.

- [ ] **Step 5: Verify and commit**

```bash
node --test apps/pages-auth/src/oauth-endpoints.test.js apps/pages-auth/src/index.test.js apps/pages-auth/src/*.test.js
git add apps/pages-auth/src/oauth-endpoints.js apps/pages-auth/src/oauth-endpoints.test.js apps/pages-auth/src/index.js apps/pages-auth/src/index.test.js apps/pages-auth/wrangler.template.toml
git commit -m "feat(auth): 增加 OAuth 授权回调端点"
```

## Task 6: Workspace Verification and Review

**Files:**

- Modify only if verification exposes formatting drift or missing config docs.

- [ ] **Step 1: Run focused auth tests**

```bash
node --test apps/pages-auth/src/*.test.js
```

Expected: PASS.

- [ ] **Step 2: Run router/auth regression tests**

```bash
node --test apps/pages-auth/src/*.test.js apps/pages-router/src/*.test.js
```

Expected: PASS.

- [ ] **Step 3: Run workspace checks**

```bash
pnpm test
pnpm lint
pnpm exec prettier --check apps/pages-auth docs/pages-v2-wfp-architecture.md docs/superpowers/plans/2026-06-15-pages-v2-auth-service-endpoints.md
```

Expected: all pass.

- [ ] **Step 4: Confirm local SSO reference remains untracked**

```bash
git ls-files --error-unmatch docs/xd-sso.md
git status --short
```

Expected: `git ls-files` fails. `docs/xd-sso.md` may appear as `?? docs/xd-sso.md`, and must not be staged.

- [ ] **Step 5: Final review**

Dispatch final reviewers for:

- spec compliance against this plan and `docs/pages-v2-wfp-architecture.md`;
- security review of OAuth code/token redaction, redirect allowlist, secret placement, one-time consume, and production/staging/local separation.

Fix P0/P1 findings before completion.

## Self-Review Notes

- Spec coverage: this plan closes the M2 gap left by shell-only Durable Objects and creates the auth service boundary needed by M3 API and M4 CLI.
- Local SSO: explicit local host support is limited to `pages-auth`; router local site domains remain out of scope.
- Security: this milestone still avoids live SSO secrets in code and tests. Provider hooks allow deterministic tests without committing real client id or secret.
- v1/v2 boundary: all paths are under `/.xd-pages/*` on `pages.xd.team` auth hosts. No `workers.xd.team` behavior changes.
