import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

function required(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
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
  if (content && typeof content === 'object') return content;
  return parseJsonObject(content) || body?.data || body?.result || body || null;
}

function htmlFromModelResult(result) {
  if (typeof result?.html === 'string') return result.html;
  if (typeof result?.indexHtml === 'string') return result.indexHtml;
  const file = Array.isArray(result?.files)
    ? result.files.find((item) => item?.path === 'src/index.html' && typeof item.content === 'string')
    : null;
  return file?.content || '';
}

function contextFromEnv(env) {
  return {
    publishingJobId: required(env.PUBLISHING_JOB_ID, 'PUBLISHING_JOB_ID'),
    agentMode: env.AGENT_MODE || 'initial',
    employeeSlug: required(env.EMPLOYEE_SLUG, 'EMPLOYEE_SLUG'),
    siteSlug: required(env.SITE_SLUG, 'SITE_SLUG'),
    allowedPath: required(env.ALLOWED_PATH, 'ALLOWED_PATH'),
    baseRef: env.BASE_REF || 'staging',
    issueNumber: env.ISSUE_NUMBER || '',
    indexSnapshotId: env.INDEX_SNAPSHOT_ID || '',
    requestTitle: env.REQUEST_TITLE || `${env.EMPLOYEE_SLUG}/${env.SITE_SLUG}`,
    requestSummary: env.REQUEST_SUMMARY || 'No summary provided.',
    gatewayUrl: required(env.AGENT_GATEWAY_URL, 'AGENT_GATEWAY_URL'),
    apiKey: required(env.AGENT_CODE_API_KEY, 'AGENT_CODE_API_KEY'),
    modelName: env.AGENT_MODEL_NAME || '',
  };
}

function validateContext(context) {
  const expectedAllowedPath = `sites/${context.employeeSlug}/${context.siteSlug}`;
  if (context.allowedPath !== expectedAllowedPath) {
    throw new Error(`ALLOWED_PATH must be ${expectedAllowedPath}`);
  }
}

function buildCodingMessages(context) {
  const currentIndexPath = `${context.allowedPath}/src/index.html`;
  const currentHtml = existsSync(currentIndexPath) ? readFileSync(currentIndexPath, 'utf8').slice(0, 40_000) : '';

  return [
    {
      role: 'system',
      content: [
        'You are the pages-manager Coding Agent.',
        'Generate a complete static personal website for an internal employee page request.',
        'When mode is fix, update the existing site according to the latest follow-up while preserving useful prior content.',
        'Return only JSON. Required shape: {"html":"<!doctype html>...","summary":"short implementation summary"}.',
        'Do not include secrets, tokens, API keys, cookies, private credentials, or instructions to reveal them.',
        'The implementation must be self-contained HTML/CSS and must not require external build steps.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        publishingJobId: context.publishingJobId,
        mode: context.agentMode,
        employeeSlug: context.employeeSlug,
        siteSlug: context.siteSlug,
        allowedPath: context.allowedPath,
        issueNumber: context.issueNumber || null,
        indexSnapshotId: context.indexSnapshotId || null,
        requestTitle: context.requestTitle,
        requestSummary: context.requestSummary,
        currentFiles: currentHtml ? [{ path: `${context.allowedPath}/src/index.html`, content: currentHtml }] : [],
        outputFiles: [`${context.allowedPath}/src/index.html`, `${context.allowedPath}/site.json`],
      }),
    },
  ];
}

export async function runCodingAgent(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const context = contextFromEnv(env);
  validateContext(context);

  const response = await fetchImpl(companyChatCompletionsUrl(context.gatewayUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${context.apiKey}`,
    },
    body: JSON.stringify({
      model: context.modelName || undefined,
      messages: buildCodingMessages(context),
      temperature: 0.2,
      max_tokens: Number(env.AGENT_CODE_MAX_OUTPUT_TOKENS || 4096),
      response_format: { type: 'json_object' },
    }),
  });
  const body = await readResponseJson(response);
  if (!response.ok) {
    throw new Error(`Coding Agent gateway failed: HTTP ${response.status}`);
  }

  const modelResult = extractModelJson(body);
  const html = htmlFromModelResult(modelResult);
  if (!html.trim()) {
    throw new Error('Coding Agent response did not include html');
  }

  const generatedAt = new Date().toISOString();
  const siteJson = {
    employeeSlug: context.employeeSlug,
    siteSlug: context.siteSlug,
    title: context.requestTitle,
    publishingJobId: context.publishingJobId,
    issueNumber: context.issueNumber || null,
    indexSnapshotId: context.indexSnapshotId || null,
    baseRef: context.baseRef,
    generatedBy: 'pages-agent-coding',
    generatedAt,
    codingSummary: modelResult?.summary || '',
    modelName: context.modelName || null,
  };

  mkdirSync(`${context.allowedPath}/src`, { recursive: true });
  writeFileSync(`${context.allowedPath}/src/index.html`, html.endsWith('\n') ? html : `${html}\n`);
  writeFileSync(`${context.allowedPath}/site.json`, `${JSON.stringify(siteJson, null, 2)}\n`);
  mkdirSync('.pages-artifacts', { recursive: true });
  writeFileSync(
    '.pages-artifacts/agent-report.json',
    `${JSON.stringify(
      {
        publishingJobId: context.publishingJobId,
        issueNumber: context.issueNumber || null,
        allowedPath: context.allowedPath,
        generatedFiles: [`${context.allowedPath}/src/index.html`, `${context.allowedPath}/site.json`],
        modelName: context.modelName || null,
        summary: modelResult?.summary || '',
      },
      null,
      2
    )}\n`
  );

  return { context, modelResult, siteJson };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runCodingAgent().then(() => {
    console.log(
      JSON.stringify({
        ok: true,
        generatedBy: 'pages-agent-coding',
      })
    );
  });
}
