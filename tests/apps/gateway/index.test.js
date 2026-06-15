import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayApp } from '../../../apps/gateway/src/index.js';

async function json(response) {
  return response.json();
}

async function githubSignature(secret, body) {
  const key = await crypto.subtle.importKey(
    'raw',
    new globalThis.TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new globalThis.TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

async function slackSignature(secret, timestamp, body) {
  const key = await crypto.subtle.importKey(
    'raw',
    new globalThis.TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new globalThis.TextEncoder().encode(`v0:${timestamp}:${body}`));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `v0=${hex}`;
}

async function recordSuccessfulSiteCheck(app, options = {}) {
  const prNumber = options.prNumber || 12;
  const headSha = options.headSha || 'a'.repeat(40);
  await app.store.recordSiteCheckRun({
    repoFullName: options.repoFullName || 'org/pages-manager',
    prNumber,
    checkRunId: options.checkRunId || `site-check-${prNumber}`,
    checkRunNodeId: options.checkRunNodeId || `SCR_SITE_CHECK_${prNumber}`,
    checkName: options.checkName || 'site-check',
    appSlug: options.appSlug || 'github-actions',
    appName: options.appName || 'GitHub Actions',
    status: 'completed',
    conclusion: 'success',
    headSha,
    detailsUrl: options.detailsUrl || `https://github.example/org/pages-manager/actions/runs/${prNumber}`,
    firstSeenDeliveryId: options.deliveryId || `seed-site-check-${prNumber}`,
    lastSeenDeliveryId: options.deliveryId || `seed-site-check-${prNumber}`,
    completedAt: new Date('2026-06-14T00:00:00.000Z').toISOString(),
  });
}

async function moveJobToPrCreated(app, options = {}) {
  const prNumber = options.prNumber || 12;
  const headSha = options.headSha || 'a'.repeat(40);
  const createBody = await json(
    await app.fetch(
      new Request('http://gateway.test/api/publishing-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': options.idempotencyKey || `api-pr-${prNumber}`,
          'X-Pages-Actor-Id': 'usr_1',
        },
        body: JSON.stringify({ employeeSlug: 'zhangsan', siteSlug: 'profile' }),
      })
    )
  );

  for (const stageResult of ['issue_created', 'index_ready', 'pr_created']) {
    const response = await app.fetch(
      new Request('http://gateway.test/internal/executor-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publishingJobId: createBody.job.id,
          stageResult,
          issueNumber: 1,
          indexSnapshotId: 'idxsnap_1',
          branchName: `sites/job-${createBody.job.id}-zhangsan-profile`,
          prNumber,
          prUrl: `https://github.example/org/pages-manager/pull/${prNumber}`,
          baseRef: 'staging',
          headSha,
        }),
      })
    );
    assert.equal(response.status, 200);
  }

  if (options.siteCheck !== false) {
    await recordSuccessfulSiteCheck(app, { prNumber, headSha });
  }

  return createBody.job.id;
}

test('Slack bot events do not receive working reactions', async () => {
  const app = createGatewayApp();
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-bot-reaction-skip',
        event: {
          type: 'message',
          subtype: 'bot_message',
          bot_id: 'B1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000100',
          text: 'status update',
        },
      }),
    }),
    {
      SLACK_EVENTS_PROCESSING_MODE: 'sync',
      SLACK_REACTION_ON_RECEIVE: 'true',
      SLACK_BOT_TOKEN: 'xoxb-test',
      async SLACK_FETCH() {
        throw new Error('bot events should not call Slack API');
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'ignored_slack_event');
  assert.equal(body.reason, 'ignored_bot_event');
});

test('API creates a PublishingJob without requiring GitHub repo user permissions', async () => {
  const app = createGatewayApp();
  const response = await app.fetch(
    new Request('http://gateway.test/api/publishing-jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'api-smoke-1',
        'X-Pages-Actor-Id': 'usr_no_github_access',
      },
      body: JSON.stringify({
        employeeSlug: 'zhangsan',
        siteSlug: 'profile',
        brief: 'Create a profile page',
      }),
    })
  );

  const body = await json(response);
  assert.equal(response.status, 201);
  assert.equal(body.created, true);
  assert.equal(body.job.requestedById, 'usr_no_github_access');
  assert.equal(body.job.status, 'received');
});

test('gateway readiness checks the runtime store', async () => {
  const app = createGatewayApp({
    store: {
      backend: 'mysql',
      async health() {
        return { ok: true, backend: 'mysql' };
      },
    },
  });

  const health = await json(await app.fetch(new Request('http://gateway.test/health')));
  const readyResponse = await app.fetch(new Request('http://gateway.test/ready'));
  const ready = await json(readyResponse);

  assert.equal(health.storeBackend, 'mysql');
  assert.equal(readyResponse.status, 200);
  assert.equal(ready.status, 'ready');
  assert.equal(ready.storeBackend, 'mysql');
});

test('gateway readiness fails closed when store health fails', async () => {
  const app = createGatewayApp({
    store: {
      backend: 'mysql',
      async health() {
        throw new Error('database unavailable');
      },
    },
  });

  const response = await app.fetch(new Request('http://gateway.test/ready'));
  const body = await json(response);

  assert.equal(response.status, 503);
  assert.equal(body.status, 'not_ready');
  assert.equal(body.storeBackend, 'mysql');
  assert.equal(body.error, 'database unavailable');
});

test('API create is idempotent by actor and idempotency key', async () => {
  const app = createGatewayApp();
  const request = () =>
    new Request('http://gateway.test/api/publishing-jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'api-smoke-2',
        'X-Pages-Actor-Id': 'usr_1',
      },
      body: JSON.stringify({ employeeSlug: 'zhangsan', siteSlug: 'profile' }),
    });

  const first = await json(await app.fetch(request()));
  const secondResponse = await app.fetch(request());
  const second = await json(secondResponse);

  assert.equal(secondResponse.status, 200);
  assert.equal(first.job.id, second.job.id);
  assert.equal(second.created, false);
});

test('API lists PublishingJobs for ACK smoke troubleshooting', async () => {
  const app = createGatewayApp();

  for (const [idempotencyKey, employeeSlug, siteSlug] of [
    ['api-list-1', 'alice', 'profile'],
    ['api-list-2', 'bob', 'portfolio'],
  ]) {
    const response = await app.fetch(
      new Request('http://gateway.test/api/publishing-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': idempotencyKey,
          'X-Pages-Actor-Id': 'usr_list',
        },
        body: JSON.stringify({ employeeSlug, siteSlug }),
      })
    );
    assert.equal(response.status, 201);
  }

  const listed = await json(await app.fetch(new Request('http://gateway.test/api/publishing-jobs?source=api&q=portfolio')));

  assert.equal(listed.total, 1);
  assert.equal(listed.limit, 50);
  assert.equal(listed.offset, 0);
  assert.equal(listed.jobs[0].employeeSlug, 'bob');
  assert.equal(listed.jobs[0].siteSlug, 'portfolio');
});

test('Slack event creates a slack-sourced job', async () => {
  const app = createGatewayApp();
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000100',
          text: 'issue: 帮我创建 profile 页面',
        },
      }),
    })
  );

  const body = await json(response);
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);

  const jobResponse = await app.fetch(new Request(`http://gateway.test/api/publishing-jobs/${body.jobId}`));
  const jobBody = await json(jobResponse);
  assert.equal(jobBody.job.source, 'slack');
  assert.equal(jobBody.job.requestedById, 'slack:T1:U1');
  assert.equal(jobBody.job.slackSessionId, body.slackSessionId);
  assert.match(jobBody.job.slackSessionKey, /^dm-thread:D1:1710000000\.000100$/);
  assert.deepEqual(jobBody.job.slackThread, {
    teamId: 'T1',
    channelId: 'D1',
    channelType: 'im',
    messageTs: '1710000000.000100',
    threadTs: '1710000000.000100',
    userId: 'U1',
  });

  const deliveries = app.store.listSlackDeliveries({ eventId: 'Ev1' });
  assert.equal(deliveries.total, 1);
  assert.equal(deliveries.deliveries[0].processingStatus, 'processed');
  assert.equal(deliveries.deliveries[0].resultType, 'job_created');
  assert.equal(deliveries.deliveries[0].publishingJobId, body.jobId);
  assert.equal(deliveries.deliveries[0].slackSessionId, body.slackSessionId);
  assert.equal(deliveries.deliveries[0].channelId, 'D1');
  assert.equal(deliveries.deliveries[0].threadTs, '1710000000.000100');
});

test('Slack event snapshots requester profile when bot token can read Slack user info', async () => {
  const app = createGatewayApp();
  const profileCalls = [];
  const slackMessages = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-profile-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000106',
          text: 'issue: 帮我创建 profile 页面',
        },
      }),
    }),
    {
      SLACK_BOT_TOKEN: 'test-slack-token',
      async SLACK_PROFILE_FETCH(url, request) {
        profileCalls.push({ url: String(url), request });
        assert.equal(String(url), 'https://slack.com/api/users.info');
        assert.equal(new URLSearchParams(request.body).get('user'), 'U1');
        return new Response(
          JSON.stringify({
            ok: true,
            user: {
              id: 'U1',
              team_id: 'T1',
              name: 'zhangsan',
              profile: {
                display_name: '张三',
                real_name: 'Zhang San',
                email: 'zhangsan@example.com',
              },
            },
          }),
          { status: 200 }
        );
      },
      async SLACK_FETCH(url, request) {
        slackMessages.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '1710000001.000106' }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);
  const jobBody = await json(await app.fetch(new Request(`http://gateway.test/api/publishing-jobs/${body.jobId}`)));

  assert.equal(response.status, 200);
  assert.equal(profileCalls.length, 1);
  assert.equal(slackMessages.length, 1);
  assert.match(jobBody.job.employeeSlug, /^zhangsan-[a-z0-9]{6}$/);
  assert.deepEqual(jobBody.job.requesterProfile, {
    source: 'slack.users.info',
    slackTeamId: 'T1',
    slackUserId: 'U1',
    name: 'zhangsan',
    displayName: '张三',
    realName: 'Zhang San',
    email: 'zhangsan@example.com',
  });
});

