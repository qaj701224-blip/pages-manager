import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentRuntimeConfigRestoration } from './restore-runtime-config.js';

const command = {
  environment: 'production',
  siteId: 'site_1',
  actorId: 'usr_1',
  enabled: true,
  restoreVars: [{ name: 'OLD_FLAG', value: 'old', revision: 2 }],
  expectedVars: [{ name: 'FEATURE_FLAG', value: 'on', revision: 3 }],
};

function createApplication(runtimeConfig) {
  return createDeploymentRuntimeConfigRestoration({
    runtimeConfig,
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
    ids: { next: (prefix) => `${prefix}_1` },
  });
}

test('deployment runtime config restoration skips disabled or unsupported compensation', async () => {
  const unsupported = createApplication({});
  assert.deepEqual(await unsupported.restore(command), { kind: 'skipped' });

  const disabled = createApplication({
    replaceVars: async () => assert.fail('disabled compensation must not replace vars'),
  });
  assert.deepEqual(await disabled.restore({ ...command, enabled: false }), { kind: 'skipped' });
});

test('deployment runtime config restoration does not overwrite a newer authority snapshot', async () => {
  const application = createApplication({
    listVars: async () => [{ ...command.expectedVars[0], revision: 4 }],
    replaceVars: async () => assert.fail('stale compensation must not replace vars'),
  });

  assert.deepEqual(await application.restore(command), { kind: 'stale' });
});

test('deployment runtime config restoration preserves legacy replacement when snapshot reads are unsupported', async () => {
  const calls = [];
  const records = [{ name: 'OLD_FLAG', value: 'old', revision: 5 }];
  const application = createApplication({
    async replaceVars(input) {
      calls.push(input);
      return records;
    },
  });

  assert.deepEqual(await application.restore(command), { kind: 'restored', runtimeVarRecords: records });
  assert.deepEqual(
    { ...calls[0], createId: undefined },
    {
      environment: 'production',
      siteId: 'site_1',
      vars: { OLD_FLAG: 'old' },
      actorId: 'usr_1',
      updatedAt: '2026-08-21T00:00:00.000Z',
      createId: undefined,
    }
  );
  assert.equal(calls[0].createId(), 'var_1');
});

test('deployment runtime config restoration reports best-effort read and mutation failures', async () => {
  const unreadable = createApplication({
    listVars: async () => {
      throw new Error('read failed');
    },
    replaceVars: async () => assert.fail('failed reads must not replace vars'),
  });
  assert.deepEqual(await unreadable.restore(command), { kind: 'failed' });

  const unwriteable = createApplication({
    listVars: async () => command.expectedVars,
    replaceVars: async () => {
      throw new Error('write failed');
    },
  });
  assert.deepEqual(await unwriteable.restore(command), { kind: 'failed' });
});
