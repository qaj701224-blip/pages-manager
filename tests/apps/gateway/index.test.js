import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createGatewayApp as createRuntimeGatewayApp } from '../../../apps/gateway/src/index.js';
import {
  buildConversationContext,
  repeatPreviousMessageFromContext,
} from '../../../apps/gateway/src/slack/conversation-context.js';
import {
  answerRepoQuestion,
  platformDraftFromRepoQuestionContext,
  repoQuestionActionBlocks,
} from '../../../apps/gateway/src/slack/repo-question.js';
import { redactSecretLikeText } from '../../../apps/gateway/src/slack/text.js';
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

function readRequestJson(request = {}) {
  return request.body ? JSON.parse(request.body) : {};
}

test('Slack text redacts all GitHub token prefixes', () => {
  const redacted = redactSecretLikeText(
    [
      'ghp_1234567890abcdefghij1234567890',
      'gho_1234567890abcdefghij1234567890',
      'ghu_1234567890abcdefghij1234567890',
      'ghs_1234567890abcdefghij1234567890',
      'ghr_1234567890abcdefghij1234567890',
      'github_pat_1234567890abcdefghij1234567890',
    ].join(' ')
  );

  assert.equal((redacted.match(/\[REDACTED_GITHUB_TOKEN\]/g) || []).length, 6);
  assert.doesNotMatch(redacted, /gh[pousr]_|github_pat_/);
});

async function fetchAndDrainWaitUntil(app, request, env = {}) {
  const waitUntilPromises = [];
  const response = await app.fetch(request, env, {
    waitUntil(promise) {
      waitUntilPromises.push(promise);
    },
  });
  return {
    response,
    waitUntil: () => Promise.all(waitUntilPromises),
    waitUntilCount: waitUntilPromises.length,
  };
}

function mockSlackAgentTurnAnalysis(analysis = {}, calls = []) {
  return {
    SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
    async SLACK_AGENT_FETCH(_url, request) {
      const payload = readRequestJson(request);
      calls.push(payload);
      return new Response(
        JSON.stringify({
          ok: true,
          turn: {
            agentRunId: payload.agentRunId,
            slackSessionId: payload.slackSessionId,
            analysis,
            events: [
              {
                type: 'analysis_final',
                sequence: 1,
                agentRunId: payload.agentRunId,
                slackSessionId: payload.slackSessionId,
                analysis,
              },
            ],
          },
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    },
  };
}

function notifierResponse(body = {}, status = 200) {
  return new Response(JSON.stringify(body), { status });
}

function defaultSlackNotifierResponse(call, index) {
  const payload = call.body?.payload || {};
  const target = call.body?.target || {};
  const message = call.body?.message || {};
  const job = call.body?.job || {};
  const options = call.body?.options || {};
  const existingMessage = call.body?.existingMessage || null;
  const channel =
    payload.channel || target.channel || message.channel || existingMessage?.channel || job.slackThread?.channelId || 'D1';
  const ts = payload.ts || message.messageTs || existingMessage?.messageTs || `171000000${index}.000100`;

  if (call.path === '/internal/slack-notifier/job-status') {
    return notifierResponse({
      ok: true,
      action: existingMessage?.messageTs ? 'updated' : 'posted',
      channel,
      ts,
      message: {
        channel,
        threadTs: job.slackThread?.threadTs || existingMessage?.threadTs || null,
        messageTs: ts,
        stage: options.stage || job.status,
        status: job.status,
      },
    });
  }

  if (call.path === '/internal/slack-notifier/user-info') {
    return notifierResponse({
      ok: true,
      profile: {
        source: 'slack.users.info',
        slackTeamId: 'T1',
        slackUserId: call.body?.user || call.body?.userId || call.body?.slackUserId || 'U1',
        name: 'zhangsan',
        displayName: '张三',
        realName: 'Zhang San',
        email: 'zhangsan@example.com',
      },
    });
  }

  return notifierResponse({ ok: true, channel, ts });
}

test('conversation context repeat skips the current user message when no previous reply exists', () => {
  const context = buildConversationContext({
    sessionMemory: {},
    intake: {
      text: '上一条消息是什么？',
      messageTs: '1710000000.000100',
    },
  });

  assert.equal(repeatPreviousMessageFromContext(context, 'previous_visible_message'), null);
});

function mockSlackNotifier(calls = [], options = {}) {
  return {
    SLACK_NOTIFIER_URL: options.url || 'http://slack-notifier.test',
    SLACK_NOTIFIER_SHARED_SECRET: options.secret || 'test-slack-notifier-secret',
    async SLACK_NOTIFIER_FETCH(url, request) {
      const call = {
        url: String(url),
        path: new URL(String(url)).pathname,
        request,
        body: readRequestJson(request),
      };
      calls.push(call);
      const custom = options.handle ? await options.handle(call) : null;
      if (custom) return custom;
      return defaultSlackNotifierResponse(call, calls.length);
    },
  };
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
    conclusion: options.conclusion || 'success',
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
  const notifierCalls = [];
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
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'ignored_slack_event');
  assert.equal(body.reason, 'ignored_bot_event');
  assert.equal(notifierCalls.length, 0);
});

test('Slack immediate replies replace working reaction with done reaction', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
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
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);
  const reactionCalls = notifierCalls.filter((call) =>
    ['/internal/slack-notifier/reaction', '/internal/slack-notifier/reaction-remove'].includes(call.path)
  );
  const deliveries = app.store.listSlackDeliveries({ eventId: 'Ev-reaction-done' }).deliveries;

  assert.equal(response.status, 200);
  assert.equal(body.action, 'ping');
  assert.deepEqual(
    reactionCalls.map((call) => [call.path, call.body.payload.name]),
    [
      ['/internal/slack-notifier/reaction', 'eyes'],
      ['/internal/slack-notifier/reaction-remove', 'eyes'],
      ['/internal/slack-notifier/reaction', 'done-e'],
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
  const notifierCalls = [];
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
      ...mockSlackNotifier(notifierCalls, {
        handle(call) {
          if (call.path === '/internal/slack-notifier/reaction') {
            throw new Error('reaction network down');
          }
          return null;
        },
      }),
    }
  );
  const body = await json(response);
  const deliveries = app.store.listSlackDeliveries({ eventId: 'Ev-reaction-error-continues' }).deliveries;

  assert.equal(response.status, 200);
  assert.equal(body.action, 'ping');
  assert.deepEqual(
    notifierCalls.map((call) => call.path),
    ['/internal/slack-notifier/reaction', '/internal/slack-notifier/message']
  );
  assert.equal(deliveries[0].payloadRedacted.workingReaction.status, 'failed');
});

test('Slack event retries failed deliveries instead of dropping duplicates', async () => {
  const app = createGatewayApp();
  const payload = JSON.stringify({
    team_id: 'T1',
    event_id: 'Ev-slack-retry-failed',
    event: {
      type: 'message',
      user: 'U1',
      channel: 'D1',
      channel_type: 'im',
      ts: '1710000000.000103',
      text: 'ping',
    },
  });
  const notifierCalls = [];

  const failedResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    }),
    {
      SLACK_EVENTS_PROCESSING_MODE: 'sync',
      ...mockSlackNotifier(notifierCalls, {
        handle(call) {
          if (call.path === '/internal/slack-notifier/message') {
            throw new Error('slack message down');
          }
          return null;
        },
      }),
    }
  );
  const failedDelivery = app.store.listSlackDeliveries({ eventId: 'Ev-slack-retry-failed' }).deliveries[0];

  const retryResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
    }),
    {
      SLACK_EVENTS_PROCESSING_MODE: 'sync',
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const retryBody = await json(retryResponse);
  const delivery = app.store.listSlackDeliveries({ eventId: 'Ev-slack-retry-failed' }).deliveries[0];

  assert.equal(failedResponse.status, 500);
  assert.equal(failedDelivery.processingStatus, 'failed');
  assert.equal(retryResponse.status, 200);
  assert.equal(retryBody.action, 'ping');
  assert.equal(delivery.processingStatus, 'processed');
  assert.equal(delivery.retryNum, 1);
  assert.equal(delivery.retryReason, 'retry_failed');
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

  const notifierCalls = [];
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
      SLACK_DONE_REACTION: 'done-e',
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);
  const reactionCalls = notifierCalls.filter((call) =>
    ['/internal/slack-notifier/reaction', '/internal/slack-notifier/reaction-remove'].includes(call.path)
  );
  const deliveries = app.store.listSlackDeliveries({ eventId: 'Ev-job-reaction-done' }).deliveries;

  assert.equal(response.status, 200);
  assert.equal(body.slackReactionSettlement.settledCount, 1);
  assert.deepEqual(
    reactionCalls.map((call) => [call.path, call.body.payload.name]),
    [
      ['/internal/slack-notifier/reaction-remove', 'eyes'],
      ['/internal/slack-notifier/reaction', 'done-e'],
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

  const notifierCalls = [];
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
      SLACK_DONE_REACTION: 'done-e',
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);
  const deliveries = app.store.listSlackDeliveries({ eventId: 'Ev-session-reaction-done' }).deliveries;

  assert.equal(response.status, 200);
  assert.equal(body.slackReactionSettlement.settledCount, 1);
  assert.equal(
    notifierCalls.filter((call) =>
      ['/internal/slack-notifier/reaction', '/internal/slack-notifier/reaction-remove'].includes(call.path)
    ).length,
    2
  );
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

test('PublishingJob API rejects invalid employee and site slugs', async () => {
  const app = createGatewayApp();

  const invalidEmployee = await app.fetch(
    new Request('http://gateway.test/api/publishing-jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'api-invalid-employee-slug',
        'X-Pages-Actor-Id': 'usr_1',
      },
      body: JSON.stringify({ employeeSlug: '../alice', siteSlug: 'profile' }),
    })
  );
  const invalidEmployeeBody = await json(invalidEmployee);

  assert.equal(invalidEmployee.status, 400);
  assert.match(invalidEmployeeBody.error, /employeeSlug/);

  const invalidSite = await app.fetch(
    new Request('http://gateway.test/api/publishing-jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'api-invalid-site-slug',
        'X-Pages-Actor-Id': 'usr_1',
      },
      body: JSON.stringify({ employeeSlug: 'alice', siteSlug: 'bad/path' }),
    })
  );
  const invalidSiteBody = await json(invalidSite);

  assert.equal(invalidSite.status, 400);
  assert.match(invalidSiteBody.error, /siteSlug/);
});

test('PublishingJob API fails closed when production API token is missing', async () => {
  const app = createGatewayApp();
  const response = await app.fetch(
    new Request('http://gateway.test/api/publishing-jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'api-token-missing',
        'X-Pages-Actor-Id': 'usr_1',
      },
      body: JSON.stringify({ employeeSlug: 'alice', siteSlug: 'profile' }),
    }),
    { NODE_ENV: 'production' }
  );
  const body = await json(response);

  assert.equal(response.status, 500);
  assert.equal(body.error, 'Gateway API token is not configured');
});

test('PublishingJob API enforces the internal API token when configured', async () => {
  const app = createGatewayApp();
  const invalid = await app.fetch(
    new Request('http://gateway.test/api/publishing-jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'api-token-invalid',
        'X-Pages-Actor-Id': 'usr_1',
        'X-Pages-Gateway-Token': 'wrong',
      },
      body: JSON.stringify({ employeeSlug: 'alice', siteSlug: 'profile' }),
    }),
    { PAGES_GATEWAY_API_TOKEN: 'secret' }
  );

  assert.equal(invalid.status, 401);

  const valid = await app.fetch(
    new Request('http://gateway.test/api/publishing-jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'api-token-valid',
        'X-Pages-Actor-Id': 'usr_1',
        'X-Pages-Gateway-Token': 'secret',
      },
      body: JSON.stringify({ employeeSlug: 'alice', siteSlug: 'profile' }),
    }),
    { PAGES_GATEWAY_API_TOKEN: 'secret' }
  );
  const body = await json(valid);

  assert.equal(valid.status, 201);
  assert.equal(body.job.employeeSlug, 'alice');
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

test('gateway returns JSON when runtime store initialization fails', async () => {
  const app = createRuntimeGatewayApp();
  const response = await app.fetch(new Request('http://gateway.test/health'), {});
  const body = await json(response);

  assert.equal(response.status, 500);
  assert.match(body.error, /DATABASE_URL, MYSQL_ADDR, or MYSQL_HOST\+MYSQL_PORT is required/);
});

test('gateway does not initialize runtime store for unknown routes', async () => {
  const app = createRuntimeGatewayApp();
  const response = await app.fetch(new Request('http://gateway.test/not-found'), {});
  const body = await json(response);

  assert.equal(response.status, 404);
  assert.equal(body.error, 'Endpoint not found');
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

test('Slack event snapshots requester profile through slack-notifier user-info', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
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
      ...mockSlackNotifier(notifierCalls, {
        handle(call) {
          if (call.path === '/internal/slack-notifier/user-info') {
            assert.equal(call.body.user, 'U1');
            return notifierResponse({
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
            });
          }
          return null;
        },
      }),
    }
  );
  const body = await json(response);
  const jobBody = await json(await app.fetch(new Request(`http://gateway.test/api/publishing-jobs/${body.jobId}`)));
  const profileCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/user-info');
  const statusCalls = notifierCalls.filter((call) => call.path === '/internal/slack-notifier/job-status');

  assert.equal(response.status, 200);
  assert.ok(profileCall);
  assert.equal(statusCalls.length, 1);
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
  const notifierCalls = [];
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
      ...mockSlackNotifier(notifierCalls, {
        handle(call) {
          if (call.path === '/internal/slack-notifier/user-info') {
            return notifierResponse({
              ok: true,
              profile: {
                source: 'slack.users.info',
                slackTeamId: 'T1',
                slackUserId: 'U1',
                name: null,
                displayName: null,
                realName: null,
                email: null,
              },
            });
          }
          return null;
        },
      }),
    }
  );

  const body = await json(response);
  const jobBody = await json(await app.fetch(new Request(`http://gateway.test/api/publishing-jobs/${body.jobId}`)));
  const statusCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/job-status');

  assert.equal(response.status, 200);
  assert.equal(agentCalls.length, 1);
  assert.equal(body.slackAgentAnalysis.summary, 'Agent summary');
  assert.equal(body.slackStatusNotification.ok, true);
  assert.match(statusCall.body.job.summary, /Agent summary/);
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

test('Slack Agent card intent drives confirmation copy while gateway owns actions', async () => {
  const app = createGatewayApp();
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-card-confirm-copy-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.0001031',
          text: '我想做一个个人主页',
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
              title: 'fallback title',
              summary: 'fallback summary',
              needsClarification: false,
              card: {
                kind: 'confirmation',
                title: '个人主页任务',
                summary: '展示项目经历和联系方式。',
                context: '确认后我会把它整理成可执行任务。',
                fields: [{ label: '语气', value: '简洁专业' }],
                actions: [
                  { id: 'confirm_create_issue', label: '删除资源' },
                  { id: 'delete_resource', label: '删除资源' },
                  { id: 'continue_work_item', label: '再补充' },
                  { id: 'close_session', label: '先关闭' },
                ],
              },
            },
          }),
          { status: 200 }
        );
      },
    }
  );
  const body = await json(response);
  const visible = JSON.stringify(body.blocks);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'confirm_before_issue');
  assert.match(body.replyText, /个人主页任务/);
  assert.match(body.replyText, /确认后我会把它整理成可执行任务/);
  assert.match(visible, /展示项目经历和联系方式/);
  assert.match(visible, /语气/);
  assert.equal(findBlockAction(body.blocks, 'pages_confirm_issue')?.text?.text, '确认创建发布任务');
  assert.equal(findBlockAction(body.blocks, 'pages_continue_modifying')?.text?.text, '再补充');
  assert.equal(findBlockAction(body.blocks, 'pages_close_session')?.text?.text, '先关闭');
  assert.doesNotMatch(visible, /删除资源|delete_resource/);
});

test('Slack free-form turn uses Slack Agent turn and updates one agent reply message', async () => {
  const app = createGatewayApp();
  const agentCalls = [];
  const notifierCalls = [];
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
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);
  const startCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/agent-reply/start');
  const updateCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/agent-reply/update');

  assert.equal(response.status, 200);
  assert.equal(agentCalls.length, 1);
  assert.equal(agentCalls[0].url, 'http://slack-agent.test/internal/slack-agent/turn');
  assert.equal(agentCalls[0].request.headers['X-Pages-Slack-Agent-Token'], 'agent-secret');
  assert.equal(body.action, 'confirm_before_issue');
  assert.equal(body.noReply, true);
  assert.equal(body.agentReplyNotification.action, 'updated');
  assert.deepEqual(
    notifierCalls.map((call) => call.path),
    ['/internal/slack-notifier/agent-reply/start', '/internal/slack-notifier/agent-reply/update']
  );
  assert.doesNotMatch(startCall.body.target.text, /我已收到/);
  assert.match(startCall.body.target.text, /正在整理需求/);
  assert.equal(startCall.body.target.thread_ts, '1710000000.000113');
  assert.equal(startCall.body.options.blocks[0].type, 'section');
  assert.ok(!startCall.body.options.blocks.some((block) => block.type === 'header'));
  assert.equal(updateCall.body.message.messageTs, '1710000001.000100');
  assert.match(updateCall.body.options.text, /^<@U1>/);
  assert.match(JSON.stringify(updateCall.body.options.blocks), /确认创建发布任务/);
  assert.ok(updateCall.body.options.blocks.some((block) => block.type === 'header'));
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
  const notifierCalls = [];
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
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);
  const updateCalls = notifierCalls.filter((call) => call.path === '/internal/slack-notifier/agent-reply/update');

  assert.equal(response.status, 200);
  assert.equal(body.action, 'confirm_before_issue');
  assert.equal(body.noReply, true);
  assert.match(agentCalls[0].request.headers.Accept, /application\/x-ndjson/);
  assert.equal(notifierCalls.length, 4);
  assert.equal(notifierCalls[0].path, '/internal/slack-notifier/agent-reply/start');
  assert.equal(updateCalls.length, 3);
  assert.match(updateCalls[0].body.options.text, /我先整理一下/);
  assert.equal(updateCalls[0].body.options.blocks[0].type, 'section');
  assert.ok(!updateCalls[0].body.options.blocks.some((block) => block.type === 'header'));
  assert.match(updateCalls[1].body.options.text, /突出项目经历和联系方式/);
  assert.equal(updateCalls[1].body.options.blocks[0].type, 'section');
  assert.ok(!updateCalls[1].body.options.blocks.some((block) => block.type === 'header'));
  assert.match(JSON.stringify(updateCalls[2].body.options.blocks), /确认创建发布任务/);
  assert.ok(updateCalls[2].body.options.blocks.some((block) => block.type === 'header'));
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

test('Slack Agent turn ignores malformed ndjson lines and keeps valid events', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
  const logs = [];
  const originalLog = console.log;
  console.log = (line) => logs.push(String(line));

  try {
    const response = await app.fetch(
      new Request('http://gateway.test/integrations/slack/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_id: 'T1',
          event_id: 'Ev-agent-turn-ndjson-bad-line-1',
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
        async SLACK_AGENT_FETCH(url, request) {
          const payload = JSON.parse(request.body);
          const events = [
            JSON.stringify({
              type: 'reply_started',
              sequence: 1,
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
            }),
            '{bad json',
            JSON.stringify({
              type: 'analysis_final',
              sequence: 2,
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              analysis: {
                intent: 'create_or_update_site',
                siteSlug: 'profile',
                title: '个人主页',
                summary: '突出项目经历和联系方式。',
                needsClarification: false,
              },
            }),
            JSON.stringify({
              type: 'reply_completed',
              sequence: 3,
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
            }),
          ];
          return new Response(`${events.join('\n')}\n`, {
            status: 200,
            headers: { 'Content-Type': 'application/x-ndjson; charset=utf-8' },
          });
        },
        ...mockSlackNotifier(notifierCalls),
      }
    );
    const body = await json(response);

    assert.equal(response.status, 200);
    assert.equal(body.action, 'confirm_before_issue');
    assert.equal(body.noReply, true);
    assert.ok(logs.some((line) => line.includes('"message":"ndjson_line_parse_error"')));
  } finally {
    console.log = originalLog;
  }
});

