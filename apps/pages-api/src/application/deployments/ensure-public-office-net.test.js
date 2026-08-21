import assert from 'node:assert/strict';
import test from 'node:test';

import { createPublicWorkerOfficeNetGuard } from './ensure-public-office-net.js';

const requiredCommand = {
  provider: { executionProvider: 'wfp' },
  environment: 'production',
  siteId: 'site_1',
  workerName: 'pages-v2-guide-ver-1',
  executionProvider: 'wfp',
  deploymentShape: 'worker-only',
  exposure: 'public',
  signal: new globalThis.AbortController().signal,
};

test('public OfficeNet application returns domain skips without touching settings', async () => {
  const application = createPublicWorkerOfficeNetGuard({
    settings: { ensureAbsent: async () => assert.fail('settings must be skipped') },
  });

  assert.deepEqual(await application.ensure({ ...requiredCommand, exposure: 'internal' }), {
    ok: true,
    result: { status: 'not_applicable', reason: 'exposure-not-public' },
  });
});

test('public OfficeNet application verifies required WFP settings through its narrow capability', async () => {
  const calls = [];
  const application = createPublicWorkerOfficeNetGuard({
    settings: {
      async ensureAbsent(command) {
        calls.push(command);
      },
    },
  });

  assert.deepEqual(await application.ensure(requiredCommand), { ok: true, result: { status: 'verified' } });
  assert.deepEqual(calls, [requiredCommand]);
});

test('public OfficeNet application preserves typed settings and domain failures', async () => {
  const cause = new Error('settings update failed');
  cause.code = 'SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED';
  const application = createPublicWorkerOfficeNetGuard({
    settings: {
      ensureAbsent: async () => {
        throw cause;
      },
    },
  });

  assert.deepEqual(await application.ensure(requiredCommand), {
    ok: false,
    error: { code: 'SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED', reason: 'settings_failure', cause },
  });
  assert.deepEqual(await application.ensure({ ...requiredCommand, executionProvider: 'other' }), {
    ok: false,
    error: { code: 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED', reason: 'execution_provider_unsupported' },
  });
});

test('public OfficeNet application requires its settings capability', () => {
  assert.throws(
    () => createPublicWorkerOfficeNetGuard({ settings: {} }),
    /settings\.ensureAbsent is required/
  );
});
