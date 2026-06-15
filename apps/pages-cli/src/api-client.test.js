import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, createApiClient } from './api-client.js';

test('API client sends bearer credential and JSON body with idempotency key', async () => {
  const calls = [];
  const client = createApiClient({
    apiBaseUrl: 'https://api.pages.xd.team',
    authBaseUrl: 'https://auth.pages.xd.team',
    credential: { type: 'cli_token', value: 'cli_secret' },
    fetch: async (request) => {
      calls.push(request);
      return Response.json({ ok: true });
    },
  });

  assert.deepEqual(
    await client.requestApi('POST', '/.xd-pages/api/deployments', { siteId: 'site_1' }, { idempotencyKey: 'idem_1' }),
    { ok: true }
  );

  const request = calls[0];
  assert.equal(request.url, 'https://api.pages.xd.team/.xd-pages/api/deployments');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.get('Authorization'), 'Bearer cli_secret');
  assert.equal(request.headers.get('Idempotency-Key'), 'idem_1');
  assert.equal(request.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(await request.json(), { siteId: 'site_1' });
});

test('API client calls auth base without bearer for login endpoints', async () => {
  const calls = [];
  const client = createApiClient({
    apiBaseUrl: 'https://api.pages.xd.team',
    authBaseUrl: 'https://auth.pages.xd.team',
    fetch: async (request) => {
      calls.push(request);
      return Response.json({ status: 'pending' });
    },
  });

  assert.deepEqual(await client.requestAuth('POST', '/.xd-pages/cli/login/poll', { loginId: 'cli_1' }), {
    status: 'pending',
  });
  assert.equal(calls[0].url, 'https://auth.pages.xd.team/.xd-pages/cli/login/poll');
  assert.equal(calls[0].headers.has('Authorization'), false);
});

test('API client turns safe error envelopes into ApiError', async () => {
  const client = createApiClient({
    apiBaseUrl: 'https://api.pages.xd.team',
    authBaseUrl: 'https://auth.pages.xd.team',
    credential: { type: 'access_key', value: 'xdpak_production_ak_1_secret' },
    fetch: async () =>
      Response.json(
        {
          error: {
            code: 'SITE_NOT_FOUND',
            message: 'Site not found.',
            action: 'Check the site id.',
          },
        },
        { status: 404 }
      ),
  });

  await assert.rejects(
    () => client.requestApi('GET', '/.xd-pages/api/sites/site_1'),
    (error) => {
      assert.equal(error instanceof ApiError, true);
      assert.equal(error.status, 404);
      assert.equal(error.code, 'SITE_NOT_FOUND');
      assert.equal(error.action, 'Check the site id.');
      return true;
    }
  );
});
