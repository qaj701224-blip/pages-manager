import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentCompletion, synthesizeSucceededDeployment } from './complete-deployment.js';

const deployment = {
  id: 'dep_1',
  status: 'activating',
  versionId: null,
  previousVersionId: null,
  errorCode: 'OLD_ERROR',
  errorMessage: 'Old failure',
  failureStage: 'old_stage',
  failureDiagnostics: { stale: true },
};
const command = {
  deployment,
  versionId: 'ver_2',
  previousVersionId: 'ver_1',
  completedAt: '2026-08-21T00:00:00.000Z',
};

function createApplication(overrides = {}) {
  return createDeploymentCompletion({
    deployments: { update: async () => null },
    telemetry: {
      persistSucceeded: async () => null,
      persistFailed: async () => null,
    },
    ...overrides,
  });
}

test('deployment completion persists the successful terminal patch through its narrow port', async () => {
  const calls = [];
  const completed = { ...deployment, status: 'succeeded', versionId: 'ver_2' };
  const application = createApplication({
    deployments: {
      async update(id, patch) {
        calls.push([id, patch]);
        return completed;
      },
    },
  });

  assert.equal(await application.complete(command), completed);
  assert.deepEqual(calls, [
    [
      'dep_1',
      {
        status: 'succeeded',
        versionId: 'ver_2',
        previousVersionId: 'ver_1',
        completedAt: '2026-08-21T00:00:00.000Z',
      },
    ],
  ]);
});

test('deployment completion preserves committed success when terminal persistence fails', async () => {
  const cause = new Error('deployment store unavailable');
  const failures = [];
  const application = createApplication({
    deployments: {
      update: async () => {
        throw cause;
      },
    },
    telemetry: {
      persistSucceeded: async () => assert.fail('state persistence did not succeed'),
      persistFailed: async (input) => failures.push(input),
    },
  });

  assert.deepEqual(await application.complete(command), {
    ...deployment,
    status: 'succeeded',
    versionId: 'ver_2',
    previousVersionId: 'ver_1',
    completedAt: '2026-08-21T00:00:00.000Z',
    errorCode: null,
    errorMessage: null,
    failureStage: null,
    failureDiagnostics: null,
  });
  assert.deepEqual(failures, [
    {
      deploymentId: 'dep_1',
      operation: 'persist_succeeded_deployment',
      cause,
    },
  ]);
});

test('deployment completion records trace success after persistence', async () => {
  const calls = [];
  const completed = { ...deployment, status: 'succeeded' };
  const application = createApplication({
    deployments: {
      async update() {
        calls.push('update');
        return completed;
      },
    },
    telemetry: {
      async persistSucceeded() {
        calls.push('trace_succeeded');
      },
      persistFailed: async () => assert.fail('completion must succeed'),
    },
  });

  assert.equal(await application.complete(command), completed);
  assert.deepEqual(calls, ['update', 'trace_succeeded']);
});

test('deployment completion synthesizes committed success when trace completion fails', async () => {
  const cause = new Error('trace store unavailable');
  const failures = [];
  const application = createApplication({
    deployments: { update: async () => ({ ...deployment, status: 'succeeded' }) },
    telemetry: {
      persistSucceeded: async () => {
        throw cause;
      },
      persistFailed: async (input) => failures.push(input),
    },
  });

  const result = await application.complete(command);
  assert.equal(result.status, 'succeeded');
  assert.equal(result.errorCode, null);
  assert.equal(failures[0].cause, cause);
});

test('successful deployment synthesis clears stale failure fields', () => {
  assert.deepEqual(
    synthesizeSucceededDeployment(deployment, {
      versionId: 'ver_2',
      completedAt: '2026-08-21T00:00:00.000Z',
    }),
    {
      ...deployment,
      status: 'succeeded',
      versionId: 'ver_2',
      completedAt: '2026-08-21T00:00:00.000Z',
      errorCode: null,
      errorMessage: null,
      failureStage: null,
      failureDiagnostics: null,
    }
  );
});

test('deployment completion requires its update capability', () => {
  assert.throws(
    () => createDeploymentCompletion({ deployments: {}, telemetry: {} }),
    /deployments\.update is required/
  );
});
