import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';

import worker from './index.js';
import { createAccessKeyPlaintext, hashAccessKey } from './crypto.js';
import { createTestPagesStore } from './test-store.js';

test('creates deployment, immutable version, active route, and route snapshot', async () => {
  const store = await createSeededStore();
  await store.replaceSiteAclEntries(
    'site_1',
    [{ id: 'acl_1', subjectType: 'department', subjectValue: 'dept_design', accessRole: 'viewer', effect: 'allow' }],
    { createdBy: 'usr_1', updatedAt: '2026-06-15T00:00:00.000Z' },
    'production'
  );
  const snapshots = createSnapshotStore();

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        ...deployPayload(),
        source: 'cli',
      },
      { 'Idempotency-Key': 'idem_1' }
    ),
    testEnv(store, snapshots)
  );

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.deployment.id, 'dep_1');
  assert.equal(body.deployment.status, 'succeeded');
  assert.equal(body.deployment.versionId, 'ver_1');
  assertNoPublicExecutionDetails(body);
  assert.equal(body.route.routeGeneration, 1);
  assert.match((await store.getSiteVersion('ver_1')).contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal((await store.getSiteVersion('ver_1')).artifactRef, 'wfp://test/pages-v2-docs-ver-1');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_1');
  const pointer = snapshots.read('production:route_pointer:docs.pages.xd.team');
  assert.equal(pointer.routeGeneration, 1);
  assert.deepEqual(snapshots.read(pointer.snapshotKey).acl, [
    { effect: 'allow', subjectType: 'department', subjectValue: 'dept_design' },
  ]);
});

test('uploads and verifies WFP worker before route activation', async () => {
  const store = await createSeededStore();
  const events = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => {
        events.push(['upload', workerName, (await store.getRouteBySiteId('site_1')).activeVersionId]);
        return { artifactRef: `wfp://test/${workerName}` };
      },
      verify: async ({ workerName }) => {
        events.push(['verify', workerName, (await store.getRouteBySiteId('site_1')).activeVersionId]);
        return { ok: true };
      },
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        contentHash: 'sha256:abc',
        artifactBundle: workerBundle('export default {};'),
      },
      { 'Idempotency-Key': 'wfp_order' }
    ),
    env
  );

  assert.equal(response.status, 201);
  assert.deepEqual(events, [
    ['upload', 'pages-v2-docs-ver-1', null],
    ['verify', 'pages-v2-docs-ver-1', null],
  ]);
  assert.equal((await store.getDeployment('dep_1')).status, 'succeeded');
});

test('creates static deployment from multipart asset artifact without worker bundle', async () => {
  const store = await createSeededStore();
  const uploads = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async (input) => {
        uploads.push({
          assetManifest: input.assetManifest,
          assetFiles: input.assetFiles.map((file) => ({
            path: file.path,
            contentType: file.contentType,
            size: file.bytes.byteLength,
          })),
          artifactBundle: input.artifactBundle,
        });
        return { artifactRef: `assets://test/${input.workerName}` };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        contentHash: 'sha256:asset',
        assetManifest: {
          '/index.html': {
            hash: 'hash_index',
            size: '<h1>Hello</h1>'.length,
            content_type: 'text/html; charset=utf-8',
          },
        },
        files: [{ field: 'file-0', filename: 'index.html', content: '<h1>Hello</h1>', type: 'text/html' }],
      },
      { 'Idempotency-Key': 'asset_deploy' }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(uploads, [
    {
      assetManifest: {
        '/index.html': {
          hash: hashAsset(Buffer.from('<h1>Hello</h1>'), 'text/html'),
          size: '<h1>Hello</h1>'.length,
          content_type: 'text/html',
        },
      },
      assetFiles: [{ path: '/index.html', contentType: 'text/html', size: '<h1>Hello</h1>'.length }],
      artifactBundle: undefined,
    },
  ]);
  assert.equal((await store.getSiteVersion('ver_1')).artifactRef, 'assets://test/pages-v2-docs-ver-1');
});

test('accepts v2 publishPlan multipart metadata and passes resolved decision to provider', async () => {
  const store = await createSeededStore();
  const uploads = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async (input) => {
        uploads.push({
          decision: input.decision,
          assetManifest: input.assetManifest,
          assetFiles: input.assetFiles.map((file) => ({
            path: file.path,
            contentType: file.contentType,
            size: file.bytes.byteLength,
          })),
          artifactBundle: input.artifactBundle,
        });
        return { artifactRef: `assets://test/${input.workerName}` };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const response = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'auto',
        source: 'cli',
        publishPlan: {
          deploymentShape: 'assets-only',
          requestedFallback: 'auto',
          resolvedFallback: 'index',
          routingMode: 'assets-only',
          workerEntry: null,
          assetsConfig: { notFoundHandling: 'single-page-application' },
        },
        assetManifest: [
          {
            path: '/index.html',
            partName: 'asset-file-0',
            size: 5,
            contentType: 'text/html; charset=utf-8',
          },
        ],
        files: [{ field: 'asset-file-0', filename: 'index.html', content: 'hello', type: 'text/html; charset=utf-8' }],
      },
      { 'Idempotency-Key': 'publish_plan_ok' }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(uploads, [
    {
      decision: {
        deploymentShape: 'assets-only',
        requestedFallback: 'auto',
        resolvedFallback: 'index',
        routingMode: 'assets-only',
        workerEntry: null,
        assetsConfig: { notFoundHandling: 'single-page-application' },
      },
      assetManifest: {
        '/index.html': {
          hash: hashAsset(Buffer.from('hello'), 'text/html; charset=utf-8'),
          size: 5,
          content_type: 'text/html; charset=utf-8',
        },
      },
      assetFiles: [{ path: '/index.html', contentType: 'text/html; charset=utf-8', size: 5 }],
      artifactBundle: undefined,
    },
  ]);
  const body = await response.json();
  assert.equal(body.decision.deploymentShape, 'assets-only');
  assert.equal(body.decision.resolvedFallback, 'index');
  assert.deepEqual(body.version.decision, {
    deploymentShape: 'assets-only',
    requestedFallback: 'auto',
    resolvedFallback: 'index',
    routingMode: 'assets-only',
  });
  assertNoPublicExecutionDetails(body);
});

test('accepts v2 worker-with-assets publishPlan and builds Worker bundle plus assets', async () => {
  const store = await createSeededStore();
  const uploads = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async (input) => {
        uploads.push({
          decision: input.decision,
          mainModule: input.artifactBundle?.mainModule,
          modules: input.artifactBundle?.modules.map((module) => module.name),
          assetPaths: Object.keys(input.assetManifest || {}),
        });
        return { artifactRef: `worker-assets://test/${input.workerName}` };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const response = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteSlug: 'docs',
        requestedFallback: 'auto',
        source: 'cli',
        publishPlan: {
          deploymentShape: 'worker-with-assets',
          requestedFallback: 'auto',
          resolvedFallback: 'not-found',
          routingMode: 'worker-first',
          workerEntry: '_worker.js',
          workerMainModuleName: '_worker.js',
          assetsConfig: { notFoundHandling: '404-page' },
        },
        assetManifest: [
          {
            path: '/index.html',
            partName: 'asset-file-0',
            size: 5,
            contentType: 'text/html; charset=utf-8',
          },
        ],
        workerModules: [
          {
            moduleName: '_worker.js',
            partName: 'worker-main',
            size: 18,
            contentType: 'application/javascript+module',
          },
        ],
        files: [{ field: 'asset-file-0', filename: 'index.html', content: 'hello', type: 'text/html; charset=utf-8' }],
        worker: {
          field: 'worker-main',
          filename: '_worker.js',
          content: 'export default {};',
          type: 'application/javascript+module',
        },
      },
      { 'Idempotency-Key': 'publish_plan_worker_assets' }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(uploads, [
    {
      decision: {
        deploymentShape: 'worker-with-assets',
        requestedFallback: 'auto',
        resolvedFallback: 'not-found',
        routingMode: 'worker-first',
        workerEntry: '_worker.js',
        assetsConfig: { notFoundHandling: '404-page' },
      },
      mainModule: '_worker.js',
      modules: ['_worker.js'],
      assetPaths: ['/index.html'],
    },
  ]);
});

