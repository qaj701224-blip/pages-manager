import assert from 'node:assert/strict';
import test from 'node:test';

import * as gatewayModule from '../../../apps/gateway/src/index.js';
import { Router } from '../../../apps/gateway/src/http/router.js';
import {
  SITE_PUBLISHING_RETIRED_CODE,
  SITE_PUBLISHING_RETIRED_MESSAGE,
} from '../../../apps/gateway/src/publishing/retirement.js';
import { registerGatewayRoutes } from '../../../apps/gateway/src/routes/register.js';
import { createGatewayApp as createGatewayTestApp } from '../../helpers/gateway-app.js';
import { GatewayStoreFixture } from '../../helpers/gateway-store-fixture.js';

const { createGatewayApp } = gatewayModule;

async function json(response) {
  return response.json();
}

function createSiteJob(store, suffix = 'retirement', requestedById = 'usr_retirement', source = 'api') {
  return store.createJob({
    source,
    requestedById,
    idempotencyKey: `retirement-${suffix}`,
    employeeSlug: 'alice',
    siteSlug: 'profile',
    summary: 'Retained historical publishing job',
  }).job;
}

function bindSiteJobToSlackSession(store, job, suffix = 'retirement', channelId = 'D1') {
  const session = store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: `dm:${channelId}:${suffix}`,
    channelId,
    threadTs: `1710000000.${suffix}`,
    activeJobId: job.id,
    activeWorkItemKind: 'site_publishing',
    activeWorkItemId: job.id,
  });
  store.linkJobToSlackSession(job, session);
  return session;
}

function sitePublishingInteractionRequest(actionId, session, job) {
  return new Request('http://gateway.test/integrations/slack/interactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      payload: JSON.stringify({
        type: 'block_actions',
        team: { id: 'T1' },
        user: { id: 'U1' },
        channel: { id: session.channelId },
        message: { ts: session.threadTs },
        actions: [
          {
            action_id: actionId,
            value: JSON.stringify({
              sessionId: session.id,
              workItemKind: 'site_publishing',
              workItemId: job.id,
            }),
          },
        ],
      }),
    }).toString(),
  });
}

test('generic Gateway test helper uses production retirement wiring', async () => {
  const app = createGatewayTestApp({ store: new GatewayStoreFixture() });
  const response = await app.fetch(
    new Request('http://gateway.test/api/publishing-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
  );

  assert.equal(response.status, 410);
  assert.equal((await json(response)).error, SITE_PUBLISHING_RETIRED_CODE);
});

test('production Gateway retires PublishingJob creation before parsing or dispatch', async () => {
  const store = new GatewayStoreFixture();
  let createCalls = 0;
  const originalCreateJob = store.createJob.bind(store);
  store.createJob = (...args) => {
    createCalls += 1;
    return originalCreateJob(...args);
  };
  const app = createGatewayApp({ store });

  const response = await app.fetch(
    new Request('http://gateway.test/api/publishing-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
  );

  assert.equal(response.status, 410);
  assert.deepEqual(await json(response), {
    error: SITE_PUBLISHING_RETIRED_CODE,
    message: SITE_PUBLISHING_RETIRED_MESSAGE,
  });
  assert.equal(createCalls, 0);
});

test('production Gateway retires PublishingJob creation before store initialization', async () => {
  let createStoreCalls = 0;
  const app = createGatewayApp({
    async createStore() {
      createStoreCalls += 1;
      throw new Error('database unavailable');
    },
  });

  const response = await app.fetch(
    new Request('http://gateway.test/api/publishing-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'not json',
    })
  );

  assert.equal(response.status, 410);
  assert.equal((await json(response)).error, SITE_PUBLISHING_RETIRED_CODE);
  assert.equal(createStoreCalls, 0);
});

test('production Slack confirmation returns retirement before store initialization', async () => {
  let createStoreCalls = 0;
  const app = createGatewayApp({
    async createStore() {
      createStoreCalls += 1;
      throw new Error('database unavailable');
    },
  });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        payload: JSON.stringify({
          type: 'block_actions',
          team: { id: 'T1' },
          user: { id: 'U1' },
          actions: [{ action_id: 'pages_confirm_issue', value: 'sess_retired' }],
        }),
      }).toString(),
    })
  );

  assert.equal(response.status, 200);
  assert.equal((await json(response)).text, SITE_PUBLISHING_RETIRED_MESSAGE);
  assert.equal(createStoreCalls, 0);
});

test('production Gateway retirement cannot be disabled through app options', async () => {
  const store = new GatewayStoreFixture();
  const app = createGatewayApp({
    store,
    retireSitePublishing: false,
    createPublishingJobHandler: async () =>
      new Response(JSON.stringify({ ok: true }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      }),
  });

  const apiResponse = await app.fetch(
    new Request('http://gateway.test/api/publishing-jobs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    })
  );
  const slackResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-retirement-cannot-disable',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000101',
          text: 'issue: 帮我创建 profile 页面',
        },
      }),
    })
  );

  assert.equal(apiResponse.status, 410);
  assert.equal((await json(apiResponse)).error, SITE_PUBLISHING_RETIRED_CODE);
  assert.equal(slackResponse.status, 200);
  assert.equal((await json(slackResponse)).action, 'site_publishing_retired');
  assert.equal(store.jobs.size, 0);
});

test('production Gateway entry does not export a legacy Site Publishing re-enable factory', () => {
  assert.equal(Object.hasOwn(gatewayModule, 'createLegacySitePublishingGatewayAppForTests'), false);
});

