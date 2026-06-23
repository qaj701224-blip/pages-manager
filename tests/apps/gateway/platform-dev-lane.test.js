import assert from 'node:assert/strict';
import test from 'node:test';

import { createSlackAgentApp } from '../../../apps/slack-agent/src/index.js';
import {
  slackPlatformIssueConfirmationBlocks,
  slackPlatformIssueConfirmationText,
} from '../../../apps/gateway/src/slack/issue-confirmation.js';
import { notifySlackPlatformDevStatus } from '../../../apps/gateway/src/slack/platform-notifier.js';
import { platformDevItemMarker } from '../../../packages/git-client/src/index.js';
import { createGatewayApp } from '../../helpers/gateway-app.js';

async function json(response) {
  return response.json();
}

function slackEvent(text, eventId = 'Ev-platform-1') {
  return {
    team_id: 'T1',
    event_id: eventId,
    event: {
      type: 'message',
      user: 'U1',
      channel: 'D1',
      channel_type: 'im',
      ts: '1710000000.000100',
      text,
    },
  };
}

function interaction(actionId, value) {
  return {
    type: 'block_actions',
    team: { id: 'T1' },
    user: { id: 'U1' },
    trigger_id: 'trigger-1',
    channel: { id: 'D1' },
    container: { channel_id: 'D1', message_ts: '1710000000.000200' },
    message: { ts: '1710000000.000200', thread_ts: '1710000000.000100' },
    actions: [{ action_id: actionId, value }],
  };
}

function notifierEnv(calls = []) {
  return {
    SLACK_NOTIFIER_URL: 'http://slack-notifier.test',
    SLACK_NOTIFIER_SHARED_SECRET: 'secret',
    async SLACK_NOTIFIER_FETCH(url, request) {
      const body = request.body ? JSON.parse(request.body) : {};
      calls.push({ url: String(url), path: new URL(String(url)).pathname, body });
      if (String(url).endsWith('/user-info')) {
        return new Response(
          JSON.stringify({
            ok: true,
            profile: {
              source: 'slack.users.info',
              slackTeamId: 'T1',
              slackUserId: 'U1',
              displayName: '张三',
              email: 'zhangsan@example.com',
            },
          }),
          { status: 200 }
        );
      }
      return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: `171000000${calls.length}.000200` }), {
        status: 200,
      });
    },
  };
}

function deterministicSlackAgentEnv() {
  const agent = createSlackAgentApp({
    config: {
      sharedSecret: 'agent-secret',
      modelProvider: 'deterministic',
      streamingEnabled: false,
    },
  });
  return {
    SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
    SLACK_AGENT_SHARED_SECRET: 'agent-secret',
    SLACK_AGENT_FETCH: (url, request) => agent.fetch(new Request(url, request)),
  };
}

test('Slack platform request shows platform confirmation instead of site publishing confirmation', async () => {
  const app = createGatewayApp();
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackEvent('通过 Slack 创建 pages-manager 自身开发 issue，并跟踪 GitHub PR 进度')),
    }),
    { SLACK_EVENTS_PROCESSING_MODE: 'sync', ...deterministicSlackAgentEnv() }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'confirm_before_platform_issue');
  assert.equal(body.slackAgentAnalysis.lane, 'platform-dev');
  assert.equal(body.blocks.at(-1).elements[0].action_id, 'pages_confirm_platform_issue');
});

test('platform CI confirmation is shown as high risk without leaking raw labels', () => {
  const text = slackPlatformIssueConfirmationText({
    lane: 'platform-dev',
    intent: 'create_platform_issue',
    title: '调整 gateway worker mysql 流程',
    summary: '调整 GitHub Actions 检查。',
    issueType: 'type:ci',
    risk: 'risk:medium',
    areas: ['area:gateway', 'area:worker', 'area:ci'],
  });
  const blocks = slackPlatformIssueConfirmationBlocks(
    { id: 'sess_1' },
    {
      lane: 'platform-dev',
      intent: 'create_platform_issue',
      title: '调整 gateway worker mysql 流程',
      summary: '调整 GitHub Actions 检查。',
      issueType: 'type:ci',
      risk: 'risk:medium',
      areas: ['area:gateway', 'area:worker', 'area:ci'],
    }
  );
  const blockText = JSON.stringify(blocks);

  assert.match(text, /类型：自动化流程调整/);
  assert.match(text, /风险：高，需要人工确认/);
  assert.match(text, /等待人工确认/);
  assert.doesNotMatch(`${text}\n${blockText}`, /type:ci|risk:high|area:gateway|area:worker/);
  assert.doesNotMatch(`${text}\n${blockText}`, /\b(gateway|worker|mysql)\b/i);
});