test('rejects v2 publishPlan with duplicate part names or undeclared uploads', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());

  const duplicate = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'auto',
        contentHash: 'sha256:asset',
        publishPlan: {
          deploymentShape: 'assets-only',
          requestedFallback: 'auto',
          resolvedFallback: 'index',
          routingMode: 'assets-only',
          workerEntry: null,
          assetsConfig: { notFoundHandling: 'single-page-application' },
        },
        assetManifest: [
          {
            path: '/index.html',
            partName: 'asset-file-0',
            hash: 'hash_index',
            size: 5,
            contentType: 'text/html; charset=utf-8',
          },
          { path: '/app.js', partName: 'asset-file-0', hash: 'hash_app', size: 5, contentType: 'text/javascript' },
        ],
        files: [{ field: 'asset-file-0', filename: 'index.html', content: 'hello', type: 'text/html; charset=utf-8' }],
      },
      { 'Idempotency-Key': 'publish_plan_duplicate' }
    ),
    env
  );
  const undeclared = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'auto',
        contentHash: 'sha256:asset',
        publishPlan: {
          deploymentShape: 'assets-only',
          requestedFallback: 'auto',
          resolvedFallback: 'index',
          routingMode: 'assets-only',
          workerEntry: null,
          assetsConfig: { notFoundHandling: 'single-page-application' },
        },
        assetManifest: [
          {
            path: '/index.html',
            partName: 'asset-file-0',
            hash: 'hash_index',
            size: 5,
            contentType: 'text/html; charset=utf-8',
          },
        ],
        files: [
          { field: 'asset-file-0', filename: 'index.html', content: 'hello', type: 'text/html; charset=utf-8' },
          { field: 'asset-file-1', filename: 'app.js', content: 'hello', type: 'text/javascript' },
        ],
      },
      { 'Idempotency-Key': 'publish_plan_undeclared' }
    ),
    env
  );

  assert.equal(duplicate.status, 400);
  assert.equal((await duplicate.json()).error.code, 'PUBLISH_PLAN_INVALID');
  assert.equal(undeclared.status, 400);
  assert.equal((await undeclared.json()).error.code, 'PUBLISH_PLAN_INVALID');
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('rejects v2 publishPlan asset paths that match the upload denylist', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'auto',
        publishPlan: {
          deploymentShape: 'assets-only',
          requestedFallback: 'auto',
          resolvedFallback: 'not-found',
          routingMode: 'assets-only',
          workerEntry: null,
          assetsConfig: { notFoundHandling: '404-page' },
        },
        assetManifest: [
          {
            path: '/.env',
            partName: 'asset-file-0',
            size: 'SECRET=bad'.length,
            contentType: 'text/plain',
          },
        ],
        files: [{ field: 'asset-file-0', filename: '.env', content: 'SECRET=bad', type: 'text/plain' }],
      },
      { 'Idempotency-Key': 'publish_plan_denylist' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'ASSET_MANIFEST_INVALID');
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('rejects explicit fallback for worker-only publishPlan', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'index',
        contentHash: 'sha256:worker',
        publishPlan: {
          deploymentShape: 'worker-only',
          requestedFallback: 'index',
          resolvedFallback: null,
          routingMode: 'worker-only',
          workerEntry: 'worker.mjs',
          workerMainModuleName: 'worker.mjs',
        },
        workerModules: [
          {
            moduleName: 'worker.mjs',
            partName: 'worker-main',
            hash: 'hash_worker',
            size: 18,
            contentType: 'application/javascript+module',
          },
        ],
        worker: {
          field: 'worker-main',
          filename: 'worker.mjs',
          content: 'export default {};',
          type: 'application/javascript+module',
        },
      },
      { 'Idempotency-Key': 'fallback_worker_only' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'FALLBACK_REQUIRES_ASSETS');
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('rejects index fallback publishPlan when index.html is not uploaded', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'index',
        publishPlan: {
          deploymentShape: 'assets-only',
          requestedFallback: 'index',
          resolvedFallback: 'index',
          routingMode: 'assets-only',
          workerEntry: null,
          assetsConfig: { notFoundHandling: 'single-page-application' },
        },
        assetManifest: [
          {
            path: '/app.js',
            partName: 'asset-file-0',
            size: 5,
            contentType: 'text/javascript; charset=utf-8',
          },
        ],
        files: [{ field: 'asset-file-0', filename: 'app.js', content: 'hello', type: 'text/javascript; charset=utf-8' }],
      },
      { 'Idempotency-Key': 'fallback_index_missing_index' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'FALLBACK_INDEX_REQUIRES_INDEX_HTML');
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('rejects v2 publishPlan when content hash does not match uploaded bytes', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ expectedContentHash: `sha256:${'0'.repeat(64)}` }),
      { 'Idempotency-Key': 'content_hash_mismatch' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'CONTENT_HASH_MISMATCH');
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('rejects multipart asset artifacts with unsafe or incomplete file manifests', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());

  const traversal = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'not-found',
        contentHash: 'sha256:asset',
        assetManifest: {
          '/../secret.txt': { hash: 'hash_secret', size: 5, content_type: 'text/plain' },
        },
        files: [{ field: 'file-0', filename: '../secret.txt', content: 'hello', type: 'text/plain' }],
      },
      { 'Idempotency-Key': 'asset_traversal' }
    ),
    env
  );
  const missing = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'not-found',
        publishPlan: {
          deploymentShape: 'assets-only',
          requestedFallback: 'not-found',
          resolvedFallback: 'not-found',
          routingMode: 'assets-only',
          workerEntry: null,
          assetsConfig: { notFoundHandling: '404-page' },
        },
        assetManifest: [
          {
            path: '/index.html',
            partName: 'asset-file-0',
            size: 5,
            contentType: 'text/html; charset=utf-8',
          },
        ],
        files: [],
      },
      { 'Idempotency-Key': 'asset_missing' }
    ),
    env
  );

  assert.equal(traversal.status, 400);
  assert.equal((await traversal.json()).error.code, 'ASSET_MANIFEST_INVALID');
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'ASSET_FILES_REQUIRED');
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('deployments can target an existing site by user-visible slug', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'Docs' }),
      { 'Idempotency-Key': 'slug_deploy' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json();
  assert.equal(body.deployment.siteId, 'site_1');
  assert.equal(body.route.hostname, 'docs.pages.xd.team');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_1');
});

test('access keys can deploy by slug only when the resolved site matches their scope', async () => {
  const store = await createSeededStore();
  await store.createSite({
    id: 'site_2',
    slug: 'other',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_2',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_2',
    hostname: 'other.pages.xd.team',
  });
  const matchingKey = await seedAccessKey(store, 'ak_deploy', ['deploy:site'], 'site_1');
  const otherSiteKey = await seedAccessKey(store, 'ak_other', ['deploy:site'], 'site_2');
  const env = testEnv(store, createSnapshotStore());

  const allowed = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload({ siteId: undefined, siteSlug: 'docs' }), {
      Authorization: `Bearer ${matchingKey}`,
      'Idempotency-Key': 'slug_access_key_ok',
    }),
    env
  );
  const denied = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload({ siteId: undefined, siteSlug: 'docs' }), {
      Authorization: `Bearer ${otherSiteKey}`,
      'Idempotency-Key': 'slug_access_key_denied',
    }),
    env
  );

  assert.equal(allowed.status, 201, await allowed.clone().text());
  assert.equal((await allowed.json()).deployment.siteId, 'site_1');
  assert.equal(denied.status, 404);
  const deniedBody = await denied.json();
  assert.equal(deniedBody.error.code, 'SITE_NOT_FOUND');
  assert.equal(deniedBody.error.action, 'Check the site slug and access key scope.');
});

