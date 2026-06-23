import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.js';
import { buildOpenApi } from './openapi.js';

test('builds production XD Pages OpenAPI skeleton for development checks', () => {
  const body = buildOpenApi({
    environment: 'production',
    apiBaseUrl: 'https://api.pages.xd.team',
    authBaseUrl: 'https://auth.pages.xd.team',
    siteDomainSuffix: 'pages.xd.team',
  });
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
  assert.equal(
    body.paths['/.xd-pages/api/auth/whoami'].get.responses[200].content['application/json'].schema.$ref,
    '#/components/schemas/WhoamiResponse'
  );
  assert.ok(body.paths['/.xd-pages/api/deployments']);
  assert.ok(body.paths['/.xd-pages/api/deployments/{id}']);
  assert.ok(body.paths['/.xd-pages/api/versions/{id}/rollback']);
  assert.ok(body.components.schemas.WhoamiResponse);
  assert.deepEqual(body.components.schemas.WhoamiActor.oneOf[0].required, [
    'type',
    'credentialType',
    'userId',
    'email',
    'name',
    'scopes',
  ]);
  assert.deepEqual(body.components.schemas.WhoamiActor.oneOf[1].required, [
    'type',
    'credentialType',
    'accessKeyId',
    'userId',
    'email',
    'name',
    'siteId',
    'scopes',
  ]);
  assert.ok(body.components.schemas.CliManagedDeploymentRequest);
  assert.ok(body.components.schemas.DeploymentDecision);
  assert.equal(body.paths['/.xd-pages/api/deployments'].post.requestBody.content['application/json'], undefined);
  assert.equal(
    body.paths['/.xd-pages/api/versions/{id}/rollback'].post.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/RollbackRequest'
  );
  assert.ok(body.paths['/.xd-pages/api/deployments'].post.requestBody.content['multipart/form-data']);
  assert.equal(
    body.paths['/.xd-pages/api/deployments'].post.requestBody.content['multipart/form-data'].schema.$ref,
    '#/components/schemas/CliManagedDeploymentRequest'
  );
  assert.deepEqual(body.paths['/.xd-pages/api/deployments'].post['x-error-codes'], [
    'ASSET_MANIFEST_INVALID',
    'ASSET_FILES_REQUIRED',
    'CLI_UPLOAD_PROTOCOL_REQUIRED',
    'CONTENT_HASH_MISMATCH',
    'PUBLISH_PLAN_INVALID',
    'PUBLISH_PLAN_VERSION_UNSUPPORTED',
    'FALLBACK_REQUIRES_ASSETS',
    'INVALID_MULTIPART',
    'PAYLOAD_TOO_LARGE',
    'SITE_REQUIRED',
    'SITE_SLUG_INVALID',
    'SITE_SLUG_RESERVED',
    'DEPLOYMENT_PLATFORM_CONFIG_INVALID',
    'DEPLOYMENT_UPLOAD_FAILED',
    'DEPLOYMENT_VERIFY_FAILED',
    'DEPLOYMENT_STATE_WRITE_FAILED',
    'DEPLOYMENT_CAPACITY_EXHAUSTED',
    'ROUTE_SNAPSHOT_WRITE_FAILED',
    'IDEMPOTENCY_CONFLICT',
  ]);
  assert.deepEqual(body.components.schemas.SiteAclEntry.properties.effect.enum, ['allow']);
  assert.deepEqual(body.components.schemas.SiteAclEntry.properties.subjectType.enum, ['email', 'department']);
  assert.deepEqual(body.components.schemas.SiteVisibility.enum, ['internal', 'org', 'acl', 'owner', 'disabled']);
  assert.equal(serialized.includes('artifactKind'), false);
  assert.equal(serialized.includes('publishPlan'), false);
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

test('does not serve OpenAPI as public pages-api routes', async () => {
  for (const path of ['/openapi.json', '/.xd-pages/api/openapi.json']) {
    const publicResponse = await worker.fetch(new Request(`https://api.pages.xd.team${path}`), {
      PAGES_ENV: 'production',
      IP_ALLOWLIST: '10.0.0.0/8',
    });

    assert.equal(publicResponse.status, 403);
    assert.equal((await publicResponse.json()).error.code, 'IP_NOT_ALLOWED');

    const response = await worker.fetch(new Request(`https://api.pages.xd.team${path}`, {
      headers: { 'CF-Connecting-IP': '10.1.2.3' },
    }), {
      PAGES_ENV: 'production',
      IP_ALLOWLIST: '10.0.0.0/8',
    });

    assert.equal(response.status, 404);
    assert.equal((await response.json()).error.code, 'NOT_FOUND');
  }
});

test('staging OpenAPI contract uses staging server URL without v1 addresses', () => {
  const body = buildOpenApi({
    environment: 'staging',
    apiBaseUrl: 'https://api-staging.pages.xd.team',
    authBaseUrl: 'https://auth-staging.pages.xd.team',
    siteDomainSuffix: 'pages.xd.team',
  });

  assert.deepEqual(body.servers, [{ url: 'https://api-staging.pages.xd.team' }]);
  assert.doesNotMatch(JSON.stringify(body), /workers\.xd\.team/);
});

test('legacy token headers are rejected before route matching', async () => {
  const response = await worker.fetch(new Request('https://api.pages.xd.team/.xd-pages/api/sites', {
    headers: { 'X-Pages-Token': 'legacy' },
  }), {
    PAGES_ENV: 'production',
  });

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'LEGACY_TOKEN_UNSUPPORTED');
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
  assert.match(body, /pages detect <dir> --json/);
  assert.match(body, /pages deploy <dir> <site>/);
  assert.match(body, /--token <token>/);
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
  assert.doesNotMatch(body, /--access-key|curl|X-Pages-Token|api\.workers\.xd\.team|workers\.xd\.team/);
  assert.doesNotMatch(body, /client_secret|CF_API_TOKEN|CLOUDFLARE/i);
});

test('serves staging skill with explicit staging CLI environment', async () => {
  const response = await worker.fetch(new Request('https://api-staging.pages.xd.team/skill.md'), {
    PAGES_ENV: 'staging',
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /pages env staging/);
  assert.match(body, /pages login --env staging/);
  assert.match(body, /pages detect <dir> --json/);
  assert.match(body, /pages deploy <dir> <site> --env staging --dry-run --json/);
  assert.match(body, /pages deploy <dir> <site> --env staging --visibility org/);
  assert.match(body, /pages deploy <dir> <site> --env staging --token <token> --json/);
  assert.doesNotMatch(body, /api\.pages\.xd\.team(?![\\w.-])/);
  assert.doesNotMatch(body, /workers\.xd\.team/);
});

test('serves readme docs without legacy API addresses', async () => {
  const response = await worker.fetch(new Request('https://api-staging.pages.xd.team/readme.md'), {
    PAGES_ENV: 'staging',
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /text\/markdown/);
  const body = await response.text();
  assert.match(body, /api-staging\.pages\.xd\.team/);
  assert.match(body, /pages login/);
  assert.match(body, /pages detect \.\/dist --json/);
  assert.match(body, /pages deploy \.\/dist demo --visibility org/);
  assert.match(body, /--token <token>/);
  assert.match(body, /--config <file>/);
  assert.doesNotMatch(body, /--access-key|--env|pages env|Environment/);
  assert.doesNotMatch(
    body,
    new RegExp(
      `${['XD Pages ', 'v2'].join('')}|${['--slu', 'g'].join('')}|` +
        `${['--save', '-config'].join('')}|${['\\.pages', '\\.json'].join('')}|PAGES_ACCESS_KEY|\`public\``
    )
  );
  assert.doesNotMatch(body, /X-Pages-Token|api\.workers\.xd\.team|workers\.xd\.team/);
});
