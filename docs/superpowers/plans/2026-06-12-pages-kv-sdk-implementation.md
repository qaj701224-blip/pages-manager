# Pages KV SDK Implementation Plan

> Obsolete: 本计划记录的是早期 Pages KV SDK 实施方案。当前 v2 设计已调整为 `pages.xd.team` 新平台独立持有 `apps/kv-gateway`，v1 `apps/server` 不再签发 capability、部署 gateway 或提供 Pages KV。后续以 `docs/pages-v2-wfp-architecture.md` 为准。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a publishable `@xd/pages-sdk` plus a KV gateway and pages-manager integration so `kv=true` SPA and Worker sites can read, write, and delete site-scoped KV through a stable SDK.

**Architecture:** Add a small internal protocol package for shared constants, key validation, storage-key construction, and JSON envelopes. Publish `apps/pages-sdk` for browser and Worker callers, route browser calls through a generated same-origin SPA runtime endpoint, and send all real KV operations to a private `apps/kv-gateway` Worker that verifies signed capability JWTs and enforces the per-site storage prefix.

**Tech Stack:** Cloudflare Workers, Service Bindings, Cloudflare KV, Node.js `node:test`, pnpm workspaces, JavaScript ESM for Workers/packages, TypeScript for `apps/pages-sdk`, `tsc` for SDK builds.

---

## File Structure

Create:

- `packages/pages-runtime-protocol/package.json` - internal workspace package metadata.
- `packages/pages-runtime-protocol/src/index.js` - shared runtime/gateway constants, error envelopes, key/type/TTL/site UUID validators, base64url user-key encoding, and storage-key builder.
- `packages/pages-runtime-protocol/src/index.test.js` - protocol tests that root `pnpm test` already includes through `packages/**/*.test.js`.
- `apps/pages-sdk/package.json` - publishable npm package metadata for `@xd/pages-sdk`.
- `apps/pages-sdk/tsconfig.json` - TypeScript build config.
- `apps/pages-sdk/README.md` - package-level browser and Worker usage docs.
- `apps/pages-sdk/src/types.ts` - public SDK types and minimal Cloudflare `Fetcher` shape.
- `apps/pages-sdk/src/errors.ts` - `PagesSDKError` and runtime response validation helpers.
- `apps/pages-sdk/src/browser.ts` - `@xd/pages-sdk/browser` implementation.
- `apps/pages-sdk/src/worker.ts` - `@xd/pages-sdk/worker` gateway client implementation.
- `apps/pages-sdk/src/adapter.ts` - same-origin SPA runtime endpoint adapter.
- `apps/pages-sdk/src/inline.ts` - self-contained generated runtime source string for pages-manager.
- `apps/pages-sdk/test/browser.test.js` - tests against built `dist/browser.js`.
- `apps/pages-sdk/test/worker.test.js` - tests against built `dist/worker.js`.
- `apps/pages-sdk/test/adapter.test.js` - tests against built `dist/adapter.js`.
- `apps/pages-sdk/test/inline.test.js` - tests against built `dist/internal/runtime-source.js`.
- `apps/kv-gateway/package.json` - deployable Worker package metadata.
- `apps/kv-gateway/wrangler.template.toml` - rendered by `scripts/gen-wrangler.sh`; no real namespace IDs.
- `apps/kv-gateway/src/auth.js` - HS256 JWT registry parsing, signing/verifying helpers, and claim validation.
- `apps/kv-gateway/src/index.js` - gateway Worker entry and KV handlers.
- `apps/kv-gateway/src/auth.test.js` - JWT/key-registry tests.
- `apps/kv-gateway/src/index.test.js` - gateway route, auth, key, and KV provider error tests.
- `apps/server/src/lib/kv-capability.js` - pages-manager-side HS256 JWT signing and key registry parsing.
- `apps/server/src/lib/kv-capability.test.js` - capability signing tests.

Modify:

- `package.json` - update root `test` script to include all app tests and run the SDK build before SDK tests.
- `apps/server/package.json` - depend on `@xd/pages-runtime-protocol` and `@xd/pages-sdk`.
- `apps/server/wrangler.template.toml` - add non-secret KV gateway/service/key-registry variables and comments for Worker secrets.
- `apps/server/src/handlers/deploy.js` - parse `kv=true` fail-closed, preserve/generate `siteUuid`, sign capability, pass KV deploy options, and add worker-preset warnings.
- `apps/server/src/lib/cf-api.js` - add KV-aware metadata bindings and generated SPA runtime Worker source.
- `apps/server/src/lib/cf-api.test.js` - cover KV bindings, no-bindings when disabled, SPA runtime ordering, and no bare `@xd/*` imports.
- `apps/server/src/handlers/deploy.test.js` - cover `kv` parsing, conflict behavior, `siteUuid` preservation, deploy-time capability plumbing, and no secret leaks.
- `scripts/gen-wrangler.sh` - support `apps/kv-gateway`, render production/staging gateway names, namespace IDs, `workers_dev=false`, and env-specific service names for `apps/server`.
- `scripts/gen-wrangler.test.js` - cover gateway config and production/staging separation.
- `README.md`, `API.md`, `pages-deploy.skill.md` - document SDK usage, `kv=true`, worker bundling, and security boundaries.
- `apps/server/src/handlers/openapi.js` and related handler tests - document deploy parameter and warnings in public OpenAPI/readme/skill output.

Do not modify `AGENTS.md` or `CLAUDE.md` for this feature unless the repository rules themselves change.

---

## Task 1: Add The Internal Runtime Protocol Package

**Files:**

- Create: `packages/pages-runtime-protocol/package.json`
- Create: `packages/pages-runtime-protocol/src/index.js`
- Create: `packages/pages-runtime-protocol/src/index.test.js`

- [ ] **Step 1: Write protocol tests first**

Create `packages/pages-runtime-protocol/src/index.test.js` with these concrete behaviors:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BINDINGS,
  ERROR_CODES,
  GATEWAY,
  HEADERS,
  RUNTIME,
  buildErrorEnvelope,
  buildOkEnvelope,
  buildStorageKey,
  encodeUserKey,
  isValidSiteUuid,
  parseKvEnabled,
  validateKvType,
  validateTtl,
  validateUserKey,
} from './index.js';

test('exports stable runtime, gateway, header, binding and error constants', () => {
  assert.equal(RUNTIME.BASE_PATH, '/.xd-pages/runtime/v1');
  assert.equal(RUNTIME.KV_GET_PATH, '/.xd-pages/runtime/v1/kv/get');
  assert.equal(GATEWAY.KV_SET_PATH, '/v1/kv/set');
  assert.equal(HEADERS.RUNTIME_REQUEST, 'X-XD-Pages-Runtime');
  assert.equal(BINDINGS.KV_GATEWAY, 'XD_PAGES_KV_GATEWAY');
  assert.equal(ERROR_CODES.INVALID_RUNTIME_RESPONSE, 'INVALID_RUNTIME_RESPONSE');
});

test('parseKvEnabled is explicit and fail closed', () => {
  assert.equal(parseKvEnabled(undefined).enabled, false);
  assert.equal(parseKvEnabled(null).enabled, false);
  assert.equal(parseKvEnabled(false).enabled, false);
  assert.equal(parseKvEnabled('false').enabled, false);
  assert.equal(parseKvEnabled(true).enabled, true);
  assert.equal(parseKvEnabled('true').enabled, true);
  assert.deepEqual(parseKvEnabled('worker'), {
    enabled: false,
    error: { code: 'INVALID_KV_OPTION', message: 'kv must be true or false' },
  });
});

