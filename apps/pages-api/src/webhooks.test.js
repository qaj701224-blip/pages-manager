import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.js';
import { createTestPagesStore } from './test-store.js';
import { deliverWebhookEvent } from './webhooks.js';

const FULL_WEBHOOK_URL = 'https://hooks.slack.com/services/T000/B000/super-secret-token?debug=1';

test('console admin creates webhook subscriptions without returning or storing plaintext URL', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/webhooks', {
      method: 'POST',
      body: {
        name: 'Slack deploy events',
        url: FULL_WEBHOOK_URL,
        events: ['site.deployed'],
        payloadMode: 'template',
        restrictedTemplate: {
          text: 'XD Cell: {{site.slug}} deployed by {{actor.email}}',
        },
      },
    }),
    env(store)
  );

  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json();
  assert.equal(body.webhook.name, 'Slack deploy events');
  assert.equal(body.webhook.urlHost, 'hooks.slack.com');
  assert.equal(body.webhook.urlMasked, 'https://hooks.slack.com/.../oken');
  assert.match(body.webhook.urlFingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.equal(body.webhook.url, undefined);
  assert.equal(body.webhook.encryptedUrlCiphertext, undefined);
  assert.equal(body.webhook.urlSecretRef, undefined);
  assert.doesNotMatch(
    JSON.stringify(body),
    /debug=1|services\/T000\/B000|super-secret-token|https:\/\/hooks\.slack\.com\/services/
  );

  const stored = await store.getWebhookSubscription({ id: body.webhook.id, includeSecret: true });
  assert.equal(stored.urlHost, 'hooks.slack.com');
  assert.notEqual(stored.encryptedUrlCiphertext, FULL_WEBHOOK_URL);
  assert.equal(stored.url, undefined);
  assert.equal(stored.urlSecretRef, null);
  assert.doesNotMatch(JSON.stringify(stored), /debug=1|services\/T000\/B000|https:\/\/hooks\.slack\.com\/services/);
});

test('console admin rejects template payload mode without a restricted template', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/webhooks', {
      method: 'POST',
      body: {
        name: 'Broken template',
        url: FULL_WEBHOOK_URL,
        events: ['site.deployed'],
        payloadMode: 'template',
      },
    }),
    env(store)
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'WEBHOOK_TEMPLATE_REQUIRED');
});

test('console admin can add a restricted template without resending payloadMode on update', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await store.createWebhookSubscription({
    id: 'wh_1',
    environment: 'production',
    name: 'Slack deploy events',
    events: ['site.deployed'],
    payloadMode: 'standard',
    restrictedTemplate: null,
    encryptedUrlCiphertext: 'v1:ciphertext',
    urlHost: 'hooks.slack.com',
    urlMasked: 'https://hooks.slack.com/.../token',
    urlFingerprint: 'sha256:abc',
    createdByUserId: 'usr_root',
  });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/webhooks/wh_1', {
      method: 'PATCH',
      body: {
        restrictedTemplate: {
          text: 'XD Cell: {{site.slug}} deployed',
        },
      },
    }),
    env(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.equal(body.webhook.payloadMode, 'template');
  assert.deepEqual(body.webhook.restrictedTemplate, {
    text: 'XD Cell: {{site.slug}} deployed',
  });
});

test('console admin validates webhook target resolution on create and update', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  const privateTargetEnv = env(store, {
    resolveWebhookHost: async () => ['10.0.0.8'],
  });
  const create = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/webhooks', {
      method: 'POST',
      body: {
        name: 'private target',
        url: 'https://hooks.example.test/services/T/B/C',
        events: ['site.deployed'],
        payloadMode: 'standard',
      },
    }),
    privateTargetEnv
  );

  assert.equal(create.status, 400);
  assert.equal((await create.json()).error.code, 'WEBHOOK_URL_HOST_FORBIDDEN');

  const publicTargetEnv = env(store, {
    resolveWebhookHost: async () => ['8.8.8.8'],
  });
  const created = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/webhooks', {
      method: 'POST',
      body: {
        name: 'public target',
        url: FULL_WEBHOOK_URL,
        events: ['site.deployed'],
        payloadMode: 'standard',
      },
    }),
    publicTargetEnv
  );
  assert.equal(created.status, 201, await created.clone().text());

  const update = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/webhooks/wh_1', {
      method: 'PATCH',
      body: {
        url: 'https://hooks.example.test/services/T/B/C',
      },
    }),
    privateTargetEnv
  );

  assert.equal(update.status, 400);
  assert.equal((await update.json()).error.code, 'WEBHOOK_URL_HOST_FORBIDDEN');
});

