# Pages v2 Router Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the M1 `apps/pages-router` security foundation for v2 `*.pages.xd.team` data-plane routing.

**Architecture:** This plan creates a narrow, testable Cloudflare Worker module that enforces the v2 data-plane safety boundary before any future SSO or WFP production dispatch work. The router classifies `pages.xd.team` hostnames, rejects reserved hosts and paths, applies a fail-closed company IP allowlist, strips platform cookies/headers before dispatch, dispatches through a mockable WFP namespace binding, and scrubs platform response headers/cookies.

**Tech Stack:** Cloudflare Worker module syntax, Node `node:test`, workspace packages `@xd/ip-guard`, `@xd/pages-runtime-protocol`, and `@xd/worker-kit`.

---

## Scope

This is M1 from `docs/superpowers/specs/2026-06-15-pages-v2-full-implementation-design.md`. It does not implement real SSO, real D1 schema, real WFP upload, CLI, access keys, or route snapshot persistence. Later milestones will replace the in-memory/mock route snapshot input with D1/KV snapshots and real session/JWT signing.

## File Structure

Create:

```text
apps/pages-router/package.json
apps/pages-router/src/host.js
apps/pages-router/src/host.test.js
apps/pages-router/src/platform-path.js
apps/pages-router/src/platform-path.test.js
apps/pages-router/src/sanitize.js
apps/pages-router/src/sanitize.test.js
apps/pages-router/src/index.js
apps/pages-router/src/index.test.js
apps/pages-router/wrangler.template.toml
```

Responsibilities:

- `host.js`: Parse and validate production/staging hostnames.
- `platform-path.js`: Identify `/.xd-pages/*` reserved platform paths.
- `sanitize.js`: Strip platform-owned request headers/cookies and response headers/cookies.
- `index.js`: Worker `fetch()` entry, IP gate, host/path gate, route snapshot lookup, mockable dispatch, and JSON errors.
- `wrangler.template.toml`: v2 router deployment template with placeholder bindings only.

### Task 1: Router Package Scaffold

**Files:**

- Create: `apps/pages-router/package.json`
- Create: `apps/pages-router/wrangler.template.toml`

- [ ] **Step 1: Create package manifest**

Create `apps/pages-router/package.json`:

```json
{
  "name": "@xd/pages-router",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "@xd/ip-guard": "workspace:*",
    "@xd/pages-runtime-protocol": "workspace:*",
    "@xd/worker-kit": "workspace:*"
  },
  "devDependencies": {
    "wrangler": "catalog:"
  }
}
```

- [ ] **Step 2: Create wrangler template**

Create `apps/pages-router/wrangler.template.toml`:

```toml
name = "__WORKER_NAME__"
main = "src/index.js"
compatibility_date = "2026-06-15"

[vars]
PAGES_ENV = "__PAGES_ENV__"
PUBLIC_AUTH_BASE = "__PUBLIC_AUTH_BASE__"
PUBLIC_API_BASE = "__PUBLIC_API_BASE__"
PUBLIC_SITE_SUFFIX = "__PUBLIC_SITE_SUFFIX__"
ROUTE_CACHE_TTL_SECONDS = "__ROUTE_CACHE_TTL_SECONDS__"
ROUTER_IP_ALLOWLIST_CIDRS = "__ROUTER_IP_ALLOWLIST_CIDRS__"
ROUTER_JWKS_URL = "__ROUTER_JWKS_URL__"

[[services]]
binding = "PAGES_AUTH"
service = "__PAGES_AUTH_SERVICE__"

[[dispatch_namespaces]]
binding = "PAGES_DISPATCH"
namespace = "__PAGES_DISPATCH_NAMESPACE__"
```

- [ ] **Step 3: Verify workspace sees the package**

Run:

```bash
pnpm --filter @xd/pages-router exec pwd
```

Expected: command exits 0 and prints the absolute `apps/pages-router` path.

- [ ] **Step 4: Commit scaffold**

```bash
git add apps/pages-router/package.json apps/pages-router/wrangler.template.toml
git commit -m "feat(router): 新增 pages v2 router 包"
```

### Task 2: Host Classification

**Files:**

- Create: `apps/pages-router/src/host.js`
- Create: `apps/pages-router/src/host.test.js`

- [ ] **Step 1: Write failing host tests**