test('uses bounded WFP worker names for valid long slugs', async () => {
  const store = createTestPagesStore({
    now: () => '2026-06-15T00:00:00.000Z',
  });
  await store.createUser({
    userId: 'usr_1',
    email: 'user@example.com',
    realname: 'User One',
    employeeStatus: 'active',
  });
  await store.createSite({
    id: 'site_long',
    slug: 'very-long-pages-site-slug-that-is-still-valid',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_long',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_long',
    hostname: 'very-long-pages-site-slug-that-is-still-valid.pages.xd.team',
  });
  const uploadedWorkerNames = [];
  const env = testEnv(store, createSnapshotStore(), {
    nextId: (prefix) => {
      if (prefix === 'dep') return 'dep_1234567890abcdef1234567890abcdef';
      if (prefix === 'ver') return 'ver_1234567890abcdef1234567890abcdef';
      return `${prefix}_1`;
    },
    WFP_PROVIDER: {
      upload: async ({ workerName }) => {
        uploadedWorkerNames.push(workerName);
        return { artifactRef: `wfp://test/${workerName}` };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: 'site_long' }),
      { 'Idempotency-Key': 'long_slug' }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(uploadedWorkerNames.length, 1);
  assert.equal(uploadedWorkerNames[0].length <= 63, true);
  assert.match(uploadedWorkerNames[0], /^[a-z0-9][a-z0-9-]{0,62}$/);
});

test('WFP upload metadata binds Pages KV gateway to user workers', async () => {
  const store = await createSeededStore();
  const requests = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: undefined,
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'cf_secret_token',
    WFP_DISPATCH_NAMESPACE: 'pages-production',
    fetch: async (request) => {
      requests.push(request);
      return Response.json({ success: true, result: { id: 'ok' } });
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'wfp_binding',
    }),
    env
  );

  assert.equal(response.status, 201);
  const uploadRequest = requests.find((request) => request.method === 'PUT');
  const metadata = JSON.parse(await (await uploadRequest.formData()).get('metadata').text());
  assert.deepEqual(metadata.bindings, [
    { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' },
  ]);
});

test('WFP static asset deployment uses Cloudflare assets upload session and ASSETS binding', async () => {
  const store = await createSeededStore();
  const requests = [];
  const assetHash = hashAsset(Buffer.from('hello'), 'text/html');
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: undefined,
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'cf_secret_token',
    WFP_DISPATCH_NAMESPACE: 'pages-production',
    fetch: async (request) => {
      requests.push(request.clone());
      if (request.url.includes('/assets-upload-session')) {
        return Response.json({ success: true, result: { jwt: 'upload-jwt', buckets: [[assetHash]] } });
      }
      if (request.url.includes('/workers/assets/upload')) {
        return Response.json({ success: true, result: { jwt: 'completion-jwt' } });
      }
      return Response.json({ success: true, result: { id: 'ok' } });
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        contentHash: 'sha256:asset',
        assetManifest: {
          '/index.html': { hash: 'hash_index', size: 5, content_type: 'text/html; charset=utf-8' },
        },
        files: [{ field: 'file-0', filename: 'index.html', content: 'hello', type: 'text/html' }],
      },
      { 'Idempotency-Key': 'wfp_assets' }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.ok(
    requests.some((request) =>
      request.url.includes('/workers/dispatch/namespaces/pages-production/scripts/pages-v2-docs-ver-1/assets-upload-session')
    )
  );
  assert.ok(requests.some((request) => request.url.includes('/workers/assets/upload?base64=true')));
  const assetUpload = requests.find((request) => request.url.includes('/workers/assets/upload?base64=true'));
  const assetUploadForm = await assetUpload.formData();
  assert.equal(assetUploadForm.get(assetHash).type, 'text/html');
  assert.equal(await assetUploadForm.get(assetHash).text(), 'aGVsbG8=');
  const uploadRequest = requests.find((request) => request.method === 'PUT');
  const metadata = JSON.parse(await (await uploadRequest.formData()).get('metadata').text());
  assert.deepEqual(metadata.bindings, [
    { type: 'assets', name: 'ASSETS' },
    { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' },
  ]);
  assert.deepEqual(metadata.assets, {
    jwt: 'completion-jwt',
    config: { not_found_handling: 'single-page-application' },
  });
});

test('deploys through normal worker slot mode without exposing provider to the request', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  const snapshots = createSnapshotStore();
  const events = [];
  const env = testEnv(store, snapshots, {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    NORMAL_WORKER_SLOT_PROVIDER: {
      upload: async ({ workerName, slot }) => {
        events.push(['upload', workerName, slot.id, (await store.getRouteBySiteId('site_1')).activeVersionId]);
      },
      verify: async ({ workerName, slot }) => {
        events.push(['verify', workerName, slot.id, (await store.getRouteBySiteId('site_1')).activeVersionId]);
      },
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        ...deployPayload(),
        executionProvider: 'wfp',
      },
      { 'Idempotency-Key': 'slot_deploy' }
    ),
    env
  );

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.version.runtime, 'worker');
  assertNoPublicExecutionDetails(body);
  assert.equal((await store.getSiteVersion('ver_1')).executionProvider, 'normal-worker-slot');
  assert.equal((await store.getRouteBySiteId('site_1')).dispatchBindingName, 'SITE_SLOT_007');
  assert.equal((await store.getWorkerSlot('slot_007')).status, 'assigned');
  assert.equal((await store.getWorkerSlot('slot_007')).assignedVersionId, 'ver_1');
  const pointer = snapshots.read('production:route_pointer:docs.pages.xd.team');
  assert.deepEqual(snapshots.read(pointer.snapshotKey).dispatch, {
    type: 'service-binding',
    slotId: 'slot_007',
    bindingName: 'SITE_SLOT_007',
  });
  assert.deepEqual(events, [
    ['upload', 'pages-v2-production-slot-007', 'slot_007', null],
    ['verify', 'pages-v2-production-slot-007', 'slot_007', null],
  ]);
});

test('releases previous normal worker slot after replacement deploy succeeds', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  await store.createWorkerSlot({
    id: 'slot_008',
    environment: 'production',
    slotNumber: 8,
    workerName: 'pages-v2-production-slot-008',
    bindingName: 'SITE_SLOT_008',
    status: 'available',
  });
  const events = [];
  const env = testEnv(store, createSnapshotStore(), {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    NORMAL_WORKER_SLOT_PROVIDER: {
      upload: async () => null,
      verify: async () => ({ ok: true }),
      cleanupRetainedSlot: async ({ slot }) => {
        events.push(['cleanup', slot.id, slot.assignedVersionId]);
      },
    },
  });

  await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'slot_first' }),
    env
  );
  const replacement = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("def"); } };' }),
      { 'Idempotency-Key': 'slot_second' }
    ),
    env
  );
  const rollback = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback', {}, { 'Idempotency-Key': 'rb_retired_slot' }),
    env
  );

  assert.equal(replacement.status, 201);
  assert.equal((await store.getWorkerSlot('slot_007')).status, 'available');
  assert.equal((await store.getWorkerSlot('slot_007')).assignedVersionId, null);
  assert.equal((await store.getWorkerSlot('slot_007')).lastDeployedVersionId, 'ver_1');
  assert.equal((await store.getWorkerSlot('slot_008')).status, 'assigned');
  assert.equal((await store.getWorkerSlot('slot_008')).assignedVersionId, 'ver_2');
  assert.equal(rollback.status, 409);
  assert.equal((await rollback.json()).error.code, 'ROLLBACK_VERSION_UNAVAILABLE');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_2');
  assert.deepEqual(events, [['cleanup', 'slot_007', 'ver_1']]);
});

test('keeps replacement deployment succeeded when previous slot cleanup fails closed', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  await store.createWorkerSlot({
    id: 'slot_008',
    environment: 'production',
    slotNumber: 8,
    workerName: 'pages-v2-production-slot-008',
    bindingName: 'SITE_SLOT_008',
    status: 'available',
  });
  const env = testEnv(store, createSnapshotStore(), {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    NORMAL_WORKER_SLOT_PROVIDER: {
      upload: async () => null,
      verify: async () => ({ ok: true }),
      cleanupRetainedSlot: async () => {
        throw new Error('cleanup failed');
      },
    },
  });

  await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'slot_first' }),
    env
  );
  const replacement = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("def"); } };' }),
      { 'Idempotency-Key': 'slot_second' }
    ),
    env
  );

  assert.equal(replacement.status, 201);
  assert.equal((await store.getDeployment('dep_2')).status, 'succeeded');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_2');
  assert.equal((await store.getWorkerSlot('slot_007')).status, 'cleanup_pending');
  assert.equal((await store.getWorkerSlot('slot_007')).assignedVersionId, 'ver_1');
});

