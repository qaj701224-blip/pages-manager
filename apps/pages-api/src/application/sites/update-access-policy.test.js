import assert from 'node:assert/strict';
import test from 'node:test';

import { createUpdateSiteAccessPolicy } from './update-access-policy.js';

test('site access policy use case commits authority and refreshes the active snapshot under one lease', async () => {
  const calls = [];
  const currentRoute = route({ policyVersion: 1, routeGeneration: 2 });
  const committedRoute = route({ policyVersion: 2, routeGeneration: 3, visibility: 'acl' });
  const update = createUpdateSiteAccessPolicy({
    sitePolicy: {
      async withSiteCommitLock(environment, siteId, callback, options) {
        calls.push(['lease', environment, siteId, options]);
        return callback({ lockId: 'lock_1', fencingToken: 2 });
      },
      async getSite() {
        return { id: 'site_1' };
      },
      async getRouteBySiteId() {
        return currentRoute;
      },
      async listSiteAclEntries() {
        return [];
      },
      async updateSiteAccessPolicy(input) {
        calls.push(['update', input]);
        return { site: { id: 'site_1' }, route: committedRoute, aclEntries: input.aclEntries || [] };
      },
    },
    routeSnapshots: {
      async refreshActive(input) {
        calls.push(['snapshot', input]);
      },
    },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
  });

  const result = await update({
    environment: 'production',
    siteId: 'site_1',
    actorUserId: 'usr_1',
    visibility: 'acl',
    resolveAclEntries: () => [{ subjectType: 'email', subjectValue: 'user@example.test' }],
  });

  assert.equal(result.route, committedRoute);
  assert.equal(calls[0][0], 'lease');
  assert.equal(calls[1][0], 'update');
  assert.equal(calls[2][0], 'snapshot');
  assert.equal(calls[1][1].accessMode, 'acl');
  assert.deepEqual(calls[1][1].expected, {
    policyVersion: 1,
    routeGeneration: 2,
    activeVersionId: 'version_1',
    runtimeConfigGeneration: 0,
  });
});

test('site access policy use case compensates the exact committed route after snapshot failure', async () => {
  const currentRoute = route({ policyVersion: 1, routeGeneration: 2, visibility: 'org' });
  const committedRoute = route({ policyVersion: 2, routeGeneration: 3, visibility: 'acl' });
  const compensatedRoute = route({ policyVersion: 3, routeGeneration: 4, visibility: 'org' });
  let routeRead = 0;
  let updateCount = 0;
  let snapshotCount = 0;
  const update = createUpdateSiteAccessPolicy({
    sitePolicy: {
      async withSiteCommitLock(environment, siteId, callback) {
        return callback({ lockId: 'lock_1', fencingToken: 2 });
      },
      async getSite() {
        return { id: 'site_1' };
      },
      async getRouteBySiteId() {
        routeRead += 1;
        return routeRead === 1 ? currentRoute : committedRoute;
      },
      async listSiteAclEntries() {
        return [{ subjectType: 'email', subjectValue: 'old@example.test' }];
      },
      async updateSiteAccessPolicy() {
        updateCount += 1;
        return {
          site: { id: 'site_1' },
          route: updateCount === 1 ? committedRoute : compensatedRoute,
          aclEntries: [],
        };
      },
    },
    routeSnapshots: {
      async refreshActive() {
        snapshotCount += 1;
        if (snapshotCount === 1) throw applicationError('ROUTE_SNAPSHOT_WRITE_FAILED');
      },
    },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
  });

  await assert.rejects(
    update({ environment: 'production', siteId: 'site_1', actorUserId: 'usr_1', visibility: 'acl' }),
    (error) => error.code === 'ROUTE_SNAPSHOT_WRITE_FAILED'
  );
  assert.equal(updateCount, 2);
  assert.equal(snapshotCount, 2);
});

function route(overrides = {}) {
  return {
    id: 'route_1',
    environment: 'production',
    siteId: 'site_1',
    exposure: 'internal',
    accessMode: 'authenticated',
    visibility: 'org',
    policyVersion: 1,
    routeGeneration: 1,
    activeVersionId: 'version_1',
    runtimeConfigGeneration: 0,
    routeStatus: 'active',
    ...overrides,
  };
}

function applicationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
