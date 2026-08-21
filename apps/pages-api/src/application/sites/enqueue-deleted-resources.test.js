import assert from 'node:assert/strict';
import test from 'node:test';

import { createEnqueueDeletedSiteResources } from './enqueue-deleted-resources.js';

test('deleted-site cleanup preserves resource precedence and version identity', async () => {
  const tasks = [];
  let id = 0;
  let now = 0;
  const enqueue = createEnqueueDeletedSiteResources({
    cleanupTasks: {
      async listSiteWfpCleanupReferences() {
        return {
          activeRoutes: [
            managedResource({ workerName: 'pages-v2-shared', siteId: 'site_route', versionId: 'version_route' }),
            managedResource({ workerName: 'pages-v2-route-only', siteId: 'site_route_only', versionId: 'version_route_only' }),
            { workerName: 'normal-worker', siteId: 'site_unmanaged', versionId: 'version_unmanaged' },
          ],
          versions: [
            managedResource({ workerName: 'pages-v2-shared', siteId: 'site_version', id: 'version_record' }),
            managedResource({ workerName: 'pages-v2-version-only', siteId: 'site_version_only', id: 'version_only' }),
          ],
        };
      },
      async createDeploymentResourceCleanupTask(task) {
        tasks.push(task);
      },
    },
    isManagedResource: (candidate) => candidate?.executionProvider === 'wfp',
    ids: { next: () => `cln_${++id}` },
    clock: { now: () => `2027-01-15T08:00:0${++now}.000Z` },
  });

  await enqueue({
    environment: 'production',
    site: { id: 'site_original' },
    previousRoute: managedResource({
      workerName: 'pages-v2-previous-only',
      activeVersionId: 'version_active',
    }),
    cleanupAfter: '2027-01-15T08:05:00.000Z',
  });

  assert.deepEqual(
    tasks.map(({ resourceRef, siteId, versionId }) => ({ resourceRef, siteId, versionId })),
    [
      { resourceRef: 'pages-v2-previous-only', siteId: 'site_original', versionId: 'version_active' },
      { resourceRef: 'pages-v2-shared', siteId: 'site_version', versionId: 'version_record' },
      { resourceRef: 'pages-v2-route-only', siteId: 'site_route_only', versionId: 'version_route_only' },
      { resourceRef: 'pages-v2-version-only', siteId: 'site_version_only', versionId: 'version_only' },
    ]
  );
  assert.deepEqual(
    tasks.map(({ id: taskId, createdAt, updatedAt }) => ({ taskId, createdAt, updatedAt })),
    [
      { taskId: 'cln_1', createdAt: '2027-01-15T08:00:01.000Z', updatedAt: '2027-01-15T08:00:02.000Z' },
      { taskId: 'cln_2', createdAt: '2027-01-15T08:00:03.000Z', updatedAt: '2027-01-15T08:00:04.000Z' },
      { taskId: 'cln_3', createdAt: '2027-01-15T08:00:05.000Z', updatedAt: '2027-01-15T08:00:06.000Z' },
      { taskId: 'cln_4', createdAt: '2027-01-15T08:00:07.000Z', updatedAt: '2027-01-15T08:00:08.000Z' },
    ]
  );
});

function managedResource(values) {
  return { executionProvider: 'wfp', dispatchType: 'dispatch-namespace', ...values };
}
