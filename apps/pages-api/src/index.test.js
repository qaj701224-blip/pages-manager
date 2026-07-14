import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import worker from './index.js';
import { buildS2SCanonicalInput, createS2SSignature } from './s2s-auth.js';
import { createTestPagesStore } from './test-store.js';

test('health returns pages-api service and environment', async () => {
  const response = await worker.fetch(new Request('https://api.pages.xd.team/.xd-pages/health'), {
    PAGES_ENV: 'production',
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), {
    status: 'ok',
    service: 'pages-api',
    environment: 'production',
  });
});

test('health rejects legacy token headers', async () => {
  const response = await worker.fetch(
    new Request('https://api.pages.xd.team/.xd-pages/health', {
      headers: { 'X-Pages-Token': 'legacy' },
    }),
    {
      PAGES_ENV: 'production',
    }
  );

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'LEGACY_TOKEN_UNSUPPORTED');
  assert.equal(body.error.message, 'Legacy Pages tokens are not supported by XD Cell.');
  assert.equal(body.error.action, 'Run `xd-cell login` or use an XD Cell access key.');
});

test('scheduled handler runs due WFP cleanup tasks', async () => {
  const store = createTestPagesStore({
    now: () => '2026-06-15T00:00:00.000Z',
  });
  const deletedWorkers = [];
  await store.createUser({
    userId: 'usr_1',
    email: 'user@example.com',
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
  await store.createSiteVersion({
    id: 'ver_old',
    siteId: 'site_1',
    deploymentId: 'dep_old',
    workerName: 'pages-v2-docs-ver-old',
    runtime: 'worker',
    executionProvider: 'wfp',
    dispatchType: 'dispatch-namespace',
    artifactRef: 'wfp://test/pages-v2-docs-ver-old',
    contentHash: 'sha256:old',
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    artifactAvailability: 'active',
    createdBy: 'usr_1',
  });
  await store.createDeploymentResourceCleanupTask({
    id: 'cln_1',
    environment: 'production',
    resourceType: 'wfp_user_worker',
    resourceRef: 'pages-v2-docs-ver-old',
    siteId: 'site_1',
    versionId: 'ver_old',
    deploymentId: 'dep_new',
    cleanupReason: 'blue_green_previous_worker',
    status: 'pending',
    cleanupAfter: '2026-06-14T23:59:00.000Z',
  });

  await worker.scheduled(
    { scheduledTime: Date.parse('2026-06-15T00:00:00.000Z'), cron: '*/15 * * * *' },
    {
      PAGES_ENV: 'production',
      PAGES_STORE: store,
      now: () => '2026-06-15T00:00:00.000Z',
      WFP_RESOURCE_ADMIN_CLIENT: {
        deleteWorker: async ({ workerName }) => deletedWorkers.push(workerName),
      },
    },
    { waitUntil: (promise) => promise }
  );

  assert.deepEqual(deletedWorkers, ['pages-v2-docs-ver-old']);
  assert.equal((await store.getDeploymentResourceCleanupTask('cln_1', 'production')).status, 'succeeded');
  assert.equal((await store.getSiteVersion('ver_old')).artifactAvailability, 'retired');
});

test('scheduled handler cleans expired S2S guards even when deployment cleanup fails', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  await store.reserveS2SNonce({
    environment: 'production',
    clientId: 'xdmaker',
    nonce: 'nonce_cleanup01',
    endpoint: '/.xd-pages/api/s2s/tokens',
    receivedAt: '2026-06-14T23:50:00.000Z',
    expiresAt: '2026-06-14T23:59:00.000Z',
  });
  await store.consumeS2SRateLimit({
    environment: 'production',
    scope: 'client',
    subject: 'xdmaker',
    bucketStart: '2026-06-14T23:50:00.000Z',
    expiresAt: '2026-06-15T00:00:00.000Z',
    limit: 300,
  });
  store.listDueDeploymentResourceCleanupTasks = async () => {
    throw new Error('cleanup unavailable');
  };
  await worker.scheduled(
    { scheduledTime: Date.parse('2026-06-15T00:00:00.000Z'), cron: '*/15 * * * *' },
    {
      PAGES_ENV: 'production',
      PAGES_STORE: store,
      now: () => '2026-06-15T00:00:00.000Z',
    }
  );
  assert.equal(store.s2sNonces.size, 0);
  assert.equal(store.s2sRateLimits.size, 0);
});

test('scheduled handler retries failed WFP cleanup tasks', async () => {
  const store = createTestPagesStore({
    now: () => '2026-06-15T00:00:00.000Z',
  });
  const deletedWorkers = [];
  await store.createDeploymentResourceCleanupTask({
    id: 'cln_failed',
    environment: 'production',
    resourceType: 'wfp_user_worker',
    resourceRef: 'pages-v2-docs-ver-old',
    cleanupReason: 'blue_green_previous_worker',
    status: 'failed',
    cleanupAfter: '2026-06-14T23:59:00.000Z',
    attemptCount: 1,
    lastErrorCode: 'CLEANUP_DELETE_FAILED',
    lastErrorMessage: 'Worker could not be deleted from Cloudflare.',
  });

  await worker.scheduled(
    { scheduledTime: Date.parse('2026-06-15T00:00:00.000Z'), cron: '*/15 * * * *' },
    {
      PAGES_ENV: 'production',
      PAGES_STORE: store,
      now: () => '2026-06-15T00:00:00.000Z',
      WFP_RESOURCE_ADMIN_CLIENT: {
        deleteWorker: async ({ workerName }) => deletedWorkers.push(workerName),
      },
    },
    { waitUntil: (promise) => promise }
  );

  const task = await store.getDeploymentResourceCleanupTask('cln_failed', 'production');
  assert.deepEqual(deletedWorkers, ['pages-v2-docs-ver-old']);
  assert.equal(task.status, 'succeeded');
  assert.equal(task.attemptCount, 2);
});

test('scheduled handler retries expired running WFP cleanup tasks', async () => {
  const store = createTestPagesStore({
    now: () => '2026-06-15T00:00:00.000Z',
  });
  const deletedWorkers = [];
  await store.createDeploymentResourceCleanupTask({
    id: 'cln_running_expired',
    environment: 'production',
    resourceType: 'wfp_user_worker',
    resourceRef: 'pages-v2-docs-ver-old',
    cleanupReason: 'blue_green_previous_worker',
    status: 'running',
    cleanupAfter: '2026-06-14T23:59:00.000Z',
    attemptCount: 1,
    lockedUntil: '2026-06-14T23:59:30.000Z',
  });

  await worker.scheduled(
    { scheduledTime: Date.parse('2026-06-15T00:00:00.000Z'), cron: '*/15 * * * *' },
    {
      PAGES_ENV: 'production',
      PAGES_STORE: store,
      now: () => '2026-06-15T00:00:00.000Z',
      WFP_RESOURCE_ADMIN_CLIENT: {
        deleteWorker: async ({ workerName }) => deletedWorkers.push(workerName),
      },
    },
    { waitUntil: (promise) => promise }
  );

  const task = await store.getDeploymentResourceCleanupTask('cln_running_expired', 'production');
  assert.deepEqual(deletedWorkers, ['pages-v2-docs-ver-old']);
  assert.equal(task.status, 'succeeded');
  assert.equal(task.attemptCount, 2);
});

test('scheduled handler records locked cleanup exceptions and continues the batch', async () => {
  const store = createTestPagesStore({
    now: () => '2026-06-15T00:00:00.000Z',
  });
  const deletedWorkers = [];
  await store.createUser({
    userId: 'usr_1',
    email: 'user@example.com',
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
  await store.createSiteVersion({
    id: 'ver_error',
    siteId: 'site_1',
    deploymentId: 'dep_old',
    workerName: 'pages-v2-docs-ver-error',
    runtime: 'worker',
    executionProvider: 'wfp',
    dispatchType: 'dispatch-namespace',
    artifactRef: 'wfp://test/pages-v2-docs-ver-error',
    contentHash: 'sha256:error',
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    artifactAvailability: 'active',
    createdBy: 'usr_1',
  });
  await store.createDeploymentResourceCleanupTask({
    id: 'cln_error',
    environment: 'production',
    resourceType: 'wfp_user_worker',
    resourceRef: 'pages-v2-docs-ver-error',
    siteId: 'site_1',
    versionId: 'ver_error',
    deploymentId: 'dep_new',
    cleanupReason: 'blue_green_previous_worker',
    status: 'pending',
    cleanupAfter: '2026-06-14T23:59:00.000Z',
  });
  await store.createDeploymentResourceCleanupTask({
    id: 'cln_next',
    environment: 'production',
    resourceType: 'wfp_user_worker',
    resourceRef: 'pages-v2-docs-ver-next',
    cleanupReason: 'blue_green_previous_worker',
    status: 'pending',
    cleanupAfter: '2026-06-14T23:59:01.000Z',
  });

  const originalFindActiveRoute = store.findActiveRouteByWorkerResource.bind(store);
  let routeChecks = 0;
  store.findActiveRouteByWorkerResource = async (input) => {
    routeChecks += 1;
    if (routeChecks === 2) throw new Error('route store unavailable');
    return originalFindActiveRoute(input);
  };

  await worker.scheduled(
    { scheduledTime: Date.parse('2026-06-15T00:00:00.000Z'), cron: '*/15 * * * *' },
    {
      PAGES_ENV: 'production',
      PAGES_STORE: store,
      now: () => '2026-06-15T00:00:00.000Z',
      WFP_RESOURCE_ADMIN_CLIENT: {
        deleteWorker: async ({ workerName }) => deletedWorkers.push(workerName),
      },
    }
  );

  const failedTask = await store.getDeploymentResourceCleanupTask('cln_error', 'production');
  const nextTask = await store.getDeploymentResourceCleanupTask('cln_next', 'production');
  assert.equal(failedTask.status, 'failed');
  assert.equal(failedTask.lastErrorCode, 'CLEANUP_TASK_FAILED');
  assert.equal(failedTask.lastErrorMessage, 'Cleanup task failed unexpectedly.');
  assert.equal(failedTask.lockedUntil, null);
  assert.equal((await store.getSiteVersion('ver_error')).artifactAvailability, 'active');
  assert.equal(nextTask.status, 'succeeded');
  assert.deepEqual(deletedWorkers, ['pages-v2-docs-ver-next']);
});

test('invalid environment fails closed', async () => {
  const response = await worker.fetch(new Request('https://api.pages.xd.team/.xd-pages/health'), {
    PAGES_ENV: 'preview',
  });

  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error.code, 'API_ENV_INVALID');
  assert.equal(body.error.action, 'Check the pages-api Worker environment configuration.');
});

test('unknown endpoints return safe JSON errors', async () => {
  const response = await worker.fetch(
    new Request('https://api.pages.xd.team/.xd-pages/api/missing', {
      headers: { 'CF-Connecting-IP': '10.1.2.3' },
    }),
    {
      PAGES_ENV: 'production',
      IP_ALLOWLIST: '10.0.0.0/8',
    }
  );

  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.match(body.error.action, /Check the endpoint/);
});

test('management API rejects requests outside the configured IP allowlist before auth handlers', async () => {
  const store = createTestPagesStore({
    now: () => '2026-06-15T00:00:00.000Z',
  });
  await store.createUser({
    userId: 'usr_1',
    email: 'user@example.com',
    employeeStatus: 'active',
  });
  const response = await worker.fetch(
    new Request('https://api.pages.xd.team/.xd-pages/api/sites', {
      headers: {
        Authorization: 'Bearer cli-token',
        'CF-Connecting-IP': '203.0.113.8',
      },
    }),
    {
      PAGES_ENV: 'production',
      PAGES_STORE: store,
      IP_ALLOWLIST: '10.0.0.0/8',
      verifyCliToken: async () => ({
        sub: 'usr_1',
        purpose: 'cli_token',
        aud: 'pages-cli',
        env: 'production',
        jti: 'cli_1',
      }),
    }
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'IP_NOT_ALLOWED');
});

test('S2S endpoint is denied by the existing IP allowlist before nonce or token handling', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  const request = await signedS2SRequest({ now: 1_781_481_600, nonce: 'nonce_denied1' });
  const response = await worker.fetch(request, {
    PAGES_ENV: 'production',
    PAGES_STORE: store,
    IP_ALLOWLIST: '10.0.0.0/8',
    S2S_CLIENT_KEYS: 'xdmaker:key_1:S2S_SECRET_XDMAKER',
    S2S_SECRET_XDMAKER: 'secret',
    now: () => '2026-06-15T00:00:00.000Z',
  });
  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'IP_NOT_ALLOWED');
  assert.equal(store.s2sNonces.size, 0);
});

