import assert from 'node:assert/strict';
import test from 'node:test';

import { createSlackAgentApp } from '../../../apps/slack-agent/src/index.js';
import {
  slackPlatformIssueConfirmationBlocks,
  slackPlatformIssueConfirmationText,
} from '../../../apps/gateway/src/slack/issue-confirmation.js';
import { platformDevInput } from '../../../apps/gateway/src/slack/platform-input.js';
import { notifySlackPlatformDevStatus } from '../../../apps/gateway/src/slack/platform-notifier.js';
import { slackWorkItemListBlocks } from '../../../apps/gateway/src/slack/work-items.js';
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

function createOpenPlatformPr(app, options = {}) {
  const { item } = app.store.createPlatformDevItem({
    source: 'slack',
    requestedById: 'slack:T1:U1',
    idempotencyKey: options.idempotencyKey || `platform-pr-${options.prNumber || 90}`,
    title: options.title || '平台需求',
    summary: options.summary || '平台需求',
    issueType: options.issueType || 'type:dev',
    areas: options.areas || ['area:platform'],
    risk: options.risk || 'risk:medium',
    agentEligible: options.agentEligible ?? true,
    requiresHumanGate: options.requiresHumanGate ?? false,
    gateStatus: options.gateStatus || 'not_required',
    slackSessionId: options.slackSessionId || 'sess_platform_pr',
    slackSessionKey: 'dm:D1',
    slackThread: { teamId: 'T1', channelId: 'D1', threadTs: '1710000000.000100', userId: 'U1' },
  });
  app.store.upsertSlackSession({
    id: options.slackSessionId || 'sess_platform_pr',
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1',
    channelId: 'D1',
    dmChannelId: 'D1',
    threadTs: '1710000000.000100',
    activeContextExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: 'active',
  });
  let updated = app.store.updatePlatformDevItem(item.id, 'issue_created', {
    githubIssueNumber: options.issueNumber || 80,
    githubIssueUrl: `https://github.example/org/pages-manager/issues/${options.issueNumber || 80}`,
  });
  updated = app.store.updatePlatformDevItem(updated.id, 'agent_queued');
  updated = app.store.updatePlatformDevItem(updated.id, 'agent_running');
  updated = app.store.updatePlatformDevItem(updated.id, 'branch_committed');
  updated = app.store.updatePlatformDevItem(updated.id, 'pr_created', {
    githubPrNumber: options.prNumber || 90,
    githubPrUrl: `https://github.example/org/pages-manager/pull/${options.prNumber || 90}`,
    branchName: options.branchName || 'platform/item-pdev',
    headSha: options.headSha || 'b'.repeat(40),
  });
  app.store.linkPlatformDevItemToSlackSession(updated, app.store.getSlackSession(options.slackSessionId || 'sess_platform_pr'));
  return updated;
}

function latestSlackStatusBlocks(notifierCalls = []) {
  const call = notifierCalls
    .filter((item) => ['/internal/slack-notifier/message', '/internal/slack-notifier/update'].includes(item.path))
    .filter((item) => item.body?.payload?.blocks?.length)
    .at(-1);
  return JSON.stringify(call?.body?.payload?.blocks || []);
}

test('platform question input cannot be forced into agent dispatch by model output', () => {
  const input = platformDevInput({
    team_id: 'T1',
    event_id: 'Ev-platform-question',
    event: {
      type: 'message',
      user: 'U1',
      channel: 'D1',
      channel_type: 'im',
      ts: '1710000000.000100',
      text: '目前这个对话的 sessions 是保存在哪里？',
    },
    slackAgentAnalysis: {
      lane: 'platform-dev',
      intent: 'create_platform_issue',
      issueType: 'type:question',
      risk: 'risk:medium',
      agentEligible: true,
      requiresHumanGate: true,
      summary: '目前这个对话的 sessions 是保存在哪里？',
    },
  });

  assert.equal(input.issueType, 'type:question');
  assert.equal(input.agentEligible, false);
  assert.equal(input.requiresHumanGate, false);
  assert.equal(input.gateStatus, 'not_required');
});

test('platform question confirmation card does not promise automatic development', () => {
  const analysis = {
    title: '目前这个对话的 sessions 是保存在哪里？',
    summary: '目前这个对话的 sessions 是保存在哪里？',
    issueType: 'type:question',
    risk: 'risk:medium',
    agentEligible: true,
  };
  const text = slackPlatformIssueConfirmationText(analysis);
  const blocks = slackPlatformIssueConfirmationBlocks({ id: 'sess_question' }, analysis);
  const serializedBlocks = JSON.stringify(blocks);

  assert.match(text, /不会启动自动开发/);
  assert.match(serializedBlocks, /不会启动自动开发/);
  assert.doesNotMatch(text, /进入后续处理/);
});

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

