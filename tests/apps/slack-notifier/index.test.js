import assert from 'node:assert/strict';
import test from 'node:test';

import { createSlackNotifierApp } from '../../../apps/slack-notifier/src/index.js';

async function json(response) {
  return response.json();
}

test('slack notifier reports health', async () => {
  const app = createSlackNotifierApp();
  const response = await app.fetch(new Request('http://slack-notifier.test/health'));

  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { status: 'ok', service: 'slack-notifier' });
});

test('slack notifier requires internal token when configured', async () => {
  const app = createSlackNotifierApp();
  const response = await app.fetch(
    new Request('http://slack-notifier.test/internal/slack-notifier/job-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
    { SLACK_NOTIFIER_SHARED_SECRET: 'secret' }
  );

  assert.equal(response.status, 401);
});

test('slack notifier fails closed when shared secret is missing', async () => {
  const app = createSlackNotifierApp();
  const response = await app.fetch(
    new Request('http://slack-notifier.test/internal/slack-notifier/job-message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    }),
    { SLACK_BOT_TOKEN: 'xoxb-test' }
  );
  const body = await json(response);

  assert.equal(response.status, 500);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Slack notifier shared secret is required');
});

test('slack notifier returns json errors for invalid request bodies', async () => {
  const app = createSlackNotifierApp();
  const response = await app.fetch(
    new Request('http://slack-notifier.test/internal/slack-notifier/message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pages-Slack-Notifier-Token': 'secret',
      },
      body: '{',
    }),
    { SLACK_NOTIFIER_SHARED_SECRET: 'secret' }
  );
  const body = await json(response);

  assert.equal(response.status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Invalid JSON body');
});

test('slack notifier returns json errors for delivery failures', async () => {
  const app = createSlackNotifierApp();
  const response = await app.fetch(
    new Request('http://slack-notifier.test/internal/slack-notifier/message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pages-Slack-Notifier-Token': 'secret',
      },
      body: JSON.stringify({ payload: { channel: 'C1', text: 'hello' } }),
    }),
    {
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_NOTIFIER_SHARED_SECRET: 'secret',
      async SLACK_FETCH() {
        throw new Error('Slack request failed');
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 500);
  assert.equal(body.ok, false);
  assert.equal(body.error, 'Slack request failed');
});

test('slack notifier updates an existing status card', async () => {
  const app = createSlackNotifierApp();
  const slackRequests = [];
  const response = await app.fetch(
    new Request('http://slack-notifier.test/internal/slack-notifier/job-status', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pages-Slack-Notifier-Token': 'secret',
      },
      body: JSON.stringify({
        job: {
          id: 'job_1',
          status: 'preview_deployed',
          employeeSlug: 'alice',
          siteSlug: 'profile',
          summary: '个人主页',
          previewUrl: 'https://preview.example.test',
          slackThread: {
            channelId: 'C1',
            threadTs: '1710000000.000100',
            userId: 'U1',
          },
        },
        options: { stage: 'preview_deployed' },
        existingMessage: {
          channel: 'C1',
          threadTs: '1710000000.000100',
          messageTs: '1710000001.000100',
          stage: 'pr_created',
        },
      }),
    }),
    {
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_NOTIFIER_SHARED_SECRET: 'secret',
      async SLACK_FETCH(url, request) {
        slackRequests.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '1710000001.000100' }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);
  const payload = JSON.parse(slackRequests[0].request.body);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.action, 'updated');
  assert.equal(slackRequests[0].url, 'https://slack.com/api/chat.update');
  assert.equal(slackRequests[0].request.headers.Authorization, 'Bearer xoxb-test');
  assert.match(JSON.stringify(payload.blocks), /Preview 已生成/);
  assert.equal(body.message.messageTs, '1710000001.000100');
});

test('slack notifier posts plain Slack messages for gateway replies', async () => {
  const app = createSlackNotifierApp();
  const slackRequests = [];
  const response = await app.fetch(
    new Request('http://slack-notifier.test/internal/slack-notifier/message', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pages-Slack-Notifier-Token': 'secret',
      },
      body: JSON.stringify({
        payload: {
          channel: 'C1',
          thread_ts: '1710000000.000100',
          text: '<@U1> 我已收到，正在整理。',
        },
      }),
    }),
    {
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_NOTIFIER_SHARED_SECRET: 'secret',
      async SLACK_FETCH(url, request) {
        slackRequests.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '1710000002.000100' }));
      },
    }
  );
  const body = await json(response);
  const payload = JSON.parse(slackRequests[0].request.body);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(slackRequests[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(payload.text, '<@U1> 我已收到，正在整理。');
});

test('slack notifier adds working reactions', async () => {
  const app = createSlackNotifierApp();
  const slackRequests = [];
  const response = await app.fetch(
    new Request('http://slack-notifier.test/internal/slack-notifier/reaction', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pages-Slack-Notifier-Token': 'secret',
      },
      body: JSON.stringify({
        payload: {
          channel: 'C1',
          timestamp: '1710000000.000100',
          name: 'eyes',
        },
      }),
    }),
    {
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_NOTIFIER_SHARED_SECRET: 'secret',
      async SLACK_FETCH(url, request) {
        slackRequests.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true }));
      },
    }
  );
  const body = await json(response);
  const payload = JSON.parse(slackRequests[0].request.body);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(slackRequests[0].url, 'https://slack.com/api/reactions.add');
  assert.deepEqual(payload, {
    channel: 'C1',
    timestamp: '1710000000.000100',
    name: 'eyes',
  });
});