test('Slack event can snapshot requester profile through slack-notifier', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-profile-notifier-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000107',
          text: 'issue: 帮我创建 profile 页面',
        },
      }),
    }),
    {
      SLACK_NOTIFIER_URL: 'http://slack-notifier.test',
      SLACK_NOTIFIER_SHARED_SECRET: 'notifier-secret',
      async SLACK_NOTIFIER_FETCH(url, request) {
        notifierCalls.push({ url: String(url), request });
        assert.equal(request.headers['X-Pages-Slack-Notifier-Token'], 'notifier-secret');
        if (String(url).endsWith('/internal/slack-notifier/job-status')) {
          return new Response(
            JSON.stringify({
              ok: true,
              action: 'posted',
              channel: 'D1',
              ts: '1710000001.000107',
              message: {
                channel: 'D1',
                threadTs: '1710000000.000107',
                messageTs: '1710000001.000107',
                stage: 'received',
                status: 'received',
              },
            })
          );
        }
        if (String(url).endsWith('/internal/slack-notifier/job-message')) {
          return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '1710000002.000107' }));
        }
        return new Response(
          JSON.stringify({
            ok: true,
            profile: {
              source: 'slack.users.info',
              slackTeamId: 'T1',
              slackUserId: 'U1',
              name: 'zhangsan',
              displayName: '张三',
              realName: 'Zhang San',
              email: 'zhangsan@example.com',
            },
          })
        );
      },
    }
  );
  const body = await json(response);
  const jobBody = await json(await app.fetch(new Request(`http://gateway.test/api/publishing-jobs/${body.jobId}`)));

  assert.equal(response.status, 200);
  const profileCall = notifierCalls.find((call) => call.url === 'http://slack-notifier.test/internal/slack-notifier/user-info');
  assert.ok(profileCall);
  assert.equal(JSON.parse(profileCall.request.body).user, 'U1');
  assert.match(jobBody.job.employeeSlug, /^zhangsan-[a-z0-9]{6}$/);
  assert.equal(jobBody.job.requesterProfile.email, 'zhangsan@example.com');
});

test('Slack event can use Slack Agent analysis before creating a job', async () => {
  const app = createGatewayApp();
  const agentCalls = [];
  const slackMessages = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000101',
          text: 'issue: 帮我创建 profile 页面',
        },
      }),
    }),
    {
      SLACK_AGENT_ANALYZE_URL: 'http://slack-agent.test/internal/slack-agent/analyze',
      SLACK_AGENT_SHARED_SECRET: 'agent-secret',
      SLACK_BOT_TOKEN: 'test-slack-token',
      async SLACK_PROFILE_FETCH() {
        return new Response(JSON.stringify({ ok: true, user: { id: 'U1', profile: {} } }), { status: 200 });
      },
      async SLACK_AGENT_FETCH(url, request) {
        agentCalls.push({ url: String(url), request });
        assert.equal(request.headers['X-Pages-Slack-Agent-Token'], 'agent-secret');
        const payload = JSON.parse(request.body);
        assert.equal(payload.slackSession.primarySlackUserId, 'U1');
        assert.equal(payload.sessionMemory.slackSessionId, payload.slackSession.id);
        assert.equal(payload.agentRun.agentKind, 'slack_agent');
        return new Response(
          JSON.stringify({
            ok: true,
            analysis: {
              intent: 'create_or_update_site',
              employeeSlug: 'alice',
              siteSlug: 'portfolio',
              title: 'Agent title',
              summary: 'Agent summary',
              approvalMode: 'manual_required',
            },
          }),
          { status: 200 }
        );
      },
      async SLACK_FETCH(url, request) {
        slackMessages.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '1710000001.000101' }), {
          status: 200,
        });
      },
    }
  );

  const body = await json(response);
  const jobBody = await json(await app.fetch(new Request(`http://gateway.test/api/publishing-jobs/${body.jobId}`)));

  assert.equal(response.status, 200);
  assert.equal(agentCalls.length, 1);
  assert.equal(body.slackAgentAnalysis.summary, 'Agent summary');
  assert.equal(body.slackStatusNotification.ok, true);
  assert.match(JSON.stringify(JSON.parse(slackMessages[0].request.body).blocks), /Agent summary/);
  assert.match(jobBody.job.employeeSlug, /^u1-[a-z0-9]{6}$/);
  assert.notEqual(jobBody.job.employeeSlug, 'alice');
  assert.equal(jobBody.job.siteSlug, 'portfolio');
  assert.equal(jobBody.job.intent, 'create_or_update_site');
  assert.equal(jobBody.job.summary, 'Agent summary');
});

test('Slack free-form turn asks clarification through Slack Agent without creating a job', async () => {
  const app = createGatewayApp();
  const agentCalls = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-clarify-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000102',
          text: '先聊聊我个人品牌的方向',
        },
      }),
    }),
    {
      SLACK_AGENT_ANALYZE_URL: 'http://slack-agent.test/internal/slack-agent/analyze',
      async SLACK_AGENT_FETCH(url, request) {
        agentCalls.push({ url: String(url), request });
        const payload = JSON.parse(request.body);
        assert.equal(payload.text, '先聊聊我个人品牌的方向');
        assert.equal(payload.slackSession.primarySlackUserId, 'U1');
        return new Response(
          JSON.stringify({
            ok: true,
            analysis: {
              intent: 'clarify',
              summary: '可以，我需要先确认你想突出哪些内容：项目、履历还是设计风格？',
              needsClarification: true,
            },
          }),
          { status: 200 }
        );
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'clarification_needed');
  assert.equal(body.accepted, false);
  assert.equal(body.jobId, undefined);
  assert.match(body.replyText, /需要先确认/);
  assert.equal(agentCalls.length, 1);
  assert.equal(app.store.jobs.size, 0);
});

test('Slack free-form turn asks for confirmation before creating an issue', async () => {
  const app = createGatewayApp();
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-freeform-create-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000103',
          text: '我想做一个个人主页，突出项目经历和联系方式',
        },
      }),
    }),
    {
      SLACK_AGENT_ANALYZE_URL: 'http://slack-agent.test/internal/slack-agent/analyze',
      async SLACK_AGENT_FETCH() {
        return new Response(
          JSON.stringify({
            ok: true,
            analysis: {
              intent: 'create_or_update_site',
              employeeSlug: 'alice',
              siteSlug: 'brand',
              title: 'Alice personal brand page',
              summary: '用户希望创建一个突出项目经历和联系方式的个人主页。',
              needsClarification: false,
            },
          }),
          { status: 200 }
        );
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'confirm_before_issue');
  assert.equal(body.accepted, false);
  assert.equal(body.jobId, undefined);
  assert.match(body.replyText, /不会创建 issue/);
  assert.match(body.replyText, /确认创建发布任务/);
  assert.equal(app.store.jobs.size, 0);
});

test('Slack free-form turn can create a job after explicit confirmation', async () => {
  const app = createGatewayApp();
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-freeform-confirmed-create-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000108',
          text: '个人品牌想走清爽可信的路线，信息足够，请直接创建发布任务',
        },
      }),
    }),
    {
      SLACK_AGENT_ANALYZE_URL: 'http://slack-agent.test/internal/slack-agent/analyze',
      async SLACK_AGENT_FETCH() {
        return new Response(
          JSON.stringify({
            ok: true,
            analysis: {
              intent: 'create_or_update_site',
              employeeSlug: 'alice',
              siteSlug: 'brand',
              title: 'Alice personal brand page',
              summary: '用户希望创建一个清爽可信的个人品牌页面。',
              needsClarification: false,
            },
          }),
          { status: 200 }
        );
      },
    }
  );
  const body = await json(response);
  const jobBody = await json(await app.fetch(new Request(`http://gateway.test/api/publishing-jobs/${body.jobId}`)));

  assert.equal(response.status, 200);
  assert.equal(body.action, 'create_job');
  assert.equal(body.accepted, true);
  assert.match(jobBody.job.employeeSlug, /^u1-[a-z0-9]{6}$/);
  assert.notEqual(jobBody.job.employeeSlug, 'alice');
  assert.equal(jobBody.job.siteSlug, 'brand');
  assert.equal(jobBody.job.summary, '用户希望创建一个清爽可信的个人品牌页面。');
});

test('Slack free-form turn stays conversational when Slack Agent is not configured', async () => {
  const app = createGatewayApp();
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-freeform-no-provider-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000104',
          text: '先聊聊我个人品牌的方向',
        },
      }),
    })
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'agent_turn');
  assert.equal(body.accepted, false);
  assert.equal(body.jobId, undefined);
  assert.match(body.replyText, /没有可用的 Slack Agent/);
  assert.equal(app.store.jobs.size, 0);
});