test('platform task list uses product labels instead of raw internal labels', () => {
  const blocks = slackWorkItemListBlocks(
    { id: 'sess_list' },
    [
      {
        id: 'pdev_list',
        workItemKind: 'platform_dev',
        status: 'gate_pending',
        title: '调整 gateway worker mysql 流程',
        summary: '调整 gateway worker mysql 和 GitHub Actions 检查。',
        issueType: 'type:ci',
        risk: 'risk:high',
        areas: ['area:gateway', 'area:worker', 'area:ci'],
        issueNumber: 77,
      },
    ]
  );
  const payload = JSON.stringify(blocks);

  assert.match(payload, /自动化流程调整/);
  assert.match(payload, /高，需要人工确认/);
  assert.match(payload, /平台入口/);
  assert.match(payload, /后台处理/);
  assert.match(payload, /自动化流程/);
  assert.doesNotMatch(payload, /type:ci|risk:high|area:gateway|area:worker/);
  assert.doesNotMatch(payload, /\b(gateway|worker|mysql)\b/i);
  assert.doesNotMatch(payload, /你的发布任务|PR \/ Preview/);
});

test('platform diagnosis reports blocker without leaking substrate terms', async () => {
  const app = createGatewayApp();
  const item = createOpenPlatformPr(app, {
    title: '调整 gateway worker mysql 流程',
    summary: '调整 gateway worker mysql 和 GitHub Actions 检查。',
    issueType: 'type:ci',
    risk: 'risk:high',
    gateStatus: 'approved',
  });
  app.store.updatePlatformDevItem(item.id, 'ci_running');
  app.store.updatePlatformDevItem(item.id, 'ci_failed', {
    errorMessage: 'gateway worker mysql status card failed',
  });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackEvent('为什么没成功？帮我查一下日志', 'Ev-platform-diagnosis')),
    }),
    { SLACK_EVENTS_PROCESSING_MODE: 'sync', ...deterministicSlackAgentEnv() }
  );
  const body = await json(response);
  const payload = JSON.stringify(body);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'diagnose_work_item');
  assert.match(body.replyText, /任务诊断|当前状态|CI 未通过|建议操作|关联日志/);
  assert.match(payload, /查看 Issue|查看 PR|重试|追加诊断到 Issue|转人工排查/);
  assert.doesNotMatch(payload, /\b(gateway|worker|mysql|status card)\b/i);
});

test('model-requested retry returns diagnosis confirmation instead of dispatching immediately', async () => {
  const app = createGatewayApp();
  const item = createOpenPlatformPr(app, {
    slackSessionId: 'sess_diagnosis_retry_confirm',
    issueType: 'type:ci',
    risk: 'risk:high',
    gateStatus: 'approved',
  });
  app.store.updatePlatformDevItem(item.id, 'ci_running');
  app.store.updatePlatformDevItem(item.id, 'ci_failed', {
    errorMessage: 'workflow failed',
  });
  const workerCalls = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackEvent('重试这个任务', 'Ev-platform-retry-confirm')),
    }),
    {
      SLACK_EVENTS_PROCESSING_MODE: 'sync',
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      SLACK_AGENT_SHARED_SECRET: 'agent-secret',
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      PAGES_WORKER_SHARED_SECRET: 'worker-secret',
      async WORKER_FETCH(url, request) {
        workerCalls.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
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
                intent: 'retry_work_item',
                summary: '重试这个任务',
                needsClarification: false,
                toolCall: { name: 'request_retry_work_item', args: {} },
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
  const payload = JSON.stringify(body);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'diagnose_work_item');
  assert.equal(app.store.getPlatformDevItem(item.id).status, 'ci_failed');
  assert.equal(workerCalls.length, 0);
  assert.match(payload, /重试|追加诊断到 Issue|转人工排查/);
});

