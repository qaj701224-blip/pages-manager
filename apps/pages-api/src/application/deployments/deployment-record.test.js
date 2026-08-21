import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentRecord } from './deployment-record.js';

test('deployment record application creates a pending deploy through its narrow port', async () => {
  const calls = [];
  const expected = { kind: 'created', deployment: { id: 'dep_1' } };
  const application = createDeploymentRecord({
    deploymentRecords: {
      async createForIdempotency(input) {
        calls.push(input);
        return expected;
      },
    },
    ids: { next: (prefix) => `${prefix}_1` },
  });

  const result = await application.createPending({
    environment: 'production',
    actor: { actorId: 'access_key:key_1', userId: 'usr_1', type: 'access_key' },
    source: 'cli',
    siteId: 'site_1',
    operation: 'deploy',
    idempotencyKey: 'idem_1',
    requestHash: 'sha256:request',
    traceId: 'dtr_1',
    visibility: 'org',
    previousVersionId: 'ver_1',
  });

  assert.equal(result, expected);
  assert.deepEqual(calls, [
    {
      id: 'dep_1',
      environment: 'production',
      actorId: 'access_key:key_1',
      actorUserId: 'usr_1',
      actorType: 'access_key',
      source: 'cli',
      siteId: 'site_1',
      operation: 'deploy',
      idempotencyKey: 'idem_1',
      requestHash: 'sha256:request',
      traceId: 'dtr_1',
      visibility: 'org',
      previousVersionId: 'ver_1',
      status: 'pending',
    },
  ]);
});

test('deployment record application includes the immutable target version for rollback', async () => {
  let record;
  const application = createDeploymentRecord({
    deploymentRecords: {
      async createForIdempotency(input) {
        record = input;
        return { kind: 'created', deployment: input };
      },
    },
    ids: { next: () => 'dep_rollback' },
  });

  await application.createPending({
    environment: 'staging',
    actor: { actorId: 'usr_1', userId: 'usr_1', type: 'user' },
    source: 'api',
    siteId: 'site_1',
    operation: 'rollback',
    idempotencyKey: 'rollback_1',
    requestHash: 'sha256:rollback',
    traceId: null,
    visibility: 'internal',
    versionId: 'ver_target',
    previousVersionId: null,
  });

  assert.equal(record.versionId, 'ver_target');
  assert.equal(record.status, 'pending');
  assert.equal(record.traceId, null);
  assert.equal(record.previousVersionId, null);
});

test('deployment record application fails fast for missing ports', () => {
  assert.throws(
    () => createDeploymentRecord({ deploymentRecords: {}, ids: { next() {} } }),
    /deploymentRecords\.createForIdempotency is required/
  );
  assert.throws(
    () => createDeploymentRecord({ deploymentRecords: { createForIdempotency() {} }, ids: {} }),
    /ids\.next is required/
  );
});
