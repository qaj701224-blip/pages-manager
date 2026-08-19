import assert from 'node:assert/strict';
import test from 'node:test';

import {
  auditActorView,
  auditEventLabel,
  auditMetadataSummary,
  filterAuditEvents,
  serializeAuditMetadata,
} from './admin-audit-model.js';

test('audit actor view prefers SSO realname over generic user label', () => {
  assert.deepEqual(
    auditActorView({
      actorType: 'user',
      actorUserId: 'usr_actor',
      actor: {
        type: 'user',
        userId: 'usr_actor',
        displayName: '徐天麒',
        email: 'actor@example.com',
      },
    }),
    {
      primary: '徐天麒',
      secondary: 'actor@example.com',
    }
  );
});

test('audit filtering searches actor display name and email', () => {
  const events = [
    {
      id: 'audit_1',
      eventType: 'site.publish',
      actorType: 'user',
      actorUserId: 'usr_actor',
      actor: {
        displayName: '徐天麒',
        email: 'actor@example.com',
      },
      decision: 'allow',
      metadata: {
        siteSlug: 'demo',
      },
    },
  ];

  assert.deepEqual(filterAuditEvents(events, { query: '徐天麒', decision: 'all' }), events);
  assert.deepEqual(filterAuditEvents(events, { query: 'actor@example.com', decision: 'all' }), events);
});

test('audit metadata summary distinguishes stages from the same operation', () => {
  assert.equal(
    auditMetadataSummary({
      eventType: 'admin.site.exposure',
      metadata: {
        operationId: 'op_public',
        siteSlug: 'public',
        reason: 'staging verification',
        stage: 'policy_committed',
      },
    }),
    'stage: policy_committed · siteSlug: public'
  );
});

test('audit labels keep Chinese title and stable enum', () => {
  assert.deepEqual(auditEventLabel('site.owner.transfer'), {
    title: '转移站点归属',
    technical: 'site.owner.transfer',
  });
  assert.deepEqual(auditEventLabel('future.event'), {
    title: 'future.event',
    technical: 'future.event',
  });
  assert.deepEqual(auditEventLabel('site_secret.put'), {
    title: '更新站点 Secret',
    technical: 'site_secret.put',
  });
  assert.deepEqual(auditEventLabel('site.v1_takeover'), {
    title: '接管 v1 同名站点',
    technical: 'site.v1_takeover',
  });
  assert.deepEqual(auditEventLabel('admin.site.exposure'), {
    title: '调整站点公网暴露',
    technical: 'admin.site.exposure',
  });
});

test('audit summaries reflect nested owner, merge counts, and v1 retire metadata', () => {
  assert.equal(
    auditMetadataSummary({
      eventType: 'site.owner.transfer',
      metadata: {
        siteSlug: 'demo',
        fromOwner: { type: 'user', id: 'u1' },
        toOwner: { type: 'team', id: 't1' },
      },
    }),
    'demo；user:u1 → team:t1'
  );
  assert.equal(
    auditMetadataSummary({
      eventType: 'admin.department_team.merge',
      metadata: {
        sourceTeamId: 'team_a',
        targetTeamId: 'team_b',
        counts: { sites: 2, accessKeys: 1, members: 5 },
      },
    }),
    'team_a → team_b；站点 2 / Access Key 1 / 成员 5'
  );
  assert.equal(
    auditMetadataSummary({
      eventType: 'admin.v1_site_retire',
      metadata: { siteName: 'demo', workerName: 'pages-demo', hostname: 'demo.workers.xd.team', stage: 'kv_delete' },
    }),
    'demo；阶段 kv_delete；demo.workers.xd.team'
  );
});

test('unknown audit summaries prefer top-level resource ids', () => {
  assert.equal(
    auditMetadataSummary({
      eventType: 'future.event',
      siteId: 'site_1',
      routeId: 'route_1',
      versionId: 'ver_1',
      metadata: { reason: 'future shape' },
    }),
    'siteId: site_1 · routeId: route_1'
  );
});

test('audit metadata serialization preserves null', () => {
  assert.equal(serializeAuditMetadata(null), 'null');
  assert.equal(serializeAuditMetadata({ stage: 'done' }), '{\n  "stage": "done"\n}');
});

test('audit search includes resource ids and sanitized metadata', () => {
  const events = [
    {
      id: 'audit_1',
      eventType: 'site.deleted',
      actorType: 'user',
      actorUserId: 'usr_1',
      siteId: 'site_1',
      routeId: 'route_1',
      versionId: null,
      decision: 'allow',
      metadata: { siteSlug: 'demo', nested: { reason: 'owner request' } },
    },
  ];
  assert.equal(filterAuditEvents(events, { query: 'route_1', decision: 'all' }).length, 1);
  assert.equal(filterAuditEvents(events, { query: 'owner request', decision: 'all' }).length, 1);
});
