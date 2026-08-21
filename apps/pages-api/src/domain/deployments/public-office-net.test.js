import assert from 'node:assert/strict';
import test from 'node:test';

import { resolvePublicWorkerOfficeNetGuard } from './public-office-net.js';

test('public OfficeNet guard skips non-public, assets-only, and normal Worker routes', () => {
  assert.deepEqual(
    resolvePublicWorkerOfficeNetGuard({
      exposure: 'internal',
      deploymentShape: 'worker-only',
      executionProvider: 'wfp',
    }),
    { ok: true, kind: 'skipped', result: { status: 'not_applicable', reason: 'exposure-not-public' } }
  );
  assert.deepEqual(
    resolvePublicWorkerOfficeNetGuard({
      exposure: 'public',
      deploymentShape: 'assets-only',
      executionProvider: 'wfp',
    }),
    { ok: true, kind: 'skipped', result: { status: 'not_applicable', reason: 'assets-only' } }
  );
  assert.deepEqual(
    resolvePublicWorkerOfficeNetGuard({
      exposure: 'public',
      deploymentShape: 'worker-with-assets',
      executionProvider: 'normal-worker-slot',
    }),
    { ok: true, kind: 'skipped', result: { status: 'not_applicable', reason: 'normal-worker-slot' } }
  );
});

test('public OfficeNet guard requires remove and verify for WFP Workers', () => {
  assert.deepEqual(
    resolvePublicWorkerOfficeNetGuard({
      exposure: 'public',
      deploymentShape: 'worker-only',
      executionProvider: 'wfp',
    }),
    { ok: true, kind: 'required' }
  );
});

test('public OfficeNet guard fails closed for unknown shapes and providers', () => {
  assert.deepEqual(
    resolvePublicWorkerOfficeNetGuard({
      exposure: 'public',
      deploymentShape: 'unknown',
      executionProvider: 'wfp',
    }),
    {
      ok: false,
      error: { code: 'SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED', reason: 'deployment_shape_unknown' },
    }
  );
  assert.deepEqual(
    resolvePublicWorkerOfficeNetGuard({
      exposure: 'public',
      deploymentShape: 'worker-only',
      executionProvider: 'unknown',
    }),
    {
      ok: false,
      error: { code: 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED', reason: 'execution_provider_unsupported' },
    }
  );
});
