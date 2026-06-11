# pages-manager Workspace Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convert `pages-manager` into a pnpm workspace with `apps/` and `packages/`, extract stable shared helpers, and replace workflow heredocs with a checked generator while preserving current runtime behavior.

**Architecture:** Keep root public documents as repository-level contract files. Move Workers into `apps/`, move only stable shared code into leaf `packages/`, and keep deployment isolation by generating one top-level `wrangler.toml` per app/environment instead of using `wrangler --env`.

**Tech Stack:** Node.js 22.12+, pnpm 9.15+, Cloudflare Wrangler 4.91, Workers runtime APIs, `node:test`, GitHub Actions.

---

## Files and Responsibilities

- `pnpm-workspace.yaml`: Defines workspace apps/packages and Wrangler catalog version.
- `package.json`: Root developer entry point and workspace-wide lint/test scripts.
- `apps/server/package.json`: Server Worker package metadata, Wrangler dependency, and workspace package dependencies.
- `apps/server/src/**`: Existing management API Worker source after directory move.
- `apps/xdads-302/package.json`: Legacy redirect Worker package metadata.
- `apps/xdads-302/index.js`: Existing redirect Worker source after directory move.
- `packages/worker-kit/src/index.js`: Shared Workers response helper, initially only `jsonResponse()`.
- `packages/worker-kit/src/index.test.js`: `jsonResponse()` behavior tests.
- `packages/ip-guard/src/index.js`: Shared IP allowlist parser, matcher, baked guard source builder, and env guard source.
- `packages/ip-guard/src/index.test.js`: Runtime matcher and generated guard source tests.
- `scripts/gen-wrangler.sh`: Generates `apps/server/wrangler.toml` or `apps/xdads-302/wrangler.toml` for a single app/environment.
- `scripts/gen-wrangler.test.js`: Tests generator output and environment safety checks.
- `.github/workflows/ci.yml`: Workspace install/lint/test CI.
- `.github/workflows/deploy.yml`: Production manual deployment, now with lint/test and generator.
- `.github/workflows/deploy-staging.yml`: Staging deployment using generator.
- `AGENTS.md`, `CLAUDE.md`, `README.md`: Path, command, and structure documentation.

---

### Task 1: Create Workspace Layout and Move Apps

**Files:**
- Create: `pnpm-workspace.yaml`
- Modify: `package.json`
- Move: `server/` -> `apps/server/`
- Move: `xdads-302/` -> `apps/xdads-302/`
- Modify: `apps/server/package.json`
- Create: `apps/xdads-302/package.json`
- Modify: `.gitignore`
- Modify: `apps/server/src/index.js`
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/deploy.yml`
- Modify: `.github/workflows/deploy-staging.yml`
- Delete: `apps/server/pnpm-lock.yaml`

- [ ] **Step 1: Add workspace metadata**

Create `pnpm-workspace.yaml`:

```yaml
packages:
  - apps/*
  - packages/*

catalog:
  wrangler: 4.91.0
```

Update root `package.json` scripts to:

```json
{
  "private": true,
  "packageManager": "pnpm@9.15.0",
  "type": "module",
  "engines": {
    "node": ">=22.12.0",
    "pnpm": ">=9.15.0"
  },
  "scripts": {
    "lint": "eslint .",
    "lint:fix": "eslint --fix .",
    "test": "node --test \"apps/server/src/**/*.test.js\"",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "fix": "eslint --fix . && prettier --write ."
  },
  "devDependencies": {
    "@eslint/js": "^9.0.0",
    "eslint": "^9.0.0",
    "eslint-config-prettier": "^10.0.0",
    "prettier": "^3.0.0"
  }
}
```

- [ ] **Step 2: Move app directories**

Run:

```bash
mkdir -p apps
git mv server apps/server
git mv xdads-302 apps/xdads-302
```

Expected: `git status --short` shows renames under `apps/`.

- [ ] **Step 3: Update app package metadata**

Replace `apps/server/package.json` with:

```json
{
  "name": "@xd/server",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "catalog:"
  }
}
```

Create `apps/xdads-302/package.json`:

```json
{
  "name": "@xd/xdads-302",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "devDependencies": {
    "wrangler": "catalog:"
  }
}
```

- [ ] **Step 4: Update document imports after move**

In `apps/server/src/index.js`, replace:

```js
import README from '../../README.md';
import SKILL from '../../pages-deploy.skill.md';
```

with:

```js
import README from '../../../README.md';
import SKILL from '../../../pages-deploy.skill.md';
```

- [ ] **Step 5: Update ignored generated Wrangler files**

In `.gitignore`, replace:

```gitignore
server/wrangler.toml
xdads-302/wrangler.toml
```

with:

```gitignore
apps/server/wrangler.toml
apps/xdads-302/wrangler.toml
```

- [ ] **Step 6: Update workflows to the new app path while keeping existing heredoc model**

In `.github/workflows/ci.yml`, keep install/lint/test root commands and ensure `cache-dependency-path` is `pnpm-lock.yaml`:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [master]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6

      - uses: pnpm/action-setup@v6
        with:
          version: 9.15.0

      - uses: actions/setup-node@v6
        with:
          node-version: 22.12.0
          cache: pnpm
          cache-dependency-path: pnpm-lock.yaml

      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm test
```

In `.github/workflows/deploy.yml` and `.github/workflows/deploy-staging.yml`, for this task only:

- replace `server/pnpm-lock.yaml` with `pnpm-lock.yaml`
- replace `pnpm --dir server install --frozen-lockfile` with `pnpm install --frozen-lockfile`
- replace `cat > server/wrangler.toml` with `cat > apps/server/wrangler.toml`
- replace `pnpm --dir server exec wrangler deploy` with `pnpm --dir apps/server exec wrangler deploy`
- replace `pnpm --dir server exec wrangler secret put` with `pnpm --dir apps/server exec wrangler secret put`

