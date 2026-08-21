import assert from 'node:assert/strict';
import test from 'node:test';

import { createV1SitesQuery } from './list-v1-sites.js';

test('v1 sites query joins Cloudflare inventory with environment-scoped active sites', async () => {
  const calls = [];
  const siteKeys = [{ name: 'legacy-site' }];
  const workers = [{ name: 'pages-legacy-site' }];
  const activeV2Sites = [{ slug: 'legacy-site' }];
  const reservedWorkerNames = new Set(['pages-manager']);
  const query = createV1SitesQuery({
    inventory: {
      listSites: async () => (calls.push('siteKeys'), siteKeys),
      listWorkers: async () => (calls.push('workers'), workers),
    },
    sites: {
      listActiveSlugs: async (input) => (calls.push(['activeV2Sites', input]), activeV2Sites),
    },
    projection: {
      formatSites: (input) => (calls.push(['formatSites', input]), ['site-projection']),
      formatUnregisteredWorkers: (input) => (calls.push(['formatWorkers', input]), ['worker-projection']),
    },
  });

  const result = await query.list({ environment: 'production', reservedWorkerNames });

  assert.deepEqual(result, {
    sites: ['site-projection'],
    unregisteredWorkers: ['worker-projection'],
  });
  assert.deepEqual(calls.find((item) => Array.isArray(item) && item[0] === 'activeV2Sites')[1], {
    environment: 'production',
  });
  const siteProjection = calls.find((item) => Array.isArray(item) && item[0] === 'formatSites')[1];
  assert.deepEqual(siteProjection, {
    siteKeys,
    workers,
    activeV2Sites,
    environment: 'production',
    reservedWorkerNames,
  });
  assert.ok(calls.indexOf('siteKeys') < calls.findIndex((item) => Array.isArray(item) && item[0] === 'formatSites'));
  assert.ok(calls.indexOf('workers') < calls.findIndex((item) => Array.isArray(item) && item[0] === 'formatSites'));
});

test('v1 sites query requires narrow inventory, site, and projection ports', () => {
  assert.throws(() => createV1SitesQuery({ inventory: {}, sites: {}, projection: {} }), /inventory\.listSites is required/);
});