test('append diagnosis button writes a scoped GitHub issue comment', async () => {
  const app = createGatewayApp();
  const githubCalls = [];
  const notifierCalls = [];
  const item = createOpenPlatformPr(app, {
    slackSessionId: 'sess_diagnosis_append',
    issueType: 'type:ci',
    risk: 'risk:high',
  });
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        interaction(
          'pages_request_append_diagnosis',
          JSON.stringify({ sessionId: 'sess_diagnosis_append', workItemKind: 'platform_dev', workItemId: item.id })
        )
      ),
    }),
    {
      ...notifierEnv(notifierCalls),
      GITHUB_REPOSITORY: 'org/pages-manager',
      GITHUB_TOKEN: 'github-token',
      async GITHUB_FETCH(url, request) {
        githubCalls.push({ url: String(url), body: JSON.parse(request.body), request });
        return new Response(
          JSON.stringify({
            id: 123,
            html_url: 'https://github.example/org/pages-manager/issues/80#issuecomment-123',
          }),
          { status: 201 }
        );
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.match(body.text, /已把诊断摘要追加到 Issue #80/);
  assert.equal(body.action, 'append_diagnosis_comment');
  assert.equal(body.accepted, true);
  assert.equal(githubCalls.length, 1);
  assert.match(githubCalls[0].url, /\/repos\/org\/pages-manager\/issues\/80\/comments$/);
  assert.match(githubCalls[0].body.body, /## Slack 任务诊断/);
  assert.match(githubCalls[0].body.body, /当前状态|Issue|PR|建议操作/);
  assert.doesNotMatch(githubCalls[0].body.body, /\b(gateway|worker|mysql|status card)\b/i);
  const updateCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/update');
  assert.ok(updateCall);
  assert.match(JSON.stringify(updateCall.body.payload), /诊断已追加/);
  assert.match(JSON.stringify(updateCall.body.payload), /open_issue|open_pr/);
  assert.doesNotMatch(JSON.stringify(updateCall.body.payload), /pages_request_append_diagnosis/);
});

test('append diagnosis button does not use status-only GitHub token for issue comments', async () => {
  const app = createGatewayApp();
  const githubCalls = [];
  const item = createOpenPlatformPr(app, {
    slackSessionId: 'sess_diagnosis_append_status_token',
    issueType: 'type:ci',
    risk: 'risk:high',
  });
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        interaction(
          'pages_request_append_diagnosis',
          JSON.stringify({
            sessionId: 'sess_diagnosis_append_status_token',
            workItemKind: 'platform_dev',
            workItemId: item.id,
          })
        )
      ),
    }),
    {
      ...notifierEnv(),
      GITHUB_REPOSITORY: 'org/pages-manager',
      GITHUB_STATUS_TOKEN: 'status-token',
      async GITHUB_FETCH(url, request) {
        githubCalls.push({ url: String(url), body: JSON.parse(request.body), request });
        return new Response(JSON.stringify({ id: 125 }), { status: 201 });
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'append_diagnosis_comment_failed');
  assert.equal(body.accepted, false);
  assert.match(body.text, /GitHub 写入暂未配置/);
  assert.equal(githubCalls.length, 0);
});

