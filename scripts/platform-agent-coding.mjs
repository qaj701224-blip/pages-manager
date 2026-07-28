import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, normalize, posix, relative, sep } from 'node:path';

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function optionalReasoningEffort(value) {
  const normalized = String(value === undefined || value === null ? 'medium' : value)
    .trim()
    .toLowerCase();
  if (!normalized || ['off', 'false', 'none', 'disabled'].includes(normalized)) return undefined;
  return normalized;
}

function trimTrailingSlash(value = '') {
  return String(value || '').replace(/\/+$/, '');
}

export function companyChatCompletionsUrl(baseUrl) {
  const normalized = trimTrailingSlash(baseUrl);
  if (!normalized) throw new Error('AGENT_GATEWAY_URL is required');
  if (normalized.endsWith('/chat/completions')) return normalized;
  if (normalized.endsWith('/v1')) return `${normalized}/chat/completions`;
  return `${normalized}/v1/chat/completions`;
}

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

function isPlainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function textFromContentParts(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item;
        if (!isPlainObject(item)) return '';
        return textFromContentParts(item.text || item.content || item.value || '');
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function stripCodeFence(value) {
  const text = String(value || '').trim();
  const fence = text.match(/^```(?:[a-z0-9_-]+)?\s*\n([\s\S]*?)\n```$/i);
  return fence ? fence[1].trim() : text;
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

function extractModelJson(body) {
  const content = body?.choices?.[0]?.message?.content || body?.choices?.[0]?.text || body?.output_text;
  if (isPlainObject(content)) return content;
  if (isPlainObject(body?.choices?.[0]?.message?.parsed)) return body.choices[0].message.parsed;
  const contentText = textFromContentParts(content);
  const parsedContent = parseJsonObject(contentText);
  if (parsedContent) return parsedContent;
  if (isPlainObject(body?.data)) return body.data;
  if (isPlainObject(body?.result)) return body.result;
  if (isPlainObject(body?.output)) return body.output;
  if (typeof body?.output === 'string') return parseJsonObject(body.output);
  if (typeof body?.content === 'string') return parseJsonObject(body.content);
  if (typeof body?.rawText === 'string') return parseJsonObject(body.rawText);
  return body || null;
}

function summarizeShape(value, depth = 0) {
  if (value === null || value === undefined) return { type: String(value) };
  if (typeof value === 'string') {
    return {
      type: 'string',
      length: value.length,
      looksLikeJsonObject: Boolean(parseJsonObject(value)),
    };
  }
  if (typeof value !== 'object') return { type: typeof value };
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      sample: depth >= 2 ? undefined : value.slice(0, 3).map((item) => summarizeShape(item, depth + 1)),
    };
  }

  const keys = Object.keys(value);
  const sample = {};
  if (depth < 2) {
    for (const key of keys.slice(0, 12)) {
      sample[key] = summarizeShape(value[key], depth + 1);
    }
  }

  return {
    type: 'object',
    keys: keys.slice(0, 30),
    sample,
  };
}

function writeDiagnostic({ body, modelResult, context, reason }) {
  mkdirSync('.pages-artifacts', { recursive: true });
  const firstChoice = body?.choices?.[0] || {};
  const firstMessage = firstChoice.message || {};
  const diagnostic = {
    reason,
    platformDevItemId: context.platformDevItemId,
    modelName: context.modelName || null,
    finishReason: firstChoice.finish_reason || null,
    messageContentLength: typeof firstMessage.content === 'string' ? firstMessage.content.length : null,
    completionTokens: body?.usage?.completion_tokens ?? null,
    reasoningTokens: body?.usage?.completion_tokens_details?.reasoning_tokens ?? null,
    responseShape: summarizeShape(body),
    modelResultShape: summarizeShape(modelResult),
  };
  writeFileSync('.pages-artifacts/platform-agent-debug.json', `${JSON.stringify(diagnostic, null, 2)}\n`);
}

