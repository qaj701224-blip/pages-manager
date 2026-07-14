import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.js';
import { buildOpenApi } from './openapi.js';

test('builds production XD Cell OpenAPI skeleton for development checks', () => {
  const body = buildOpenApi({
    environment: 'production',
    apiBaseUrl: 'https://api.pages.xd.team',
    authBaseUrl: 'https://auth.pages.xd.team',
    siteDomainSuffix: 'pages.xd.team',
  });
  const serialized = JSON.stringify(body);

  assert.equal(body.openapi, '3.1.0');
  assert.equal(body.info.title, 'XD Cell API');
  assert.equal(body.info.description, 'Control plane API for XD Cell.');
  assert.deepEqual(body.servers, [{ url: 'https://api.pages.xd.team' }]);
  assert.ok(body.paths['/.xd-pages/api/sites']);
  assert.ok(body.paths['/.xd-pages/api/sites/{id}'].patch);
  assert.ok(body.paths['/.xd-pages/api/sites/{id}'].delete);
  assert.ok(body.paths['/.xd-pages/api/sites/{id}/acl'].put);
  assert.ok(body.paths['/.xd-pages/api/sites/{id}/acl/entries'].post);
  assert.ok(body.paths['/.xd-pages/api/sites/{id}/acl/entries'].delete);
  assert.ok(body.paths['/.xd-pages/api/sites/{site}/secrets'].put);
  assert.ok(body.paths['/.xd-pages/api/sites/{site}/secrets'].delete);
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
    'ownerType',
    'ownerId',
    'siteId',
    'scopes',
  ]);
  assert.equal(
    body.paths['/.xd-pages/api/access-keys'].post.summary,
    'Create a personal access key, optionally scoped to one site'
  );
  assert.ok(body.components.schemas.CliManagedDeploymentRequest);
  assert.equal(body.components.schemas.Team.properties.siteCount.type, 'integer');
  assert.equal(body.components.schemas.Team.properties.memberCount.type, 'integer');
  assert.ok(body.components.schemas.DeploymentDecision);
  assert.deepEqual(body.components.schemas.DeploymentDecision.properties.requestedFallback.enum, [
    'auto',
    'index',
    'not-found',
    'none',
    'single-page-application',
    '404-page',
  ]);
  assert.deepEqual(body.components.schemas.DeploymentDecision.properties.resolvedFallback.enum, [
    'index',
    'not-found',
    'none',
    null,
  ]);
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
    'SITE_NOT_FOUND',
    'SITE_SLUG_INVALID',
    'SITE_SLUG_RESERVED',
    'SITE_SLUG_CONFLICT',
    'SITE_VISIBILITY_INVALID',
    'HOSTNAME_CLAIM_CONFLICT',
    'TEAM_REQUIRED',
    'TEAM_NOT_FOUND',
    'TEAM_PUBLISHER_REQUIRED',
    'DEPLOY_FORBIDDEN',
    'DEPLOYMENT_PLATFORM_CONFIG_INVALID',
    'DEPLOYMENT_UPLOAD_FAILED',
    'DEPLOYMENT_VERIFY_FAILED',
    'DEPLOYMENT_STATE_WRITE_FAILED',
    'DEPLOYMENT_CAPACITY_EXHAUSTED',
    'RUNTIME_VARS_INVALID',
    'RUNTIME_BINDING_NAME_CONFLICT',
    'RUNTIME_BINDINGS_LIMIT_EXCEEDED',
    'RUNTIME_VARS_REQUIRE_WORKER',
    'RUNTIME_CONFIG_CHANGED',
    'RUNTIME_CONFIG_UNSUPPORTED',
    'ROUTE_SNAPSHOT_WRITE_FAILED',
    'IDEMPOTENCY_CONFLICT',
  ]);
  assert.equal(
    body.paths['/.xd-pages/api/sites/{site}/secrets'].put.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/SiteSecretPutRequest'
  );
  assert.equal(
    body.paths['/.xd-pages/api/sites/{site}/secrets'].delete.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/SiteSecretDeleteRequest'
  );
  assert.ok(
    body.paths['/.xd-pages/api/sites/{site}/secrets'].put['x-error-codes'].includes('SECRET_VALUE_TOO_LARGE')
  );
  assert.ok(
    body.paths['/.xd-pages/api/sites/{site}/secrets'].put['x-error-codes'].includes('RUNTIME_CONFIG_CHANGED')
  );
  assert.ok(
    body.paths['/.xd-pages/api/sites/{site}/secrets'].delete['x-error-codes'].includes('RUNTIME_CONFIG_CHANGED')
  );
  assert.ok(body.paths['/.xd-pages/api/access-keys'].post['x-error-codes'].includes('ACCESS_KEY_SITE_FORBIDDEN'));
  assert.ok(body.paths['/.xd-pages/api/access-keys'].post['x-error-codes'].includes('ACCESS_KEY_EXPIRY_INVALID'));
  assert.ok(body.paths['/.xd-pages/api/access-keys'].post['x-error-codes'].includes('ACCESS_KEY_EXPIRY_TOO_LONG'));
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
  assert.doesNotMatch(serialized, /api\.workers\.xd\.team|X-Pages-Token/);
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
  assert.doesNotMatch(JSON.stringify(body), /api\.workers\.xd\.team|X-Pages-Token/);
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
  assert.match(body, /name: xd-cell/);
  assert.match(body, /XD Cell/);
  assert.match(body, /xd-cell login/);
  assert.match(body, /xd-cell detect <entry> --json/);
  assert.match(body, /xd-cell deploy <entry> <site> --dry-run --json/);
  assert.match(body, /xd-cell deploy --config xd-cell\.config\.json/);
  assert.match(body, /XD_CELL_API_TOKEN/);
  assert.match(body, /--token <token>/);
  assert.match(body, /xd-cell secrets put <site> API_TOKEN/);
  assert.match(body, /xd-cell secrets delete <site> API_TOKEN/);
  assert.match(body, /xd-cell sites delete <site> --yes --json/);
  assert.match(body, /删除站点前确认目标；当前 CLI 不提供恢复。/);
  assert.match(body, /assets\.not_found_handling/);
  assert.match(body, /--json/);
  assert.match(body, /api\.pages\.xd\.team/);
  assert.match(body, /pages\.xd\.team/);
  assert.doesNotMatch(
    body,
    new RegExp(
      `${['XD Pages ', 'v2'].join('')}|${['--slu', 'g'].join('')}|` +
        `${['--save', '-config'].join('')}|${['\\.pages', '\\.json'].join('')}|PAGES_ACCESS_KEY|\`public\``
    )
  );
  assert.doesNotMatch(body, /--access-key|curl|X-Pages-Token|api\.workers\.xd\.team/);
  assert.doesNotMatch(body, /--fallback <|xd-cell rollback|xd-cell env|--env staging|secrets list/);
  assert.doesNotMatch(body, /client_secret|CF_API_TOKEN|CLOUDFLARE/i);
  assert.doesNotMatch(body, /DELETE \/\.xd-pages\/api\/sites/);
  assert.doesNotMatch(body, /XD Pages/);
});