test('retry diagnosis button dispatches a scoped platform fix round', async () => {
  const app = createGatewayApp();
  const workerCalls = [];
  const notifierCalls = [];
  const item = createOpenPlatformPr(app, {
    slackSessionId: 'sess_diagnosis_retry',
    issueType: 'type:ci',
    risk: 'risk:high',
    gateStatus: 'approved',
  });
  app.store.updatePlatformDevItem(item.id, 'ci_running');
  app.store.updatePlatformDevItem(item.id, 'ci_failed', {
    errorMessage: 'workflow failed',
  });
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        interaction(
          'pages_request_retry_work_item',
          JSON.stringify({ sessionId: 'sess_diagnosis_retry', workItemKind: 'platform_dev', workItemId: item.id })
        )
      ),
    }),
    {
      ...notifierEnv(notifierCalls),
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      PAGES_WORKER_SHARED_SECRET: 'worker-secret',
      async WORKER_FETCH(url, request) {
        workerCalls.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(JSON.stringify({ ok: true, result: { action: 'platform_agent_fix_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);
  const updated = app.store.getPlatformDevItem(item.id);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'retry_work_item');
  assert.equal(body.accepted, true);
  assert.equal(updated.status, 'agent_queued');
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].body.workItemKind, 'platform_dev');
  assert.equal(workerCalls[0].body.platformDevItem.id, item.id);
  assert.ok(app.store.listAgentRunEventsForWorkItem('platform_dev', item.id).some((event) => event.stage === 'agent_queued'));
  const updateCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/update');
  assert.ok(updateCall);
  assert.match(JSON.stringify(updateCall.body.payload), /已请求重试/);
  assert.match(JSON.stringify(updateCall.body.payload), /open_issue|open_pr/);
  assert.doesNotMatch(JSON.stringify(updateCall.body.payload), /pages_request_retry_work_item/);
});

test('human triage button records the request and writes a scoped issue comment', async () => {
  const app = createGatewayApp();
  const githubCalls = [];
  const notifierCalls = [];
  const item = createOpenPlatformPr(app, {
    slackSessionId: 'sess_diagnosis_triage',
    issueType: 'type:ci',
    risk: 'risk:high',
  });
  app.store.updatePlatformDevItem(item.id, 'ci_running');
  app.store.updatePlatformDevItem(item.id, 'ci_failed', {
    errorMessage: 'workflow failed',
  });
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        interaction(
          'pages_request_human_triage',
          JSON.stringify({ sessionId: 'sess_diagnosis_triage', workItemKind: 'platform_dev', workItemId: item.id })
        )
      ),
    }),
    {
      ...notifierEnv(notifierCalls),
      GITHUB_REPOSITORY: 'org/pages-manager',
      GITHUB_TOKEN: 'github-token',
      async GITHUB_FETCH(url, request) {
        githubCalls.push({ url: String(url), body: JSON.parse(request.body), request });
        return new Response(
          JSON.stringify({
            id: 124,
            html_url: 'https://github.example/org/pages-manager/issues/80#issuecomment-124',
          }),
          { status: 201 }
        );
      },
    }
  );
  const body = await json(response);
  const events = app.store.listAgentRunEventsForWorkItem('platform_dev', item.id);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'human_triage');
  assert.match(body.text, /已标记为需要人工排查/);
  assert.equal(githubCalls.length, 1);
  assert.match(githubCalls[0].url, /\/repos\/org\/pages-manager\/issues\/80\/comments$/);
  assert.match(githubCalls[0].body.body, /## 请求人工排查/);
  assert.doesNotMatch(githubCalls[0].body.body, /\b(gateway|worker|mysql|status card)\b/i);
  assert.ok(events.some((event) => event.type === 'human_triage_requested'));
  const updateCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/update');
  assert.ok(updateCall);
  assert.match(JSON.stringify(updateCall.body.payload), /已请求人工排查/);
  assert.match(JSON.stringify(updateCall.body.payload), /open_issue|open_pr/);
  assert.doesNotMatch(JSON.stringify(updateCall.body.payload), /pages_request_human_triage/);
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
  const notifierCalls = [];

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
      ...notifierEnv(notifierCalls),
      PAGES_PLATFORM_GATE_APPROVERS: 'slack:T1:U1',
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
  const updateCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/update');
  assert.ok(updateCall);
  assert.match(JSON.stringify(updateCall.body.payload), /自动开发已批准/);
  assert.doesNotMatch(JSON.stringify(updateCall.body.payload), /pages_approve_platform_gate|pages_reject_platform_gate/);
});

