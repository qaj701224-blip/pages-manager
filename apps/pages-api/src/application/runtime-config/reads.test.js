import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeConfigReads } from './reads.js';

test('runtime config reads call only the requested narrow repository capability', async () => {
  const calls = [];
  const service = createRuntimeConfigReads({
    repository: {
      async listVars(environment, siteId) {
        calls.push(['vars', environment, siteId]);
        return [{ name: 'API_BASE', value: 'https://api.example.com', revision: 2 }];
      },
      async listSecretMetadata(environment, siteId) {
        calls.push(['secrets', environment, siteId]);
        return [{ name: 'API_TOKEN', revision: 3 }];
      },
    },
  });

  assert.deepEqual(await service.listVars({ environment: 'production', siteId: 'site_1' }), [
    { name: 'API_BASE', value: 'https://api.example.com', revision: 2 },
  ]);
  assert.deepEqual(calls, [['vars', 'production', 'site_1']]);

  assert.deepEqual(await service.listSecretMetadata({ environment: 'production', siteId: 'site_1' }), [
    { name: 'API_TOKEN', revision: 3 },
  ]);
  assert.deepEqual(calls, [
    ['vars', 'production', 'site_1'],
    ['secrets', 'production', 'site_1'],
  ]);
});

test('runtime config reads fail closed when a requested repository capability is absent', async () => {
  const service = createRuntimeConfigReads({ repository: {} });

  await assert.rejects(service.listVars({ environment: 'production', siteId: 'site_1' }), {
    message: 'RUNTIME_CONFIG_UNSUPPORTED',
  });
  await assert.rejects(service.listSecretMetadata({ environment: 'production', siteId: 'site_1' }), {
    message: 'RUNTIME_CONFIG_UNSUPPORTED',
  });
});

test('runtime config reads do not substitute one configuration class when the requested query fails', async () => {
  const failure = new Error('SENSITIVE_D1_FAILURE');
  const service = createRuntimeConfigReads({
    repository: {
      async listVars() {
        throw failure;
      },
      async listSecretMetadata() {
        throw failure;
      },
    },
  });

  await assert.rejects(service.listVars({ environment: 'production', siteId: 'site_1' }), failure);
  await assert.rejects(service.listSecretMetadata({ environment: 'production', siteId: 'site_1' }), failure);
});