function contextFromEnv(env) {
  return {
    platformDevItemId: required(env.PLATFORM_DEV_ITEM_ID, 'PLATFORM_DEV_ITEM_ID'),
    agentMode: env.AGENT_MODE || 'initial',
    issueNumber: env.ISSUE_NUMBER || '',
    prNumber: env.PR_NUMBER || '',
    headSha: env.HEAD_SHA || '',
    requestTitle: env.REQUEST_TITLE || 'Platform change',
    requestSummary: env.REQUEST_SUMMARY || 'No summary provided.',
    issueType: required(env.ISSUE_TYPE, 'ISSUE_TYPE'),
    areas: env.AREAS || '',
    risk: required(env.RISK, 'RISK'),
    effectiveRisk: required(env.RISK, 'RISK'),
    autoDevTriggered: String(env.AUTO_DEV_TRIGGERED || 'false').toLowerCase() === 'true',
    baseRef: env.BASE_REF || 'master',
    branchName: env.AGENT_BRANCH_NAME || env.BRANCH_NAME || '',
    gatewayUrl: required(env.AGENT_GATEWAY_URL, 'AGENT_GATEWAY_URL'),
    apiKey: required(env.AGENT_CODE_API_KEY, 'AGENT_CODE_API_KEY'),
    modelName: env.AGENT_MODEL_NAME || '',
    reviewContext: env.REVIEW_CONTEXT || '',
    memoryContext: env.MEMORY_CONTEXT || '',
    statusContext: env.STATUS_CONTEXT || '',
    followupContext: env.FOLLOWUP_CONTEXT || '',
  };
}

function validateContext(context) {
  if (!/^pdev_[A-Za-z0-9_]{1,80}$/.test(context.platformDevItemId)) {
    throw new Error('PLATFORM_DEV_ITEM_ID must be a pdev_ id');
  }
  if (!/^type:(dev|bug|docs|feedback|question|ci|ops|security)$/.test(context.issueType)) {
    throw new Error('ISSUE_TYPE is invalid');
  }
  if (!/^risk:(low|medium|high)$/.test(context.risk)) {
    throw new Error('RISK is invalid');
  }
  context.effectiveRisk = ['type:ci', 'type:ops', 'type:security'].includes(context.issueType) ? 'risk:high' : context.risk;
  if (!context.autoDevTriggered) {
    throw new Error('Platform work must be manually triggered before coding agent execution');
  }
}

function safeReadFile(path, maxLength = 50_000) {
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf8');
  return content.length > maxLength ? content.slice(0, maxLength) : content;
}

function collectContextFiles() {
  const paths = [
    'AGENTS.md',
    'package.json',
    'apps/slack-agent/src/analysis.js',
    'apps/gateway/src/control-plane/executor-callback-handlers.js',
    'apps/gateway/src/control-plane/github-webhook-handlers.js',
    'apps/gateway/src/control-plane/shared.js',
    'apps/gateway/src/control-plane/slack-event-handlers.js',
    'apps/gateway/src/control-plane/slack-interaction-handlers.js',
    'apps/gateway/src/slack/issue-confirmation.js',
    'apps/gateway/src/slack/platform-input.js',
    'apps/gateway/src/slack/platform-notifier.js',
    'apps/worker/src/jobs/platform-dev.js',
    'packages/workflow-core/src/index.js',
    'packages/git-client/src/index.js',
    'docs/architecture/platform-dev-lane.md',
  ];

  return paths
    .map((path) => ({ path, content: safeReadFile(path) }))
    .filter((file) => file.content !== null);
}

function buildCodingMessages(context) {
  return [
    {
      role: 'system',
      content: [
        'You are the pages-manager Platform Coding Agent.',
        'Implement changes for the pages-manager repository itself.',
        'Return only JSON with shape: {"files":[{"path":"repo/relative/path","content":"complete file content"}],"summary":"short summary","tests":["test command"]}.',
        'Each file content must be the complete final content for that file, not a patch.',
        'Keep changes directly scoped to the Platform Dev issue.',
        'Do not include secrets, tokens, cookies, private credentials, local env values, or real internal account data.',
        'Do not modify production deploy behavior, Cloudflare runtime resources, Aliyun credentials, ACK/K8s secrets, or user site content unless the issue explicitly asks and auto-dev has been manually triggered.',
        'Do not write files under node_modules, .git, .pages-artifacts, dist, build outputs, local env files, or wrangler.toml.',
        'Prefer existing project patterns, node:test coverage, and the documented architecture.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        platformDevItemId: context.platformDevItemId,
        mode: context.agentMode,
        issueNumber: context.issueNumber || null,
        prNumber: context.prNumber || null,
        headSha: context.headSha || null,
        issueType: context.issueType,
        areas: context.areas,
        risk: context.effectiveRisk,
        declaredRisk: context.risk,
        autoDevTriggered: context.autoDevTriggered,
        baseRef: context.baseRef,
        branchName: context.branchName || null,
        requestTitle: context.requestTitle,
        requestSummary: context.requestSummary,
        reviewContext: context.reviewContext,
        memoryContext: context.memoryContext,
        statusContext: context.statusContext,
        followupContext: context.followupContext,
        currentFiles: collectContextFiles(),
      }),
    },
  ];
}

