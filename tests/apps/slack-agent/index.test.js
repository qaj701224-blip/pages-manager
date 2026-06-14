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
    assert.match(analysis.summary, /个人网站/);
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