test('production Gateway route registrar ignores legacy handler and retirement overrides', async () => {
  const router = new Router();
  registerGatewayRoutes(router);
  const request = new Request('http://gateway.test/api/publishing-jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const match = router.match(request.method, new URL(request.url).pathname);

  const response = await match.handler(request, { store: new GatewayStoreFixture() }, match.params);

  assert.equal(response.status, 410);
  assert.equal((await json(response)).error, SITE_PUBLISHING_RETIRED_CODE);
});

test('production Gateway preserves PublishingJob history read APIs', async () => {
  const store = new GatewayStoreFixture();
  const job = createSiteJob(store, 'history');
  const app = createGatewayApp({ store });

  const listResponse = await app.fetch(new Request('http://gateway.test/api/publishing-jobs'));
  const jobResponse = await app.fetch(new Request(`http://gateway.test/api/publishing-jobs/${job.id}`));
  const eventsResponse = await app.fetch(new Request(`http://gateway.test/api/publishing-jobs/${job.id}/events`));

  assert.equal(listResponse.status, 200);
  assert.equal((await json(listResponse)).jobs[0].id, job.id);
  assert.equal(jobResponse.status, 200);
  assert.equal((await json(jobResponse)).job.id, job.id);
  assert.equal(eventsResponse.status, 200);
  assert.equal((await json(eventsResponse)).events.length > 0, true);
});

test('production Slack site publishing intake and confirmation return the retirement message', async () => {
  const store = new GatewayStoreFixture();
  const app = createGatewayApp({ store });

  const intakeResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-retired-site-intake',
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
  const intake = await json(intakeResponse);

  const confirmResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'block_actions',
        team: { id: 'T1' },
        user: { id: 'U1' },
        actions: [{ action_id: 'pages_confirm_issue', value: 'sess_retired' }],
      }),
    })
  );
  const confirm = await json(confirmResponse);

  assert.equal(intakeResponse.status, 200);
  assert.equal(intake.action, 'site_publishing_retired');
  assert.equal(intake.replyText, SITE_PUBLISHING_RETIRED_MESSAGE);
  assert.equal(confirmResponse.status, 200);
  assert.equal(confirm.response_type, 'ephemeral');
  assert.equal(confirm.text, SITE_PUBLISHING_RETIRED_MESSAGE);
  assert.equal(store.jobs.size, 0);
});

test('production Slack continue-modifying keeps explicitly typed site sessions retired', async () => {
  const store = new GatewayStoreFixture();
  const job = createSiteJob(store, 'continue-explicit-site', 'slack:T1:U1', 'slack');
  const session = store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1:continue-explicit-site',
    channelId: 'D1',
    threadTs: '1710000000.000103',
    activeJobId: null,
    activeWorkItemKind: 'site_publishing',
    activeWorkItemId: job.id,
  });
  const app = createGatewayApp({ store });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        payload: JSON.stringify({
          type: 'block_actions',
          team: { id: 'T1' },
          user: { id: 'U1' },
          channel: { id: 'D1' },
          message: { ts: session.threadTs },
          actions: [{ action_id: 'pages_continue_modifying', value: session.id }],
        }),
      }).toString(),
    })
  );

  assert.equal(response.status, 200);
  assert.equal((await json(response)).text, SITE_PUBLISHING_RETIRED_MESSAGE);
});

test('production Slack site publishing clarification returns the retirement message', async () => {
  const store = new GatewayStoreFixture();
  const app = createGatewayApp({ store });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-retired-site-clarification',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000102',
          text: '帮我做一个个人主页',
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
                lane: 'site-publishing',
                intent: 'clarify',
                summary: '需要确认页面风格。',
                visibleReply: '你希望使用哪种页面风格？',
                needsClarification: true,
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
  assert.equal(body.action, 'site_publishing_retired');
  assert.equal(body.replyText, SITE_PUBLISHING_RETIRED_MESSAGE);
});

