import assert from 'node:assert/strict';
import test from 'node:test';

import { auditActorView, filterAuditEvents } from './admin-audit-model.js';

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