Production workflow still only has:

```yaml
on:
  workflow_dispatch:
```

Staging workflow still has:

```yaml
on:
  workflow_dispatch:
  push:
    branches: [staging]
```

- [ ] **Step 7: Remove nested lockfile and regenerate workspace lockfile**

Run:

```bash
rm apps/server/pnpm-lock.yaml
pnpm install
```

Expected: root `pnpm-lock.yaml` changes and no `apps/server/pnpm-lock.yaml` remains.

- [ ] **Step 8: Run verification**

Run:

```bash
pnpm lint
pnpm test
```

Expected: both commands pass.

- [ ] **Step 9: Commit workspace move**

Run:

```bash
git add package.json pnpm-workspace.yaml pnpm-lock.yaml .gitignore .github/workflows apps
git add -u server xdads-302
git commit -m "refactor: 调整 workspace 应用结构"
```

---

### Task 2: Add `@xd/worker-kit` and Replace JSON Helpers

**Files:**
- Create: `packages/worker-kit/package.json`
- Create: `packages/worker-kit/src/index.js`
- Create: `packages/worker-kit/src/index.test.js`
- Modify: `package.json`
- Modify: `apps/server/package.json`
- Modify: `apps/server/src/index.js`
- Modify: `apps/server/src/handlers/deploy.js`
- Modify: `apps/server/src/handlers/site.js`
- Modify: `apps/server/src/handlers/list.js`
- Modify: `apps/server/src/handlers/health.js`

- [ ] **Step 1: Write failing tests for `jsonResponse()`**

Update root `package.json` test script so package tests are included:

```json
"test": "node --test \"apps/server/src/**/*.test.js\" \"packages/**/*.test.js\""
```

Create `packages/worker-kit/package.json`:

```json
{
  "name": "@xd/worker-kit",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "exports": {
    ".": "./src/index.js"
  }
}
```

Create `packages/worker-kit/src/index.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { jsonResponse } from './index.js';

test('jsonResponse returns JSON with status 200 by default', async () => {
  const response = jsonResponse({ status: 'ok' });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('jsonResponse accepts custom status', () => {
  const response = jsonResponse({ error: 'bad request' }, 400);

  assert.equal(response.status, 400);
});

test('jsonResponse appends extra headers without allowing Content-Type override', () => {
  const response = jsonResponse(
    { status: 'ok' },
    201,
    {
      'Cache-Control': 'no-store',
      'Content-Type': 'text/plain',
    }
  );

  assert.equal(response.status, 201);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Content-Type'), 'application/json');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm test
```

Expected: FAIL because `packages/worker-kit/src/index.js` does not exist or does not export `jsonResponse`.

- [ ] **Step 3: Implement `jsonResponse()`**

Create `packages/worker-kit/src/index.js`:

```js
export function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...headers,
      'Content-Type': 'application/json',
    },
  });
}
```

- [ ] **Step 4: Run package test to verify it passes**

Run:

```bash
pnpm test
```

Expected: PASS for `packages/worker-kit/src/index.test.js`.

- [ ] **Step 5: Add package dependency to server**

Update `apps/server/package.json`:

```json
{
  "name": "@xd/server",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "wrangler deploy"
  },
  "dependencies": {
    "@xd/worker-kit": "workspace:*"
  },
  "devDependencies": {
    "wrangler": "catalog:"
  }
}
```

Run:

```bash
pnpm install
```

Expected: root `pnpm-lock.yaml` records `@xd/worker-kit` workspace dependency.

- [ ] **Step 6: Replace local JSON helpers**

In each of these files:

- `apps/server/src/index.js`
- `apps/server/src/handlers/deploy.js`
- `apps/server/src/handlers/site.js`
- `apps/server/src/handlers/list.js`

Add:

```js
import { jsonResponse } from '@xd/worker-kit';
```

Remove the local:

```js
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
```

Replace calls like:

```js
return json(data, status);
```

with:

```js
return jsonResponse(data, status);
```

In `apps/server/src/handlers/health.js`, replace the file with:

```js
import { jsonResponse } from '@xd/worker-kit';

export async function handleHealth() {
  return jsonResponse({ status: 'ok' });
}
```

- [ ] **Step 7: Run server tests**

Run:

```bash
pnpm test
```

Expected: all existing server tests and new worker-kit tests pass.

- [ ] **Step 8: Commit worker-kit extraction**

Run:

```bash
git add apps/server/package.json pnpm-lock.yaml packages/worker-kit apps/server/src
git commit -m "refactor(server): 抽取 JSON 响应 helper"
```

---

### Task 3: Add `@xd/ip-guard` and Move IP Logic Without Behavior Changes

**Files:**
- Create: `packages/ip-guard/package.json`
- Create: `packages/ip-guard/src/index.js`
- Create: `packages/ip-guard/src/index.test.js`
- Modify: `apps/server/package.json`
- Modify: `apps/server/src/index.js`
- Modify: `apps/server/src/lib/cf-api.js`
- Modify: `apps/server/src/lib/cf-api.test.js`
- Modify: `apps/server/src/handlers/openapi.js`
- Modify: `apps/server/src/handlers/openapi.test.js`
- Delete: `apps/server/src/lib/ip.js`

- [ ] **Step 1: Write failing tests for runtime IP matcher and generated source**

Create `packages/ip-guard/package.json`:

```json
{
  "name": "@xd/ip-guard",
  "version": "1.0.0",
  "type": "module",
  "private": true,
  "exports": {
    ".": "./src/index.js"
  }
}
```