test('high-risk platform gate approval fails closed without approver allowlist', async () => {
  const app = createGatewayApp();
  const { item } = app.store.createPlatformDevItem({
    source: 'slack',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'platform-gate-allowlist-missing',
    title: '平台高风险需求',
    summary: '修改 CI workflow',
    issueType: 'type:ci',
    areas: ['area:ci'],
    risk: 'risk:high',
    agentEligible: true,
    requiresHumanGate: true,
    gateStatus: 'pending',
    slackSessionId: 'sess_gate_allowlist_missing',
    slackThread: { teamId: 'T1', channelId: 'D1', threadTs: '1710000000.000100', userId: 'U1' },
  });
  app.store.upsertSlackSession({
    id: 'sess_gate_allowlist_missing',
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1',
    status: 'active',
  });
  app.store.linkPlatformDevItemToSlackSession(item, app.store.getSlackSession('sess_gate_allowlist_missing'));
  app.store.updatePlatformDevItem(item.id, 'gate_pending');
  const workerCalls = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        interaction(
          'pages_approve_platform_gate',
          JSON.stringify({
            workItemKind: 'platform_dev',
            workItemId: item.id,
            sessionId: 'sess_gate_allowlist_missing',
            gateType: 'risk',
          })
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
  assert.match(body.text, /指定维护者批准/);
  assert.equal(updated.status, 'gate_pending');
  assert.equal(updated.gateStatus, 'pending');
  assert.equal(app.store.getWorkItemGate('platform_dev', item.id, 'risk').status, 'pending');
  assert.equal(workerCalls.length, 0);
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
  const notifierCalls = [];

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
    notifierEnv(notifierCalls)
  );
  const updated = app.store.getPlatformDevItem(item.id);

  assert.equal(response.status, 200);
  assert.equal(updated.status, 'closed_unmerged');
  assert.equal(updated.gateStatus, 'rejected');
  assert.equal(app.store.getWorkItemGate('platform_dev', item.id, 'risk').status, 'rejected');
  const updateCall = notifierCalls.find((call) => call.path === '/internal/slack-notifier/update');
  assert.ok(updateCall);
  assert.match(JSON.stringify(updateCall.body.payload), /自动开发已停止/);
  assert.doesNotMatch(JSON.stringify(updateCall.body.payload), /pages_approve_platform_gate|pages_reject_platform_gate/);
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

test('Slack follow-up on an active platform PR dispatches a fix round', async () => {
  const app = createGatewayApp();
  const item = createOpenPlatformPr(app, {
    idempotencyKey: 'platform-followup-pr',
    issueNumber: 81,
    prNumber: 91,
    slackSessionId: 'sess_platform_followup',
  });
  const workerCalls = [];
  const githubCalls = [];
  const notifierCalls = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackEvent('继续修改：文案再克制一些', 'Ev-platform-followup-1')),
    }),
    {
      ...notifierEnv(notifierCalls),
      GITHUB_REPO: 'org/pages-manager',
      GITHUB_TOKEN: 'ghs_test',
      async GITHUB_FETCH(url, request) {
        githubCalls.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(JSON.stringify({ id: 901, html_url: 'https://github.example/comment/901' }), {
          status: 201,
        });
      },
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      PAGES_WORKER_SHARED_SECRET: 'worker-secret',
      async WORKER_FETCH(url, request) {
        workerCalls.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(JSON.stringify({ ok: true, result: { action: 'platform_agent_fix_dispatched' } }), {
          status: 200,
        });
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
                intent: 'modify_existing_preview',
                summary: '文案再克制一些',
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
  const updated = app.store.getPlatformDevItem(item.id);
  const memory = app.store.getSessionMemory('sess_platform_followup');

  assert.equal(response.status, 200);
  assert.equal(body.action, 'platform_followup_fix_dispatched');
  assert.equal(updated.status, 'agent_queued');
  assert.match(updated.summary, /Slack Follow-up/);
  assert.equal(memory.lastAgentResponse, body.replyText);
  assert.equal(memory.conversationContext.lastAssistantMessage.text, body.replyText);
  assert.match(memory.conversationContext.recentTurns.at(-1).text, /已追加到 Issue|已记录/);
  assert.equal(githubCalls.length, 1);
  assert.match(githubCalls[0].url, /\/repos\/org\/pages-manager\/issues\/81\/comments$/);
  assert.match(githubCalls[0].body.body, /文案再克制一些/);
  assert.match(githubCalls[0].body.body, /Agent mode: followup/);
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].body.workItemKind, 'platform_dev');
  assert.equal(workerCalls[0].body.platformDevItem.id, item.id);
  const blocks = latestSlackStatusBlocks(notifierCalls);
  assert.match(blocks, /本轮补充/);
  assert.match(blocks, /文案再克制一些/);
});

test('Slack platform follow-up does not use status-only GitHub token for issue comments', async () => {
  const app = createGatewayApp();
  const item = createOpenPlatformPr(app, {
    idempotencyKey: 'platform-followup-status-token',
    issueNumber: 87,
    prNumber: 97,
    slackSessionId: 'sess_platform_followup_status_token',
  });
  const workerCalls = [];
  const githubCalls = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackEvent('继续修改：补充状态 token 不应写 issue', 'Ev-platform-followup-status-token')),
    }),
    {
      SLACK_EVENTS_PROCESSING_MODE: 'sync',
      ...notifierEnv(),
      GITHUB_REPO: 'org/pages-manager',
      GITHUB_STATUS_TOKEN: 'status-token',
      async GITHUB_FETCH(url, request) {
        githubCalls.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(JSON.stringify({ id: 987 }), { status: 201 });
      },
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      PAGES_WORKER_SHARED_SECRET: 'worker-secret',
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      SLACK_AGENT_SHARED_SECRET: 'agent-secret',
      async WORKER_FETCH(url, request) {
        workerCalls.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(JSON.stringify({ ok: true, result: { action: 'platform_agent_fix_dispatched' } }), {
          status: 200,
        });
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
                intent: 'append_requirement',
                summary: '补充状态 token 不应写 issue',
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
  const updated = app.store.getPlatformDevItem(item.id);

  assert.equal(response.status, 200);
  assert.equal(body.action, 'platform_followup_fix_dispatched');
  assert.equal(updated.status, 'agent_queued');
  assert.equal(githubCalls.length, 0);
  assert.equal(workerCalls.length, 1);
});

