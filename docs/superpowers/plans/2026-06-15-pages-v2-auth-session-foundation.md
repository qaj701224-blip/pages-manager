# Pages v2 Auth Session Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the M2 `apps/pages-auth` foundation for OAuth state, CLI login transactions, session JWTs, host-only cookies, and revocable session records.

**Architecture:** This milestone creates a narrow auth package without connecting to the real SSO provider yet. It implements testable primitives and state machines that later `pages-auth` Durable Objects and router/API service bindings can use: signed purpose-bound JWTs, auth/site cookie builders, one-time OAuth state, one-time CLI login completion, and session refresh/revoke records.

**Tech Stack:** Cloudflare Worker module syntax, Web Crypto HS256 JWTs, Node `node:test`, workspace packages `@xd/pages-runtime-protocol`, `@xd/worker-kit`, and existing `apps/pages-router` host classifier.

---

## Scope

This is M2 from `docs/superpowers/specs/2026-06-15-pages-v2-full-implementation-design.md`.

In scope:

- New `apps/pages-auth` workspace package and wrangler template.
- Purpose-bound session JWT signing/verification for `auth_session`, `site_session`, and future `cli_token`.
- Host-only cookie helpers for `auth_session` and `site_session`.
- OAuth state transaction primitives with return URL allowlist, secret hash, expiration, and one-time consumption.
- CLI login transaction primitives with login secret, device code confirmation, expiration, and one-time consumption.
- Session record lifecycle primitives for idle refresh, absolute expiration, and revocation.
- Minimal Worker entry with `/.xd-pages/health`, safe JSON errors, and exported Durable Object class placeholders backed by the primitives.

Out of scope:

- Real 心动 SSO token exchange and profile fetch.
- Real D1 session index writes.
- Router integration for `site_session`.
- API browser session exchange.
- Real CLI command implementation.

`docs/xd-sso.md` is local reference only and must remain untracked/uncommitted.

## File Structure

Create:

```text
apps/pages-auth/package.json
apps/pages-auth/wrangler.template.toml
apps/pages-auth/src/id.js
apps/pages-auth/src/id.test.js
apps/pages-auth/src/jwt.js
apps/pages-auth/src/jwt.test.js
apps/pages-auth/src/cookies.js
apps/pages-auth/src/cookies.test.js
apps/pages-auth/src/oauth-state.js
apps/pages-auth/src/oauth-state.test.js
apps/pages-auth/src/cli-login.js
apps/pages-auth/src/cli-login.test.js
apps/pages-auth/src/session-record.js
apps/pages-auth/src/session-record.test.js
apps/pages-auth/src/index.js
apps/pages-auth/src/index.test.js
```

Modify only if needed:

```text
pnpm-lock.yaml
```

Responsibilities:

- `id.js`: CSPRNG ids/secrets, SHA-256 hashing, constant-time digest comparison.
- `jwt.js`: session key registry, HS256 signing, HS256 verification, standard claims validation.
- `cookies.js`: host-only auth/site session cookie creation/clearing and host binding checks.
- `oauth-state.js`: one-time OAuth state creation and consumption.
- `cli-login.js`: CLI login start, browser confirmation, CLI polling/consumption.
- `session-record.js`: revocable session record lifecycle.
- `index.js`: Worker module entry, safe health/error responses, and Durable Object class shells.

### Naming and Env Conventions

Use these env names in code and tests:

```text
PAGES_ENV                         production / staging
PAGES_SESSION_JWT_ACTIVE_KID      active signing key id
PAGES_SESSION_JWT_KEYS            comma-separated kid:HS256:SECRET_ENV_NAME
PAGES_SESSION_JWT_SECRET_TEST     test-only secret env name in tests
OAUTH_STATE_TTL_SECONDS           default 300
CLI_LOGIN_TTL_SECONDS             default 600
AUTH_SESSION_IDLE_TTL_SECONDS     default 1209600
AUTH_SESSION_ABSOLUTE_TTL_SECONDS default 2592000
SITE_SESSION_IDLE_TTL_SECONDS     default 259200
SITE_SESSION_ABSOLUTE_TTL_SECONDS default 604800
```

Wrangler template must use placeholders only. Do not put real SSO client id, secret, Cloudflare resource id, account id, zone id, or namespace id in any committed file.

### Task 1: Auth Package Scaffold

**Files:**

- Create: `apps/pages-auth/package.json`
- Create: `apps/pages-auth/wrangler.template.toml`

- [ ] **Step 1: Create package manifest**

Create `apps/pages-auth/package.json`:

```json
{
  "name": "@xd/pages-auth",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "@xd/pages-runtime-protocol": "workspace:*",
    "@xd/worker-kit": "workspace:*"
  },
  "devDependencies": {
    "wrangler": "catalog:"
  }
}
```

- [ ] **Step 2: Create wrangler template**

Create `apps/pages-auth/wrangler.template.toml`:

```toml
name = "__WORKER_NAME__"
main = "src/index.js"
compatibility_date = "2026-06-15"

[vars]
PAGES_ENV = "__PAGES_ENV__"
PUBLIC_AUTH_BASE = "__PUBLIC_AUTH_BASE__"
PUBLIC_API_BASE = "__PUBLIC_API_BASE__"
PUBLIC_SITE_SUFFIX = "__PUBLIC_SITE_SUFFIX__"
OAUTH_STATE_TTL_SECONDS = "__OAUTH_STATE_TTL_SECONDS__"
CLI_LOGIN_TTL_SECONDS = "__CLI_LOGIN_TTL_SECONDS__"
AUTH_SESSION_IDLE_TTL_SECONDS = "__AUTH_SESSION_IDLE_TTL_SECONDS__"
AUTH_SESSION_ABSOLUTE_TTL_SECONDS = "__AUTH_SESSION_ABSOLUTE_TTL_SECONDS__"
SITE_SESSION_IDLE_TTL_SECONDS = "__SITE_SESSION_IDLE_TTL_SECONDS__"
SITE_SESSION_ABSOLUTE_TTL_SECONDS = "__SITE_SESSION_ABSOLUTE_TTL_SECONDS__"
PAGES_SESSION_JWT_ACTIVE_KID = "__PAGES_SESSION_JWT_ACTIVE_KID__"
PAGES_SESSION_JWT_KEYS = "__PAGES_SESSION_JWT_KEYS__"
SSO_AUTHORIZATION_URL = "https://sso.security.xindong.com/cas/oauth2.0/authorize"
SSO_TOKEN_URL = "https://sso.security.xindong.com/cas/oauth2.0/accessToken"
SSO_PROFILE_URL = "https://sso.security.xindong.com/cas/oauth2.0/profile"
SSO_CLIENT_ID = "<xd_pages|xd_pages_staging>"

[[durable_objects.bindings]]
name = "OAUTH_STATES"
class_name = "OAuthStateDO"

[[durable_objects.bindings]]
name = "CLI_LOGINS"
class_name = "CliLoginDO"

[[durable_objects.bindings]]
name = "AUTH_SESSIONS"
class_name = "AuthSessionDO"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["OAuthStateDO", "CliLoginDO", "AuthSessionDO"]
```