Create `packages/ip-guard/src/index.test.js`:

```js
import assert from 'node:assert/strict';
import test from 'node:test';
import { ENV_GUARD_SOURCE, buildBakedGuardSource, isAllowedIP, parseAllowlist } from './index.js';

function requestWithIP(ip) {
  return new Request('https://site.workers.xd.team/', {
    headers: ip ? { 'CF-Connecting-IP': ip } : {},
  });
}

function loadBakedCheckIP(allowlist) {
  return new Function(`${buildBakedGuardSource(allowlist)}; return checkIP;`)();
}

function loadEnvCheckIP() {
  return new Function(`${ENV_GUARD_SOURCE}; return checkIP;`)();
}

test('parseAllowlist accepts comma whitespace and newline separators', () => {
  assert.deepEqual(parseAllowlist('127.0.0.1, 10.0.0.0/8\n::1'), ['127.0.0.1', '10.0.0.0/8', '::1']);
});

test('parseAllowlist removes empty entries', () => {
  assert.deepEqual(parseAllowlist(' , \n 127.0.0.1  , '), ['127.0.0.1']);
});

test('isAllowedIP supports IPv4 exact matches', () => {
  assert.equal(isAllowedIP('127.0.0.1', '127.0.0.1'), true);
  assert.equal(isAllowedIP('127.0.0.2', '127.0.0.1'), false);
});

test('isAllowedIP supports IPv4 CIDR ranges', () => {
  assert.equal(isAllowedIP('10.2.3.4', '10.0.0.0/8'), true);
  assert.equal(isAllowedIP('11.2.3.4', '10.0.0.0/8'), false);
});

test('isAllowedIP handles CIDR boundaries', () => {
  assert.equal(isAllowedIP('203.0.113.25', '0.0.0.0/0'), true);
  assert.equal(isAllowedIP('203.0.113.25', '203.0.113.25/32'), true);
  assert.equal(isAllowedIP('203.0.113.26', '203.0.113.25/32'), false);
});

test('isAllowedIP supports IPv6 exact matches', () => {
  assert.equal(isAllowedIP('::1', '::1'), true);
  assert.equal(isAllowedIP('::2', '::1'), false);
});

test('isAllowedIP denies missing IP empty allowlist and invalid rules', () => {
  assert.equal(isAllowedIP('', '127.0.0.1'), false);
  assert.equal(isAllowedIP('127.0.0.1', ''), false);
  assert.equal(isAllowedIP('999.0.0.1', '999.0.0.1'), false);
  assert.equal(isAllowedIP('127.0.0.1', '127.0.0.0/99'), false);
});

test('baked guard source checks IP without env binding', () => {
  const checkIP = loadBakedCheckIP('127.0.0.1,10.0.0.0/8,::1');

  assert.equal(checkIP(requestWithIP('127.0.0.1')), null);
  assert.equal(checkIP(requestWithIP('10.1.2.3')), null);
  assert.equal(checkIP(requestWithIP('::1')), null);
  assert.equal(checkIP(requestWithIP('198.51.100.10')).status, 403);
});

test('baked guard source does not read env.IP_ALLOWLIST', () => {
  const source = buildBakedGuardSource('127.0.0.1');

  assert.match(source, /const A=\["127\.0\.0\.1"\]/);
  assert.doesNotMatch(source, /env\.IP_ALLOWLIST/);
});

test('env guard source reads env.IP_ALLOWLIST and exposes checkIP(request, env)', () => {
  const checkIP = loadEnvCheckIP();
  const env = { IP_ALLOWLIST: '127.0.0.1,10.0.0.0/8,::1' };

  assert.equal(checkIP(requestWithIP('127.0.0.1'), env), null);
  assert.equal(checkIP(requestWithIP('10.1.2.3'), env), null);
  assert.equal(checkIP(requestWithIP('::1'), env), null);
  assert.equal(checkIP(requestWithIP('198.51.100.10'), env).status, 403);
  assert.match(ENV_GUARD_SOURCE, /env\.IP_ALLOWLIST/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
pnpm test
```

Expected: FAIL because `packages/ip-guard/src/index.js` does not exist or does not export the required symbols.

- [ ] **Step 3: Implement `@xd/ip-guard` with current semantics**

Create `packages/ip-guard/src/index.js`:

```js
export function parseAllowlist(value = '') {
  return String(value)
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function ipToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;

  let result = 0;
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null;
    const octet = Number(part);
    if (octet < 0 || octet > 255) return null;
    result = (result << 8) + octet;
  }
  return result >>> 0;
}

function parseRule(entry) {
  if (entry.includes(':')) return { type: 'exact6', value: entry };
  if (entry.includes('/')) {
    const [base, bitsValue] = entry.split('/');
    const baseInt = ipToInt(base);
    const bits = Number(bitsValue);
    if (baseInt === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    const mask = bits === 0 ? 0 : ~((1 << (32 - bits)) - 1) >>> 0;
    return { type: 'cidr', network: baseInt & mask, mask };
  }

  const exact = ipToInt(entry);
  return exact === null ? null : { type: 'exact4', value: exact };
}

export function isAllowedIP(ip, allowlist = '') {
  if (!ip) return false;

  const rules = parseAllowlist(allowlist).map(parseRule).filter(Boolean);
  if (rules.length === 0) return false;

  if (ip.includes(':')) {
    return rules.some((rule) => rule.type === 'exact6' && rule.value === ip);
  }

  const ipInt = ipToInt(ip);
  if (ipInt === null) return false;

  return rules.some((rule) => {
    if (rule.type === 'exact4') return rule.value === ipInt;
    if (rule.type === 'cidr') return (ipInt & rule.mask) === rule.network;
    return false;
  });
}

export function buildBakedGuardSource(allowlist) {
  const entries = JSON.stringify(parseAllowlist(allowlist));
  return `