test('normal worker slot upload metadata binds Pages KV gateway to slot workers', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  const requests = [];
  const env = testEnv(store, createSnapshotStore(), {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'cf_secret_token',
    fetch: async (request) => {
      requests.push(request);
      return Response.json({ success: true, result: { id: 'ok' } });
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'slot_binding',
    }),
    env
  );

  assert.equal(response.status, 201);
  const uploadRequestIndex = requests.findIndex((request) => request.method === 'PUT');
  const uploadRequest = requests[uploadRequestIndex];
  assert.match(uploadRequest.url, /\/workers\/scripts\/pages-v2-production-slot-007$/);
  const metadata = JSON.parse(await (await uploadRequest.formData()).get('metadata').text());
  assert.deepEqual(metadata.bindings, [
    { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' },
  ]);
  const disableSubdomainRequestIndexes = requests
    .map((request, index) => ({ request, index }))
    .filter(({ request }) =>
      request.url.endsWith('/workers/services/pages-v2-production-slot-007/environments/production/subdomain')
    )
    .map(({ index }) => index);
  assert.deepEqual(
    disableSubdomainRequestIndexes.map((index) => requests[index].method),
    ['POST', 'POST']
  );
  assert.ok(disableSubdomainRequestIndexes[0] < uploadRequestIndex, 'workers.dev subdomain is disabled before slot upload');
  assert.ok(disableSubdomainRequestIndexes[1] > uploadRequestIndex, 'workers.dev subdomain is disabled after slot upload');
  assert.deepEqual(await requests[disableSubdomainRequestIndexes[1]].json(), { enabled: false });
});

test('normal worker slot static asset deployment uses Cloudflare assets upload session and ASSETS binding', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  const requests = [];
  const assetHash = hashAsset(Buffer.from('hello'), 'text/html');
  const env = testEnv(store, createSnapshotStore(), {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'cf_secret_token',
    fetch: async (request) => {
      requests.push(request.clone());
      if (request.method === 'GET' && request.url.endsWith('/workers/scripts/pages-v2-production-slot-007')) {
        return multipartWorkerScriptResponse();
      }
      if (request.url.includes('/assets-upload-session')) {
        return Response.json({ success: true, result: { jwt: 'upload-jwt', buckets: [[assetHash]] } });
      }
      if (request.url.includes('/workers/assets/upload')) {
        return Response.json({ success: true, result: { jwt: 'completion-jwt' } });
      }
      return Response.json({ success: true, result: { id: 'ok' } });
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'not-found',
        contentHash: 'sha256:asset',
        assetManifest: {
          '/index.html': { hash: 'hash_index', size: 5, content_type: 'text/html; charset=utf-8' },
        },
        files: [{ field: 'file-0', filename: 'index.html', content: 'hello', type: 'text/html' }],
      },
      { 'Idempotency-Key': 'slot_assets' }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.ok(
    requests.some((request) => request.url.includes('/workers/scripts/pages-v2-production-slot-007/assets-upload-session'))
  );
  assert.ok(requests.some((request) => request.url.includes('/workers/assets/upload?base64=true')));
  const assetUpload = requests.find((request) => request.url.includes('/workers/assets/upload?base64=true'));
  const assetUploadForm = await assetUpload.formData();
  assert.equal(assetUploadForm.get(assetHash).type, 'text/html');
  assert.equal(await assetUploadForm.get(assetHash).text(), 'aGVsbG8=');
  const uploadRequest = requests.find((request) => request.method === 'PUT');
  const metadata = JSON.parse(await (await uploadRequest.formData()).get('metadata').text());
  assert.deepEqual(metadata.bindings, [
    { type: 'assets', name: 'ASSETS' },
    { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' },
  ]);
  assert.deepEqual(metadata.assets, {
    jwt: 'completion-jwt',
    config: { not_found_handling: '404-page' },
  });
});

test('normal worker slot worker-with-assets deployment keeps user worker and runs it before assets', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  const requests = [];
  const env = testEnv(store, createSnapshotStore(), {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'cf_secret_token',
    fetch: async (request) => {
      requests.push(request.clone());
      if (request.method === 'GET' && request.url.endsWith('/workers/scripts/pages-v2-production-slot-007')) {
        return multipartWorkerScriptResponse();
      }
      if (request.url.includes('/assets-upload-session')) {
        return Response.json({ success: true, result: { jwt: 'upload-jwt', buckets: [['hash_index']] } });
      }
      if (request.url.includes('/workers/assets/upload')) {
        return Response.json({ success: true, result: { jwt: 'completion-jwt' } });
      }
      return Response.json({ success: true, result: { id: 'ok' } });
    },
  });

  const response = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'auto',
        publishPlan: {
          deploymentShape: 'worker-with-assets',
          requestedFallback: 'auto',
          resolvedFallback: 'not-found',
          routingMode: 'worker-first',
          workerEntry: '_worker.js',
          workerMainModuleName: '_worker.js',
          assetsConfig: { notFoundHandling: '404-page' },
        },
        assetManifest: [
          {
            path: '/index.html',
            partName: 'asset-file-0',
            size: 5,
            contentType: 'text/html; charset=utf-8',
          },
        ],
        workerModules: [
          {
            moduleName: '_worker.js',
            partName: 'worker-main',
            size: 18,
            contentType: 'application/javascript+module',
          },
        ],
        files: [{ field: 'asset-file-0', filename: 'index.html', content: 'hello', type: 'text/html; charset=utf-8' }],
        worker: {
          field: 'worker-main',
          filename: '_worker.js',
          content: 'export default {};',
          type: 'application/javascript+module',
        },
      },
      { 'Idempotency-Key': 'slot_worker_assets' }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  const uploadRequest = requests.find((request) => request.method === 'PUT');
  const uploadForm = await uploadRequest.formData();
  const metadata = JSON.parse(await uploadForm.get('metadata').text());
  assert.equal(metadata.main_module, '_worker.js');
  assert.equal(await uploadForm.get('_worker.js').text(), 'export default {};');
  assert.deepEqual(metadata.assets, {
    jwt: 'completion-jwt',
    config: { not_found_handling: '404-page', run_worker_first: true },
  });
});

test('fails closed and disables a slot when workers.dev cannot be disabled', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  const requests = [];
  const env = testEnv(store, createSnapshotStore(), {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'cf_secret_token',
    fetch: async (request) => {
      requests.push(request);
      if (request.url.endsWith('/workers/services/pages-v2-production-slot-007/environments/production/subdomain')) {
        return Response.json({ success: false, errors: [{ code: 'subdomain_disable_failed' }] }, { status: 500 });
      }
      return Response.json({ success: true, result: { id: 'ok' } });
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'slot_subdomain_failed',
    }),
    env
  );

  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'DEPLOYMENT_UPLOAD_FAILED');
  assert.equal(requests.some((request) => request.method === 'PUT'), false);
  assert.equal((await store.getWorkerSlot('slot_007')).status, 'disabled');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);
});

test('deletes uploaded slot worker when post-upload workers.dev disable fails', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  let subdomainCalls = 0;
  const requests = [];
  const env = testEnv(store, createSnapshotStore(), {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'cf_secret_token',
    fetch: async (request) => {
      requests.push(request.clone());
      if (request.url.endsWith('/workers/services/pages-v2-production-slot-007/environments/production/subdomain')) {
        subdomainCalls += 1;
        if (subdomainCalls === 2) {
          return Response.json({ success: false, errors: [{ code: 'subdomain_disable_failed' }] }, { status: 500 });
        }
      }
      return Response.json({ success: true, result: { id: 'ok' } });
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'slot_subdomain_failed_after_upload',
    }),
    env
  );

  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'DEPLOYMENT_UPLOAD_FAILED');
  assert.ok(requests.some((request) => request.method === 'PUT'), 'slot Worker was uploaded before failure');
  assert.ok(
    requests.some(
      (request) =>
        request.method === 'DELETE' && request.url.endsWith('/workers/scripts/pages-v2-production-slot-007')
    ),
    'uploaded slot Worker should be deleted when workers.dev cannot be confirmed disabled'
  );
  assert.equal((await store.getWorkerSlot('slot_007')).status, 'disabled');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);
});