test('confirming platform request creates PlatformDevItem and starts worker when gate is not required', async () => {
  const app = createGatewayApp();
  const notifierCalls = [];
  const workerCalls = [];
  const first = await json(
    await app.fetch(
      new Request('http://gateway.test/integrations/slack/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slackEvent('通过 Slack 创建 pages-manager 自身开发 issue，并跟踪 GitHub PR 进度', 'Ev-platform-2')),
      }),
      { SLACK_EVENTS_PROCESSING_MODE: 'sync', ...deterministicSlackAgentEnv() }
    )
  );
  const sessionId = first.slackSessionId;

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(interaction('pages_confirm_platform_issue', sessionId)),
    }),
    {
      ...notifierEnv(notifierCalls),
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      PAGES_WORKER_SHARED_SECRET: 'worker-secret',
      async WORKER_FETCH(url, request) {
        workerCalls.push({ url: String(url), body: JSON.parse(request.body), request });
        return new Response(JSON.stringify({ ok: true, result: { action: 'platform_issue_created_and_agent_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);
  const item = app.store.getPlatformDevItem(body.platformDevItemId);

  assert.equal(response.status, 200);
  assert.equal(body.created, true);
  assert.equal(item.status, 'received');
  assert.equal(item.issueType, 'type:dev');
  assert.equal(item.requiresHumanGate, false);
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].body.workItemKind, 'platform_dev');
  assert.equal(workerCalls[0].body.platformDevItem.id, item.id);
  assert.equal(app.store.getSlackSession(sessionId).activeWorkItemId, item.id);
  assert.ok(notifierCalls.some((call) => call.path === '/internal/slack-notifier/message'));
});

test('high-risk platform request creates issue work and waits for gate before coding dispatch', async () => {
  const app = createGatewayApp();
  const first = await json(
    await app.fetch(
      new Request('http://gateway.test/integrations/slack/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(slackEvent('修改 pages-manager 的 CI workflow 和 ECS 部署脚本', 'Ev-platform-3')),
      }),
      { SLACK_EVENTS_PROCESSING_MODE: 'sync', ...deterministicSlackAgentEnv() }
    )
  );
  const workerCalls = [];
  const notifierCalls = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(interaction('pages_confirm_platform_issue', first.slackSessionId)),
    }),
    {
      ...notifierEnv(notifierCalls),
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      PAGES_WORKER_SHARED_SECRET: 'worker-secret',
      async WORKER_FETCH(url, request) {
        workerCalls.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }
  );
  const body = await json(response);
  const item = app.store.getPlatformDevItem(body.platformDevItemId);

  assert.equal(item.issueType, 'type:ci');
  assert.equal(item.risk, 'risk:high');
  assert.equal(item.requiresHumanGate, true);
  assert.equal(item.gateStatus, 'pending');
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].body.workItemKind, 'platform_dev');
  assert.equal(workerCalls[0].body.platformDevItem.requiresHumanGate, true);
  assert.equal(app.store.getWorkItemGate('platform_dev', item.id, 'risk').status, 'pending');
  const progressCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/message');
  const blocks = progressCall.body.payload?.blocks || progressCall.body.blocks || progressCall.body.message?.blocks || [];
  const actionIds = blocks
    .filter((block) => block.type === 'actions')
    .flatMap((block) => block.elements.map((element) => element.action_id));
  assert.ok(actionIds.includes('pages_approve_platform_gate'));
  assert.ok(actionIds.includes('pages_reject_platform_gate'));
});

test('platform status notification uses product labels instead of raw internal labels', async () => {
  const calls = [];
  const store = {
    getSlackWorkItemStatusMessage() {
      return null;
    },
    recordSlackWorkItemStatusMessage(kind, id, message) {
      return { id: 'msg_1', workItemKind: kind, workItemId: id, ...message };
    },
    recordAgentRunEvent() {
      return null;
    },
  };
  const item = {
    id: 'pdev_notify',
    status: 'gate_pending',
    title: '调整 gateway worker mysql 流程',
    summary: '调整 gateway worker mysql 和 GitHub Actions 检查。',
    issueType: 'type:ci',
    risk: 'risk:high',
    areas: ['area:gateway', 'area:worker', 'area:ci'],
    slackSessionId: 'sess_notify',
    slackThread: { channelId: 'D1', threadTs: '1710000000.000100' },
  };

  await notifySlackPlatformDevStatus(
    {
      SLACK_NOTIFIER_URL: 'http://slack-notifier.test',
      SLACK_NOTIFIER_SHARED_SECRET: 'secret',
      async SLACK_NOTIFIER_FETCH(url, request) {
        calls.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '1710000001.000200' }), { status: 200 });
      },
    },
    store,
    item
  );

  const payload = JSON.stringify(calls[0].body);
  assert.match(payload, /自动化流程调整/);
  assert.match(payload, /高，需要人工确认/);
  assert.doesNotMatch(payload, /type:ci|risk:high|area:gateway|area:worker/);
  assert.doesNotMatch(payload, /\b(gateway|worker|mysql)\b/i);
});

