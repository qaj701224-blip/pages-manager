import assert from 'node:assert/strict';
import test from 'node:test';

import { createPublicOfficeNetSettings } from './public-office-net-settings.js';

const baseCommand = {
  environment: 'production',
  siteId: 'site_1',
  workerName: 'pages-v2-guide-ver-1',
  signal: new globalThis.AbortController().signal,
};

test('public OfficeNet settings serialize remove and verify under the runtime-config lock', async () => {
  const calls = [];
  const settingsController = new globalThis.AbortController();
  const operationController = new globalThis.AbortController();
  operationController.abort(new Error('site lease lost'));
  const providerSignals = [];
  const settings = createPublicOfficeNetSettings({
    withRuntimeConfigLock: async (environment, siteId, callback) => {
      calls.push(['lock', environment, siteId]);
      return callback({ signal: settingsController.signal });
    },
  });
  const provider = {
    async removeOfficeNetBinding({ workerName, signal }) {
      calls.push(['remove', workerName]);
      providerSignals.push(signal);
    },
    async verifyOfficeNetAbsent({ workerName, signal }) {
      calls.push(['verify', workerName]);
      providerSignals.push(signal);
      return true;
    },
  };

  await settings.ensureAbsent({ ...baseCommand, provider, signal: operationController.signal });

  assert.deepEqual(calls, [
    ['lock', 'production', 'site_1'],
    ['remove', 'pages-v2-guide-ver-1'],
    ['verify', 'pages-v2-guide-ver-1'],
  ]);
  assert.equal(providerSignals.length, 2);
  assert.equal(providerSignals[0], providerSignals[1]);
  assert.equal(providerSignals[0].aborted, true);
});

test('public OfficeNet settings preserve remove and verify failure classification', async () => {
  const removeCause = new Error('remove failed');
  const removeSettings = createPublicOfficeNetSettings({});
  await assert.rejects(
    () =>
      removeSettings.ensureAbsent({
        ...baseCommand,
        provider: {
          removeOfficeNetBinding: async () => {
            throw removeCause;
          },
          verifyOfficeNetAbsent: async () => true,
        },
      }),
    (error) => error.code === 'SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED' && error.cause === removeCause
  );

  const verifySettings = createPublicOfficeNetSettings({});
  await assert.rejects(
    () =>
      verifySettings.ensureAbsent({
        ...baseCommand,
        provider: {
          removeOfficeNetBinding: async () => null,
          verifyOfficeNetAbsent: async () => false,
        },
      }),
    (error) => error.code === 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED'
  );
});

test('public OfficeNet settings fail closed for missing Provider methods and lock failures', async () => {
  const settings = createPublicOfficeNetSettings({});
  await assert.rejects(
    () => settings.ensureAbsent({ ...baseCommand, provider: {} }),
    (error) => error.code === 'SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED'
  );
  await assert.rejects(
    () =>
      settings.ensureAbsent({
        ...baseCommand,
        provider: { removeOfficeNetBinding: async () => null },
      }),
    (error) => error.code === 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED'
  );

  const lockCause = new Error('runtime lock unavailable');
  const locked = createPublicOfficeNetSettings({
    withRuntimeConfigLock: async () => {
      throw lockCause;
    },
  });
  await assert.rejects(
    () =>
      locked.ensureAbsent({
        ...baseCommand,
        provider: {
          removeOfficeNetBinding: async () => null,
          verifyOfficeNetAbsent: async () => true,
        },
      }),
    (error) => error.code === 'SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED' && error.cause === lockCause
  );
});