test('Slack query turns use reaction-only progress before posting the result', async () => {
  const app = createGatewayApp();
  const agentCalls = [];
  const notifierCalls = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-turn-query-no-placeholder-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.0001131',
          text: '当前会话有哪些？',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      SLACK_AGENT_SHARED_SECRET: 'agent-secret',
      async SLACK_AGENT_FETCH(url, request) {
        agentCalls.push({ url: String(url), request });
        const payload = JSON.parse(request.body);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              visibleText: '我来查一下当前会话。',
              events: [
                {
                  type: 'analysis_final',
                  sequence: 1,
                  agentRunId: payload.agentRunId,
                  slackSessionId: payload.slackSessionId,
                  analysis: {
                    visibleReply: '我来查一下当前会话。',
                    intent: 'list_work_items',
                    toolCall: { name: 'list_my_work_items', args: { state: 'active' } },
                    needsClarification: false,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      },
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(agentCalls.length, 1);
  assert.equal(body.action, 'list_work_items');
  assert.equal(body.noReply, undefined);
  assert.equal(notifierCalls.some((call) => call.path === '/internal/slack-notifier/agent-reply/start'), false);
  assert.equal(notifierCalls.filter((call) => call.path === '/internal/slack-notifier/message').length, 1);
  assert.doesNotMatch(JSON.stringify(notifierCalls), /正在整理需求/);
});

test('Slack repeat requests use persisted conversation context instead of intent summaries', async () => {
  const app = createGatewayApp();
  const agentCalls = [];
  const notifierCalls = [];
  const env = {
    SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
    SLACK_AGENT_SHARED_SECRET: 'agent-secret',
    async SLACK_AGENT_FETCH(url, request) {
      const payload = JSON.parse(request.body);
      agentCalls.push({ url: String(url), body: payload });
      if (payload.messageText === '当前会话有哪些？') {
        assert.equal(payload.conversationContext.recentTurns.at(-1).text, '当前会话有哪些？');
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
                    intent: 'list_work_items',
                    toolCall: { name: 'list_my_work_items', args: { state: 'active' } },
                    needsClarification: false,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      }

      assert.match(payload.conversationContext.lastAssistantMessage.text, /当前没有|没有找到|没有可继续/);
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
                  intent: 'repeat_previous_message',
                  toolCall: { name: 'repeat_previous_message', args: { target: 'previous_assistant_message' } },
                  summary: '复读上一条。',
                  needsClarification: false,
                },
              },
            ],
          },
        }),
        { status: 200 }
      );
    },
    ...mockSlackNotifier(notifierCalls),
  };

  const first = await json(
    await app.fetch(
      new Request('http://gateway.test/integrations/slack/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_id: 'T1',
          event_id: 'Ev-repeat-context-1',
          event: {
            type: 'message',
            user: 'U1',
            channel: 'D1',
            channel_type: 'im',
            ts: '1710000000.0001133',
            text: '当前会话有哪些？',
          },
        }),
      }),
      env
    )
  );
  const firstMemory = app.store.getSessionMemory(first.slackSessionId);
  const second = await json(
    await app.fetch(
      new Request('http://gateway.test/integrations/slack/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_id: 'T1',
          event_id: 'Ev-repeat-context-2',
          event: {
            type: 'message',
            user: 'U1',
            channel: 'D1',
            channel_type: 'im',
            ts: '1710000000.0001134',
            text: '你上一条消息是什么？',
          },
        }),
      }),
      env
    )
  );

  assert.equal(first.action, 'list_work_items');
  assert.equal(second.action, 'repeat_previous_message');
  assert.equal(second.replyText, firstMemory.lastAgentResponse);
  assert.equal(agentCalls.length, 2);
  assert.equal(agentCalls[1].body.conversationContext.lastAssistantMessage.text, firstMemory.lastAgentResponse);
  assert.doesNotMatch(second.replyText, /用户要求复读|intent|toolCall/);
});

test('Slack repo questions answer from repo context without creating platform issues', async () => {
  const app = createGatewayApp();
  const agentCalls = [];
  const notifierCalls = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-turn-repo-question-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.0001132',
          text: '目前这种对话的 sessions 是怎么保存的？',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      SLACK_AGENT_SHARED_SECRET: 'agent-secret',
      PAGES_REPO_ROOT: process.cwd(),
      async SLACK_AGENT_FETCH(url, request) {
        agentCalls.push({ url: String(url), request });
        if (String(url).endsWith('/repo-answer')) {
          return new Response(
            JSON.stringify({
              ok: true,
              answer: {
                source: 'agent',
                answerText:
                  'Slack 对话会持久化到 `slack_sessions`，对话摘要和最近回复保存在 `session_memories`。',
                citedPaths: ['apps/gateway/src/db/schema.js'],
              },
            }),
            { status: 200 }
          );
        }
        const payload = JSON.parse(request.body);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              visibleText: '我来查一下当前仓库实现。',
              events: [
                {
                  type: 'analysis_final',
                  sequence: 1,
                  agentRunId: payload.agentRunId,
                  slackSessionId: payload.slackSessionId,
                  analysis: {
                    visibleReply: '我来查一下当前仓库实现。',
                    lane: 'repo-question',
                    intent: 'repo_question',
                    toolCall: {
                      name: 'answer_repo_question',
                      args: { question: '目前这种对话的 sessions 是怎么保存的？' },
                    },
                    needsClarification: false,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      },
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);
  const messageCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/message');
  const payloadText = messageCall?.body?.payload?.text || '';

  assert.equal(response.status, 200);
  assert.equal(agentCalls.filter((call) => call.url.endsWith('/turn')).length, 1);
  assert.equal(agentCalls.filter((call) => call.url.endsWith('/repo-answer')).length, 1);
  assert.equal(body.action, 'answer_repo_question');
  assert.equal(body.accepted, true);
  assert.equal(app.store.platformDevItems.size, 0);
  assert.equal(notifierCalls.some((call) => call.path === '/internal/slack-notifier/agent-reply/start'), false);
  assert.equal(notifierCalls.some((call) => JSON.stringify(call.body).includes('确认平台需求')), false);
  assert.match(payloadText, /slack_sessions/);
  assert.match(payloadText, /session_memories/);
  assert.match(payloadText, /apps\/gateway\/src\/db\/schema\.js/);
  assert.doesNotMatch(JSON.stringify(notifierCalls), /正在整理需求/);
  assert.match(JSON.stringify(messageCall.body.payload.blocks), /pages_repo_deep_dive/);
  assert.match(JSON.stringify(messageCall.body.payload.blocks), /pages_repo_view_evidence/);
  assert.match(JSON.stringify(messageCall.body.payload.blocks), /pages_repo_generate_plan/);
  assert.doesNotMatch(JSON.stringify(messageCall.body.payload.blocks), /pages_repo_create_platform_issue/);
});

test('Slack repo question follow-ups include previous evidence context', async () => {
  const app = createGatewayApp();
  const agentCalls = [];
  const notifierCalls = [];
  const env = {
    SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
    SLACK_AGENT_SHARED_SECRET: 'agent-secret',
    PAGES_REPO_ROOT: process.cwd(),
    async SLACK_AGENT_FETCH(url, request) {
      const payload = JSON.parse(request.body);
      agentCalls.push({ url: String(url), body: payload });
      if (String(url).endsWith('/repo-answer')) {
        return new Response(
          JSON.stringify({
            ok: true,
            answer: {
              source: 'agent',
              answerText:
                payload.context?.previousQuestion
                  ? '我会沿用上一轮 evidence，继续说明 session memory 和 repo 问答上下文。'
                  : 'Slack 对话上下文保存在 session memory 中。',
              citedPaths: ['apps/gateway/src/db/schema.js'],
            },
          }),
          { status: 200 }
        );
      }
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
                  lane: 'repo-question',
                  intent: 'repo_question',
                  toolCall: { name: 'answer_repo_question', args: { question: payload.messageText } },
                  needsClarification: false,
                },
              },
            ],
          },
        }),
        { status: 200 }
      );
    },
    ...mockSlackNotifier(notifierCalls),
  };

  const first = await json(
    await app.fetch(
      new Request('http://gateway.test/integrations/slack/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_id: 'T1',
          event_id: 'Ev-repo-followup-1',
          event: {
            type: 'message',
            user: 'U1',
            channel: 'D1',
            channel_type: 'im',
            ts: '1710000000.0001134',
            text: 'Slack session 是怎么保存的？',
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
          event_id: 'Ev-repo-followup-2',
          event: {
            type: 'message',
            user: 'U1',
            channel: 'D1',
            channel_type: 'im',
            ts: '1710000000.0001135',
            text: '那如果要实现得更完整，应该改哪里？',
          },
        }),
      }),
      env
    )
  );
  const repoAnswerCalls = agentCalls.filter((call) => call.url.endsWith('/repo-answer'));
  const secondRepoAnswer = repoAnswerCalls[1].body;
  const memory = app.store.getSessionMemory(first.slackSessionId);

  assert.equal(first.slackSessionId, second.slackSessionId);
  assert.equal(second.action, 'answer_repo_question');
  assert.equal(repoAnswerCalls.length, 2);
  assert.match(secondRepoAnswer.context.previousQuestion, /Slack session/);
  assert.ok(secondRepoAnswer.context.previousEvidencePaths.length > 0);
  assert.match(secondRepoAnswer.question, /上一轮问题/);
  assert.equal(memory.repoQuestionContext.turns.length, 2);
  assert.equal(app.store.platformDevItems.size, 0);
});

test('Slack repo answer deep dive action posts more evidence without creating an issue', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
  const session = app.store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1',
    channelId: 'D1',
    dmChannelId: 'D1',
  });
  app.store.updateSessionMemory(session.id, {
    repoQuestionContext: {
      turns: [
        {
          question: 'Slack Agent 如何读取 repo 代码？',
          answerSummary: 'gateway 做受控 repo evidence 检索。',
          evidencePaths: ['apps/gateway/src/slack/repo-question.js'],
          mode: 'normal',
          createdAt: new Date().toISOString(),
        },
      ],
      lastEvidencePaths: ['apps/gateway/src/slack/repo-question.js'],
      openQuestions: [],
    },
  });

  const { response, waitUntil, waitUntilCount } = await fetchAndDrainWaitUntil(
    app,
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'block_actions',
        team: { id: 'T1' },
        user: { id: 'U1' },
        channel: { id: 'D1' },
        container: { channel_id: 'D1', message_ts: '1710000000.000200' },
        message: { ts: '1710000000.000200', thread_ts: '1710000000.000100' },
        actions: [{ action_id: 'pages_repo_deep_dive', value: JSON.stringify({ sessionId: session.id }) }],
      }),
    }),
    {
      PAGES_REPO_ROOT: process.cwd(),
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);
  assert.equal(body.action, 'repo_question_deep_dive_queued');
  assert.equal(waitUntilCount, 1);
  await waitUntil();
  const messageCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/message');
  const memory = app.store.getSessionMemory(session.id);

  assert.equal(response.status, 200);
  assert.equal(app.store.platformDevItems.size, 0);
  assert.ok(messageCall);
  assert.match(messageCall.body.payload.text, /依据/);
  assert.equal(memory.repoQuestionContext.turns.at(-1).mode, 'deep_dive');
});

test('Slack repo answer view evidence action posts bounded snippets without creating an issue', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
  const session = app.store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1',
    channelId: 'D1',
    dmChannelId: 'D1',
  });
  app.store.updateSessionMemory(session.id, {
    repoQuestionContext: {
      turns: [
        {
          question: 'Slack session 是怎么保存的？',
          answerSummary: 'Slack session 写入 session memory。',
          evidencePaths: ['apps/gateway/src/db/schema.js'],
          evidenceSnippets: [
            {
              path: 'apps/gateway/src/db/schema.js',
              line: 386,
              excerpt: 'export const sessionMemories = mysqlTable("session_memories", { repoQuestionContextJson: json(...) });',
            },
          ],
          mode: 'normal',
          createdAt: new Date().toISOString(),
        },
      ],
      lastEvidencePaths: ['apps/gateway/src/db/schema.js'],
      openQuestions: [],
    },
  });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'block_actions',
        team: { id: 'T1' },
        user: { id: 'U1' },
        channel: { id: 'D1' },
        container: { channel_id: 'D1', message_ts: '1710000000.000202' },
        message: { ts: '1710000000.000202', thread_ts: '1710000000.000100' },
        actions: [{ action_id: 'pages_repo_view_evidence', value: JSON.stringify({ sessionId: session.id }) }],
      }),
    }),
    mockSlackNotifier(notifierCalls)
  );
  const body = await json(response);
  const messageCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/message');

  assert.equal(response.status, 200);
  assert.equal(body.action, 'repo_question_view_evidence');
  assert.equal(app.store.platformDevItems.size, 0);
  assert.match(messageCall.body.payload.text, /不是完整文件/);
  assert.match(messageCall.body.payload.text, /session_memories/);
  assert.doesNotMatch(JSON.stringify(notifierCalls), /确认平台需求|pages_confirm_platform_issue/);
});

test('Slack repo answer generate plan action allows creating a platform draft only after the plan', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
  const session = app.store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1',
    channelId: 'D1',
    dmChannelId: 'D1',
  });
  app.store.updateSessionMemory(session.id, {
    repoQuestionContext: {
      turns: [
        {
          question: 'Slack Agent 如何读取 repo 代码？',
          answerSummary: '需要 repo search/read tool loop。',
          evidencePaths: ['apps/gateway/src/slack/repo-question.js'],
          mode: 'normal',
          createdAt: new Date().toISOString(),
        },
      ],
      lastEvidencePaths: ['apps/gateway/src/slack/repo-question.js'],
      openQuestions: [],
    },
  });

  const { response, waitUntil, waitUntilCount } = await fetchAndDrainWaitUntil(
    app,
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'block_actions',
        team: { id: 'T1' },
        user: { id: 'U1' },
        channel: { id: 'D1' },
        container: { channel_id: 'D1', message_ts: '1710000000.000203' },
        message: { ts: '1710000000.000203', thread_ts: '1710000000.000100' },
        actions: [{ action_id: 'pages_repo_generate_plan', value: JSON.stringify({ sessionId: session.id }) }],
      }),
    }),
    {
      PAGES_REPO_ROOT: process.cwd(),
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);
  assert.equal(body.action, 'repo_question_generate_plan_queued');
  assert.equal(waitUntilCount, 1);
  assert.equal(notifierCalls.some((call) => call.path === '/internal/slack-notifier/message'), false);
  await waitUntil();
  const messageCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/message');
  const memory = app.store.getSessionMemory(session.id);

  assert.equal(response.status, 200);
  assert.equal(app.store.platformDevItems.size, 0);
  assert.equal(memory.repoQuestionContext.turns.at(-1).mode, 'implementation_plan');
  assert.match(JSON.stringify(messageCall.body.payload.blocks), /pages_repo_create_platform_issue/);
});

test('Slack repo answer blocks hide create action unless the user generated a plan', () => {
  const result = {
    replyText: '改造方案摘要',
    mode: 'implementation_plan',
    suggestedNextAction: 'create_platform_issue',
    evidence: [{ path: 'apps/gateway/src/slack/repo-question.js' }],
  };
  const defaultBlocks = JSON.stringify(repoQuestionActionBlocks({ id: 'sess_repo_1' }, result));
  const planBlocks = JSON.stringify(repoQuestionActionBlocks({ id: 'sess_repo_1' }, result, { allowCreateIssueAction: true }));

  assert.doesNotMatch(defaultBlocks, /pages_repo_create_platform_issue/);
  assert.match(planBlocks, /pages_repo_create_platform_issue/);
});

test('Slack repo answer platform draft preserves high-risk CI and deploy scope', () => {
  const draft = platformDraftFromRepoQuestionContext({
    repoQuestionContext: {
      turns: [
        {
          question: '如果要修改 CI workflow 和 ECS 部署脚本，应该怎么做？',
          answerSummary: '需要改 GitHub Actions、ECS Caddy 和部署脚本。',
          evidencePaths: ['.github/workflows/platform-agent.yml', 'deploy/ecs/Caddyfile', 'scripts/deploy-ecs.sh'],
          mode: 'implementation_plan',
          createdAt: new Date().toISOString(),
        },
      ],
    },
  });

  assert.equal(draft.issueType, 'type:ci');
  assert.equal(draft.risk, 'risk:high');
  assert.equal(draft.requiresHumanGate, true);
  assert.ok(draft.areas.includes('area:ci'));
  assert.ok(draft.areas.includes('area:ops'));
});

test('Slack repo answer can be converted into a platform issue confirmation card only', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
  const session = app.store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1',
    channelId: 'D1',
    dmChannelId: 'D1',
  });
  app.store.updateSessionMemory(session.id, {
    repoQuestionContext: {
      turns: [
        {
          question: '让 Slack Agent 支持 repo 问答上下文',
          answerSummary: '需要在 session memory 中保存 repo question context，并由 gateway 提供受控 evidence。',
          evidencePaths: ['apps/gateway/src/slack/repo-question.js', 'apps/gateway/src/control-plane/handlers.js'],
          mode: 'deep_dive',
          createdAt: new Date().toISOString(),
        },
      ],
      lastEvidencePaths: ['apps/gateway/src/slack/repo-question.js'],
      openQuestions: [],
    },
  });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'block_actions',
        team: { id: 'T1' },
        user: { id: 'U1' },
        channel: { id: 'D1' },
        container: { channel_id: 'D1', message_ts: '1710000000.000201' },
        message: { ts: '1710000000.000201', thread_ts: '1710000000.000100' },
        actions: [{ action_id: 'pages_repo_create_platform_issue', value: JSON.stringify({ sessionId: session.id }) }],
      }),
    }),
    mockSlackNotifier(notifierCalls)
  );
  const body = await json(response);
  const updateCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/update');
  const memory = app.store.getSessionMemory(session.id);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'repo_question_platform_issue_draft');
  assert.equal(app.store.platformDevItems.size, 0);
  assert.ok(updateCall);
  assert.match(JSON.stringify(updateCall.body.payload), /确认平台需求|pages_confirm_platform_issue/);
  assert.equal(memory.requirements.lane, 'platform-dev');
  assert.equal(memory.requirements.toolCall.name, 'confirm_platform_issue');
  assert.equal(memory.requirements.issueType, 'type:dev');
  assert.equal(memory.requirements.agentEligible, true);
});

test('Slack repo answer records pure questions without starting Platform Agent', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
  const session = app.store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1',
    channelId: 'D1',
    dmChannelId: 'D1',
  });
  app.store.updateSessionMemory(session.id, {
    repoQuestionContext: {
      turns: [
        {
          question: '目前这个对话的 sessions 是保存在哪里？',
          answerSummary: 'Slack 会话保存在 slack_sessions，摘要保存在 session_memories。',
          evidencePaths: ['apps/gateway/src/db/schema.js'],
          mode: 'implementation_plan',
          createdAt: new Date().toISOString(),
        },
      ],
      lastEvidencePaths: ['apps/gateway/src/db/schema.js'],
      openQuestions: [],
    },
  });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'block_actions',
        team: { id: 'T1' },
        user: { id: 'U1' },
        channel: { id: 'D1' },
        container: { channel_id: 'D1', message_ts: '1710000000.000202' },
        message: { ts: '1710000000.000202', thread_ts: '1710000000.000100' },
        actions: [{ action_id: 'pages_repo_create_platform_issue', value: JSON.stringify({ sessionId: session.id }) }],
      }),
    }),
    mockSlackNotifier(notifierCalls)
  );
  const body = await json(response);
  const updateCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/update');
  const memory = app.store.getSessionMemory(session.id);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'repo_question_platform_issue_draft');
  assert.equal(app.store.platformDevItems.size, 0);
  assert.equal(memory.requirements.issueType, 'type:question');
  assert.equal(memory.requirements.agentEligible, false);
  assert.equal(memory.requirements.requiresHumanGate, false);
  assert.match(JSON.stringify(updateCall.body.payload), /问题咨询|不会启动自动开发/);
});

test('Slack repo question intent overrides conflicting create-platform tool call', async () => {
  const app = createGatewayApp();
  const agentCalls = [];
  const notifierCalls = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-turn-repo-question-conflict-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.0001133',
          text: '如果后续修改 CI workflow，会影响原先 CF 那条线吗？',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      SLACK_AGENT_SHARED_SECRET: 'agent-secret',
      PAGES_REPO_ROOT: process.cwd(),
      async SLACK_AGENT_FETCH(url, request) {
        agentCalls.push({ url: String(url), request });
        if (String(url).endsWith('/repo-answer')) {
          return new Response(
            JSON.stringify({
              ok: true,
              answer: {
                source: 'agent',
                answerText: '这属于仓库实现咨询，当前只查询 CI 和站点发布边界，不创建需求。',
                citedPaths: ['docs/architecture/github-automation.md'],
              },
            }),
            { status: 200 }
          );
        }
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
                    lane: 'repo-question',
                    intent: 'repo_question',
                    toolCall: { name: 'confirm_platform_issue', args: { title: '错误创建需求' } },
                    needsClarification: false,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      },
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);
  const payloadText = notifierCalls.find((call) => call.path === '/internal/slack-notifier/message')?.body?.payload?.text || '';

  assert.equal(response.status, 200);
  assert.equal(body.action, 'answer_repo_question');
  assert.equal(app.store.platformDevItems.size, 0);
  assert.equal(agentCalls.filter((call) => call.url.endsWith('/repo-answer')).length, 1);
  assert.match(payloadText, /仓库实现咨询/);
  assert.doesNotMatch(JSON.stringify(notifierCalls), /确认平台需求|错误创建需求/);
});