test('console admin lists and disables webhook subscriptions without exposing target URL secrets', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  const created = await store.createWebhookSubscription({
    id: 'wh_1',
    environment: 'production',
    name: 'Slack deploy events',
    events: ['site.deployed'],
    payloadMode: 'standard',
    restrictedTemplate: null,
    encryptedUrlCiphertext: 'v1:ciphertext',
    urlHost: 'hooks.slack.com',
    urlMasked: 'https://hooks.slack.com/.../token',
    urlFingerprint: 'sha256:abc',
    createdByUserId: 'usr_root',
  });

  const list = await worker.fetch(internalConsoleRequest('/.xd-pages/api/console/admin/webhooks'), env(store));
  assert.equal(list.status, 200, await list.clone().text());
  const listBody = await list.json();
  assert.deepEqual(
    listBody.webhooks.map((webhook) => webhook.id),
    [created.id]
  );
  assert.equal(listBody.webhooks[0].urlHost, 'hooks.slack.com');
  assert.equal(listBody.webhooks[0].url, undefined);
  assert.equal(listBody.webhooks[0].encryptedUrlCiphertext, undefined);

  const disabled = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/webhooks/wh_1', {
      method: 'DELETE',
    }),
    env(store)
  );
  assert.equal(disabled.status, 200, await disabled.clone().text());
  const disabledBody = await disabled.json();
  assert.equal(disabledBody.webhook.enabled, false);
  assert.equal(disabledBody.webhook.url, undefined);
  assert.equal(disabledBody.webhook.encryptedUrlCiphertext, undefined);
});

test('console admin webhook deliveries expose metadata without raw payload or target URL', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await store.createWebhookSubscription({
    id: 'wh_1',
    environment: 'production',
    name: 'Slack deploy events',
    events: ['site.deployed'],
    payloadMode: 'standard',
    restrictedTemplate: null,
    encryptedUrlCiphertext: 'v1:ciphertext',
    urlHost: 'hooks.slack.com',
    urlMasked: 'https://hooks.slack.com/.../token',
    urlFingerprint: 'sha256:abc',
    createdByUserId: 'usr_root',
  });
  await store.recordWebhookDelivery({
    id: 'whd_1',
    environment: 'production',
    subscriptionId: 'wh_1',
    eventType: 'site.deployed',
    deliveryStatus: 'succeeded',
    renderStatus: 'succeeded',
    payloadMode: 'standard',
    payloadHash: 'sha256:def',
    targetHost: 'hooks.slack.com',
    httpStatus: 200,
    attemptCount: 1,
  });

  const response = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/webhooks/wh_1/deliveries'),
    env(store)
  );

  assert.equal(response.status, 200, await response.clone().text());
  const body = await response.json();
  assert.deepEqual(body.deliveries, [
    {
      id: 'whd_1',
      subscriptionId: 'wh_1',
      eventType: 'site.deployed',
      deliveryStatus: 'succeeded',
      renderStatus: 'succeeded',
      payloadMode: 'standard',
      payloadHash: 'sha256:def',
      targetHost: 'hooks.slack.com',
      httpStatus: 200,
      attemptCount: 1,
      nextRetryAt: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(body), /payload":|rawPayload|https:\/\/hooks\.slack\.com|ciphertext/);
});

test('deliverWebhookEvent renders template payloads and records successful delivery metadata', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  const testEnv = env(store);
  const create = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/webhooks', {
      method: 'POST',
      body: {
        name: 'Slack deploy events',
        url: FULL_WEBHOOK_URL,
        events: ['site.deployed'],
        payloadMode: 'template',
        restrictedTemplate: {
          text: 'XD Cell: {{site.slug}} deployed by {{actor.email}}',
        },
      },
    }),
    testEnv
  );
  assert.equal(create.status, 201, await create.clone().text());

  let capturedRequest;
  const delivery = await deliverWebhookEvent({
    store,
    env: testEnv,
    config: { environment: 'production' },
    subscriptionId: 'wh_1',
    event: {
      id: 'evt_1',
      type: 'site.deployed',
      environment: 'production',
      occurredAt: '2026-07-01T00:00:00.000Z',
      actor: { type: 'user', userId: 'usr_1', email: 'owner@example.com' },
      site: { id: 'site_1', slug: 'docs', hostname: 'docs.pages.xd.team' },
      deployment: { id: 'dep_1', status: 'succeeded' },
    },
    now: () => '2026-07-01T00:00:00.000Z',
    resolveHost: async () => ['8.8.8.8'],
    fetchImpl: async (request) => {
      capturedRequest = request;
      return new Response('ok', { status: 200 });
    },
  });

  assert.equal(delivery.deliveryStatus, 'succeeded');
  assert.equal(delivery.renderStatus, 'succeeded');
  assert.equal(delivery.payloadMode, 'template');
  assert.match(delivery.payloadHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(delivery.attemptCount, 1);
  assert.equal(capturedRequest.url, FULL_WEBHOOK_URL);
  assert.deepEqual(await capturedRequest.json(), {
    text: 'XD Cell: docs deployed by owner@example.com',
  });
  const deliveries = await store.listWebhookDeliveries({ environment: 'production', subscriptionId: 'wh_1' });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].targetHost, 'hooks.slack.com');
  assert.equal(deliveries[0].nextRetryAt, null);
  assert.doesNotMatch(JSON.stringify(deliveries), /https:\/\/hooks\.slack\.com|super-secret-token|payload":/);
});

