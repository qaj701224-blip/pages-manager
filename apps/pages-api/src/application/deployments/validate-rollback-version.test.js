import assert from 'node:assert/strict';
import test from 'node:test';

import { createRollbackVersionValidation } from './validate-rollback-version.js';

const version = {
  id: 'ver_1',
  deploymentId: 'dep_1',
  artifactAvailability: 'active',
  executionProvider: 'wfp',
};

test('rollback version validation accepts active artifacts from succeeded deployments', async () => {
  const calls = [];
  const application = createRollbackVersionValidation({
    deployments: {
      async get(...args) {
        calls.push(args);
        return { id: 'dep_1', status: 'succeeded' };
      },
    },
  });

  assert.deepEqual(await application.validate({ version, environment: 'production' }), { ok: true });
  assert.deepEqual(calls, [['dep_1', 'production']]);
});

test('rollback version validation rejects unavailable artifacts before reading deployment state', async () => {
  let read = false;
  const application = createRollbackVersionValidation({
    deployments: { get: async () => (read = true) },
  });

  assert.deepEqual(
    await application.validate({ version: { ...version, artifactAvailability: 'retired' }, environment: 'production' }),
    { ok: false, error: { reason: 'artifact_unavailable' } }
  );
  assert.equal(read, false);
});

test('rollback version validation distinguishes failed source deployments and legacy Providers', async () => {
  const failedSource = createRollbackVersionValidation({
    deployments: { get: async () => ({ status: 'failed' }) },
  });
  assert.deepEqual(await failedSource.validate({ version, environment: 'production' }), {
    ok: false,
    error: { reason: 'source_deployment_unavailable' },
  });

  const legacyProvider = createRollbackVersionValidation({
    deployments: { get: async () => ({ status: 'succeeded' }) },
  });
  assert.deepEqual(
    await legacyProvider.validate({
      version: { ...version, executionProvider: 'normal-worker-slot' },
      environment: 'production',
    }),
    { ok: false, error: { reason: 'legacy_provider_unavailable' } }
  );
});

test('rollback version validation requires its deployment capability', () => {
  assert.throws(() => createRollbackVersionValidation({ deployments: {} }), /deployments\.get is required/);
});