test('Slack free-form turn redacts token-like content from gateway session memory', async () => {
  const app = createGatewayApp();
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-redact-memory-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000105',
          text: '先聊聊 sk-123456789012345678901234',
        },
      }),
    })
  );
  const body = await json(response);
  const memory = app.store.getSessionMemory(body.slackSessionId);

  assert.equal(response.status, 200);
  assert.equal(body.accepted, false);
  assert.doesNotMatch(JSON.stringify(memory), /sk-123456789012345678901234/);
  assert.match(JSON.stringify(memory), /\[REDACTED_API_KEY\]/);
});

test('executor callbacks notify the source Slack thread', async () => {
  const app = createGatewayApp();
  const slackMessages = [];
  const createResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-slack-notify-1',
        event: {
          type: 'app_mention',
          user: 'U1',
          channel: 'C1',
          channel_type: 'channel',
          ts: '1710000000.000200',
          text: 'issue: 帮我创建 profile 页面',
        },
      }),
    })
  );
  const created = await json(createResponse);

  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: created.jobId,
        stageResult: 'issue_created',
        issueNumber: 8,
        issueUrl: 'https://github.example/org/pages-manager/issues/8',
      }),
    }),
    {
      SLACK_BOT_TOKEN: 'test-slack-token',
      SLACK_USER_PROFILE_LOOKUP: 'false',
      async SLACK_FETCH(url, request) {
        slackMessages.push({ url: String(url), request });
        assert.equal(request.headers.Authorization, 'Bearer test-slack-token');
        return new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '1710000001.000100' }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.slackStatusNotification.ok, true);
  assert.equal(body.slackStatusNotification.action, 'posted');
  assert.equal(body.slackNotification.ok, true);
  assert.equal(slackMessages.length, 2);
  const statusPayload = JSON.parse(slackMessages[0].request.body);
  assert.equal(slackMessages[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(statusPayload.channel, 'C1');
  assert.equal(statusPayload.thread_ts, '1710000000.000200');
  assert.match(statusPayload.text, /^<@U1> Pages 发布任务/);
  assert.ok(Array.isArray(statusPayload.blocks));
  assert.match(JSON.stringify(statusPayload.blocks), /Issue 已创建/);
  assert.match(JSON.stringify(statusPayload.blocks), /查看 Issue/);
  assert.deepEqual(JSON.parse(slackMessages[1].request.body), {
    channel: 'C1',
    thread_ts: '1710000000.000200',
    text: '<@U1> 已创建 GitHub issue：#8\nhttps://github.example/org/pages-manager/issues/8',
  });
  assert.equal(body.job.issueUrl, 'https://github.example/org/pages-manager/issues/8');

  const duplicate = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: created.jobId,
        stageResult: 'issue_created',
        issueNumber: 8,
        issueUrl: 'https://github.example/org/pages-manager/issues/8',
      }),
    }),
    {
      SLACK_BOT_TOKEN: 'test-slack-token',
      async SLACK_FETCH() {
        throw new Error('duplicate callback should not post to Slack');
      },
    }
  );
  const duplicateBody = await json(duplicate);
  assert.equal(duplicateBody.slackStatusNotification.skipped, true);
  assert.equal(duplicateBody.slackNotification.skipped, true);
});

test('executor callbacks update the Slack status card in place', async () => {
  const app = createGatewayApp();
  const slackMessages = [];
  const createResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-slack-card-1',
        event: {
          type: 'app_mention',
          user: 'U1',
          channel: 'C1',
          channel_type: 'channel',
          ts: '1710000000.000210',
          text: 'issue: 帮我创建 profile 页面，突出项目经历',
        },
      }),
    }),
    {
      SLACK_BOT_TOKEN: 'test-slack-token',
      SLACK_USER_PROFILE_LOOKUP: 'false',
      async SLACK_FETCH(url, request) {
        slackMessages.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '1710000001.000210' }), {
          status: 200,
        });
      },
    }
  );
  const created = await json(createResponse);
  assert.equal(created.slackStatusNotification.action, 'posted');
  assert.equal(slackMessages.length, 1);

  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: created.jobId,
        stageResult: 'issue_created',
        issueNumber: 18,
        issueUrl: 'https://github.example/org/pages-manager/issues/18',
      }),
    }),
    {
      SLACK_BOT_TOKEN: 'test-slack-token',
      async SLACK_FETCH(url, request) {
        slackMessages.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '1710000001.000210' }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);
  const updatePayload = JSON.parse(slackMessages[1].request.body);

  assert.equal(response.status, 200);
  assert.equal(body.slackStatusNotification.action, 'updated');
  assert.equal(slackMessages[1].url, 'https://slack.com/api/chat.update');
  assert.equal(updatePayload.channel, 'C1');
  assert.equal(updatePayload.ts, '1710000001.000210');
  assert.ok(Array.isArray(updatePayload.blocks));
  assert.match(JSON.stringify(updatePayload.blocks), /Issue 已创建/);
  assert.match(JSON.stringify(updatePayload.blocks), /https:\/\/github.example\/org\/pages-manager\/issues\/18/);
});

test('preview_deployed status card includes the preview link', async () => {
  const app = createGatewayApp();
  const slackMessages = [];
  const createResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-slack-preview-card-1',
        event: {
          type: 'app_mention',
          user: 'U1',
          channel: 'C1',
          channel_type: 'channel',
          ts: '1710000000.000220',
          text: 'issue: 帮我创建 profile 页面',
        },
      }),
    })
  );
  const created = await json(createResponse);

  for (const stageResult of ['issue_created', 'index_ready', 'pr_created']) {
    const stageResponse = await app.fetch(
      new Request('http://gateway.test/internal/executor-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publishingJobId: created.jobId,
          stageResult,
          issueNumber: 19,
          issueUrl: 'https://github.example/org/pages-manager/issues/19',
          indexSnapshotId: 'idxsnap_19',
          branchName: 'sites/job-preview-card-smoke-profile',
          prNumber: 29,
          prUrl: 'https://github.example/org/pages-manager/pull/29',
          headSha: 'a'.repeat(40),
        }),
      })
    );
    assert.equal(stageResponse.status, 200);
  }
  app.store.recordSlackJobStatusMessage(created.jobId, {
    channel: 'C1',
    threadTs: '1710000000.000220',
    messageTs: '1710000001.000220',
    stage: 'pr_created',
  });

  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: created.jobId,
        stageResult: 'preview_deployed',
        previewUrl: 'https://preview.example.test',
      }),
    }),
    {
      SLACK_BOT_TOKEN: 'test-slack-token',
      async SLACK_FETCH(url, request) {
        slackMessages.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '1710000001.000220' }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);
  const updatePayload = JSON.parse(slackMessages[0].request.body);

  assert.equal(response.status, 200);
  assert.equal(body.slackStatusNotification.action, 'updated');
  assert.equal(slackMessages[0].url, 'https://slack.com/api/chat.update');
  assert.match(JSON.stringify(updatePayload.blocks), /Preview 已生成/);
  assert.match(JSON.stringify(updatePayload.blocks), /https:\/\/preview.example.test/);
  assert.match(JSON.stringify(updatePayload.blocks), /打开 Preview/);
});

test('Slack help and ping messages do not create jobs', async () => {
  const app = createGatewayApp();
  const workerStarts = [];

  for (const [eventId, text, action] of [
    ['Ev-help-1', '帮助', 'help'],
    ['Ev-ping-1', '1', 'ping'],
  ]) {
    const response = await app.fetch(
      new Request('http://gateway.test/integrations/slack/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_id: 'T1',
          event_id: eventId,
          event: {
            type: 'message',
            user: 'U1',
            channel_type: 'im',
            text,
          },
        }),
      }),
      {
        PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
        async WORKER_FETCH(url, request) {
          workerStarts.push({ url: String(url), request });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      }
    );
    const body = await json(response);
    assert.equal(response.status, 200);
    assert.equal(body.action, action);
    assert.equal(body.accepted, false);
    assert.equal(body.jobId, undefined);
    assert.match(body.replyText, action === 'help' ? /自然语言/ : /我在/);
  }

  assert.equal(workerStarts.length, 0);
});

test('Slack status message reads an existing job without creating a new one', async () => {
  const app = createGatewayApp();
  const createResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-create-before-status',
        event: {
          type: 'message',
          user: 'U1',
          channel_type: 'im',
          text: 'issue: 创建一个 issue',
        },
      }),
    })
  );
  const created = await json(createResponse);

  const statusResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-status-1',
        event: {
          type: 'message',
          user: 'U1',
          channel_type: 'im',
          text: `状态 ${created.jobId}`,
        },
      }),
    })
  );
  const body = await json(statusResponse);

  assert.equal(statusResponse.status, 200);
  assert.equal(body.action, 'status');
  assert.equal(body.accepted, false);
  assert.equal(body.jobId, undefined);
  assert.match(body.replyText, new RegExp(created.jobId));
  assert.match(body.replyText, /状态：received/);
});

