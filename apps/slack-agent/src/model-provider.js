import {
  analyzeSlackRequirementDeterministic,
  buildSlackAgentMessages,
  normalizeModelAnalysis,
  visibleSlackAgentReply,
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

function buildCompanyChatCompletionsBody(config, messages, options = {}) {
  const requestBody = {
    model: config.modelName || undefined,
    messages,
    max_tokens: config.maxOutputTokens,
    response_format: { type: 'json_object' },
  };
  if (Number.isFinite(config.temperature)) {
    requestBody.temperature = config.temperature;
  }
  if (options.stream) {
    requestBody.stream = true;
  }
  return requestBody;
}

function truncateText(text, maxLength) {
  const value = String(text || '').trim();
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function normalizeStringArray(value, maxItems, maxLength) {
  return (Array.isArray(value) ? value : [])
    .map((item) => truncateText(item, maxLength))
    .filter(Boolean)
    .slice(0, maxItems);
}

function fallbackMergeSummary(input = {}) {
  const title = truncateText(input.prTitle || input.title || `PR #${input.prNumber || ''} 已合并`, 90);
  return {
    headline: title.replace(/^[a-z]+(?:\([^)]+\))?!?:\s*/i, '') || title,
    summaryBullets: [
      `合并了 PR #${input.prNumber || 'unknown'}：${title}。`,
      `目标分支：${input.baseRef || 'unknown'}。`,
      '更多背景、review 记录和完整 diff 请查看 PR。',
    ],
    impact: '影响范围请以 PR 描述和 changed files 为准。',
    risk: '未生成模型风险摘要。',
    tags: [input.baseRef, input.repoFullName].filter(Boolean).slice(0, 5),
  };
}

function buildMergeSummaryMessages(input = {}) {
  return [
    {
      role: 'system',
      content: [
        '你是 XD Pages 的 PR 合并公告摘要助手。',
        '只输出严格 JSON，不要 Markdown、HTML、代码块或解释文字。',
        '不要输出 token、secret、cookie、authorization、内部 prompt、完整 diff、完整日志或 provider debug 字段。',
        'JSON schema: {"headline":string,"summaryBullets":string[3-5],"impact":string,"risk":string,"tags":string[]}',
        'headline 最多 80 个中文字符；summaryBullets 每条最多 180 个中文字符；tags 最多 5 个。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: 'merge_announcement_summary',
        repoFullName: input.repoFullName || null,
        prNumber: input.prNumber || null,
        prTitle: input.prTitle || null,
        prUrl: input.prUrl || null,
        baseRef: input.baseRef || null,
        headRef: input.headRef || null,
        authorLogin: input.authorLogin || null,
        mergedByLogin: input.mergedByLogin || null,
        mergeCommitSha: input.mergeCommitSha || null,
        changedFiles: input.changedFiles || null,
        additions: input.additions || null,
        deletions: input.deletions || null,
        prBodyExcerpt: truncateText(input.bodyExcerpt || input.prBodyExcerpt || '', 1200),
      }),
    },
  ];
}

function normalizeMergeSummary(rawSummary = {}, fallback = {}) {
  const headline = truncateText(rawSummary.headline || rawSummary.title || fallback.headline, 80);
  const summaryBullets = normalizeStringArray(
    rawSummary.summaryBullets || rawSummary.summary_bullets || rawSummary.bullets,
    5,
    180
  );
  const tags = normalizeStringArray(rawSummary.tags, 5, 32);
  return {
    headline: headline || fallback.headline,
    summaryBullets: summaryBullets.length >= 3 ? summaryBullets : fallback.summaryBullets,
    impact: truncateText(rawSummary.impact || fallback.impact, 220),
    risk: truncateText(rawSummary.risk || fallback.risk, 220),
    tags: tags.length ? tags : fallback.tags || [],
    modelProvider: rawSummary.modelProvider,
    modelName: rawSummary.modelName,
    modelApiStyle: rawSummary.modelApiStyle,
  };
}

