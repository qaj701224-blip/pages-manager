import assert from 'node:assert/strict';
import test from 'node:test';

import { createAuditEventsQuery } from './list-audit-events.js';

test('audit events query reads one environment and orders tied governance stages deterministically', async () => {
  const calls = [];
  const application = createAuditEventsQuery({
    audits: {
      async list(input) {
        calls.push(['list', input]);
        return [
          auditEvent('audit_attempted', '2026-08-21T00:00:00.000Z', 'attempted'),
          auditEvent('audit_older', '2026-08-20T00:00:00.000Z', 'effective_success'),
          auditEvent('audit_committed', '2026-08-21T00:00:00.000Z', 'policy_committed'),
          auditEvent('audit_success', '2026-08-21T00:00:00.000Z', 'effective_success'),
        ];
      },
    },
    metadata: { sanitize: (value) => ({ ...value, sanitized: true }) },
  });

  const events = await application.list({ environment: 'production' });

  assert.deepEqual(events.map((event) => event.id), [
    'audit_success',
    'audit_committed',
    'audit_attempted',
    'audit_older',
  ]);
  assert.deepEqual(calls, [['list', { environment: 'production' }]]);
  assert.equal(events[0].metadata.sanitized, true);
});

test('audit events query projects actor, resource correlation, and sanitized metadata', async () => {
  const metadata = { workerName: 'secret-worker' };
  const application = createAuditEventsQuery({
    audits: {
      list: async () => [
        {
          id: 'audit_1',
          eventType: 'admin.site.exposure',
          traceId: 'trace_1',
          actorUserId: 'usr_1',
          actorType: 'platform_admin',
          actor: { displayName: 'Admin', email: 'admin@example.com' },
          siteId: 'site_1',
          routeId: 'route_1',
          versionId: 'ver_1',
          decision: 'allow',
          statusCode: 200,
          metadata,
          createdAt: '2026-08-21T00:00:00.000Z',
        },
      ],
    },
    metadata: {
      sanitize(input) {
        assert.equal(input, metadata);
        return { workerName: '[REDACTED]' };
      },
    },
  });

  assert.deepEqual(await application.list({ environment: 'production' }), [
    {
      id: 'audit_1',
      eventType: 'admin.site.exposure',
      traceId: 'trace_1',
      actorUserId: 'usr_1',
      actorType: 'platform_admin',
      actor: {
        type: 'platform_admin',
        userId: 'usr_1',
        displayName: 'Admin',
        email: 'admin@example.com',
      },
      siteId: 'site_1',
      routeId: 'route_1',
      versionId: 'ver_1',
      decision: 'allow',
      statusCode: 200,
      metadata: { workerName: '[REDACTED]' },
      createdAt: '2026-08-21T00:00:00.000Z',
    },
  ]);
});

test('audit events query requires its narrow repository and sanitizer', () => {
  assert.throws(() => createAuditEventsQuery({ audits: {}, metadata: {} }), /audits\.list is required/);
});

function auditEvent(id, createdAt, stage) {
  return {
    id,
    eventType: 'admin.site.exposure',
    actorType: 'platform_admin',
    decision: 'allow',
    metadata: { operationId: 'op_1', stage },
    createdAt,
  };
}