- [ ] **Step 3: Verify workspace sees the package**

Run:

```bash
pnpm install --lockfile-only
pnpm --filter @xd/pages-auth exec pwd
```

Expected: both commands exit 0, and the second command prints the absolute `apps/pages-auth` path.

- [ ] **Step 4: Commit scaffold**

```bash
git add apps/pages-auth/package.json apps/pages-auth/wrangler.template.toml pnpm-lock.yaml
git commit -m "feat(auth): 新增 pages v2 auth 包"
```

### Task 2: Shared ID and Hash Helpers

**Files:**

- Create: `apps/pages-auth/src/id.js`
- Create: `apps/pages-auth/src/id.test.js`

- [ ] **Step 1: Write failing ID tests**

Create `apps/pages-auth/src/id.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { constantTimeEqualHex, createOpaqueToken, sha256Hex } from './id.js';

test('createOpaqueToken uses prefix and base64url characters', () => {
  const token = createOpaqueToken('ost', {
    bytes: new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253]),
  });

  assert.equal(token, 'ost_AAECA_r7_P0');
});

test('createOpaqueToken requires a safe lowercase prefix', () => {
  assert.throws(() => createOpaqueToken('Bad', { bytes: new Uint8Array([1]) }), /prefix/i);
  assert.throws(() => createOpaqueToken('bad-prefix', { bytes: new Uint8Array([1]) }), /prefix/i);
});

test('sha256Hex returns stable lowercase hex', async () => {
  assert.equal(await sha256Hex('secret'), '2bb80d537b1da3e38bd30361aa855686bde0ba720eea6a7c0b3fb99a760d5b');
});

test('constantTimeEqualHex compares equal-length hex digests', () => {
  assert.equal(constantTimeEqualHex('aa00', 'aa00'), true);
  assert.equal(constantTimeEqualHex('aa00', 'aa01'), false);
  assert.equal(constantTimeEqualHex('aa00', 'aa'), false);
});
```

- [ ] **Step 2: Run ID tests and verify RED**

Run:

```bash
node --test apps/pages-auth/src/id.test.js
```

Expected: FAIL with module-not-found for `apps/pages-auth/src/id.js`.

- [ ] **Step 3: Implement ID helpers**

Create `apps/pages-auth/src/id.js`:

```js
const encoder = new TextEncoder();
const SAFE_PREFIX_RE = /^[a-z][a-z0-9_]{1,15}$/;

export function createOpaqueToken(prefix, { byteLength = 24, bytes } = {}) {
  if (!SAFE_PREFIX_RE.test(prefix)) throw new Error('Token prefix must be lowercase snake case');
  const tokenBytes = bytes || randomBytes(byteLength);
  return `${prefix}_${base64UrlEncodeBytes(tokenBytes)}`;
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return bytesToHex(new Uint8Array(digest));
}

export function constantTimeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function randomBytes(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytes;
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
```

- [ ] **Step 4: Run ID tests and verify GREEN**

Run:

```bash
node --test apps/pages-auth/src/id.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit ID helpers**

```bash
git add apps/pages-auth/src/id.js apps/pages-auth/src/id.test.js
git commit -m "feat(auth): 增加安全随机标识和哈希工具"
```

### Task 3: Session JWT Signing and Verification

**Files:**

- Create: `apps/pages-auth/src/jwt.js`
- Create: `apps/pages-auth/src/jwt.test.js`

- [ ] **Step 1: Write failing JWT tests**

Create `apps/pages-auth/src/jwt.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { signSessionJwt, verifySessionJwt } from './jwt.js';

const now = 1_700_000_000;

function testEnv(overrides = {}) {
  return {
    PAGES_ENV: 'production',
    PAGES_SESSION_JWT_ACTIVE_KID: 'prod-hs-2026-06',
    PAGES_SESSION_JWT_KEYS: 'prod-hs-2026-06:HS256:PAGES_SESSION_JWT_SECRET_TEST',
    PAGES_SESSION_JWT_SECRET_TEST: 'test-session-secret',
    ...overrides,
  };
}

test('signs and verifies an auth_session token with purpose and audience binding', async () => {
  const jwt = await signSessionJwt(
    {
      purpose: 'auth_session',
      audience: 'pages-auth',
      subject: 'usr_123',
      now,
      ttlSeconds: 3600,
      claims: {
        sid: 'sid_auth',
        sessionVersion: 3,
        authTime: now,
      },
    },
    testEnv()
  );

  const verified = await verifySessionJwt(jwt, testEnv(), {
    purpose: 'auth_session',
    audience: 'pages-auth',
    now,
  });

  assert.equal(verified.iss, 'pages-auth');
  assert.equal(verified.aud, 'pages-auth');
  assert.equal(verified.env, 'production');
  assert.equal(verified.purpose, 'auth_session');
  assert.equal(verified.sub, 'usr_123');
  assert.equal(verified.sid, 'sid_auth');
  assert.equal(verified.exp, now + 3600);
});

