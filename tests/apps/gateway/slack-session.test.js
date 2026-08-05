import assert from 'node:assert/strict';
import test from 'node:test';

import { classifySlackIntake } from '../../../apps/gateway/src/slack/intake.js';
import { readSlackSessionConfig, slackUserIdFromBody } from '../../../apps/gateway/src/slack/session.js';
import { createLegacyGatewayAppForTests as createGatewayApp } from '../../helpers/legacy-gateway-app.js';
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

async function postSlackInteraction(app, payload, env = {}) {
  return json(
    await app.fetch(
      new Request('http://gateway.test/integrations/slack/interactions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ payload: JSON.stringify(payload) }).toString(),
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

test('explicit top-level DM issue commands start isolated Slack sessions', async () => {
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

  assert.notEqual(first.slackSessionId, second.slackSessionId);
  assert.equal(app.store.getSlackSession(first.slackSessionId).sessionKey, 'dm-thread:D1:1710000000.000100');
  assert.equal(app.store.getSlackSession(second.slackSessionId).sessionKey, 'dm-thread:D1:1710000001.000100');
});

test('top-level DM messages continue the only active Slack session', async () => {
  const app = createGatewayApp();

  const first = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-dm-active-1',
      ts: '1710000000.000100',
      text: '我想先聊聊个人网站',
    })
  );
  const second = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-dm-active-2',
      ts: '1710000001.000100',
      text: '再补充联系方式和项目经历',
    })
  );

  assert.equal(second.slackSessionId, first.slackSessionId);
  assert.equal(app.store.getSlackSession(first.slackSessionId).sessionKey, 'dm:D1:1710000000.000100');
});

test('question-like issue prefix continues the active DM session instead of starting a new issue command session', async () => {
  const app = createGatewayApp();
  const agentCalls = [];
  const first = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-dm-issue-question-1',
      ts: '1710000000.000100',
      text: 'issue: 做一个项目展示页',
    })
  );
  const second = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-dm-issue-question-2',
      ts: '1710000001.000100',
      text: 'issue 我能主动关闭吗？',
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      async SLACK_AGENT_FETCH(url, request) {
        agentCalls.push({ url: String(url), request });
        const payload = JSON.parse(request.body);
        assert.equal(payload.slackSessionId, first.slackSessionId);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              visibleText: '当前 Slack 里不能直接关闭 GitHub issue。',
              events: [
                { type: 'reply_started', sequence: 1, agentRunId: payload.agentRunId, slackSessionId: payload.slackSessionId },
                {
                  type: 'analysis_final',
                  sequence: 2,
                  agentRunId: payload.agentRunId,
                  slackSessionId: payload.slackSessionId,
                  analysis: {
                    intent: 'clarify',
                    summary: '当前 Slack 里不能直接关闭 GitHub issue。',
                    needsClarification: true,
                    clarifyingQuestion: '你是想结束 Slack 会话，还是询问 GitHub issue 是否能关闭？',
                  },
                },
                { type: 'reply_completed', sequence: 3, agentRunId: payload.agentRunId, slackSessionId: payload.slackSessionId },
              ],
            },
          }),
          { status: 200 }
        );
      },
    }
  );

  assert.equal(second.slackSessionId, first.slackSessionId);
  assert.equal(agentCalls.length, 1);
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
  assert.equal(session.sessionKey, 'dm:D1:1710000000.000100');
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
  assert.equal(session.sessionKey, 'dm:D1:1710000000.000100');
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

test('natural close-session wording closes the active DM session', async () => {
  const app = createGatewayApp();

  const created = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-natural-close-1',
      ts: '1710000000.000100',
      text: '我想先聊聊个人网站',
    })
  );
  const closed = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-natural-close-2',
      ts: '1710000001.000100',
      text: '关闭会话',
    })
  );

  assert.equal(closed.action, 'close_session');
  assert.equal(app.store.getSlackSession(created.slackSessionId).status, 'closed');
});

test('status query with explicit job id does not regress under natural language phrasing', async () => {
  const intake = classifySlackIntake(slackEvent({ eventId: 'Ev-status-classify', text: '状态 job_abc123' }));
  assert.equal(intake.action, 'diagnose_work_item');
  assert.equal(intake.jobId, 'job_abc123');

  const app = createGatewayApp();
  const created = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-status-job-1',
      user: 'U1',
      ts: '1710000000.000100',
      text: 'issue: 做一个项目展示页',
    })
  );

  const queried = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-status-job-2',
      user: 'U1',
      ts: '1710000001.000100',
      text: `状态 ${created.jobId}`,
    })
  );

  assert.equal(queried.action, 'diagnose_work_item');
  assert.equal(queried.accepted, false);
  assert.equal(queried.jobId, created.jobId);
  assert.match(queried.replyText, /当前状态|最近阶段/);
});

