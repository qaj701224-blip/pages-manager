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

test('deployment completion persists the successful terminal patch through its narrow port', async () => {
  const calls = [];
  const completed = { ...deployment, status: 'succeeded', versionId: 'ver_2' };
  const application = createDeploymentCompletion({
    deployments: {
      async update(id, patch) {
        calls.push([id, patch]);
        return completed;
      },
    },
  });

  assert.deepEqual(await application.complete(command), { ok: true, deployment: completed });
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
  const application = createDeploymentCompletion({
    deployments: {
      update: async () => {
        throw cause;
      },
    },
  });

  assert.deepEqual(await application.complete(command), {
    ok: false,
    deployment: {
      ...deployment,
      status: 'succeeded',
      versionId: 'ver_2',
      previousVersionId: 'ver_1',
      completedAt: '2026-08-21T00:00:00.000Z',
      errorCode: null,
      errorMessage: null,
      failureStage: null,
      failureDiagnostics: null,
    },
    error: { code: 'DEPLOYMENT_STATE_WRITE_FAILED', cause },
  });
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
  assert.throws(() => createDeploymentCompletion({ deployments: {} }), /deployments\.update is required/);
});