test('Slack follow-up continues the failed platform issue instead of creating a duplicate issue', async () => {
  const app = createGatewayApp();
  app.store.upsertSlackSession({
    id: 'sess_platform_failed_followup',
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1',
    channelId: 'D1',
    dmChannelId: 'D1',
    threadTs: '1710000000.000100',
    activeContextExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: 'active',
  });
  const { item } = app.store.createPlatformDevItem({
    source: 'slack',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'platform-failed-followup',
    title: '修改 README',
    summary: '修改 README.md',
    issueType: 'type:dev',
    areas: ['area:docs'],
    risk: 'risk:medium',
    agentEligible: true,
    requiresHumanGate: false,
    gateStatus: 'not_required',
    slackSessionId: 'sess_platform_failed_followup',
    slackSessionKey: 'dm:D1',
    slackThread: { teamId: 'T1', channelId: 'D1', threadTs: '1710000000.000100', userId: 'U1' },
  });
  let updated = app.store.updatePlatformDevItem(item.id, 'issue_created', {
    githubIssueNumber: 91,
    githubIssueUrl: 'https://github.example/org/pages-manager/issues/91',
  });
  app.store.linkPlatformDevItemToSlackSession(updated, app.store.getSlackSession('sess_platform_failed_followup'));
  updated = app.store.updatePlatformDevItem(updated.id, 'agent_queued');
  updated = app.store.updatePlatformDevItem(updated.id, 'agent_running');
  updated = app.store.updatePlatformDevItem(updated.id, 'failed', {
    errorMessage: 'Workflow failed before PR creation.',
  });
  app.store.upsertSlackSession({
    ...app.store.getSlackSession('sess_platform_failed_followup'),
    activeWorkItemKind: null,
    activeWorkItemId: null,
    activeIssueNumber: null,
    activePrNumber: null,
    activePreviewUrl: null,
  });

  const workerCalls = [];
  const githubCalls = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        slackEvent('不再修改 README.md；改为在仓库中新增 DIY.md，文件内容只需要一个标题。', 'Ev-platform-failed-followup')
      ),
    }),
    {
      SLACK_EVENTS_PROCESSING_MODE: 'sync',
      ...notifierEnv(),
      GITHUB_REPO: 'org/pages-manager',
      GITHUB_TOKEN: 'ghs_test',
      SLACK_AGENT_TURN_URL: 'http://slack-agent.test/internal/slack-agent/turn',
      SLACK_AGENT_SHARED_SECRET: 'agent-secret',
      async GITHUB_FETCH(url, request) {
        githubCalls.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(JSON.stringify({ id: 910, html_url: 'https://github.example/comment/910' }), {
          status: 201,
        });
      },
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      PAGES_WORKER_SHARED_SECRET: 'worker-secret',
      async WORKER_FETCH(url, request) {
        workerCalls.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(JSON.stringify({ ok: true, result: { action: 'platform_agent_fix_dispatched' } }), {
          status: 200,
        });
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
                lane: 'platform-dev',
                intent: 'create_platform_issue',
                summary: payload.text,
                needsClarification: false,
                toolCall: { name: 'confirm_platform_issue', args: { title: '错误的新 issue' } },
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
  const finalItem = app.store.getPlatformDevItem(item.id);
  const platformItems = [...app.store.platformDevItems.values()];

  assert.equal(response.status, 200);
  assert.equal(body.action, 'platform_followup_fix_dispatched');
  assert.equal(platformItems.length, 1);
  assert.equal(finalItem.status, 'agent_queued');
  assert.match(finalItem.summary, /DIY\.md/);
  assert.equal(app.store.getSlackSession('sess_platform_failed_followup').activeWorkItemId, item.id);
  assert.equal(githubCalls.length, 1);
  assert.match(githubCalls[0].url, /\/repos\/org\/pages-manager\/issues\/91\/comments$/);
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].body.platformDevItem.id, item.id);
  assert.notEqual(body.action, 'confirm_before_platform_issue');
});

