import assert from 'node:assert/strict';
import test from 'node:test';

import { createFailedDeploymentsRecovery } from './recover-failed-deployments.js';

const site = { id: 'site_1', hostname: 'guide.workers.xd.team' };
const actor = { type: 'user', userId: 'usr_1' };
const marker = {
  deploymentId: 'dep_1',
  operation: 'rollback',
  failedPatch: { errorCode: 'ROUTE_ACTIVATION_CONFLICT' },
};
const deployment = { id: 'dep_1', siteId: 'site_1', status: 'activating' };
const command = { site, actor, environment: 'production' };

function record(markerValue = marker, deleted = []) {
  return {
    marker: markerValue,
    async delete() {
      deleted.push(markerValue?.deploymentId || null);
    },
  };
}

function createDependencies(overrides = {}) {
  return {
    markers: { list: async () => ({ records: [], readError: null }) },
    deployments: { get: async () => deployment },
    commits: { reconcile: async (value) => value },
    traces: { forDeployment: async () => null },
    failures: { complete: async () => ({ ...deployment, status: 'failed' }) },
    telemetry: { recovered: async () => null },
    repairs: { report: () => null },
    ...overrides,
  };
}

test('failed deployment recovery skips pending site creation without reading markers', async () => {
  const application = createFailedDeploymentsRecovery(
    createDependencies({
      markers: { list: async () => assert.fail('markers must not be read') },
    })
  );

  assert.equal(await application.recover({ ...command, site: { ...site, pendingSiteCreation: true } }), undefined);
});

test('failed deployment recovery removes invalid, stale, foreign, and terminal markers', async () => {
  const deleted = [];
  const records = [
    record(null, deleted),
    record({ ...marker, deploymentId: 'missing' }, deleted),
    record({ ...marker, deploymentId: 'foreign' }, deleted),
    record({ ...marker, deploymentId: 'terminal' }, deleted),
  ];
  const application = createFailedDeploymentsRecovery(
    createDependencies({
      markers: { list: async () => ({ records, readError: null }) },
      deployments: {
        async get(deploymentId) {
          if (deploymentId === 'missing') return null;
          if (deploymentId === 'foreign') return { id: deploymentId, siteId: 'site_other', status: 'pending' };
          return { id: deploymentId, siteId: 'site_1', status: 'failed' };
        },
      },
      commits: { reconcile: async () => assert.fail('stale records must not reconcile') },
    })
  );

  await application.recover(command);
  assert.deepEqual(deleted, [null, 'missing', 'foreign', 'terminal']);
});

test('failed deployment recovery completes a nonterminal marker then records compensation before deletion', async () => {
  const calls = [];
  const trace = { traceId: 'dtr_1' };
  const application = createFailedDeploymentsRecovery(
    createDependencies({
      markers: {
        list: async () => ({
          records: [
            {
              marker,
              async delete() {
                calls.push(['delete']);
              },
            },
          ],
          readError: null,
        }),
      },
      deployments: {
        async get(deploymentId, environment) {
          calls.push(['get', deploymentId, environment]);
          return deployment;
        },
      },
      commits: {
        async reconcile(value, environment) {
          calls.push(['reconcile', value, environment]);
          return value;
        },
      },
      traces: {
        async forDeployment(value, environment) {
          calls.push(['trace', value, environment]);
          return trace;
        },
      },
      failures: {
        async complete(input) {
          calls.push(['complete', input]);
          return { ...deployment, status: 'failed' };
        },
      },
      telemetry: {
        async recovered(receivedTrace, input) {
          calls.push(['recovered', receivedTrace, input]);
        },
      },
    })
  );

  await application.recover(command);
  assert.deepEqual(calls.map(([operation]) => operation), [
    'get',
    'reconcile',
    'trace',
    'complete',
    'recovered',
    'delete',
  ]);
  assert.deepEqual(calls[3][1], {
    deploymentId: 'dep_1',
    patch: marker.failedPatch,
    actor,
    site,
    trace,
  });
  assert.deepEqual(calls[4], ['recovered', trace, { operatorAction: 'retry_rollback' }]);
});