const A=${entries};
function n2i(ip){return ip.split(".").reduce((a,o)=>(a<<8)+Number(o),0)>>>0}
const R=A.map(e=>{if(e.includes(":"))return{t:6,v:e};
if(e.includes("/")){const[b,s]=e.split("/");const m=~((1<<(32-Number(s)))-1)>>>0;return{t:4,n:n2i(b)&m,m};}
return{t:4,v:n2i(e)};});
function checkIP(req){const ip=req.headers.get("CF-Connecting-IP");if(!ip)return null;
if(ip.includes(":"))return R.some(r=>r.t===6&&r.v===ip)?null:new Response("IP not allowed",{status:403});
const n=n2i(ip);const ok=R.some(r=>{if(r.t===6)return false;if(r.v!==undefined)return r.v===n;return(n&r.m)===r.n;});
return ok?null:new Response("IP not allowed",{status:403});}`;
}

export const ENV_GUARD_SOURCE = [
  'function getAllowed(env) {',
  '  return String(env.IP_ALLOWLIST || "")',
  '    .split(",")',
  '    .map((entry) => entry.trim())',
  '    .filter(Boolean);',
  '}',
  '',
  'function ipToInt(ip) {',
  '  return ip.split(".").reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;',
  '}',
  '',
  'function toRules(allowed) {',
  '  return allowed.map((entry) => {',
  '  if (entry.includes(":")) return { type: "exact6", value: entry };',
  '  if (entry.includes("/")) {',
  '    const [base, bits] = entry.split("/");',
  '    const mask = ~((1 << (32 - Number(bits))) - 1) >>> 0;',
  '    return { type: "cidr", network: ipToInt(base) & mask, mask };',
  '  }',
  '  return { type: "exact4", value: ipToInt(entry) };',
  '  });',
  '}',
  '',
  'function checkIP(request, env) {',
  '  const rules = toRules(getAllowed(env));',
  '  const ip = request.headers.get("CF-Connecting-IP");',
  '  if (!ip) return null;',
  '  if (ip.includes(":")) {',
  '    return rules.some((r) => r.type === "exact6" && r.value === ip)',
  '      ? null',
  '      : new Response("IP not allowed", { status: 403 });',
  '  }',
  '  const n = ipToInt(ip);',
  '  const ok = rules.some((r) => {',
  '    if (r.type === "exact4") return r.value === n;',
  '    if (r.type === "cidr") return (n & r.mask) === r.network;',
  '    return false;',
  '  });',
  '  return ok ? null : new Response("IP not allowed", { status: 403 });',
  '}',
].join('\\n');
```

- [ ] **Step 4: Run package tests**

Run:

```bash
pnpm test
```

Expected: new `@xd/ip-guard` tests pass.

- [ ] **Step 5: Add dependency to server**

Update `apps/server/package.json` dependencies to include both packages:

```json
"dependencies": {
  "@xd/ip-guard": "workspace:*",
  "@xd/worker-kit": "workspace:*"
}
```

Run:

```bash
pnpm install
```

Expected: root `pnpm-lock.yaml` records `@xd/ip-guard` workspace dependency.

- [ ] **Step 6: Replace server runtime import and delete old ip module**

In `apps/server/src/index.js`, replace:

```js
import { isAllowedIP } from './lib/ip.js';
```

with:

```js
import { isAllowedIP } from '@xd/ip-guard';
```

Delete `apps/server/src/lib/ip.js`.

- [ ] **Step 7: Replace baked guard builder in `cf-api.js`**

In `apps/server/src/lib/cf-api.js`, replace:

```js
import { parseAllowlist } from './ip.js';
```

with:

```js
import { buildBakedGuardSource } from '@xd/ip-guard';
```

Remove the local `buildIpGuard(allowlist)` function.

Replace:

```js
${buildIpGuard(allowlist)}
```

with:

```js
${buildBakedGuardSource(allowlist)}
```

Keep `buildWorkerMetadata()` and `buildWorkerCode()` behavior unchanged.

- [ ] **Step 8: Replace OpenAPI env guard source**

In `apps/server/src/handlers/openapi.js`, add:

```js
import { ENV_GUARD_SOURCE } from '@xd/ip-guard';
```

Replace the existing `source: [...].join('\n')` for `x-libs.ip-guard.source` with:

```js
source: ENV_GUARD_SOURCE,
```

Keep `usage: 'const blocked = checkIP(request, env); if (blocked) return blocked;'` unchanged.

- [ ] **Step 9: Run focused regression tests**

Run:

```bash
pnpm test
```

Expected:

- `apps/server/src/handlers/openapi.test.js` passes and still sees `env.IP_ALLOWLIST`.
- `apps/server/src/lib/cf-api.test.js` passes and still sees baked `const A=["127.0.0.1","::1"]`.
- `packages/ip-guard/src/index.test.js` passes.

- [ ] **Step 10: Commit ip-guard extraction**

Run:

```bash
git add apps/server/package.json pnpm-lock.yaml packages/ip-guard apps/server/src
git add -u apps/server/src/lib/ip.js
git commit -m "refactor(server): 抽取 IP 白名单逻辑"
```

---

### Task 4: Add Wrangler Templates and Generator

**Files:**
- Rename: `apps/server/wrangler.example.toml` -> `apps/server/wrangler.template.toml`
- Rename: `apps/xdads-302/wrangler.example.toml` -> `apps/xdads-302/wrangler.template.toml`
- Create: `scripts/gen-wrangler.sh`
- Create: `scripts/gen-wrangler.test.js`
- Modify: `package.json`
- Modify: `.github/workflows/deploy.yml`
- Modify: `.github/workflows/deploy-staging.yml`

