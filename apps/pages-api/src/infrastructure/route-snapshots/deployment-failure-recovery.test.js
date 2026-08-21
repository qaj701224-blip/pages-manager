import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentFailureRecoveryMarkers } from './deployment-failure-recovery.js';

const failedPatch = {
  versionId: 'ver_1',
  previousVersionId: 'ver_2',
  errorCode: 'ROUTE_ACTIVATION_CONFLICT',
  errorMessage: 'Route changed while rollback was activating.',
  failureStage: 'rollback_activate_route',
  failureDiagnostics: { schemaVersion: 1, stage: 'rollback_activate_route' },
  completedAt: '2026-08-21T00:00:00.000Z',
};

function createAdapter(overrides = {}) {
  return createDeploymentFailureRecoveryMarkers({
    markers: {},
    environment: 'production',
    durableRecords: {
      write: async () => false,
      list: async () => [],
      delete: async () => null,
    },
    clock: { now: () => '2026-08-21T00:01:00.000Z' },
    ...overrides,
  });
}

test('deployment failure recovery markers persist the sanitized marker to KV first', async () => {
  const calls = [];
  const adapter = createAdapter({
    markers: {
      async put(key, value) {
        calls.push([key, JSON.parse(value)]);
      },
    },
    durableRecords: {
      write: async () => assert.fail('durable fallback must not run'),
      list: async () => [],
      delete: async () => null,
    },
  });

  assert.equal(
    await adapter.persist({
      siteId: 'site_1',
      siteHostname: 'guide.workers.xd.team',
      deploymentId: 'dep_1',
      operation: 'rollback',
      failedPatch,
    }),
    true
  );
  assert.deepEqual(calls, [
    [
      'production:deployment_failure_recovery:site_1:dep_1',
      {
        schemaVersion: 1,
        environment: 'production',
        siteId: 'site_1',
        deploymentId: 'dep_1',
        operation: 'rollback',
        failedPatch,
        createdAt: '2026-08-21T00:01:00.000Z',
      },
    ],
  ]);
});

test('deployment failure recovery markers sanitize secrets and fall back to durable state', async () => {
  const calls = [];
  const adapter = createAdapter({
    markers: {
      put: async () => {
        throw new Error('KV unavailable');
      },
    },
    durableRecords: {
      async write(input) {
        calls.push(input);
        return true;
      },
      list: async () => [],
      delete: async () => null,
    },
  });

  assert.equal(
    await adapter.persist({
      siteId: 'site_1',
      siteHostname: 'guide.workers.xd.team',
      deploymentId: 'dep_1',
      operation: 'other',
      failedPatch: {
        errorCode: 'invalid-code',
        errorMessage: 'Bearer secret-token https://secret.example',
        failureStage: 'INVALID',
        failureDiagnostics: { token: 'secret' },
      },
    }),
    true
  );
  assert.equal(calls[0].hostname, 'guide.workers.xd.team');
  assert.equal(calls[0].deploymentId, 'dep_1');
  const marker = JSON.parse(calls[0].value);
  assert.equal(marker.operation, 'deploy');
  assert.deepEqual(marker.failedPatch, {
    errorCode: 'DEPLOYMENT_STATE_WRITE_FAILED',
    errorMessage: 'Deployment failure state required recovery.',
    failureStage: 'persist_deployment_state',
    completedAt: '2026-08-21T00:01:00.000Z',
  });
  assert.doesNotMatch(calls[0].value, /Bearer|secret-token|https:\/\//);
});

test('deployment failure recovery markers list paginated KV and durable records with best-effort deletion', async () => {
  const kvDeleted = [];
  const durableDeleted = [];
  const pages = [
    {
      keys: [
        { name: 'production:deployment_failure_recovery:site_1:dep_1' },
        { name: 'other:key' },
      ],
      list_complete: false,
      cursor: 'next',
    },
    {
      keys: [{ name: 'production:deployment_failure_recovery:site_1:invalid' }],
      list_complete: true,
    },
  ];
  const adapter = createAdapter({
    markers: {
      async list(options) {
        assert.equal(options.prefix, 'production:deployment_failure_recovery:site_1:');
        return pages.shift();
      },
      async get(key) {
        if (key.endsWith(':invalid')) return '{invalid-json';
        return JSON.stringify({
          schemaVersion: 1,
          environment: 'production',
          siteId: 'site_1',
          deploymentId: 'dep_1',
          operation: 'rollback',
          failedPatch,
        });
      },
      async delete(key) {
        kvDeleted.push(key);
      },
    },
    durableRecords: {
      write: async () => false,
      async list(input) {
        assert.deepEqual(input, { hostname: 'guide.workers.xd.team' });
        return [
          {
            deploymentId: 'dep_2',
            value: JSON.stringify({
              schemaVersion: 1,
              environment: 'production',
              siteId: 'site_1',
              deploymentId: 'dep_2',
              operation: 'deploy',
              failedPatch,
            }),
          },
        ];
      },
      async delete(input) {
        durableDeleted.push(input);
      },
    },
  });

  const result = await adapter.list({
    id: 'site_1',
    route: { hostname: 'guide.workers.xd.team' },
  });

  assert.equal(result.readError, null);
  assert.deepEqual(result.records.map(({ marker }) => marker?.deploymentId || null), ['dep_1', null, 'dep_2']);
  await Promise.all(result.records.map((record) => record.delete()));
  assert.deepEqual(kvDeleted, [
    'production:deployment_failure_recovery:site_1:dep_1',
    'production:deployment_failure_recovery:site_1:invalid',
  ]);
  assert.deepEqual(durableDeleted, [{ hostname: 'guide.workers.xd.team', deploymentId: 'dep_2' }]);
});

test('deployment failure recovery markers preserve the first KV or durable read failure', async () => {
  const kvCause = new Error('KV list failed');
  const durableCause = new Error('durable list failed');
  const adapter = createAdapter({
    markers: {
      list: async () => {
        throw kvCause;
      },
      get: async () => null,
    },
    durableRecords: {
      write: async () => false,
      list: async () => {
        throw durableCause;
      },
      delete: async () => null,
    },
  });

  const result = await adapter.list({ id: 'site_1', hostname: 'guide.workers.xd.team' });
  assert.deepEqual(result.records, []);
  assert.equal(result.readError.code, 'DEPLOYMENT_STATE_WRITE_FAILED');
  assert.equal(result.readError.message, 'Deployment recovery markers could not be listed.');
  assert.equal(result.readError.cause, kvCause);
});

test('deployment failure recovery markers require durable storage and clock capabilities', () => {
  assert.throws(
    () => createDeploymentFailureRecoveryMarkers({ durableRecords: {}, clock: {} }),
    /durableRecords\.write is required/
  );
});