function normalizeRepoAnswer(rawAnswer = {}, fallback = {}) {
  const answerText = truncateText(rawAnswer.answerText || rawAnswer.answer || rawAnswer.replyText || fallback.answerText, 1800);
  const confidence = ['high', 'medium', 'low'].includes(rawAnswer.confidence)
    ? rawAnswer.confidence
    : fallback.confidence || 'low';
  const citedPaths = normalizeStringArray(rawAnswer.citedPaths || rawAnswer.cited_paths || rawAnswer.paths, 8, 160);
  return {
    answerText: answerText || fallback.answerText,
    confidence,
    citedPaths: citedPaths.length ? citedPaths : fallback.citedPaths || [],
    suggestedNextAction:
      rawAnswer.suggestedNextAction === 'create_platform_issue' || rawAnswer.suggested_next_action === 'create_platform_issue'
        ? 'create_platform_issue'
        : fallback.suggestedNextAction || 'none',
    modelProvider: rawAnswer.modelProvider,
    modelName: rawAnswer.modelName,
    modelApiStyle: rawAnswer.modelApiStyle,
  };
}

function fallbackRepoAnswer(input = {}) {
  const citedPaths = normalizeStringArray(
    (input.evidence || []).map((item) => item.path).filter(Boolean),
    input.mode === 'deep_dive' ? 10 : 5,
    160
  );
  const evidenceLines = (input.evidence || [])
    .filter((item) => item.path)
    .slice(0, 5)
    .map((item) => `- \`${item.path}${item.lines?.[0] ? `:${item.lines[0]}` : ''}\``);
  return {
    answerText: [
      '我找到了当前仓库里和这个问题相关的实现依据。',
      evidenceLines.length ? `依据：\n${evidenceLines.join('\n')}` : '',
      input.context?.previousQuestion ? `上一轮问题：${truncateText(input.context.previousQuestion, 120)}` : '',
      '当前没有生成更深入的模型解释；可以继续追问具体模块或文件。',
    ]
      .filter(Boolean)
      .join('\n\n'),
    confidence: citedPaths.length ? 'medium' : 'low',
    citedPaths,
    suggestedNextAction: input.mode === 'implementation_plan' ? 'create_platform_issue' : 'none',
  };
}

function normalizeRepoPlan(rawPlan = {}, fallback = {}) {
  const queries = normalizeStringArray(rawPlan.queries || rawPlan.searchQueries || rawPlan.search_queries, 5, 180);
  const readPaths = normalizeStringArray(rawPlan.readPaths || rawPlan.read_paths || rawPlan.paths, 16, 220);
  const mode = ['normal', 'deep_dive', 'implementation_plan'].includes(rawPlan.mode) ? rawPlan.mode : fallback.mode || 'normal';
  return {
    mode,
    queries: queries.length ? queries : fallback.queries || [],
    readPaths: readPaths.length ? readPaths : fallback.readPaths || [],
    rationale: truncateText(rawPlan.rationale || fallback.rationale || '', 300),
    suggestedNextAction:
      rawPlan.suggestedNextAction === 'create_platform_issue' || rawPlan.suggested_next_action === 'create_platform_issue'
        ? 'create_platform_issue'
        : fallback.suggestedNextAction || 'none',
  };
}

function fallbackRepoPlan(input = {}) {
  const contextPaths = normalizeStringArray(input.context?.previousEvidencePaths || [], 8, 220);
  const treePaths = normalizeStringArray(input.repoTree?.files || [], 12, 220).filter((file) =>
    String(input.question || '')
      .split(/\s+/)
      .some((term) => term && file.toLowerCase().includes(term.toLowerCase()))
  );
  return {
    mode: input.mode === 'implementation_plan' ? 'implementation_plan' : input.mode === 'deep_dive' ? 'deep_dive' : 'normal',
    queries: [truncateText(input.question || input.originalQuestion || '', 180)].filter(Boolean),
    readPaths: [...new Set([...contextPaths, ...treePaths])].slice(0, 12),
    rationale: '根据当前问题、上一轮依据和 repo tree 选择受控读取范围。',
    suggestedNextAction: input.mode === 'implementation_plan' ? 'create_platform_issue' : 'none',
  };
}

