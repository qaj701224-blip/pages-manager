import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import kvGatewayWorker from '../../kv-gateway/src/index.js';
import routerWorker from '../../pages-router/src/index.js';
import apiWorker from './index.js';
import { createTestPagesStore } from './test-store.js';

test('site created by API can deploy and use router-proxied Pages KV', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await store.createUser({
    userId: 'usr_1',
    email: 'user@example.com',
    realname: 'User One',
    employeeStatus: 'active',
  });
  const snapshots = new MemoryRouteSnapshots();
  const siteData = new MemoryKv();
  const apiEnv = {
    PAGES_ENV: 'production',
    PAGES_STORE: store,
    ROUTE_SNAPSHOTS: snapshots,
    IP_ALLOWLIST: '10.0.0.0/8',
    ACCESS_KEY_PEPPERS: 'pepper_1:ACCESS_KEY_PEPPER_TEST',
    ACCESS_KEY_PEPPER_TEST: 'pepper-secret',
    now: () => '2026-06-15T00:00:00.000Z',
    nextId: deterministicId(),
    nextSiteUuid: () => '4b4c8e8361ef4b47b64f5c20a7db7c47',
    verifyCliToken: async () => ({
      sub: 'usr_1',
      purpose: 'cli_token',
      aud: 'pages-cli',
      env: 'production',
      jti: 'cli_1',
    }),
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => ({ ok: true }),
    },
  };

  const createSite = await apiWorker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/sites', { slug: 'guide', visibility: 'internal' }),
    apiEnv
  );
  const siteBody = await createSite.json();
  const deploy = await apiWorker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      { siteId: siteBody.site.id, workerContent: 'export default {};' },
      { 'Idempotency-Key': 'deploy_docs' }
    ),
    apiEnv
  );

  assert.equal(createSite.status, 201);
  assert.equal(deploy.status, 201);
  assert.equal((await store.getSite(siteBody.site.id)).siteUuid, '4b4c8e8361ef4b47b64f5c20a7db7c47');

  const routerResponse = await routerWorker.fetch(
    new Request('https://guide.pages.xd.team/.xd-pages/runtime/v1/kv/set', {
      method: 'POST',
      headers: {
        'CF-Connecting-IP': '10.1.2.3',
        'Content-Type': 'application/json',
        'X-XD-Pages-Runtime': '1',
        Origin: 'https://guide.pages.xd.team',
      },
      body: JSON.stringify({ key: 'app/config', value: { enabled: true }, type: 'json' }),
    }),
    routerEnv(snapshots, siteData)
  );

  assert.equal(routerResponse.status, 200);
  assert.equal((await routerResponse.json()).ok, true);
  assert.deepEqual([...siteData.values.values()], [JSON.stringify({ enabled: true })]);
});

function deterministicId() {
  const counters = { site: 0, route: 0, dep: 0, ver: 0 };
  return (prefix) => {
    counters[prefix] = (counters[prefix] || 0) + 1;
    return `${prefix}_${counters[prefix]}`;
  };
}

function routerEnv(routeSnapshots, siteData) {
  return {
    PAGES_ENV: 'production',
    PAGES_SESSION_JWT_ISSUER: 'pages-router',
    PUBLIC_AUTH_BASE: 'https://auth.pages.xd.team',
    ROUTER_IP_ALLOWLIST_CIDRS: '10.0.0.0/8',
    PAGES_SESSION_JWT_ACTIVE_KID: 'session-hs-2026-06',
    PAGES_SESSION_JWT_KEYS: 'session-hs-2026-06:HS256:PAGES_SESSION_JWT_SECRET_TEST',
    PAGES_SESSION_JWT_SECRET_TEST: 'test-session-secret',
    PAGES_CAP_JWT_ACTIVE_KID: 'cap-hs-2026-06',
    PAGES_CAP_JWT_KEYS: 'cap-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_TEST',
    PAGES_CAP_JWT_SECRET_TEST: 'test-capability-secret',
    nowSeconds: () => Math.floor(Date.now() / 1000),
    ROUTE_SNAPSHOTS: routeSnapshots,
    PAGES_DISPATCH: {
      get() {
        return {
          fetch: async () => new Response('user worker ok'),
        };
      },
    },
    XD_PAGES_KV_GATEWAY: {
      fetch: async (request) =>
        kvGatewayWorker.fetch(request, {
          XD_PAGES_ENV: 'production',
          PAGES_CAP_JWT_KEYS: 'cap-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_TEST',
          PAGES_CAP_JWT_SECRET_TEST: 'test-capability-secret',
          SITE_DATA: siteData,
        }),
    },
  };
}

function jsonRequest(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer cli-token',
      'CF-Connecting-IP': '10.1.2.3',
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function deploymentRequest(url, { siteId, workerContent }, headers = {}) {
  const moduleName = 'worker.mjs';
  const contentType = 'application/javascript+module';
  const bytes = Buffer.from(workerContent);
  const decision = {
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    workerEntry: moduleName,
  };
  const metadata = {
    schemaVersion: 1,
    siteId,
    requestedFallback: 'auto',
    source: 'cli',
    contentHash: hashUploadPlan([{ relativePath: moduleName, contentType, bytes }], decision),
    publishPlan: {
      ...decision,
      workerMainModuleName: moduleName,
    },
    assetManifest: [],
    workerMainModuleName: moduleName,
    workerModules: [
      {
        moduleName,
        partName: 'worker-main',
        hash: hashAsset(bytes, contentType),
        size: bytes.byteLength,
        contentType,
      },
    ],
    controlSignals: [],
  };
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
  form.set('worker-main', new Blob([workerContent], { type: contentType }), moduleName);

  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: 'Bearer cli-token',
      'CF-Connecting-IP': '10.1.2.3',
      ...headers,
    },
    body: form,
  });
}

function hashAsset(bytes, contentType) {
  return createHash('sha256')
    .update('xd-pages-asset-v2\0')
    .update(contentType)
    .update('\0')
    .update(bytes)
    .digest('hex')
    .slice(0, 32);
}

function hashUploadPlan(files, decision) {
  const hash = createHash('sha256');
  hash.update('xd-pages-upload-plan-v1\0');
  hash.update(JSON.stringify(publishPlanFromDecision(decision)));
  hash.update('\0');
  for (const file of files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update('file\0');
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(String(file.bytes.byteLength));
    hash.update('\0');
    hash.update(file.contentType);
    hash.update('\0');
    hash.update(file.bytes);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function publishPlanFromDecision(decision) {
  return {
    deploymentShape: decision.deploymentShape,
    requestedFallback: decision.requestedFallback,
    resolvedFallback: decision.resolvedFallback,
    routingMode: decision.routingMode,
    workerEntry: decision.workerEntry,
    workerMainModuleName: decision.workerEntry,
    assetsConfig: null,
  };
}

class MemoryRouteSnapshots {
  constructor() {
    this.values = new Map();
  }

  async put(key, value) {
    this.values.set(key, value);
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }
}

class MemoryKv {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async put(key, value) {
    this.values.set(key, value);
  }

  async delete(key) {
    this.values.delete(key);
  }
}
