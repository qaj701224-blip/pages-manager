import assert from 'node:assert/strict';
import test from 'node:test';

import { createRollbackOfficeNetVerification } from './ensure-rollback-office-net.js';

const targetVersion = {
  id: 'ver_target',
  workerName: 'pages-v2-guide-ver-target',
  executionProvider: 'wfp',
  deploymentShape: 'worker-only',
};
const currentVersion = {
  id: 'ver_current',
  workerName: 'pages-v2-guide-ver-current',
  executionProvider: 'wfp',
  deploymentShape: 'worker-with-assets',
};
const signal = new globalThis.AbortController().signal;
const telemetry = { start: () => null, finish: async () => null };

function command(overrides = {}) {
  return {
    environment: 'production',
    siteId: 'site_1',
    version: targetVersion,
    currentVersionId: currentVersion.id,
    exposure: 'public',
    signal,
    ...overrides,
  };
}

test('rollback OfficeNet verification checks the target before the distinct current public version', async () => {
  const calls = [];
  const application = createRollbackOfficeNetVerification({
    versions: {
      async getById(versionId, environment) {
        calls.push(['version', versionId, environment]);
        return currentVersion;
      },
    },
    officeNet: {
      async ensure(input) {
        calls.push(['officeNet', input]);
      },
    },
    telemetry,
  });

  assert.deepEqual(await application.verify(command()), { ok: true });
  assert.deepEqual(calls, [
    [
      'officeNet',
      {
        environment: 'production',
        siteId: 'site_1',
        workerName: targetVersion.workerName,
        executionProvider: 'wfp',
        deploymentShape: 'worker-only',
        exposure: 'public',
        signal,
      },
    ],
    ['version', 'ver_current', 'production'],
    [
      'officeNet',
      {
        environment: 'production',
        siteId: 'site_1',
        workerName: currentVersion.workerName,
        executionProvider: 'wfp',
        deploymentShape: 'worker-with-assets',
        exposure: 'public',
        signal,
      },
    ],
  ]);
});

test('rollback OfficeNet verification skips the current-version lookup for internal or unchanged routes', async () => {
  const calls = [];
  const application = createRollbackOfficeNetVerification({
    versions: { getById: async () => assert.fail('current version must not be read') },
    officeNet: {
      async ensure(input) {
        calls.push(input);
      },
    },
    telemetry,
  });

  assert.deepEqual(await application.verify(command({ exposure: 'internal' })), { ok: true });
  assert.deepEqual(
    await application.verify(command({ currentVersionId: targetVersion.id })),
    { ok: true }
  );
  assert.deepEqual(calls.map(({ exposure }) => exposure), ['internal', 'public']);
});

test('rollback OfficeNet verification fails closed when the current public version is missing', async () => {
  const calls = [];
  const application = createRollbackOfficeNetVerification({
    versions: {
      async getById(versionId, environment) {
        calls.push(['version', versionId, environment]);
        return null;
      },
    },
    officeNet: {
      async ensure(input) {
        calls.push(['officeNet', input.workerName]);
      },
    },
    telemetry,
  });

  assert.deepEqual(await application.verify(command()), {
    ok: false,
    error: {
      code: 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED',
      reason: 'current_version_missing',
    },
  });
  assert.deepEqual(calls, [
    ['officeNet', targetVersion.workerName],
    ['version', currentVersion.id, 'production'],
  ]);
});

test('rollback OfficeNet verification preserves capability and version lookup failures', async () => {
  const officeNetError = new Error('OfficeNet verification failed');
  const officeNetFailure = createRollbackOfficeNetVerification({
    versions: { getById: async () => currentVersion },
    officeNet: {
      ensure: async () => {
        throw officeNetError;
      },
    },
    telemetry,
  });
  await assert.rejects(() => officeNetFailure.verify(command()), (error) => error === officeNetError);

  const versionError = new Error('version store unavailable');
  const versionFailure = createRollbackOfficeNetVerification({
    versions: {
      getById: async () => {
        throw versionError;
      },
    },
    officeNet: { ensure: async () => null },
    telemetry,
  });
  await assert.rejects(() => versionFailure.verify(command()), (error) => error === versionError);
});