test('S2S endpoint reaches the handler through the allowlist without bearer auth', async () => {
  const store = createTestPagesStore({ now: () => '2026-06-15T00:00:00.000Z' });
  const request = await signedS2SRequest({ now: 1_781_481_600, nonce: 'nonce_allowed1', ip: '10.1.2.3' });
  const response = await worker.fetch(request, {
    PAGES_ENV: 'production',
    PAGES_STORE: store,
    IP_ALLOWLIST: '10.0.0.0/8',
    S2S_CLIENT_KEYS: 'xdmaker:key_1:S2S_SECRET_XDMAKER',
    S2S_SECRET_XDMAKER: 'secret',
    ACCESS_KEY_ACTIVE_PEPPER_ID: 'pepper_s2s',
    ACCESS_KEY_PEPPERS: 'pepper_s2s:S2S_ACCESS_KEY_PEPPER',
    S2S_ACCESS_KEY_PEPPER: 'secret-pepper',
    now: () => '2026-06-15T00:00:00.000Z',
    nextId: (prefix) => `${prefix}_route_test`,
  });
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal((await response.json()).source, 'xdmaker_s2s');
  assert.equal(store.s2sNonces.size, 1);
});

test('internal user upsert is only callable through internal service host', async () => {
  const store = createTestPagesStore({
    now: () => '2026-06-15T00:00:00.000Z',
  });
  const publicResponse = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/internal/users/upsert',
      {
        user: { userId: 'usr_1', email: 'user@example.com', employeeStatus: 'active' },
        now: 1_800_000_000,
      },
      { 'CF-Connecting-IP': '10.1.2.3' }
    ),
    { PAGES_ENV: 'production', PAGES_STORE: store, IP_ALLOWLIST: '10.0.0.0/8' }
  );
  const internalResponse = await worker.fetch(
    jsonRequest('https://pages-api.internal/.xd-pages/internal/users/upsert', {
      user: {
        userId: 'usr_1',
        email: 'USER@example.com',
        realname: '示例用户',
        account: 'USER@example.com',
        accountId: 'acct_1',
        employeenum: 'user',
        employeeStatus: 'active',
        sessionVersion: 2,
      },
      now: 1_800_000_000,
    }),
    { PAGES_ENV: 'production', PAGES_STORE: store }
  );

  assert.equal(publicResponse.status, 404);
  assert.equal((await publicResponse.json()).error.code, 'NOT_FOUND');
  assert.equal(internalResponse.status, 200, await internalResponse.clone().text());
  assert.equal((await store.getUser('usr_1')).email, 'user@example.com');
  assert.equal((await store.getUser('usr_1')).realname, '示例用户');
  assert.equal((await store.getUser('usr_1')).account, 'USER@example.com');
  assert.equal((await store.getUser('usr_1')).accountId, 'acct_1');
  assert.equal((await store.getUser('usr_1')).employeenum, 'user');
  assert.equal((await store.getUser('usr_1')).sessionVersion, 2);
});

