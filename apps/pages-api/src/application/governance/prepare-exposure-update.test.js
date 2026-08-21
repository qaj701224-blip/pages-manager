import assert from 'node:assert/strict';
import test from 'node:test';

import { createExposureUpdatePreparation } from './prepare-exposure-update.js';

const command = {
  environment: 'production',
  actorUserId: 'usr_admin',
  site: {
    id: 'site_1',
    slug: 'example',
    defaultExposure: 'internal',
    route: { id: 'route_1', exposure: 'internal' },
  },
  exposure: 'public',
  reason: 'Public launch review',
};

test('exposure update preparation creates one correlated operation and required attempted audit', async () => {
  const calls = [];
  const application = createExposureUpdatePreparation({
    audits: {
      async record(input) {
        calls.push(['audit', input]);
      },
    },
    ids: { next: (prefix) => (calls.push(['id', prefix]), 'op_1') },
    clock: { now: () => (calls.push(['now']), '2026-08-21T00:00:00.000Z') },
  });

  assert.deepEqual(await application.prepare(command), {
    ok: true,
    context: {
      operationId: 'op_1',
      now: '2026-08-21T00:00:00.000Z',
      auditMetadata: {
        operationId: 'op_1',
        siteSlug: 'example',
        previousExposure: 'internal',
        requestedExposure: 'public',
        reason: 'Public launch review',
        source: 'console-admin',
      },
    },
  });
  assert.deepEqual(calls, [
    ['id', 'op'],
    ['now'],
    [
      'audit',
      {
        id: 'op_1:attempted',
        environment: 'production',
        traceId: 'op_1',
        eventType: 'admin.site.exposure',
        actorUserId: 'usr_admin',
        actorType: 'platform_admin',
        siteId: 'site_1',
        routeId: 'route_1',
        decision: 'allow',
        statusCode: 202,
        metadata: {
          operationId: 'op_1',
          siteSlug: 'example',
          previousExposure: 'internal',
          requestedExposure: 'public',
          reason: 'Public launch review',
          source: 'console-admin',
          stage: 'attempted',
        },
        createdAt: '2026-08-21T00:00:00.000Z',
      },
    ],
  ]);
});

test('exposure update preparation fails closed when the required audit cannot be persisted', async () => {
  const cause = new Error('audit unavailable');
  const application = createExposureUpdatePreparation({
    audits: { record: async () => Promise.reject(cause) },
    ids: { next: () => 'op_1' },
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
  });

  assert.deepEqual(await application.prepare(command), {
    ok: false,
    error: { reason: 'required_audit_failed', cause },
  });
});

test('exposure update preparation requires narrow audit, id, and clock ports', () => {
  assert.throws(
    () => createExposureUpdatePreparation({ audits: {}, ids: {}, clock: {} }),
    /audits\.record is required/
  );
});