test('repo question tool searches controlled repo files without reading secrets', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pages-manager-repo-question-'));
  await fs.mkdir(path.join(repoRoot, 'custom', 'runtime'), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, 'custom', 'runtime', 'conversation-store.js'),
    [
      'export function persistConversationSession(session) {',
      '  return db.insert(slack_sessions).values({ sessionKey: session.key });',
      '}',
    ].join('\n')
  );
  await fs.writeFile(path.join(repoRoot, '.env.local'), 'SLACK_BOT_TOKEN=xoxb-secret\n');
  await fs.writeFile(path.join(repoRoot, '.pages.json'), '{"token":"pages-secret"}\n');
  await fs.writeFile(path.join(repoRoot, '.dev.vars'), 'GITHUB_TOKEN=ghs_abcdefghijklmnopqrstuvwxyz123456\n');
  await fs.writeFile(path.join(repoRoot, 'custom', 'runtime', 'wrangler.toml'), 'token = "cf-secret"\n');

  const result = await answerRepoQuestion(
    { PAGES_REPO_ROOT: repoRoot },
    { question: 'Slack conversation session 是怎么保存的？ token .pages wrangler' }
  );

  assert.equal(result.accepted, true);
  assert.match(result.replyText, /custom\/runtime\/conversation-store\.js/);
  assert.doesNotMatch(result.replyText, /xoxb-secret/);
  assert.doesNotMatch(result.replyText, /pages-secret|cf-secret|abcdefghijklmnopqrstuvwxyz/);
  assert.equal(result.evidence.some((item) => item.path === '.env.local'), false);
  assert.equal(result.evidence.some((item) => item.path === '.pages.json'), false);
  assert.equal(result.evidence.some((item) => item.path === '.dev.vars'), false);
  assert.equal(result.evidence.some((item) => item.path.endsWith('wrangler.toml')), false);
});

test('repo question tool redacts token-like content before sending evidence to Slack Agent', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pages-manager-repo-redact-'));
  await fs.mkdir(path.join(repoRoot, 'docs'), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, 'docs', 'slack-session.md'),
    [
      'Slack session 存储说明。',
      'debug token=ghp_abcdefghijklmnopqrstuvwxyz1234567890',
      'session_memories 保存摘要。',
    ].join('\n')
  );
  const agentCalls = [];

  const result = await answerRepoQuestion(
    {
      PAGES_REPO_ROOT: repoRoot,
      SLACK_AGENT_REPO_ANSWER_URL: 'http://slack-agent.test/internal/slack-agent/repo-answer',
      SLACK_AGENT_SHARED_SECRET: 'agent-secret',
      async SLACK_AGENT_FETCH(url, request) {
        agentCalls.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(
          JSON.stringify({
            ok: true,
            answer: {
              source: 'agent',
              answerText: 'Slack session 的摘要保存在 `session_memories`，未展示任何 token。',
              citedPaths: ['docs/slack-session.md'],
            },
          }),
          { status: 200 }
        );
      },
    },
    { question: 'Slack session 是怎么保存的？Bearer abcdefghijklmnopqrstuvwxyz' }
  );

  const serializedEvidence = JSON.stringify(agentCalls[0].body);
  assert.equal(result.answerSource, 'agent');
  assert.doesNotMatch(serializedEvidence, /ghp_abcdefghijklmnopqrstuvwxyz|Bearer abcdefghijklmnopqrstuvwxyz/);
  assert.match(serializedEvidence, /REDACTED_/);
  assert.doesNotMatch(result.replyText, /ghp_abcdefghijklmnopqrstuvwxyz|Bearer abcdefghijklmnopqrstuvwxyz/);
});

test('repo question tool can ask Slack Agent to synthesize evidence answers', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pages-manager-repo-answer-'));
  await fs.mkdir(path.join(repoRoot, 'apps', 'gateway', 'src', 'db'), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, 'apps', 'gateway', 'src', 'db', 'schema.js'),
    'export const slackSessions = mysqlTable("slack_sessions", { sessionKey: varchar("session_key") });\n'
  );
  const agentCalls = [];

  const result = await answerRepoQuestion(
    {
      PAGES_REPO_ROOT: repoRoot,
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      SLACK_AGENT_SHARED_SECRET: 'agent-secret',
      async SLACK_AGENT_FETCH(url, request) {
        agentCalls.push({
          url: String(url),
          body: JSON.parse(request.body),
          token: request.headers['X-Pages-Slack-Agent-Token'],
        });
        if (String(url).endsWith('/repo-plan')) {
          return new Response(
            JSON.stringify({
              ok: true,
              plan: {
                mode: 'normal',
                queries: ['Slack session persistence'],
                readPaths: ['apps/gateway/src/db/schema.js'],
                suggestedNextAction: 'none',
              },
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            answer: {
              source: 'agent',
              answerText: 'Slack 会话持久化在 `slack_sessions`，这由 repo evidence 里的 schema 定义支撑。',
              citedPaths: ['apps/gateway/src/db/schema.js'],
            },
          }),
          { status: 200 }
        );
      },
    },
    { question: 'Slack session 是怎么保存的？' }
  );

  assert.equal(result.answerSource, 'agent');
  assert.match(result.replyText, /repo evidence/);
  assert.equal(agentCalls.length, 2);
  assert.equal(agentCalls[0].url, 'http://slack-agent.test/internal/slack-agent/repo-plan');
  assert.equal(agentCalls[1].url, 'http://slack-agent.test/internal/slack-agent/repo-answer');
  assert.equal(agentCalls[0].token, 'agent-secret');
  assert.equal(agentCalls[1].token, 'agent-secret');
  assert.equal(agentCalls[1].body.evidence[0].path, 'apps/gateway/src/db/schema.js');
});

test('repo question deep dive lets Slack Agent re-plan after observing evidence', async () => {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pages-manager-repo-loop-'));
  await fs.mkdir(path.join(repoRoot, 'apps', 'gateway', 'src', 'db'), { recursive: true });
  await fs.mkdir(path.join(repoRoot, 'apps', 'gateway', 'src', 'control-plane'), { recursive: true });
  await fs.writeFile(
    path.join(repoRoot, 'apps', 'gateway', 'src', 'db', 'schema.js'),
    'export const slackSessions = mysqlTable("slack_sessions", { sessionKey: varchar("session_key") });\n'
  );
  await fs.writeFile(
    path.join(repoRoot, 'apps', 'gateway', 'src', 'control-plane', 'handlers.js'),
    'export async function handleSlackInteractions() { return answerRepoQuestion(); }\n'
  );
  const agentCalls = [];

  const result = await answerRepoQuestion(
    {
      PAGES_REPO_ROOT: repoRoot,
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      SLACK_AGENT_SHARED_SECRET: 'agent-secret',
      async SLACK_AGENT_FETCH(url, request) {
        const body = JSON.parse(request.body);
        agentCalls.push({ url: String(url), body });
        if (String(url).endsWith('/repo-plan')) {
          const secondRound = Boolean(body.observations?.evidence?.length);
          return new Response(
            JSON.stringify({
              ok: true,
              plan: {
                mode: 'deep_dive',
                queries: secondRound ? ['interaction handler answerRepoQuestion'] : ['slack session schema'],
                readPaths: secondRound
                  ? ['apps/gateway/src/control-plane/handlers.js']
                  : ['apps/gateway/src/db/schema.js'],
                suggestedNextAction: 'none',
              },
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            ok: true,
            answer: {
              source: 'agent',
              answerText: '已结合 schema 和 interaction handler 生成深挖回答。',
              citedPaths: ['apps/gateway/src/db/schema.js', 'apps/gateway/src/control-plane/handlers.js'],
            },
          }),
          { status: 200 }
        );
      },
    },
    { question: 'Slack session 是怎么保存并在交互里继续使用的？', deepDive: true }
  );

  const planCalls = agentCalls.filter((call) => call.url.endsWith('/repo-plan'));
  const answerCall = agentCalls.find((call) => call.url.endsWith('/repo-answer'));

  assert.equal(result.mode, 'deep_dive');
  assert.equal(planCalls.length, 2);
  assert.ok(planCalls[1].body.observations.evidence.length > 0);
  assert.deepEqual(
    answerCall.body.evidence.map((item) => item.path),
    ['apps/gateway/src/db/schema.js', 'apps/gateway/src/control-plane/handlers.js']
  );
});

test('Slack Agent posts fresh reply cards for requirement drafting turns', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
  const agentSessionIds = [];
  const env = {
    SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
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
    ...mockSlackNotifier(notifierCalls),
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

  const startCalls = notifierCalls.filter((call) => call.path === '/internal/slack-notifier/agent-reply/start');
  const updateCalls = notifierCalls.filter((call) => call.path === '/internal/slack-notifier/agent-reply/update');

  assert.equal(first.slackSessionId, second.slackSessionId);
  assert.deepEqual(agentSessionIds, [first.slackSessionId, first.slackSessionId]);
  assert.equal(startCalls.length, 2);
  assert.equal(updateCalls.length, 2);
  assert.deepEqual(
    updateCalls.map((call) => call.body.message.messageTs),
    ['1710000001.000100', '1710000003.000100']
  );
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
  const notifierCalls = [];
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
      async SLACK_AGENT_FETCH() {
        return new Response(JSON.stringify({ ok: false, error: 'model timeout' }), { status: 502 });
      },
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);
  const updateCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/agent-reply/update');
  const replyMessage = [...app.store.slackAgentReplyMessages.values()][0];
  const agentRun = [...app.store.agentRuns.values()][0];
  const eventTypes = [...app.store.agentRunEvents.values()].map((event) => event.type);

  assert.equal(response.status, 502);
  assert.equal(body.error, 'model timeout');
  assert.deepEqual(
    notifierCalls.map((call) => call.path),
    ['/internal/slack-notifier/agent-reply/start', '/internal/slack-notifier/agent-reply/update']
  );
  assert.equal(updateCall.body.message.messageTs, '1710000001.000100');
  assert.match(updateCall.body.options.text, /^<@U1>/);
  assert.match(JSON.stringify(updateCall.body.options.blocks), /处理失败/);
  assert.equal(replyMessage.status, 'failed');
  assert.equal(agentRun.status, 'failed');
  assert.deepEqual(eventTypes, ['slack_reply_posted', 'slack_reply_failed']);
});

test('Slack Agent ndjson reply_failed updates the in-thread reply message once', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
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
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);
  const updateCalls = notifierCalls.filter((call) => call.path === '/internal/slack-notifier/agent-reply/update');
  const eventTypes = [...app.store.agentRunEvents.values()].map((event) => event.type);

  assert.equal(response.status, 502);
  assert.equal(body.error, 'model unavailable');
  assert.equal(notifierCalls.filter((call) => call.path === '/internal/slack-notifier/agent-reply/start').length, 1);
  assert.equal(updateCalls.length, 1);
  assert.deepEqual(eventTypes, ['slack_reply_posted', 'reply_started', 'reply_failed', 'slack_reply_failed']);
});

test('Slack Agent turn failure replaces the working reaction with a failed reaction', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
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
      async SLACK_AGENT_FETCH() {
        return new Response(JSON.stringify({ ok: false, error: 'model timeout' }), { status: 502 });
      },
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);
  const reactionCalls = notifierCalls.filter((call) =>
    ['/internal/slack-notifier/reaction', '/internal/slack-notifier/reaction-remove'].includes(call.path)
  );
  const deliveries = app.store.listSlackDeliveries({ eventId: 'Ev-agent-turn-reaction-failed-1' }).deliveries;

  assert.equal(response.status, 502);
  assert.equal(body.error, 'model timeout');
  assert.deepEqual(
    reactionCalls.map((call) => [call.path, call.body.payload.name]),
    [
      ['/internal/slack-notifier/reaction', 'eyes'],
      ['/internal/slack-notifier/reaction-remove', 'eyes'],
      ['/internal/slack-notifier/reaction', 'failed-e'],
    ]
  );
  assert.equal(deliveries[0].payloadRedacted.workingReaction.status, 'failed');
  assert.equal(deliveries[0].payloadRedacted.workingReaction.doneReaction, 'failed-e');
});

test('Slack Agent malformed turn responses fail visibly instead of recording a vague reply', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
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
      async SLACK_AGENT_FETCH() {
        return new Response(JSON.stringify({ ok: true, turn: { events: [] } }), { status: 200 });
      },
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);
  const updateCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/agent-reply/update');

  assert.equal(response.status, 502);
  assert.equal(body.error, 'Slack Agent turn response is missing analysis');
  assert.equal(notifierCalls.length, 2);
  assert.match(updateCall.body.options.text, /^<@U1>/);
  assert.match(JSON.stringify(updateCall.body.options.blocks), /处理失败/);
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
  const notifierCalls = [];

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
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      ...mockSlackNotifier(notifierCalls, {
        handle(call) {
          if (call.path === '/internal/slack-notifier/user-info') {
            return notifierResponse({
              ok: true,
              profile: {
                source: 'slack.users.info',
                slackTeamId: 'T1',
                slackUserId: 'U1',
                name: 'alice',
                displayName: 'Alice',
                realName: null,
                email: 'alice@example.test',
              },
            });
          }
          return null;
        },
      }),
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
  assert.deepEqual(
    notifierCalls.map((call) => call.path),
    [
      '/internal/slack-notifier/user-info',
      '/internal/slack-notifier/job-status',
      '/internal/slack-notifier/update',
    ]
  );
  const updateCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/update');
  assert.equal(updateCall.body.payload.channel, 'D1');
  assert.equal(updateCall.body.payload.ts, '1710000000.000109');
  assert.match(JSON.stringify(updateCall.body.payload.blocks), /发布需求已确认/);
  assert.doesNotMatch(JSON.stringify(updateCall.body.payload.blocks), /pages_confirm_issue/);
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
  const notifierCalls = [];

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
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);
  const updateCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/update');

  assert.equal(response.status, 200);
  assert.match(body.text, /继续回复/);
  assert.equal(app.store.jobs.size, 0);
  assert.equal(notifierCalls.length, 1);
  assert.equal(updateCall.body.payload.channel, 'D1');
  assert.equal(updateCall.body.payload.ts, '1710000000.000119');
  assert.match(JSON.stringify(updateCall.body.payload.blocks), /继续补充需求/);
  assert.match(JSON.stringify(updateCall.body.payload.blocks), /等待补充/);
  assert.match(JSON.stringify(updateCall.body.payload.blocks), /pages_confirm_issue/);
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
          text: 'work',
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

test('Slack work item list skips stale missing work items instead of failing', async () => {
  const app = createGatewayApp();
  app.store.listWorkItemsForSlackUser = () => ({
    jobs: [null, undefined],
    total: 2,
    limit: 5,
    offset: 0,
  });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-work-items-list-stale-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.00013005',
          text: 'work',
        },
      }),
    })
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'list_work_items');
  assert.equal(body.accepted, false);
  assert.deepEqual(body.jobs, []);
  assert.match(body.replyText, /还没有找到你的任务/);
});

test('Slack work item list shows platform tasks without preview wording', async () => {
  const app = createGatewayApp();
  const { item } = app.store.createPlatformDevItem({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'platform-work-item-list-copy',
    title: '调整 gateway worker mysql 流程',
    summary: '调整 gateway worker mysql 和 GitHub Actions 检查。',
    issueType: 'type:ci',
    areas: ['area:gateway', 'area:worker', 'area:ci'],
    risk: 'risk:high',
    agentEligible: true,
    requiresHumanGate: true,
    gateStatus: 'pending',
  });
  app.store.patchPlatformDevItem(item.id, {
    githubIssueNumber: 72,
    githubIssueUrl: 'https://github.example/org/pages-manager/issues/72',
  });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-platform-work-items-list-copy-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.0001301',
          text: 'work',
        },
      }),
    })
  );
  const body = await json(response);
  const visible = JSON.stringify(body.blocks);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'list_work_items');
  assert.equal(body.jobs.length, 1);
  assert.equal(body.jobs[0].id, item.id);
  assert.match(visible, /你的任务/);
  assert.match(visible, /自动化流程调整/);
  assert.match(visible, /高，需要人工确认/);
  assert.doesNotMatch(visible, /你的发布任务|PR \/ Preview/);
  assert.doesNotMatch(visible, /type:ci|risk:high|area:gateway|area:worker/);
});

test('Slack issue list includes active and closed issue records', async () => {
  const app = createGatewayApp();
  const active = app.store.createPlatformDevItem({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'platform-visible-active-issue',
    title: '平台功能需求',
    summary: '正在处理的平台功能需求。',
    issueType: 'type:dev',
    areas: ['area:slack'],
    risk: 'risk:medium',
    agentEligible: true,
    requiresHumanGate: false,
  }).item;
  app.store.patchPlatformDevItem(active.id, {
    githubIssueNumber: 88,
    githubIssueUrl: 'https://github.example/org/pages-manager/issues/88',
  });
  const closed = app.store.createPlatformDevItem({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'platform-visible-closed-issue',
    title: '问题咨询记录',
    summary: '已经关闭的问题咨询。',
    issueType: 'type:question',
    areas: ['area:platform'],
    risk: 'risk:low',
    agentEligible: false,
    requiresHumanGate: false,
  }).item;
  app.store.patchPlatformDevItem(closed.id, {
    status: 'closed_unmerged',
    githubIssueNumber: 89,
    githubIssueUrl: 'https://github.example/org/pages-manager/issues/89',
  });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-platform-issue-list-all-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.0001302',
          text: 'work all',
        },
      }),
    })
  );
  const body = await json(response);
  const visible = JSON.stringify(body.blocks);
  const memory = app.store.getSessionMemory(body.slackSessionId);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'list_work_items');
  assert.equal(body.workItemState, 'all');
  assert.equal(body.jobs.length, 2);
  assert.match(visible, /Issue：#88/);
  assert.match(visible, /Issue：#89/);
  assert.equal(memory.lastWorkItemList.total, 2);
  assert.equal(memory.lastWorkItemList.shown.length, 2);
});

test('Slack issue list follow-up reuses previous list context', async () => {
  const app = createGatewayApp();
  const firstItem = app.store.createPlatformDevItem({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'platform-list-followup-active-issue',
    title: '平台功能需求',
    summary: '正在处理的平台功能需求。',
    issueType: 'type:dev',
    areas: ['area:slack'],
    risk: 'risk:medium',
    agentEligible: true,
    requiresHumanGate: false,
  }).item;
  app.store.patchPlatformDevItem(firstItem.id, {
    githubIssueNumber: 88,
    githubIssueUrl: 'https://github.example/org/pages-manager/issues/88',
  });
  const secondItem = app.store.createPlatformDevItem({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'platform-list-followup-closed-issue',
    title: '问题咨询记录',
    summary: '已经关闭的问题咨询。',
    issueType: 'type:question',
    areas: ['area:platform'],
    risk: 'risk:low',
    agentEligible: false,
    requiresHumanGate: false,
  }).item;
  app.store.patchPlatformDevItem(secondItem.id, {
    status: 'closed_unmerged',
    githubIssueNumber: 89,
    githubIssueUrl: 'https://github.example/org/pages-manager/issues/89',
  });

  const firstResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-platform-issue-list-followup-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.0001303',
          text: 'work all',
        },
      }),
    })
  );
  const firstBody = await json(firstResponse);
  const agentRequests = [];

  const followupResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-platform-issue-list-followup-2',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.0001304',
          text: '只有这一个么？',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      SLACK_AGENT_SHARED_SECRET: 'agent-secret',
      async SLACK_AGENT_FETCH(_url, request) {
        const payload = JSON.parse(request.body);
        agentRequests.push(payload);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              analysis: {
                intent: 'list_work_items',
                visibleReply: '我继续查看上次的 issue 列表范围。',
                summary: '继续查看上次的 issue 列表范围。',
                toolCall: {
                  name: 'list_my_work_items',
                  args: { state: payload.sessionMemory.lastWorkItemList.workItemState },
                },
                needsClarification: false,
              },
              events: [
                {
                  type: 'analysis_final',
                  sequence: 1,
                  agentRunId: payload.agentRunId,
                  slackSessionId: payload.slackSessionId,
                  analysis: {
                    intent: 'list_work_items',
                    visibleReply: '我继续查看上次的 issue 列表范围。',
                    summary: '继续查看上次的 issue 列表范围。',
                    toolCall: {
                      name: 'list_my_work_items',
                      args: { state: payload.sessionMemory.lastWorkItemList.workItemState },
                    },
                    needsClarification: false,
                  },
                },
              ],
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      },
    }
  );
  const followupBody = await json(followupResponse);

  assert.equal(firstResponse.status, 200);
  assert.equal(firstBody.workItemState, 'all');
  assert.equal(firstBody.jobs.length, 2);
  assert.equal(followupResponse.status, 200);
  assert.equal(followupBody.action, 'list_work_items');
  assert.equal(followupBody.workItemState, 'all');
  assert.equal(followupBody.jobs.length, 2);
  assert.equal(followupBody.slackSessionId, firstBody.slackSessionId);
  assert.equal(agentRequests.length, 1);
  assert.equal(agentRequests[0].sessionMemory.lastWorkItemList.workItemState, 'all');
  assert.equal(agentRequests[0].sessionMemory.lastWorkItemList.total, 2);
  assert.doesNotMatch(followupBody.replyText, /哪个对象/);
});