Create `apps/pages-router/src/host.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyHost } from './host.js';

test('classifies production site hostnames', () => {
  assert.deepEqual(classifyHost('demo.pages.xd.team', { environment: 'production' }), {
    ok: true,
    environment: 'production',
    hostname: 'demo.pages.xd.team',
    slug: 'demo',
  });
});

test('classifies staging site hostnames', () => {
  assert.deepEqual(classifyHost('demo-staging.pages.xd.team', { environment: 'staging' }), {
    ok: true,
    environment: 'staging',
    hostname: 'demo-staging.pages.xd.team',
    slug: 'demo',
  });
});

test('rejects platform reserved hosts', () => {
  assert.equal(classifyHost('api.pages.xd.team', { environment: 'production' }).code, 'RESERVED_HOST');
  assert.equal(classifyHost('auth.pages.xd.team', { environment: 'production' }).code, 'RESERVED_HOST');
  assert.equal(classifyHost('api-staging.pages.xd.team', { environment: 'staging' }).code, 'RESERVED_HOST');
  assert.equal(classifyHost('auth-staging.pages.xd.team', { environment: 'staging' }).code, 'RESERVED_HOST');
});

test('rejects production slugs that look like staging hosts', () => {
  assert.equal(classifyHost('demo-staging.pages.xd.team', { environment: 'production' }).code, 'RESERVED_SLUG');
});

test('rejects invalid hostnames and cross-environment hosts', () => {
  assert.equal(classifyHost('demo.pages.xd.team', { environment: 'staging' }).code, 'HOST_ENV_MISMATCH');
  assert.equal(classifyHost('demo-staging.pages.xd.team', { environment: 'production' }).code, 'RESERVED_SLUG');
  assert.equal(classifyHost('foo.bar.pages.xd.team', { environment: 'production' }).code, 'INVALID_HOST');
  assert.equal(classifyHost('pages.xd.team', { environment: 'production' }).code, 'INVALID_HOST');
  assert.equal(classifyHost('demo.workers.xd.team', { environment: 'production' }).code, 'INVALID_HOST');
});

test('rejects reserved slugs and invalid slug syntax', () => {
  assert.equal(classifyHost('admin.pages.xd.team', { environment: 'production' }).code, 'RESERVED_SLUG');
  assert.equal(classifyHost('-bad.pages.xd.team', { environment: 'production' }).code, 'INVALID_SLUG');
  assert.equal(classifyHost('Bad.pages.xd.team', { environment: 'production' }).code, 'INVALID_SLUG');
});
```

- [ ] **Step 2: Run host tests and verify RED**

Run:

```bash
node --test apps/pages-router/src/host.test.js
```

Expected: FAIL with module-not-found for `apps/pages-router/src/host.js`.

- [ ] **Step 3: Implement host classification**

Create `apps/pages-router/src/host.js`:

