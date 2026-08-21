import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentFailureCompletion } from './complete-failed-deployment.js';

const before = { id: 'dep_1', status: 'activating' };
const site = { id: 'site_1', hostname: 'guide.workers.xd.team' };
const actor = { type: 'user', userId: 'usr_1' };
const patch = {
  errorCode: 'ROUTE_ACTIVATION_CONFLICT',
  errorMessage: 'Route changed while rollback was activating.',
  failureStage: 'rollback_activate_route',
};
const command = {
  deploymentId: 'dep_1',
  environment: 'production',
  operation: 'rollback',
  patch,
  actor,
  site,
};

function createDependencies(overrides = {}) {
  return {
    deployments: {
      get: async () => before,
      update: async (deploymentId, failedPatch) => ({ id: deploymentId, ...failedPatch }),
    },
    telemetry: {
      startPersist: () => null,
      persistFailed: async () => null,
      persistSucceeded: async () => null,
      webhookSkipped: async () => null,
    },
    recoveryMarkers: { persist: async () => true },
    repairs: { report: () => null },
    webhooks: { emitFailed: async () => null },
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
    ...overrides,
  };
}

test('failed deployment completion persists once then emits the first terminal failure webhook', async () => {
  const calls = [];
  const completed = { id: 'dep_1', status: 'failed', ...patch };
  const application = createDeploymentFailureCompletion(
    createDependencies({
      deployments: {
        async get(deploymentId, environment) {
          calls.push(['get', deploymentId, environment]);
          return before;
        },
        async update(deploymentId, failedPatch) {
          calls.push(['update', deploymentId, failedPatch]);
          return completed;
        },
      },
      telemetry: {
        startPersist(operation) {
          calls.push(['start', operation]);
          return { operation };
        },
        persistFailed: async () => assert.fail('initial persistence must succeed'),
        async persistSucceeded(stage) {
          calls.push(['succeeded', stage.operation]);
        },
        webhookSkipped: async () => assert.fail('the first failure must emit a webhook'),
      },
      webhooks: {
        async emitFailed(input) {
          calls.push(['webhook', input]);
        },
      },
    })
  );

  assert.equal(await application.complete(command), completed);
  assert.deepEqual(calls, [
    ['get', 'dep_1', 'production'],
    ['start', 'persist_failed_deployment'],
    [
      'update',
      'dep_1',
      {
        ...patch,
        status: 'failed',
        completedAt: '2026-08-21T00:00:00.000Z',
      },
    ],
    ['succeeded', 'persist_failed_deployment'],
    ['webhook', { actor, site, deployment: completed }],
  ]);
});

test('failed deployment completion traces the first write before retrying it', async () => {
  const firstCause = new Error('first write failed');
  const calls = [];
  let attempts = 0;
  const recovered = { id: 'dep_1', status: 'failed', ...patch };
  const application = createDeploymentFailureCompletion(
    createDependencies({
      deployments: {
        get: async () => before,
        async update() {
          calls.push(['update', ++attempts]);
          if (attempts === 1) throw firstCause;
          return recovered;
        },
      },
      telemetry: {
        startPersist(operation) {
          calls.push(['start', operation]);
          return operation;
        },
        async persistFailed(input) {
          calls.push(['failed', input.stage, input.operation, input.cause]);
        },
        async persistSucceeded(stage) {
          calls.push(['succeeded', stage]);
        },
        webhookSkipped: async () => null,
      },
    })
  );

  assert.equal(await application.complete(command), recovered);
  assert.deepEqual(calls, [
    ['start', 'persist_failed_deployment'],
    ['update', 1],
    ['failed', 'persist_failed_deployment', 'persist_failed_deployment', firstCause],
    ['start', 'recover_failed_deployment'],
    ['update', 2],
    ['succeeded', 'recover_failed_deployment'],
  ]);
});