test('rejects tampered tokens, wrong audience, wrong purpose, and wrong env', async () => {
  const jwt = await signSessionJwt(
    {
      purpose: 'site_session',
      audience: 'foo.pages.xd.team',
      subject: 'usr_123',
      now,
      ttlSeconds: 600,
      claims: { sid: 'sid_site', siteId: 'site_demo', policyVersion: 1, sessionVersion: 1 },
    },
    testEnv()
  );

  const [header, payload, signature] = jwt.split('.');
  const tampered = `${header}.${payload}.${signature.slice(0, -1)}x`;

  await assert.rejects(
    () => verifySessionJwt(tampered, testEnv(), { purpose: 'site_session', audience: 'foo.pages.xd.team', now }),
    /signature/i
  );
  await assert.rejects(
    () => verifySessionJwt(jwt, testEnv(), { purpose: 'auth_session', audience: 'foo.pages.xd.team', now }),
    /purpose/i
  );
  await assert.rejects(
    () => verifySessionJwt(jwt, testEnv(), { purpose: 'site_session', audience: 'bar.pages.xd.team', now }),
    /audience/i
  );
  await assert.rejects(
    () =>
      verifySessionJwt(jwt, testEnv({ PAGES_ENV: 'staging' }), { purpose: 'site_session', audience: 'foo.pages.xd.team', now }),
    /environment/i
  );
});

test('rejects expired tokens and future-issued tokens', async () => {
  const expired = await signSessionJwt(
    { purpose: 'cli_token', audience: 'pages-api', subject: 'usr_123', now, ttlSeconds: 10, claims: { jti: 'cli_1' } },
    testEnv()
  );
  const future = await signSessionJwt(
    { purpose: 'cli_token', audience: 'pages-api', subject: 'usr_123', now: now + 120, ttlSeconds: 10, claims: { jti: 'cli_2' } },
    testEnv()
  );

  await assert.rejects(
    () => verifySessionJwt(expired, testEnv(), { purpose: 'cli_token', audience: 'pages-api', now: now + 11 }),
    /expired/i
  );
  await assert.rejects(() => verifySessionJwt(future, testEnv(), { purpose: 'cli_token', audience: 'pages-api', now }), /iat/i);
});

test('rejects missing active key and duplicate key registry entries', async () => {
  await assert.rejects(
    () =>
      signSessionJwt(
        { purpose: 'auth_session', audience: 'pages-auth', subject: 'usr_123', now, ttlSeconds: 10 },
        testEnv({ PAGES_SESSION_JWT_ACTIVE_KID: '' })
      ),
    /active kid/i
  );
  await assert.rejects(
    () =>
      signSessionJwt(
        { purpose: 'auth_session', audience: 'pages-auth', subject: 'usr_123', now, ttlSeconds: 10 },
        testEnv({
          PAGES_SESSION_JWT_KEYS:
            'prod-hs-2026-06:HS256:PAGES_SESSION_JWT_SECRET_TEST,prod-hs-2026-06:HS256:PAGES_SESSION_JWT_SECRET_TEST',
        })
      ),
    /duplicate/i
  );
});
```

- [ ] **Step 2: Run JWT tests and verify RED**

Run:

```bash
node --test apps/pages-auth/src/jwt.test.js
```

Expected: FAIL with module-not-found for `apps/pages-auth/src/jwt.js`.

- [ ] **Step 3: Implement JWT helpers**

Create `apps/pages-auth/src/jwt.js`:

```js
const ISSUER = 'pages-auth';
const MAX_IAT_FUTURE_SKEW_SECONDS = 60;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export async function signSessionJwt({ purpose, audience, subject, now, ttlSeconds, claims = {} }, env) {
  const key = parseActiveSigningKey(env);
  const payload = {
    iss: ISSUER,
    aud: requiredString(audience, 'audience'),
    env: requiredRouterEnvironment(env?.PAGES_ENV),
    purpose: requiredString(purpose, 'purpose'),
    sub: requiredString(subject, 'subject'),
    iat: requiredNumber(now, 'now'),
    nbf: requiredNumber(now, 'now'),
    exp: requiredNumber(now, 'now') + requiredPositiveNumber(ttlSeconds, 'ttlSeconds'),
    ...claims,
  };

  return createHs256Jwt({ kid: key.kid, secret: key.secret, payload });
}

export async function verifySessionJwt(token, env, { purpose, audience, now = Math.floor(Date.now() / 1000) } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) throw new Error('Session token invalid: malformed JWT');

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseJwtJson(encodedHeader, 'header');
  const payload = parseJwtJson(encodedPayload, 'payload');
  const registry = parseKeyRegistry(env);
  const key = registry.get(header.kid);

  if (!key) throw new Error('Session token invalid: unknown kid');
  if (header.alg !== key.alg) throw new Error('Session token invalid: alg mismatch');

  const expectedSignature = await signHs256(key.secret, `${encodedHeader}.${encodedPayload}`);
  const actualSignature = base64UrlDecodeBytes(encodedSignature);
  if (!constantTimeEqualBytes(expectedSignature, actualSignature)) {
    throw new Error('Session token invalid: invalid signature');
  }

  validateClaims(payload, env, { purpose, audience, now });
  return payload;
}

export function parseKeyRegistry(env) {
  const value = env?.PAGES_SESSION_JWT_KEYS;
  if (typeof value !== 'string' || value.trim() === '') throw new Error('Session key registry is missing');

  const registry = new Map();
  for (const entry of value
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)) {
    const parts = entry.split(':').map((part) => part.trim());
    if (parts.length !== 3 || parts.some((part) => part === '')) throw new Error('Malformed session key registry entry');

    const [kid, alg, secretEnvName] = parts;
    if (alg !== 'HS256') throw new Error(`Unsupported session key alg: ${alg}`);
    if (registry.has(kid)) throw new Error(`Duplicate session key kid: ${kid}`);

    const secret = env[secretEnvName];
    if (typeof secret !== 'string' || secret === '') throw new Error(`Missing session secret env var: ${secretEnvName}`);
    registry.set(kid, { kid, alg, secret });
  }

  if (registry.size === 0) throw new Error('Session key registry is empty');
  return registry;
}

function parseActiveSigningKey(env) {
  const activeKid = env?.PAGES_SESSION_JWT_ACTIVE_KID?.trim();
  if (!activeKid) throw new Error('Session active kid is missing');
  const key = parseKeyRegistry(env).get(activeKid);
  if (!key) throw new Error(`Session active kid not found: ${activeKid}`);
  return key;
}

