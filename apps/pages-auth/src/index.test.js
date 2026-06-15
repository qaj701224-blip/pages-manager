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
