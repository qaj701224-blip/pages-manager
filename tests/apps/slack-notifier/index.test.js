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

test('slack notifier fetches Slack user profile through internal endpoint', async () => {
  const app = createSlackNotifierApp();
  const slackRequests = [];
  const response = await app.fetch(
    new Request('http://slack-notifier.test/internal/slack-notifier/user-info', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pages-Slack-Notifier-Token': 'secret',
      },
      body: JSON.stringify({ user: 'U1' }),
    }),
    {
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_NOTIFIER_SHARED_SECRET: 'secret',
      async SLACK_FETCH(url, request) {
        slackRequests.push({ url: String(url), request });
        return new Response(
          JSON.stringify({
            ok: true,
            user: {
              id: 'U1',
              team_id: 'T1',
              name: 'zhangsan',
              real_name: 'Zhang San',
              profile: {
                display_name: '张三',
                real_name: 'Zhang San',
                email: 'zhangsan@example.com',
              },
            },
          })
        );
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(slackRequests[0].url, 'https://slack.com/api/users.info');
  assert.equal(slackRequests[0].request.headers.Authorization, 'Bearer xoxb-test');
  assert.equal(new URLSearchParams(slackRequests[0].request.body).get('user'), 'U1');
  assert.deepEqual(body.profile, {
    source: 'slack.users.info',
    slackTeamId: 'T1',
    slackUserId: 'U1',
    name: 'zhangsan',
    displayName: '张三',
    realName: 'Zhang San',
    email: 'zhangsan@example.com',
  });
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
  assert.match(JSON.stringify(payload.blocks), /最终需求/);
  assert.doesNotMatch(JSON.stringify(payload.blocks), /preview_deployed/);
  assert.equal(body.message.messageTs, '1710000001.000100');
});

test('slack notifier skips stale status card regressions', async () => {
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
          status: 'previewing',
          employeeSlug: 'alice',
          siteSlug: 'profile',
          summary: '个人主页',
          slackThread: {
            channelId: 'C1',
            threadTs: '1710000000.000100',
            userId: 'U1',
          },
        },
        options: { stage: 'previewing' },
        existingMessage: {
          channel: 'C1',
          threadTs: '1710000000.000100',
          messageTs: '1710000001.000100',
          stage: 'preview_deployed',
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

  assert.equal(response.status, 200);
  assert.equal(body.skipped, true);
  assert.equal(body.reason, 'stale_stage');
  assert.deepEqual(slackRequests, []);
});

test('slack notifier can update a deployed preview card for a new fix round', async () => {
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
          status: 'fixing',
          employeeSlug: 'alice',
          siteSlug: 'profile',
          summary: '个人主页\n\n## Slack Follow-up\n\n标题改成中文。',
          slackThread: {
            channelId: 'C1',
            threadTs: '1710000000.000100',
            userId: 'U1',
          },
        },
        options: {
          stage: 'fixing',
          allowRegression: true,
          skipDuplicate: false,
          cardTitle: '第 1 轮修改处理中',
          currentChange: '本轮修改：标题改成中文。',
          statusText: ':hourglass_flowing_sand: 正在更新 PR 和 Preview。',
        },
        existingMessage: {
          channel: 'C1',
          threadTs: '1710000000.000100',
          messageTs: '1710000001.000100',
          stage: 'preview_deployed',
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
  assert.match(JSON.stringify(payload.blocks), /第 1 轮修改处理中/);
  assert.match(JSON.stringify(payload.blocks), /最终需求/);
  assert.match(JSON.stringify(payload.blocks), /本轮修改.*标题改成中文。/);
  assert.doesNotMatch(JSON.stringify(payload.blocks), /Slack Follow-up/);
  assert.doesNotMatch(JSON.stringify(payload.blocks), /\\nfixing/);
  assert.equal(body.message.stage, 'fixing');
});

test('slack notifier renders custom progress text in status cards', async () => {
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
          id: 'job_2',
          status: 'reviewing',
          employeeSlug: 'alice',
          siteSlug: 'profile',
          summary: '个人主页',
          slackThread: {
            channelId: 'C1',
            threadTs: '1710000000.000200',
            userId: 'U1',
          },
        },
        options: {
          stage: 'reviewing',
          text: 'Review Agent 已记录，正在等待 site-check 通过后再生成 Preview。',
        },
      }),
    }),
    {
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_NOTIFIER_SHARED_SECRET: 'secret',
      async SLACK_FETCH(url, request) {
        slackRequests.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '1710000002.000100' }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);
  const payload = JSON.parse(slackRequests[0].request.body);

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.match(JSON.stringify(payload.blocks), /等待 site-check 通过后再生成 Preview/);
});

