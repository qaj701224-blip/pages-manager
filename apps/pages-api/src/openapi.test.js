import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.js';

test('serves production XD Pages OpenAPI skeleton', async () => {
  const response = await worker.fetch(new Request('https://api.pages.xd.team/.xd-pages/api/openapi.json'), {
    PAGES_ENV: 'production',
  });

  assert.equal(response.status, 200);
  const body = await response.json();
  const serialized = JSON.stringify(body);

  assert.equal(body.openapi, '3.1.0');
  assert.equal(body.info.title, 'XD Pages API');
  assert.equal(body.info.description, 'Control plane API for XD Pages.');
  assert.deepEqual(body.servers, [{ url: 'https://api.pages.xd.team' }]);
  assert.ok(body.paths['/.xd-pages/api/sites']);
  assert.ok(body.paths['/.xd-pages/api/sites/{id}'].patch);
  assert.ok(body.paths['/.xd-pages/api/sites/{id}/acl'].put);
  assert.ok(body.paths['/.xd-pages/api/sites/{id}/acl/entries'].post);
  assert.ok(body.paths['/.xd-pages/api/sites/{id}/acl/entries'].delete);
  assert.ok(body.paths['/.xd-pages/api/access-keys']);
  assert.ok(body.paths['/.xd-pages/api/auth/whoami']);
  assert.ok(body.paths['/.xd-pages/api/deployments']);
  assert.ok(body.paths['/.xd-pages/api/deployments/{id}']);
  assert.ok(body.paths['/.xd-pages/api/versions/{id}/rollback']);
  assert.ok(body.components.schemas.DeploymentRequest);
  assert.ok(body.components.schemas.ArtifactBundle);
  assert.equal(
    body.paths['/.xd-pages/api/deployments'].post.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/DeploymentRequest'
  );
  assert.ok(body.paths['/.xd-pages/api/deployments'].post.requestBody.content['multipart/form-data']);
  assert.match(JSON.stringify(body.components.schemas.StaticAssetDeploymentRequest), /assetManifest/);
  assert.match(JSON.stringify(body.components.schemas.StaticAssetDeploymentRequest), /file-/);
  assert.deepEqual(body.paths['/.xd-pages/api/deployments'].post['x-error-codes'], [
    'ARTIFACT_BUNDLE_REQUIRED',
    'ARTIFACT_BUNDLE_INVALID',
    'ASSET_MANIFEST_REQUIRED',
    'ASSET_MANIFEST_INVALID',
    'ASSET_FILES_REQUIRED',
    'INVALID_MULTIPART',
    'PAYLOAD_TOO_LARGE',
    'DEPLOYMENT_PLATFORM_CONFIG_INVALID',
    'DEPLOYMENT_UPLOAD_FAILED',
    'DEPLOYMENT_VERIFY_FAILED',
    'DEPLOYMENT_STATE_WRITE_FAILED',
    'DEPLOYMENT_CAPACITY_EXHAUSTED',
    'ROUTE_SNAPSHOT_WRITE_FAILED',
    'IDEMPOTENCY_CONFLICT',
  ]);
  assert.match(JSON.stringify(body.components.schemas.DeploymentRequest), /artifactBundle/);
  assert.match(JSON.stringify(body.components.schemas.DeploymentRequest), /siteSlug/);
  assert.deepEqual(body.components.schemas.SiteAclEntry.properties.effect.enum, ['allow']);
  assert.deepEqual(body.components.schemas.SiteAclEntry.properties.subjectType.enum, ['email', 'department']);
  assert.deepEqual(body.components.schemas.SiteVisibility.enum, ['internal', 'org', 'acl', 'owner', 'disabled']);
  assert.doesNotMatch(
    serialized,
    new RegExp(
      `${['XD Pages ', 'v2'].join('')}|${['--slu', 'g'].join('')}|` +
        `${['--save', '-config'].join('')}|${['\\.pages', '\\.json'].join('')}|public.+公司网络`
    )
  );
  assert.doesNotMatch(serialized, /workers\.xd\.team/);
  assert.doesNotMatch(serialized, /WFP|SLOT|worker slot|execution provider|dispatch namespace|service binding/i);
  assert.doesNotMatch(serialized, /X-Pages-Token/);
  assert.doesNotMatch(serialized, /CLOUDFLARE|client_secret|zone_id|account_id/i);
});

test('serves public OpenAPI at top-level docs path', async () => {
  const response = await worker.fetch(new Request('https://api.pages.xd.team/openapi.json'), {
    PAGES_ENV: 'production',
  });

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).servers, [{ url: 'https://api.pages.xd.team' }]);
});

test('serves CLI-only skill without legacy API instructions', async () => {
  const response = await worker.fetch(new Request('https://api.pages.xd.team/skill.md'), {
    PAGES_ENV: 'production',
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /text\/markdown/);
  const body = await response.text();
  assert.match(body, /name: pages/);
  assert.match(body, /pages login/);
  assert.match(body, /pages deploy <dir> <site>/);
  assert.match(body, /--access-key <access-key>/);
  assert.match(body, /--config pages\.config\.json/);
  assert.match(body, /--json/);
  assert.match(body, /api\.pages\.xd\.team/);
  assert.doesNotMatch(
    body,
    new RegExp(
      `${['XD Pages ', 'v2'].join('')}|${['--slu', 'g'].join('')}|` +
        `${['--save', '-config'].join('')}|${['\\.pages', '\\.json'].join('')}|PAGES_ACCESS_KEY|\`public\``
    )
  );
  assert.doesNotMatch(body, /curl|X-Pages-Token|api\.workers\.xd\.team|workers\.xd\.team/);
  assert.doesNotMatch(body, /client_secret|CF_API_TOKEN|CLOUDFLARE/i);
});

test('serves readme docs without legacy API addresses', async () => {
  const response = await worker.fetch(new Request('https://api-staging.pages.xd.team/readme.md'), {
    PAGES_ENV: 'staging',
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /text\/markdown/);
  const body = await response.text();
  assert.match(body, /api-staging\.pages\.xd\.team/);
  assert.match(body, /pages login --env staging/);
  assert.match(body, /pages deploy \.\/dist demo --env staging --visibility org/);
  assert.match(body, /--access-key <key>/);
  assert.match(body, /--config <file>/);
  assert.doesNotMatch(
    body,
    new RegExp(
      `${['XD Pages ', 'v2'].join('')}|${['--slu', 'g'].join('')}|` +
        `${['--save', '-config'].join('')}|${['\\.pages', '\\.json'].join('')}|PAGES_ACCESS_KEY|\`public\``
    )
  );
  assert.doesNotMatch(body, /X-Pages-Token|api\.workers\.xd\.team|workers\.xd\.team/);
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