test('production Slack follow-up, retry, and reopen do not continue site publishing jobs', async () => {
  const store = new GatewayStoreFixture();
  let activeJob = createSiteJob(store, 'slack-continuation', 'slack:T1:U1', 'slack');
  activeJob = store.patchJob(activeJob.id, {
    status: 'changes_requested',
    issueNumber: 71,
    issueUrl: 'https://github.example/org/pages-manager/issues/71',
    prNumber: 81,
    prUrl: 'https://github.example/org/pages-manager/pull/81',
    headSha: '8'.repeat(40),
  });
  const activeSession = bindSiteJobToSlackSession(store, activeJob, '000171', 'D2');

  let cancelledJob = createSiteJob(store, 'slack-reopen', 'slack:T1:U1', 'slack');
  cancelledJob = store.patchJob(cancelledJob.id, {
    status: 'cancelled',
    errorCode: 'github_issue_closed',
    errorMessage: 'GitHub issue #72 已关闭，发布任务已停止。',
    issueNumber: 72,
    issueUrl: 'https://github.example/org/pages-manager/issues/72',
  });
  const cancelledSession = bindSiteJobToSlackSession(store, cancelledJob, '000172', 'D3');
  const app = createGatewayApp({ store });
  const workerStarts = [];
  const githubWrites = [];
  const followupEnv = {
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
              intent: 'append_requirement',
              summary: '继续修改标题。',
              toolCall: { name: 'record_followup', args: {} },
              needsClarification: false,
            },
            events: [],
          },
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    },
    PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
    async WORKER_FETCH(url, request) {
      workerStarts.push({ url: String(url), body: JSON.parse(request.body) });
      return new Response(JSON.stringify({ ok: true }));
    },
  };

  const followupResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-retired-followup',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D2',
          channel_type: 'im',
          ts: '1710000010.000171',
          thread_ts: activeSession.threadTs,
          text: '继续修改：把标题改成中文',
        },
      }),
    }),
    followupEnv
  );

  const repeatedFollowupResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-retired-followup-repeat',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D2',
          channel_type: 'im',
          ts: '1710000011.000171',
          thread_ts: activeSession.threadTs,
          text: '继续修改：再调整一下副标题',
        },
      }),
    }),
    followupEnv
  );

  const retrySession = bindSiteJobToSlackSession(store, store.getJob(activeJob.id), '000173', 'D4');

  const retryResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        payload: JSON.stringify({
          type: 'block_actions',
          team: { id: 'T1' },
          user: { id: 'U1' },
          channel: { id: 'D4' },
          message: { ts: retrySession.threadTs },
          actions: [
            {
              action_id: 'pages_request_retry_work_item',
              value: JSON.stringify({
                sessionId: retrySession.id,
                workItemKind: 'site_publishing',
                workItemId: activeJob.id,
              }),
            },
          ],
        }),
      }).toString(),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(JSON.stringify({ ok: true }));
      },
    }
  );

  const reopenResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        payload: JSON.stringify({
          type: 'block_actions',
          team: { id: 'T1' },
          user: { id: 'U1' },
          channel: { id: 'D3' },
          message: { ts: cancelledSession.threadTs },
          actions: [
            {
              action_id: 'pages_reopen_work_item',
              value: JSON.stringify({
                sessionId: cancelledSession.id,
                workItemKind: 'site_publishing',
                jobId: cancelledJob.id,
                target: 'issue',
              }),
            },
          ],
        }),
      }).toString(),
    }),
    {
      GITHUB_REPO: 'org/pages-manager',
      GITHUB_APP_INSTALLATION_TOKEN: 'test-token',
      async GITHUB_FETCH(url, request) {
        githubWrites.push({ url: String(url), request });
        return new Response(JSON.stringify({ number: 72, state: 'open' }));
      },
    }
  );

  const followup = await json(followupResponse);
  const repeatedFollowup = await json(repeatedFollowupResponse);
  const retry = await json(retryResponse);
  const reopen = await json(reopenResponse);

  assert.equal(followupResponse.status, 200);
  assert.equal(followup.action, 'site_publishing_retired');
  assert.equal(followup.replyText, SITE_PUBLISHING_RETIRED_MESSAGE);
  assert.equal(store.getAgentRun(followup.agentRunId).status, 'completed');
  assert.equal(repeatedFollowupResponse.status, 200);
  assert.equal(repeatedFollowup.action, 'site_publishing_retired');
  assert.equal(repeatedFollowup.replyText, SITE_PUBLISHING_RETIRED_MESSAGE);
  assert.equal(store.getAgentRun(repeatedFollowup.agentRunId).status, 'completed');
  assert.equal(retryResponse.status, 200);
  assert.equal(retry.accepted, false);
  assert.equal(retry.replyText, SITE_PUBLISHING_RETIRED_MESSAGE);
  assert.equal(reopenResponse.status, 200);
  assert.equal(reopen.text, SITE_PUBLISHING_RETIRED_MESSAGE);
  assert.equal(store.getJob(activeJob.id).status, 'changes_requested');
  assert.equal(store.getJob(cancelledJob.id).status, 'cancelled');
  assert.equal(workerStarts.length, 0);
  assert.equal(githubWrites.length, 0);
});

test('production Slack diagnosis remains read-only for historical site publishing jobs', async () => {
  const store = new GatewayStoreFixture();
  let job = createSiteJob(store, 'slack-diagnosis', 'slack:T1:U1', 'slack');
  job = store.patchJob(job.id, {
    status: 'changes_requested',
    issueNumber: 91,
    issueUrl: 'https://github.example/org/pages-manager/issues/91',
    prNumber: 92,
    prUrl: 'https://github.example/org/pages-manager/pull/92',
  });
  const session = bindSiteJobToSlackSession(store, job, '000191', 'D5');
  const app = createGatewayApp({ store });
  const githubWrites = [];
  const env = {
    GITHUB_REPOSITORY: 'org/pages-manager',
    GITHUB_STATUS_TOKEN: 'status-token',
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
              intent: 'diagnose_current_work_item',
              summary: '诊断当前任务。',
              toolCall: { name: 'diagnose_current_work_item', args: {} },
              needsClarification: false,
            },
            events: [],
          },
        }),
        { headers: { 'Content-Type': 'application/json' } }
      );
    },
    async GITHUB_FETCH(url, request) {
      githubWrites.push({ url: String(url), request });
      if (request.method === 'GET') {
        return new Response(JSON.stringify({ number: 91, state: 'closed' }));
      }
      return new Response(JSON.stringify({ id: 901 }), { status: 201 });
    },
  };

  const diagnosisResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-retired-site-diagnosis',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D5',
          channel_type: 'im',
          ts: '1710000020.000191',
          thread_ts: session.threadTs,
          text: '帮我诊断当前任务',
        },
      }),
    }),
    env
  );
  const diagnosis = await json(diagnosisResponse);

  const appendResponse = await app.fetch(sitePublishingInteractionRequest('pages_request_append_diagnosis', session, job), env);
  const triageResponse = await app.fetch(sitePublishingInteractionRequest('pages_request_human_triage', session, job), env);
  const append = await json(appendResponse);
  const triage = await json(triageResponse);

  assert.equal(diagnosisResponse.status, 200);
  assert.equal(diagnosis.action, 'diagnose_work_item');
  assert.doesNotMatch(
    JSON.stringify(diagnosis.blocks || []),
    /pages_request_retry_work_item|pages_request_append_diagnosis|pages_request_human_triage/
  );
  assert.equal(appendResponse.status, 200);
  assert.equal(append.accepted, false);
  assert.equal(append.text, SITE_PUBLISHING_RETIRED_MESSAGE);
  assert.equal(triageResponse.status, 200);
  assert.equal(triage.accepted, false);
  assert.equal(triage.text, SITE_PUBLISHING_RETIRED_MESSAGE);
  assert.equal(store.getJob(job.id).status, 'changes_requested');
  assert.equal(githubWrites.length, 0);
});