function normalizeRepoPath(rawPath) {
  const stripped = String(rawPath || '')
    .trim()
    .replace(/^\.\/+/, '')
    .replaceAll('\\', '/');
  const normalized = posix.normalize(stripped);
  if (!normalized || normalized === '.' || normalized.startsWith('../') || normalized === '..' || posix.isAbsolute(normalized)) {
    throw new Error(`Generated path is outside the repository: ${rawPath}`);
  }
  return normalized;
}

function isForbiddenPath(path) {
  return (
    path === '.env' ||
    path.startsWith('.env.') ||
    path.endsWith('/.env') ||
    path.includes('/.env.') ||
    path.endsWith('wrangler.toml') ||
    path.startsWith('.git/') ||
    path.startsWith('node_modules/') ||
    path.startsWith('.pages-artifacts/') ||
    path.startsWith('dist/') ||
    path.startsWith('build/')
  );
}

function requiresHighRiskManualTriggerForPath(path) {
  return (
    path.startsWith('.github/') ||
    path.startsWith('k8s/') ||
    path.startsWith('deploy/') ||
    path.startsWith('docker/') ||
    path === 'Dockerfile' ||
    path.startsWith('Dockerfile.') ||
    path.startsWith('scripts/deploy') ||
    path.startsWith('scripts/k8s') ||
    path.startsWith('scripts/put-') ||
    path.includes('/deploy') ||
    path.includes('/k8s')
  );
}

function hasSecretLikeContent(content) {
  const text = String(content || '');
  if (
    /(xox[baprs]-|xapp-|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|BEGIN (RSA|OPENSSH|EC) PRIVATE KEY)/.test(
      text
    )
  ) {
    return true;
  }

  return /(?:CF_API_TOKEN|SLACK_AGENT_API_KEY|AGENT_CODE_API_KEY)\s*[:=]\s*['"]?(?!\$\{\{\s*secrets\.|process\.env\.|\$\{|<|YOUR_|REPLACE_|example|placeholder|xxx|redacted|not-set|do-not-set)([A-Za-z0-9_./+=-]{8,})/i.test(
    text
  );
}

function generatedFilesFromResult(result, context, seen = new Set(), depth = 0) {
  if (!result || depth > 6) return [];
  if (typeof result === 'string') {
    const parsed = parseJsonObject(result);
    return parsed ? generatedFilesFromResult(parsed, context, seen, depth + 1) : [];
  }
  if (!isPlainObject(result) || seen.has(result)) return [];
  seen.add(result);

  const fileArrays = [result.files, result.outputFiles, result.generatedFiles].filter(Array.isArray);
  const files = [];
  for (const fileArray of fileArrays) {
    for (const file of fileArray) {
      if (!isPlainObject(file)) continue;
      const path = file.path || file.name || file.filename;
      const content = file.content ?? file.body ?? file.text ?? file.code;
      if (typeof path === 'string' && typeof content === 'string') {
        files.push({ path, content: stripCodeFence(content) });
      }
    }
  }

  if (isPlainObject(result.files)) {
    for (const [path, content] of Object.entries(result.files)) {
      if (typeof content === 'string') files.push({ path, content: stripCodeFence(content) });
      else if (isPlainObject(content) && typeof (content.content || content.body || content.code) === 'string') {
        files.push({ path, content: stripCodeFence(content.content || content.body || content.code) });
      }
    }
  }

  if (files.length) return files;

  for (const key of ['result', 'data', 'output', 'response', 'message']) {
    const nestedFiles = generatedFilesFromResult(result[key], context, seen, depth + 1);
    if (nestedFiles.length) return nestedFiles;
  }
  return [];
}