test('fails normal worker slot deployment when no slot is available', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'slot_full' }),
    testEnv(store, createSnapshotStore(), { PAGES_EXECUTION_MODE: 'normal-worker-slot' })
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'DEPLOYMENT_CAPACITY_EXHAUSTED');
  assert.equal(await store.getSiteVersion('ver_1'), null);
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);
});

test('notifies Slack with an actions URL button when normal worker slot capacity is exhausted', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_001',
    environment: 'production',
    slotNumber: 1,
    workerName: 'pages-v2-production-slot-001',
    bindingName: 'SITE_SLOT_001',
    status: 'assigned',
  });
  await store.createWorkerSlot({
    id: 'slot_002',
    environment: 'production',
    slotNumber: 2,
    workerName: 'pages-v2-production-slot-002',
    bindingName: 'SITE_SLOT_002',
    status: 'assigned',
  });
  const slackRequests = [];
  const webhookUrl = testSlackWebhookUrl();
  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'slot_notify' }),
    testEnv(store, createSnapshotStore(), {
      PAGES_EXECUTION_MODE: 'normal-worker-slot',
      PAGES_NORMAL_WORKER_SLOT_EXPAND_BY: '2',
      SLACK_PAGES_ALERT_MENTION_USER_ID: 'UTESTMEMBER',
      SLACK_PAGES_ALERT_WEBHOOK_URL: webhookUrl,
      fetch: async (request) => {
        slackRequests.push(request);
        return new Response('ok');
      },
    })
  );

  assert.equal(response.status, 503);
  assert.equal(slackRequests.length, 1);
  assert.equal(slackRequests[0].method, 'POST');
  assert.equal(slackRequests[0].url, webhookUrl);
  const payload = await slackRequests[0].json();
  const serialized = JSON.stringify(payload);
  assert.equal(payload.text, '静态页面池容量不足，需要扩容');
  assert.equal((serialized.match(/<@UTESTMEMBER>/g) || []).length, 1);
  assert.deepEqual(payload.blocks[2].fields, [
    { type: 'mrkdwn', text: '*环境*\nproduction' },
    { type: 'mrkdwn', text: '*容量*\n已用 2 / 总计 2' },
    { type: 'mrkdwn', text: '*剩余*\n0' },
    { type: 'mrkdwn', text: '*扩容*\n+2' },
  ]);
  assert.match(serialized, /https:\/\/github\.com\/xindong\/pages-manager\/actions/);
  assert.match(serialized, /button/);
  assert.doesNotMatch(serialized, /Deployment|Site|dep_1|site_1/);
  assert.doesNotMatch(serialized, /cli-token|pepper|cf_secret_token|Authorization|user@example\.com/);
});

test('does not mask capacity response when Slack notification fails', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'slot_notify_fail',
    }),
    testEnv(store, createSnapshotStore(), {
      PAGES_EXECUTION_MODE: 'normal-worker-slot',
      SLACK_PAGES_ALERT_WEBHOOK_URL: testSlackWebhookUrl(),
      fetch: async () => new Response('nope', { status: 500 }),
    })
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'DEPLOYMENT_CAPACITY_EXHAUSTED');
  assert.equal((await store.getDeployment('dep_1')).errorCode, 'DEPLOYMENT_CAPACITY_EXHAUSTED');
});

test('deployment idempotency replays same request and rejects changed request', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots);

  const first = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'idem_1' }),
    env
  );
  const replay = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'idem_1' }),
    env
  );
  const conflict = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("def"); } };' }),
      { 'Idempotency-Key': 'idem_1' }
    ),
    env
  );
  const bundleConflict = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("changed"); } };' }),
      { 'Idempotency-Key': 'idem_1' }
    ),
    env
  );

  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).deployment.id, 'dep_1');
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(bundleConflict.status, 409);
  assert.equal((await bundleConflict.json()).error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(await store.getSiteVersion('ver_2'), null);
});

test('rejects hand-written JSON deployment uploads', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      { siteId: 'site_1', contentHash: 'sha256:abc' },
      { 'Idempotency-Key': 'missing_bundle' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'CLI_UPLOAD_PROTOCOL_REQUIRED');
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('returns payload-too-large for oversized deployment bodies', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'a'.repeat(50 * 1024 * 1024 + 1) }),
      { 'Idempotency-Key': 'too_large' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('gets deployment by id for authorized site actors', async () => {
  const store = await createSeededStore();
  await store.createDeploymentForIdempotency({
    id: 'dep_1',
    environment: 'production',
    actorId: 'usr_1',
    actorUserId: 'usr_1',
    actorType: 'user',
    source: 'cli',
    siteId: 'site_1',
    operation: 'deploy',
    idempotencyKey: 'idem_1',
    requestHash: 'hash_1',
    visibility: 'org',
    status: 'succeeded',
  });

  const response = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/deployments/dep_1'),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).deployment.id, 'dep_1');
});

test('requires read:site scope for access key deployment reads', async () => {
  const store = await createSeededStore();
  await store.createDeploymentForIdempotency({
    id: 'dep_1',
    environment: 'production',
    actorId: 'usr_1',
    actorUserId: 'usr_1',
    actorType: 'user',
    source: 'cli',
    siteId: 'site_1',
    operation: 'deploy',
    idempotencyKey: 'idem_1',
    requestHash: 'hash_1',
    visibility: 'org',
    status: 'succeeded',
  });
  const deployOnlyKey = await seedAccessKey(store, 'ak_deploy', ['deploy:site']);
  const readKey = await seedAccessKey(store, 'ak_read', ['read:site']);

  const denied = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/deployments/dep_1', {
      Authorization: `Bearer ${deployOnlyKey}`,
    }),
    testEnv(store, createSnapshotStore())
  );
  const allowed = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/deployments/dep_1', {
      Authorization: `Bearer ${readKey}`,
    }),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'DEPLOYMENT_READ_FORBIDDEN');
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).deployment.id, 'dep_1');
});

test('enforces deploy and rollback access key scopes separately', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots);
  const deployOnlyKey = await seedAccessKey(store, 'ak_deploy', ['deploy:site']);
  const rollbackOnlyKey = await seedAccessKey(store, 'ak_rollback', ['rollback:site']);

  const deployWithRollbackOnly = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      Authorization: `Bearer ${rollbackOnlyKey}`,
      'Idempotency-Key': 'deploy_rollback_only',
    }),
    env
  );

  await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'deploy_1' }),
    env
  );
  const rollbackWithDeployOnly = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      {
        Authorization: `Bearer ${deployOnlyKey}`,
        'Idempotency-Key': 'rollback_deploy_only',
      }
    ),
    env
  );

  assert.equal(deployWithRollbackOnly.status, 403);
  assert.equal((await deployWithRollbackOnly.json()).error.code, 'DEPLOY_FORBIDDEN');
  assert.equal(rollbackWithDeployOnly.status, 403);
  assert.equal((await rollbackWithDeployOnly.json()).error.code, 'ROLLBACK_FORBIDDEN');
});

test('rolls back to an existing immutable version and writes a new route snapshot', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots);

  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'deploy_1' }),
      env
    )
  );
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ moduleContent: 'export default { fetch() { return new Response("def"); } };' }),
        { 'Idempotency-Key': 'deploy_2' }
      ),
      env
    )
  );

  const rollback = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback', {}, { 'Idempotency-Key': 'rb_1' }),
    env
  );

  assert.equal(rollback.status, 201, await rollback.clone().text());
  const body = await rollback.json();
  assert.equal(body.deployment.operation, 'rollback');
  assert.equal(body.deployment.previousVersionId, 'ver_2');
  assert.equal(body.route.activeVersionId, 'ver_1');
  assert.equal(body.route.routeGeneration, 3);
  const rolledBackVersion = await store.getSiteVersion('ver_1');
  const replacementVersion = await store.getSiteVersion('ver_2');
  assert.match(rolledBackVersion.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(replacementVersion.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(rolledBackVersion.contentHash, replacementVersion.contentHash);
  assert.equal(snapshots.read('production:route_pointer:docs.pages.xd.team').routeGeneration, 3);
});

