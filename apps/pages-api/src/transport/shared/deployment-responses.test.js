import assert from 'node:assert/strict';
import test from 'node:test';

import { deploySiteResolutionErrorResponse, rollbackSiteResolutionErrorResponse } from './deployment-responses.js';

test('rollback site resolution errors map to stable public responses', async () => {
  const cases = [
    ['VERSION_NOT_FOUND', 404, 'Check the version id.'],
    ['SITE_NOT_FOUND', 404, 'Check the site slug.'],
    ['ROLLBACK_SITE_MISMATCH', 409, 'Check the site name and version id.'],
    ['ROLLBACK_FORBIDDEN', 403, 'Use a token scoped to this site.'],
  ];

  for (const [code, status, action] of cases) {
    const response = rollbackSiteResolutionErrorResponse({ code });
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.error.code, code);
    assert.equal(body.error.action, action);
  }
});

test('rollback site resolution response mapping fails closed for unknown errors', () => {
  assert.throws(() => rollbackSiteResolutionErrorResponse({ code: 'UNKNOWN' }), /Unknown rollback site resolution error/);
});

test('deploy site resolution errors preserve public status, code, and action variants', async () => {
  const cases = [
    ['SITE_NOT_FOUND_BY_ID', 404, 'SITE_NOT_FOUND', 'Check the site id.'],
    ['SITE_NOT_FOUND_BY_SLUG', 404, 'SITE_NOT_FOUND', 'Check the site slug.'],
    ['SITE_NOT_FOUND_BY_SLUG_SCOPE', 404, 'SITE_NOT_FOUND', 'Check the site slug and access key scope.'],
    ['SITE_SLUG_RESERVED', 400, 'SITE_SLUG_RESERVED', '该站点名是 XD Cell 平台保留项，请换一个业务站点名。'],
    [
      'SITE_SLUG_INVALID',
      400,
      'SITE_SLUG_INVALID',
      'Use 2-50 lowercase letters, numbers, and hyphens; the first and last characters must be alphanumeric.',
    ],
    [
      'DEPLOY_TRANSFER_FORBIDDEN_CURRENT',
      403,
      'DEPLOY_FORBIDDEN',
      'Use a publisher/admin role or owner-scoped access key for the current site.',
    ],
    ['DEPLOY_TRANSFER_FORBIDDEN_TARGET', 403, 'DEPLOY_FORBIDDEN', 'Use an owner-scoped access key for the target team.'],
    ['TEAM_REQUIRED', 400, 'TEAM_REQUIRED', 'Choose a team.'],
    ['TEAM_NOT_FOUND', 404, 'TEAM_NOT_FOUND', 'Check the team id.'],
    ['TEAM_PUBLISHER_REQUIRED', 403, 'TEAM_PUBLISHER_REQUIRED', 'Ask a team publisher to deploy this site.'],
    ['SITE_TRANSFER_UNSUPPORTED', 503, 'SITE_TRANSFER_UNSUPPORTED', 'Retry later.'],
    [
      'TEAM_OWNER_VISIBILITY_UNSUPPORTED',
      400,
      'SITE_VISIBILITY_INVALID',
      'Use internal, org, acl, or disabled for team-owned sites.',
    ],
    ['DEPLOY_FORBIDDEN_SCOPE', 403, 'DEPLOY_FORBIDDEN', 'Use a token scoped to deploy sites.'],
    ['DEPLOY_FORBIDDEN_TEAM_OWNER', 403, 'DEPLOY_FORBIDDEN', 'Use a user CLI token or an owner-scoped access key for this team.'],
    ['DEPLOY_FORBIDDEN_INACTIVE_OWNER', 403, 'DEPLOY_FORBIDDEN', 'Use an active owner-scoped access key.'],
  ];

  for (const [internalCode, status, publicCode, action] of cases) {
    const response = deploySiteResolutionErrorResponse({ code: internalCode });
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.error.code, publicCode);
    assert.equal(body.error.action, action);
  }
});

test('deploy site resolution response mapping fails closed for unknown errors', () => {
  assert.throws(() => deploySiteResolutionErrorResponse({ code: 'UNKNOWN' }), /Unknown deploy site resolution error/);
});
