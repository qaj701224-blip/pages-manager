import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildGatewayPayload,
  buildSlackAckText,
  buildSlackReaction,
  buildSlackReplyMessage,
  classifySlackEvent,
  isTargetSlackEvent,
  normalizeSlackText,
  postGatewayEvent,
  shouldReplyToGatewayResult,
} from '../../../apps/slack-connector/src/slack-event.js';

test('targets direct messages and app mentions', () => {
  assert.equal(isTargetSlackEvent({ type: 'message', channel_type: 'im', user: 'U1' }), true);
  assert.equal(isTargetSlackEvent({ type: 'message', channel: 'D1', user: 'U1' }), true);
  assert.equal(isTargetSlackEvent({ type: 'app_mention', user: 'U1' }), true);
  assert.equal(isTargetSlackEvent({ type: 'message', channel_type: 'channel', user: 'U1' }), false);
  assert.equal(
    isTargetSlackEvent(
      { type: 'message', channel_type: 'channel', user: 'U1', thread_ts: '1000.000' },
      { acceptThreadMessages: true }
    ),
    true
  );
  assert.equal(
    isTargetSlackEvent({ type: 'message', channel_type: 'channel', user: 'U1' }, { acceptThreadMessages: true }),
    false
  );
});

test('ignores bot and changed message events by default', () => {
  assert.equal(isTargetSlackEvent({ type: 'message', channel_type: 'im', bot_id: 'B1' }), false);
  assert.equal(isTargetSlackEvent({ type: 'message', channel_type: 'im', subtype: 'message_changed' }), false);
  assert.equal(
    isTargetSlackEvent({ type: 'message', channel_type: 'im', bot_id: 'B1' }, { acceptBotEvents: true }),
    true
  );
});

test('classifies Slack event filter decisions for logs', () => {
  assert.deepEqual(classifySlackEvent(null), { target: false, reason: 'missing_event' });
  assert.deepEqual(classifySlackEvent({ type: 'message', channel_type: 'im', subtype: 'message_replied' }), {
    target: false,
    reason: 'ignored_subtype:message_replied',
  });
  assert.deepEqual(classifySlackEvent({ type: 'message', channel_type: 'im', bot_id: 'B1' }), {
    target: false,
    reason: 'ignored_bot_event',
  });
  assert.deepEqual(classifySlackEvent({ type: 'message', channel_type: 'im', user: 'U1' }), {
    target: true,
    reason: 'direct_message',
  });
  assert.deepEqual(classifySlackEvent({ type: 'message', channel: 'D1', user: 'U1' }), {
    target: true,
    reason: 'direct_message',
  });
});

test('normalizes app mention text before forwarding to gateway', () => {
  assert.equal(normalizeSlackText('<@U_BOT>   给张三做一个 profile 页面', { botUserId: 'U_BOT' }), '给张三做一个 profile 页面');
});

test('builds gateway payload from Socket Mode event body', () => {
  const payload = buildGatewayPayload(
    {
      type: 'event_callback',
      team_id: 'T1',
      api_app_id: 'A1',
      event_id: 'Ev1',
    },
    {
      type: 'message',
      channel_type: 'im',
      channel: 'D1',
      user: 'U1',
      ts: '1000.000',
      text: '生成个人站',
    },
    {
      employeeSlug: 'zhangsan',
      siteSlug: 'profile',
    }
  );

  assert.equal(payload.team_id, 'T1');
  assert.equal(payload.event_id, 'Ev1');
  assert.equal(payload.employeeSlug, 'zhangsan');
  assert.equal(payload.siteSlug, 'profile');
  assert.equal(payload.text, '生成个人站');
  assert.equal(payload.event.text, '生成个人站');
  assert.equal(payload.connector.transport, 'socket_mode');
});

test('normalizes direct message channel type when Slack omits channel_type', () => {
  const payload = buildGatewayPayload(
    {
      type: 'event_callback',
      team_id: 'T1',
      event_id: 'Ev1',
    },
    {
      type: 'message',
      channel: 'D1',
      user: 'U1',
      ts: '1000.000',
      text: '继续',
    },
    {}
  );

  assert.equal(payload.event.channel_type, 'im');
});

test('builds Slack reply text and replies in Slack threads', () => {
  assert.equal(buildSlackAckText({ replyText: '自定义回复' }), '自定义回复');
  assert.match(buildSlackAckText({ created: true, jobId: 'job_123' }), /job_123/);
  assert.match(
    buildSlackAckText({
      created: true,
      jobId: 'job_123',
      workerStart: { response: { result: { issueUrl: 'https://github.example/issues/1' } } },
    }),
    /https:\/\/github\.example\/issues\/1/
  );
  assert.deepEqual(buildSlackReplyMessage({ channel: 'D1', channel_type: 'im', user: 'U1', ts: '1' }, 'ok'), {
    channel: 'D1',
    text: '<@U1> ok',
    thread_ts: '1',
  });
  assert.deepEqual(
    buildSlackReplyMessage({ channel: 'D1', channel_type: 'im', user: 'U1', ts: '2', thread_ts: '1' }, 'ok'),
    {
      channel: 'D1',
      text: '<@U1> ok',
      thread_ts: '1',
    }
  );
  assert.deepEqual(buildSlackReplyMessage({ channel: 'C1', channel_type: 'channel', user: 'U1', ts: '1' }, 'ok'), {
    channel: 'C1',
    text: '<@U1> ok',
    thread_ts: '1',
  });
  assert.deepEqual(buildSlackReplyMessage({ channel: 'C1', channel_type: 'channel', user: 'U1', ts: '1' }, '<@U1> ok'), {
    channel: 'C1',
    text: '<@U1> ok',
    thread_ts: '1',
  });
});

test('builds Slack reaction payload for the source message', () => {
  assert.deepEqual(buildSlackReaction({ channel: 'D1', ts: '1000.000' }, ':hourglass_flowing_sand:'), {
    channel: 'D1',
    timestamp: '1000.000',
    name: 'hourglass_flowing_sand',
  });
  assert.equal(buildSlackReaction({ channel: 'D1' }, 'eyes'), null);
  assert.equal(buildSlackReaction({ channel: 'D1', ts: '1000.000' }, ''), null);
});

test('can suppress connector replies for ignored gateway events', () => {
  assert.equal(shouldReplyToGatewayResult({ ok: true, action: 'ignored_untracked_thread_message' }), false);
  assert.equal(shouldReplyToGatewayResult({ ok: true, reply: false }), false);
  assert.equal(shouldReplyToGatewayResult({ ok: true, replyText: null }), false);
  assert.equal(shouldReplyToGatewayResult({ ok: true, replyText: '继续处理' }), true);
});

test('posts gateway event and rejects failed responses', async () => {
  const ok = await postGatewayEvent(
    async (_url, request) => {
      assert.equal(request.method, 'POST');
      assert.equal(request.headers['Content-Type'], 'application/json');
      assert.equal(request.headers['X-Pages-Slack-Connector-Token'], 'secret');
      return new Response(JSON.stringify({ ok: true, jobId: 'job_123' }), { status: 200 });
    },
    'http://gateway.test/integrations/slack/events',
    { event_id: 'Ev1' },
    { connectorToken: 'secret' }
  );
  assert.equal(ok.jobId, 'job_123');

  await assert.rejects(
    () =>
      postGatewayEvent(
        async () => new Response(JSON.stringify({ error: 'bad event' }), { status: 400 }),
        'http://gateway.test/integrations/slack/events',
        { event_id: 'Ev2' }
      ),
    /bad event/
  );
});
