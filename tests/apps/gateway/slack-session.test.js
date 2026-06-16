import assert from 'node:assert/strict';
import test from 'node:test';

import { readSlackSessionConfig, slackUserIdFromBody } from '../../../apps/gateway/src/slack/session.js';
import { createGatewayApp } from '../../helpers/gateway-app.js';
import { GatewayStoreFixture } from '../../helpers/gateway-store-fixture.js';

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
  assert.deepEqual(userOneSessions.map((session) => session.sessionKey).sort(), [
    'thread:C1:1710000000.000100',
    'thread:C1:1710000001.000100',
  ]);
  assert.equal(userTwoSessions[0].sessionKey, 'thread:C1:1710000000.000100');
});

test('Slack user id normalization ignores object payload shape', () => {
  assert.equal(
    slackUserIdFromBody({
      event: {
        user: { id: 'U_OBJECT' },
      },
    }),
    'U_OBJECT'
  );
  assert.equal(slackUserIdFromBody({ user: { id: 'U_BODY' } }), 'U_BODY');
  assert.equal(slackUserIdFromBody({ event: { user: { name: 'missing-id' } } }, null), null);
});

test('top-level DM messages start isolated Slack thread sessions', async () => {
  const app = createGatewayApp();

  const first = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-dm-1',
      ts: '1710000000.000100',
      text: 'issue: 做一个项目展示页',
    })
  );
  const second = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-dm-2',
      ts: '1710000001.000100',
      text: 'issue: 做一个招聘落地页',
    })
  );
  const third = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-dm-3',
      ts: '1710000002.000100',
      text: '这个 preview 不满意',
    })
  );

  assert.notEqual(first.slackSessionId, second.slackSessionId);
  assert.notEqual(first.slackSessionId, third.slackSessionId);
  assert.notEqual(second.slackSessionId, third.slackSessionId);
  assert.equal(app.store.getSlackSession(first.slackSessionId).sessionKey, 'dm-thread:D1:1710000000.000100');
  assert.equal(app.store.getSlackSession(second.slackSessionId).sessionKey, 'dm-thread:D1:1710000001.000100');
  assert.equal(app.store.getSlackSession(third.slackSessionId).sessionKey, 'dm-thread:D1:1710000002.000100');
});

test('DM thread replies continue the same Slack session', async () => {
  const app = createGatewayApp();

  const first = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-dm-thread-1',
      ts: '1710000000.000100',
      text: '我想先聊聊个人网站',
    })
  );
  const second = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-dm-thread-2',
      ts: '1710000001.000100',
      threadTs: '1710000000.000100',
      text: '按你推荐的来，一个包含我个人特色的网站即可',
    })
  );

  const session = app.store.getSlackSession(first.slackSessionId);

  assert.equal(second.slackSessionId, first.slackSessionId);
  assert.equal(session.sessionKey, 'dm-thread:D1:1710000000.000100');
  assert.equal(session.threadTs, '1710000000.000100');
});

test('DM events without channel_type are inferred from the D channel id', async () => {
  const app = createGatewayApp();

  const first = await postSlack(app, {
    team_id: 'T1',
    event_id: 'Ev-dm-infer-1',
    event: {
      type: 'message',
      user: 'U1',
      channel: 'D1',
      ts: '1710000000.000100',
      text: '我想先聊聊个人网站',
    },
  });
  const second = await postSlack(app, {
    team_id: 'T1',
    event_id: 'Ev-dm-infer-2',
    event: {
      type: 'message',
      user: 'U1',
      channel: 'D1',
      ts: '1710000001.000100',
      thread_ts: '1710000000.000100',
      text: '继续补充项目经历',
    },
  });

  const session = app.store.getSlackSession(first.slackSessionId);

  assert.equal(second.slackSessionId, first.slackSessionId);
  assert.equal(session.sessionKey, 'dm-thread:D1:1710000000.000100');
  assert.equal(session.channelId, 'D1');
  assert.equal(session.surfaceContext.channelType, 'im');
  assert.equal(session.dmChannelId, 'D1');
});

test('Slack users cannot select another user session explicitly', async () => {
  const app = createGatewayApp();

  const created = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-forbidden-session-1',
      user: 'U1',
      ts: '1710000000.000100',
      text: 'issue: 做一个项目展示页',
    })
  );

  const forbidden = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-forbidden-session-2',
      user: 'U2',
      ts: '1710000001.000100',
      text: `session: ${created.slackSessionId} 继续修改`,
    })
  );

  assert.equal(forbidden.accepted, false);
  assert.equal(forbidden.action, 'forbidden_cross_user_session');
  assert.match(forbidden.replyText, /不属于当前 Slack 用户/);
});

test('Slack users cannot query another user job status', async () => {
  const app = createGatewayApp();

  const created = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-forbidden-job-1',
      user: 'U1',
      ts: '1710000000.000100',
      text: 'issue: 做一个项目展示页',
    })
  );

  const forbidden = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-forbidden-job-2',
      user: 'U2',
      ts: '1710000001.000100',
      text: `状态 ${created.jobId}`,
    })
  );

  assert.equal(forbidden.accepted, false);
  assert.equal(forbidden.action, 'forbidden_cross_user_job');
  assert.match(forbidden.replyText, /不属于当前 Slack 用户/);
});

test('top-level DM after expired active context starts a new thread session', async () => {
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
  assert.equal(response.action, 'agent_turn');
  assert.notEqual(response.slackSessionId, created.slackSessionId);
  assert.equal(app.store.getSlackSession(response.slackSessionId).sessionKey, 'dm-thread:D1:1710000001.000100');
});

test('Slack Agent lease prevents concurrent runs in the same session', () => {
  const store = new GatewayStoreFixture();
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

test('Slack close command closes the selected session and clears active context', async () => {
  const app = createGatewayApp();
  const created = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-close-1',
      ts: '1710000000.000100',
      text: 'issue: 做一个个人主页',
    })
  );

  const response = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-close-2',
      ts: '1710000001.000100',
      text: `close: ${created.slackSessionId}`,
    })
  );
  const session = app.store.getSlackSession(created.slackSessionId);

  assert.equal(response.action, 'close_session');
  assert.equal(response.accepted, true);
  assert.equal(session.status, 'closed');
  assert.equal(session.activeJobId, null);
  assert.equal(session.activeIssueNumber, null);
  assert.equal(session.activePrNumber, null);
  assert.equal(session.activePreviewUrl, null);
});

test('closed Slack session is reactivated when the same thread starts a new job', async () => {
  const app = createGatewayApp();
  const created = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-close-thread-1',
      channel: 'C1',
      channelType: 'channel',
      ts: '1710000000.000100',
      text: 'issue: 做一个个人主页',
    })
  );

  await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-close-thread-2',
      channel: 'C1',
      channelType: 'channel',
      ts: '1710000001.000100',
      threadTs: '1710000000.000100',
      text: `close: ${created.slackSessionId}`,
    })
  );

  const reopened = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-close-thread-3',
      channel: 'C1',
      channelType: 'channel',
      ts: '1710000002.000100',
      threadTs: '1710000000.000100',
      text: 'issue: 重新做一个活动页',
    })
  );
  const session = app.store.getSlackSession(created.slackSessionId);

  assert.equal(reopened.accepted, true);
  assert.equal(reopened.slackSessionId, created.slackSessionId);
  assert.equal(session.status, 'active');
  assert.equal(session.closedAt, null);
  assert.equal(session.activeJobId, reopened.jobId);
});
