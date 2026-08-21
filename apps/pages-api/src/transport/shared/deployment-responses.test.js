import assert from 'node:assert/strict';
import test from 'node:test';

import { rollbackSiteResolutionErrorResponse } from './deployment-responses.js';

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