function validateGeneratedFiles(files, context = {}) {
  if (!files.length) {
    const error = new Error(
      'Platform Coding Agent response did not include files; check whether this is a question/diagnosis request or needs a clearer code-change goal'
    );
    error.code = 'missing_files';
    throw error;
  }

  const seen = new Set();
  return files.map((file) => {
    const path = normalizeRepoPath(file.path);
    if (seen.has(path)) throw new Error(`Generated duplicate file path: ${path}`);
    seen.add(path);
    if (isForbiddenPath(path)) throw new Error(`Generated path is forbidden for Platform Agent: ${path}`);
    if (requiresHighRiskManualTriggerForPath(path) && (context.effectiveRisk !== 'risk:high' || !context.autoDevTriggered)) {
      throw new Error(`Generated path requires a manual auto-dev trigger: ${path}`);
    }
    if (hasSecretLikeContent(file.content)) throw new Error(`Generated file contains secret-looking content: ${path}`);
    return { path, content: file.content.endsWith('\n') ? file.content : `${file.content}\n` };
  });
}

function writeGeneratedFiles(files) {
  for (const file of files) {
    const localPath = normalize(file.path).split(posix.sep).join(sep);
    const repoRelative = relative(process.cwd(), localPath);
    if (repoRelative.startsWith('..') || repoRelative === '') {
      throw new Error(`Generated path is outside the repository: ${file.path}`);
    }
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, file.content);
  }
}

function summaryFromResult(result) {
  if (!isPlainObject(result)) return '';
  return String(result.summary || result.changeSummary || result.description || '').trim();
}

export async function runPlatformCodingAgent(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const context = contextFromEnv(env);
  validateContext(context);

  const requestBody = {
    model: context.modelName || undefined,
    messages: buildCodingMessages(context),
    max_tokens: Number(env.AGENT_CODE_MAX_OUTPUT_TOKENS || 16_384),
    max_completion_tokens: Number(env.AGENT_CODE_MAX_COMPLETION_TOKENS || env.AGENT_CODE_MAX_OUTPUT_TOKENS || 16_384),
    response_format: { type: 'json_object' },
  };
  const temperature = optionalNumber(env.AGENT_CODE_TEMPERATURE || env.AGENT_MODEL_TEMPERATURE);
  if (temperature !== undefined) requestBody.temperature = temperature;
  const reasoningEffort = optionalReasoningEffort(env.AGENT_CODE_REASONING_EFFORT);
  if (reasoningEffort !== undefined) requestBody.reasoning_effort = reasoningEffort;

  const response = await fetchImpl(companyChatCompletionsUrl(context.gatewayUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${context.apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });
  const body = await readResponseJson(response);
  if (!response.ok) throw new Error(`Platform Coding Agent gateway failed: HTTP ${response.status}`);

  const modelResult = extractModelJson(body);
  let files = generatedFilesFromResult(modelResult, context);
  try {
    files = validateGeneratedFiles(files, context);
  } catch (error) {
    const reason = error.code === 'missing_files' ? 'missing_files' : 'invalid_files';
    writeDiagnostic({ body, modelResult, context, reason });
    throw error;
  }
  writeGeneratedFiles(files);

  mkdirSync('.pages-artifacts', { recursive: true });
  const report = {
    platformDevItemId: context.platformDevItemId,
    issueNumber: context.issueNumber || null,
    prNumber: context.prNumber || null,
    headSha: context.headSha || null,
    issueType: context.issueType,
    areas: context.areas,
    risk: context.effectiveRisk,
    declaredRisk: context.risk,
    autoDevTriggered: context.autoDevTriggered,
    baseRef: context.baseRef,
    contextReceived: {
      review: Boolean(String(context.reviewContext || '').trim()),
      memory: Boolean(String(context.memoryContext || '').trim()),
      status: Boolean(String(context.statusContext || '').trim()),
      followup: Boolean(String(context.followupContext || '').trim()),
    },
    generatedFiles: files.map((file) => file.path),
    modelName: context.modelName || null,
    summary: summaryFromResult(modelResult),
  };
  writeFileSync('.pages-artifacts/platform-agent-report.json', `${JSON.stringify(report, null, 2)}\n`);
  return { context, modelResult, report };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPlatformCodingAgent().then((result) => {
    console.log(
      JSON.stringify({
        ok: true,
        generatedBy: 'platform-agent-coding',
        files: result.report.generatedFiles,
      })
    );
  });
}