test('Slack event can start the worker without requiring user GitHub permissions', async () => {
  const app = createGatewayApp();
  const workerStarts = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-worker-1',
        event: {
          type: 'message',
          user: 'U1',
          channel_type: 'im',
          text: 'issue: 帮我创建 profile 页面',
        },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      PAGES_WORKER_SHARED_SECRET: 'worker-secret',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        assert.equal(request.headers['X-Pages-Worker-Token'], 'worker-secret');
        assert.equal(JSON.parse(request.body).job.requestedById, 'slack:T1:U1');
        return new Response(JSON.stringify({ ok: true, result: { action: 'issue_created_and_project_index_dispatched' } }), {
          status: 200,
        });
      },
    }
  );

  const body = await json(response);
  assert.equal(response.status, 200);
  assert.equal(body.workerStart.started, true);
  assert.equal(workerStarts.length, 1);
});

test('index_ready callback can start worker to dispatch pages-agent', async () => {
  const app = createGatewayApp();
  const createBody = await json(
    await app.fetch(
      new Request('http://gateway.test/api/publishing-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'api-index-ready-worker',
          'X-Pages-Actor-Id': 'usr_1',
        },
        body: JSON.stringify({ employeeSlug: 'zhangsan', siteSlug: 'profile' }),
      })
    )
  );
  const workerStarts = [];

  const issueResponse = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: createBody.job.id,
        stageResult: 'issue_created',
        issueNumber: 9,
      }),
    })
  );
  assert.equal(issueResponse.status, 200);

  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: createBody.job.id,
        stageResult: 'index_ready',
        indexSnapshotId: 'idxsnap_1',
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        const body = JSON.parse(request.body);
        assert.equal(body.job.status, 'generating_page');
        assert.equal(body.job.indexSnapshotId, 'idxsnap_1');
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_agent_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.job.status, 'generating_page');
  assert.equal(body.workerStart.started, true);
  assert.equal(workerStarts.length, 1);
});

test('Slack HTTP events require a valid Slack signature when configured', async () => {
  const app = createGatewayApp();
  const secret = 'slack-signing-secret';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({
    team_id: 'T1',
    event_id: 'Ev-secure-1',
    event: {
      type: 'message',
      user: 'U1',
      channel: 'D1',
      channel_type: 'im',
      text: 'secure request',
    },
  });
  const request = (signature) =>
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': timestamp,
        ...(signature ? { 'X-Slack-Signature': signature } : {}),
      },
      body,
    });

  const rejected = await app.fetch(request('v0=bad'), { SLACK_SIGNING_SECRET: secret, SLACK_EVENTS_PROCESSING_MODE: 'sync' });
  assert.equal(rejected.status, 401);

  const accepted = await app.fetch(request(await slackSignature(secret, timestamp, body)), {
    SLACK_SIGNING_SECRET: secret,
    SLACK_EVENTS_PROCESSING_MODE: 'sync',
  });
  assert.equal(accepted.status, 200);
});

test('Slack HTTP events fail closed when production signature config is missing', async () => {
  const app = createGatewayApp();
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-missing-signing-secret',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          text: 'secure request',
        },
      }),
    }),
    {
      NODE_ENV: 'production',
      SLACK_EVENTS_PROCESSING_MODE: 'async',
    }
  );
  const body = await json(response);

  assert.equal(response.status, 401);
  assert.equal(body.error, 'Slack signing secret is not configured');
});

test('Slack HTTP url verification echoes the challenge as plain text', async () => {
  const app = createGatewayApp();
  const secret = 'slack-signing-secret';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const body = JSON.stringify({ type: 'url_verification', challenge: 'challenge-value' });
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Slack-Request-Timestamp': timestamp,
        'X-Slack-Signature': await slackSignature(secret, timestamp, body),
      },
      body,
    }),
    { SLACK_SIGNING_SECRET: secret }
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Type'), 'text/plain; charset=utf-8');
  assert.equal(await response.text(), 'challenge-value');
});

test('Slack HTTP auth failures log only safe diagnostics', async () => {
  const app = createGatewayApp();
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(line);

  try {
    const response = await app.fetch(
      new Request('http://gateway.test/integrations/slack/events', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'Slackbot 1.0 (+https://api.slack.com/robots)',
        },
        body: JSON.stringify({ type: 'event_callback', event_id: 'Ev-missing-signature' }),
      }),
      { SLACK_SIGNING_SECRET: 'slack-signing-secret', SLACK_SIGNATURE_REQUIRED: 'true' }
    );

    assert.equal(response.status, 401);
  } finally {
    console.log = originalLog;
  }

  const diagnostic = logs.map((line) => JSON.parse(line)).find((line) => line.message === 'slack_http_request_failed');
  assert.equal(diagnostic.path, '/integrations/slack/events');
  assert.equal(diagnostic.status, 401);
  assert.equal(diagnostic.error, 'Missing Slack signature');
  assert.equal(diagnostic.slackSignaturePresent, false);
  assert.equal(diagnostic.slackTimestampPresent, false);
  assert.doesNotMatch(JSON.stringify(diagnostic), /Ev-missing-signature|slack-signing-secret|v0=/);
});

test('Slack interaction can close only the caller owned session', async () => {
  const app = createGatewayApp();
  const created = await json(
    await app.fetch(
      new Request('http://gateway.test/integrations/slack/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_id: 'T1',
          event_id: 'Ev-interaction-close-1',
          event: {
            type: 'message',
            user: 'U1',
            channel: 'D1',
            channel_type: 'im',
            ts: '1710000000.000310',
            text: 'issue: 做一个个人主页',
          },
        }),
      })
    )
  );
  const secret = 'slack-signing-secret';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = JSON.stringify({
    type: 'block_actions',
    team: { id: 'T1' },
    user: { id: 'U1' },
    actions: [{ action_id: 'pages_close_session', value: created.slackSessionId }],
  });
  const formBody = new URLSearchParams({ payload }).toString();

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Slack-Request-Timestamp': timestamp,
        'X-Slack-Signature': await slackSignature(secret, timestamp, formBody),
      },
      body: formBody,
    }),
    { SLACK_SIGNING_SECRET: secret }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.match(body.text, /已关闭/);
  assert.equal(app.store.getSlackSession(created.slackSessionId).status, 'closed');
});

test('executor callback advances the preview loop', async () => {
  const app = createGatewayApp();
  const createBody = await json(
    await app.fetch(
      new Request('http://gateway.test/api/publishing-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'api-smoke-3',
          'X-Pages-Actor-Id': 'usr_1',
        },
        body: JSON.stringify({ employeeSlug: 'zhangsan', siteSlug: 'profile' }),
      })
    )
  );

  for (const stageResult of ['issue_created', 'index_ready', 'patch_generated', 'branch_committed', 'pr_created']) {
    const response = await app.fetch(
      new Request('http://gateway.test/internal/executor-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publishingJobId: createBody.job.id,
          stageResult,
          issueNumber: 1,
          indexSnapshotId: 'idxsnap_1',
          branchName: 'sites/job-test-zhangsan-profile',
          prNumber: 2,
        }),
      })
    );
    assert.equal(response.status, 200);
  }

  const previewResponse = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: createBody.job.id,
        stageResult: 'preview_deployed',
        previewUrl: 'https://preview.example.test',
      }),
    })
  );
  const body = await json(previewResponse);

  assert.equal(body.job.status, 'preview_deployed');
  assert.equal(body.job.previewUrl, 'https://preview.example.test');
});

test('Slack follow-up on an active preview dispatches a fix round instead of creating a new job', async () => {
  const app = createGatewayApp();
  const createResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-followup-create',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000100',
          text: 'issue: 帮我创建 profile 页面',
        },
      }),
    })
  );
  const created = await json(createResponse);

  for (const [stageResult, patch] of [
    [
      'issue_created',
      {
        issueNumber: 21,
        issueUrl: 'https://github.example/org/pages-manager/issues/21',
      },
    ],
    [
      'pr_created',
      {
        issueNumber: 21,
        branchName: 'sites/job-followup-smoke-profile',
        prNumber: 31,
        prUrl: 'https://github.example/org/pages-manager/pull/31',
        headSha: '1'.repeat(40),
      },
    ],
    [
      'preview_deployed',
      {
        previewUrl: 'https://preview.example.test',
      },
    ],
  ]) {
    const response = await app.fetch(
      new Request('http://gateway.test/internal/executor-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publishingJobId: created.jobId,
          stageResult,
          ...patch,
        }),
      })
    );
    assert.equal(response.status, 200);
  }

  const workerStarts = [];
  const agentCalls = [];
  const followupResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-followup-fix',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000010.000100',
          thread_ts: '1710000000.000100',
          text: '这个 preview 不满意，把标题改成中文，再加一个项目经历区域',
        },
      }),
    }),
    {
      SLACK_AGENT_ANALYZE_URL: 'http://slack-agent.test/internal/slack-agent/analyze',
      async SLACK_AGENT_FETCH(url, request) {
        agentCalls.push({ url: String(url), request });
        const payload = JSON.parse(request.body);
        assert.equal(payload.slackSession.activeJobId, created.jobId);
        assert.equal(payload.issueLinks.length, 1);
        return new Response(
          JSON.stringify({
            ok: true,
            analysis: {
              intent: 'append_requirement',
              summary: '把标题改成中文，再加一个项目经历区域。',
              needsClarification: false,
            },
          }),
          { status: 200 }
        );
      },
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        const body = JSON.parse(request.body);
        assert.equal(body.job.id, created.jobId);
        assert.equal(body.job.status, 'fixing');
        assert.equal(body.job.prNumber, 31);
        assert.equal(body.job.previewUrl, null);
        assert.match(body.job.summary, /Slack Follow-up/);
        assert.match(body.job.summary, /标题改成中文/);
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_agent_fix_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const followup = await json(followupResponse);
  const jobBody = await json(await app.fetch(new Request(`http://gateway.test/api/publishing-jobs/${created.jobId}`)));

  assert.equal(followupResponse.status, 200);
  assert.equal(followup.action, 'followup_fix_dispatched');
  assert.equal(followup.jobId, created.jobId);
  assert.match(followup.replyText, /同一个 PR/);
  assert.equal(jobBody.job.status, 'fixing');
  assert.equal(jobBody.job.previewUrl, null);
  assert.equal(agentCalls.length, 1);
  assert.equal(workerStarts.length, 1);
});