test('siteUuid must be 32 lowercase hex characters', () => {
  assert.equal(isValidSiteUuid('4b4c8e8361ef4b47b64f5c20a7db7c47'), true);
  assert.equal(isValidSiteUuid('4B4C8E8361EF4B47B64F5C20A7DB7C47'), false);
  assert.equal(isValidSiteUuid('4b4c8e83-61ef-4b47-b64f-5c20a7db7c47'), false);
});

test('user key validation rejects empty, reserved and oversized keys', () => {
  assert.equal(validateUserKey('app/config').ok, true);
  assert.equal(validateUserKey('').error.code, 'INVALID_KEY');
  assert.equal(validateUserKey('.').error.code, 'INVALID_KEY');
  assert.equal(validateUserKey('..').error.code, 'INVALID_KEY');
  assert.equal(validateUserKey('.xd-pages/runtime').error.code, 'INVALID_KEY');
  assert.equal(validateUserKey('__xd_pages/runtime').error.code, 'INVALID_KEY');
  assert.equal(validateUserKey('a'.repeat(257)).error.code, 'INVALID_KEY');
});

test('user key encoding is base64url and reversible at storage-key boundary', () => {
  assert.equal(encodeUserKey('a/b c%中文'), 'YS9iIGMl5Lit5paH');
  const key = buildStorageKey({
    siteSlug: 'q2-report',
    siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47',
    userKey: 'a/b c%中文',
  });
  assert.equal(key, 's/q2-report--4b4c8e8361ef4b47b64f5c20a7db7c47/k/YS9iIGMl5Lit5paH');
});

test('storage key validates slug, UUID and final Cloudflare KV key length', () => {
  assert.throws(
    () => buildStorageKey({ siteSlug: 'Bad', siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47', userKey: 'ok' }),
    /Invalid site slug/
  );
  assert.throws(
    () => buildStorageKey({ siteSlug: 'q2-report', siteUuid: 'bad', userKey: 'ok' }),
    /Invalid site UUID/
  );
  const nearLimit = buildStorageKey({
    siteSlug: 'a'.repeat(50),
    siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47',
    userKey: '中'.repeat(80),
  });
  assert.ok(new TextEncoder().encode(nearLimit).byteLength <= 512);
});

test('type and ttl validation match runtime contract', () => {
  assert.equal(validateKvType(undefined).value, 'json');
  assert.equal(validateKvType('text').value, 'text');
  assert.equal(validateKvType('binary').error.code, 'INVALID_TYPE');
  assert.equal(validateTtl(undefined).value, undefined);
  assert.equal(validateTtl(60).value, 60);
  assert.equal(validateTtl(59).error.code, 'INVALID_TTL');
  assert.equal(validateTtl(31536001).error.code, 'INVALID_TTL');
});

test('JSON envelopes are stable', () => {
  assert.deepEqual(buildOkEnvelope({ key: 'x' }), { ok: true, key: 'x' });
  assert.deepEqual(buildErrorEnvelope('INVALID_KEY', 'Invalid KV key'), {
    ok: false,
    error: { code: 'INVALID_KEY', message: 'Invalid KV key' },
  });
});
```

- [ ] **Step 2: Run the failing protocol tests**

Run:

```bash
pnpm test -- packages/pages-runtime-protocol/src/index.test.js
```

Expected: FAIL with `Cannot find module` or missing export errors because the package is not implemented yet.

- [ ] **Step 3: Implement `packages/pages-runtime-protocol/package.json`**

```json
{
  "name": "@xd/pages-runtime-protocol",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "exports": {
    ".": "./src/index.js"
  }
}
```

- [ ] **Step 4: Implement `packages/pages-runtime-protocol/src/index.js`**

Implement these exact exported names:

```js
export const RUNTIME = {
  VERSION: 'v1',
  BASE_PATH: '/.xd-pages/runtime/v1',
  KV_GET_PATH: '/.xd-pages/runtime/v1/kv/get',
  KV_SET_PATH: '/.xd-pages/runtime/v1/kv/set',
  KV_DELETE_PATH: '/.xd-pages/runtime/v1/kv/delete',
};

export const GATEWAY = {
  BASE_PATH: '/v1',
  KV_GET_PATH: '/v1/kv/get',
  KV_SET_PATH: '/v1/kv/set',
  KV_DELETE_PATH: '/v1/kv/delete',
};

export const HEADERS = {
  RUNTIME_REQUEST: 'X-XD-Pages-Runtime',
  REQUEST_ID: 'X-XD-Pages-Request-Id',
};

export const BINDINGS = {
  ASSETS: 'ASSETS',
  KV_GATEWAY: 'XD_PAGES_KV_GATEWAY',
  SITE_ID: 'XD_PAGES_SITE_ID',
  SITE_UUID: 'XD_PAGES_SITE_UUID',
  ENV: 'XD_PAGES_ENV',
  KV_CAPABILITY: 'XD_PAGES_KV_CAPABILITY',
};

export const ERROR_CODES = {
  METHOD_NOT_ALLOWED: 'METHOD_NOT_ALLOWED',
  INVALID_CONTENT_TYPE: 'INVALID_CONTENT_TYPE',
  INVALID_JSON: 'INVALID_JSON',
  INVALID_KEY: 'INVALID_KEY',
  INVALID_TYPE: 'INVALID_TYPE',
  INVALID_TTL: 'INVALID_TTL',
  INVALID_KV_OPTION: 'INVALID_KV_OPTION',
  KV_DECODE_FAILED: 'KV_DECODE_FAILED',
  KV_VALUE_TOO_LARGE: 'KV_VALUE_TOO_LARGE',
  FORBIDDEN: 'FORBIDDEN',
  CAPABILITY_INVALID: 'CAPABILITY_INVALID',
  CAPABILITY_SCOPE_DENIED: 'CAPABILITY_SCOPE_DENIED',
  KV_FAILED: 'KV_FAILED',
  INVALID_RUNTIME_RESPONSE: 'INVALID_RUNTIME_RESPONSE',
};

const SITE_SLUG_RE = /^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$/;
const SITE_UUID_RE = /^[0-9a-f]{32}$/;
const textEncoder = new TextEncoder();

export function buildOkEnvelope(payload = {}) {
  return { ok: true, ...payload };
}

export function buildErrorEnvelope(code, message) {
  return { ok: false, error: { code, message } };
}

export function parseKvEnabled(value) {
  if (value === undefined || value === null || value === false || value === 'false') return { enabled: false };
  if (value === true || value === 'true') return { enabled: true };
  return {
    enabled: false,
    error: { code: ERROR_CODES.INVALID_KV_OPTION, message: 'kv must be true or false' },
  };
}

export function isValidSiteSlug(siteSlug) {
  return typeof siteSlug === 'string' && SITE_SLUG_RE.test(siteSlug);
}

export function isValidSiteUuid(siteUuid) {
  return typeof siteUuid === 'string' && SITE_UUID_RE.test(siteUuid);
}

export function validateUserKey(key) {
  if (typeof key !== 'string') return { ok: false, error: { code: ERROR_CODES.INVALID_KEY, message: 'Invalid KV key' } };
  if (!key || key === '.' || key === '..') return { ok: false, error: { code: ERROR_CODES.INVALID_KEY, message: 'Invalid KV key' } };
  if (key.startsWith('.xd-pages/') || key.startsWith('__xd_pages/')) {
    return { ok: false, error: { code: ERROR_CODES.INVALID_KEY, message: 'Invalid KV key' } };
  }
  if (textEncoder.encode(key).byteLength > 256) {
    return { ok: false, error: { code: ERROR_CODES.INVALID_KEY, message: 'Invalid KV key' } };
  }
  return { ok: true, value: key };
}

export function encodeUserKey(key) {
  const bytes = textEncoder.encode(key);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function buildStorageKey({ siteSlug, siteUuid, userKey }) {
  if (!isValidSiteSlug(siteSlug)) throw new Error('Invalid site slug');
  if (!isValidSiteUuid(siteUuid)) throw new Error('Invalid site UUID');
  const keyValidation = validateUserKey(userKey);
  if (!keyValidation.ok) throw new Error(keyValidation.error.message);
  const storageKey = `s/${siteSlug}--${siteUuid}/k/${encodeUserKey(userKey)}`;
  if (textEncoder.encode(storageKey).byteLength > 512) throw new Error('Storage key exceeds Cloudflare KV limit');
  return storageKey;
}

export function validateKvType(type = 'json') {
  if (type === 'json' || type === 'text') return { ok: true, value: type };
  return { ok: false, error: { code: ERROR_CODES.INVALID_TYPE, message: 'Invalid KV value type' } };
}

export function validateTtl(expirationTtl) {
  if (expirationTtl === undefined || expirationTtl === null) return { ok: true, value: undefined };
  if (!Number.isInteger(expirationTtl) || expirationTtl < 60 || expirationTtl > 31536000) {
    return { ok: false, error: { code: ERROR_CODES.INVALID_TTL, message: 'Invalid expirationTtl' } };
  }
  return { ok: true, value: expirationTtl };
}
```

- [ ] **Step 5: Run protocol tests**

Run:

```bash
pnpm test -- packages/pages-runtime-protocol/src/index.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit protocol package**

```bash
git add packages/pages-runtime-protocol
git commit -m "feat(kv): 添加 Pages runtime 协议包"
```

---

## Task 2: Add The Publishable `@xd/pages-sdk` Package

**Files:**

- Create: `apps/pages-sdk/package.json`
- Create: `apps/pages-sdk/tsconfig.json`
- Create: `apps/pages-sdk/README.md`
- Create: `apps/pages-sdk/src/types.ts`
- Create: `apps/pages-sdk/src/errors.ts`
- Create: `apps/pages-sdk/src/browser.ts`
- Create: `apps/pages-sdk/src/worker.ts`
- Create: `apps/pages-sdk/src/adapter.ts`
- Create: `apps/pages-sdk/src/inline.ts`
- Create: `apps/pages-sdk/test/browser.test.js`
- Create: `apps/pages-sdk/test/worker.test.js`
- Create: `apps/pages-sdk/test/adapter.test.js`
- Create: `apps/pages-sdk/test/inline.test.js`
- Modify: `package.json`

- [ ] **Step 1: Add root test/build wiring**

Modify root `package.json` scripts so SDK tests run against built output:

```json
{
  "scripts": {
    "lint": "eslint .",
    "lint:fix": "eslint --fix .",
    "test": "pnpm --filter @xd/pages-sdk build && node --test \"apps/*/src/**/*.test.js\" \"apps/pages-sdk/test/**/*.test.js\" \"packages/**/*.test.js\" \"scripts/**/*.test.js\"",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "fix": "eslint --fix . && prettier --write ."
  }
}
```

- [ ] **Step 2: Create SDK package metadata**

Create `apps/pages-sdk/package.json`:

```json
{
  "name": "@xd/pages-sdk",
  "version": "0.1.0",
  "type": "module",
  "private": false,
  "sideEffects": false,
  "files": ["dist", "README.md"],
  "exports": {
    "./browser": {
      "types": "./dist/browser.d.ts",
      "import": "./dist/browser.js"
    },
    "./worker": {
      "types": "./dist/worker.d.ts",
      "import": "./dist/worker.js"
    },
    "./internal/runtime-source": {
      "import": "./dist/internal/runtime-source.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@xd/pages-runtime-protocol": "workspace:*"
  },
  "devDependencies": {
    "typescript": "^5.8.0"
  }
}
```

Create `apps/pages-sdk/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "skipLibCheck": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Write browser SDK tests**

Create `apps/pages-sdk/test/browser.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPagesClient, PagesSDKError } from '../dist/browser.js';

test('browser get posts to same-origin runtime endpoint', async () => {
  const calls = [];
  const client = createPagesClient({
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return Response.json({ ok: true, found: true, key: 'app/config', value: { theme: 'dark' } });
    },
  });

  const value = await client.kv.get('app/config');

  assert.deepEqual(value, { theme: 'dark' });
  assert.equal(calls[0].url, '/.xd-pages/runtime/v1/kv/get');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.equal(calls[0].init.headers['X-XD-Pages-Runtime'], '1');
  assert.deepEqual(JSON.parse(calls[0].init.body), { key: 'app/config', type: 'json' });
});

test('browser get returns null for misses', async () => {
  const client = createPagesClient({
    fetch: async () => Response.json({ ok: true, found: false, key: 'missing', value: null }),
  });

  assert.equal(await client.kv.get('missing'), null);
});

test('browser put and delete use POST envelopes', async () => {
  const bodies = [];
  const client = createPagesClient({
    fetch: async (url, init) => {
      bodies.push({ url: String(url), body: JSON.parse(init.body) });
      return Response.json({ ok: true, key: bodies.at(-1).body.key });
    },
  });

  await client.kv.set('drafts/1', 'hello', { type: 'text', expirationTtl: 3600 });
  await client.kv.delete('drafts/1');

  assert.deepEqual(bodies, [
    { url: '/.xd-pages/runtime/v1/kv/set', body: { key: 'drafts/1', type: 'text', value: 'hello', expirationTtl: 3600 } },
    { url: '/.xd-pages/runtime/v1/kv/delete', body: { key: 'drafts/1' } },
  ]);
});

test('browser SDK converts non-JSON runtime responses to INVALID_RUNTIME_RESPONSE', async () => {
  const client = createPagesClient({
    fetch: async () => new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }),
  });

  await assert.rejects(() => client.kv.get('app/config'), (error) => {
    assert.equal(error instanceof PagesSDKError, true);
    assert.equal(error.code, 'INVALID_RUNTIME_RESPONSE');
    return true;
  });
});
```

- [ ] **Step 4: Write worker SDK tests**

Create `apps/pages-sdk/test/worker.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { createPagesRuntime } from '../dist/worker.js';

