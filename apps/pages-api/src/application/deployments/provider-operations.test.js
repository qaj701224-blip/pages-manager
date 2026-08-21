import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentProviderOperations } from './provider-operations.js';

const uploadTelemetry = { start: () => null, finish: async () => null };
const verifyTelemetry = { start: () => null, finish: async () => null };

test('deployment Provider operations prepare a provider through the narrow factory port', () => {
  const calls = [];
  const provider = { executionProvider: 'wfp' };
  const application = createDeploymentProviderOperations({
    providers: {
      create(site) {
        calls.push(site);
        return provider;
      },
    },
    uploadTelemetry,
    verifyTelemetry,
  });
  const site = { id: 'site_1' };

  assert.deepEqual(application.prepare({ site }), { ok: true, provider });
  assert.deepEqual(calls, [site]);
});

test('deployment Provider operations map configuration failures without throwing', () => {
  const cause = new Error('provider configuration unavailable');
  const application = createDeploymentProviderOperations({
    providers: {
      create() {
        throw cause;
      },
    },
    uploadTelemetry,
    verifyTelemetry,
  });

  assert.deepEqual(application.prepare({ site: { id: 'site_1' } }), {
    ok: false,
    error: { code: 'DEPLOYMENT_PROVIDER_CONFIG_INVALID', cause },
  });
});

test('deployment Provider operations forward upload input and return its artifact result', async () => {
  const inputs = [];
  const uploaded = { artifactRef: 'wfp://artifact', workerName: 'pages-v2-guide-ver-1' };
  const application = createDeploymentProviderOperations({ providers: { create() {} }, uploadTelemetry, verifyTelemetry });
  const provider = {
    async upload(input) {
      inputs.push(input);
      return uploaded;
    },
  };

  const result = await application.upload({
    provider,
    site: { id: 'site_1' },
    versionId: 'ver_1',
    runtimeBindings: { vars: {}, secrets: [] },
  });

  assert.deepEqual(result, { ok: true, uploaded });
  assert.deepEqual(inputs, [
    {
      site: { id: 'site_1' },
      versionId: 'ver_1',
      runtimeBindings: { vars: {}, secrets: [] },
    },
  ]);
});

test('deployment Provider operations preserve upload and verify causes in typed failures', async () => {
  const uploadCause = Object.assign(new Error('upload failed'), { operation: 'worker_put' });
  const verifyCause = new Error('verify failed');
  const application = createDeploymentProviderOperations({ providers: { create() {} }, uploadTelemetry, verifyTelemetry });

  assert.deepEqual(
    await application.upload({
      provider: {
        upload: async () => {
          throw uploadCause;
        },
      },
      versionId: 'ver_1',
    }),
    {
      ok: false,
      error: { code: 'DEPLOYMENT_PROVIDER_UPLOAD_FAILED', cause: uploadCause },
    }
  );
  assert.deepEqual(
    await application.verify({
      provider: {
        verify: async () => {
          throw verifyCause;
        },
      },
      versionId: 'ver_1',
    }),
    {
      ok: false,
      error: { code: 'DEPLOYMENT_PROVIDER_VERIFY_FAILED', cause: verifyCause },
    }
  );
});

test('deployment Provider operations require their factory capability', () => {
  assert.throws(
    () => createDeploymentProviderOperations({ providers: {}, uploadTelemetry, verifyTelemetry }),
    /providers\.create is required/
  );
});