test('production Slack task list reads historical site publishing jobs without reconciliation or actions', async () => {
  const store = new GatewayStoreFixture();
  let job = createSiteJob(store, 'slack-list-readonly', 'slack:T1:U1', 'slack');
  job = store.patchJob(job.id, {
    status: 'changes_requested',
    issueNumber: 96,
    issueUrl: 'https://github.example/org/pages-manager/issues/96',
  });
  const session = bindSiteJobToSlackSession(store, job, '000196', 'D9');
  const app = createGatewayApp({ store });
  const githubCalls = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-retired-site-list',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D9',
          channel_type: 'im',
          ts: '1710000032.000196',
          thread_ts: session.threadTs,
          text: '我的任务',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      GITHUB_REPOSITORY: 'org/pages-manager',
      GITHUB_STATUS_TOKEN: 'status-token',
      async GITHUB_FETCH(url, request) {
        githubCalls.push({ url: String(url), request });
        return new Response(JSON.stringify({ number: 96, state: 'closed' }));
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
                intent: 'list_my_work_items',
                summary: '查看我的任务。',
                toolCall: { name: 'list_my_work_items', args: { state: 'all' } },
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
  assert.equal(body.action, 'list_work_items');
  assert.match(JSON.stringify(body.jobs), new RegExp(job.id));
  assert.doesNotMatch(JSON.stringify(body.blocks || []), /pages_select_work_item|pages_reopen_work_item/);
  assert.equal(store.getJob(job.id).status, 'changes_requested');
  assert.equal(githubCalls.length, 0);
});

test('production Slack cannot switch or select historical site publishing jobs', async () => {
  const store = new GatewayStoreFixture();
  let job = createSiteJob(store, 'slack-switch', 'slack:T1:U1', 'slack');
  job = store.patchJob(job.id, {
    status: 'changes_requested',
    issueNumber: 93,
    issueUrl: 'https://github.example/org/pages-manager/issues/93',
    prNumber: 94,
    prUrl: 'https://github.example/org/pages-manager/pull/94',
  });
  const buttonSession = store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D6:retirement-button-switch',
    channelId: 'D6',
    threadTs: '1710000030.000193',
  });
  const agentSession = store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D7:retirement-agent-switch',
    channelId: 'D7',
    threadTs: '1710000030.000194',
  });
  const app = createGatewayApp({ store });

  const buttonResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        payload: JSON.stringify({
          type: 'block_actions',
          team: { id: 'T1' },
          user: { id: 'U1' },
          channel: { id: 'D6' },
          message: { ts: buttonSession.threadTs },
          actions: [
            {
              action_id: 'pages_select_work_item',
              value: JSON.stringify({
                sessionId: buttonSession.id,
                workItemKind: 'site_publishing',
                jobId: job.id,
              }),
            },
          ],
        }),
      }).toString(),
    })
  );
  const button = await json(buttonResponse);

  const continueResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        payload: JSON.stringify({
          type: 'block_actions',
          team: { id: 'T1' },
          user: { id: 'U1' },
          channel: { id: 'D6' },
          message: { ts: buttonSession.threadTs },
          actions: [{ action_id: 'pages_continue_modifying', value: buttonSession.id }],
        }),
      }).toString(),
    })
  );
  const continueBody = await json(continueResponse);

  const agentResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-retired-site-switch',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D7',
          channel_type: 'im',
          ts: '1710000031.000194',
          thread_ts: agentSession.threadTs,
          text: '继续 issue #93',
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
                intent: 'switch_work_item',
                summary: '继续 Issue #93。',
                toolCall: { name: 'switch_work_item', args: { kind: 'issue', number: 93 } },
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
  const agent = await json(agentResponse);

  assert.equal(buttonResponse.status, 200);
  assert.equal(button.text, SITE_PUBLISHING_RETIRED_MESSAGE);
  assert.equal(continueResponse.status, 200);
  assert.equal(continueBody.text, SITE_PUBLISHING_RETIRED_MESSAGE);
  assert.equal(agentResponse.status, 200);
  assert.equal(agent.action, 'site_publishing_retired');
  assert.equal(agent.accepted, false);
  assert.equal(agent.replyText, SITE_PUBLISHING_RETIRED_MESSAGE);
  assert.equal((await store.getSlackSession(buttonSession.id)).activeJobId, null);
  assert.equal((await store.getSlackSession(agentSession.id)).activeJobId, null);
});

