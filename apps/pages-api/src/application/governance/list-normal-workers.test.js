import assert from 'node:assert/strict';
import test from 'node:test';

import { createNormalWorkersQuery, projectNormalWorker } from './list-normal-workers.js';

test('normal workers query reads one environment and projects lifecycle state', async () => {
  const calls = [];
  const idle = worker({ id: 'slot_1', status: 'available' });
  const active = worker({
    id: 'slot_2',
    status: 'assigned',
    activeRoute: {
      siteId: 'site_1',
      routeId: 'route_1',
      activeVersionId: 'ver_1',
      hostname: 'example.workers.xd.team',
      secret: 'must-not-return',
    },
  });
  const application = createNormalWorkersQuery({
    workers: { list: async (input) => (calls.push(input), [idle, active]) },
  });

  const result = await application.list({ environment: 'production' });

  assert.deepEqual(calls, [{ environment: 'production' }]);
  assert.deepEqual(result.map((item) => [item.id, item.lifecycle, item.canDelete]), [
    ['slot_1', 'idle', true],
    ['slot_2', 'active', false],
  ]);
  assert.deepEqual(result[1].activeRoute, {
    siteId: 'site_1',
    routeId: 'route_1',
    activeVersionId: 'ver_1',
    hostname: 'example.workers.xd.team',
  });
});

test('normal worker projection preserves retired and unknown lifecycle states', () => {
  assert.equal(projectNormalWorker(worker({ status: 'retired' })).lifecycle, 'retired');
  assert.equal(projectNormalWorker(worker({ status: 'provisioning' })).lifecycle, 'provisioning');
  assert.equal(projectNormalWorker(worker({ status: 'delete_pending' })).lifecycle, 'idle');
});

test('normal workers query requires its narrow repository', () => {
  assert.throws(() => createNormalWorkersQuery({ workers: {} }), /workers\.list is required/);
});

function worker(overrides = {}) {
  return {
    id: 'slot_1',
    environment: 'production',
    slotNumber: 1,
    workerName: 'pages-v2-production-slot-001',
    bindingName: 'SITE_SLOT_001',
    status: 'available',
    updatedAt: '2026-08-21T00:00:00.000Z',
    activeRoute: null,
    ...overrides,
  };
}
