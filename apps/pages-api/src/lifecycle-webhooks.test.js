import assert from 'node:assert/strict';
import test from 'node:test';

import { emitSiteDeletedWebhook, emitSiteDisabledWebhook, emitSiteFailedWebhook } from './lifecycle-webhooks.js';

const ENVIRONMENT = 'production';
const ENCRYPTION_KEY = 'test-webhook-url-key';

test('site.disabled delivery includes the visibility transition and isolates delivery failure', async () => {
  const requests = [];
  const store = await createWebhookStore('site.disabled');
  const env = {
    WEBHOOK_URL_ENCRYPTION_KEY: ENCRYPTION_KEY,
    resolveWebhookHost: async () => ['8.8.8.8'],
    WEBHOOK_FETCH: async (request) => {
      requests.push(request);
      throw new Error('receiver unavailable');
    },
    now: () => '2026-08-07T12:00:00.000Z',
    nextId: (prefix) => `${prefix}_1`,
  };

  await emitSiteDisabledWebhook({
    store,
    env,
    config: { environment: ENVIRONMENT },
    actor: { userId: 'usr_1', email: 'owner@example.com' },
    site: { id: 'site_1', slug: 'demo', ownerType: 'user', defaultVisibility: 'org' },
    previousRoute: { visibility: 'org', hostname: 'demo.pages.xd.team', routeStatus: 'active' },
    route: { visibility: 'disabled', hostname: 'demo.pages.xd.team', routeStatus: 'disabled' },
  });

  assert.equal(requests.length, 1);
  const payload = await requests[0].json();
  assert.equal(payload.event.type, 'site.disabled');
  assert.equal(payload.actor.type, 'user');
  assert.deepEqual(payload.change, {
    field: 'visibility',
    previousValue: 'org',
    currentValue: 'disabled',
  });
  assert.equal(store.updatedDeliveries[0].deliveryStatus, 'failed');
});

test('site.deleted does not emit an actorless event', async () => {
  const requests = [];
  const store = await createWebhookStore('site.deleted');
  const env = {
    WEBHOOK_URL_ENCRYPTION_KEY: ENCRYPTION_KEY,
    resolveWebhookHost: async () => ['8.8.8.8'],
    WEBHOOK_FETCH: async (request) => {
      requests.push(request);
      return new Response('ok', { status: 200 });
    },
    now: () => '2026-08-07T12:00:00.000Z',
    nextId: (prefix) => `${prefix}_1`,
  };

  await emitSiteDeletedWebhook({
    store,
    env,
    config: { environment: ENVIRONMENT },
    site: { id: 'site_1', slug: 'demo', ownerType: 'user' },
    previousRoute: { visibility: 'org', hostname: 'demo.pages.xd.team', routeStatus: 'active' },
    route: { visibility: 'disabled', hostname: 'demo.pages.xd.team', routeStatus: 'deleted' },
  });

  assert.equal(requests.length, 0);
  assert.equal(store.recordedDeliveries.length, 0);
});

test('team lookup failure omits optional team data without dropping lifecycle events', async () => {
  const cases = [
    {
      eventType: 'site.disabled',
      emit: (store, env) =>
        emitSiteDisabledWebhook({
          store,
          env,
          config: { environment: ENVIRONMENT },
          actor: { userId: 'usr_1', email: 'owner@example.com' },
          site: { id: 'site_1', slug: 'demo', ownerType: 'team', ownerId: 'team_1' },
          previousRoute: { visibility: 'org', hostname: 'demo.pages.xd.team', routeStatus: 'active' },
          route: { visibility: 'disabled', hostname: 'demo.pages.xd.team', routeStatus: 'disabled' },
        }),
    },
    {
      eventType: 'site.deleted',
      emit: (store, env) =>
        emitSiteDeletedWebhook({
          store,
          env,
          config: { environment: ENVIRONMENT },
          actor: { userId: 'usr_1', email: 'owner@example.com' },
          site: { id: 'site_1', slug: 'demo', ownerType: 'team', ownerId: 'team_1' },
          previousRoute: { visibility: 'org', hostname: 'demo.pages.xd.team', routeStatus: 'active' },
          route: { visibility: 'disabled', hostname: 'demo.pages.xd.team', routeStatus: 'deleted' },
        }),
    },
    {
      eventType: 'site.failed',
      emit: (store, env) =>
        emitSiteFailedWebhook({
          store,
          env,
          config: { environment: ENVIRONMENT },
          actor: { userId: 'usr_1', email: 'owner@example.com' },
          site: {
            id: 'site_1',
            slug: 'demo',
            ownerType: 'team',
            ownerId: 'team_1',
            route: { visibility: 'org', hostname: 'demo.pages.xd.team', routeStatus: 'active' },
          },
          deployment: {
            id: 'dep_1',
            status: 'failed',
            source: 'cli',
            operation: 'deploy',
            createdAt: '2026-08-07T11:59:00.000Z',
            completedAt: '2026-08-07T12:00:00.000Z',
            failureStage: 'upload',
            errorCode: 'UPLOAD_FAILED',
          },
        }),
    },
  ];

  for (const { eventType, emit } of cases) {
    const requests = [];
    const store = await createWebhookStore(eventType);
    store.getTeam = async () => {
      throw new Error('team lookup unavailable');
    };
    const env = {
      WEBHOOK_URL_ENCRYPTION_KEY: ENCRYPTION_KEY,
      resolveWebhookHost: async () => ['8.8.8.8'],
      WEBHOOK_FETCH: async (request) => {
        requests.push(request);
        return new Response('ok', { status: 200 });
      },
      now: () => '2026-08-07T12:00:00.000Z',
      nextId: (prefix) => `${prefix}_1`,
    };

    await emit(store, env);

    assert.equal(requests.length, 1, eventType);
    const payload = await requests[0].json();
    assert.equal(payload.event.type, eventType);
    assert.equal('team' in payload, false);
    assert.equal(payload.site.id, 'site_1');
  }
});

async function createWebhookStore(eventType) {
  const subscription = {
    id: 'wh_1',
    environment: ENVIRONMENT,
    events: [eventType],
    enabled: true,
    payloadMode: 'standard',
    restrictedTemplate: null,
    encryptedUrlCiphertext: await encryptWebhookUrlForTest('https://hooks.example.test/hook'),
    urlHost: 'hooks.example.test',
  };
  const store = {
    recordedDeliveries: [],
    updatedDeliveries: [],
    async listWebhookSubscriptions() {
      return [{ ...subscription }];
    },
    async getWebhookSubscription() {
      return { ...subscription };
    },
    async recordWebhookDelivery(input) {
      const delivery = { ...input };
      this.recordedDeliveries.push(delivery);
      return delivery;
    },
    async updateWebhookDelivery(id, patch) {
      const delivery = { id, ...patch };
      this.updatedDeliveries.push(delivery);
      return delivery;
    },
  };
  return store;
}

async function encryptWebhookUrlForTest(value) {
  const material = new globalThis.TextEncoder().encode(ENCRYPTION_KEY);
  const digest = await crypto.subtle.digest('SHA-256', material);
  const key = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt']);
  const iv = new Uint8Array(12).fill(7);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new globalThis.TextEncoder().encode(value))
  );
  return `v1:${base64UrlEncode(iv)}:${base64UrlEncode(encrypted)}`;
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
