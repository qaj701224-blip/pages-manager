import assert from 'node:assert/strict';
import test from 'node:test';

import { createRollbackRouteStateRead } from './read-rollback-route-state.js';

const command = { siteId: 'site_1', environment: 'production' };

test('rollback route state read returns the authoritative route through its narrow capability', async () => {
  const route = { id: 'route_1', activeVersionId: 'ver_2' };
  const calls = [];
  const application = createRollbackRouteStateRead({
    routes: {
      async getBySiteId(siteId, environment) {
        calls.push([siteId, environment]);
        return route;
      },
    },
  });

  assert.deepEqual(await application.read(command), { ok: true, route });
  assert.deepEqual(calls, [['site_1', 'production']]);
});

test('rollback route state read distinguishes a missing route from a store failure', async () => {
  const missing = createRollbackRouteStateRead({ routes: { getBySiteId: async () => null } });
  assert.deepEqual(await missing.read(command), {
    ok: false,
    error: {
      code: 'ROUTE_ACTIVATION_CONFLICT',
      reason: 'route_missing',
    },
  });

  const cause = new Error('route store unavailable');
  const failed = createRollbackRouteStateRead({
    routes: {
      getBySiteId: async () => {
        throw cause;
      },
    },
  });
  assert.deepEqual(await failed.read(command), {
    ok: false,
    error: {
      code: 'ROLLBACK_ACTIVATION_FAILED',
      reason: 'route_read_failed',
      cause,
    },
  });
});

test('rollback route state read requires its route capability', () => {
  assert.throws(() => createRollbackRouteStateRead({ routes: {} }), /routes\.getBySiteId is required/);
});
