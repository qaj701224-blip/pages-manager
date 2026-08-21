import assert from 'node:assert/strict';
import test from 'node:test';

import { createTestPagesStore } from '../../test-support/pages-store-fixture.js';
import { resolveLegacyV1SiteTarget } from './ownership.js';
import { cleanupLegacyV1CloudflareSite } from './cloudflare-cleanup.js';
import { createSiteWithLegacyV1Takeover } from './takeover.js';

function activeV1Claim(overrides = {}) {
  return {
    id: 'claim_1',
    environment: 'production',
    hostname: 'guide.workers.xd.team',
    normalizedSlug: 'guide',
    hostnameFamily: 'workers',
    ownerSystem: 'v1',
    ownerId: 'v1:production:guide',
    ownerRef: 'pages-guide',
    status: 'active',
    ...overrides,
  };
}

function kvWith(value) {
  return {
    async get(key, type) {
      assert.equal(key, 'guide');
      assert.equal(type, 'json');
      return value;
    },
  };
}

function ownershipInput(overrides = {}) {
  return {
    sites: kvWith({
      name: 'guide',
      token: 'pages_owner@example.com',
      scriptName: 'pages-guide',
      url: 'https://guide.workers.xd.team',
    }),
    actor: { userId: 'usr_1', email: 'OWNER@example.com' },
    claim: activeV1Claim(),
    environment: 'production',
    slug: 'guide',
    hostname: 'guide.workers.xd.team',
    ...overrides,
  };
}

test('resolves a matching active v1 site without returning ownership secrets', async () => {
  const target = await resolveLegacyV1SiteTarget(ownershipInput());

  assert.deepEqual(target, {
    environment: 'production',
    slug: 'guide',
    hostname: 'guide.workers.xd.team',
    routePattern: 'guide.workers.xd.team/*',
    scriptName: 'pages-guide',
    claimOwnerId: 'v1:production:guide',
    claimOwnerRef: 'pages-guide',
  });
  assert.equal('token' in target, false);
  assert.equal('email' in target, false);
});

test('rejects a non-active v1 claim before reading the legacy KV record', async () => {
  let readCount = 0;
  const sites = { get: async () => { readCount += 1; return null; } };

  await assert.rejects(
    resolveLegacyV1SiteTarget(ownershipInput({ sites, claim: activeV1Claim({ status: 'held' }) })),
    { code: 'HOSTNAME_CLAIM_CONFLICT' }
  );
  assert.equal(readCount, 0);
});

test('rejects a mismatched legacy owner without exposing the owner', async () => {
  await assert.rejects(
    resolveLegacyV1SiteTarget(
      ownershipInput({
        sites: kvWith({
          name: 'guide',
          token: 'pages_other@example.com',
          scriptName: 'pages-guide',
          url: 'https://guide.workers.xd.team',
        }),
      })
    ),
    (error) => error.code === 'HOSTNAME_CLAIM_CONFLICT' && !/other@example.com|pages_/.test(error.message)
  );
});

test('rejects a staging Worker marker during production takeover validation', async () => {
  await assert.rejects(
    resolveLegacyV1SiteTarget(
      ownershipInput({
        sites: kvWith({
          name: 'guide',
          token: 'pages_owner@example.com',
          scriptName: 'pages-staging-guide',
          url: 'https://guide.workers.xd.team',
        }),
      })
    ),
    { code: 'HOSTNAME_CLAIM_CONFLICT' }
  );
});

test('rejects a v1 Worker name that does not match the requested slug', async () => {
  await assert.rejects(
    resolveLegacyV1SiteTarget(
      ownershipInput({
        sites: kvWith({
          name: 'guide',
          token: 'pages_owner@example.com',
          scriptName: 'pages-other',
          url: 'https://guide.workers.xd.team',
        }),
        claim: activeV1Claim({ ownerRef: 'pages-other' }),
      })
    ),
    { code: 'HOSTNAME_CLAIM_CONFLICT' }
  );
});

test('deletes only the verified exact route and v1 Worker in order', async () => {
  const calls = [];
  await cleanupLegacyV1CloudflareSite({
    env: {
      V1_CLOUDFLARE_CLIENT: {
        async listRoutes() {
          calls.push('listRoutes');
          return [{ id: 'route_cf_1', pattern: 'guide.workers.xd.team/*', script: 'pages-guide' }];
        },
        async deleteRoute({ routeId }) {
          calls.push(`deleteRoute:${routeId}`);
        },
        async deleteScript({ scriptName }) {
          calls.push(`deleteScript:${scriptName}`);
        },
      },
    },
    config: { environment: 'production' },
    target: {
      environment: 'production',
      slug: 'guide',
      hostname: 'guide.workers.xd.team',
      routePattern: 'guide.workers.xd.team/*',
      scriptName: 'pages-guide',
    },
  });

  assert.deepEqual(calls, ['listRoutes', 'deleteRoute:route_cf_1', 'deleteScript:pages-guide']);
});