test('platform failure notification filters internal substrate terms from error copy', async () => {
  const calls = [];
  const store = {
    getSlackWorkItemStatusMessage() {
      return null;
    },
    recordSlackWorkItemStatusMessage(kind, id, message) {
      return { id: 'msg_1', workItemKind: kind, workItemId: id, ...message };
    },
    recordAgentRunEvent() {
      return null;
    },
  };
  const item = {
    id: 'pdev_notify_failed',
    status: 'failed',
    title: '调整 gateway worker mysql 流程',
    summary: '调整 gateway worker mysql 和 GitHub Actions 检查。',
    issueType: 'type:ci',
    risk: 'risk:high',
    areas: ['area:gateway', 'area:worker', 'area:ci'],
    errorMessage: 'gateway worker mysql status card failed',
    slackSessionId: 'sess_notify_failed',
    slackThread: { channelId: 'D1', threadTs: '1710000000.000100' },
  };

  await notifySlackPlatformDevStatus(
    {
      SLACK_NOTIFIER_URL: 'http://slack-notifier.test',
      SLACK_NOTIFIER_SHARED_SECRET: 'secret',
      async SLACK_NOTIFIER_FETCH(url, request) {
        calls.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(JSON.stringify({ ok: true, channel: 'D1', ts: '1710000001.000200' }), { status: 200 });
      },
    },
    store,
    item
  );

  const payload = JSON.stringify(calls[0].body);
  assert.match(payload, /处理失败|平台改造需求/);
  assert.doesNotMatch(payload, /\b(gateway|worker|mysql|status card)\b/i);
});

test('approving high-risk platform gate starts worker for the existing item', async () => {
  const app = createGatewayApp();
  const { item } = app.store.createPlatformDevItem({
    source: 'slack',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'platform-gate-approve',
    title: '平台高风险需求',
    summary: '修改 CI workflow',
    issueType: 'type:ci',
    areas: ['area:ci'],
    risk: 'risk:high',
    agentEligible: true,
    requiresHumanGate: true,
    gateStatus: 'pending',
    slackSessionId: 'sess_gate',
    slackThread: { teamId: 'T1', channelId: 'D1', threadTs: '1710000000.000100', userId: 'U1' },
  });
  app.store.upsertSlackSession({
    id: 'sess_gate',
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1',
    status: 'active',
  });
  app.store.linkPlatformDevItemToSlackSession(item, app.store.getSlackSession('sess_gate'));
  app.store.updatePlatformDevItem(item.id, 'gate_pending');
  const workerCalls = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        interaction(
          'pages_approve_platform_gate',
          JSON.stringify({ workItemKind: 'platform_dev', workItemId: item.id, sessionId: 'sess_gate', gateType: 'risk' })
        )
      ),
    }),
    {
      ...notifierEnv(),
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      PAGES_WORKER_SHARED_SECRET: 'worker-secret',
      async WORKER_FETCH(url, request) {
        workerCalls.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }
  );
  const body = await json(response);
  const updated = app.store.getPlatformDevItem(item.id);

  assert.equal(response.status, 200);
  assert.equal(body.platformDevItemId, item.id);
  assert.equal(updated.gateStatus, 'approved');
  assert.equal(updated.status, 'agent_queued');
  assert.equal(app.store.getWorkItemGate('platform_dev', item.id, 'risk').status, 'approved');
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].body.platformDevItem.id, item.id);
});

