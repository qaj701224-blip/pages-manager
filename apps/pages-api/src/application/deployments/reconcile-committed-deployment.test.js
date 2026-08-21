import assert from 'node:assert/strict';
import test from 'node:test';

import { createCommittedDeploymentReconciliation } from './reconcile-committed-deployment.js';

const deployment = {
  id: 'dep_1',
  siteId: 'site_1',
  versionId: 'ver_1',
  operation: 'deploy',
  status: 'activating',
  errorCode: 'DEPLOYMENT_STATE_WRITE_FAILED',
};
const command = { deployment, environment: 'production', trace: { traceId: 'dtr_1' } };

function createDependencies(overrides = {}) {
  return {
    state: {
      getVersion: async () => ({ id: 'ver_1', deploymentId: 'dep_1' }),
      getRoute: async () => ({ siteId: 'site_1', activeVersionId: 'ver_1' }),
      updateDeployment: async (deploymentId, patch) => ({ id: deploymentId, ...patch }),
    },
    traces: { forDeployment: async () => null },
    telemetry: {
      reconciled: async () => null,
      persistFailed: async () => null,
    },
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
    ...overrides,
  };
}

test('committed deployment reconciliation skips terminal or incomplete deployment state', async () => {
  const application = createCommittedDeploymentReconciliation(
    createDependencies({
      state: {
        getVersion: async () => assert.fail('state must not be read'),
        getRoute: async () => assert.fail('state must not be read'),
        updateDeployment: async () => assert.fail('state must not be written'),
      },
    })
  );

  for (const value of [
    null,
    { ...deployment, status: 'succeeded' },
    { ...deployment, status: 'failed' },
    { ...deployment, siteId: null },
    { ...deployment, versionId: null },
  ]) {
    assert.equal(await application.reconcile({ ...command, deployment: value }), value);
  }
});

test('committed deployment reconciliation requires the active route and owned deploy version', async () => {
  for (const state of [
    {
      getVersion: async () => ({ id: 'ver_1', deploymentId: 'dep_1' }),
      getRoute: async () => ({ siteId: 'site_1', activeVersionId: 'ver_other' }),
      updateDeployment: async () => assert.fail('uncommitted route must not update'),
    },
    {
      getVersion: async () => ({ id: 'ver_1', deploymentId: 'dep_other' }),
      getRoute: async () => ({ siteId: 'site_1', activeVersionId: 'ver_1' }),
      updateDeployment: async () => assert.fail('foreign deploy version must not update'),
    },
  ]) {
    const application = createCommittedDeploymentReconciliation(createDependencies({ state }));
    assert.equal(await application.reconcile(command), deployment);
  }
});

test('committed deployment reconciliation persists deploy success before recording compensation', async () => {
  const calls = [];
  const reconciled = { ...deployment, status: 'succeeded' };
  const application = createCommittedDeploymentReconciliation(
    createDependencies({
      state: {
        async getVersion(versionId, environment) {
          calls.push(['version', versionId, environment]);
          return { id: versionId, deploymentId: 'dep_1' };
        },
        async getRoute(siteId, environment) {
          calls.push(['route', siteId, environment]);
          return { siteId, activeVersionId: 'ver_1' };
        },
        async updateDeployment(deploymentId, patch) {
          calls.push(['update', deploymentId, patch]);
          return reconciled;
        },
      },
      traces: { forDeployment: async () => assert.fail('explicit trace must be reused') },
      telemetry: {
        async reconciled(trace) {
          calls.push(['reconciled', trace]);
        },
        persistFailed: async () => assert.fail('persistence must succeed'),
      },
    })
  );

  assert.equal(await application.reconcile(command), reconciled);
  assert.deepEqual(calls, [
    ['version', 'ver_1', 'production'],
    ['route', 'site_1', 'production'],
    [
      'update',
      'dep_1',
      {
        status: 'succeeded',
        versionId: 'ver_1',
        completedAt: '2026-08-21T00:00:00.000Z',
      },
    ],
    ['reconciled', command.trace],
  ]);
});

test('committed deployment reconciliation accepts an active rollback version from another deployment', async () => {
  const reconciled = { id: 'dep_1', status: 'succeeded' };
  const application = createCommittedDeploymentReconciliation(
    createDependencies({
      state: {
        getVersion: async () => ({ id: 'ver_1', deploymentId: 'dep_original' }),
        getRoute: async () => ({ siteId: 'site_1', activeVersionId: 'ver_1' }),
        updateDeployment: async () => reconciled,
      },
    })
  );

  assert.equal(
    await application.reconcile({ ...command, deployment: { ...deployment, operation: 'rollback' } }),
    reconciled
  );
});

test('committed deployment reconciliation loads a stored trace only after detecting committed traffic', async () => {
  const calls = [];
  const storedTrace = { traceId: 'dtr_stored' };
  const application = createCommittedDeploymentReconciliation(
    createDependencies({
      traces: {
        async forDeployment(value, environment) {
          calls.push(['trace', value, environment]);
          return storedTrace;
        },
      },
      state: {
        getVersion: async () => ({ id: 'ver_1', deploymentId: 'dep_1' }),
        getRoute: async () => ({ siteId: 'site_1', activeVersionId: 'ver_1' }),
        async updateDeployment() {
          calls.push(['update']);
          return null;
        },
      },
      telemetry: {
        async reconciled(trace) {
          calls.push(['reconciled', trace]);
        },
        persistFailed: async () => null,
      },
    })
  );

  const result = await application.reconcile({ ...command, trace: null });
  assert.deepEqual(calls.map(([operation]) => operation), ['trace', 'update', 'reconciled']);
  assert.equal(calls[2][1], storedTrace);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.errorCode, null);
});

test('committed deployment reconciliation synthesizes success when persistence fails', async () => {
  const cause = new Error('deployment store unavailable');
  const failures = [];
  const application = createCommittedDeploymentReconciliation(
    createDependencies({
      state: {
        getVersion: async () => ({ id: 'ver_1', deploymentId: 'dep_1' }),
        getRoute: async () => ({ siteId: 'site_1', activeVersionId: 'ver_1' }),
        updateDeployment: async () => {
          throw cause;
        },
      },
      telemetry: {
        reconciled: async () => assert.fail('update did not complete'),
        async persistFailed(input) {
          failures.push(input);
        },
      },
    })
  );

  const result = await application.reconcile(command);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.errorCode, null);
  assert.deepEqual(failures, [
    {
      trace: command.trace,
      deploymentId: 'dep_1',
      operation: 'reconcile_committed_deployment',
      cause,
    },
  ]);
});

test('committed deployment reconciliation preserves trace failure precedence after a successful update', async () => {
  const cause = new Error('trace store unavailable');
  const failures = [];
  const application = createCommittedDeploymentReconciliation(
    createDependencies({
      telemetry: {
        reconciled: async () => {
          throw cause;
        },
        async persistFailed(input) {
          failures.push(input);
        },
      },
    })
  );

  const result = await application.reconcile(command);
  assert.equal(result.status, 'succeeded');
  assert.equal(failures[0].cause, cause);
});

test('committed deployment reconciliation requires its narrow capabilities', () => {
  assert.throws(
    () => createCommittedDeploymentReconciliation({ state: {}, traces: {}, telemetry: {}, clock: {} }),
    /state\.getVersion is required/
  );
});
