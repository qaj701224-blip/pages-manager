import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayApp } from '../../helpers/gateway-app.js';

async function json(response) {
  return response.json();
}

function findBlockAction(blocks = [], actionId = '') {
  for (const block of blocks) {
    const action = block.elements?.find((element) => element.action_id === actionId);
    if (action) return action;
  }
  return null;
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

test('Slack immediate replies replace working reaction with done reaction', async () => {
  const app = createGatewayApp();
  const slackRequests = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-reaction-done',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000100',
          text: 'ping',
        },
      }),
    }),
    {
      SLACK_EVENTS_PROCESSING_MODE: 'sync',
      SLACK_REACTION_ON_RECEIVE: 'true',
      SLACK_WORKING_REACTION: 'eyes',
      SLACK_DONE_REACTION: 'done-e',
      SLACK_BOT_TOKEN: 'xoxb-test',
      async SLACK_FETCH(url, request) {
        slackRequests.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '1710000001.000100' }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);
  const reactionCalls = slackRequests
    .map((call) => ({ url: call.url, payload: JSON.parse(call.request.body) }))
    .filter((call) => call.url.includes('/reactions.'));
  const deliveries = app.store.listSlackDeliveries({ eventId: 'Ev-reaction-done' }).deliveries;

  assert.equal(response.status, 200);
  assert.equal(body.action, 'ping');
  assert.deepEqual(
    reactionCalls.map((call) => [call.url, call.payload.name]),
    [
      ['https://slack.com/api/reactions.add', 'eyes'],
      ['https://slack.com/api/reactions.remove', 'eyes'],
      ['https://slack.com/api/reactions.add', 'done-e'],
    ]
  );
  assert.equal(deliveries[0].payloadRedacted.workingReaction.status, 'done');
  assert.equal(deliveries[0].payloadRedacted.workingReaction.doneReaction, 'done-e');
});

test('Slack skipped working reaction is not treated as active', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-reaction-skipped',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000101',
          text: 'ping',
        },
      }),
    }),
    {
      SLACK_EVENTS_PROCESSING_MODE: 'sync',
      SLACK_REACTION_ON_RECEIVE: 'true',
      SLACK_NOTIFIER_URL: 'http://slack-notifier.test',
      SLACK_NOTIFIER_SHARED_SECRET: 'secret',
      async SLACK_NOTIFIER_FETCH(url, request) {
        notifierCalls.push({ url: String(url), request });
        if (String(url).endsWith('/reaction')) {
          return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'no_target' }));
        }
        return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '1710000001.000101' }));
      },
    }
  );
  const body = await json(response);
  const deliveries = app.store.listSlackDeliveries({ eventId: 'Ev-reaction-skipped' }).deliveries;

  assert.equal(response.status, 200);
  assert.equal(body.action, 'ping');
  assert.deepEqual(
    notifierCalls.map((call) => new URL(call.url).pathname),
    ['/internal/slack-notifier/reaction', '/internal/slack-notifier/message']
  );
  assert.equal(deliveries[0].payloadRedacted.workingReaction.status, 'failed');
});

test('Slack working reaction errors do not block message processing', async () => {
  const app = createGatewayApp();
  const slackRequests = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-reaction-error-continues',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000102',
          text: 'ping',
        },
      }),
    }),
    {
      SLACK_EVENTS_PROCESSING_MODE: 'sync',
      SLACK_REACTION_ON_RECEIVE: 'true',
      SLACK_BOT_TOKEN: 'xoxb-test',
      async SLACK_FETCH(url, request) {
        slackRequests.push({ url: String(url), request });
        if (String(url).endsWith('/reactions.add')) {
          throw new Error('reaction network down');
        }
        return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '1710000001.000102' }));
      },
    }
  );
  const body = await json(response);
  const deliveries = app.store.listSlackDeliveries({ eventId: 'Ev-reaction-error-continues' }).deliveries;

  assert.equal(response.status, 200);
  assert.equal(body.action, 'ping');
  assert.deepEqual(
    slackRequests.map((call) => call.url),
    ['https://slack.com/api/reactions.add', 'https://slack.com/api/chat.postMessage']
  );
  assert.equal(deliveries[0].payloadRedacted.workingReaction.status, 'failed');
});

test('preview completion replaces pending Slack working reactions with done reaction', async () => {
  const app = createGatewayApp();
  const jobId = await moveJobToPrCreated(app, { prNumber: 77, headSha: 'b'.repeat(40) });
  app.store.recordSlackDelivery({
    teamId: 'T1',
    eventId: 'Ev-job-reaction-done',
    eventType: 'message',
    channelId: 'D1',
    threadTs: '1710000000.000100',
    slackUserId: 'U1',
    publishingJobId: jobId,
    payloadRedacted: {
      workingReaction: {
        status: 'working',
        addedAt: '2026-06-15T00:00:00.000Z',
        reaction: {
          channel: 'D1',
          timestamp: '1710000000.000100',
          name: 'eyes',
        },
      },
    },
  });

  const slackRequests = [];
  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: jobId,
        stageResult: 'preview_deployed',
        previewUrl: 'https://preview.example.test/job-reaction',
      }),
    }),
    {
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_DONE_REACTION: 'done-e',
      async SLACK_FETCH(url, request) {
        slackRequests.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }
  );
  const body = await json(response);
  const reactionCalls = slackRequests.map((call) => ({ url: call.url, payload: JSON.parse(call.request.body) }));
  const deliveries = app.store.listSlackDeliveries({ eventId: 'Ev-job-reaction-done' }).deliveries;

  assert.equal(response.status, 200);
  assert.equal(body.slackReactionSettlement.settledCount, 1);
  assert.deepEqual(
    reactionCalls.map((call) => [call.url, call.payload.name]),
    [
      ['https://slack.com/api/reactions.remove', 'eyes'],
      ['https://slack.com/api/reactions.add', 'done-e'],
    ]
  );
  assert.equal(deliveries[0].payloadRedacted.workingReaction.status, 'done');
  assert.equal(deliveries[0].payloadRedacted.workingReaction.doneReaction, 'done-e');
});

test('preview completion also settles working reactions linked by Slack session', async () => {
  const app = createGatewayApp();
  const jobId = await moveJobToPrCreated(app, { prNumber: 78, headSha: 'c'.repeat(40) });
  app.store.patchJob(jobId, {
    slackSessionId: 'sess_reaction_fallback',
    slackThread: {
      channelId: 'D1',
      threadTs: '1710000000.000200',
      userId: 'U1',
    },
  });
  app.store.recordSlackDelivery({
    teamId: 'T1',
    eventId: 'Ev-session-reaction-done',
    eventType: 'message',
    channelId: 'D1',
    threadTs: '1710000000.000200',
    slackUserId: 'U1',
    slackSessionId: 'sess_reaction_fallback',
    payloadRedacted: {
      workingReaction: {
        status: 'working',
        addedAt: '2026-06-15T00:00:00.000Z',
        reaction: {
          channel: 'D1',
          timestamp: '1710000030.000200',
          name: 'eyes',
        },
      },
    },
  });

  const slackRequests = [];
  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: jobId,
        stageResult: 'preview_deployed',
        previewUrl: 'https://preview.example.test/session-reaction',
      }),
    }),
    {
      SLACK_BOT_TOKEN: 'xoxb-test',
      SLACK_DONE_REACTION: 'done-e',
      async SLACK_FETCH(url, request) {
        slackRequests.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }
  );
  const body = await json(response);
  const deliveries = app.store.listSlackDeliveries({ eventId: 'Ev-session-reaction-done' }).deliveries;

  assert.equal(response.status, 200);
  assert.equal(body.slackReactionSettlement.settledCount, 1);
  assert.equal(slackRequests.filter((call) => call.url.includes('/reactions.')).length, 2);
  assert.equal(deliveries[0].payloadRedacted.workingReaction.status, 'done');
  assert.equal(deliveries[0].payloadRedacted.workingReaction.doneReaction, 'done-e');
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
  assert.match(body.replyText, /我整理好了，先等你确认/);
  assert.match(body.replyText, /下一步：点击「确认创建发布任务」/);
  assert.equal(body.blocks?.at(-1)?.elements?.[0]?.action_id, 'pages_confirm_issue');
  assert.equal(app.store.jobs.size, 0);
});