test('high-risk platform gate cannot be approved by another Slack user', async () => {
  const app = createGatewayApp();
  const { item } = app.store.createPlatformDevItem({
    source: 'slack',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'platform-gate-actor',
    title: '平台高风险需求',
    summary: '修改 CI workflow',
    issueType: 'type:ci',
    areas: ['area:ci'],
    risk: 'risk:high',
    agentEligible: true,
    requiresHumanGate: true,
    gateStatus: 'pending',
    slackSessionId: 'sess_gate_actor',
    slackThread: { teamId: 'T1', channelId: 'D1', threadTs: '1710000000.000100', userId: 'U1' },
  });
  app.store.upsertSlackSession({
    id: 'sess_gate_actor',
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1',
    status: 'active',
  });
  app.store.linkPlatformDevItemToSlackSession(item, app.store.getSlackSession('sess_gate_actor'));
  app.store.updatePlatformDevItem(item.id, 'gate_pending');
  const workerCalls = [];
  const payload = interaction(
    'pages_approve_platform_gate',
    JSON.stringify({ workItemKind: 'platform_dev', workItemId: item.id, sessionId: 'sess_gate_actor', gateType: 'risk' })
  );
  payload.user.id = 'U2';

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }),
    {
      ...notifierEnv(),
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      PAGES_WORKER_SHARED_SECRET: 'worker-secret',
      async WORKER_FETCH(url, request) {
        workerCalls.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }
  );
  const body = await json(response);
  const updated = app.store.getPlatformDevItem(item.id);

  assert.equal(response.status, 200);
  assert.match(body.text, /不存在，或不属于当前 Slack 用户/);
  assert.equal(updated.gateStatus, 'pending');
  assert.equal(app.store.getWorkItemGate('platform_dev', item.id, 'risk').status, 'pending');
  assert.equal(workerCalls.length, 0);
});

test('rejecting high-risk platform gate closes the item without starting worker', async () => {
  const app = createGatewayApp();
  const { item } = app.store.createPlatformDevItem({
    source: 'slack',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'platform-gate-reject',
    title: '平台高风险需求',
    summary: '修改 CI workflow',
    issueType: 'type:ci',
    areas: ['area:ci'],
    risk: 'risk:high',
    agentEligible: true,
    requiresHumanGate: true,
    gateStatus: 'pending',
    slackSessionId: 'sess_gate_reject',
    slackThread: { teamId: 'T1', channelId: 'D1', threadTs: '1710000000.000100', userId: 'U1' },
  });
  app.store.upsertSlackSession({
    id: 'sess_gate_reject',
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1',
    status: 'active',
  });
  app.store.linkPlatformDevItemToSlackSession(item, app.store.getSlackSession('sess_gate_reject'));
  app.store.updatePlatformDevItem(item.id, 'gate_pending');

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        interaction(
          'pages_reject_platform_gate',
          JSON.stringify({ workItemKind: 'platform_dev', workItemId: item.id, sessionId: 'sess_gate_reject', gateType: 'risk' })
        )
      ),
    }),
    notifierEnv()
  );
  const updated = app.store.getPlatformDevItem(item.id);

  assert.equal(response.status, 200);
  assert.equal(updated.status, 'closed_unmerged');
  assert.equal(updated.gateStatus, 'rejected');
  assert.equal(app.store.getWorkItemGate('platform_dev', item.id, 'risk').status, 'rejected');
});

test('platform executor callback updates PlatformDevItem PR state', async () => {
  const app = createGatewayApp();
  const { item } = app.store.createPlatformDevItem({
    source: 'slack',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'platform-callback',
    title: '平台需求',
    summary: '平台需求',
    issueType: 'type:dev',
    areas: ['area:gateway'],
    risk: 'risk:medium',
    slackThread: { teamId: 'T1', channelId: 'D1', threadTs: '1710000000.000100', userId: 'U1' },
  });

  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        workItemKind: 'platform_dev',
        platformDevItemId: item.id,
        stageResult: 'pr_created',
        prNumber: 44,
        prUrl: 'https://github.example/org/pages-manager/pull/44',
        branchName: 'feat/platform-pdev',
        headSha: 'a'.repeat(40),
      }),
    }),
    notifierEnv()
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.item.status, 'pr_created');
  assert.equal(body.item.githubPrNumber, 44);
  assert.equal(app.store.findPlatformDevItemByPrNumber(44).id, item.id);
});

test('GitHub issue webhook recognizes PlatformDev marker', async () => {
  const app = createGatewayApp();
  const { item } = app.store.createPlatformDevItem({
    source: 'slack',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'platform-webhook',
    title: '平台需求',
    summary: '平台需求',
    issueType: 'type:dev',
    areas: ['area:gateway'],
    risk: 'risk:medium',
    slackThread: { teamId: 'T1', channelId: 'D1', threadTs: '1710000000.000100', userId: 'U1' },
  });
  const payload = {
    action: 'opened',
    repository: { full_name: 'org/pages-manager' },
    issue: {
      number: 51,
      html_url: 'https://github.example/org/pages-manager/issues/51',
      body: `hello\n${platformDevItemMarker(item.id)}`,
    },
  };
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-platform-issue',
        'X-GitHub-Event': 'issues',
      },
      body: JSON.stringify(payload),
    }),
    notifierEnv()
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.issueAction, 'platform_item_recorded');
  assert.equal(body.item.githubIssueNumber, 51);
});