test('production Slack reopen checks retirement before reconciling GitHub state', async () => {
  const store = new GatewayStoreFixture();
  let job = createSiteJob(store, 'slack-reopen-order', 'slack:T1:U1', 'slack');
  job = store.patchJob(job.id, {
    status: 'changes_requested',
    issueNumber: 95,
    issueUrl: 'https://github.example/org/pages-manager/issues/95',
  });
  const session = store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D8:retirement-reopen-order',
    channelId: 'D8',
    threadTs: '1710000030.000195',
  });
  const app = createGatewayApp({ store });
  const githubCalls = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-retired-site-reopen-order',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D8',
          channel_type: 'im',
          ts: '1710000031.000195',
          thread_ts: session.threadTs,
          text: '重新打开 issue #95',
        },
      }),
    }),
    {
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      GITHUB_REPOSITORY: 'org/pages-manager',
      GITHUB_STATUS_TOKEN: 'status-token',
      async GITHUB_FETCH(url, request) {
        githubCalls.push({ url: String(url), request });
        return new Response(JSON.stringify({ number: 95, state: 'closed' }));
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
                summary: '重新打开 Issue #95。',
                toolCall: { name: 'reopen_work_item', args: { kind: 'issue', number: 95 } },
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
  assert.equal(body.action, 'site_publishing_retired');
  assert.equal(body.replyText, SITE_PUBLISHING_RETIRED_MESSAGE);
  assert.equal(store.getJob(job.id).status, 'changes_requested');
  assert.equal(githubCalls.length, 0);
});

test('production GitHub review and executor callbacks are recorded or ignored without advancing site jobs', async () => {
  const store = new GatewayStoreFixture();
  let job = createSiteJob(store, 'callbacks');
  job = store.updateJob(job.id, 'issue_created', { issueNumber: 13 });
  job = store.updateJob(job.id, 'generating_page');
  job = store.updateJob(job.id, 'pr_created', {
    prNumber: 13,
    prUrl: 'https://github.example/org/pages-manager/pull/13',
    headSha: 'c'.repeat(40),
  });
  const app = createGatewayApp({ store });

  const reviewResponse = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-retired-review',
        'X-GitHub-Event': 'pull_request_review_comment',
      },
      body: JSON.stringify({
        action: 'created',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 13, head: { sha: 'c'.repeat(40) } },
        comment: {
          id: 200,
          node_id: 'PRRC_RETIRED_200',
          body: 'Must fix before preview.',
          path: 'sites/alice/profile/index.html',
          line: 3,
          user: { login: 'greptile[bot]' },
        },
        sender: { login: 'greptile[bot]' },
      }),
    })
  );
  const review = await json(reviewResponse);

  const callbackResponse = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publishingJobId: job.id, stageResult: 'previewing' }),
    })
  );
  const callback = await json(callbackResponse);
  const unknownCallbackResponse = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publishingJobId: job.id, stageResult: 'legacy_unknown_stage' }),
    })
  );
  const unknownCallback = await json(unknownCallbackResponse);
  const reconcileResponse = await app.fetch(
    new Request('http://gateway.test/internal/review-gate/reconcile', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ publishingJobId: job.id }),
    })
  );
  const reconcile = await json(reconcileResponse);

  assert.equal(reviewResponse.status, 200);
  assert.equal(review.ignored, SITE_PUBLISHING_RETIRED_CODE);
  assert.equal(review.reviewComment.classification, 'blocking');
  assert.equal(callbackResponse.status, 200);
  assert.equal(callback.ignored, SITE_PUBLISHING_RETIRED_CODE);
  assert.equal(unknownCallbackResponse.status, 200);
  assert.equal(unknownCallback.ignored, SITE_PUBLISHING_RETIRED_CODE);
  assert.equal(reconcileResponse.status, 200);
  assert.equal(reconcile.results[0].ignored, SITE_PUBLISHING_RETIRED_CODE);
  assert.equal(store.getJob(job.id).status, 'pr_created');
});

