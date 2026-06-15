import assert from 'node:assert/strict';
import test from 'node:test';

import { buildRouteSnapshot, writeRouteSnapshot } from './route-snapshot.js';

test('builds immutable route snapshot from authority records', () => {
  const snapshot = buildRouteSnapshot({
    site: { id: 'site_1', slug: 'docs', siteUuid: 'uuid_1' },
    route: {
      id: 'route_1',
      hostname: 'docs.pages.xd.team',
      environment: 'production',
      runtime: 'wfp',
      workerName: 'pages-v2-docs-ver-1',
      activeVersionId: 'ver_1',
      visibility: 'org',
      policyVersion: 1,
      routeGeneration: 2,
      routeStatus: 'active',
      cacheTier: 'fast',
    },
    version: {
      id: 'ver_1',
      artifactKind: 'worker',
      contentHash: 'sha256:abc',
    },
  });

  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    routeId: 'route_1',
    hostname: 'docs.pages.xd.team',
    environment: 'production',
    siteId: 'site_1',
    siteUuid: 'uuid_1',
    slug: 'docs',
    runtime: 'wfp',
    workerName: 'pages-v2-docs-ver-1',
    activeVersionId: 'ver_1',
    artifactKind: 'worker',
    contentHash: 'sha256:abc',
    visibility: 'org',
    policyVersion: 1,
    routeGeneration: 2,
    routeStatus: 'active',
    cacheTier: 'fast',
  });
});

test('writes immutable snapshot and pointer records', async () => {
  const writes = new Map();
  const snapshot = buildRouteSnapshot({
    site: { id: 'site_1', slug: 'docs', siteUuid: 'uuid_1' },
    route: {
      id: 'route_1',
      hostname: 'docs.pages.xd.team',
      environment: 'production',
      runtime: 'wfp',
      workerName: 'pages-v2-docs-ver-1',
      activeVersionId: 'ver_1',
      visibility: 'org',
      policyVersion: 1,
      routeGeneration: 2,
      routeStatus: 'active',
      cacheTier: 'fast',
    },
    version: {
      id: 'ver_1',
      artifactKind: 'worker',
      contentHash: 'sha256:abc',
    },
  });

  await writeRouteSnapshot(
    {
      put: async (key, value) => writes.set(key, JSON.parse(value)),
    },
    snapshot
  );

  assert.equal(writes.get('route_snapshot:docs.pages.xd.team:2').activeVersionId, 'ver_1');
  assert.deepEqual(writes.get('route_pointer:docs.pages.xd.team'), {
    hostname: 'docs.pages.xd.team',
    routeGeneration: 2,
    snapshotKey: 'route_snapshot:docs.pages.xd.team:2',
  });
});
