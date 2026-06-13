import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { readSlackAgentConfig } from '../../../apps/slack-agent/src/config.js';
import { analyzeSlackRequirement, createSlackAgentApp } from '../../../apps/slack-agent/src/index.js';

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
});