test('failed deployment recovery verifies reconciled terminal persistence before deleting the marker', async () => {
  const deleted = [];
  let reads = 0;
  const application = createFailedDeploymentsRecovery(
    createDependencies({
      markers: { list: async () => ({ records: [record(marker, deleted)], readError: null }) },
      deployments: {
        get: async () => (++reads === 1 ? deployment : { ...deployment, status: 'succeeded' }),
      },
      commits: { reconcile: async () => ({ ...deployment, status: 'succeeded' }) },
      failures: { complete: async () => assert.fail('committed deployment must not be failed') },
    })
  );

  await application.recover(command);
  assert.deepEqual(deleted, ['dep_1']);

  const notPersisted = createFailedDeploymentsRecovery(
    createDependencies({
      markers: { list: async () => ({ records: [record()], readError: null }) },
      deployments: { get: async () => deployment },
      commits: { reconcile: async () => ({ ...deployment, status: 'succeeded' }) },
    })
  );
  await assert.rejects(
    () => notPersisted.recover(command),
    (error) =>
      error.code === 'DEPLOYMENT_STATE_WRITE_FAILED' &&
      error.message === 'Reconciled deployment state could not be persisted.'
  );
});

test('failed deployment recovery keeps nonterminal completion markers and preserves state failures', async () => {
  let deleted = false;
  const retained = createFailedDeploymentsRecovery(
    createDependencies({
      markers: {
        list: async () => ({
          records: [{ marker, delete: async () => (deleted = true) }],
          readError: null,
        }),
      },
      failures: { complete: async () => deployment },
    })
  );
  await retained.recover(command);
  assert.equal(deleted, false);

  const cause = new Error('failure persistence unavailable');
  cause.code = 'DEPLOYMENT_STATE_WRITE_FAILED';
  const failed = createFailedDeploymentsRecovery(
    createDependencies({
      markers: { list: async () => ({ records: [record()], readError: null }) },
      failures: {
        complete: async () => {
          throw cause;
        },
      },
    })
  );
  await assert.rejects(() => failed.recover(command), (error) => error === cause);
});

test('failed deployment recovery reports unexpected completion errors without deleting the marker', async () => {
  const completionError = new Error('unexpected completion failure');
  const reports = [];
  let deleted = false;
  const application = createFailedDeploymentsRecovery(
    createDependencies({
      markers: {
        list: async () => ({
          records: [{ marker, delete: async () => (deleted = true) }],
          readError: null,
        }),
      },
      failures: {
        complete: async () => {
          throw completionError;
        },
      },
      repairs: { report: (input) => reports.push(input) },
    })
  );

  await application.recover(command);
  assert.equal(deleted, false);
  assert.deepEqual(reports, [
    {
      environment: 'production',
      siteId: 'site_1',
      deploymentId: 'dep_1',
      reason: 'deployment_failure_state_recovery_failed',
    },
  ]);
});

test('failed deployment recovery processes records before surfacing the marker read error', async () => {
  const readError = new Error('marker page incomplete');
  const deleted = [];
  const application = createFailedDeploymentsRecovery(
    createDependencies({
      markers: {
        list: async () => ({ records: [record(null, deleted)], readError }),
      },
    })
  );

  await assert.rejects(() => application.recover(command), (error) => error === readError);
  assert.deepEqual(deleted, [null]);
});

test('failed deployment recovery classifies deployment and commit state read failures', async () => {
  const stateCause = new Error('deployment store unavailable');
  const stateRead = createFailedDeploymentsRecovery(
    createDependencies({
      markers: { list: async () => ({ records: [record()], readError: null }) },
      deployments: {
        get: async () => {
          throw stateCause;
        },
      },
    })
  );
  await assert.rejects(
    () => stateRead.recover(command),
    (error) =>
      error.code === 'DEPLOYMENT_STATE_WRITE_FAILED' &&
      error.message === 'Deployment state could not be read for recovery.' &&
      error.cause === stateCause
  );

  const commitCause = new Error('route state unavailable');
  const commitRead = createFailedDeploymentsRecovery(
    createDependencies({
      markers: { list: async () => ({ records: [record()], readError: null }) },
      commits: {
        reconcile: async () => {
          throw commitCause;
        },
      },
    })
  );
  await assert.rejects(
    () => commitRead.recover(command),
    (error) =>
      error.code === 'DEPLOYMENT_STATE_WRITE_FAILED' &&
      error.message === 'Deployment commit state could not be read for recovery.' &&
      error.cause === commitCause
  );
});

test('failed deployment recovery requires its narrow capabilities', () => {
  assert.throws(
    () =>
      createFailedDeploymentsRecovery({
        markers: {},
        deployments: {},
        commits: {},
        traces: {},
        failures: {},
        telemetry: {},
        repairs: {},
      }),
    /markers\.list is required/
  );
});