test('internal hostname claim acquire is only callable through internal service host', async () => {
  const store = createTestPagesStore({
    now: () => '2026-06-15T00:00:00.000Z',
  });
  await store.acquireHostnameClaim({
    environment: 'production',
    hostname: 'demo.workers.xd.team',
    normalizedSlug: 'demo',
    hostnameFamily: 'workers',
    ownerSystem: 'v1',
    ownerId: 'v1:production:demo',
    ownerRef: 'pages-demo',
    source: 'backfill_v1_sites',
  });

  const body = {
    claim: {
      environment: 'production',
      hostname: 'demo.workers.xd.team',
      normalizedSlug: 'demo',
      hostnameFamily: 'workers',
      ownerSystem: 'v2',
      ownerId: 'site_demo',
      ownerRef: 'route_demo',
      source: 'v2_create',
    },
  };
  const publicResponse = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/internal/hostname-claims/acquire', body, {
      'CF-Connecting-IP': '10.1.2.3',
    }),
    { PAGES_ENV: 'production', PAGES_STORE: store, IP_ALLOWLIST: '10.0.0.0/8' }
  );
  const internalResponse = await worker.fetch(
    jsonRequest('https://pages-api.internal/.xd-pages/internal/hostname-claims/acquire', body),
    { PAGES_ENV: 'production', PAGES_STORE: store }
  );

  assert.equal(publicResponse.status, 404);
  assert.equal((await publicResponse.json()).error.code, 'NOT_FOUND');
  assert.equal(internalResponse.status, 409);
  const conflictBody = await internalResponse.json();
  assert.equal(conflictBody.error.code, 'HOSTNAME_CLAIM_CONFLICT');
});

