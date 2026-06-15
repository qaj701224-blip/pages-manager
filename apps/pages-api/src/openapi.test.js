import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.js';

test('serves production v2-only OpenAPI skeleton', async () => {
  const response = await worker.fetch(new Request('https://api.pages.xd.team/.xd-pages/api/openapi.json'), {
    PAGES_ENV: 'production',
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  const serialized = JSON.stringify(body);

  assert.equal(body.openapi, '3.1.0');
  assert.deepEqual(body.servers, [{ url: 'https://api.pages.xd.team' }]);
  assert.ok(body.paths['/.xd-pages/api/sites']);
  assert.ok(body.paths['/.xd-pages/api/access-keys']);
  assert.ok(body.paths['/.xd-pages/api/deployments']);
  assert.ok(body.paths['/.xd-pages/api/deployments/{id}']);
  assert.ok(body.paths['/.xd-pages/api/versions/{id}/rollback']);
  assert.doesNotMatch(serialized, /workers\.xd\.team/);
  assert.doesNotMatch(serialized, /X-Pages-Token/);
  assert.doesNotMatch(serialized, /CLOUDFLARE|client_secret|zone_id|account_id/i);
});

test('OpenAPI rejects legacy token headers', async () => {
  const response = await worker.fetch(
    new Request('https://api.pages.xd.team/.xd-pages/api/openapi.json', {
      headers: { 'X-Pages-Token': 'legacy' },
    }),
    {
      PAGES_ENV: 'production',
    }
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'LEGACY_TOKEN_UNSUPPORTED');
});

test('serves staging OpenAPI server URL without v1 addresses', async () => {
  const response = await worker.fetch(new Request('https://api-staging.pages.xd.team/.xd-pages/api/openapi.json'), {
    PAGES_ENV: 'staging',
  });

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).servers, [{ url: 'https://api-staging.pages.xd.team' }]);
});