function validateClaims(claims, env, { purpose, audience, now }) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) throw new Error('Session token invalid: invalid claims');
  if (claims.iss !== ISSUER) throw new Error('Session token invalid: invalid issuer');
  if (claims.aud !== audience) throw new Error('Session token invalid: audience mismatch');
  if (claims.env !== requiredRouterEnvironment(env?.PAGES_ENV)) throw new Error('Session token invalid: environment mismatch');
  if (claims.purpose !== purpose) throw new Error('Session token invalid: purpose mismatch');
  if (typeof claims.sub !== 'string' || claims.sub === '') throw new Error('Session token invalid: invalid subject');
  if (typeof claims.iat !== 'number' || claims.iat > now + MAX_IAT_FUTURE_SKEW_SECONDS)
    throw new Error('Session token invalid: iat is in the future');
  if (typeof claims.nbf !== 'number' || claims.nbf > now) throw new Error('Session token invalid: nbf is not active');
  if (typeof claims.exp !== 'number' || claims.exp <= now) throw new Error('Session token invalid: expired');
}

async function createHs256Jwt({ kid, secret, payload }) {
  const header = { typ: 'JWT', alg: 'HS256', kid };
  const encodedHeader = base64UrlEncodeJson(header);
  const encodedPayload = base64UrlEncodeJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await signHs256(secret, signingInput);
  return `${signingInput}.${base64UrlEncodeBytes(signature)}`;
}

async function signHs256(secret, signingInput) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput)));
}

function parseJwtJson(value, label) {
  try {
    return JSON.parse(decoder.decode(base64UrlDecodeBytes(value)));
  } catch {
    throw new Error(`Session token invalid: invalid JWT ${label}`);
  }
}

function requiredString(value, label) {
  if (typeof value !== 'string' || value === '') throw new Error(`Session token ${label} is required`);
  return value;
}

function requiredNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Session token ${label} must be a number`);
  return value;
}

function requiredPositiveNumber(value, label) {
  const number = requiredNumber(value, label);
  if (number <= 0) throw new Error(`Session token ${label} must be positive`);
  return number;
}

function requiredRouterEnvironment(value) {
  if (value !== 'production' && value !== 'staging') throw new Error('Session environment is invalid');
  return value;
}

function base64UrlEncodeJson(value) {
  return base64UrlEncodeBytes(encoder.encode(JSON.stringify(value)));
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeBytes(value) {
  if (typeof value !== 'string' || /[^A-Za-z0-9_-]/.test(value)) throw new Error('Session token invalid: malformed base64url');
  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function constantTimeEqualBytes(expected, actual) {
  if (expected.byteLength !== actual.byteLength) return false;
  let diff = 0;
  for (let index = 0; index < expected.byteLength; index += 1) diff |= expected[index] ^ actual[index];
  return diff === 0;
}
```

- [ ] **Step 4: Run JWT tests and verify GREEN**

Run:

```bash
node --test apps/pages-auth/src/jwt.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit JWT helpers**

```bash
git add apps/pages-auth/src/jwt.js apps/pages-auth/src/jwt.test.js
git commit -m "feat(auth): 增加用途绑定 session JWT"
```

### Task 4: Host-Only Cookie and Host Binding Helpers

**Files:**

- Create: `apps/pages-auth/src/cookies.js`
- Create: `apps/pages-auth/src/cookies.test.js`

- [ ] **Step 1: Write failing cookie tests**

Create `apps/pages-auth/src/cookies.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTH_SESSION_COOKIE,
  SITE_SESSION_COOKIE,
  buildAuthSessionCookie,
  buildClearAuthSessionCookie,
  buildClearSiteSessionCookie,
  buildSiteSessionCookie,
  isAuthSessionHost,
  isSiteSessionHost,
} from './cookies.js';

test('builds host-only auth_session cookies without Domain', () => {
  const cookie = buildAuthSessionCookie('jwt.auth', { maxAgeSeconds: 1209600 });

  assert.match(cookie, new RegExp(`^${AUTH_SESSION_COOKIE}=jwt\\.auth;`));
  assert.match(cookie, /Secure/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=1209600/);
  assert.doesNotMatch(cookie, /Domain=/i);
});

test('builds host-only site_session cookies without Domain', () => {
  const cookie = buildSiteSessionCookie('jwt.site', { maxAgeSeconds: 604800 });

  assert.match(cookie, new RegExp(`^${SITE_SESSION_COOKIE}=jwt\\.site;`));
  assert.doesNotMatch(cookie, /Domain=/i);
});

test('builds clearing cookies for host-only sessions', () => {
  assert.match(buildClearAuthSessionCookie(), new RegExp(`^${AUTH_SESSION_COOKIE}=;`));
  assert.match(buildClearAuthSessionCookie(), /Max-Age=0/);
  assert.match(buildClearSiteSessionCookie(), new RegExp(`^${SITE_SESSION_COOKIE}=;`));
  assert.match(buildClearSiteSessionCookie(), /Max-Age=0/);
});

test('validates auth host by environment', () => {
  assert.equal(isAuthSessionHost('auth.pages.xd.team', 'production'), true);
  assert.equal(isAuthSessionHost('auth-staging.pages.xd.team', 'staging'), true);
  assert.equal(isAuthSessionHost('auth.pages.xd.team', 'staging'), false);
  assert.equal(isAuthSessionHost('api.pages.xd.team', 'production'), false);
});

test('validates site session host by environment and rejects platform hosts', () => {
  assert.equal(isSiteSessionHost('demo.pages.xd.team', 'production'), true);
  assert.equal(isSiteSessionHost('demo-staging.pages.xd.team', 'staging'), true);
  assert.equal(isSiteSessionHost('demo.pages.xd.team', 'staging'), false);
  assert.equal(isSiteSessionHost('auth.pages.xd.team', 'production'), false);
  assert.equal(isSiteSessionHost('demo.workers.xd.team', 'production'), false);
});
```

- [ ] **Step 2: Run cookie tests and verify RED**

Run:

```bash
node --test apps/pages-auth/src/cookies.test.js
```

Expected: FAIL with module-not-found for `apps/pages-auth/src/cookies.js`.

- [ ] **Step 3: Implement cookie helpers**

Create `apps/pages-auth/src/cookies.js`:

```js
import { classifyHost } from '../../pages-router/src/host.js';

export const AUTH_SESSION_COOKIE = '__Host-pages_auth_session';
export const SITE_SESSION_COOKIE = '__Host-pages_site_session';

export function buildAuthSessionCookie(token, { maxAgeSeconds }) {
  return buildSessionCookie(AUTH_SESSION_COOKIE, token, maxAgeSeconds);
}

