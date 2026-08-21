import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeConfigSync } from './runtime-config-sync.js';

test('runtime config sync skips provider creation when no active Worker exists', async () => {
  let providerCreated = false;
  const sync = createRuntimeConfigSync({
    environment: 'production',
    store: {
      async getRouteBySiteId() {
        return { routeStatus: 'inactive', activeVersionId: null };
      },
      async getSiteVersion() {
        assert.fail('version must not be read for an inactive route');
      },
    },
    createProvider() {
      providerCreated = true;
      return {};
    },
  });

  assert.deepEqual(await sync.syncPlainText({ site: { id: 'site_1' }, snapshot: { vars: [] } }), {
    appliesTo: 'next_deployment',
  });
  assert.equal(providerCreated, false);
});

test('runtime config sync reports provider setup failures without HTTP objects', async () => {
  const store = {
    async getRouteBySiteId() {
      return {
        routeStatus: 'active',
        activeVersionId: 'version_1',
        executionProvider: 'wfp',
        workerName: 'pages-v2-site-1',
      };
    },
    async getSiteVersion() {
      return { executionProvider: 'wfp', deploymentShape: 'worker-only', workerName: 'pages-v2-site-1' };
    },
  };
  const sync = createRuntimeConfigSync({
    environment: 'production',
    store,
    createProvider() {
      throw new Error('provider unavailable');
    },
  });

  await assert.rejects(
    sync.syncSecret({ site: { id: 'site_1' }, mutation: { operation: 'put', name: 'API_TOKEN', value: 'secret' } }),
    (error) =>
      error.code === 'SECRET_ACTIVE_WORKER_SYNC_FAILED' &&
      error.stage === 'provider_setup' &&
      error.reason === 'provider_configuration_failed'
  );
});