test('Slack explicit issue and PR count query is not swallowed by active platform focus', async () => {
  const app = createGatewayApp();
  const activeItem = app.store.createPlatformDevItem({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'platform-list-active-focus',
    title: 'Slack Agent 对话改造',
    summary: '正在处理的平台功能需求。',
    issueType: 'type:dev',
    areas: ['area:slack'],
    risk: 'risk:medium',
    agentEligible: true,
    requiresHumanGate: false,
  }).item;
  app.store.patchPlatformDevItem(activeItem.id, {
    githubIssueNumber: 88,
    githubIssueUrl: 'https://github.example/org/pages-manager/issues/88',
  });
  const otherIssue = app.store.createPlatformDevItem({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'platform-list-other-issue',
    title: '另一个平台任务',
    summary: '另一个还没处理的平台任务。',
    issueType: 'type:bug',
    areas: ['area:github'],
    risk: 'risk:medium',
    agentEligible: true,
    requiresHumanGate: false,
  }).item;
  app.store.patchPlatformDevItem(otherIssue.id, {
    githubIssueNumber: 91,
    githubIssueUrl: 'https://github.example/org/pages-manager/issues/91',
  });
  const prItem = app.store.createPlatformDevItem({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'platform-list-pr',
    title: '已有 PR 的平台任务',
    summary: '已有 PR 的平台任务。',
    issueType: 'type:dev',
    areas: ['area:ci'],
    risk: 'risk:medium',
    agentEligible: true,
    requiresHumanGate: false,
  }).item;
  app.store.patchPlatformDevItem(prItem.id, {
    status: 'pr_created',
    githubIssueNumber: 92,
    githubIssueUrl: 'https://github.example/org/pages-manager/issues/92',
    githubPrNumber: 93,
    githubPrUrl: 'https://github.example/org/pages-manager/pull/93',
  });
  const session = app.store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    slackUserId: 'U1',
    sessionKey: 'dm:D1:1710000000.0001305',
    channelId: 'D1',
    channelType: 'im',
    threadTs: '1710000000.0001305',
    messageTs: '1710000000.0001305',
    activeWorkItemKind: 'platform_dev',
    activeWorkItemId: activeItem.id,
    activeIssueNumber: 88,
  });
  await app.store.linkPlatformDevItemToSlackSession(activeItem, session);
  const agentRequests = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-platform-issue-pr-count-active-focus-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000001.0001305',
          thread_ts: '1710000000.0001305',
          text: '目前我有什么 issue 或者 PR 还没有处理？',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      SLACK_AGENT_SHARED_SECRET: 'agent-secret',
      async SLACK_AGENT_FETCH(_url, request) {
        const payload = JSON.parse(request.body);
        agentRequests.push(payload);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              analysis: {
                dialogAct: 'run_tool',
                intent: 'list_work_items',
                summary: '列出当前未处理的 issue 和 PR',
                toolCall: { name: 'list_my_work_items', args: { state: 'active' } },
                confirmationRequirement: 'none',
                focus: { kind: 'work_item_list', source: 'model' },
                card: { kind: 'task_list', title: '当前任务', summary: '列出未处理项', actions: [] },
                needsClarification: false,
              },
              events: [
                {
                  type: 'analysis_final',
                  sequence: 1,
                  agentRunId: payload.agentRunId,
                  slackSessionId: payload.slackSessionId,
                  analysis: {
                    dialogAct: 'run_tool',
                    intent: 'list_work_items',
                    summary: '列出当前未处理的 issue 和 PR',
                    toolCall: { name: 'list_my_work_items', args: { state: 'active' } },
                    confirmationRequirement: 'none',
                    focus: { kind: 'work_item_list', source: 'model' },
                    card: { kind: 'task_list', title: '当前任务', summary: '列出未处理项', actions: [] },
                    needsClarification: false,
                  },
                },
              ],
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      },
    }
  );
  const body = await json(response);
  const visible = JSON.stringify(body.blocks);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'list_work_items');
  assert.equal(body.workItemState, 'active');
  assert.equal(body.jobs.length, 3);
  assert.equal(body.slackSessionId, session.id);
  assert.equal(agentRequests.length, 1);
  assert.match(visible, /Issue：#88/);
  assert.match(visible, /Issue：#91/);
  assert.match(visible, /PR：#93/);
});

test('Slack Agent task list card intent drives list copy and action labels', async () => {
  const app = createGatewayApp();
  const job = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'agent-card-list-job',
    employeeSlug: 'u1',
    siteSlug: 'profile',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Profile page',
    summary: '个人主页',
  }).job;
  app.store.patchJob(job.id, {
    status: 'preview_deployed',
    issueNumber: 65,
    issueUrl: 'https://github.example/org/pages-manager/issues/65',
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
        event_id: 'Ev-agent-card-list-copy-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000001.0001306',
          text: '我有哪些任务？',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      async SLACK_AGENT_FETCH(_url, request) {
        const payload = JSON.parse(request.body);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              analysis: {
                dialogAct: 'run_tool',
                intent: 'list_work_items',
                toolCall: { name: 'list_my_work_items', args: { state: 'active' } },
                needsClarification: false,
                card: {
                  kind: 'task_list',
                  title: '任务总览',
                  summary: '这里是你现在可以继续推进的任务。',
                  context: '选择后，这个对话会聚焦到对应任务。',
                  actions: [
                    { id: 'open_pr', label: '看 PR' },
                    { id: 'continue_work_item', label: '继续这个' },
                    { id: 'open_preview', label: '看预览' },
                    { id: 'delete_resource', label: '删除' },
                  ],
                },
              },
              events: [],
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      },
    }
  );
  const body = await json(response);
  const visible = JSON.stringify(body.blocks);
  const firstActions = body.blocks.find((block) => block.type === 'actions')?.elements || [];

  assert.equal(response.status, 200);
  assert.equal(body.action, 'list_work_items');
  assert.match(visible, /任务总览/);
  assert.match(visible, /这里是你现在可以继续推进的任务/);
  assert.match(visible, /选择后，这个对话会聚焦到对应任务/);
  assert.equal(findBlockAction(body.blocks, 'pages_select_work_item')?.text?.text, '继续这个');
  assert.equal(findBlockAction(body.blocks, 'open_pr')?.text?.text, '看 PR');
  assert.equal(findBlockAction(body.blocks, 'open_preview')?.text?.text, '看预览');
  assert.deepEqual(
    firstActions.map((action) => action.action_id).slice(0, 3),
    ['open_pr', 'pages_select_work_item', 'open_preview']
  );
  assert.doesNotMatch(visible, /删除|delete_resource/);
});

test('Slack Agent can switch to a platform issue without site publishing status card', async () => {
  const app = createGatewayApp();
  const { item } = app.store.createPlatformDevItem({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'agent-switch-platform-issue',
    title: '平台需求',
    summary: '通过 Slack 切换平台需求。',
    issueType: 'type:dev',
    areas: ['area:slack'],
    risk: 'risk:medium',
    agentEligible: true,
    requiresHumanGate: false,
  });
  const itemWithIssue = app.store.patchPlatformDevItem(item.id, {
    githubIssueNumber: 72,
    githubIssueUrl: 'https://github.example/org/pages-manager/issues/72',
  });
  app.store.upsertSlackSession({
    id: 'sess_platform_switch',
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1',
    status: 'active',
  });
  app.store.linkPlatformDevItemToSlackSession(itemWithIssue, app.store.getSlackSession('sess_platform_switch'));
  const notifierCalls = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-switch-platform-issue-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.0001302',
          text: '继续 issue #72',
        },
      }),
    }),
    {
      SLACK_NOTIFIER_URL: 'http://slack-notifier.test',
      SLACK_NOTIFIER_SHARED_SECRET: 'secret',
      async SLACK_NOTIFIER_FETCH(url, request) {
        notifierCalls.push({ url: String(url), body: readRequestJson(request) });
        return notifierResponse({ ok: true, channel: 'D1', ts: '1710000001.000200' });
      },
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      async SLACK_AGENT_FETCH(_url, request) {
        const payload = JSON.parse(request.body);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              analysis: {
                intent: 'switch_work_item',
                visibleReply: '我来切换到这个平台需求。',
                summary: '切换到 issue #72。',
                toolCall: { name: 'switch_work_item', args: { kind: 'issue', number: 72 } },
                needsClarification: false,
              },
              events: [],
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      },
    }
  );
  const body = await json(response);
  const session = app.store.getSlackSession(body.slackSessionId);
  const payload = JSON.stringify(notifierCalls.map((call) => call.body));

  assert.equal(response.status, 200);
  assert.equal(body.action, 'switch_work_item');
  assert.equal(body.workItemKind, 'platform_dev');
  assert.equal(body.workItemId, item.id);
  assert.equal(session.activeWorkItemKind, 'platform_dev');
  assert.equal(session.activeWorkItemId, item.id);
  assert.equal(session.activeJobId, null);
  assert.match(payload, /Pages 平台需求进度/);
  assert.doesNotMatch(payload, /Preview 已生成|发布需求/);
});

test('Slack Agent unsupported destructive intent refuses bulk destructive issue requests', async () => {
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
              intent: 'unsupported_destructive_request',
              toolCall: { name: 'unsupported_destructive_request', args: {} },
              summary: '用户要求批量归档 issue，Slack 不支持直接执行。',
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
  assert.match(body.replyText, /不能在 Slack 里直接关闭或删除/);
  assert.equal(app.store.getJob(job.id).status, 'preview_deployed');
  assert.equal(agentCalls.length, 1);
});

test('Slack Agent unsupported destructive toolCall does not run repo answer', async () => {
  const app = createGatewayApp();
  const agentCalls = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-bulk-close-repo-question-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.0001331',
          text: '解释一下怎么把我名下所有 issue 都删除',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      SLACK_AGENT_SHARED_SECRET: 'agent-secret',
      async SLACK_AGENT_FETCH(url, request) {
        agentCalls.push({ url: String(url), request });
        return new Response(
          JSON.stringify({
            analysis: {
              intent: 'unsupported_destructive_request',
              toolCall: { name: 'unsupported_destructive_request', args: {} },
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
  assert.equal(agentCalls.filter((call) => call.url.endsWith('/repo-answer')).length, 0);
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
          text: 'work',
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
          text: 'work all',
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

test('Slack Agent list intent preserves history scope from free-form user text', async () => {
  const app = createGatewayApp();
  const active = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'agent-history-active-work-item',
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
  });
  const closed = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'agent-history-closed-work-item',
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

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-history-work-items-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000136',
          text: '历史的所有 PR 或者 issue 有哪些',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      async SLACK_AGENT_FETCH(_url, request) {
        const payload = JSON.parse(request.body);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              analysis: {
                intent: 'list_work_items',
                visibleReply: '我来查看历史的所有 PR 和 issue。',
                summary: '查询历史的所有 PR 和 issue。',
                needsClarification: false,
              },
              events: [
                {
                  type: 'analysis_final',
                  sequence: 1,
                  agentRunId: payload.agentRunId,
                  slackSessionId: payload.slackSessionId,
                  analysis: {
                    intent: 'list_work_items',
                    visibleReply: '我来查看历史的所有 PR 和 issue。',
                    summary: '查询历史的所有 PR 和 issue。',
                    needsClarification: false,
                  },
                },
              ],
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      },
    }
  );
  const body = await json(response);
  const blocks = JSON.stringify(body.blocks);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'list_work_items');
  assert.equal(body.jobs.length, 2);
  assert.match(blocks, /Issue 已关闭/);
  assert.match(blocks, /#69/);
  assert.match(blocks, /重新打开 Issue/);
});

test('Slack Agent tool call can list only closed work items without cross-user leakage', async () => {
  const app = createGatewayApp();
  const active = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'agent-tool-active-work-item',
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
    prNumber: 68,
  });
  const closed = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'agent-tool-closed-work-item',
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
  });
  const otherClosed = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U2',
    idempotencyKey: 'agent-tool-other-closed-work-item',
    employeeSlug: 'u2',
    siteSlug: 'other-closed',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Other closed profile page',
    summary: '别人的已关闭任务',
  }).job;
  app.store.patchJob(otherClosed.id, {
    status: 'cancelled',
    errorCode: 'github_pr_closed',
    issueNumber: 67,
    prNumber: 70,
  });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-tool-closed-work-items-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.0001361',
          text: '之前关掉的 issue 和 PR 有哪些',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      async SLACK_AGENT_FETCH(_url, request) {
        const payload = JSON.parse(request.body);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              analysis: {
                intent: 'list_work_items',
                visibleReply: '我来查看你已关闭的 issue 和 PR。',
                summary: '查询已关闭的 issue 和 PR。',
                toolCall: {
                  name: 'list_my_work_items',
                  args: { state: 'closed', requestedById: 'slack:T1:U2' },
                },
                needsClarification: false,
              },
              events: [
                {
                  type: 'analysis_final',
                  sequence: 1,
                  agentRunId: payload.agentRunId,
                  slackSessionId: payload.slackSessionId,
                  analysis: {
                    intent: 'list_work_items',
                    visibleReply: '我来查看你已关闭的 issue 和 PR。',
                    summary: '查询已关闭的 issue 和 PR。',
                    toolCall: {
                      name: 'list_my_work_items',
                      args: { state: 'closed', requestedById: 'slack:T1:U2' },
                    },
                    needsClarification: false,
                  },
                },
              ],
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      },
    }
  );
  const body = await json(response);
  const blocks = JSON.stringify(body.blocks);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'list_work_items');
  assert.equal(body.workItemState, 'closed');
  assert.equal(body.jobs.length, 1);
  assert.equal(body.jobs[0].issueNumber, 66);
  assert.match(blocks, /Issue 已关闭/);
  assert.match(blocks, /重新打开 Issue/);
  assert.doesNotMatch(blocks, /#68/);
  assert.doesNotMatch(blocks, /#70/);
  assert.doesNotMatch(blocks, /pages_select_work_item/);
});

test('Slack closed work item query is not starved by many active work items', async () => {
  const app = createGatewayApp();
  const closed = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'closed-query-old-cancelled-work-item',
    employeeSlug: 'u1',
    siteSlug: 'closed-old',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Closed old profile page',
    summary: '旧的已关闭任务',
  }).job;
  app.store.patchJob(closed.id, {
    status: 'cancelled',
    errorCode: 'github_issue_closed',
    issueNumber: 60,
    issueUrl: 'https://github.example/org/pages-manager/issues/60',
  });
  app.store.jobs.set(closed.id, {
    ...app.store.getJob(closed.id),
    updatedAt: '2026-06-15T00:00:00.000Z',
  });

  for (let index = 0; index < 25; index += 1) {
    const active = app.store.createJob({
      source: 'slack',
      requestedByType: 'user',
      requestedById: 'slack:T1:U1',
      idempotencyKey: `active-before-closed-query-${index}`,
      employeeSlug: 'u1',
      siteSlug: `active-${index}`,
      intent: 'create_site',
      approvalMode: 'manual_required',
      title: `Active profile page ${index}`,
      summary: '可继续任务',
    }).job;
    app.store.patchJob(active.id, {
      status: 'preview_deployed',
      issueNumber: 100 + index,
      prNumber: 200 + index,
    });
    app.store.jobs.set(active.id, {
      ...app.store.getJob(active.id),
      updatedAt: `2026-06-16T00:${String(index).padStart(2, '0')}:00.000Z`,
    });
  }

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-closed-query-not-starved-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.0001363',
          text: 'work closed',
        },
      }),
    })
  );
  const body = await json(response);
  const blocks = JSON.stringify(body.blocks);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'list_work_items');
  assert.equal(body.workItemState, 'closed');
  assert.equal(body.jobs.length, 1);
  assert.equal(body.jobs[0].issueNumber, 60);
  assert.match(blocks, /Issue 已关闭/);
  assert.match(blocks, /重新打开 Issue/);
  assert.doesNotMatch(blocks, /#200/);
});

test('Slack work item queries prefer Slack Agent tool execution when configured', async () => {
  const app = createGatewayApp();
  const closed = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'agent-preferred-closed-work-item',
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
    issueNumber: 66,
    issueUrl: 'https://github.example/org/pages-manager/issues/66',
  });
  const agentCalls = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-preferred-work-items-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.0001362',
          text: 'work closed',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      async SLACK_AGENT_FETCH(_url, request) {
        const payload = JSON.parse(request.body);
        agentCalls.push(payload);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              analysis: {
                intent: 'list_work_items',
                visibleReply: '我来查看你已关闭的发布任务。',
                summary: '查询已关闭的发布任务。',
                toolCall: { name: 'list_my_work_items', args: { state: 'closed' } },
                needsClarification: false,
              },
              events: [
                {
                  type: 'analysis_final',
                  sequence: 1,
                  agentRunId: payload.agentRunId,
                  slackSessionId: payload.slackSessionId,
                  analysis: {
                    intent: 'list_work_items',
                    toolCall: { name: 'list_my_work_items', args: { state: 'closed' } },
                    needsClarification: false,
                  },
                },
              ],
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(agentCalls.length, 1);
  assert.equal(body.action, 'list_work_items');
  assert.equal(body.workItemState, 'closed');
  assert.equal(body.jobs.length, 1);
  assert.equal(body.jobs[0].issueNumber, 66);
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
          text: 'work',
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
          text: 'work all',
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
          text: 'work',
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
          text: 'work',
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
          text: 'work all',
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
          text: 'work all',
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

test('Slack Agent can reopen a visible closed issue through a scoped tool call', async () => {
  const app = createGatewayApp();
  const job = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'agent-reopen-closed-issue-work-item',
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
  const githubRequests = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-reopen-issue-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000142',
          text: '重新打开 issue #70',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
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
      async SLACK_AGENT_FETCH(_url, request) {
        const payload = JSON.parse(request.body);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              analysis: {
                intent: 'reopen_work_item',
                visibleReply: '我来恢复这个 issue。',
                summary: '恢复 issue #70。',
                toolCall: { name: 'reopen_work_item', args: { kind: 'issue', number: 70 } },
                needsClarification: false,
              },
              events: [
                {
                  type: 'analysis_final',
                  sequence: 1,
                  agentRunId: payload.agentRunId,
                  slackSessionId: payload.slackSessionId,
                  analysis: {
                    intent: 'reopen_work_item',
                    toolCall: { name: 'reopen_work_item', args: { kind: 'issue', number: 70, requestedById: 'slack:T1:U2' } },
                    needsClarification: false,
                  },
                },
              ],
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      },
    }
  );
  const body = await json(response);
  const updatedJob = app.store.getJob(job.id);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'reopen_work_item');
  assert.equal(body.jobId, job.id);
  assert.equal(updatedJob.status, 'generating_page');
  assert.equal(updatedJob.errorCode, null);
  assert.equal(githubRequests.length, 1);
  assert.match(githubRequests[0].url, /\/issues\/70$/);
});

