import assert from 'node:assert/strict';
import test from 'node:test';

import { readApiConfig } from '../infrastructure/config/api-config.js';
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

test('Public Sites exact path maps Store initialization failure once', async () => {
  let storeCalls = 0;
  const router = createPagesApiRouter({
    createStore() {
      storeCalls += 1;
      throw new Error('D1 unavailable');
    },
  });

  const response = await router(
    new Request('https://api.pages.xd.team/.xd-pages/api/public/sites'),
    { PAGES_ENV: 'production' },
    undefined,
    config
  );

  assert.equal(response.status, 500);
  assert.equal((await response.json()).error.code, 'API_STORE_UNAVAILABLE');
  assert.equal(storeCalls, 1);
});

test('Public Sites exact path initializes once while lookalikes stay lazy and return 404', async () => {
  let storeCalls = 0;
  const router = createPagesApiRouter({
    createStore() {
      storeCalls += 1;
      return {};
    },
  });

  const exact = await router(
    new Request('https://api.pages.xd.team/.xd-pages/api/public/sites'),
    { PAGES_ENV: 'production' },
    undefined,
    config
  );
  assert.equal(exact.status, 401);
  assert.equal((await exact.json()).error.code, 'PAGES_AUTH_REQUIRED');
  assert.equal(storeCalls, 1);

  for (const pathname of [
    '/.xd-pages/api/public/sites-extra',
    '/.xd-pages/api/public/sites/extra',
    '/.xd-pages/api/public/anything',
  ]) {
    const response = await router(
      new Request(`https://api.pages.xd.team${pathname}`),
      { PAGES_ENV: 'production' },
      undefined,
      config
    );
    assert.equal(response.status, 404, pathname);
    assert.equal((await response.json()).error.code, 'NOT_FOUND', pathname);
  }
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
