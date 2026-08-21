import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentRuntimeConfigCommit } from './commit-runtime-config.js';

const command = {
  environment: 'production',
  siteId: 'site_1',
  actorId: 'usr_1',
  enabled: true,
  requestedVars: { FEATURE_FLAG: 'on' },
  expectedVars: [{ name: 'OLD_FLAG', value: 'old', revision: 2 }],
  expectedSecrets: [{ name: 'API_TOKEN', value: 'secret', revision: 3 }],
};
const telemetry = { start: () => null, finish: async () => null };

function createApplication({ runtimeConfig = {}, validate = async () => ({ ok: true }), trace = telemetry } = {}) {
  return createDeploymentRuntimeConfigCommit({
    runtimeConfig,
    snapshotValidation: { validate },
    telemetry: trace,
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
    ids: { next: (prefix) => `${prefix}_1` },
  });
}

test('deployment runtime config commit skips omitted vars without touching its ports', async () => {
  const application = createApplication({
    runtimeConfig: { replaceVars: async () => assert.fail('skipped commits must not replace vars') },
    validate: async () => assert.fail('skipped commits must not validate snapshots'),
  });

  assert.deepEqual(await application.commit({ ...command, enabled: false }), {
    ok: true,
    kind: 'skipped',
  });
});

test('deployment runtime config commit checks mutation capability before snapshot authority', async () => {
  const application = createApplication({
    validate: async () => assert.fail('missing mutation capability wins before snapshot validation'),
  });

  assert.deepEqual(await application.commit(command), {
    ok: false,
    error: { code: 'RUNTIME_CONFIG_UNSUPPORTED', reason: 'capability_unavailable' },
  });
});

test('deployment runtime config commit preserves snapshot validation failures', async () => {
  const application = createApplication({
    runtimeConfig: { replaceVars: async () => assert.fail('stale snapshots must not replace vars') },
    validate: async (input) => {
      assert.deepEqual(input, {
        environment: 'production',
        siteId: 'site_1',
        expectedVars: command.expectedVars,
        expectedSecrets: command.expectedSecrets,
      });
      return { ok: false, error: { code: 'RUNTIME_CONFIG_CHANGED' } };
    },
  });

  assert.deepEqual(await application.commit(command), {
    ok: false,
    error: { code: 'RUNTIME_CONFIG_CHANGED', reason: 'snapshot_validation_failed' },
  });
});

test('deployment runtime config commit replaces vars and returns the committed provider view', async () => {
  const calls = [];
  const records = [{ name: 'FEATURE_FLAG', value: 'on', revision: 4 }];
  const application = createApplication({
    runtimeConfig: {
      async replaceVars(input) {
        calls.push(input);
        return records;
      },
    },
  });

  const result = await application.commit(command);

  assert.equal(result.kind, 'committed');
  assert.equal(result.runtimeVarRecords, records);
  assert.deepEqual(result.runtimeVars, { FEATURE_FLAG: 'on' });
  assert.equal(calls.length, 1);
  assert.deepEqual(
    { ...calls[0], createId: undefined },
    {
      environment: 'production',
      siteId: 'site_1',
      vars: { FEATURE_FLAG: 'on' },
      actorId: 'usr_1',
      updatedAt: '2026-08-21T00:00:00.000Z',
      createId: undefined,
    }
  );
  assert.equal(calls[0].createId(), 'var_1');
});

test('deployment runtime config commit maps mutation failures without exposing their cause', async () => {
  const application = createApplication({
    runtimeConfig: {
      replaceVars: async () => {
        throw new Error('database detail must not escape');
      },
    },
  });

  assert.deepEqual(await application.commit(command), {
    ok: false,
    error: { code: 'RUNTIME_CONFIG_UNSUPPORTED', reason: 'mutation_failed' },
  });

  const invalidResult = createApplication({
    runtimeConfig: { replaceVars: async () => null },
  });
  assert.deepEqual(await invalidResult.commit(command), {
    ok: false,
    error: { code: 'RUNTIME_CONFIG_UNSUPPORTED', reason: 'mutation_failed' },
  });
});

test('deployment runtime config commit requires composition capabilities', () => {
  assert.throws(
    () => createDeploymentRuntimeConfigCommit({ runtimeConfig: {}, snapshotValidation: {}, telemetry, clock: {}, ids: {} }),
    /snapshotValidation\.validate is required/
  );
  assert.throws(
    () =>
      createDeploymentRuntimeConfigCommit({
        runtimeConfig: {},
        snapshotValidation: { validate() {} },
        telemetry,
        clock: {},
        ids: { next() {} },
      }),
    /clock\.now is required/
  );
  assert.throws(
    () =>
      createDeploymentRuntimeConfigCommit({
        runtimeConfig: {},
        snapshotValidation: { validate() {} },
        telemetry: {},
        clock: { now() {} },
        ids: { next() {} },
      }),
    /telemetry\.start is required/
  );
});

test('deployment runtime config commit traces success and typed failures around the mutation', async () => {
  const calls = [];
  const stage = { operation: 'commit_runtime_config' };
  const trace = {
    start() {
      calls.push(['start']);
      return stage;
    },
    async finish(receivedStage, outcome) {
      calls.push(['finish', receivedStage, outcome]);
    },
  };
  const success = createApplication({
    runtimeConfig: {
      async replaceVars() {
        calls.push(['replace']);
        return [];
      },
    },
    validate: async () => (calls.push(['validate']), { ok: true }),
    trace,
  });

  assert.equal((await success.commit(command)).ok, true);
  assert.deepEqual(calls.splice(0), [
    ['start'],
    ['validate'],
    ['replace'],
    ['finish', stage, { status: 'succeeded' }],
  ]);

  const failure = createApplication({
    runtimeConfig: { replaceVars: async () => assert.fail('stale snapshots must not replace vars') },
    validate: async () => ({ ok: false, error: { code: 'RUNTIME_CONFIG_CHANGED' } }),
    trace,
  });
  const result = await failure.commit(command);
  assert.deepEqual(calls, [['start'], ['finish', stage, { status: 'failed', error: result.error }]]);
});

test('deployment runtime config commit finishes skipped telemetry before its no-op result', async () => {
  const calls = [];
  const application = createApplication({
    runtimeConfig: { replaceVars: async () => assert.fail('skipped commits must not replace vars') },
    validate: async () => assert.fail('skipped commits must not validate snapshots'),
    trace: {
      start() {
        calls.push(['start']);
        return null;
      },
      async finish(_stage, outcome) {
        calls.push(['finish', outcome]);
      },
    },
  });

  assert.deepEqual(await application.commit({ ...command, enabled: false }), { ok: true, kind: 'skipped' });
  assert.deepEqual(calls, [['start'], ['finish', { status: 'skipped' }]]);
});

test('deployment runtime config commit starts telemetry synchronously', () => {
  const startError = new Error('invalid trace');
  const application = createApplication({
    runtimeConfig: { replaceVars: async () => assert.fail('replace must not run') },
    validate: async () => assert.fail('validate must not run'),
    trace: {
      start() {
        throw startError;
      },
      finish: async () => assert.fail('finish must not run'),
    },
  });

  assert.throws(() => application.commit(command), (error) => error === startError);
});