test('Slack Agent reopens platform issues through platform recovery without site publishing state', async () => {
  const app = createGatewayApp();
  const { item } = app.store.createPlatformDevItem({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'agent-reopen-platform-issue',
    title: '已关闭平台需求',
    summary: '平台需求已关闭。',
    issueType: 'type:dev',
    areas: ['area:slack'],
    risk: 'risk:medium',
    agentEligible: true,
    requiresHumanGate: false,
  });
  const itemWithIssue = app.store.updatePlatformDevItem(item.id, 'issue_created', {
    githubIssueNumber: 73,
    githubIssueUrl: 'https://github.example/org/pages-manager/issues/73',
  });
  const closedItem = app.store.updatePlatformDevItem(itemWithIssue.id, 'closed_unmerged');
  app.store.upsertSlackSession({
    id: 'sess_platform_reopen',
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1',
    status: 'active',
  });
  app.store.linkPlatformDevItemToSlackSession(closedItem, app.store.getSlackSession('sess_platform_reopen'));
  const githubRequests = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-reopen-platform-issue-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.0001421',
          text: '重新打开 issue #73',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      GITHUB_REPO: 'org/pages-manager',
      GITHUB_APP_INSTALLATION_TOKEN: 'ghs_write',
      async GITHUB_FETCH(url, request) {
        githubRequests.push({ url: String(url), request });
        return new Response(JSON.stringify({ number: 73, state: 'open' }));
      },
      async SLACK_AGENT_FETCH(_url, request) {
        const payload = JSON.parse(request.body);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              analysis: {
                intent: 'reopen_work_item',
                visibleReply: '我来恢复这个平台需求。',
                summary: '恢复 issue #73。',
                toolCall: { name: 'reopen_work_item', args: { kind: 'issue', number: 73 } },
                needsClarification: false,
              },
              events: [],
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      },
    }
  );
  const body = await json(response);
  const updatedItem = app.store.getPlatformDevItem(item.id);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'reopen_work_item');
  assert.equal(body.workItemKind, 'platform_dev');
  assert.equal(body.workItemId, item.id);
  assert.match(body.replyText, /平台需求/);
  assert.equal(updatedItem.status, 'agent_queued');
  assert.equal(updatedItem.errorCode, null);
  assert.equal(githubRequests.length, 1);
  assert.match(githubRequests[0].url, /\/issues\/73$/);
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
          text: 'work',
        },
      }),
    })
  );
  const listBody = await json(listResponse);

  assert.equal(listResponse.status, 200);
  assert.notEqual(listBody.action, 'agent_busy');
  assert.equal(listBody.action, 'list_work_items');
  assert.notEqual(listBody.slackSessionId, session.id);
  assert.equal(app.store.getSlackSession(session.id).status, 'closed');
  assert.equal(listBody.jobs.length, 1);
});

test('Slack can switch the current thread to a visible PR', async () => {
  const app = createGatewayApp();
  const agentCalls = [];
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
    }),
    mockSlackAgentTurnAnalysis(
      {
        intent: 'switch_work_item',
        toolCall: { name: 'switch_work_item', args: { kind: 'pr', number: 68 } },
        summary: '切换到 PR #68。',
        needsClarification: false,
      },
      agentCalls
    )
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
  assert.equal(agentCalls.length, 1);
});

test('Slack can switch the current thread to a visible issue', async () => {
  const app = createGatewayApp();
  const agentCalls = [];
  const job = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'switch-issue-work-item',
    employeeSlug: 'u1',
    siteSlug: 'profile',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'U1 profile page from issue',
    summary: '个人主页',
  }).job;
  app.store.patchJob(job.id, {
    status: 'issue_created',
    issueNumber: 66,
    issueUrl: 'https://github.example/org/pages-manager/issues/66',
  });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-work-items-switch-issue-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.0001311',
          text: '继续 issue #66',
        },
      }),
    }),
    mockSlackAgentTurnAnalysis(
      {
        intent: 'switch_work_item',
        toolCall: { name: 'switch_work_item', args: { kind: 'issue', number: 66 } },
        summary: '切换到 Issue #66。',
        needsClarification: false,
      },
      agentCalls
    )
  );
  const body = await json(response);
  const session = app.store.getSlackSession(body.slackSessionId);
  const memory = app.store.getSessionMemory(session.id);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'switch_work_item');
  assert.equal(body.jobId, job.id);
  assert.equal(session.activeJobId, job.id);
  assert.equal(session.activeIssueNumber, 66);
  assert.equal(session.activePrNumber, null);
  assert.equal(memory.requirements.issueNumber, 66);
  assert.match(memory.lastAgentResponse, /已切换到 Issue #66/);
  assert.equal(agentCalls.length, 1);
});

test('Slack switch only patches Slack binding and keeps fresher job state', async () => {
  const app = createGatewayApp();
  const agentCalls = [];
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
    }),
    mockSlackAgentTurnAnalysis(
      {
        intent: 'switch_work_item',
        toolCall: { name: 'switch_work_item', args: { kind: 'pr', number: 68 } },
        summary: '切换到 PR #68。',
        needsClarification: false,
      },
      agentCalls
    )
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
  assert.equal(agentCalls.length, 1);
});

test('Slack switch posts a new scoped card when the existing job card belongs to another thread', async () => {
  const app = createGatewayApp();
  const agentCalls = [];
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
  const notifierCalls = [];

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
      ...mockSlackAgentTurnAnalysis(
        {
          intent: 'switch_work_item',
          toolCall: { name: 'switch_work_item', args: { kind: 'pr', number: 68 } },
          summary: '切换到 PR #68。',
          needsClarification: false,
        },
        agentCalls
      ),
      ...mockSlackNotifier(notifierCalls, {
        handle(call) {
          if (call.path === '/internal/slack-notifier/job-status') {
            return notifierResponse({
              ok: true,
              action: 'posted',
              channel: 'D-new',
              ts: '1710000000.000134',
              message: {
                channel: 'D-new',
                threadTs: '1710000000.000133',
                messageTs: '1710000000.000134',
                stage: 'preview_deployed',
                status: 'preview_deployed',
              },
            });
          }
          return null;
        },
      }),
    }
  );
  const body = await json(response);
  const statusCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/job-status');
  const scopedMessage = app.store.getSlackJobStatusMessage(job.id, { slackSessionId: body.slackSessionId });
  const oldMessage = app.store.getSlackJobStatusMessage(job.id);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'switch_work_item');
  assert.equal(body.noReply, true);
  assert.equal(notifierCalls.length, 1);
  assert.equal(statusCall.body.job.slackThread.channelId, 'D-new');
  assert.equal(statusCall.body.job.slackThread.threadTs, '1710000000.000133');
  assert.equal(statusCall.body.existingMessage, null);
  assert.equal(statusCall.body.options.slackSessionId, body.slackSessionId);
  assert.equal(scopedMessage.channel, 'D-new');
  assert.equal(scopedMessage.threadTs, '1710000000.000133');
  assert.equal(scopedMessage.messageTs, '1710000000.000134');
  assert.equal(oldMessage.channel, 'D-old');
  assert.equal(oldMessage.messageTs, '1710000000.000002');
  assert.equal(agentCalls.length, 1);
});

test('Slack cannot switch to another user PR', async () => {
  const app = createGatewayApp();
  const agentCalls = [];
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
    }),
    mockSlackAgentTurnAnalysis(
      {
        intent: 'switch_work_item',
        toolCall: { name: 'switch_work_item', args: { kind: 'pr', number: 70 } },
        summary: '切换到 PR #70。',
        needsClarification: false,
      },
      agentCalls
    )
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'switch_work_item_not_found');
  assert.equal(body.accepted, false);
  assert.match(body.replyText, /没有找到你可继续操作的 PR #70/);
  assert.equal(agentCalls.length, 1);
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

test('executor callback fails closed when production callback token is missing', async () => {
  const app = createGatewayApp();
  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: 'job_missing',
        stageResult: 'issue_created',
      }),
    }),
    { NODE_ENV: 'production' }
  );
  const body = await json(response);

  assert.equal(response.status, 500);
  assert.equal(body.error, 'Internal callback token is not configured');
});

test('executor callbacks update the source Slack status card without extra progress messages', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
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
    }),
    mockSlackNotifier(notifierCalls)
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
      SLACK_USER_PROFILE_LOOKUP: 'false',
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);
  const statusCalls = notifierCalls.filter((call) => call.path === '/internal/slack-notifier/job-status');
  const latestStatusCall = statusCalls.at(-1);

  assert.equal(response.status, 200);
  assert.equal(body.slackStatusNotification.ok, true);
  assert.equal(body.slackStatusNotification.action, 'updated');
  assert.equal(body.slackNotification, undefined);
  assert.equal(statusCalls.length, 2);
  assert.equal(latestStatusCall.body.job.slackThread.channelId, 'C1');
  assert.equal(latestStatusCall.body.job.slackThread.threadTs, '1710000000.000200');
  assert.equal(latestStatusCall.body.options.stage, 'issue_created');
  assert.match(latestStatusCall.body.options.text, /已创建 GitHub issue/);
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
    mockSlackNotifier([])
  );
  const duplicateBody = await json(duplicate);
  assert.equal(duplicate.status, 200);
  assert.equal(duplicateBody.slackStatusNotification.ok, true);
  assert.equal(duplicateBody.slackNotification, undefined);
});

test('executor failure callback stores workflow run identity for diagnosis', async () => {
  const app = createGatewayApp();
  const job = app.store.createJob({
    source: 'api',
    requestedByType: 'user',
    requestedById: 'usr_1',
    idempotencyKey: 'executor-failure-workflow-run',
    employeeSlug: 'u1',
    siteSlug: 'profile',
    intent: 'create_site',
    approvalMode: 'manual_required',
  }).job;

  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: job.id,
        status: 'failed',
        errorCode: 'AGENT_FAILED',
        errorMessage: 'pages-agent.yml failed before creating a PR',
        workflowName: 'pages-agent.yml',
        workflowRunId: '28037536775',
      }),
    })
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.job.status, 'failed');
  assert.equal(body.job.workflowName, 'pages-agent.yml');
  assert.equal(body.job.workflowRunId, '28037536775');
});

test('platform executor failure callback stores workflow run identity for diagnosis', async () => {
  const app = createGatewayApp();
  const { item } = app.store.createPlatformDevItem({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'platform-executor-failure-workflow-run',
    title: '修复 Slack CI 诊断',
    summary: '让 Slack 能查 GitHub Actions 日志。',
    issueType: 'type:dev',
    areas: ['area:slack'],
    risk: 'risk:medium',
    agentEligible: true,
    requiresHumanGate: false,
  });
  app.store.updatePlatformDevItem(item.id, 'issue_created', {
    githubIssueNumber: 91,
    githubIssueUrl: 'https://github.example/org/pages-manager/issues/91',
  });

  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workItemKind: 'platform_dev',
        platformDevItemId: item.id,
        status: 'failed',
        errorCode: 'platform_agent_failed',
        errorMessage: 'platform-agent.yml failed before completing the PR flow',
        workflowName: 'platform-agent.yml',
        workflowRunId: '28038250585',
      }),
    })
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.item.status, 'failed');
  assert.equal(body.item.workflowName, 'platform-agent.yml');
  assert.equal(body.item.workflowRunId, '28038250585');
});

test('executor callbacks update the Slack status card in place', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
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
      SLACK_USER_PROFILE_LOOKUP: 'false',
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const created = await json(createResponse);
  assert.equal(created.slackStatusNotification.action, 'posted');
  assert.equal(notifierCalls.filter((call) => call.path === '/internal/slack-notifier/job-status').length, 1);

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
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);
  const statusCalls = notifierCalls.filter((call) => call.path === '/internal/slack-notifier/job-status');
  const updateCall = statusCalls[1];

  assert.equal(response.status, 200);
  assert.equal(body.slackStatusNotification.action, 'updated');
  assert.equal(updateCall.body.existingMessage.channel, 'C1');
  assert.equal(updateCall.body.existingMessage.messageTs, '1710000001.000100');
  assert.equal(updateCall.body.options.stage, 'issue_created');
  assert.match(updateCall.body.options.text, /已创建 GitHub issue/);
  assert.equal(updateCall.body.job.issueUrl, 'https://github.example/org/pages-manager/issues/18');
});

test('preview_deployed status card includes the preview link', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
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
    }),
    mockSlackNotifier(notifierCalls)
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
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);
  const statusCall = notifierCalls.filter((call) => call.path === '/internal/slack-notifier/job-status').at(-1);

  assert.equal(response.status, 200);
  assert.equal(body.slackStatusNotification.action, 'updated');
  assert.ok(statusCall.body.existingMessage.messageTs);
  assert.equal(statusCall.body.options.stage, 'preview_deployed');
  assert.match(statusCall.body.options.text, /Preview 已生成/);
  assert.equal(statusCall.body.job.previewUrl, 'https://preview.example.test');
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
  const agentCalls = [];
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
    }),
    mockSlackAgentTurnAnalysis(
      {
        intent: 'diagnose_work_item',
        toolCall: { name: 'diagnose_current_work_item', args: { jobId: created.jobId } },
        summary: '查询当前任务状态。',
        needsClarification: false,
      },
      agentCalls
    )
  );
  const body = await json(statusResponse);

  assert.equal(statusResponse.status, 200);
  assert.equal(body.action, 'diagnose_work_item');
  assert.equal(body.accepted, false);
  assert.equal(body.jobId, created.jobId);
  assert.doesNotMatch(body.replyText, /job_[A-Za-z0-9_]+/);
  assert.match(body.replyText, /当前状态：整理需求/);
  assert.match(body.replyText, /最近阶段：整理需求/);
  assert.match(body.replyText, /建议操作：/);
  assert.equal(agentCalls.length, 0);
});

test('Slack Agent diagnosis card intent drives diagnosis copy and action order', async () => {
  const app = createGatewayApp();
  const job = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'agent-card-diagnosis-job',
    employeeSlug: 'u1',
    siteSlug: 'profile',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Profile page',
    summary: '个人主页',
  }).job;
  app.store.patchJob(job.id, {
    status: 'preview_deployed',
    issueNumber: 65,
    issueUrl: 'https://github.example/org/pages-manager/issues/65',
    prNumber: 68,
    prUrl: 'https://github.example/org/pages-manager/pull/68',
    previewUrl: 'https://preview.example.test/u1',
  });
  app.store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    slackUserId: 'U1',
    sessionKey: 'dm:D1:1710000000.000150',
    channelId: 'D1',
    channelType: 'im',
    threadTs: '1710000000.000150',
    messageTs: '1710000000.000150',
    activeJobId: job.id,
  });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-card-diagnosis-copy-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000001.000150',
          text: '为什么没成功？',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      async SLACK_AGENT_FETCH(_url, request) {
        const payload = JSON.parse(request.body);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              analysis: {
                dialogAct: 'run_tool',
                intent: 'diagnose_work_item',
                toolCall: { name: 'diagnose_current_work_item', args: { jobId: job.id } },
                needsClarification: false,
                card: {
                  kind: 'diagnosis',
                  title: '诊断结果',
                  summary: '任务已经有 Preview，可以继续检查或追加诊断。',
                  fields: [{ label: '建议', value: '先看预览，再决定是否继续修改。' }],
                  actions: [
                    { id: 'open_preview', label: '看预览' },
                    { id: 'append_diagnosis_to_issue', label: '写入 Issue' },
                    { id: 'open_issue', label: '看 Issue' },
                    { id: 'delete_resource', label: '删除资源' },
                  ],
                },
              },
              events: [],
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      },
    }
  );
  const body = await json(response);
  const visible = JSON.stringify(body.blocks);
  const actionIds = body.blocks.find((block) => block.type === 'actions')?.elements?.map((action) => action.action_id) || [];

  assert.equal(response.status, 200);
  assert.equal(body.action, 'diagnose_work_item');
  assert.match(visible, /诊断结果/);
  assert.match(visible, /任务已经有 Preview/);
  assert.match(visible, /先看预览，再决定是否继续修改/);
  assert.equal(findBlockAction(body.blocks, 'open_preview')?.text?.text, '看预览');
  assert.equal(findBlockAction(body.blocks, 'pages_request_append_diagnosis')?.text?.text, '写入 Issue');
  assert.equal(findBlockAction(body.blocks, 'open_issue')?.text?.text, '看 Issue');
  assert.deepEqual(actionIds.slice(0, 3), ['open_preview', 'pages_request_append_diagnosis', 'open_issue']);
  assert.doesNotMatch(visible, /删除资源|delete_resource/);
});

test('Slack review result query summarizes visible Review Agent comments', async () => {
  const app = createGatewayApp();
  const agentRequests = [];
  const headSha = 'c'.repeat(40);
  const job = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'review-results-visible-job',
    employeeSlug: 'u1',
    siteSlug: 'profile',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Profile page',
    summary: '个人主页',
  }).job;
  const updatedJob = app.store.patchJob(job.id, {
    status: 'reviewing',
    issueNumber: 81,
    issueUrl: 'https://github.example/org/pages-manager/issues/81',
    prNumber: 88,
    prUrl: 'https://github.example/org/pages-manager/pull/88',
    headSha,
  });
  const session = app.store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1:1710000000.000151',
    channelId: 'D1',
    threadTs: '1710000000.000151',
    dmChannelId: 'D1',
    activeJobId: updatedJob.id,
    activeWorkItemKind: 'site_publishing',
    activeWorkItemId: updatedJob.id,
    activeIssueNumber: 81,
    activePrNumber: 88,
    activeContextExpiresAt: '2999-01-01T00:00:00.000Z',
  });
  app.store.linkJobToSlackSession(updatedJob, session);
  app.store.recordReviewAgentComment({
    repoFullName: 'org/pages-manager',
    prNumber: 88,
    headSha,
    githubCommentNodeId: 'RRC_blocking_1',
    reviewAgentLogin: 'chatgpt-codex-connector[bot]',
    sourceType: 'inline_comment',
    status: 'open',
    classification: 'blocking',
    path: 'apps/gateway/src/slack/review-results.js',
    line: 42,
    body: 'Blocking: 这里会把其它 Slack 用户的 review comment 暴露出来。',
    bodyRedacted: 'Blocking: 这里会把其它 Slack 用户的 review comment 暴露出来。',
    createdAt: '2026-06-24T00:00:00.000Z',
    updatedAt: '2026-06-24T00:00:00.000Z',
  });
  app.store.recordReviewAgentComment({
    repoFullName: 'org/pages-manager',
    prNumber: 88,
    headSha,
    githubCommentNodeId: 'RRC_suggestion_1',
    reviewAgentLogin: 'chatgpt-codex-connector[bot]',
    sourceType: 'review_summary',
    status: 'open',
    classification: 'suggestion',
    body: 'Suggestion: 可以把 Slack 展示文案再收敛一点。',
    bodyRedacted: 'Suggestion: 可以把 Slack 展示文案再收敛一点。',
    createdAt: '2026-06-24T00:01:00.000Z',
    updatedAt: '2026-06-24T00:01:00.000Z',
  });
  await recordSuccessfulSiteCheck(app, { prNumber: 88, headSha });

  const eventId = 'Ev-review-results-visible-1';
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
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000001.000151',
          text: 'review 说了什么？有哪些 blocker？',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      async SLACK_AGENT_FETCH(_url, request) {
        const payload = JSON.parse(request.body);
        agentRequests.push(payload);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              analysis: {
                intent: 'summarize_review_results',
                visibleReply: '我来整理当前 PR 的 Review 结果。',
                summary: '整理当前 PR 的 Review 结果。',
                toolCall: { name: 'summarize_review_results', args: { kind: 'current', maxItems: 5 } },
                needsClarification: false,
              },
              events: [
                {
                  type: 'analysis_final',
                  sequence: 1,
                  agentRunId: payload.agentRunId,
                  slackSessionId: payload.slackSessionId,
                  analysis: {
                    intent: 'summarize_review_results',
                    visibleReply: '我来整理当前 PR 的 Review 结果。',
                    summary: '整理当前 PR 的 Review 结果。',
                    toolCall: { name: 'summarize_review_results', args: { kind: 'current', maxItems: 5 } },
                    needsClarification: false,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      },
    }
  );
  const body = await json(response);
  const memory = app.store.getSessionMemory(body.slackSessionId);
  const delivery = app.store.slackDeliveries.get(`T1:${eventId}`);

  assert.equal(response.status, 200);
  assert.equal(agentRequests.length, 1);
  assert.equal(body.action, 'summarize_review_results');
  assert.equal(body.accepted, true);
  assert.equal(body.reviewResults.conclusion, 'blocked');
  assert.equal(body.reviewResults.counts.blocking, 1);
  assert.equal(body.reviewResults.counts.suggestion, 1);
  assert.match(body.replyText, /Review 目前有 1 条需要先处理的问题/);
  assert.match(body.replyText, /apps\/gateway\/src\/slack\/review-results\.js:42/);
  assert.match(body.replyText, /其它 Slack 用户的 review comment/);
  assert.match(body.replyText, /可以把 Slack 展示文案再收敛一点/);
  assert.equal(findBlockAction(body.blocks, 'open_pr')?.url, 'https://github.example/org/pages-manager/pull/88');
  assert.equal(findBlockAction(body.blocks, 'open_workflow')?.url, 'https://github.example/org/pages-manager/actions/runs/88');
  assert.equal(memory.requirements.reviewResults.prNumber, 88);
  assert.equal(memory.requirements.reviewResults.conclusion, 'blocked');
  assert.match(memory.conversationContext.lastAssistantMessage.text, /Review 目前有 1 条需要先处理的问题/);
  assert.match(memory.conversationContext.lastAssistantMessage.text, /apps\/gateway\/src\/slack\/review-results\.js:42/);
  assert.equal(delivery.resultType, 'status_returned');
});