test('rejects rollback when requested site does not match the version site', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots);
  await store.createSite({
    id: 'site_2',
    slug: 'other',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_2',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_2',
    hostname: 'other.pages.xd.team',
  });
  await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'deploy_1' }),
    env
  );

  const rollback = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      { siteSlug: 'other' },
      { 'Idempotency-Key': 'rb_wrong_site' }
    ),
    env
  );

  assert.equal(rollback.status, 409);
  assert.equal((await rollback.json()).error.code, 'ROLLBACK_SITE_MISMATCH');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_1');
  assert.equal((await store.getRouteBySiteId('site_2')).activeVersionId, null);
});

test('marks deployment failed when route snapshot write fails and replays failed terminal state', async () => {
  const store = await createSeededStore();
  const deletedWorkers = [];
  const env = testEnv(store, failingSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => ({ ok: true }),
      delete: async ({ workerName }) => deletedWorkers.push(workerName),
    },
  });
  const request = () =>
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'snapshot_fail' });

  const first = await worker.fetch(request(), env);
  const replay = await worker.fetch(request(), env);

  assert.equal(first.status, 503);
  const firstBody = await first.json();
  assert.equal(firstBody.error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.equal(firstBody.error.action, 'Retry the deployment with a new Idempotency-Key.');
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.deepEqual(deletedWorkers, ['pages-v2-docs-ver-1']);
  assert.deepEqual(await store.getRouteBySiteId('site_1'), {
    id: 'route_1',
    hostname: 'docs.pages.xd.team',
    siteId: 'site_1',
    environment: 'production',
    runtime: 'disabled',
    executionProvider: null,
    workerName: null,
    dispatchType: null,
    dispatchBindingName: null,
    slotId: null,
    activeVersionId: null,
    visibility: 'org',
    policyVersion: 1,
    routeGeneration: 0,
    routeStatus: 'disabled',
    cacheTier: 'fast',
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.deployment.status, 'failed');
  assert.equal(replayBody.deployment.errorCode, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.equal(replayBody.deployment.errorMessage, 'Route snapshot write failed.');
});

test('marks deployment failed when WFP upload fails without creating active version', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async () => {
        throw new Error('upload failed');
      },
      verify: async () => {
        throw new Error('verify should not run');
      },
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default {};' }),
      { 'Idempotency-Key': 'wfp_upload_fail' }
    ),
    env
  );

  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.code, 'DEPLOYMENT_UPLOAD_FAILED');
  assert.equal(body.error.action, 'Retry the deployment with a new Idempotency-Key.');
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.equal(await store.getSiteVersion('ver_1'), null);
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);
});

test('marks deployment failed when WFP verify fails without creating active version', async () => {
  const store = await createSeededStore();
  const deletedWorkers = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => {
        throw new Error('verify failed');
      },
      delete: async ({ workerName }) => deletedWorkers.push(workerName),
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default {};' }),
      { 'Idempotency-Key': 'wfp_verify_fail' }
    ),
    env
  );

  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.code, 'DEPLOYMENT_VERIFY_FAILED');
  assert.equal(body.error.action, 'Retry the deployment with a new Idempotency-Key.');
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.equal(await store.getSiteVersion('ver_1'), null);
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);
  assert.deepEqual(deletedWorkers, ['pages-v2-docs-ver-1']);
});

test('cleans uploaded workers and marks deployments failed when post-upload persistence fails', async () => {
  const store = await createSeededStore();
  store.createSiteVersion = async () => {
    throw new Error('D1 unavailable');
  };
  const deletedWorkers = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => ({ ok: true }),
      delete: async ({ workerName }) => deletedWorkers.push(workerName),
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'persist_fail',
    }),
    env
  );

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, 'DEPLOYMENT_STATE_WRITE_FAILED');
  assert.equal(body.error.action, 'Retry the deployment with a new Idempotency-Key.');
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.equal((await store.getDeployment('dep_1')).errorCode, 'DEPLOYMENT_STATE_WRITE_FAILED');
  assert.equal(await store.getSiteVersion('ver_1'), null);
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);
  assert.deepEqual(deletedWorkers, ['pages-v2-docs-ver-1']);
});

test('marks deployment failed when pre-upload status write fails without uploading', async () => {
  const store = await createSeededStore();
  const originalUpdateDeployment = store.updateDeployment.bind(store);
  let failNextUploadingWrite = true;
  store.updateDeployment = async (id, patch) => {
    if (patch.status === 'uploading' && failNextUploadingWrite) {
      failNextUploadingWrite = false;
      throw new Error('D1 unavailable');
    }
    return originalUpdateDeployment(id, patch);
  };
  const uploadedWorkers = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => {
        uploadedWorkers.push(workerName);
        return { artifactRef: `wfp://test/${workerName}` };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'pre_upload_state_fail',
    }),
    env
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'DEPLOYMENT_STATE_WRITE_FAILED');
  assert.deepEqual(uploadedWorkers, []);
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.equal((await store.getDeployment('dep_1')).errorCode, 'DEPLOYMENT_STATE_WRITE_FAILED');
  assert.equal(await store.getSiteVersion('ver_1'), null);
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);
});

test('reconciles deployment success when final status write fails after route commit', async () => {
  const store = await createSeededStore();
  const originalUpdateDeployment = store.updateDeployment.bind(store);
  let failNextSucceededWrite = true;
  store.updateDeployment = async (id, patch) => {
    if (patch.status === 'succeeded' && failNextSucceededWrite) {
      failNextSucceededWrite = false;
      throw new Error('D1 unavailable');
    }
    return originalUpdateDeployment(id, patch);
  };
  const env = testEnv(store, createSnapshotStore());
  const request = deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
    'Idempotency-Key': 'final_state_fail',
  });

  const response = await worker.fetch(request, env);
  const body = await response.json();
  const statusBeforePoll = await store.getDeployment('dep_1');
  const polled = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/deployments/dep_1'), env);
  const pollBody = await polled.json();

  assert.equal(response.status, 201);
  assert.equal(body.deployment.status, 'succeeded');
  assert.equal(body.deployment.versionId, 'ver_1');
  assert.equal(statusBeforePoll.status, 'activating');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_1');
  assert.equal(polled.status, 200);
  assert.equal(pollBody.deployment.status, 'succeeded');
  assert.equal((await store.getDeployment('dep_1')).status, 'succeeded');
});

test('reconciles rollback success when final status write fails after route commit', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());
  await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'deploy_1' }),
    env
  );
  await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("def"); } };' }),
      { 'Idempotency-Key': 'deploy_2' }
    ),
    env
  );
  const originalUpdateDeployment = store.updateDeployment.bind(store);
  let failNextRollbackSucceededWrite = true;
  store.updateDeployment = async (id, patch) => {
    if (id === 'dep_3' && patch.status === 'succeeded' && failNextRollbackSucceededWrite) {
      failNextRollbackSucceededWrite = false;
      throw new Error('D1 unavailable');
    }
    return originalUpdateDeployment(id, patch);
  };

  const rollback = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback', {}, { 'Idempotency-Key': 'rb_final_fail' }),
    env
  );
  const body = await rollback.json();
  const statusBeforePoll = await store.getDeployment('dep_3');
  const polled = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/deployments/dep_3'), env);

  assert.equal(rollback.status, 201);
  assert.equal(body.deployment.status, 'succeeded');
  assert.equal(body.deployment.versionId, 'ver_1');
  assert.equal(statusBeforePoll.status, 'pending');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_1');
  assert.equal((await polled.json()).deployment.status, 'succeeded');
  assert.equal((await store.getDeployment('dep_3')).status, 'succeeded');
});