test('worker SDK calls gateway with bearer capability', async () => {
  const calls = [];
  const pages = createPagesRuntime({
    env: {
      XD_PAGES_KV_CAPABILITY: 'capability.jwt',
      XD_PAGES_KV_GATEWAY: {
        fetch: async (request) => {
          calls.push(request);
          return Response.json({ ok: true, found: true, key: 'app/config', value: { theme: 'dark' } });
        },
      },
    },
  });

  assert.deepEqual(await pages.kv.get('app/config'), { theme: 'dark' });
  assert.equal(calls[0].url, 'https://pages-kv-gateway.local/v1/kv/get');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.get('Authorization'), 'Bearer capability.jwt');
  assert.equal(calls[0].headers.get('Content-Type'), 'application/json');
  assert.deepEqual(await calls[0].json(), { key: 'app/config', type: 'json' });
});

test('worker SDK throws provider error code from gateway envelope', async () => {
  const pages = createPagesRuntime({
    env: {
      XD_PAGES_KV_CAPABILITY: 'capability.jwt',
      XD_PAGES_KV_GATEWAY: {
        fetch: async () => Response.json({ ok: false, error: { code: 'KV_FAILED', message: 'KV failed' } }, { status: 500 }),
      },
    },
  });

  await assert.rejects(() => pages.kv.delete('drafts/1'), /KV failed/);
});
```

- [ ] **Step 5: Write adapter and inline tests**

Create `apps/pages-sdk/test/adapter.test.js` and `apps/pages-sdk/test/inline.test.js` with these assertions:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { handlePagesRuntimeRequest } from '../dist/adapter.js';

function envWithGateway(response) {
  return {
    XD_PAGES_KV_CAPABILITY: 'capability.jwt',
    XD_PAGES_KV_GATEWAY: { fetch: async () => response },
  };
}

test('adapter returns null for non-runtime paths', async () => {
  const request = new Request('https://demo.workers.xd.team/index.html');
  assert.equal(await handlePagesRuntimeRequest(request, envWithGateway(Response.json({ ok: true }))), null);
});

test('adapter fails closed when runtime path lacks checkAccess', async () => {
  const request = new Request('https://demo.workers.xd.team/.xd-pages/runtime/v1/kv/get', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-XD-Pages-Runtime': '1' },
    body: JSON.stringify({ key: 'x' }),
  });

  const response = await handlePagesRuntimeRequest(request, envWithGateway(Response.json({ ok: true })));
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'FORBIDDEN');
});

test('adapter rejects method, content-type, runtime header and cross-site signals', async () => {
  const base = 'https://demo.workers.xd.team/.xd-pages/runtime/v1/kv/get';
  const getResponse = await handlePagesRuntimeRequest(new Request(base), envWithGateway(Response.json({ ok: true })), {
    checkAccess: async () => null,
  });
  assert.equal(getResponse.status, 405);

  const textResponse = await handlePagesRuntimeRequest(new Request(base, { method: 'POST', body: '{}' }), envWithGateway(Response.json({ ok: true })), {
    checkAccess: async () => null,
  });
  assert.equal(textResponse.status, 415);

  const noHeader = await handlePagesRuntimeRequest(
    new Request(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }),
    envWithGateway(Response.json({ ok: true })),
    { checkAccess: async () => null }
  );
  assert.equal(noHeader.status, 403);

  const crossSite = await handlePagesRuntimeRequest(
    new Request(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-XD-Pages-Runtime': '1', 'Sec-Fetch-Site': 'cross-site' },
      body: '{}',
    }),
    envWithGateway(Response.json({ ok: true })),
    { checkAccess: async () => null }
  );
  assert.equal(crossSite.status, 403);
});
```

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { PAGES_RUNTIME_SOURCE } from '../dist/internal/runtime-source.js';

