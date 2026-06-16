import assert from 'node:assert/strict';
import test from 'node:test';

import {
  addSlackReaction,
  notifySlackJobStatus,
  postSlackMessage,
  removeSlackReaction,
} from '../../../apps/gateway/src/slack/notifier.js';

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

test('gateway skips stale Slack status updates before remote notifier call', async () => {
  const calls = [];
  const store = {
    getSlackJobStatusMessage() {
      return {
        channel: 'C1',
        threadTs: '1710000000.000100',
        messageTs: '1710000001.000100',
        stage: 'preview_deployed',
        status: 'preview_deployed',
      };
    },
  };
  const job = {
    id: 'job_1',
    status: 'previewing',
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
        return new Response(JSON.stringify({ ok: true }));
      },
    },
    store,
    job,
    { stage: 'previewing' }
  );

  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'stale_stage');
  assert.deepEqual(calls, []);
});

test('gateway can allow a new Slack card cycle after preview is already deployed', async () => {
  const calls = [];
  const recordedMessages = [];
  const store = {
    getSlackJobStatusMessage() {
      return {
        channel: 'C1',
        threadTs: '1710000000.000100',
        messageTs: '1710000001.000100',
        stage: 'preview_deployed',
        status: 'preview_deployed',
      };
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
    status: 'fixing',
    employeeSlug: 'alice',
    siteSlug: 'profile',
    summary: '个人主页\n\n## Slack Follow-up\n\n标题改成中文。',
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
            action: 'updated',
            channel: 'C1',
            ts: '1710000001.000100',
            message: {
              channel: 'C1',
              threadTs: '1710000000.000100',
              messageTs: '1710000001.000100',
              stage: 'fixing',
              status: 'fixing',
            },
          }),
          { status: 200 }
        );
      },
    },
    store,
    job,
    {
      stage: 'fixing',
      allowRegression: true,
      skipDuplicate: false,
      cardTitle: '第 1 轮修改处理中',
      finalSummary: '个人主页\n\n*已追加修改*\n1. 标题改成中文。',
      currentChange: '本轮修改：标题改成中文。',
    }
  );
  const payload = JSON.parse(calls[0].request.body);

  assert.equal(result.ok, true);
  assert.equal(calls[0].url, 'http://slack-notifier.test/internal/slack-notifier/job-status');
  assert.equal(recordedMessages[0].stage, 'fixing');
  assert.equal(payload.options.allowRegression, true);
  assert.equal(payload.options.cardTitle, '第 1 轮修改处理中');
  assert.match(payload.options.finalSummary, /已追加修改/);
  assert.match(payload.options.currentChange, /标题改成中文/);
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

test('gateway delegates reaction removal to remote notifier when configured', async () => {
  const calls = [];
  const result = await removeSlackReaction(
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
  assert.equal(calls[0].url, 'http://slack-notifier.test/internal/slack-notifier/reaction-remove');
  assert.equal(payload.payload.name, 'eyes');
});