test('Slack free-form turn uses Slack Agent turn and updates one agent reply message', async () => {
  const app = createGatewayApp();
  const agentCalls = [];
  const slackCalls = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-turn-card-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000113',
          text: '我想做一个个人主页，突出项目经历和联系方式',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      SLACK_AGENT_ANALYZE_URL: 'http://slack-agent.test/internal/slack-agent/analyze',
      SLACK_AGENT_SHARED_SECRET: 'agent-secret',
      SLACK_BOT_TOKEN: 'xoxb-test',
      async SLACK_AGENT_FETCH(url, request) {
        agentCalls.push({ url: String(url), request });
        const payload = JSON.parse(request.body);
        assert.equal(payload.agentRunId, payload.agentRun.id);
        assert.equal(payload.slackSessionId, payload.slackSession.id);
        assert.equal(payload.messageText, '我想做一个个人主页，突出项目经历和联系方式');
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              visibleText: '我已整理好这轮需求。',
              events: [
                { type: 'reply_started', sequence: 1, agentRunId: payload.agentRunId, slackSessionId: payload.slackSessionId },
                {
                  type: 'reply_delta',
                  sequence: 2,
                  agentRunId: payload.agentRunId,
                  slackSessionId: payload.slackSessionId,
                  text: '我已整理好这轮需求。',
                },
                {
                  type: 'analysis_final',
                  sequence: 3,
                  agentRunId: payload.agentRunId,
                  slackSessionId: payload.slackSessionId,
                  analysis: {
                    intent: 'create_or_update_site',
                    siteSlug: 'profile',
                    title: '个人主页',
                    summary: '突出项目经历和联系方式。',
                    needsClarification: false,
                  },
                },
                { type: 'reply_completed', sequence: 4, agentRunId: payload.agentRunId, slackSessionId: payload.slackSessionId },
              ],
            },
          }),
          { status: 200 }
        );
      },
      async SLACK_FETCH(url, request) {
        slackCalls.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '1710000001.000113' }), { status: 200 });
      },
    }
  );
  const body = await json(response);
  const postPayload = JSON.parse(slackCalls[0].request.body);
  const updatePayload = JSON.parse(slackCalls[1].request.body);

  assert.equal(response.status, 200);
  assert.equal(agentCalls.length, 1);
  assert.equal(agentCalls[0].url, 'http://slack-agent.test/internal/slack-agent/turn');
  assert.equal(agentCalls[0].request.headers['X-Pages-Slack-Agent-Token'], 'agent-secret');
  assert.equal(body.action, 'confirm_before_issue');
  assert.equal(body.noReply, true);
  assert.equal(body.agentReplyNotification.action, 'updated');
  assert.equal(slackCalls.length, 2);
  assert.match(slackCalls[0].url, /chat\.postMessage$/);
  assert.match(slackCalls[1].url, /chat\.update$/);
  assert.equal(postPayload.thread_ts, '1710000000.000113');
  assert.equal(postPayload.blocks[0].type, 'section');
  assert.ok(!postPayload.blocks.some((block) => block.type === 'header'));
  assert.equal(updatePayload.ts, '1710000001.000113');
  assert.match(updatePayload.text, /^<@U1>/);
  assert.match(JSON.stringify(updatePayload.blocks), /确认创建发布任务/);
  assert.ok(updatePayload.blocks.some((block) => block.type === 'header'));
  assert.equal(app.store.slackAgentReplyMessages.size, 1);
  assert.equal(app.store.agentRunEvents.size, 6);
  assert.deepEqual(
    [...app.store.agentRunEvents.values()].map((event) => event.type),
    ['slack_reply_posted', 'reply_started', 'reply_delta', 'analysis_final', 'reply_completed', 'slack_reply_updated']
  );
});

test('Slack Agent turn consumes ndjson chunks and updates one reply message progressively', async () => {
  const app = createGatewayApp();
  const agentCalls = [];
  const slackCalls = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-turn-ndjson-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000118',
          text: '做一个个人主页，突出项目经历和联系方式',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      SLACK_AGENT_REPLY_UPDATE_INTERVAL_MS: '0',
      SLACK_BOT_TOKEN: 'xoxb-test',
      async SLACK_AGENT_FETCH(url, request) {
        agentCalls.push({ url: String(url), request });
        const payload = JSON.parse(request.body);
        const events = [
          { type: 'reply_started', sequence: 1, agentRunId: payload.agentRunId, slackSessionId: payload.slackSessionId },
          {
            type: 'reply_delta',
            sequence: 2,
            agentRunId: payload.agentRunId,
            slackSessionId: payload.slackSessionId,
            text: '我先整理一下：',
          },
          {
            type: 'reply_delta',
            sequence: 3,
            agentRunId: payload.agentRunId,
            slackSessionId: payload.slackSessionId,
            text: '这是一个突出项目经历和联系方式的个人主页。',
          },
          {
            type: 'analysis_final',
            sequence: 4,
            agentRunId: payload.agentRunId,
            slackSessionId: payload.slackSessionId,
            analysis: {
              intent: 'create_or_update_site',
              siteSlug: 'profile',
              title: '个人主页',
              summary: '突出项目经历和联系方式。',
              needsClarification: false,
            },
          },
          { type: 'reply_completed', sequence: 5, agentRunId: payload.agentRunId, slackSessionId: payload.slackSessionId },
        ];
        return new Response(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
        });
      },
      async SLACK_FETCH(url, request) {
        slackCalls.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '1710000001.000118' }), { status: 200 });
      },
    }
  );
  const body = await json(response);
  const updatePayloads = slackCalls
    .filter((call) => call.url.endsWith('/chat.update'))
    .map((call) => JSON.parse(call.request.body));

  assert.equal(response.status, 200);
  assert.equal(body.action, 'confirm_before_issue');
  assert.equal(body.noReply, true);
  assert.match(agentCalls[0].request.headers.Accept, /application\/x-ndjson/);
  assert.equal(slackCalls.length, 4);
  assert.match(slackCalls[0].url, /chat\.postMessage$/);
  assert.equal(updatePayloads.length, 3);
  assert.match(updatePayloads[0].text, /我先整理一下/);
  assert.equal(updatePayloads[0].blocks[0].type, 'section');
  assert.ok(!updatePayloads[0].blocks.some((block) => block.type === 'header'));
  assert.match(updatePayloads[1].text, /突出项目经历和联系方式/);
  assert.equal(updatePayloads[1].blocks[0].type, 'section');
  assert.ok(!updatePayloads[1].blocks.some((block) => block.type === 'header'));
  assert.match(JSON.stringify(updatePayloads[2].blocks), /确认创建发布任务/);
  assert.ok(updatePayloads[2].blocks.some((block) => block.type === 'header'));
  assert.deepEqual(
    [...app.store.agentRunEvents.values()].map((event) => event.type),
    [
      'slack_reply_posted',
      'reply_started',
      'reply_delta',
      'slack_reply_updated',
      'reply_delta',
      'slack_reply_updated',
      'analysis_final',
      'reply_completed',
      'slack_reply_updated',
    ]
  );
});

test('Slack Agent reuses one agent reply card across consecutive DM turns', async () => {
  const app = createGatewayApp();
  const slackCalls = [];
  const agentSessionIds = [];
  const env = {
    SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
    SLACK_BOT_TOKEN: 'xoxb-test',
    async SLACK_AGENT_FETCH(_url, request) {
      const payload = JSON.parse(request.body);
      agentSessionIds.push(payload.slackSessionId);
      const secondTurn = /联系方式/.test(payload.messageText);
      return new Response(
        JSON.stringify({
          ok: true,
          turn: {
            agentRunId: payload.agentRunId,
            slackSessionId: payload.slackSessionId,
            events: [
              { type: 'reply_started', sequence: 1, agentRunId: payload.agentRunId, slackSessionId: payload.slackSessionId },
              {
                type: 'reply_delta',
                sequence: 2,
                agentRunId: payload.agentRunId,
                slackSessionId: payload.slackSessionId,
                text: secondTurn ? '我会把联系方式补进需求。' : '我已整理好这轮需求。',
              },
              {
                type: 'analysis_final',
                sequence: 3,
                agentRunId: payload.agentRunId,
                slackSessionId: payload.slackSessionId,
                analysis: {
                  intent: 'create_or_update_site',
                  siteSlug: 'profile',
                  title: '个人主页',
                  summary: secondTurn ? '补充联系方式。' : '突出项目经历。',
                  needsClarification: false,
                },
              },
              { type: 'reply_completed', sequence: 4, agentRunId: payload.agentRunId, slackSessionId: payload.slackSessionId },
            ],
          },
        }),
        { status: 200 }
      );
    },
    async SLACK_FETCH(url, request) {
      slackCalls.push({ url: String(url), request });
      return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '1710000001.000120' }), { status: 200 });
    },
  };

  const first = await json(
    await app.fetch(
      new Request('http://gateway.test/integrations/slack/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_id: 'T1',
          event_id: 'Ev-agent-reuse-1',
          event: {
            type: 'message',
            user: 'U1',
            channel: 'D1',
            channel_type: 'im',
            ts: '1710000000.000120',
            text: '做一个个人主页，突出项目经历',
          },
        }),
      }),
      env
    )
  );
  const second = await json(
    await app.fetch(
      new Request('http://gateway.test/integrations/slack/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_id: 'T1',
          event_id: 'Ev-agent-reuse-2',
          event: {
            type: 'message',
            user: 'U1',
            channel: 'D1',
            channel_type: 'im',
            ts: '1710000002.000120',
            text: '再补充联系方式',
          },
        }),
      }),
      env
    )
  );

  const postCount = slackCalls.filter((call) => call.url.endsWith('/chat.postMessage')).length;
  const updatePayloads = slackCalls
    .filter((call) => call.url.endsWith('/chat.update'))
    .map((call) => JSON.parse(call.request.body));

  assert.equal(first.slackSessionId, second.slackSessionId);
  assert.deepEqual(agentSessionIds, [first.slackSessionId, first.slackSessionId]);
  assert.equal(postCount, 1);
  assert.equal(updatePayloads.length, 3);
  assert.ok(updatePayloads.every((payload) => payload.ts === '1710000001.000120'));
  assert.equal(app.store.slackAgentReplyMessages.size, 2);
});