test('production GitHub site-check and reopened resources are recorded or ignored without restoring site jobs', async () => {
  const store = new GatewayStoreFixture();
  let job = createSiteJob(store, 'github-continuation');
  job = store.patchJob(job.id, {
    status: 'cancelled',
    errorCode: 'github_pr_closed',
    errorMessage: 'GitHub PR #42 已关闭，发布任务已停止。',
    issueNumber: 41,
    issueUrl: 'https://github.example/org/pages-manager/issues/41',
    prNumber: 42,
    prUrl: 'https://github.example/org/pages-manager/pull/42',
    headSha: '4'.repeat(40),
  });
  const app = createGatewayApp({ store });
  const workerStarts = [];
  const env = {
    PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
    async WORKER_FETCH(url, request) {
      workerStarts.push({ url: String(url), body: JSON.parse(request.body) });
      return new Response(JSON.stringify({ ok: true }));
    },
  };

  const siteCheckResponse = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-retired-site-check',
        'X-GitHub-Event': 'check_run',
      },
      body: JSON.stringify({
        action: 'completed',
        repository: { full_name: 'org/pages-manager' },
        check_run: {
          id: 4201,
          node_id: 'SCR_RETIRED_4201',
          name: 'site-check',
          status: 'completed',
          conclusion: 'success',
          head_sha: '4'.repeat(40),
          app: { slug: 'github-actions', name: 'GitHub Actions' },
          pull_requests: [{ number: 42 }],
        },
        sender: { login: 'github-actions[bot]' },
      }),
    }),
    env
  );
  const issueResponse = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-retired-issue-reopened',
        'X-GitHub-Event': 'issues',
      },
      body: JSON.stringify({
        action: 'reopened',
        repository: { full_name: 'org/pages-manager' },
        issue: {
          number: 41,
          html_url: 'https://github.example/org/pages-manager/issues/41',
          body: `PublishingJob: ${job.id}`,
        },
      }),
    }),
    env
  );
  const prResponse = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-retired-pr-reopened',
        'X-GitHub-Event': 'pull_request',
      },
      body: JSON.stringify({
        action: 'reopened',
        repository: { full_name: 'org/pages-manager' },
        pull_request: {
          number: 42,
          state: 'open',
          merged: false,
          html_url: 'https://github.example/org/pages-manager/pull/42',
          head: { sha: '4'.repeat(40) },
        },
      }),
    }),
    env
  );

  const siteCheck = await json(siteCheckResponse);
  const issue = await json(issueResponse);
  const pr = await json(prResponse);

  assert.equal(siteCheckResponse.status, 200);
  assert.equal(siteCheck.ignored, SITE_PUBLISHING_RETIRED_CODE);
  assert.equal(siteCheck.siteCheckRun.conclusion, 'success');
  assert.equal(issueResponse.status, 200);
  assert.equal(issue.ignored, SITE_PUBLISHING_RETIRED_CODE);
  assert.equal(prResponse.status, 200);
  assert.equal(pr.ignored, SITE_PUBLISHING_RETIRED_CODE);
  assert.equal(store.getJob(job.id).status, 'cancelled');
  assert.equal(store.getJob(job.id).errorCode, 'github_pr_closed');
  assert.equal(workerStarts.length, 0);
});

test('production GitHub merged site job does not queue a merge announcement', async () => {
  const store = new GatewayStoreFixture();
  let job = createSiteJob(store, 'github-merge-announcement');
  job = store.patchJob(job.id, {
    status: 'preview_deployed',
    prNumber: 43,
    prUrl: 'https://github.example/org/pages-manager/pull/43',
    headSha: '5'.repeat(40),
  });
  const app = createGatewayApp({ store });
  const notifierCalls = [];
  const waitUntilPromises = [];
  const env = {
    MERGE_ANNOUNCEMENT_ENABLED: 'true',
    MERGE_ANNOUNCEMENT_INCLUDE_SITE_PRS: 'true',
    MERGE_ANNOUNCEMENT_CHANNEL_ID: 'C-MERGES',
    SLACK_NOTIFIER_URL: 'http://slack-notifier.test',
    SLACK_NOTIFIER_SHARED_SECRET: 'test-slack-notifier-secret',
    async SLACK_NOTIFIER_FETCH(url, request) {
      notifierCalls.push({ url: String(url), request });
      return new Response(JSON.stringify({ ok: true, channel: 'C-MERGES', ts: '1710000040.000200' }));
    },
    waitUntil(promise) {
      waitUntilPromises.push(promise);
    },
  };

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-retired-pr-merged-announcement',
        'X-GitHub-Event': 'pull_request',
      },
      body: JSON.stringify({
        action: 'closed',
        repository: { full_name: 'org/pages-manager' },
        pull_request: {
          number: 43,
          state: 'closed',
          merged: true,
          title: 'Update retained site',
          html_url: 'https://github.example/org/pages-manager/pull/43',
          merge_commit_sha: '6'.repeat(40),
          base: { ref: 'master' },
          head: { ref: 'site/profile', sha: '5'.repeat(40) },
        },
      }),
    }),
    env,
    { waitUntil: env.waitUntil }
  );
  await Promise.all(waitUntilPromises);
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.ignored, SITE_PUBLISHING_RETIRED_CODE);
  assert.equal(notifierCalls.length, 0);
  assert.equal(
    [...store.agentRunEvents.values()].some((event) => event.type === 'merge_announcement'),
    false
  );
  assert.equal(
    [...store.agentRuns.values()].some((run) => run.agentKind === 'merge_announcement'),
    false
  );
  assert.equal(store.getJob(job.id).status, 'preview_deployed');
});

test('production GitHub unmatched merged PR still queues the general merge announcement', async () => {
  const store = new GatewayStoreFixture();
  const app = createGatewayApp({ store });
  const notifierCalls = [];
  const waitUntilPromises = [];
  const env = {
    MERGE_ANNOUNCEMENT_ENABLED: 'true',
    MERGE_ANNOUNCEMENT_CHANNEL_ID: 'C-MERGES',
    SLACK_NOTIFIER_URL: 'http://slack-notifier.test',
    SLACK_NOTIFIER_SHARED_SECRET: 'test-slack-notifier-secret',
    async SLACK_NOTIFIER_FETCH(url, request) {
      notifierCalls.push({ url: String(url), request });
      return new Response(JSON.stringify({ ok: true, channel: 'C-MERGES', ts: '1710000040.000201' }));
    },
    waitUntil(promise) {
      waitUntilPromises.push(promise);
    },
  };

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-unmatched-pr-merged-announcement',
        'X-GitHub-Event': 'pull_request',
      },
      body: JSON.stringify({
        action: 'closed',
        repository: { full_name: 'org/pages-manager' },
        pull_request: {
          number: 44,
          state: 'closed',
          merged: true,
          title: 'Retain general merge announcement',
          html_url: 'https://github.example/org/pages-manager/pull/44',
          merge_commit_sha: '7'.repeat(40),
          base: { ref: 'master' },
          head: { ref: 'feat/general-merge', sha: '6'.repeat(40) },
        },
      }),
    }),
    env,
    { waitUntil: env.waitUntil }
  );
  await Promise.all(waitUntilPromises);
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.ignored, 'job_not_found');
  assert.equal(body.mergeAnnouncement.queued, true);
  assert.equal(notifierCalls.length, 1);
});