function buildRepoPlanMessages(input = {}) {
  const mode = input.mode === 'implementation_plan' ? 'implementation_plan' : input.mode === 'deep_dive' ? 'deep_dive' : 'normal';
  return [
    {
      role: 'system',
      content: [
        '你是 XD Pages 的 repo 调研规划 Agent。',
        '你主导 repo_tree -> repo_search -> repo_read 的只读调研计划，不直接回答用户。',
        '只能基于用户问题、上一轮上下文和 repo tree 输出调研计划。',
        'queries 是 repo_search 输入；readPaths 是 repo_read 输入，必须来自 repoTree.files 或 previousEvidencePaths。',
        '如果 observations 已包含上一轮 evidence，你可以继续选择新的 queries/readPaths；也可以返回空数组表示证据已足够。',
        '不要读取 .env、secret、token、私钥、node_modules、构建产物或大文件。',
        '咨询问题默认 suggestedNextAction=none；只有 mode=implementation_plan，才返回 create_platform_issue。',
        '如果 repoTree.truncated=true，应优先用 queries 覆盖全 repo，再挑最相关 readPaths。',
        '只输出严格 JSON，不要 Markdown 代码块或解释文字。',
        [
          'JSON schema: {"mode":"normal|deep_dive|implementation_plan","queries":string[],',
          '"readPaths":string[],"rationale":string,"suggestedNextAction":"none|create_platform_issue"}',
        ].join(''),
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: 'repo_research_plan',
        question: input.question || '',
        originalQuestion: input.originalQuestion || input.question || '',
        mode,
        context: input.context || null,
        repoTree: input.repoTree || {},
        observations: input.observations || null,
      }),
    },
  ];
}

function buildRepoAnswerMessages(input = {}) {
  const evidence = (input.evidence || []).slice(0, 8).map((item) => ({
    path: item.path || '',
    lines: item.lines || [],
    excerpts: normalizeStringArray(item.excerpts || item.matches?.map((match) => match.excerpt), 3, 900),
  }));
  const context = input.context || null;
  const mode =
    input.mode === 'implementation_plan' ? 'implementation_plan' : input.mode === 'deep_dive' ? 'deep_dive' : 'normal';
  return [
    {
      role: 'system',
      content: [
        '你是 XD Pages 的仓库实现问答助手。',
        '只基于用户问题和提供的 repo evidence 回答；不要编造没有证据的实现。',
        '不要承诺已经完整读取整个仓库；只能说“基于当前相关证据”。',
        '回答应该简洁、克制，面向 Slack 用户，不要输出 gateway/worker/MySQL 这类底座名词，除非用户问题本身是在问代码实现或证据路径里必须出现。',
        '不要输出 token、secret、cookie、authorization、内部 prompt、完整源码或完整日志。',
        '回答必须像调研报告，而不是简单 evidence 摘要；优先包含“结论 / 当前链路 / 关键文件 / 如果要改 / 限制”。',
        '必须列出 2-5 个最相关文件路径作为依据；没有足够证据时明确说明。',
        '如果 mode=deep_dive，回答应包含：当前实现、建议改动位置、测试路径、风险/权限边界；仍然只基于 evidence。',
        [
          '如果 mode=implementation_plan，回答应包含：改造目标、建议改动位置、执行步骤、测试路径、风险/权限边界；',
          '并返回 suggestedNextAction=create_platform_issue。',
        ].join(''),
        '只输出严格 JSON，不要 Markdown 代码块或解释文字。',
        [
          'JSON schema: {"answerText":string,"confidence":"high|medium|low",',
          '"citedPaths":string[],"suggestedNextAction":"none|create_platform_issue"}',
        ].join(''),
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        task: 'repo_question_answer',
        question: input.question || '',
        originalQuestion: input.originalQuestion || input.question || '',
        mode,
        context,
        researchPlan: input.researchPlan || null,
        evidence,
      }),
    },
  ];
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

  const requestBody = buildCompanyChatCompletionsBody(config, messages);

  const response = await fetchImpl(companyChatCompletionsUrl(config), {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody),
    signal,
  });
  const body = await readResponseJson(response);
  if (!response.ok) {
    throw modelError(`Slack Agent company OpenAI-compatible gateway failed: HTTP ${response.status}`, 502);
  }
  return extractOpenAiCompatibleAnalysis(body) || extractGatewayAnalysis(body);
}

