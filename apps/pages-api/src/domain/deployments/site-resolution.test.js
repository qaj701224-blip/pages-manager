import assert from 'node:assert/strict';
import test from 'node:test';

import { validateNewDeploymentSiteSlug } from './site-resolution.js';

test('new deployment site slug validation distinguishes valid, reserved, and invalid names', () => {
  assert.deepEqual(validateNewDeploymentSiteSlug('new-guide', 'production'), { ok: true });
  assert.deepEqual(validateNewDeploymentSiteSlug('openapi', 'production'), {
    ok: false,
    error: { code: 'SITE_SLUG_RESERVED' },
  });
  assert.deepEqual(validateNewDeploymentSiteSlug('a', 'production'), {
    ok: false,
    error: { code: 'SITE_SLUG_INVALID' },
  });
});