test('deployment Provider upload traces success and failure around the provider call', async () => {
  const calls = [];
  const stage = { operation: 'provider_upload' };
  const createApplication = () =>
    createDeploymentProviderOperations({
      providers: { create() {} },
      uploadTelemetry: {
        start() {
          calls.push(['start']);
          return stage;
        },
        async finish(receivedStage, outcome) {
          calls.push(['finish', receivedStage, outcome]);
        },
      },
      verifyTelemetry,
    });

  const uploaded = { operation: 'worker_put' };
  assert.deepEqual(
    await createApplication().upload({
      provider: { upload: async () => (calls.push(['upload']), uploaded) },
    }),
    { ok: true, uploaded }
  );
  assert.deepEqual(calls.splice(0), [
    ['start'],
    ['upload'],
    ['finish', stage, { status: 'succeeded', operation: 'worker_put' }],
  ]);

  const cause = new Error('upload failed');
  assert.deepEqual(
    await createApplication().upload({ provider: { upload: async () => Promise.reject(cause) } }),
    { ok: false, error: { code: 'DEPLOYMENT_PROVIDER_UPLOAD_FAILED', cause } }
  );
  assert.deepEqual(calls, [
    ['start'],
    ['finish', stage, { status: 'failed', cause }],
  ]);
});

test('deployment Provider upload converts success finish errors using failure precedence', async () => {
  const finishError = new Error('trace finish failed');
  const calls = [];
  const application = createDeploymentProviderOperations({
    providers: { create() {} },
    uploadTelemetry: {
      start: () => null,
      async finish(_stage, outcome) {
        calls.push(outcome);
        if (outcome.status === 'succeeded') throw finishError;
      },
    },
    verifyTelemetry,
  });

  assert.deepEqual(await application.upload({ provider: { upload: async () => ({}) } }), {
    ok: false,
    error: { code: 'DEPLOYMENT_PROVIDER_UPLOAD_FAILED', cause: finishError },
  });
  assert.deepEqual(calls, [
    { status: 'succeeded', operation: undefined },
    { status: 'failed', cause: finishError },
  ]);
});

test('deployment Provider upload starts telemetry synchronously', () => {
  const startError = new Error('invalid trace');
  const application = createDeploymentProviderOperations({
    providers: { create() {} },
    uploadTelemetry: {
      start() {
        throw startError;
      },
      finish: async () => assert.fail('finish must not run'),
    },
    verifyTelemetry,
  });

  assert.throws(
    () => application.upload({ provider: { upload: async () => assert.fail('upload must not run') } }),
    (error) => error === startError
  );
});

test('deployment Provider verify traces success and failure around the provider call', async () => {
  const calls = [];
  const stage = { operation: 'provider_verify' };
  const createApplication = () =>
    createDeploymentProviderOperations({
      providers: { create() {} },
      uploadTelemetry,
      verifyTelemetry: {
        start() {
          calls.push(['start']);
          return stage;
        },
        async finish(receivedStage, outcome) {
          calls.push(['finish', receivedStage, outcome]);
        },
      },
    });

  assert.deepEqual(
    await createApplication().verify({ provider: { verify: async () => calls.push(['verify']) } }),
    { ok: true }
  );
  assert.deepEqual(calls.splice(0), [
    ['start'],
    ['verify'],
    ['finish', stage, { status: 'succeeded' }],
  ]);

  const cause = new Error('verify failed');
  assert.deepEqual(
    await createApplication().verify({ provider: { verify: async () => Promise.reject(cause) } }),
    { ok: false, error: { code: 'DEPLOYMENT_PROVIDER_VERIFY_FAILED', cause } }
  );
  assert.deepEqual(calls, [
    ['start'],
    ['finish', stage, { status: 'failed', cause }],
  ]);
});

test('deployment Provider verify converts success finish errors using failure precedence', async () => {
  const finishError = new Error('trace finish failed');
  const application = createDeploymentProviderOperations({
    providers: { create() {} },
    uploadTelemetry,
    verifyTelemetry: {
      start: () => null,
      async finish(_stage, outcome) {
        if (outcome.status === 'succeeded') throw finishError;
      },
    },
  });

  assert.deepEqual(await application.verify({ provider: { verify: async () => null } }), {
    ok: false,
    error: { code: 'DEPLOYMENT_PROVIDER_VERIFY_FAILED', cause: finishError },
  });
});