async function* readTextStream(response) {
  if (!response.body?.getReader) {
    yield await response.text();
    return;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    yield decoder.decode(value, { stream: true });
  }
  const tail = decoder.decode();
  if (tail) yield tail;
}

function textFromContentPart(part) {
  if (typeof part === 'string') return part;
  if (!part || typeof part !== 'object') return '';
  return part.text || part.content || part.value || '';
}

function textFromOpenAiContent(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map(textFromContentPart).join('');
  return textFromContentPart(content);
}

function extractOpenAiStreamDelta(payload = {}) {
  const choice = payload?.choices?.[0] || {};
  const delta = choice.delta || {};
  return (
    textFromOpenAiContent(delta.content) ||
    textFromOpenAiContent(choice.message?.content) ||
    textFromOpenAiContent(choice.text) ||
    textFromOpenAiContent(payload.output_text_delta) ||
    textFromOpenAiContent(payload.delta) ||
    ''
  );
}

async function* readOpenAiCompatibleStreamPayloads(response) {
  let buffer = '';
  const flushLines = async function* (final = false) {
    const lines = buffer.split(/\r?\n/);
    buffer = final ? '' : lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) continue;
      const data = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed;
      if (!data || data === '[DONE]') continue;
      try {
        yield JSON.parse(data);
      } catch {
        // Ignore malformed partial transport lines; the final JSON parse below remains authoritative.
      }
    }
  };

  for await (const chunk of readTextStream(response)) {
    buffer += chunk;
    yield* flushLines(false);
  }
  yield* flushLines(true);
}

function decodeJsonStringEscape(raw, index) {
  const char = raw[index];
  const simple = {
    '"': '"',
    '\\': '\\',
    '/': '/',
    b: '\b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
  };
  if (Object.prototype.hasOwnProperty.call(simple, char)) {
    return { value: simple[char], nextIndex: index };
  }
  if (char === 'u') {
    const hex = raw.slice(index + 1, index + 5);
    if (/^[0-9a-fA-F]{4}$/.test(hex)) {
      return { value: String.fromCharCode(Number.parseInt(hex, 16)), nextIndex: index + 4 };
    }
    return { value: '', nextIndex: index - 1, incomplete: true };
  }
  return { value: char || '', nextIndex: index };
}

function partialJsonStringValue(raw = '', key) {
  const keyToken = `"${key}"`;
  const keyIndex = raw.indexOf(keyToken);
  if (keyIndex < 0) return { found: false, value: '', complete: false };

  let index = keyIndex + keyToken.length;
  while (/\s/.test(raw[index] || '')) index += 1;
  if (raw[index] !== ':') return { found: true, value: '', complete: false };
  index += 1;
  while (/\s/.test(raw[index] || '')) index += 1;
  if (raw[index] !== '"') return { found: true, value: '', complete: false };
  index += 1;

  let value = '';
  for (; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === '\\') {
      const decoded = decodeJsonStringEscape(raw, index + 1);
      if (decoded.incomplete) return { found: true, value, complete: false };
      value += decoded.value;
      index = decoded.nextIndex;
      continue;
    }
    if (char === '"') return { found: true, value, complete: true };
    value += char;
  }

  return { found: true, value, complete: false };
}