test('Slack confirmation after preview does not dispatch another fix round', async () => {
  const app = createGatewayApp();
  const createResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-confirm-create',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000120',
          text: 'issue: 帮我创建 profile 页面',
        },
      }),
    })
  );
  const created = await json(createResponse);

  for (const [stageResult, patch] of [
    [
      'issue_created',
      {
        issueNumber: 22,
        issueUrl: 'https://github.example/org/pages-manager/issues/22',
      },
    ],
    [
      'pr_created',
      {
        issueNumber: 22,
        branchName: 'sites/job-confirm-smoke-profile',
        prNumber: 32,
        prUrl: 'https://github.example/org/pages-manager/pull/32',
        headSha: '2'.repeat(40),
      },
    ],
    [
      'preview_deployed',
      {
        previewUrl: 'https://preview.example.test/confirmed',
      },
    ],
  ]) {
    const response = await app.fetch(
      new Request('http://gateway.test/internal/executor-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publishingJobId: created.jobId,
          stageResult,
          ...patch,
        }),
      })
    );
    assert.equal(response.status, 200);
  }

  const workerStarts = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-confirm-preview',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000010.000120',
          text: '这个版本可以，帮我保留这个 preview。',
        },
      }),
    }),
    {
      SLACK_AGENT_ANALYZE_URL: 'http://slack-agent.test/internal/slack-agent/analyze',
      async SLACK_AGENT_FETCH() {
        return new Response(
          JSON.stringify({
            ok: true,
            analysis: {
              intent: 'confirm_preview',
              summary: '已记录用户确认当前 preview 可以保留。',
              needsClarification: false,
            },
          }),
          { status: 200 }
        );
      },
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }
  );
  const body = await json(response);
  const jobBody = await json(await app.fetch(new Request(`http://gateway.test/api/publishing-jobs/${created.jobId}`)));

  assert.equal(response.status, 200);
  assert.equal(body.action, 'agent_turn_recorded');
  assert.equal(body.accepted, false);
  assert.equal(body.jobId, undefined);
  assert.equal(jobBody.job.status, 'preview_deployed');
  assert.equal(jobBody.job.previewUrl, 'https://preview.example.test/confirmed');
  assert.equal(workerStarts.length, 0);
  assert.equal(app.store.jobs.size, 1);
});

test('Slack channel thread replies can continue an existing session without another mention', async () => {
  const app = createGatewayApp();
  const createResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-thread-followup-create',
        event: {
          type: 'app_mention',
          user: 'U1',
          channel: 'C1',
          channel_type: 'channel',
          ts: '1710000100.000100',
          text: 'issue: 帮我创建 profile 页面',
        },
      }),
    })
  );
  const created = await json(createResponse);

  for (const [stageResult, patch] of [
    ['issue_created', { issueNumber: 51, issueUrl: 'https://github.example/org/pages-manager/issues/51' }],
    [
      'pr_created',
      {
        branchName: 'sites/job-thread-followup-smoke-profile',
        prNumber: 61,
        prUrl: 'https://github.example/org/pages-manager/pull/61',
        headSha: '6'.repeat(40),
      },
    ],
    ['preview_deployed', { previewUrl: 'https://preview.example.test/thread' }],
  ]) {
    const response = await app.fetch(
      new Request('http://gateway.test/internal/executor-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publishingJobId: created.jobId,
          stageResult,
          ...patch,
        }),
      })
    );
    assert.equal(response.status, 200);
  }

  const workerStarts = [];
  const followupResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-thread-followup-plain',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'C1',
          channel_type: 'channel',
          ts: '1710000110.000100',
          thread_ts: '1710000100.000100',
          text: '这个 preview 不满意，把标题改成中文',
        },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        const body = JSON.parse(request.body);
        assert.equal(body.job.id, created.jobId);
        assert.equal(body.job.status, 'fixing');
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_agent_fix_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const followup = await json(followupResponse);

  assert.equal(followupResponse.status, 200);
  assert.equal(followup.action, 'followup_fix_dispatched');
  assert.equal(followup.jobId, created.jobId);
  assert.equal(followup.slackSessionId, created.slackSessionId);
  assert.equal(app.store.jobs.size, 1);
  assert.equal(workerStarts.length, 1);
});

test('Slack channel thread replies without an existing session are ignored', async () => {
  const app = createGatewayApp();
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-thread-untracked',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'C1',
          channel_type: 'channel',
          ts: '1710000200.000200',
          thread_ts: '1710000200.000100',
          text: '这个也帮我改一下',
        },
      }),
    })
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'ignored_untracked_thread_message');
  assert.equal(body.accepted, false);
  assert.equal(body.reply, false);
  assert.equal(app.store.jobs.size, 0);
});

test('pages-agent fix callback moves a fixing job back to reviewing', async () => {
  const app = createGatewayApp();
  const jobId = await moveJobToPrCreated(app, {
    prNumber: 32,
    headSha: '2'.repeat(40),
    idempotencyKey: 'api-fix-callback',
  });
  const job = app.store.updateJob(jobId, 'reviewing');
  const fixing = app.store.moveJobToFixing(job.id, { summary: `${job.summary}\n\n## Slack Follow-up\n\n改标题。` });
  assert.equal(fixing.status, 'fixing');

  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: jobId,
        stageResult: 'reviewing',
        branchName: 'sites/job-fix-callback-zhangsan-profile',
        prNumber: 32,
        prUrl: 'https://github.example/org/pages-manager/pull/32',
        baseRef: 'staging',
        headSha: '3'.repeat(40),
      }),
    })
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.job.status, 'reviewing');
  assert.equal(body.job.prNumber, 32);
  assert.equal(body.job.headSha, '3'.repeat(40));
});

test('pages-agent issue webhook callback can move issue_created directly to pr_created', async () => {
  const app = createGatewayApp();
  const createBody = await json(
    await app.fetch(
      new Request('http://gateway.test/api/publishing-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'api-issue-webhook-pr',
          'X-Pages-Actor-Id': 'usr_1',
        },
        body: JSON.stringify({ employeeSlug: 'zhangsan', siteSlug: 'profile' }),
      })
    )
  );

  await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: createBody.job.id,
        stageResult: 'issue_created',
        issueNumber: 8,
        issueUrl: 'https://github.example/issues/8',
      }),
    })
  );

  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: createBody.job.id,
        stageResult: 'pr_created',
        issueNumber: 8,
        branchName: 'sites/job-test-zhangsan-profile',
        prNumber: 22,
        prUrl: 'https://github.example/pull/22',
        baseRef: 'staging',
        headSha: 'c'.repeat(40),
      }),
    })
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.job.status, 'pr_created');
  assert.equal(body.job.prNumber, 22);
  assert.equal(body.job.issueNumber, 8);
});

test('GitHub issue webhook routes platform issue through gateway before starting pages-agent', async () => {
  const app = createGatewayApp();
  const createBody = await json(
    await app.fetch(
      new Request('http://gateway.test/api/publishing-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'api-issue-webhook-dispatch',
          'X-Pages-Actor-Id': 'usr_1',
        },
        body: JSON.stringify({
          employeeSlug: 'zhangsan',
          siteSlug: 'profile',
          summary: 'Create a personal website.',
        }),
      })
    )
  );

  const issueBody = [
    `PublishingJob: ${createBody.job.id}`,
    '',
    'Target: zhangsan/profile',
    'Allowed path: sites/zhangsan/profile',
    'Base ref: staging',
    '',
    '## Requirement Summary',
    '',
    'Create a personal website.',
  ].join('\n');
  const workerStarts = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-issue-1',
        'X-GitHub-Event': 'issues',
      },
      body: JSON.stringify({
        action: 'opened',
        repository: { full_name: 'org/pages-manager' },
        issue: {
          number: 31,
          html_url: 'https://github.example/org/pages-manager/issues/31',
          body: issueBody,
        },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_agent_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);
  const workerBody = JSON.parse(workerStarts[0].request.body);

  assert.equal(response.status, 200);
  assert.equal(body.issueAction, 'pages_agent_dispatched');
  assert.equal(body.job.status, 'generating_page');
  assert.equal(body.job.issueNumber, 31);
  assert.equal(workerStarts.length, 1);
  assert.equal(workerStarts[0].url, 'http://worker.test/internal/publishing-jobs/start');
  assert.equal(workerBody.job.id, createBody.job.id);
  assert.equal(workerBody.job.status, 'generating_page');
  assert.equal(workerBody.job.issueNumber, 31);
});

