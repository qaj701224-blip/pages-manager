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

function redactSecretLikeText(text, secrets = []) {
  let redacted = String(text || '');
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(String(secret)).join('[REDACTED_SECRET]');
  }

  return redacted
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{8,})\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/\b(xapp-[A-Za-z0-9-]{8,})\b/g, '[REDACTED_SLACK_APP_TOKEN]')
    .replace(/\b(ghp_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_API_KEY]')
    .replace(
      /("(?:api[_-]?key|token|secret|password|passwd|pwd)"\s*:\s*")[^"]+(")/gi,
      '$1[REDACTED_SECRET]$2'
    )
    .replace(
      /\b(api[_-]?key|token|secret|password|passwd|pwd)\b\s*[:=]\s*["']?[^"',\s}]+/gi,
      '$1=[REDACTED_SECRET]'
    );
}

export function redactSlackAgentLogValue(value, secrets = []) {
  if (typeof value === 'string') return redactSecretLikeText(value, secrets);
  return JSON.parse(redactSecretLikeText(JSON.stringify(value ?? null), secrets));
}

function extractUserText(input = {}) {
  return input.text || input.event?.text || input.summary || '';
}

function logSlackAgentModelCall({ input, config, messages, status, durationMs, analysis = null, error = null }) {
  const secrets = [config.apiKey];
  const event = input.event || {};
  const safeLog = {
    service: 'pages-slack-agent',
    message: 'slack_agent_model_call',
    provider: config.modelProvider || 'company-agent',
    model: config.modelName || null,
    modelApiStyle: 'company-openai-compatible',
    status,
    durationMs,
    teamId: input.team_id || input.teamId || event.team || null,
    channel: event.channel || null,
    channelType: event.channel_type || null,
    user: event.user || null,
    threadTs: event.thread_ts || null,
    eventId: input.event_id || input.eventId || null,
    intent: analysis?.intent || null,
    needsClarification: Boolean(analysis?.needsClarification),
    userText: redactSlackAgentLogValue(extractUserText(input), secrets),
    prompt: redactSlackAgentLogValue(messages, secrets),
  };

  if (error) {
    safeLog.error = error.message;
  }

  console.log(JSON.stringify(safeLog));
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

async function callCompanyOpenAiGateway({ config, messages, fetchImpl, signal }) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const response = await fetchImpl(companyChatCompletionsUrl(config), {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: config.modelName || undefined,
      messages,
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
  const startedAt = Date.now();
  const messages = buildSlackAgentMessages(input, fallbackAnalysis);

  try {
    const rawAnalysis = await callCompanyOpenAiGateway({
      config,
      messages,
      fetchImpl,
      signal: controller.signal,
    });

    if (!rawAnalysis) {
      throw modelError('Slack Agent company gateway response did not contain a JSON analysis object', 502);
    }

    const analysis = {
      ...normalizeModelAnalysis(rawAnalysis, fallbackAnalysis, input),
      modelProvider: config.modelProvider || 'company-agent',
      modelName: config.modelName || null,
      modelApiStyle: 'company-openai-compatible',
    };
    logSlackAgentModelCall({
      input,
      config,
      messages,
      status: 'ok',
      durationMs: Date.now() - startedAt,
      analysis,
    });
    return analysis;
  } catch (err) {
    logSlackAgentModelCall({
      input,
      config,
      messages,
      status: 'error',
      durationMs: Date.now() - startedAt,
      error: err,
    });
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