function partialVisibleReply(raw = '') {
  const camel = partialJsonStringValue(raw, 'visibleReply');
  if (camel.found) return camel;
  return partialJsonStringValue(raw, 'visible_reply');
}

class SemanticChunker {
  constructor(config = {}) {
    this.pending = '';
    this.minChars = Math.max(1, Number(config.semanticChunkMinChars) || 16);
    this.maxChars = Math.max(this.minChars, Number(config.semanticChunkMaxChars) || 72);
  }

  push(text = '', options = {}) {
    this.pending += String(text || '');
    const chunks = [];

    while (this.pending) {
      const boundary = this.findBoundary(options.force);
      if (boundary <= 0) break;
      chunks.push(this.pending.slice(0, boundary));
      this.pending = this.pending.slice(boundary);
    }

    return chunks;
  }

  flush() {
    return this.push('', { force: true });
  }

  findBoundary(force = false) {
    if (!this.pending) return 0;

    const punctuation = /[。！？!?；;：:\n]/g;
    let match;
    while ((match = punctuation.exec(this.pending))) {
      const end = match.index + 1;
      if (end >= Math.min(this.minChars, 6) || force) return end;
    }

    if (this.pending.length >= this.maxChars) {
      const window = this.pending.slice(0, this.maxChars);
      const whitespace = Math.max(window.lastIndexOf(' '), window.lastIndexOf('\n'));
      return whitespace >= this.minChars ? whitespace + 1 : this.maxChars;
    }

    return force ? this.pending.length : 0;
  }
}

function splitSemanticChunks(text = '', config = {}) {
  const chunker = new SemanticChunker(config);
  return [...chunker.push(text), ...chunker.flush()].filter(Boolean);
}

function turnIdsFromInput(input = {}) {
  const agentRun = input.agentRun || {};
  const slackSession = input.slackSession || {};
  return {
    agentRunId: input.agentRunId || input.agent_run_id || agentRun.id || null,
    slackSessionId: input.slackSessionId || input.slack_session_id || slackSession.id || null,
  };
}