test('fails deployment activation without clobbering a concurrently changed route', async () => {
  const store = await createSeededStore();
  const originalActivate = store.activateSiteVersion.bind(store);
  let injectedConcurrentActivation = false;
  store.activateSiteVersion = async (siteId, patch, environment, expectedRoute) => {
    if (!injectedConcurrentActivation) {
      injectedConcurrentActivation = true;
      await originalActivate(
        siteId,
        {
          activeVersionId: 'ver_concurrent',
          workerName: 'pages-v2-docs-concurrent',
          runtime: 'worker',
          executionProvider: 'wfp',
          dispatchType: 'dispatch-namespace',
          visibility: 'org',
          updatedAt: '2026-06-15T00:00:30.000Z',
        },
        environment
      );
    }
    return originalActivate(siteId, patch, environment, expectedRoute);
  };
  const snapshots = createSnapshotStore();
  const deletedWorkers = [];
  const env = testEnv(store, snapshots, {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => ({ ok: true }),
      delete: async ({ workerName }) => deletedWorkers.push(workerName),
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'activation_race',
    }),
    env
  );

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'ROUTE_ACTIVATION_CONFLICT');
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.equal((await store.getDeployment('dep_1')).errorCode, 'ROUTE_ACTIVATION_CONFLICT');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_concurrent');
  assert.equal(snapshots.read('production:route_pointer:docs.pages.xd.team'), undefined);
  assert.deepEqual(deletedWorkers, ['pages-v2-docs-ver-1']);
});

test('fails deployment when production WFP namespace points at staging', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: undefined,
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'cf_secret_token',
    WFP_DISPATCH_NAMESPACE: 'pages-staging',
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default {};' }),
      { 'Idempotency-Key': 'wfp_config_fail' }
    ),
    env
  );

  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error.code, 'DEPLOYMENT_PLATFORM_CONFIG_INVALID');
  assert.equal(body.error.action, 'Check the Pages deployment platform configuration and retry with a new Idempotency-Key.');
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);
});

test('keeps previous active route when rollback snapshot write fails', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());

  await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'deploy_1' }),
    env
  );
  await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("def"); } };' }),
      { 'Idempotency-Key': 'deploy_2' }
    ),
    env
  );

  env.ROUTE_SNAPSHOTS = failingSnapshotStore();
  const rollback = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback', {}, { 'Idempotency-Key': 'rb_fail' }),
    env
  );
  const route = await store.getRouteBySiteId('site_1');

  assert.equal(rollback.status, 503);
  const body = await rollback.json();
  assert.equal(body.error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.equal(body.error.action, 'Retry the rollback with a new Idempotency-Key.');
  assert.equal((await store.getDeployment('dep_3')).status, 'failed');
  assert.equal(route.activeVersionId, 'ver_2');
  assert.equal(route.workerName, 'pages-v2-docs-ver-2');
  assert.equal(route.routeGeneration, 2);
  assert.equal(route.routeStatus, 'active');
});

test('rejects rollback to a version from a failed deployment', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, failingSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => ({ ok: true }),
      delete: async () => null,
    },
  });

  const failedDeploy = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'failed_version',
    }),
    env
  );
  const rollback = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback', {}, {
      'Idempotency-Key': 'rb_failed_version',
    }),
    env
  );

  assert.equal(failedDeploy.status, 503);
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.equal((await store.getSiteVersion('ver_1')).deploymentId, 'dep_1');
  assert.equal(rollback.status, 409);
  assert.equal((await rollback.json()).error.code, 'ROLLBACK_VERSION_UNAVAILABLE');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);
});

test('rejects rollback to a released normal worker slot version', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  const env = testEnv(store, failingSnapshotStore(), {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    NORMAL_WORKER_SLOT_PROVIDER: {
      upload: async () => null,
      verify: async () => ({ ok: true }),
    },
  });

  const failedDeploy = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'failed_slot_version',
    }),
    env
  );
  const rollback = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback', {}, { 'Idempotency-Key': 'rb_released_slot' }),
    env
  );

  assert.equal(failedDeploy.status, 503);
  assert.equal((await store.getWorkerSlot('slot_007')).status, 'available');
  assert.equal(rollback.status, 409);
  assert.equal((await rollback.json()).error.code, 'ROLLBACK_VERSION_UNAVAILABLE');
});

test('requires idempotency key for deploy and rollback', async () => {
  const store = await createSeededStore();
  const deploy = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/deployments', {
      ...deployPayload(),
    }),
    testEnv(store, createSnapshotStore())
  );
  const rollback = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback', {}),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(deploy.status, 400);
  assert.equal((await deploy.json()).error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(rollback.status, 400);
  assert.equal((await rollback.json()).error.code, 'IDEMPOTENCY_KEY_REQUIRED');
});

async function createSeededStore() {
  const store = createTestPagesStore({
    now: () => '2026-06-15T00:00:00.000Z',
  });
  await store.createUser({
    userId: 'usr_1',
    email: 'user@example.com',
    realname: 'User One',
    employeeStatus: 'active',
  });
  await store.createSite({
    id: 'site_1',
    slug: 'docs',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'docs.pages.xd.team',
  });
  return store;
}

function testEnv(store, snapshots, overrides = {}) {
  let counters = { dep: 0, ver: 0 };
  return {
    PAGES_ENV: 'production',
    PAGES_STORE: store,
    ROUTE_SNAPSHOTS: snapshots,
    IP_ALLOWLIST: '10.0.0.0/8',
    ACCESS_KEY_PEPPERS: 'pepper_1:ACCESS_KEY_PEPPER_TEST',
    ACCESS_KEY_PEPPER_TEST: 'pepper-secret',
    now: () => '2026-06-15T00:00:00.000Z',
    nextId: (prefix) => {
      if (prefix === 'dep') return `dep_${(counters.dep += 1)}`;
      if (prefix === 'ver') return `ver_${(counters.ver += 1)}`;
      return `${prefix}_1`;
    },
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
    ...overrides,
  };
}

function assertNoPublicExecutionDetails(body) {
  const serialized = JSON.stringify(body);
  assert.equal('workerName' in (body.version || {}), false);
  assert.equal('workerName' in (body.route || {}), false);
  assert.equal('executionProvider' in (body.version || {}), false);
  assert.equal('executionProvider' in (body.route || {}), false);
  assert.equal('dispatchBindingName' in (body.route || {}), false);
  assert.equal('artifactKind' in (body.version || {}), false);
  assert.equal('artifactKind' in body, false);
  assert.doesNotMatch(serialized, /pages-v2-(?:production|staging)-slot-\d+/);
  assert.doesNotMatch(serialized, /SITE_SLOT_\d+/);
  assert.doesNotMatch(serialized, /normal-worker-slot|executionProvider|dispatchBindingName|artifactKind/);
}

async function assertDeployOk(response) {
  assert.equal(response.status, 201, await response.clone().text());
  return response;
}

async function seedAccessKey(store, keyId, scopes, siteId = 'site_1') {
  const plaintext = createAccessKeyPlaintext({
    environment: 'production',
    keyId,
    bytes: new Uint8Array(24).fill(keyId === 'ak_deploy' ? 3 : 4),
  });
  await store.createAccessKey({
    id: keyId,
    ownerUserId: 'usr_1',
    keyHash: await hashAccessKey(plaintext, 'pepper-secret'),
    pepperId: 'pepper_1',
    name: keyId,
    scopes,
    siteId,
    expiresAt: '2026-07-15T00:00:00.000Z',
  });
  return plaintext;
}

function createSnapshotStore() {
  const values = new Map();
  return {
    put: async (key, value) => values.set(key, JSON.parse(value)),
    read: (key) => values.get(key),
  };
}

function failingSnapshotStore() {
  return {
    put: async () => {
      throw new Error('snapshot write failed');
    },
  };
}