test('inline runtime source is self-contained', () => {
  assert.equal(typeof PAGES_RUNTIME_SOURCE, 'string');
  assert.match(PAGES_RUNTIME_SOURCE, /handlePagesRuntimeRequest/);
  assert.doesNotMatch(PAGES_RUNTIME_SOURCE, /from ['"]@xd\//);
  assert.doesNotMatch(PAGES_RUNTIME_SOURCE, /import ['"]@xd\//);
});
```

- [ ] **Step 6: Run SDK tests to verify they fail before implementation**

Run:

```bash
pnpm --filter @xd/pages-sdk build && node --test "apps/pages-sdk/test/**/*.test.js"
```

Expected: FAIL with missing source files or missing exports.

- [ ] **Step 7: Implement SDK source**

Implement:

- `PagesSDKError` with `code`, `status`, and `details`.
- Browser client that sends `POST` JSON to `RUNTIME.KV_*_PATH`, adds `Content-Type: application/json` and `X-XD-Pages-Runtime: 1`, validates JSON response envelopes, returns `null` on `{ found: false }`, and throws `PagesSDKError` on runtime errors.
- Worker client that sends `POST` JSON to service binding requests using `new Request("https://pages-kv-gateway.local" + GATEWAY.KV_*_PATH, ...)`, adds `Authorization: Bearer ${env.XD_PAGES_KV_CAPABILITY}`, validates gateway envelopes, and throws `PagesSDKError`.
- Adapter that matches `RUNTIME.BASE_PATH`, returns `null` for non-runtime paths, rejects non-POST, non-JSON, missing `X-XD-Pages-Runtime: 1`, cross-site `Sec-Fetch-Site`, and mismatched `Origin`, then requires `options.checkAccess` before calling Worker SDK.
- Inline module that exports `PAGES_RUNTIME_SOURCE` as a single string containing the compiled adapter, worker client, and protocol helpers with no bare imports.

Keep request and response shapes exactly as in the spec:

```ts
export type KVType = 'json' | 'text';

export function createPagesClient(options?: {
  basePath?: string;
  fetch?: typeof fetch;
}): {
  kv: {
    get<T = unknown>(key: string, options?: { type?: KVType }): Promise<T | string | null>;
    set(key: string, value: unknown, options?: { type?: KVType; expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
  };
};

export function createPagesRuntime(options: {
  env: PagesRuntimeEnv;
}): {
  kv: {
    get<T = unknown>(key: string, options?: { type?: KVType }): Promise<T | string | null>;
    set(key: string, value: unknown, options?: { type?: KVType; expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
  };
};

export async function handlePagesRuntimeRequest(
  request: Request,
  env: PagesRuntimeEnv,
  options?: {
    checkAccess?: (request: Request, env: PagesRuntimeEnv) => Response | null | Promise<Response | null>;
  }
): Promise<Response | null>;
```

- [ ] **Step 8: Run SDK build and tests**

Run:

```bash
pnpm --filter @xd/pages-sdk build
node --test "apps/pages-sdk/test/**/*.test.js"
```

Expected: PASS.

- [ ] **Step 9: Commit SDK package**

```bash
git add package.json apps/pages-sdk
git commit -m "feat(kv): 添加 Pages SDK 包"
```

---

## Task 3: Add KV Gateway Worker

**Files:**

- Create: `apps/kv-gateway/package.json`
- Create: `apps/kv-gateway/wrangler.template.toml`
- Create: `apps/kv-gateway/src/auth.js`
- Create: `apps/kv-gateway/src/auth.test.js`
- Create: `apps/kv-gateway/src/index.js`
- Create: `apps/kv-gateway/src/index.test.js`

- [ ] **Step 1: Create gateway package and template**

`apps/kv-gateway/package.json`:

```json
{
  "name": "@xd/kv-gateway",
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

`apps/kv-gateway/wrangler.template.toml`:

```toml
name = "__WORKER_NAME__"
main = "src/index.js"
compatibility_date = "2025-05-01"
account_id = "__CLOUDFLARE_ACCOUNT_ID__"
workers_dev = false

[vars]
XD_PAGES_ENV = "__PUBLIC_ENVIRONMENT__"
PAGES_CAP_JWT_ACTIVE_KID = "__PAGES_CAP_JWT_ACTIVE_KID__"
PAGES_CAP_JWT_KEYS = "__PAGES_CAP_JWT_KEYS__"

[[kv_namespaces]]
binding = "SITE_DATA"
id = "__SITE_DATA_KV_NAMESPACE_ID__"

# Runtime secrets, set outside the repository:
# npx wrangler secret put PAGES_CAP_JWT_SECRET_202606
```

- [ ] **Step 2: Write JWT auth tests**

Create `apps/kv-gateway/src/auth.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHs256Jwt, parseKeyRegistry, verifyCapability } from './auth.js';

const env = {
  XD_PAGES_ENV: 'production',
  PAGES_CAP_JWT_KEYS: 'prod-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606',
  PAGES_CAP_JWT_SECRET_202606: 'test-secret',
};

test('parseKeyRegistry binds kid to alg and secret value', () => {
  assert.deepEqual(parseKeyRegistry(env), new Map([
    ['prod-hs-2026-06', { alg: 'HS256', secret: 'test-secret' }],
  ]));
});

test('verifyCapability accepts valid HS256 token with required claims and scope', async () => {
  const token = await createHs256Jwt({
    kid: 'prod-hs-2026-06',
    secret: 'test-secret',
    payload: {
      iss: 'pages-manager',
      aud: 'pages-kv-gateway',
      env: 'production',
      siteId: 'q2-report',
      siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47',
      siteGeneration: 1,
      scope: ['kv:get'],
      iat: 1781111111,
      nbf: 1,
      jti: 'cap_test',
    },
  });

  const claims = await verifyCapability(`Bearer ${token}`, env, { requiredScope: 'kv:get', now: 1781111111 });
  assert.equal(claims.siteId, 'q2-report');
  assert.equal(claims.siteUuid, '4b4c8e8361ef4b47b64f5c20a7db7c47');
});

test('verifyCapability rejects alg mismatch, unknown kid, env mismatch and missing scope', async () => {
  const token = await createHs256Jwt({
    kid: 'prod-hs-2026-06',
    secret: 'test-secret',
    header: { alg: 'RS256' },
    payload: {
      iss: 'pages-manager',
      aud: 'pages-kv-gateway',
      env: 'production',
      siteId: 'q2-report',
      siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47',
      scope: ['kv:get'],
      iat: 1,
      nbf: 1,
      jti: 'cap_bad_alg',
    },
  });

  await assert.rejects(() => verifyCapability(`Bearer ${token}`, env, { requiredScope: 'kv:get', now: 2 }), /alg/);
  await assert.rejects(() => verifyCapability('Bearer bad.token.value', env, { requiredScope: 'kv:get', now: 2 }), /capability/i);

  const noSet = await createHs256Jwt({
    kid: 'prod-hs-2026-06',
    secret: 'test-secret',
    payload: {
      iss: 'pages-manager',
      aud: 'pages-kv-gateway',
      env: 'production',
      siteId: 'q2-report',
      siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47',
      scope: ['kv:get'],
      iat: 1,
      nbf: 1,
      jti: 'cap_no_set',
    },
  });
  await assert.rejects(() => verifyCapability(`Bearer ${noSet}`, env, { requiredScope: 'kv:set', now: 2 }), /scope/);
});
```

- [ ] **Step 3: Implement auth helpers**

Implement `apps/kv-gateway/src/auth.js` with:

- base64url encode/decode helpers using `TextEncoder`, `TextDecoder`, `btoa`, and `atob`.
- `parseKeyRegistry(env)` parsing `PAGES_CAP_JWT_KEYS` entries shaped as `kid:alg:secretEnvName`.
- `createHs256Jwt({ kid, secret, payload, header })` for tests and manager test parity.
- `verifyCapability(authorization, env, { requiredScope, now })` that rejects missing bearer tokens, unknown `kid`, `header.alg !== registry[kid].alg`, non-HS256 entries, invalid signatures, invalid `iss`, `aud`, `env`, `siteId`, `siteUuid`, `scope`, `nbf`, and future-skewed `iat`.

- [ ] **Step 4: Write gateway handler tests**

Create `apps/kv-gateway/src/index.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import gateway from './index.js';
import { createHs256Jwt } from './auth.js';

async function token(scope = ['kv:get', 'kv:set', 'kv:delete']) {
  return createHs256Jwt({
    kid: 'prod-hs-2026-06',
    secret: 'test-secret',
    payload: {
      iss: 'pages-manager',
      aud: 'pages-kv-gateway',
      env: 'production',
      siteId: 'q2-report',
      siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47',
      siteGeneration: 1,
      scope,
      iat: 1,
      nbf: 1,
      jti: 'cap_test',
    },
  });
}

function env(kv = new Map()) {
  return {
    XD_PAGES_ENV: 'production',
    PAGES_CAP_JWT_KEYS: 'prod-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606',
    PAGES_CAP_JWT_SECRET_202606: 'test-secret',
    SITE_DATA: {
      async get(key) {
        return kv.has(key) ? kv.get(key) : null;
      },
      async put(key, value, options) {
        kv.set(key, value);
        kv.set(`${key}:options`, options);
      },
      async delete(key) {
        kv.delete(key);
      },
    },
  };
}

async function post(path, body, bearer) {
  return new Request(`https://gateway.local${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

test('get reads only the JWT-derived site prefix', async () => {
  const kv = new Map([
    ['s/q2-report--4b4c8e8361ef4b47b64f5c20a7db7c47/k/YXBwL2NvbmZpZw', JSON.stringify({ theme: 'dark' })],
  ]);
  const response = await gateway.fetch(await post('/v1/kv/get', { key: 'app/config', type: 'json', siteId: 'evil' }, await token()), env(kv));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, key: 'app/config', found: true, value: { theme: 'dark' } });
});

test('put stores text and ttl metadata under prefixed key', async () => {
  const kv = new Map();
  const response = await gateway.fetch(
    await post('/v1/kv/set', { key: 'drafts/1', type: 'text', value: 'hello', expirationTtl: 3600 }, await token()),
    env(kv)
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, key: 'drafts/1' });
  const storageKey = 's/q2-report--4b4c8e8361ef4b47b64f5c20a7db7c47/k/ZHJhZnRzLzE';
  assert.equal(kv.get(storageKey), 'hello');
  assert.equal(kv.get(`${storageKey}:options`).expirationTtl, 3600);
  assert.equal(kv.get(`${storageKey}:options`).metadata.siteId, 'q2-report');
  assert.equal(kv.get(`${storageKey}:options`).metadata.type, 'text');
});

test('delete requires kv:delete scope', async () => {
  const response = await gateway.fetch(await post('/v1/kv/delete', { key: 'drafts/1' }, await token(['kv:get'])), env());
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'CAPABILITY_SCOPE_DENIED');
});

test('provider value-too-large errors are standardized', async () => {
  const brokenEnv = env();
  brokenEnv.SITE_DATA.put = async () => {
    throw new Error('KV PUT failed: value length of 26214401 exceeds limit');
  };

  const response = await gateway.fetch(await post('/v1/kv/set', { key: 'x', value: 'y' }, await token()), brokenEnv);
  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'KV_VALUE_TOO_LARGE');
});
```

- [ ] **Step 5: Implement gateway entry**

Implement `apps/kv-gateway/src/index.js`:

- Route only `POST /v1/kv/get`, `POST /v1/kv/set`, and `POST /v1/kv/delete`.
- Use `verifyCapability(request.headers.get('Authorization'), env, { requiredScope })`.
- Parse JSON body and map bad JSON to `INVALID_JSON`.
- Validate key/type/ttl through `@xd/pages-runtime-protocol`.
- Build storage key only from `claims.siteId`, `claims.siteUuid`, and `body.key`.
- For JSON put, store `JSON.stringify(body.value)` and metadata `{ siteId, type, updatedAt }`.
- For text put, store `String(body.value ?? '')`.
- For JSON get, parse stored JSON; parse failure returns `KV_DECODE_FAILED`.
- Map provider errors containing `value`, `size`, `too large`, or `limit` to `KV_VALUE_TOO_LARGE` with status `413`; other provider errors to `KV_FAILED` with status `500`.
- Log only `event`, `environment`, `siteId`, `jti`, `type`, and `status`; do not log JWT, value, full user key, namespace id, or deploy token.

- [ ] **Step 6: Run gateway tests**

Run:

```bash
node --test "apps/kv-gateway/src/**/*.test.js"
```

Expected: PASS.

- [ ] **Step 7: Commit gateway Worker**

```bash
git add apps/kv-gateway
git commit -m "feat(kv): 添加 KV gateway Worker"
```

---

## Task 4: Render Gateway And Server Environment Configuration

**Files:**

- Modify: `scripts/gen-wrangler.sh`
- Modify: `scripts/gen-wrangler.test.js`
- Modify: `apps/server/wrangler.template.toml`

- [ ] **Step 1: Write generator tests for gateway and server KV variables**

Add tests to `scripts/gen-wrangler.test.js`:

```js
const kvGatewayWranglerPath = join(repoRoot, 'apps/kv-gateway/wrangler.toml');

const kvEnv = {
  ...baseEnv,
  SITE_DATA_KV_NAMESPACE_ID: 'dummy-site-data-kv',
  PAGES_CAP_JWT_ACTIVE_KID: 'prod-hs-2026-06',
  PAGES_CAP_JWT_KEYS: 'prod-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606',
};

function renderKvGateway(envName, env = kvEnv) {
  renderApp('apps/kv-gateway', envName, env);
  return readFileSync(kvGatewayWranglerPath, 'utf8');
}
```

And concrete tests:

```js
test('production kv-gateway config renders private production gateway', () => {
  const config = renderKvGateway('production');

  assert.match(config, /name = "pages-kv-gateway"/);
  assert.match(config, /workers_dev = false/);
  assert.match(config, /XD_PAGES_ENV = "production"/);
  assert.match(config, /binding = "SITE_DATA"/);
  assert.match(config, /id = "dummy-site-data-kv"/);
  assert.doesNotMatch(config, /pages-kv-gateway-staging/);
  assert.doesNotMatch(config, /staging/);
});

test('staging kv-gateway config renders staging gateway only', () => {
  const config = renderKvGateway('staging');

  assert.match(config, /name = "pages-kv-gateway-staging"/);
  assert.match(config, /XD_PAGES_ENV = "staging"/);
  assert.doesNotMatch(config, /name = "pages-kv-gateway"/);
});

test('server config renders environment-specific kv gateway service name', () => {
  const production = renderServer('production', kvEnv);
  assert.match(production, /KV_GATEWAY_SERVICE = "pages-kv-gateway"/);

  const staging = renderServer('staging', kvEnv);
  assert.match(staging, /KV_GATEWAY_SERVICE = "pages-kv-gateway-staging"/);
});
```

Update `afterEach` to remove `kvGatewayWranglerPath`.

- [ ] **Step 2: Run generator tests and verify failure**

Run:

```bash
node --test scripts/gen-wrangler.test.js
```

Expected: FAIL because `apps/kv-gateway` is unsupported and server template lacks `KV_GATEWAY_SERVICE`.

- [ ] **Step 3: Update server template**

Add these vars to `apps/server/wrangler.template.toml`:

```toml
KV_GATEWAY_SERVICE = "__KV_GATEWAY_SERVICE__"
PAGES_CAP_JWT_ACTIVE_KID = "__PAGES_CAP_JWT_ACTIVE_KID__"
PAGES_CAP_JWT_KEYS = "__PAGES_CAP_JWT_KEYS__"
```

Add comments:

```toml
# KV capability secrets, set outside the repository:
# npx wrangler secret put PAGES_CAP_JWT_SECRET_202606
```

- [ ] **Step 4: Update `scripts/gen-wrangler.sh`**

Change supported apps to include `apps/kv-gateway`. For `apps/server`, require `PAGES_CAP_JWT_ACTIVE_KID` and `PAGES_CAP_JWT_KEYS`, set:

```bash
case "$environment" in
  production)
    kv_gateway_service="pages-kv-gateway"
    ;;
  staging)
    kv_gateway_service="pages-kv-gateway-staging"
    ;;
esac
```

Replace `__KV_GATEWAY_SERVICE__`, `__PAGES_CAP_JWT_ACTIVE_KID__`, and `__PAGES_CAP_JWT_KEYS__`.

For `apps/kv-gateway`, require:

```bash
require_env SITE_DATA_KV_NAMESPACE_ID
require_env PAGES_CAP_JWT_ACTIVE_KID
require_env PAGES_CAP_JWT_KEYS
```

Set:

```bash
case "$environment" in
  production)
    worker_name="pages-kv-gateway"
    public_environment="production"
    ;;
  staging)
    worker_name="pages-kv-gateway-staging"
    public_environment="staging"
    ;;
