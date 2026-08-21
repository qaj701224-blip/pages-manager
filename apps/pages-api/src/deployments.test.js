import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';

import { WfpApiError } from '@xd/wfp-client';
import worker from './index.js';
import { createAccessKeyPlaintext, hashAccessKey } from './crypto.js';
import { ensurePublicWorkerOfficeNetAbsent } from './deployments.js';
import { buildRouteSnapshot, RoutePointerDO, writeRouteSnapshot } from './route-snapshot.js';
import { createTestPagesStore } from './test-store.js';
import { seedLifecycleWebhook, TEST_WEBHOOK_URL_ENCRYPTION_KEY } from './lifecycle-webhook-test-fixtures.js';

const BEARER_USR_1 = createAccessKeyPlaintext({
  environment: 'production',
  keyId: 'ak_cli_usr_1',
  bytes: new Uint8Array(24).fill(11),
});
const BEARER_USR_PUBLISHER = createAccessKeyPlaintext({
  environment: 'production',
  keyId: 'ak_cli_usr_publisher',
  bytes: new Uint8Array(24).fill(12),
});
const BEARER_USR_2 = createAccessKeyPlaintext({
  environment: 'production',
  keyId: 'ak_cli_usr_2',
  bytes: new Uint8Array(24).fill(13),
});

async function seedCliLoginKey(store, userId, plaintext, environment = 'production') {
  await store.createAccessKey({
    id: `ak_cli_${userId}`,
    environment,
    ownerType: 'user',
    ownerId: userId,
    ownerUserId: userId,
    createdByUserId: userId,
    keyHash: await hashAccessKey(plaintext, 'pepper-secret'),
    pepperId: 'pepper_1',
    name: `cli login ${userId}`,
    scopes: ['*'],
    issuedSource: 'cli_login',
    issuedSessionVersion: 1,
  });
}

test('creates deployment, immutable version, active route, and route snapshot', async () => {
  const store = await createSeededStore();
  await store.replaceSiteAclEntries(
    'site_1',
    [{ id: 'acl_1', subjectType: 'department', subjectValue: 'dept_design', accessRole: 'viewer', effect: 'allow' }],
    { createdBy: 'usr_1', updatedAt: '2026-06-15T00:00:00.000Z' },
    'production'
  );
  const snapshots = createSnapshotStore();

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        ...deployPayload(),
        source: 'cli',
      },
      { 'Idempotency-Key': 'idem_1' }
    ),
    testEnv(store, snapshots)
  );

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.deployment.id, 'dep_1');
  assert.equal(body.deployment.status, 'succeeded');
  assert.equal(body.deployment.versionId, 'ver_1');
  assert.equal(body.deployment.previousVersionId, null);
  assertNoPublicExecutionDetails(body);
  assert.equal(body.route.routeGeneration, 1);
  assert.match((await store.getSiteVersion('ver_1')).contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal((await store.getSiteVersion('ver_1')).artifactRef, 'wfp://test/pages-v2-guide-ver-1');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_1');
  const pointer = snapshots.read('production:route_pointer:guide.pages.xd.team');
  assert.equal(pointer.routeGeneration, 1);
  assert.deepEqual(snapshots.read(pointer.snapshotKey).acl, [
    { effect: 'allow', subjectType: 'department', subjectValue: 'dept_design' },
  ]);
});

test('records the previously active version for each successful deployment', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());

  const first = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'previous_version_first',
    }),
    env
  );
  const second = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
      { 'Idempotency-Key': 'previous_version_second' }
    ),
    env
  );

  assert.equal(first.status, 201, await first.clone().text());
  assert.equal(second.status, 201, await second.clone().text());
  assert.equal((await first.json()).deployment.previousVersionId, null);
  assert.equal((await second.json()).deployment.previousVersionId, 'ver_1');
  assert.equal((await store.getDeployment('dep_1')).previousVersionId, null);
  assert.equal((await store.getDeployment('dep_2')).previousVersionId, 'ver_1');
});

test('upload failure records the previous version for an existing active deployment', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());
  const first = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'previous_version_upload_failure_first',
    }),
    env
  );
  assert.equal(first.status, 201, await first.clone().text());

  env.WFP_PROVIDER = {
    upload: async () => {
      throw new Error('upload failed');
    },
    verify: async () => {
      throw new Error('verify should not run');
    },
  };
  const second = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
      { 'Idempotency-Key': 'previous_version_upload_failure_second' }
    ),
    env
  );

  assert.equal(second.status, 502, await second.clone().text());
  const failed = await store.getDeployment('dep_2', 'production');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.previousVersionId, 'ver_1');
});

test('first upload failure keeps the previous version empty', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async () => {
        throw new Error('upload failed');
      },
      verify: async () => {
        throw new Error('verify should not run');
      },
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'first_upload_failure_previous_version',
    }),
    env
  );

  assert.equal(response.status, 502, await response.clone().text());
  const failed = await store.getDeployment('dep_1', 'production');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.previousVersionId, null);
});

test('upload failure leaves the existing active route unchanged', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());
  const first = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'active_route_upload_failure_first',
    }),
    env
  );
  assert.equal(first.status, 201, await first.clone().text());
  const before = await store.getRouteBySiteId('site_1', 'production');

  env.WFP_PROVIDER = {
    upload: async () => {
      throw new Error('upload failed');
    },
    verify: async () => {
      throw new Error('verify should not run');
    },
  };
  const second = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
      { 'Idempotency-Key': 'active_route_upload_failure_second' }
    ),
    env
  );

  assert.equal(second.status, 502, await second.clone().text());
  const after = await store.getRouteBySiteId('site_1', 'production');
  assert.equal(after.activeVersionId, before.activeVersionId);
  assert.equal(after.workerName, before.workerName);
  assert.equal(after.routeGeneration, before.routeGeneration);
});

test('POST deploy responses expose a server trace header and persist the trace on the deployment', async () => {
  const store = await createSeededStore();
  const request = deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
    'Idempotency-Key': 'trace_success',
    'cf-ray': 'a2dfd41a7a7796d2-SIN',
  });

  const response = await worker.fetch(request, testEnv(store, createSnapshotStore()));

  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(response.headers.get('X-Deployment-Trace-Id'), 'dtr_1');
  assert.equal((await store.getDeployment('dep_1', 'production')).traceId, 'dtr_1');
  const events = await store.listDeploymentEvents({ environment: 'production', traceId: 'dtr_1' });
  assert.equal(
    events.some((event) => event.inboundRayId === 'a2dfd41a7a7796d2-SIN'),
    true
  );
  assert.equal(
    events.some((event) => event.deploymentId === 'dep_1'),
    true
  );
});

test('POST deploy authentication failures keep a log-correlatable trace without persisting unauthenticated events', async () => {
  const store = await createSeededStore();
  const traceLogs = [];
  const env = testEnv(store, createSnapshotStore());
  env.logDeploymentTraceEvent = (line) => traceLogs.push(JSON.parse(line));
  const request = deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
    'Idempotency-Key': 'trace_auth_failure',
    'cf-ray': 'auth-ray-SIN',
  });
  request.headers.delete('Authorization');

  const response = await worker.fetch(request, env);
  const traceId = response.headers.get('X-Deployment-Trace-Id');

  assert.equal(response.status, 401);
  assert.equal(traceId, 'dtr_1');
  assert.equal((await response.json()).error.code, 'PAGES_AUTH_REQUIRED');
  assert.deepEqual(await store.listDeploymentEvents({ environment: 'production', traceId }), []);
  assert.deepEqual(
    traceLogs.map((event) => ({
      stage: event.stage,
      status: event.status,
      deploymentId: event.deploymentId,
      inboundRayId: event.inboundRayId,
      errorCode: event.errorCode,
    })),
    [
      {
        stage: 'intake',
        status: 'succeeded',
        deploymentId: null,
        inboundRayId: 'auth-ray-SIN',
        errorCode: null,
      },
      {
        stage: 'auth_and_site_resolution',
        status: 'failed',
        deploymentId: null,
        inboundRayId: 'auth-ray-SIN',
        errorCode: 'PAGES_AUTH_REQUIRED',
      },
    ]
  );
  assert.equal(traceLogs.every((event) => event.event === 'pages_deployment_trace_event'), true);
});

test('POST deploy authentication exceptions return a safe traced response without unauthenticated D1 writes', async () => {
  const store = await createSeededStore();
  store.getAccessKeyById = async () => {
    throw new Error('SQL token=must-not-be-returned');
  };
  const traceLogs = [];
  const env = testEnv(store, createSnapshotStore());
  env.logDeploymentTraceEvent = (line) => traceLogs.push(JSON.parse(line));

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'trace_auth_exception',
    }),
    env
  );
  const traceId = response.headers.get('X-Deployment-Trace-Id');
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(traceId, 'dtr_1');
  assert.equal(body.error.code, 'DEPLOYMENT_REQUEST_FAILED');
  assert.deepEqual(await store.listDeploymentEvents({ environment: 'production', traceId }), []);
  assert.equal(
    traceLogs.some(
      (event) =>
        event.stage === 'auth_and_site_resolution' &&
        event.operation === 'authenticate_request' &&
        event.status === 'failed' &&
        event.errorCode === 'DEPLOYMENT_REQUEST_FAILED'
    ),
    true
  );
  assert.doesNotMatch(JSON.stringify({ body, traceLogs }), /SQL|token=|must-not-be-returned/);
});

test('POST deploy orchestration exceptions persist the active safe stage and return the trace header', async () => {
  const store = await createSeededStore();
  store.getSiteForUser = async () => {
    throw new Error('SQL secret=must-not-be-returned');
  };

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'trace_orchestration_exception',
    }),
    testEnv(store, createSnapshotStore())
  );
  const traceId = response.headers.get('X-Deployment-Trace-Id');
  const body = await response.json();
  const events = await store.listDeploymentEvents({ environment: 'production', traceId });

  assert.equal(response.status, 500);
  assert.equal(traceId, 'dtr_1');
  assert.equal(body.error.code, 'DEPLOYMENT_REQUEST_FAILED');
  assert.equal(
    events.some(
      (event) =>
        event.stage === 'auth_and_site_resolution' &&
        event.operation === 'resolve_site' &&
        event.status === 'failed' &&
        event.errorCode === 'DEPLOYMENT_REQUEST_FAILED'
    ),
    true
  );
  assert.doesNotMatch(JSON.stringify({ body, events }), /SQL|secret=|must-not-be-returned/);
});

test('POST deploy exceptions after record creation terminalize the deployment at the orchestration stage', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());
  const originalNextId = env.nextId;
  env.nextId = (prefix) => {
    if (prefix === 'ver') throw new Error('secret=must-not-be-returned');
    return originalNextId(prefix);
  };

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'trace_post_record_exception',
    }),
    env
  );
  const traceId = response.headers.get('X-Deployment-Trace-Id');
  const body = await response.json();
  const deployment = await store.getDeployment('dep_1', 'production');
  const events = await store.listDeploymentEvents({ environment: 'production', traceId });

  assert.equal(response.status, 500);
  assert.equal(body.error.code, 'DEPLOYMENT_REQUEST_FAILED');
  assert.equal(deployment.status, 'failed');
  assert.equal(deployment.errorCode, 'DEPLOYMENT_REQUEST_FAILED');
  assert.equal(deployment.failureStage, 'deployment_operation');
  assert.equal(
    events.some(
      (event) =>
        event.stage === 'deployment_operation' &&
        event.operation === 'orchestrate_deployment_request' &&
        event.status === 'failed' &&
        event.errorCode === 'DEPLOYMENT_REQUEST_FAILED'
    ),
    true
  );
  assert.doesNotMatch(JSON.stringify({ body, deployment, events }), /secret=|must-not-be-returned/);
});

test('POST deploy keeps a traced response when unexpected failure terminal recovery is unavailable', async () => {
  const store = await createSeededStore();
  const originalUpdateDeployment = store.updateDeployment.bind(store);
  store.updateDeployment = async (deploymentId, patch) => {
    if (patch.status === 'failed') throw new Error('SQL token=terminal-recovery-secret');
    return originalUpdateDeployment(deploymentId, patch);
  };
  const stateWriteLogs = [];
  const repairLogs = [];
  const snapshots = createSnapshotStore();
  snapshots.put = async () => {
    throw new Error('KV token=terminal-recovery-marker-secret');
  };
  const env = testEnv(store, snapshots, {
    logDeploymentStateWriteFailed: (line) => stateWriteLogs.push(JSON.parse(line)),
    logDeploymentRepairRequired: (line) => repairLogs.push(JSON.parse(line)),
  });
  const originalNextId = env.nextId;
  env.nextId = (prefix) => {
    if (prefix === 'ver') throw new Error('secret=must-not-be-returned');
    return originalNextId(prefix);
  };

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'trace_terminal_recovery_unavailable',
    }),
    env
  );
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error.code, 'DEPLOYMENT_REQUEST_FAILED');
  assert.equal(response.headers.get('X-Deployment-Trace-Id'), 'dtr_1');
  assert.equal((await store.getDeployment('dep_1', 'production')).status, 'pending');
  assert.deepEqual(
    stateWriteLogs.map((entry) => entry.operation),
    ['persist_failed_deployment', 'recover_failed_deployment']
  );
  assert.equal(repairLogs.at(-1)?.reason, 'deployment_failure_state_recovery_failed');
  assert.doesNotMatch(JSON.stringify({ body, stateWriteLogs, repairLogs }), /SQL|KV|token=|secret=/);
});

test('recovers a failed terminal write through RoutePointer durable state when D1 and KV writes both fail', async () => {
  let d1Unavailable = true;
  const store = await createSeededStore();
  const originalUpdateDeployment = store.updateDeployment.bind(store);
  store.updateDeployment = async (deploymentId, patch) => {
    if (d1Unavailable && patch.status === 'failed') throw new Error('SQL terminal write unavailable');
    return originalUpdateDeployment(deploymentId, patch);
  };
  const snapshots = createSnapshotStore();
  const originalSnapshotPut = snapshots.put;
  snapshots.put = async () => {
    throw new Error('KV recovery marker unavailable');
  };
  const repairLogs = [];
  const env = testEnv(store, snapshots, {
    ROUTE_POINTER_LOCKS: createRoutePointerLocks(snapshots),
    logDeploymentRepairRequired: (line) => repairLogs.push(JSON.parse(line)),
  });
  const originalNextId = env.nextId;
  let failVersionId = true;
  env.nextId = (prefix) => {
    if (prefix === 'ver' && failVersionId) throw new Error('unexpected orchestration failure');
    return originalNextId(prefix);
  };

  const failedResponse = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'durable_recovery_initial_failure',
    }),
    env
  );

  assert.equal(failedResponse.status, 500, await failedResponse.clone().text());
  assert.equal((await failedResponse.json()).error.code, 'DEPLOYMENT_REQUEST_FAILED');
  assert.equal((await store.getDeployment('dep_1')).status, 'pending');
  assert.equal(repairLogs.at(-1)?.reason, 'deployment_failure_state_recovery_deferred');

  d1Unavailable = false;
  failVersionId = false;
  snapshots.put = originalSnapshotPut;
  const retry = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("recovered"); } };' }),
      { 'Idempotency-Key': 'durable_recovery_retry' }
    ),
    env
  );

  assert.equal(retry.status, 201, await retry.clone().text());
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.equal((await store.getDeployment('dep_1')).errorCode, 'DEPLOYMENT_REQUEST_FAILED');
  assert.equal((await store.getDeployment('dep_2')).status, 'succeeded');
});

test('recovers a durable failure marker before fail-closing on unavailable KV marker listing', async () => {
  let d1Unavailable = true;
  const store = await createSeededStore();
  const originalUpdateDeployment = store.updateDeployment.bind(store);
  store.updateDeployment = async (deploymentId, patch) => {
    if (d1Unavailable && patch.status === 'failed') throw new Error('SQL terminal write unavailable');
    return originalUpdateDeployment(deploymentId, patch);
  };
  const snapshots = createSnapshotStore();
  const originalSnapshotPut = snapshots.put;
  const originalSnapshotList = snapshots.list;
  snapshots.put = async () => {
    throw new Error('KV recovery marker unavailable');
  };
  const env = testEnv(store, snapshots, {
    ROUTE_POINTER_LOCKS: createRoutePointerLocks(snapshots),
  });
  const originalNextId = env.nextId;
  let failVersionId = true;
  env.nextId = (prefix) => {
    if (prefix === 'ver' && failVersionId) throw new Error('unexpected orchestration failure');
    return originalNextId(prefix);
  };

  const failedResponse = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'durable_recovery_kv_list_initial_failure',
    }),
    env
  );

  assert.equal(failedResponse.status, 500, await failedResponse.clone().text());
  assert.equal((await store.getDeployment('dep_1')).status, 'pending');

  d1Unavailable = false;
  failVersionId = false;
  snapshots.put = originalSnapshotPut;
  snapshots.list = async () => {
    throw new Error('KV marker listing unavailable');
  };
  const blockedRetry = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'durable_recovery_kv_list_blocked_retry',
    }),
    env
  );

  assert.equal(blockedRetry.status, 503, await blockedRetry.clone().text());
  assert.equal((await blockedRetry.json()).error.code, 'DEPLOYMENT_STATE_WRITE_FAILED');
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.equal(await store.getDeployment('dep_2'), null);

  snapshots.list = originalSnapshotList;
  const successfulRetry = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("recovered"); } };' }),
      { 'Idempotency-Key': 'durable_recovery_kv_list_successful_retry' }
    ),
    env
  );

  assert.equal(successfulRetry.status, 201, await successfulRetry.clone().text());
  assert.equal((await store.getDeployment('dep_2')).status, 'succeeded');
});

test('retains a newly created site hostname for durable failure recovery', async () => {
  let d1Unavailable = true;
  let providerUnavailable = true;
  const store = await createSeededStore();
  const ownerScopedKey = await seedAccessKey(store, 'ak_owner_recovery', ['deploy:site'], null);
  const originalUpdateDeployment = store.updateDeployment.bind(store);
  store.updateDeployment = async (deploymentId, patch) => {
    if (d1Unavailable && patch.status === 'failed') throw new Error('SQL terminal write unavailable');
    return originalUpdateDeployment(deploymentId, patch);
  };
  const snapshots = createSnapshotStore();
  const originalSnapshotPut = snapshots.put;
  snapshots.put = async () => {
    throw new Error('KV recovery marker unavailable');
  };
  const repairLogs = [];
  const durableScopeNames = [];
  const routePointerLocks = createRoutePointerLocks(snapshots);
  const env = testEnv(store, snapshots, {
    ROUTE_POINTER_LOCKS: {
      ...routePointerLocks,
      idFromName: (name) => {
        durableScopeNames.push(name);
        return routePointerLocks.idFromName(name);
      },
    },
    logDeploymentRepairRequired: (line) => repairLogs.push(JSON.parse(line)),
    WFP_PROVIDER: {
      upload: async ({ workerName }) => {
        if (providerUnavailable) {
          throw new WfpApiError({
            code: 'WFP_NETWORK_ERROR',
            message: 'provider unavailable',
            operation: 'worker_put',
          });
        }
        return { artifactRef: `wfp://test/${workerName}` };
      },
      verify: async () => ({ ok: true }),
    },
  });
  const originalNextId = env.nextId;
  env.nextId = (prefix) => {
    if (prefix === 'site') return 'site_new_recovery';
    if (prefix === 'route') return 'route_new_recovery';
    return originalNextId(prefix);
  };
  const firstHeaders = {
    Authorization: `Bearer ${ownerScopedKey}`,
    'Idempotency-Key': 'new_site_durable_recovery_initial_failure',
  };

  const failedResponse = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'new-recovery', visibility: 'internal' }),
      firstHeaders
    ),
    env
  );

  assert.equal(failedResponse.status, 503, await failedResponse.clone().text());
  assert.equal((await failedResponse.json()).error.code, 'DEPLOYMENT_STATE_WRITE_FAILED');
  assert.equal((await store.getDeployment('dep_1')).status, 'uploading');
  assert.equal(repairLogs.at(-1)?.reason, 'deployment_failure_state_recovery_deferred');
  assert.deepEqual(durableScopeNames, ['production:new-recovery.workers.xd.team']);
  assert.equal((await store.findSiteBySlug('production', 'new-recovery')).id, 'site_new_recovery');

  d1Unavailable = false;
  providerUnavailable = false;
  snapshots.put = originalSnapshotPut;
  const retry = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'new-recovery', visibility: 'internal' }),
      {
        Authorization: `Bearer ${ownerScopedKey}`,
        'Idempotency-Key': 'new_site_durable_recovery_retry',
      }
    ),
    env
  );

  assert.equal(retry.status, 201, await retry.clone().text());
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.equal((await store.getDeployment('dep_2')).status, 'succeeded');
});

test('POST deploy returns the committed success when trailing trace work fails after terminal persistence', async () => {
  const store = await createSeededStore();
  let succeededPersisted = false;
  const originalUpdateDeployment = store.updateDeployment.bind(store);
  store.updateDeployment = async (deploymentId, patch) => {
    const updated = await originalUpdateDeployment(deploymentId, patch);
    if (patch.status === 'succeeded') succeededPersisted = true;
    return updated;
  };
  const env = testEnv(store, createSnapshotStore());
  const originalNextId = env.nextId;
  let postSuccessTraceIds = 0;
  env.nextId = (prefix) => {
    if (prefix === 'dpe' && succeededPersisted) {
      postSuccessTraceIds += 1;
      if (postSuccessTraceIds === 2) throw new Error('secret=must-not-be-returned');
    }
    return originalNextId(prefix);
  };

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'trace_post_success_exception',
    }),
    env
  );
  const traceId = response.headers.get('X-Deployment-Trace-Id');
  const body = await response.json();
  const deployment = await store.getDeployment('dep_1', 'production');
  const events = await store.listDeploymentEvents({ environment: 'production', traceId });

  assert.equal(response.status, 201);
  assert.equal(body.deployment.status, 'succeeded');
  assert.equal(deployment.status, 'succeeded');
  assert.equal(
    events.some(
      (event) =>
        event.stage === 'deployment_operation' &&
        event.operation === 'orchestrate_deployment_request' &&
        event.status === 'failed' &&
        event.errorCode === 'DEPLOYMENT_REQUEST_FAILED'
    ),
    true
  );
  assert.doesNotMatch(JSON.stringify({ body, deployment, events }), /secret=|must-not-be-returned/);
});

test('POST deploy reconciles committed traffic when success persistence and trailing trace work both fail', async () => {
  const store = await createSeededStore();
  let finalWriteFailed = false;
  const originalUpdateDeployment = store.updateDeployment.bind(store);
  store.updateDeployment = async (deploymentId, patch) => {
    if (patch.status === 'succeeded' && !finalWriteFailed) {
      finalWriteFailed = true;
      throw new Error('first terminal write failed');
    }
    return originalUpdateDeployment(deploymentId, patch);
  };
  const env = testEnv(store, createSnapshotStore());
  const originalNextId = env.nextId;
  let postFailureTraceIds = 0;
  env.nextId = (prefix) => {
    if (prefix === 'dpe' && finalWriteFailed) {
      postFailureTraceIds += 1;
      if (postFailureTraceIds === 2) throw new Error('token=must-not-be-returned');
    }
    return originalNextId(prefix);
  };

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'trace_double_post_commit_exception',
    }),
    env
  );
  const traceId = response.headers.get('X-Deployment-Trace-Id');
  const body = await response.json();
  const deployment = await store.getDeployment('dep_1', 'production');
  const route = await store.getRouteBySiteId('site_1', 'production');
  const events = await store.listDeploymentEvents({ environment: 'production', traceId });

  assert.equal(response.status, 201);
  assert.equal(body.deployment.status, 'succeeded');
  assert.equal(deployment.status, 'succeeded');
  assert.equal(route.activeVersionId, 'ver_1');
  assert.equal(
    events.some(
      (event) =>
        event.stage === 'deployment_state_persist' &&
        event.operation === 'reconcile_committed_deployment' &&
        event.status === 'compensated'
    ),
    true
  );
  assert.doesNotMatch(JSON.stringify({ body, deployment, events }), /token=|must-not-be-returned/);
});

test('POST deployment intake and payload failures return trace headers and events without deployment ids', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());

  const missingKey = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload()),
    env
  );
  const invalidProtocol = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'trace_invalid_protocol',
    }),
    env
  );
  const hashMismatch = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ expectedContentHash: `sha256:${'0'.repeat(64)}` }),
      { 'Idempotency-Key': 'trace_hash_mismatch' }
    ),
    env
  );
  const malformedMultipart = await worker.fetch(
    new Request('https://api.pages.xd.team/.xd-pages/api/deployments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BEARER_USR_1}`,
        'CF-Connecting-IP': '10.1.2.3',
        'Idempotency-Key': 'trace_malformed_multipart',
        'Content-Type': 'multipart/form-data; boundary=broken-boundary',
      },
      body: 'not-a-valid-multipart-body',
    }),
    env
  );

  for (const [response, stage, operation, code] of [
    [missingKey, 'intake', 'read_idempotency_key', 'IDEMPOTENCY_KEY_REQUIRED'],
    [invalidProtocol, 'intake', 'parse_multipart', 'CLI_UPLOAD_PROTOCOL_REQUIRED'],
    [hashMismatch, 'payload_validation', 'validate_content_hash', 'CONTENT_HASH_MISMATCH'],
    [malformedMultipart, 'intake', 'parse_multipart', 'INVALID_MULTIPART'],
  ]) {
    const traceId = response.headers.get('X-Deployment-Trace-Id');
    assert.match(traceId, /^dtr_\d+$/);
    assert.equal((await response.clone().json()).error.code, code);
    const events = await store.listDeploymentEvents({ environment: 'production', traceId });
    assert.equal(
      events.some(
        (event) =>
          event.stage === stage && event.operation === operation && event.status === 'failed' && event.deploymentId === null
      ),
      true
    );
  }
});

test('POST deployment validation failures before record creation leave a payload trace event', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: undefined }),
      { 'Idempotency-Key': 'trace_site_required' }
    ),
    timelineTestEnv(store, createSnapshotStore())
  );

  const traceId = response.headers.get('X-Deployment-Trace-Id');
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'SITE_REQUIRED');
  assert.equal(
    (await store.listDeploymentEvents({ environment: 'production', traceId })).some(
      (event) =>
        event.stage === 'payload_validation' &&
        event.status === 'failed' &&
        event.errorCode === 'SITE_REQUIRED' &&
        event.deploymentId === null
    ),
    true
  );
});

test('POST deployment record creation failures keep a queryable trace', async () => {
  const store = await createSeededStore();
  store.createDeploymentForIdempotency = async () => {
    throw new Error('must-not-be-exposed');
  };
  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'trace_record_failure',
    }),
    testEnv(store, createSnapshotStore())
  );

  const traceId = response.headers.get('X-Deployment-Trace-Id');
  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'DEPLOYMENT_STATE_WRITE_FAILED');
  assert.equal(
    (await store.listDeploymentEvents({ environment: 'production', traceId })).some(
      (event) =>
        event.stage === 'deployment_record' &&
        event.operation === 'create_deployment' &&
        event.status === 'failed' &&
        event.deploymentId === null
    ),
    true
  );
});

test('GET deployment reads do not create a request trace header', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/deployments/dep_missing'),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.headers.has('X-Deployment-Trace-Id'), false);
});

test('POST rollback responses persist a main trace and capture pre-deployment failures', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'trace_rollback_deploy_1',
      }),
      env
    )
  );
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
        { 'Idempotency-Key': 'trace_rollback_deploy_2' }
      ),
      env
    )
  );

  const rollback = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      {
        'Idempotency-Key': 'trace_rollback_success',
        'cf-ray': 'rollback-ray-SIN',
      }
    ),
    env
  );
  const missingKey = await worker.fetch(jsonRequest('https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback', {}), env);

  assert.equal(rollback.status, 201, await rollback.clone().text());
  const rollbackTraceId = rollback.headers.get('X-Deployment-Trace-Id');
  assert.equal((await store.getDeployment('dep_3', 'production')).traceId, rollbackTraceId);
  assert.equal(
    (await store.listDeploymentEvents({ environment: 'production', traceId: rollbackTraceId })).some(
      (event) => event.operation === 'create_deployment' && event.deploymentId === 'dep_3'
    ),
    true
  );
  const failureTraceId = missingKey.headers.get('X-Deployment-Trace-Id');
  assert.equal(missingKey.status, 400);
  assert.equal(
    (await store.listDeploymentEvents({ environment: 'production', traceId: failureTraceId })).some(
      (event) => event.stage === 'intake' && event.status === 'failed' && event.deploymentId === null
    ),
    true
  );
});

test('POST rollback exceptions after record creation terminalize the deployment at the orchestration stage', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'trace_rollback_exception_deploy_1',
      }),
      env
    )
  );
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
        { 'Idempotency-Key': 'trace_rollback_exception_deploy_2' }
      ),
      env
    )
  );

  let deploymentRecordFinished = false;
  let injected = false;
  const originalCreateDeploymentEvent = store.createDeploymentEvent.bind(store);
  store.createDeploymentEvent = async (event) => {
    const created = await originalCreateDeploymentEvent(event);
    if (
      event.stage === 'deployment_record' &&
      event.operation === 'create_deployment' &&
      event.status === 'succeeded' &&
      event.deploymentId === 'dep_3'
    ) {
      deploymentRecordFinished = true;
    }
    return created;
  };
  const originalNextId = env.nextId;
  env.nextId = (prefix) => {
    if (prefix === 'dpe' && deploymentRecordFinished && !injected) {
      injected = true;
      throw new Error('token=must-not-be-returned');
    }
    return originalNextId(prefix);
  };

  const response = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      { 'Idempotency-Key': 'trace_rollback_post_record_exception' }
    ),
    env
  );
  const traceId = response.headers.get('X-Deployment-Trace-Id');
  const body = await response.json();
  const deployment = await store.getDeployment('dep_3', 'production');
  const events = await store.listDeploymentEvents({ environment: 'production', traceId });

  assert.equal(response.status, 500);
  assert.equal(body.error.code, 'DEPLOYMENT_REQUEST_FAILED');
  assert.equal(deployment.status, 'failed');
  assert.equal(deployment.errorCode, 'DEPLOYMENT_REQUEST_FAILED');
  assert.equal(deployment.failureStage, 'deployment_operation');
  assert.equal((await store.getRouteBySiteId('site_1', 'production')).activeVersionId, 'ver_2');
  assert.equal(
    events.some(
      (event) =>
        event.stage === 'deployment_operation' &&
        event.operation === 'orchestrate_rollback_request' &&
        event.status === 'failed' &&
        event.errorCode === 'DEPLOYMENT_REQUEST_FAILED'
    ),
    true
  );
  assert.doesNotMatch(JSON.stringify({ body, deployment, events }), /token=|must-not-be-returned/);
});

test('successful worker-with-assets deployments persist the complete ordered stage timeline', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      workerWithAssetsDeploymentFields({ vars: { FEATURE_FLAG: 'enabled' } }),
      { 'Idempotency-Key': 'trace_complete_timeline' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 201, await response.clone().text());
  const events = await store.listDeploymentEvents({
    environment: 'production',
    traceId: response.headers.get('X-Deployment-Trace-Id'),
  });
  assert.deepEqual(
    events.map((event) => ({ stage: event.stage, operation: event.operation, status: event.status })),
    [
      { stage: 'intake', operation: 'accept_request', status: 'succeeded' },
      { stage: 'auth_and_site_resolution', operation: 'authenticate_request', status: 'succeeded' },
      { stage: 'intake', operation: 'parse_multipart', status: 'succeeded' },
      { stage: 'payload_validation', operation: 'validate_deployment_payload', status: 'succeeded' },
      { stage: 'deployment_record', operation: 'create_deployment', status: 'succeeded' },
      { stage: 'runtime_config', operation: 'resolve_runtime_config', status: 'succeeded' },
      { stage: 'provider_upload', operation: 'provider_upload', status: 'succeeded' },
      { stage: 'provider_verify', operation: 'provider_verify', status: 'succeeded' },
      { stage: 'runtime_config_commit', operation: 'commit_runtime_config', status: 'succeeded' },
      { stage: 'version_create', operation: 'create_site_version', status: 'succeeded' },
      { stage: 'route_policy_lock', operation: 'acquire_site_commit_lock', status: 'succeeded' },
      { stage: 'office_net', operation: 'verify_public_office_net_absent', status: 'skipped' },
      { stage: 'route_activate', operation: 'activate_route', status: 'succeeded' },
      { stage: 'route_snapshot', operation: 'write_route_snapshot', status: 'succeeded' },
      { stage: 'deployment_state_persist', operation: 'persist_succeeded_deployment', status: 'succeeded' },
      { stage: 'cleanup_or_compensation', operation: 'worker_placeholder_put', status: 'skipped' },
      { stage: 'cleanup_or_compensation', operation: 'worker_delete', status: 'skipped' },
      { stage: 'webhook_delivery', operation: 'site_deployed', status: 'skipped' },
    ]
  );
  for (const event of events) {
    assert.match(event.startedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(event.completedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(Number.isInteger(event.durationMs) && event.durationMs >= 0, true);
  }
});

test('provider stage failures persist the failing provider operation and terminal deployment evidence', async () => {
  const store = await createSeededStore();
  const providerError = Object.assign(new Error('must not be persisted'), {
    operation: 'assets_upload',
  });
  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'trace_provider_upload_failure',
    }),
    timelineTestEnv(store, createSnapshotStore(), {
      WFP_PROVIDER: {
        upload: async () => {
          throw providerError;
        },
        verify: async () => {
          throw new Error('verify should not run');
        },
      },
    })
  );

  assert.equal(response.status, 502, await response.clone().text());
  const events = await store.listDeploymentEvents({ environment: 'production', deploymentId: 'dep_1' });
  assert.deepEqual(
    events
      .filter((event) => ['provider_upload', 'deployment_state_persist', 'webhook_delivery'].includes(event.stage))
      .map((event) => ({ stage: event.stage, operation: event.operation, status: event.status })),
    [
      { stage: 'provider_upload', operation: 'assets_upload', status: 'failed' },
      { stage: 'deployment_state_persist', operation: 'persist_failed_deployment', status: 'succeeded' },
      { stage: 'webhook_delivery', operation: 'site_failed', status: 'skipped' },
    ]
  );
  assert.doesNotMatch(JSON.stringify(events), /must not be persisted/);
});

test('normal worker slot failures persist safe Cloudflare diagnostics on the provider stage event', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  let requestCount = 0;
  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'trace_normal_slot_provider_failure',
    }),
    timelineTestEnv(store, createSnapshotStore(), {
      PAGES_EXECUTION_MODE: 'normal-worker-slot',
      CF_ACCOUNT_ID: 'account_1',
      CF_API_TOKEN: 'cf_secret_token',
      fetch: async () => {
        requestCount += 1;
        if (requestCount === 2) {
          return Response.json(
            {
              success: false,
              errors: [
                {
                  code: 1000,
                  message: 'upload rejected cf_secret_token https://api.cloudflare.com/client/v4/accounts/account_1',
                },
              ],
            },
            { status: 502, headers: { 'cf-ray': 'normal-slot-ray-1' } }
          );
        }
        return Response.json({ success: true, result: { id: 'ok' } });
      },
    })
  );

  assert.equal(response.status, 502, await response.clone().text());
  const events = await store.listDeploymentEvents({ environment: 'production', deploymentId: 'dep_1' });
  const failedUpload = events.find((event) => event.stage === 'provider_upload' && event.status === 'failed');
  assert.equal(failedUpload.operation, 'worker_put');
  assert.deepEqual(failedUpload.diagnostics, {
    causeClass: 'provider_upload_error',
    httpStatus: 502,
    clientCode: 'WFP_API_ERROR',
    providerCode: '1000',
    providerMessage: 'upload rejected [redacted] [redacted-url]',
    providerRequestId: 'normal-slot-ray-1',
  });
  assert.doesNotMatch(JSON.stringify(failedUpload), /cf_secret_token|https:\/\//);
});