test('multiple active DM sessions do not bind natural status queries to the first session', async () => {
  const intake = classifySlackIntake(slackEvent({ eventId: 'Ev-ambiguous-status-classify', text: '现在进度怎么样？' }));
  assert.equal(intake.action, 'diagnose_work_item');

  const app = createGatewayApp();

  await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-ambiguous-status-1',
      ts: '1710000000.000100',
      text: 'issue: 做一个项目展示页',
    })
  );
  await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-ambiguous-status-2',
      ts: '1710000001.000100',
      text: 'issue: 做一个博客页',
    })
  );

  const ambiguous = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-ambiguous-status-3',
      ts: '1710000002.000100',
      text: '现在进度怎么样？',
    })
  );

  assert.equal(ambiguous.accepted, false);
  assert.equal(ambiguous.action, 'ambiguous_active_dm_sessions');
  assert.match(ambiguous.replyText, /多个最近的会话/);
  assert.match(ambiguous.replyText, /job id|issue|PR|GitHub URL/i);
});

test('multiple active DM sessions can still list work items', async () => {
  const app = createGatewayApp();

  await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-list-multiple-sessions-1',
      ts: '1710000000.000100',
      text: 'issue: 做一个项目展示页',
    })
  );
  await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-list-multiple-sessions-2',
      ts: '1710000001.000100',
      text: 'issue: 做一个博客页',
    })
  );

  const listed = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-list-multiple-sessions-3',
      ts: '1710000002.000100',
      text: 'work',
    })
  );

  assert.equal(listed.action, 'list_work_items');
  assert.equal(listed.accepted, false);
  assert.equal(listed.jobs.length, 2);
  assert.doesNotMatch(listed.replyText, /多个最近的会话/);
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
  assert.equal(app.store.getSlackSession(response.slackSessionId).sessionKey, 'dm:D1:1710000001.000100');
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

test('terminal Slack Agent runs are not revived by later completion', () => {
  const store = new GatewayStoreFixture();
  const agentRun = store.createAgentRun({
    agentKind: 'slack_agent',
    slackSessionId: 'sess_terminal',
    leaseExpiresAt: '2026-06-12T00:03:00.000Z',
  });

  const failed = store.failAgentRun(agentRun.id, 'slack_session_closed', 'Slack session was closed');
  const completed = store.completeAgentRun(agentRun.id, { report: { action: 'late_completion' } });

  assert.equal(failed.status, 'failed');
  assert.equal(completed.status, 'failed');
  assert.equal(completed.errorCode, 'slack_session_closed');
  assert.equal(completed.report.action, undefined);
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

test('explicit issue close requests do not close the Slack session even if Agent asks for close', async () => {
  const app = createGatewayApp();
  const created = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-close-issue-1',
      ts: '1710000000.000100',
      text: 'issue: 做一个个人主页',
    })
  );

  const response = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-close-issue-2',
      ts: '1710000001.000100',
      text: '关闭 这个 https://github.com/xindong/pages-manager/issues/97 issue',
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      async SLACK_AGENT_FETCH(url, request) {
        const payload = JSON.parse(request.body);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              visibleText: '收到，我会关闭当前会话。',
              events: [
                { type: 'reply_started', sequence: 1, agentRunId: payload.agentRunId, slackSessionId: payload.slackSessionId },
                {
                  type: 'analysis_final',
                  sequence: 2,
                  agentRunId: payload.agentRunId,
                  slackSessionId: payload.slackSessionId,
                  analysis: {
                    intent: 'close_session',
                    toolCall: { name: 'close_session', args: {} },
                    summary: '用户想关闭 GitHub issue。',
                    needsClarification: false,
                  },
                },
                { type: 'reply_completed', sequence: 3, agentRunId: payload.agentRunId, slackSessionId: payload.slackSessionId },
              ],
            },
          }),
          { status: 200 }
        );
      },
    }
  );
  const session = app.store.getSlackSession(created.slackSessionId);

  assert.equal(response.action, 'unsupported_destructive_request');
  assert.equal(response.accepted, false);
  assert.match(response.replyText, /不能在 Slack 里直接关闭或删除/);
  assert.equal(session.status, 'active');
});

test('closed Slack session stays closed when the same thread starts a new job', async () => {
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
  const newSession = app.store.getSlackSession(reopened.slackSessionId);

  assert.equal(reopened.accepted, true);
  assert.notEqual(reopened.slackSessionId, created.slackSessionId);
  assert.equal(session.status, 'closed');
  assert.equal(session.activeJobId, null);
  assert.equal(newSession.status, 'active');
  assert.equal(newSession.activeJobId, reopened.jobId);
});