export function buildSiteSessionCookie(token, { maxAgeSeconds }) {
  return buildSessionCookie(SITE_SESSION_COOKIE, token, maxAgeSeconds);
}

export function buildClearAuthSessionCookie() {
  return buildSessionCookie(AUTH_SESSION_COOKIE, '', 0);
}

export function buildClearSiteSessionCookie() {
  return buildSessionCookie(SITE_SESSION_COOKIE, '', 0);
}

export function isAuthSessionHost(hostname, environment) {
  if (environment === 'production') return hostname === 'auth.pages.xd.team';
  if (environment === 'staging') return hostname === 'auth-staging.pages.xd.team';
  return false;
}

export function isSiteSessionHost(hostname, environment) {
  const classified = classifyHost(hostname, { environment });
  return classified.ok;
}

function buildSessionCookie(name, value, maxAgeSeconds) {
  if (!Number.isInteger(maxAgeSeconds) || maxAgeSeconds < 0) throw new Error('Cookie Max-Age must be a non-negative integer');
  return `${name}=${value}; Path=/; Max-Age=${maxAgeSeconds}; Secure; HttpOnly; SameSite=Lax`;
}
```

- [ ] **Step 4: Run cookie tests and verify GREEN**

Run:

```bash
node --test apps/pages-auth/src/cookies.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit cookie helpers**

```bash
git add apps/pages-auth/src/cookies.js apps/pages-auth/src/cookies.test.js
git commit -m "feat(auth): 增加 host-only session cookie 工具"
```

### Task 5: OAuth State Transaction

**Files:**

- Create: `apps/pages-auth/src/oauth-state.js`
- Create: `apps/pages-auth/src/oauth-state.test.js`

- [ ] **Step 1: Write failing OAuth state tests**

Create `apps/pages-auth/src/oauth-state.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { consumeOAuthState, createOAuthState } from './oauth-state.js';

const now = 1_700_000_000;

test('creates OAuth state bound to site host and return_to', async () => {
  const tx = await createOAuthState({
    environment: 'production',
    siteHost: 'demo.pages.xd.team',
    returnTo: 'https://demo.pages.xd.team/reports?q=1',
    now,
    ttlSeconds: 300,
    stateId: 'ost_state',
    stateSecret: 'secret',
  });

  assert.equal(tx.publicState, 'ost_state.secret');
  assert.equal(tx.record.id, 'ost_state');
  assert.equal(tx.record.secretHash.length, 64);
  assert.equal(tx.record.returnTo, 'https://demo.pages.xd.team/reports?q=1');
  assert.equal(tx.record.siteHost, 'demo.pages.xd.team');
  assert.equal(tx.record.expiresAt, now + 300);
  assert.equal(tx.record.consumedAt, null);
});

test('rejects open redirects and cross-environment site hosts', async () => {
  await assert.rejects(
    () =>
      createOAuthState({
        environment: 'production',
        siteHost: 'demo.pages.xd.team',
        returnTo: 'https://evil.example/path',
        now,
        ttlSeconds: 300,
      }),
    /return_to/i
  );
  await assert.rejects(
    () =>
      createOAuthState({
        environment: 'staging',
        siteHost: 'demo.pages.xd.team',
        returnTo: 'https://demo.pages.xd.team/',
        now,
        ttlSeconds: 300,
      }),
    /site host/i
  );
});

test('consumes OAuth state once with matching secret', async () => {
  const tx = await createOAuthState({
    environment: 'production',
    siteHost: 'demo.pages.xd.team',
    returnTo: 'https://demo.pages.xd.team/',
    now,
    ttlSeconds: 300,
    stateId: 'ost_state',
    stateSecret: 'secret',
  });

  const consumed = await consumeOAuthState('ost_state.secret', tx.record, { now: now + 10 });

  assert.equal(consumed.ok, true);
  assert.equal(consumed.record.consumedAt, now + 10);
  assert.equal(consumed.returnTo, 'https://demo.pages.xd.team/');

  await assert.rejects(() => consumeOAuthState('ost_state.secret', consumed.record, { now: now + 11 }), /consumed/i);
});

test('rejects OAuth state with wrong secret or expiration', async () => {
  const tx = await createOAuthState({
    environment: 'production',
    siteHost: 'demo.pages.xd.team',
    returnTo: 'https://demo.pages.xd.team/',
    now,
    ttlSeconds: 300,
    stateId: 'ost_state',
    stateSecret: 'secret',
  });

  await assert.rejects(() => consumeOAuthState('ost_state.wrong', tx.record, { now: now + 10 }), /secret/i);
  await assert.rejects(() => consumeOAuthState('ost_state.secret', tx.record, { now: now + 301 }), /expired/i);
});
```

- [ ] **Step 2: Run OAuth state tests and verify RED**

Run:

```bash
node --test apps/pages-auth/src/oauth-state.test.js
```

Expected: FAIL with module-not-found for `apps/pages-auth/src/oauth-state.js`.

- [ ] **Step 3: Implement OAuth state transaction**

Create `apps/pages-auth/src/oauth-state.js`:

```js
import { classifyHost } from '../../pages-router/src/host.js';
import { constantTimeEqualHex, createOpaqueToken, sha256Hex } from './id.js';

export async function createOAuthState({
  environment,
  siteHost,
  returnTo,
  now,
  ttlSeconds,
  stateId = createOpaqueToken('ost'),
  stateSecret = createOpaqueToken('sec'),
}) {
  const normalizedSiteHost = validateSiteHost(siteHost, environment);
  const normalizedReturnTo = validateReturnTo(returnTo, normalizedSiteHost);

  return {
    publicState: `${stateId}.${stateSecret}`,
    record: {
      id: stateId,
      environment,
      siteHost: normalizedSiteHost,
      returnTo: normalizedReturnTo,
      secretHash: await sha256Hex(stateSecret),
      issuedAt: now,
      expiresAt: now + ttlSeconds,
      consumedAt: null,
    },
  };
}

export async function consumeOAuthState(publicState, record, { now }) {
  const [stateId, stateSecret] = parsePublicState(publicState);
  if (!record || record.id !== stateId) throw new Error('OAuth state invalid: unknown state');
  if (record.consumedAt !== null) throw new Error('OAuth state invalid: already consumed');
  if (record.expiresAt <= now) throw new Error('OAuth state invalid: expired');

  const actualHash = await sha256Hex(stateSecret);
  if (!constantTimeEqualHex(record.secretHash, actualHash)) throw new Error('OAuth state invalid: secret mismatch');

  const consumedRecord = { ...record, consumedAt: now };
  return { ok: true, record: consumedRecord, returnTo: record.returnTo, siteHost: record.siteHost };
}

function parsePublicState(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 2 || parts.some((part) => part === '')) throw new Error('OAuth state invalid: malformed state');
  return parts;
}

function validateSiteHost(siteHost, environment) {
  const host = String(siteHost || '')
    .trim()
    .toLowerCase();
  const classified = classifyHost(host, { environment });
  if (!classified.ok) throw new Error('OAuth state invalid: site host is not allowed');
  return classified.hostname;
}

function validateReturnTo(returnTo, siteHost) {
  let url;
  try {
    url = new URL(returnTo);
  } catch {
    throw new Error('OAuth state invalid: return_to must be an absolute URL');
  }

  if (url.protocol !== 'https:') throw new Error('OAuth state invalid: return_to must use https');
  if (url.username || url.password) throw new Error('OAuth state invalid: return_to credentials are not allowed');
  if (url.hash) throw new Error('OAuth state invalid: return_to fragment is not allowed');
  if (url.hostname !== siteHost) throw new Error('OAuth state invalid: return_to host is not allowed');
  return url.toString();
}
```

- [ ] **Step 4: Run OAuth state tests and verify GREEN**

Run:

```bash
node --test apps/pages-auth/src/oauth-state.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit OAuth state transaction**

```bash
git add apps/pages-auth/src/oauth-state.js apps/pages-auth/src/oauth-state.test.js
git commit -m "feat(auth): 增加一次性 OAuth state 事务"
```

### Task 6: CLI Login Transaction

**Files:**

- Create: `apps/pages-auth/src/cli-login.js`
- Create: `apps/pages-auth/src/cli-login.test.js`

- [ ] **Step 1: Write failing CLI login tests**

Create `apps/pages-auth/src/cli-login.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { confirmCliLogin, consumeCliLogin, createCliLogin } from './cli-login.js';

const now = 1_700_000_000;

test('creates pending CLI login with login secret and device code', async () => {
  const tx = await createCliLogin({
    environment: 'production',
    now,
    ttlSeconds: 600,
    loginId: 'cli_login',
    loginSecret: 'secret',
    deviceCode: '12345678',
  });

  assert.equal(tx.loginId, 'cli_login');
  assert.equal(tx.loginSecret, 'secret');
  assert.equal(tx.deviceCode, '12345678');
  assert.equal(tx.record.status, 'pending');
  assert.equal(tx.record.expiresAt, now + 600);
  assert.equal(tx.record.secretHash.length, 64);
});

test('does not let CLI consume before browser confirmation', async () => {
  const tx = await createCliLogin({
    environment: 'production',
    now,
    ttlSeconds: 600,
    loginId: 'cli_login',
    loginSecret: 'secret',
    deviceCode: '12345678',
  });

  await assert.rejects(
    () => consumeCliLogin({ loginId: 'cli_login', loginSecret: 'secret' }, tx.record, { now: now + 10 }),
    /pending/i
  );
});

test('confirms with matching device code and consumes once with login secret', async () => {
  const tx = await createCliLogin({
    environment: 'production',
    now,
    ttlSeconds: 600,
    loginId: 'cli_login',
    loginSecret: 'secret',
    deviceCode: '12345678',
  });
  const confirmed = confirmCliLogin({ deviceCode: '12345678', userId: 'usr_123' }, tx.record, { now: now + 20 });

  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.userId, 'usr_123');

  const consumed = await consumeCliLogin({ loginId: 'cli_login', loginSecret: 'secret' }, confirmed, { now: now + 21 });

  assert.equal(consumed.userId, 'usr_123');
  assert.equal(consumed.record.status, 'consumed');
  await assert.rejects(
    () => consumeCliLogin({ loginId: 'cli_login', loginSecret: 'secret' }, consumed.record, { now: now + 22 }),
    /consumed/i
  );
});

test('rejects wrong device code, wrong login secret, and expiration', async () => {
  const tx = await createCliLogin({
    environment: 'production',
    now,
    ttlSeconds: 600,
    loginId: 'cli_login',
    loginSecret: 'secret',
    deviceCode: '12345678',
  });

  assert.throws(() => confirmCliLogin({ deviceCode: '00000000', userId: 'usr_123' }, tx.record, { now: now + 20 }), /device/i);
  const confirmed = confirmCliLogin({ deviceCode: '12345678', userId: 'usr_123' }, tx.record, { now: now + 20 });
  await assert.rejects(
    () => consumeCliLogin({ loginId: 'cli_login', loginSecret: 'wrong' }, confirmed, { now: now + 21 }),
    /secret/i
  );
  await assert.rejects(
    () => consumeCliLogin({ loginId: 'cli_login', loginSecret: 'secret' }, confirmed, { now: now + 601 }),
    /expired/i
  );
});
```

- [ ] **Step 2: Run CLI login tests and verify RED**

Run:

```bash
node --test apps/pages-auth/src/cli-login.test.js
```

Expected: FAIL with module-not-found for `apps/pages-auth/src/cli-login.js`.

- [ ] **Step 3: Implement CLI login transaction**

Create `apps/pages-auth/src/cli-login.js`:

```js
import { constantTimeEqualHex, createOpaqueToken, sha256Hex } from './id.js';

const DEVICE_CODE_RE = /^[0-9]{8}$/;

export async function createCliLogin({
  environment,
  now,
  ttlSeconds,
  loginId = createOpaqueToken('cli'),
  loginSecret = createOpaqueToken('sec'),
  deviceCode = createDeviceCode(),
}) {
  if (environment !== 'production' && environment !== 'staging') throw new Error('CLI login environment is invalid');
  if (!DEVICE_CODE_RE.test(deviceCode)) throw new Error('CLI login device code must be 8 digits');

  return {
    loginId,
    loginSecret,
    deviceCode,
    record: {
      id: loginId,
      environment,
      deviceCode,
      secretHash: await sha256Hex(loginSecret),
      status: 'pending',
      userId: null,
      issuedAt: now,
      confirmedAt: null,
      consumedAt: null,
      expiresAt: now + ttlSeconds,
    },
  };
}