test('internal hostname claim confirm and release stay on internal service host', async () => {
  const store = createTestPagesStore({
    now: () => '2026-06-15T00:00:00.000Z',
  });
  const claim = {
    environment: 'production',
    hostname: 'demo.workers.xd.team',
    normalizedSlug: 'demo',
    hostnameFamily: 'workers',
    ownerSystem: 'v1',
    ownerId: 'v1:production:demo',
    ownerRef: 'pages-demo',
    source: 'v1_deploy',
    status: 'pending',
  };
  await store.acquireHostnameClaim(claim);

  const publicConfirm = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/internal/hostname-claims/confirm',
      { claim },
      {
        'CF-Connecting-IP': '10.1.2.3',
      }
    ),
    { PAGES_ENV: 'production', PAGES_STORE: store, IP_ALLOWLIST: '10.0.0.0/8' }
  );
  const internalConfirm = await worker.fetch(
    jsonRequest('https://pages-api.internal/.xd-pages/internal/hostname-claims/confirm', { claim }),
    { PAGES_ENV: 'production', PAGES_STORE: store }
  );

  assert.equal(publicConfirm.status, 404);
  assert.equal(internalConfirm.status, 200, await internalConfirm.clone().text());
  assert.equal((await store.getHostnameClaim(claim.hostname)).status, 'active');

  const pendingClaim = { ...claim, hostname: 'retry.workers.xd.team', normalizedSlug: 'retry', ownerId: 'v1:production:retry' };
  await store.acquireHostnameClaim(pendingClaim);
  const internalRelease = await worker.fetch(
    jsonRequest('https://pages-api.internal/.xd-pages/internal/hostname-claims/release', {
      claim: { ...pendingClaim, releaseReason: 'v1_deploy_failed' },
    }),
    { PAGES_ENV: 'production', PAGES_STORE: store }
  );

  assert.equal(internalRelease.status, 200, await internalRelease.clone().text());
  assert.equal((await store.getHostnameClaim(pendingClaim.hostname)).status, 'released');
});