test('closed Slack channel thread ignores plain replies until the bot is addressed again', async () => {
  const app = createGatewayApp();
  const created = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-closed-unaddressed-thread-1',
      channel: 'C1',
      channelType: 'channel',
      ts: '1710000000.000100',
      text: 'issue: 做一个个人主页',
    })
  );

  await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-closed-unaddressed-thread-2',
      channel: 'C1',
      channelType: 'channel',
      ts: '1710000001.000100',
      threadTs: '1710000000.000100',
      text: `close: ${created.slackSessionId}`,
    })
  );

  const ignored = await postSlack(app, {
    team_id: 'T1',
    event_id: 'Ev-closed-unaddressed-thread-3',
    event: {
      type: 'message',
      user: 'U1',
      channel: 'C1',
      channel_type: 'channel',
      ts: '1710000002.000100',
      thread_ts: '1710000000.000100',
      text: '继续帮我改一下标题',
    },
  });

  assert.equal(ignored.action, 'ignored_untracked_thread_message');
  assert.equal(ignored.accepted, false);
  assert.equal(app.store.getSlackSession(created.slackSessionId).status, 'closed');
  assert.equal(app.store.jobs.size, 1);
});

test('Slack close button clears a running Agent lease before the next thread message', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
  const created = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-close-button-1',
      channel: 'C1',
      channelType: 'channel',
      ts: '1710000000.000100',
      text: 'issue: 做一个个人主页',
    })
  );
  const running = app.store.createAgentRun({
    agentKind: 'slack_agent',
    slackSessionId: created.slackSessionId,
    leaseExpiresAt: '2999-01-01T00:00:00.000Z',
  });

  const closed = await postSlackInteraction(app, {
    type: 'block_actions',
    team: { id: 'T1' },
    user: { id: 'U1' },
    channel: { id: 'C1' },
    container: { channel_id: 'C1', message_ts: '1710000000.000200' },
    message: { ts: '1710000000.000200', thread_ts: '1710000000.000100' },
    actions: [{ action_id: 'pages_close_session', value: created.slackSessionId }],
  }, {
    SLACK_NOTIFIER_URL: 'http://slack-notifier.test',
    SLACK_NOTIFIER_SHARED_SECRET: 'secret',
    async SLACK_NOTIFIER_FETCH(url, request) {
      const body = request.body ? JSON.parse(request.body) : {};
      notifierCalls.push({ path: new URL(String(url)).pathname, body });
      return new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '1710000000.000200' }), { status: 200 });
    },
  });
  const next = await postSlack(
    app,
    slackEvent({
      eventId: 'Ev-close-button-2',
      channel: 'C1',
      channelType: 'channel',
      ts: '1710000001.000100',
      threadTs: '1710000000.000100',
      text: 'work',
    })
  );

  assert.match(closed.text, /已关闭/);
  assert.equal(closed.closeCardUpdate?.ok, true);
  assert.equal(app.store.getAgentRun(running.id).status, 'failed');
  assert.equal(app.store.getAgentRun(running.id).errorCode, 'slack_session_closed');
  assert.equal(next.action, 'list_work_items');
  assert.notEqual(next.action, 'agent_busy');
  const updateCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/update');
  assert.ok(updateCall);
  assert.match(JSON.stringify(updateCall.body.payload), /会话已关闭/);
  assert.doesNotMatch(JSON.stringify(updateCall.body.payload), /pages_close_session/);
});

test('late Slack Agent result after close does not create a stale job', async () => {
  const app = createGatewayApp();
  let resolveStarted;
  let resolveAgentResponse;
  const agentStarted = new Promise((resolve) => {
    resolveStarted = resolve;
  });
  const agentResponse = new Promise((resolve) => {
    resolveAgentResponse = resolve;
  });
  const agentFetch = async (_url, init = {}) => {
    const payload = JSON.parse(init.body || '{}');
    resolveStarted(payload);
    return await agentResponse;
  };

  const turnPromise = postSlack(
    app,
    slackEvent({
      eventId: 'Ev-late-close-1',
      channel: 'C1',
      channelType: 'channel',
      ts: '1710000000.000100',
      text: '做一个活动主页',
    }),
    {
      SLACK_AGENT_ANALYZE_URL: 'https://slack-agent.test/analyze',
      SLACK_AGENT_FETCH: agentFetch,
    }
  );
  const agentPayload = await agentStarted;

  await postSlackInteraction(app, {
    type: 'block_actions',
    team: { id: 'T1' },
    user: { id: 'U1' },
    actions: [{ action_id: 'pages_close_session', value: agentPayload.slackSessionId }],
  });
  resolveAgentResponse(
    new Response(
      JSON.stringify({
        analysis: {
          intent: 'create_or_update_site',
          summary: '做一个不应该落库的旧活动主页',
          siteSlug: 'campaign',
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    )
  );

  const result = await turnPromise;
  const agentRun = app.store.getAgentRun(agentPayload.agentRunId);

  assert.equal(result.action, 'slack_agent_turn_cancelled');
  assert.equal(result.noReply, true);
  assert.equal(agentRun.status, 'failed');
  assert.equal(agentRun.errorCode, 'slack_session_closed');
  assert.equal(app.store.listJobs().total, 0);
});