async function* streamCompanyOpenAiGatewayTurnEvents({ input, config, messages, fetchImpl, signal, fallbackAnalysis }) {
  const headers = {
    'Content-Type': 'application/json',
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const response = await fetchImpl(companyChatCompletionsUrl(config), {
    method: 'POST',
    headers,
    body: JSON.stringify(buildCompanyChatCompletionsBody(config, messages, { stream: true })),
    signal,
  });
  if (!response.ok) {
    throw modelError(`Slack Agent company OpenAI-compatible gateway failed: HTTP ${response.status}`, 502);
  }

  const chunker = new SemanticChunker(config);
  let rawContent = '';
  let lastVisibleLength = 0;
  let emittedVisible = '';

  for await (const payload of readOpenAiCompatibleStreamPayloads(response)) {
    const delta = extractOpenAiStreamDelta(payload);
    if (!delta) continue;
    rawContent += delta;
    const visible = partialVisibleReply(rawContent);
    if (!visible.found || visible.value.length <= lastVisibleLength) continue;

    const newText = visible.value.slice(lastVisibleLength);
    lastVisibleLength = visible.value.length;
    for (const chunk of chunker.push(newText)) {
      emittedVisible += chunk;
      yield { type: 'reply_delta', text: chunk };
    }
  }

  const rawAnalysis =
    extractOpenAiCompatibleAnalysis({ choices: [{ message: { content: rawContent } }] }) ||
    extractGatewayAnalysis({ rawText: rawContent });
  if (!rawAnalysis) {
    throw modelError('Slack Agent company gateway response did not contain a JSON analysis object', 502);
  }

  const analysis = {
    ...normalizeModelAnalysis(rawAnalysis, fallbackAnalysis, input),
    modelProvider: config.modelProvider || 'company-agent',
    modelName: config.modelName || null,
    modelApiStyle: 'company-openai-compatible',
  };
  const finalVisible = visibleSlackAgentReply(analysis);
  for (const chunk of chunker.flush()) {
    emittedVisible += chunk;
    yield { type: 'reply_delta', text: chunk };
  }
  if (!emittedVisible) {
    for (const chunk of splitSemanticChunks(finalVisible, config)) {
      emittedVisible += chunk;
      yield { type: 'reply_delta', text: chunk };
    }
  }
  yield { type: 'analysis_final', analysis };
}

async function* fallbackTurnEvents(input, options, analysis) {
  const visibleText = visibleSlackAgentReply(analysis);
  for (const chunk of splitSemanticChunks(visibleText, options.config || {})) {
    yield { type: 'reply_delta', text: chunk };
  }
  yield { type: 'analysis_final', analysis };
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

export async function summarizeMergeAnnouncementWithProvider(input = {}, options = {}) {
  const config = options.config || {};
  const fallback = fallbackMergeSummary(input);
  if (config.modelProvider === 'deterministic') {
    return {
      ...fallback,
      source: 'deterministic',
      modelProvider: 'deterministic',
      modelApiStyle: 'deterministic',
    };
  }

  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number(config.mergeSummaryTimeoutMs || config.requestTimeoutMs || 30_000);
  const controller = new globalThis.AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const messages = buildMergeSummaryMessages(input);

  try {
    const rawSummary = await callCompanyOpenAiGateway({
      config: {
        ...config,
        modelName: config.mergeSummaryModel || config.modelName,
      },
      messages,
      fetchImpl,
      signal: controller.signal,
    });

    if (!rawSummary) {
      throw modelError('Slack Agent merge summary response did not contain a JSON object', 502);
    }

    const summary = {
      ...normalizeMergeSummary(rawSummary, fallback),
      source: 'agent',
      modelProvider: config.modelProvider || 'company-agent',
      modelName: config.mergeSummaryModel || config.modelName || null,
      modelApiStyle: 'company-openai-compatible',
    };
    logSlackAgentModelCall({
      input: { ...input, text: input.prTitle || '' },
      config,
      messages,
      status: 'ok',
      durationMs: Date.now() - startedAt,
      analysis: { intent: 'merge_announcement_summary', needsClarification: false },
    });
    return summary;
  } catch (err) {
    logSlackAgentModelCall({
      input: { ...input, text: input.prTitle || '' },
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

export async function answerRepoQuestionWithProvider(input = {}, options = {}) {
  const config = options.config || {};
  const fallback = fallbackRepoAnswer(input);
  if (config.modelProvider === 'deterministic') {
    return {
      ...fallback,
      source: 'deterministic',
      modelProvider: 'deterministic',
      modelApiStyle: 'deterministic',
    };
  }

  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number(config.repoAnswerTimeoutMs || config.requestTimeoutMs || 45_000);
  const controller = new globalThis.AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const messages = buildRepoAnswerMessages(input);

  try {
    const rawAnswer = await callCompanyOpenAiGateway({
      config: {
        ...config,
        modelName: config.repoAnswerModel || config.modelName,
      },
      messages,
      fetchImpl,
      signal: controller.signal,
    });

    if (!rawAnswer) {
      throw modelError('Slack Agent repo answer response did not contain a JSON object', 502);
    }

    const answer = {
      ...normalizeRepoAnswer(rawAnswer, fallback),
      source: 'agent',
      modelProvider: config.modelProvider || 'company-agent',
      modelName: config.repoAnswerModel || config.modelName || null,
      modelApiStyle: 'company-openai-compatible',
    };
    logSlackAgentModelCall({
      input: { ...input, text: input.question || '' },
      config,
      messages,
      status: 'ok',
      durationMs: Date.now() - startedAt,
      analysis: { intent: 'repo_question_answer', needsClarification: false },
    });
    return answer;
  } catch (err) {
    logSlackAgentModelCall({
      input: { ...input, text: input.question || '' },
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

export async function planRepoResearchWithProvider(input = {}, options = {}) {
  const config = options.config || {};
  const fallback = fallbackRepoPlan(input);
  if (config.modelProvider === 'deterministic') {
    return {
      ...fallback,
      source: 'deterministic',
      modelProvider: 'deterministic',
      modelApiStyle: 'deterministic',
    };
  }

  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = Number(config.repoPlanTimeoutMs || config.repoAnswerTimeoutMs || config.requestTimeoutMs || 30_000);
  const controller = new globalThis.AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const messages = buildRepoPlanMessages(input);

  try {
    const rawPlan = await callCompanyOpenAiGateway({
      config: {
        ...config,
        modelName: config.repoPlanModel || config.repoAnswerModel || config.modelName,
      },
      messages,
      fetchImpl,
      signal: controller.signal,
    });

    if (!rawPlan) {
      throw modelError('Slack Agent repo plan response did not contain a JSON object', 502);
    }

    const plan = {
      ...normalizeRepoPlan(rawPlan, fallback),
      source: 'agent',
      modelProvider: config.modelProvider || 'company-agent',
      modelName: config.repoPlanModel || config.repoAnswerModel || config.modelName || null,
      modelApiStyle: 'company-openai-compatible',
    };
    logSlackAgentModelCall({
      input: { ...input, text: input.question || '' },
      config,
      messages,
      status: 'ok',
      durationMs: Date.now() - startedAt,
      analysis: { intent: 'repo_research_plan', needsClarification: false },
    });
    return plan;
  } catch (err) {
    logSlackAgentModelCall({
      input: { ...input, text: input.question || '' },
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

export async function* streamSlackAgentTurnEvents(input = {}, options = {}) {
  const config = options.config || {};
  const fallbackAnalysis = analyzeSlackRequirementDeterministic(input);
  const ids = turnIdsFromInput(input);
  let sequence = 1;
  const eventBase = {
    ...ids,
    visibleToUser: true,
  };

  yield { ...eventBase, type: 'reply_started', sequence: sequence++ };

  const emit = async function* (eventStream) {
    for await (const event of eventStream) {
      yield {
        ...eventBase,
        ...event,
        agentRunId: event.agentRunId || eventBase.agentRunId,
        slackSessionId: event.slackSessionId || eventBase.slackSessionId,
        sequence: sequence++,
      };
    }
  };

  if (config.modelProvider === 'deterministic') {
    const analysis = {
      ...fallbackAnalysis,
      modelProvider: 'deterministic',
      modelApiStyle: 'deterministic',
    };
    yield* emit(fallbackTurnEvents(input, options, analysis));
    yield { ...eventBase, type: 'reply_completed', sequence: sequence++ };
    return;
  }

  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = config.requestTimeoutMs || 120_000;
  const controller = new globalThis.AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  const messages = buildSlackAgentMessages(input, fallbackAnalysis);

  try {
    if (config.streamingEnabled === false) {
      const analysis = await analyzeSlackRequirementWithProvider(input, options);
      yield* emit(fallbackTurnEvents(input, options, analysis));
    } else {
      let finalAnalysis = null;
      const streamingEvents = streamCompanyOpenAiGatewayTurnEvents({
        input,
        config,
        messages,
        fetchImpl,
        signal: controller.signal,
        fallbackAnalysis,
      });
      for await (const event of emit(streamingEvents)) {
        if (event.type === 'analysis_final') finalAnalysis = event.analysis;
        yield event;
      }
      logSlackAgentModelCall({
        input,
        config,
        messages,
        status: 'ok',
        durationMs: Date.now() - startedAt,
        analysis: finalAnalysis,
      });
    }
    yield { ...eventBase, type: 'reply_completed', sequence: sequence++ };
  } catch (err) {
    logSlackAgentModelCall({
      input,
      config,
      messages,
      status: 'error',
      durationMs: Date.now() - startedAt,
      error: err,
    });
    yield {
      ...eventBase,
      type: 'reply_failed',
      sequence: sequence++,
      text: '这轮需求整理失败了，请稍后重试，或直接补充更具体的信息。',
      error: err.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}