```js
import { isValidSiteSlug } from '@xd/pages-runtime-protocol';

const PROD_SUFFIX = '.pages.xd.team';
const STAGING_SUFFIX = '-staging.pages.xd.team';

const RESERVED_HOSTS = new Set([
  'api.pages.xd.team',
  'auth.pages.xd.team',
  'admin.pages.xd.team',
  'router.pages.xd.team',
  'kv-gateway.pages.xd.team',
  'api-staging.pages.xd.team',
  'auth-staging.pages.xd.team',
  'admin-staging.pages.xd.team',
  'router-staging.pages.xd.team',
  'kv-gateway-staging.pages.xd.team',
]);

const RESERVED_SLUGS = new Set([
  'api',
  'api-staging',
  'auth',
  'auth-staging',
  'admin',
  'admin-staging',
  'manager',
  'manager-staging',
  'router',
  'router-staging',
  'kv-gateway',
  'kv-gateway-staging',
  'pages',
  'login',
  'logout',
  'callback',
  'oauth',
  'sso',
  'internal',
]);

export function classifyHost(hostname, { environment }) {
  const normalized = String(hostname || '').trim();

  if (RESERVED_HOSTS.has(normalized)) return rejected('RESERVED_HOST', normalized, environment);
  if (normalized.endsWith('.internal.pages.xd.team')) return rejected('RESERVED_HOST', normalized, environment);

  if (environment === 'production') return classifyProductionHost(normalized);
  if (environment === 'staging') return classifyStagingHost(normalized);

  return rejected('INVALID_ENVIRONMENT', normalized, environment);
}

function classifyProductionHost(hostname) {
  if (!hostname.endsWith(PROD_SUFFIX) || hostname === 'pages.xd.team') {
    return rejected('INVALID_HOST', hostname, 'production');
  }

  const slug = hostname.slice(0, -PROD_SUFFIX.length);
  if (slug.includes('.')) return rejected('INVALID_HOST', hostname, 'production');
  if (slug.endsWith('-staging')) return rejected('RESERVED_SLUG', hostname, 'production');

  return validateSlug({ hostname, slug, environment: 'production' });
}

function classifyStagingHost(hostname) {
  if (!hostname.endsWith(STAGING_SUFFIX)) {
    if (hostname.endsWith(PROD_SUFFIX)) return rejected('HOST_ENV_MISMATCH', hostname, 'staging');
    return rejected('INVALID_HOST', hostname, 'staging');
  }

  const slug = hostname.slice(0, -STAGING_SUFFIX.length);
  if (slug.includes('.')) return rejected('INVALID_HOST', hostname, 'staging');

  return validateSlug({ hostname, slug, environment: 'staging' });
}

function validateSlug({ hostname, slug, environment }) {
  if (RESERVED_SLUGS.has(slug)) return rejected('RESERVED_SLUG', hostname, environment);
  if (!isValidSiteSlug(slug)) return rejected('INVALID_SLUG', hostname, environment);

  return { ok: true, environment, hostname, slug };
}

function rejected(code, hostname, environment) {
  return { ok: false, code, hostname, environment };
}
```

- [ ] **Step 4: Run host tests and verify GREEN**

Run:

```bash
node --test apps/pages-router/src/host.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit host classifier**

```bash
git add apps/pages-router/src/host.js apps/pages-router/src/host.test.js
git commit -m "feat(router): 校验 pages v2 子站域名"
```

### Task 3: Platform Path Reservation

**Files:**

- Create: `apps/pages-router/src/platform-path.js`
- Create: `apps/pages-router/src/platform-path.test.js`

- [ ] **Step 1: Write failing platform path tests**

Create `apps/pages-router/src/platform-path.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { isPlatformPath } from './platform-path.js';

test('detects platform reserved paths', () => {
  assert.equal(isPlatformPath('/.xd-pages/auth/callback'), true);
  assert.equal(isPlatformPath('/.xd-pages/runtime/v1/kv/get'), true);
  assert.equal(isPlatformPath('/.xd-pages/health'), true);
});

test('does not reserve normal user paths', () => {
  assert.equal(isPlatformPath('/'), false);
  assert.equal(isPlatformPath('/app/.xd-pages'), false);
  assert.equal(isPlatformPath('/xd-pages/auth/callback'), false);
});
```

- [ ] **Step 2: Run platform path tests and verify RED**

Run:

```bash
node --test apps/pages-router/src/platform-path.test.js
```

Expected: FAIL with module-not-found for `apps/pages-router/src/platform-path.js`.

- [ ] **Step 3: Implement platform path helper**

Create `apps/pages-router/src/platform-path.js`:

```js
export const PLATFORM_PATH_PREFIX = '/.xd-pages/';

export function isPlatformPath(pathname) {
  return pathname === '/.xd-pages' || String(pathname || '').startsWith(PLATFORM_PATH_PREFIX);
}
```

- [ ] **Step 4: Run platform path tests and verify GREEN**

Run:

```bash
node --test apps/pages-router/src/platform-path.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit platform path helper**

```bash
git add apps/pages-router/src/platform-path.js apps/pages-router/src/platform-path.test.js
git commit -m "feat(router): 保留平台路径"
```

### Task 4: Header and Cookie Sanitization

**Files:**

- Create: `apps/pages-router/src/sanitize.js`
- Create: `apps/pages-router/src/sanitize.test.js`

- [ ] **Step 1: Write failing sanitization tests**

