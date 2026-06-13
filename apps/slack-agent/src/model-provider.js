import {
  analyzeSlackRequirementDeterministic,
  buildSlackAgentMessages,
  normalizeModelAnalysis,
} from './analysis.js';

function parseJsonObject(text) {
  if (!text || typeof text !== 'string') return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
}

async function readResponseJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { rawText: text };
  }
}

function modelError(message, status = 502) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function trimTrailingSlash(value = '') {
  return String(value || '').replace(/\/+$/, '');
}

function companyChatCompletionsUrl(config) {
  const baseUrl = trimTrailingSlash(config.gatewayUrl);
  if (!baseUrl) throw modelError('AGENT_GATEWAY_URL is required', 503);
  if (baseUrl.endsWith('/chat/completions')) return baseUrl;
  if (baseUrl.endsWith('/v1')) return `${baseUrl}/chat/completions`;
  return `${baseUrl}/v1/chat/completions`;
}

function extractOpenAiCompatibleAnalysis(body) {
  const content = body?.choices?.[0]?.message?.content || body?.choices?.[0]?.text || body?.output_text;
  if (content && typeof content === 'object') return content;
  return parseJsonObject(content) || body?.analysis || body?.data?.analysis || null;
}

function extractGatewayAnalysis(body) {
  if (body?.analysis && typeof body.analysis === 'object') return body.analysis;
  if (body?.result?.analysis && typeof body.result.analysis === 'object') return body.result.analysis;
  if (body?.data?.analysis && typeof body.data.analysis === 'object') return body.data.analysis;
  if (body?.output && typeof body.output === 'object' && !Array.isArray(body.output)) return body.output;
  if (typeof body?.output === 'string') return parseJsonObject(body.output);
  if (typeof body?.content === 'string') return parseJsonObject(body.content);
  if (typeof body?.rawText === 'string') return parseJsonObject(body.rawText);
  return null;
}

async function callCompanyOpenAiGateway({ input, config, fallbackAnalysis, fetchImpl, signal }) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const response = await fetchImpl(companyChatCompletionsUrl(config), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.modelName || undefined,
      messages: buildSlackAgentMessages(input, fallbackAnalysis),
      temperature: 0,
      max_tokens: config.maxOutputTokens,
      response_format: { type: 'json_object' },
    }),
    signal,
  });
  const body = await readResponseJson(response);
  if (!response.ok) {
    throw modelError(`Slack Agent company OpenAI-compatible gateway failed: HTTP ${response.status}`, 502);
  }
  return extractOpenAiCompatibleAnalysis(body) || extractGatewayAnalysis(body);
}

export async function analyzeSlackRequirementWithProvider(input = {}, options = {}) {
  const config = options.config || {};
  const fallbackAnalysis = analyzeSlackRequirementDeterministic(input);
  if (config.modelProvider === 'deterministic') {
    return {
      ...fallbackAnalysis,
      modelProvider: 'deterministic',
      modelApiStyle: 'deterministic',
    };
  }

  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = config.requestTimeoutMs || 120_000;
  const controller = new globalThis.AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const rawAnalysis = await callCompanyOpenAiGateway({
      input,
      config,
      fallbackAnalysis,
      fetchImpl,
      signal: controller.signal,
    });

    if (!rawAnalysis) {
      throw modelError('Slack Agent company gateway response did not contain a JSON analysis object', 502);
    }

    return {
      ...normalizeModelAnalysis(rawAnalysis, fallbackAnalysis, input),
      modelProvider: config.modelProvider || 'company-agent',
      modelName: config.modelName || null,
      modelApiStyle: 'company-openai-compatible',
    };
  } finally {
    clearTimeout(timeout);
  }
}
