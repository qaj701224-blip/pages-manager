import assert from 'node:assert/strict';
import test from 'node:test';

import { addSlackReaction, notifySlackJobStatus, postSlackMessage } from '../../../apps/gateway/src/slack-notifier.js';

test('gateway delegates Slack status delivery to remote notifier when configured', async () => {
  const calls = [];
  const recordedMessages = [];
  const store = {
    getSlackJobStatusMessage() {
      return null;
    },
    recordAgentRunEvent(input) {
      return { created: true, event: input };
    },
    recordSlackJobStatusMessage(jobId, input) {
      const message = { ...input, jobId };
      recordedMessages.push(message);
      return message;
    },
  };
  const job = {
    id: 'job_1',
    status: 'received',
    employeeSlug: 'alice',
    siteSlug: 'profile',
    summary: '个人主页',
    slackThread: {
      channelId: 'C1',
      threadTs: '1710000000.000100',
      userId: 'U1',
    },
  };

  const result = await notifySlackJobStatus(
    {
      SLACK_NOTIFIER_URL: 'http://slack-notifier.test',
      SLACK_NOTIFIER_SHARED_SECRET: 'secret',
      async SLACK_NOTIFIER_FETCH(url, request) {
        calls.push({ url: String(url), request });
        return new Response(
          JSON.stringify({
            ok: true,
            action: 'posted',
            channel: 'C1',
            ts: '1710000001.000100',
            message: {
              channel: 'C1',
              threadTs: '1710000000.000100',
              messageTs: '1710000001.000100',
              stage: 'received',
              status: 'received',
            },
          }),
          { status: 200 }
        );
      },
    },
    store,
    job,
    { stage: 'received' }
  );

  assert.equal(result.ok, true);
  assert.equal(result.action, 'posted');
  assert.equal(calls[0].url, 'http://slack-notifier.test/internal/slack-notifier/job-status');
  assert.equal(calls[0].request.headers['X-Pages-Slack-Notifier-Token'], 'secret');
  assert.equal(recordedMessages[0].messageTs, '1710000001.000100');
  assert.equal(result.message.jobId, 'job_1');
});

test('gateway delegates plain Slack replies to remote notifier when configured', async () => {
  const calls = [];
  const result = await postSlackMessage(
    {
      SLACK_NOTIFIER_URL: 'http://slack-notifier.test',
      SLACK_NOTIFIER_SHARED_SECRET: 'secret',
      async SLACK_NOTIFIER_FETCH(url, request) {
        calls.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '1710000002.000100' }));
      },
    },
    {
      channel: 'C1',
      thread_ts: '1710000000.000100',
      text: '<@U1> 我已收到，正在整理。',
    }
  );

  const payload = JSON.parse(calls[0].request.body);

  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'http://slack-notifier.test/internal/slack-notifier/message');
  assert.equal(calls[0].request.headers['X-Pages-Slack-Notifier-Token'], 'secret');
  assert.equal(payload.payload.text, '<@U1> 我已收到，正在整理。');
});

test('gateway does not call remote notifier without shared secret', async () => {
  const calls = [];
  const result = await postSlackMessage(
    {
      SLACK_NOTIFIER_URL: 'http://slack-notifier.test',
      async SLACK_NOTIFIER_FETCH(url, request) {
        calls.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true }));
      },
    },
    {
      channel: 'C1',
      thread_ts: '1710000000.000100',
      text: '<@U1> 我已收到，正在整理。',
    }
  );

  assert.equal(result.ok, false);
  assert.equal(result.status, 500);
  assert.equal(result.error, 'Slack notifier shared secret is required');
  assert.deepEqual(calls, []);
});

test('gateway delegates working reactions to remote notifier when configured', async () => {
  const calls = [];
  const result = await addSlackReaction(
    {
      SLACK_NOTIFIER_URL: 'http://slack-notifier.test',
      SLACK_NOTIFIER_SHARED_SECRET: 'secret',
      async SLACK_NOTIFIER_FETCH(url, request) {
        calls.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'C1', ts: null }));
      },
    },
    {
      channel: 'C1',
      timestamp: '1710000000.000100',
      name: 'eyes',
    }
  );

  const payload = JSON.parse(calls[0].request.body);

  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'http://slack-notifier.test/internal/slack-notifier/reaction');
  assert.equal(payload.payload.name, 'eyes');
});