export function confirmCliLogin({ deviceCode, userId }, record, { now }) {
  assertUsableRecord(record, now);
  if (record.status !== 'pending') throw new Error(`CLI login invalid: status is ${record.status}`);
  if (record.deviceCode !== deviceCode) throw new Error('CLI login invalid: device code mismatch');
  if (typeof userId !== 'string' || userId === '') throw new Error('CLI login invalid: user id is required');

  return { ...record, status: 'confirmed', userId, confirmedAt: now };
}

export async function consumeCliLogin({ loginId, loginSecret }, record, { now }) {
  assertUsableRecord(record, now);
  if (record.id !== loginId) throw new Error('CLI login invalid: unknown login id');
  if (record.status === 'pending') throw new Error('CLI login invalid: still pending');
  if (record.status === 'consumed') throw new Error('CLI login invalid: already consumed');
  if (record.status !== 'confirmed') throw new Error(`CLI login invalid: status is ${record.status}`);

  const actualHash = await sha256Hex(loginSecret);
  if (!constantTimeEqualHex(record.secretHash, actualHash)) throw new Error('CLI login invalid: secret mismatch');

  const consumedRecord = { ...record, status: 'consumed', consumedAt: now };
  return { userId: record.userId, environment: record.environment, record: consumedRecord };
}

function assertUsableRecord(record, now) {
  if (!record || typeof record !== 'object') throw new Error('CLI login invalid: missing record');
  if (record.expiresAt <= now) throw new Error('CLI login invalid: expired');
}

function createDeviceCode() {
  const array = new Uint32Array(1);
  crypto.getRandomValues(array);
  return String(array[0] % 100_000_000).padStart(8, '0');
}
```

- [ ] **Step 4: Run CLI login tests and verify GREEN**

Run:

```bash
node --test apps/pages-auth/src/cli-login.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit CLI login transaction**

```bash
git add apps/pages-auth/src/cli-login.js apps/pages-auth/src/cli-login.test.js
git commit -m "feat(auth): 增加 CLI 登录事务状态机"
```

### Task 7: Session Record Lifecycle

**Files:**

- Create: `apps/pages-auth/src/session-record.js`
- Create: `apps/pages-auth/src/session-record.test.js`

- [ ] **Step 1: Write failing session record tests**

Create `apps/pages-auth/src/session-record.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { createSessionRecord, refreshSessionRecord, revokeSessionRecord } from './session-record.js';

const now = 1_700_000_000;

test('creates revocable auth session records with idle and absolute expiration', () => {
  const record = createSessionRecord({
    sid: 'sid_auth',
    userId: 'usr_123',
    purpose: 'auth_session',
    now,
    idleTtlSeconds: 120,
    absoluteTtlSeconds: 300,
  });

  assert.deepEqual(record, {
    sid: 'sid_auth',
    userId: 'usr_123',
    purpose: 'auth_session',
    issuedAt: now,
    lastSeenAt: now,
    expiresAt: now + 120,
    absoluteExpiresAt: now + 300,
    revokedAt: null,
    authTime: now,
  });
});

test('refreshes idle expiration without passing absolute expiration', () => {
  const record = createSessionRecord({
    sid: 'sid_auth',
    userId: 'usr_123',
    purpose: 'auth_session',
    now,
    idleTtlSeconds: 120,
    absoluteTtlSeconds: 300,
  });
  const refreshed = refreshSessionRecord(record, { now: now + 250, idleTtlSeconds: 120 });

  assert.equal(refreshed.lastSeenAt, now + 250);
  assert.equal(refreshed.expiresAt, now + 300);
});

test('rejects refresh after idle expiration, absolute expiration, or revocation', () => {
  const record = createSessionRecord({
    sid: 'sid_auth',
    userId: 'usr_123',
    purpose: 'auth_session',
    now,
    idleTtlSeconds: 120,
    absoluteTtlSeconds: 300,
  });

  assert.throws(() => refreshSessionRecord(record, { now: now + 121, idleTtlSeconds: 120 }), /expired/i);
  assert.throws(() => refreshSessionRecord(record, { now: now + 301, idleTtlSeconds: 120 }), /expired/i);

  const revoked = revokeSessionRecord(record, { now: now + 30 });
  assert.equal(revoked.revokedAt, now + 30);
  assert.throws(() => refreshSessionRecord(revoked, { now: now + 31, idleTtlSeconds: 120 }), /revoked/i);
});
```

- [ ] **Step 2: Run session record tests and verify RED**

Run:

```bash
node --test apps/pages-auth/src/session-record.test.js
```

Expected: FAIL with module-not-found for `apps/pages-auth/src/session-record.js`.

- [ ] **Step 3: Implement session record lifecycle**

Create `apps/pages-auth/src/session-record.js`:

```js
export function createSessionRecord({ sid, userId, purpose, now, idleTtlSeconds, absoluteTtlSeconds }) {
  requireString(sid, 'sid');
  requireString(userId, 'userId');
  requireString(purpose, 'purpose');
  requirePositive(idleTtlSeconds, 'idleTtlSeconds');
  requirePositive(absoluteTtlSeconds, 'absoluteTtlSeconds');

  return {
    sid,
    userId,
    purpose,
    issuedAt: now,
    lastSeenAt: now,
    expiresAt: now + idleTtlSeconds,
    absoluteExpiresAt: now + absoluteTtlSeconds,
    revokedAt: null,
    authTime: now,
  };
}

export function refreshSessionRecord(record, { now, idleTtlSeconds }) {
  assertActive(record, now);
  requirePositive(idleTtlSeconds, 'idleTtlSeconds');

  return {
    ...record,
    lastSeenAt: now,
    expiresAt: Math.min(now + idleTtlSeconds, record.absoluteExpiresAt),
  };
}

export function revokeSessionRecord(record, { now }) {
  if (!record || typeof record !== 'object') throw new Error('Session record is missing');
  if (record.revokedAt !== null) return record;
  return { ...record, revokedAt: now };
}

function assertActive(record, now) {
  if (!record || typeof record !== 'object') throw new Error('Session record is missing');
  if (record.revokedAt !== null) throw new Error('Session record revoked');
  if (record.absoluteExpiresAt <= now) throw new Error('Session record expired');
  if (record.expiresAt <= now) throw new Error('Session record expired');
}

function requireString(value, label) {
  if (typeof value !== 'string' || value === '') throw new Error(`Session ${label} is required`);
}

function requirePositive(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw new Error(`Session ${label} must be positive`);
}
```

