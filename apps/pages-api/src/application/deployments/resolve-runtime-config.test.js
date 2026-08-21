import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentRuntimeConfigResolution } from './resolve-runtime-config.js';

const command = {
  environment: 'production',
  siteId: 'site_1',
  workerRequired: true,
  varsProvided: false,
  requestedVars: undefined,
};

test('runtime config resolution reads the stored deployment snapshot through its narrow port', async () => {
  const calls = [];
  const storedVars = [{ name: 'FEATURE_FLAG', value: 'on', revision: 3 }];
  const storedSecrets = [{ name: 'API_TOKEN', value: 'secret', revision: 4, internal: 'omitted' }];
  const application = createDeploymentRuntimeConfigResolution({
    runtimeConfig: {
      async listVars(environment, siteId) {
        calls.push(['vars', environment, siteId]);
        return storedVars;
      },
      async listSecrets(environment, siteId) {
        calls.push(['secrets', environment, siteId]);
        return storedSecrets;
      },
      async hashInput(vars, secrets) {
        calls.push(['hash', vars, secrets]);
      },
    },
  });

  const result = await application.resolve(command);

  assert.deepEqual(calls, [
    ['vars', 'production', 'site_1'],
    ['secrets', 'production', 'site_1'],
    ['hash', { FEATURE_FLAG: 'on' }, storedSecrets],
  ]);
  assert.deepEqual(result, {
    ok: true,
    kind: 'resolved',
    runtimeVars: { FEATURE_FLAG: 'on' },
    runtimeVarRecords: storedVars,
    originalRuntimeVarRecords: storedVars,
    runtimeSecrets: storedSecrets,
    runtimeBindings: {
      vars: { FEATURE_FLAG: 'on' },
      secrets: [{ name: 'API_TOKEN', value: 'secret', revision: 4 }],
    },
  });
});

test('runtime config resolution prepares sorted revision-zero records for explicit vars', async () => {
  const storedVars = [{ name: 'OLD_FLAG', value: 'old', revision: 8 }];
  const application = createDeploymentRuntimeConfigResolution({
    runtimeConfig: {
      listVars: async () => storedVars,
      listSecrets: async () => [],
      hashInput: async () => {},
    },
  });

  const result = await application.resolve({
    ...command,
    varsProvided: true,
    requestedVars: { Z_FLAG: 'last', A_FLAG: 'first' },
  });

  assert.deepEqual(result.runtimeVars, { A_FLAG: 'first', Z_FLAG: 'last' });
  assert.deepEqual(result.runtimeVarRecords, [
    { name: 'A_FLAG', value: 'first', revision: 0 },
    { name: 'Z_FLAG', value: 'last', revision: 0 },
  ]);
  assert.equal(result.originalRuntimeVarRecords, storedVars);
});

test('runtime config resolution skips Store reads for asset-only deployments while preserving empty validation', async () => {
  const calls = [];
  const application = createDeploymentRuntimeConfigResolution({
    runtimeConfig: {
      listVars: async () => assert.fail('asset-only deployments must not read vars'),
      listSecrets: async () => assert.fail('asset-only deployments must not read secrets'),
      async hashInput(vars, secrets) {
        calls.push([vars, secrets]);
      },
    },
  });

  const result = await application.resolve({ ...command, workerRequired: false });

  assert.equal(result.kind, 'skipped');
  assert.deepEqual(calls, [[{}, []]]);
  assert.deepEqual(result.runtimeBindings, { vars: {}, secrets: [] });
});

test('runtime config resolution distinguishes missing Store capabilities from resolution failures', async () => {
  const unavailable = createDeploymentRuntimeConfigResolution({
    runtimeConfig: { listVars: null, listSecrets: null, hashInput: async () => {} },
  });
  assert.deepEqual(await unavailable.resolve(command), {
    ok: false,
    error: { code: 'RUNTIME_CONFIG_UNSUPPORTED', reason: 'capability_unavailable' },
  });

  const unreadable = createDeploymentRuntimeConfigResolution({
    runtimeConfig: {
      listVars: async () => {
        throw new Error('database unavailable');
      },
      listSecrets: async () => assert.fail('secret reads follow successful var reads'),
      hashInput: async () => assert.fail('hashing follows successful reads'),
    },
  });
  assert.deepEqual(await unreadable.resolve(command), {
    ok: false,
    error: { code: 'RUNTIME_CONFIG_UNSUPPORTED', reason: 'resolution_failed' },
  });
});

test('runtime config resolution maps binding conflicts and limits before hashing', async () => {
  const hashInput = async () => assert.fail('invalid bindings must not be hashed');
  const conflict = createDeploymentRuntimeConfigResolution({
    runtimeConfig: {
      listVars: async () => [{ name: 'API_TOKEN', value: 'plain', revision: 1 }],
      listSecrets: async () => [{ name: 'API_TOKEN', value: 'secret', revision: 1 }],
      hashInput,
    },
  });
  assert.deepEqual(await conflict.resolve(command), {
    ok: false,
    error: { code: 'RUNTIME_BINDING_NAME_CONFLICT' },
  });

  const limited = createDeploymentRuntimeConfigResolution({
    runtimeConfig: {
      listVars: async () => Array.from({ length: 65 }, (_, index) => ({ name: `FEATURE_${index}`, value: 'on', revision: 1 })),
      listSecrets: async () => [],
      hashInput,
    },
  });
  assert.deepEqual(await limited.resolve(command), {
    ok: false,
    error: { code: 'RUNTIME_BINDINGS_LIMIT_EXCEEDED' },
  });
});

test('runtime config resolution fails closed when hashing is unavailable', async () => {
  const application = createDeploymentRuntimeConfigResolution({
    runtimeConfig: {
      listVars: async () => [],
      listSecrets: async () => [],
      hashInput: async () => {
        throw new Error('pepper unavailable');
      },
    },
  });

  assert.deepEqual(await application.resolve(command), {
    ok: false,
    error: { code: 'RUNTIME_CONFIG_UNSUPPORTED', reason: 'resolution_failed' },
  });
});

test('runtime config resolution preserves the post-hash quota validation', async () => {
  const secrets = [];
  const application = createDeploymentRuntimeConfigResolution({
    runtimeConfig: {
      listVars: async () => [{ name: 'FEATURE_FLAG', value: 'on', revision: 1 }],
      listSecrets: async () => secrets,
      hashInput: async () => {
        secrets.push({ name: 'FEATURE_FLAG', value: 'secret', revision: 1 });
      },
    },
  });

  assert.deepEqual(await application.resolve(command), {
    ok: false,
    error: { code: 'RUNTIME_BINDING_NAME_CONFLICT' },
  });
});

test('runtime config resolution requires its hash capability at composition time', () => {
  assert.throws(() => createDeploymentRuntimeConfigResolution({ runtimeConfig: {} }), /runtimeConfig\.hashInput is required/);
});