test('treats missing route and Worker as idempotent cleanup', async () => {
  const calls = [];
  await cleanupLegacyV1CloudflareSite({
    env: {
      V1_CLOUDFLARE_CLIENT: {
        async listRoutes() {
          calls.push('listRoutes');
          return [];
        },
        async deleteScript({ scriptName }) {
          calls.push(`deleteScript:${scriptName}`);
          return null;
        },
      },
    },
    config: { environment: 'production' },
    target: {
      environment: 'production',
      slug: 'guide',
      hostname: 'guide.workers.xd.team',
      routePattern: 'guide.workers.xd.team/*',
      scriptName: 'pages-guide',
    },
  });

  assert.deepEqual(calls, ['listRoutes', 'deleteScript:pages-guide']);
});

test('refuses to delete a route bound to another Worker', async () => {
  let deleteCount = 0;
  await assert.rejects(
    cleanupLegacyV1CloudflareSite({
      env: {
        V1_CLOUDFLARE_CLIENT: {
          async listRoutes() {
            return [{ id: 'route_cf_1', pattern: 'guide.workers.xd.team/*', script: 'pages-other' }];
          },
          async deleteRoute() {
            deleteCount += 1;
          },
          async deleteScript() {
            deleteCount += 1;
          },
        },
      },
      config: { environment: 'production' },
      target: {
        environment: 'production',
        slug: 'guide',
        hostname: 'guide.workers.xd.team',
        routePattern: 'guide.workers.xd.team/*',
        scriptName: 'pages-guide',
      },
    }),
    { code: 'V1_TAKEOVER_CLEANUP_FAILED' }
  );
  assert.equal(deleteCount, 0);
});

test('refuses to delete duplicate exact routes instead of choosing one', async () => {
  let deleteCount = 0;
  await assert.rejects(
    cleanupLegacyV1CloudflareSite({
      env: {
        V1_CLOUDFLARE_CLIENT: {
          async listRoutes() {
            return [
              { id: 'route_cf_1', pattern: 'guide.workers.xd.team/*', script: 'pages-guide' },
              { id: 'route_cf_2', pattern: 'guide.workers.xd.team/*', script: 'pages-guide' },
            ];
          },
          async deleteRoute() {
            deleteCount += 1;
          },
          async deleteScript() {
            deleteCount += 1;
          },
        },
      },
      config: { environment: 'production' },
      target: {
        environment: 'production',
        slug: 'guide',
        hostname: 'guide.workers.xd.team',
        routePattern: 'guide.workers.xd.team/*',
        scriptName: 'pages-guide',
      },
    }),
    { code: 'V1_TAKEOVER_CLEANUP_FAILED' }
  );
  assert.equal(deleteCount, 0);
});

test('refuses a destructive target whose Worker name does not match its slug', async () => {
  let deleteCount = 0;
  await assert.rejects(
    cleanupLegacyV1CloudflareSite({
      env: {
        V1_CLOUDFLARE_CLIENT: {
          async listRoutes() {
            return [{ id: 'route_cf_1', pattern: 'guide.workers.xd.team/*', script: 'pages-other' }];
          },
          async deleteRoute() {
            deleteCount += 1;
          },
          async deleteScript() {
            deleteCount += 1;
          },
        },
      },
      config: { environment: 'production' },
      target: {
        environment: 'production',
        slug: 'guide',
        hostname: 'guide.workers.xd.team',
        routePattern: 'guide.workers.xd.team/*',
        scriptName: 'pages-other',
      },
    }),
    { code: 'V1_TAKEOVER_CLEANUP_FAILED' }
  );
  assert.equal(deleteCount, 0);
});

test('deletes the exact route but defers Worker cleanup while another route still references it', async () => {
  const calls = [];
  const result = await cleanupLegacyV1CloudflareSite({
    env: {
      V1_CLOUDFLARE_CLIENT: {
        async listRoutes() {
          calls.push('listRoutes');
          return [
            { id: 'route_cf_1', pattern: 'guide.workers.xd.team/*', script: 'pages-guide' },
            { id: 'route_cf_2', pattern: 'docs.workers.xd.team/*', script: 'pages-guide' },
          ];
        },
        async deleteRoute({ routeId }) {
          calls.push(`deleteRoute:${routeId}`);
        },
        async deleteScript() {
          calls.push('deleteScript');
        },
      },
    },
    config: { environment: 'production' },
    target: {
      environment: 'production',
      slug: 'guide',
      hostname: 'guide.workers.xd.team',
      routePattern: 'guide.workers.xd.team/*',
      scriptName: 'pages-guide',
    },
  });

  assert.deepEqual(result, { workerCleanup: 'deferred_shared_route' });
  assert.deepEqual(calls, ['listRoutes', 'deleteRoute:route_cf_1']);
});

