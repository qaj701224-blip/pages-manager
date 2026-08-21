import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isSiteVisibility,
  mergeSiteAclEntries,
  normalizeSiteAclEntries,
  previousRouteExposure,
  removeSiteAclEntries,
  sitePolicyExpected,
  sitePolicyRouteCanBeCompensated,
  teamOwnerSupportsVisibility,
} from './access-policy.js';

test('site visibility and ownership rules stay transport independent', () => {
  assert.equal(isSiteVisibility('acl'), true);
  assert.equal(isSiteVisibility('public'), false);
  assert.equal(teamOwnerSupportsVisibility({ ownerType: 'team' }, 'owner'), false);
  assert.equal(teamOwnerSupportsVisibility({ ownerType: 'user' }, 'owner'), true);
  assert.equal(previousRouteExposure({ exposure: 'public' }), 'public');
  assert.equal(previousRouteExposure({ exposure: 'unexpected' }), 'internal');
});

test('ACL normalization canonicalizes and deduplicates supported subjects', () => {
  let id = 0;
  const entries = normalizeSiteAclEntries(
    [
      { subjectType: ' EMAIL ', subjectValue: ' Alice@Example.COM ' },
      { subjectType: 'email', subjectValue: 'alice@example.com', accessRole: 'viewer' },
      { subjectType: 'department', subjectValue: ' 心动 / 技术平台部 ' },
    ],
    { createId: () => `acl_${++id}` }
  );

  assert.deepEqual(entries, [
    {
      id: 'acl_1',
      subjectType: 'email',
      subjectValue: 'alice@example.com',
      accessRole: 'viewer',
      effect: 'allow',
    },
    {
      id: 'acl_2',
      subjectType: 'department',
      subjectValue: '心动/技术平台部',
      accessRole: 'viewer',
      effect: 'allow',
    },
  ]);
});

test('ACL rules expose stable domain codes and enforce the merged collection limit', () => {
  assert.throws(
    () => normalizeSiteAclEntries([{ subjectType: 'user', subjectValue: 'usr_1' }], { createId: () => 'acl_1' }),
    (error) => error.code === 'ACL_SUBJECT_TYPE_UNSUPPORTED'
  );
  const existing = Array.from({ length: 200 }, (_, index) => ({
    id: `acl_${index}`,
    subjectType: 'email',
    subjectValue: `user-${index}@example.com`,
    effect: 'allow',
    accessRole: 'viewer',
  }));
  assert.throws(
    () =>
      mergeSiteAclEntries(existing, [
        {
          id: 'acl_new',
          subjectType: 'email',
          subjectValue: 'new@example.com',
          effect: 'allow',
          accessRole: 'viewer',
        },
      ]),
    (error) => error.code === 'ACL_ENTRIES_INVALID' && error.reason === 'merged_limit'
  );
  assert.equal(removeSiteAclEntries(existing, [existing[0]]).length, 199);
});

test('route compensation requires the exact committed authority state', () => {
  const route = {
    id: 'route_1',
    environment: 'production',
    siteId: 'site_1',
    exposure: 'internal',
    accessMode: 'org',
    visibility: 'org',
    policyVersion: 2,
    routeGeneration: 3,
    activeVersionId: 'version_1',
    runtimeConfigGeneration: 4,
    routeStatus: 'active',
  };
  assert.deepEqual(sitePolicyExpected(route), {
    policyVersion: 2,
    routeGeneration: 3,
    activeVersionId: 'version_1',
    runtimeConfigGeneration: 4,
  });
  assert.equal(sitePolicyRouteCanBeCompensated(route, { ...route }), true);
  assert.equal(sitePolicyRouteCanBeCompensated({ ...route, policyVersion: 3 }, route), false);
});