test('serves staging skill without exposing user-facing environment switches', async () => {
  const response = await worker.fetch(new Request('https://api-staging.pages.xd.team/skill.md'), {
    PAGES_ENV: 'staging',
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /API: `https:\/\/api-staging\.pages\.xd\.team`/);
  assert.match(body, /Auth: `https:\/\/auth-staging\.pages\.xd\.team`/);
  assert.match(body, /普通 `xd-cell` CLI 默认操作 production/);
  assert.match(body, /staging 公共 skill 只提供能力边界说明/);
  assert.doesNotMatch(body, /xd-cell login/);
  assert.doesNotMatch(body, /xd-cell whoami --json/);
  assert.doesNotMatch(body, /xd-cell detect <entry> --json/);
  assert.doesNotMatch(body, /xd-cell deploy <entry> <site> --dry-run --json/);
  assert.doesNotMatch(body, /xd-cell deploy <entry> <site> --visibility org/);
  assert.doesNotMatch(body, /xd-cell sites delete/);
  assert.doesNotMatch(body, /^xd-cell access (set|grant|revoke)\b/m);
  assert.doesNotMatch(body, /^xd-cell secrets (put|delete)\b/m);
  assert.doesNotMatch(body, /export XD_CELL_API_TOKEN=<token>/);
  assert.doesNotMatch(body, /xd-cell deploy --config xd-cell\.config\.json/);
  assert.doesNotMatch(body, /xd-cell env staging|xd-cell login --env staging|--env staging/);
  assert.doesNotMatch(body, /pages\.config\.json|--fallback <|xd-cell rollback|secrets list/);
  assert.doesNotMatch(body, /api\.pages\.xd\.team(?![\\w.-])/);
  assert.match(body, /pages\.xd\.team/);
  assert.doesNotMatch(body, /api\.workers\.xd\.team/);
});

test('serves production readme with safe site deletion guidance', async () => {
  const response = await worker.fetch(new Request('https://api.pages.xd.team/readme.md'), {
    PAGES_ENV: 'production',
  });

  assert.equal(response.status, 200);
  const body = await response.text();
  assert.match(body, /xd-cell sites delete demo --yes --json/);
  assert.match(body, /删除站点前确认目标；当前 CLI 不提供恢复。/);
});

test('serves readme docs without legacy API addresses', async () => {
  const response = await worker.fetch(new Request('https://api-staging.pages.xd.team/readme.md'), {
    PAGES_ENV: 'staging',
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get('Content-Type'), /text\/markdown/);
  const body = await response.text();
  assert.match(body, /^# XD Cell/m);
  assert.match(body, /api-staging\.pages\.xd\.team/);
  assert.match(body, /pages\.xd\.team/);
  assert.match(body, /普通 `xd-cell` CLI 默认操作 production/);
  assert.match(body, /staging 命令请使用维护流程提供的专用入口/);
  assert.doesNotMatch(body, /xd-cell login/);
  assert.doesNotMatch(body, /xd-cell detect \.\/dist --json/);
  assert.doesNotMatch(body, /xd-cell deploy \.\/dist demo --visibility org/);
  assert.doesNotMatch(body, /xd-cell deploy --config xd-cell\.config\.json/);
  assert.doesNotMatch(body, /xd-cell sites delete/);
  assert.match(body, /XD_CELL_API_TOKEN/);
  assert.doesNotMatch(body, /^xd-cell access (set|grant|revoke)\b/m);
  assert.doesNotMatch(body, /^xd-cell secrets (put|delete)\b/m);
  assert.doesNotMatch(body, /--access-key|--env|xd-cell env|Environment|当前环境/);
  assert.doesNotMatch(body, /--fallback <|xd-cell rollback|secrets list|pages\.config\.json/);
  assert.doesNotMatch(
    body,
    new RegExp(
      `${['XD Pages ', 'v2'].join('')}|${['--slu', 'g'].join('')}|` +
        `${['--save', '-config'].join('')}|${['\\.pages', '\\.json'].join('')}|PAGES_ACCESS_KEY|\`public\``
    )
  );
  assert.doesNotMatch(body, /X-Pages-Token|api\.workers\.xd\.team/);
  assert.doesNotMatch(body, /XD Pages/);
});