test('Slack Agent turn falls back to a plain reply when the reply placeholder is skipped', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-turn-card-skipped-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000117',
          text: '我想做一个个人主页，突出项目经历和联系方式',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      SLACK_NOTIFIER_URL: 'http://slack-notifier.test',
      SLACK_NOTIFIER_SHARED_SECRET: 'notifier-secret',
      async SLACK_AGENT_FETCH(url, request) {
        const payload = JSON.parse(request.body);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              events: [
                {
                  type: 'analysis_final',
                  sequence: 1,
                  agentRunId: payload.agentRunId,
                  slackSessionId: payload.slackSessionId,
                  analysis: {
                    intent: 'create_or_update_site',
                    siteSlug: 'profile',
                    title: '个人主页',
                    summary: '突出项目经历和联系方式。',
                    needsClarification: false,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      },
      async SLACK_NOTIFIER_FETCH(url, request) {
        notifierCalls.push({ url: String(url), request });
        if (String(url).endsWith('/agent-reply/start')) {
          return new Response(JSON.stringify({ ok: true, skipped: true, reason: 'no_target' }), { status: 200 });
        }
        return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '1710000002.000117' }), { status: 200 });
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'confirm_before_issue');
  assert.notEqual(body.noReply, true);
  assert.equal(app.store.slackAgentReplyMessages.size, 0);
  assert.deepEqual(
    notifierCalls.map((call) => new URL(call.url).pathname),
    ['/internal/slack-notifier/agent-reply/start', '/internal/slack-notifier/message']
  );
});

test('Slack Agent turn failure updates the in-thread reply message', async () => {
  const app = createGatewayApp();
  const slackCalls = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-turn-card-failed-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000114',
          text: '我想做一个个人主页，突出项目经历和联系方式',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      SLACK_BOT_TOKEN: 'xoxb-test',
      async SLACK_AGENT_FETCH() {
        return new Response(JSON.stringify({ ok: false, error: 'model timeout' }), { status: 502 });
      },
      async SLACK_FETCH(url, request) {
        slackCalls.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '1710000001.000114' }), { status: 200 });
      },
    }
  );
  const body = await json(response);
  const updatePayload = JSON.parse(slackCalls[1].request.body);
  const replyMessage = [...app.store.slackAgentReplyMessages.values()][0];
  const agentRun = [...app.store.agentRuns.values()][0];
  const eventTypes = [...app.store.agentRunEvents.values()].map((event) => event.type);

  assert.equal(response.status, 502);
  assert.equal(body.error, 'model timeout');
  assert.equal(slackCalls.length, 2);
  assert.match(slackCalls[0].url, /chat\.postMessage$/);
  assert.match(slackCalls[1].url, /chat\.update$/);
  assert.equal(updatePayload.ts, '1710000001.000114');
  assert.match(updatePayload.text, /^<@U1>/);
  assert.match(JSON.stringify(updatePayload.blocks), /处理失败/);
  assert.equal(replyMessage.status, 'failed');
  assert.equal(agentRun.status, 'failed');
  assert.deepEqual(eventTypes, ['slack_reply_posted', 'slack_reply_failed']);
});

test('Slack Agent ndjson reply_failed updates the in-thread reply message once', async () => {
  const app = createGatewayApp();
  const slackCalls = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-turn-card-ndjson-failed-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000119',
          text: '我想做一个个人主页，突出项目经历和联系方式',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      SLACK_BOT_TOKEN: 'xoxb-test',
      async SLACK_AGENT_FETCH(url, request) {
        const payload = JSON.parse(request.body);
        const events = [
          { type: 'reply_started', sequence: 1, agentRunId: payload.agentRunId, slackSessionId: payload.slackSessionId },
          {
            type: 'reply_failed',
            sequence: 2,
            agentRunId: payload.agentRunId,
            slackSessionId: payload.slackSessionId,
            text: '模型暂时不可用。',
            error: 'model unavailable',
          },
        ];
        return new Response(`${events.map((event) => JSON.stringify(event)).join('\n')}\n`, {
          status: 200,
          headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
        });
      },
      async SLACK_FETCH(url, request) {
        slackCalls.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '1710000001.000119' }), { status: 200 });
      },
    }
  );
  const body = await json(response);
  const updateCalls = slackCalls.filter((call) => call.url.endsWith('/chat.update'));
  const eventTypes = [...app.store.agentRunEvents.values()].map((event) => event.type);

  assert.equal(response.status, 502);
  assert.equal(body.error, 'model unavailable');
  assert.equal(slackCalls.filter((call) => call.url.endsWith('/chat.postMessage')).length, 1);
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(eventTypes, ['slack_reply_posted', 'reply_started', 'reply_failed', 'slack_reply_failed']);
});

test('Slack Agent turn failure replaces the working reaction with a failed reaction', async () => {
  const app = createGatewayApp();
  const slackCalls = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-turn-reaction-failed-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000116',
          text: '我想做一个个人主页，突出项目经历和联系方式',
        },
      }),
    }),
    {
      SLACK_EVENTS_PROCESSING_MODE: 'sync',
      SLACK_REACTION_ON_RECEIVE: 'true',
      SLACK_WORKING_REACTION: 'eyes',
      SLACK_FAILED_REACTION: 'failed-e',
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      SLACK_BOT_TOKEN: 'xoxb-test',
      async SLACK_AGENT_FETCH() {
        return new Response(JSON.stringify({ ok: false, error: 'model timeout' }), { status: 502 });
      },
      async SLACK_FETCH(url, request) {
        slackCalls.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '1710000001.000116' }), { status: 200 });
      },
    }
  );
  const body = await json(response);
  const reactionCalls = slackCalls
    .map((call) => ({ url: call.url, payload: JSON.parse(call.request.body) }))
    .filter((call) => call.url.includes('/reactions.'));
  const deliveries = app.store.listSlackDeliveries({ eventId: 'Ev-agent-turn-reaction-failed-1' }).deliveries;

  assert.equal(response.status, 502);
  assert.equal(body.error, 'model timeout');
  assert.deepEqual(
    reactionCalls.map((call) => [call.url, call.payload.name]),
    [
      ['https://slack.com/api/reactions.add', 'eyes'],
      ['https://slack.com/api/reactions.remove', 'eyes'],
      ['https://slack.com/api/reactions.add', 'failed-e'],
    ]
  );
  assert.equal(deliveries[0].payloadRedacted.workingReaction.status, 'failed');
  assert.equal(deliveries[0].payloadRedacted.workingReaction.doneReaction, 'failed-e');
});

test('Slack Agent malformed turn responses fail visibly instead of recording a vague reply', async () => {
  const app = createGatewayApp();
  const slackCalls = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-turn-card-malformed-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000115',
          text: '我想做一个个人主页，突出项目经历和联系方式',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      SLACK_BOT_TOKEN: 'xoxb-test',
      async SLACK_AGENT_FETCH() {
        return new Response(JSON.stringify({ ok: true, turn: { events: [] } }), { status: 200 });
      },
      async SLACK_FETCH(url, request) {
        slackCalls.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '1710000001.000115' }), { status: 200 });
      },
    }
  );
  const body = await json(response);
  const updatePayload = JSON.parse(slackCalls[1].request.body);

  assert.equal(response.status, 502);
  assert.equal(body.error, 'Slack Agent turn response is missing analysis');
  assert.equal(slackCalls.length, 2);
  assert.match(updatePayload.text, /^<@U1>/);
  assert.match(JSON.stringify(updatePayload.blocks), /处理失败/);
});

test('Slack confirmation draft hides internal session and job context from users', async () => {
  const app = createGatewayApp();
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-freeform-internal-summary-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000107',
          text: '做一个 profile 网站，唯一标识 clean-copy-001',
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
              siteSlug: 'profile',
              title: '创建/更新 smoke/profile 个人网站',
              summary: [
                '为 smoke 名下的 profile 个人网站创建/更新发布任务，突出项目经历和联系方式。',
                '当前会话历史中用户已确认开始生成页面，应优先沿用已有会话关系，避免重复创建新的 issue：',
                'activeJobId=job_abc123，activeIssueNumber=59，并保留既有 PR/preview 关系',
                '（历史关联 PR #58，previewUrl=https://pm-pr-58-example.workers.xd.team）。',
                '最终归属目录应由 gateway 根据 Slack 身份派生。',
              ].join(''),
              needsClarification: false,
            },
          }),
          { status: 200 }
        );
      },
    }
  );
  const body = await json(response);
  const visible = `${body.replyText}\n${JSON.stringify(body.blocks)}`;

  assert.equal(response.status, 200);
  assert.equal(body.action, 'confirm_before_issue');
  assert.doesNotMatch(visible, /activeJobId|activeIssueNumber|previewUrl|gateway|job_abc123|pm-pr-58/i);
  assert.match(body.replyText, /标题：/);
  assert.match(body.replyText, /需求：/);
  assert.match(body.replyText, /下一步：点击「确认创建发布任务」/);
});

test('Slack free-form turn still requires button confirmation before creating an issue', async () => {
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

  assert.equal(response.status, 200);
  assert.equal(body.action, 'confirm_before_issue');
  assert.equal(body.accepted, false);
  assert.equal(body.jobId, undefined);
  assert.match(body.replyText, /下一步：点击「确认创建发布任务」/);
  assert.equal(body.blocks?.at(-1)?.type, 'actions');
  assert.equal(body.blocks.at(-1).elements[0].action_id, 'pages_confirm_issue');
  assert.equal(app.store.jobs.size, 0);
});