test('production GitHub stale-head historical site PR remains retired and does not announce', async () => {
  const store = new GatewayStoreFixture();
  let job = createSiteJob(store, 'stale-head-merge-announcement');
  job = store.patchJob(job.id, {
    status: 'preview_deployed',
    prNumber: 45,
    prUrl: 'https://github.example/org/pages-manager/pull/45',
    headSha: '8'.repeat(40),
  });
  const app = createGatewayApp({ store });
  const notifierCalls = [];
  const waitUntilPromises = [];
  const env = {
    MERGE_ANNOUNCEMENT_ENABLED: 'true',
    MERGE_ANNOUNCEMENT_CHANNEL_ID: 'C-MERGES',
    SLACK_NOTIFIER_URL: 'http://slack-notifier.test',
    SLACK_NOTIFIER_SHARED_SECRET: 'test-slack-notifier-secret',
    async SLACK_NOTIFIER_FETCH(url, request) {
      notifierCalls.push({ url: String(url), request });
      return new Response(JSON.stringify({ ok: true, channel: 'C-MERGES', ts: '1710000040.000202' }));
    },
    waitUntil(promise) {
      waitUntilPromises.push(promise);
    },
  };

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-stale-head-site-pr-merged',
        'X-GitHub-Event': 'pull_request',
      },
      body: JSON.stringify({
        action: 'closed',
        repository: { full_name: 'org/pages-manager' },
        pull_request: {
          number: 45,
          state: 'closed',
          merged: true,
          title: 'Retired site with stale head',
          html_url: 'https://github.example/org/pages-manager/pull/45',
          merge_commit_sha: 'a'.repeat(40),
          base: { ref: 'master' },
          head: { ref: 'site/profile', sha: '9'.repeat(40) },
        },
      }),
    }),
    env,
    { waitUntil: env.waitUntil }
  );
  await Promise.all(waitUntilPromises);
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.ignored, SITE_PUBLISHING_RETIRED_CODE);
  assert.equal(body.jobId, job.id);
  assert.equal(notifierCalls.length, 0);
});

test('production Gateway retirement keeps Platform Dev confirmation and retry active', async () => {
  const store = new GatewayStoreFixture();
  const session = store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D9:platform-retirement-confirm',
    channelId: 'D9',
    threadTs: '1710000040.000201',
  });
  store.updateSessionMemory(session.id, {
    summary: 'Keep Platform Dev active',
    requirements: {
      lane: 'platform-dev',
      intent: 'create_platform_issue',
      title: 'Keep Platform Dev active',
      summary: 'Keep Platform Dev active while Site Publishing is retired.',
      issueType: 'type:dev',
      areas: ['area:gateway'],
      risk: 'risk:medium',
      agentEligible: true,
      needsClarification: false,
    },
  });
  const app = createGatewayApp({ store });
  const workerStarts = [];
  const waitUntilPromises = [];
  const env = {
    PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
    PAGES_WORKER_SHARED_SECRET: 'worker-secret',
    async WORKER_FETCH(url, request) {
      workerStarts.push({ url: String(url), body: JSON.parse(request.body) });
      return new Response(JSON.stringify({ ok: true }));
    },
  };

  const confirmResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'block_actions',
        team: { id: 'T1' },
        user: { id: 'U1' },
        channel: { id: 'D9' },
        actions: [{ action_id: 'pages_confirm_platform_issue', value: session.id }],
      }),
    }),
    env,
    {
      waitUntil(promise) {
        waitUntilPromises.push(promise);
      },
    }
  );
  const confirm = await json(confirmResponse);
  await Promise.all(waitUntilPromises);
  let item = store.getPlatformDevItem(confirm.platformDevItemId);

  assert.equal(confirmResponse.status, 200);
  assert.equal(confirm.created, true);
  assert.equal(item.status, 'received');
  assert.equal(workerStarts.length, 1);
  assert.equal(workerStarts[0].body.workItemKind, 'platform_dev');

  item = store.patchPlatformDevItem(item.id, {
    status: 'failed',
    autoDevStatus: 'triggered',
    githubIssueNumber: 101,
    githubIssueUrl: 'https://github.example/org/pages-manager/issues/101',
    githubPrNumber: 102,
    githubPrUrl: 'https://github.example/org/pages-manager/pull/102',
    headSha: '7'.repeat(40),
  });
  const retryResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'block_actions',
        team: { id: 'T1' },
        user: { id: 'U1' },
        channel: { id: 'D9' },
        actions: [
          {
            action_id: 'pages_request_retry_work_item',
            value: JSON.stringify({
              sessionId: session.id,
              workItemKind: 'platform_dev',
              workItemId: item.id,
            }),
          },
        ],
      }),
    }),
    env
  );
  const retry = await json(retryResponse);

  assert.equal(retryResponse.status, 200);
  assert.equal(retry.action, 'retry_work_item');
  assert.equal(retry.accepted, true);
  assert.equal(store.getPlatformDevItem(item.id).status, 'agent_queued');
  assert.equal(workerStarts.length, 2);
  assert.equal(workerStarts[1].body.workItemKind, 'platform_dev');
});