test('deployment state, version creation, and policy lock failures persist their exact failing stages', async () => {
  const scenarios = [
    {
      name: 'uploading state',
      mutate(store) {
        const updateDeployment = store.updateDeployment.bind(store);
        store.updateDeployment = async (id, patch) => {
          if (patch.status === 'uploading') throw new Error('uploading state unavailable');
          return updateDeployment(id, patch);
        };
      },
      expectedStatus: 503,
      expectedCode: 'DEPLOYMENT_STATE_WRITE_FAILED',
      expectedStage: 'deployment_state_persist',
      expectedOperation: 'persist_uploading_deployment',
    },
    {
      name: 'uploaded state',
      mutate(store) {
        const updateDeployment = store.updateDeployment.bind(store);
        store.updateDeployment = async (id, patch) => {
          if (patch.status === 'uploaded') throw new Error('uploaded state unavailable');
          return updateDeployment(id, patch);
        };
      },
      expectedStatus: 503,
      expectedCode: 'DEPLOYMENT_STATE_WRITE_FAILED',
      expectedStage: 'deployment_state_persist',
      expectedOperation: 'persist_uploaded_deployment',
    },
    {
      name: 'version create',
      mutate(store) {
        store.createSiteVersion = async () => {
          throw new Error('version store unavailable');
        };
      },
      expectedStatus: 503,
      expectedCode: 'DEPLOYMENT_STATE_WRITE_FAILED',
      expectedStage: 'version_create',
      expectedOperation: 'create_site_version',
    },
    {
      name: 'policy lock',
      mutate(store) {
        store.withSiteCommitLock = undefined;
      },
      expectedStatus: 409,
      expectedCode: 'SITE_POLICY_LOCKED',
      expectedStage: 'route_policy_lock',
      expectedOperation: 'acquire_site_commit_lock',
    },
  ];

  for (const scenario of scenarios) {
    const store = await createSeededStore();
    scenario.mutate(store);
    const response = await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': `trace_${scenario.name.replaceAll(' ', '_')}`,
      }),
      timelineTestEnv(store, createSnapshotStore())
    );

    assert.equal(response.status, scenario.expectedStatus, `${scenario.name}: ${await response.clone().text()}`);
    assert.equal((await response.clone().json()).error.code, scenario.expectedCode);
    const events = await store.listDeploymentEvents({ environment: 'production', deploymentId: 'dep_1' });
    assert.equal(
      events.some(
        (event) =>
          event.stage === scenario.expectedStage && event.operation === scenario.expectedOperation && event.status === 'failed'
      ),
      true,
      `${scenario.name}: ${JSON.stringify(events)}`
    );
    if (scenario.name === 'policy lock') {
      const failedDeployment = await store.getDeployment('dep_1', 'production');
      const cleanupEvent = events.find(
        (event) => event.stage === 'cleanup_or_compensation' && event.operation === 'worker_delete'
      );
      assert.equal(failedDeployment.failureStage, 'route_policy_lock');
      assert.equal(failedDeployment.failureDiagnostics.stage, 'route_policy_lock');
      assert.deepEqual(cleanupEvent.diagnostics.originalFailure, {
        stage: 'route_policy_lock',
        code: 'SITE_POLICY_LOCKED',
      });
    }
  }
});

test('rollback uses the shared timeline with rollback-specific route operations', async () => {
  const store = await createSeededStore();
  const env = timelineTestEnv(store, createSnapshotStore());
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'timeline_rollback_deploy_1',
      }),
      env
    )
  );
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
        { 'Idempotency-Key': 'timeline_rollback_deploy_2' }
      ),
      env
    )
  );

  const response = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      {
        'Idempotency-Key': 'trace_complete_rollback',
      }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  const events = await store.listDeploymentEvents({
    environment: 'production',
    traceId: response.headers.get('X-Deployment-Trace-Id'),
  });
  assert.deepEqual(
    events.map((event) => ({ stage: event.stage, operation: event.operation, status: event.status })),
    [
      { stage: 'intake', operation: 'accept_request', status: 'succeeded' },
      { stage: 'auth_and_site_resolution', operation: 'authenticate_request', status: 'succeeded' },
      { stage: 'intake', operation: 'parse_json', status: 'succeeded' },
      { stage: 'payload_validation', operation: 'rollback_validate', status: 'succeeded' },
      { stage: 'deployment_record', operation: 'create_deployment', status: 'succeeded' },
      { stage: 'runtime_config', operation: 'rollback_runtime_config_not_applicable', status: 'skipped' },
      { stage: 'provider_upload', operation: 'rollback_provider_upload_not_applicable', status: 'skipped' },
      { stage: 'provider_verify', operation: 'rollback_provider_verify_not_applicable', status: 'skipped' },
      {
        stage: 'runtime_config_commit',
        operation: 'rollback_runtime_config_commit_not_applicable',
        status: 'skipped',
      },
      { stage: 'version_create', operation: 'rollback_version_create_not_applicable', status: 'skipped' },
      { stage: 'route_policy_lock', operation: 'rollback_policy_lock', status: 'succeeded' },
      { stage: 'office_net', operation: 'rollback_verify_public_office_net_absent', status: 'skipped' },
      { stage: 'route_activate', operation: 'rollback_route_activate', status: 'succeeded' },
      { stage: 'route_snapshot', operation: 'rollback_route_snapshot', status: 'succeeded' },
      { stage: 'deployment_state_persist', operation: 'persist_succeeded_deployment', status: 'succeeded' },
      { stage: 'webhook_delivery', operation: 'rollback_no_webhook', status: 'skipped' },
    ]
  );
});

test('rollback failures preserve the failed stage, compensation, terminal persistence, and webhook outcome', async () => {
  const scenarios = [
    {
      name: 'policy lock',
      mutate(store) {
        store.acquireSiteCommitLock = async () => {
          throw new Error('lock unavailable');
        };
      },
      expectedCode: 'SITE_POLICY_LOCKED',
      expectedEvents: [
        { stage: 'route_policy_lock', operation: 'rollback_policy_lock', status: 'failed' },
        { stage: 'deployment_state_persist', operation: 'persist_failed_deployment', status: 'succeeded' },
        { stage: 'webhook_delivery', operation: 'site_failed', status: 'skipped' },
      ],
    },
    {
      name: 'snapshot compensation',
      mutate(_store, env, snapshots) {
        env.ROUTE_SNAPSHOTS = failFirstSnapshotPutAfter(snapshots, async () => {});
      },
      expectedCode: 'ROUTE_SNAPSHOT_WRITE_FAILED',
      expectedEvents: [
        { stage: 'route_snapshot', operation: 'rollback_route_snapshot', status: 'failed' },
        {
          stage: 'cleanup_or_compensation',
          operation: 'rollback_restore_route_after_snapshot_failure',
          status: 'compensated',
        },
        { stage: 'deployment_state_persist', operation: 'persist_failed_deployment', status: 'succeeded' },
        { stage: 'webhook_delivery', operation: 'site_failed', status: 'skipped' },
      ],
    },
  ];

  for (const scenario of scenarios) {
    const store = await createSeededStore();
    const snapshots = createSnapshotStore();
    const env = timelineTestEnv(store, snapshots);
    await assertDeployOk(
      await worker.fetch(
        deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
          'Idempotency-Key': `rollback_failure_${scenario.name}_deploy_1`,
        }),
        env
      )
    );
    await assertDeployOk(
      await worker.fetch(
        deploymentRequest(
          'https://api.pages.xd.team/.xd-pages/api/deployments',
          deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
          { 'Idempotency-Key': `rollback_failure_${scenario.name}_deploy_2` }
        ),
        env
      )
    );
    scenario.mutate(store, env, snapshots);

    const response = await worker.fetch(
      jsonRequest(
        'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
        {},
        {
          'Idempotency-Key': `rollback_failure_${scenario.name}`,
        }
      ),
      env
    );

    assert.notEqual(response.status, 201);
    assert.equal((await response.clone().json()).error.code, scenario.expectedCode);
    const events = await store.listDeploymentEvents({ environment: 'production', deploymentId: 'dep_3' });
    const relevant = events
      .filter((event) =>
        scenario.expectedEvents.some((expected) => expected.stage === event.stage && expected.operation === event.operation)
      )
      .map((event) => ({ stage: event.stage, operation: event.operation, status: event.status }));
    assert.deepEqual(relevant, scenario.expectedEvents, `${scenario.name}: ${JSON.stringify(events)}`);
  }
});

test('webhook delivery events distinguish success, failure, and no matching subscription without leaking targets', async () => {
  const scenarios = [
    { name: 'success', responseStatus: 200, expectedStatus: 'succeeded' },
    { name: 'failure', responseStatus: 500, expectedStatus: 'failed' },
    { name: 'skipped', responseStatus: null, expectedStatus: 'skipped' },
  ];

  for (const scenario of scenarios) {
    const store = await createSeededStore();
    await seedPlatformAdmin(store);
    const targetUrl = 'https://hooks.slack.com/services/T000/B000/trace-secret';
    const env = timelineTestEnv(store, createSnapshotStore(), {
      WEBHOOK_URL_ENCRYPTION_KEY: 'test-webhook-url-key',
      resolveWebhookHost: async () => ['8.8.8.8'],
      WEBHOOK_FETCH: async () => new Response('result', { status: scenario.responseStatus || 200 }),
    });
    if (scenario.responseStatus !== null) {
      const created = await worker.fetch(
        internalConsoleRequest('/.xd-pages/api/console/admin/webhooks', {
          method: 'POST',
          body: {
            name: `Trace ${scenario.name}`,
            url: targetUrl,
            events: ['site.deployed'],
            payloadMode: 'standard',
          },
        }),
        env
      );
      assert.equal(created.status, 201, await created.clone().text());
    }

    const response = await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': `trace_webhook_${scenario.name}`,
      }),
      env
    );
    assert.equal(response.status, 201, await response.clone().text());

    const events = await store.listDeploymentEvents({ environment: 'production', deploymentId: 'dep_1' });
    const webhook = events.find((event) => event.stage === 'webhook_delivery');
    assert.equal(webhook.operation, 'site_deployed');
    assert.equal(webhook.status, scenario.expectedStatus);
    if (scenario.expectedStatus === 'failed') {
      assert.equal(webhook.diagnostics.causeClass, 'webhook_delivery_error');
    }
    assert.doesNotMatch(JSON.stringify(webhook), /hooks\.slack\.com|trace-secret/);
  }
});

test('creates a deployment with production ID generation when env.nextId is unavailable', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots);
  delete env.nextId;

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'production_id_generation_deploy',
    }),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json();
  assert.equal(body.deployment.status, 'succeeded');
  assert.match(body.deployment.id, /^dep_[a-f0-9]{32}$/);
  assert.match(body.deployment.versionId, /^ver_[a-f0-9]{32}$/);
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, body.deployment.versionId);
});

test('rolls back with production ID generation when env.nextId is unavailable', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots);

  const first = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'production_id_generation_rollback_1',
    }),
    env
  );
  const second = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("second"); } };' }),
      { 'Idempotency-Key': 'production_id_generation_rollback_2' }
    ),
    env
  );
  assert.equal(first.status, 201, await first.clone().text());
  assert.equal(second.status, 201, await second.clone().text());
  const firstBody = await first.json();
  delete env.nextId;

  const rollback = await worker.fetch(
    jsonRequest(
      `https://api.pages.xd.team/.xd-pages/api/versions/${firstBody.deployment.versionId}/rollback`,
      {},
      { 'Idempotency-Key': 'production_id_generation_rollback' }
    ),
    env
  );

  assert.equal(rollback.status, 201, await rollback.clone().text());
  const body = await rollback.json();
  assert.equal(body.deployment.status, 'succeeded');
  assert.equal(body.route.activeVersionId, firstBody.deployment.versionId);
  assert.match(body.deployment.id, /^dep_[a-f0-9]{32}$/);
});

test('does not fail a deployment when the KV pointer read remains on the previous snapshot', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots);

  const first = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'stale_pointer_first',
    }),
    env
  );
  assert.equal(first.status, 201, await first.clone().text());

  env.ROUTE_SNAPSHOTS = stalePointerSnapshotStore(snapshots);
  const second = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
      { 'Idempotency-Key': 'stale_pointer_second' }
    ),
    env
  );

  assert.equal(second.status, 201, await second.clone().text());
  assert.equal((await store.getDeployment('dep_2')).status, 'succeeded');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_2');
});

test('does not fail an assets-only internal deployment when a missing KV pointer is negatively cached', async () => {
  const store = await createSeededStore();
  await store.updateSiteVisibility('site_1', { visibility: 'internal', updatedAt: '2026-06-15T00:00:01.000Z' }, 'production');
  const snapshots = createSnapshotStore();
  const env = testEnv(store, negativePointerSnapshotStore(snapshots));

  const response = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'auto',
        source: 'cli',
        publishPlan: {
          deploymentShape: 'assets-only',
          requestedFallback: 'auto',
          resolvedFallback: 'index',
          routingMode: 'assets-only',
          workerEntry: null,
          assetsConfig: { notFoundHandling: 'single-page-application' },
        },
        assetManifest: [
          {
            path: '/index.html',
            partName: 'asset-file-0',
            size: 5,
            contentType: 'text/html; charset=utf-8',
          },
        ],
        files: [{ field: 'asset-file-0', filename: 'index.html', content: 'hello', type: 'text/html; charset=utf-8' }],
      },
      { 'Idempotency-Key': 'negative_pointer_assets_only' }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.equal((await store.getDeployment('dep_1')).status, 'succeeded');
  assert.equal((await store.getRouteBySiteId('site_1')).visibility, 'internal');
});

test('successful deployments deliver site.deployed webhooks for matching subscriptions', async () => {
  const store = await createSeededStore();
  await seedPlatformAdmin(store);
  const requests = [];
  const env = testEnv(store, createSnapshotStore(), {
    WEBHOOK_URL_ENCRYPTION_KEY: 'test-webhook-url-key',
    resolveWebhookHost: async () => ['8.8.8.8'],
    WEBHOOK_FETCH: async (request) => {
      requests.push(request);
      return new Response('ok', { status: 200 });
    },
  });

  const created = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/webhooks', {
      method: 'POST',
      body: {
        name: 'Slack deploy events',
        url: 'https://hooks.slack.com/services/T000/B000/token',
        events: ['site.deployed'],
        payloadMode: 'standard',
      },
    }),
    env
  );
  assert.equal(created.status, 201, await created.clone().text());

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'deploy_1' }),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(requests.length, 1);
  assert.equal(requests[0].headers.get('X-XD-Cell-Event'), 'site.deployed');
  const payload = await requests[0].json();
  assert.equal(payload.event.type, 'site.deployed');
  assert.equal(payload.site.slug, 'guide');
  assert.equal(payload.site.hostname, 'guide.pages.xd.team');
  assert.equal(payload.deployment.id, 'dep_1');
  assert.equal(payload.deployment.status, 'succeeded');
  const deliveries = await store.listWebhookDeliveries({ environment: 'production', subscriptionId: 'wh_1' });
  assert.equal(deliveries.length, 1);
  assert.equal(deliveries[0].deliveryStatus, 'succeeded');
  assert.equal(deliveries[0].eventType, 'site.deployed');
});

test('first persisted deployment failure delivers site.failed with safe failure fields only', async () => {
  const store = await createSeededStore();
  await seedPlatformAdmin(store);
  const requests = [];
  const env = testEnv(store, createSnapshotStore(), {
    WEBHOOK_URL_ENCRYPTION_KEY: 'test-webhook-url-key',
    resolveWebhookHost: async () => ['8.8.8.8'],
    WEBHOOK_FETCH: async (request) => {
      requests.push(request);
      return new Response('ok', { status: 200 });
    },
    WFP_PROVIDER: {
      upload: async () => {
        throw new Error('upload failed');
      },
      verify: async () => {
        throw new Error('verify should not run');
      },
    },
  });

  const created = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/webhooks', {
      method: 'POST',
      body: {
        name: 'Failure events',
        url: 'https://hooks.slack.com/services/T000/B000/token',
        events: ['site.failed'],
        payloadMode: 'standard',
      },
    }),
    env
  );
  assert.equal(created.status, 201, await created.clone().text());

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'failed-webhook-1',
    }),
    env
  );
  assert.equal(response.status, 502, await response.clone().text());
  assert.equal(requests.length, 1);
  const payload = await requests[0].json();
  assert.equal(payload.event.type, 'site.failed');
  assert.equal(payload.deployment.operation, 'deploy');
  assert.equal(payload.deployment.failureStage, 'upload_worker');
  assert.equal(payload.deployment.errorCode, 'DEPLOYMENT_UPLOAD_FAILED');
  assert.equal(payload.deployment.errorMessage, undefined);
  assert.equal(payload.deployment.failureDiagnostics, undefined);

  const replay = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'failed-webhook-1',
    }),
    env
  );
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.equal((await replay.json()).deployment.status, 'failed');
  assert.equal(requests.length, 1);
});

test('team-owned deployments include team fields in webhook payloads', async () => {
  const store = await createSeededStore();
  await seedPlatformAdmin(store);
  const team = await store.createTeam({
    id: 'team_webhook',
    environment: 'production',
    teamType: 'custom',
    name: 'Webhook Team',
    createdByUserId: 'usr_1',
  });
  const teamKey = await seedAccessKey(store, 'ak_team_webhook', ['deploy:site'], null, {
    ownerType: 'team',
    ownerId: team.id,
    ownerUserId: 'usr_1',
    createdByUserId: 'usr_1',
  });
  const requests = [];
  const env = testEnv(store, createSnapshotStore(), {
    WEBHOOK_URL_ENCRYPTION_KEY: 'test-webhook-url-key',
    resolveWebhookHost: async () => ['8.8.8.8'],
    WEBHOOK_FETCH: async (request) => {
      requests.push(request);
      return new Response('ok', { status: 200 });
    },
    nextId: (prefix) => {
      if (prefix === 'site') return 'site_webhook_team';
      if (prefix === 'route') return 'route_webhook_team';
      return `${prefix}_1`;
    },
  });

  const created = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/webhooks', {
      method: 'POST',
      body: {
        name: 'Team deploy events',
        url: 'https://hooks.slack.com/services/T000/B000/token',
        events: ['site.deployed'],
        payloadMode: 'standard',
      },
    }),
    env
  );
  assert.equal(created.status, 201, await created.clone().text());

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'team-webhook' }),
      {
        Authorization: `Bearer ${teamKey}`,
        'Idempotency-Key': 'deploy_team_webhook',
      }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(requests.length, 1);
  const payload = await requests[0].json();
  assert.deepEqual(payload.team, {
    id: 'team_webhook',
    name: 'Webhook Team',
    teamType: 'custom',
  });
});

test('successful deployment schedules webhook delivery with waitUntil without blocking response', async () => {
  const store = await createSeededStore();
  await seedPlatformAdmin(store);
  let releaseWebhook;
  const waitUntilPromises = [];
  const env = testEnv(store, createSnapshotStore(), {
    WEBHOOK_URL_ENCRYPTION_KEY: 'test-webhook-url-key',
    resolveWebhookHost: async () => ['8.8.8.8'],
    WEBHOOK_FETCH: async () =>
      new Promise((resolve) => {
        releaseWebhook = () => resolve(new Response('ok', { status: 200 }));
      }),
  });

  const created = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/webhooks', {
      method: 'POST',
      body: {
        name: 'Slow deploy events',
        url: 'https://hooks.slack.com/services/T000/B000/token',
        events: ['site.deployed'],
        payloadMode: 'standard',
      },
    }),
    env
  );
  assert.equal(created.status, 201, await created.clone().text());

  const responsePromise = worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'deploy_wait_until',
    }),
    env,
    {
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    }
  );
  const earlyResult = await Promise.race([
    responsePromise.then(() => 'response'),
    new Promise((resolve) => setTimeout(() => resolve('blocked'), 20)),
  ]);
  if (earlyResult === 'blocked') {
    for (let attempt = 0; attempt < 10 && !releaseWebhook; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    releaseWebhook?.();
  }
  const response = await responsePromise;

  assert.equal(earlyResult, 'response');
  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(waitUntilPromises.length, 1);
  if (!releaseWebhook) {
    for (let attempt = 0; attempt < 10 && !releaseWebhook; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  }
  assert.equal(typeof releaseWebhook, 'function');
  releaseWebhook();
  await waitUntilPromises[0];
  const deliveries = await store.listWebhookDeliveries({ environment: 'production', subscriptionId: 'wh_1' });
  assert.equal(deliveries[0].deliveryStatus, 'succeeded');
});

test('deployment preserves an existing pages.xd.team route hostname during workers-domain rollout', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'deploy_1' }),
    testEnv(store, snapshots)
  );
  const body = await response.json();

  assert.equal(response.status, 201);
  assert.equal(body.route.hostname, 'guide.pages.xd.team');
  assert.equal((await store.getRouteBySiteId('site_1')).hostname, 'guide.pages.xd.team');
  assert.equal(snapshots.read('production:route_pointer:guide.pages.xd.team').routeGeneration, 1);
  assert.equal(snapshots.read('production:route_pointer:guide.workers.xd.team'), undefined);
});

test('uploads and verifies WFP worker before route activation', async () => {
  const store = await createSeededStore();
  const events = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => {
        events.push(['upload', workerName, (await store.getRouteBySiteId('site_1')).activeVersionId]);
        return { artifactRef: `wfp://test/${workerName}` };
      },
      verify: async ({ workerName }) => {
        events.push(['verify', workerName, (await store.getRouteBySiteId('site_1')).activeVersionId]);
        return { ok: true };
      },
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        contentHash: 'sha256:abc',
        artifactBundle: workerBundle('export default {};'),
      },
      { 'Idempotency-Key': 'wfp_order' }
    ),
    env
  );

  assert.equal(response.status, 201);
  assert.deepEqual(events, [
    ['upload', 'pages-v2-guide-ver-1', null],
    ['verify', 'pages-v2-guide-ver-1', null],
  ]);
  assert.equal((await store.getDeployment('dep_1')).status, 'succeeded');
});

test('successful WFP redeploy queues previous worker cleanup after route cutover', async () => {
  const store = await createSeededStore();
  const deletedWorkers = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => ({ ok: true }),
      delete: async ({ workerName }) => deletedWorkers.push(workerName),
    },
  });

  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'blue_green_1',
      }),
      env
    )
  );
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ moduleContent: 'export default { fetch() { return new Response("green"); } };' }),
        { 'Idempotency-Key': 'blue_green_2' }
      ),
      env
    )
  );

  const route = await store.getRouteBySiteId('site_1', 'production');
  const tasks = await store.listDeploymentResourceCleanupTasks({ environment: 'production' });

  assert.equal(route.activeVersionId, 'ver_2');
  assert.deepEqual(deletedWorkers, []);
  assert.deepEqual(tasks, [
    {
      id: 'cln_1',
      environment: 'production',
      resourceType: 'wfp_user_worker',
      resourceRef: 'pages-v2-guide-ver-1',
      siteId: 'site_1',
      versionId: 'ver_1',
      deploymentId: 'dep_2',
      cleanupReason: 'blue_green_previous_worker',
      status: 'pending',
      cleanupAfter: '2026-06-15T00:05:00.000Z',
      attemptCount: 0,
      lastErrorCode: null,
      lastErrorMessage: null,
      lockedUntil: null,
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
    },
  ]);
  const cleanupEvent = (await store.listDeploymentEvents({ environment: 'production', deploymentId: 'dep_2' })).find(
    (event) => event.stage === 'cleanup_or_compensation' && event.operation === 'worker_delete'
  );
  assert.equal(cleanupEvent.status, 'succeeded');
  assert.deepEqual(cleanupEvent.diagnostics, {
    causeClass: 'cleanup_scheduled',
    trafficImpact: 'new_version_active',
    cleanupStatus: 'scheduled',
    cleanupTaskId: 'cln_1',
    compensation: {
      status: 'scheduled',
      operation: 'worker_delete',
    },
  });
  assert.equal((await store.getSiteVersion('ver_1')).artifactAvailability, 'active');
});

test('keeps a committed WFP redeploy successful when cleanup task enqueueing fails', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());

  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'cleanup_enqueue_failure_seed',
      }),
      env
    )
  );
  store.createDeploymentResourceCleanupTask = async () => {
    throw new Error('SQL token=must-not-be-persisted');
  };

  const replacement = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("green"); } };' }),
      { 'Idempotency-Key': 'cleanup_enqueue_failure_replacement' }
    ),
    env
  );

  assert.equal(replacement.status, 201, await replacement.clone().text());
  assert.equal((await store.getDeployment('dep_2')).status, 'succeeded');
  const cleanupEvent = (await store.listDeploymentEvents({ environment: 'production', deploymentId: 'dep_2' })).find(
    (event) => event.stage === 'cleanup_or_compensation' && event.operation === 'worker_delete'
  );
  assert.equal(cleanupEvent.status, 'failed');
  assert.deepEqual(cleanupEvent.diagnostics, {
    causeClass: 'cleanup_task_store_error',
    trafficImpact: 'new_version_active',
    cleanupStatus: 'failed',
    cleanupTaskId: 'cln_1',
    compensation: {
      status: 'failed',
      operation: 'worker_delete',
    },
  });
  assert.doesNotMatch(JSON.stringify(cleanupEvent), /SQL|token|must-not-be-persisted/);
});

test('successful production redeploy does not queue cleanup for staging-prefixed previous worker', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());

  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'staging_prefix_seed',
      }),
      env
    )
  );

  await store.activateSiteVersion(
    'site_1',
    {
      activeVersionId: 'ver_1',
      workerName: 'pages-v2-staging-guide-ver-old',
      runtime: 'worker',
      executionProvider: 'wfp',
      dispatchType: 'dispatch-namespace',
      visibility: 'org',
      updatedAt: '2026-06-15T00:00:00.000Z',
    },
    'production',
    await store.getRouteBySiteId('site_1', 'production')
  );
  await writeCurrentRouteSnapshot(store, env.ROUTE_SNAPSHOTS);

  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'staging_prefix_previous_worker',
      }),
      env
    )
  );

  assert.deepEqual(await store.listDeploymentResourceCleanupTasks({ environment: 'production' }), []);
});

test('creates static deployment from multipart asset artifact without worker bundle', async () => {
  const store = await createSeededStore();
  const uploads = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async (input) => {
        uploads.push({
          assetManifest: input.assetManifest,
          assetFiles: input.assetFiles.map((file) => ({
            path: file.path,
            contentType: file.contentType,
            size: file.bytes.byteLength,
          })),
          artifactBundle: input.artifactBundle,
        });
        return { artifactRef: `assets://test/${input.workerName}` };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        contentHash: 'sha256:asset',
        assetManifest: {
          '/index.html': {
            hash: 'hash_index',
            size: '<h1>Hello</h1>'.length,
            content_type: 'text/html; charset=utf-8',
          },
        },
        files: [{ field: 'file-0', filename: 'index.html', content: '<h1>Hello</h1>', type: 'text/html' }],
      },
      { 'Idempotency-Key': 'asset_deploy' }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(uploads, [
    {
      assetManifest: {
        '/index.html': {
          hash: hashAsset(Buffer.from('<h1>Hello</h1>'), 'text/html'),
          size: '<h1>Hello</h1>'.length,
          content_type: 'text/html',
        },
      },
      assetFiles: [{ path: '/index.html', contentType: 'text/html', size: '<h1>Hello</h1>'.length }],
      artifactBundle: undefined,
    },
  ]);
  assert.equal((await store.getSiteVersion('ver_1')).artifactRef, 'assets://test/pages-v2-guide-ver-1');
});

test('accepts v2 publishPlan multipart metadata and passes resolved decision to provider', async () => {
  const store = await createSeededStore();
  const uploads = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async (input) => {
        uploads.push({
          decision: input.decision,
          assetManifest: input.assetManifest,
          assetFiles: input.assetFiles.map((file) => ({
            path: file.path,
            contentType: file.contentType,
            size: file.bytes.byteLength,
          })),
          artifactBundle: input.artifactBundle,
        });
        return { artifactRef: `assets://test/${input.workerName}` };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const response = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'auto',
        source: 'cli',
        publishPlan: {
          deploymentShape: 'assets-only',
          requestedFallback: 'auto',
          resolvedFallback: 'index',
          routingMode: 'assets-only',
          workerEntry: null,
          assetsConfig: { notFoundHandling: 'single-page-application' },
        },
        assetManifest: [
          {
            path: '/index.html',
            partName: 'asset-file-0',
            size: 5,
            contentType: 'text/html; charset=utf-8',
          },
        ],
        files: [{ field: 'asset-file-0', filename: 'index.html', content: 'hello', type: 'text/html; charset=utf-8' }],
      },
      { 'Idempotency-Key': 'publish_plan_ok' }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(uploads, [
    {
      decision: {
        deploymentShape: 'assets-only',
        requestedFallback: 'auto',
        resolvedFallback: 'index',
        routingMode: 'assets-only',
        workerEntry: null,
        assetsConfig: { notFoundHandling: 'single-page-application' },
      },
      assetManifest: {
        '/index.html': {
          hash: hashAsset(Buffer.from('hello'), 'text/html; charset=utf-8'),
          size: 5,
          content_type: 'text/html; charset=utf-8',
        },
      },
      assetFiles: [{ path: '/index.html', contentType: 'text/html; charset=utf-8', size: 5 }],
      artifactBundle: undefined,
    },
  ]);
  const body = await response.json();
  assert.equal(body.decision.deploymentShape, 'assets-only');
  assert.equal(body.decision.resolvedFallback, 'index');
  assert.deepEqual(body.version.decision, {
    deploymentShape: 'assets-only',
    requestedFallback: 'auto',
    resolvedFallback: 'index',
    routingMode: 'assets-only',
  });
  assertNoPublicExecutionDetails(body);
});

test('site normal worker override no longer diverts new deployments away from WFP', async () => {
  const store = await createSeededStore();
  store.sites.get('site_1').executionModeOverride = 'normal-worker-slot';
  await store.createWorkerSlot({
    id: 'slot_production_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  const uploads = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => {
        uploads.push(workerName);
        return { artifactRef: `wfp://test/${workerName}` };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'normal_override_uses_wfp',
    }),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(uploads, ['pages-v2-guide-ver-1']);
  assert.equal((await store.getSiteVersion('ver_1')).executionProvider, 'wfp');
  assert.equal((await store.getRouteBySiteId('site_1')).dispatchType, 'dispatch-namespace');
  assert.equal((await store.getWorkerSlot('slot_production_007')).status, 'available');
});

test('rejects xd-cell config as a public asset in publishPlan uploads', async () => {
  const store = await createSeededStore();
  const uploads = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async () => {
        uploads.push('upload');
        return { artifactRef: 'assets://unexpected' };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const response = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'auto',
        source: 'cli',
        publishPlan: {
          deploymentShape: 'assets-only',
          requestedFallback: 'auto',
          resolvedFallback: 'index',
          routingMode: 'assets-only',
          workerEntry: null,
          assetsConfig: { notFoundHandling: 'single-page-application' },
        },
        assetManifest: [
          {
            path: '/xd-cell.config.json',
            partName: 'asset-file-0',
            size: 2,
            contentType: 'application/json',
          },
        ],
        files: [{ field: 'asset-file-0', filename: 'xd-cell.config.json', content: '{}', type: 'application/json' }],
      },
      { 'Idempotency-Key': 'publish_plan_config_asset' }
    ),
    env
  );

  assert.equal(response.status, 400, await response.clone().text());
  assert.equal((await response.json()).error.code, 'ASSET_MANIFEST_INVALID');
  assert.deepEqual(uploads, []);
});

test('accepts v2 worker-with-assets publishPlan and builds Worker bundle plus assets', async () => {
  const store = await createSeededStore();
  const uploads = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async (input) => {
        uploads.push({
          decision: input.decision,
          mainModule: input.artifactBundle?.mainModule,
          modules: input.artifactBundle?.modules.map((module) => module.name),
          assetPaths: Object.keys(input.assetManifest || {}),
        });
        return { artifactRef: `worker-assets://test/${input.workerName}` };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const response = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteSlug: 'guide',
        requestedFallback: 'auto',
        source: 'cli',
        publishPlan: {
          deploymentShape: 'worker-with-assets',
          requestedFallback: 'auto',
          resolvedFallback: 'not-found',
          routingMode: 'worker-first',
          workerEntry: '_worker.js',
          workerMainModuleName: '_worker.js',
          assetsConfig: { notFoundHandling: '404-page' },
        },
        assetManifest: [
          {
            path: '/index.html',
            partName: 'asset-file-0',
            size: 5,
            contentType: 'text/html; charset=utf-8',
          },
        ],
        workerModules: [
          {
            moduleName: '_worker.js',
            partName: 'worker-main',
            size: 18,
            contentType: 'application/javascript+module',
          },
        ],
        files: [{ field: 'asset-file-0', filename: 'index.html', content: 'hello', type: 'text/html; charset=utf-8' }],
        worker: {
          field: 'worker-main',
          filename: '_worker.js',
          content: 'export default {};',
          type: 'application/javascript+module',
        },
      },
      { 'Idempotency-Key': 'publish_plan_worker_assets' }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(uploads, [
    {
      decision: {
        deploymentShape: 'worker-with-assets',
        requestedFallback: 'auto',
        resolvedFallback: 'not-found',
        routingMode: 'worker-first',
        workerEntry: '_worker.js',
        assetsConfig: { notFoundHandling: '404-page' },
      },
      mainModule: '_worker.js',
      modules: ['_worker.js'],
      assetPaths: ['/index.html'],
    },
  ]);
});

test('deployments validate vars and pass runtime bindings plus enabled site secrets to provider', async () => {
  const store = await createSeededStore();
  await store.putSiteSecret({
    id: 'sec_1',
    environment: 'production',
    siteId: 'site_1',
    name: 'API_TOKEN',
    value: 'super-secret-value',
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  const uploads = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async (input) => {
        uploads.push({
          runtimeBindings: input.runtimeBindings,
        });
        return { artifactRef: `wfp://test/${input.workerName}` };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({
        vars: { API_BASE: 'https://api.example.com/private' },
      }),
      { 'Idempotency-Key': 'runtime_config_deploy' }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(uploads, [
    {
      runtimeBindings: {
        vars: { API_BASE: 'https://api.example.com/private' },
        secrets: [{ name: 'API_TOKEN', value: 'super-secret-value', revision: 1 }],
      },
    },
  ]);
  const body = await response.json();
  assertJsonLeafValueAbsent(body, 'https://api.example.com/private');
  assert.equal(JSON.stringify(body).includes('super-secret-value'), false);
  assertPublicDeploymentEnvelopeHidesRuntimeConfig(body);
  const version = await store.getSiteVersion('ver_1');
  assert.deepEqual(version.varNamesJson, ['API_BASE']);
  assert.deepEqual(version.secretNamesJson, ['API_TOKEN']);
  assert.deepEqual(version.runtimeConfigSnapshotJson, {
    vars: [{ name: 'API_BASE', value: 'https://api.example.com/private', revision: 1 }],
    secrets: [{ name: 'API_TOKEN', revision: 1, valueHash: version.runtimeConfigSnapshotJson.secrets[0].valueHash }],
  });
  assert.match(version.runtimeConfigSnapshotJson.secrets[0].valueHash, /^[a-f0-9]{64}$/);
  assert.notEqual(version.runtimeConfigSnapshotJson.secrets[0].valueHash, 'super-secret-value');
  const replay = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({
        vars: { API_BASE: 'https://api.example.com/private' },
      }),
      { 'Idempotency-Key': 'runtime_config_deploy' }
    ),
    env
  );
  assert.equal(replay.status, 200, await replay.clone().text());
  assertPublicDeploymentEnvelopeHidesRuntimeConfig(await replay.json());
  const getResponse = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/deployments/dep_1'), env);
  assert.equal(getResponse.status, 200, await getResponse.clone().text());
  assertPublicDeploymentEnvelopeHidesRuntimeConfig(await getResponse.json());
  assert.deepEqual(await store.listEnabledSiteVars('production', 'site_1'), [
    {
      id: 'var_1',
      environment: 'production',
      siteId: 'site_1',
      name: 'API_BASE',
      value: 'https://api.example.com/private',
      revision: 1,
      createdBy: 'usr_1',
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
      deletedAt: null,
    },
  ]);
  assert.match((await store.getDeployment('dep_1')).requestHash, /^sha256:/);
});

test('deployments keep existing site vars when new clients omit vars from publish metadata', async () => {
  const store = await createSeededStore();
  const uploads = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async (input) => {
        uploads.push(input.runtimeBindings.vars);
        return { artifactRef: `wfp://test/${input.workerName}` };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const first = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload({ vars: { FEATURE_FLAG: 'on' } }), {
      'Idempotency-Key': 'site_vars_first',
    }),
    env
  );
  const second = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("second"); } };' }),
      { 'Idempotency-Key': 'site_vars_omitted' }
    ),
    env
  );

  assert.equal(first.status, 201, await first.clone().text());
  assert.equal(second.status, 201, await second.clone().text());
  assert.deepEqual(uploads, [{ FEATURE_FLAG: 'on' }, { FEATURE_FLAG: 'on' }]);
  assert.deepEqual((await store.getSiteVersion('ver_2')).runtimeConfigSnapshotJson, {
    vars: [{ name: 'FEATURE_FLAG', value: 'on', revision: 1 }],
    secrets: [],
  });
});

test('deployments clear site vars when vars is explicitly empty', async () => {
  const store = await createSeededStore();
  const uploads = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async (input) => {
        uploads.push(input.runtimeBindings.vars);
        return { artifactRef: `wfp://test/${input.workerName}` };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const first = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload({ vars: { FEATURE_FLAG: 'on' } }), {
      'Idempotency-Key': 'site_vars_seed',
    }),
    env
  );
  const second = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({
        moduleContent: 'export default { fetch() { return new Response("cleared"); } };',
        vars: {},
      }),
      { 'Idempotency-Key': 'site_vars_clear' }
    ),
    env
  );

  assert.equal(first.status, 201, await first.clone().text());
  assert.equal(second.status, 201, await second.clone().text());
  assert.deepEqual(uploads, [{ FEATURE_FLAG: 'on' }, {}]);
  assert.deepEqual(await store.listEnabledSiteVars('production', 'site_1'), []);
  assert.deepEqual((await store.getSiteVersion('ver_2')).runtimeConfigSnapshotJson, {
    vars: [],
    secrets: [],
  });
});

