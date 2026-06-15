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
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal((await response.json()).error.code, 'AUTH_ENV_INVALID');
});

test('exports Durable Object shell classes', () => {
  assert.equal(typeof OAuthStateDO, 'function');
  assert.equal(typeof CliLoginDO, 'function');
  assert.equal(typeof AuthSessionDO, 'function');
});

test('OAuthStateDO stores, consumes, and rejects repeated consume without leaking secretHash', async () => {
  const durableObject = new OAuthStateDO(createDoState(), {});
  const createResponse = await durableObject.fetch(
    jsonRequest('https://oauth-state-do/create', {
      environment: 'production',
      siteHost: 'demo.pages.xd.team',
      returnTo: 'https://demo.pages.xd.team/app',
      now: 1_800_000_000,
      ttlSeconds: 300,
      stateId: 'ost_test',
      stateSecret: 'state-secret',
    })
  );

  assert.equal(createResponse.status, 200);
  assert.equal(createResponse.headers.get('Cache-Control'), 'no-store');
  const createText = await createResponse.text();
  assert.equal(createText.includes('secretHash'), false);
  assert.equal(JSON.parse(createText).publicState, 'ost_test.state-secret');

  const consumeResponse = await durableObject.fetch(
    jsonRequest('https://oauth-state-do/consume', {
      publicState: 'ost_test.state-secret',
      now: 1_800_000_001,
    })
  );

  assert.equal(consumeResponse.status, 200);
  const consumeText = await consumeResponse.text();
  assert.equal(consumeText.includes('secretHash'), false);
  assert.equal(JSON.parse(consumeText).record.consumedAt, 1_800_000_001);

  const repeatedResponse = await durableObject.fetch(
    jsonRequest('https://oauth-state-do/consume', {
      publicState: 'ost_test.state-secret',
      now: 1_800_000_002,
    })
  );

  assert.equal(repeatedResponse.status, 409);
  assert.equal((await repeatedResponse.json()).error.code, 'STATE_INVALID');
});

test('CliLoginDO confirms and consumes login transactions without leaking secretHash', async () => {
  const durableObject = new CliLoginDO(createDoState(), {});
  const createResponse = await durableObject.fetch(
    jsonRequest('https://cli-login-do/create', {
      environment: 'production',
      now: 1_800_000_000,
      ttlSeconds: 600,
      loginId: 'cli_test',
      loginSecret: 'login-secret',
      deviceCode: '12345678',
    })
  );

  assert.equal(createResponse.status, 200);
  const createText = await createResponse.text();
  assert.equal(createText.includes('secretHash'), false);
  assert.equal(JSON.parse(createText).record.status, 'pending');

  const confirmResponse = await durableObject.fetch(
    jsonRequest('https://cli-login-do/confirm', {
      deviceCode: '12345678',
      userId: 'usr_123',
      now: 1_800_000_001,
    })
  );

  assert.equal(confirmResponse.status, 200);
  assert.equal((await confirmResponse.json()).record.status, 'confirmed');

  const consumeResponse = await durableObject.fetch(
    jsonRequest('https://cli-login-do/consume', {
      loginId: 'cli_test',
      loginSecret: 'login-secret',
      now: 1_800_000_002,
    })
  );

  assert.equal(consumeResponse.status, 200);
  const consumeText = await consumeResponse.text();
  assert.equal(consumeText.includes('secretHash'), false);
  assert.equal(JSON.parse(consumeText).userId, 'usr_123');
});

test('AuthSessionDO creates, refreshes, and revokes session records', async () => {
  const durableObject = new AuthSessionDO(createDoState(), {});
  const createResponse = await durableObject.fetch(
    jsonRequest('https://auth-session-do/create', {
      sid: 'sid_test',
      userId: 'usr_123',
      purpose: 'auth_session',
      now: 1_800_000_000,
      idleTtlSeconds: 120,
      absoluteTtlSeconds: 300,
    })
  );

  assert.equal(createResponse.status, 200);
  assert.equal((await createResponse.json()).expiresAt, 1_800_000_120);

  const refreshResponse = await durableObject.fetch(
    jsonRequest('https://auth-session-do/refresh', {
      sid: 'sid_test',
      now: 1_800_000_100,
      idleTtlSeconds: 120,
    })
  );

  assert.equal(refreshResponse.status, 200);
  assert.equal((await refreshResponse.json()).expiresAt, 1_800_000_220);

  const revokeResponse = await durableObject.fetch(
    jsonRequest('https://auth-session-do/revoke', {
      sid: 'sid_test',
      now: 1_800_000_110,
    })
  );

  assert.equal(revokeResponse.status, 200);
  assert.equal((await revokeResponse.json()).revokedAt, 1_800_000_110);
});

test('Durable Object fetch returns safe no-store errors for unknown paths and invalid JSON', async () => {
  const durableObject = new OAuthStateDO(createDoState(), {});

  const unknownResponse = await durableObject.fetch(jsonRequest('https://oauth-state-do/missing', {}));

  assert.equal(unknownResponse.status, 404);
  assert.equal(unknownResponse.headers.get('Cache-Control'), 'no-store');
  assert.equal((await unknownResponse.json()).error.code, 'NOT_FOUND');

  const invalidJsonResponse = await durableObject.fetch(
    new Request('https://oauth-state-do/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"state":',
    })
  );

  assert.equal(invalidJsonResponse.status, 400);
  assert.equal(invalidJsonResponse.headers.get('Cache-Control'), 'no-store');
  assert.equal((await invalidJsonResponse.json()).error.code, 'INVALID_JSON');
});

function jsonRequest(url, body) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function createDoState() {
  return {
    storage: createFakeStorage(),
  };
}

function createFakeStorage() {
  const records = new Map();
  return {
    async get(key) {
      return clone(records.get(key));
    },
    async put(key, value) {
      records.set(key, clone(value));
    },
    async delete(key) {
      records.delete(key);
    },
  };
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}