test('Slack confirm issue button creates the publishing job and starts worker', async () => {
  const app = createGatewayApp();
  const draftResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-freeform-confirm-button-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000109',
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
  const draft = await json(draftResponse);
  const sessionId = draft.slackSessionId;
  const secret = 'slack-signing-secret';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = JSON.stringify({
    type: 'block_actions',
    team: { id: 'T1' },
    user: { id: 'U1' },
    channel: { id: 'D1' },
    message: { ts: '1710000000.000109' },
    actions: [{ action_id: 'pages_confirm_issue', value: sessionId }],
  });
  const formBody = new URLSearchParams({ payload }).toString();
  const workerStarts = [];
  const slackRequests = [];

  const confirmResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-Slack-Request-Timestamp': timestamp,
        'X-Slack-Signature': await slackSignature(secret, timestamp, formBody),
      },
      body: formBody,
    }),
    {
      SLACK_SIGNING_SECRET: secret,
      SLACK_BOT_TOKEN: 'xoxb-test',
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async SLACK_FETCH(url, request) {
        slackRequests.push({ url: String(url), request });
        if (String(url).endsWith('/users.info')) {
          return new Response(
            JSON.stringify({
              ok: true,
              user: {
                id: 'U1',
                team_id: 'T1',
                name: 'alice',
                profile: { display_name: 'Alice', email: 'alice@example.test' },
              },
            }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '1710000001.000109' }), { status: 200 });
      },
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }
  );
  const confirmed = await json(confirmResponse);
  const jobBody = await json(await app.fetch(new Request(`http://gateway.test/api/publishing-jobs/${confirmed.jobId}`)));

  assert.equal(confirmResponse.status, 200);
  assert.equal(confirmed.created, true);
  assert.match(jobBody.job.employeeSlug, /^alice-[a-z0-9]{6}$/);
  assert.notEqual(jobBody.job.employeeSlug, 'alice');
  assert.equal(jobBody.job.siteSlug, 'brand');
  assert.equal(jobBody.job.summary, '用户希望创建一个清爽可信的个人品牌页面。');
  assert.equal(workerStarts.length, 1);
  const chatRequests = slackRequests.filter((call) => /\/chat\.(postMessage|update)$/.test(call.url));
  assert.equal(chatRequests.length, 2);
  assert.equal(chatRequests[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(chatRequests[1].url, 'https://slack.com/api/chat.update');
  const updatePayload = JSON.parse(chatRequests[1].request.body);
  assert.equal(updatePayload.channel, 'D1');
  assert.equal(updatePayload.ts, '1710000000.000109');
  assert.match(JSON.stringify(updatePayload.blocks), /发布需求已确认/);
  assert.doesNotMatch(JSON.stringify(updatePayload.blocks), /pages_confirm_issue/);
});

test('Slack continue modifying button updates the draft card without creating an issue', async () => {
  const app = createGatewayApp();
  const draftResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-freeform-continue-card-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000119',
          text: '做一个个人网站，先突出项目经历',
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
              siteSlug: 'profile',
              title: '个人网站',
              summary: '用户希望创建突出项目经历的个人网站。',
              needsClarification: false,
            },
          }),
          { status: 200 }
        );
      },
    }
  );
  const draft = await json(draftResponse);
  const secret = 'slack-signing-secret';
  const timestamp = String(Math.floor(Date.now() / 1000));
  const payload = JSON.stringify({
    type: 'block_actions',
    team: { id: 'T1' },
    user: { id: 'U1' },
    channel: { id: 'D1' },
    message: { ts: '1710000000.000119' },
    actions: [{ action_id: 'pages_continue_modifying', value: draft.slackSessionId }],
  });
  const formBody = new URLSearchParams({ payload }).toString();
  const slackRequests = [];

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
    {
      SLACK_SIGNING_SECRET: secret,
      SLACK_BOT_TOKEN: 'xoxb-test',
      async SLACK_FETCH(url, request) {
        slackRequests.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '1710000000.000119' }), { status: 200 });
      },
    }
  );
  const body = await json(response);
  const updatePayload = JSON.parse(slackRequests[0].request.body);

  assert.equal(response.status, 200);
  assert.match(body.text, /继续回复/);
  assert.equal(app.store.jobs.size, 0);
  assert.equal(slackRequests[0].url, 'https://slack.com/api/chat.update');
  assert.match(JSON.stringify(updatePayload.blocks), /继续补充需求/);
  assert.match(JSON.stringify(updatePayload.blocks), /等待补充/);
  assert.match(JSON.stringify(updatePayload.blocks), /pages_confirm_issue/);
});

test('Slack work item list only shows current user publishing jobs', async () => {
  const app = createGatewayApp();
  const owned = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'owned-work-item',
    employeeSlug: 'u1',
    siteSlug: 'profile',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'U1 profile page',
    summary: '个人主页',
  }).job;
  app.store.patchJob(owned.id, {
    status: 'preview_deployed',
    issueNumber: 65,
    issueUrl: 'https://github.example/org/pages-manager/issues/65',
    prNumber: 68,
    prUrl: 'https://github.example/org/pages-manager/pull/68',
    previewUrl: 'https://preview.example.test/u1',
  });
  const other = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U2',
    idempotencyKey: 'other-work-item',
    employeeSlug: 'u2',
    siteSlug: 'profile',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'U2 profile page',
    summary: '别人的主页',
  }).job;
  app.store.patchJob(other.id, { status: 'pr_created', prNumber: 70 });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-work-items-list-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000130',
          text: '我的 PR',
        },
      }),
    })
  );
  const body = await json(response);
  const visible = JSON.stringify(body.blocks);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'list_work_items');
  assert.equal(body.accepted, false);
  assert.equal(body.jobs.length, 1);
  assert.equal(body.jobs[0].prNumber, 68);
  assert.match(visible, /你的发布任务/);
  assert.match(visible, /pages_select_work_item/);
  assert.doesNotMatch(visible, /#70/);
  assert.equal(app.store.jobs.size, 2);

  const selectValue = body.blocks.find((block) => block.type === 'actions')?.elements?.[0]?.value;
  const interactionPayload = {
    type: 'block_actions',
    team: { id: 'T1' },
    user: { id: 'U1' },
    channel: { id: 'D1' },
    message: { ts: '1710000000.000130' },
    actions: [{ action_id: 'pages_select_work_item', value: selectValue }],
  };
  const selectResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ payload: JSON.stringify(interactionPayload) }).toString(),
    })
  );
  const selected = await json(selectResponse);
  const session = app.store.getSlackSession(body.slackSessionId);

  assert.equal(selectResponse.status, 200);
  assert.match(selected.text, /已切换到 PR #68/);
  assert.equal(session.activeJobId, owned.id);
  assert.equal(session.activePrNumber, 68);
});

test('Slack refuses bulk destructive issue requests instead of listing jobs', async () => {
  const app = createGatewayApp();
  const agentCalls = [];
  const job = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'bulk-close-owned',
    employeeSlug: 'u1',
    siteSlug: 'profile',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'U1 profile page',
    summary: '个人主页',
  }).job;
  app.store.patchJob(job.id, { status: 'preview_deployed', issueNumber: 65, prNumber: 68 });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-bulk-close-issues-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000133',
          text: '把我名下项目 issue 全部归档',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      async SLACK_AGENT_FETCH(url, request) {
        agentCalls.push({ url: String(url), request });
        return new Response(
          JSON.stringify({
            analysis: {
              intent: 'list_work_items',
              summary: '模型误判为查看任务列表',
              needsClarification: false,
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'unsupported_destructive_request');
  assert.equal(body.accepted, false);
  assert.match(body.replyText, /不能批量关闭或删除/);
  assert.equal(app.store.getJob(job.id).status, 'preview_deployed');
  assert.equal(agentCalls.length, 0);
});

test('Slack work item list hides inactive jobs by default and shows history as read-only', async () => {
  const app = createGatewayApp();
  const active = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'active-work-item',
    employeeSlug: 'u1',
    siteSlug: 'active',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Active profile page',
    summary: '可继续任务',
  }).job;
  app.store.patchJob(active.id, {
    status: 'preview_deployed',
    issueNumber: 65,
    issueUrl: 'https://github.example/org/pages-manager/issues/65',
    prNumber: 68,
    prUrl: 'https://github.example/org/pages-manager/pull/68',
    previewUrl: 'https://preview.example.test/u1',
  });
  const closed = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'closed-work-item',
    employeeSlug: 'u1',
    siteSlug: 'closed',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Closed profile page',
    summary: '已关闭任务',
  }).job;
  app.store.patchJob(closed.id, {
    status: 'cancelled',
    errorCode: 'github_issue_closed',
    errorMessage: 'GitHub issue #66 已关闭，发布任务已停止。',
    issueNumber: 66,
    issueUrl: 'https://github.example/org/pages-manager/issues/66',
    prNumber: 69,
    prUrl: 'https://github.example/org/pages-manager/pull/69',
  });

  const listResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-work-items-active-only-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000134',
          text: '我的 PR',
        },
      }),
    })
  );
  const listBody = await json(listResponse);
  const defaultBlocks = JSON.stringify(listBody.blocks);

  assert.equal(listBody.jobs.length, 1);
  assert.equal(listBody.jobs[0].prNumber, 68);
  assert.doesNotMatch(defaultBlocks, /#69/);

  const historyResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-work-items-history-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000135',
          text: '查看我的历史发布任务',
        },
      }),
    })
  );
  const historyBody = await json(historyResponse);
  const historyBlocks = JSON.stringify(historyBody.blocks);
  const closedSectionIndex = historyBody.blocks.findIndex((block) => JSON.stringify(block).includes('#69'));
  const closedActions = closedSectionIndex >= 0 ? historyBody.blocks[closedSectionIndex + 1] : null;

  assert.equal(historyBody.jobs.length, 2);
  assert.match(historyBlocks, /Issue 已关闭/);
  assert.match(historyBlocks, /打开 Issue/);
  assert.ok(closedSectionIndex >= 0);
  assert.doesNotMatch(JSON.stringify(closedActions), /pages_select_work_item/);

  const staleSelectResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        payload: JSON.stringify({
          type: 'block_actions',
          team: { id: 'T1' },
          user: { id: 'U1' },
          channel: { id: 'D1' },
          message: { ts: '1710000000.000135' },
          actions: [
            {
              action_id: 'pages_select_work_item',
              value: JSON.stringify({ sessionId: historyBody.slackSessionId, jobId: closed.id }),
            },
          ],
        }),
      }).toString(),
    })
  );
  const staleSelect = await json(staleSelectResponse);

  assert.equal(staleSelect.response_type, 'ephemeral');
  assert.match(staleSelect.text, /不能继续修改/);
});

