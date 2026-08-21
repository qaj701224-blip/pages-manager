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
const telemetry = { start: () => null, finish: async () => null };

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
    telemetry,
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
    telemetry,
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
    telemetry,
  });

  const result = await application.resolve({ ...command, workerRequired: false });

  assert.equal(result.kind, 'skipped');
  assert.deepEqual(calls, [[{}, []]]);
  assert.deepEqual(result.runtimeBindings, { vars: {}, secrets: [] });
});

test('runtime config resolution distinguishes missing Store capabilities from resolution failures', async () => {
  const unavailable = createDeploymentRuntimeConfigResolution({
    runtimeConfig: { listVars: null, listSecrets: null, hashInput: async () => {} },
    telemetry,
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
    telemetry,
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
    telemetry,
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
    telemetry,
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
    telemetry,
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
    telemetry,
  });

  assert.deepEqual(await application.resolve(command), {
    ok: false,
    error: { code: 'RUNTIME_BINDING_NAME_CONFLICT' },
  });
});

test('runtime config resolution requires its hash capability at composition time', () => {
  assert.throws(
    () => createDeploymentRuntimeConfigResolution({ runtimeConfig: {}, telemetry }),
    /runtimeConfig\.hashInput is required/
  );
});

test('runtime config resolution traces worker success and typed failure', async () => {
  const calls = [];
  const stage = { operation: 'resolve_runtime_config' };
  const tracedTelemetry = {
    start() {
      calls.push(['start']);
      return stage;
    },
    async finish(receivedStage, outcome) {
      calls.push(['finish', receivedStage, outcome]);
    },
  };
  const success = createDeploymentRuntimeConfigResolution({
    runtimeConfig: {
      listVars: async () => [],
      listSecrets: async () => [],
      hashInput: async () => calls.push(['hash']),
    },
    telemetry: tracedTelemetry,
  });
  assert.equal((await success.resolve(command)).ok, true);
  assert.deepEqual(calls.splice(0), [
    ['start'],
    ['hash'],
    ['finish', stage, { status: 'succeeded' }],
  ]);

  const failure = createDeploymentRuntimeConfigResolution({
    runtimeConfig: { listVars: null, listSecrets: null, hashInput: async () => assert.fail('hash must not run') },
    telemetry: tracedTelemetry,
  });
  const result = await failure.resolve(command);
  assert.deepEqual(calls, [['start'], ['finish', stage, { status: 'failed', error: result.error }]]);
});

test('runtime config resolution finishes asset-only trace before empty binding hashing', async () => {
  const calls = [];
  const application = createDeploymentRuntimeConfigResolution({
    runtimeConfig: {
      listVars: async () => assert.fail('vars must not be read'),
      listSecrets: async () => assert.fail('secrets must not be read'),
      async hashInput() {
        calls.push(['hash']);
        throw new Error('pepper unavailable');
      },
    },
    telemetry: {
      start() {
        calls.push(['start']);
        return null;
      },
      async finish(_stage, outcome) {
        calls.push(['finish', outcome]);
      },
    },
  });

  assert.deepEqual(await application.resolve({ ...command, workerRequired: false }), {
    ok: false,
    error: { code: 'RUNTIME_CONFIG_UNSUPPORTED', reason: 'resolution_failed' },
  });
  assert.deepEqual(calls, [
    ['start'],
    ['finish', { status: 'skipped' }],
    ['hash'],
  ]);
});

test('runtime config resolution starts telemetry synchronously', () => {
  const startError = new Error('invalid trace');
  const application = createDeploymentRuntimeConfigResolution({
    runtimeConfig: { hashInput: async () => assert.fail('hash must not run') },
    telemetry: {
      start() {
        throw startError;
      },
      finish: async () => assert.fail('finish must not run'),
    },
  });

  assert.throws(() => application.resolve(command), (error) => error === startError);
});