Create `apps/pages-router/src/sanitize.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeRequestForUserWorker, sanitizeUserWorkerResponse } from './sanitize.js';

test('strips platform request headers and platform cookies before dispatch', async () => {
  const request = new Request('https://demo.pages.xd.team/path', {
    headers: {
      Cookie: 'theme=dark; __Host-pages_site_session=secret; app=ok; __Secure-pages_capability=nope',
      'CF-Platform-Auth': 'fake',
      'X-Pages-Token': 'fake',
      'X-XD-Pages-Runtime': 'fake',
      Accept: 'text/html',
    },
  });

  const sanitized = sanitizeRequestForUserWorker(request, {
    'CF-Platform-Auth': 'internal.jwt',
    'CF-Platform-User': 'usr_123',
  });

  assert.equal(sanitized.headers.get('CF-Platform-Auth'), 'internal.jwt');
  assert.equal(sanitized.headers.get('CF-Platform-User'), 'usr_123');
  assert.equal(sanitized.headers.get('X-Pages-Token'), null);
  assert.equal(sanitized.headers.get('X-XD-Pages-Runtime'), null);
  assert.equal(sanitized.headers.get('Accept'), 'text/html');
  assert.equal(sanitized.headers.get('Cookie'), 'theme=dark; app=ok');
});

test('removes cookie header when only platform cookies were present', () => {
  const request = new Request('https://demo.pages.xd.team/path', {
    headers: {
      Cookie: '__Host-pages_site_session=secret; __Secure-pages_capability=nope',
    },
  });

  const sanitized = sanitizeRequestForUserWorker(request, {});

  assert.equal(sanitized.headers.get('Cookie'), null);
});

test('strips platform response headers and platform Set-Cookie values', async () => {
  const headers = new Headers({
    'CF-Platform-Trace-Id': 'fake',
    'X-Pages-Token': 'fake',
    'Content-Type': 'text/plain',
  });
  headers.append('Set-Cookie', '__Host-pages_site_session=evil; Path=/; Secure');
  headers.append('Set-Cookie', 'app=ok; Path=/; Secure');
  headers.append('Set-Cookie', 'bad=parent; Domain=.pages.xd.team; Path=/; Secure');

  const response = sanitizeUserWorkerResponse(new Response('ok', { status: 200, headers }));

  assert.equal(response.headers.get('CF-Platform-Trace-Id'), null);
  assert.equal(response.headers.get('X-Pages-Token'), null);
  assert.equal(response.headers.get('Content-Type'), 'text/plain');

  const setCookies = getSetCookies(response.headers);
  assert.deepEqual(setCookies, ['app=ok; Path=/; Secure']);
  assert.equal(await response.text(), 'ok');
});

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const value = headers.get('Set-Cookie');
  return value ? [value] : [];
}
```

- [ ] **Step 2: Run sanitization tests and verify RED**

Run:

```bash
node --test apps/pages-router/src/sanitize.test.js
```

Expected: FAIL with module-not-found for `apps/pages-router/src/sanitize.js`.

- [ ] **Step 3: Implement sanitization**

Create `apps/pages-router/src/sanitize.js`:

```js
const PLATFORM_HEADER_PREFIXES = ['cf-platform-', 'x-pages-', 'x-xd-pages-'];
const PLATFORM_COOKIE_PREFIXES = ['__Host-pages_', '__Secure-pages_'];
const FORBIDDEN_COOKIE_DOMAIN_RE = /;\s*domain=(?:\.pages\.xd\.team|pages\.xd\.team)\s*(?:;|$)/i;

export function sanitizeRequestForUserWorker(request, platformHeaders = {}) {
  const headers = new Headers(request.headers);

  for (const name of [...headers.keys()]) {
    if (isPlatformHeader(name)) headers.delete(name);
  }

  const cookie = sanitizeCookieHeader(headers.get('Cookie'));
  if (cookie) {
    headers.set('Cookie', cookie);
  } else {
    headers.delete('Cookie');
  }

  for (const [name, value] of Object.entries(platformHeaders)) {
    headers.set(name, value);
  }

  return new Request(request, { headers });
}

export function sanitizeUserWorkerResponse(response) {
  const headers = new Headers(response.headers);
  const setCookies = getSetCookies(headers);

  for (const name of [...headers.keys()]) {
    if (isPlatformHeader(name) || name.toLowerCase() === 'set-cookie') headers.delete(name);
  }

  for (const setCookie of setCookies.filter(isAllowedSetCookie)) {
    headers.append('Set-Cookie', setCookie);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function sanitizeCookieHeader(value) {
  if (!value) return '';

  const kept = [];
  for (const part of value.split(';')) {
    const trimmed = part.trim();
    if (!trimmed || !trimmed.includes('=')) continue;

    const [name] = trimmed.split('=', 1);
    if (isPlatformCookieName(name)) continue;
    kept.push(trimmed);
  }

  return kept.join('; ');
}

function isAllowedSetCookie(value) {
  const name = String(value || '').split('=', 1)[0];
  if (isPlatformCookieName(name)) return false;
  if (FORBIDDEN_COOKIE_DOMAIN_RE.test(value)) return false;
  return true;
}

function isPlatformHeader(name) {
  const lower = String(name || '').toLowerCase();
  return PLATFORM_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

function isPlatformCookieName(name) {
  return PLATFORM_COOKIE_PREFIXES.some((prefix) => String(name || '').startsWith(prefix));
}

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const value = headers.get('Set-Cookie');
  return value ? [value] : [];
}
```