test('late issue_created callback is idempotent after GitHub issue webhook started pages-agent', async () => {
  const app = createGatewayApp();
  const createBody = await json(
    await app.fetch(
      new Request('http://gateway.test/api/publishing-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'api-issue-webhook-callback-race',
          'X-Pages-Actor-Id': 'usr_1',
        },
        body: JSON.stringify({
          employeeSlug: 'zhangsan',
          siteSlug: 'profile',
          summary: 'Create a personal website.',
        }),
      })
    )
  );

  const issueBody = [
    `PublishingJob: ${createBody.job.id}`,
    '',
    'Target: zhangsan/profile',
    'Allowed path: sites/zhangsan/profile',
  ].join('\n');

  await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-issue-race-1',
        'X-GitHub-Event': 'issues',
      },
      body: JSON.stringify({
        action: 'opened',
        repository: { full_name: 'org/pages-manager' },
        issue: {
          number: 32,
          html_url: 'https://github.example/org/pages-manager/issues/32',
          body: issueBody,
        },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH() {
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_agent_dispatched' } }), {
          status: 200,
        });
      },
    }
  );

  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: createBody.job.id,
        stageResult: 'issue_created',
        issueNumber: 32,
        issueUrl: 'https://github.example/org/pages-manager/issues/32',
      }),
    })
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.job.status, 'generating_page');
  assert.equal(body.job.issueNumber, 32);
});

test('GitHub Review Agent approval dispatches staging preview', async () => {
  const app = createGatewayApp();
  const headSha = 'b'.repeat(40);
  const jobId = await moveJobToPrCreated(app, { prNumber: 12, headSha, idempotencyKey: 'api-review-preview' });
  const workerStarts = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-approved',
        'X-GitHub-Event': 'pull_request_review',
      },
      body: JSON.stringify({
        action: 'submitted',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 12, head: { sha: headSha } },
        review: {
          id: 100,
          node_id: 'PRR_100',
          state: 'approved',
          body: 'LGTM, no issues found.',
          user: { login: 'greptile[bot]' },
        },
        sender: { login: 'greptile[bot]' },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      PAGES_WORKER_SHARED_SECRET: 'worker-secret',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        assert.equal(request.headers['X-Pages-Worker-Token'], 'worker-secret');
        const body = JSON.parse(request.body);
        assert.equal(body.job.id, jobId);
        assert.equal(body.job.status, 'previewing');
        assert.equal(body.job.prNumber, 12);
        assert.equal(body.job.headSha, headSha);
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_preview_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'preview_dispatched');
  assert.equal(body.reviewComment.classification, 'note');
  assert.equal(body.gate.canPreview, true);
  assert.equal(body.job.status, 'previewing');
  assert.equal(body.workerStart.started, true);
  assert.equal(workerStarts.length, 1);
});

test('GitHub Review Agent approval waits for site-check before preview', async () => {
  const app = createGatewayApp();
  const headSha = '6'.repeat(40);
  await moveJobToPrCreated(app, {
    prNumber: 26,
    headSha,
    idempotencyKey: 'api-review-waits-site-check',
    siteCheck: false,
  });
  const workerStarts = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-waits-site-check',
        'X-GitHub-Event': 'pull_request_review',
      },
      body: JSON.stringify({
        action: 'submitted',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 26, head: { sha: headSha } },
        review: {
          id: 126,
          node_id: 'PRR_126',
          state: 'approved',
          body: 'LGTM, no issues found.',
          user: { login: 'greptile[bot]' },
        },
        sender: { login: 'greptile[bot]' },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'site_check_waiting');
  assert.equal(body.gate.canPreview, false);
  assert.equal(body.gate.siteCheck.status, 'missing');
  assert.equal(body.job.status, 'reviewing');
  assert.equal(workerStarts.length, 0);
});

test('site-check success dispatches preview after stored Review Agent approval', async () => {
  const app = createGatewayApp();
  const headSha = '7'.repeat(40);
  const jobId = await moveJobToPrCreated(app, {
    prNumber: 27,
    headSha,
    idempotencyKey: 'api-site-check-replays-review',
    siteCheck: false,
  });
  const workerStarts = [];

  const reviewResponse = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-before-site-check',
        'X-GitHub-Event': 'pull_request_review',
      },
      body: JSON.stringify({
        action: 'submitted',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 27, head: { sha: headSha } },
        review: {
          id: 127,
          node_id: 'PRR_127',
          state: 'approved',
          body: 'LGTM, no issues found.',
          user: { login: 'greptile[bot]' },
        },
        sender: { login: 'greptile[bot]' },
      }),
    })
  );
  assert.equal(reviewResponse.status, 200);

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-site-check-success',
        'X-GitHub-Event': 'check_run',
      },
      body: JSON.stringify({
        action: 'completed',
        repository: { full_name: 'org/pages-manager' },
        check_run: {
          id: 7001,
          node_id: 'SCR_7001',
          name: 'site-check',
          status: 'completed',
          conclusion: 'success',
          head_sha: headSha,
          details_url: 'https://github.example/org/pages-manager/actions/runs/7001',
          app: { slug: 'github-actions', name: 'GitHub Actions' },
          pull_requests: [{ number: 27 }],
        },
        sender: { login: 'github-actions[bot]' },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        const body = JSON.parse(request.body);
        assert.equal(body.job.id, jobId);
        assert.equal(body.job.status, 'previewing');
        assert.equal(body.job.headSha, headSha);
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_preview_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'preview_dispatched');
  assert.equal(body.siteCheckRun.conclusion, 'success');
  assert.equal(body.gate.canPreview, true);
  assert.equal(body.gate.siteCheck.passed, true);
  assert.equal(body.job.status, 'previewing');
  assert.equal(workerStarts.length, 1);
});

test('site-check failure pauses preview for the PR', async () => {
  const app = createGatewayApp();
  const headSha = '8'.repeat(40);
  await moveJobToPrCreated(app, {
    prNumber: 28,
    headSha,
    idempotencyKey: 'api-site-check-failed',
    siteCheck: false,
  });
  const workerStarts = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-site-check-failure',
        'X-GitHub-Event': 'check_run',
      },
      body: JSON.stringify({
        action: 'completed',
        repository: { full_name: 'org/pages-manager' },
        check_run: {
          id: 8001,
          node_id: 'SCR_8001',
          name: 'site-check',
          status: 'completed',
          conclusion: 'failure',
          head_sha: headSha,
          details_url: 'https://github.example/org/pages-manager/actions/runs/8001',
          app: { slug: 'github-actions', name: 'GitHub Actions' },
          pull_requests: [{ number: 28 }],
        },
        sender: { login: 'github-actions[bot]' },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'site_check_failed');
  assert.equal(body.gate.canPreview, false);
  assert.equal(body.gate.siteCheck.conclusion, 'failure');
  assert.equal(body.job.status, 'changes_requested');
  assert.equal(workerStarts.length, 0);
});

test('GitHub Review Agent nonblocking summary dispatches staging preview', async () => {
  const app = createGatewayApp();
  const headSha = '1'.repeat(40);
  const jobId = await moveJobToPrCreated(app, {
    prNumber: 22,
    headSha,
    idempotencyKey: 'api-review-codex-preview',
  });
  const workerStarts = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-codex-summary',
        'X-GitHub-Event': 'pull_request_review',
      },
      body: JSON.stringify({
        action: 'submitted',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 22, head: { sha: headSha } },
        review: {
          id: 101,
          node_id: 'PRR_101',
          state: 'commented',
          body: 'Here are some automated review suggestions for this pull request.',
          user: { login: 'chatgpt-codex-connector' },
        },
        sender: { login: 'chatgpt-codex-connector' },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        const body = JSON.parse(request.body);
        assert.equal(body.job.id, jobId);
        assert.equal(body.job.status, 'previewing');
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_preview_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'preview_dispatched');
  assert.equal(body.reviewComment.classification, 'suggestion');
  assert.equal(body.gate.canPreview, true);
  assert.equal(body.job.status, 'previewing');
  assert.equal(body.workerStart.started, true);
  assert.equal(workerStarts.length, 1);
});

test('GitHub Review gate reclassifies stored Codex P2 comments after rules change', async () => {
  const app = createGatewayApp();
  const headSha = '5'.repeat(40);
  const jobId = await moveJobToPrCreated(app, {
    prNumber: 25,
    headSha,
    idempotencyKey: 'api-review-reclassify-stored',
  });
  const workerStarts = [];

  app.store.recordReviewAgentComment({
    repoFullName: 'org/pages-manager',
    prNumber: 25,
    githubReviewId: 'legacy-review',
    githubCommentId: 'legacy-comment',
    githubCommentNodeId: 'PRRC_LEGACY_P2',
    sourceType: 'inline_comment',
    reviewAgentLogin: 'chatgpt-codex-connector[bot]',
    reviewState: '',
    body: '**<sub><sub>![P2 Badge](https://img.shields.io/badge/P2-yellow?style=flat)</sub></sub> Limit contact row styles**',
    path: 'sites/zhangsan/profile/src/index.html',
    line: 404,
    diffHunk: null,
    status: 'open',
    classification: 'unknown',
    firstSeenDeliveryId: 'legacy-delivery',
    lastSeenDeliveryId: 'legacy-delivery',
    headSha,
  });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-reclassify-p2',
        'X-GitHub-Event': 'issue_comment',
      },
      body: JSON.stringify({
        action: 'created',
        repository: { full_name: 'org/pages-manager' },
        issue: { number: 25, pull_request: { url: 'https://github.example/org/pages-manager/pulls/25' } },
        comment: {
          id: 104,
          node_id: 'IC_104',
          body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${headSha.slice(0, 10)}\``,
          user: { login: 'chatgpt-codex-connector' },
        },
        sender: { login: 'chatgpt-codex-connector' },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        const body = JSON.parse(request.body);
        assert.equal(body.job.id, jobId);
        assert.equal(body.job.status, 'previewing');
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_preview_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'preview_dispatched');
  assert.equal(body.gate.unknownCount, 0);
  assert.equal(body.gate.suggestionCount, 1);
  assert.equal(body.job.status, 'previewing');
  assert.equal(workerStarts.length, 1);
});