test('defers Worker cleanup when script deletion fails after deleting the exact route', async () => {
  const calls = [];
  const result = await cleanupLegacyV1CloudflareSite({
    env: {
      V1_CLOUDFLARE_CLIENT: {
        async listRoutes() {
          calls.push('listRoutes');
          return [{ id: 'route_cf_1', pattern: 'guide.workers.xd.team/*', script: 'pages-guide' }];
        },
        async deleteRoute({ routeId }) {
          calls.push(`deleteRoute:${routeId}`);
        },
        async deleteScript({ scriptName }) {
          calls.push(`deleteScript:${scriptName}`);
          throw new Error('cloudflare unavailable');
        },
      },
    },
    config: { environment: 'production' },
    target: {
      environment: 'production',
      slug: 'guide',
      hostname: 'guide.workers.xd.team',
      routePattern: 'guide.workers.xd.team/*',
      scriptName: 'pages-guide',
    },
  });

  assert.deepEqual(result, { workerCleanup: 'deferred_delete_failed' });
  assert.deepEqual(calls, ['listRoutes', 'deleteRoute:route_cf_1', 'deleteScript:pages-guide']);
});

test('loads all Cloudflare route pages before deleting the verified exact route', async () => {
  const requests = [];
  const env = {
    CF_ACCOUNT_ID: 'account_test',
    CF_API_TOKEN: 'token_test',
    CF_ZONE_ID_NEW: 'zone_test',
    fetch: async (url, init) => {
      requests.push({ url, method: init.method });
      if (url.includes('?page=1&')) {
        return new Response(
          JSON.stringify({
            success: true,
            result: [{ id: 'route_other', pattern: 'other.workers.xd.team/*', script: 'pages-other' }],
            result_info: { page: 1, total_pages: 2 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          success: true,
          result: [{ id: 'route_cf_1', pattern: 'guide.workers.xd.team/*', script: 'pages-guide' }],
          result_info: { page: 2, total_pages: 2 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    },
  };

  await cleanupLegacyV1CloudflareSite({
    env,
    config: { environment: 'production' },
    target: {
      environment: 'production',
      slug: 'guide',
      hostname: 'guide.workers.xd.team',
      routePattern: 'guide.workers.xd.team/*',
      scriptName: 'pages-guide',
    },
  });

  assert.deepEqual(
    requests.map(({ url, method }) => [method, url]),
    [
      ['GET', 'https://api.cloudflare.com/client/v4/zones/zone_test/workers/routes?page=1&per_page=100'],
      ['GET', 'https://api.cloudflare.com/client/v4/zones/zone_test/workers/routes?page=2&per_page=100'],
      ['DELETE', 'https://api.cloudflare.com/client/v4/zones/zone_test/workers/routes/route_cf_1'],
      ['DELETE', 'https://api.cloudflare.com/client/v4/accounts/account_test/workers/scripts/pages-guide'],
    ]
  );
});

test('refuses a production target with a staging hostname or Worker prefix', async () => {
  let deleteCount = 0;
  await assert.rejects(
    cleanupLegacyV1CloudflareSite({
      env: {
        V1_CLOUDFLARE_CLIENT: {
          async listRoutes() {
            return [];
          },
          async deleteRoute() {
            deleteCount += 1;
          },
          async deleteScript() {
            deleteCount += 1;
          },
        },
      },
      config: { environment: 'production' },
      target: {
        environment: 'production',
        slug: 'guide',
        hostname: 'guide-staging.workers.xd.team',
        routePattern: 'guide-staging.workers.xd.team/*',
        scriptName: 'pages-staging-guide',
      },
    }),
    { code: 'V1_TAKEOVER_CLEANUP_FAILED' }
  );
  assert.equal(deleteCount, 0);
});

function siteInput(overrides = {}) {
  return {
    id: 'site_1',
    slug: 'guide',
    ownerType: 'user',
    ownerId: 'usr_1',
    ownerUserId: 'usr_1',
    siteUuid: 'uuid_1',
    defaultVisibility: 'org',
    environment: 'production',
    routeId: 'route_1',
    hostname: 'guide.workers.xd.team',
    ...overrides,
  };
}

async function legacyStore() {
  const store = createTestPagesStore({ now: () => '2026-08-06T00:00:00.000Z' });
  await store.acquireHostnameClaim({
    environment: 'production',
    hostname: 'guide.workers.xd.team',
    normalizedSlug: 'guide',
    hostnameFamily: 'workers',
    ownerSystem: 'v1',
    ownerId: 'v1:production:guide',
    ownerRef: 'pages-guide',
    source: 'backfill_v1_sites',
  });
  return store;
}

function takeoverEnv({
  kvValue = {
    name: 'guide',
    token: 'pages_owner@example.com',
    scriptName: 'pages-guide',
    url: 'https://guide.workers.xd.team',
  },
  cloudflare,
  deleteError = null,
} = {}) {
  const deletes = [];
  return {
    V1_SITES: {
      async get(slug, type) {
        assert.equal(slug, 'guide');
        assert.equal(type, 'json');
        return kvValue;
      },
      async delete(slug) {
        deletes.push(slug);
        if (deleteError) throw deleteError;
      },
    },
    V1_CLOUDFLARE_CLIENT: cloudflare || {
      async listRoutes() {
        return [{ id: 'route_cf_1', pattern: 'guide.workers.xd.team/*', script: 'pages-guide' }];
      },
      async deleteRoute() {},
      async deleteScript() {},
    },
    nextId(prefix) {
      return `${prefix}_generated`;
    },
    now() {
      return '2026-08-06T00:00:00.000Z';
    },
    deletes,
  };
}

test('does not read legacy KV when normal v2 site creation succeeds', async () => {
  const store = createTestPagesStore({ now: () => '2026-08-06T00:00:00.000Z' });
  let kvReads = 0;
  const env = {
    V1_SITES: { async get() { kvReads += 1; return null; } },
    now: () => '2026-08-06T00:00:00.000Z',
  };

  const site = await createSiteWithLegacyV1Takeover({
    env,
    config: { environment: 'production', siteDomainSuffix: 'workers.xd.team' },
    store,
    actor: { type: 'user', userId: 'usr_1', email: 'owner@example.com' },
    siteInput: siteInput(),
  });

  assert.equal(site.id, 'site_1');
  assert.equal(kvReads, 0);
});

test('takes over a matching v1 site and defers only KV deletion failures', async () => {
  const store = await legacyStore();
  const env = takeoverEnv({ deleteError: new Error('kv unavailable') });

  const site = await createSiteWithLegacyV1Takeover({
    env,
    config: { environment: 'production', siteDomainSuffix: 'workers.xd.team' },
    store,
    actor: { type: 'user', userId: 'usr_1', email: 'OWNER@example.com' },
    siteInput: siteInput(),
  });

  assert.equal(site.id, 'site_1');
  assert.equal((await store.getHostnameClaim('guide.workers.xd.team')).ownerSystem, 'v2');
  const cleanupTasks = await store.listDeploymentResourceCleanupTasks({ environment: 'production' });
  assert.equal(cleanupTasks[0].resourceType, 'v1_sites_kv_record');
  assert.deepEqual(env.deletes, ['guide']);
});

test('takes over a matching v1 site while deferring a shared Worker cleanup', async () => {
  const store = await legacyStore();
  const calls = [];
  const env = takeoverEnv({
    cloudflare: {
      async listRoutes() {
        calls.push('listRoutes');
        return [
          { id: 'route_cf_1', pattern: 'guide.workers.xd.team/*', script: 'pages-guide' },
          { id: 'route_cf_2', pattern: 'docs.workers.xd.team/*', script: 'pages-guide' },
        ];
      },
      async deleteRoute({ routeId }) {
        calls.push(`deleteRoute:${routeId}`);
      },
      async deleteScript() {
        calls.push('deleteScript');
      },
    },
  });

  const site = await createSiteWithLegacyV1Takeover({
    env,
    config: { environment: 'production', siteDomainSuffix: 'workers.xd.team' },
    store,
    actor: { type: 'user', userId: 'usr_1', email: 'OWNER@example.com' },
    siteInput: siteInput(),
  });

  assert.equal(site.id, 'site_1');
  assert.equal((await store.getHostnameClaim('guide.workers.xd.team')).ownerSystem, 'v2');
  assert.deepEqual(calls, ['listRoutes', 'deleteRoute:route_cf_1']);
  const cleanupTasks = await store.listDeploymentResourceCleanupTasks({ environment: 'production' });
  assert.equal(cleanupTasks.length, 1);
  assert.equal(cleanupTasks[0].resourceType, 'v1_worker_script');
  assert.equal(cleanupTasks[0].resourceRef, 'pages-guide');
  assert.equal(cleanupTasks[0].cleanupReason, 'v1_email_takeover_shared_route');
  assert.doesNotMatch(JSON.stringify(cleanupTasks[0]), /owner@example\.com|pages_owner/);
});

test('takes over a matching v1 site when Worker deletion must be retried', async () => {
  const store = await legacyStore();
  const env = takeoverEnv({
    cloudflare: {
      async listRoutes() {
        return [{ id: 'route_cf_1', pattern: 'guide.workers.xd.team/*', script: 'pages-guide' }];
      },
      async deleteRoute() {},
      async deleteScript() {
        throw new Error('cloudflare unavailable');
      },
    },
  });

  const site = await createSiteWithLegacyV1Takeover({
    env,
    config: { environment: 'production', siteDomainSuffix: 'workers.xd.team' },
    store,
    actor: { type: 'user', userId: 'usr_1', email: 'OWNER@example.com' },
    siteInput: siteInput(),
  });

  assert.equal(site.id, 'site_1');
  assert.equal((await store.getHostnameClaim('guide.workers.xd.team')).ownerSystem, 'v2');
  const cleanupTasks = await store.listDeploymentResourceCleanupTasks({ environment: 'production' });
  assert.equal(cleanupTasks.length, 1);
  assert.equal(cleanupTasks[0].resourceType, 'v1_worker_script');
  assert.equal(cleanupTasks[0].resourceRef, 'pages-guide');
  assert.equal(cleanupTasks[0].cleanupReason, 'v1_email_takeover_worker_delete_failed');
});

test('keeps v1 state and performs no destructive call when ownership email differs', async () => {
  const store = await legacyStore();
  let destructiveCalls = 0;
  const env = takeoverEnv({
    kvValue: {
      name: 'guide',
      token: 'pages_other@example.com',
      scriptName: 'pages-guide',
      url: 'https://guide.workers.xd.team',
    },
    cloudflare: {
      async listRoutes() { destructiveCalls += 1; return []; },
      async deleteRoute() { destructiveCalls += 1; },
      async deleteScript() { destructiveCalls += 1; },
    },
  });

  await assert.rejects(
    createSiteWithLegacyV1Takeover({
      env,
      config: { environment: 'production', siteDomainSuffix: 'workers.xd.team' },
      store,
      actor: { type: 'user', userId: 'usr_1', email: 'owner@example.com' },
      siteInput: siteInput(),
    }),
    { code: 'HOSTNAME_CLAIM_CONFLICT' }
  );
  assert.equal(destructiveCalls, 0);
  assert.equal((await store.getHostnameClaim('guide.workers.xd.team')).ownerSystem, 'v1');
});

test('preserves v1 claim when Cloudflare cleanup fails', async () => {
  const store = await legacyStore();
  const cleanupError = new Error('cloudflare unavailable');
  cleanupError.code = 'V1_TAKEOVER_CLEANUP_FAILED';
  const env = takeoverEnv({
    cloudflare: {
      async listRoutes() { throw cleanupError; },
    },
  });

  await assert.rejects(
    createSiteWithLegacyV1Takeover({
      env,
      config: { environment: 'production', siteDomainSuffix: 'workers.xd.team' },
      store,
      actor: { type: 'user', userId: 'usr_1', email: 'owner@example.com' },
      siteInput: siteInput(),
    }),
    { code: 'V1_TAKEOVER_CLEANUP_FAILED' }
  );
  assert.equal(await store.getSite('site_1'), null);
  assert.equal((await store.getHostnameClaim('guide.workers.xd.team')).ownerSystem, 'v1');
});

test('maps legacy KV read failures to a closed takeover configuration error', async () => {
  const store = await legacyStore();
  let cloudflareCalls = 0;
  const env = takeoverEnv({
    cloudflare: {
      async listRoutes() {
        cloudflareCalls += 1;
        return [];
      },
    },
  });
  env.V1_SITES.get = async () => {
    throw new Error('raw KV metadata failure');
  };

  await assert.rejects(
    createSiteWithLegacyV1Takeover({
      env,
      config: { environment: 'production', siteDomainSuffix: 'workers.xd.team' },
      store,
      actor: { type: 'user', userId: 'usr_1', email: 'owner@example.com' },
      siteInput: siteInput(),
    }),
    { code: 'V1_TAKEOVER_CONFIG_UNAVAILABLE' }
  );
  assert.equal(cloudflareCalls, 0);
  assert.equal((await store.getHostnameClaim('guide.workers.xd.team')).ownerSystem, 'v1');
});