test('Slack platform follow-up reports issue comment and worker startup failure visibly', async () => {
  const app = createGatewayApp();
  const item = createOpenPlatformPr(app, {
    idempotencyKey: 'platform-followup-worker-failure',
    issueNumber: 86,
    prNumber: 96,
    slackSessionId: 'sess_platform_followup_failure',
  });
  const githubCalls = [];
  const notifierCalls = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(slackEvent('继续补充：也要改 AGENTS.md 里的 CF 说明', 'Ev-platform-followup-failure')),
    }),
    {
      ...notifierEnv(notifierCalls),
      GITHUB_REPO: 'org/pages-manager',
      GITHUB_TOKEN: 'ghs_test',
      async GITHUB_FETCH(url, request) {
        githubCalls.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(JSON.stringify({ id: 902, html_url: 'https://github.example/comment/902' }), {
          status: 201,
        });
      },
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      PAGES_WORKER_SHARED_SECRET: 'worker-secret',
      async WORKER_FETCH() {
        return new Response(JSON.stringify({ ok: false, error: 'GitHub request failed: Not Found' }), {
          status: 500,
        });
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
                intent: 'append_requirement',
                summary: '也要改 AGENTS.md 里的 CF 说明',
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
  assert.equal(body.action, 'platform_followup_fix_ready');
  assert.equal(body.noReply, false);
  assert.match(body.replyText, /已追加到 Issue/);
  assert.match(body.replyText, /workflow 还不可用/);
  assert.equal(githubCalls.length, 1);
  assert.match(githubCalls[0].body.body, /AGENTS\.md/);
  const blocks = latestSlackStatusBlocks(notifierCalls);
  assert.match(blocks, /自动开发暂未启动/);
  assert.match(blocks, /AGENTS\.md/);
  assert.equal(app.store.getPlatformDevItem(item.id).status, 'agent_queued');
});

test('platform CI failure dispatches an automatic fix round', async () => {
  const app = createGatewayApp();
  const headSha = 'c'.repeat(40);
  const item = createOpenPlatformPr(app, {
    idempotencyKey: 'platform-ci-fix',
    issueNumber: 82,
    prNumber: 92,
    headSha,
    slackSessionId: 'sess_platform_ci_fix',
  });
  const workerCalls = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-platform-ci-failure',
        'X-GitHub-Event': 'check_run',
      },
      body: JSON.stringify({
        action: 'completed',
        repository: { full_name: 'org/pages-manager' },
        check_run: {
          id: 9201,
          node_id: 'SCR_PLATFORM_9201',
          name: 'site-check',
          status: 'completed',
          conclusion: 'failure',
          head_sha: headSha,
          app: { slug: 'github-actions', name: 'GitHub Actions' },
          pull_requests: [{ number: 92 }],
        },
        sender: { login: 'github-actions[bot]' },
      }),
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
  assert.equal(body.reviewAction, 'platform_ci_fix_dispatched');
  assert.equal(updated.status, 'agent_queued');
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].body.platformDevItem.id, item.id);
});

test('platform blocking review dispatches an automatic fix round', async () => {
  const app = createGatewayApp();
  const headSha = 'd'.repeat(40);
  const item = createOpenPlatformPr(app, {
    idempotencyKey: 'platform-review-fix',
    issueNumber: 83,
    prNumber: 93,
    headSha,
    slackSessionId: 'sess_platform_review_fix',
  });
  const workerCalls = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-platform-review-blocking',
        'X-GitHub-Event': 'pull_request_review',
      },
      body: JSON.stringify({
        action: 'submitted',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 93, head: { sha: headSha } },
        review: {
          id: 9301,
          node_id: 'PRR_PLATFORM_9301',
          state: 'changes_requested',
          body: '必须修复阻塞问题。',
          user: { login: 'chatgpt-codex-connector' },
        },
        sender: { login: 'chatgpt-codex-connector' },
      }),
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
  assert.equal(body.reviewAction, 'platform_review_fix_dispatched');
  assert.equal(updated.status, 'agent_queued');
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].body.platformDevItem.id, item.id);
});