test('GitHub Review Agent issue comment summary dispatches staging preview', async () => {
  const app = createGatewayApp();
  const headSha = '2'.repeat(40);
  const jobId = await moveJobToPrCreated(app, {
    prNumber: 23,
    headSha,
    idempotencyKey: 'api-review-codex-issue-comment-preview',
  });
  const workerStarts = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-codex-issue-comment',
        'X-GitHub-Event': 'issue_comment',
      },
      body: JSON.stringify({
        action: 'created',
        repository: { full_name: 'org/pages-manager' },
        issue: { number: 23, pull_request: { url: 'https://github.example/org/pages-manager/pulls/23' } },
        comment: {
          id: 102,
          node_id: 'IC_102',
          body: "Codex Review: Didn't find any major issues.",
          user: { login: 'chatgpt-codex-connector' },
        },
        sender: { login: 'chatgpt-codex-connector' },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        const body = JSON.parse(request.body);
        assert.equal(body.job.id, jobId);
        assert.equal(body.job.status, 'previewing');
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_preview_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'preview_dispatched');
  assert.equal(body.reviewComment.classification, 'note');
  assert.equal(body.gate.canPreview, true);
  assert.equal(body.job.status, 'previewing');
  assert.equal(body.workerStart.started, true);
  assert.equal(workerStarts.length, 1);
});

test('pr_created callback replays existing Review Agent summary and dispatches preview', async () => {
  const app = createGatewayApp();
  const headSha = '3'.repeat(40);
  const workerStarts = [];
  const createBody = await json(
    await app.fetch(
      new Request('http://gateway.test/api/publishing-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'api-review-before-pr-created',
          'X-Pages-Actor-Id': 'usr_1',
        },
        body: JSON.stringify({ employeeSlug: 'zhangsan', siteSlug: 'profile' }),
      })
    )
  );

  for (const stageResult of ['issue_created', 'index_ready']) {
    const response = await app.fetch(
      new Request('http://gateway.test/internal/executor-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publishingJobId: createBody.job.id,
          stageResult,
          issueNumber: 33,
          issueUrl: 'https://github.example/org/pages-manager/issues/33',
          indexSnapshotId: 'idxsnap_1',
        }),
      })
    );
    assert.equal(response.status, 200);
  }

  const reviewResponse = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-before-pr-created',
        'X-GitHub-Event': 'issue_comment',
      },
      body: JSON.stringify({
        action: 'created',
        repository: { full_name: 'org/pages-manager' },
        issue: { number: 34, pull_request: { url: 'https://github.example/org/pages-manager/pulls/34' } },
        comment: {
          id: 110,
          node_id: 'IC_110',
          body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${headSha.slice(0, 10)}\``,
          user: { login: 'chatgpt-codex-connector' },
        },
        sender: { login: 'chatgpt-codex-connector' },
      }),
    })
  );
  const reviewBody = await json(reviewResponse);

  assert.equal(reviewResponse.status, 200);
  assert.equal(reviewBody.reviewAction, 'recorded');
  assert.equal(reviewBody.job, undefined);

  await recordSuccessfulSiteCheck(app, { prNumber: 34, headSha });

  const prResponse = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: createBody.job.id,
        stageResult: 'pr_created',
        branchName: `sites/job-${createBody.job.id}-zhangsan-profile`,
        prNumber: 34,
        prUrl: 'https://github.example/org/pages-manager/pull/34',
        baseRef: 'staging',
        headSha,
      }),
    }),
    {
      GITHUB_REPO: 'org/pages-manager',
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        const body = JSON.parse(request.body);
        assert.equal(body.job.id, createBody.job.id);
        assert.equal(body.job.status, 'previewing');
        assert.equal(body.job.prNumber, 34);
        assert.equal(body.job.headSha, headSha);
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_preview_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const prBody = await json(prResponse);

  assert.equal(prResponse.status, 200);
  assert.equal(prBody.job.status, 'previewing');
  assert.equal(prBody.reviewReplay.reviewAction, 'preview_dispatched');
  assert.equal(prBody.reviewReplay.gate.canPreview, true);
  assert.equal(prBody.workerStart.started, true);
  assert.equal(workerStarts.length, 1);
});

test('GitHub Review Agent issue comment retries preview worker when job is already previewing', async () => {
  const app = createGatewayApp();
  const headSha = '6'.repeat(40);
  const jobId = await moveJobToPrCreated(app, {
    prNumber: 26,
    headSha,
    idempotencyKey: 'api-review-codex-preview-retry',
  });

  const firstResponse = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-codex-previewing-no-worker',
        'X-GitHub-Event': 'issue_comment',
      },
      body: JSON.stringify({
        action: 'created',
        repository: { full_name: 'org/pages-manager' },
        issue: { number: 26, pull_request: { url: 'https://github.example/org/pages-manager/pulls/26' } },
        comment: {
          id: 105,
          node_id: 'IC_105',
          body: "Codex Review: Didn't find any major issues.",
          user: { login: 'chatgpt-codex-connector' },
        },
        sender: { login: 'chatgpt-codex-connector' },
      }),
    })
  );
  const firstBody = await json(firstResponse);

  assert.equal(firstResponse.status, 200);
  assert.equal(firstBody.reviewAction, 'preview_dispatched');
  assert.equal(firstBody.job.status, 'previewing');
  assert.equal(firstBody.workerStart, undefined);

  const workerStarts = [];
  const retryResponse = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-codex-previewing-retry-worker',
        'X-GitHub-Event': 'issue_comment',
      },
      body: JSON.stringify({
        action: 'created',
        repository: { full_name: 'org/pages-manager' },
        issue: { number: 26, pull_request: { url: 'https://github.example/org/pages-manager/pulls/26' } },
        comment: {
          id: 106,
          node_id: 'IC_106',
          body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${headSha.slice(0, 10)}\``,
          user: { login: 'chatgpt-codex-connector' },
        },
        sender: { login: 'chatgpt-codex-connector' },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        const body = JSON.parse(request.body);
        assert.equal(body.job.id, jobId);
        assert.equal(body.job.status, 'previewing');
        assert.equal(body.job.headSha, headSha);
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_preview_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const retryBody = await json(retryResponse);

  assert.equal(retryResponse.status, 200);
  assert.equal(retryBody.reviewAction, 'preview_dispatched');
  assert.equal(retryBody.gate.canPreview, true);
  assert.equal(retryBody.job.status, 'previewing');
  assert.equal(retryBody.workerStart.started, true);
  assert.equal(workerStarts.length, 1);
});

test('GitHub Review Agent issue comment targets latest reused PR job by reviewed commit', async () => {
  const app = createGatewayApp();
  const oldHeadSha = '3'.repeat(40);
  const newHeadSha = '4'.repeat(40);
  const oldJobId = await moveJobToPrCreated(app, {
    prNumber: 24,
    headSha: oldHeadSha,
    idempotencyKey: 'api-review-reused-pr-old',
  });
  const newJobId = await moveJobToPrCreated(app, {
    prNumber: 24,
    headSha: newHeadSha,
    idempotencyKey: 'api-review-reused-pr-new',
  });
  const workerStarts = [];

  const oldPreview = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: oldJobId,
        stageResult: 'preview_deployed',
        previewUrl: 'https://old-preview.example.test',
      }),
    })
  );
  assert.equal(oldPreview.status, 200);

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-reused-pr-new',
        'X-GitHub-Event': 'issue_comment',
      },
      body: JSON.stringify({
        action: 'created',
        repository: { full_name: 'org/pages-manager' },
        issue: { number: 24, pull_request: { url: 'https://github.example/org/pages-manager/pulls/24' } },
        comment: {
          id: 103,
          node_id: 'IC_103',
          body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${newHeadSha.slice(0, 10)}\``,
          user: { login: 'chatgpt-codex-connector' },
        },
        sender: { login: 'chatgpt-codex-connector' },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        const body = JSON.parse(request.body);
        assert.equal(body.job.id, newJobId);
        assert.equal(body.job.status, 'previewing');
        assert.equal(body.job.headSha, newHeadSha);
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_preview_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);
  const oldJob = await json(await app.fetch(new Request(`http://gateway.test/api/publishing-jobs/${oldJobId}`)));

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'preview_dispatched');
  assert.equal(body.reviewComment.headSha, newHeadSha.slice(0, 10));
  assert.equal(body.job.id, newJobId);
  assert.equal(body.job.status, 'previewing');
  assert.equal(oldJob.job.status, 'preview_deployed');
  assert.equal(workerStarts.length, 1);
});

