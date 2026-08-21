import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentProviderOperations } from './provider-operations.js';

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
  });

  assert.deepEqual(application.prepare({ site: { id: 'site_1' } }), {
    ok: false,
    error: { code: 'DEPLOYMENT_PROVIDER_CONFIG_INVALID', cause },
  });
});

test('deployment Provider operations forward upload input and return its artifact result', async () => {
  const inputs = [];
  const uploaded = { artifactRef: 'wfp://artifact', workerName: 'pages-v2-guide-ver-1' };
  const application = createDeploymentProviderOperations({ providers: { create() {} } });
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
  const application = createDeploymentProviderOperations({ providers: { create() {} } });

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
  assert.throws(() => createDeploymentProviderOperations({ providers: {} }), /providers\.create is required/);
});