test('wrangler templates include required WFP vars without runtime token placeholders', async () => {
  const productionTemplate = await readFile(new URL('../wrangler.production.template.toml', import.meta.url), 'utf8');
  const stagingTemplate = await readFile(new URL('../wrangler.staging.template.toml', import.meta.url), 'utf8');

  assert.match(productionTemplate, /WFP_DISPATCH_NAMESPACE = "xd-cell-workers-production"/);
  assert.match(stagingTemplate, /WFP_DISPATCH_NAMESPACE = "xd-cell-workers-staging"/);
  assert.match(productionTemplate, /PAGES_EXECUTION_MODE = "wfp"/);
  assert.match(stagingTemplate, /PAGES_EXECUTION_MODE = "wfp"/);
  assert.match(productionTemplate, /PAGES_NORMAL_WORKER_SLOT_EXPAND_BY = "2"/);
  assert.match(stagingTemplate, /PAGES_NORMAL_WORKER_SLOT_EXPAND_BY = "20"/);
  assert.match(productionTemplate, /SLACK_PAGES_ALERT_MENTION_USER_ID = "U06QLFY2XCK"/);
  assert.match(stagingTemplate, /SLACK_PAGES_ALERT_MENTION_USER_ID = "U06QLFY2XCK"/);
  assert.match(productionTemplate, /WFP_COMPATIBILITY_DATE = "2026-06-15"/);
  assert.match(stagingTemplate, /WFP_COMPATIBILITY_DATE = "2026-06-15"/);
  assert.match(productionTemplate, /crons = \["\*\/15 \* \* \* \*"\]/);
  assert.match(stagingTemplate, /crons = \["\*\/15 \* \* \* \*"\]/);
  assert.match(productionTemplate, /PAGES_USER_WORKER_VPC_TUNNEL_ID = "__PAGES_USER_WORKER_VPC_TUNNEL_ID__"/);
  assert.match(stagingTemplate, /PAGES_USER_WORKER_VPC_TUNNEL_ID = "__PAGES_USER_WORKER_VPC_TUNNEL_ID__"/);
  assert.doesNotMatch(`${productionTemplate}\n${stagingTemplate}`, /PAGES_USER_WORKER_VPC_TUNNEL_ID = "[0-9a-f-]{36}"/);
  assert.match(productionTemplate, /ACCESS_KEY_ACTIVE_PEPPER_ID = "pepper_2026_06"/);
  assert.match(stagingTemplate, /ACCESS_KEY_PEPPERS = "pepper_2026_06:ACCESS_KEY_PEPPER_202606"/);
  assert.match(productionTemplate, /SITE_SECRET_ENCRYPTION_KEY: encryption key for site-level runtime secrets/);
  assert.match(stagingTemplate, /SITE_SECRET_ENCRYPTION_KEY: encryption key for site-level runtime secrets/);
  assert.match(productionTemplate, /WEBHOOK_URL_ENCRYPTION_KEY: encryption key for platform webhook target URLs/);
  assert.match(stagingTemplate, /WEBHOOK_URL_ENCRYPTION_KEY: encryption key for platform webhook target URLs/);
  assert.doesNotMatch(`${productionTemplate}\n${stagingTemplate}`, /__PAGES_EXECUTION_MODE__/);
  assert.doesNotMatch(`${productionTemplate}\n${stagingTemplate}`, /SITE_SECRET_ENCRYPTION_KEY\s*=/);
  assert.doesNotMatch(`${productionTemplate}\n${stagingTemplate}`, /WEBHOOK_URL_ENCRYPTION_KEY\s*=/);
  assert.doesNotMatch(`${productionTemplate}\n${stagingTemplate}`, /CF_API_TOKEN|CF_ACCOUNT_ID/);
});

function jsonRequest(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function signedS2SRequest({ now, nonce, ip = '203.0.113.8' }) {
  const rawBody = JSON.stringify({ email: 'route@example.com', feishu_open_id: 'ou_route', display_name: 'Route User' });
  const canonical = await buildS2SCanonicalInput({
    environment: 'production',
    clientId: 'xdmaker',
    keyId: 'key_1',
    method: 'POST',
    pathname: '/.xd-pages/api/s2s/tokens',
    timestamp: String(now),
    nonce,
    rawBody,
  });
  const signature = await createS2SSignature('secret', canonical);
  return new Request('https://api.pages.xd.team/.xd-pages/api/s2s/tokens', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': ip,
      'X-XD-Cell-S2S-Client': 'xdmaker',
      'X-XD-Cell-S2S-Key-Id': 'key_1',
      'X-XD-Cell-S2S-Timestamp': String(now),
      'X-XD-Cell-S2S-Nonce': nonce,
      'X-XD-Cell-S2S-Signature': signature,
    },
    body: rawBody,
  });
}
