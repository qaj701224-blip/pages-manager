import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayApp } from '../../../apps/gateway/src/index.js';
import { readSlackSessionConfig } from '../../../apps/gateway/src/slack-session.js';
import { MemoryGatewayStore } from '../../../apps/gateway/src/store.js';

async function json(response) {
  return response.json();
}

function slackEvent({ eventId, user = 'U1', channel = 'D1', channelType = 'im', ts, threadTs, text }) {
  return {
    team_id: 'T1',
    event_id: eventId,
    event: {
      type: channelType === 'im' ? 'message' : 'app_mention',
      user,
      channel,
      channel_type: channelType,
      ts,
      ...(threadTs ? { thread_ts: threadTs } : {}),
      text,
    },
  };
}

async function postSlack(app, payload, env = {}) {
  return json(
    await app.fetch(
      new Request('http://gateway.test/integrations/slack/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }),
      env
    )
  );
}

test('Slack sessions are isolated by user and channel thread', async () => {
  const app = createGatewayApp();

  const first = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-thread-1',
      channel: 'C1',
      channelType: 'channel',
      ts: '1710000000.000100',
      text: 'issue: 给 smoke/profile 做一个个人主页',
    })
  );
  const second = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-thread-2',
      channel: 'C1',
      channelType: 'channel',
      ts: '1710000001.000100',
      text: 'issue: 给 smoke/blog 做一个博客页',
    })
  );
  const otherUser = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-thread-3',
      user: 'U2',
      channel: 'C1',
      channelType: 'channel',
      ts: '1710000000.000200',
      threadTs: '1710000000.000100',
      text: 'issue: 我也要一个页面',
    })
  );

  assert.notEqual(first.slackSessionId, second.slackSessionId);
  assert.notEqual(first.slackSessionId, otherUser.slackSessionId);

  const userOneSessions = app.store.findSlackSessionsForUser('T1', 'U1');
  const userTwoSessions = app.store.findSlackSessionsForUser('T1', 'U2');
  assert.equal(userOneSessions.length, 2);
  assert.equal(userTwoSessions.length, 1);
  assert.deepEqual(
    userOneSessions.map((session) => session.sessionKey).sort(),
    ['thread:C1:1710000000.000100', 'thread:C1:1710000001.000100']
  );
  assert.equal(userTwoSessions[0].sessionKey, 'thread:C1:1710000000.000100');
});

test('DM messages with multiple active sessions ask the user to choose', async () => {
  const app = createGatewayApp();

  await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-dm-1',
      ts: '1710000000.000100',
      text: 'issue: 做一个项目展示页',
    })
  );
  await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-dm-2',
      ts: '1710000001.000100',
      text: 'issue: 做一个招聘落地页',
    })
  );

  const ambiguous = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-dm-3',
      ts: '1710000002.000100',
      text: '这个 preview 不满意',
    })
  );

  assert.equal(ambiguous.accepted, false);
  assert.equal(ambiguous.action, 'ambiguous_active_dm_sessions');
  assert.match(ambiguous.replyText, /多个最近的会话/);
  assert.equal(ambiguous.sessions.length, 2);
});

test('expired active context is not selected by default even when it is recent', async () => {
  const app = createGatewayApp();
  const created = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-expire-1',
      ts: '1710000000.000100',
      text: 'issue: 做一个个人主页',
    }),
    { SLACK_AGENT_ACTIVE_CONTEXT_TTL_HOURS: '12' }
  );

  const session = app.store.getSlackSession(created.slackSessionId);
  app.store.upsertSlackSession(
    {
      ...session,
      activeContextExpiresAt: '2026-06-10T00:00:00.000Z',
      lastActiveAt: '2026-06-11T00:00:00.000Z',
    },
    new Date('2026-06-11T00:00:00.000Z')
  );

  const response = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-expire-2',
      ts: '1710000001.000100',
      text: '刚才那个继续',
    }),
    { SLACK_AGENT_ACTIVE_CONTEXT_TTL_HOURS: '12' }
  );

  assert.equal(response.accepted, false);
  assert.equal(response.action, 'ambiguous_recent_dm_sessions');
  assert.match(response.replyText, /session: sess_xxx/);
});

test('Slack Agent lease prevents concurrent runs in the same session', () => {
  const store = new MemoryGatewayStore();
  const config = readSlackSessionConfig({ SLACK_AGENT_SESSION_LEASE_SECONDS: '180' });
  const session = store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1:current',
    activeContextExpiresAt: '2026-06-12T12:00:00.000Z',
  });

  const first = store.acquireSlackAgentLease(session.id, config, new Date('2026-06-12T00:00:00.000Z'));
  const second = store.acquireSlackAgentLease(session.id, config, new Date('2026-06-12T00:00:01.000Z'));

  assert.equal(first.acquired, true);
  assert.equal(second.acquired, false);
  assert.equal(second.agentRun.id, first.agentRun.id);
});

test('executor callbacks keep IssueLink and SlackSession active target in sync', async () => {
  const app = createGatewayApp();
  const created = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-link-1',
      ts: '1710000000.000100',
      text: 'issue: 做一个个人主页',
    })
  );

  await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: created.jobId,
        stageResult: 'issue_created',
        issueNumber: 42,
        issueUrl: 'https://github.example/org/pages-manager/issues/42',
      }),
    })
  );

  const link = app.store.findIssueLinkByJobId(created.jobId);
  const session = app.store.getSlackSession(created.slackSessionId);

  assert.equal(link.issueNumber, 42);
  assert.equal(session.activeJobId, created.jobId);
  assert.equal(session.activeIssueNumber, 42);
});
