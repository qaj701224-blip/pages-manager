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

function createApplication({ runtimeConfig = {}, validate = async () => ({ ok: true }) } = {}) {
  return createDeploymentRuntimeConfigCommit({
    runtimeConfig,
    snapshotValidation: { validate },
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
    () => createDeploymentRuntimeConfigCommit({ runtimeConfig: {}, snapshotValidation: {}, clock: {}, ids: {} }),
    /snapshotValidation\.validate is required/
  );
  assert.throws(
    () =>
      createDeploymentRuntimeConfigCommit({
        runtimeConfig: {},
        snapshotValidation: { validate() {} },
        clock: {},
        ids: { next() {} },
      }),
    /clock\.now is required/
  );
});
