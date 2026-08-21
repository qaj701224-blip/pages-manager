import assert from 'node:assert/strict';
import test from 'node:test';

import { createTransferSiteOwner } from './transfer-owner.js';

test('transfer owner use case writes authority, refreshes the route snapshot, and returns the committed route', async () => {
  const calls = [];
  const route = { id: 'route_1', routeStatus: 'active', activeVersionId: 'version_1' };
  const transfer = createTransferSiteOwner({
    siteOwnership: {
      async transferSiteOwner(siteId, input, environment) {
        calls.push(['transfer', siteId, input, environment]);
        return { id: siteId, ownerType: input.ownerType, ownerId: input.ownerId };
      },
      async getRouteBySiteId(siteId, environment) {
        calls.push(['route', siteId, environment]);
        return route;
      },
    },
    routeSnapshots: {
      async refreshActive(input) {
        calls.push(['snapshot', input]);
      },
    },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
  });

  const result = await transfer({
    environment: 'production',
    site: { id: 'site_1', ownerType: 'user', ownerId: 'usr_old' },
    target: { ownerType: 'team', ownerId: 'team_1', ownerUserId: 'usr_1' },
    buildAuditEvent: (updatedAt) => ({ id: 'audit_1', createdAt: updatedAt }),
  });

  assert.equal(result.route, route);
  assert.equal(calls[0][0], 'transfer');
  assert.equal(calls[1][0], 'route');
  assert.equal(calls[2][0], 'snapshot');
  assert.deepEqual(calls[0][2].auditEvent, { id: 'audit_1', createdAt: '2027-01-15T08:00:00.000Z' });
});

test('transfer owner use case restores the previous owner when the caller requests snapshot compensation', async () => {
  const transfers = [];
  const transfer = createTransferSiteOwner({
    siteOwnership: {
      async transferSiteOwner(siteId, input) {
        transfers.push(input);
        return { id: siteId, ownerType: input.ownerType, ownerId: input.ownerId };
      },
      async getRouteBySiteId() {
        return { id: 'route_1', routeStatus: 'active', activeVersionId: 'version_1' };
      },
    },
    routeSnapshots: {
      async refreshActive() {
        throw applicationError('ROUTE_SNAPSHOT_WRITE_FAILED');
      },
    },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
  });

  await assert.rejects(
    transfer({
      environment: 'production',
      site: {
        id: 'site_1',
        ownerType: 'user',
        ownerId: 'usr_old',
        ownerUserId: 'usr_old',
        defaultVisibility: 'org',
      },
      target: { ownerType: 'team', ownerId: 'team_1', ownerUserId: 'usr_1' },
      compensateSnapshotFailure: true,
    }),
    (error) => error.code === 'ROUTE_SNAPSHOT_WRITE_FAILED'
  );
  assert.equal(transfers.length, 2);
  assert.deepEqual(transfers[1], {
    ownerType: 'user',
    ownerId: 'usr_old',
    ownerUserId: 'usr_old',
    defaultVisibility: 'org',
    updatedAt: '2027-01-15T08:00:00.000Z',
  });
});

function applicationError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}
