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
  assert.ok(body.paths['/.xd-pages/api/sites/{id}'].patch);
  assert.ok(body.paths['/.xd-pages/api/sites/{id}/acl'].put);
  assert.ok(body.paths['/.xd-pages/api/access-keys']);
  assert.ok(body.paths['/.xd-pages/api/deployments']);
  assert.ok(body.paths['/.xd-pages/api/deployments/{id}']);
  assert.ok(body.paths['/.xd-pages/api/versions/{id}/rollback']);
  assert.ok(body.components.schemas.DeploymentRequest);
  assert.ok(body.components.schemas.ArtifactBundle);
  assert.equal(
    body.paths['/.xd-pages/api/deployments'].post.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/DeploymentRequest'
  );
  assert.deepEqual(body.paths['/.xd-pages/api/deployments'].post['x-error-codes'], [
    'ARTIFACT_BUNDLE_REQUIRED',
    'ARTIFACT_BUNDLE_INVALID',
    'PAYLOAD_TOO_LARGE',
    'WFP_CONFIG_INVALID',
    'WFP_UPLOAD_FAILED',
    'WFP_VERIFY_FAILED',
    'ROUTE_SNAPSHOT_WRITE_FAILED',
    'IDEMPOTENCY_CONFLICT',
  ]);
  assert.match(JSON.stringify(body.components.schemas.DeploymentRequest), /artifactBundle/);
  assert.deepEqual(body.components.schemas.SiteAclEntry.properties.effect.enum, ['allow']);
  assert.deepEqual(body.components.schemas.SiteAclEntry.properties.subjectType.enum, ['user', 'email', 'department']);
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
