import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createDirectMessagePollState,
  createMessageDedupeCache,
  markMessageProcessed,
  messageDedupeKey,
  pollSlackDirectMessagesOnce,
} from '../../../apps/slack-connector/src/dm-poller.js';

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });
}

test('message dedupe cache tracks Slack message channel and ts', () => {
  const cache = createMessageDedupeCache(2);
  const first = { type: 'message', channel: 'D1', ts: '1' };
  const second = { type: 'message', channel: 'D1', ts: '2' };
  const third = { type: 'message', channel: 'D1', ts: '3' };

  assert.equal(messageDedupeKey(first), 'D1:1');
  assert.equal(markMessageProcessed(cache, first), false);
  assert.equal(markMessageProcessed(cache, first), true);
  assert.equal(markMessageProcessed(cache, second), false);
  assert.equal(markMessageProcessed(cache, third), false);
  assert.equal(markMessageProcessed(cache, first), false);
});

test('DM poller bootstraps latest message then forwards only new user messages', async () => {
  const state = createDirectMessagePollState();
  const processedMessages = createMessageDedupeCache();
  const calls = [];
  const forwarded = [];

  const fetchImpl = async (url) => {
    const parsed = new URL(String(url));
    calls.push({ method: parsed.pathname.split('/').at(-1), oldest: parsed.searchParams.get('oldest') || '' });

    if (parsed.pathname.endsWith('/auth.test')) {
      return jsonResponse({ ok: true, team_id: 'T1' });
    }
    if (parsed.pathname.endsWith('/conversations.list')) {
      return jsonResponse({ ok: true, channels: [{ id: 'D1', is_im: true }] });
    }
    if (parsed.pathname.endsWith('/conversations.history')) {
      const oldest = parsed.searchParams.get('oldest') || '';
      if (!oldest) {
        return jsonResponse({
          ok: true,
          messages: [{ type: 'message', user: 'U1', channel: 'D1', ts: '1', text: 'old' }],
        });
      }

      return jsonResponse({
        ok: true,
        messages: [
          { type: 'message', user: 'UBOT', bot_id: 'B1', channel: 'D1', ts: '2', text: 'bot' },
          { type: 'message', user: 'U1', channel: 'D1', ts: '3', text: 'new' },
        ],
      });
    }

    return jsonResponse({ ok: false, error: 'unexpected_method' });
  };

  const config = {
    botToken: 'xoxb-test',
    dmPollChannelLimit: 20,
    dmPollBatchSize: 5,
  };

  const first = await pollSlackDirectMessagesOnce({
    config,
    fetchImpl,
    client: {},
    logger: {},
    state,
    processedMessages,
    onEvent: async (args) => forwarded.push(args),
  });
  const second = await pollSlackDirectMessagesOnce({
    config,
    fetchImpl,
    client: {},
    logger: {},
    state,
    processedMessages,
    onEvent: async (args) => forwarded.push(args),
  });

  assert.equal(first.forwarded, 0);
  assert.equal(second.forwarded, 1);
  assert.equal(forwarded.length, 1);
  assert.equal(forwarded[0].body.event_id, 'poll:T1:D1:3');
  assert.deepEqual(forwarded[0].event, {
    type: 'message',
    channel: 'D1',
    channel_type: 'im',
    user: 'U1',
    ts: '3',
    text: 'new',
  });
  assert.equal(state.lastSeenByChannel.get('D1'), '3');
  assert.deepEqual(
    calls.filter((call) => call.method === 'conversations.history').map((call) => call.oldest),
    ['', '1']
  );
});
