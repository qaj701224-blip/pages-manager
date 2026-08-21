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
const telemetry = { start: () => null, finish: async () => null };

test('public OfficeNet application returns domain skips without touching settings', async () => {
  const application = createPublicWorkerOfficeNetGuard({
    settings: { ensureAbsent: async () => assert.fail('settings must be skipped') },
    telemetry,
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
    telemetry,
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
    telemetry,
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
    () => createPublicWorkerOfficeNetGuard({ settings: {}, telemetry }),
    /settings\.ensureAbsent is required/
  );
});

test('public OfficeNet application traces skips, success, and typed failures in order', async () => {
  const calls = [];
  const stage = { operation: 'verify_public_office_net_absent' };
  const createApplication = (ensureAbsent) =>
    createPublicWorkerOfficeNetGuard({
      settings: {
        async ensureAbsent(command) {
          calls.push(['settings', command.siteId]);
          return ensureAbsent(command);
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

  await createApplication(async () => null).ensure({ ...requiredCommand, exposure: 'internal' });
  assert.deepEqual(calls.splice(0), [
    ['start'],
    ['finish', stage, { status: 'skipped' }],
  ]);

  await createApplication(async () => null).ensure({ ...requiredCommand, deploymentShape: 'assets-only' });
  assert.deepEqual(calls.splice(0), [
    ['start'],
    ['finish', stage, { status: 'succeeded' }],
  ]);

  await createApplication(async () => null).ensure(requiredCommand);
  assert.deepEqual(calls.splice(0), [
    ['start'],
    ['settings', 'site_1'],
    ['finish', stage, { status: 'succeeded' }],
  ]);

  const cause = new Error('settings failed');
  await createApplication(async () => Promise.reject(cause)).ensure(requiredCommand);
  assert.deepEqual(calls, [
    ['start'],
    ['settings', 'site_1'],
    [
      'finish',
      stage,
      {
        status: 'failed',
        error: {
          code: 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED',
          reason: 'settings_failure',
          cause,
        },
      },
    ],
  ]);
});

test('public OfficeNet application preserves success finish failure precedence', async () => {
  const finishError = new Error('trace finish failed');
  const calls = [];
  const application = createPublicWorkerOfficeNetGuard({
    settings: { ensureAbsent: async () => calls.push(['settings']) },
    telemetry: {
      start: () => null,
      async finish(_stage, outcome) {
        calls.push(['finish', outcome]);
        if (outcome.status === 'succeeded') throw finishError;
      },
    },
  });

  await assert.rejects(() => application.ensure(requiredCommand), (error) => error === finishError);
  assert.deepEqual(calls, [
    ['settings'],
    ['finish', { status: 'succeeded' }],
    ['finish', { status: 'failed', reason: 'telemetry_finish_error', cause: finishError }],
  ]);
});

test('public OfficeNet application starts telemetry synchronously', () => {
  const startError = new Error('invalid trace');
  const application = createPublicWorkerOfficeNetGuard({
    settings: { ensureAbsent: async () => assert.fail('settings must not run') },
    telemetry: {
      start() {
        throw startError;
      },
      finish: async () => assert.fail('finish must not run'),
    },
  });

  assert.throws(() => application.ensure(requiredCommand), (error) => error === startError);
});