test('failed deployment completion persists a durable marker after both writes fail', async () => {
  const firstCause = new Error('first write failed');
  const recoveryCause = new Error('recovery write failed');
  const calls = [];
  let attempts = 0;
  const application = createDeploymentFailureCompletion(
    createDependencies({
      deployments: {
        get: async () => before,
        update: async () => {
          throw attempts++ === 0 ? firstCause : recoveryCause;
        },
      },
      telemetry: {
        startPersist: (operation) => operation,
        async persistFailed(input) {
          calls.push(['failed', input.operation, input.cause]);
        },
        persistSucceeded: async () => assert.fail('both persistence attempts fail'),
        webhookSkipped: async () => assert.fail('terminal persistence did not complete'),
      },
      recoveryMarkers: {
        async persist(input) {
          calls.push(['marker', input]);
          return true;
        },
      },
      repairs: {
        report(input) {
          calls.push(['repair', input]);
        },
      },
      webhooks: { emitFailed: async () => assert.fail('terminal persistence did not complete') },
    })
  );

  await assert.rejects(
    () => application.complete(command),
    (error) =>
      error.code === 'DEPLOYMENT_STATE_WRITE_FAILED' &&
      error.message === 'Deployment failure state could not be persisted.' &&
      error.cause === recoveryCause
  );
  const failedPatch = {
    ...patch,
    status: 'failed',
    completedAt: '2026-08-21T00:00:00.000Z',
  };
  assert.deepEqual(calls, [
    ['failed', 'persist_failed_deployment', firstCause],
    ['failed', 'recover_failed_deployment', recoveryCause],
    [
      'marker',
      {
        deploymentId: 'dep_1',
        siteId: 'site_1',
        siteHostname: 'guide.workers.xd.team',
        operation: 'rollback',
        failedPatch,
      },
    ],
    [
      'repair',
      {
        environment: 'production',
        siteId: 'site_1',
        deploymentId: 'dep_1',
        reason: 'deployment_failure_state_recovery_deferred',
      },
    ],
  ]);
});

test('failed deployment completion skips duplicate or unverifiable webhooks', async () => {
  for (const scenario of [
    { name: 'missing before', before: null, updated: { status: 'failed' }, site },
    { name: 'missing update', before, updated: null, site },
    { name: 'already failed', before: { status: 'failed' }, updated: { status: 'failed' }, site },
    { name: 'non-terminal update', before, updated: { status: 'activating' }, site },
    { name: 'missing site', before, updated: { status: 'failed' }, site: null },
  ]) {
    let skipped = 0;
    const application = createDeploymentFailureCompletion(
      createDependencies({
        deployments: {
          get: async () => scenario.before,
          update: async () => scenario.updated,
        },
        telemetry: {
          startPersist: () => null,
          persistFailed: async () => null,
          persistSucceeded: async () => null,
          webhookSkipped: async () => {
            skipped += 1;
          },
        },
        webhooks: { emitFailed: async () => assert.fail(`${scenario.name} must skip the webhook`) },
      })
    );

    assert.equal(await application.complete({ ...command, site: scenario.site }), scenario.updated);
    assert.equal(skipped, 1, scenario.name);
  }
});

test('failed deployment completion preserves an explicit completion timestamp', async () => {
  let persisted;
  const application = createDeploymentFailureCompletion(
    createDependencies({
      deployments: {
        get: async () => null,
        update: async (_deploymentId, failedPatch) => {
          persisted = failedPatch;
          return failedPatch;
        },
      },
      clock: { now: () => assert.fail('clock must not be read') },
    })
  );

  await application.complete({
    ...command,
    patch: { ...patch, completedAt: '2026-08-20T00:00:00.000Z' },
  });
  assert.equal(persisted.completedAt, '2026-08-20T00:00:00.000Z');
});

test('failed deployment completion requires its narrow capabilities', () => {
  assert.throws(
    () =>
      createDeploymentFailureCompletion({
        deployments: {},
        telemetry: {},
        recoveryMarkers: {},
        repairs: {},
        webhooks: {},
        clock: {},
      }),
    /deployments\.get is required/
  );
});
