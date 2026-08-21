import assert from 'node:assert/strict';
import test from 'node:test';

import { readApiConfig } from '../config.js';
import { createPagesApiRouter } from './router.js';

const config = readApiConfig({ PAGES_ENV: 'production' });

test('health and preflight routes do not initialize the Store', async () => {
  let storeCalls = 0;
  const router = createPagesApiRouter({
    createStore() {
      storeCalls += 1;
      throw new Error('Store must stay lazy');
    },
  });

  const health = await router(
    new Request('https://api.pages.xd.team/.xd-pages/health'),
    { PAGES_ENV: 'production' },
    undefined,
    config
  );
  const legacy = await router(
    new Request('https://api.pages.xd.team/.xd-pages/api/sites', { headers: { 'X-Pages-Token': 'legacy' } }),
    { PAGES_ENV: 'production' },
    undefined,
    config
  );

  assert.equal(health.status, 200);
  assert.equal(legacy.status, 400);
  assert.equal(storeCalls, 0);
});

test('management routes map Store initialization failures consistently', async () => {
  let storeCalls = 0;
  const router = createPagesApiRouter({
    createStore() {
      storeCalls += 1;
      throw new Error('D1 unavailable');
    },
  });

  const response = await router(
    new Request('https://api.pages.xd.team/.xd-pages/api/sites'),
    { PAGES_ENV: 'production' },
    undefined,
    config
  );

  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, 'API_STORE_UNAVAILABLE');
  assert.equal(storeCalls, 1);
});

test('unknown internal routes initialize the Store only once per request', async () => {
  let storeCalls = 0;
  const router = createPagesApiRouter({
    createStore() {
      storeCalls += 1;
      return {};
    },
  });

  const response = await router(
    new Request('https://pages-api.internal/.xd-pages/internal/unknown'),
    { PAGES_ENV: 'production' },
    undefined,
    config
  );

  assert.equal(response.status, 404);
  assert.equal(storeCalls, 1);
});
