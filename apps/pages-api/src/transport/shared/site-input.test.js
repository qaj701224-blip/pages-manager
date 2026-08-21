import assert from 'node:assert/strict';
import test from 'node:test';

import {
  normalizeSiteAclInput,
  normalizeSiteSlug,
  rejectUserExposureMutation,
  validateSiteSlugInput,
} from './site-input.js';

test('site input helpers preserve slug normalization and validation responses', async () => {
  assert.equal(normalizeSiteSlug('  Demo-Site  '), 'demo-site');
  assert.equal(validateSiteSlugInput('demo-site', 'production'), null);
  const response = validateSiteSlugInput('A', 'production');
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'SITE_SLUG_INVALID');
});

test('site input helpers preserve admin-only exposure and ACL mapping', async () => {
  const exposureResponse = rejectUserExposureMutation({ exposure: 'public' });
  assert.equal(exposureResponse.status, 403);
  assert.equal((await exposureResponse.json()).error.code, 'SITE_EXPOSURE_ADMIN_REQUIRED');

  const entries = normalizeSiteAclInput(
    [{ subjectType: 'email', subjectValue: 'USER@EXAMPLE.COM' }],
    { nextId: () => 'acl_1' }
  );
  assert.deepEqual(entries, [
    {
      id: 'acl_1',
      subjectType: 'email',
      subjectValue: 'user@example.com',
      accessRole: 'viewer',
      effect: 'allow',
    },
  ]);
});