test('deliverWebhookEvent records template render failures without outbound fetch', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T00:00:00.000Z' });
  await seedPlatformAdmin(store);
  await store.createWebhookSubscription({
    id: 'wh_1',
    environment: 'production',
    name: 'broken template',
    events: ['site.deployed'],
    payloadMode: 'template',
    restrictedTemplate: { text: '{{site.providerResourceId}}' },
    encryptedUrlCiphertext: 'v1:ciphertext',
    urlHost: 'hooks.slack.com',
    urlMasked: 'https://hooks.slack.com/.../token',
    urlFingerprint: 'sha256:abc',
    createdByUserId: 'usr_root',
  });
  let fetchCalled = false;

  const delivery = await deliverWebhookEvent({
    store,
    env: env(store),
    config: { environment: 'production' },
    subscriptionId: 'wh_1',
    event: {
      id: 'evt_1',
      type: 'site.deployed',
      environment: 'production',
      site: { id: 'site_1', slug: 'docs' },
    },
    now: () => '2026-07-01T00:00:00.000Z',
    resolveHost: async () => ['8.8.8.8'],
    fetchImpl: async () => {
      fetchCalled = true;
      return new Response('ok', { status: 200 });
    },
  });

  assert.equal(fetchCalled, false);
  assert.equal(delivery.deliveryStatus, 'failed');
  assert.equal(delivery.renderStatus, 'failed');
  assert.equal(delivery.errorCode, 'WEBHOOK_TEMPLATE_VARIABLE_FORBIDDEN');
  assert.equal(delivery.attemptCount, 0);
});

test('webhook schema includes subscription and delivery tables', async () => {
  const { createSchemaSql } = await import('./schema.js');
  const sql = createSchemaSql().join('\n');

  assert.match(sql, /CREATE TABLE IF NOT EXISTS webhook_subscriptions\b/);
  assert.match(sql, /encrypted_url_ciphertext TEXT NOT NULL/);
  assert.match(sql, /url_fingerprint TEXT NOT NULL/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS webhook_deliveries\b/);
  assert.match(sql, /payload_hash TEXT/);
  assert.doesNotMatch(sql, /\bwebhook_signing_secret\b/);
});

function env(store, overrides = {}) {
  return {
    PAGES_ENV: 'production',
    PAGES_STORE: store,
    IP_ALLOWLIST: '10.0.0.0/8',
    WEBHOOK_URL_ENCRYPTION_KEY: 'test-webhook-url-key',
    resolveWebhookHost: async () => ['8.8.8.8'],
    now: () => '2026-07-01T00:00:00.000Z',
    nextId: (prefix) => (prefix === 'wh' ? 'wh_1' : `${prefix}_1`),
    ...overrides,
  };
}

function internalConsoleRequest(path, { method = 'GET', body } = {}) {
  const headers = {
    Host: 'pages-api.internal',
    'X-Console-BFF': 'pages-console',
    'X-Console-User-Id': 'usr_root',
    'X-Console-Email': 'root@example.com',
    'X-Console-Admin': 'true',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(`https://pages-api.internal${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function seedPlatformAdmin(store, userId = 'usr_root') {
  if (!(await store.getUser(userId))) {
    await store.createUser({
      userId,
      email: 'root@example.com',
      employeeStatus: 'active',
      sessionVersion: 1,
    });
  }
  await store.grantPlatformAdmin({
    environment: 'production',
    userId,
    grantedByUserId: 'usr_bootstrap',
    grantReason: 'test',
  });
}