esac
```

Render `apps/kv-gateway/wrangler.template.toml`, then verify production output contains no `staging` strings and staging output contains `name = "pages-kv-gateway-staging"` and `XD_PAGES_ENV = "staging"`.

- [ ] **Step 5: Run generator tests**

Run:

```bash
node --test scripts/gen-wrangler.test.js
```

Expected: PASS.

- [ ] **Step 6: Commit config rendering**

```bash
git add scripts/gen-wrangler.sh scripts/gen-wrangler.test.js apps/server/wrangler.template.toml apps/kv-gateway/wrangler.template.toml
git commit -m "build(kv): 渲染 KV gateway 部署配置"
```

---

## Task 5: Add Manager Capability Signing And KV Deploy Plumbing

**Files:**

- Create: `apps/server/src/lib/kv-capability.js`
- Create: `apps/server/src/lib/kv-capability.test.js`
- Modify: `apps/server/package.json`
- Modify: `apps/server/src/handlers/deploy.js`
- Modify: `apps/server/src/handlers/deploy.test.js`
- Modify: `apps/server/src/lib/cf-api.js`
- Modify: `apps/server/src/lib/cf-api.test.js`

- [ ] **Step 1: Add server dependencies**

Modify `apps/server/package.json`:

```json
{
  "dependencies": {
    "@xd/ip-guard": "workspace:*",
    "@xd/pages-runtime-protocol": "workspace:*",
    "@xd/pages-sdk": "workspace:*",
    "@xd/worker-kit": "workspace:*"
  }
}
```

- [ ] **Step 2: Write capability signer tests**

Create `apps/server/src/lib/kv-capability.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { signKvCapability } from './kv-capability.js';

