import assert from 'node:assert/strict';
import test from 'node:test';

import { createRollbackRouteStateRead } from './read-rollback-route-state.js';

const command = { siteId: 'site_1', environment: 'production' };
const telemetry = { failed: async () => null };

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
    telemetry,
  });

  assert.deepEqual(await application.read(command), { ok: true, route });
  assert.deepEqual(calls, [['site_1', 'production']]);
});

test('rollback route state read distinguishes a missing route from a store failure', async () => {
  const missing = createRollbackRouteStateRead({ routes: { getBySiteId: async () => null }, telemetry });
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
    telemetry,
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

test('rollback route state read requires its route and telemetry capabilities', () => {
  assert.throws(() => createRollbackRouteStateRead({ routes: {}, telemetry }), /routes\.getBySiteId is required/);
  assert.throws(
    () => createRollbackRouteStateRead({ routes: { getBySiteId: async () => null }, telemetry: {} }),
    /telemetry\.failed is required/
  );
});

test('rollback route state read records typed failures after the authoritative read', async () => {
  const calls = [];
  const tracedTelemetry = {
    async failed(error) {
      calls.push(['failed', error]);
    },
  };
  const missing = createRollbackRouteStateRead({
    routes: {
      async getBySiteId() {
        calls.push(['read']);
        return null;
      },
    },
    telemetry: tracedTelemetry,
  });
  const missingResult = await missing.read(command);
  assert.deepEqual(calls.splice(0), [['read'], ['failed', missingResult.error]]);

  const cause = new Error('route store unavailable');
  const failed = createRollbackRouteStateRead({
    routes: {
      async getBySiteId() {
        calls.push(['read']);
        throw cause;
      },
    },
    telemetry: tracedTelemetry,
  });
  const failedResult = await failed.read(command);
  assert.deepEqual(calls, [['read'], ['failed', failedResult.error]]);
});