test('failed explicit vars deployment does not update site-level vars used by later omitted-vars deploy', async () => {
  const store = await createSeededStore();
  const uploads = [];
  let failNextUpload = false;
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async (input) => {
        uploads.push(input.runtimeBindings.vars);
        if (failNextUpload) throw new Error('upload failed');
        return { artifactRef: `wfp://test/${input.workerName}` };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const seed = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload({ vars: { FEATURE_FLAG: 'on' } }), {
      'Idempotency-Key': 'site_vars_seed_before_failure',
    }),
    env
  );
  failNextUpload = true;
  const failed = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({
        moduleContent: 'export default { fetch() { return new Response("failed"); } };',
        vars: { FEATURE_FLAG: 'failed' },
      }),
      { 'Idempotency-Key': 'site_vars_failed_deploy' }
    ),
    env
  );
  failNextUpload = false;
  const omitted = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("omitted"); } };' }),
      { 'Idempotency-Key': 'site_vars_after_failed_deploy' }
    ),
    env
  );

  assert.equal(seed.status, 201, await seed.clone().text());
  assert.equal(failed.status, 502, await failed.clone().text());
  assert.equal(omitted.status, 201, await omitted.clone().text());
  const omittedBody = await omitted.json();
  assert.deepEqual(uploads, [{ FEATURE_FLAG: 'on' }, { FEATURE_FLAG: 'failed' }, { FEATURE_FLAG: 'on' }]);
  assert.deepEqual(await store.listEnabledSiteVars('production', 'site_1'), [
    {
      id: 'var_1',
      environment: 'production',
      siteId: 'site_1',
      name: 'FEATURE_FLAG',
      value: 'on',
      revision: 1,
      createdBy: 'usr_1',
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
      deletedAt: null,
    },
  ]);
  assert.deepEqual((await store.getSiteVersion(omittedBody.deployment.versionId)).runtimeConfigSnapshotJson, {
    vars: [{ name: 'FEATURE_FLAG', value: 'on', revision: 1 }],
    secrets: [],
  });
});

test('assets-only deploys ignore vars metadata without syncing site vars', async () => {
  const store = await createSeededStore();
  await store.replaceSiteVars({
    environment: 'production',
    siteId: 'site_1',
    vars: { FEATURE_FLAG: 'on' },
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  const uploads = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async (input) => {
        uploads.push(input.runtimeBindings);
        return { artifactRef: `wfp://test/${input.workerName}` };
      },
      verify: async () => ({ ok: true }),
    },
  });
  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        vars: { API_BASE: 'https://api.example.com/static' },
        files: [{ field: 'asset-index', filename: 'index.html', content: '<h1>Hello</h1>', type: 'text/html' }],
      },
      { 'Idempotency-Key': 'assets_vars_noop' }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.deepEqual(uploads, [{ vars: {}, secrets: [] }]);
  assert.deepEqual(await store.listEnabledSiteVars('production', 'site_1'), [
    {
      id: 'var_1',
      environment: 'production',
      siteId: 'site_1',
      name: 'FEATURE_FLAG',
      value: 'on',
      revision: 1,
      createdBy: 'usr_1',
      createdAt: '2026-06-15T00:00:00.000Z',
      updatedAt: '2026-06-15T00:00:00.000Z',
      deletedAt: null,
    },
  ]);
  const version = await store.getSiteVersion('ver_1');
  assert.deepEqual(version.varNamesJson, []);
  assert.deepEqual(version.runtimeConfigSnapshotJson, { vars: [], secrets: [] });
});

test('assets-only deploys ignore invalid vars metadata and keep idempotency independent from vars', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());
  const first = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        vars: { API_TOKEN: 1 },
        files: [{ field: 'asset-index', filename: 'index.html', content: '<h1>Hello</h1>', type: 'text/html' }],
      },
      { 'Idempotency-Key': 'assets_vars_invalid_noop' }
    ),
    env
  );
  const second = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        vars: { OTHER_TOKEN: 'ignored' },
        files: [{ field: 'asset-index', filename: 'index.html', content: '<h1>Hello</h1>', type: 'text/html' }],
      },
      { 'Idempotency-Key': 'assets_vars_invalid_noop' }
    ),
    env
  );

  assert.equal(first.status, 201, await first.clone().text());
  assert.equal(second.status, 200, await second.clone().text());
  assert.deepEqual(await store.listEnabledSiteVars('production', 'site_1'), []);
  assert.deepEqual((await store.getSiteVersion('ver_1')).runtimeConfigSnapshotJson, { vars: [], secrets: [] });
});

test('deployment request hash uses secret revisions without hashing secret values', async () => {
  async function deployWithSecretValue(value) {
    const store = await createSeededStore();
    await store.putSiteSecret({
      id: 'sec_1',
      environment: 'production',
      siteId: 'site_1',
      name: 'API_TOKEN',
      value,
      actorId: 'usr_1',
      updatedAt: '2026-06-15T00:00:00.000Z',
    });
    const env = testEnv(store, createSnapshotStore(), {
      WFP_PROVIDER: {
        upload: async (input) => ({ artifactRef: `wfp://test/${input.workerName}` }),
        verify: async () => ({ ok: true }),
      },
    });

    const response = await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ vars: { API_BASE: 'https://api.example.com' } }),
        { 'Idempotency-Key': 'runtime_config_revision' }
      ),
      env
    );

    assert.equal(response.status, 201, await response.clone().text());
    return (await store.getDeployment('dep_1')).requestHash;
  }

  assert.equal(await deployWithSecretValue('first-secret-value'), await deployWithSecretValue('second-secret-value'));
});

test('deployment request hash changes when runtime var values change', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async (input) => ({ artifactRef: `wfp://test/${input.workerName}` }),
      verify: async () => ({ ok: true }),
    },
  });

  const first = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload({ vars: { FEATURE_FLAG: 'on' } }), {
      'Idempotency-Key': 'runtime_var_value',
    }),
    env
  );
  const second = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload({ vars: { FEATURE_FLAG: 'off' } }), {
      'Idempotency-Key': 'runtime_var_value',
    }),
    env
  );

  assert.equal(first.status, 201, await first.clone().text());
  assert.equal(second.status, 409, await second.clone().text());
  assert.equal((await second.json()).error.code, 'IDEMPOTENCY_CONFLICT');
});

test('deployment request hash uses peppered runtime var digests', async () => {
  async function deployWithPepper(pepper) {
    const store = await createSeededStore();
    const env = testEnv(store, createSnapshotStore(), {
      RUNTIME_CONFIG_HASH_PEPPER: pepper,
      WFP_PROVIDER: {
        upload: async (input) => ({ artifactRef: `wfp://test/${input.workerName}` }),
        verify: async () => ({ ok: true }),
      },
    });

    const response = await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload({ vars: { FEATURE_FLAG: 'on' } }), {
        'Idempotency-Key': 'runtime_var_digest',
      }),
      env
    );

    assert.equal(response.status, 201, await response.clone().text());
    return (await store.getDeployment('dep_1')).requestHash;
  }

  assert.notEqual(await deployWithPepper('first-pepper'), await deployWithPepper('second-pepper'));
});

test('deployment fails closed when runtime config hash pepper is unavailable', async () => {
  const store = await createSeededStore();
  const uploads = [];
  const env = testEnv(store, createSnapshotStore(), {
    // Auth still needs the access-key pepper to verify the bearer; the runtime config hash
    // pepper is made unavailable via a non-matching active pepper id so the deploy fails closed.
    ACCESS_KEY_PEPPERS: 'pepper_1:ACCESS_KEY_PEPPER_TEST',
    ACCESS_KEY_PEPPER_TEST: 'pepper-secret',
    ACCESS_KEY_ACTIVE_PEPPER_ID: 'pepper_missing',
    RUNTIME_CONFIG_HASH_PEPPER: '',
    REQUEST_HASH_PEPPER: '',
    WFP_PROVIDER: {
      upload: async () => {
        uploads.push('upload');
        return { artifactRef: 'wfp://unexpected' };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload({ vars: { FEATURE_FLAG: 'on' } }), {
      'Idempotency-Key': 'runtime_hash_pepper_missing',
    }),
    env
  );

  assert.equal(response.status, 503, await response.clone().text());
  const body = await response.json();
  assert.equal(body.error.code, 'RUNTIME_CONFIG_UNSUPPORTED');
  assert.equal(body.error.action, 'Check runtime configuration and retry with a new Idempotency-Key.');
  assert.deepEqual(uploads, []);
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('deployment reports retry-later when runtime config Store capabilities are unavailable', async () => {
  const store = await createSeededStore();
  store.listEnabledSiteVars = undefined;
  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'runtime_config_store_capability_missing',
    }),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 503, await response.clone().text());
  const body = await response.json();
  assert.equal(body.error.code, 'RUNTIME_CONFIG_UNSUPPORTED');
  assert.equal(body.error.action, 'Retry later.');
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('deployment runtime snapshot hashes use the active access-key pepper when explicit runtime pepper is absent', async () => {
  const store = await createSeededStore();
  await store.putSiteSecret({
    id: 'sec_1',
    environment: 'production',
    siteId: 'site_1',
    name: 'API_TOKEN',
    value: 'secret-value',
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  const env = testEnv(store, createSnapshotStore(), {
    ACCESS_KEY_ACTIVE_PEPPER_ID: 'active',
    // pepper_1 entry keeps bearer auth working; the hash still resolves to the active pepper.
    ACCESS_KEY_PEPPERS: 'old:ACCESS_KEY_PEPPER_OLD,active:ACCESS_KEY_PEPPER_ACTIVE,pepper_1:ACCESS_KEY_PEPPER_TEST',
    ACCESS_KEY_PEPPER_OLD: 'old-pepper',
    ACCESS_KEY_PEPPER_ACTIVE: 'active-pepper',
    ACCESS_KEY_PEPPER_TEST: 'pepper-secret',
    RUNTIME_CONFIG_HASH_PEPPER: '',
    WFP_PROVIDER: {
      upload: async (input) => ({ artifactRef: `wfp://test/${input.workerName}` }),
      verify: async () => ({ ok: true }),
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload({ vars: { FEATURE_FLAG: 'on' } }), {
      'Idempotency-Key': 'runtime_hash_active_pepper',
    }),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  const version = await store.getSiteVersion('ver_1');
  assert.equal(
    version.runtimeConfigSnapshotJson.secrets[0].valueHash,
    await hashAccessKey('xd-pages-runtime-secret-v1\0API_TOKEN\0secret-value', 'active-pepper')
  );
  assert.notEqual(
    version.runtimeConfigSnapshotJson.secrets[0].valueHash,
    await hashAccessKey('xd-pages-runtime-secret-v1\0API_TOKEN\0secret-value', 'old-pepper')
  );
});

test('deployment fails closed when the runtime config snapshot authority cannot be read', async () => {
  const store = await createSeededStore();
  const originalListEnabledSiteVars = store.listEnabledSiteVars.bind(store);
  let reads = 0;
  store.listEnabledSiteVars = async (...args) => {
    reads += 1;
    if (reads === 2) throw new Error('snapshot authority unavailable');
    return originalListEnabledSiteVars(...args);
  };
  const uploads = [];
  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'runtime_snapshot_authority_unavailable',
    }),
    testEnv(store, createSnapshotStore(), {
      WFP_PROVIDER: {
        upload: async () => {
          uploads.push('upload');
          return { artifactRef: 'wfp://unexpected' };
        },
        verify: async () => ({ ok: true }),
      },
    })
  );

  assert.equal(response.status, 503, await response.clone().text());
  const body = await response.json();
  assert.equal(body.error.code, 'RUNTIME_CONFIG_UNSUPPORTED');
  assert.equal(body.error.action, 'Check runtime configuration and retry with a new Idempotency-Key.');
  assert.deepEqual(uploads, []);
  const deployment = await store.getDeployment('dep_1');
  assert.equal(deployment.status, 'failed');
  assert.equal(deployment.failureStage, 'runtime_config_snapshot');
});

test('deployment fails closed when site secrets change before provider upload', async () => {
  const store = await createSeededStore();
  await store.putSiteSecret({
    id: 'sec_1',
    environment: 'production',
    siteId: 'site_1',
    name: 'API_TOKEN',
    value: 'first-secret-value',
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  const originalListEnabledSiteSecrets = store.listEnabledSiteSecrets.bind(store);
  let reads = 0;
  store.listEnabledSiteSecrets = async (...args) => {
    reads += 1;
    const secrets = await originalListEnabledSiteSecrets(...args);
    if (reads === 1) {
      await store.putSiteSecret({
        id: 'sec_1',
        environment: 'production',
        siteId: 'site_1',
        name: 'API_TOKEN',
        value: 'second-secret-value',
        actorId: 'usr_1',
        updatedAt: '2026-06-15T00:00:01.000Z',
      });
    }
    return secrets;
  };
  const uploads = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async () => {
        uploads.push('upload');
        return { artifactRef: 'wfp://unexpected' };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'runtime_secret_changed',
    }),
    env
  );

  assert.equal(response.status, 409, await response.clone().text());
  const body = await response.json();
  assert.equal(body.error.code, 'RUNTIME_CONFIG_CHANGED');
  assert.deepEqual(uploads, []);
  const failedDeployment = await store.getDeployment('dep_1');
  assert.equal(failedDeployment.status, 'failed');
  assert.equal(failedDeployment.errorCode, 'RUNTIME_CONFIG_CHANGED');
  assert.equal(failedDeployment.failureStage, 'runtime_config_snapshot');
  assert.equal(failedDeployment.failureDiagnostics.stage, 'runtime_config_snapshot');
  assert.equal(failedDeployment.failureDiagnostics.uploadCompleted, false);
  assert.equal(failedDeployment.failureDiagnostics.routePointerCommitted, false);
});

test('deployment fails closed and cleans uploaded worker when site secrets change after provider upload', async () => {
  const store = await createSeededStore();
  await store.putSiteSecret({
    id: 'sec_1',
    environment: 'production',
    siteId: 'site_1',
    name: 'API_TOKEN',
    value: 'first-secret-value',
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  const deletedWorkers = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => {
        await store.putSiteSecret({
          id: 'sec_1',
          environment: 'production',
          siteId: 'site_1',
          name: 'API_TOKEN',
          value: 'second-secret-value',
          actorId: 'usr_1',
          updatedAt: '2026-06-15T00:00:01.000Z',
        });
        return { artifactRef: `wfp://test/${workerName}` };
      },
      verify: async () => ({ ok: true }),
      delete: async ({ workerName }) => deletedWorkers.push(workerName),
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'runtime_secret_changed_after_upload',
    }),
    env
  );

  assert.equal(response.status, 409, await response.clone().text());
  const body = await response.json();
  assert.equal(body.error.code, 'RUNTIME_CONFIG_CHANGED');
  assert.deepEqual(deletedWorkers, ['pages-v2-guide-ver-1']);
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.equal((await store.getDeployment('dep_1')).errorCode, 'RUNTIME_CONFIG_CHANGED');
  assert.equal(await store.getSiteVersion('ver_1'), null);
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);
});

test('deployment fails closed when site secrets change after provider verify before route activation', async () => {
  const store = await createSeededStore();
  await store.putSiteSecret({
    id: 'sec_1',
    environment: 'production',
    siteId: 'site_1',
    name: 'API_TOKEN',
    value: 'first-secret-value',
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  const deletedWorkers = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => {
        await store.putSiteSecret({
          id: 'sec_1',
          environment: 'production',
          siteId: 'site_1',
          name: 'API_TOKEN',
          value: 'second-secret-value',
          actorId: 'usr_1',
          updatedAt: '2026-06-15T00:00:01.000Z',
        });
        return { ok: true };
      },
      delete: async ({ workerName }) => deletedWorkers.push(workerName),
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'runtime_secret_changed_after_verify',
    }),
    env
  );

  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error.code, 'RUNTIME_CONFIG_CHANGED');
  assert.deepEqual(deletedWorkers, ['pages-v2-guide-ver-1']);
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.equal((await store.getDeployment('dep_1')).errorCode, 'RUNTIME_CONFIG_CHANGED');
  assert.equal(await store.getSiteVersion('ver_1'), null);
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);
});

test('deployment activation rejects a stale runtime config authority record', async () => {
  const store = await createSeededStore();
  await store.putSiteSecret({
    id: 'sec_1',
    environment: 'production',
    siteId: 'site_1',
    name: 'API_TOKEN',
    value: 'first-secret-value',
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  const originalActivate = store.activateSiteVersion.bind(store);
  let injectedRuntimeChange = false;
  store.activateSiteVersion = async (siteId, patch, environment, expectedRoute) => {
    if (!injectedRuntimeChange) {
      injectedRuntimeChange = true;
      await store.putSiteSecret({
        id: 'sec_1',
        environment: 'production',
        siteId: 'site_1',
        name: 'API_TOKEN',
        value: 'second-secret-value',
        actorId: 'usr_1',
        updatedAt: '2026-06-15T00:00:01.000Z',
      });
    }
    return originalActivate(siteId, patch, environment, expectedRoute);
  };
  const deletedWorkers = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => ({ ok: true }),
      delete: async ({ workerName }) => deletedWorkers.push(workerName),
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'runtime_secret_changed_at_activation',
    }),
    env
  );

  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error.code, 'RUNTIME_CONFIG_CHANGED');
  assert.deepEqual(deletedWorkers, ['pages-v2-guide-ver-1']);
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.equal((await store.getDeployment('dep_1')).errorCode, 'RUNTIME_CONFIG_CHANGED');
  assert.equal((await store.getDeployment((await store.getSiteVersion('ver_1')).deploymentId)).status, 'failed');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);
});

test('deployment fails closed when site secrets change after activation authority read before final snapshot check', async () => {
  const store = await createSeededStore();
  await store.putSiteSecret({
    id: 'sec_1',
    environment: 'production',
    siteId: 'site_1',
    name: 'API_TOKEN',
    value: 'first-secret-value',
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  const originalGetRoute = store.getRouteBySiteId.bind(store);
  let injectedRuntimeChange = false;
  let providerVerified = false;
  store.getRouteBySiteId = async (siteId, environment) => {
    const route = await originalGetRoute(siteId, environment);
    if (providerVerified && !injectedRuntimeChange && siteId === 'site_1') {
      injectedRuntimeChange = true;
      await store.putSiteSecret({
        id: 'sec_1',
        environment: 'production',
        siteId: 'site_1',
        name: 'API_TOKEN',
        value: 'second-secret-value',
        actorId: 'usr_1',
        updatedAt: '2026-06-15T00:00:01.000Z',
      });
    }
    return route;
  };
  const deletedWorkers = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => {
        providerVerified = true;
        return { ok: true };
      },
      delete: async ({ workerName }) => deletedWorkers.push(workerName),
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'runtime_secret_changed_after_authority_read',
    }),
    env
  );

  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error.code, 'RUNTIME_CONFIG_CHANGED');
  assert.deepEqual(deletedWorkers, ['pages-v2-guide-ver-1']);
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.equal((await store.getDeployment('dep_1')).errorCode, 'RUNTIME_CONFIG_CHANGED');
  assert.equal(await store.getSiteVersion('ver_1'), null);
  assert.equal((await originalGetRoute('site_1', 'production')).activeVersionId, null);
});

test('normal worker slot deploy cleans slot when site secrets change after provider upload', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  await store.putSiteSecret({
    id: 'sec_1',
    environment: 'production',
    siteId: 'site_1',
    name: 'API_TOKEN',
    value: 'first-secret-value',
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  const events = [];
  const env = testEnv(store, createSnapshotStore(), {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    NORMAL_WORKER_SLOT_PROVIDER: {
      upload: async ({ slot }) => {
        events.push(['upload', slot.id]);
        await store.putSiteSecret({
          id: 'sec_1',
          environment: 'production',
          siteId: 'site_1',
          name: 'API_TOKEN',
          value: 'second-secret-value',
          actorId: 'usr_1',
          updatedAt: '2026-06-15T00:00:01.000Z',
        });
      },
      verify: async () => {
        events.push(['verify']);
      },
      cleanupRetainedSlot: async ({ slot }) => {
        events.push(['cleanup', slot.id, slot.assignedVersionId]);
      },
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'slot_runtime_secret_changed_after_upload',
    }),
    env
  );

  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error.code, 'RUNTIME_CONFIG_CHANGED');
  assert.deepEqual(events, [
    ['upload', 'slot_007'],
    ['cleanup', 'slot_007', 'ver_1'],
  ]);
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.equal((await store.getDeployment('dep_1')).errorCode, 'RUNTIME_CONFIG_CHANGED');
  assert.equal(await store.getSiteVersion('ver_1'), null);
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);
  assert.equal((await store.getWorkerSlot('slot_007')).status, 'available');
  assert.equal((await store.getWorkerSlot('slot_007')).assignedVersionId, null);
});

test('deployments reject invalid or sensitive vars before provider upload', async () => {
  const store = await createSeededStore();
  const uploads = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async () => {
        uploads.push('upload');
        return { artifactRef: 'wfp://unexpected' };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ vars: { API_TOKEN: 'secret-ish' } }),
      { 'Idempotency-Key': 'runtime_vars_invalid' }
    ),
    env
  );

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'RUNTIME_VARS_INVALID');
  assert.equal(JSON.stringify(body).includes('secret-ish'), false);
  assert.deepEqual(uploads, []);
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('deployments reject null vars metadata on Worker deploys', async () => {
  const store = await createSeededStore();
  await store.replaceSiteVars({
    environment: 'production',
    siteId: 'site_1',
    vars: { FEATURE_FLAG: 'on' },
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:00:00.000Z',
    createId: () => 'var_1',
  });
  const uploads = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async () => {
        uploads.push('upload');
        return { artifactRef: 'wfp://unexpected' };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload({ vars: null }), {
      'Idempotency-Key': 'runtime_vars_null',
    }),
    env
  );

  assert.equal(response.status, 400, await response.clone().text());
  assert.equal((await response.json()).error.code, 'RUNTIME_VARS_INVALID');
  assert.deepEqual(uploads, []);
  assert.deepEqual(
    (await store.listEnabledSiteVars('production', 'site_1')).map((entry) => entry.name),
    ['FEATURE_FLAG']
  );
});

test('deployments reject runtime vars that conflict with site secret binding names before provider upload', async () => {
  const store = await createSeededStore();
  await store.putSiteSecret({
    id: 'sec_1',
    environment: 'production',
    siteId: 'site_1',
    name: 'API_BASE',
    value: 'secret-value',
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  const uploads = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async () => {
        uploads.push('upload');
        return { artifactRef: 'wfp://unexpected' };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ vars: { API_BASE: 'https://api.example.com' } }),
      { 'Idempotency-Key': 'runtime_binding_name_conflict' }
    ),
    env
  );

  assert.equal(response.status, 400, await response.clone().text());
  const body = await response.json();
  assert.equal(body.error.code, 'RUNTIME_BINDING_NAME_CONFLICT');
  assert.equal(body.error.action, 'Use unique names for vars and site secrets.');
  assert.deepEqual(uploads, []);
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('deployments reject runtime binding quotas before provider upload', async () => {
  const store = await createSeededStore();
  const uploads = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async () => {
        uploads.push('upload');
        return { artifactRef: 'wfp://unexpected' };
      },
      verify: async () => ({ ok: true }),
    },
  });
  const vars = Object.fromEntries(Array.from({ length: 65 }, (_, index) => [`FEATURE_${index}`, 'on']));

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload({ vars }), {
      'Idempotency-Key': 'runtime_binding_quota',
    }),
    env
  );

  assert.equal(response.status, 400, await response.clone().text());
  assert.equal((await response.json()).error.code, 'RUNTIME_BINDINGS_LIMIT_EXCEEDED');
  assert.deepEqual(uploads, []);
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('secrets API stores site-level secrets and delete disables future deployments without listing values', async () => {
  const store = await createSeededStore();
  const put = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/sites/guide/secrets',
      {
        name: 'API_TOKEN',
        value: 'super-secret-value',
      },
      { method: 'PUT' }
    ),
    testEnv(store, createSnapshotStore())
  );
  const del = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/sites/guide/secrets',
      {
        name: 'API_TOKEN',
      },
      { method: 'DELETE' }
    ),
    testEnv(store, createSnapshotStore())
  );
  const list = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/sites/guide/secrets'),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(put.status, 200, await put.clone().text());
  assert.equal(del.status, 200, await del.clone().text());
  assert.equal(list.status, 405);
  assert.deepEqual(await put.clone().json(), {
    secret: { site: 'guide', name: 'API_TOKEN', updated: true, deleted: false },
  });
  assert.deepEqual(await del.clone().json(), {
    secret: { site: 'guide', name: 'API_TOKEN', updated: false, deleted: true },
  });
  assert.deepEqual(await store.listEnabledSiteSecrets('production', 'site_1'), []);
  const auditEvents = await store.listAuditEvents();
  assert.deepEqual(
    auditEvents.map((event) => ({
      eventType: event.eventType,
      actorUserId: event.actorUserId,
      actorType: event.actorType,
      siteId: event.siteId,
      decision: event.decision,
      statusCode: event.statusCode,
      metadata: event.metadata,
    })),
    [
      {
        eventType: 'site_secret.put',
        actorUserId: 'usr_1',
        actorType: 'user',
        siteId: 'site_1',
        decision: 'allow',
        statusCode: 200,
        metadata: { siteSlug: 'guide', revision: 1 },
      },
      {
        eventType: 'site_secret.delete',
        actorUserId: 'usr_1',
        actorType: 'user',
        siteId: 'site_1',
        decision: 'allow',
        statusCode: 200,
        metadata: { siteSlug: 'guide', revision: 1 },
      },
    ]
  );
  assert.equal(JSON.stringify(await put.clone().json()).includes('revision'), false);
  assert.equal(JSON.stringify(await del.clone().json()).includes('revision'), false);
  assert.equal(JSON.stringify(auditEvents).includes('API_TOKEN'), false);
  assert.equal(JSON.stringify(auditEvents).includes('super-secret-value'), false);
});

test('secrets API fails closed without persisting secrets when audit write fails', async () => {
  const store = await createSeededStore({ failAuditWrites: true });
  const response = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/sites/guide/secrets',
      {
        name: 'API_TOKEN',
        value: 'super-secret-value',
      },
      { method: 'PUT' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).error.code, 'RUNTIME_CONFIG_UNSUPPORTED');
  assert.deepEqual(await store.listEnabledSiteSecrets('production', 'site_1'), []);
  assert.equal(JSON.stringify(await store.listAuditEvents()).includes('super-secret-value'), false);
});

test('rejects Worker module uploads that are not valid UTF-8', async () => {
  const store = await createSeededStore();
  const invalidWorkerBytes = new Uint8Array([0xff, 0xfe, 0xfd]);
  const decodedReplacementBytes = new globalThis.TextEncoder().encode(
    new globalThis.TextDecoder('utf-8').decode(invalidWorkerBytes)
  );
  const decision = {
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    workerEntry: 'worker.mjs',
  };
  const response = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'auto',
        source: 'cli',
        publishPlan: {
          ...decision,
          workerEntry: 'worker.mjs',
          workerMainModuleName: 'worker.mjs',
          assetsConfig: null,
        },
        workerModules: [
          {
            moduleName: 'worker.mjs',
            partName: 'worker-main',
            size: invalidWorkerBytes.byteLength,
            contentType: 'application/javascript+module',
          },
        ],
        worker: {
          field: 'worker-main',
          filename: 'worker.mjs',
          content: invalidWorkerBytes,
          type: 'application/javascript+module',
        },
        expectedContentHash: hashUploadPlan(
          [
            {
              relativePath: 'worker.mjs',
              contentType: 'application/javascript+module',
              bytes: decodedReplacementBytes,
            },
          ],
          decision
        ),
      },
      { 'Idempotency-Key': 'publish_plan_invalid_worker_utf8' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'PUBLISH_PLAN_INVALID');
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('rejects v2 publishPlan with duplicate part names or undeclared uploads', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());

  const duplicate = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'auto',
        contentHash: 'sha256:asset',
        publishPlan: {
          deploymentShape: 'assets-only',
          requestedFallback: 'auto',
          resolvedFallback: 'index',
          routingMode: 'assets-only',
          workerEntry: null,
          assetsConfig: { notFoundHandling: 'single-page-application' },
        },
        assetManifest: [
          {
            path: '/index.html',
            partName: 'asset-file-0',
            hash: 'hash_index',
            size: 5,
            contentType: 'text/html; charset=utf-8',
          },
          { path: '/app.js', partName: 'asset-file-0', hash: 'hash_app', size: 5, contentType: 'text/javascript' },
        ],
        files: [{ field: 'asset-file-0', filename: 'index.html', content: 'hello', type: 'text/html; charset=utf-8' }],
      },
      { 'Idempotency-Key': 'publish_plan_duplicate' }
    ),
    env
  );
  const undeclared = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'auto',
        contentHash: 'sha256:asset',
        publishPlan: {
          deploymentShape: 'assets-only',
          requestedFallback: 'auto',
          resolvedFallback: 'index',
          routingMode: 'assets-only',
          workerEntry: null,
          assetsConfig: { notFoundHandling: 'single-page-application' },
        },
        assetManifest: [
          {
            path: '/index.html',
            partName: 'asset-file-0',
            hash: 'hash_index',
            size: 5,
            contentType: 'text/html; charset=utf-8',
          },
        ],
        files: [
          { field: 'asset-file-0', filename: 'index.html', content: 'hello', type: 'text/html; charset=utf-8' },
          { field: 'asset-file-1', filename: 'app.js', content: 'hello', type: 'text/javascript' },
        ],
      },
      { 'Idempotency-Key': 'publish_plan_undeclared' }
    ),
    env
  );

  assert.equal(duplicate.status, 400);
  assert.equal((await duplicate.json()).error.code, 'PUBLISH_PLAN_INVALID');
  assert.equal(undeclared.status, 400);
  assert.equal((await undeclared.json()).error.code, 'PUBLISH_PLAN_INVALID');
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('rejects v2 publishPlan asset paths that match the upload denylist', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'auto',
        publishPlan: {
          deploymentShape: 'assets-only',
          requestedFallback: 'auto',
          resolvedFallback: 'not-found',
          routingMode: 'assets-only',
          workerEntry: null,
          assetsConfig: { notFoundHandling: '404-page' },
        },
        assetManifest: [
          {
            path: '/.env',
            partName: 'asset-file-0',
            size: 'SECRET=bad'.length,
            contentType: 'text/plain',
          },
        ],
        files: [{ field: 'asset-file-0', filename: '.env', content: 'SECRET=bad', type: 'text/plain' }],
      },
      { 'Idempotency-Key': 'publish_plan_denylist' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'ASSET_MANIFEST_INVALID');
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('rejects v2 publishPlan asset paths that match the upload denylist case-insensitively', async () => {
  const env = testEnv(await createSeededStore(), createSnapshotStore());
  const deniedPaths = ['/.ENV', '/Wrangler.toml', '/.GitHub/workflows/deploy.yml'];

  for (const [index, assetPath] of deniedPaths.entries()) {
    const response = await worker.fetch(
      publishPlanMultipartRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        {
          siteId: 'site_1',
          requestedFallback: 'auto',
          publishPlan: {
            deploymentShape: 'assets-only',
            requestedFallback: 'auto',
            resolvedFallback: 'not-found',
            routingMode: 'assets-only',
            workerEntry: null,
            assetsConfig: { notFoundHandling: '404-page' },
          },
          assetManifest: [
            {
              path: assetPath,
              partName: 'asset-file-0',
              size: 'SECRET=bad'.length,
              contentType: 'text/plain',
            },
          ],
          files: [{ field: 'asset-file-0', filename: path.basename(assetPath), content: 'SECRET=bad', type: 'text/plain' }],
        },
        { 'Idempotency-Key': `publish_plan_denylist_case_${index}` }
      ),
      env
    );

    assert.equal(response.status, 400, assetPath);
    assert.equal((await response.json()).error.code, 'ASSET_MANIFEST_INVALID');
  }
});

test('rejects explicit fallback for worker-only publishPlan', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'index',
        contentHash: 'sha256:worker',
        publishPlan: {
          deploymentShape: 'worker-only',
          requestedFallback: 'index',
          resolvedFallback: null,
          routingMode: 'worker-only',
          workerEntry: 'worker.mjs',
          workerMainModuleName: 'worker.mjs',
        },
        workerModules: [
          {
            moduleName: 'worker.mjs',
            partName: 'worker-main',
            hash: 'hash_worker',
            size: 18,
            contentType: 'application/javascript+module',
          },
        ],
        worker: {
          field: 'worker-main',
          filename: 'worker.mjs',
          content: 'export default {};',
          type: 'application/javascript+module',
        },
      },
      { 'Idempotency-Key': 'fallback_worker_only' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'FALLBACK_REQUIRES_ASSETS');
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('rejects index fallback publishPlan when index.html is not uploaded', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'index',
        publishPlan: {
          deploymentShape: 'assets-only',
          requestedFallback: 'index',
          resolvedFallback: 'index',
          routingMode: 'assets-only',
          workerEntry: null,
          assetsConfig: { notFoundHandling: 'single-page-application' },
        },
        assetManifest: [
          {
            path: '/app.js',
            partName: 'asset-file-0',
            size: 5,
            contentType: 'text/javascript; charset=utf-8',
          },
        ],
        files: [{ field: 'asset-file-0', filename: 'app.js', content: 'hello', type: 'text/javascript; charset=utf-8' }],
      },
      { 'Idempotency-Key': 'fallback_index_missing_index' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'FALLBACK_INDEX_REQUIRES_INDEX_HTML');
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('rejects v2 publishPlan when content hash does not match uploaded bytes', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ expectedContentHash: `sha256:${'0'.repeat(64)}` }),
      { 'Idempotency-Key': 'content_hash_mismatch' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'CONTENT_HASH_MISMATCH');
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('rejects multipart asset artifacts with unsafe or incomplete file manifests', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());

  const traversal = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'not-found',
        contentHash: 'sha256:asset',
        assetManifest: {
          '/../secret.txt': { hash: 'hash_secret', size: 5, content_type: 'text/plain' },
        },
        files: [{ field: 'file-0', filename: '../secret.txt', content: 'hello', type: 'text/plain' }],
      },
      { 'Idempotency-Key': 'asset_traversal' }
    ),
    env
  );
  const missing = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'not-found',
        publishPlan: {
          deploymentShape: 'assets-only',
          requestedFallback: 'not-found',
          resolvedFallback: 'not-found',
          routingMode: 'assets-only',
          workerEntry: null,
          assetsConfig: { notFoundHandling: '404-page' },
        },
        assetManifest: [
          {
            path: '/index.html',
            partName: 'asset-file-0',
            size: 5,
            contentType: 'text/html; charset=utf-8',
          },
        ],
        files: [],
      },
      { 'Idempotency-Key': 'asset_missing' }
    ),
    env
  );

  assert.equal(traversal.status, 400);
  assert.equal((await traversal.json()).error.code, 'ASSET_MANIFEST_INVALID');
  assert.equal(missing.status, 400);
  assert.equal((await missing.json()).error.code, 'ASSET_FILES_REQUIRED');
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('deployments can target an existing site by user-visible slug', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'Guide' }),
      { 'Idempotency-Key': 'slug_deploy' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json();
  assert.equal(body.deployment.siteId, 'site_1');
  assert.equal(body.route.hostname, 'guide.pages.xd.team');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_1');
});

test('deployments reject reserved site slugs with actionable API errors', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'openapi' }),
      { 'Idempotency-Key': 'reserved_slug_deploy' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'SITE_SLUG_RESERVED');
  assert.equal(body.error.message, 'Site slug is reserved.');
  assert.match(body.error.action, /平台保留/);
});

test('deployments reject existing sites whose slugs are reserved', async () => {
  const store = await createSeededStore();
  await store.createSite({
    id: 'site_reserved',
    slug: 'docs',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_reserved',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_reserved',
    hostname: 'docs.pages.xd.team',
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'docs' }),
      { 'Idempotency-Key': 'existing_reserved_slug_deploy' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'SITE_SLUG_RESERVED');
  assert.match(body.error.action, /平台保留/);
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('deployments reject existing sites whose slugs would create unroutable workers', async () => {
  const store = await createSeededStore();
  await store.createSite({
    id: 'site_staging_prefixed',
    slug: 'staging-demo',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_staging_prefixed',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_staging_prefixed',
    hostname: 'staging-demo.pages.xd.team',
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload({ siteId: 'site_staging_prefixed' }), {
      'Idempotency-Key': 'existing_staging_prefixed_site_id_deploy',
    }),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 400);
  const body = await response.json();
  assert.equal(body.error.code, 'SITE_SLUG_RESERVED');
  assert.match(body.error.action, /平台保留/);
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('access keys can deploy by slug only when the resolved site matches their scope', async () => {
  const store = await createSeededStore();
  await store.createSite({
    id: 'site_2',
    slug: 'other',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_2',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_2',
    hostname: 'other.pages.xd.team',
  });
  const matchingKey = await seedAccessKey(store, 'ak_deploy', ['deploy:site'], 'site_1');
  const otherSiteKey = await seedAccessKey(store, 'ak_other', ['deploy:site'], 'site_2');
  const env = testEnv(store, createSnapshotStore());

  const allowed = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'guide' }),
      {
        Authorization: `Bearer ${matchingKey}`,
        'Idempotency-Key': 'slug_access_key_ok',
      }
    ),
    env
  );
  const denied = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'guide' }),
      {
        Authorization: `Bearer ${otherSiteKey}`,
        'Idempotency-Key': 'slug_access_key_denied',
      }
    ),
    env
  );

  assert.equal(allowed.status, 201, await allowed.clone().text());
  assert.equal((await allowed.json()).deployment.siteId, 'site_1');
  assert.equal(denied.status, 404);
  const deniedBody = await denied.json();
  assert.equal(deniedBody.error.code, 'SITE_NOT_FOUND');
  assert.equal(deniedBody.error.action, 'Check the site slug and access key scope.');
});