test('platform blocking review recovers a failed PR item and dispatches a fix round', async () => {
  const app = createGatewayApp();
  const headSha = '9'.repeat(40);
  const item = createOpenPlatformPr(app, {
    idempotencyKey: 'platform-review-fix-after-failed',
    issueNumber: 88,
    prNumber: 98,
    headSha,
    slackSessionId: 'sess_platform_review_failed_fix',
  });
  app.store.updateSessionMemory('sess_platform_review_failed_fix', {
    summary: '用户希望失败后仍能继续处理 Review blocking comment。',
  });
  const failed = app.store.updatePlatformDevItem(item.id, 'failed', {
    errorCode: 'platform_agent_failed',
    errorMessage: 'previous platform-agent.yml run failed',
  });
  assert.equal(failed.status, 'failed');
  const workerCalls = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-platform-review-failed-blocking',
        'X-GitHub-Event': 'pull_request_review',
      },
      body: JSON.stringify({
        action: 'submitted',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 98, head: { sha: headSha } },
        review: {
          id: 9801,
          node_id: 'PRR_PLATFORM_9801',
          state: 'changes_requested',
          body: 'blocking: README 说明还没有补齐。',
          user: { login: 'chatgpt-codex-connector' },
        },
        sender: { login: 'chatgpt-codex-connector' },
      }),
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
  assert.equal(body.reviewAction, 'platform_review_fix_dispatched');
  assert.equal(updated.status, 'agent_queued');
  assert.equal(updated.errorCode, null);
  assert.equal(workerCalls.length, 1);
  assert.equal(workerCalls[0].body.platformDevItem.id, item.id);
  assert.equal(workerCalls[0].body.platformDevItem.githubPrNumber, 98);
  assert.equal(workerCalls[0].body.platformDevItem.headSha, headSha);
  assert.match(workerCalls[0].body.platformDevItem.reviewContext, /README 说明还没有补齐/);
  assert.match(workerCalls[0].body.platformDevItem.memoryContext, /失败后仍能继续处理 Review/);
  assert.match(workerCalls[0].body.platformDevItem.statusContext, /failed -> review_blocked/);
});

test('stale platform CI failure does not regress an active fix round', async () => {
  const app = createGatewayApp();
  const headSha = 'e'.repeat(40);
  const item = createOpenPlatformPr(app, {
    idempotencyKey: 'platform-ci-stale',
    issueNumber: 84,
    prNumber: 94,
    headSha,
    slackSessionId: 'sess_platform_ci_stale',
  });
  const queued = app.store.updatePlatformDevItem(item.id, 'agent_queued');
  const workerCalls = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-platform-ci-stale',
        'X-GitHub-Event': 'check_run',
      },
      body: JSON.stringify({
        action: 'completed',
        repository: { full_name: 'org/pages-manager' },
        check_run: {
          id: 9401,
          node_id: 'SCR_PLATFORM_9401',
          name: 'site-check',
          status: 'completed',
          conclusion: 'failure',
          head_sha: headSha,
          app: { slug: 'github-actions', name: 'GitHub Actions' },
          pull_requests: [{ number: 94 }],
        },
        sender: { login: 'github-actions[bot]' },
      }),
    }),
    {
      ...notifierEnv(),
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerCalls.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }
  );
  const body = await json(response);
  const updated = app.store.getPlatformDevItem(queued.id);

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'platform_ci_stale_ignored');
  assert.equal(updated.status, 'agent_queued');
  assert.equal(workerCalls.length, 0);
});

test('stale platform blocking review does not regress an active fix round', async () => {
  const app = createGatewayApp();
  const headSha = 'f'.repeat(40);
  const item = createOpenPlatformPr(app, {
    idempotencyKey: 'platform-review-stale',
    issueNumber: 85,
    prNumber: 95,
    headSha,
    slackSessionId: 'sess_platform_review_stale',
  });
  const queued = app.store.updatePlatformDevItem(item.id, 'agent_queued');
  const workerCalls = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-platform-review-stale',
        'X-GitHub-Event': 'pull_request_review',
      },
      body: JSON.stringify({
        action: 'submitted',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 95, head: { sha: headSha } },
        review: {
          id: 9501,
          node_id: 'PRR_PLATFORM_9501',
          state: 'changes_requested',
          body: '旧 review 阻塞意见。',
          user: { login: 'chatgpt-codex-connector' },
        },
        sender: { login: 'chatgpt-codex-connector' },
      }),
    }),
    {
      ...notifierEnv(),
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerCalls.push({ url: String(url), body: JSON.parse(request.body) });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }
  );
  const body = await json(response);
  const updated = app.store.getPlatformDevItem(queued.id);

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'platform_review_stale_ignored');
  assert.equal(updated.status, 'agent_queued');
  assert.equal(workerCalls.length, 0);
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