test('Slack work item list reconciles GitHub closed issues before showing actions', async () => {
  const app = createGatewayApp();
  const job = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'stale-github-closed-work-item',
    employeeSlug: 'u1',
    siteSlug: 'closed-on-github',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Closed on GitHub',
    summary: 'GitHub 已关闭但本地状态还没同步。',
  }).job;
  app.store.patchJob(job.id, {
    status: 'preview_deployed',
    issueNumber: 66,
    issueUrl: 'https://github.example/org/pages-manager/issues/66',
    prNumber: 69,
    prUrl: 'https://github.example/org/pages-manager/pull/69',
  });

  const githubRequests = [];
  const env = {
    GITHUB_REPO: 'org/pages-manager',
    GITHUB_STATUS_TOKEN: 'ghs_status',
    async GITHUB_STATUS_FETCH(url, request) {
      githubRequests.push({ url: String(url), request });
      return new Response(
        JSON.stringify({
          number: 66,
          state: 'closed',
          closed_at: '2026-06-16T07:00:00.000Z',
          html_url: 'https://github.example/org/pages-manager/issues/66',
        })
      );
    },
  };

  const listResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-work-items-reconcile-closed-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000136',
          text: '我的 PR',
        },
      }),
    }),
    env
  );
  const listBody = await json(listResponse);

  assert.equal(listResponse.status, 200);
  assert.equal(listBody.action, 'list_work_items');
  assert.equal(listBody.jobs.length, 0);
  assert.equal(app.store.getJob(job.id).status, 'cancelled');
  assert.equal(app.store.getJob(job.id).errorCode, 'github_issue_closed');
  assert.equal(githubRequests[0].url, 'https://api.github.com/repos/org/pages-manager/issues/66');
  assert.equal(githubRequests[0].request.headers.Authorization, 'Bearer ghs_status');

  const historyResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-work-items-reconcile-closed-history-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000137',
          text: '查看我的历史发布任务',
        },
      }),
    }),
    env
  );
  const historyBody = await json(historyResponse);
  const historyBlocks = JSON.stringify(historyBody.blocks);

  assert.equal(historyBody.jobs.length, 1);
  assert.match(historyBlocks, /Issue 已关闭/);
  assert.match(historyBlocks, /打开 Issue/);
  assert.doesNotMatch(historyBlocks, /pages_select_work_item/);
});

test('Slack work item list reconciles closed GitHub issues beyond the display limit', async () => {
  const app = createGatewayApp();
  const closed = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'stale-closed-beyond-display-limit',
    employeeSlug: 'u1',
    siteSlug: 'closed-old',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Closed old profile page',
    summary: '这个任务已经在 GitHub 关闭，但本地状态还没同步。',
  }).job;
  app.store.patchJob(closed.id, {
    status: 'preview_deployed',
    issueNumber: 60,
    issueUrl: 'https://github.example/org/pages-manager/issues/60',
    updatedAt: '2026-06-15T00:00:00.000Z',
  });

  for (let index = 0; index < 6; index += 1) {
    const active = app.store.createJob({
      source: 'slack',
      requestedByType: 'user',
      requestedById: 'slack:T1:U1',
      idempotencyKey: `active-before-closed-${index}`,
      employeeSlug: 'u1',
      siteSlug: `active-${index}`,
      intent: 'create_site',
      approvalMode: 'manual_required',
      title: `Active profile page ${index}`,
      summary: '可继续任务',
    }).job;
    const patched = app.store.patchJob(active.id, {
      status: 'preview_deployed',
      issueNumber: 100 + index,
      issueUrl: `https://github.example/org/pages-manager/issues/${100 + index}`,
      prNumber: 200 + index,
    });
    app.store.jobs.set(patched.id, {
      ...patched,
      updatedAt: `2026-06-16T00:0${index}:00.000Z`,
    });
  }

  app.store.jobs.set(closed.id, {
    ...app.store.getJob(closed.id),
    updatedAt: '2026-06-15T00:00:00.000Z',
  });

  const githubRequests = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-work-items-reconcile-beyond-limit-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000138',
          text: '我的 PR',
        },
      }),
    }),
    {
      GITHUB_REPO: 'org/pages-manager',
      GITHUB_STATUS_TOKEN: 'ghs_status',
      async GITHUB_STATUS_FETCH(url) {
        const issueNumber = Number(String(url).match(/\/issues\/(\d+)$/)?.[1] || 0);
        githubRequests.push(issueNumber);
        return new Response(
          JSON.stringify({
            number: issueNumber,
            state: issueNumber === 60 ? 'closed' : 'open',
            closed_at: issueNumber === 60 ? '2026-06-15T08:01:25.000Z' : null,
            html_url: `https://github.example/org/pages-manager/issues/${issueNumber}`,
          })
        );
      },
    }
  );
  const body = await json(response);
  const visible = JSON.stringify(body.blocks);

  assert.equal(response.status, 200);
  assert.equal(body.jobs.length, 5);
  assert.equal(app.store.getJob(closed.id).status, 'cancelled');
  assert.equal(app.store.getJob(closed.id).errorCode, 'github_issue_closed');
  assert.ok(githubRequests.includes(60));
  assert.doesNotMatch(visible, /closed-old/);
  assert.doesNotMatch(visible, /#60/);
});

test('Slack work item list reconciles GitHub closed PRs before showing actions', async () => {
  const app = createGatewayApp();
  const job = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'stale-github-closed-pr-work-item',
    employeeSlug: 'u1',
    siteSlug: 'closed-pr-on-github',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Closed PR profile page',
    summary: 'GitHub PR 已关闭，但本地状态还没同步。',
  }).job;
  app.store.patchJob(job.id, {
    status: 'preview_deployed',
    issueNumber: 65,
    issueUrl: 'https://github.example/org/pages-manager/issues/65',
    prNumber: 68,
    prUrl: 'https://github.example/org/pages-manager/pull/68',
  });

  const githubRequests = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-work-items-reconcile-closed-pr-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000139',
          text: '我的 PR',
        },
      }),
    }),
    {
      GITHUB_REPO: 'org/pages-manager',
      GITHUB_STATUS_TOKEN: 'ghs_status',
      async GITHUB_STATUS_FETCH(url) {
        githubRequests.push(String(url));
        if (String(url).includes('/pulls/68')) {
          return new Response(
            JSON.stringify({
              number: 68,
              state: 'closed',
              merged: false,
              html_url: 'https://github.example/org/pages-manager/pull/68',
            })
          );
        }
        return new Response(
          JSON.stringify({
            number: 65,
            state: 'open',
            html_url: 'https://github.example/org/pages-manager/issues/65',
          })
        );
      },
    }
  );
  const body = await json(response);
  const visible = JSON.stringify(body.blocks);

  assert.equal(response.status, 200);
  assert.equal(body.jobs.length, 0);
  assert.equal(app.store.getJob(job.id).status, 'cancelled');
  assert.equal(app.store.getJob(job.id).errorCode, 'github_pr_closed');
  assert.ok(githubRequests.some((url) => url.includes('/issues/65')));
  assert.ok(githubRequests.some((url) => url.includes('/pulls/68')));
  assert.doesNotMatch(visible, /closed-pr-on-github/);
  assert.doesNotMatch(visible, /#68/);
});

test('Slack reopen button restores a closed GitHub PR work item', async () => {
  const app = createGatewayApp();
  const job = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'reopen-closed-pr-work-item',
    employeeSlug: 'u1',
    siteSlug: 'closed-pr',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Closed PR profile page',
    summary: '已关闭 PR 需要恢复。',
  }).job;
  app.store.patchJob(job.id, {
    status: 'cancelled',
    errorCode: 'github_pr_closed',
    errorMessage: 'GitHub PR #69 已关闭，发布任务已停止。',
    issueNumber: 66,
    issueUrl: 'https://github.example/org/pages-manager/issues/66',
    prNumber: 69,
    prUrl: 'https://github.example/org/pages-manager/pull/69',
  });

  const historyResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-work-items-reopen-pr-history-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000140',
          text: '查看我的历史发布任务',
        },
      }),
    })
  );
  const historyBody = await json(historyResponse);
  const historyBlocks = JSON.stringify(historyBody.blocks);
  const reopenAction = findBlockAction(historyBody.blocks, 'pages_reopen_work_item');

  assert.match(historyBlocks, /PR 已关闭/);
  assert.match(historyBlocks, /重新打开 PR/);
  assert.ok(reopenAction);

  const githubRequests = [];
  const reopenResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        payload: JSON.stringify({
          type: 'block_actions',
          team: { id: 'T1' },
          user: { id: 'U1' },
          channel: { id: 'D1' },
          message: { ts: '1710000000.000140' },
          actions: [reopenAction],
        }),
      }).toString(),
    }),
    {
      GITHUB_REPO: 'org/pages-manager',
      GITHUB_APP_INSTALLATION_TOKEN: 'ghs_write',
      async GITHUB_FETCH(url, request) {
        githubRequests.push({ url: String(url), request });
        return new Response(
          JSON.stringify({
            number: 69,
            state: 'open',
            merged: false,
            html_url: 'https://github.example/org/pages-manager/pull/69',
          })
        );
      },
    }
  );
  const reopenBody = await json(reopenResponse);
  const updatedJob = app.store.getJob(job.id);

  assert.equal(reopenResponse.status, 200);
  assert.equal(reopenBody.jobId, job.id);
  assert.equal(updatedJob.status, 'reviewing');
  assert.equal(updatedJob.errorCode, null);
  assert.equal(updatedJob.errorMessage, null);
  assert.equal(githubRequests[0].request.method, 'PATCH');
  assert.match(githubRequests[0].url, /\/pulls\/69$/);
  assert.equal(JSON.parse(githubRequests[0].request.body).state, 'open');
});