test('user owner-scoped access keys can create a new personal site during deploy', async () => {
  const store = await createSeededStore();
  const ownerScopedKey = await seedAccessKey(store, 'ak_owner_create', ['deploy:site'], null);
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots, {
    ROUTE_POINTER_LOCKS: createRoutePointerLocks(snapshots),
    nextId: (prefix) => {
      if (prefix === 'site') return 'site_new_personal';
      if (prefix === 'route') return 'route_new_personal';
      return `${prefix}_1`;
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'new-personal', visibility: 'internal' }),
      {
        Authorization: `Bearer ${ownerScopedKey}`,
        'Idempotency-Key': 'owner_scoped_create_personal',
      }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json();
  const site = await store.findSiteBySlug('production', 'new-personal');
  assert.equal(body.deployment.siteId, site.id);
  assert.equal(site.ownerType, 'user');
  assert.equal(site.ownerId, 'usr_1');
  assert.equal(site.ownerUserId, 'usr_1');
  assert.equal(site.defaultVisibility, 'internal');
  assert.equal((await store.getRouteBySiteId(site.id)).hostname, 'new-personal.workers.xd.team');
});

test('direct deployment takes over an email-matched v1 site while deferring a shared Worker cleanup', async () => {
  const store = await createSeededStore();
  const ownerScopedKey = await seedAccessKey(store, 'ak_owner_takeover', ['deploy:site'], null);
  await store.acquireHostnameClaim({
    environment: 'production',
    hostname: 'legacy-guide.workers.xd.team',
    normalizedSlug: 'legacy-guide',
    hostnameFamily: 'workers',
    ownerSystem: 'v1',
    ownerId: 'v1:production:legacy-guide',
    ownerRef: 'pages-legacy-guide',
    source: 'backfill_v1_sites',
  });
  const cloudflareCalls = [];
  const deletedKvKeys = [];
  const env = testEnv(store, createSnapshotStore(), {
    V1_SITES: {
      async get(slug, type) {
        assert.equal(slug, 'legacy-guide');
        assert.equal(type, 'json');
        return {
          name: 'legacy-guide',
          token: 'pages_user@example.com',
          scriptName: 'pages-legacy-guide',
          url: 'https://legacy-guide.workers.xd.team',
        };
      },
      async delete(slug) {
        deletedKvKeys.push(slug);
      },
    },
    V1_CLOUDFLARE_CLIENT: {
      async listRoutes() {
        cloudflareCalls.push('listRoutes');
        return [
          { id: 'route_cf_1', pattern: 'legacy-guide.workers.xd.team/*', script: 'pages-legacy-guide' },
          { id: 'route_cf_2', pattern: 'docs.workers.xd.team/*', script: 'pages-legacy-guide' },
        ];
      },
      async deleteRoute({ routeId }) {
        cloudflareCalls.push(`deleteRoute:${routeId}`);
      },
      async deleteScript({ scriptName }) {
        cloudflareCalls.push(`deleteScript:${scriptName}`);
      },
    },
    nextId: (prefix) =>
      ({ site: 'site_takeover', route: 'route_takeover', dep: 'dep_takeover', ver: 'ver_takeover', aud: 'aud_takeover' })[
        prefix
      ] || `${prefix}_takeover`,
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'legacy-guide' }),
      {
        Authorization: `Bearer ${ownerScopedKey}`,
        'Idempotency-Key': 'owner_scoped_v1_takeover',
      }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json();
  assert.equal(body.deployment.status, 'succeeded');
  assert.equal(body.deployment.siteId, 'site_takeover');
  assert.equal(body.route.hostname, 'legacy-guide.workers.xd.team');
  assert.doesNotMatch(JSON.stringify(body), /pages-user@example\.com|pages-legacy-guide/);
  assert.deepEqual(cloudflareCalls, ['listRoutes', 'deleteRoute:route_cf_1']);
  assert.deepEqual(deletedKvKeys, ['legacy-guide']);
  assert.equal((await store.getHostnameClaim('legacy-guide.workers.xd.team')).ownerSystem, 'v2');
  assert.equal((await store.findSiteBySlug('production', 'legacy-guide')).id, 'site_takeover');
  const cleanupTasks = await store.listDeploymentResourceCleanupTasks({ environment: 'production' });
  assert.equal(cleanupTasks.length, 1);
  assert.equal(cleanupTasks[0].resourceType, 'v1_worker_script');
  assert.equal(cleanupTasks[0].resourceRef, 'pages-legacy-guide');
});

test('new site deploy idempotency conflict does not create an empty site first', async () => {
  const store = await createSeededStore();
  const ownerScopedKey = await seedAccessKey(store, 'ak_owner_create', ['deploy:site'], null);
  await store.createDeploymentForIdempotency({
    id: 'dep_existing',
    environment: 'production',
    actorId: 'ak_owner_create',
    actorUserId: 'usr_1',
    actorType: 'access_key',
    source: 'cli',
    siteId: 'site_new_personal',
    operation: 'deploy',
    idempotencyKey: 'owner_scoped_create_personal',
    requestHash: 'sha256:existing-request',
    visibility: 'org',
    status: 'succeeded',
  });
  const env = testEnv(store, createSnapshotStore(), {
    nextId: (prefix) => {
      if (prefix === 'site') return 'site_new_personal';
      if (prefix === 'route') return 'route_new_personal';
      return `${prefix}_1`;
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'new-personal', visibility: 'internal' }),
      {
        Authorization: `Bearer ${ownerScopedKey}`,
        'Idempotency-Key': 'owner_scoped_create_personal',
      }
    ),
    env
  );

  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(await store.findSiteBySlug('production', 'new-personal'), null);
  assert.equal(await store.getHostnameClaim('new-personal.workers.xd.team'), null);
});

test('team owner-scoped access keys can create a new team site during deploy', async () => {
  const store = await createSeededStore();
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_1',
  });
  const teamKey = await seedAccessKey(store, 'ak_team_create', ['deploy:site'], null, {
    ownerType: 'team',
    ownerId: team.id,
    ownerUserId: 'usr_1',
    createdByUserId: 'usr_1',
  });

  const env = testEnv(store, createSnapshotStore(), {
    nextId: (prefix) => {
      if (prefix === 'site') return 'site_new_team';
      if (prefix === 'route') return 'route_new_team';
      return `${prefix}_1`;
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'new-team' }),
      {
        Authorization: `Bearer ${teamKey}`,
        'Idempotency-Key': 'owner_scoped_create_team',
      }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json();
  const site = await store.findSiteBySlug('production', 'new-team');
  assert.equal(body.deployment.siteId, site.id);
  assert.equal(site.ownerType, 'team');
  assert.equal(site.ownerId, team.id);
  assert.equal(site.ownerUserId, 'usr_1');
  assert.equal(site.defaultVisibility, 'org');
  assert.equal((await store.getRouteBySiteId(site.id)).hostname, 'new-team.workers.xd.team');
});

test('user owner-scoped access keys can create a new team site when the user is a team publisher', async () => {
  const store = await createSeededStore();
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_1',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_1',
    role: 'publisher',
    membershipSource: 'manual',
  });
  const ownerScopedKey = await seedAccessKey(store, 'ak_user_team_create', ['deploy:site'], null);
  const env = testEnv(store, createSnapshotStore(), {
    nextId: (prefix) => {
      if (prefix === 'site') return 'site_user_team';
      if (prefix === 'route') return 'route_user_team';
      return `${prefix}_1`;
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'new-user-team', teamId: team.id, visibility: 'internal' }),
      {
        Authorization: `Bearer ${ownerScopedKey}`,
        'Idempotency-Key': 'user_owner_scoped_create_team',
      }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json();
  const site = await store.findSiteBySlug('production', 'new-user-team');
  assert.equal(body.deployment.siteId, site.id);
  assert.equal(site.ownerType, 'team');
  assert.equal(site.ownerId, team.id);
  assert.equal(site.ownerUserId, 'usr_1');
  assert.equal(site.defaultVisibility, 'internal');
  assert.equal((await store.getRouteBySiteId(site.id)).hostname, 'new-user-team.workers.xd.team');
});

test('user owner-scoped access keys can transfer a personal site to a team during deploy', async () => {
  const store = await createSeededStore();
  const requests = [];
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_1',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_1',
    role: 'publisher',
    membershipSource: 'manual',
  });
  const ownerScopedKey = await seedAccessKey(store, 'ak_user_team_transfer_deploy', ['deploy:site'], null);
  await seedLifecycleWebhook(store, 'site.disabled');

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'guide', teamId: team.id, visibility: 'disabled' }),
      {
        Authorization: `Bearer ${ownerScopedKey}`,
        'Idempotency-Key': 'user_owner_scoped_transfer_team_deploy',
      }
    ),
    testEnv(store, createSnapshotStore(), {
      WEBHOOK_URL_ENCRYPTION_KEY: TEST_WEBHOOK_URL_ENCRYPTION_KEY,
      resolveWebhookHost: async () => ['8.8.8.8'],
      WEBHOOK_FETCH: async (request) => {
        requests.push(request);
        return new Response('ok', { status: 200 });
      },
    })
  );

  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json();
  const site = await store.findSiteBySlug('production', 'guide');
  assert.equal(body.deployment.siteId, site.id);
  assert.deepEqual(body.ownerTransfer, {
    siteSlug: 'guide',
    fromOwner: { type: 'user', id: 'usr_1' },
    toOwner: { type: 'team', id: team.id },
    source: 'deploy',
  });
  assert.equal(site.ownerType, 'team');
  assert.equal(site.ownerId, team.id);
  assert.equal(site.ownerUserId, 'usr_1');
  assert.equal((await store.getRouteBySiteId(site.id)).visibility, 'disabled');
  assert.equal(requests.length, 1);
  const payload = await requests[0].json();
  assert.equal(payload.event.type, 'site.disabled');
  assert.deepEqual(payload.change, {
    field: 'visibility',
    previousValue: 'org',
    currentValue: 'disabled',
  });
  const transferEvents = (await store.listAuditEvents()).filter((event) => event.eventType === 'site.owner.transfer');
  assert.equal(transferEvents.length, 1);
  assert.deepEqual(transferEvents[0].metadata, {
    siteSlug: 'guide',
    fromOwner: { type: 'user', id: 'usr_1' },
    toOwner: { type: 'team', id: team.id },
    source: 'deploy',
  });
});

test('deploy rejects owner visibility for team-owned sites', async () => {
  const store = await createSeededStore();
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_1',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_1',
    role: 'publisher',
    membershipSource: 'manual',
  });
  const ownerScopedKey = await seedAccessKey(store, 'ak_user_team_owner_visibility', ['deploy:site'], null);

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'new-team-owner', teamId: team.id, visibility: 'owner' }),
      {
        Authorization: `Bearer ${ownerScopedKey}`,
        'Idempotency-Key': 'team_owner_visibility_rejected',
      }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 400, await response.clone().text());
  assert.equal((await response.json()).error.code, 'SITE_VISIBILITY_INVALID');
  assert.equal(await store.findSiteBySlug('production', 'new-team-owner'), null);
});

test('deploy rolls back owner transfer when route snapshot write fails', async () => {
  const store = await createSeededStore();
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_1',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_1',
    role: 'publisher',
    membershipSource: 'manual',
  });
  const ownerScopedKey = await seedAccessKey(store, 'ak_user_team_transfer_snapshot_fail', ['deploy:site'], null);

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'guide', teamId: team.id, visibility: 'internal' }),
      {
        Authorization: `Bearer ${ownerScopedKey}`,
        'Idempotency-Key': 'team_transfer_snapshot_failure',
      }
    ),
    testEnv(store, failingSnapshotStore())
  );

  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  const site = await store.getSite('site_1');
  assert.equal(site.ownerType, 'user');
  assert.equal(site.ownerId, 'usr_1');
  assert.equal(site.ownerUserId, 'usr_1');
  assert.equal(site.defaultVisibility, 'org');
});

test('owner-transfer activation failure emits site.failed with the restored personal owner', async () => {
  const store = await createSeededStore();
  const requests = [];
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_1',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_1',
    role: 'publisher',
    membershipSource: 'manual',
  });
  await seedLifecycleWebhook(store, 'site.failed');
  store.activateSiteVersion = async () => null;
  const ownerScopedKey = await seedAccessKey(store, 'ak_owner_transfer_conflict', ['deploy:site'], null);

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'guide', teamId: team.id, visibility: 'internal' }),
      {
        Authorization: `Bearer ${ownerScopedKey}`,
        'Idempotency-Key': 'owner_transfer_conflict',
      }
    ),
    testEnv(store, createSnapshotStore(), {
      WEBHOOK_URL_ENCRYPTION_KEY: TEST_WEBHOOK_URL_ENCRYPTION_KEY,
      resolveWebhookHost: async () => ['8.8.8.8'],
      WEBHOOK_FETCH: async (request) => {
        requests.push(request);
        return new Response('ok', { status: 200 });
      },
    })
  );

  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error.code, 'ROUTE_ACTIVATION_CONFLICT');
  const site = await store.getSite('site_1');
  assert.equal(site.ownerType, 'user');
  assert.equal(site.ownerId, 'usr_1');
  assert.equal(requests.length, 1);
  const payload = await requests[0].json();
  assert.equal(payload.site.ownerType, 'user');
  assert.equal(payload.site.ownerId, 'usr_1');
  assert.equal(payload.team, undefined);
});

test('user owner-scoped access keys cannot create a team site when the user is only a viewer', async () => {
  const store = await createSeededStore();
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_1',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_1',
    role: 'viewer',
    membershipSource: 'manual',
  });
  const ownerScopedKey = await seedAccessKey(store, 'ak_user_team_viewer', ['deploy:site'], null);

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'new-user-team', teamId: team.id }),
      {
        Authorization: `Bearer ${ownerScopedKey}`,
        'Idempotency-Key': 'user_owner_scoped_team_viewer_denied',
      }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 403, await response.clone().text());
  assert.equal((await response.json()).error.code, 'TEAM_PUBLISHER_REQUIRED');
  assert.equal(await store.findSiteBySlug('production', 'new-user-team'), null);
});

test('team publishers can create a new team-owned site during deploy with a CLI token', async () => {
  const store = await createSeededStore();
  await store.createUser({
    userId: 'usr_publisher',
    email: 'publisher@example.com',
    employeeStatus: 'active',
  });
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_1',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_publisher',
    role: 'publisher',
    membershipSource: 'manual',
  });
  await seedCliLoginKey(store, 'usr_publisher', BEARER_USR_PUBLISHER);
  const env = testEnv(store, createSnapshotStore(), {
    nextId: (prefix) => {
      if (prefix === 'site') return 'site_cli_team';
      if (prefix === 'route') return 'route_cli_team';
      return `${prefix}_1`;
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'new-team-cli', teamId: team.id, visibility: 'internal' }),
      { 'Idempotency-Key': 'cli_team_create', Authorization: `Bearer ${BEARER_USR_PUBLISHER}` }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json();
  const site = await store.findSiteBySlug('production', 'new-team-cli');
  assert.equal(body.deployment.siteId, site.id);
  assert.equal(site.ownerType, 'team');
  assert.equal(site.ownerId, team.id);
  assert.equal(site.ownerUserId, 'usr_publisher');
  assert.equal(site.defaultVisibility, 'internal');
  assert.equal((await store.getRouteBySiteId(site.id)).hostname, 'new-team-cli.workers.xd.team');
});

test('team viewers cannot create a new team-owned site during deploy with a CLI token', async () => {
  const store = await createSeededStore();
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_1',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_1',
    role: 'viewer',
    membershipSource: 'manual',
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'new-team-cli', teamId: team.id }),
      { 'Idempotency-Key': 'cli_team_viewer_denied' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 403, await response.clone().text());
  assert.equal((await response.json()).error.code, 'TEAM_PUBLISHER_REQUIRED');
  assert.equal(await store.findSiteBySlug('production', 'new-team-cli'), null);
});

test('site-scoped access keys cannot create a new site during deploy', async () => {
  const store = await createSeededStore();
  const siteScopedKey = await seedAccessKey(store, 'ak_site_scoped_create_denied', ['deploy:site'], 'site_1');

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'new-denied' }),
      {
        Authorization: `Bearer ${siteScopedKey}`,
        'Idempotency-Key': 'site_scoped_create_denied',
      }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 404);
  const body = await response.json();
  assert.equal(body.error.code, 'SITE_NOT_FOUND');
  assert.equal(body.error.action, 'Check the site slug and access key scope.');
  assert.equal(await store.findSiteBySlug('production', 'new-denied'), null);
});

test('user owner-scoped access keys cannot deploy another user personal site', async () => {
  const store = await createSeededStore();
  await store.createUser({
    userId: 'usr_2',
    email: 'other@example.com',
    employeeStatus: 'active',
  });
  await store.createSite({
    id: 'site_2',
    slug: 'other',
    ownerUserId: 'usr_2',
    ownerType: 'user',
    ownerId: 'usr_2',
    siteUuid: 'uuid_2',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_2',
    hostname: 'other.pages.xd.team',
  });
  const ownerScopedKey = await seedAccessKey(store, 'ak_owner', ['deploy:site'], null);
  const originalGetSiteForUser = store.getSiteForUser.bind(store);
  store.getSiteForUser = async (siteId, userId, actor, environment) => {
    if (actor?.type === 'access_key' && siteId === 'site_2') {
      return store.getSite(siteId, environment);
    }
    return originalGetSiteForUser(siteId, userId, actor, environment);
  };

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: 'site_2', siteSlug: undefined }),
      {
        Authorization: `Bearer ${ownerScopedKey}`,
        'Idempotency-Key': 'owner_scoped_cross_user_denied',
      }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 403, await response.clone().text());
  const traceId = response.headers.get('X-Deployment-Trace-Id');
  assert.equal((await response.json()).error.code, 'DEPLOY_FORBIDDEN');
  assert.equal(
    (await store.listDeploymentEvents({ environment: 'production', traceId })).some(
      (event) =>
        event.stage === 'auth_and_site_resolution' &&
        event.status === 'failed' &&
        event.errorCode === 'DEPLOY_FORBIDDEN' &&
        event.deploymentId === null
    ),
    true
  );
});

test('viewer members cannot deploy rollback or manage site secrets', async () => {
  const store = await createSeededStore();
  await store.createUser({
    userId: 'usr_2',
    email: 'viewer@example.com',
    realname: 'Viewer User',
    employeeStatus: 'active',
  });
  await store.addSiteMember({
    siteId: 'site_1',
    userId: 'usr_2',
    role: 'viewer',
    createdBy: 'usr_1',
    createdAt: '2026-06-15T00:00:00.000Z',
  });
  await seedCliLoginKey(store, 'usr_2', BEARER_USR_2);
  const ownerEnv = testEnv(store, createSnapshotStore());
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'owner_deploy',
      }),
      ownerEnv
    )
  );
  const viewerEnv = testEnv(store, createSnapshotStore());

  const deploy = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("viewer"); } };' }),
      { 'Idempotency-Key': 'viewer_deploy', Authorization: `Bearer ${BEARER_USR_2}` }
    ),
    viewerEnv
  );
  const putSecret = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/sites/guide/secrets',
      {
        name: 'API_TOKEN',
        value: 'super-secret-value',
      },
      { method: 'PUT', Authorization: `Bearer ${BEARER_USR_2}` }
    ),
    viewerEnv
  );
  const rollback = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      {
        'Idempotency-Key': 'viewer_rollback',
        Authorization: `Bearer ${BEARER_USR_2}`,
      }
    ),
    viewerEnv
  );

  assert.equal(deploy.status, 403, await deploy.clone().text());
  assert.equal((await deploy.json()).error.code, 'DEPLOY_FORBIDDEN');
  assert.equal(putSecret.status, 403, await putSecret.clone().text());
  assert.equal((await putSecret.json()).error.code, 'DEPLOY_FORBIDDEN');
  assert.equal(rollback.status, 403, await rollback.clone().text());
  assert.equal((await rollback.json()).error.code, 'ROLLBACK_FORBIDDEN');
  assert.deepEqual(await store.listEnabledSiteSecrets('production', 'site_1'), []);
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_1');
});

test('team publishers can deploy team-owned sites with their CLI token', async () => {
  const store = await createSeededStore();
  await store.createUser({
    userId: 'usr_publisher',
    email: 'publisher@example.com',
    employeeStatus: 'active',
  });
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_1',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_publisher',
    role: 'publisher',
    membershipSource: 'manual',
  });
  await store.createSite({
    id: 'site_team',
    slug: 'team-guide',
    ownerUserId: 'usr_1',
    ownerType: 'team',
    ownerId: team.id,
    siteUuid: 'uuid_team',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_team',
    hostname: 'team-guide.pages.xd.team',
  });
  await seedCliLoginKey(store, 'usr_publisher', BEARER_USR_PUBLISHER);

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'team-guide', teamId: team.id }),
      { 'Idempotency-Key': 'team_publisher_deploy', Authorization: `Bearer ${BEARER_USR_PUBLISHER}` }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.equal((await response.json()).deployment.siteId, 'site_team');
});

test('requested team id transfers an existing personal site when the actor can manage the target team', async () => {
  const store = await createSeededStore();
  await store.updateSiteVisibility('site_1', { visibility: 'internal', updatedAt: '2026-06-15T00:00:00.000Z' }, 'production');
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_1',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_1',
    role: 'publisher',
    membershipSource: 'manual',
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'guide', teamId: team.id }),
      { 'Idempotency-Key': 'team_slug_personal_denied' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json();
  assert.equal(body.deployment.siteId, 'site_1');
  const site = await store.getSite('site_1');
  assert.equal(site.ownerType, 'team');
  assert.equal(site.ownerId, team.id);
  assert.equal(site.ownerUserId, 'usr_1');
  assert.equal(site.defaultVisibility, 'internal');
  assert.equal((await store.getRouteBySiteId('site_1')).visibility, 'internal');
});

test('requested team id transfers an existing team site when the actor can manage both teams', async () => {
  const store = await createSeededStore();
  const teamA = await store.createTeam({
    id: 'team_a',
    environment: 'production',
    teamType: 'custom',
    name: 'Team A',
    createdByUserId: 'usr_1',
  });
  const teamB = await store.createTeam({
    id: 'team_b',
    environment: 'production',
    teamType: 'custom',
    name: 'Team B',
    createdByUserId: 'usr_1',
  });
  await store.addTeamMember({
    teamId: teamA.id,
    userId: 'usr_1',
    role: 'publisher',
    membershipSource: 'manual',
  });
  await store.addTeamMember({
    teamId: teamB.id,
    userId: 'usr_1',
    role: 'publisher',
    membershipSource: 'manual',
  });
  await store.createSite({
    id: 'site_team_a',
    slug: 'team-guide',
    ownerUserId: 'usr_1',
    ownerType: 'team',
    ownerId: teamA.id,
    siteUuid: 'uuid_team_a',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_team_a',
    hostname: 'team-guide.pages.xd.team',
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ siteId: undefined, siteSlug: 'team-guide', teamId: teamB.id }),
      { 'Idempotency-Key': 'team_slug_other_team_denied' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json();
  assert.equal(body.deployment.siteId, 'site_team_a');
  const site = await store.getSite('site_team_a');
  assert.equal(site.ownerType, 'team');
  assert.equal(site.ownerId, teamB.id);
  assert.equal(site.ownerUserId, 'usr_1');
});

test('uses bounded WFP worker names for valid long slugs', async () => {
  const store = createTestPagesStore({
    now: () => '2026-06-15T00:00:00.000Z',
  });
  await store.createUser({
    userId: 'usr_1',
    email: 'user@example.com',
    realname: 'User One',
    employeeStatus: 'active',
  });
  await seedCliLoginKey(store, 'usr_1', BEARER_USR_1);
  await store.createSite({
    id: 'site_long',
    slug: 'very-long-pages-site-slug-that-is-still-valid',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_long',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_long',
    hostname: 'very-long-pages-site-slug-that-is-still-valid.pages.xd.team',
  });
  const uploadedWorkerNames = [];
  const env = testEnv(store, createSnapshotStore(), {
    nextId: (prefix) => {
      if (prefix === 'dep') return 'dep_1234567890abcdef1234567890abcdef';
      if (prefix === 'ver') return 'ver_1234567890abcdef1234567890abcdef';
      return `${prefix}_1`;
    },
    WFP_PROVIDER: {
      upload: async ({ workerName }) => {
        uploadedWorkerNames.push(workerName);
        return { artifactRef: `wfp://test/${workerName}` };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload({ siteId: 'site_long' }), {
      'Idempotency-Key': 'long_slug',
    }),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(uploadedWorkerNames.length, 1);
  assert.equal(uploadedWorkerNames[0].length <= 63, true);
  assert.match(uploadedWorkerNames[0], /^[a-z0-9][a-z0-9-]{0,62}$/);
});

test('WFP upload metadata binds Pages KV gateway and runtime bindings to user workers', async () => {
  const store = await createSeededStore();
  await store.putSiteSecret({
    id: 'sec_1',
    environment: 'production',
    siteId: 'site_1',
    name: 'API_TOKEN',
    value: 'super-secret-value',
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  const requests = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: undefined,
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'cf_secret_token',
    WFP_DISPATCH_NAMESPACE: 'xd-cell-workers-production',
    fetch: async (request) => {
      requests.push(request);
      return Response.json({ success: true, result: { id: 'ok' } });
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ vars: { API_BASE: 'https://api.example.com' } }),
      {
        'Idempotency-Key': 'wfp_binding',
      }
    ),
    env
  );

  assert.equal(response.status, 201);
  const uploadRequest = requests.find((request) => request.method === 'PUT');
  const metadata = JSON.parse(await (await uploadRequest.formData()).get('metadata').text());
  assert.deepEqual(metadata.bindings, [
    { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' },
    { type: 'plain_text', name: 'API_BASE', text: 'https://api.example.com' },
    { type: 'secret_text', name: 'API_TOKEN', text: 'super-secret-value' },
  ]);
});

test('WFP worker deployment binds office VPC network when tunnel id is configured', async () => {
  const store = await createSeededStore();
  const requests = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: undefined,
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'cf_secret_token',
    WFP_DISPATCH_NAMESPACE: 'xd-cell-workers-production',
    PAGES_USER_WORKER_VPC_TUNNEL_ID: 'test-office-tunnel-id',
    fetch: async (request) => {
      requests.push(request);
      if (request.method === 'GET' && request.url.endsWith('/settings')) {
        return Response.json({ success: true, result: { bindings: [] } });
      }
      return Response.json({ success: true, result: { id: 'ok' } });
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'wfp_vpc_network',
    }),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  const uploadRequest = requests.find((request) => request.method === 'PUT');
  const metadata = JSON.parse(await (await uploadRequest.formData()).get('metadata').text());
  assert.deepEqual(metadata.bindings, [
    { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' },
    { type: 'vpc_network', name: 'XD_OFFICE_NET', tunnel_id: 'test-office-tunnel-id' },
  ]);
});

test('WFP public worker deployment does not bind office VPC network', async () => {
  const store = await createSeededStore();
  const lease = await store.acquireSiteCommitLock('production', 'site_1', { lockId: 'public_deploy_lock' });
  const currentRoute = await store.getRouteBySiteId('site_1', 'production');
  await store.updateSiteAccessPolicy({
    environment: 'production',
    siteId: 'site_1',
    exposure: 'public',
    expected: {
      policyVersion: currentRoute.policyVersion,
      routeGeneration: currentRoute.routeGeneration,
      activeVersionId: currentRoute.activeVersionId,
      runtimeConfigGeneration: currentRoute.runtimeConfigGeneration,
    },
    lease,
  });
  await store.releaseSiteCommitLock('production', 'site_1', lease.lockId);

  const requests = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: undefined,
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'cf_secret_token',
    WFP_DISPATCH_NAMESPACE: 'xd-cell-workers-production',
    PAGES_USER_WORKER_VPC_TUNNEL_ID: 'test-office-tunnel-id',
    fetch: async (request) => {
      requests.push(request);
      if (request.method === 'GET' && request.url.endsWith('/settings')) {
        return Response.json({ success: true, result: { bindings: [] } });
      }
      return Response.json({ success: true, result: { id: 'ok' } });
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'wfp_public_no_office_net',
    }),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  const uploadRequest = requests.find((request) => request.method === 'PUT');
  const metadata = JSON.parse(await (await uploadRequest.formData()).get('metadata').text());
  assert.deepEqual(metadata.bindings, [{ type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' }]);
});

test('WFP public activation fails closed when OfficeNet cannot be verified absent', async () => {
  const store = await createSeededStore();
  const lease = await store.acquireSiteCommitLock('production', 'site_1', { lockId: 'public_verify_lock' });
  const currentRoute = await store.getRouteBySiteId('site_1', 'production');
  await store.updateSiteAccessPolicy({
    environment: 'production',
    siteId: 'site_1',
    exposure: 'public',
    expected: {
      policyVersion: currentRoute.policyVersion,
      routeGeneration: currentRoute.routeGeneration,
      activeVersionId: currentRoute.activeVersionId,
      runtimeConfigGeneration: currentRoute.runtimeConfigGeneration,
    },
    lease,
  });
  await store.releaseSiteCommitLock('production', 'site_1', lease.lockId);

  const events = [];
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots, {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => ({ ok: true }),
      removeOfficeNetBinding: async ({ workerName }) => {
        events.push(['remove', workerName]);
        return { removed: true };
      },
      verifyOfficeNetAbsent: async ({ workerName }) => {
        events.push(['verify', workerName]);
        return false;
      },
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'wfp_public_verify_failed',
    }),
    env
  );

  assert.equal(response.status, 503, await response.clone().text());
  const body = await response.json();
  assert.equal(body.error.code, 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED');
  assert.deepEqual(
    events.map(([kind]) => kind),
    ['remove', 'verify']
  );
  assert.equal((await store.getRouteBySiteId('site_1', 'production')).activeVersionId, null);
  assert.equal(snapshots.read('production:route_pointer:guide.pages.xd.team') ?? null, null);
});

test('WFP public activation preserves nested Provider diagnostics when OfficeNet removal fails', async () => {
  const store = await createSeededStore();
  const lease = await store.acquireSiteCommitLock('production', 'site_1', { lockId: 'public_provider_trace_lock' });
  const currentRoute = await store.getRouteBySiteId('site_1', 'production');
  await store.updateSiteAccessPolicy({
    environment: 'production',
    siteId: 'site_1',
    exposure: 'public',
    expected: {
      policyVersion: currentRoute.policyVersion,
      routeGeneration: currentRoute.routeGeneration,
      activeVersionId: currentRoute.activeVersionId,
      runtimeConfigGeneration: currentRoute.runtimeConfigGeneration,
    },
    lease,
  });
  await store.releaseSiteCommitLock('production', 'site_1', lease.lockId);

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'wfp_public_provider_diagnostics',
    }),
    testEnv(store, createSnapshotStore(), {
      WFP_PROVIDER: {
        upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
        verify: async () => ({ ok: true }),
        removeOfficeNetBinding: async () => {
          throw new WfpApiError({
            status: 502,
            code: 'WFP_API_ERROR',
            message: 'settings update failed',
            operation: 'worker_settings_patch',
            providerCode: 10090,
            providerMessage: 'Settings update rejected',
            providerRequestId: 'ray-office-net-patch',
          });
        },
        verifyOfficeNetAbsent: async () => {
          throw new Error('verify should not run');
        },
      },
    })
  );

  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.clone().json()).error.code, 'SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED');
  const events = await store.listDeploymentEvents({
    environment: 'production',
    traceId: response.headers.get('X-Deployment-Trace-Id'),
  });
  const officeNetFailure = events.find((event) => event.stage === 'office_net' && event.status === 'failed');
  assert.equal(officeNetFailure.operation, 'worker_settings_patch');
  assert.equal(officeNetFailure.errorCode, 'SITE_PUBLIC_OFFICE_NET_REMOVE_FAILED');
  assert.deepEqual(officeNetFailure.diagnostics, {
    causeClass: 'public_office_net_error',
    httpStatus: 502,
    clientCode: 'WFP_API_ERROR',
    providerCode: '10090',
    providerMessage: 'Settings update rejected',
    providerRequestId: 'ray-office-net-patch',
  });
});

test('public OfficeNet guard reports non-WFP deployment shapes as not applicable', async () => {
  const actions = [];
  const result = await ensurePublicWorkerOfficeNetAbsent(
    {
      removeOfficeNetBinding: async () => actions.push('remove'),
      verifyOfficeNetAbsent: async () => actions.push('verify'),
    },
    {
      environment: 'production',
      siteId: 'site_assets',
      workerName: 'pages-v2-assets',
      executionProvider: 'wfp',
      deploymentShape: 'assets-only',
      exposure: 'public',
    }
  );

  assert.deepEqual(result, { status: 'not_applicable', reason: 'assets-only' });
  assert.deepEqual(actions, []);
});

test('WFP public activation serializes OfficeNet settings changes with runtime binding sync', async () => {
  const store = await createSeededStore();
  const lease = await store.acquireSiteCommitLock('production', 'site_1', { lockId: 'public_settings_lock_policy' });
  const currentRoute = await store.getRouteBySiteId('site_1', 'production');
  await store.updateSiteAccessPolicy({
    environment: 'production',
    siteId: 'site_1',
    exposure: 'public',
    expected: {
      policyVersion: currentRoute.policyVersion,
      routeGeneration: currentRoute.routeGeneration,
      activeVersionId: currentRoute.activeVersionId,
      runtimeConfigGeneration: currentRoute.runtimeConfigGeneration,
    },
    lease,
  });
  await store.releaseSiteCommitLock('production', 'site_1', lease.lockId);

  const originalWithRuntimeConfigLock = store.withRuntimeConfigLock.bind(store);
  let settingsLockHeld = false;
  let lockCalls = 0;
  store.withRuntimeConfigLock = async (...args) => {
    lockCalls += 1;
    return originalWithRuntimeConfigLock(args[0], args[1], async (lock) => {
      settingsLockHeld = true;
      try {
        return await args[2](lock);
      } finally {
        settingsLockHeld = false;
      }
    });
  };

  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => ({ ok: true }),
      removeOfficeNetBinding: async () => {
        assert.equal(settingsLockHeld, true);
        return { removed: true };
      },
      verifyOfficeNetAbsent: async () => {
        assert.equal(settingsLockHeld, true);
        return true;
      },
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'wfp_public_settings_lock',
    }),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(lockCalls, 1);
});

test('WFP public activation uses the renewable site commit lock and forwards its abort signal', async () => {
  const store = await createSeededStore();
  const policyLease = await store.acquireSiteCommitLock('production', 'site_1', { lockId: 'public_renewable_policy' });
  const currentRoute = await store.getRouteBySiteId('site_1', 'production');
  await store.updateSiteAccessPolicy({
    environment: 'production',
    siteId: 'site_1',
    exposure: 'public',
    expected: {
      policyVersion: currentRoute.policyVersion,
      routeGeneration: currentRoute.routeGeneration,
      activeVersionId: currentRoute.activeVersionId,
      runtimeConfigGeneration: currentRoute.runtimeConfigGeneration,
    },
    lease: policyLease,
  });
  await store.releaseSiteCommitLock('production', 'site_1', policyLease.lockId);

  const originalWithSiteCommitLock = store.withSiteCommitLock.bind(store);
  let siteLockCalls = 0;
  let siteSignal;
  store.withSiteCommitLock = async (...args) => {
    siteLockCalls += 1;
    return originalWithSiteCommitLock(
      args[0],
      args[1],
      async (lease) => {
        siteSignal = lease.signal;
        return args[2](lease);
      },
      args[3]
    );
  };

  const providerSignals = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => ({ ok: true }),
      removeOfficeNetBinding: async ({ signal }) => providerSignals.push(signal),
      verifyOfficeNetAbsent: async ({ signal }) => {
        providerSignals.push(signal);
        return true;
      },
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'wfp_public_renewable_site_lock',
    }),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.equal(siteLockCalls, 1);
  assert.equal(siteSignal instanceof globalThis.AbortSignal, true);
  assert.equal(providerSignals.length, 2);
  assert.equal(
    providerSignals.every((signal) => signal instanceof globalThis.AbortSignal),
    true
  );
});