- [ ] **Step 1: Rename templates**

Run:

```bash
git mv apps/server/wrangler.example.toml apps/server/wrangler.template.toml
git mv apps/xdads-302/wrangler.example.toml apps/xdads-302/wrangler.template.toml
```

- [ ] **Step 2: Replace server template content**

Replace `apps/server/wrangler.template.toml` with:

```toml
name = "__WORKER_NAME__"
main = "src/index.js"
compatibility_date = "2025-05-01"
account_id = "__CLOUDFLARE_ACCOUNT_ID__"
workers_dev = true

[vars]
CF_ACCOUNT_ID = "__CLOUDFLARE_ACCOUNT_ID__"
PAGES_MANAGER_WORKER_NAME = "__WORKER_NAME__"
PUBLIC_ENVIRONMENT = "__PUBLIC_ENVIRONMENT__"
PUBLIC_API_BASE = "__PUBLIC_API_BASE__"
PUBLIC_MANAGER_DEV_BASE = "__PUBLIC_MANAGER_DEV_BASE__"
DOMAIN_BASE = "__DOMAIN_BASE__"
DOMAIN_LABEL = "__DOMAIN_LABEL__"
WORKER_PREFIX = "__WORKER_PREFIX__"
WORKERS_DEV_SUBDOMAIN = "__WORKERS_DEV_SUBDOMAIN__"
IP_ALLOWLIST = "__IP_ALLOWLIST__"

[[rules]]
type = "Text"
globs = ["**/*.md"]
fallthrough = true

[[kv_namespaces]]
binding = "SITES"
id = "__SITES_KV_NAMESPACE_ID__"

[[routes]]
pattern = "__API_ROUTE__"
custom_domain = true

# Runtime secrets, set outside the repository:
# npx wrangler secret put CF_ZONE_ID_NEW
# npx wrangler secret put CF_API_TOKEN
```

- [ ] **Step 3: Write failing generator tests**

Update root `package.json` test script so script tests are included:

```json
"test": "node --test \"apps/server/src/**/*.test.js\" \"packages/**/*.test.js\" \"scripts/**/*.test.js\""
```

Create `scripts/gen-wrangler.test.js`:

```js
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import test from 'node:test';

const env = {
  ...process.env,
  CLOUDFLARE_ACCOUNT_ID: 'dummy-account',
  SITES_KV_NAMESPACE_ID: 'dummy-kv',
  IP_ALLOWLIST: '127.0.0.1,::1',
};

function runGenerator(targetEnv) {
  execFileSync('bash', ['scripts/gen-wrangler.sh', 'apps/server', targetEnv], {
    env,
    stdio: 'pipe',
  });
  const output = readFileSync('apps/server/wrangler.toml', 'utf8');
  rmSync('apps/server/wrangler.toml', { force: true });
  return output;
}

test('generator renders production server wrangler config', () => {
  const output = runGenerator('production');

  assert.match(output, /name = "pages-manager"/);
  assert.match(output, /PUBLIC_ENVIRONMENT = "production"/);
  assert.match(output, /PUBLIC_API_BASE = "https:\/\/api\.workers\.xd\.team"/);
  assert.match(output, /WORKER_PREFIX = "pages-"/);
  assert.match(output, /pattern = "api\.workers\.xd\.team"/);
  assert.doesNotMatch(output, /api-staging/);
  assert.doesNotMatch(output, /pages-staging-/);
});

test('generator renders staging server wrangler config', () => {
  const output = runGenerator('staging');

  assert.match(output, /name = "pages-manager-staging"/);
  assert.match(output, /PUBLIC_ENVIRONMENT = "staging"/);
  assert.match(output, /PUBLIC_API_BASE = "https:\/\/api-staging\.workers\.xd\.team"/);
  assert.match(output, /DOMAIN_LABEL = "-staging"/);
  assert.match(output, /WORKER_PREFIX = "pages-staging-"/);
  assert.match(output, /pattern = "api-staging\.workers\.xd\.team"/);
});

test('generator rejects unknown environment', () => {
  assert.throws(
    () =>
      execFileSync('bash', ['scripts/gen-wrangler.sh', 'apps/server', 'preview'], {
        env,
        stdio: 'pipe',
      }),
    /Command failed/
  );
});

test('generator rejects unsafe IP_ALLOWLIST values', () => {
  assert.throws(
    () =>
      execFileSync('bash', ['scripts/gen-wrangler.sh', 'apps/server', 'staging'], {
        env: { ...env, IP_ALLOWLIST: '127.0.0.1"bad' },
        stdio: 'pipe',
      }),
    /Command failed/
  );
});
```

- [ ] **Step 4: Run generator tests to verify they fail**

Run:

```bash
pnpm test
```

Expected: FAIL because `scripts/gen-wrangler.sh` does not exist.

- [ ] **Step 5: Implement generator script**

