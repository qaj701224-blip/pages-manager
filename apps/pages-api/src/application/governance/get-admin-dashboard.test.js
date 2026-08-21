import assert from 'node:assert/strict';
import test from 'node:test';

import { createAdminDashboardQuery } from './get-admin-dashboard.js';

test('admin dashboard query projects governance counts and a safe deployment summary', async () => {
  const calls = [];
  const application = createAdminDashboardQuery({
    dashboards: {
      async read(input) {
        calls.push(['read', input]);
        return {
          environment: 'production',
          counts: { sites: 1, users: 2, teams: 1, deployments: 1, failedDeployments: 1 },
          resourceCleanup: {
            pendingTasks: 2,
            failedTasks: 1,
            oldestPendingAt: '2026-08-21T00:00:00.000Z',
          },
          failedDeployments: [
            {
              id: 'dep_1',
              siteId: 'site_1',
              siteSlug: 'example',
              ownerType: 'team',
              ownerId: 'team_1',
              ownerDisplayName: 'Example Team',
              ownerTeamType: 'custom',
              actor: {
                type: 'access_key',
                id: 'key_1',
                userId: 'usr_1',
                email: 'owner@example.com',
                displayName: 'Owner',
              },
              status: 'failed',
              source: 'cli',
              operation: 'publish',
              createdAt: '2026-08-21T00:30:00.000Z',
              traceId: 'dtr_1',
              errorCode: 'DEPLOYMENT_UPLOAD_FAILED',
              errorMessage: 'Deployment upload failed.',
              failureStage: 'upload_worker',
              failureDiagnostics: { provider: { name: 'cloudflare_wfp' } },
            },
          ],
        };
      },
    },
    clock: { now: () => '2026-08-21T01:00:00.000Z' },
  });

  assert.deepEqual(await application.get({ environment: 'production' }), {
    environment: 'production',
    counts: { sites: 1, users: 2, teams: 1, deployments: 1, failedDeployments: 1 },
    resourceCleanup: {
      pendingTasks: 2,
      failedTasks: 1,
      oldestPendingAt: '2026-08-21T00:00:00.000Z',
      oldestPendingAgeSeconds: 3600,
      orphanCandidates: null,
      v1Sites: null,
    },
    failedDeployments: [
      {
        id: 'dep_1',
        siteId: 'site_1',
        siteSlug: 'example',
        owner: {
          state: 'persisted',
          type: 'team',
          id: 'team_1',
          email: null,
          displayName: 'Example Team',
          departmentPath: null,
          teamType: 'custom',
        },
        actor: {
          type: 'access_key',
          id: 'key_1',
          userId: 'usr_1',
          email: 'owner@example.com',
          displayName: 'Owner',
        },
        status: 'failed',
        source: 'cli',
        operation: 'publish',
        createdAt: '2026-08-21T00:30:00.000Z',
        traceId: 'dtr_1',
        errorCode: 'DEPLOYMENT_UPLOAD_FAILED',
        errorMessage: 'Deployment upload failed.',
        failureStage: 'upload_worker',
      },
    ],
  });
  assert.deepEqual(calls, [['read', { environment: 'production' }]]);
});

test('admin dashboard query preserves an uncreated site owner and empty cleanup defaults', async () => {
  const application = createAdminDashboardQuery({
    dashboards: {
      read: async () => ({
        environment: 'staging',
        counts: {},
        failedDeployments: [
          {
            id: 'dep_2',
            siteId: 'site_pending',
            ownerState: 'not_created',
            actorType: 'user',
            actorId: 'usr_2',
            actorUserId: 'usr_2',
            status: 'failed',
            createdAt: '2026-08-21T00:00:00.000Z',
          },
        ],
      }),
    },
    clock: { now: () => '2026-08-21T01:00:00.000Z' },
  });

  const dashboard = await application.get({ environment: 'staging' });

  assert.deepEqual(dashboard.resourceCleanup, {
    pendingTasks: 0,
    failedTasks: 0,
    oldestPendingAt: null,
    oldestPendingAgeSeconds: null,
    orphanCandidates: null,
    v1Sites: null,
  });
  assert.deepEqual(dashboard.failedDeployments[0].owner, {
    state: 'not_created',
    type: null,
    id: null,
    email: null,
    displayName: null,
    departmentPath: null,
    teamType: null,
  });
});

test('admin dashboard query requires its narrow ports', () => {
  assert.throws(() => createAdminDashboardQuery({ dashboards: {}, clock: {} }), /dashboards\.read is required/);
});
