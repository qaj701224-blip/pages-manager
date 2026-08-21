import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentRuntimeConfigSnapshotValidation } from './validate-runtime-config-snapshot.js';

const command = {
  environment: 'production',
  siteId: 'site_1',
  expectedVars: [{ name: 'FEATURE_FLAG', value: 'on', revision: 1 }],
  expectedSecrets: [{ name: 'API_TOKEN', value: 'secret', revision: 2 }],
};

test('runtime config snapshot validation reads the current authority through its narrow port', async () => {
  const calls = [];
  const application = createDeploymentRuntimeConfigSnapshotValidation({
    runtimeConfig: {
      async listVars(environment, siteId) {
        calls.push(['vars', environment, siteId]);
        return command.expectedVars;
      },
      async listSecrets(environment, siteId) {
        calls.push(['secrets', environment, siteId]);
        return command.expectedSecrets;
      },
    },
  });

  assert.deepEqual(await application.validate(command), { ok: true });
  assert.deepEqual(calls, [
    ['vars', 'production', 'site_1'],
    ['secrets', 'production', 'site_1'],
  ]);
});

test('runtime config snapshot validation reports semantic authority drift', async () => {
  const application = createDeploymentRuntimeConfigSnapshotValidation({
    runtimeConfig: {
      listVars: async () => command.expectedVars,
      listSecrets: async () => [{ ...command.expectedSecrets[0], revision: 3 }],
    },
  });

  assert.deepEqual(await application.validate(command), {
    ok: false,
    error: { code: 'RUNTIME_CONFIG_CHANGED' },
  });
});

test('runtime config snapshot validation fails closed for missing or failing Store capabilities', async () => {
  const unavailable = createDeploymentRuntimeConfigSnapshotValidation({ runtimeConfig: {} });
  assert.deepEqual(await unavailable.validate(command), {
    ok: false,
    error: { code: 'RUNTIME_CONFIG_UNSUPPORTED' },
  });

  const unreadable = createDeploymentRuntimeConfigSnapshotValidation({
    runtimeConfig: {
      listVars: async () => {
        throw new Error('database unavailable');
      },
      listSecrets: async () => assert.fail('secret reads follow successful var reads'),
    },
  });
  assert.deepEqual(await unreadable.validate(command), {
    ok: false,
    error: { code: 'RUNTIME_CONFIG_UNSUPPORTED' },
  });
});