Create `scripts/gen-wrangler.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail

APP="${1:-}"
ENVIRONMENT="${2:-}"

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    die "$name is required"
  fi
}

toml_safe() {
  local name="$1"
  local value="$2"
  case "$value" in
    *\"*|*\\*|*$'\n'*|*$'\r'*)
      die "$name contains unsupported TOML string characters"
      ;;
  esac
}

replace_token() {
  local file="$1"
  local token="$2"
  local value="$3"
  perl -0pi -e "s/\\Q$token\\E/\\Q$value\\E/g" "$file"
}

[ -n "$APP" ] || die "app path is required"
[ -n "$ENVIRONMENT" ] || die "environment is required"

case "$APP" in
  apps/server) ;;
  apps/xdads-302) ;;
  *) die "unsupported app: $APP" ;;
esac

case "$ENVIRONMENT" in
  production|staging) ;;
  *) die "unsupported environment: $ENVIRONMENT" ;;
esac

require_env CLOUDFLARE_ACCOUNT_ID
toml_safe CLOUDFLARE_ACCOUNT_ID "$CLOUDFLARE_ACCOUNT_ID"

TEMPLATE="$APP/wrangler.template.toml"
OUTPUT="$APP/wrangler.toml"
[ -f "$TEMPLATE" ] || die "template not found: $TEMPLATE"

DOMAIN_BASE="workers.xd.team"
WORKERS_DEV_SUBDOMAIN="xd-cf-2022"

if [ "$APP" = "apps/server" ]; then
  require_env SITES_KV_NAMESPACE_ID
  require_env IP_ALLOWLIST
  toml_safe SITES_KV_NAMESPACE_ID "$SITES_KV_NAMESPACE_ID"
  toml_safe IP_ALLOWLIST "$IP_ALLOWLIST"
  if ! [[ "$IP_ALLOWLIST" =~ ^[0-9A-Fa-f:\.,/\ _-]+$ ]]; then
    die "IP_ALLOWLIST contains unsupported characters"
  fi

  if [ "$ENVIRONMENT" = "production" ]; then
    WORKER_NAME="pages-manager"
    PUBLIC_ENVIRONMENT="production"
    PUBLIC_API_BASE="https://api.workers.xd.team"
    PUBLIC_MANAGER_DEV_BASE="https://pages-manager.xd-cf-2022.workers.dev"
    DOMAIN_LABEL=""
    WORKER_PREFIX="pages-"
    API_ROUTE="api.workers.xd.team"
  else
    WORKER_NAME="pages-manager-staging"
    PUBLIC_ENVIRONMENT="staging"
    PUBLIC_API_BASE="https://api-staging.workers.xd.team"
    PUBLIC_MANAGER_DEV_BASE="https://pages-manager-staging.xd-cf-2022.workers.dev"
    DOMAIN_LABEL="-staging"
    WORKER_PREFIX="pages-staging-"
    API_ROUTE="api-staging.workers.xd.team"
  fi

  if [ "$ENVIRONMENT" = "production" ]; then
    [[ "$WORKER_NAME" != *staging* ]] || die "production worker name includes staging"
    [[ "$API_ROUTE" != *api-staging* ]] || die "production route includes api-staging"
    [ "$WORKER_PREFIX" = "pages-" ] || die "production worker prefix must be pages-"
  else
    [[ "$WORKER_NAME" == *staging* ]] || die "staging worker name must include staging"
    [ "$API_ROUTE" = "api-staging.workers.xd.team" ] || die "staging route mismatch"
    [ "$WORKER_PREFIX" = "pages-staging-" ] || die "staging worker prefix mismatch"
  fi

  cp "$TEMPLATE" "$OUTPUT"
  replace_token "$OUTPUT" "__WORKER_NAME__" "$WORKER_NAME"
  replace_token "$OUTPUT" "__CLOUDFLARE_ACCOUNT_ID__" "$CLOUDFLARE_ACCOUNT_ID"
  replace_token "$OUTPUT" "__PUBLIC_ENVIRONMENT__" "$PUBLIC_ENVIRONMENT"
  replace_token "$OUTPUT" "__PUBLIC_API_BASE__" "$PUBLIC_API_BASE"
  replace_token "$OUTPUT" "__PUBLIC_MANAGER_DEV_BASE__" "$PUBLIC_MANAGER_DEV_BASE"
  replace_token "$OUTPUT" "__DOMAIN_BASE__" "$DOMAIN_BASE"
  replace_token "$OUTPUT" "__DOMAIN_LABEL__" "$DOMAIN_LABEL"
  replace_token "$OUTPUT" "__WORKER_PREFIX__" "$WORKER_PREFIX"
  replace_token "$OUTPUT" "__WORKERS_DEV_SUBDOMAIN__" "$WORKERS_DEV_SUBDOMAIN"
  replace_token "$OUTPUT" "__IP_ALLOWLIST__" "$IP_ALLOWLIST"
  replace_token "$OUTPUT" "__SITES_KV_NAMESPACE_ID__" "$SITES_KV_NAMESPACE_ID"
  replace_token "$OUTPUT" "__API_ROUTE__" "$API_ROUTE"
else
  if [ "$ENVIRONMENT" != "production" ]; then
    die "apps/xdads-302 only supports production"
  fi
  cp "$TEMPLATE" "$OUTPUT"
  replace_token "$OUTPUT" "__CLOUDFLARE_ACCOUNT_ID__" "$CLOUDFLARE_ACCOUNT_ID"
fi

printf 'generated %s\n' "$OUTPUT"
```

Run:

```bash
chmod +x scripts/gen-wrangler.sh
```

- [ ] **Step 6: Run generator tests**

Run:

```bash
pnpm test
```

Expected: `scripts/gen-wrangler.test.js` passes.

- [ ] **Step 7: Replace deploy workflow heredocs with generator**

Replace `.github/workflows/deploy.yml` with:

```yaml
name: Deploy Production

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v6

      - uses: pnpm/action-setup@v6
        with:
          version: 9.15.0

      - uses: actions/setup-node@v6
        with:
          node-version: 22.12.0
          cache: pnpm
          cache-dependency-path: pnpm-lock.yaml

      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm test

      - name: Generate Wrangler config
        shell: bash
        env:
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          SITES_KV_NAMESPACE_ID: ${{ secrets.SITES_KV_NAMESPACE_ID }}
          IP_ALLOWLIST: ${{ vars.IP_ALLOWLIST }}
        run: scripts/gen-wrangler.sh apps/server production

      - name: Validate Worker secrets
        shell: bash
        env:
          CF_ZONE_ID_NEW: ${{ secrets.CF_ZONE_ID_NEW }}
          CF_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
        run: |
          set -euo pipefail
          : "${CF_ZONE_ID_NEW:?CF_ZONE_ID_NEW is required}"
          : "${CF_API_TOKEN:?CF_API_TOKEN is required}"

      - name: Deploy Worker
        shell: bash
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: pnpm --dir apps/server exec wrangler deploy

      - name: Inject Worker secrets
        shell: bash
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          CF_ZONE_ID_NEW: ${{ secrets.CF_ZONE_ID_NEW }}
          CF_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
        run: |
          set -euo pipefail
          printf '%s' "$CF_ZONE_ID_NEW" | pnpm --dir apps/server exec wrangler secret put CF_ZONE_ID_NEW
          printf '%s' "$CF_API_TOKEN" | pnpm --dir apps/server exec wrangler secret put CF_API_TOKEN
```

Replace `.github/workflows/deploy-staging.yml` with:

```yaml
name: Deploy Staging

on:
  workflow_dispatch:
  push:
    branches: [staging]

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: actions/checkout@v6

      - uses: pnpm/action-setup@v6
        with:
          version: 9.15.0

      - uses: actions/setup-node@v6
        with:
          node-version: 22.12.0
          cache: pnpm
          cache-dependency-path: pnpm-lock.yaml

      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm test

      - name: Generate Wrangler config
        shell: bash
        env:
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          SITES_KV_NAMESPACE_ID: ${{ secrets.SITES_KV_NAMESPACE_ID }}
          IP_ALLOWLIST: ${{ vars.IP_ALLOWLIST }}
        run: scripts/gen-wrangler.sh apps/server staging

      - name: Validate Worker secrets
        shell: bash
        env:
          CF_ZONE_ID_NEW: ${{ secrets.CF_ZONE_ID_NEW }}
          CF_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
        run: |
          set -euo pipefail
          : "${CF_ZONE_ID_NEW:?CF_ZONE_ID_NEW is required}"
          : "${CF_API_TOKEN:?CF_API_TOKEN is required}"

      - name: Deploy Worker
        shell: bash
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
        run: pnpm --dir apps/server exec wrangler deploy

      - name: Inject Worker secrets
        shell: bash
        env:
          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          CF_ZONE_ID_NEW: ${{ secrets.CF_ZONE_ID_NEW }}
          CF_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
        run: |
          set -euo pipefail
          printf '%s' "$CF_ZONE_ID_NEW" | pnpm --dir apps/server exec wrangler secret put CF_ZONE_ID_NEW
          printf '%s' "$CF_API_TOKEN" | pnpm --dir apps/server exec wrangler secret put CF_API_TOKEN
```

- [ ] **Step 8: Run workflow and generator verification**

Run:

```bash
pnpm test
CLOUDFLARE_ACCOUNT_ID=dummy-account SITES_KV_NAMESPACE_ID=dummy-kv IP_ALLOWLIST=127.0.0.1,::1 scripts/gen-wrangler.sh apps/server staging
rg -n 'pages-manager-staging|api-staging\.workers\.xd\.team|pages-staging-' apps/server/wrangler.toml
rm apps/server/wrangler.toml
CLOUDFLARE_ACCOUNT_ID=dummy-account SITES_KV_NAMESPACE_ID=dummy-kv IP_ALLOWLIST=127.0.0.1,::1 scripts/gen-wrangler.sh apps/server production
rg -n 'name = "pages-manager"|api\.workers\.xd\.team|WORKER_PREFIX = "pages-"' apps/server/wrangler.toml
rm apps/server/wrangler.toml
```

Expected: tests pass, both generated configs contain the expected environment-specific values, and generated `wrangler.toml` is removed.

- [ ] **Step 9: Commit generator and workflow changes**

Run:

```bash
git add apps/server/wrangler.template.toml apps/xdads-302/wrangler.template.toml scripts/gen-wrangler.sh scripts/gen-wrangler.test.js .github/workflows package.json pnpm-lock.yaml
git add -u apps/server/wrangler.example.toml apps/xdads-302/wrangler.example.toml
git commit -m "ci: 生成 Wrangler 部署配置"
```

---

### Task 5: Update Repository Documentation

**Files:**
- Modify: `AGENTS.md`
- Modify: `CLAUDE.md`
- Modify: `README.md`
- Inspect: `API.md`

- [ ] **Step 1: Update AGENTS and CLAUDE paths**

In both `AGENTS.md` and `CLAUDE.md`, update these references:

```text
server/src/ -> apps/server/src/
server/src/handlers/ -> apps/server/src/handlers/
server/src/lib/ -> apps/server/src/lib/
server/wrangler.toml -> apps/server/wrangler.toml
xdads-302/wrangler.toml -> apps/xdads-302/wrangler.toml
```

Keep both files byte-for-byte identical except for their filenames.

- [ ] **Step 2: Update README file tree and commands**

In `README.md`, replace the file structure section with:

```text
pages-manager/
├── README.md
├── API.md
├── pages-deploy.skill.md
├── pnpm-workspace.yaml
├── apps/
│   ├── server/
│   │   ├── wrangler.template.toml
│   │   ├── package.json
│   │   └── src/
│   │       ├── index.js
│   │       ├── router.js
│   │       ├── lib/
│   │       │   ├── cf-api.js
│   │       │   └── public-config.js
│   │       └── handlers/
│   │           ├── deploy.js
│   │           ├── site.js
│   │           ├── list.js
│   │           └── health.js
│   └── xdads-302/
│       ├── wrangler.template.toml
│       ├── package.json
│       └── index.js
├── packages/
│   ├── ip-guard/
│   └── worker-kit/
├── scripts/
│   ├── gen-wrangler.sh
│   ├── deploy.sh
│   ├── manage.sh
│   └── migrate-domain.sh
└── demos/
```