test('Slack reopen button restores a closed GitHub issue work item', async () => {
  const app = createGatewayApp();
  const job = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'reopen-closed-issue-work-item',
    employeeSlug: 'u1',
    siteSlug: 'closed-issue',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Closed issue profile page',
    summary: '已关闭 issue 需要恢复。',
  }).job;
  app.store.patchJob(job.id, {
    status: 'cancelled',
    errorCode: 'github_issue_closed',
    errorMessage: 'GitHub issue #70 已关闭，发布任务已停止。',
    issueNumber: 70,
    issueUrl: 'https://github.example/org/pages-manager/issues/70',
  });

  const historyResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-work-items-reopen-issue-history-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000141',
          text: '查看我的历史发布任务',
        },
      }),
    })
  );
  const historyBody = await json(historyResponse);
  const historyBlocks = JSON.stringify(historyBody.blocks);
  const reopenAction = findBlockAction(historyBody.blocks, 'pages_reopen_work_item');

  assert.match(historyBlocks, /Issue 已关闭/);
  assert.match(historyBlocks, /重新打开 Issue/);
  assert.ok(reopenAction);

  const githubRequests = [];
  const reopenResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        payload: JSON.stringify({
          type: 'block_actions',
          team: { id: 'T1' },
          user: { id: 'U1' },
          channel: { id: 'D1' },
          message: { ts: '1710000000.000141' },
          actions: [reopenAction],
        }),
      }).toString(),
    }),
    {
      GITHUB_REPO: 'org/pages-manager',
      GITHUB_APP_INSTALLATION_TOKEN: 'ghs_write',
      async GITHUB_FETCH(url, request) {
        githubRequests.push({ url: String(url), request });
        return new Response(
          JSON.stringify({
            number: 70,
            state: 'open',
            html_url: 'https://github.example/org/pages-manager/issues/70',
          })
        );
      },
    }
  );
  const reopenBody = await json(reopenResponse);
  const updatedJob = app.store.getJob(job.id);

  assert.equal(reopenResponse.status, 200);
  assert.equal(reopenBody.jobId, job.id);
  assert.equal(updatedJob.status, 'generating_page');
  assert.equal(updatedJob.errorCode, null);
  assert.equal(updatedJob.errorMessage, null);
  assert.equal(githubRequests[0].request.method, 'PATCH');
  assert.match(githubRequests[0].url, /\/issues\/70$/);
  assert.equal(JSON.parse(githubRequests[0].request.body).state, 'open');
});

test('Slack close session stops running agent runs before the same thread continues', async () => {
  const app = createGatewayApp();
  const session = app.store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm-thread:D1:1710000000.000140',
    sessionTitle: 'Profile page',
    channelId: 'D1',
    threadTs: '1710000000.000140',
    dmChannelId: 'D1',
    surfaceContext: {
      channelId: 'D1',
      channelType: 'im',
      messageTs: '1710000000.000140',
      threadTs: '1710000000.000140',
      dmChannelId: 'D1',
    },
    status: 'active',
    activeContextExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  const job = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'close-session-running-agent',
    employeeSlug: 'u1',
    siteSlug: 'profile',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'U1 profile page',
    summary: '个人主页',
    slackSessionId: session.id,
    slackSessionKey: session.sessionKey,
    slackThread: {
      teamId: 'T1',
      channelId: 'D1',
      channelType: 'im',
      messageTs: '1710000000.000140',
      threadTs: '1710000000.000140',
      userId: 'U1',
    },
  }).job;
  const activeJob = app.store.patchJob(job.id, {
    status: 'preview_deployed',
    issueNumber: 65,
    issueUrl: 'https://github.example/org/pages-manager/issues/65',
    prNumber: 68,
    prUrl: 'https://github.example/org/pages-manager/pull/68',
    previewUrl: 'https://preview.example.test/u1',
  });
  app.store.linkJobToSlackSession(activeJob, session);
  const runningRun = app.store.createAgentRun({
    agentKind: 'slack_agent',
    slackSessionId: session.id,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  const closeResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        payload: JSON.stringify({
          type: 'block_actions',
          team: { id: 'T1' },
          user: { id: 'U1' },
          channel: { id: 'D1' },
          message: { ts: '1710000001.000140', thread_ts: '1710000000.000140' },
          actions: [{ action_id: 'pages_close_session', value: session.id }],
        }),
      }).toString(),
    })
  );
  const closeBody = await json(closeResponse);

  assert.equal(closeResponse.status, 200);
  assert.match(closeBody.text, /已关闭当前会话/);
  assert.equal(app.store.getSlackSession(session.id).status, 'closed');
  assert.equal(app.store.getAgentRun(runningRun.id).status, 'failed');
  assert.equal(app.store.getAgentRun(runningRun.id).errorCode, 'slack_session_closed');

  const listResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-after-close-same-thread-list-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000002.000140',
          thread_ts: '1710000000.000140',
          text: '目前我的 PR 有几个？',
        },
      }),
    })
  );
  const listBody = await json(listResponse);

  assert.equal(listResponse.status, 200);
  assert.notEqual(listBody.action, 'agent_busy');
  assert.equal(listBody.action, 'list_work_items');
  assert.equal(listBody.jobs.length, 1);
});

test('Slack can switch the current thread to a visible PR', async () => {
  const app = createGatewayApp();
  const job = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'switch-work-item',
    employeeSlug: 'u1',
    siteSlug: 'profile',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'U1 profile page',
    summary: '个人主页',
  }).job;
  app.store.patchJob(job.id, {
    status: 'preview_deployed',
    prNumber: 68,
    prUrl: 'https://github.example/org/pages-manager/pull/68',
    previewUrl: 'https://preview.example.test/u1',
  });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-work-items-switch-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000131',
          text: '继续 PR #68',
        },
      }),
    })
  );
  const body = await json(response);
  const session = app.store.getSlackSession(body.slackSessionId);
  const updatedJob = app.store.getJob(job.id);
  const links = app.store.findIssueLinksForSlackSession(session.id);
  const memory = app.store.getSessionMemory(session.id);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'switch_work_item');
  assert.equal(body.jobId, job.id);
  assert.equal(session.activeJobId, job.id);
  assert.equal(session.activePrNumber, 68);
  assert.equal(updatedJob.slackSessionId, session.id);
  assert.equal(updatedJob.slackThread.threadTs, '1710000000.000131');
  assert.equal(links.length, 1);
  assert.equal(links[0].publishingJobId, job.id);
  assert.equal(memory.requirements.prNumber, 68);
  assert.equal(memory.requirements.previewUrl, 'https://preview.example.test/u1');
  assert.match(memory.lastAgentResponse, /已切换到 PR #68/);
});

test('Slack switch only patches Slack binding and keeps fresher job state', async () => {
  const app = createGatewayApp();
  const job = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'switch-keeps-fresher-job-state',
    employeeSlug: 'u1',
    siteSlug: 'profile',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'U1 profile page',
    summary: '个人主页',
  }).job;
  app.store.patchJob(job.id, {
    status: 'reviewing',
    prNumber: 68,
    prUrl: 'https://github.example/org/pages-manager/pull/68',
    previewUrl: null,
  });
  const staleJob = app.store.getJob(job.id);
  app.store.patchJob(job.id, {
    status: 'preview_deployed',
    previewUrl: 'https://preview.example.test/u1-fresh',
    headSha: 'a'.repeat(40),
  });
  app.store.findJobByPrNumber = () => staleJob;

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-work-items-switch-stale-job-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000135',
          text: '继续 PR #68',
        },
      }),
    })
  );
  const body = await json(response);
  const session = app.store.getSlackSession(body.slackSessionId);
  const updatedJob = app.store.getJob(job.id);
  const memory = app.store.getSessionMemory(session.id);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'switch_work_item');
  assert.equal(updatedJob.status, 'preview_deployed');
  assert.equal(updatedJob.previewUrl, 'https://preview.example.test/u1-fresh');
  assert.equal(updatedJob.headSha, 'a'.repeat(40));
  assert.equal(updatedJob.slackSessionId, session.id);
  assert.equal(updatedJob.slackThread.threadTs, '1710000000.000135');
  assert.equal(memory.requirements.previewUrl, 'https://preview.example.test/u1-fresh');
});