- [ ] **Step 4: Run session record tests and verify GREEN**

Run:

```bash
node --test apps/pages-auth/src/session-record.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit session record lifecycle**

```bash
git add apps/pages-auth/src/session-record.js apps/pages-auth/src/session-record.test.js
git commit -m "feat(auth): 增加 session 刷新和吊销记录"
```

### Task 8: Worker Entry and Durable Object Shells

**Files:**

- Create: `apps/pages-auth/src/index.js`
- Create: `apps/pages-auth/src/index.test.js`

- [ ] **Step 1: Write failing Worker entry tests**

Create `apps/pages-auth/src/index.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import worker, { AuthSessionDO, CliLoginDO, OAuthStateDO } from './index.js';

test('health endpoint returns non-sensitive environment status without cache', async () => {
  const response = await worker.fetch(new Request('https://auth.pages.xd.team/.xd-pages/health'), {
    PAGES_ENV: 'production',
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), { status: 'ok', service: 'pages-auth', environment: 'production' });
});

test('unknown paths return safe no-store errors', async () => {
  const response = await worker.fetch(new Request('https://auth.pages.xd.team/not-found'), {
    PAGES_ENV: 'production',
  });

  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await response.json()).error.code, 'NOT_FOUND');
});

test('invalid PAGES_ENV fails closed', async () => {
  const response = await worker.fetch(new Request('https://auth.pages.xd.team/.xd-pages/health'), {
    PAGES_ENV: 'preview',
  });

  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, 'AUTH_ENV_INVALID');
});

test('exports Durable Object shell classes', () => {
  assert.equal(typeof OAuthStateDO, 'function');
  assert.equal(typeof CliLoginDO, 'function');
  assert.equal(typeof AuthSessionDO, 'function');
});
```

- [ ] **Step 2: Run Worker entry tests and verify RED**

Run:

```bash
node --test apps/pages-auth/src/index.test.js
```

Expected: FAIL with module-not-found for `apps/pages-auth/src/index.js`.

- [ ] **Step 3: Implement Worker entry and DO shell classes**

Create `apps/pages-auth/src/index.js`:

```js
import { jsonResponse } from '@xd/worker-kit';

export default {
  async fetch(request, env) {
    const environment = readEnvironment(env);
    if (!environment) return errorResponse('AUTH_ENV_INVALID', 'Auth environment is invalid.', 500);

    const url = new URL(request.url);
    if (url.pathname === '/.xd-pages/health') {
      return jsonResponse({ status: 'ok', service: 'pages-auth', environment }, 200, { 'Cache-Control': 'no-store' });
    }

    return errorResponse('NOT_FOUND', 'Endpoint not found.', 404);
  },
};

export class OAuthStateDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
}

export class CliLoginDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
}

export class AuthSessionDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
  }
}

function readEnvironment(env) {
  if (env?.PAGES_ENV === 'production' || env?.PAGES_ENV === 'staging') return env.PAGES_ENV;
  return null;
}

function errorResponse(code, message, status) {
  return jsonResponse({ error: { code, message } }, status, { 'Cache-Control': 'no-store' });
}
```

- [ ] **Step 4: Run Worker entry tests and verify GREEN**

Run:

```bash
node --test apps/pages-auth/src/index.test.js
```

Expected: PASS.

- [ ] **Step 5: Run all pages-auth tests**

Run:

```bash
node --test apps/pages-auth/src/*.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit Worker entry**

```bash
git add apps/pages-auth/src/index.js apps/pages-auth/src/index.test.js
git commit -m "feat(auth): 增加 auth worker 安全入口"
```

### Task 9: Workspace Verification

**Files:**

- Modify only if verification exposes formatting or lockfile drift:
  - `pnpm-lock.yaml`
  - files under `apps/pages-auth/src/`

- [ ] **Step 1: Run package install**

Run:

```bash
pnpm install
```

Expected: exits 0 and reports lockfile up to date.

- [ ] **Step 2: Run focused auth tests**

Run:

```bash
node --test apps/pages-auth/src/*.test.js
```

Expected: PASS.

- [ ] **Step 3: Run auth and router focused tests together**

Run:

```bash
node --test apps/pages-auth/src/*.test.js apps/pages-router/src/*.test.js
```

Expected: PASS.

- [ ] **Step 4: Run full test suite**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 5: Run lint**

Run:

```bash
pnpm lint
```

Expected: PASS.

- [ ] **Step 6: Run format check**

Run:

```bash
pnpm exec prettier --check apps/pages-auth docs/superpowers/plans/2026-06-15-pages-v2-auth-session-foundation.md
```

Expected: PASS.

- [ ] **Step 7: Confirm local SSO reference is not staged**

Run:

```bash
git status --short
git ls-files docs/xd-sso.md --error-unmatch
```

Expected: `docs/xd-sso.md` may appear as untracked local reference; `git ls-files ... --error-unmatch` must fail.

- [ ] **Step 8: Commit verification-only fixes if needed**

If formatting changes are needed, commit them:

```bash
git add apps/pages-auth docs/superpowers/plans/2026-06-15-pages-v2-auth-session-foundation.md
git commit -m "test(auth): 格式化 auth 基础测试"
```

If no files changed, skip this commit.

## Plan Self-Review

- Spec coverage: this plan covers M2 foundation only. It creates auth primitives, cookie/session boundaries, and safe Worker shells; real SSO exchange and router/API integration remain later M2/M6 follow-up work.
- Security coverage: OAuth state and CLI login are one-time, secret-bound, expiring transactions; session JWTs bind issuer, audience, environment, purpose, subject, `kid`, `iat`, `nbf`, and `exp`; cookies are host-only and contain no `Domain`.
- v1/v2 boundary: all host checks use `pages.xd.team`; no v1 `workers.xd.team` auth compatibility is introduced.
- Local SSO reference: this plan intentionally does not read or commit `docs/xd-sso.md`; tests use fake secrets only.
- Known intentional limitation: Durable Object classes are shells in this milestone. Their storage/fetch APIs should be expanded when real OAuth callback and CLI browser confirmation endpoints are wired.