- [ ] **Step 4: Run sanitization tests and verify GREEN**

Run:

```bash
node --test apps/pages-router/src/sanitize.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit sanitization**

```bash
git add apps/pages-router/src/sanitize.js apps/pages-router/src/sanitize.test.js
git commit -m "feat(router): 清洗平台 header 和 cookie"
```

### Task 5: Router Fetch Pipeline

**Files:**

- Create: `apps/pages-router/src/index.js`
- Create: `apps/pages-router/src/index.test.js`

- [ ] **Step 1: Write failing router fetch tests**

Create `apps/pages-router/src/index.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.js';

test('fails closed before route lookup when IP allowlist is missing', async () => {
  const env = routeEnv({ ROUTER_IP_ALLOWLIST_CIDRS: undefined });
  const response = await worker.fetch(new Request('https://demo.pages.xd.team/'), env);

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'IP_DENIED');
  assert.equal(env.lookupCount, 0);
  assert.equal(env.dispatchCount, 0);
});

test('fails closed when CF-Connecting-IP is missing', async () => {
  const env = routeEnv();
  const response = await worker.fetch(new Request('https://demo.pages.xd.team/'), env);

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'IP_DENIED');
  assert.equal(env.lookupCount, 0);
  assert.equal(env.dispatchCount, 0);
});

test('rejects reserved platform hosts before dispatch', async () => {
  const env = routeEnv();
  const response = await worker.fetch(
    new Request('https://api.pages.xd.team/', { headers: { 'CF-Connecting-IP': '10.1.2.3' } }),
    env
  );

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'RESERVED_HOST');
  assert.equal(env.dispatchCount, 0);
});

test('rejects platform reserved paths before dispatch', async () => {
  const env = routeEnv();
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/.xd-pages/runtime/v1/kv/get', {
      headers: { 'CF-Connecting-IP': '10.1.2.3' },
    }),
    env
  );

  assert.equal(response.status, 404);
  assert.equal((await response.json()).error.code, 'PLATFORM_PATH_RESERVED');
  assert.equal(env.dispatchCount, 0);
});

test('dispatches an allowed production site with sanitized request headers', async () => {
  const env = routeEnv();
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/', {
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        'CF-Platform-Auth': 'fake',
        Cookie: 'app=ok; __Host-pages_site_session=secret',
      },
    }),
    env
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'user worker ok');
  assert.equal(env.dispatchedRequest.headers.get('CF-Platform-Auth'), 'test.internal.jwt');
  assert.equal(env.dispatchedRequest.headers.get('CF-Platform-User'), 'anonymous');
  assert.equal(env.dispatchedRequest.headers.get('CF-Platform-Site-Id'), 'site_demo');
  assert.equal(env.dispatchedRequest.headers.get('CF-Platform-Site-Slug'), 'demo');
  assert.equal(env.dispatchedRequest.headers.get('Cookie'), 'app=ok');
});