test('Slack switch posts a new scoped card when the existing job card belongs to another thread', async () => {
  const app = createGatewayApp();
  const job = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'switch-scoped-card',
    employeeSlug: 'u1',
    siteSlug: 'profile',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'U1 profile page',
    summary: '个人主页',
  }).job;
  app.store.patchJob(job.id, {
    status: 'preview_deployed',
    prNumber: 68,
    prUrl: 'https://github.example/org/pages-manager/pull/68',
    previewUrl: 'https://preview.example.test/u1',
  });
  app.store.recordSlackJobStatusMessage(job.id, {
    channel: 'D-old',
    threadTs: '1710000000.000001',
    messageTs: '1710000000.000002',
    stage: 'preview_deployed',
    status: 'preview_deployed',
  });
  const slackRequests = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-work-items-switch-scoped-card-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D-new',
          channel_type: 'im',
          ts: '1710000000.000133',
          text: '继续 PR #68',
        },
      }),
    }),
    {
      SLACK_BOT_TOKEN: 'test-slack-token',
      async SLACK_FETCH(url, request) {
        slackRequests.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'D-new', ts: '1710000000.000134' }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);
  const payload = JSON.parse(slackRequests[0].request.body);
  const scopedMessage = app.store.getSlackJobStatusMessage(job.id, { slackSessionId: body.slackSessionId });
  const oldMessage = app.store.getSlackJobStatusMessage(job.id);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'switch_work_item');
  assert.equal(body.noReply, true);
  assert.equal(slackRequests.length, 1);
  assert.equal(slackRequests[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(payload.channel, 'D-new');
  assert.equal(payload.thread_ts, '1710000000.000133');
  assert.equal(payload.ts, undefined);
  assert.equal(scopedMessage.channel, 'D-new');
  assert.equal(scopedMessage.threadTs, '1710000000.000133');
  assert.equal(scopedMessage.messageTs, '1710000000.000134');
  assert.equal(oldMessage.channel, 'D-old');
  assert.equal(oldMessage.messageTs, '1710000000.000002');
});

test('Slack cannot switch to another user PR', async () => {
  const app = createGatewayApp();
  const job = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U2',
    idempotencyKey: 'cross-user-work-item',
    employeeSlug: 'u2',
    siteSlug: 'profile',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'U2 profile page',
    summary: '别人的主页',
  }).job;
  app.store.patchJob(job.id, { status: 'pr_created', prNumber: 70 });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-work-items-cross-user-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000132',
          text: '继续 PR #70',
        },
      }),
    })
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'switch_work_item_not_found');
  assert.equal(body.accepted, false);
  assert.match(body.replyText, /没有找到你可继续操作的 PR #70/);
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
  assert.match(body.replyText, /现在还不能理解这条消息/);
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

test('executor callbacks update the source Slack status card without extra progress messages', async () => {
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
  assert.equal(body.slackNotification, undefined);
  assert.equal(slackMessages.length, 1);
  const statusPayload = JSON.parse(slackMessages[0].request.body);
  assert.equal(slackMessages[0].url, 'https://slack.com/api/chat.postMessage');
  assert.equal(statusPayload.channel, 'C1');
  assert.equal(statusPayload.thread_ts, '1710000000.000200');
  assert.match(statusPayload.text, /^<@U1> Pages 发布进度/);
  assert.ok(Array.isArray(statusPayload.blocks));
  assert.match(JSON.stringify(statusPayload.blocks), /Issue 已创建/);
  assert.match(JSON.stringify(statusPayload.blocks), /查看 Issue/);
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
  assert.equal(duplicateBody.slackNotification, undefined);
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
    assert.match(body.replyText, action === 'help' ? /先整理，等你确认/ : /我在/);
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
  assert.doesNotMatch(body.replyText, /job_[A-Za-z0-9_]+/);
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

  app.store.recordSlackJobStatusMessage(created.jobId, {
    channel: 'D1',
    threadTs: '1710000000.000100',
    messageTs: '1710000001.000100',
    stage: 'preview_deployed',
    status: 'preview_deployed',
  });

  const workerStarts = [];
  const agentCalls = [];
  const slackRequests = [];
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
      SLACK_BOT_TOKEN: 'test-slack-token',
      async SLACK_FETCH(url, request) {
        slackRequests.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '1710000001.000100' }), {
          status: 200,
        });
      },
    }
  );
  const followup = await json(followupResponse);
  const jobBody = await json(await app.fetch(new Request(`http://gateway.test/api/publishing-jobs/${created.jobId}`)));
  const slackPayload = JSON.parse(slackRequests[0].request.body);

  assert.equal(followupResponse.status, 200);
  assert.equal(followup.action, 'followup_fix_dispatched');
  assert.equal(followup.jobId, created.jobId);
  assert.equal(followup.noReply, true);
  assert.equal(followup.slackStatusNotification.action, 'updated');
  assert.equal(slackRequests[0].url, 'https://slack.com/api/chat.update');
  assert.match(JSON.stringify(slackPayload.blocks), /第 1 轮修改处理中/);
  assert.match(JSON.stringify(slackPayload.blocks), /最终需求/);
  assert.match(JSON.stringify(slackPayload.blocks), /本轮修改.*把标题改成中文/);
  assert.doesNotMatch(JSON.stringify(slackPayload.blocks), /Slack Follow-up/);
  assert.equal(jobBody.job.status, 'fixing');
  assert.equal(jobBody.job.previewUrl, null);
  assert.equal(agentCalls.length, 1);
  assert.equal(workerStarts.length, 1);

  const queuedResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-followup-queued',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000020.000100',
          thread_ts: '1710000000.000100',
          text: '再把按钮改成黑色',
        },
      }),
    }),
    {
      SLACK_AGENT_ANALYZE_URL: 'http://slack-agent.test/internal/slack-agent/analyze',
      async SLACK_AGENT_FETCH() {
        agentCalls.push({ queued: true });
        return new Response(
          JSON.stringify({
            ok: true,
            analysis: {
              intent: 'append_requirement',
              summary: '再把按钮改成黑色。',
              needsClarification: false,
            },
          }),
          { status: 200 }
        );
      },
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH() {
        workerStarts.push({ queued: true });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      SLACK_BOT_TOKEN: 'test-slack-token',
      async SLACK_FETCH(url, request) {
        slackRequests.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '1710000001.000100' }), {
          status: 200,
        });
      },
    }
  );
  const queued = await json(queuedResponse);
  const queuedSlackPayload = JSON.parse(slackRequests.at(-1).request.body);

  assert.equal(queuedResponse.status, 200);
  assert.equal(queued.action, 'followup_fix_queued');
  assert.equal(queued.noReply, true);
  assert.match(JSON.stringify(queuedSlackPayload.blocks), /第 2 轮修改已排队/);
  assert.match(JSON.stringify(queuedSlackPayload.blocks), /最终需求/);
  assert.match(JSON.stringify(queuedSlackPayload.blocks), /本轮修改.*再把按钮改成黑色/);
  assert.doesNotMatch(JSON.stringify(queuedSlackPayload.blocks), /Slack Follow-up/);
  assert.equal(workerStarts.length, 1);

  const rerunResponse = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: created.jobId,
        stageResult: 'reviewing',
        branchName: 'sites/job-followup-fix-zhangsan-profile',
        prNumber: 31,
        prUrl: 'https://github.example/org/pages-manager/pull/31',
        baseRef: 'staging',
        headSha: '4'.repeat(40),
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request, rerun: true });
        const body = JSON.parse(request.body);
        assert.equal(body.job.id, created.jobId);
        assert.equal(body.job.status, 'fixing');
        assert.match(body.job.summary, /标题改成中文/);
        assert.match(body.job.summary, /按钮改成黑色/);
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_agent_fix_dispatched' } }), {
          status: 200,
        });
      },
      SLACK_BOT_TOKEN: 'test-slack-token',
      async SLACK_FETCH(url, request) {
        slackRequests.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '1710000001.000100' }), {
          status: 200,
        });
      },
    }
  );
  const rerun = await json(rerunResponse);

  assert.equal(rerunResponse.status, 200);
  assert.equal(rerun.job.status, 'fixing');
  assert.equal(rerun.queuedFollowupRerun.queuedFollowupCount, 1);
  assert.equal(rerun.workerStart.started, true);
  assert.equal(workerStarts.length, 2);
});

test('queued Slack follow-up rerun uses Redis claim to avoid duplicate Coding Agent dispatch', async () => {
  const app = createGatewayApp();
  const jobId = await moveJobToPrCreated(app, { prNumber: 61, headSha: '6'.repeat(40) });
  app.store.moveJobToFixing(jobId, {
    summary: [
      '做一个 profile 页面。',
      '',
      '## Slack Follow-up',
      '标题改成中文。',
      '',
      '## Slack Follow-up',
      '按钮改成黑色。',
    ].join('\n'),
  });
  app.store.recordAgentRunEvent(
    {
      publishingJobId: jobId,
      type: 'coding_fix_dispatched',
      stage: 'fixing',
      status: 'dispatched',
      text: 'round:1 Coding Agent 修复已启动。',
      dedupeKey: `test-dispatched:${jobId}:1`,
    },
    new Date('2026-06-14T00:00:00.000Z')
  );
  app.store.recordAgentRunEvent(
    {
      publishingJobId: jobId,
      type: 'slack_followup_queued',
      stage: 'fixing',
      status: 'queued',
      text: '按钮改成黑色。',
      dedupeKey: `test-queued:${jobId}:2`,
    },
    new Date('2026-06-14T00:00:01.000Z')
  );

  const redisCalls = [];
  app.store.redis = {
    async set(...args) {
      redisCalls.push(['set', ...args]);
      return null;
    },
  };
  const workerStarts = [];
  const slackRequests = [];

  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: jobId,
        stageResult: 'reviewing',
        branchName: 'sites/job-followup-fix-zhangsan-profile',
        prNumber: 61,
        prUrl: 'https://github.example/org/pages-manager/pull/61',
        baseRef: 'staging',
        headSha: '7'.repeat(40),
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      SLACK_BOT_TOKEN: 'test-slack-token',
      async SLACK_FETCH(url, request) {
        slackRequests.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.queuedFollowupRerun.skipped, true);
  assert.equal(body.queuedFollowupRerun.reason, 'queued_followup_claimed');
  assert.equal(workerStarts.length, 0);
  assert.equal(slackRequests.length, 0);
  assert.equal(redisCalls.length, 1);
  assert.deepEqual(redisCalls[0].slice(0, 4), [
    'set',
    `pages-manager:coding-fix:queued-followup:${jobId}:round:2`,
    redisCalls[0][2],
    'PX',
  ]);
  assert.equal(redisCalls[0][5], 'NX');
});