test('slack notifier renders closed issue status cards as read-only', async () => {
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
          id: 'job_closed',
          status: 'cancelled',
          errorCode: 'github_issue_closed',
          employeeSlug: 'alice',
          siteSlug: 'profile',
          summary: '个人主页',
          issueUrl: 'https://github.example/org/pages-manager/issues/66',
          slackSessionId: 'sess_1',
          slackThread: {
            channelId: 'C1',
            threadTs: '1710000000.000300',
            userId: 'U1',
          },
        },
        options: {
          stage: 'cancelled',
          cardTitle: 'Issue 已关闭',
        },
      }),
    }),
    {
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_NOTIFIER_SHARED_SECRET: 'secret',
      async SLACK_FETCH(url, request) {
        slackRequests.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '1710000003.000100' }), {
          status: 200,
        });
      },
    }
  );
  const payload = JSON.parse(slackRequests[0].request.body);
  const blocksText = JSON.stringify(payload.blocks);

  assert.equal(response.status, 200);
  assert.match(blocksText, /Issue 已关闭/);
  assert.match(blocksText, /任务已停止/);
  assert.match(blocksText, /打开 Issue/);
  assert.doesNotMatch(blocksText, /继续修改可以直接/);
  assert.doesNotMatch(blocksText, /pages_continue_modifying/);
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

test('slack notifier starts and updates an agent reply message', async () => {
  const app = createSlackNotifierApp();
  const slackRequests = [];
  const env = {
    SLACK_BOT_TOKEN: 'xoxb-test',
    SLACK_NOTIFIER_SHARED_SECRET: 'secret',
    async SLACK_FETCH(url, request) {
      slackRequests.push({ url: String(url), request });
      return new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '1710000002.000100' }));
    },
  };

  const startResponse = await app.fetch(
    new Request('http://slack-notifier.test/internal/slack-notifier/agent-reply/start', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pages-Slack-Notifier-Token': 'secret',
      },
      body: JSON.stringify({
        target: { channel: 'C1', thread_ts: '1710000000.000100' },
        options: { text: '<@U1> 我已收到，正在整理需求。' },
      }),
    }),
    env
  );
  const updateResponse = await app.fetch(
    new Request('http://slack-notifier.test/internal/slack-notifier/agent-reply/update', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Pages-Slack-Notifier-Token': 'secret',
      },
      body: JSON.stringify({
        message: { channel: 'C1', messageTs: '1710000002.000100' },
        options: { text: '<@U1> 我整理好了，先等你确认。', status: 'completed' },
      }),
    }),
    env
  );
  const startPayload = JSON.parse(slackRequests[0].request.body);
  const updatePayload = JSON.parse(slackRequests[1].request.body);

  assert.equal(startResponse.status, 200);
  assert.equal(updateResponse.status, 200);
  assert.equal(slackRequests[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(slackRequests[1].url, 'https://slack.com/api/chat.update');
  assert.equal(startPayload.thread_ts, '1710000000.000100');
  assert.match(JSON.stringify(startPayload.blocks), /正在整理/);
  assert.equal(startPayload.blocks[0].type, 'section');
  assert.ok(!startPayload.blocks.some((block) => block.type === 'header'));
  assert.equal(updatePayload.ts, '1710000002.000100');
  assert.match(JSON.stringify(updatePayload.blocks), /我整理好了/);
  assert.equal(updatePayload.blocks[0].type, 'section');
  assert.ok(!updatePayload.blocks.some((block) => block.type === 'header'));
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

test('slack notifier removes working reactions', async () => {
  const app = createSlackNotifierApp();
  const slackRequests = [];
  const response = await app.fetch(
    new Request('http://slack-notifier.test/internal/slack-notifier/reaction-remove', {
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
  assert.equal(slackRequests[0].url, 'https://slack.com/api/reactions.remove');
  assert.deepEqual(payload, {
    channel: 'C1',
    timestamp: '1710000000.000100',
    name: 'eyes',
  });
});
