import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import worker from './index.js';
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
    jsonRequest('https://api.pages.xd.team/.xd-pages/internal/hostname-claims/confirm', { claim }, {
      'CF-Connecting-IP': '10.1.2.3',
    }),
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
