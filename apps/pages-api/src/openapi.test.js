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
  assert.ok(body.components.schemas.AdminUser);
  assert.deepEqual(body.components.schemas.AdminUsersResponse.required, ['users', 'pagination']);
  assert.deepEqual(body.components.schemas.AdminUsersResponse.properties.pagination.required, ['total', 'limit', 'offset']);
  assert.ok(body.paths['/.xd-pages/api/sites/{id}'].patch);
  assert.ok(body.paths['/.xd-pages/api/sites/{id}'].delete);
  assert.ok(body.paths['/.xd-pages/api/sites/{id}/metadata'].patch);
  assert.equal(
    body.paths['/.xd-pages/api/sites/{id}/metadata'].patch.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/SiteMetadataUpdateRequest'
  );
  assert.deepEqual(body.components.schemas.SiteMetadataUpdateRequest.properties.title, {
    type: ['string', 'null'],
    pattern: '\\S',
    description:
      'Optional display name. String values are NFC-normalized; control characters and U+2028/U+2029 are rejected, ' +
      'then surrounding whitespace is trimmed and the result must contain 1-80 Unicode code points. ' +
      'Send null to clear it.',
  });
  assert.deepEqual(body.components.schemas.SiteMetadataUpdateRequest.properties.slug, {
    type: 'string',
    description:
      'Canonical site URL slug. Input is trimmed and lowercased before validation; the normalized slug must contain ' +
      '2-50 lowercase ASCII letters, digits, or hyphens, start and end with an alphanumeric character, and not be ' +
      'reserved. The previous URL stops resolving and is released after a safety hold.',
  });
  assert.equal(new RegExp(body.components.schemas.SiteMetadataUpdateRequest.properties.title.pattern, 'u').test('   '), false);
  assert.equal(
    new RegExp(body.components.schemas.SiteMetadataUpdateRequest.properties.title.pattern, 'u').test('产品文档'),
    true
  );
  assert.deepEqual(body.components.schemas.SiteMetadataProjection.required, [
    'id',
    'title',
    'displayName',
    'slug',
    'routingStatus',
    'url',
  ]);
  assert.equal(body.components.schemas.SiteMetadataProjection.additionalProperties, false);
  assert.equal(
    body.paths['/.xd-pages/api/sites/{id}/metadata'].patch.responses[202].content['application/json'].schema.$ref,
    '#/components/schemas/SiteMetadataPendingResponse'
  );
  assert.equal(
    body.paths['/.xd-pages/api/sites/{id}/metadata'].patch.responses[200].description,
    'Site metadata saved; routingStatus may be ready or pending'
  );
  assert.deepEqual(body.paths['/.xd-pages/api/sites/{id}/metadata'].patch['x-error-codes'], [
    'INVALID_JSON',
    'SITE_METADATA_INVALID',
    'SITE_TITLE_INVALID',
    'SITE_SLUG_INVALID',
    'SITE_SLUG_RESERVED',
    'SITE_SLUG_CONFLICT',
    'SITE_METADATA_CONFLICT',
    'SITE_NOT_FOUND',
    'SITE_METADATA_MUTATIONS_DISABLED',
    'SITE_METADATA_UPDATE_FAILED',
  ]);
  assert.equal(
    body.paths['/.xd-pages/api/sites/{id}/metadata'].patch.responses[400].description,
    'Invalid JSON, metadata, title, or slug'
  );
  assert.deepEqual(body.paths['/.xd-pages/api/sites/{id}/metadata'].patch.responses[500], {
    description: 'Site metadata update failed',
  });
  assert.equal(serialized.includes('thumbnail'), false);
  assert.equal(serialized.includes('R2'), false);
  assert.ok(body.paths['/.xd-pages/api/sites/{id}/acl'].get);
  assert.ok(body.paths['/.xd-pages/api/sites/{id}/acl'].put);
  assert.ok(body.paths['/.xd-pages/api/sites/{id}/acl/entries'].post);
  assert.ok(body.paths['/.xd-pages/api/sites/{id}/acl/entries'].delete);
  assert.match(body.components.schemas.SiteVisibility.description, /internal.*anonymous/);
  assert.match(body.components.schemas.SiteVisibility.description, /exposure/);
  assert.ok(body.components.schemas.AdminSiteExposureRequest);
  assert.deepEqual(body.components.schemas.AdminSiteExposureReason.required, ['text', 'changedAt']);
  assert.deepEqual(body.components.schemas.AdminSiteAccess.required, [
    'exposure',
    'accessMode',
    'visibility',
    'aclEntries',
    'exposureReason',
  ]);
  assert.deepEqual(body.paths['/.xd-pages/api/sites/{id}'].patch['x-error-codes'], [
    'SITE_VISIBILITY_INVALID',
    'SITE_EXPOSURE_ADMIN_REQUIRED',
    'SITE_POLICY_FORBIDDEN',
    'SITE_POLICY_CONFLICT',
    'ROUTE_POLICY_REPAIR_REQUIRED',
  ]);
  assert.deepEqual(body.paths['/.xd-pages/api/sites/{id}'].delete['x-error-codes'], [
    'SITE_POLICY_FORBIDDEN',
    'SITE_POLICY_CONFLICT',
    'SITE_NOT_FOUND',
    'ROUTE_SNAPSHOT_WRITE_FAILED',
    'ROUTE_POLICY_REPAIR_REQUIRED',
  ]);
  assert.deepEqual(body.paths['/.xd-pages/api/sites/{id}'].delete.responses[503], {
    description: 'Route snapshot write or recovery failed',
  });
  assert.ok(body.paths['/.xd-pages/api/console/admin/sites/{id}/exposure'].patch);
  assert.equal(
    body.paths['/.xd-pages/api/console/admin/sites/{id}/access'].get.responses[200].content['application/json'].schema.$ref,
    '#/components/schemas/AdminSiteAccessResponse'
  );
  assert.equal(
    body.paths['/.xd-pages/api/console/admin/sites/{id}/exposure'].patch.responses[200].content['application/json'].schema.$ref,
    '#/components/schemas/AdminSiteExposureUpdateResponse'
  );
  assert.equal(
    body.paths['/.xd-pages/api/console/admin/sites/{id}/exposure'].patch['x-error-codes'].includes('SITE_EXPOSURE_AUDIT_FAILED'),
    false
  );
  assert.ok(
    body.paths['/.xd-pages/api/console/admin/sites/{id}/exposure'].patch['x-error-codes'].includes('SITE_EXPOSURE_AUDIT_REQUIRED')
  );
  assert.ok(
    body.paths['/.xd-pages/api/console/admin/sites/{id}/exposure'].patch['x-error-codes'].includes('SITE_PUBLIC_ROUTE_INACTIVE')
  );
  assert.ok(body.paths['/.xd-pages/api/sites/{site}/secrets'].put);
  assert.ok(body.paths['/.xd-pages/api/sites/{site}/secrets'].delete);
  assert.ok(body.paths['/.xd-pages/api/sites/{site}/secrets'].get);
  assert.ok(body.paths['/.xd-pages/api/sites/{site}/vars'].put);
  assert.ok(body.paths['/.xd-pages/api/sites/{site}/vars'].delete);
  assert.ok(body.paths['/.xd-pages/api/sites/{site}/vars'].get);
  assert.ok(body.paths['/.xd-pages/api/access-keys']);
  assert.ok(body.paths['/.xd-pages/api/auth/whoami']);
  assert.equal(body.paths['/.xd-pages/api/s2s/tokens'], undefined);
  assert.equal(body.paths['/.xd-pages/api/s2s/tokens/revoke'], undefined);
  assert.doesNotMatch(JSON.stringify(body), /s2sHmac|S2SToken|X-XD-Cell-S2S/);
  assert.match(body.components.securitySchemes.bearerAuth.description, /connection assertion/);
  assert.doesNotMatch(JSON.stringify(body), /user@example|ou_|xdp_/i);
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
  assert.equal(
    body.components.schemas.CliManagedDeploymentRequest.properties.metadata.contentMediaType,
    'application/json'
  );
  assert.equal(
    body.components.schemas.CliManagedDeploymentRequest.properties.metadata.contentSchema.$ref,
    '#/components/schemas/DeploymentMetadata'
  );
  assert.deepEqual(body.components.schemas.DeploymentMetadata.properties.title.type, ['string', 'null']);
  assert.match(body.components.schemas.CliManagedDeploymentRequest.properties.metadata.description, /optional title/);
  assert.match(body.components.schemas.CliManagedDeploymentRequest.properties.metadata.description, /omit it/);
  assert.match(body.components.schemas.CliManagedDeploymentRequest.properties.metadata.description, /send null to clear/);
  assert.match(body.components.schemas.CliManagedDeploymentRequest.properties.metadata.description, /CLI does not send title/);
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
  assert.deepEqual(Object.keys(body.paths['/.xd-pages/api/deployments'].post.responses).sort(), [
    '201',
    '400',
    '401',
    '403',
    '404',
    '409',
    '413',
    '500',
    '502',
    '503',
  ]);
  assert.deepEqual(Object.keys(body.paths['/.xd-pages/api/versions/{id}/rollback'].post.responses).sort(), [
    '201',
    '400',
    '401',
    '403',
    '404',
    '409',
    '500',
    '503',
  ]);
  for (const response of Object.values(body.paths['/.xd-pages/api/deployments'].post.responses)) {
    assert.equal(response.headers['X-Deployment-Trace-Id'].$ref, '#/components/headers/DeploymentTraceId');
  }
  for (const response of Object.values(body.paths['/.xd-pages/api/versions/{id}/rollback'].post.responses)) {
    assert.equal(response.headers['X-Deployment-Trace-Id'].$ref, '#/components/headers/DeploymentTraceId');
  }
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
    'SITE_TITLE_INVALID',
    'SITE_METADATA_MUTATIONS_DISABLED',
    'SITE_METADATA_CONFLICT',
    'SITE_METADATA_UPDATE_FAILED',
    'SITE_NOT_FOUND',
    'SITE_SLUG_INVALID',
    'SITE_SLUG_RESERVED',
    'SITE_SLUG_CONFLICT',
    'SITE_VISIBILITY_INVALID',
    'HOSTNAME_CLAIM_CONFLICT',
    'SITE_CREATE_UNAVAILABLE',
    'TEAM_REQUIRED',
    'TEAM_NOT_FOUND',
    'TEAM_PUBLISHER_REQUIRED',
    'DEPLOY_FORBIDDEN',
    'DEPLOYMENT_PLATFORM_CONFIG_INVALID',
    'DEPLOYMENT_UPLOAD_FAILED',
    'DEPLOYMENT_VERIFY_FAILED',
    'DEPLOYMENT_STATE_WRITE_FAILED',
    'DEPLOYMENT_REQUEST_FAILED',
    'DEPLOYMENT_CAPACITY_EXHAUSTED',
    'SITE_POLICY_LOCKED',
    'SITE_POLICY_CONFLICT',
    'ROUTE_ACTIVATION_CONFLICT',
    'SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED',
    'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED',
    'RUNTIME_VARS_INVALID',
    'RUNTIME_BINDING_NAME_CONFLICT',
    'RUNTIME_BINDINGS_LIMIT_EXCEEDED',
    'RUNTIME_VARS_REQUIRE_WORKER',
    'RUNTIME_CONFIG_CHANGED',
    'RUNTIME_CONFIG_UNSUPPORTED',
    'ROUTE_SNAPSHOT_WRITE_FAILED',
    'IDEMPOTENCY_CONFLICT',
  ]);
  assert.ok(body.paths['/.xd-pages/api/versions/{id}/rollback'].post['x-error-codes'].includes('ROLLBACK_ACTIVATION_FAILED'));
  assert.ok(body.paths['/.xd-pages/api/versions/{id}/rollback'].post['x-error-codes'].includes('DEPLOYMENT_REQUEST_FAILED'));
  assert.deepEqual(body.paths['/.xd-pages/api/sites'].post['x-error-codes'], [
    'SITE_SLUG_CONFLICT',
    'HOSTNAME_CLAIM_CONFLICT',
    'SITE_CREATE_UNAVAILABLE',
  ]);
  assert.ok(body.paths['/.xd-pages/api/sites/{id}/transfer'].post['x-error-codes'].includes('SITE_POLICY_CONFLICT'));
  assert.ok(body.paths['/.xd-pages/api/sites/{id}/transfer'].post['x-error-codes'].includes('ROUTE_SNAPSHOT_WRITE_FAILED'));
  assert.ok(body.paths['/.xd-pages/api/sites/{id}/transfer'].post['x-error-codes'].includes('ROUTE_POLICY_REPAIR_REQUIRED'));
  assert.deepEqual(body.paths['/.xd-pages/api/sites/{id}/transfer'].post.responses[409], {
    description: 'Site changed concurrently',
  });
  assert.deepEqual(body.paths['/.xd-pages/api/sites/{id}/transfer'].post.responses[503], {
    description: 'Site transfer store, route snapshot write, or recovery unavailable',
  });
  assert.equal(
    body.paths['/.xd-pages/api/sites/{site}/secrets'].put.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/SiteSecretPutRequest'
  );
  assert.equal(
    body.paths['/.xd-pages/api/sites/{site}/secrets'].delete.requestBody.content['application/json'].schema.$ref,
    '#/components/schemas/SiteSecretDeleteRequest'
  );
  assert.equal(
    body.paths['/.xd-pages/api/sites/{site}/secrets'].get.responses[200].content['application/json'].schema.$ref,
    '#/components/schemas/SiteSecretsResponse'
  );
  assert.deepEqual(body.paths['/.xd-pages/api/sites/{site}/secrets'].get['x-error-codes'], [
    'SITE_SLUG_INVALID',
    'SITE_SLUG_RESERVED',
    'SITE_NOT_FOUND',
    'DEPLOY_FORBIDDEN',
    'RUNTIME_CONFIG_UNSUPPORTED',
  ]);
  assert.deepEqual(body.components.schemas.SiteSecretMetadata.required, ['name', 'revision', 'updatedAt']);
  assert.equal(body.components.schemas.SiteSecretMetadata.properties.value, undefined);
  assert.ok(body.paths['/.xd-pages/api/sites/{site}/secrets'].put['x-error-codes'].includes('SECRET_VALUE_TOO_LARGE'));
  assert.ok(body.paths['/.xd-pages/api/sites/{site}/secrets'].put['x-error-codes'].includes('RUNTIME_CONFIG_CHANGED'));
  assert.ok(body.paths['/.xd-pages/api/sites/{site}/secrets'].put['x-error-codes'].includes('RUNTIME_BINDING_NAME_CONFLICT'));
  assert.ok(body.paths['/.xd-pages/api/sites/{site}/secrets'].put['x-error-codes'].includes('RUNTIME_BINDINGS_LIMIT_EXCEEDED'));
  assert.ok(body.paths['/.xd-pages/api/sites/{site}/secrets'].delete['x-error-codes'].includes('RUNTIME_CONFIG_CHANGED'));
  for (const operation of ['put', 'delete']) {
    const errorCodes = body.paths['/.xd-pages/api/sites/{site}/secrets'][operation]['x-error-codes'];
    assert.ok(errorCodes.includes('SITE_SLUG_INVALID'));
    assert.ok(errorCodes.includes('SITE_SLUG_RESERVED'));
  }
  assert.equal(
    body.paths['/.xd-pages/api/sites/{site}/secrets'].delete['x-error-codes'].includes('RUNTIME_BINDING_NAME_CONFLICT'),
    false
  );
  assert.equal(
    body.paths['/.xd-pages/api/sites/{site}/secrets'].delete['x-error-codes'].includes('RUNTIME_BINDINGS_LIMIT_EXCEEDED'),
    false
  );
  assert.deepEqual(body.components.schemas.SiteVarPutRequest.required, ['name', 'value']);
  assert.equal(body.components.schemas.SiteVarPutRequest.additionalProperties, false);
  assert.deepEqual(body.components.schemas.SiteVarDeleteRequest.required, ['name']);
  assert.equal(body.components.schemas.SiteVarDeleteRequest.additionalProperties, false);
  const varsPath = body.paths['/.xd-pages/api/sites/{site}/vars'];
  assert.equal(varsPath.put.requestBody.content['application/json'].schema.$ref, '#/components/schemas/SiteVarPutRequest');
  assert.equal(varsPath.delete.requestBody.content['application/json'].schema.$ref, '#/components/schemas/SiteVarDeleteRequest');
  assert.equal(varsPath.get.responses[200].content['application/json'].schema.$ref, '#/components/schemas/SiteVarsResponse');
  assert.deepEqual(varsPath.get['x-error-codes'], [
    'SITE_SLUG_INVALID',
    'SITE_SLUG_RESERVED',
    'SITE_NOT_FOUND',
    'DEPLOY_FORBIDDEN',
    'RUNTIME_CONFIG_UNSUPPORTED',
  ]);
  assert.deepEqual(body.components.schemas.SiteRuntimeVar.required, ['name', 'value', 'revision', 'updatedAt']);
  assert.match(body.components.schemas.SiteVarPutRequest.properties.value.description, /authorized GET/);
  assert.deepEqual(varsPath.put['x-error-codes'], [
    'INVALID_JSON',
    'RUNTIME_VAR_INVALID',
    'RUNTIME_BINDING_NAME_RESERVED',
    'RUNTIME_VARS_LIMIT_EXCEEDED',
    'RUNTIME_BINDING_NAME_CONFLICT',
    'RUNTIME_BINDINGS_LIMIT_EXCEEDED',
    'SITE_SLUG_INVALID',
    'SITE_SLUG_RESERVED',
    'SITE_NOT_FOUND',
    'DEPLOY_FORBIDDEN',
    'RUNTIME_CONFIG_CHANGED',
    'RUNTIME_CONFIG_UNSUPPORTED',
    'RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED',
  ]);
  assert.deepEqual(varsPath.delete['x-error-codes'], [
    'INVALID_JSON',
    'RUNTIME_VAR_INVALID',
    'RUNTIME_BINDING_NAME_RESERVED',
    'SITE_SLUG_INVALID',
    'SITE_SLUG_RESERVED',
    'SITE_NOT_FOUND',
    'DEPLOY_FORBIDDEN',
    'RUNTIME_CONFIG_CHANGED',
    'RUNTIME_CONFIG_UNSUPPORTED',
    'RUNTIME_VAR_ACTIVE_WORKER_SYNC_FAILED',
  ]);
  assert.deepEqual(Object.keys(varsPath.put.responses).map(Number), [200, 400, 403, 404, 409, 413, 502, 503]);
  assert.deepEqual(Object.keys(varsPath.delete.responses).map(Number), [200, 400, 403, 404, 409, 502, 503]);
  assert.doesNotMatch(JSON.stringify(varsPath.put.responses[200]), /"value"/);
  assert.doesNotMatch(JSON.stringify(varsPath.delete.responses[200]), /"value"/);
  assert.ok(body.paths['/.xd-pages/api/access-keys'].post['x-error-codes'].includes('ACCESS_KEY_SITE_FORBIDDEN'));
  assert.ok(body.paths['/.xd-pages/api/sites/{id}/acl'].get['x-error-codes'].includes('SITE_POLICY_FORBIDDEN'));
  assert.equal(
    body.paths['/.xd-pages/api/sites/{id}/acl'].get.responses[403].description,
    'Access key cannot manage the target site'
  );
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

    assert.equal(publicResponse.status, 404);
    assert.equal((await publicResponse.json()).error.code, 'NOT_FOUND');

    const response = await worker.fetch(
      new Request(`https://api.pages.xd.team${path}`, {
        headers: { 'CF-Connecting-IP': '10.1.2.3' },
      }),
      {
        PAGES_ENV: 'production',
        IP_ALLOWLIST: '10.0.0.0/8',
      }
    );

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
  const response = await worker.fetch(
    new Request('https://api.pages.xd.team/.xd-pages/api/sites', {
      headers: { 'X-Pages-Token': 'legacy' },
    }),
    {
      PAGES_ENV: 'production',
    }
  );

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