test('production Gateway retirement keeps Platform Dev reopen active', async () => {
  const store = new GatewayStoreFixture();
  const session = store.upsertSlackSession({
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D10:platform-retirement-reopen',
    channelId: 'D10',
    threadTs: '1710000040.000202',
  });
  let item = store.createPlatformDevItem({
    source: 'slack',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'platform-retirement-reopen',
    title: 'Reopen Platform Dev issue',
    summary: 'Platform Dev reopen remains active.',
    issueType: 'type:dev',
    areas: ['area:gateway'],
    risk: 'risk:medium',
    agentEligible: true,
  }).item;
  item = store.patchPlatformDevItem(item.id, {
    status: 'cancelled',
    autoDevStatus: 'triggered',
    githubIssueNumber: 103,
    githubIssueUrl: 'https://github.example/org/pages-manager/issues/103',
  });
  store.linkPlatformDevItemToSlackSession(item, session);
  const app = createGatewayApp({ store });
  const githubWrites = [];
  const workerStarts = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'block_actions',
        team: { id: 'T1' },
        user: { id: 'U1' },
        channel: { id: 'D10' },
        actions: [
          {
            action_id: 'pages_reopen_work_item',
            value: JSON.stringify({
              sessionId: session.id,
              workItemKind: 'platform_dev',
              jobId: item.id,
              target: 'issue',
            }),
          },
        ],
      }),
    }),
    {
      GITHUB_REPOSITORY: 'org/pages-manager',
      GITHUB_TOKEN: 'github-token',
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      PAGES_WORKER_SHARED_SECRET: 'worker-secret',
      async GITHUB_FETCH(url, request) {
        githubWrites.push({ url: String(url), method: request.method });
        return new Response(
          JSON.stringify({
            number: 103,
            state: 'open',
            html_url: 'https://github.example/org/pages-manager/issues/103',
          })
        );
      },
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(JSON.stringify({ ok: true }));
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.match(body.text, /已重新打开 Issue/);
  assert.equal(githubWrites.length, 1);
  assert.equal(githubWrites[0].method, 'PATCH');
  assert.equal(workerStarts.length, 1);
  assert.equal(workerStarts[0].body.workItemKind, 'platform_dev');
  assert.notEqual(store.getPlatformDevItem(item.id).status, 'cancelled');
});

test('production Gateway retirement keeps Platform Dev CI and review webhooks active', async () => {
  const store = new GatewayStoreFixture();
  let item = store.createPlatformDevItem({
    source: 'slack',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'platform-retirement-review',
    title: 'Keep Platform Dev review active',
    summary: 'Platform Dev review remains active.',
    issueType: 'type:dev',
    areas: ['area:github'],
    risk: 'risk:medium',
    agentEligible: true,
  }).item;
  item = store.patchPlatformDevItem(item.id, {
    status: 'pr_created',
    autoDevStatus: 'triggered',
    githubIssueNumber: 104,
    githubPrNumber: 105,
    githubPrUrl: 'https://github.example/org/pages-manager/pull/105',
    headSha: '8'.repeat(40),
  });
  const app = createGatewayApp({ store });

  const ciResponse = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-platform-retirement-ci',
        'X-GitHub-Event': 'check_run',
      },
      body: JSON.stringify({
        action: 'completed',
        repository: { full_name: 'org/pages-manager' },
        check_run: {
          id: 10501,
          node_id: 'SCR_PLATFORM_RETIREMENT_10501',
          name: 'Platform CI',
          status: 'completed',
          conclusion: 'success',
          head_sha: '8'.repeat(40),
          app: { slug: 'github-actions', name: 'GitHub Actions' },
          pull_requests: [{ number: 105 }],
        },
        sender: { login: 'github-actions[bot]' },
      }),
    })
  );
  const ci = await json(ciResponse);

  const reviewResponse = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-platform-retirement-review',
        'X-GitHub-Event': 'pull_request_review',
      },
      body: JSON.stringify({
        action: 'submitted',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 105, head: { sha: '8'.repeat(40) } },
        review: {
          id: 10502,
          node_id: 'PRR_PLATFORM_RETIREMENT_10502',
          state: 'approved',
          body: 'No blocking issues.',
          user: { login: 'chatgpt-codex-connector' },
        },
        sender: { login: 'chatgpt-codex-connector' },
      }),
    })
  );
  const review = await json(reviewResponse);

  assert.equal(ciResponse.status, 200);
  assert.equal(ci.reviewAction, 'platform_ci_recorded');
  assert.equal(reviewResponse.status, 200);
  assert.equal(review.reviewAction, 'platform_review_recorded');
  assert.equal(store.getPlatformDevItem(item.id).status, 'ready_to_merge');
});

test('production Gateway retirement leaves Platform Dev executor callbacks active', async () => {
  const store = new GatewayStoreFixture();
  const item = store.createPlatformDevItem({
    source: 'api',
    requestedById: 'usr_platform',
    idempotencyKey: 'platform-retirement-regression',
    title: 'Keep Platform Dev active',
    summary: 'Platform Dev remains available',
  }).item;
  const app = createGatewayApp({ store });

  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workItemKind: 'platform_dev',
        platformDevItemId: item.id,
        stageResult: 'issue_created',
        issueNumber: 88,
      }),
    })
  );

  assert.equal(response.status, 200);
  assert.equal((await json(response)).item.status, 'issue_created');
  assert.equal(store.getPlatformDevItem(item.id).status, 'issue_created');
});