test('signKvCapability signs with active kid and does not add exp', async () => {
  const token = await signKvCapability(
    {
      siteId: 'q2-report',
      siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47',
      siteGeneration: 1,
      envName: 'production',
      now: 1781111111,
      jti: 'cap_test',
    },
    {
      PAGES_CAP_JWT_ACTIVE_KID: 'prod-hs-2026-06',
      PAGES_CAP_JWT_KEYS: 'prod-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606',
      PAGES_CAP_JWT_SECRET_202606: 'test-secret',
    }
  );

  const [encodedHeader, encodedPayload] = token.split('.');
  const header = JSON.parse(Buffer.from(encodedHeader.replaceAll('-', '+').replaceAll('_', '/'), 'base64url').toString('utf8'));
  const payload = JSON.parse(Buffer.from(encodedPayload.replaceAll('-', '+').replaceAll('_', '/'), 'base64url').toString('utf8'));

  assert.equal(header.alg, 'HS256');
  assert.equal(header.kid, 'prod-hs-2026-06');
  assert.equal(payload.iss, 'pages-manager');
  assert.equal(payload.aud, 'pages-kv-gateway');
  assert.equal(payload.env, 'production');
  assert.equal(payload.siteId, 'q2-report');
  assert.equal(payload.siteUuid, '4b4c8e8361ef4b47b64f5c20a7db7c47');
  assert.deepEqual(payload.scope, ['kv:get', 'kv:set', 'kv:delete']);
  assert.equal(payload.exp, undefined);
});
```

- [ ] **Step 3: Implement manager-side capability signing**

`apps/server/src/lib/kv-capability.js` must export:

```js
export function parseCapabilitySigningKey(env) {
  const activeKid = env.PAGES_CAP_JWT_ACTIVE_KID;
  const registry = env.PAGES_CAP_JWT_KEYS;
  // Return { kid, alg: 'HS256', secret } for the active kid.
}