test('WFP public rollback removes and verifies OfficeNet before route cutover', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const initialEnv = testEnv(store, snapshots);
  await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'public_rollback_deploy_1',
    }),
    initialEnv
  );
  await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
      { 'Idempotency-Key': 'public_rollback_deploy_2' }
    ),
    initialEnv
  );
  const lease = await store.acquireSiteCommitLock('production', 'site_1', { lockId: 'public_rollback_policy' });
  const currentRoute = await store.getRouteBySiteId('site_1', 'production');
  await store.updateSiteAccessPolicy({
    environment: 'production',
    siteId: 'site_1',
    exposure: 'public',
    expected: {
      policyVersion: currentRoute.policyVersion,
      routeGeneration: currentRoute.routeGeneration,
      activeVersionId: currentRoute.activeVersionId,
      runtimeConfigGeneration: currentRoute.runtimeConfigGeneration,
    },
    lease,
  });
  await store.releaseSiteCommitLock('production', 'site_1', lease.lockId);
  await writeCurrentRouteSnapshot(store, snapshots);

  const events = [];
  const env = testEnv(store, snapshots, {
    WFP_PROVIDER: {
      removeOfficeNetBinding: async ({ workerName }) => events.push(['remove', workerName]),
      verifyOfficeNetAbsent: async ({ workerName }) => {
        events.push(['verify', workerName]);
        return true;
      },
    },
  });
  const rollback = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      { 'Idempotency-Key': 'public_rollback_1' }
    ),
    env
  );

  assert.equal(rollback.status, 201, await rollback.clone().text());
  assert.deepEqual(events, [
    ['remove', 'pages-v2-guide-ver-1'],
    ['verify', 'pages-v2-guide-ver-1'],
    ['remove', 'pages-v2-guide-ver-2'],
    ['verify', 'pages-v2-guide-ver-2'],
  ]);
  const route = await store.getRouteBySiteId('site_1', 'production');
  assert.equal(route.activeVersionId, 'ver_1');
  assert.equal(route.exposure, 'public');
});

test('WFP public rollback fails before cutover when the current Worker OfficeNet state is unsafe', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots);
  await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'public_rollback_guard_deploy_1',
    }),
    env
  );
  await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
      { 'Idempotency-Key': 'public_rollback_guard_deploy_2' }
    ),
    env
  );
  const lease = await store.acquireSiteCommitLock('production', 'site_1', { lockId: 'public_rollback_guard_policy' });
  const currentRoute = await store.getRouteBySiteId('site_1', 'production');
  await store.updateSiteAccessPolicy({
    environment: 'production',
    siteId: 'site_1',
    exposure: 'public',
    expected: {
      policyVersion: currentRoute.policyVersion,
      routeGeneration: currentRoute.routeGeneration,
      activeVersionId: currentRoute.activeVersionId,
      runtimeConfigGeneration: currentRoute.runtimeConfigGeneration,
    },
    lease,
  });
  await store.releaseSiteCommitLock('production', 'site_1', lease.lockId);
  await writeCurrentRouteSnapshot(store, snapshots);

  env.WFP_PROVIDER = {
    removeOfficeNetBinding: async () => ({ removed: true }),
    verifyOfficeNetAbsent: async ({ workerName }) => workerName !== 'pages-v2-guide-ver-2',
  };
  const rollback = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      {
        'Idempotency-Key': 'public_rollback_guard_failed',
      }
    ),
    env
  );

  assert.equal(rollback.status, 503, await rollback.clone().text());
  assert.equal((await rollback.json()).error.code, 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED');
  assert.equal((await store.getRouteBySiteId('site_1', 'production')).activeVersionId, 'ver_2');
  const failed = await store.getDeployment('dep_3', 'production');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureStage, 'rollback_public_office_net');
});

test('rollback records a terminal failure and releases its lease when the route disappears after locking', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());
  await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'rollback_route_missing_deploy_1',
    }),
    env
  );
  await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
      { 'Idempotency-Key': 'rollback_route_missing_deploy_2' }
    ),
    env
  );

  const originalAcquire = store.acquireSiteCommitLock.bind(store);
  const originalGetRoute = store.getRouteBySiteId.bind(store);
  let hideNextRoute = false;
  store.acquireSiteCommitLock = async (...args) => {
    const lease = await originalAcquire(...args);
    hideNextRoute = Boolean(lease);
    return lease;
  };
  store.getRouteBySiteId = async (...args) => {
    if (hideNextRoute) {
      hideNextRoute = false;
      return null;
    }
    return originalGetRoute(...args);
  };

  const rollback = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      {
        'Idempotency-Key': 'rollback_route_missing',
      }
    ),
    env
  );

  assert.equal(rollback.status, 409, await rollback.clone().text());
  assert.equal((await rollback.json()).error.code, 'ROUTE_ACTIVATION_CONFLICT');
  const failed = await store.getDeployment('dep_3', 'production');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'ROUTE_ACTIVATION_CONFLICT');
  assert.ok(await originalAcquire('production', 'site_1', { lockId: 'rollback_route_missing_retry' }));
});

test('rollback recovers its failed terminal state after the first state write fails', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'rollback_best_effort_deploy_1',
      }),
      env
    )
  );
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
        { 'Idempotency-Key': 'rollback_best_effort_deploy_2' }
      ),
      env
    )
  );

  const originalAcquire = store.acquireSiteCommitLock.bind(store);
  const originalGetRoute = store.getRouteBySiteId.bind(store);
  const originalUpdateDeployment = store.updateDeployment.bind(store);
  let hideNextRoute = false;
  let failedStateWriteAttempts = 0;
  store.acquireSiteCommitLock = async (...args) => {
    const lease = await originalAcquire(...args);
    hideNextRoute = Boolean(lease);
    return lease;
  };
  store.getRouteBySiteId = async (...args) => {
    if (hideNextRoute) {
      hideNextRoute = false;
      return null;
    }
    return originalGetRoute(...args);
  };
  store.updateDeployment = async (id, patch) => {
    if (id === 'dep_3' && patch.status === 'failed' && failedStateWriteAttempts++ === 0) {
      throw new Error('failed terminal write temporarily unavailable');
    }
    return originalUpdateDeployment(id, patch);
  };

  const rollback = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      {
        'Idempotency-Key': 'rollback_best_effort_failure',
      }
    ),
    env
  );

  assert.equal(rollback.status, 409, await rollback.clone().text());
  assert.equal((await rollback.json()).error.code, 'ROUTE_ACTIVATION_CONFLICT');
  assert.equal(failedStateWriteAttempts, 2);
  const failed = await store.getDeployment('dep_3', 'production');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'ROUTE_ACTIVATION_CONFLICT');
});

test('rollback reports state persistence failure when terminal recovery also fails', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots);
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'rollback_persist_failure_deploy_1',
      }),
      env
    )
  );
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
        { 'Idempotency-Key': 'rollback_persist_failure_deploy_2' }
      ),
      env
    )
  );

  const originalAcquire = store.acquireSiteCommitLock.bind(store);
  const originalGetRoute = store.getRouteBySiteId.bind(store);
  const originalUpdateDeployment = store.updateDeployment.bind(store);
  const originalCreateDeploymentEvent = store.createDeploymentEvent.bind(store);
  let d1Unavailable = false;
  let hideRouteOnNextLease = true;
  let hideNextRoute = false;
  let failedStateWriteAttempts = 0;
  let failReconciledSuccessWrite = false;
  store.acquireSiteCommitLock = async (...args) => {
    const lease = await originalAcquire(...args);
    hideNextRoute = Boolean(lease) && hideRouteOnNextLease;
    hideRouteOnNextLease = false;
    return lease;
  };
  store.getRouteBySiteId = async (...args) => {
    if (hideNextRoute) {
      hideNextRoute = false;
      d1Unavailable = true;
      return null;
    }
    return originalGetRoute(...args);
  };
  store.updateDeployment = async (id, patch) => {
    if (failReconciledSuccessWrite && id === 'dep_3' && patch.status === 'succeeded') {
      throw new Error('reconciled success write unavailable');
    }
    if (d1Unavailable && id === 'dep_3' && patch.status === 'failed') {
      failedStateWriteAttempts += 1;
      throw new Error('failed terminal write unavailable');
    }
    return originalUpdateDeployment(id, patch);
  };
  store.createDeploymentEvent = async (input) => {
    if (d1Unavailable) throw new Error('failed terminal event unavailable');
    return originalCreateDeploymentEvent(input);
  };
  const request = (idempotencyKey) =>
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      {
        'Idempotency-Key': idempotencyKey,
      }
    );

  const rollback = await worker.fetch(request('rollback_persist_failure'), env);

  assert.equal(rollback.status, 503, await rollback.clone().text());
  assert.equal((await rollback.json()).error.code, 'DEPLOYMENT_STATE_WRITE_FAILED');
  assert.equal((await store.getDeployment('dep_3', 'production')).status, 'pending');
  assert.equal((await snapshots.list({ prefix: 'production:deployment_failure_recovery:site_1:' })).keys.length, 1);

  d1Unavailable = false;
  const routeBeforeCommittedRecovery = await store.getRouteBySiteId('site_1', 'production');
  const rollbackTargetVersion = await store.getSiteVersion('ver_1', 'production');
  await store.activateSiteVersion(
    'site_1',
    {
      activeVersionId: rollbackTargetVersion.id,
      workerName: rollbackTargetVersion.workerName,
      runtime: rollbackTargetVersion.runtime,
      executionProvider: rollbackTargetVersion.executionProvider,
      dispatchType: rollbackTargetVersion.dispatchType,
      visibility: routeBeforeCommittedRecovery.visibility,
      updatedAt: '2026-06-15T00:00:00.000Z',
    },
    'production',
    routeBeforeCommittedRecovery
  );
  failReconciledSuccessWrite = true;
  const blockedCommittedRetry = await worker.fetch(
    request('rollback_persist_failure_committed_state_unavailable'),
    env
  );
  failReconciledSuccessWrite = false;

  assert.equal(blockedCommittedRetry.status, 503, await blockedCommittedRetry.clone().text());
  assert.equal((await blockedCommittedRetry.json()).error.code, 'DEPLOYMENT_STATE_WRITE_FAILED');
  assert.equal((await store.getDeployment('dep_3', 'production')).status, 'pending');
  assert.equal(await store.getDeployment('dep_4', 'production'), null);
  assert.equal((await snapshots.list({ prefix: 'production:deployment_failure_recovery:site_1:' })).keys.length, 1);
  await store.restoreSiteRoute('site_1', routeBeforeCommittedRecovery, 'production');

  const originalListMarkers = snapshots.list;
  const originalGetSiteVersion = store.getSiteVersion.bind(store);
  let armRecoveryVersionReadFailure = true;
  let failRecoveryVersionRead = false;
  snapshots.list = async (options) => {
    const page = await originalListMarkers(options);
    if (armRecoveryVersionReadFailure && options?.prefix?.includes(':deployment_failure_recovery:')) {
      armRecoveryVersionReadFailure = false;
      failRecoveryVersionRead = true;
    }
    return page;
  };
  store.getSiteVersion = async (...args) => {
    if (failRecoveryVersionRead) {
      failRecoveryVersionRead = false;
      throw new Error('SQL token=recovery-version-read-secret');
    }
    return originalGetSiteVersion(...args);
  };
  const blockedRetry = await worker.fetch(request('rollback_persist_failure_reconcile_unavailable'), env);

  assert.equal(blockedRetry.status, 503, await blockedRetry.clone().text());
  assert.equal((await blockedRetry.json()).error.code, 'DEPLOYMENT_STATE_WRITE_FAILED');
  assert.equal(await store.getDeployment('dep_4', 'production'), null);
  assert.equal((await snapshots.list({ prefix: 'production:deployment_failure_recovery:site_1:' })).keys.length, 1);

  const retry = await worker.fetch(request('rollback_persist_failure_retry'), env);

  assert.equal(retry.status, 201, await retry.clone().text());
  assert.equal(failedStateWriteAttempts, 2);
  const failed = await store.getDeployment('dep_3', 'production');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'ROUTE_ACTIVATION_CONFLICT');
  assert.equal((await store.getDeployment('dep_4', 'production')).status, 'succeeded');
  assert.equal((await snapshots.list({ prefix: 'production:deployment_failure_recovery:site_1:' })).keys.length, 0);
});

test('rollback policy conflict keeps the WFP provider fallback for legacy versions', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'rollback_provider_fallback_deploy_1',
      }),
      env
    )
  );
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
        { 'Idempotency-Key': 'rollback_provider_fallback_deploy_2' }
      ),
      env
    )
  );
  store.siteVersions.get('ver_1').executionProvider = null;
  store.acquireSiteCommitLock = async () => null;

  const rollback = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      {
        'Idempotency-Key': 'rollback_provider_fallback',
      }
    ),
    env
  );

  assert.equal(rollback.status, 409, await rollback.clone().text());
  assert.equal((await rollback.json()).error.code, 'SITE_POLICY_CONFLICT');
  const failed = await store.getDeployment('dep_3', 'production');
  assert.equal(failed.failureDiagnostics.executionProvider, 'wfp');
});

test('rollback route read failure releases the renewable lease and records a terminal failure', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'rollback_route_read_failure_deploy_1',
      }),
      env
    )
  );
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
        { 'Idempotency-Key': 'rollback_route_read_failure_deploy_2' }
      ),
      env
    )
  );

  const originalGetRoute = store.getRouteBySiteId.bind(store);
  const originalAcquire = store.acquireSiteCommitLock.bind(store);
  let throwAfterAcquire = false;
  store.acquireSiteCommitLock = async (...args) => {
    const lease = await originalAcquire(...args);
    throwAfterAcquire = Boolean(lease);
    return lease;
  };
  store.getRouteBySiteId = async (...args) => {
    if (throwAfterAcquire) {
      throwAfterAcquire = false;
      throw new Error('route read failed');
    }
    return originalGetRoute(...args);
  };

  const rollback = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      {
        'Idempotency-Key': 'rollback_route_read_failure',
      }
    ),
    env
  );

  assert.equal(rollback.status, 503, await rollback.clone().text());
  assert.equal((await rollback.json()).error.code, 'ROLLBACK_ACTIVATION_FAILED');
  const failed = await store.getDeployment('dep_3', 'production');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'ROLLBACK_ACTIVATION_FAILED');
  assert.ok(await originalAcquire('production', 'site_1', { lockId: 'rollback_route_read_failure_retry' }));
});

test('rollback stops before activation when renewable lease renewal loses fencing', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots, {
    SITE_COMMIT_LOCK_RENEW_INTERVAL_MS: 1,
  });
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'rollback_renewal_loss_deploy_1',
      }),
      env
    )
  );
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
        { 'Idempotency-Key': 'rollback_renewal_loss_deploy_2' }
      ),
      env
    )
  );

  const originalRenew = store.renewSiteCommitLock.bind(store);
  store.renewSiteCommitLock = async () => null;
  const originalGetRoute = store.getRouteBySiteId.bind(store);
  const originalAcquire = store.acquireSiteCommitLock.bind(store);
  let delayAfterAcquire = false;
  store.acquireSiteCommitLock = async (...args) => {
    const lease = await originalAcquire(...args);
    delayAfterAcquire = Boolean(lease);
    return lease;
  };
  store.getRouteBySiteId = async (...args) => {
    if (delayAfterAcquire) {
      delayAfterAcquire = false;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return originalGetRoute(...args);
  };

  const rollback = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      {
        'Idempotency-Key': 'rollback_renewal_loss',
      }
    ),
    env
  );

  assert.equal(rollback.status, 503, await rollback.clone().text());
  assert.equal((await rollback.json()).error.code, 'ROLLBACK_ACTIVATION_FAILED');
  assert.equal((await store.getRouteBySiteId('site_1', 'production')).activeVersionId, 'ver_2');
  assert.equal((await store.getDeployment('dep_3', 'production')).status, 'failed');
  store.renewSiteCommitLock = originalRenew;
});

test('rollback stops before activation when the renewable lease times out', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots, {
    SITE_COMMIT_LOCK_TIMEOUT_MS: 1,
  });
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'rollback_timeout_deploy_1',
      }),
      env
    )
  );
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
        { 'Idempotency-Key': 'rollback_timeout_deploy_2' }
      ),
      env
    )
  );

  const originalGetRoute = store.getRouteBySiteId.bind(store);
  const originalAcquire = store.acquireSiteCommitLock.bind(store);
  let delayAfterAcquire = false;
  store.acquireSiteCommitLock = async (...args) => {
    const lease = await originalAcquire(...args);
    delayAfterAcquire = Boolean(lease);
    return lease;
  };
  store.getRouteBySiteId = async (...args) => {
    if (delayAfterAcquire) {
      delayAfterAcquire = false;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return originalGetRoute(...args);
  };

  const rollback = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      {
        'Idempotency-Key': 'rollback_timeout',
      }
    ),
    env
  );

  assert.equal(rollback.status, 503, await rollback.clone().text());
  assert.equal((await rollback.json()).error.code, 'ROLLBACK_ACTIVATION_FAILED');
  assert.equal((await store.getRouteBySiteId('site_1', 'production')).activeVersionId, 'ver_2');
  assert.equal((await store.getDeployment('dep_3', 'production')).status, 'failed');
});

test('rollback release failure does not mask the original error or skip terminal state', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'rollback_release_failure_deploy_1',
      }),
      env
    )
  );
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
        { 'Idempotency-Key': 'rollback_release_failure_deploy_2' }
      ),
      env
    )
  );

  const originalGetRoute = store.getRouteBySiteId.bind(store);
  const originalAcquire = store.acquireSiteCommitLock.bind(store);
  const originalRelease = store.releaseSiteCommitLock.bind(store);
  let hideNextRoute = false;
  store.acquireSiteCommitLock = async (...args) => {
    const lease = await originalAcquire(...args);
    hideNextRoute = Boolean(lease);
    return lease;
  };
  store.getRouteBySiteId = async (...args) => {
    if (hideNextRoute) {
      hideNextRoute = false;
      return null;
    }
    return originalGetRoute(...args);
  };
  store.releaseSiteCommitLock = async () => {
    throw new Error('release failed');
  };

  const rollback = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      {
        'Idempotency-Key': 'rollback_release_failure',
      }
    ),
    env
  );

  assert.equal(rollback.status, 409, await rollback.clone().text());
  assert.equal((await rollback.json()).error.code, 'ROUTE_ACTIVATION_CONFLICT');
  const failed = await store.getDeployment('dep_3', 'production');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'ROUTE_ACTIVATION_CONFLICT');
  store.releaseSiteCommitLock = originalRelease;
});

test('deployment rejects exposure drift between upload and activation', async () => {
  const store = await createSeededStore();
  const policyLease = await store.acquireSiteCommitLock('production', 'site_1', { lockId: 'deploy_exposure_initial' });
  const initialRoute = await store.getRouteBySiteId('site_1', 'production');
  await store.updateSiteAccessPolicy({
    environment: 'production',
    siteId: 'site_1',
    exposure: 'public',
    expected: {
      policyVersion: initialRoute.policyVersion,
      routeGeneration: initialRoute.routeGeneration,
      activeVersionId: initialRoute.activeVersionId,
      runtimeConfigGeneration: initialRoute.runtimeConfigGeneration,
    },
    lease: policyLease,
  });
  await store.releaseSiteCommitLock('production', 'site_1', policyLease.lockId);

  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => {
        const lease = await store.acquireSiteCommitLock('production', 'site_1', { lockId: 'deploy_exposure_drift' });
        const route = await store.getRouteBySiteId('site_1', 'production');
        await store.updateSiteAccessPolicy({
          environment: 'production',
          siteId: 'site_1',
          exposure: 'internal',
          expected: {
            policyVersion: route.policyVersion,
            routeGeneration: route.routeGeneration,
            activeVersionId: route.activeVersionId,
            runtimeConfigGeneration: route.runtimeConfigGeneration,
          },
          lease,
        });
        await store.releaseSiteCommitLock('production', 'site_1', lease.lockId);
        return { artifactRef: `wfp://test/${workerName}` };
      },
      verify: async () => ({ ok: true }),
      delete: async () => null,
    },
  });
  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'deploy_exposure_drift',
    }),
    env
  );

  assert.equal(response.status, 409, await response.clone().text());
  assert.equal((await response.json()).error.code, 'ROUTE_ACTIVATION_CONFLICT');
  const route = await store.getRouteBySiteId('site_1', 'production');
  assert.equal(route.activeVersionId, null);
  assert.equal(route.exposure, 'internal');
});

test('WFP worker-with-assets deployment binds office VPC network when tunnel id is configured', async () => {
  const store = await createSeededStore();
  const requests = [];
  const assetHash = hashAsset(Buffer.from('hello'), 'text/html; charset=utf-8');
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: undefined,
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'cf_secret_token',
    WFP_DISPATCH_NAMESPACE: 'xd-cell-workers-production',
    PAGES_USER_WORKER_VPC_TUNNEL_ID: 'test-office-tunnel-id',
    fetch: async (request) => {
      requests.push(request.clone());
      if (request.url.includes('/assets-upload-session')) {
        return Response.json({ success: true, result: { jwt: 'upload-jwt', buckets: [[assetHash]] } });
      }
      if (request.url.includes('/workers/assets/upload')) {
        return Response.json({ success: true, result: { jwt: 'completion-jwt' } });
      }
      return Response.json({ success: true, result: { id: 'ok' } });
    },
  });

  const response = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteSlug: 'guide',
        requestedFallback: 'auto',
        source: 'cli',
        publishPlan: {
          deploymentShape: 'worker-with-assets',
          requestedFallback: 'auto',
          resolvedFallback: 'not-found',
          routingMode: 'worker-first',
          workerEntry: '_worker.js',
          workerMainModuleName: '_worker.js',
          assetsConfig: { notFoundHandling: '404-page' },
        },
        assetManifest: [
          {
            path: '/index.html',
            partName: 'asset-file-0',
            size: 5,
            contentType: 'text/html; charset=utf-8',
          },
        ],
        workerModules: [
          {
            moduleName: '_worker.js',
            partName: 'worker-main',
            size: 18,
            contentType: 'application/javascript+module',
          },
        ],
        files: [{ field: 'asset-file-0', filename: 'index.html', content: 'hello', type: 'text/html; charset=utf-8' }],
        worker: {
          field: 'worker-main',
          filename: '_worker.js',
          content: 'export default {};',
          type: 'application/javascript+module',
        },
      },
      { 'Idempotency-Key': 'wfp_worker_assets_vpc_network' }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  const uploadRequest = requests.find((request) => request.method === 'PUT');
  const metadata = JSON.parse(await (await uploadRequest.formData()).get('metadata').text());
  assert.deepEqual(metadata.bindings, [
    { type: 'assets', name: 'ASSETS' },
    { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' },
    { type: 'vpc_network', name: 'XD_OFFICE_NET', tunnel_id: 'test-office-tunnel-id' },
  ]);
});

test('WFP static asset deployment uses Cloudflare assets upload session and ASSETS binding', async () => {
  const store = await createSeededStore();
  const requests = [];
  const assetHash = hashAsset(Buffer.from('hello'), 'text/html');
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: undefined,
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'cf_secret_token',
    WFP_DISPATCH_NAMESPACE: 'xd-cell-workers-production',
    PAGES_USER_WORKER_VPC_TUNNEL_ID: 'test-office-tunnel-id',
    fetch: async (request) => {
      requests.push(request.clone());
      if (request.url.includes('/assets-upload-session')) {
        return Response.json({ success: true, result: { jwt: 'upload-jwt', buckets: [[assetHash]] } });
      }
      if (request.url.includes('/workers/assets/upload')) {
        return Response.json({ success: true, result: { jwt: 'completion-jwt' } });
      }
      return Response.json({ success: true, result: { id: 'ok' } });
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        contentHash: 'sha256:asset',
        assetManifest: {
          '/index.html': { hash: 'hash_index', size: 5, content_type: 'text/html; charset=utf-8' },
        },
        files: [{ field: 'file-0', filename: 'index.html', content: 'hello', type: 'text/html' }],
      },
      { 'Idempotency-Key': 'wfp_assets' }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.ok(
    requests.some((request) =>
      request.url.includes(
        '/workers/dispatch/namespaces/xd-cell-workers-production/scripts/pages-v2-guide-ver-1/assets-upload-session'
      )
    )
  );
  assert.ok(requests.some((request) => request.url.includes('/workers/assets/upload?base64=true')));
  const assetUpload = requests.find((request) => request.url.includes('/workers/assets/upload?base64=true'));
  const assetUploadForm = await assetUpload.formData();
  assert.equal(assetUploadForm.get(assetHash).type, 'text/html');
  assert.equal(await assetUploadForm.get(assetHash).text(), 'aGVsbG8=');
  const uploadRequest = requests.find((request) => request.method === 'PUT');
  const metadata = JSON.parse(await (await uploadRequest.formData()).get('metadata').text());
  assert.deepEqual(metadata.bindings, [
    { type: 'assets', name: 'ASSETS' },
    { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' },
  ]);
  assert.deepEqual(metadata.assets, {
    jwt: 'completion-jwt',
    config: { not_found_handling: 'single-page-application' },
  });
});

test('deploys through normal worker slot mode without exposing provider to the request', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  const snapshots = createSnapshotStore();
  const events = [];
  const env = testEnv(store, snapshots, {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    NORMAL_WORKER_SLOT_PROVIDER: {
      upload: async ({ workerName, slot }) => {
        events.push(['upload', workerName, slot.id, (await store.getRouteBySiteId('site_1')).activeVersionId]);
      },
      verify: async ({ workerName, slot }) => {
        events.push(['verify', workerName, slot.id, (await store.getRouteBySiteId('site_1')).activeVersionId]);
      },
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        ...deployPayload(),
        executionProvider: 'wfp',
      },
      { 'Idempotency-Key': 'slot_deploy' }
    ),
    env
  );

  assert.equal(response.status, 201);
  const body = await response.json();
  assert.equal(body.version.runtime, 'worker');
  assertNoPublicExecutionDetails(body);
  assert.equal((await store.getSiteVersion('ver_1')).executionProvider, 'normal-worker-slot');
  assert.equal((await store.getRouteBySiteId('site_1')).dispatchBindingName, 'SITE_SLOT_007');
  assert.equal((await store.getWorkerSlot('slot_007')).status, 'assigned');
  assert.equal((await store.getWorkerSlot('slot_007')).assignedVersionId, 'ver_1');
  const pointer = snapshots.read('production:route_pointer:guide.pages.xd.team');
  assert.deepEqual(snapshots.read(pointer.snapshotKey).dispatch, {
    type: 'service-binding',
    slotId: 'slot_007',
    bindingName: 'SITE_SLOT_007',
  });
  assert.deepEqual(events, [
    ['upload', 'pages-v2-production-slot-007', 'slot_007', null],
    ['verify', 'pages-v2-production-slot-007', 'slot_007', null],
  ]);
});

test('releases previous normal worker slot after replacement deploy succeeds', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  await store.createWorkerSlot({
    id: 'slot_008',
    environment: 'production',
    slotNumber: 8,
    workerName: 'pages-v2-production-slot-008',
    bindingName: 'SITE_SLOT_008',
    status: 'available',
  });
  const events = [];
  const env = testEnv(store, createSnapshotStore(), {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    NORMAL_WORKER_SLOT_PROVIDER: {
      upload: async () => null,
      verify: async () => ({ ok: true }),
      cleanupRetainedSlot: async ({ slot }) => {
        events.push(['cleanup', slot.id, slot.assignedVersionId]);
      },
    },
  });

  await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'slot_first',
    }),
    env
  );
  const replacement = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("def"); } };' }),
      { 'Idempotency-Key': 'slot_second' }
    ),
    env
  );
  const rollback = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback', {}, { 'Idempotency-Key': 'rb_retired_slot' }),
    env
  );

  assert.equal(replacement.status, 201);
  assert.equal((await store.getWorkerSlot('slot_007')).status, 'available');
  assert.equal((await store.getWorkerSlot('slot_007')).assignedVersionId, null);
  assert.equal((await store.getWorkerSlot('slot_007')).lastDeployedVersionId, 'ver_1');
  assert.equal((await store.getWorkerSlot('slot_008')).status, 'assigned');
  assert.equal((await store.getWorkerSlot('slot_008')).assignedVersionId, 'ver_2');
  assert.equal(rollback.status, 409);
  assert.equal((await rollback.json()).error.code, 'ROLLBACK_VERSION_UNAVAILABLE');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_2');
  assert.deepEqual(events, [['cleanup', 'slot_007', 'ver_1']]);
  const cleanupEvent = (await store.listDeploymentEvents({ environment: 'production', deploymentId: 'dep_2' })).find(
    (event) => event.stage === 'cleanup_or_compensation' && event.operation === 'worker_placeholder_put'
  );
  assert.equal(cleanupEvent.status, 'compensated');
  assert.equal(cleanupEvent.diagnostics.cleanupStatus, 'succeeded');
  assert.equal(cleanupEvent.diagnostics.trafficImpact, 'new_version_active');
});

test('keeps replacement deployment succeeded when previous slot cleanup fails closed', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  await store.createWorkerSlot({
    id: 'slot_008',
    environment: 'production',
    slotNumber: 8,
    workerName: 'pages-v2-production-slot-008',
    bindingName: 'SITE_SLOT_008',
    status: 'available',
  });
  const env = testEnv(store, createSnapshotStore(), {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    NORMAL_WORKER_SLOT_PROVIDER: {
      upload: async () => null,
      verify: async () => ({ ok: true }),
      cleanupRetainedSlot: async () => {
        throw new WfpApiError({
          status: 502,
          code: 'WFP_API_ERROR',
          message: 'placeholder cleanup failed',
          operation: 'worker_placeholder_put',
          providerCode: 10090,
          providerMessage: 'Placeholder rejected',
          providerRequestId: 'ray-slot-cleanup',
        });
      },
    },
  });

  await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'slot_first',
    }),
    env
  );
  const replacement = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("def"); } };' }),
      { 'Idempotency-Key': 'slot_second' }
    ),
    env
  );

  assert.equal(replacement.status, 201);
  assert.equal((await store.getDeployment('dep_2')).status, 'succeeded');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_2');
  assert.equal((await store.getWorkerSlot('slot_007')).status, 'cleanup_pending');
  assert.equal((await store.getWorkerSlot('slot_007')).assignedVersionId, 'ver_1');
  const cleanupEvent = (await store.listDeploymentEvents({ environment: 'production', deploymentId: 'dep_2' })).find(
    (event) => event.stage === 'cleanup_or_compensation' && event.operation === 'worker_placeholder_put'
  );
  assert.equal(cleanupEvent.status, 'failed');
  assert.deepEqual(cleanupEvent.diagnostics.compensation, {
    status: 'failed',
    operation: 'worker_placeholder_put',
    httpStatus: 502,
    clientCode: 'WFP_API_ERROR',
    providerCode: '10090',
    providerMessage: 'Placeholder rejected',
    providerRequestId: 'ray-slot-cleanup',
  });
});

test('normal worker slot upload failure cleans slot before reuse', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  const events = [];
  const env = testEnv(store, createSnapshotStore(), {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    NORMAL_WORKER_SLOT_PROVIDER: {
      upload: async ({ runtimeBindings }) => {
        events.push(['upload', runtimeBindings.vars.API_BASE]);
        throw new Error('upload failed after runtime bindings reached provider');
      },
      cleanupRetainedSlot: async ({ slot }) => {
        events.push(['cleanup', slot.id, slot.assignedVersionId]);
      },
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ vars: { API_BASE: 'https://api.example.com' } }),
      { 'Idempotency-Key': 'slot_upload_failed_cleanup' }
    ),
    env
  );

  assert.equal(response.status, 502);
  assert.deepEqual(events, [
    ['upload', 'https://api.example.com'],
    ['cleanup', 'slot_007', 'ver_1'],
  ]);
  assert.equal((await store.getWorkerSlot('slot_007')).status, 'available');
  assert.equal((await store.getWorkerSlot('slot_007')).assignedVersionId, null);
});

test('normal worker slot upload failure disables slot when cleanup fails', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  const env = testEnv(store, createSnapshotStore(), {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    NORMAL_WORKER_SLOT_PROVIDER: {
      upload: async () => {
        throw new Error('upload failed after runtime bindings reached provider');
      },
      cleanupRetainedSlot: async () => {
        throw new Error('cleanup failed');
      },
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ vars: { API_BASE: 'https://api.example.com' } }),
      { 'Idempotency-Key': 'slot_upload_failed_cleanup_failed' }
    ),
    env
  );

  assert.equal(response.status, 502);
  assert.equal((await store.getWorkerSlot('slot_007')).status, 'disabled');
  assert.equal((await store.getWorkerSlot('slot_007')).assignedVersionId, null);
});

test('normal worker slot verify failure cleans uploaded worker before slot reuse', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  const events = [];
  const env = testEnv(store, createSnapshotStore(), {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    NORMAL_WORKER_SLOT_PROVIDER: {
      upload: async ({ runtimeBindings }) => {
        events.push(['upload', runtimeBindings.vars.API_BASE]);
      },
      verify: async () => {
        events.push(['verify']);
        throw new Error('verify failed after upload');
      },
      cleanupRetainedSlot: async ({ slot }) => {
        events.push(['cleanup', slot.id, slot.assignedVersionId]);
      },
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ vars: { API_BASE: 'https://api.example.com' } }),
      { 'Idempotency-Key': 'slot_verify_failed_cleanup' }
    ),
    env
  );

  assert.equal(response.status, 502, await response.clone().text());
  assert.deepEqual(events, [['upload', 'https://api.example.com'], ['verify'], ['cleanup', 'slot_007', 'ver_1']]);
  assert.equal((await store.getWorkerSlot('slot_007')).status, 'available');
  assert.equal((await store.getWorkerSlot('slot_007')).assignedVersionId, null);
});

