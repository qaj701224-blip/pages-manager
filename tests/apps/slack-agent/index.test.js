import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readSlackAgentConfig } from '../../../apps/slack-agent/src/config.js';
import { analyzeSlackRequirement, createSlackAgentApp } from '../../../apps/slack-agent/src/index.js';
import { redactSlackAgentLogValue } from '../../../apps/slack-agent/src/model-provider.js';
import {
  analyzeSlackRequirementDeterministic,
  buildSlackAgentMessages,
  normalizeModelAnalysis,
} from '../../../apps/slack-agent/src/analysis.js';
import { SLACK_AGENT_POLICY_PACKAGE_VERSION } from '../../../apps/slack-agent/src/policy/package.js';

describe('slack agent', () => {
  it('summarizes create or update site requests', () => {
    const analysis = analyzeSlackRequirement({
      employeeSlug: 'alice',
      siteSlug: 'portfolio',
      text: '创建一个个人网站，突出项目经历',
    });

    assert.equal(analysis.intent, 'create_or_update_site');
    assert.equal(analysis.employeeSlug, 'alice');
    assert.equal(analysis.siteSlug, 'portfolio');
    assert.equal(analysis.needsClarification, false);
    assert.equal(analysis.toolCall.name, 'confirm_create_issue');
    assert.match(analysis.summary, /个人网站/);
  });

  it('routes pages-manager repository changes to platform dev lane', () => {
    const analysis = analyzeSlackRequirement({
      text: '通过 Slack 创建 pages-manager 自身的开发 issue，并让 GitHub PR 进度回写到 Slack',
    });

    assert.equal(analysis.lane, 'platform-dev');
    assert.equal(analysis.intent, 'create_platform_issue');
    assert.equal(analysis.toolCall.name, 'confirm_platform_issue');
    assert.equal(analysis.issueType, 'type:dev');
    assert.deepEqual(analysis.areas, ['area:github', 'area:slack']);
    assert.equal(analysis.risk, 'risk:medium');
    assert.equal(analysis.agentEligible, true);
    assert.equal(analysis.requiresHumanGate, false);
  });

  it('marks CI and ops platform requests as high risk with human gate', () => {
    const analysis = analyzeSlackRequirement({
      text: '修改 pages-manager 的 CI workflow 和 ECS 部署脚本',
    });

    assert.equal(analysis.lane, 'platform-dev');
    assert.equal(analysis.intent, 'create_platform_issue');
    assert.equal(analysis.issueType, 'type:ci');
    assert.equal(analysis.risk, 'risk:high');
    assert.equal(analysis.requiresHumanGate, true);
    assert.ok(analysis.areas.includes('area:ci'));
    assert.ok(analysis.areas.includes('area:ops'));
  });

  it('routes repo implementation questions to read-only repo answer tool', () => {
    const analysis = analyzeSlackRequirement({
      text: '目前这种对话的 sessions 是怎么保存的？',
    });

    assert.equal(analysis.lane, 'repo-question');
    assert.equal(analysis.intent, 'repo_question');
    assert.equal(analysis.needsClarification, false);
    assert.deepEqual(analysis.toolCall, {
      name: 'answer_repo_question',
      args: { question: '目前这种对话的 sessions 是怎么保存的？' },
    });
  });

  it('keeps consultative repo questions out of platform issue creation even with change words', () => {
    const analysis = analyzeSlackRequirement({
      text: '如果后续要修改 CI workflow，会影响原先 CF 那条线吗？',
    });

    assert.equal(analysis.lane, 'repo-question');
    assert.equal(analysis.intent, 'repo_question');
    assert.deepEqual(analysis.toolCall, {
      name: 'answer_repo_question',
      args: { question: '如果后续要修改 CI workflow，会影响原先 CF 那条线吗？' },
    });
  });

  it('keeps implementation plan questions as repo consultation before explicit confirmation', () => {
    const analysis = analyzeSlackRequirement({
      text: '如果要支持 Slack Agent 读取当前 repo 代码，应该怎么实现？',
    });

    assert.equal(analysis.lane, 'repo-question');
    assert.equal(analysis.intent, 'repo_question');
    assert.deepEqual(analysis.toolCall, {
      name: 'answer_repo_question',
      args: { question: '如果要支持 Slack Agent 读取当前 repo 代码，应该怎么实现？' },
    });
  });

  it('tells the model to treat conditional implementation language as consultation', () => {
    const fallback = analyzeSlackRequirementDeterministic({
      text: '如果要支持 Slack Agent 读取当前 repo 代码，应该怎么实现？',
    });
    const messages = buildSlackAgentMessages(
      {
        text: '如果要支持 Slack Agent 读取当前 repo 代码，应该怎么实现？',
      },
      fallback
    );

    assert.match(messages[0].content, /语气判断必须优先于关键词/);
    assert.match(messages[0].content, /如果要支持/);
    assert.match(messages[0].content, /这是咨询或设计讨论/);
    assert.match(messages[0].content, /只有用户明确说/);
  });

  it('passes the policy package and conversation context to model turns', () => {
    const fallback = analyzeSlackRequirementDeterministic({
      text: '你上一条消息是什么？',
      sessionMemory: {
        lastAgentResponse: '当前会话里有 Issue #90。',
        conversationContext: {
          recentTurns: [{ role: 'assistant', text: '当前会话里有 Issue #90。' }],
          lastAssistantMessage: { role: 'assistant', text: '当前会话里有 Issue #90。' },
        },
      },
    });
    const messages = buildSlackAgentMessages(
      {
        text: '你上一条消息是什么？',
        sessionMemory: {
          conversationContext: {
            recentTurns: [{ role: 'assistant', text: '当前会话里有 Issue #90。' }],
            lastAssistantMessage: { role: 'assistant', text: '当前会话里有 Issue #90。' },
          },
        },
      },
      fallback
    );
    const payload = JSON.parse(messages[1].content);

    assert.equal(fallback.policyVersion, SLACK_AGENT_POLICY_PACKAGE_VERSION);
    assert.match(messages[0].content, new RegExp(`Policy package: ${SLACK_AGENT_POLICY_PACKAGE_VERSION}`));
    assert.match(messages[0].content, /Selected runtime skills:/);
    assert.match(messages[0].content, /conversationContext/);
    assert.ok(payload.selectedSkills.includes('conversation-context'));
    assert.equal(payload.conversationContext.lastAssistantMessage.text, '当前会话里有 Issue #90。');
  });

  it('selects repo question and product design skills for consultative implementation questions', () => {
    const fallback = analyzeSlackRequirementDeterministic({
      text: '从产品角度看，如果要支持 Slack Agent 读取 repo，应该怎么实现？',
    });
    const messages = buildSlackAgentMessages(
      {
        text: '从产品角度看，如果要支持 Slack Agent 读取 repo，应该怎么实现？',
      },
      fallback
    );
    const payload = JSON.parse(messages[1].content);

    assert.ok(payload.selectedSkills.includes('repo-question'));
    assert.ok(payload.selectedSkills.includes('product-design'));
    assert.match(messages[0].content, /skill:repo-question/);
    assert.match(messages[0].content, /skill:product-design/);
    assert.match(messages[0].content, /语气判断必须优先于关键词/);
  });

  it('continues the active platform issue for implicit follow-up wording', () => {
    const analysis = analyzeSlackRequirement({
      text: '不再修改 README.md，改为在仓库中新增 DIY.md，文件内容只需要一个标题。',
      slackSession: {
        id: 'sess_issue_91',
        activeWorkItemKind: 'platform_dev',
        activeWorkItemId: 'pdev_issue_91',
        activeIssueNumber: 91,
      },
    });

    assert.equal(analysis.lane, 'platform-dev');
    assert.equal(analysis.intent, 'append_requirement');
    assert.deepEqual(analysis.toolCall, { name: 'record_followup', args: {} });
    assert.equal(analysis.needsClarification, false);
  });

  it('normalizes model-created platform issue drafts into follow-up when current issue is focused', () => {
    const input = {
      text: '不再修改 README.md，改为在仓库中新增 DIY.md，文件内容只需要一个标题。',
      slackSession: {
        id: 'sess_issue_91',
        activeWorkItemKind: 'platform_dev',
        activeWorkItemId: 'pdev_issue_91',
        activeIssueNumber: 91,
      },
    };
    const fallback = analyzeSlackRequirementDeterministic(input);
    const analysis = normalizeModelAnalysis(
      {
        lane: 'platform-dev',
        intent: 'create_platform_issue',
        summary: input.text,
        toolCall: { name: 'confirm_platform_issue', args: { title: '错误的新需求' } },
        needsClarification: false,
      },
      fallback,
      input
    );

    assert.equal(analysis.lane, 'platform-dev');
    assert.equal(analysis.intent, 'append_requirement');
    assert.deepEqual(analysis.toolCall, { name: 'record_followup', args: {} });
  });

  it('routes repeat requests to a constrained repeat tool', () => {
    const input = { text: '你上一条消息是什么？' };
    const fallback = analyzeSlackRequirementDeterministic(input);
    const analysis = normalizeModelAnalysis(
      {
        intent: 'repeat_previous_message',
        toolCall: { name: 'confirm_platform_issue', args: { title: '错误创建需求' } },
        summary: '复读上一条消息。',
      },
      fallback,
      input
    );

    assert.equal(analysis.intent, 'repeat_previous_message');
    assert.deepEqual(analysis.toolCall, {
      name: 'repeat_previous_message',
      args: { target: 'previous_assistant_message' },
    });
  });

  it('derives tool calls from model intent instead of deterministic fallback intent', () => {
    const input = { text: '这个 Slack 流程的 session 存在哪里？' };
    const fallback = analyzeSlackRequirementDeterministic(input);
    const analysis = normalizeModelAnalysis(
      {
        lane: 'repo-question',
        intent: 'repo_question',
        summary: '查询 Slack 会话持久化实现',
        needsClarification: false,
      },
      {
        ...fallback,
        intent: 'create_platform_issue',
        lane: 'platform-dev',
        toolCall: { name: 'confirm_platform_issue', args: {} },
      },
      input
    );

    assert.equal(analysis.intent, 'repo_question');
    assert.deepEqual(analysis.toolCall, {
      name: 'answer_repo_question',
      args: { question: '这个 Slack 流程的 session 存在哪里？' },
    });
  });

  it('forces read-only repo question tool when model intent and tool call conflict', () => {
    const input = { text: '这个 Slack 流程的 session 存在哪里？' };
    const fallback = analyzeSlackRequirementDeterministic(input);
    const analysis = normalizeModelAnalysis(
      {
        lane: 'repo-question',
        intent: 'repo_question',
        summary: '查询 Slack 会话持久化实现',
        toolCall: { name: 'confirm_platform_issue', args: { title: '错误创建需求' } },
        needsClarification: false,
      },
      fallback,
      input
    );

    assert.equal(analysis.intent, 'repo_question');
    assert.deepEqual(analysis.toolCall, {
      name: 'answer_repo_question',
      args: { question: '这个 Slack 流程的 session 存在哪里？' },
    });
  });

  it('returns a scoped tool call for closed work item queries', () => {
    const analysis = analyzeSlackRequirement({ text: '查看我已关闭的发布任务' });

    assert.equal(analysis.intent, 'list_work_items');
    assert.equal(analysis.workItemState, 'closed');
    assert.deepEqual(analysis.toolCall, { name: 'list_my_work_items', args: { state: 'closed' } });
  });

  it('treats issue list questions as all work item queries', () => {
    const analysis = analyzeSlackRequirement({ text: '目前我的 issue 有哪几个？' });

    assert.equal(analysis.intent, 'list_work_items');
    assert.equal(analysis.dialogAct, 'run_tool');
    assert.equal(analysis.confirmationRequirement, 'none');
    assert.equal(analysis.capability, 'list_my_work_items');
    assert.equal(analysis.card.kind, 'task_list');
    assert.equal(analysis.workItemState, 'all');
    assert.equal(analysis.needsClarification, false);
    assert.deepEqual(analysis.toolCall, { name: 'list_my_work_items', args: { state: 'all' } });
  });

  it('keeps model-selected issue and PR count tools above current focus continuation', () => {
    const input = {
      text: '目前我有什么 issue 或者 PR 还没有处理？',
      slackSession: {
        id: 'sess_1',
        activeWorkItemKind: 'platform_dev',
        activeWorkItemId: 'pdev_88',
        activeIssueNumber: 88,
      },
      sessionMemory: {
        summary: '当前焦点是 Issue #88',
      },
    };
    const fallback = analyzeSlackRequirementDeterministic(input);
    const analysis = normalizeModelAnalysis(
      {
        dialogAct: 'run_tool',
        intent: 'list_work_items',
        summary: '列出当前未处理的 issue 和 PR',
        toolCall: { name: 'list_my_work_items', args: { state: 'active' } },
        confirmationRequirement: 'none',
        focus: { kind: 'work_item_list', source: 'model' },
        card: { kind: 'task_list', title: '当前任务', summary: '列出未处理项', actions: [] },
        needsClarification: false,
      },
      fallback,
      input
    );

    assert.equal(analysis.intent, 'list_work_items');
    assert.equal(analysis.dialogAct, 'run_tool');
    assert.equal(analysis.confirmationRequirement, 'none');
    assert.equal(analysis.capability, 'list_my_work_items');
    assert.deepEqual(analysis.focus, { kind: 'work_item_list', source: 'model' });
    assert.equal(analysis.workItemState, 'active');
    assert.deepEqual(analysis.toolCall, { name: 'list_my_work_items', args: { state: 'active' } });
  });

  it('adds capability metadata for follow-up, diagnosis, confirmation, and full-auto requests', () => {
    const followup = analyzeSlackRequirement({
      text: '这个 issue 接着改，文案再克制一点',
      slackSession: { id: 'sess_1', activeWorkItemKind: 'platform_dev', activeWorkItemId: 'pdev_1' },
    });
    const diagnosis = analyzeSlackRequirement({ text: '为什么没 PR？查一下刚才那个 job' });
    const fullAuto = analyzeSlackRequirement({ text: '后面你全自动接管，不要再问我' });

    assert.equal(followup.intent, 'append_requirement');
    assert.equal(followup.capability, 'record_followup');
    assert.equal(followup.dialogAct, 'run_tool');
    assert.deepEqual(followup.toolCall, { name: 'record_followup', args: {} });

    assert.equal(diagnosis.intent, 'diagnose_work_item');
    assert.equal(diagnosis.capability, 'diagnose_current_work_item');
    assert.equal(diagnosis.card.kind, 'diagnosis');

    assert.equal(fullAuto.intent, 'clarify');
    assert.equal(fullAuto.needsClarification, true);
    assert.equal(fullAuto.confirmationRequirement, 'none');
    assert.equal(fullAuto.toolCall, null);
  });

  it('continues previous work item list context for short follow-up questions', () => {
    const analysis = analyzeSlackRequirement({
      text: '只有这一个么？',
      sessionMemory: {
        lastWorkItemList: {
          action: 'list_work_items',
          workItemState: 'all',
          total: 2,
          shown: [{ issueNumber: 88 }, { issueNumber: 89 }],
        },
      },
    });

    assert.equal(analysis.intent, 'list_work_items');
    assert.equal(analysis.workItemState, 'all');
    assert.equal(analysis.needsClarification, false);
    assert.equal(analysis.sessionContext.lastWorkItemList.total, 2);
    assert.equal(analysis.sessionContext.lastWorkItemList.shownCount, 2);
    assert.deepEqual(analysis.toolCall, { name: 'list_my_work_items', args: { state: 'all' } });
  });

  it('keeps issue and PR switch targets distinct', () => {
    const issueAnalysis = analyzeSlackRequirement({ text: '继续 issue #60' });
    const prAnalysis = analyzeSlackRequirement({ text: '继续 PR #68' });

    assert.equal(issueAnalysis.intent, 'switch_work_item');
    assert.deepEqual(issueAnalysis.toolCall, { name: 'switch_work_item', args: { kind: 'issue', number: 60 } });
    assert.equal(prAnalysis.intent, 'switch_work_item');
    assert.deepEqual(prAnalysis.toolCall, { name: 'switch_work_item', args: { kind: 'pr', number: 68 } });
  });

  it('emits a scoped reopen tool call for explicit closed issue or PR requests', () => {
    const issueAnalysis = analyzeSlackRequirement({ text: '重新打开 issue #60' });
    const prAnalysis = analyzeSlackRequirement({ text: 'reopen PR #68' });

    assert.equal(issueAnalysis.intent, 'reopen_work_item');
    assert.deepEqual(issueAnalysis.toolCall, { name: 'reopen_work_item', args: { kind: 'issue', number: 60 } });
    assert.equal(prAnalysis.intent, 'reopen_work_item');
    assert.deepEqual(prAnalysis.toolCall, { name: 'reopen_work_item', args: { kind: 'pr', number: 68 } });
  });

  it('routes natural diagnosis questions to the current work item diagnosis tool', () => {
    const analysis = analyzeSlackRequirement({ text: '为什么 issue 创建了 PR 没出来？帮我查一下日志' });

    assert.equal(analysis.intent, 'diagnose_work_item');
    assert.equal(analysis.needsClarification, false);
    assert.deepEqual(analysis.toolCall, { name: 'diagnose_current_work_item', args: { timeWindowMinutes: 30 } });
  });

  it('includes session context for model-driven turns', () => {
    const analysis = analyzeSlackRequirement({
      text: '继续修改 preview',
      slackSession: {
        id: 'sess_1',
        sessionKey: 'dm:D1:1710000000.000100',
        status: 'active',
        activeJobId: 'job_1',
        activeIssueNumber: 8,
      },
      sessionMemory: {
        summary: '用户想做一个偏技术品牌的个人主页',
      },
      issueLinks: [{ publishingJobId: 'job_1' }],
    });

    assert.equal(analysis.sessionContext.slackSessionId, 'sess_1');
    assert.equal(analysis.sessionContext.memorySummary, '用户想做一个偏技术品牌的个人主页');
    assert.equal(analysis.sessionContext.issueLinkCount, 1);
    assert.equal(analysis.sessionContext.activeJobId, 'job_1');
  });

  it('marks unclear messages for clarification', () => {
    const analysis = analyzeSlackRequirement({ text: '你好' });

    assert.equal(analysis.intent, 'clarify');
    assert.equal(analysis.needsClarification, true);
  });

  it('does not turn bulk destructive issue requests into work item lists', () => {
    for (const text of ['关闭我名下的所有 issue', '把我名下项目 issue 全部归档', 'archive all my PRs']) {
      const analysis = analyzeSlackRequirement({ text });

      assert.equal(analysis.intent, 'unsupported_destructive_request');
      assert.equal(analysis.needsClarification, false);
      assert.match(analysis.clarifyingQuestion, /不能批量关闭或删除/);
    }
  });

  it('requires the internal token when configured', async () => {
    const app = createSlackAgentApp({ config: { sharedSecret: 'secret' } });
    const response = await app.fetch(
      new Request('http://localhost/internal/slack-agent/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '创建页面' }),
      })
    );

    assert.equal(response.status, 401);
  });

  it('fails closed when the internal shared secret is missing', async () => {
    const app = createSlackAgentApp({ config: { modelProvider: 'deterministic', sharedSecret: '' } });
    const response = await app.fetch(
      new Request('http://localhost/internal/slack-agent/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: '创建页面' }),
      })
    );
    const body = await response.json();

    assert.equal(response.status, 500);
    assert.equal(body.error, 'Slack agent shared secret is not configured');
  });

  it('returns a turn contract with visible reply events', async () => {
    const app = createSlackAgentApp({ config: { modelProvider: 'deterministic', sharedSecret: 'secret' } });
    const response = await app.fetch(
      new Request('http://localhost/internal/slack-agent/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pages-Slack-Agent-Token': 'secret' },
        body: JSON.stringify({
          agentRunId: 'agent_1',
          slackSessionId: 'sess_1',
          text: '创建一个个人网站，突出项目经历',
        }),
      })
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.analysis.intent, 'create_or_update_site');
    assert.equal(body.turn.agentRunId, 'agent_1');
    assert.equal(body.turn.slackSessionId, 'sess_1');
    assert.equal(body.turn.events[0].type, 'reply_started');
    assert.equal(body.turn.events[1].type, 'reply_delta');
    assert.equal(body.turn.events[2].type, 'analysis_final');
    assert.match(body.turn.visibleText, /我已整理好/);
  });

  it('can stream the turn contract as ndjson events', async () => {
    const app = createSlackAgentApp({ config: { modelProvider: 'deterministic', sharedSecret: 'secret' } });
    const response = await app.fetch(
      new Request('http://localhost/internal/slack-agent/turn', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
          'X-Pages-Slack-Agent-Token': 'secret',
        },
        body: JSON.stringify({
          agentRunId: 'agent_1',
          slackSessionId: 'sess_1',
          text: '你好',
        }),
      })
    );
    const lines = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Content-Type'), 'application/x-ndjson; charset=utf-8');
    assert.deepEqual(
      lines.map((line) => line.type),
      ['reply_started', 'reply_delta', 'analysis_final', 'reply_completed']
    );
    assert.equal(lines[2].analysis.needsClarification, true);
  });

  it('returns a scoped merge announcement summary without Slack session state', async () => {
    const app = createSlackAgentApp({ config: { modelProvider: 'deterministic', sharedSecret: 'secret' } });
    const response = await app.fetch(
      new Request('http://localhost/internal/slack-agent/merge-summary', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pages-Slack-Agent-Token': 'secret' },
        body: JSON.stringify({
          repoFullName: 'org/pages-manager',
          prNumber: 82,
          prTitle: 'feat(slack): 完善任务诊断入口',
          baseRef: 'master',
        }),
      })
    );
    const body = await response.json();
    const visible = JSON.stringify(body.summary);

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.summary.source, 'deterministic');
    assert.equal(body.summary.summaryBullets.length, 3);
    assert.doesNotMatch(visible, /\bslackSessionId|agentRunId|gateway|worker|mysql|status card\b/i);
  });

  it('answers repo questions from provided evidence through the model gateway', async () => {
    const calls = [];
    const app = createSlackAgentApp({
      config: {
        modelProvider: 'company-agent',
        gatewayUrl: 'https://agent-gateway.example/v1',
        apiKey: 'gateway-key',
        modelName: 'company-agent',
        maxOutputTokens: 512,
        repoAnswerTimeoutMs: 1000,
        sharedSecret: 'secret',
      },
      async fetchImpl(url, request) {
        calls.push({ url: String(url), request });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    answerText:
                      'Slack 会话由 gateway 持久化，核心字段在 `slack_sessions`，摘要和最近回复放在 `session_memories`。',
                    confidence: 'high',
                    citedPaths: ['apps/gateway/src/db/schema.js', 'apps/gateway/src/slack/session.js'],
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      },
    });

    const response = await app.fetch(
      new Request('http://localhost/internal/slack-agent/repo-answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pages-Slack-Agent-Token': 'secret' },
        body: JSON.stringify({
          question: 'Slack session 是怎么保存的？',
          evidence: [
            {
              path: 'apps/gateway/src/db/schema.js',
              lines: [120],
              excerpts: ['export const slackSessions = mysqlTable("slack_sessions", { ... })'],
            },
          ],
        }),
      })
    );
    const body = await response.json();
    const modelPayload = JSON.parse(calls[0].request.body);

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.answer.source, 'agent');
    assert.match(body.answer.answerText, /slack_sessions/);
    assert.deepEqual(body.answer.citedPaths, ['apps/gateway/src/db/schema.js', 'apps/gateway/src/slack/session.js']);
    assert.equal(calls[0].url, 'https://agent-gateway.example/v1/chat/completions');
    assert.equal(modelPayload.messages[1].role, 'user');
    assert.match(modelPayload.messages[1].content, /repo_question_answer/);
  });

  it('plans repo research before gateway reads files', async () => {
    const calls = [];
    const app = createSlackAgentApp({
      config: {
        modelProvider: 'company-agent',
        gatewayUrl: 'https://agent-gateway.example/v1',
        apiKey: 'gateway-key',
        modelName: 'company-agent',
        maxOutputTokens: 512,
        repoPlanTimeoutMs: 1000,
        sharedSecret: 'secret',
      },
      async fetchImpl(url, request) {
        calls.push({ url: String(url), request });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    mode: 'deep_dive',
                    queries: ['Slack session persistence'],
                    readPaths: ['apps/gateway/src/db/schema.js', 'apps/gateway/src/slack/session.js'],
                    rationale: '需要读取 session schema 和选择逻辑。',
                    suggestedNextAction: 'none',
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      },
    });

    const response = await app.fetch(
      new Request('http://localhost/internal/slack-agent/repo-plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pages-Slack-Agent-Token': 'secret' },
        body: JSON.stringify({
          question: 'Slack session 是怎么保存的？',
          mode: 'deep_dive',
          repoTree: {
            files: ['apps/gateway/src/db/schema.js', 'apps/gateway/src/slack/session.js'],
          },
        }),
      })
    );
    const body = await response.json();
    const modelPayload = JSON.parse(calls[0].request.body);

    assert.equal(response.status, 200);
    assert.equal(body.ok, true);
    assert.equal(body.plan.source, 'agent');
    assert.deepEqual(body.plan.queries, ['Slack session persistence']);
    assert.deepEqual(body.plan.readPaths, ['apps/gateway/src/db/schema.js', 'apps/gateway/src/slack/session.js']);
    assert.equal(calls[0].url, 'https://agent-gateway.example/v1/chat/completions');
    assert.match(modelPayload.messages[1].content, /repo_research_plan/);
  });

  it('prefers shared company gateway config names while keeping legacy Slack names as fallback', () => {
    const config = readSlackAgentConfig({
      AGENT_MODEL_PROVIDER: 'company-agent',
      AGENT_MODEL_NAME: 'company-router',
      AGENT_GATEWAY_URL: 'https://agent-gateway.example',
      SLACK_AGENT_MODEL_PROVIDER: 'legacy-provider',
      SLACK_AGENT_MODEL_NAME: 'legacy-model',
      SLACK_AGENT_GATEWAY_URL: 'https://legacy-agent-gateway.example',
      SLACK_AGENT_API_KEY: 'slack-agent-key',
    });

    assert.equal(config.modelProvider, 'company-agent');
    assert.equal(config.modelName, 'company-router');
    assert.equal(config.gatewayUrl, 'https://agent-gateway.example');
    assert.equal(config.apiKey, 'slack-agent-key');

    const temperatureConfig = readSlackAgentConfig({
      AGENT_MODEL_TEMPERATURE: '0.7',
    });
    assert.equal(temperatureConfig.temperature, 0.7);

    const legacyConfig = readSlackAgentConfig({
      SLACK_AGENT_MODEL_NAME: 'legacy-model',
      SLACK_AGENT_GATEWAY_URL: 'https://legacy-agent-gateway.example',
    });

    assert.equal(legacyConfig.modelProvider, 'company-agent');
    assert.equal(legacyConfig.modelName, 'legacy-model');
    assert.equal(legacyConfig.gatewayUrl, 'https://legacy-agent-gateway.example');
  });

  it('calls the company OpenAI-compatible gateway and normalizes JSON output', async () => {
    const calls = [];
    const app = createSlackAgentApp({
      config: {
        modelProvider: 'company-agent',
        gatewayUrl: 'https://agent-gateway.example/v1',
        apiKey: 'gateway-key',
        modelName: 'company-agent',
        maxOutputTokens: 512,
        requestTimeoutMs: 1000,
        sharedSecret: 'secret',
      },
      async fetchImpl(url, request) {
        calls.push({ url: String(url), request });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    intent: 'append_requirement',
                    employeeSlug: 'bob',
                    siteSlug: 'portfolio',
                    title: '补充需求',
                    summary: '追加项目经历',
                    needsClarification: false,
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      },
    });

    const response = await app.fetch(
      new Request('http://localhost/internal/slack-agent/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pages-Slack-Agent-Token': 'secret' },
        body: JSON.stringify({ text: '再加一个项目经历区域' }),
      })
    );
    const body = await response.json();
    const payload = JSON.parse(calls[0].request.body);

    assert.equal(response.status, 200);
    assert.equal(calls[0].url, 'https://agent-gateway.example/v1/chat/completions');
    assert.equal(calls[0].request.headers.Authorization, 'Bearer gateway-key');
    assert.equal(payload.model, 'company-agent');
    assert.equal(payload.messages.length, 2);
    assert.equal('temperature' in payload, false);
    assert.deepEqual(payload.response_format, { type: 'json_object' });
    assert.equal(body.analysis.intent, 'append_requirement');
    assert.equal(body.analysis.modelProvider, 'company-agent');
    assert.equal(body.analysis.modelApiStyle, 'company-openai-compatible');
  });

  it('streams company gateway visible replies as semantic ndjson chunks', async () => {
    const calls = [];
    const app = createSlackAgentApp({
      config: {
        modelProvider: 'company-agent',
        gatewayUrl: 'https://agent-gateway.example/v1',
        apiKey: 'gateway-key',
        modelName: 'company-agent',
        maxOutputTokens: 512,
        requestTimeoutMs: 1000,
        semanticChunkMinChars: 16,
        semanticChunkMaxChars: 72,
        sharedSecret: 'secret',
      },
      async fetchImpl(url, request) {
        calls.push({ url: String(url), request });
        const events = [
          { choices: [{ delta: { content: '{"visibleReply":"我先整理一下：' } }] },
          { choices: [{ delta: { content: '这是一个突出项目经历和联系方式的个人主页。' } }] },
          {
            choices: [
              {
                delta: {
                  content: [
                    '","intent":"create_or_update_site","siteSlug":"profile",',
                    '"title":"个人主页","summary":"突出项目经历和联系方式。","needsClarification":false}',
                  ].join(''),
                },
              },
            ],
          },
        ];
        return new Response(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`, {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        });
      },
    });

    const response = await app.fetch(
      new Request('http://localhost/internal/slack-agent/turn', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/x-ndjson',
          'X-Pages-Slack-Agent-Token': 'secret',
        },
        body: JSON.stringify({
          agentRunId: 'agent_stream_1',
          slackSessionId: 'sess_stream_1',
          text: '做一个个人主页，突出项目经历和联系方式',
        }),
      })
    );
    const lines = (await response.text())
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const payload = JSON.parse(calls[0].request.body);
    const deltas = lines.filter((line) => line.type === 'reply_delta');
    const final = lines.find((line) => line.type === 'analysis_final');

    assert.equal(response.status, 200);
    assert.equal(calls[0].url, 'https://agent-gateway.example/v1/chat/completions');
    assert.equal(payload.stream, true);
    assert.deepEqual(
      lines.map((line) => line.type),
      ['reply_started', 'reply_delta', 'reply_delta', 'analysis_final', 'reply_completed']
    );
    assert.deepEqual(
      deltas.map((line) => line.text),
      ['我先整理一下：', '这是一个突出项目经历和联系方式的个人主页。']
    );
    assert.doesNotMatch(deltas.map((line) => line.text).join(''), /visibleReply|intent|siteSlug/);
    assert.equal(final.analysis.intent, 'create_or_update_site');
    assert.equal(final.analysis.visibleReply, '我先整理一下：这是一个突出项目经历和联系方式的个人主页。');
    assert.equal(final.analysis.modelApiStyle, 'company-openai-compatible');
  });

  it('normalizes company gateway root BaseURL to /v1/chat/completions', async () => {
    const calls = [];
    const app = createSlackAgentApp({
      config: {
        modelProvider: 'company-agent',
        gatewayUrl: 'https://agent-gateway.example',
        apiKey: 'gateway-key',
        modelName: 'company-agent',
        requestTimeoutMs: 1000,
        sharedSecret: 'secret',
      },
      async fetchImpl(url) {
        calls.push(String(url));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify({ intent: 'clarify', needsClarification: true }) } }],
          }),
          { status: 200 }
        );
      },
    });

    await app.fetch(
      new Request('http://localhost/internal/slack-agent/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pages-Slack-Agent-Token': 'secret' },
        body: JSON.stringify({ text: '你好' }),
      })
    );

    assert.equal(calls[0], 'https://agent-gateway.example/v1/chat/completions');
  });

  it('preserves model clarification questions for free-form conversations', async () => {
    const app = createSlackAgentApp({
      config: {
        modelProvider: 'company-agent',
        gatewayUrl: 'https://agent-gateway.example',
        apiKey: 'gateway-key',
        modelName: 'company-agent',
        requestTimeoutMs: 1000,
        sharedSecret: 'secret',
      },
      async fetchImpl() {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    intent: 'clarify',
                    summary: '需要补充目标内容。',
                    clarifyingQuestion: '你希望页面重点展示项目、履历还是联系方式？',
                    needsClarification: true,
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      },
    });

    const response = await app.fetch(
      new Request('http://localhost/internal/slack-agent/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Pages-Slack-Agent-Token': 'secret' },
        body: JSON.stringify({ text: '先聊聊我的个人主页' }),
      })
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.analysis.needsClarification, true);
    assert.equal(body.analysis.clarifyingQuestion, '你希望页面重点展示项目、履历还是联系方式？');
  });

  it('redacts token-like values from Slack Agent audit logs', () => {
    const redacted = redactSlackAgentLogValue(
      {
        text: '请不要记录 xoxb-1234567890-secret 或 ghp_1234567890abcdefghij1234567890',
        token: 'plain-token-value',
      },
      ['exact-secret']
    );

    assert.match(redacted.text, /\[REDACTED_SLACK_TOKEN\]/);
    assert.match(redacted.text, /\[REDACTED_GITHUB_TOKEN\]/);
    assert.equal(redacted.token, '[REDACTED_SECRET]');
  });

  it('logs model calls with redacted prompt and user text', async () => {
    const logs = [];
    const originalLog = console.log;
    console.log = (line) => logs.push(line);

    try {
      const app = createSlackAgentApp({
        config: {
          modelProvider: 'company-agent',
          gatewayUrl: 'https://agent-gateway.example',
          apiKey: 'exact-agent-secret',
          modelName: 'codex/gpt-5.5',
          requestTimeoutMs: 1000,
          sharedSecret: 'secret',
        },
        async fetchImpl() {
          return new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: JSON.stringify({
                      intent: 'clarify',
                      summary: '需要补充信息',
                      needsClarification: true,
                    }),
                  },
                },
              ],
            }),
            { status: 200 }
          );
        },
      });

      const response = await app.fetch(
        new Request('http://localhost/internal/slack-agent/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Pages-Slack-Agent-Token': 'secret' },
          body: JSON.stringify({
            text: '你好 token=abc123 xoxb-1234567890-secret',
            event: {
              channel: 'D1',
              channel_type: 'im',
              user: 'U1',
              thread_ts: '1000.000',
            },
          }),
        })
      );

      assert.equal(response.status, 200);
    } finally {
      console.log = originalLog;
    }

    const auditLog = logs.map((line) => JSON.parse(line)).find((line) => line.message === 'slack_agent_model_call');
    assert.equal(auditLog.provider, 'company-agent');
    assert.equal(auditLog.model, 'codex/gpt-5.5');
    assert.equal(auditLog.status, 'ok');
    assert.equal(auditLog.channel, 'D1');
    assert.match(auditLog.userText, /\[REDACTED/);
    assert.match(auditLog.prompt[1].content, /\[REDACTED/);
    assert.doesNotMatch(JSON.stringify(auditLog), /exact-agent-secret|xoxb-1234567890-secret|token=abc123/);
  });
});
