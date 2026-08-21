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
  });
  await assert.rejects(() => versionFailure.verify(command()), (error) => error === versionError);
});

test('rollback OfficeNet verification requires its narrow capabilities', () => {
  assert.throws(
    () => createRollbackOfficeNetVerification({ versions: {}, officeNet: {} }),
    /versions\.getById is required/
  );
});