test('normal worker slot upload metadata binds Pages KV gateway to slot workers', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  const requests = [];
  const env = testEnv(store, createSnapshotStore(), {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'cf_secret_token',
    fetch: async (request) => {
      requests.push(request);
      return Response.json({ success: true, result: { id: 'ok' } });
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'slot_binding',
    }),
    env
  );

  assert.equal(response.status, 201);
  const uploadRequestIndex = requests.findIndex((request) => request.method === 'PUT');
  const uploadRequest = requests[uploadRequestIndex];
  assert.match(uploadRequest.url, /\/workers\/scripts\/pages-v2-production-slot-007$/);
  const metadata = JSON.parse(await (await uploadRequest.formData()).get('metadata').text());
  assert.deepEqual(metadata.bindings, [{ type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' }]);
  const disableSubdomainRequestIndexes = requests
    .map((request, index) => ({ request, index }))
    .filter(({ request }) =>
      request.url.endsWith('/workers/services/pages-v2-production-slot-007/environments/production/subdomain')
    )
    .map(({ index }) => index);
  assert.deepEqual(
    disableSubdomainRequestIndexes.map((index) => requests[index].method),
    ['POST', 'POST']
  );
  assert.ok(disableSubdomainRequestIndexes[0] < uploadRequestIndex, 'workers.dev subdomain is disabled before slot upload');
  assert.ok(disableSubdomainRequestIndexes[1] > uploadRequestIndex, 'workers.dev subdomain is disabled after slot upload');
  assert.deepEqual(await requests[disableSubdomainRequestIndexes[1]].json(), { enabled: false });
});

test('normal worker slot static asset deployment uses Cloudflare assets upload session and ASSETS binding', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  const requests = [];
  const assetHash = hashAsset(Buffer.from('hello'), 'text/html');
  const env = testEnv(store, createSnapshotStore(), {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'cf_secret_token',
    fetch: async (request) => {
      requests.push(request.clone());
      if (request.method === 'GET' && request.url.endsWith('/workers/scripts/pages-v2-production-slot-007')) {
        return multipartWorkerScriptResponse();
      }
      if (request.url.includes('/assets-upload-session')) {
        return Response.json({ success: true, result: { jwt: 'upload-jwt', buckets: [[assetHash]] } });
      }
      if (request.url.includes('/workers/assets/upload')) {
        return Response.json({ success: true, result: { jwt: 'completion-jwt' } });
      }
      return Response.json({ success: true, result: { id: 'ok' } });
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'not-found',
        contentHash: 'sha256:asset',
        assetManifest: {
          '/index.html': { hash: 'hash_index', size: 5, content_type: 'text/html; charset=utf-8' },
        },
        files: [{ field: 'file-0', filename: 'index.html', content: 'hello', type: 'text/html' }],
      },
      { 'Idempotency-Key': 'slot_assets' }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  assert.ok(
    requests.some((request) => request.url.includes('/workers/scripts/pages-v2-production-slot-007/assets-upload-session'))
  );
  assert.ok(requests.some((request) => request.url.includes('/workers/assets/upload?base64=true')));
  const assetUpload = requests.find((request) => request.url.includes('/workers/assets/upload?base64=true'));
  const assetUploadForm = await assetUpload.formData();
  assert.equal(assetUploadForm.get(assetHash).type, 'text/html');
  assert.equal(await assetUploadForm.get(assetHash).text(), 'aGVsbG8=');
  const uploadRequest = requests.find((request) => request.method === 'PUT');
  const metadata = JSON.parse(await (await uploadRequest.formData()).get('metadata').text());
  assert.deepEqual(metadata.bindings, [
    { type: 'assets', name: 'ASSETS' },
    { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' },
  ]);
  assert.deepEqual(metadata.assets, {
    jwt: 'completion-jwt',
    config: { not_found_handling: '404-page' },
  });
});

test('normal worker slot worker-with-assets deployment keeps user worker and runs it before assets', async () => {
  const store = await createSeededStore();
  await store.putSiteSecret({
    id: 'sec_1',
    environment: 'production',
    siteId: 'site_1',
    name: 'API_TOKEN',
    value: 'super-secret-value',
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  const requests = [];
  const env = testEnv(store, createSnapshotStore(), {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'cf_secret_token',
    fetch: async (request) => {
      requests.push(request.clone());
      if (request.method === 'GET' && request.url.endsWith('/workers/scripts/pages-v2-production-slot-007')) {
        return multipartWorkerScriptResponse();
      }
      if (request.url.includes('/assets-upload-session')) {
        return Response.json({ success: true, result: { jwt: 'upload-jwt', buckets: [['hash_index']] } });
      }
      if (request.url.includes('/workers/assets/upload')) {
        return Response.json({ success: true, result: { jwt: 'completion-jwt' } });
      }
      return Response.json({ success: true, result: { id: 'ok' } });
    },
  });

  const response = await worker.fetch(
    publishPlanMultipartRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      {
        siteId: 'site_1',
        requestedFallback: 'auto',
        publishPlan: {
          deploymentShape: 'worker-with-assets',
          requestedFallback: 'auto',
          resolvedFallback: 'not-found',
          routingMode: 'worker-first',
          workerEntry: '_worker.js',
          workerMainModuleName: '_worker.js',
          assetsConfig: { notFoundHandling: '404-page' },
        },
        assetManifest: [
          {
            path: '/index.html',
            partName: 'asset-file-0',
            size: 5,
            contentType: 'text/html; charset=utf-8',
          },
        ],
        workerModules: [
          {
            moduleName: '_worker.js',
            partName: 'worker-main',
            size: 18,
            contentType: 'application/javascript+module',
          },
        ],
        files: [{ field: 'asset-file-0', filename: 'index.html', content: 'hello', type: 'text/html; charset=utf-8' }],
        vars: { API_BASE: 'https://api.example.com' },
        worker: {
          field: 'worker-main',
          filename: '_worker.js',
          content: 'export default {};',
          type: 'application/javascript+module',
        },
      },
      { 'Idempotency-Key': 'slot_worker_assets' }
    ),
    env
  );

  assert.equal(response.status, 201, await response.clone().text());
  const uploadRequest = requests.find((request) => request.method === 'PUT');
  const uploadForm = await uploadRequest.formData();
  const metadata = JSON.parse(await uploadForm.get('metadata').text());
  assert.equal(metadata.main_module, '_worker.js');
  assert.equal(await uploadForm.get('_worker.js').text(), 'export default {};');
  assert.deepEqual(metadata.bindings, [
    { type: 'assets', name: 'ASSETS' },
    { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' },
    { type: 'plain_text', name: 'API_BASE', text: 'https://api.example.com' },
    { type: 'secret_text', name: 'API_TOKEN', text: 'super-secret-value' },
  ]);
  assert.deepEqual(metadata.assets, {
    jwt: 'completion-jwt',
    config: { not_found_handling: '404-page', run_worker_first: true },
  });
});

test('fails closed and disables a slot when workers.dev cannot be disabled', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  const requests = [];
  const env = testEnv(store, createSnapshotStore(), {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'cf_secret_token',
    fetch: async (request) => {
      requests.push(request);
      if (request.url.endsWith('/workers/services/pages-v2-production-slot-007/environments/production/subdomain')) {
        return Response.json({ success: false, errors: [{ code: 'subdomain_disable_failed' }] }, { status: 500 });
      }
      return Response.json({ success: true, result: { id: 'ok' } });
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'slot_subdomain_failed',
    }),
    env
  );

  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'DEPLOYMENT_UPLOAD_FAILED');
  assert.equal(
    requests.some((request) => request.method === 'PUT'),
    false
  );
  assert.equal((await store.getWorkerSlot('slot_007')).status, 'disabled');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);
});

test('deletes uploaded slot worker when post-upload workers.dev disable fails', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  let subdomainCalls = 0;
  const requests = [];
  const env = testEnv(store, createSnapshotStore(), {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'cf_secret_token',
    fetch: async (request) => {
      requests.push(request.clone());
      if (request.url.endsWith('/workers/services/pages-v2-production-slot-007/environments/production/subdomain')) {
        subdomainCalls += 1;
        if (subdomainCalls === 2) {
          return Response.json({ success: false, errors: [{ code: 'subdomain_disable_failed' }] }, { status: 500 });
        }
      }
      return Response.json({ success: true, result: { id: 'ok' } });
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'slot_subdomain_failed_after_upload',
    }),
    env
  );

  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'DEPLOYMENT_UPLOAD_FAILED');
  assert.ok(
    requests.some((request) => request.method === 'PUT'),
    'slot Worker was uploaded before failure'
  );
  assert.ok(
    requests.some(
      (request) => request.method === 'DELETE' && request.url.endsWith('/workers/scripts/pages-v2-production-slot-007')
    ),
    'uploaded slot Worker should be deleted when workers.dev cannot be confirmed disabled'
  );
  assert.equal((await store.getWorkerSlot('slot_007')).status, 'disabled');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);
});

test('fails normal worker slot deployment when no slot is available', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'slot_full' }),
    testEnv(store, createSnapshotStore(), { PAGES_EXECUTION_MODE: 'normal-worker-slot' })
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'DEPLOYMENT_CAPACITY_EXHAUSTED');
  assert.equal(await store.getSiteVersion('ver_1'), null);
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);
});

test('notifies Slack with an actions URL button when normal worker slot capacity is exhausted', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_001',
    environment: 'production',
    slotNumber: 1,
    workerName: 'pages-v2-production-slot-001',
    bindingName: 'SITE_SLOT_001',
    status: 'assigned',
  });
  await store.createWorkerSlot({
    id: 'slot_002',
    environment: 'production',
    slotNumber: 2,
    workerName: 'pages-v2-production-slot-002',
    bindingName: 'SITE_SLOT_002',
    status: 'assigned',
  });
  const slackRequests = [];
  const webhookUrl = testSlackWebhookUrl();
  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'slot_notify',
    }),
    testEnv(store, createSnapshotStore(), {
      PAGES_EXECUTION_MODE: 'normal-worker-slot',
      PAGES_NORMAL_WORKER_SLOT_EXPAND_BY: '2',
      SLACK_PAGES_ALERT_MENTION_USER_ID: 'UTESTMEMBER',
      SLACK_PAGES_ALERT_WEBHOOK_URL: webhookUrl,
      fetch: async (request) => {
        slackRequests.push(request);
        return new Response('ok');
      },
    })
  );

  assert.equal(response.status, 503);
  assert.equal(slackRequests.length, 1);
  assert.equal(slackRequests[0].method, 'POST');
  assert.equal(slackRequests[0].url, webhookUrl);
  const payload = await slackRequests[0].json();
  const serialized = JSON.stringify(payload);
  assert.equal(payload.text, 'Legacy Worker 池容量不足，需要迁移到 WFP');
  assert.equal((serialized.match(/<@UTESTMEMBER>/g) || []).length, 1);
  assert.deepEqual(payload.blocks[2].fields, [
    { type: 'mrkdwn', text: '*环境*\nproduction' },
    { type: 'mrkdwn', text: '*容量*\n已用 2 / 总计 2' },
    { type: 'mrkdwn', text: '*剩余*\n0' },
    { type: 'mrkdwn', text: '*建议*\n迁移/重发到 WFP' },
  ]);
  assert.match(serialized, /https:\/\/github\.com\/xindong\/pages-manager\/actions/);
  assert.match(serialized, /button/);
  assert.doesNotMatch(serialized, /Deployment|Site|dep_1|site_1/);
  assert.doesNotMatch(serialized, /cli-token|pepper|cf_secret_token|Authorization|user@example\.com/);
});

test('does not mask capacity response when Slack notification fails', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'slot_notify_fail',
    }),
    testEnv(store, createSnapshotStore(), {
      PAGES_EXECUTION_MODE: 'normal-worker-slot',
      SLACK_PAGES_ALERT_WEBHOOK_URL: testSlackWebhookUrl(),
      fetch: async () => new Response('nope', { status: 500 }),
    })
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'DEPLOYMENT_CAPACITY_EXHAUSTED');
  assert.equal((await store.getDeployment('dep_1')).errorCode, 'DEPLOYMENT_CAPACITY_EXHAUSTED');
});

test('deployment idempotency replays same request and rejects changed request', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots);

  const first = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'idem_1' }),
    env
  );
  const replay = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'idem_1' }),
    env
  );
  const secondReplay = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'idem_1' }),
    env
  );
  const conflict = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("def"); } };' }),
      { 'Idempotency-Key': 'idem_1' }
    ),
    env
  );
  const bundleConflict = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("changed"); } };' }),
      { 'Idempotency-Key': 'idem_1' }
    ),
    env
  );

  assert.equal(first.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(secondReplay.status, 200);
  assert.equal(first.headers.get('X-Deployment-Trace-Id'), replay.headers.get('X-Deployment-Trace-Id'));
  assert.equal(first.headers.get('X-Deployment-Trace-Id'), secondReplay.headers.get('X-Deployment-Trace-Id'));
  assert.notEqual(conflict.headers.get('X-Deployment-Trace-Id'), first.headers.get('X-Deployment-Trace-Id'));
  const replayBody = await replay.json();
  assert.equal(replayBody.deployment.id, 'dep_1');
  assert.equal((await store.getDeployment('dep_1', 'production')).traceId, first.headers.get('X-Deployment-Trace-Id'));
  assert.deepEqual(
    (await store.listDeploymentEvents({ environment: 'production', traceId: first.headers.get('X-Deployment-Trace-Id') }))
      .filter((event) => event.operation === 'idempotency_replay')
      .map((event) => event.attempt)
      .sort((left, right) => left - right),
    [2, 3]
  );
  assert.deepEqual(await store.listDeploymentEvents({ environment: 'production', traceId: 'dtr_2' }), []);
  assert.deepEqual(await store.listDeploymentEvents({ environment: 'production', traceId: 'dtr_3' }), []);
  assert.equal(
    (
      await store.listDeploymentEvents({
        environment: 'production',
        traceId: first.headers.get('X-Deployment-Trace-Id'),
      })
    )
      .filter((event) => event.attempt > 1)
      .every((event) => event.operation === 'idempotency_replay'),
    true
  );
  assert.deepEqual(replayBody.decision, replayBody.version.decision);
  assert.deepEqual(replayBody.decision, {
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
  });
  assert.equal(conflict.status, 409);
  assert.equal((await conflict.json()).error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(bundleConflict.status, 409);
  assert.equal((await bundleConflict.json()).error.code, 'IDEMPOTENCY_CONFLICT');
  assert.equal(await store.getSiteVersion('ver_2'), null);
});

test('deployment idempotency replay claims a trace for legacy deployments without one', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());

  const first = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'legacy_trace_replay',
    }),
    env
  );
  await store.updateDeployment('dep_1', { traceId: null });

  const replay = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'legacy_trace_replay',
    }),
    env
  );

  assert.equal(first.status, 201);
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.equal(replay.headers.get('X-Deployment-Trace-Id'), 'dtr_2');
  assert.equal((await store.getDeployment('dep_1', 'production')).traceId, 'dtr_2');
});

test('deployment idempotency replay keeps a trace when legacy trace claiming fails', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'legacy_trace_claim_failure',
      }),
      env
    )
  );
  await store.updateDeployment('dep_1', { traceId: null });
  store.claimDeploymentTrace = async () => {
    throw new Error('claim failed');
  };

  const replay = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'legacy_trace_claim_failure',
    }),
    env
  );

  assert.equal(replay.status, 200, await replay.clone().text());
  assert.equal(replay.headers.get('X-Deployment-Trace-Id'), 'dtr_2');
  assert.equal((await replay.json()).deployment.status, 'succeeded');
  const replayEvents = await store.listDeploymentEvents({ environment: 'production', traceId: 'dtr_2' });
  assert.equal(
    replayEvents.some(
      (event) => event.stage === 'deployment_record' && event.operation === 'claim_deployment_trace' && event.status === 'failed'
    ),
    true
  );
  assert.equal(
    replayEvents.some(
      (event) => event.stage === 'deployment_record' && event.operation === 'idempotency_replay' && event.status === 'succeeded'
    ),
    true
  );
});

test('rollback idempotency replay keeps a trace when legacy trace claiming fails', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'rollback_claim_deploy_1',
      }),
      env
    )
  );
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
        { 'Idempotency-Key': 'rollback_claim_deploy_2' }
      ),
      env
    )
  );
  const firstRollback = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      {
        'Idempotency-Key': 'legacy_rollback_trace_claim_failure',
      }
    ),
    env
  );
  assert.equal(firstRollback.status, 201, await firstRollback.clone().text());
  await store.updateDeployment('dep_3', { traceId: null });
  store.claimDeploymentTrace = async () => {
    throw new Error('claim failed');
  };

  const replay = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      {
        'Idempotency-Key': 'legacy_rollback_trace_claim_failure',
      }
    ),
    env
  );

  assert.equal(replay.status, 200, await replay.clone().text());
  assert.equal(replay.headers.get('X-Deployment-Trace-Id'), 'dtr_4');
  assert.equal((await replay.json()).deployment.status, 'succeeded');
  const replayEvents = await store.listDeploymentEvents({ environment: 'production', traceId: 'dtr_4' });
  assert.equal(
    replayEvents.some(
      (event) => event.stage === 'deployment_record' && event.operation === 'claim_deployment_trace' && event.status === 'failed'
    ),
    true
  );
  assert.equal(
    replayEvents.some(
      (event) => event.stage === 'deployment_record' && event.operation === 'idempotency_replay' && event.status === 'succeeded'
    ),
    true
  );
});

test('deployment idempotency replay ignores later site-level runtime config changes', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots);

  const first = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'idem_runtime_config_replay',
    }),
    env
  );
  await store.putSiteSecret({
    id: 'sec_later',
    environment: 'production',
    siteId: 'site_1',
    name: 'API_TOKEN',
    value: 'later-secret-value',
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:01:00.000Z',
  });
  await store.replaceSiteVars({
    environment: 'production',
    siteId: 'site_1',
    vars: { FEATURE_FLAG: 'later' },
    actorId: 'usr_1',
    updatedAt: '2026-06-15T00:02:00.000Z',
  });
  const replay = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'idem_runtime_config_replay',
    }),
    env
  );

  assert.equal(first.status, 201, await first.clone().text());
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.equal((await replay.json()).deployment.id, 'dep_1');
});

test('deployment idempotency conflict does not transfer site ownership first', async () => {
  const store = await createSeededStore();
  const team = await store.createTeam({
    id: 'team_1',
    environment: 'production',
    teamType: 'custom',
    name: 'Team One',
    createdByUserId: 'usr_1',
  });
  await store.addTeamMember({
    teamId: team.id,
    userId: 'usr_1',
    role: 'publisher',
    membershipSource: 'manual',
  });
  const env = testEnv(store, createSnapshotStore());

  const first = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'idem_transfer_conflict',
    }),
    env
  );
  const conflict = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({
        siteId: undefined,
        siteSlug: 'guide',
        teamId: team.id,
        moduleContent: 'export default { fetch() { return new Response("changed"); } };',
      }),
      { 'Idempotency-Key': 'idem_transfer_conflict' }
    ),
    env
  );

  assert.equal(first.status, 201, await first.clone().text());
  assert.equal(conflict.status, 409, await conflict.clone().text());
  assert.equal((await conflict.json()).error.code, 'IDEMPOTENCY_CONFLICT');
  const site = await store.getSite('site_1');
  assert.equal(site.ownerType, 'user');
  assert.equal(site.ownerId, 'usr_1');
  assert.equal((await store.listAuditEvents()).filter((event) => event.eventType === 'site.owner.transfer').length, 0);
});

test('rejects hand-written JSON deployment uploads', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      { siteId: 'site_1', contentHash: 'sha256:abc' },
      { 'Idempotency-Key': 'missing_bundle' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'CLI_UPLOAD_PROTOCOL_REQUIRED');
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('returns payload-too-large for oversized deployment bodies', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'a'.repeat(50 * 1024 * 1024 + 1) }),
      { 'Idempotency-Key': 'too_large' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('returns payload-too-large when publish metadata exceeds upload limit', async () => {
  const store = await createSeededStore();
  const form = new FormData();
  const metadata = JSON.stringify({
    schemaVersion: 1,
    siteId: 'site_1',
    requestedFallback: 'auto',
    source: 'cli',
    contentHash: 'sha256:metadata',
    publishPlan: {
      deploymentShape: 'assets-only',
      requestedFallback: 'auto',
      resolvedFallback: 'not-found',
      routingMode: 'assets-only',
      workerEntry: null,
      workerMainModuleName: null,
      assetsConfig: { notFoundHandling: '404-page' },
    },
    assetManifest: [],
    workerModules: [],
    controlSignals: ['x'.repeat(50 * 1024 * 1024)],
  });
  form.set('metadata', new Blob([metadata], { type: 'application/json' }), 'metadata.json');

  const response = await worker.fetch(
    new Request('https://api.pages.xd.team/.xd-pages/api/deployments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${BEARER_USR_1}`,
        'CF-Connecting-IP': '10.1.2.3',
        'Idempotency-Key': 'metadata_too_large',
      },
      body: form,
    }),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'PAYLOAD_TOO_LARGE');
  assert.equal(await store.getSiteVersion('ver_1'), null);
});

test('gets deployment by id for authorized site actors', async () => {
  const store = await createSeededStore();
  await store.createDeploymentForIdempotency({
    id: 'dep_1',
    environment: 'production',
    actorId: 'usr_1',
    actorUserId: 'usr_1',
    actorType: 'user',
    source: 'cli',
    siteId: 'site_1',
    operation: 'deploy',
    idempotencyKey: 'idem_1',
    requestHash: 'hash_1',
    visibility: 'org',
    status: 'succeeded',
  });

  const response = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/deployments/dep_1'),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 200);
  assert.equal((await response.json()).deployment.id, 'dep_1');
});

test('requires read:site scope for access key deployment reads', async () => {
  const store = await createSeededStore();
  await store.createDeploymentForIdempotency({
    id: 'dep_1',
    environment: 'production',
    actorId: 'usr_1',
    actorUserId: 'usr_1',
    actorType: 'user',
    source: 'cli',
    siteId: 'site_1',
    operation: 'deploy',
    idempotencyKey: 'idem_1',
    requestHash: 'hash_1',
    visibility: 'org',
    status: 'succeeded',
  });
  const deployOnlyKey = await seedAccessKey(store, 'ak_deploy', ['deploy:site']);
  const readKey = await seedAccessKey(store, 'ak_read', ['read:site']);

  const denied = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/deployments/dep_1', {
      Authorization: `Bearer ${deployOnlyKey}`,
    }),
    testEnv(store, createSnapshotStore())
  );
  const allowed = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/deployments/dep_1', {
      Authorization: `Bearer ${readKey}`,
    }),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'DEPLOYMENT_READ_FORBIDDEN');
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).deployment.id, 'dep_1');
});

test('personal read access keys cannot read deployments for sites outside their ownership', async () => {
  const store = await createSeededStore();
  await store.createUser({
    userId: 'usr_2',
    email: 'other@example.com',
    realname: 'Other User',
    employeeStatus: 'active',
  });
  await store.createDeploymentForIdempotency({
    id: 'dep_1',
    environment: 'production',
    actorId: 'usr_1',
    actorUserId: 'usr_1',
    actorType: 'user',
    source: 'cli',
    siteId: 'site_1',
    operation: 'deploy',
    idempotencyKey: 'idem_1',
    requestHash: 'hash_1',
    visibility: 'org',
    status: 'succeeded',
  });
  const otherUserReadKey = await seedAccessKey(store, 'ak_read_other', ['read:site'], null, {
    ownerUserId: 'usr_2',
  });

  const response = await worker.fetch(
    authRequest('https://api.pages.xd.team/.xd-pages/api/deployments/dep_1', {
      Authorization: `Bearer ${otherUserReadKey}`,
    }),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'DEPLOYMENT_READ_FORBIDDEN');
});

test('enforces deploy and rollback access key scopes separately', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots);
  const deployOnlyKey = await seedAccessKey(store, 'ak_deploy', ['deploy:site']);
  const rollbackOnlyKey = await seedAccessKey(store, 'ak_rollback', ['rollback:site']);

  const deployWithRollbackOnly = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      Authorization: `Bearer ${rollbackOnlyKey}`,
      'Idempotency-Key': 'deploy_rollback_only',
    }),
    env
  );

  await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'deploy_1' }),
    env
  );
  const rollbackWithDeployOnly = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      {
        Authorization: `Bearer ${deployOnlyKey}`,
        'Idempotency-Key': 'rollback_deploy_only',
      }
    ),
    env
  );

  assert.equal(deployWithRollbackOnly.status, 403);
  assert.equal((await deployWithRollbackOnly.json()).error.code, 'DEPLOY_FORBIDDEN');
  assert.equal(rollbackWithDeployOnly.status, 403);
  assert.equal((await rollbackWithDeployOnly.json()).error.code, 'ROLLBACK_FORBIDDEN');
});

test('rolls back to an existing immutable version and writes a new route snapshot', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots);

  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'deploy_1',
      }),
      env
    )
  );
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ moduleContent: 'export default { fetch() { return new Response("def"); } };' }),
        { 'Idempotency-Key': 'deploy_2' }
      ),
      env
    )
  );

  const rollback = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback', {}, { 'Idempotency-Key': 'rb_1' }),
    env
  );

  assert.equal(rollback.status, 201, await rollback.clone().text());
  const body = await rollback.json();
  assert.equal(body.deployment.operation, 'rollback');
  assert.equal(body.deployment.previousVersionId, 'ver_2');
  assert.equal(body.route.activeVersionId, 'ver_1');
  assert.equal(body.route.routeGeneration, 3);
  const rolledBackVersion = await store.getSiteVersion('ver_1');
  const replacementVersion = await store.getSiteVersion('ver_2');
  assert.match(rolledBackVersion.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(replacementVersion.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(rolledBackVersion.contentHash, replacementVersion.contentHash);
  assert.equal(snapshots.read('production:route_pointer:guide.pages.xd.team').routeGeneration, 3);
});

test('rejects rollback when requested site does not match the version site', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots);
  await store.createSite({
    id: 'site_2',
    slug: 'other',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_2',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_2',
    hostname: 'other.pages.xd.team',
  });
  await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'deploy_1' }),
    env
  );

  const rollback = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      { siteSlug: 'other' },
      { 'Idempotency-Key': 'rb_wrong_site' }
    ),
    env
  );

  assert.equal(rollback.status, 409);
  assert.equal((await rollback.json()).error.code, 'ROLLBACK_SITE_MISMATCH');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_1');
  assert.equal((await store.getRouteBySiteId('site_2')).activeVersionId, null);
});

test('marks deployment failed when route snapshot write fails and replays failed terminal state', async () => {
  const store = await createSeededStore();
  const deletedWorkers = [];
  const env = testEnv(store, failingSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => ({ ok: true }),
      delete: async ({ workerName }) => deletedWorkers.push(workerName),
    },
  });
  const request = () =>
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'snapshot_fail',
    });

  const first = await worker.fetch(request(), env);
  const replay = await worker.fetch(request(), env);

  assert.equal(first.status, 503);
  const firstBody = await first.json();
  assert.equal(firstBody.error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.equal(firstBody.error.action, 'Retry the deployment with a new Idempotency-Key.');
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.deepEqual(deletedWorkers, []);
  assert.deepEqual(await store.getRouteBySiteId('site_1'), {
    id: 'route_1',
    hostname: 'guide.pages.xd.team',
    siteId: 'site_1',
    environment: 'production',
    runtime: 'disabled',
    executionProvider: null,
    workerName: null,
    dispatchType: null,
    dispatchBindingName: null,
    slotId: null,
    activeVersionId: null,
    visibility: 'org',
    exposure: 'internal',
    accessMode: 'org',
    policyVersion: 1,
    routeGeneration: 2,
    runtimeConfigGeneration: 0,
    routeStatus: 'disabled',
    cacheTier: 'fast',
    createdAt: '2026-06-15T00:00:00.000Z',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });
  assert.equal(replay.status, 200);
  const replayBody = await replay.json();
  assert.equal(replayBody.deployment.status, 'failed');
  assert.equal(replayBody.deployment.errorCode, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.equal(replayBody.deployment.errorMessage, 'Route snapshot write failed.');
});

test('restores previous route when snapshot write fails after runtime config changes', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());

  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'snapshot_previous_version',
      }),
      env
    )
  );

  const previousRoute = await store.getRouteBySiteId('site_1', 'production');
  let injectedRuntimeChange = false;
  env.ROUTE_SNAPSHOTS = {
    put: async () => {
      if (!injectedRuntimeChange) {
        injectedRuntimeChange = true;
        await store.putSiteSecret({
          id: 'sec_1',
          environment: 'production',
          siteId: 'site_1',
          name: 'API_TOKEN',
          value: 'changed-after-activation',
          actorId: 'usr_1',
          updatedAt: '2026-06-15T00:00:01.000Z',
        });
      }
      throw new Error('snapshot write failed');
    },
  };

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("def"); } };' }),
      { 'Idempotency-Key': 'snapshot_runtime_changed_after_activation' }
    ),
    env
  );
  const route = await store.getRouteBySiteId('site_1', 'production');

  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.equal((await store.getDeployment('dep_2')).status, 'failed');
  assert.equal(route.activeVersionId, previousRoute.activeVersionId);
  assert.equal(route.workerName, previousRoute.workerName);
  assert.equal(route.routeGeneration, previousRoute.routeGeneration + 2);
  assert.equal(route.routeStatus, previousRoute.routeStatus);
  assert.equal(route.runtimeConfigGeneration, previousRoute.runtimeConfigGeneration + 1);
});

test('restores previous route when snapshot write fails after policy changes', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());

  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'snapshot_policy_previous_version',
      }),
      env
    )
  );

  const previousRoute = await store.getRouteBySiteId('site_1', 'production');
  let injectedPolicyChange = false;
  env.ROUTE_SNAPSHOTS = {
    put: async () => {
      if (!injectedPolicyChange) {
        injectedPolicyChange = true;
        await store.updateSiteVisibility('site_1', { visibility: 'owner', updatedAt: '2026-06-15T00:00:02.000Z' }, 'production');
      }
      throw new Error('snapshot write failed');
    },
  };

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("def"); } };' }),
      { 'Idempotency-Key': 'snapshot_policy_changed_after_activation' }
    ),
    env
  );
  const route = await store.getRouteBySiteId('site_1', 'production');

  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.equal((await store.getDeployment('dep_2')).status, 'failed');
  assert.equal(route.activeVersionId, previousRoute.activeVersionId);
  assert.equal(route.workerName, previousRoute.workerName);
  assert.equal(route.routeGeneration, previousRoute.routeGeneration + 2);
  assert.equal(route.visibility, 'owner');
  assert.equal(route.policyVersion, previousRoute.policyVersion + 1);
  assert.equal(route.cacheTier, 'sensitive');
});

test('restores previous WFP route snapshot after a concurrent policy snapshot advances the pointer', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const deletedWorkers = [];
  const env = testEnv(store, snapshots, {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => ({ ok: true }),
      delete: async ({ workerName }) => deletedWorkers.push(workerName),
    },
  });

  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'snapshot_pointer_previous_version',
      }),
      env
    )
  );
  const previousRoute = await store.getRouteBySiteId('site_1', 'production');

  env.ROUTE_SNAPSHOTS = failFirstSnapshotPutAfter(snapshots, async () => {
    await store.updateSiteVisibility('site_1', { visibility: 'owner', updatedAt: '2026-06-15T00:00:03.000Z' }, 'production');
    await writeCurrentRouteSnapshot(store, snapshots);
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("def"); } };' }),
      { 'Idempotency-Key': 'snapshot_policy_pointer_changed_after_activation' }
    ),
    env
  );
  const route = await store.getRouteBySiteId('site_1', 'production');
  const pointer = snapshots.read('production:route_pointer:guide.pages.xd.team');
  const snapshot = snapshots.read(pointer.snapshotKey);

  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.equal(route.activeVersionId, previousRoute.activeVersionId);
  assert.equal(route.workerName, previousRoute.workerName);
  assert.equal(route.routeGeneration, previousRoute.routeGeneration + 2);
  assert.equal(route.visibility, 'owner');
  assert.equal(route.policyVersion, previousRoute.policyVersion + 1);
  assert.equal(pointer.routeGeneration, route.routeGeneration);
  assert.equal(pointer.policyVersion, route.policyVersion);
  assert.equal(snapshot.activeVersionId, previousRoute.activeVersionId);
  assert.equal(snapshot.workerName, previousRoute.workerName);
  assert.equal(snapshot.visibility, 'owner');
  assert.deepEqual(deletedWorkers, ['pages-v2-guide-ver-2']);
});

test('writes an inactive route snapshot when first WFP deploy snapshot fails after pointer advance', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const deletedWorkers = [];
  const env = testEnv(store, snapshots, {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => ({ ok: true }),
      delete: async ({ workerName }) => deletedWorkers.push(workerName),
    },
  });

  env.ROUTE_SNAPSHOTS = failFirstSnapshotPutAfter(snapshots, async () => {
    await store.updateSiteVisibility('site_1', { visibility: 'owner', updatedAt: '2026-06-15T00:00:03.000Z' }, 'production');
    await writeCurrentRouteSnapshot(store, snapshots);
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'snapshot_disabled_pointer_changed_after_activation',
    }),
    env
  );
  const route = await store.getRouteBySiteId('site_1', 'production');
  const pointer = snapshots.read('production:route_pointer:guide.pages.xd.team');
  const snapshot = snapshots.read(pointer.snapshotKey);

  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.equal(route.activeVersionId, null);
  assert.equal(route.workerName, null);
  assert.equal(route.routeStatus, 'disabled');
  assert.equal(route.routeGeneration, 2);
  assert.equal(route.visibility, 'owner');
  assert.equal(pointer.routeGeneration, route.routeGeneration);
  assert.equal(pointer.policyVersion, route.policyVersion);
  assert.equal(snapshot.activeVersionId, null);
  assert.equal(snapshot.workerName, null);
  assert.equal(snapshot.routeStatus, 'disabled');
  assert.deepEqual(deletedWorkers, ['pages-v2-guide-ver-1']);
});

test('writes restored route snapshot before cleaning failed deployment worker', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const deletedWorkers = [];
  const env = testEnv(store, snapshots, {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => ({ ok: true }),
      delete: async ({ workerName }) => deletedWorkers.push(workerName),
    },
  });

  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'snapshot_restore_previous_version',
      }),
      env
    )
  );

  let writes = 0;
  env.ROUTE_SNAPSHOTS = {
    put: async (key, value) => {
      writes += 1;
      if (writes === 1) throw new Error('snapshot write failed');
      return snapshots.put(key, value);
    },
    read: snapshots.read,
  };

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("def"); } };' }),
      { 'Idempotency-Key': 'snapshot_restore_then_cleanup' }
    ),
    env
  );
  const pointer = snapshots.read('production:route_pointer:guide.pages.xd.team');

  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.deepEqual(deletedWorkers, ['pages-v2-guide-ver-2']);
  assert.equal(pointer.routeGeneration, 3);
  assert.equal(snapshots.read(pointer.snapshotKey).activeVersionId, 'ver_1');
});

test('normal worker slot snapshot failure restores previous route before cleaning failed slot', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_001',
    environment: 'production',
    slotNumber: 1,
    workerName: 'pages-v2-production-slot-001',
    bindingName: 'SITE_SLOT_001',
    status: 'available',
  });
  await store.createWorkerSlot({
    id: 'slot_002',
    environment: 'production',
    slotNumber: 2,
    workerName: 'pages-v2-production-slot-002',
    bindingName: 'SITE_SLOT_002',
    status: 'available',
  });
  const snapshots = createSnapshotStore();
  const events = [];
  const env = testEnv(store, snapshots, {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    NORMAL_WORKER_SLOT_PROVIDER: {
      upload: async ({ slot }) => events.push(['upload', slot.id]),
      verify: async ({ slotId }) => events.push(['verify', slotId]),
      cleanupRetainedSlot: async ({ slot }) => events.push(['cleanup', slot.id, slot.assignedVersionId]),
    },
  });

  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'slot_snapshot_previous_version',
      }),
      env
    )
  );

  let writes = 0;
  env.ROUTE_SNAPSHOTS = {
    put: async (key, value) => {
      writes += 1;
      if (writes === 1) throw new Error('snapshot write failed');
      return snapshots.put(key, value);
    },
    read: snapshots.read,
  };

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("slot"); } };' }),
      { 'Idempotency-Key': 'slot_snapshot_restore_then_cleanup' }
    ),
    env
  );
  const route = await store.getRouteBySiteId('site_1', 'production');
  const pointer = snapshots.read('production:route_pointer:guide.pages.xd.team');

  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.equal(route.activeVersionId, 'ver_1');
  assert.equal(route.slotId, 'slot_001');
  assert.equal((await store.getWorkerSlot('slot_002')).status, 'available');
  assert.equal((await store.getWorkerSlot('slot_002')).assignedVersionId, null);
  assert.deepEqual(events, [
    ['upload', 'slot_001'],
    ['verify', 'slot_001'],
    ['upload', 'slot_002'],
    ['verify', 'slot_002'],
    ['cleanup', 'slot_002', 'ver_2'],
  ]);
  assert.equal(snapshots.read(pointer.snapshotKey).activeVersionId, 'ver_1');
});

test('normal worker slot snapshot failure restores snapshot after a concurrent policy pointer advance', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_001',
    environment: 'production',
    slotNumber: 1,
    workerName: 'pages-v2-production-slot-001',
    bindingName: 'SITE_SLOT_001',
    status: 'available',
  });
  await store.createWorkerSlot({
    id: 'slot_002',
    environment: 'production',
    slotNumber: 2,
    workerName: 'pages-v2-production-slot-002',
    bindingName: 'SITE_SLOT_002',
    status: 'available',
  });
  const snapshots = createSnapshotStore();
  const events = [];
  const env = testEnv(store, snapshots, {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    NORMAL_WORKER_SLOT_PROVIDER: {
      upload: async ({ slot }) => events.push(['upload', slot.id]),
      verify: async ({ slotId }) => events.push(['verify', slotId]),
      cleanupRetainedSlot: async ({ slot }) => events.push(['cleanup', slot.id, slot.assignedVersionId]),
    },
  });

  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'slot_snapshot_pointer_previous_version',
      }),
      env
    )
  );
  const previousRoute = await store.getRouteBySiteId('site_1', 'production');

  env.ROUTE_SNAPSHOTS = failFirstSnapshotPutAfter(snapshots, async () => {
    await store.updateSiteVisibility('site_1', { visibility: 'owner', updatedAt: '2026-06-15T00:00:03.000Z' }, 'production');
    await writeCurrentRouteSnapshot(store, snapshots);
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("slot"); } };' }),
      { 'Idempotency-Key': 'slot_snapshot_policy_pointer_changed_after_activation' }
    ),
    env
  );
  const route = await store.getRouteBySiteId('site_1', 'production');
  const pointer = snapshots.read('production:route_pointer:guide.pages.xd.team');
  const snapshot = snapshots.read(pointer.snapshotKey);

  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.equal(route.activeVersionId, previousRoute.activeVersionId);
  assert.equal(route.slotId, previousRoute.slotId);
  assert.equal(route.routeGeneration, previousRoute.routeGeneration + 2);
  assert.equal(route.visibility, 'owner');
  assert.equal(pointer.routeGeneration, route.routeGeneration);
  assert.equal(snapshot.activeVersionId, previousRoute.activeVersionId);
  assert.equal(snapshot.dispatch.slotId, previousRoute.slotId);
  assert.equal((await store.getWorkerSlot('slot_002')).status, 'available');
  assert.equal((await store.getWorkerSlot('slot_002')).assignedVersionId, null);
  assert.deepEqual(events, [
    ['upload', 'slot_001'],
    ['verify', 'slot_001'],
    ['upload', 'slot_002'],
    ['verify', 'slot_002'],
    ['cleanup', 'slot_002', 'ver_2'],
  ]);
});