test('sanitizes platform response headers and cookies', async () => {
  const env = routeEnv({
    userResponse: new Response('ok', {
      headers: {
        'CF-Platform-Trace-Id': 'fake',
        'Set-Cookie': '__Host-pages_site_session=evil; Path=/; Secure',
      },
    }),
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/', { headers: { 'CF-Connecting-IP': '10.1.2.3' } }),
    env
  );

  assert.equal(response.headers.get('CF-Platform-Trace-Id'), null);
  assert.equal(response.headers.get('Set-Cookie'), null);
});

test('rejects route snapshot environment mismatches', async () => {
  const env = routeEnv({
    routes: {
      'demo.pages.xd.team': {
        environment: 'staging',
        hostname: 'demo.pages.xd.team',
        routeStatus: 'active',
        runtime: 'wfp',
        workerName: 'demo-worker',
        siteId: 'site_demo',
        slug: 'demo',
        activeVersionId: 'ver_demo',
      },
    },
  });
  const response = await worker.fetch(
    new Request('https://demo.pages.xd.team/', { headers: { 'CF-Connecting-IP': '10.1.2.3' } }),
    env
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'ROUTE_ENV_MISMATCH');
  assert.equal(env.dispatchCount, 0);
});

function routeEnv(overrides = {}) {
  const state = {
    lookupCount: 0,
    dispatchCount: 0,
    dispatchedRequest: null,
  };
  const routes = overrides.routes || {
    'demo.pages.xd.team': {
      environment: 'production',
      hostname: 'demo.pages.xd.team',
      routeStatus: 'active',
      runtime: 'wfp',
      workerName: 'demo-worker',
      siteId: 'site_demo',
      slug: 'demo',
      activeVersionId: 'ver_demo',
    },
  };
  const userResponse = overrides.userResponse || new Response('user worker ok');

  const env = {
    ...state,
    PAGES_ENV: 'production',
    ROUTER_IP_ALLOWLIST_CIDRS: '10.0.0.0/8',
    ROUTE_SNAPSHOTS: routes,
    TEST_INTERNAL_JWT: 'test.internal.jwt',
    PAGES_DISPATCH: {
      get(workerName) {
        assert.equal(workerName, 'demo-worker');
        return {
          async fetch(request) {
            this;
            state.dispatchCount += 1;
            env.dispatchCount = state.dispatchCount;
            state.dispatchedRequest = request;
            env.dispatchedRequest = request;
            return userResponse;
          },
        };
      },
    },
    get lookupCount() {
      return state.lookupCount;
    },
    set lookupCount(value) {
      state.lookupCount = value;
    },
    get dispatchCount() {
      return state.dispatchCount;
    },
    set dispatchCount(value) {
      state.dispatchCount = value;
    },
    get dispatchedRequest() {
      return state.dispatchedRequest;
    },
    set dispatchedRequest(value) {
      state.dispatchedRequest = value;
    },
    lookupRoute(hostname) {
      state.lookupCount += 1;
      return routes[hostname] || null;
    },
  };

  return env;
}
```

- [ ] **Step 2: Run router tests and verify RED**

Run:

```bash
node --test apps/pages-router/src/index.test.js
```

Expected: FAIL with module-not-found for `apps/pages-router/src/index.js`.

- [ ] **Step 3: Implement router fetch pipeline**

Create `apps/pages-router/src/index.js`:

```js
import { isAllowedIP } from '@xd/ip-guard';
import { jsonResponse } from '@xd/worker-kit';

import { classifyHost } from './host.js';
import { isPlatformPath } from './platform-path.js';
import { sanitizeRequestForUserWorker, sanitizeUserWorkerResponse } from './sanitize.js';

export default {
  async fetch(request, env) {
    const ipDecision = enforceIPAllowlist(request, env);
    if (ipDecision) return ipDecision;

    const url = new URL(request.url);
    const environment = env.PAGES_ENV || 'production';
    const host = classifyHost(url.hostname, { environment });
    if (!host.ok) return errorResponse(host.code, `Host ${url.hostname} is not a routable pages v2 site.`, 404);

    if (isPlatformPath(url.pathname)) {
      return errorResponse('PLATFORM_PATH_RESERVED', 'This platform path is not dispatched to user workers.', 404);
    }

    const route = await readRouteSnapshot(env, host.hostname);
    if (!route) return errorResponse('ROUTE_NOT_FOUND', 'Site route not found.', 404);
    if (route.environment !== environment || route.hostname !== host.hostname) {
      return errorResponse('ROUTE_ENV_MISMATCH', 'Route environment does not match router environment.', 403);
    }
    if (route.routeStatus !== 'active' || route.runtime !== 'wfp') {
      return errorResponse('ROUTE_INACTIVE', 'Site route is not active.', 404);
    }

    const dispatchTarget = env.PAGES_DISPATCH?.get(route.workerName);
    if (!dispatchTarget) return errorResponse('DISPATCH_UNAVAILABLE', 'Dispatch namespace is not available.', 503);

    const sanitizedRequest = sanitizeRequestForUserWorker(request, buildPlatformHeaders(route, env));
    const userResponse = await dispatchTarget.fetch(sanitizedRequest, env);
    return sanitizeUserWorkerResponse(userResponse);
  },
};

function enforceIPAllowlist(request, env) {
  const allowlist = env.ROUTER_IP_ALLOWLIST_CIDRS;
  const ip = request.headers.get('CF-Connecting-IP');
  if (!isAllowedIP(ip, allowlist)) {
    return errorResponse('IP_DENIED', 'Client IP is not allowed.', 403);
  }
  return null;
}

async function readRouteSnapshot(env, hostname) {
  if (typeof env.lookupRoute === 'function') return env.lookupRoute(hostname);
  return env.ROUTE_SNAPSHOTS?.[hostname] || null;
}

function buildPlatformHeaders(route, env) {
  return {
    'CF-Platform-Auth': env.TEST_INTERNAL_JWT || '',
    'CF-Platform-User': 'anonymous',
    'CF-Platform-Site-Id': route.siteId,
    'CF-Platform-Site-Slug': route.slug,
    'CF-Platform-Version': route.activeVersionId,
    'CF-Platform-Trace-Id': crypto.randomUUID(),
  };
}

function errorResponse(code, message, status) {
  return jsonResponse(
    {
      error: {
        code,
        message,
      },
    },
    status,
    { 'Cache-Control': 'no-store' }
  );
}
```

- [ ] **Step 4: Run router tests and verify GREEN**

Run:

```bash
node --test apps/pages-router/src/index.test.js
```

Expected: PASS.

- [ ] **Step 5: Run all pages-router tests**

Run:

```bash
node --test apps/pages-router/src/*.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit router fetch pipeline**

```bash
git add apps/pages-router/src/index.js apps/pages-router/src/index.test.js
git commit -m "feat(router): 增加安全 dispatch 管线"
```

### Task 6: Workspace Verification

**Files:**

- Modify only if verification exposes a missing package pattern:
  - `package.json`
  - `pnpm-lock.yaml`

- [ ] **Step 1: Run package install if lockfile needs the new workspace package**

Run:

```bash
pnpm install
```

Expected: exits 0. If `pnpm-lock.yaml` changes only because the new workspace package is recognized, keep the change.

- [ ] **Step 2: Run focused router tests**

Run:

```bash
node --test apps/pages-router/src/*.test.js
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run:

```bash
pnpm test
```

Expected: PASS.

- [ ] **Step 4: Run lint**

Run:

```bash
pnpm lint
```

Expected: PASS.

- [ ] **Step 5: Run format check**

Run:

```bash
pnpm exec prettier --check apps/pages-router docs/superpowers/plans/2026-06-15-pages-v2-router-foundation.md
```

Expected: PASS.

- [ ] **Step 6: Confirm no local SSO reference is staged**

Run:

```bash
git status --short
```

Expected: `docs/xd-sso.md` may appear as untracked local reference, but it must not be staged.

- [ ] **Step 7: Commit verification updates if needed**

If `pnpm-lock.yaml` changed, commit it with the router package:

```bash
git add pnpm-lock.yaml
git commit -m "build(router): 更新 pages-router workspace lockfile"
```

If `pnpm-lock.yaml` did not change, skip this commit.

## Plan Self-Review

- Spec coverage: this plan covers M1 router security foundation only. M2-M8 remain separate implementation plans by design.
- v1/v2 boundary: every routable host in this plan is `pages.xd.team`; `workers.xd.team` appears only as a rejected host in tests.
- Security coverage: IP allowlist runs before route lookup and dispatch; platform cookies/headers are scrubbed before and after dispatch; reserved platform paths do not dispatch.
- Known intentional limitation: `TEST_INTERNAL_JWT` is a test placeholder. Real `internal_worker_jwt` signing belongs to the later Auth/Session and Router JWT milestones.