Replace local development commands with:

```bash
pnpm install

# 本地开发管理 Worker
pnpm --dir apps/server dev

# 生成本地 Wrangler 配置后部署管理 Worker
CLOUDFLARE_ACCOUNT_ID=example-account-id \
SITES_KV_NAMESPACE_ID=example-kv-namespace-id \
IP_ALLOWLIST=127.0.0.1,::1 \
scripts/gen-wrangler.sh apps/server production
pnpm --dir apps/server deploy
```

Replace the ignored file note with:

```text
真实 `apps/server/wrangler.toml`、`apps/xdads-302/wrangler.toml`、`.dev.vars`、`.env` 和 `.pages.json` 不提交到 Git。GitHub Actions 部署时会根据 Environment Secrets 生成 `apps/server/wrangler.toml`。
```

- [ ] **Step 3: Inspect API.md**

Run:

```bash
rg -n 'server/|wrangler|xdads-302|pages-manager|api\.workers\.xd\.team' API.md
```

Expected: `API.md` contains public API behavior but no stale source tree paths that must change for this refactor. If only API URLs and endpoint examples appear, leave `API.md` unchanged.

- [ ] **Step 4: Verify AGENTS and CLAUDE are synchronized**

Run:

```bash
diff -u AGENTS.md CLAUDE.md
```

Expected: no output.

- [ ] **Step 5: Commit documentation updates**

Run:

```bash
git add AGENTS.md CLAUDE.md README.md API.md
git commit -m "docs: 更新 workspace 结构说明"
```

---

### Task 6: Final Verification and Cleanup

**Files:**
- Inspect: entire repository
- Generated then remove: `apps/server/wrangler.toml`

- [ ] **Step 1: Ensure no generated config is tracked**

Run:

```bash
git status --short
git check-ignore -v apps/server/wrangler.toml apps/xdads-302/wrangler.toml
```

Expected:

- `git status --short` does not show `apps/server/wrangler.toml`.
- `git check-ignore` reports `.gitignore` rules for both generated Wrangler files.

- [ ] **Step 2: Run full project verification**

Run:

```bash
pnpm install --frozen-lockfile
pnpm lint
pnpm test
```

Expected: all commands pass.

- [ ] **Step 3: Run staging generator and Wrangler dry-run**

Run:

```bash
CLOUDFLARE_ACCOUNT_ID=dummy-account \
SITES_KV_NAMESPACE_ID=dummy-kv \
IP_ALLOWLIST=127.0.0.1,::1 \
scripts/gen-wrangler.sh apps/server staging

pnpm --dir apps/server exec wrangler deploy --dry-run
rm apps/server/wrangler.toml
```

Expected: Wrangler dry-run succeeds or fails only because dummy Cloudflare values are rejected after local config parsing. It must not fail because of missing Markdown imports, missing package dependencies, or stale paths.

- [ ] **Step 4: Run production generator and Wrangler dry-run**

Run:

```bash
CLOUDFLARE_ACCOUNT_ID=dummy-account \
SITES_KV_NAMESPACE_ID=dummy-kv \
IP_ALLOWLIST=127.0.0.1,::1 \
scripts/gen-wrangler.sh apps/server production

pnpm --dir apps/server exec wrangler deploy --dry-run
rm apps/server/wrangler.toml
```

Expected: Wrangler dry-run succeeds or fails only because dummy Cloudflare values are rejected after local config parsing. It must not fail because of missing Markdown imports, missing package dependencies, or stale paths.

- [ ] **Step 5: Check production workflow trigger**

Run:

```bash
sed -n '1,20p' .github/workflows/deploy.yml
sed -n '1,25p' .github/workflows/deploy-staging.yml
```

Expected:

- production deploy workflow has only `workflow_dispatch`.
- staging deploy workflow has `workflow_dispatch` and push `staging`.

- [ ] **Step 6: Review diff for secrets and environment mixups**

Run:

```bash
rg -n 'cf_[A-Za-z0-9]|CLOUDFLARE_API_TOKEN=.*[A-Za-z0-9]{20,}|SITES_KV_NAMESPACE_ID = "[a-f0-9-]{20,}"|account_id = "[a-f0-9]{20,}"' .
rg -n 'api-staging|pages-staging|pages-manager-staging|api\.workers\.xd\.team|pages-manager"' .github/workflows apps/server/wrangler.template.toml scripts/gen-wrangler.sh
```

Expected:

- first command returns no real-looking secrets or IDs.
- second command shows staging values only in staging matrix/tests and production values only in production matrix/tests.

- [ ] **Step 7: Confirm final working tree state**

Run:

```bash
git status --short
```

Expected: no output. If this prints `apps/server/wrangler.toml`, delete that generated file and run `git status --short` again.

---

## Implementation Notes

- Do not change `/readme.md` rendering behavior in this refactor. It should still return root `README.md` without staging/production replacement.
- Do not move `README.md`, `API.md`, or `pages-deploy.skill.md` into `apps/server/`.
- Do not introduce `wrangler --env`.
- Do not change `MIME_WORKER_HELPER` or `MIME_TYPES` behavior.
- Do not wrap or mutate user-provided `_worker.js` for worker preset deployments.
- Keep `AGENTS.md` and `CLAUDE.md` synchronized after every documentation edit.
