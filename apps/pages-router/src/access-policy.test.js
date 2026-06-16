import assert from 'node:assert/strict';
import test from 'node:test';

import { evaluateAccessPolicy } from './access-policy.js';

test('public visibility allows anonymous access', () => {
  assert.deepEqual(evaluateAccessPolicy(route({ visibility: 'public' }), null), {
    ok: true,
    user: null,
  });
});

test('disabled visibility always denies before identity checks', () => {
  assert.deepEqual(evaluateAccessPolicy(route({ visibility: 'disabled' }), activeUser()), {
    ok: false,
    code: 'SITE_DISABLED',
    status: 403,
  });
});

test('protected visibilities require a site session', () => {
  assert.deepEqual(evaluateAccessPolicy(route({ visibility: 'org' }), null), {
    ok: false,
    code: 'SITE_SESSION_REQUIRED',
    status: 302,
  });
});

test('org visibility requires an active employee', () => {
  assert.equal(evaluateAccessPolicy(route({ visibility: 'org' }), activeUser()).ok, true);
  assert.deepEqual(evaluateAccessPolicy(route({ visibility: 'org' }), activeUser({ employeeStatus: 'left' })), {
    ok: false,
    code: 'SITE_ACCESS_FORBIDDEN',
    status: 403,
  });
});

test('owner visibility requires active site owner', () => {
  assert.equal(
    evaluateAccessPolicy(route({ visibility: 'owner', ownerUserId: 'usr_1' }), activeUser({ userId: 'usr_1' })).ok,
    true
  );
  assert.deepEqual(evaluateAccessPolicy(route({ visibility: 'owner', ownerUserId: 'usr_1' }), activeUser({ userId: 'usr_2' })), {
    ok: false,
    code: 'SITE_ACCESS_FORBIDDEN',
    status: 403,
  });
});

test('acl visibility uses allow-only OR entries for email and department', () => {
  const aclRoute = route({
    visibility: 'acl',
    acl: [
      { effect: 'allow', subjectType: 'email', subjectValue: 'alice@example.com' },
      { effect: 'allow', subjectType: 'department', subjectValue: 'dept_design' },
    ],
  });

  assert.equal(evaluateAccessPolicy(aclRoute, activeUser({ email: 'alice@example.com' })).ok, true);
  assert.equal(evaluateAccessPolicy(aclRoute, activeUser({ departments: ['dept_design'] })).ok, true);
  assert.deepEqual(
    evaluateAccessPolicy(aclRoute, activeUser({ userId: 'usr_2', email: 'bob@example.com', departments: ['dept_eng'] })),
    {
      ok: false,
      code: 'SITE_ACCESS_FORBIDDEN',
      status: 403,
    }
  );
});

test('acl visibility does not match internal user id subjects', () => {
  const aclRoute = route({
    visibility: 'acl',
    acl: [{ effect: 'allow', subjectType: 'user', subjectValue: 'usr_9' }],
  });

  assert.deepEqual(evaluateAccessPolicy(aclRoute, activeUser({ userId: 'usr_9' })), {
    ok: false,
    code: 'SITE_ACCESS_FORBIDDEN',
    status: 403,
  });
});

test('acl visibility fails closed for empty email subjects', () => {
  const aclRoute = route({
    visibility: 'acl',
    acl: [{ effect: 'allow', subjectType: 'email', subjectValue: '' }],
  });

  assert.deepEqual(evaluateAccessPolicy(aclRoute, activeUser({ email: '' })), {
    ok: false,
    code: 'SITE_ACCESS_FORBIDDEN',
    status: 403,
  });
});

test('site session is stale when site, policy, or user session version mismatches', () => {
  assert.deepEqual(evaluateAccessPolicy(route({ siteId: 'site_1' }), activeUser({ siteId: 'site_2' })), {
    ok: false,
    code: 'SITE_SESSION_STALE',
    status: 302,
  });
  assert.deepEqual(evaluateAccessPolicy(route({ policyVersion: 2 }), activeUser({ policyVersion: 1 })), {
    ok: false,
    code: 'SITE_SESSION_STALE',
    status: 302,
  });
  assert.deepEqual(evaluateAccessPolicy(route({ requiredSessionVersion: 3 }), activeUser({ sessionVersion: 2 })), {
    ok: false,
    code: 'SITE_SESSION_STALE',
    status: 302,
  });
  assert.equal(evaluateAccessPolicy(route({ requiredSessionVersion: 3 }), activeUser({ sessionVersion: 4 })).ok, true);
});

function route(overrides = {}) {
  return {
    siteId: 'site_1',
    visibility: 'org',
    policyVersion: 1,
    requiredSessionVersion: 1,
    ownerUserId: 'owner_1',
    acl: [],
    ...overrides,
  };
}

function activeUser(overrides = {}) {
  return {
    userId: 'usr_1',
    siteId: 'site_1',
    policyVersion: 1,
    sessionVersion: 1,
    employeeStatus: 'active',
    email: 'user@example.com',
    departments: [],
    ...overrides,
  };
}
