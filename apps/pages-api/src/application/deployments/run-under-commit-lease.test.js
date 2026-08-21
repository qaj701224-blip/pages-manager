import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentCommitLease } from './run-under-commit-lease.js';

const command = { environment: 'production', siteId: 'site_1' };
const telemetry = { start: () => null, finish: async () => null };

test('deployment commit lease runs work after acquisition telemetry succeeds', async () => {
  const calls = [];
  const stage = { operation: 'acquire_site_commit_lock' };
  const lease = { lockId: 'deploylock_1', fencingToken: 3 };
  const application = createDeploymentCommitLease({
    leases: {
      async run(input, work) {
        calls.push(['acquire', input]);
        return work(lease);
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

  const result = await application.run(command, async (receivedLease) => {
    calls.push(['work', receivedLease]);
    return { id: 'route_1' };
  });

  assert.deepEqual(result, { ok: true, value: { id: 'route_1' } });
  assert.deepEqual(calls, [
    ['start'],
    ['acquire', command],
    ['finish', stage, { status: 'succeeded' }],
    ['work', lease],
  ]);
});

test('deployment commit lease preserves a successful null work result', async () => {
  const application = createDeploymentCommitLease({
    leases: { run: async (_command, work) => work({ lockId: 'deploylock_1' }) },
    telemetry,
  });

  assert.deepEqual(await application.run(command, async () => null), { ok: true, value: null });
});

test('deployment commit lease reports unavailable and failed acquisition without running work', async () => {
  const calls = [];
  const stage = { operation: 'acquire_site_commit_lock' };
  const tracedTelemetry = {
    start() {
      calls.push(['start']);
      return stage;
    },
    async finish(receivedStage, outcome) {
      calls.push(['finish', receivedStage, outcome]);
    },
  };
  const unavailable = createDeploymentCommitLease({
    leases: { run: async () => null },
    telemetry: tracedTelemetry,
  });

  assert.deepEqual(
    await unavailable.run(command, async () => assert.fail('work must not run')),
    {
      ok: false,
      error: { code: 'SITE_POLICY_LOCKED', reason: 'capability_unavailable' },
    }
  );
  assert.deepEqual(calls.splice(0), [
    ['start'],
    ['finish', stage, { status: 'failed', reason: 'capability_unavailable' }],
  ]);

  const cause = new Error('lock store unavailable');
  const failed = createDeploymentCommitLease({
    leases: {
      async run() {
        throw cause;
      },
    },
    telemetry: tracedTelemetry,
  });
  assert.deepEqual(await failed.run(command, async () => assert.fail('work must not run')), {
    ok: false,
    error: { code: 'SITE_POLICY_LOCKED', reason: 'acquire_failed', cause },
  });
  assert.deepEqual(calls, [
    ['start'],
    ['finish', stage, { status: 'failed', reason: 'acquire_failed', cause }],
  ]);
});

test('deployment commit lease does not reclassify work failures as acquisition failures', async () => {
  const cause = new Error('activation failed');
  const calls = [];
  const application = createDeploymentCommitLease({
    leases: { run: async (_command, work) => work({ lockId: 'deploylock_1' }) },
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

  await assert.rejects(
    () => application.run(command, async () => Promise.reject(cause)),
    (error) => error === cause
  );
  assert.deepEqual(calls, [
    ['start'],
    ['finish', { status: 'succeeded' }],
  ]);
});

test('deployment commit lease starts telemetry synchronously', () => {
  const startError = new Error('invalid trace');
  const application = createDeploymentCommitLease({
    leases: { run: async () => assert.fail('lease acquisition must not run') },
    telemetry: {
      start() {
        throw startError;
      },
      finish: async () => assert.fail('finish must not run'),
    },
  });

  assert.throws(
    () => application.run(command, async () => assert.fail('work must not run')),
    (error) => error === startError
  );
});

test('deployment commit lease requires lease, telemetry, and work capabilities', () => {
  assert.throws(() => createDeploymentCommitLease({ leases: {}, telemetry }), /leases\.run is required/);
  assert.throws(
    () => createDeploymentCommitLease({ leases: { run: async () => null }, telemetry: {} }),
    /telemetry\.start is required/
  );

  const application = createDeploymentCommitLease({ leases: { run: async () => null }, telemetry });
  assert.throws(() => application.run(command), /work is required/);
});