test('Slack review result query refuses another user PR', async () => {
  const app = createGatewayApp();
  const agentRequests = [];
  const job = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U2',
    idempotencyKey: 'review-results-cross-user-job',
    employeeSlug: 'u2',
    siteSlug: 'profile',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'U2 profile page',
    summary: '别人的主页',
  }).job;
  const updatedJob = app.store.patchJob(job.id, {
    status: 'reviewing',
    issueNumber: 89,
    prNumber: 90,
    prUrl: 'https://github.example/org/pages-manager/pull/90',
  });
  const session = app.store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U2',
    sessionKey: 'dm:D2:1710000000.000152',
    channelId: 'D2',
    threadTs: '1710000000.000152',
    dmChannelId: 'D2',
    activeJobId: updatedJob.id,
    activeWorkItemKind: 'site_publishing',
    activeWorkItemId: updatedJob.id,
    activeIssueNumber: 89,
    activePrNumber: 90,
    activeContextExpiresAt: '2999-01-01T00:00:00.000Z',
  });
  app.store.linkJobToSlackSession(updatedJob, session);

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-review-results-cross-user-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000001.000152',
          text: 'PR #90 review 结果呢',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      async SLACK_AGENT_FETCH(_url, request) {
        const payload = JSON.parse(request.body);
        agentRequests.push(payload);
        assert.deepEqual(payload.explicitWorkItemReference, { kind: 'pr', number: 90 });
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              analysis: {
                intent: 'summarize_review_results',
                visibleReply: '我来整理 PR #90 的 Review 结果。',
                summary: '整理 PR #90 的 Review 结果。',
                toolCall: { name: 'summarize_review_results', args: { kind: 'current', maxItems: 5 } },
                needsClarification: false,
              },
              events: [
                {
                  type: 'analysis_final',
                  sequence: 1,
                  agentRunId: payload.agentRunId,
                  slackSessionId: payload.slackSessionId,
                  analysis: {
                    intent: 'summarize_review_results',
                    visibleReply: '我来整理 PR #90 的 Review 结果。',
                    summary: '整理 PR #90 的 Review 结果。',
                    toolCall: { name: 'summarize_review_results', args: { kind: 'current', maxItems: 5 } },
                    needsClarification: false,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(agentRequests.length, 1);
  assert.equal(body.action, 'summarize_review_results_forbidden');
  assert.equal(body.accepted, false);
  assert.match(body.replyText, /不属于当前 Slack 用户/);
});

test('Slack review result query keeps explicit PR target above agent current target', async () => {
  const app = createGatewayApp();
  const headShaCurrent = 'd'.repeat(40);
  const headShaExplicit = 'e'.repeat(40);
  const currentJob = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'review-results-current-job',
    employeeSlug: 'u1',
    siteSlug: 'current',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Current profile page',
    summary: '当前任务',
  }).job;
  const explicitJob = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'review-results-explicit-job',
    employeeSlug: 'u1',
    siteSlug: 'explicit',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Explicit profile page',
    summary: '显式任务',
  }).job;
  const updatedCurrent = app.store.patchJob(currentJob.id, {
    status: 'reviewing',
    issueNumber: 81,
    prNumber: 88,
    prUrl: 'https://github.example/org/pages-manager/pull/88',
    headSha: headShaCurrent,
  });
  const updatedExplicit = app.store.patchJob(explicitJob.id, {
    status: 'reviewing',
    issueNumber: 82,
    prNumber: 90,
    prUrl: 'https://github.example/org/pages-manager/pull/90',
    headSha: headShaExplicit,
  });
  const session = app.store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1:1710000000.000153',
    channelId: 'D1',
    threadTs: '1710000000.000153',
    dmChannelId: 'D1',
    activeJobId: updatedCurrent.id,
    activeWorkItemKind: 'site_publishing',
    activeWorkItemId: updatedCurrent.id,
    activeIssueNumber: 81,
    activePrNumber: 88,
    activeContextExpiresAt: '2999-01-01T00:00:00.000Z',
  });
  app.store.linkJobToSlackSession(updatedExplicit, session);
  app.store.linkJobToSlackSession(updatedCurrent, session);
  app.store.recordReviewAgentComment({
    repoFullName: 'org/pages-manager',
    prNumber: 88,
    headSha: headShaCurrent,
    githubCommentNodeId: 'RRC_current_1',
    reviewAgentLogin: 'chatgpt-codex-connector[bot]',
    sourceType: 'review_summary',
    status: 'open',
    classification: 'suggestion',
    body: 'Suggestion: current PR comment should not be selected.',
    bodyRedacted: 'Suggestion: current PR comment should not be selected.',
    createdAt: '2026-06-24T00:02:00.000Z',
    updatedAt: '2026-06-24T00:02:00.000Z',
  });
  app.store.recordReviewAgentComment({
    repoFullName: 'org/pages-manager',
    prNumber: 90,
    headSha: headShaExplicit,
    githubCommentNodeId: 'RRC_explicit_1',
    reviewAgentLogin: 'chatgpt-codex-connector[bot]',
    sourceType: 'inline_comment',
    status: 'open',
    classification: 'blocking',
    path: 'apps/gateway/src/control-plane/handlers.js',
    line: 196,
    body: 'Blocking: explicit PR target must override agent current args.',
    bodyRedacted: 'Blocking: explicit PR target must override agent current args.',
    createdAt: '2026-06-24T00:03:00.000Z',
    updatedAt: '2026-06-24T00:03:00.000Z',
  });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-review-results-explicit-target-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000001.000153',
          text: 'PR #90 review 结果呢',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      async SLACK_AGENT_FETCH(_url, request) {
        const payload = JSON.parse(request.body);
        assert.deepEqual(payload.explicitWorkItemReference, { kind: 'pr', number: 90 });
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              analysis: {
                intent: 'summarize_review_results',
                visibleReply: '我来整理当前 PR 的 Review 结果。',
                summary: '整理当前 PR 的 Review 结果。',
                toolCall: { name: 'summarize_review_results', args: { kind: 'current', maxItems: 5 } },
                needsClarification: false,
              },
              events: [
                {
                  type: 'analysis_final',
                  sequence: 1,
                  agentRunId: payload.agentRunId,
                  slackSessionId: payload.slackSessionId,
                  analysis: {
                    intent: 'summarize_review_results',
                    visibleReply: '我来整理当前 PR 的 Review 结果。',
                    summary: '整理当前 PR 的 Review 结果。',
                    toolCall: { name: 'summarize_review_results', args: { kind: 'current', maxItems: 5 } },
                    needsClarification: false,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'summarize_review_results');
  assert.equal(body.reviewResults.prNumber, 90);
  assert.match(body.replyText, /explicit PR target/);
  assert.doesNotMatch(body.replyText, /current PR comment/);
});

test('Slack review result query surfaces failed site-check without review comments', async () => {
  const app = createGatewayApp();
  const headSha = '1'.repeat(40);
  const job = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'review-results-failed-site-check-job',
    employeeSlug: 'u1',
    siteSlug: 'failed-site-check',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Failed site-check page',
    summary: 'site-check 失败',
  }).job;
  const updatedJob = app.store.patchJob(job.id, {
    status: 'reviewing',
    issueNumber: 92,
    prNumber: 93,
    prUrl: 'https://github.example/org/pages-manager/pull/93',
    headSha,
  });
  const session = app.store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1:1710000000.000156',
    channelId: 'D1',
    threadTs: '1710000000.000156',
    dmChannelId: 'D1',
    activeJobId: updatedJob.id,
    activeWorkItemKind: 'site_publishing',
    activeWorkItemId: updatedJob.id,
    activeIssueNumber: 92,
    activePrNumber: 93,
    activeContextExpiresAt: '2999-01-01T00:00:00.000Z',
  });
  app.store.linkJobToSlackSession(updatedJob, session);
  await recordSuccessfulSiteCheck(app, { prNumber: 93, headSha, conclusion: 'failure' });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-review-results-site-check-failed-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000001.000156',
          text: 'review 结果呢',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      async SLACK_AGENT_FETCH(_url, request) {
        const payload = JSON.parse(request.body);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              analysis: {
                intent: 'summarize_review_results',
                visibleReply: '我来整理当前 PR 的 Review 结果。',
                summary: '整理当前 PR 的 Review 结果。',
                toolCall: { name: 'summarize_review_results', args: { kind: 'current', maxItems: 5 } },
                needsClarification: false,
              },
              events: [
                {
                  type: 'analysis_final',
                  sequence: 1,
                  agentRunId: payload.agentRunId,
                  slackSessionId: payload.slackSessionId,
                  analysis: {
                    intent: 'summarize_review_results',
                    visibleReply: '我来整理当前 PR 的 Review 结果。',
                    summary: '整理当前 PR 的 Review 结果。',
                    toolCall: { name: 'summarize_review_results', args: { kind: 'current', maxItems: 5 } },
                    needsClarification: false,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'summarize_review_results');
  assert.equal(body.reviewResults.conclusion, 'waiting_site_check');
  assert.equal(body.reviewResults.gate.siteCheckStatus, 'completed');
  assert.equal(body.reviewResults.gate.siteCheckConclusion, 'failure');
  assert.match(body.replyText, /site-check 还没通过/);
  assert.doesNotMatch(body.replyText, /还没有收到 Review Agent 的结果/);
});

test('Slack review result query keeps current session target above agent-inferred target', async () => {
  const app = createGatewayApp();
  const headShaCurrent = 'f'.repeat(40);
  const headShaAgent = 'a'.repeat(40);
  const currentJob = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'review-results-current-precedence-job',
    employeeSlug: 'u1',
    siteSlug: 'current',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Current profile page',
    summary: '当前任务',
  }).job;
  const agentJob = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'review-results-agent-target-job',
    employeeSlug: 'u1',
    siteSlug: 'agent-target',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Agent target profile page',
    summary: 'Agent 推断任务',
  }).job;
  const updatedCurrent = app.store.patchJob(currentJob.id, {
    status: 'reviewing',
    issueNumber: 83,
    prNumber: 88,
    prUrl: 'https://github.example/org/pages-manager/pull/88',
    headSha: headShaCurrent,
  });
  const updatedAgent = app.store.patchJob(agentJob.id, {
    status: 'reviewing',
    issueNumber: 84,
    prNumber: 90,
    prUrl: 'https://github.example/org/pages-manager/pull/90',
    headSha: headShaAgent,
  });
  const session = app.store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1:1710000000.000154',
    channelId: 'D1',
    threadTs: '1710000000.000154',
    dmChannelId: 'D1',
    activeJobId: updatedCurrent.id,
    activeWorkItemKind: 'site_publishing',
    activeWorkItemId: updatedCurrent.id,
    activeIssueNumber: 83,
    activePrNumber: 88,
    activeContextExpiresAt: '2999-01-01T00:00:00.000Z',
  });
  app.store.linkJobToSlackSession(updatedAgent, session);
  app.store.linkJobToSlackSession(updatedCurrent, session);
  app.store.recordReviewAgentComment({
    repoFullName: 'org/pages-manager',
    prNumber: 88,
    headSha: headShaCurrent,
    githubCommentNodeId: 'RRC_current_precedence_1',
    reviewAgentLogin: 'chatgpt-codex-connector[bot]',
    sourceType: 'inline_comment',
    status: 'open',
    classification: 'blocking',
    body: 'Blocking: current session target must win when user did not name another PR.',
    bodyRedacted: 'Blocking: current session target must win when user did not name another PR.',
    createdAt: '2026-06-24T00:04:00.000Z',
    updatedAt: '2026-06-24T00:04:00.000Z',
  });
  app.store.recordReviewAgentComment({
    repoFullName: 'org/pages-manager',
    prNumber: 90,
    headSha: headShaAgent,
    githubCommentNodeId: 'RRC_agent_target_1',
    reviewAgentLogin: 'chatgpt-codex-connector[bot]',
    sourceType: 'review_summary',
    status: 'open',
    classification: 'suggestion',
    body: 'Suggestion: agent inferred target should not win.',
    bodyRedacted: 'Suggestion: agent inferred target should not win.',
    createdAt: '2026-06-24T00:05:00.000Z',
    updatedAt: '2026-06-24T00:05:00.000Z',
  });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-review-results-current-precedence-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000001.000154',
          text: 'review 结果呢',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      async SLACK_AGENT_FETCH(_url, request) {
        const payload = JSON.parse(request.body);
        assert.equal(payload.explicitWorkItemReference, null);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              analysis: {
                intent: 'summarize_review_results',
                visibleReply: '我来整理当前 PR 的 Review 结果。',
                summary: '整理当前 PR 的 Review 结果。',
                toolCall: { name: 'summarize_review_results', args: { kind: 'pr', number: 90, maxItems: 5 } },
                needsClarification: false,
              },
              events: [
                {
                  type: 'analysis_final',
                  sequence: 1,
                  agentRunId: payload.agentRunId,
                  slackSessionId: payload.slackSessionId,
                  analysis: {
                    intent: 'summarize_review_results',
                    visibleReply: '我来整理当前 PR 的 Review 结果。',
                    summary: '整理当前 PR 的 Review 结果。',
                    toolCall: { name: 'summarize_review_results', args: { kind: 'pr', number: 90, maxItems: 5 } },
                    needsClarification: false,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'summarize_review_results');
  assert.equal(body.reviewResults.prNumber, 88);
  assert.match(body.replyText, /current session target/);
  assert.doesNotMatch(body.replyText, /agent inferred target/);
});

test('Slack review result query can use a single previous work-item list target', async () => {
  const app = createGatewayApp();
  const headSha = '9'.repeat(40);
  const job = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'review-results-list-focus-job',
    employeeSlug: 'u1',
    siteSlug: 'list-focus',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'List focus profile page',
    summary: '上一轮列表里的任务',
  }).job;
  const updatedJob = app.store.patchJob(job.id, {
    status: 'reviewing',
    issueNumber: 85,
    prNumber: 91,
    prUrl: 'https://github.example/org/pages-manager/pull/91',
    headSha,
  });
  const session = app.store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm-thread:D1:1710000000.000155',
    channelId: 'D1',
    threadTs: '1710000000.000155',
    dmChannelId: 'D1',
    activeContextExpiresAt: '2999-01-01T00:00:00.000Z',
  });
  app.store.linkJobToSlackSession(updatedJob, session);
  app.store.updateSessionMemory(session.id, {
    lastWorkItemList: {
      action: 'list_work_items',
      workItemState: 'active',
      total: 1,
      shown: [
        {
          id: updatedJob.id,
          status: 'reviewing',
          siteSlug: updatedJob.siteSlug,
          issueNumber: 85,
          prNumber: 91,
          previewUrl: null,
        },
      ],
      createdAt: '2026-06-24T00:06:00.000Z',
    },
  });
  app.store.recordReviewAgentComment({
    repoFullName: 'org/pages-manager',
    prNumber: 91,
    headSha,
    githubCommentNodeId: 'RRC_list_focus_1',
    reviewAgentLogin: 'chatgpt-codex-connector[bot]',
    sourceType: 'inline_comment',
    status: 'open',
    classification: 'blocking',
    body: 'Blocking: single previous list item can be the review target.',
    bodyRedacted: 'Blocking: single previous list item can be the review target.',
    createdAt: '2026-06-24T00:06:00.000Z',
    updatedAt: '2026-06-24T00:06:00.000Z',
  });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-review-results-list-focus-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000001.000155',
          thread_ts: '1710000000.000155',
          text: 'review 结果呢',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      async SLACK_AGENT_FETCH(_url, request) {
        const payload = JSON.parse(request.body);
        assert.equal(payload.conversationContext.lastWorkItemList.total, 1);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              analysis: {
                intent: 'summarize_review_results',
                visibleReply: '我来整理刚才那个 PR 的 Review 结果。',
                summary: '整理刚才那个 PR 的 Review 结果。',
                toolCall: { name: 'summarize_review_results', args: { kind: 'current', maxItems: 5 } },
                needsClarification: false,
              },
              events: [
                {
                  type: 'analysis_final',
                  sequence: 1,
                  agentRunId: payload.agentRunId,
                  slackSessionId: payload.slackSessionId,
                  analysis: {
                    intent: 'summarize_review_results',
                    visibleReply: '我来整理刚才那个 PR 的 Review 结果。',
                    summary: '整理刚才那个 PR 的 Review 结果。',
                    toolCall: { name: 'summarize_review_results', args: { kind: 'current', maxItems: 5 } },
                    needsClarification: false,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'summarize_review_results');
  assert.equal(body.reviewResults.prNumber, 91);
  assert.match(body.replyText, /single previous list item/);
});

test('Slack explicit PR diagnosis bypasses multiple active DM session ambiguity', async () => {
  const app = createGatewayApp();
  const targetJob = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'diagnosis-explicit-pr-target',
    employeeSlug: 'u1',
    siteSlug: 'target',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Target job',
    summary: '目标任务',
  }).job;
  const updatedTargetJob = app.store.patchJob(targetJob.id, {
    status: 'pr_created',
    issueNumber: 76,
    prNumber: 77,
    prUrl: 'https://github.example/org/pages-manager/pull/77',
    workflowRunId: '28000000077',
  });
  const otherJob = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'diagnosis-other-active-session',
    employeeSlug: 'u1',
    siteSlug: 'other',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Other job',
    summary: '另一个任务',
  }).job;
  const firstSession = app.store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1:1710000000.000260',
    channelId: 'D1',
    threadTs: '1710000000.000260',
    dmChannelId: 'D1',
    activeJobId: otherJob.id,
    activeContextExpiresAt: '2999-01-01T00:00:00.000Z',
  });
  const secondSession = app.store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1:1710000000.000261',
    channelId: 'D1',
    threadTs: '1710000000.000261',
    dmChannelId: 'D1',
    activeJobId: targetJob.id,
    activeContextExpiresAt: '2999-01-01T00:00:00.000Z',
  });
  app.store.linkJobToSlackSession(otherJob, firstSession);
  app.store.linkJobToSlackSession(updatedTargetJob, secondSession);

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-diagnosis-explicit-pr-target-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000001.000260',
          text: '状态 PR #77',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      async SLACK_AGENT_FETCH(_url, request) {
        const payload = JSON.parse(request.body);
        assert.deepEqual(payload.explicitWorkItemReference, { kind: 'pr', number: 77 });
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              analysis: {
                dialogAct: 'run_tool',
                intent: 'diagnose_work_item',
                toolCall: { name: 'diagnose_current_work_item', args: { kind: 'pr', number: 77 } },
                needsClarification: false,
              },
              events: [],
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      },
      GITHUB_REPO: 'org/pages-manager',
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'diagnose_work_item');
  assert.equal(body.accepted, false);
  assert.equal(body.jobId, targetJob.id);
  assert.match(body.replyText, /#77/);
  assert.doesNotMatch(body.replyText, /多个最近的会话/);
});