function jsonRequest(url, body, headers = {}) {
  const hasBody = body !== undefined;
  return new Request(url, {
    method: hasBody ? 'POST' : 'GET',
    headers: {
      Authorization: 'Bearer cli-token',
      'CF-Connecting-IP': '10.1.2.3',
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: hasBody ? JSON.stringify(body) : undefined,
  });
}

function deploymentRequest(url, fields, headers = {}) {
  const normalized = normalizeDeploymentFields(fields);
  return publishPlanMultipartRequest(url, normalized, headers);
}

function publishPlanMultipartRequest(url, fields, headers = {}) {
  const normalized = normalizeDeploymentFields(fields);
  const form = new FormData();
  const metadata = {
    schemaVersion: normalized.schemaVersion || 1,
    siteId: normalized.siteId,
    siteSlug: normalized.siteSlug,
    requestedFallback: normalized.requestedFallback,
    source: normalized.source || 'cli',
    contentHash: normalized.contentHash,
    publishPlan: normalized.publishPlan,
    assetManifest: normalized.assetManifest || [],
    workerMainModuleName: normalized.workerMainModuleName || normalized.publishPlan?.workerMainModuleName,
    workerModules: normalized.workerModules || [],
    controlSignals: normalized.controlSignals || [],
  };
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
  for (const file of normalized.files || []) {
    form.set(file.field, new Blob([file.content], { type: file.type || 'application/octet-stream' }), file.filename);
  }
  if (normalized.worker) {
    form.set(
      normalized.worker.field,
      new Blob([normalized.worker.content], { type: normalized.worker.type || 'application/javascript+module' }),
      normalized.worker.filename
    );
  }
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

function normalizeDeploymentFields(fields) {
  if (fields.publishPlan) return normalizePublishPlanFields(fields);
  if (fields.assetManifest || fields.files?.length) return normalizeAssetOnlyFields(fields);
  return normalizeWorkerOnlyFields(fields);
}

function normalizeWorkerOnlyFields(fields) {
  const bundle = fields.artifactBundle || workerBundle(fields.moduleContent || 'export default {};');
  const mainModule = bundle.mainModule || bundle.modules?.[0]?.name || 'worker.mjs';
  const main = bundle.modules.find((module) => module.name === mainModule) || bundle.modules[0];
  const content = main?.content || 'export default {};';
  const type = main?.type || 'application/javascript+module';
  const worker = {
    field: 'worker-main',
    filename: mainModule,
    content,
    type,
  };
  const bytes = Buffer.from(content);
  const decision = {
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    workerEntry: mainModule,
  };
  return {
    ...fields,
    requestedFallback: fields.requestedFallback || 'auto',
    publishPlan: {
      ...decision,
      workerMainModuleName: mainModule,
    },
    workerModules: [
      {
        moduleName: mainModule,
        partName: worker.field,
        hash: hashAsset(bytes, type),
        size: bytes.byteLength,
        contentType: type,
      },
    ],
    worker,
    assetManifest: [],
    files: [],
    contentHash: fields.expectedContentHash || hashUploadPlan([{ relativePath: mainModule, contentType: type, bytes }], decision),
  };
}

function normalizeAssetOnlyFields(fields) {
  const files = fields.files || [];
  const assets = files.map((file, index) => {
    const path = normalizeAssetPathFromFilename(file.filename);
    const contentType = file.type || fields.assetManifest?.[path]?.content_type || 'application/octet-stream';
    const bytes = Buffer.from(file.content);
    return {
      path,
      partName: file.field || `asset-file-${index}`,
      hash: hashAsset(bytes, contentType),
      size: bytes.byteLength,
      contentType,
      file: {
        ...file,
        field: file.field || `asset-file-${index}`,
        type: contentType,
      },
    };
  });
  const resolvedFallback = fields.requestedFallback === 'not-found' ? 'not-found' : 'index';
  const decision = {
    deploymentShape: 'assets-only',
    requestedFallback: fields.requestedFallback || (resolvedFallback === 'index' ? 'index' : 'not-found'),
    resolvedFallback,
    routingMode: 'assets-only',
    workerEntry: null,
  };
  return {
    ...fields,
    requestedFallback: fields.requestedFallback || decision.requestedFallback,
    publishPlan: {
      ...decision,
      workerMainModuleName: null,
      assetsConfig: { notFoundHandling: resolvedFallback === 'index' ? 'single-page-application' : '404-page' },
    },
    assetManifest: assets.map(({ file: _file, ...asset }) => asset),
    files: assets.map((asset) => asset.file),
    workerModules: [],
    contentHash:
      fields.expectedContentHash ||
      hashUploadPlan(
        assets.map((asset) => ({
          relativePath: asset.path.replace(/^\/+/, ''),
          contentType: asset.contentType,
          bytes: Buffer.from(asset.file.content),
        })),
        decision
      ),
  };
}

function normalizePublishPlanFields(fields) {
  const assets = (fields.assetManifest || []).map((asset) => {
    const file = (fields.files || []).find((candidate) => candidate.field === asset.partName) || {};
    const contentType = asset.contentType || file.type || 'application/octet-stream';
    const bytes = Buffer.from(file.content || '');
    return {
      ...asset,
      hash: asset.keepHash ? asset.hash : hashAsset(bytes, contentType),
      size: asset.size ?? bytes.byteLength,
      contentType,
    };
  });
  const workerModules = (fields.workerModules || []).map((module) => {
    const worker =
      fields.worker && fields.worker.field === module.partName
        ? fields.worker
        : (fields.workerParts || []).find((candidate) => candidate.field === module.partName) || {};
    const contentType = module.contentType || worker.type || 'application/javascript+module';
    const bytes = Buffer.from(worker.content || '');
    return {
      ...module,
      hash: module.keepHash ? module.hash : hashAsset(bytes, contentType),
      size: module.size ?? bytes.byteLength,
      contentType,
    };
  });
  const files = (fields.files || []).map((file) => {
    const asset = assets.find((entry) => entry.partName === file.field);
    return { ...file, type: asset?.contentType || file.type };
  });
  const decision = {
    deploymentShape: fields.publishPlan.deploymentShape,
    requestedFallback: fields.publishPlan.requestedFallback,
    resolvedFallback: fields.publishPlan.resolvedFallback,
    routingMode: fields.publishPlan.routingMode,
    workerEntry: fields.publishPlan.workerMainModuleName || fields.publishPlan.workerEntry || null,
  };
  const hashFiles = [
    ...assets.map((asset) => {
      const file = files.find((candidate) => candidate.field === asset.partName) || {};
      return {
        relativePath: asset.path.replace(/^\/+/, ''),
        contentType: asset.contentType,
        bytes: Buffer.from(file.content || ''),
      };
    }),
    ...workerModules.map((module) => {
      const worker = fields.worker && fields.worker.field === module.partName ? fields.worker : {};
      return {
        relativePath: module.moduleName,
        contentType: module.contentType,
        bytes: Buffer.from(worker.content || ''),
      };
    }),
  ];
  return {
    ...fields,
    assetManifest: assets,
    files,
    workerModules,
    contentHash: fields.expectedContentHash || hashUploadPlan(hashFiles, decision),
  };
}

function authRequest(url, headers = {}) {
  return new Request(url, {
    headers: { Authorization: 'Bearer cli-token', 'CF-Connecting-IP': '10.1.2.3', ...headers },
  });
}

function workerBundle(content) {
  return {
    mainModule: 'worker.mjs',
    modules: [{ name: 'worker.mjs', content, type: 'application/javascript+module' }],
  };
}

function hashAsset(bytes, contentType) {
  return createHash('sha256')
    .update('xd-pages-asset-v2\0')
    .update(contentType || 'application/octet-stream')
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
    hash.update(file.contentType || 'application/octet-stream');
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
    assetsConfig: decision.resolvedFallback
      ? {
          notFoundHandling: decision.resolvedFallback === 'index' ? 'single-page-application' : '404-page',
        }
      : null,
  };
}

function normalizeAssetPathFromFilename(filename) {
  return `/${String(filename || 'index.html').replaceAll('\\', '/').replace(/^\/+/, '')}`;
}

function multipartWorkerScriptResponse() {
  return new Response(
    [
      '--form-boundary',
      'Content-Disposition: form-data; name="worker.mjs"; filename="worker.mjs"',
      'Content-Type: application/javascript+module',
      '',
      'export default {};',
      '--form-boundary--',
      '',
    ].join('\r\n'),
    {
      status: 200,
      headers: { 'Content-Type': 'multipart/form-data; boundary=form-boundary' },
    }
  );
}

function testSlackWebhookUrl() {
  return ['https://hooks.slack.com', 'services', 'T000', 'B000', 'PLACEHOLDER'].join('/');
}

function deployPayload(overrides = {}) {
  const contentHash = overrides.contentHash || 'sha256:abc';
  const moduleContent =
    overrides.moduleContent || `export default { fetch() { return new Response(${JSON.stringify(contentHash)}); } };`;
  const payload = {
    siteId: 'site_1',
    contentHash,
    artifactBundle: overrides.artifactBundle || workerBundle(moduleContent),
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (key !== 'moduleContent') payload[key] = value;
  }
  return payload;
}
