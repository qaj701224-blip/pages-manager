import assert from 'node:assert/strict';
import test from 'node:test';

import { buildSiteOwnerTransferAuditEvent } from './build-owner-transfer-audit-event.js';

test('buildSiteOwnerTransferAuditEvent builds the stable audit record from explicit application inputs', () => {
  assert.deepEqual(
    buildSiteOwnerTransferAuditEvent({
      id: 'aud_1',
      environment: 'production',
      actor: { type: 'user', userId: 'usr_actor' },
      site: {
        id: 'site_1',
        slug: 'demo',
        ownerType: 'user',
        ownerId: 'usr_old',
        route: { id: 'route_1' },
      },
      target: { ownerType: 'team', ownerId: 'team_1' },
      source: 'console',
      createdAt: '2026-08-21T00:00:00.000Z',
    }),
    {
      id: 'aud_1',
      environment: 'production',
      traceId: null,
      eventType: 'site.owner.transfer',
      actorUserId: 'usr_actor',
      actorType: 'user',
      siteId: 'site_1',
      routeId: 'route_1',
      versionId: null,
      decision: 'allow',
      statusCode: 200,
      ipHash: null,
      userAgentHash: null,
      metadata: {
        siteSlug: 'demo',
        fromOwner: { type: 'user', id: 'usr_old' },
        toOwner: { type: 'team', id: 'team_1' },
        source: 'console',
      },
      createdAt: '2026-08-21T00:00:00.000Z',
    }
  );
});
