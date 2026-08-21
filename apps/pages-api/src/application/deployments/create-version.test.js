import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentVersionCreation } from './create-version.js';

const command = {
  versionId: 'ver_1',
  siteId: 'site_1',
  deploymentId: 'dep_1',
  workerName: 'pages-v2-guide-ver-1',
  uploaded: {
    runtime: 'worker',
    executionProvider: 'normal-worker-slot',
    dispatchType: 'service-binding',
    dispatchBindingName: 'WORKER_SLOT_1',
    slotId: 'slot_1',
    artifactRef: 'slot://production/slot_1/pages-v2-guide-ver-1/ver_1',
  },
  executionProvider: 'wfp',
  decision: {
    deploymentShape: 'worker-with-assets',
    requestedFallback: 'index',
    resolvedFallback: 'index',
    routingMode: 'worker-first',
    workerEntry: 'worker.mjs',
  },
  contentHash: 'sha256:content',
  artifactBundle: {
    modules: [{ name: 'worker.mjs', type: 'application/javascript+module', content: 'export default {}' }],
  },
  assetManifest: {
    '/index.html': { hash: 'sha256:index', size: '12', content_type: 'text/html' },
  },
  runtimeVars: { Z_FLAG: 'last', A_FLAG: 'first' },
  runtimeVarRecords: [{ name: 'A_FLAG', value: 'first', revision: 2 }],
  runtimeSecrets: [{ name: 'API_TOKEN', value: 'secret', revision: 3 }],
  actorId: 'usr_1',
};
const telemetry = { start: () => null, finish: async () => null };

test('deployment version creation persists the complete immutable version record through its narrow port', async () => {
  const records = [];
  const version = { id: 'ver_1', persisted: true };
  const application = createDeploymentVersionCreation({
    versions: {
      async create(input) {
        records.push(input);
        return version;
      },
    },
    runtimeConfig: {
      async snapshotSecrets(secrets) {
        assert.equal(secrets, command.runtimeSecrets);
        return [{ ...secrets[0], valueHash: 'hashed-secret' }];
      },
    },
    telemetry,
  });

  assert.deepEqual(await application.create(command), { ok: true, version });
  assert.deepEqual(records, [
    {
      id: 'ver_1',
      siteId: 'site_1',
      deploymentId: 'dep_1',
      workerName: 'pages-v2-guide-ver-1',
      runtime: 'worker',
      executionProvider: 'normal-worker-slot',
      dispatchType: 'service-binding',
      dispatchBindingName: 'WORKER_SLOT_1',
      slotId: 'slot_1',
      artifactRef: 'slot://production/slot_1/pages-v2-guide-ver-1/ver_1',
      contentHash: 'sha256:content',
      deploymentShape: 'worker-with-assets',
      requestedFallback: 'index',
      resolvedFallback: 'index',
      routingMode: 'worker-first',
      workerEntry: 'worker.mjs',
      assetsConfigJson: { not_found_handling: 'single-page-application', run_worker_first: true },
      workerModulesJson: [{ moduleName: 'worker.mjs', contentType: 'application/javascript+module', size: 17 }],
      assetManifestJson: [{ path: '/index.html', hash: 'sha256:index', size: 12, contentType: 'text/html' }],
      canonicalContentHash: 'sha256:content',
      varNamesJson: ['A_FLAG', 'Z_FLAG'],
      secretNamesJson: ['API_TOKEN'],
      runtimeConfigSnapshotJson: {
        vars: [{ name: 'A_FLAG', value: 'first', revision: 2 }],
        secrets: [{ name: 'API_TOKEN', revision: 3, valueHash: 'hashed-secret' }],
      },
      artifactAvailability: 'active',
      createdBy: 'usr_1',
    },
  ]);
});

test('deployment version creation preserves WFP defaults and nullable artifact fields', async () => {
  let record;
  const application = createDeploymentVersionCreation({
    versions: {
      async create(input) {
        record = input;
        return input;
      },
    },
    runtimeConfig: { snapshotSecrets: async () => [] },
    telemetry,
  });

  const result = await application.create({
    ...command,
    uploaded: { artifactRef: 'wfp://artifact' },
    decision: {
      deploymentShape: 'worker-only',
      requestedFallback: 'auto',
      resolvedFallback: null,
      routingMode: 'worker-only',
      workerEntry: 'worker.mjs',
    },
    artifactBundle: null,
    assetManifest: null,
    runtimeVars: {},
    runtimeVarRecords: [],
    runtimeSecrets: [],
  });

  assert.equal(result.ok, true);
  assert.equal(record.runtime, 'worker');
  assert.equal(record.executionProvider, 'wfp');
  assert.equal(record.dispatchType, 'dispatch-namespace');
  assert.equal(record.dispatchBindingName, null);
  assert.equal(record.slotId, null);
  assert.equal(record.assetsConfigJson, null);
  assert.equal(record.workerModulesJson, null);
  assert.equal(record.assetManifestJson, null);
});

test('deployment version creation maps hash and repository failures to a typed result', async () => {
  const hashCause = new Error('hash unavailable');
  const hashFailure = createDeploymentVersionCreation({
    versions: { create: async () => assert.fail('hashing precedes version persistence') },
    runtimeConfig: {
      snapshotSecrets: async () => {
        throw hashCause;
      },
    },
    telemetry,
  });
  assert.deepEqual(await hashFailure.create(command), {
    ok: false,
    error: { code: 'DEPLOYMENT_VERSION_CREATE_FAILED', cause: hashCause },
  });

  const storeCause = new Error('version write failed');
  const storeFailure = createDeploymentVersionCreation({
    versions: {
      create: async () => {
        throw storeCause;
      },
    },
    runtimeConfig: { snapshotSecrets: async () => [] },
    telemetry,
  });
  assert.deepEqual(await storeFailure.create(command), {
    ok: false,
    error: { code: 'DEPLOYMENT_VERSION_CREATE_FAILED', cause: storeCause },
  });
});

test('deployment version creation traces around hashing and persistence', async () => {
  const calls = [];
  const stage = { operation: 'create_site_version' };
  const version = { id: 'ver_1' };
  const application = createDeploymentVersionCreation({
    versions: {
      async create() {
        calls.push(['version']);
        return version;
      },
    },
    runtimeConfig: {
      async snapshotSecrets() {
        calls.push(['snapshot_secrets']);
        return [];
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

  assert.deepEqual(await application.create(command), { ok: true, version });
  assert.deepEqual(calls, [
    ['start'],
    ['snapshot_secrets'],
    ['version'],
    ['finish', stage, { status: 'succeeded' }],
  ]);
});

test('deployment version creation starts telemetry synchronously', () => {
  const startError = new Error('invalid trace');
  const application = createDeploymentVersionCreation({
    versions: { create: async () => assert.fail('version persistence must not run') },
    runtimeConfig: { snapshotSecrets: async () => assert.fail('secret hashing must not run') },
    telemetry: {
      start() {
        throw startError;
      },
      finish: async () => assert.fail('finish must not run'),
    },
  });

  assert.throws(() => application.create(command), (error) => error === startError);
});

test('deployment version creation requires its hash capability', () => {
  assert.throws(
    () => createDeploymentVersionCreation({ versions: {}, runtimeConfig: {}, telemetry }),
    /runtimeConfig\.snapshotSecrets is required/
  );
});