test('Slack Agent diagnosis summarizes failed GitHub Actions job logs', async () => {
  const app = createGatewayApp();
  const headSha = 'b'.repeat(40);
  const job = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'agent-actions-diagnosis-job',
    employeeSlug: 'u1',
    siteSlug: 'profile',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Profile page',
    summary: '个人主页',
  }).job;
  app.store.patchJob(job.id, {
    status: 'pr_created',
    branchName: 'sites/job-agent-actions-diagnosis-u1-profile',
    headSha,
    workflowName: 'pages-agent.yml',
    workflowRunId: '28037536775',
    issueNumber: 65,
    issueUrl: 'https://github.example/org/pages-manager/issues/65',
    prNumber: 68,
    prUrl: 'https://github.example/org/pages-manager/pull/68',
  });
  app.store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    slackUserId: 'U1',
    sessionKey: 'dm:D1:1710000000.000250',
    channelId: 'D1',
    channelType: 'im',
    threadTs: '1710000000.000250',
    messageTs: '1710000000.000250',
    activeJobId: job.id,
  });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-actions-diagnosis-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000001.000250',
          text: '查一下 CI 为什么失败',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      async SLACK_AGENT_FETCH(_url, request) {
        const payload = JSON.parse(request.body);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              analysis: {
                dialogAct: 'run_tool',
                intent: 'diagnose_work_item',
                toolCall: { name: 'diagnose_current_work_item', args: { jobId: job.id } },
                needsClarification: false,
                card: {
                  kind: 'diagnosis',
                  title: 'CI 诊断',
                  summary: '我会检查关联 workflow 和失败日志摘要。',
                  actions: [{ id: 'open_workflow', label: '查看 Workflow' }],
                },
              },
              events: [],
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      },
      GITHUB_REPO: 'org/pages-manager',
      GITHUB_APP_INSTALLATION_TOKEN: 'github-app-token',
      async GITHUB_FETCH(url) {
        const pathname = new URL(String(url)).pathname;
        if (pathname.endsWith('/actions/runs/28037536775')) {
          return new Response(
            JSON.stringify({
              id: 28037536775,
              run_number: 42,
              name: 'Pages Agent',
              path: '.github/workflows/pages-agent.yml',
              html_url: 'https://github.example/org/pages-manager/actions/runs/28037536775',
              status: 'completed',
              conclusion: 'failure',
              head_branch: 'sites/job-agent-actions-diagnosis-u1-profile',
              head_sha: headSha,
              created_at: '2026-06-23T14:04:29Z',
            }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (pathname.endsWith('/actions/runs/28037536775/jobs')) {
          return new Response(
            JSON.stringify({
              jobs: [
                {
                  id: 82997351456,
                  name: 'Run Coding Agent',
                  status: 'completed',
                  conclusion: 'failure',
                  html_url: 'https://github.example/org/pages-manager/actions/runs/28037536775/job/82997351456',
                  steps: [
                    { name: 'Checkout', conclusion: 'success' },
                    { name: 'Run Coding Agent', conclusion: 'failure' },
                  ],
                },
              ],
            }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (pathname.endsWith('/actions/jobs/82997351456/logs')) {
          return new Response(
            [
              '2026-06-23T14:05:00Z Run platform coding agent',
              '2026-06-23T14:05:01Z Error: Platform Coding Agent response did not include files',
              '2026-06-23T14:05:01Z process exited with code 1',
            ].join('\n')
          );
        }
        return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
      },
    }
  );
  const body = await json(response);
  const visible = JSON.stringify(body.blocks);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'diagnose_work_item');
  assert.match(
    body.replyText,
    /Workflow：<https:\/\/github\.example\/org\/pages-manager\/actions\/runs\/28037536775\|Pages Agent #42>/
  );
  assert.match(
    body.replyText,
    /失败 Job：<https:\/\/github\.example\/org\/pages-manager\/actions\/runs\/28037536775\/job\/82997351456\|Run Coding Agent>/
  );
  assert.match(body.replyText, /失败步骤：Run Coding Agent/);
  assert.match(body.replyText, /Platform Coding Agent response did not include files/);
  assert.equal(
    findBlockAction(body.blocks, 'open_workflow')?.url,
    'https://github.example/org/pages-manager/actions/runs/28037536775'
  );
  assert.match(visible, /查看 Workflow/);
});

test('Slack Agent diagnosis prefers failed generated PR check workflow over successful parent workflow', async () => {
  const app = createGatewayApp();
  const headSha = 'd'.repeat(40);
  const branchName = 'sites/job-agent-actions-child-check-u1-profile';
  const job = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'agent-actions-diagnosis-child-check-job',
    employeeSlug: 'u1',
    siteSlug: 'profile',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Profile page',
    summary: '个人主页',
  }).job;
  app.store.patchJob(job.id, {
    status: 'failed',
    branchName,
    headSha,
    workflowName: 'pages-agent.yml',
    workflowRunId: '28037536000',
    issueNumber: 70,
    issueUrl: 'https://github.example/org/pages-manager/issues/70',
    prNumber: 71,
    prUrl: 'https://github.example/org/pages-manager/pull/71',
  });
  app.store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    slackUserId: 'U1',
    sessionKey: 'dm:D1:1710000000.000255',
    channelId: 'D1',
    channelType: 'im',
    threadTs: '1710000000.000255',
    messageTs: '1710000000.000255',
    activeJobId: job.id,
  });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-actions-child-check-diagnosis-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000001.000255',
          text: '为什么 PR 校验失败',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      async SLACK_AGENT_FETCH(_url, request) {
        const payload = JSON.parse(request.body);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              analysis: {
                dialogAct: 'run_tool',
                intent: 'diagnose_work_item',
                toolCall: { name: 'diagnose_current_work_item', args: { jobId: job.id } },
                needsClarification: false,
              },
              events: [],
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      },
      GITHUB_REPO: 'org/pages-manager',
      GITHUB_APP_INSTALLATION_TOKEN: 'github-app-token',
      async GITHUB_FETCH(url) {
        const parsed = new URL(String(url));
        const pathname = parsed.pathname;
        if (pathname.endsWith('/actions/runs/28037536000')) {
          return new Response(
            JSON.stringify({
              id: 28037536000,
              run_number: 40,
              name: 'Pages Agent',
              path: '.github/workflows/pages-agent.yml',
              html_url: 'https://github.example/org/pages-manager/actions/runs/28037536000',
              status: 'completed',
              conclusion: 'success',
              head_branch: branchName,
              head_sha: headSha,
              created_at: '2026-06-23T14:00:00Z',
            }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (
          pathname.endsWith('/actions/runs') &&
          (parsed.searchParams.get('branch') === branchName || parsed.searchParams.get('head_sha') === headSha)
        ) {
          return new Response(
            JSON.stringify({
              workflow_runs: [
                {
                  id: 28037536000,
                  run_number: 40,
                  name: 'Pages Agent',
                  path: '.github/workflows/pages-agent.yml',
                  html_url: 'https://github.example/org/pages-manager/actions/runs/28037536000',
                  status: 'completed',
                  conclusion: 'success',
                  head_branch: branchName,
                  head_sha: headSha,
                  created_at: '2026-06-23T14:00:00Z',
                },
                {
                  id: 28037536010,
                  run_number: 41,
                  name: 'Platform CI',
                  path: '.github/workflows/pr-platform.yml',
                  html_url: 'https://github.example/org/pages-manager/actions/runs/28037536010',
                  status: 'completed',
                  conclusion: 'failure',
                  head_branch: branchName,
                  head_sha: headSha,
                  created_at: '2026-06-23T14:01:00Z',
                },
              ],
            }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (pathname.endsWith('/actions/runs/28037536010/jobs')) {
          return new Response(
            JSON.stringify({
              jobs: [
                {
                  id: 82997351010,
                  name: 'check',
                  status: 'completed',
                  conclusion: 'failure',
                  html_url: 'https://github.example/org/pages-manager/actions/runs/28037536010/job/82997351010',
                  steps: [
                    { name: 'Detect platform changes', conclusion: 'success' },
                    { name: 'Run tests', conclusion: 'failure' },
                  ],
                },
              ],
            }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        }
        if (pathname.endsWith('/actions/jobs/82997351010/logs')) {
          return new Response(
            [
              '2026-06-23T14:05:00Z Run tests',
              '2026-06-23T14:05:01Z Error: Mixed PRs are not supported',
              '2026-06-23T14:05:01Z Process completed with exit code 1',
            ].join('\n')
          );
        }
        if (pathname.endsWith('/actions/runs/28037536000/jobs')) {
          return new Response(
            JSON.stringify({
              jobs: [{ id: 82997351000, name: 'pages-agent', status: 'completed', conclusion: 'success' }],
            }),
            { headers: { 'Content-Type': 'application/json' } }
          );
        }
        return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'diagnose_work_item');
  assert.match(
    body.replyText,
    /Workflow：<https:\/\/github\.example\/org\/pages-manager\/actions\/runs\/28037536010\|Platform CI #41>/
  );
  assert.match(
    body.replyText,
    /失败 Job：<https:\/\/github\.example\/org\/pages-manager\/actions\/runs\/28037536010\/job\/82997351010\|check>/
  );
  assert.match(body.replyText, /失败步骤：Run tests/);
  assert.match(body.replyText, /Mixed PRs are not supported/);
});

test('Slack Agent diagnosis keeps normal summary when GitHub Actions token is missing', async () => {
  const app = createGatewayApp();
  const job = app.store.createJob({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'agent-actions-diagnosis-no-token-job',
    employeeSlug: 'u1',
    siteSlug: 'profile',
    intent: 'create_site',
    approvalMode: 'manual_required',
    title: 'Profile page',
    summary: '个人主页',
  }).job;
  app.store.patchJob(job.id, {
    status: 'ci_failed',
    branchName: 'sites/job-agent-actions-diagnosis-no-token-u1-profile',
    headSha: 'c'.repeat(40),
    issueNumber: 66,
    prNumber: 69,
  });
  app.store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    slackUserId: 'U1',
    sessionKey: 'dm:D1:1710000000.000260',
    channelId: 'D1',
    channelType: 'im',
    threadTs: '1710000000.000260',
    messageTs: '1710000000.000260',
    activeJobId: job.id,
  });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-actions-diagnosis-no-token-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000001.000260',
          text: '查一下 workflow',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      async SLACK_AGENT_FETCH(_url, request) {
        const payload = JSON.parse(request.body);
        return new Response(
          JSON.stringify({
            ok: true,
            turn: {
              agentRunId: payload.agentRunId,
              slackSessionId: payload.slackSessionId,
              analysis: {
                dialogAct: 'run_tool',
                intent: 'diagnose_work_item',
                toolCall: { name: 'diagnose_current_work_item', args: { jobId: job.id } },
                needsClarification: false,
              },
              events: [],
            },
          }),
          { headers: { 'Content-Type': 'application/json' } }
        );
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'diagnose_work_item');
  assert.match(body.replyText, /当前状态：CI 未通过/);
  assert.match(body.replyText, /GitHub Actions 日志暂不可读：当前诊断入口还没有配置 Actions 读取授权/);
  assert.equal(findBlockAction(body.blocks, 'open_workflow'), null);
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
      PAGES_EXECUTOR_MODE: 'github_issue_webhook',
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
          workflowName: `${stageResult}.yml`,
          workflowRunId: String(28000000000 + stageResult.length),
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
        workflowName: 'pages-preview.yml',
        workflowRunId: '28000000099',
      }),
    })
  );
  const body = await json(previewResponse);

  assert.equal(body.job.status, 'preview_deployed');
  assert.equal(body.job.previewUrl, 'https://preview.example.test');
  assert.equal(body.job.workflowName, 'pages-preview.yml');
  assert.equal(body.job.workflowRunId, '28000000099');
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
  const notifierCalls = [];
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
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      async SLACK_AGENT_FETCH(url, request) {
        agentCalls.push({ url: String(url), request });
        const payload = JSON.parse(request.body);
        assert.equal(payload.slackSession.activeJobId, created.jobId);
        assert.equal(payload.issueLinks.length, 1);
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
                    intent: 'append_requirement',
                    summary: '把标题改成中文，再加一个项目经历区域。',
                    needsClarification: false,
                  },
                },
              ],
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
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const followup = await json(followupResponse);
  const jobBody = await json(await app.fetch(new Request(`http://gateway.test/api/publishing-jobs/${created.jobId}`)));
  const followupStatusCall = notifierCalls.filter((call) => call.path === '/internal/slack-notifier/job-status').at(-1);
  const followupMemory = app.store.getSessionMemory(created.slackSessionId);

  assert.equal(followupResponse.status, 200);
  assert.equal(agentCalls[0].url, 'http://slack-agent.test/internal/slack-agent/turn');
  assert.equal(followup.action, 'followup_fix_dispatched');
  assert.equal(followup.jobId, created.jobId);
  assert.equal(followup.noReply, true);
  assert.equal(followup.slackStatusNotification.action, 'updated');
  assert.equal(followupStatusCall.body.existingMessage.messageTs, '1710000001.000100');
  assert.equal(followupStatusCall.body.options.cardTitle, '第 1 轮修改处理中');
  assert.match(followupStatusCall.body.options.finalSummary, /帮我创建 profile 页面/);
  assert.match(followupStatusCall.body.options.currentChange, /本轮修改.*把标题改成中文/);
  assert.doesNotMatch(followupStatusCall.body.options.finalSummary, /Slack Follow-up/);
  assert.equal(jobBody.job.status, 'fixing');
  assert.equal(jobBody.job.previewUrl, null);
  assert.equal(agentCalls.length, 1);
  assert.equal(workerStarts.length, 1);
  assert.equal(followupMemory.lastAgentResponse, followup.replyText);
  assert.equal(followupMemory.conversationContext.lastAssistantMessage.text, followup.replyText);
  assert.match(followupMemory.conversationContext.recentTurns.at(-1).text, /已追加修改意见/);

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
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const queued = await json(queuedResponse);
  const queuedStatusCall = notifierCalls.filter((call) => call.path === '/internal/slack-notifier/job-status').at(-1);

  assert.equal(queuedResponse.status, 200);
  assert.equal(queued.action, 'followup_fix_queued');
  assert.equal(queued.noReply, true);
  assert.equal(queuedStatusCall.body.options.cardTitle, '第 2 轮修改已排队');
  assert.match(queuedStatusCall.body.options.finalSummary, /帮我创建 profile 页面/);
  assert.match(queuedStatusCall.body.options.currentChange, /本轮修改.*再把按钮改成黑色/);
  assert.doesNotMatch(queuedStatusCall.body.options.finalSummary, /Slack Follow-up/);
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
      PAGES_EXECUTOR_MODE: 'github_issue_webhook',
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
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const rerun = await json(rerunResponse);

  assert.equal(rerunResponse.status, 200);
  assert.equal(rerun.job.status, 'fixing');
  assert.equal(rerun.queuedFollowupRerun.queuedFollowupCount, 1);
  assert.equal(rerun.workerStart.started, true);
  assert.equal(workerStarts.length, 2);
});

test('Slack active job clarification still replies without creating an agent placeholder', async () => {
  const app = createGatewayApp();
  const createResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-active-clarify-create',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000150',
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
        issueNumber: 81,
        issueUrl: 'https://github.example/org/pages-manager/issues/81',
      }),
    })
  );
  assert.equal(issueResponse.status, 200);

  const notifierCalls = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-active-clarify-question',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000010.000150',
          thread_ts: '1710000000.000150',
          text: '项目经历这里怎么放比较好？',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      async SLACK_AGENT_FETCH(_url, request) {
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
                    intent: 'clarify',
                    summary: '用户在询问项目经历展示方式。',
                    clarifyingQuestion:
                      '可以按 2-3 个代表项目来写：项目名、你的角色、关键结果。你想偏技术成果还是业务影响？',
                    needsClarification: true,
                  },
                },
              ],
            },
          }),
          { status: 200 }
        );
      },
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);
  const messageCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/message');

  assert.equal(response.status, 200);
  assert.equal(body.action, 'clarification_needed');
  assert.equal(notifierCalls.length, 1);
  assert.match(messageCall.body.payload.text, /^<@U1>/);
  assert.match(messageCall.body.payload.text, /偏技术成果还是业务影响/);
  assert.doesNotMatch(messageCall.body.payload.text, /正在整理需求/);
  assert.equal(app.store.slackAgentReplyMessages.size, 0);
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
  const notifierCalls = [];

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
      PAGES_EXECUTOR_MODE: 'github_issue_webhook',
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.queuedFollowupRerun.skipped, true);
  assert.equal(body.queuedFollowupRerun.reason, 'queued_followup_claimed');
  assert.equal(workerStarts.length, 0);
  assert.equal(notifierCalls.length, 0);
  assert.equal(redisCalls.length, 1);
  assert.deepEqual(redisCalls[0].slice(0, 4), [
    'set',
    `pages-manager:coding-fix:queued-followup:${jobId}:round:2`,
    redisCalls[0][2],
    'PX',
  ]);
  assert.equal(redisCalls[0][5], 'NX');
});

test('Slack Agent follow-up intent in an active DM session records follow-up instead of creating another issue', async () => {
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
              intent: 'append_requirement',
              toolCall: { name: 'record_followup', args: {} },
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
  const agentCalls = [];
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
      ...mockSlackAgentTurnAnalysis(
        {
          intent: 'append_requirement',
          toolCall: { name: 'record_followup', args: {} },
          summary: '把标题改成中文。',
          needsClarification: false,
        },
        agentCalls
      ),
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
  assert.equal(agentCalls.length, 1);
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
      PAGES_EXECUTOR_MODE: 'github_issue_webhook',
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

test('GitHub webhook ignores events from non-target repositories', async () => {
  const app = createGatewayApp();
  const createBody = await json(
    await app.fetch(
      new Request('http://gateway.test/api/publishing-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'api-issue-wrong-repo',
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
  const issueBody = [`PublishingJob: ${createBody.job.id}`, '', 'Create a personal website.'].join('\n');
  const workerStarts = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-issue-wrong-repo',
        'X-GitHub-Event': 'issues',
      },
      body: JSON.stringify({
        action: 'opened',
        repository: { full_name: 'other/pages-manager' },
        issue: {
          number: 31,
          html_url: 'https://github.example/other/pages-manager/issues/31',
          body: issueBody,
        },
      }),
    }),
    {
      GITHUB_REPO: 'org/pages-manager',
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }
  );
  const body = await json(response);
  const delivery = app.store.listGithubDeliveries({ eventName: 'issues' }).deliveries[0];

  assert.equal(response.status, 200);
  assert.equal(body.ignored, 'repo_not_allowed');
  assert.equal(delivery.status, 'ignored');
  assert.equal(app.store.getJob(createBody.job.id).status, 'received');
  assert.equal(workerStarts.length, 0);
});

test('GitHub issue webhook retries deliveries that failed after insertion', async () => {
  const app = createGatewayApp();
  const createBody = await json(
    await app.fetch(
      new Request('http://gateway.test/api/publishing-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'api-issue-webhook-retry',
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
  const issueBody = [`PublishingJob: ${createBody.job.id}`, '', 'Create a personal website.'].join('\n');
  const payload = JSON.stringify({
    action: 'opened',
    repository: { full_name: 'org/pages-manager' },
    issue: {
      number: 37,
      html_url: 'https://github.example/org/pages-manager/issues/37',
      body: issueBody,
    },
  });

  const failedResponse = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-issue-retry-1',
        'X-GitHub-Event': 'issues',
      },
      body: payload,
    }),
    {
      PAGES_EXECUTOR_MODE: 'github_issue_webhook',
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH() {
        throw new Error('worker temporarily unavailable');
      },
    }
  );
  const failedDelivery = app.store.listGithubDeliveries({ eventName: 'issues' }).deliveries[0];
  const workerStarts = [];

  const retryResponse = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-issue-retry-1',
        'X-GitHub-Event': 'issues',
      },
      body: payload,
    }),
    {
      PAGES_EXECUTOR_MODE: 'github_issue_webhook',
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_agent_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const retryBody = await json(retryResponse);
  const delivery = app.store.listGithubDeliveries({ eventName: 'issues' }).deliveries[0];

  assert.equal(failedResponse.status, 500);
  assert.equal(failedDelivery.status, 'failed');
  assert.equal(retryResponse.status, 200);
  assert.equal(retryBody.issueAction, 'pages_agent_dispatched');
  assert.equal(delivery.status, 'processed');
  assert.equal(workerStarts.length, 1);
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
      PAGES_EXECUTOR_MODE: 'actions',
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
  assert.equal(body.issueAction, 'issue_recorded_waiting_for_project_index');
  assert.equal(body.job.status, 'issue_created');
  assert.equal(body.job.issueNumber, 33);
  assert.equal(workerStarts.length, 0);
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

function mergedPullRequestPayload(patch = {}) {
  return {
    action: 'closed',
    repository: {
      full_name: 'org/pages-manager',
      html_url: 'https://github.example/org/pages-manager',
    },
    pull_request: {
      number: 82,
      state: 'closed',
      merged: true,
      title: 'feat(slack): 完善任务诊断入口',
      body: '让 Slack 可以解释任务卡在哪一步。',
      html_url: 'https://github.example/org/pages-manager/pull/82',
      merge_commit_sha: 'b'.repeat(40),
      changed_files: 6,
      additions: 120,
      deletions: 24,
      user: { login: 'alice' },
      merged_by: { login: 'bob' },
      base: { ref: 'master' },
      head: { ref: 'feat/slack-diagnostics', sha: 'a'.repeat(40) },
      ...patch,
    },
  };
}

async function postPullRequestWebhook(app, deliveryId, payload, env = {}) {
  const waitUntilPromises = [];
  const runtimeEnv = {
    ...env,
    waitUntil(promise) {
      waitUntilPromises.push(promise);
      return env.waitUntil?.(promise);
    },
  };
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': deliveryId,
        'X-GitHub-Event': 'pull_request',
      },
      body: JSON.stringify(payload),
    }),
    runtimeEnv,
    { waitUntil: runtimeEnv.waitUntil }
  );
  await Promise.all(waitUntilPromises);
  return response;
}