export async function signKvCapability({ siteId, siteUuid, siteGeneration, envName, now, jti }, env) {
  // Build HS256 JWT with iss, aud, env, siteId, siteUuid, siteGeneration, scope, iat, nbf, jti.
}
```

The implementation must throw if active kid is missing, registry is missing, active kid is not found, registry alg is not `HS256`, secret env name is missing, or secret value is missing.

- [ ] **Step 4: Write `cf-api` KV metadata tests**

Add tests to `apps/server/src/lib/cf-api.test.js`:

```js
test('kv disabled does not bind gateway or capability', () => {
  const metadata = buildWorkerMetadata('completion-jwt', 'spa', false, '127.0.0.1', { kv: { enabled: false } });

  assert.deepEqual(metadata.bindings, [{ type: 'assets', name: 'ASSETS' }]);
});

test('kv enabled binds gateway, site identifiers and capability', () => {
  const metadata = buildWorkerMetadata('completion-jwt', 'spa', false, '127.0.0.1', {
    kv: {
      enabled: true,
      gatewayService: 'pages-kv-gateway',
      siteId: 'demo',
      siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47',
      envName: 'production',
      capability: 'capability.jwt',
    },
  });

  assert.deepEqual(metadata.bindings, [
    { type: 'assets', name: 'ASSETS' },
    { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' },
    { type: 'plain_text', name: 'XD_PAGES_SITE_ID', text: 'demo' },
    { type: 'plain_text', name: 'XD_PAGES_SITE_UUID', text: '4b4c8e8361ef4b47b64f5c20a7db7c47' },
    { type: 'plain_text', name: 'XD_PAGES_ENV', text: 'production' },
    { type: 'plain_text', name: 'XD_PAGES_KV_CAPABILITY', text: 'capability.jwt' },
  ]);
});

test('spa kv worker checks runtime path before assets and keeps runtime access guard', () => {
  const code = buildWorkerCode('spa', null, false, '127.0.0.1', { kv: { enabled: true } });

  assert.ok(code.indexOf('/.xd-pages/runtime/v1') < code.indexOf('env.ASSETS.fetch'));
  assert.match(code, /handlePagesRuntimeRequest/);
  assert.match(code, /checkIP\(request\)/);
  assert.doesNotMatch(code, /from ['"]@xd\//);
});
```

- [ ] **Step 5: Implement `cf-api` KV options**

Change signatures to keep backward compatibility by adding an optional final object:

```js
export function buildWorkerMetadata(completionJwt, preset, ipRestrict, allowlist, options = {}) {}
export function buildWorkerCode(preset, workerCode, ipRestrict, allowlist, options = {}) {}
export async function deployScript(token, accountId, scriptName, completionJwt, preset, workerCode, ipRestrict, allowlist, options = {}) {}
```

When `options.kv?.enabled` is true:

- Add service binding and plain text bindings listed in the spec.
- For `preset === 'spa'` and no user worker code, use the SDK inline runtime source and baked runtime allowlist guard.
- Keep `worker` preset code untouched even when KV is enabled.
- If runtime allowlist source is missing or empty, generated runtime guard must deny.

- [ ] **Step 6: Write deploy handler tests**

Add tests to `apps/server/src/handlers/deploy.test.js`:

```js
test('deploy rejects invalid kv values before Cloudflare calls', async () => {
  const form = new FormData();
  form.set('name', 'demo');
  form.set('kv', 'worker');
  form.append('index', new Blob(['ok'], { type: 'text/html' }), 'index.html');

  const response = await handleDeploy(new Request('https://api.workers.xd.team/deploy', {
    method: 'POST',
    headers: { 'X-Pages-Token': 'owner' },
    body: form,
  }), envWithExistingSite(null));

  assert.equal(response.status, 400);
  assert.equal((await response.json()).field, 'kv');
});

test('kv enabled deploy preserves existing siteUuid and returns kv flag without leaking capability', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return Response.json({ success: true, result: { jwt: 'asset-jwt', buckets: [] } });
  };

  try {
    const form = new FormData();
    form.set('name', 'demo');
    form.set('kv', 'true');
    form.append('index', new Blob(['ok'], { type: 'text/html' }), 'index.html');
    const writes = [];
    const response = await handleDeploy(new Request('https://api.workers.xd.team/deploy', {
      method: 'POST',
      headers: { 'X-Pages-Token': 'owner' },
      body: form,
    }), {
      ...envWithExistingSite({
        token: 'owner',
        siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47',
        siteGeneration: 3,
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      PUBLIC_ENVIRONMENT: 'production',
      KV_GATEWAY_SERVICE: 'pages-kv-gateway',
      PAGES_CAP_JWT_ACTIVE_KID: 'prod-hs-2026-06',
      PAGES_CAP_JWT_KEYS: 'prod-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606',
      PAGES_CAP_JWT_SECRET_202606: 'test-secret',
      SITES: {
        async get() {
          return {
            token: 'owner',
            siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47',
            siteGeneration: 3,
            createdAt: '2026-01-01T00:00:00.000Z',
          };
        },
        async put(key, value, options) {
          writes.push({ key, value: JSON.parse(value), options });
        },
      },
    });

    const body = await response.json();
    assert.equal(response.status, 200);
    assert.equal(body.kv, true);
    assert.doesNotMatch(JSON.stringify(body), /capability|jwt|test-secret/i);
    assert.equal(writes[0].value.siteUuid, '4b4c8e8361ef4b47b64f5c20a7db7c47');
    assert.equal(writes[0].value.siteGeneration, 4);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
```

- [ ] **Step 7: Implement deploy handler KV flow**

In `apps/server/src/handlers/deploy.js`:

- Parse `kv` with `parseKvEnabled(form.get('kv'))`.
- If parse returns `error`, return status `400` with `{ error: '无效的 kv 参数', field: 'kv', value, hint: 'kv 仅支持 true 或 false' }`.
- For new sites, generate `siteUuid` with `crypto.randomUUID().replaceAll('-', '')`.
- For same-token redeploys, preserve `existing.siteUuid`; if absent, generate one once and store it.
- Compute `siteGeneration = Number(existing?.siteGeneration || 0) + 1`.
- Sign capability only when `kv.enabled` is true.
- Pass `kv` options into `deployScript`.
- Persist `kvEnabled`, `siteUuid`, and `siteGeneration` in metadata and KV metadata.
- Return `kv: true` or `kv: false` in deploy response.
- Add warning when `kv=true && preset === 'worker'`: `_worker.js` receives this site's KV capability, must be bundled before upload when it imports `@xd/pages-sdk/worker`, and platform cannot stop owner code from exposing its own KV capability.

- [ ] **Step 8: Run server KV tests**

Run:

```bash
node --test "apps/server/src/lib/kv-capability.test.js" "apps/server/src/lib/cf-api.test.js" "apps/server/src/handlers/deploy.test.js"
```

Expected: PASS.

- [ ] **Step 9: Commit manager integration**

```bash
git add apps/server package.json
git commit -m "feat(kv): 接入子 Worker KV capability"
```

---

## Task 6: Update Public Docs, OpenAPI, And Skill Output

**Files:**

- Modify: `README.md`
- Modify: `API.md`
- Modify: `pages-deploy.skill.md`
- Modify: `apps/server/src/handlers/openapi.js`
- Modify: `apps/server/src/handlers/openapi.test.js`
- Modify: `apps/server/src/handlers/readme.test.js`
- Modify: `apps/server/src/handlers/skill.test.js`

- [ ] **Step 1: Write public output tests**

Add focused assertions:

```js
test('openapi documents kv opt-in and worker SDK bundling warning', async () => {
  const response = await handleOpenApi(new Request('https://api.workers.xd.team/openapi.json'), {
    PUBLIC_ENVIRONMENT: 'production',
    PUBLIC_API_BASE: 'https://api.workers.xd.team',
    DOMAIN_BASE: 'workers.xd.team',
    DOMAIN_LABEL: '',
  });
  const spec = await response.json();
  const text = JSON.stringify(spec);

  assert.match(text, /kv/);
  assert.match(text, /@xd\/pages-sdk\/browser/);
  assert.match(text, /@xd\/pages-sdk\/worker/);
  assert.match(text, /bundle|打包/);
  assert.doesNotMatch(text, /PAGES_CAP_JWT_SECRET|namespace id|capability\.jwt/);
});
```

For README and skill tests, assert the generated text contains:

- `@xd/pages-sdk/browser`
- `kv=true`
- `/.xd-pages/runtime/v1`
- `worker preset`
- no `PAGES_CAP_JWT_SECRET`
- no `SITE_DATA_KV_NAMESPACE_ID`

- [ ] **Step 2: Run doc tests and verify failure**

Run:

```bash
node --test "apps/server/src/handlers/openapi.test.js" "apps/server/src/handlers/readme.test.js" "apps/server/src/handlers/skill.test.js"
```

Expected: FAIL because KV docs are not published yet.

- [ ] **Step 3: Update docs and generated public content**

Update docs with these exact behavioral points:

- `kv=true` is the only v1 opt-in value; missing and `false` are disabled; invalid values are rejected.
- Browser usage:

```ts
import { createPagesClient } from '@xd/pages-sdk/browser';

const pages = createPagesClient();
const config = await pages.kv.get('app/config', { type: 'json' });
await pages.kv.set('drafts/123', { title: 'hello' });
await pages.kv.delete('drafts/123');
```

- Worker usage:

```js
import { createPagesRuntime } from '@xd/pages-sdk/worker';

export default {
  async fetch(request, env) {
    const pages = createPagesRuntime({ env });
    return Response.json(await pages.kv.get('app/config'));
  },
};
```

- `_worker.js` that imports npm packages must be bundled by the business build before uploading to pages-manager.
- Browser runtime endpoint is same-origin only: `POST /.xd-pages/runtime/v1/kv/get`, `put`, and `delete`.
- Public assets do not make KV runtime public; runtime KV remains protected by platform IP allowlist in v1.
- Worker preset owner code can misuse its own KV capability; platform only enforces cross-site prefix isolation.
- Do not store highly sensitive data in v1 browser KV.
- No real secret, namespace id, account id, or token appears in docs.

- [ ] **Step 4: Run doc tests**

Run:

```bash
node --test "apps/server/src/handlers/openapi.test.js" "apps/server/src/handlers/readme.test.js" "apps/server/src/handlers/skill.test.js"
```

Expected: PASS.

- [ ] **Step 5: Commit docs**

```bash
git add README.md API.md pages-deploy.skill.md apps/server/src/handlers/openapi.js apps/server/src/handlers/*.test.js
git commit -m "docs(kv): 说明 Pages KV SDK 使用方式"
```

---

## Task 7: Full Verification And Safety Review

**Files:**

- Verify all touched files.

- [ ] **Step 1: Install dependencies if lockfile changed or TypeScript is missing**

Run:

```bash
pnpm install
```

Expected: completes without secret output. Review `pnpm-lock.yaml` and include it in the final commit if it changed because `typescript` was added.

- [ ] **Step 2: Run full lint**

Run:

```bash
pnpm lint
```

Expected: PASS.

- [ ] **Step 3: Run full test suite**

Run:

```bash
pnpm test
```

Expected: PASS, including:

- `packages/pages-runtime-protocol/src/index.test.js`
- `apps/pages-sdk/test/*.test.js`
- `apps/kv-gateway/src/*.test.js`
- `apps/server/src/**/*.test.js`
- `scripts/*.test.js`

- [ ] **Step 4: Render production and staging configs without committing generated toml**

Run with dummy values:

```bash
CLOUDFLARE_ACCOUNT_ID=dummy-account \
SITES_KV_NAMESPACE_ID=dummy-sites-kv \
SITE_DATA_KV_NAMESPACE_ID=dummy-site-data-kv \
IP_ALLOWLIST=127.0.0.1,::1 \
PAGES_CAP_JWT_ACTIVE_KID=prod-hs-2026-06 \
PAGES_CAP_JWT_KEYS=prod-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606 \
scripts/gen-wrangler.sh apps/server production

CLOUDFLARE_ACCOUNT_ID=dummy-account \
SITES_KV_NAMESPACE_ID=dummy-sites-kv \
SITE_DATA_KV_NAMESPACE_ID=dummy-site-data-kv \
IP_ALLOWLIST=127.0.0.1,::1 \
PAGES_CAP_JWT_ACTIVE_KID=staging-hs-2026-06 \
PAGES_CAP_JWT_KEYS=staging-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606 \
scripts/gen-wrangler.sh apps/server staging

CLOUDFLARE_ACCOUNT_ID=dummy-account \
SITE_DATA_KV_NAMESPACE_ID=dummy-site-data-kv \
PAGES_CAP_JWT_ACTIVE_KID=prod-hs-2026-06 \
PAGES_CAP_JWT_KEYS=prod-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606 \
scripts/gen-wrangler.sh apps/kv-gateway production

CLOUDFLARE_ACCOUNT_ID=dummy-account \
SITE_DATA_KV_NAMESPACE_ID=dummy-site-data-kv \
PAGES_CAP_JWT_ACTIVE_KID=staging-hs-2026-06 \
PAGES_CAP_JWT_KEYS=staging-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606 \
scripts/gen-wrangler.sh apps/kv-gateway staging
```

Expected:

- production server config uses `KV_GATEWAY_SERVICE = "pages-kv-gateway"`.
- staging server config uses `KV_GATEWAY_SERVICE = "pages-kv-gateway-staging"`.
- production gateway config uses `name = "pages-kv-gateway"` and `workers_dev = false`.
- staging gateway config uses `name = "pages-kv-gateway-staging"` and `workers_dev = false`.
- no generated `wrangler.toml` files are committed.

- [ ] **Step 5: Secret and environment separation scan**

Run:

```bash
git diff --cached -- . ':!pnpm-lock.yaml' | rg -n "PAGES_CAP_JWT_SECRET_[0-9]+\\s*=|dummy-account|dummy-site-data-kv|capability\\.jwt|namespace_id|CF_API_TOKEN|CLOUDFLARE_API_TOKEN" || true
git status --short
```

Expected: no real secret values, no real Cloudflare IDs, no generated `apps/server/wrangler.toml`, no generated `apps/kv-gateway/wrangler.toml`.

- [ ] **Step 6: Final commit for lockfile or test-script-only changes**

If `pnpm-lock.yaml` or root dependency metadata changed after `pnpm install`, commit those changes:

```bash
git add pnpm-lock.yaml package.json
git commit -m "build(kv): 更新 Pages SDK 构建依赖"
```

Skip this commit only when there are no remaining changes.

---

## Self-Review Checklist

- [x] Spec coverage: protocol constants, POST endpoints, `kv=true` parsing, physical staging/production separation, site UUID prefix, HS256 key registry, browser SDK, Worker SDK, runtime adapter, gateway handlers, manager deploy plumbing, docs, tests, and security warnings each map to at least one task.
- [x] Placeholder scan: all tasks contain concrete file paths, commands, assertions, and implementation requirements.
- [x] Type consistency: SDK exports use `createPagesClient`, `createPagesRuntime`, `handlePagesRuntimeRequest`, `PagesRuntimeEnv`, and `KVType` consistently across tests and implementation steps.
- [x] Safety: docs and tests use dummy values only; generated `wrangler.toml` files remain uncommitted; production/staging config checks are explicit.
