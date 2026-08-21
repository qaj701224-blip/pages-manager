import assert from 'node:assert/strict';
import test from 'node:test';

import { createUploadedWorkerCompensation } from './cleanup-uploaded-worker.js';

function createApplication(overrides = {}) {
  const records = [];
  const application = createUploadedWorkerCompensation({
    routes: { get: async () => null },
    workers: { delete: async () => null },
    diagnostics: { fromError: () => ({ causeClass: 'provider_error', providerCode: 'CF_ERROR' }) },
    telemetry: {
      async record(outcome, context) {
        records.push([outcome, context]);
        return outcome;
      },
    },
    ...overrides,
  });
  return { application, records };
}

test('uploaded worker compensation deletes and records the safe outcome', async () => {
  const calls = [];
  const { application, records } = createApplication({
    workers: {
      async delete(uploaded) {
        calls.push(uploaded);
      },
    },
  });
  const uploaded = { workerName: 'pages-user-site-1' };

  assert.deepEqual(
    await application.cleanup({
      uploaded,
      originalFailure: { stage: 'provider_verify', code: 'DEPLOYMENT_VERIFY_FAILED' },
      trafficImpact: 'old_version_retained',
    }),
    { status: 'succeeded', operation: 'worker_delete', causeClass: 'cleanup_succeeded' }
  );
  assert.deepEqual(calls, [uploaded]);
  assert.deepEqual(records[0][1], {
    originalFailure: { stage: 'provider_verify', code: 'DEPLOYMENT_VERIFY_FAILED' },
    trafficImpact: 'old_version_retained',
  });
});

test('uploaded worker compensation sanitizes Provider failures before telemetry', async () => {
  const failure = Object.assign(new Error('unsafe provider failure'), { operation: 'worker_delete_custom' });
  const { application } = createApplication({
    workers: { delete: async () => Promise.reject(failure) },
  });

  assert.deepEqual(await application.cleanup({ uploaded: { workerName: 'worker-1' } }), {
    status: 'failed',
    operation: 'worker_delete_custom',
    causeClass: 'provider_error',
    provider: { causeClass: 'provider_error', providerCode: 'CF_ERROR' },
  });
});

test('uploaded worker compensation skips active artifacts and deletes inactive artifacts', async () => {
  const deleted = [];
  const uploaded = { workerName: 'worker-1', slotId: 'slot-1' };
  const { application: active } = createApplication({
    routes: { get: async () => ({ activeVersionId: 'ver-1' }) },
    workers: { delete: async (value) => deleted.push(value) },
  });
  assert.deepEqual(
    await active.cleanupIfInactive({ uploaded, siteId: 'site-1', versionId: 'ver-1', environment: 'production' }),
    { status: 'not_needed', operation: 'worker_delete', causeClass: 'cleanup_not_needed' }
  );

  const { application: inactive } = createApplication({
    routes: { get: async () => ({ activeVersionId: 'ver-2', workerName: 'worker-2' }) },
    workers: { delete: async (value) => deleted.push(value) },
  });
  assert.deepEqual(
    await inactive.cleanupIfInactive({ uploaded, siteId: 'site-1', versionId: 'ver-1', environment: 'production' }),
    { status: 'succeeded', operation: 'worker_delete', causeClass: 'cleanup_succeeded' }
  );
  assert.deepEqual(deleted, [uploaded]);
});

test('uploaded worker compensation records route read failures without deleting', async () => {
  let deleted = false;
  const { application } = createApplication({
    routes: { get: async () => Promise.reject(new Error('read failed')) },
    workers: { delete: async () => (deleted = true) },
  });

  assert.deepEqual(
    await application.cleanupIfInactive({
      uploaded: { workerName: 'worker-1' },
      siteId: 'site-1',
      versionId: 'ver-1',
      environment: 'production',
    }),
    { status: 'failed', operation: 'worker_delete', causeClass: 'cleanup_state_read_error' }
  );
  assert.equal(deleted, false);
});

test('uploaded worker compensation requires its narrow capabilities', () => {
  assert.throws(
    () => createUploadedWorkerCompensation({ routes: {}, diagnostics: {}, telemetry: {} }),
    /routes\.get is required/
  );
});
