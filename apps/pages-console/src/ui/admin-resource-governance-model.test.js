import assert from 'node:assert/strict';
import test from 'node:test';

import {
  filterV1Sites,
  filterWorkerOrphanScanWorkers,
  formatCleanupBacklogAge,
  isV1SiteStale,
} from './admin-resource-governance-model.js';

const NOW = '2026-08-05T00:00:00.000Z';

test('v1 stale detection uses the inclusive 180 day boundary and ignores invalid dates', () => {
  assert.equal(isV1SiteStale('2026-02-06T00:00:00.000Z', NOW), true);
  assert.equal(isV1SiteStale('2026-02-06T00:00:00.001Z', NOW), false);
  assert.equal(isV1SiteStale('', NOW), false);
  assert.equal(isV1SiteStale('not-a-date', NOW), false);
});

test('v1 site inventory filters by searchable fields and governance classification', () => {
  const sites = [
    {
      name: 'docs',
      url: 'https://docs.workers.xd.team',
      preset: 'spa',
      updatedAt: '2026-02-06T00:00:00.000Z',
      workerName: 'pages-docs',
      migratedCandidate: true,
    },
    {
      name: 'recent',
      url: 'https://recent.workers.xd.team',
      preset: 'worker',
      updatedAt: '2026-08-01T00:00:00.000Z',
      workerName: 'pages-recent',
      migratedCandidate: false,
    },
    {
      name: 'unknown-date',
      url: '',
      preset: null,
      updatedAt: null,
      workerName: null,
      migratedCandidate: false,
    },
  ];

  assert.deepEqual(
    filterV1Sites(sites, { query: 'PAGES-DOCS', filter: 'all', now: NOW }).map((site) => site.name),
    ['docs']
  );
  assert.deepEqual(
    filterV1Sites(sites, { query: '', filter: 'stale', now: NOW }).map((site) => site.name),
    ['docs']
  );
  assert.deepEqual(
    filterV1Sites(sites, { query: '', filter: 'migrated', now: NOW }).map((site) => site.name),
    ['docs']
  );
});

test('orphan scan filters by every classification and orphan reason', () => {
  const workers = [
    { name: 'route', referencedByActiveRoute: true },
    { name: 'rollback', rollbackEligibleVersion: true },
    { name: 'cleanup', hasPendingCleanupTask: true },
    { name: 'unknown', orphanCandidate: true, orphanReason: 'no_d1_reference' },
    { name: 'deleted', orphanCandidate: true, orphanReason: 'deleted_site' },
    { name: 'stale', orphanCandidate: true, orphanReason: 'stale_previous_version' },
  ];

  assert.deepEqual(
    filterWorkerOrphanScanWorkers(workers, 'active_route').map((item) => item.name),
    ['route']
  );
  assert.deepEqual(
    filterWorkerOrphanScanWorkers(workers, 'rollback').map((item) => item.name),
    ['rollback']
  );
  assert.deepEqual(
    filterWorkerOrphanScanWorkers(workers, 'cleanup').map((item) => item.name),
    ['cleanup']
  );
  assert.deepEqual(
    filterWorkerOrphanScanWorkers(workers, 'orphan').map((item) => item.name),
    ['unknown', 'deleted', 'stale']
  );
  assert.deepEqual(
    filterWorkerOrphanScanWorkers(workers, 'deleted_site').map((item) => item.name),
    ['deleted']
  );
});

test('cleanup backlog age formats dashboard values without turning missing scans into zero', () => {
  assert.equal(formatCleanupBacklogAge(null), '—');
  assert.equal(formatCleanupBacklogAge(0), '0 分钟');
  assert.equal(formatCleanupBacklogAge(59), '< 1 分钟');
  assert.equal(formatCleanupBacklogAge(3600), '1 小时');
  assert.equal(formatCleanupBacklogAge(90000), '1 天 1 小时');
});