test('Slack create intent in an active DM session records follow-up instead of creating another issue', async () => {
  const app = createGatewayApp();
  const createResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-active-create-intent-create',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000130',
          text: 'issue: 帮我创建 profile 页面',
        },
      }),
    })
  );
  const created = await json(createResponse);

  const issueResponse = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: created.jobId,
        stageResult: 'issue_created',
        issueNumber: 71,
        issueUrl: 'https://github.example/org/pages-manager/issues/71',
      }),
    })
  );
  assert.equal(issueResponse.status, 200);

  const workerStarts = [];
  const followupResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-active-create-intent-confirm',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000010.000130',
          thread_ts: '1710000000.000130',
          text: '我确定了，开始生成页面吧',
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
              title: '确认开始生成个人网站页面',
              summary: '用户确认开始生成页面，应沿用当前 active issue。',
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
  const followup = await json(followupResponse);
  const jobBody = await json(await app.fetch(new Request(`http://gateway.test/api/publishing-jobs/${created.jobId}`)));

  assert.equal(followupResponse.status, 200);
  assert.equal(followup.action, 'followup_recorded');
  assert.equal(followup.jobId, created.jobId);
  assert.equal(jobBody.job.issueNumber, 71);
  assert.equal(app.store.jobs.size, 1);
  assert.equal(workerStarts.length, 0);
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

test('GitHub issue webhook accepts pages-manager HTML job marker', async () => {
  const app = createGatewayApp();
  const createBody = await json(
    await app.fetch(
      new Request('http://gateway.test/api/publishing-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'api-issue-webhook-html-marker',
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
  const workerStarts = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-issue-html-marker-1',
        'X-GitHub-Event': 'issues',
      },
      body: JSON.stringify({
        action: 'opened',
        repository: { full_name: 'org/pages-manager' },
        issue: {
          number: 33,
          html_url: 'https://github.example/org/pages-manager/issues/33',
          body: `<!-- pages-manager:job_id=${createBody.job.id} -->\n\n## 发布需求\n\nCreate a personal website.`,
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

  assert.equal(response.status, 200);
  assert.equal(body.issueAction, 'pages_agent_dispatched');
  assert.equal(body.job.status, 'generating_page');
  assert.equal(body.job.issueNumber, 33);
  assert.equal(workerStarts.length, 1);
});

test('GitHub closed issue webhook marks the publishing job inactive', async () => {
  const app = createGatewayApp();
  const createBody = await json(
    await app.fetch(
      new Request('http://gateway.test/api/publishing-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'api-issue-webhook-closed',
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
  app.store.patchJob(createBody.job.id, {
    status: 'preview_deployed',
    issueNumber: 34,
    issueUrl: 'https://github.example/org/pages-manager/issues/34',
    prNumber: 35,
  });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-issue-closed-1',
        'X-GitHub-Event': 'issues',
      },
      body: JSON.stringify({
        action: 'closed',
        repository: { full_name: 'org/pages-manager' },
        issue: {
          number: 34,
          html_url: 'https://github.example/org/pages-manager/issues/34',
          body: `PublishingJob: ${createBody.job.id}`,
        },
      }),
    })
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.issueAction, 'job_cancelled_by_issue_closed');
  assert.equal(body.job.status, 'cancelled');
  assert.equal(body.job.errorCode, 'github_issue_closed');
  assert.match(body.job.errorMessage, /issue #34 已关闭/);
});

test('GitHub pull_request webhook marks closed PR inactive and restores reopened PR', async () => {
  const app = createGatewayApp();
  const createBody = await json(
    await app.fetch(
      new Request('http://gateway.test/api/publishing-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'api-pr-webhook-closed',
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
  app.store.patchJob(createBody.job.id, {
    status: 'preview_deployed',
    issueNumber: 34,
    issueUrl: 'https://github.example/org/pages-manager/issues/34',
    prNumber: 35,
    prUrl: 'https://github.example/org/pages-manager/pull/35',
    headSha: 'a'.repeat(40),
  });

  const closedResponse = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-pr-closed-1',
        'X-GitHub-Event': 'pull_request',
      },
      body: JSON.stringify({
        action: 'closed',
        repository: { full_name: 'org/pages-manager' },
        pull_request: {
          number: 35,
          state: 'closed',
          merged: false,
          html_url: 'https://github.example/org/pages-manager/pull/35',
          head: { sha: 'a'.repeat(40) },
        },
      }),
    })
  );
  const closedBody = await json(closedResponse);

  assert.equal(closedResponse.status, 200);
  assert.equal(closedBody.prAction, 'job_cancelled_by_pr_closed');
  assert.equal(closedBody.job.status, 'cancelled');
  assert.equal(closedBody.job.errorCode, 'github_pr_closed');
  assert.match(closedBody.job.errorMessage, /PR #35 已关闭/);

  const reopenedResponse = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-pr-reopened-1',
        'X-GitHub-Event': 'pull_request',
      },
      body: JSON.stringify({
        action: 'reopened',
        repository: { full_name: 'org/pages-manager' },
        pull_request: {
          number: 35,
          state: 'open',
          merged: false,
          html_url: 'https://github.example/org/pages-manager/pull/35',
          head: { sha: 'a'.repeat(40) },
        },
      }),
    })
  );
  const reopenedBody = await json(reopenedResponse);

  assert.equal(reopenedResponse.status, 200);
  assert.equal(reopenedBody.prAction, 'job_restored_by_pr_reopened');
  assert.equal(reopenedBody.job.status, 'reviewing');
  assert.equal(reopenedBody.job.errorCode, null);
  assert.equal(reopenedBody.job.errorMessage, null);
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

test('review gate reconcile records fallback result when Review Agent does not answer', async () => {
  const app = createGatewayApp();
  const headSha = 'e'.repeat(40);
  const jobId = await moveJobToPrCreated(app, {
    prNumber: 29,
    headSha,
    idempotencyKey: 'api-review-fallback-preview',
  });
  const workerStarts = [];

  const response = await app.fetch(
    new Request('http://gateway.test/internal/review-gate/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publishingJobId: jobId }),
    }),
    {
      GITHUB_REVIEW_AGENT_TIMEOUT_SECONDS: '0',
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
  const comments = app.store.listReviewAgentComments('org/pages-manager', 29, { headSha });

  assert.equal(response.status, 200);
  assert.equal(body.reconciled, 1);
  assert.equal(body.results[0].reviewAction, 'review_timeout_preview_dispatched');
  assert.equal(body.results[0].job.status, 'previewing');
  assert.equal(comments.length, 1);
  assert.equal(comments[0].reviewAgentLogin, 'pages-review-watchdog');
  assert.equal(comments[0].classification, 'note');
  assert.match(comments[0].body, /site-check has passed/);
  assert.equal(workerStarts.length, 1);
});

test('review gate reconcile waits before fallback timeout', async () => {
  const app = createGatewayApp();
  const headSha = 'f'.repeat(40);
  const jobId = await moveJobToPrCreated(app, {
    prNumber: 30,
    headSha,
    idempotencyKey: 'api-review-fallback-waiting',
  });
  const workerStarts = [];

  const response = await app.fetch(
    new Request('http://gateway.test/internal/review-gate/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publishingJobId: jobId }),
    }),
    {
      GITHUB_REVIEW_AGENT_TIMEOUT_SECONDS: '3600',
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }
  );
  const body = await json(response);
  const job = app.store.getJob(jobId);

  assert.equal(response.status, 200);
  assert.equal(body.reconciled, 0);
  assert.equal(body.results[0].skipped, 'review_timeout_waiting');
  assert.equal(job.status, 'pr_created');
  assert.equal(workerStarts.length, 0);
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

test('GitHub Review Agent blocking comment updates Slack status card', async () => {
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
  assert.equal(body.slackNotification, undefined);
  assert.equal(slackMessages.length, 1);
  assert.match(JSON.stringify(JSON.parse(slackMessages[0].request.body).blocks), /等待修复 Review 意见/);
});

test('GitHub Review Agent suggestion comment updates Slack status card without blocking preview', async () => {
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

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'reviewing');
  assert.equal(body.reviewComment.classification, 'suggestion');
  assert.equal(body.gate.canPreview, true);
  assert.equal(body.job.status, 'reviewing');
  assert.equal(body.slackStatusNotification.ok, true);
  assert.equal(body.slackNotification, undefined);
  assert.equal(slackMessages.length, 1);
  assert.match(JSON.stringify(statusPayload.blocks), /等待 Agent Review/);
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