test('normal worker slot writes inactive snapshot before cleaning first failed slot after pointer advance', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_001',
    environment: 'production',
    slotNumber: 1,
    workerName: 'pages-v2-production-slot-001',
    bindingName: 'SITE_SLOT_001',
    status: 'available',
  });
  const snapshots = createSnapshotStore();
  const events = [];
  const env = testEnv(store, snapshots, {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    NORMAL_WORKER_SLOT_PROVIDER: {
      upload: async ({ slot }) => events.push(['upload', slot.id]),
      verify: async ({ slotId }) => events.push(['verify', slotId]),
      cleanupRetainedSlot: async ({ slot }) => events.push(['cleanup', slot.id, slot.assignedVersionId]),
    },
  });

  env.ROUTE_SNAPSHOTS = failFirstSnapshotPutAfter(snapshots, async () => {
    await store.updateSiteVisibility('site_1', { visibility: 'owner', updatedAt: '2026-06-15T00:00:03.000Z' }, 'production');
    await writeCurrentRouteSnapshot(store, snapshots);
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'slot_snapshot_disabled_pointer_changed_after_activation',
    }),
    env
  );
  const route = await store.getRouteBySiteId('site_1', 'production');
  const pointer = snapshots.read('production:route_pointer:guide.pages.xd.team');
  const snapshot = snapshots.read(pointer.snapshotKey);

  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.equal(route.activeVersionId, null);
  assert.equal(route.slotId, null);
  assert.equal(route.routeStatus, 'disabled');
  assert.equal(route.routeGeneration, 2);
  assert.equal(route.visibility, 'owner');
  assert.equal(pointer.routeGeneration, route.routeGeneration);
  assert.equal(snapshot.activeVersionId, null);
  assert.equal(snapshot.dispatch.type, 'dispatch-namespace');
  assert.equal((await store.getWorkerSlot('slot_001')).status, 'available');
  assert.equal((await store.getWorkerSlot('slot_001')).assignedVersionId, null);
  assert.deepEqual(events, [
    ['upload', 'slot_001'],
    ['verify', 'slot_001'],
    ['cleanup', 'slot_001', 'ver_1'],
  ]);
});

test('marks deployment failed when WFP upload fails without creating active version', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async () => {
        throw new Error('upload failed');
      },
      verify: async () => {
        throw new Error('verify should not run');
      },
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default {};' }),
      { 'Idempotency-Key': 'wfp_upload_fail' }
    ),
    env
  );

  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.code, 'DEPLOYMENT_UPLOAD_FAILED');
  assert.equal(body.error.action, 'Retry the deployment with a new Idempotency-Key.');
  const failedDeployment = await store.getDeployment('dep_1');
  assert.equal(failedDeployment.status, 'failed');
  assert.equal(failedDeployment.failureStage, 'upload_worker');
  assert.deepEqual(failedDeployment.failureDiagnostics, {
    schemaVersion: 1,
    stage: 'upload_worker',
    executionProvider: 'wfp',
    deploymentShape: 'worker-only',
    plannedVersionId: 'ver_1',
    plannedWorkerName: 'pages-v2-guide-ver-1',
    uploadCompleted: false,
    verifyCompleted: false,
    routePointerCommitted: false,
    trafficImpact: 'old_version_retained',
    retryable: true,
    operatorAction: 'retry_deploy',
    cause: {
      code: 'DEPLOYMENT_UPLOAD_FAILED',
      class: 'provider_upload_error',
    },
  });
  assert.equal(await store.getSiteVersion('ver_1'), null);
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);

  const polled = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/deployments/dep_1'), env);
  const polledBody = await polled.json();
  assert.equal(polledBody.deployment.failureStage, 'upload_worker');
  assert.equal('failureDiagnostics' in polledBody.deployment, false);
});

test('persists structured WFP provider diagnostics for upload failures', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async () => {
        throw new WfpApiError({
          status: 400,
          code: 'WFP_API_ERROR',
          message: '10090 manifest rejected',
          operation: 'assets_upload_session',
          providerCode: 10090,
          providerMessage: 'manifest rejected',
          providerRequestId: 'ray-upload-1',
        });
      },
      verify: async () => {
        throw new Error('verify should not run');
      },
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'wfp_structured_upload_fail',
    }),
    env
  );

  assert.equal(response.status, 502);
  const failedDeployment = await store.getDeployment('dep_1');
  assert.deepEqual(failedDeployment.failureDiagnostics.provider, {
    name: 'cloudflare_wfp',
    operation: 'assets_upload_session',
    httpStatus: 400,
    clientCode: 'WFP_API_ERROR',
    providerCode: '10090',
    providerMessage: 'manifest rejected',
    providerRequestId: 'ray-upload-1',
  });

  const polled = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/deployments/dep_1'), env);
  const polledBody = await polled.json();
  assert.equal('failureDiagnostics' in polledBody.deployment, false);
});

test('marks Cloudflare Worker source compilation failures as non-retryable', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async () => {
        throw new WfpApiError({
          status: 400,
          code: 'WFP_API_ERROR',
          message: 'Worker upload rejected',
          operation: 'worker_put',
          providerCode: 10021,
          providerMessage: 'Uncaught SyntaxError: Unexpected end of input at bad-worker.js:5',
          providerRequestId: 'source-error-ray-SIN',
        });
      },
      verify: async () => {
        throw new Error('verify should not run');
      },
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'wfp_worker_source_invalid',
    }),
    env
  );
  const body = await response.json();
  const failed = await store.getDeployment('dep_1');

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'DEPLOYMENT_UPLOAD_FAILED');
  assert.equal(body.error.message, 'Worker source compilation failed.');
  assert.equal(
    body.error.action,
    'Fix the Worker source and deploy again: Uncaught SyntaxError: Unexpected end of input at bad-worker.js:5'
  );
  assert.equal(failed.failureDiagnostics.retryable, false);
  assert.equal(failed.failureDiagnostics.operatorAction, 'fix_worker_source');
  assert.equal(failed.failureDiagnostics.provider.providerCode, '10021');
});

test('keeps transient Provider upload failures retryable', async () => {
  for (const failure of [
    new WfpApiError({ code: 'WFP_NETWORK_ERROR', message: 'network failed', operation: 'worker_put' }),
    new WfpApiError({ status: 429, code: 'WFP_API_ERROR', message: 'rate limited', operation: 'worker_put' }),
    new WfpApiError({ status: 503, code: 'WFP_API_ERROR', message: 'provider unavailable', operation: 'worker_put' }),
  ]) {
    const store = await createSeededStore();
    const env = testEnv(store, createSnapshotStore(), {
      WFP_PROVIDER: {
        upload: async () => {
          throw failure;
        },
        verify: async () => {
          throw new Error('verify should not run');
        },
      },
    });

    const response = await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': `wfp_transient_${failure.code}_${failure.status || 'network'}`,
      }),
      env
    );
    const failed = await store.getDeployment('dep_1');

    assert.equal(response.status, 502);
    assert.equal(failed.failureDiagnostics.retryable, true);
    assert.equal(failed.failureDiagnostics.operatorAction, 'retry_deploy');
  }
});

test('omits untrusted WFP provider diagnostic fields from upload failures', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async () => {
        throw Object.assign(new Error('do not persist this message'), {
          code: 'UNTRUSTED_CODE',
          status: 700,
          operation: 'arbitrary_operation',
          providerCode: { secret: 'value' },
          providerMessage: 'Bearer should-not-persist',
          providerRequestId: 'not a valid request id',
        });
      },
      verify: async () => {
        throw new Error('verify should not run');
      },
    },
  });

  await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'wfp_untrusted_upload_fail',
    }),
    env
  );

  const failedDeployment = await store.getDeployment('dep_1');
  assert.equal('provider' in failedDeployment.failureDiagnostics, false);
});

test('omits JWT-like WFP provider identifiers from persisted upload diagnostics', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async () => {
        throw new WfpApiError({
          status: 400,
          code: 'WFP_API_ERROR',
          message: 'provider rejected upload',
          operation: 'worker_put',
          providerCode: 'abcd.efgh.ijkl',
          providerMessage: 'provider rejected upload',
          providerRequestId: 'mnop.qrst.uvwx',
        });
      },
      verify: async () => {
        throw new Error('verify should not run');
      },
    },
  });

  await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'wfp_jwt_identifiers_upload_fail',
    }),
    env
  );

  const failedDeployment = await store.getDeployment('dep_1');
  assert.deepEqual(failedDeployment.failureDiagnostics.provider, {
    name: 'cloudflare_wfp',
    operation: 'worker_put',
    httpStatus: 400,
    clientCode: 'WFP_API_ERROR',
    providerMessage: 'provider rejected upload',
  });
});

test('omits unsupported WFP provider operations from persisted upload diagnostics', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async () => {
        throw Object.assign(new Error('provider rejected upload'), {
          status: 400,
          code: 'WFP_API_ERROR',
          operation: 'worker_verify',
          providerCode: 10090,
          providerMessage: 'provider rejected upload',
          providerRequestId: 'ray-upload-unsupported-operation',
        });
      },
      verify: async () => {
        throw new Error('verify should not run');
      },
    },
  });

  await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'wfp_unsupported_operation_upload_fail',
    }),
    env
  );

  const failedDeployment = await store.getDeployment('dep_1');
  assert.equal('provider' in failedDeployment.failureDiagnostics, false);
});

test('recovers an upload failure terminal state after the first state write fails', async () => {
  const store = await createSeededStore();
  const originalUpdateDeployment = store.updateDeployment.bind(store);
  let failedStateWriteAttempts = 0;
  let uploadAttempts = 0;
  store.updateDeployment = async (id, patch) => {
    if (patch.status === 'failed' && failedStateWriteAttempts++ === 0) {
      throw new Error('failed terminal write temporarily unavailable');
    }
    return originalUpdateDeployment(id, patch);
  };
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async () => {
        uploadAttempts += 1;
        throw new Error('upload failed');
      },
      verify: async () => {
        throw new Error('verify should not run');
      },
    },
  });
  const request = () =>
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'upload_terminal_write_recovers',
    });

  const response = await worker.fetch(request(), env);
  const replay = await worker.fetch(request(), env);

  assert.equal(response.status, 502, await response.clone().text());
  assert.equal((await response.json()).error.code, 'DEPLOYMENT_UPLOAD_FAILED');
  assert.equal(replay.status, 200, await replay.clone().text());
  assert.equal((await replay.json()).deployment.status, 'failed');
  assert.equal(uploadAttempts, 1);
  assert.equal(failedStateWriteAttempts, 2);
  const failed = await store.getDeployment('dep_1');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.errorCode, 'DEPLOYMENT_UPLOAD_FAILED');
  const events = await store.listDeploymentEvents({ environment: 'production', deploymentId: 'dep_1' });
  assert.equal(
    events.some(
      (event) =>
        event.stage === 'deployment_state_persist' &&
        event.operation === 'recover_failed_deployment' &&
        event.status === 'succeeded'
    ),
    true
  );
});

test('returns deployment state failure when upload failure cannot persist the failed terminal state', async () => {
  const store = await createSeededStore();
  const originalUpdateDeployment = store.updateDeployment.bind(store);
  const originalCreateDeploymentEvent = store.createDeploymentEvent.bind(store);
  let d1Unavailable = false;
  let failedStateWriteAttempts = 0;
  store.updateDeployment = async (id, patch) => {
    if (d1Unavailable && patch.status === 'failed') {
      failedStateWriteAttempts += 1;
      throw new Error('SQL token=failed-terminal-secret');
    }
    return originalUpdateDeployment(id, patch);
  };
  store.createDeploymentEvent = async (input) => {
    if (d1Unavailable) throw new Error('SQL token=failed-event-secret');
    return originalCreateDeploymentEvent(input);
  };
  const requests = [];
  const stateWriteLogs = [];
  const repairLogs = [];
  let uploadAttempts = 0;
  const snapshots = createSnapshotStore();
  await seedLifecycleWebhook(store, 'site.failed');
  const env = testEnv(store, snapshots, {
    logDeploymentStateWriteFailed: (line) => stateWriteLogs.push(JSON.parse(line)),
    logDeploymentRepairRequired: (line) => repairLogs.push(JSON.parse(line)),
    WEBHOOK_URL_ENCRYPTION_KEY: TEST_WEBHOOK_URL_ENCRYPTION_KEY,
    resolveWebhookHost: async () => ['8.8.8.8'],
    WEBHOOK_FETCH: async (request) => {
      requests.push(request);
      return new Response('ok', { status: 200 });
    },
    WFP_PROVIDER: {
      upload: async ({ workerName }) => {
        uploadAttempts += 1;
        if (uploadAttempts === 1) {
          d1Unavailable = true;
          throw new Error('upload failed');
        }
        return { artifactRef: `wfp://test/${workerName}` };
      },
      verify: async () => ({ ok: true }),
    },
  });
  const request = (idempotencyKey) =>
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': idempotencyKey,
    });

  const response = await worker.fetch(request('upload_and_terminal_write_fail'), env);

  assert.equal(response.status, 503, await response.clone().text());
  assert.equal((await response.json()).error.code, 'DEPLOYMENT_STATE_WRITE_FAILED');
  assert.equal((await store.getDeployment('dep_1')).status, 'uploading');
  const recoveryMarkers = await snapshots.list({ prefix: 'production:deployment_failure_recovery:site_1:' });
  assert.equal(recoveryMarkers.keys.length, 1, JSON.stringify(repairLogs));
  const recoveryMarker = snapshots.read(recoveryMarkers.keys[0].name);
  assert.equal(recoveryMarker.failedPatch.errorCode, 'DEPLOYMENT_UPLOAD_FAILED');
  assert.doesNotMatch(JSON.stringify(recoveryMarker), /SQL|token|secret/);

  const originalSnapshotList = snapshots.list;
  let failRecoveryMarkerList = true;
  snapshots.list = async (options) => {
    if (failRecoveryMarkerList && options?.prefix?.includes(':deployment_failure_recovery:')) {
      failRecoveryMarkerList = false;
      throw new Error('KV token=recovery-marker-list-secret');
    }
    return originalSnapshotList(options);
  };
  const unreadableMarkerListRetry = await worker.fetch(
    request('upload_and_terminal_write_retry_marker_list_unavailable'),
    env
  );

  assert.equal(unreadableMarkerListRetry.status, 503, await unreadableMarkerListRetry.clone().text());
  assert.equal((await unreadableMarkerListRetry.json()).error.code, 'DEPLOYMENT_STATE_WRITE_FAILED');
  assert.equal(await store.getDeployment('dep_2'), null);
  assert.equal(uploadAttempts, 1);
  assert.equal((await snapshots.list({ prefix: 'production:deployment_failure_recovery:site_1:' })).keys.length, 1);

  const originalSnapshotGet = snapshots.get;
  let failRecoveryMarkerRead = true;
  snapshots.get = async (key) => {
    if (failRecoveryMarkerRead && key.includes(':deployment_failure_recovery:')) {
      failRecoveryMarkerRead = false;
      throw new Error('KV token=recovery-marker-read-secret');
    }
    return originalSnapshotGet(key);
  };
  const unreadableMarkerRetry = await worker.fetch(request('upload_and_terminal_write_retry_marker_unavailable'), env);

  assert.equal(unreadableMarkerRetry.status, 503, await unreadableMarkerRetry.clone().text());
  assert.equal((await unreadableMarkerRetry.json()).error.code, 'DEPLOYMENT_STATE_WRITE_FAILED');
  assert.equal(await store.getDeployment('dep_2'), null);
  assert.equal(failedStateWriteAttempts, 2);
  assert.equal((await snapshots.list({ prefix: 'production:deployment_failure_recovery:site_1:' })).keys.length, 1);

  const originalGetDeployment = store.getDeployment.bind(store);
  let failRecoveryDeploymentRead = true;
  store.getDeployment = async (deploymentId, environment) => {
    if (failRecoveryDeploymentRead && deploymentId === 'dep_1') {
      failRecoveryDeploymentRead = false;
      throw new Error('SQL token=recovery-deployment-read-secret');
    }
    return originalGetDeployment(deploymentId, environment);
  };
  const unreadableDeploymentRetry = await worker.fetch(
    request('upload_and_terminal_write_retry_deployment_unavailable'),
    env
  );

  assert.equal(unreadableDeploymentRetry.status, 503, await unreadableDeploymentRetry.clone().text());
  assert.equal((await unreadableDeploymentRetry.json()).error.code, 'DEPLOYMENT_STATE_WRITE_FAILED');
  assert.equal(await store.getDeployment('dep_2'), null);
  assert.equal(uploadAttempts, 1);
  assert.equal((await snapshots.list({ prefix: 'production:deployment_failure_recovery:site_1:' })).keys.length, 1);

  const blockedRetry = await worker.fetch(request('upload_and_terminal_write_retry_still_unavailable'), env);

  assert.equal(blockedRetry.status, 503, await blockedRetry.clone().text());
  assert.equal((await blockedRetry.json()).error.code, 'DEPLOYMENT_STATE_WRITE_FAILED');
  assert.equal(await store.getDeployment('dep_2'), null);
  assert.equal(uploadAttempts, 1);
  assert.equal((await snapshots.list({ prefix: 'production:deployment_failure_recovery:site_1:' })).keys.length, 1);

  d1Unavailable = false;
  const retry = await worker.fetch(request('upload_and_terminal_write_retry_recovered'), env);

  assert.equal(retry.status, 201, await retry.clone().text());
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.equal((await store.getDeployment('dep_1')).errorCode, 'DEPLOYMENT_UPLOAD_FAILED');
  assert.equal((await store.getDeployment('dep_2')).status, 'succeeded');
  assert.equal(uploadAttempts, 2);
  assert.equal(failedStateWriteAttempts, 4);
  assert.equal(requests.length, 1);
  assert.equal((await snapshots.list({ prefix: 'production:deployment_failure_recovery:site_1:' })).keys.length, 0);
  assert.deepEqual(
    stateWriteLogs.map((entry) => entry.operation),
    ['persist_failed_deployment', 'recover_failed_deployment', 'persist_failed_deployment', 'recover_failed_deployment']
  );
  assert.equal(repairLogs.at(-1)?.reason, 'deployment_failure_state_recovery_deferred');
  assert.doesNotMatch(JSON.stringify(stateWriteLogs), /SQL|token|failed-terminal-secret|failed-event-secret/);
});

test('marks deployment failed when WFP verify fails without creating active version', async () => {
  const store = await createSeededStore();
  const deletedWorkers = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => {
        throw new Error('verify failed');
      },
      delete: async ({ workerName }) => deletedWorkers.push(workerName),
    },
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default {};' }),
      { 'Idempotency-Key': 'wfp_verify_fail' }
    ),
    env
  );

  assert.equal(response.status, 502);
  const body = await response.json();
  assert.equal(body.error.code, 'DEPLOYMENT_VERIFY_FAILED');
  assert.equal(body.error.action, 'Retry the deployment with a new Idempotency-Key.');
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.equal(await store.getSiteVersion('ver_1'), null);
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);
  assert.deepEqual(deletedWorkers, ['pages-v2-guide-ver-1']);
});

test('preserves the verify failure when uploaded worker cleanup also fails', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => {
        throw new WfpApiError({
          status: 404,
          code: 'WFP_API_ERROR',
          message: 'worker lookup failed',
          operation: 'worker_get',
          providerCode: 10007,
          providerMessage: 'Worker not found',
          providerRequestId: 'ray-verify-original',
        });
      },
      delete: async () => {
        throw new WfpApiError({
          status: 502,
          code: 'WFP_API_ERROR',
          message: 'worker delete failed',
          operation: 'worker_delete',
          providerCode: 10090,
          providerMessage: 'Delete rejected',
          providerRequestId: 'ray-cleanup-safe',
        });
      },
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'verify_and_cleanup_fail',
    }),
    env
  );

  assert.equal(response.status, 502, await response.clone().text());
  assert.equal((await response.json()).error.code, 'DEPLOYMENT_VERIFY_FAILED');
  const failedDeployment = await store.getDeployment('dep_1');
  assert.equal(failedDeployment.status, 'failed');
  assert.equal(failedDeployment.errorCode, 'DEPLOYMENT_VERIFY_FAILED');
  assert.equal(failedDeployment.failureStage, 'verify_worker');
  const cleanupEvent = (await store.listDeploymentEvents({ environment: 'production', deploymentId: 'dep_1' })).find(
    (event) => event.stage === 'cleanup_or_compensation' && event.operation === 'worker_delete'
  );
  assert.equal(cleanupEvent.status, 'failed');
  assert.deepEqual(cleanupEvent.diagnostics, {
    causeClass: 'provider_error',
    trafficImpact: 'old_version_retained',
    cleanupStatus: 'failed',
    originalFailure: {
      stage: 'provider_verify',
      code: 'DEPLOYMENT_VERIFY_FAILED',
    },
    compensation: {
      status: 'failed',
      operation: 'worker_delete',
      httpStatus: 502,
      clientCode: 'WFP_API_ERROR',
      providerCode: '10090',
      providerMessage: 'Delete rejected',
      providerRequestId: 'ray-cleanup-safe',
    },
  });
});

test('persists structured WFP provider diagnostics for verify failures', async () => {
  const store = await createSeededStore();
  const deletedWorkers = [];
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => {
        throw new WfpApiError({
          status: 404,
          code: 'WFP_API_ERROR',
          message: '10007 Worker lookup rejected',
          operation: 'worker_get',
          providerCode: 10007,
          providerMessage: 'Worker lookup rejected',
          providerRequestId: 'ray-verify-1',
        });
      },
      delete: async ({ workerName }) => deletedWorkers.push(workerName),
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'wfp_structured_verify_fail',
    }),
    env
  );

  assert.equal(response.status, 502);
  const failedDeployment = await store.getDeployment('dep_1');
  assert.equal(failedDeployment.failureStage, 'verify_worker');
  assert.deepEqual(failedDeployment.failureDiagnostics.provider, {
    name: 'cloudflare_wfp',
    operation: 'worker_get',
    httpStatus: 404,
    clientCode: 'WFP_API_ERROR',
    providerCode: '10007',
    providerMessage: 'Worker lookup rejected',
    providerRequestId: 'ray-verify-1',
  });
  assert.deepEqual(deletedWorkers, ['pages-v2-guide-ver-1']);

  const polled = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/deployments/dep_1'), env);
  const polledBody = await polled.json();
  assert.equal('failureDiagnostics' in polledBody.deployment, false);
});

test('cleans uploaded workers and marks deployments failed when post-upload persistence fails', async () => {
  const store = await createSeededStore();
  store.createSiteVersion = async () => {
    const error = new Error('SQL SELECT secret=password FROM deployments');
    error.code = 'D1_ERROR';
    error.stack = 'Bearer must-not-be-logged';
    throw error;
  };
  const deletedWorkers = [];
  const stateWriteLogs = [];
  const env = testEnv(store, createSnapshotStore(), {
    logDeploymentStateWriteFailed: (line) => stateWriteLogs.push(JSON.parse(line)),
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => ({ ok: true }),
      delete: async ({ workerName }) => deletedWorkers.push(workerName),
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'persist_fail',
    }),
    env
  );

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error.code, 'DEPLOYMENT_STATE_WRITE_FAILED');
  assert.equal(body.error.action, 'Retry the deployment with a new Idempotency-Key.');
  const failedDeployment = await store.getDeployment('dep_1');
  assert.equal(failedDeployment.status, 'failed');
  assert.equal(failedDeployment.errorCode, 'DEPLOYMENT_STATE_WRITE_FAILED');
  assert.deepEqual(failedDeployment.failureDiagnostics.cause, {
    code: 'DEPLOYMENT_STATE_WRITE_FAILED',
    class: 'deployment_store_error',
  });
  assert.equal(stateWriteLogs.length, 1);
  assert.deepEqual(stateWriteLogs[0], {
    event: 'pages_deployment_state_write_failed',
    traceId: 'dtr_1',
    deploymentId: 'dep_1',
    stage: 'deployment_state_persist',
    operation: 'persist_activation_state',
    causeClass: 'deployment_store_error',
  });
  assert.doesNotMatch(JSON.stringify(stateWriteLogs), /SQL|password|Bearer|must-not-be-logged/);
  assert.equal(await store.getSiteVersion('ver_1'), null);
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);
  assert.deepEqual(deletedWorkers, ['pages-v2-guide-ver-1']);
});

test('marks deployment failed when pre-upload status write fails without uploading', async () => {
  const store = await createSeededStore();
  const originalUpdateDeployment = store.updateDeployment.bind(store);
  let failNextUploadingWrite = true;
  store.updateDeployment = async (id, patch) => {
    if (patch.status === 'uploading' && failNextUploadingWrite) {
      failNextUploadingWrite = false;
      throw new Error('SQL token=must-not-be-logged');
    }
    return originalUpdateDeployment(id, patch);
  };
  const uploadedWorkers = [];
  const stateWriteLogs = [];
  const env = testEnv(store, createSnapshotStore(), {
    logDeploymentStateWriteFailed: (line) => stateWriteLogs.push(JSON.parse(line)),
    WFP_PROVIDER: {
      upload: async ({ workerName }) => {
        uploadedWorkers.push(workerName);
        return { artifactRef: `wfp://test/${workerName}` };
      },
      verify: async () => ({ ok: true }),
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'pre_upload_state_fail',
    }),
    env
  );

  assert.equal(response.status, 503);
  assert.equal((await response.json()).error.code, 'DEPLOYMENT_STATE_WRITE_FAILED');
  assert.deepEqual(uploadedWorkers, []);
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.equal((await store.getDeployment('dep_1')).errorCode, 'DEPLOYMENT_STATE_WRITE_FAILED');
  assert.deepEqual((await store.getDeployment('dep_1')).failureDiagnostics.cause, {
    code: 'DEPLOYMENT_STATE_WRITE_FAILED',
    class: 'deployment_store_error',
  });
  assert.deepEqual(stateWriteLogs, [
    {
      event: 'pages_deployment_state_write_failed',
      traceId: 'dtr_1',
      deploymentId: 'dep_1',
      stage: 'deployment_state_persist',
      operation: 'persist_uploading_deployment',
      causeClass: 'deployment_store_error',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(stateWriteLogs), /SQL|token|must-not-be-logged/);
  assert.equal(await store.getSiteVersion('ver_1'), null);
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);
});

test('records the exact intermediate deployment state write that failed', async (t) => {
  for (const [status, operation] of [
    ['verified', 'persist_verified_deployment'],
    ['activating', 'persist_activating_deployment'],
  ]) {
    await t.test(status, async () => {
      const store = await createSeededStore();
      const originalUpdateDeployment = store.updateDeployment.bind(store);
      let failNextWrite = true;
      store.updateDeployment = async (id, patch) => {
        if (patch.status === status && failNextWrite) {
          failNextWrite = false;
          throw new Error('sensitive SQL should not escape');
        }
        return originalUpdateDeployment(id, patch);
      };

      const response = await worker.fetch(
        deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
          'Idempotency-Key': `state_${status}_fail`,
        }),
        testEnv(store, createSnapshotStore())
      );

      assert.equal(response.status, 503, await response.clone().text());
      assert.equal((await response.json()).error.code, 'DEPLOYMENT_STATE_WRITE_FAILED');
      const event = (await store.listDeploymentEvents({ environment: 'production', deploymentId: 'dep_1' })).find(
        (candidate) =>
          candidate.stage === 'deployment_state_persist' && candidate.operation === operation && candidate.status === 'failed'
      );
      assert.equal(event.diagnostics.causeClass, 'deployment_store_error');
      assert.doesNotMatch(JSON.stringify(event), /sensitive SQL should not escape/);
    });
  }
});

test('reconciles deployment success when final status write fails after route commit', async () => {
  const store = await createSeededStore();
  const originalUpdateDeployment = store.updateDeployment.bind(store);
  let failNextSucceededWrite = true;
  store.updateDeployment = async (id, patch) => {
    if (patch.status === 'succeeded' && failNextSucceededWrite) {
      failNextSucceededWrite = false;
      throw new Error('SQL password=must-not-be-logged');
    }
    return originalUpdateDeployment(id, patch);
  };
  const stateWriteLogs = [];
  const env = testEnv(store, createSnapshotStore(), {
    logDeploymentStateWriteFailed: (line) => stateWriteLogs.push(JSON.parse(line)),
  });
  const request = deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
    'Idempotency-Key': 'final_state_fail',
  });

  const response = await worker.fetch(request, env);
  const body = await response.json();
  const statusBeforePoll = await store.getDeployment('dep_1');
  const polled = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/deployments/dep_1'), env);
  const pollBody = await polled.json();

  assert.equal(response.status, 201);
  assert.equal(body.deployment.status, 'succeeded');
  assert.equal(body.deployment.versionId, 'ver_1');
  assert.equal(statusBeforePoll.status, 'activating');
  assert.deepEqual(stateWriteLogs, [
    {
      event: 'pages_deployment_state_write_failed',
      traceId: 'dtr_1',
      deploymentId: 'dep_1',
      stage: 'deployment_state_persist',
      operation: 'persist_succeeded_deployment',
      causeClass: 'deployment_store_error',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(stateWriteLogs), /SQL|password|must-not-be-logged/);
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_1');
  assert.equal(polled.status, 200);
  assert.equal(pollBody.deployment.status, 'succeeded');
  assert.equal((await store.getDeployment('dep_1')).status, 'succeeded');
  const events = await store.listDeploymentEvents({ environment: 'production', deploymentId: 'dep_1' });
  assert.equal(
    events.some(
      (event) =>
        event.stage === 'deployment_state_persist' &&
        event.operation === 'persist_succeeded_deployment' &&
        event.status === 'failed'
    ),
    true
  );
  assert.equal(
    events.some(
      (event) =>
        event.stage === 'deployment_state_persist' &&
        event.operation === 'reconcile_committed_deployment' &&
        event.status === 'compensated'
    ),
    true
  );
});

test('preserves previousVersionId when a redeploy success is reconciled after its final state write fails', async () => {
  const store = await createSeededStore();
  const originalUpdateDeployment = store.updateDeployment.bind(store);
  let failNextSucceededWrite = false;
  store.updateDeployment = async (id, patch) => {
    if (patch.status === 'succeeded' && failNextSucceededWrite) {
      failNextSucceededWrite = false;
      throw new Error('final deployment state unavailable');
    }
    return originalUpdateDeployment(id, patch);
  };
  const env = testEnv(store, createSnapshotStore());
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'reconcile_previous_first',
      }),
      env
    )
  );
  failNextSucceededWrite = true;

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
      { 'Idempotency-Key': 'reconcile_previous_second' }
    ),
    env
  );
  const beforePoll = await store.getDeployment('dep_2');
  const polled = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/deployments/dep_2'), env);

  assert.equal(response.status, 201, await response.clone().text());
  assert.equal((await response.json()).deployment.previousVersionId, 'ver_1');
  assert.equal(beforePoll.status, 'activating');
  assert.equal(beforePoll.previousVersionId, 'ver_1');
  assert.equal(polled.status, 200, await polled.clone().text());
  assert.equal((await polled.json()).deployment.previousVersionId, 'ver_1');
  assert.equal((await store.getDeployment('dep_2')).previousVersionId, 'ver_1');
});

test('reconciles rollback success when final status write fails after route commit', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());
  await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'deploy_1' }),
    env
  );
  await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("def"); } };' }),
      { 'Idempotency-Key': 'deploy_2' }
    ),
    env
  );
  const originalUpdateDeployment = store.updateDeployment.bind(store);
  let failNextRollbackSucceededWrite = true;
  store.updateDeployment = async (id, patch) => {
    if (id === 'dep_3' && patch.status === 'succeeded' && failNextRollbackSucceededWrite) {
      failNextRollbackSucceededWrite = false;
      throw new Error('SQL secret=must-not-be-logged');
    }
    return originalUpdateDeployment(id, patch);
  };
  const stateWriteLogs = [];
  env.logDeploymentStateWriteFailed = (line) => stateWriteLogs.push(JSON.parse(line));

  const rollback = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback', {}, { 'Idempotency-Key': 'rb_final_fail' }),
    env
  );
  const body = await rollback.json();
  const statusBeforePoll = await store.getDeployment('dep_3');
  const polled = await worker.fetch(authRequest('https://api.pages.xd.team/.xd-pages/api/deployments/dep_3'), env);

  assert.equal(rollback.status, 201);
  assert.equal(body.deployment.status, 'succeeded');
  assert.equal(body.deployment.versionId, 'ver_1');
  assert.equal(statusBeforePoll.status, 'pending');
  assert.deepEqual(stateWriteLogs, [
    {
      event: 'pages_deployment_state_write_failed',
      traceId: 'dtr_3',
      deploymentId: 'dep_3',
      stage: 'deployment_state_persist',
      operation: 'persist_succeeded_deployment',
      causeClass: 'deployment_store_error',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(stateWriteLogs), /SQL|secret|must-not-be-logged/);
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_1');
  assert.equal((await polled.json()).deployment.status, 'succeeded');
  assert.equal((await store.getDeployment('dep_3')).status, 'succeeded');
  assert.equal(
    (await store.listDeploymentEvents({ environment: 'production', deploymentId: 'dep_3' })).some(
      (event) =>
        event.stage === 'deployment_state_persist' &&
        event.operation === 'reconcile_committed_deployment' &&
        event.status === 'compensated'
    ),
    true
  );
});

test('fails deployment activation without clobbering a concurrently changed route', async () => {
  const store = await createSeededStore();
  const originalActivate = store.activateSiteVersion.bind(store);
  let injectedConcurrentActivation = false;
  store.activateSiteVersion = async (siteId, patch, environment, expectedRoute) => {
    if (!injectedConcurrentActivation) {
      injectedConcurrentActivation = true;
      await originalActivate(
        siteId,
        {
          activeVersionId: 'ver_concurrent',
          workerName: 'pages-v2-guide-concurrent',
          runtime: 'worker',
          executionProvider: 'wfp',
          dispatchType: 'dispatch-namespace',
          visibility: 'org',
          updatedAt: '2026-06-15T00:00:30.000Z',
        },
        environment
      );
    }
    return originalActivate(siteId, patch, environment, expectedRoute);
  };
  const snapshots = createSnapshotStore();
  const deletedWorkers = [];
  const env = testEnv(store, snapshots, {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => ({ ok: true }),
      delete: async ({ workerName }) => deletedWorkers.push(workerName),
    },
  });

  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'activation_race',
    }),
    env
  );

  assert.equal(response.status, 409);
  assert.equal((await response.json()).error.code, 'ROUTE_ACTIVATION_CONFLICT');
  const failedDeployment = await store.getDeployment('dep_1');
  assert.equal(failedDeployment.status, 'failed');
  assert.equal(failedDeployment.errorCode, 'ROUTE_ACTIVATION_CONFLICT');
  assert.equal(failedDeployment.failureStage, 'activate_route');
  assert.equal(failedDeployment.failureDiagnostics.stage, 'activate_route');
  assert.equal(failedDeployment.failureDiagnostics.routeActivatedInD1, false);
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_concurrent');
  assert.equal(snapshots.read('production:route_pointer:guide.pages.xd.team'), undefined);
  assert.deepEqual(deletedWorkers, ['pages-v2-guide-ver-1']);
});

test('fails deployment when production WFP namespace points at staging', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore(), {
    WFP_PROVIDER: undefined,
    CF_ACCOUNT_ID: 'account_1',
    CF_API_TOKEN: 'cf_secret_token',
    WFP_DISPATCH_NAMESPACE: 'xd-cell-workers-staging',
  });

  const response = await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default {};' }),
      { 'Idempotency-Key': 'wfp_config_fail' }
    ),
    env
  );

  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error.code, 'DEPLOYMENT_PLATFORM_CONFIG_INVALID');
  assert.equal(body.error.action, 'Check the Pages deployment platform configuration and retry with a new Idempotency-Key.');
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);
  const events = await store.listDeploymentEvents({ environment: 'production', deploymentId: 'dep_1' });
  assert.equal(
    events.some(
      (event) =>
        event.stage === 'provider_upload' &&
        event.operation === 'create_deployment_provider' &&
        event.status === 'failed' &&
        event.errorCode === 'DEPLOYMENT_PLATFORM_CONFIG_INVALID' &&
        event.diagnostics?.causeClass === 'provider_config_error'
    ),
    true,
    JSON.stringify(events)
  );
});

test('keeps previous active route when rollback snapshot write fails', async () => {
  const store = await createSeededStore();
  const requests = [];
  await seedLifecycleWebhook(store, 'site.failed');
  const env = testEnv(store, createSnapshotStore(), {
    WEBHOOK_URL_ENCRYPTION_KEY: TEST_WEBHOOK_URL_ENCRYPTION_KEY,
    resolveWebhookHost: async () => ['8.8.8.8'],
    WEBHOOK_FETCH: async (request) => {
      requests.push(request);
      return new Response('ok', { status: 200 });
    },
  });

  await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), { 'Idempotency-Key': 'deploy_1' }),
    env
  );
  await worker.fetch(
    deploymentRequest(
      'https://api.pages.xd.team/.xd-pages/api/deployments',
      deployPayload({ moduleContent: 'export default { fetch() { return new Response("def"); } };' }),
      { 'Idempotency-Key': 'deploy_2' }
    ),
    env
  );

  env.ROUTE_SNAPSHOTS = failingSnapshotStore();
  const rollback = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback', {}, { 'Idempotency-Key': 'rb_fail' }),
    env
  );
  const route = await store.getRouteBySiteId('site_1');

  assert.equal(rollback.status, 503);
  const body = await rollback.json();
  assert.equal(body.error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.equal(body.error.action, 'Retry the rollback with a new Idempotency-Key.');
  const failedDeployment = await store.getDeployment('dep_3');
  assert.equal(failedDeployment.status, 'failed');
  assert.equal(failedDeployment.failureStage, 'rollback_write_route_snapshot');
  assert.equal(failedDeployment.failureDiagnostics.stage, 'rollback_write_route_snapshot');
  assert.equal(failedDeployment.failureDiagnostics.routeActivatedInD1, true);
  assert.equal(failedDeployment.failureDiagnostics.previousRouteRestored, true);
  assert.equal(route.activeVersionId, 'ver_2');
  assert.equal(route.workerName, 'pages-v2-guide-ver-2');
  assert.equal(route.routeGeneration, 4);
  assert.equal(route.routeStatus, 'active');
  assert.equal(requests.length, 1);
  const payload = await requests[0].json();
  assert.equal(payload.event.type, 'site.failed');
  assert.equal(payload.deployment.operation, 'rollback');
});