test('GitHub merged PR webhook queues and posts one Slack merge announcement', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
  const response = await postPullRequestWebhook(app, 'delivery-merge-announcement-1', mergedPullRequestPayload(), {
    ...mockSlackNotifier(notifierCalls),
    GITHUB_REPO: 'org/pages-manager',
    MERGE_ANNOUNCEMENT_ENABLED: 'true',
    MERGE_ANNOUNCEMENT_CHANNEL_ID: 'C-MERGES',
  });
  const body = await json(response);
  const messageCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/message');
  const slackPayload = messageCall?.body?.payload || {};
  const visibleText = JSON.stringify(slackPayload);
  const events = [...app.store.agentRunEvents.values()].filter((event) => event.type === 'merge_announcement');
  const runs = [...app.store.agentRuns.values()].filter((run) => run.agentKind === 'merge_announcement');

  assert.equal(response.status, 200);
  assert.equal(body.mergeAnnouncement.queued, true);
  assert.equal(body.ignored, 'job_not_found');
  assert.equal(notifierCalls.length, 1);
  assert.equal(slackPayload.channel, 'C-MERGES');
  assert.match(slackPayload.text, /PR 已合并/);
  assert.match(visibleText, /查看 PR/);
  assert.match(visibleText, /alice/);
  assert.match(visibleText, /bob/);
  assert.match(visibleText, /master/);
  assert.match(visibleText, /bbbbbbb/);
  assert.doesNotMatch(visibleText, /\b(gateway|worker|mysql|status card|job id|callback)\b/i);
  assert.equal(events.some((event) => event.stage === 'pending'), true);
  assert.equal(events.some((event) => event.stage === 'sent' && event.slackMessageTs), true);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'completed');
  assert.equal(runs[0].report.summarySource, 'fallback_missing_agent_config');
});

test('GitHub merged platform PR keeps merged status after linked issue closes', async () => {
  const app = createGatewayApp();
  const { item } = app.store.createPlatformDevItem({
    source: 'slack',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'platform-merged-issue-close',
    title: '完善平台 PR merge 闭环',
    summary: '确保合并后 issue 关闭不会把 merged 回退成 closed_unmerged。',
    issueType: 'type:dev',
    areas: ['area:github'],
    risk: 'risk:medium',
    agentEligible: true,
    requiresHumanGate: false,
  });
  let updated = app.store.updatePlatformDevItem(item.id, 'issue_created', {
    githubIssueNumber: 188,
    githubIssueUrl: 'https://github.example/org/pages-manager/issues/188',
  });
  updated = app.store.updatePlatformDevItem(updated.id, 'agent_queued');
  updated = app.store.updatePlatformDevItem(updated.id, 'agent_running');
  updated = app.store.updatePlatformDevItem(updated.id, 'branch_committed');
  app.store.updatePlatformDevItem(updated.id, 'pr_created', {
    githubPrNumber: 288,
    githubPrUrl: 'https://github.example/org/pages-manager/pull/288',
    branchName: 'feat/platform-merged-issue-close',
    headSha: 'd'.repeat(40),
  });

  const mergedResponse = await postPullRequestWebhook(
    app,
    'delivery-platform-merged-1',
    {
      action: 'closed',
      repository: { full_name: 'org/pages-manager' },
      pull_request: {
        number: 288,
        state: 'closed',
        merged: true,
        html_url: 'https://github.example/org/pages-manager/pull/288',
        head: { ref: 'feat/platform-merged-issue-close', sha: 'd'.repeat(40) },
      },
    },
    {}
  );
  const mergedBody = await json(mergedResponse);

  assert.equal(mergedResponse.status, 200);
  assert.equal(mergedBody.item.status, 'merged');

  const issueClosedResponse = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-platform-issue-closed-after-merge',
        'X-GitHub-Event': 'issues',
      },
      body: JSON.stringify({
        action: 'closed',
        repository: { full_name: 'org/pages-manager' },
        issue: {
          number: 188,
          state: 'closed',
          html_url: 'https://github.example/org/pages-manager/issues/188',
          body: `<!-- pages-manager:platform_dev_item_id=${item.id} -->`,
        },
      }),
    })
  );
  const issueClosedBody = await json(issueClosedResponse);

  assert.equal(issueClosedResponse.status, 200);
  assert.equal(issueClosedBody.item.status, 'merged');
  assert.equal(app.store.getPlatformDevItem(item.id).status, 'merged');
});

test('GitHub merged PR webhook uses Slack Agent merge summary when configured', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
  const agentCalls = [];
  const response = await postPullRequestWebhook(app, 'delivery-merge-announcement-agent-1', mergedPullRequestPayload(), {
    ...mockSlackNotifier(notifierCalls),
    GITHUB_REPO: 'org/pages-manager',
    MERGE_ANNOUNCEMENT_ENABLED: 'true',
    MERGE_ANNOUNCEMENT_CHANNEL_ID: 'C-MERGES',
    SLACK_AGENT_MERGE_SUMMARY_URL: 'http://slack-agent.test/internal/slack-agent/merge-summary',
    SLACK_AGENT_SHARED_SECRET: 'agent-secret',
    async SLACK_AGENT_FETCH(url, request) {
      agentCalls.push({ url: String(url), request, body: JSON.parse(request.body) });
      return new Response(
        JSON.stringify({
          ok: true,
          summary: {
            headline: '完善 Slack 任务诊断入口',
            summaryBullets: ['补齐任务诊断入口。', '解释 issue、PR 和 preview 断点。', '增加受控重试和追加诊断入口。'],
            impact: '影响 Slack 内的平台任务诊断体验。',
            risk: '低风险，未改变生产部署路径。',
            tags: ['slack', 'diagnostics'],
          },
        })
      );
    },
  });
  const body = await json(response);
  const slackPayload = notifierCalls.find((call) => call.path === '/internal/slack-notifier/message')?.body?.payload || {};
  const visibleText = JSON.stringify(slackPayload);

  assert.equal(response.status, 200);
  assert.equal(body.mergeAnnouncement.queued, true);
  assert.equal(agentCalls.length, 1);
  assert.equal(agentCalls[0].request.headers['X-Pages-Slack-Agent-Token'], 'agent-secret');
  assert.equal(agentCalls[0].body.prNumber, 82);
  assert.match(visibleText, /补齐任务诊断入口/);
  assert.match(visibleText, /未改变生产部署路径/);
  assert.doesNotMatch(visibleText, /\b(gateway|worker|mysql|status card|job id|callback)\b/i);
  assert.equal(
    [...app.store.agentRuns.values()].find((run) => run.agentKind === 'merge_announcement')?.report.summarySource,
    'agent'
  );
});

test('GitHub merged PR webhook falls back when Slack Agent merge summary fails', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
  const response = await postPullRequestWebhook(app, 'delivery-merge-announcement-agent-fallback', mergedPullRequestPayload(), {
    ...mockSlackNotifier(notifierCalls),
    GITHUB_REPO: 'org/pages-manager',
    MERGE_ANNOUNCEMENT_ENABLED: 'true',
    MERGE_ANNOUNCEMENT_CHANNEL_ID: 'C-MERGES',
    SLACK_AGENT_MERGE_SUMMARY_URL: 'http://slack-agent.test/internal/slack-agent/merge-summary',
    SLACK_AGENT_SHARED_SECRET: 'agent-secret',
    async SLACK_AGENT_FETCH() {
      return new Response(JSON.stringify({ ok: false, error: 'model timeout' }), { status: 504 });
    },
  });
  const body = await json(response);
  const slackPayload = notifierCalls.find((call) => call.path === '/internal/slack-notifier/message')?.body?.payload || {};
  const visibleText = JSON.stringify(slackPayload);
  const events = [...app.store.agentRunEvents.values()].filter((event) => event.type === 'merge_announcement');

  assert.equal(response.status, 200);
  assert.equal(body.mergeAnnouncement.queued, true);
  assert.match(visibleText, /合并了 PR #82/);
  assert.equal(
    events.some((event) => event.stage === 'summary_fallback' && /model timeout|Gateway Timeout/.test(event.text)),
    true
  );
  assert.equal(events.some((event) => event.stage === 'sent'), true);
});

test('GitHub merged PR webhook dedupes merge announcement by repo PR and merge sha', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
  const env = {
    ...mockSlackNotifier(notifierCalls),
    GITHUB_REPO: 'org/pages-manager',
    MERGE_ANNOUNCEMENT_ENABLED: 'true',
    MERGE_ANNOUNCEMENT_CHANNEL_ID: 'C-MERGES',
  };
  const first = await postPullRequestWebhook(app, 'delivery-merge-announcement-dedupe-1', mergedPullRequestPayload(), env);
  const second = await postPullRequestWebhook(app, 'delivery-merge-announcement-dedupe-2', mergedPullRequestPayload(), env);
  const firstBody = await json(first);
  const secondBody = await json(second);

  assert.equal(firstBody.mergeAnnouncement.queued, true);
  assert.equal(secondBody.mergeAnnouncement.queued, false);
  assert.equal(secondBody.mergeAnnouncement.ignored, 'duplicate_merge_announcement');
  assert.equal(notifierCalls.filter((call) => call.path === '/internal/slack-notifier/message').length, 1);
});

test('GitHub merged PR webhook skips merge announcement when disabled or base ref is not allowed', async () => {
  const disabledApp = createGatewayApp();
  const disabledCalls = [];
  const disabled = await postPullRequestWebhook(disabledApp, 'delivery-merge-announcement-disabled', mergedPullRequestPayload(), {
    ...mockSlackNotifier(disabledCalls),
    GITHUB_REPO: 'org/pages-manager',
    MERGE_ANNOUNCEMENT_CHANNEL_ID: 'C-MERGES',
  });
  const disabledBody = await json(disabled);

  const stagingApp = createGatewayApp();
  const stagingCalls = [];
  const staging = await postPullRequestWebhook(
    stagingApp,
    'delivery-merge-announcement-staging',
    mergedPullRequestPayload({ base: { ref: 'staging' } }),
    {
      ...mockSlackNotifier(stagingCalls),
      GITHUB_REPO: 'org/pages-manager',
      MERGE_ANNOUNCEMENT_ENABLED: 'true',
      MERGE_ANNOUNCEMENT_CHANNEL_ID: 'C-MERGES',
    }
  );
  const stagingBody = await json(staging);

  assert.equal(disabledBody.mergeAnnouncement.queued, false);
  assert.equal(disabledBody.mergeAnnouncement.ignored, 'disabled');
  assert.equal(disabledCalls.length, 0);
  assert.equal(stagingBody.mergeAnnouncement.queued, false);
  assert.equal(stagingBody.mergeAnnouncement.ignored, 'base_ref_not_allowed');
  assert.equal(stagingCalls.length, 0);
});

test('GitHub merged site publishing PR skips fixed-channel merge announcement by default', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
  const createBody = await json(
    await app.fetch(
      new Request('http://gateway.test/api/publishing-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'site-merge-announcement-skip',
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
    prNumber: 82,
    prUrl: 'https://github.example/org/pages-manager/pull/82',
    headSha: 'a'.repeat(40),
  });

  const response = await postPullRequestWebhook(app, 'delivery-merge-announcement-site-skip', mergedPullRequestPayload(), {
    ...mockSlackNotifier(notifierCalls),
    GITHUB_REPO: 'org/pages-manager',
    MERGE_ANNOUNCEMENT_ENABLED: 'true',
    MERGE_ANNOUNCEMENT_CHANNEL_ID: 'C-MERGES',
  });
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.ignored, 'merged_pr');
  assert.equal(body.mergeAnnouncement, undefined);
  assert.equal(notifierCalls.length, 0);
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
      PAGES_EXECUTOR_MODE: 'github_issue_webhook',
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

test('GitHub Review Agent issue comment with unknown reviewed commit does not fallback to active PR job', async () => {
  const app = createGatewayApp();
  const currentHeadSha = '5'.repeat(40);
  const staleHeadSha = '6'.repeat(40);
  const jobId = await moveJobToPrCreated(app, {
    prNumber: 25,
    headSha: currentHeadSha,
    idempotencyKey: 'api-review-stale-pr-head',
  });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-stale-pr-head',
        'X-GitHub-Event': 'issue_comment',
      },
      body: JSON.stringify({
        action: 'created',
        repository: { full_name: 'org/pages-manager' },
        issue: { number: 25, pull_request: { url: 'https://github.example/org/pages-manager/pulls/25' } },
        comment: {
          id: 104,
          node_id: 'IC_104',
          body: `Codex Review: Must fix stale commit.\n\n**Reviewed commit:** \`${staleHeadSha.slice(0, 10)}\``,
          user: { login: 'chatgpt-codex-connector' },
        },
        sender: { login: 'chatgpt-codex-connector' },
      }),
    })
  );
  const body = await json(response);
  const currentJob = await json(await app.fetch(new Request(`http://gateway.test/api/publishing-jobs/${jobId}`)));

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'recorded');
  assert.equal(body.job, undefined);
  assert.equal(currentJob.job.status, 'pr_created');
  assert.equal(currentJob.job.headSha, currentHeadSha);
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
  const notifierCalls = [];
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
    }),
    mockSlackNotifier(notifierCalls)
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
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);
  const statusCall = notifierCalls.filter((call) => call.path === '/internal/slack-notifier/job-status').at(-1);

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'changes_requested');
  assert.equal(body.slackStatusNotification.ok, true);
  assert.equal(body.slackNotification, undefined);
  assert.equal(statusCall.body.options.stage, 'changes_requested');
  assert.match(statusCall.body.options.text, /blocking comment/);
  assert.match(statusCall.body.options.text, /暂停 Preview/);
});

test('GitHub Review Agent suggestion comment updates Slack status card without blocking preview', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
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
    }),
    mockSlackNotifier(notifierCalls)
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
      ...mockSlackNotifier(notifierCalls),
    }
  );
  const body = await json(response);
  const statusCall = notifierCalls.filter((call) => call.path === '/internal/slack-notifier/job-status').at(-1);

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'reviewing');
  assert.equal(body.reviewComment.classification, 'suggestion');
  assert.equal(body.gate.canPreview, true);
  assert.equal(body.job.status, 'reviewing');
  assert.equal(body.slackStatusNotification.ok, true);
  assert.equal(body.slackNotification, undefined);
  assert.equal(statusCall.body.options.stage, 'reviewing');
  assert.match(statusCall.body.options.text, /suggestion/);
  assert.match(statusCall.body.options.text, /不阻塞 Preview/);
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

test('GitHub webhook fails closed when production webhook secret is missing', async () => {
  const app = createGatewayApp();
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-missing-secret',
        'X-GitHub-Event': 'ping',
      },
      body: JSON.stringify({
        action: 'created',
        repository: { full_name: 'org/pages-manager' },
      }),
    }),
    { NODE_ENV: 'production' }
  );
  const body = await json(response);

  assert.equal(response.status, 401);
  assert.equal(body.error, 'GitHub webhook secret is not configured');
});

test('executor callback does not reopen a closed Slack session', async () => {
  const app = createGatewayApp();
  const created = await json(
    await app.fetch(
      new Request('http://gateway.test/integrations/slack/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_id: 'T1',
          event_id: 'Ev-closed-session-callback',
          event: {
            type: 'message',
            user: 'U1',
            channel: 'D1',
            channel_type: 'im',
            ts: '1710000000.000900',
            text: 'issue: 帮我创建 profile 页面',
          },
        }),
      })
    )
  );
  app.store.closeSlackSession(created.slackSessionId);

  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: created.jobId,
        stageResult: 'issue_created',
        issueNumber: 88,
        issueUrl: 'https://github.example/org/pages-manager/issues/88',
      }),
    })
  );
  const session = app.store.getSlackSession(created.slackSessionId);

  assert.equal(response.status, 200);
  assert.equal(session.status, 'closed');
  assert.equal(session.activeJobId, null);
  assert.equal(session.activeWorkItemId, null);
});

test('Slack follow-up during in-flight page generation is queued and drained by callback', async () => {
  const app = createGatewayApp();
  const created = await json(
    await app.fetch(
      new Request('http://gateway.test/integrations/slack/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_id: 'T1',
          event_id: 'Ev-inflight-followup-create',
          event: {
            type: 'message',
            user: 'U1',
            channel: 'D1',
            channel_type: 'im',
            ts: '1710000000.000901',
            text: 'issue: 帮我创建 profile 页面',
          },
        }),
      })
    )
  );
  app.store.updateJob(created.jobId, 'issue_created', { issueNumber: 89 });
  app.store.updateJob(created.jobId, 'indexing');
  app.store.updateJob(created.jobId, 'generating_page');

  const followup = await json(
    await app.fetch(
      new Request('http://gateway.test/integrations/slack/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_id: 'T1',
          event_id: 'Ev-inflight-followup-queued',
          event: {
            type: 'message',
            user: 'U1',
            channel: 'D1',
            channel_type: 'im',
            ts: '1710000010.000901',
            thread_ts: '1710000000.000901',
            text: '再加一个项目经历区域',
          },
        }),
      }),
      mockSlackAgentTurnAnalysis({
        intent: 'append_requirement',
        summary: '再加一个项目经历区域。',
        needsClarification: false,
      })
    )
  );
  assert.equal(followup.action, 'followup_fix_queued');
  assert.equal(app.store.getJob(created.jobId).status, 'generating_page');

  app.store.updateJob(created.jobId, 'pr_created', {
    branchName: 'sites/job-inflight-followup-zhangsan-profile',
    prNumber: 89,
    prUrl: 'https://github.example/org/pages-manager/pull/89',
    headSha: '8'.repeat(40),
  });
  app.store.updateJob(created.jobId, 'reviewing');
  app.store.moveJobToFixing(created.jobId, {
    summary: app.store.getJob(created.jobId).summary,
  });

  const workerStarts = [];
  const callbackResponse = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: created.jobId,
        stageResult: 'reviewing',
        branchName: 'sites/job-inflight-followup-zhangsan-profile',
        prNumber: 89,
        prUrl: 'https://github.example/org/pages-manager/pull/89',
        headSha: '9'.repeat(40),
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(_url, request) {
        workerStarts.push(JSON.parse(request.body));
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_agent_fix_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const callback = await json(callbackResponse);

  assert.equal(callbackResponse.status, 200);
  assert.equal(callback.job.status, 'fixing');
  assert.equal(callback.queuedFollowupRerun.queuedFollowupCount, 1);
  assert.equal(workerStarts.length, 1);
  assert.match(workerStarts[0].job.summary, /项目经历区域/);
});

test('stale preview callback is ignored when headSha no longer matches', async () => {
  const app = createGatewayApp();
  const jobId = await moveJobToPrCreated(app, {
    prNumber: 91,
    headSha: 'a'.repeat(40),
    idempotencyKey: 'api-stale-preview-callback',
  });
  app.store.updateJob(jobId, 'previewing', { headSha: 'b'.repeat(40) });

  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: jobId,
        stageResult: 'preview_deployed',
        previewUrl: 'https://old-preview.example.test',
        headSha: 'a'.repeat(40),
      }),
    })
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.job.status, 'previewing');
  assert.equal(body.job.previewUrl, null);
  assert.equal(body.job.headSha, 'b'.repeat(40));
});

test('GitHub issue webhook does not bypass project-index gate in actions executor mode', async () => {
  const app = createGatewayApp();
  const createBody = await json(
    await app.fetch(
      new Request('http://gateway.test/api/publishing-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'api-issue-webhook-actions-gate',
          'X-Pages-Actor-Id': 'usr_1',
        },
        body: JSON.stringify({
          employeeSlug: 'zhangsan',
          siteSlug: 'profile',
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
        'X-GitHub-Delivery': 'delivery-issue-actions-gate',
        'X-GitHub-Event': 'issues',
      },
      body: JSON.stringify({
        action: 'opened',
        repository: { full_name: 'org/pages-manager' },
        issue: {
          number: 92,
          html_url: 'https://github.example/org/pages-manager/issues/92',
          body: `PublishingJob: ${createBody.job.id}`,
        },
      }),
    }),
    {
      PAGES_EXECUTOR_MODE: 'actions',
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(_url, request) {
        workerStarts.push(JSON.parse(request.body));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.issueAction, 'issue_recorded_waiting_for_project_index');
  assert.equal(body.job.status, 'issue_created');
  assert.equal(workerStarts.length, 0);
});
