import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readSlackAgentConfig } from '../../../apps/slack-agent/src/config.js';
import { analyzeSlackRequirement, createSlackAgentApp } from '../../../apps/slack-agent/src/index.js';
import { redactSlackAgentLogValue } from '../../../apps/slack-agent/src/model-provider.js';

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

  it('returns a scoped tool call for closed work item queries', () => {
    const analysis = analyzeSlackRequirement({ text: '查看我已关闭的发布任务' });

    assert.equal(analysis.intent, 'list_work_items');
    assert.equal(analysis.workItemState, 'closed');
    assert.deepEqual(analysis.toolCall, { name: 'list_my_work_items', args: { state: 'closed' } });
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

  it('returns a turn contract with visible reply events', async () => {
    const app = createSlackAgentApp({ config: { modelProvider: 'deterministic' } });
    const response = await app.fetch(
      new Request('http://localhost/internal/slack-agent/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    const app = createSlackAgentApp({ config: { modelProvider: 'deterministic' } });
    const response = await app.fetch(
      new Request('http://localhost/internal/slack-agent/turn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json', Accept: 'application/x-ndjson' },
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
        headers: { 'Content-Type': 'application/json' },
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
        headers: { 'Content-Type': 'application/json' },
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
          headers: { 'Content-Type': 'application/json' },
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