test('GitHub Review Agent blocking comment moves job to changes_requested', async () => {
  const app = createGatewayApp();
  const headSha = 'c'.repeat(40);
  await moveJobToPrCreated(app, { prNumber: 13, headSha, idempotencyKey: 'api-review-blocking' });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-blocking',
        'X-GitHub-Event': 'pull_request_review_comment',
      },
      body: JSON.stringify({
        action: 'created',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 13, head: { sha: headSha } },
        comment: {
          id: 200,
          node_id: 'PRRC_200',
          body: 'Must fix the broken HTML before preview.',
          path: 'sites/zhangsan/profile/src/index.html',
          line: 3,
          user: { login: 'greptile[bot]' },
        },
        sender: { login: 'greptile[bot]' },
      }),
    })
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'changes_requested');
  assert.equal(body.reviewComment.classification, 'blocking');
  assert.equal(body.gate.blockingCount, 1);
  assert.equal(body.gate.canPreview, false);
  assert.equal(body.job.status, 'changes_requested');
});

test('GitHub Review Agent approval can recover from changes_requested when gate is clear', async () => {
  const app = createGatewayApp();
  const headSha = 'd'.repeat(40);
  const jobId = await moveJobToPrCreated(app, {
    prNumber: 27,
    headSha,
    idempotencyKey: 'api-review-recovered-preview',
  });
  const workerStarts = [];

  const blockingResponse = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-recover-blocking',
        'X-GitHub-Event': 'pull_request_review_comment',
      },
      body: JSON.stringify({
        action: 'created',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 27, head: { sha: headSha } },
        comment: {
          id: 2700,
          node_id: 'PRRC_2700',
          body: 'Must fix the broken HTML before preview.',
          path: 'sites/zhangsan/profile/src/index.html',
          line: 3,
          user: { login: 'greptile[bot]' },
        },
        sender: { login: 'greptile[bot]' },
      }),
    })
  );
  const blockingBody = await json(blockingResponse);
  assert.equal(blockingBody.job.status, 'changes_requested');

  await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-recover-delete',
        'X-GitHub-Event': 'pull_request_review_comment',
      },
      body: JSON.stringify({
        action: 'deleted',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 27, head: { sha: headSha } },
        comment: {
          id: 2700,
          node_id: 'PRRC_2700',
          body: 'Must fix the broken HTML before preview.',
          path: 'sites/zhangsan/profile/src/index.html',
          line: 3,
          user: { login: 'greptile[bot]' },
        },
        sender: { login: 'greptile[bot]' },
      }),
    })
  );

  const approvalResponse = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-recover-approved',
        'X-GitHub-Event': 'pull_request_review',
      },
      body: JSON.stringify({
        action: 'submitted',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 27, head: { sha: headSha } },
        review: {
          id: 2701,
          node_id: 'PRR_2701',
          state: 'approved',
          body: 'LGTM',
          user: { login: 'chatgpt-codex-connector' },
        },
        sender: { login: 'chatgpt-codex-connector' },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        const body = JSON.parse(request.body);
        assert.equal(body.job.id, jobId);
        assert.equal(body.job.status, 'previewing');
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_preview_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const approvalBody = await json(approvalResponse);

  assert.equal(approvalResponse.status, 200, JSON.stringify(approvalBody));
  assert.equal(approvalBody.reviewAction, 'preview_dispatched');
  assert.equal(approvalBody.gate.canPreview, true);
  assert.equal(approvalBody.job.status, 'previewing');
  assert.equal(workerStarts.length, 1);
});

test('GitHub Review Agent blocking comment notifies Slack thread', async () => {
  const app = createGatewayApp();
  const slackMessages = [];
  const createResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-review-slack-notify',
        event: {
          type: 'app_mention',
          user: 'U1',
          channel: 'C1',
          channel_type: 'channel',
          ts: '1710000000.000300',
          text: 'issue: 帮我创建 profile 页面',
        },
      }),
    })
  );
  const created = await json(createResponse);
  const headSha = 'e'.repeat(40);

  for (const stageResult of ['issue_created', 'index_ready', 'pr_created']) {
    const response = await app.fetch(
      new Request('http://gateway.test/internal/executor-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publishingJobId: created.jobId,
          stageResult,
          issueNumber: 8,
          indexSnapshotId: 'idxsnap_1',
          branchName: 'sites/job-review-slack-smoke-profile',
          prNumber: 15,
          prUrl: 'https://github.example/org/pages-manager/pull/15',
          headSha,
        }),
      })
    );
    assert.equal(response.status, 200);
  }

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-slack-blocking',
        'X-GitHub-Event': 'pull_request_review_comment',
      },
      body: JSON.stringify({
        action: 'created',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 15, head: { sha: headSha } },
        comment: {
          id: 201,
          node_id: 'PRRC_201',
          body: 'Must fix this before preview.',
          path: 'sites/zhangsan/profile/src/index.html',
          line: 4,
          user: { login: 'greptile[bot]' },
        },
      }),
    }),
    {
      SLACK_BOT_TOKEN: 'test-slack-token',
      async SLACK_FETCH(url, request) {
        slackMessages.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '1710000002.000100' }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'changes_requested');
  assert.equal(body.slackStatusNotification.ok, true);
  assert.equal(body.slackNotification.ok, true);
  assert.equal(slackMessages.length, 2);
  assert.match(JSON.stringify(JSON.parse(slackMessages[0].request.body).blocks), /等待修复 Review 意见/);
  assert.match(JSON.parse(slackMessages[1].request.body).text, /^<@U1> .*blocking comment/s);
});

test('GitHub Review Agent suggestion comment notifies Slack thread without blocking preview', async () => {
  const app = createGatewayApp();
  const slackMessages = [];
  const createResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-review-slack-suggestion',
        event: {
          type: 'app_mention',
          user: 'U1',
          channel: 'C1',
          channel_type: 'channel',
          ts: '1710000000.000400',
          text: 'issue: 帮我创建 profile 页面',
        },
      }),
    })
  );
  const created = await json(createResponse);
  const headSha = 'f'.repeat(40);

  for (const stageResult of ['issue_created', 'index_ready', 'pr_created']) {
    const response = await app.fetch(
      new Request('http://gateway.test/internal/executor-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publishingJobId: created.jobId,
          stageResult,
          issueNumber: 9,
          indexSnapshotId: 'idxsnap_2',
          branchName: 'sites/job-review-slack-suggestion-smoke-profile',
          prNumber: 16,
          prUrl: 'https://github.example/org/pages-manager/pull/16',
          headSha,
        }),
      })
    );
    assert.equal(response.status, 200);
  }

  await recordSuccessfulSiteCheck(app, { prNumber: 16, headSha });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-slack-suggestion',
        'X-GitHub-Event': 'pull_request_review_comment',
      },
      body: JSON.stringify({
        action: 'created',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 16, head: { sha: headSha } },
        comment: {
          id: 202,
          node_id: 'PRRC_202',
          body: 'Consider using a richer title.',
          path: 'sites/zhangsan/profile/src/index.html',
          line: 5,
          user: { login: 'greptile[bot]' },
        },
      }),
    }),
    {
      SLACK_BOT_TOKEN: 'test-slack-token',
      async SLACK_FETCH(url, request) {
        slackMessages.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '1710000003.000100' }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);
  const statusPayload = JSON.parse(slackMessages[0].request.body);
  const slackText = JSON.parse(slackMessages[1].request.body).text;

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'reviewing');
  assert.equal(body.reviewComment.classification, 'suggestion');
  assert.equal(body.gate.canPreview, true);
  assert.equal(body.job.status, 'reviewing');
  assert.equal(body.slackStatusNotification.ok, true);
  assert.equal(body.slackNotification.ok, true);
  assert.match(JSON.stringify(statusPayload.blocks), /等待 Agent Review/);
  assert.match(slackText, /^<@U1> /);
  assert.match(slackText, /suggestion/);
  assert.match(slackText, /sites\/zhangsan\/profile\/src\/index.html:5/);
});

test('GitHub webhook ignores untrusted review agents and deduplicates deliveries', async () => {
  const app = createGatewayApp();
  await moveJobToPrCreated(app, { prNumber: 14, idempotencyKey: 'api-review-dedup' });
  const request = (deliveryId, login) =>
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': deliveryId,
        'X-GitHub-Event': 'pull_request_review',
      },
      body: JSON.stringify({
        action: 'submitted',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 14, head: { sha: 'd'.repeat(40) } },
        review: {
          id: 300,
          node_id: 'PRR_300',
          state: 'approved',
          body: 'LGTM.',
          user: { login },
        },
      }),
    });

  const ignored = await json(await app.fetch(request('delivery-untrusted', 'random-bot[bot]')));
  assert.equal(ignored.ignored, 'review_agent_not_allowed');

  const first = await json(await app.fetch(request('delivery-dedup', 'greptile[bot]')));
  const second = await json(await app.fetch(request('delivery-dedup', 'greptile[bot]')));
  assert.equal(first.created, true);
  assert.equal(second.created, false);
});

test('GitHub webhook signature is enforced when configured', async () => {
  const app = createGatewayApp();
  const payload = JSON.stringify({
    action: 'created',
    repository: { full_name: 'org/pages-manager' },
  });
  const unsigned = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-unsigned',
        'X-GitHub-Event': 'ping',
      },
      body: payload,
    }),
    { GITHUB_WEBHOOK_SECRET: 'secret' }
  );
  assert.equal(unsigned.status, 401);

  const signed = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-signed',
        'X-GitHub-Event': 'ping',
        'X-Hub-Signature-256': await githubSignature('secret', payload),
      },
      body: payload,
    }),
    { GITHUB_WEBHOOK_SECRET: 'secret' }
  );
  assert.equal(signed.status, 200);
});