test('public rollback snapshot failure re-verifies the restored active Worker OfficeNet state', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots);

  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'public_restore_office_net_deploy_1',
      }),
      env
    )
  );
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
        { 'Idempotency-Key': 'public_restore_office_net_deploy_2' }
      ),
      env
    )
  );

  const lease = await store.acquireSiteCommitLock('production', 'site_1', { lockId: 'public_restore_office_net_policy' });
  const currentRoute = await store.getRouteBySiteId('site_1', 'production');
  await store.updateSiteAccessPolicy({
    environment: 'production',
    siteId: 'site_1',
    exposure: 'public',
    expected: {
      policyVersion: currentRoute.policyVersion,
      routeGeneration: currentRoute.routeGeneration,
      activeVersionId: currentRoute.activeVersionId,
      runtimeConfigGeneration: currentRoute.runtimeConfigGeneration,
    },
    lease,
  });
  await store.releaseSiteCommitLock('production', 'site_1', lease.lockId);
  await writeCurrentRouteSnapshot(store, snapshots);

  const events = [];
  env.WFP_PROVIDER = {
    removeOfficeNetBinding: async ({ workerName }) => events.push(['remove', workerName]),
    verifyOfficeNetAbsent: async ({ workerName }) => {
      events.push(['verify', workerName]);
      return true;
    },
  };
  env.ROUTE_SNAPSHOTS = failingSnapshotStore();

  const rollback = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      { 'Idempotency-Key': 'public_restore_office_net_rb' }
    ),
    env
  );

  assert.equal(rollback.status, 503, await rollback.clone().text());
  assert.equal((await rollback.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.deepEqual(events, [
    ['remove', 'pages-v2-guide-ver-1'],
    ['verify', 'pages-v2-guide-ver-1'],
    ['remove', 'pages-v2-guide-ver-2'],
    ['verify', 'pages-v2-guide-ver-2'],
    ['remove', 'pages-v2-guide-ver-2'],
    ['verify', 'pages-v2-guide-ver-2'],
  ]);
  assert.equal((await store.getRouteBySiteId('site_1', 'production')).activeVersionId, 'ver_2');
});

test('public rollback snapshot failure disables the restored route when OfficeNet cannot be verified', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots);

  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'public_restore_office_net_unsafe_deploy_1',
      }),
      env
    )
  );
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
        { 'Idempotency-Key': 'public_restore_office_net_unsafe_deploy_2' }
      ),
      env
    )
  );

  const lease = await store.acquireSiteCommitLock('production', 'site_1', { lockId: 'public_restore_office_net_unsafe_policy' });
  const currentRoute = await store.getRouteBySiteId('site_1', 'production');
  await store.updateSiteAccessPolicy({
    environment: 'production',
    siteId: 'site_1',
    exposure: 'public',
    expected: {
      policyVersion: currentRoute.policyVersion,
      routeGeneration: currentRoute.routeGeneration,
      activeVersionId: currentRoute.activeVersionId,
      runtimeConfigGeneration: currentRoute.runtimeConfigGeneration,
    },
    lease,
  });
  await store.releaseSiteCommitLock('production', 'site_1', lease.lockId);
  await writeCurrentRouteSnapshot(store, snapshots);

  const events = [];
  env.WFP_PROVIDER = {
    removeOfficeNetBinding: async ({ workerName }) => events.push(['remove', workerName]),
    verifyOfficeNetAbsent: async ({ workerName }) => {
      events.push(['verify', workerName]);
      return workerName !== 'pages-v2-guide-ver-2' || events.filter(([kind]) => kind === 'verify').length < 3;
    },
  };
  env.ROUTE_SNAPSHOTS = failFirstSnapshotPutAfter(snapshots, async () => {});

  const rollback = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      { 'Idempotency-Key': 'public_restore_office_net_unsafe_rb' }
    ),
    env
  );

  assert.equal(rollback.status, 503, await rollback.clone().text());
  assert.equal((await rollback.json()).error.code, 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED');
  const route = await store.getRouteBySiteId('site_1', 'production');
  assert.equal(route.activeVersionId, 'ver_2');
  assert.equal(route.exposure, 'internal');
  assert.equal(route.visibility, 'disabled');
  const pointer = snapshots.read('production:route_pointer:guide.pages.xd.team');
  const snapshot = snapshots.read(pointer.snapshotKey);
  assert.equal(snapshot.exposure, 'internal');
  assert.equal(snapshot.accessMode, 'disabled');
  assert.equal(snapshot.visibility, 'disabled');
});

test('public rollback records repair-required when the safe disabled snapshot cannot be written', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots);

  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'public_safe_snapshot_failed_deploy_1',
      }),
      env
    )
  );
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
        { 'Idempotency-Key': 'public_safe_snapshot_failed_deploy_2' }
      ),
      env
    )
  );

  const lease = await store.acquireSiteCommitLock('production', 'site_1', { lockId: 'public_safe_snapshot_failed_policy' });
  const currentRoute = await store.getRouteBySiteId('site_1', 'production');
  await store.updateSiteAccessPolicy({
    environment: 'production',
    siteId: 'site_1',
    exposure: 'public',
    expected: {
      policyVersion: currentRoute.policyVersion,
      routeGeneration: currentRoute.routeGeneration,
      activeVersionId: currentRoute.activeVersionId,
      runtimeConfigGeneration: currentRoute.runtimeConfigGeneration,
    },
    lease,
  });
  await store.releaseSiteCommitLock('production', 'site_1', lease.lockId);
  await writeCurrentRouteSnapshot(store, snapshots);

  let restoredVerifyCount = 0;
  const alerts = [];
  env.WFP_PROVIDER = {
    removeOfficeNetBinding: async () => ({ removed: true }),
    verifyOfficeNetAbsent: async ({ workerName }) => {
      if (workerName === 'pages-v2-guide-ver-2') restoredVerifyCount += 1;
      return workerName !== 'pages-v2-guide-ver-2' || restoredVerifyCount < 2;
    },
  };
  env.logDeploymentRepairRequired = (line) => alerts.push(JSON.parse(line));
  env.ROUTE_SNAPSHOTS = alwaysFailSnapshotStore(snapshots);

  const rollback = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      {
        'Idempotency-Key': 'public_safe_snapshot_failed_rb',
      }
    ),
    env
  );

  assert.equal(rollback.status, 503, await rollback.clone().text());
  assert.equal((await rollback.json()).error.code, 'SITE_PUBLIC_OFFICE_NET_VERIFY_FAILED');
  const failed = await store.getDeployment('dep_3', 'production');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureDiagnostics.operatorAction, 'repair_route_snapshot');
  assert.equal(failed.failureDiagnostics.routePointerCleared, true);
  assert.equal(failed.failureDiagnostics.trafficImpact, 'site_unavailable');
  assert.equal(snapshots.read('production:route_pointer:guide.pages.xd.team'), undefined);
  assert.deepEqual(alerts, [
    {
      event: 'pages_deployment_repair_required',
      environment: 'production',
      siteId: 'site_1',
      deploymentId: 'dep_3',
      reason: 'route_snapshot_repair_failed',
    },
  ]);
});

test('rollback restore failure records repair-required and still releases its lease', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const alerts = [];
  const env = testEnv(store, snapshots, {
    logDeploymentRepairRequired: (line) => alerts.push(JSON.parse(line)),
  });
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'rollback_restore_failure_deploy_1',
      }),
      env
    )
  );
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ moduleContent: 'export default { fetch() { return new Response("v2"); } };' }),
        { 'Idempotency-Key': 'rollback_restore_failure_deploy_2' }
      ),
      env
    )
  );
  store.restoreSiteRouteIfCurrent = async () => {
    throw new Error('restore failed');
  };
  env.ROUTE_SNAPSHOTS = alwaysFailSnapshotStore(snapshots);

  const rollback = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      {
        'Idempotency-Key': 'rollback_restore_failure',
      }
    ),
    env
  );

  assert.equal(rollback.status, 503, await rollback.clone().text());
  assert.equal((await rollback.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  const failed = await store.getDeployment('dep_3', 'production');
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failureDiagnostics.operatorAction, 'repair_route_snapshot');
  assert.deepEqual(alerts, [
    {
      event: 'pages_deployment_repair_required',
      environment: 'production',
      siteId: 'site_1',
      deploymentId: 'dep_3',
      reason: 'route_snapshot_repair_failed',
    },
  ]);
  assert.ok(await store.acquireSiteCommitLock('production', 'site_1', { lockId: 'rollback_restore_failure_retry' }));
});

test('rollback snapshot failure restores previous route snapshot after a concurrent policy pointer advance', async () => {
  const store = await createSeededStore();
  const snapshots = createSnapshotStore();
  const env = testEnv(store, snapshots);

  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'rollback_pointer_deploy_1',
      }),
      env
    )
  );
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ moduleContent: 'export default { fetch() { return new Response("def"); } };' }),
        { 'Idempotency-Key': 'rollback_pointer_deploy_2' }
      ),
      env
    )
  );
  const previousRoute = await store.getRouteBySiteId('site_1', 'production');

  env.ROUTE_SNAPSHOTS = failFirstSnapshotPutAfter(snapshots, async () => {
    await store.updateSiteVisibility('site_1', { visibility: 'owner', updatedAt: '2026-06-15T00:00:03.000Z' }, 'production');
    await writeCurrentRouteSnapshot(store, snapshots);
  });

  const rollback = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback', {}, { 'Idempotency-Key': 'rb_pointer_fail' }),
    env
  );
  const route = await store.getRouteBySiteId('site_1', 'production');
  const pointer = snapshots.read('production:route_pointer:guide.pages.xd.team');
  const snapshot = snapshots.read(pointer.snapshotKey);

  assert.equal(rollback.status, 503, await rollback.clone().text());
  assert.equal((await rollback.json()).error.code, 'ROUTE_SNAPSHOT_WRITE_FAILED');
  assert.equal(route.activeVersionId, previousRoute.activeVersionId);
  assert.equal(route.workerName, previousRoute.workerName);
  assert.equal(route.routeGeneration, previousRoute.routeGeneration + 2);
  assert.equal(route.visibility, 'owner');
  assert.equal(route.policyVersion, previousRoute.policyVersion + 1);
  assert.equal(pointer.routeGeneration, route.routeGeneration);
  assert.equal(pointer.policyVersion, route.policyVersion);
  assert.equal(snapshot.activeVersionId, previousRoute.activeVersionId);
  assert.equal(snapshot.workerName, previousRoute.workerName);
  assert.equal(snapshot.visibility, 'owner');
  assert.equal((await store.getDeployment('dep_3')).status, 'failed');
});

test('rejects rollback to a version from a failed deployment', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, failingSnapshotStore(), {
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => ({ ok: true }),
      delete: async () => null,
    },
  });

  const failedDeploy = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'failed_version',
    }),
    env
  );
  const rollback = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      {},
      {
        'Idempotency-Key': 'rb_failed_version',
      }
    ),
    env
  );

  assert.equal(failedDeploy.status, 503);
  assert.equal((await store.getDeployment('dep_1')).status, 'failed');
  assert.equal((await store.getSiteVersion('ver_1')).deploymentId, 'dep_1');
  assert.equal(rollback.status, 409);
  assert.equal((await rollback.json()).error.code, 'ROLLBACK_VERSION_UNAVAILABLE');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, null);
});

test('rejects rollback to a retired WFP version after artifact GC', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());

  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'retired_wfp_deploy_1',
      }),
      env
    )
  );
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ moduleContent: 'export default { fetch() { return new Response("def"); } };' }),
        { 'Idempotency-Key': 'retired_wfp_deploy_2' }
      ),
      env
    )
  );
  await store.markSiteVersionArtifactAvailability({
    id: 'ver_1',
    environment: 'production',
    artifactAvailability: 'retired',
  });

  const rollback = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback', {}, { 'Idempotency-Key': 'rb_retired_wfp' }),
    env
  );

  assert.equal(rollback.status, 409);
  assert.equal((await rollback.json()).error.code, 'ROLLBACK_VERSION_UNAVAILABLE');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_2');
});

test('rejects rollback when cleanup marks the target WFP version retiring before activation', async () => {
  const store = await createSeededStore();
  const env = testEnv(store, createSnapshotStore());

  await assertDeployOk(
    await worker.fetch(
      deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
        'Idempotency-Key': 'retiring_wfp_deploy_1',
      }),
      env
    )
  );
  await assertDeployOk(
    await worker.fetch(
      deploymentRequest(
        'https://api.pages.xd.team/.xd-pages/api/deployments',
        deployPayload({ moduleContent: 'export default { fetch() { return new Response("def"); } };' }),
        { 'Idempotency-Key': 'retiring_wfp_deploy_2' }
      ),
      env
    )
  );

  const originalActivate = store.activateSiteVersion.bind(store);
  store.activateSiteVersion = async (siteId, patch, environment, expectedRoute) => {
    if (patch.activeVersionId === 'ver_1') {
      await store.markSiteVersionArtifactAvailability({
        id: 'ver_1',
        environment: 'production',
        artifactAvailability: 'retiring',
      });
    }
    return originalActivate(siteId, patch, environment, expectedRoute);
  };

  const rollback = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback', {}, { 'Idempotency-Key': 'rb_retiring_wfp' }),
    env
  );

  assert.equal(rollback.status, 409);
  assert.equal((await rollback.json()).error.code, 'ROLLBACK_VERSION_UNAVAILABLE');
  assert.equal((await store.getRouteBySiteId('site_1')).activeVersionId, 'ver_2');
});

test('rejects rollback to a released normal worker slot version', async () => {
  const store = await createSeededStore();
  await store.createWorkerSlot({
    id: 'slot_007',
    environment: 'production',
    slotNumber: 7,
    workerName: 'pages-v2-production-slot-007',
    bindingName: 'SITE_SLOT_007',
    status: 'available',
  });
  const env = testEnv(store, failingSnapshotStore(), {
    PAGES_EXECUTION_MODE: 'normal-worker-slot',
    NORMAL_WORKER_SLOT_PROVIDER: {
      upload: async () => null,
      verify: async () => ({ ok: true }),
      cleanupRetainedSlot: async () => null,
    },
  });

  const failedDeploy = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'failed_slot_version',
    }),
    env
  );
  const rollback = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback', {}, { 'Idempotency-Key': 'rb_released_slot' }),
    env
  );

  assert.equal(failedDeploy.status, 503);
  assert.equal((await store.getWorkerSlot('slot_007')).status, 'assigned');
  assert.equal(rollback.status, 409);
  assert.equal((await rollback.json()).error.code, 'ROLLBACK_VERSION_UNAVAILABLE');
});

test('requires idempotency key for deploy and rollback', async () => {
  const store = await createSeededStore();
  const deploy = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/deployments', {
      ...deployPayload(),
    }),
    testEnv(store, createSnapshotStore())
  );
  const rollback = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback', {}),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(deploy.status, 400);
  assert.equal((await deploy.json()).error.code, 'IDEMPOTENCY_KEY_REQUIRED');
  assert.equal(rollback.status, 400);
  assert.equal((await rollback.json()).error.code, 'IDEMPOTENCY_KEY_REQUIRED');
});

test('regular deployment rejects explicit exposure changes before creating a deployment', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload({ exposure: 'public' }), {
      'Idempotency-Key': 'deploy_explicit_exposure',
    }),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 403, await response.clone().text());
  assert.equal((await response.json()).error.code, 'SITE_EXPOSURE_ADMIN_REQUIRED');
  assert.equal(await store.getDeployment('dep_1', 'production'), null);
  assert.equal((await store.getRouteBySiteId('site_1', 'production')).activeVersionId, null);
});

test('regular rollback rejects explicit exposure changes before creating a deployment', async () => {
  const store = await createSeededStore();
  const response = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/api/versions/ver_1/rollback',
      { exposure: 'public' },
      { 'Idempotency-Key': 'rollback_explicit_exposure' }
    ),
    testEnv(store, createSnapshotStore())
  );

  assert.equal(response.status, 403, await response.clone().text());
  assert.equal((await response.json()).error.code, 'SITE_EXPOSURE_ADMIN_REQUIRED');
  assert.equal(await store.getDeployment('dep_1', 'production'), null);
  assert.equal((await store.getRouteBySiteId('site_1', 'production')).activeVersionId, null);
});

async function createSeededStore(options = {}) {
  const store = createTestPagesStore({
    now: () => '2026-06-15T00:00:00.000Z',
    ...options,
  });
  await store.createUser({
    userId: 'usr_1',
    email: 'user@example.com',
    realname: 'User One',
    employeeStatus: 'active',
  });
  await seedCliLoginKey(store, 'usr_1', BEARER_USR_1);
  await store.createSite({
    id: 'site_1',
    slug: 'guide',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.pages.xd.team',
  });
  return store;
}

function testEnv(store, snapshots, overrides = {}) {
  const counters = new Map();
  return {
    PAGES_ENV: 'production',
    PAGES_STORE: store,
    ROUTE_SNAPSHOTS: snapshots,
    IP_ALLOWLIST: '10.0.0.0/8',
    ACCESS_KEY_PEPPERS: 'pepper_1:ACCESS_KEY_PEPPER_TEST',
    ACCESS_KEY_PEPPER_TEST: 'pepper-secret',
    now: () => '2026-06-15T00:00:00.000Z',
    nextId: (prefix) => {
      const next = (counters.get(prefix) || 0) + 1;
      counters.set(prefix, next);
      return `${prefix}_${next}`;
    },
    WFP_PROVIDER: {
      upload: async ({ workerName }) => ({ artifactRef: `wfp://test/${workerName}` }),
      verify: async () => ({ ok: true }),
    },
    ...overrides,
  };
}

function timelineTestEnv(store, snapshots, overrides = {}) {
  let nowMs = Date.parse('2026-06-15T00:00:00.000Z');
  return testEnv(store, snapshots, {
    now: () => new Date(nowMs++).toISOString(),
    ...overrides,
  });
}

function assertNoPublicExecutionDetails(body) {
  const serialized = JSON.stringify(body);
  assert.equal('workerName' in (body.version || {}), false);
  assert.equal('workerName' in (body.route || {}), false);
  assert.equal('executionProvider' in (body.version || {}), false);
  assert.equal('executionProvider' in (body.route || {}), false);
  assert.equal('dispatchBindingName' in (body.route || {}), false);
  assert.equal('artifactKind' in (body.version || {}), false);
  assert.equal('artifactKind' in body, false);
  assert.doesNotMatch(serialized, /pages-v2-(?:production|staging)-slot-\d+/);
  assert.doesNotMatch(serialized, /SITE_SLOT_\d+/);
  assert.doesNotMatch(serialized, /normal-worker-slot|executionProvider|dispatchBindingName|artifactKind/);
}

async function assertDeployOk(response) {
  assert.equal(response.status, 201, await response.clone().text());
  return response;
}

async function seedAccessKey(store, keyId, scopes, siteId = 'site_1', options = {}) {
  const plaintext = createAccessKeyPlaintext({
    environment: 'production',
    keyId,
    bytes: new Uint8Array(24).fill(keyId === 'ak_deploy' ? 3 : 4),
  });
  const ownerType = options.ownerType || 'user';
  const ownerUserId = options.ownerUserId || 'usr_1';
  await store.createAccessKey({
    id: keyId,
    environment: 'production',
    ownerType,
    ownerId: options.ownerId || (ownerType === 'user' ? ownerUserId : undefined),
    ownerUserId,
    createdByUserId: options.createdByUserId || ownerUserId,
    keyHash: await hashAccessKey(plaintext, 'pepper-secret'),
    pepperId: 'pepper_1',
    name: keyId,
    scopes,
    siteId,
    expiresAt: '2026-07-15T00:00:00.000Z',
  });
  return plaintext;
}

function createSnapshotStore() {
  const values = new Map();
  return {
    put: async (key, value) => values.set(key, JSON.parse(value)),
    get: async (key) => (values.has(key) ? JSON.stringify(values.get(key)) : null),
    delete: async (key) => values.delete(key),
    list: async ({ prefix = '' } = {}) => ({
      keys: [...values.keys()].filter((key) => key.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
    read: (key) => values.get(key),
  };
}

function createRoutePointerLocks(routeSnapshots) {
  const instances = new Map();
  return {
    idFromName: (name) => name,
    get: (id) => {
      if (!instances.has(id)) {
        const records = new Map();
        const state = {
          storage: {
            get: async (key) => records.get(key),
            put: async (key, value) => records.set(key, value),
            delete: async (key) => records.delete(key),
            list: async ({ prefix = '' } = {}) =>
              new Map([...records].filter(([key]) => typeof key === 'string' && key.startsWith(prefix))),
          },
        };
        instances.set(id, new RoutePointerDO(state, { ROUTE_SNAPSHOTS: routeSnapshots }));
      }
      return { fetch: (request) => instances.get(id).fetch(request) };
    },
  };
}

function stalePointerSnapshotStore(snapshots) {
  const pointerKey = 'production:route_pointer:guide.pages.xd.team';
  const cachedPointer = snapshots.read(pointerKey);
  return {
    put: snapshots.put,
    get: async (key) => (key === pointerKey ? JSON.stringify(cachedPointer) : snapshots.get(key)),
    delete: snapshots.delete,
    read: snapshots.read,
  };
}

function negativePointerSnapshotStore(snapshots) {
  const pointerKey = 'production:route_pointer:guide.pages.xd.team';
  return {
    put: snapshots.put,
    get: async (key) => (key === pointerKey ? null : snapshots.get(key)),
    delete: snapshots.delete,
    read: snapshots.read,
  };
}

function failFirstSnapshotPutAfter(snapshots, inject) {
  let injected = false;
  return {
    get: snapshots.get,
    read: snapshots.read,
    delete: snapshots.delete,
    put: async (key, value) => {
      if (!injected) {
        injected = true;
        await inject();
        throw new Error('snapshot write failed');
      }
      return snapshots.put(key, value);
    },
  };
}

async function writeCurrentRouteSnapshot(store, snapshots, siteId = 'site_1', environment = 'production') {
  const site = await store.getSite(siteId);
  const route = await store.getRouteBySiteId(siteId, environment);
  const version = route.activeVersionId
    ? await store.getSiteVersion(route.activeVersionId, environment)
    : inactiveRouteVersion(route);
  const aclEntries = await store.listSiteAclEntries(siteId);
  await writeRouteSnapshot(snapshots, buildRouteSnapshot({ site, route, version, aclEntries }));
}

function inactiveRouteVersion(route) {
  return {
    id: null,
    executionProvider: route.executionProvider,
    dispatchType: route.dispatchType,
    dispatchBindingName: route.dispatchBindingName,
    slotId: route.slotId,
    contentHash: null,
    deploymentShape: 'inactive',
    resolvedFallback: null,
    routingMode: null,
  };
}

function failingSnapshotStore() {
  return {
    put: async () => {
      throw new Error('snapshot write failed');
    },
  };
}

function alwaysFailSnapshotStore(snapshots) {
  return {
    get: snapshots.get,
    read: snapshots.read,
    delete: snapshots.delete,
    put: async () => {
      throw new Error('snapshot write failed');
    },
  };
}

function jsonRequest(url, body, headers = {}) {
  const hasBody = body !== undefined;
  const method = headers.method || (hasBody ? 'POST' : 'GET');
  const safeHeaders = { ...headers };
  delete safeHeaders.method;
  return new Request(url, {
    method,
    headers: {
      Authorization: `Bearer ${BEARER_USR_1}`,
      'CF-Connecting-IP': '10.1.2.3',
      ...(hasBody ? { 'Content-Type': 'application/json' } : {}),
      ...safeHeaders,
    },
    body: hasBody ? JSON.stringify(body) : undefined,
  });
}

function deploymentRequest(url, fields, headers = {}) {
  const normalized = normalizeDeploymentFields(fields);
  return publishPlanMultipartRequest(url, normalized, headers);
}

function publishPlanMultipartRequest(url, fields, headers = {}) {
  const normalized = normalizeDeploymentFields(fields);
  const form = new FormData();
  const metadata = {
    schemaVersion: normalized.schemaVersion || 1,
    siteId: normalized.siteId,
    siteSlug: normalized.siteSlug,
    teamId: normalized.teamId,
    visibility: normalized.visibility,
    exposure: normalized.exposure,
    requestedFallback: normalized.requestedFallback,
    source: normalized.source || 'cli',
    contentHash: normalized.contentHash,
    publishPlan: normalized.publishPlan,
    assetManifest: normalized.assetManifest || [],
    workerMainModuleName: normalized.workerMainModuleName || normalized.publishPlan?.workerMainModuleName,
    workerModules: normalized.workerModules || [],
    controlSignals: normalized.controlSignals || [],
  };
  if (Object.prototype.hasOwnProperty.call(normalized, 'vars')) metadata.vars = normalized.vars;
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
  for (const file of normalized.files || []) {
    form.set(file.field, new Blob([file.content], { type: file.type || 'application/octet-stream' }), file.filename);
  }
  if (normalized.worker) {
    form.set(
      normalized.worker.field,
      new Blob([normalized.worker.content], { type: normalized.worker.type || 'application/javascript+module' }),
      normalized.worker.filename
    );
  }
  return new Request(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${BEARER_USR_1}`,
      'CF-Connecting-IP': '10.1.2.3',
      ...headers,
    },
    body: form,
  });
}

function normalizeDeploymentFields(fields) {
  if (fields.publishPlan) return normalizePublishPlanFields(fields);
  if (fields.assetManifest || fields.files?.length) return normalizeAssetOnlyFields(fields);
  return normalizeWorkerOnlyFields(fields);
}

function normalizeWorkerOnlyFields(fields) {
  const bundle = fields.artifactBundle || workerBundle(fields.moduleContent || 'export default {};');
  const mainModule = bundle.mainModule || bundle.modules?.[0]?.name || 'worker.mjs';
  const main = bundle.modules.find((module) => module.name === mainModule) || bundle.modules[0];
  const content = main?.content || 'export default {};';
  const type = main?.type || 'application/javascript+module';
  const worker = {
    field: 'worker-main',
    filename: mainModule,
    content,
    type,
  };
  const bytes = Buffer.from(content);
  const decision = {
    deploymentShape: 'worker-only',
    requestedFallback: 'auto',
    resolvedFallback: null,
    routingMode: 'worker-only',
    workerEntry: mainModule,
  };
  return {
    ...fields,
    requestedFallback: fields.requestedFallback || 'auto',
    publishPlan: {
      ...decision,
      workerMainModuleName: mainModule,
    },
    workerModules: [
      {
        moduleName: mainModule,
        partName: worker.field,
        hash: hashAsset(bytes, type),
        size: bytes.byteLength,
        contentType: type,
      },
    ],
    worker,
    assetManifest: [],
    files: [],
    contentHash: fields.expectedContentHash || hashUploadPlan([{ relativePath: mainModule, contentType: type, bytes }], decision),
  };
}

function normalizeAssetOnlyFields(fields) {
  const files = fields.files || [];
  const assets = files.map((file, index) => {
    const path = normalizeAssetPathFromFilename(file.filename);
    const contentType = file.type || fields.assetManifest?.[path]?.content_type || 'application/octet-stream';
    const bytes = Buffer.from(file.content);
    return {
      path,
      partName: file.field || `asset-file-${index}`,
      hash: hashAsset(bytes, contentType),
      size: bytes.byteLength,
      contentType,
      file: {
        ...file,
        field: file.field || `asset-file-${index}`,
        type: contentType,
      },
    };
  });
  const resolvedFallback = fields.requestedFallback === 'not-found' ? 'not-found' : 'index';
  const decision = {
    deploymentShape: 'assets-only',
    requestedFallback: fields.requestedFallback || (resolvedFallback === 'index' ? 'index' : 'not-found'),
    resolvedFallback,
    routingMode: 'assets-only',
    workerEntry: null,
  };
  return {
    ...fields,
    requestedFallback: fields.requestedFallback || decision.requestedFallback,
    publishPlan: {
      ...decision,
      workerMainModuleName: null,
      assetsConfig: { notFoundHandling: resolvedFallback === 'index' ? 'single-page-application' : '404-page' },
    },
    assetManifest: assets.map(({ file: _file, ...asset }) => asset),
    files: assets.map((asset) => asset.file),
    workerModules: [],
    contentHash:
      fields.expectedContentHash ||
      hashUploadPlan(
        assets.map((asset) => ({
          relativePath: asset.path.replace(/^\/+/, ''),
          contentType: asset.contentType,
          bytes: Buffer.from(asset.file.content),
        })),
        decision
      ),
  };
}

function normalizePublishPlanFields(fields) {
  const assets = (fields.assetManifest || []).map((asset) => {
    const file = (fields.files || []).find((candidate) => candidate.field === asset.partName) || {};
    const contentType = asset.contentType || file.type || 'application/octet-stream';
    const bytes = Buffer.from(file.content || '');
    return {
      ...asset,
      hash: asset.keepHash ? asset.hash : hashAsset(bytes, contentType),
      size: asset.size ?? bytes.byteLength,
      contentType,
    };
  });
  const workerModules = (fields.workerModules || []).map((module) => {
    const worker =
      fields.worker && fields.worker.field === module.partName
        ? fields.worker
        : (fields.workerParts || []).find((candidate) => candidate.field === module.partName) || {};
    const contentType = module.contentType || worker.type || 'application/javascript+module';
    const bytes = Buffer.from(worker.content || '');
    return {
      ...module,
      hash: module.keepHash ? module.hash : hashAsset(bytes, contentType),
      size: module.size ?? bytes.byteLength,
      contentType,
    };
  });
  const files = (fields.files || []).map((file) => {
    const asset = assets.find((entry) => entry.partName === file.field);
    return { ...file, type: asset?.contentType || file.type };
  });
  const decision = {
    deploymentShape: fields.publishPlan.deploymentShape,
    requestedFallback: fields.publishPlan.requestedFallback,
    resolvedFallback: fields.publishPlan.resolvedFallback,
    routingMode: fields.publishPlan.routingMode,
    workerEntry: fields.publishPlan.workerMainModuleName || fields.publishPlan.workerEntry || null,
  };
  const hashFiles = [
    ...assets.map((asset) => {
      const file = files.find((candidate) => candidate.field === asset.partName) || {};
      return {
        relativePath: asset.path.replace(/^\/+/, ''),
        contentType: asset.contentType,
        bytes: Buffer.from(file.content || ''),
      };
    }),
    ...workerModules.map((module) => {
      const worker = fields.worker && fields.worker.field === module.partName ? fields.worker : {};
      return {
        relativePath: module.moduleName,
        contentType: module.contentType,
        bytes: Buffer.from(worker.content || ''),
      };
    }),
  ];
  return {
    ...fields,
    assetManifest: assets,
    files,
    workerModules,
    contentHash: fields.expectedContentHash || hashUploadPlan(hashFiles, decision),
  };
}

function authRequest(url, headers = {}) {
  return new Request(url, {
    headers: { Authorization: `Bearer ${BEARER_USR_1}`, 'CF-Connecting-IP': '10.1.2.3', ...headers },
  });
}

function internalConsoleRequest(path, { method = 'GET', body } = {}) {
  return new Request(`https://pages-api.internal${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Console-BFF': 'pages-console',
      'X-Console-User-Id': 'usr_root',
      'X-Console-Email': 'root@example.com',
      'X-Console-Admin': 'true',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function seedPlatformAdmin(store, userId = 'usr_root') {
  if (!(await store.getUser(userId))) {
    await store.createUser({
      userId,
      email: 'root@example.com',
      employeeStatus: 'active',
      sessionVersion: 1,
    });
  }
  await store.grantPlatformAdmin({
    environment: 'production',
    userId,
    grantedByUserId: 'usr_bootstrap',
    grantReason: 'test',
  });
}

function assertPublicDeploymentEnvelopeHidesRuntimeConfig(body) {
  const serialized = JSON.stringify(body);
  assert.equal(serialized.includes('valueHash'), false);
  assert.equal(serialized.includes('runtimeConfigSnapshotJson'), false);
  assert.equal(serialized.includes('secretNamesJson'), false);
  assert.equal(serialized.includes('varNamesJson'), false);
  assert.equal(body.deployment && 'runtimeConfigSnapshotJson' in body.deployment, false);
  assert.equal(body.version && 'runtimeConfigSnapshotJson' in body.version, false);
  assert.equal(body.version && 'secretNamesJson' in body.version, false);
  assert.equal(body.version && 'varNamesJson' in body.version, false);
}

function assertJsonLeafValueAbsent(value, forbidden) {
  assert.equal(
    collectJsonLeafStrings(value).some((leaf) => leaf === forbidden),
    false
  );
}

function collectJsonLeafStrings(value, output = []) {
  if (typeof value === 'string') {
    output.push(value);
    return output;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectJsonLeafStrings(item, output);
    }
    return output;
  }
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) {
      collectJsonLeafStrings(item, output);
    }
  }
  return output;
}

function workerBundle(content) {
  return {
    mainModule: 'worker.mjs',
    modules: [{ name: 'worker.mjs', content, type: 'application/javascript+module' }],
  };
}

function hashAsset(bytes, contentType) {
  return createHash('sha256')
    .update('xd-pages-asset-v2\0')
    .update(contentType || 'application/octet-stream')
    .update('\0')
    .update(bytes)
    .digest('hex')
    .slice(0, 32);
}

function hashUploadPlan(files, decision) {
  const hash = createHash('sha256');
  hash.update('xd-pages-upload-plan-v1\0');
  hash.update(JSON.stringify(publishPlanFromDecision(decision)));
  hash.update('\0');
  for (const file of files.sort((left, right) => left.relativePath.localeCompare(right.relativePath))) {
    hash.update('file\0');
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(String(file.bytes.byteLength));
    hash.update('\0');
    hash.update(file.contentType || 'application/octet-stream');
    hash.update('\0');
    hash.update(file.bytes);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function publishPlanFromDecision(decision) {
  return {
    deploymentShape: decision.deploymentShape,
    requestedFallback: decision.requestedFallback,
    resolvedFallback: decision.resolvedFallback,
    routingMode: decision.routingMode,
    workerEntry: decision.workerEntry,
    workerMainModuleName: decision.workerEntry,
    assetsConfig: decision.resolvedFallback
      ? {
          notFoundHandling: decision.resolvedFallback === 'index' ? 'single-page-application' : '404-page',
        }
      : null,
  };
}

function normalizeAssetPathFromFilename(filename) {
  return `/${String(filename || 'index.html')
    .replaceAll('\\', '/')
    .replace(/^\/+/, '')}`;
}

function multipartWorkerScriptResponse() {
  return new Response(
    [
      '--form-boundary',
      'Content-Disposition: form-data; name="worker.mjs"; filename="worker.mjs"',
      'Content-Type: application/javascript+module',
      '',
      'export default {};',
      '--form-boundary--',
      '',
    ].join('\r\n'),
    {
      status: 200,
      headers: { 'Content-Type': 'multipart/form-data; boundary=form-boundary' },
    }
  );
}

function testSlackWebhookUrl() {
  return ['https://hooks.slack.com', 'services', 'T000', 'B000', 'PLACEHOLDER'].join('/');
}

function workerWithAssetsDeploymentFields(overrides = {}) {
  return {
    siteId: 'site_1',
    requestedFallback: 'auto',
    source: 'cli',
    publishPlan: {
      deploymentShape: 'worker-with-assets',
      requestedFallback: 'auto',
      resolvedFallback: 'not-found',
      routingMode: 'worker-first',
      workerEntry: '_worker.js',
      workerMainModuleName: '_worker.js',
      assetsConfig: { notFoundHandling: '404-page' },
    },
    assetManifest: [
      {
        path: '/index.html',
        partName: 'asset-file-0',
        size: 5,
        contentType: 'text/html; charset=utf-8',
      },
    ],
    workerModules: [
      {
        moduleName: '_worker.js',
        partName: 'worker-main',
        size: 18,
        contentType: 'application/javascript+module',
      },
    ],
    files: [{ field: 'asset-file-0', filename: 'index.html', content: 'hello', type: 'text/html; charset=utf-8' }],
    worker: {
      field: 'worker-main',
      filename: '_worker.js',
      content: 'export default {};',
      type: 'application/javascript+module',
    },
    ...overrides,
  };
}

function deployPayload(overrides = {}) {
  const contentHash = overrides.contentHash || 'sha256:abc';
  const moduleContent =
    overrides.moduleContent || `export default { fetch() { return new Response(${JSON.stringify(contentHash)}); } };`;
  const payload = {
    siteId: 'site_1',
    contentHash,
    artifactBundle: overrides.artifactBundle || workerBundle(moduleContent),
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (key !== 'moduleContent') payload[key] = value;
  }
  return payload;
}