test('rollback OfficeNet verification requires its narrow capabilities', () => {
  assert.throws(
    () => createRollbackOfficeNetVerification({ versions: {}, officeNet: {}, telemetry }),
    /versions\.getById is required/
  );
});

test('rollback OfficeNet verification traces its complete dual-version stage', async () => {
  const calls = [];
  const stage = { operation: 'rollback_verify_public_office_net_absent' };
  const application = createRollbackOfficeNetVerification({
    versions: {
      async getById() {
        calls.push(['version']);
        return currentVersion;
      },
    },
    officeNet: {
      async ensure(input) {
        calls.push(['officeNet', input.workerName]);
      },
    },
    telemetry: {
      start() {
        calls.push(['start']);
        return stage;
      },
      async finish(receivedStage, outcome) {
        calls.push(['finish', receivedStage, outcome]);
      },
    },
  });

  assert.deepEqual(await application.verify(command()), { ok: true });
  assert.deepEqual(calls, [
    ['start'],
    ['officeNet', targetVersion.workerName],
    ['version'],
    ['officeNet', currentVersion.workerName],
    ['finish', stage, { status: 'succeeded' }],
  ]);
});

test('rollback OfficeNet verification traces typed and thrown failures', async () => {
  const calls = [];
  const stage = { operation: 'rollback_verify_public_office_net_absent' };
  const tracedTelemetry = {
    start: () => stage,
    async finish(receivedStage, outcome) {
      calls.push(['finish', receivedStage, outcome]);
    },
  };
  const missing = createRollbackOfficeNetVerification({
    versions: { getById: async () => null },
    officeNet: { ensure: async () => null },
    telemetry: tracedTelemetry,
  });
  const missingResult = await missing.verify(command());
  assert.deepEqual(calls.splice(0), [['finish', stage, { status: 'failed', error: missingResult.error }]]);

  const cause = new Error('OfficeNet failed');
  const failed = createRollbackOfficeNetVerification({
    versions: { getById: async () => currentVersion },
    officeNet: { ensure: async () => Promise.reject(cause) },
    telemetry: tracedTelemetry,
  });
  await assert.rejects(() => failed.verify(command()), (error) => error === cause);
  assert.deepEqual(calls, [['finish', stage, { status: 'failed', cause }]]);
});

test('rollback OfficeNet verification starts telemetry synchronously', () => {
  const startError = new Error('invalid trace');
  const application = createRollbackOfficeNetVerification({
    versions: { getById: async () => assert.fail('version must not be read') },
    officeNet: { ensure: async () => assert.fail('OfficeNet must not run') },
    telemetry: {
      start() {
        throw startError;
      },
      finish: async () => assert.fail('finish must not run'),
    },
  });

  assert.throws(() => application.verify(command()), (error) => error === startError);
});

test('rollback OfficeNet verification preserves success finish failure precedence', async () => {
  const finishError = new Error('trace finish failed');
  const calls = [];
  const application = createRollbackOfficeNetVerification({
    versions: { getById: async () => currentVersion },
    officeNet: { ensure: async () => calls.push(['officeNet']) },
    telemetry: {
      start: () => null,
      async finish(_stage, outcome) {
        calls.push(['finish', outcome]);
        if (outcome.status === 'succeeded') throw finishError;
      },
    },
  });

  await assert.rejects(() => application.verify(command()), (error) => error === finishError);
  assert.deepEqual(calls, [
    ['officeNet'],
    ['officeNet'],
    ['finish', { status: 'succeeded' }],
    ['finish', { status: 'failed', cause: finishError }],
  ]);
});
