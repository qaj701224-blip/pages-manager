import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

function required(value, name) {
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
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
  const fence = text.match(/^```(?:html|json)?\s*\n([\s\S]*?)\n```$/i);
  return fence ? fence[1].trim() : text;
}

function looksLikeHtml(value) {
  return /<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<main[\s>]|<section[\s>]|<article[\s>]|<div[\s>]|<h1[\s>]|<style[\s>]/i.test(
    String(value || '')
  );
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

function pathMatchesIndexHtml(path, context = {}) {
  const value = String(path || '').replace(/^\.\/+/, '');
  const allowedPath = String(context.allowedPath || '').replace(/^\.\/+/, '');
  return (
    value === 'src/index.html' ||
    value === 'index.html' ||
    (allowedPath && value === `${allowedPath}/src/index.html`) ||
    value.endsWith('/src/index.html')
  );
}

function htmlFromFiles(files, context) {
  if (Array.isArray(files)) {
    const file = files.find((item) => pathMatchesIndexHtml(item?.path || item?.name || item?.filename, context));
    const content = file?.content || file?.html || file?.body;
    if (typeof content === 'string' && looksLikeHtml(stripCodeFence(content))) {
      return stripCodeFence(content);
    }
  }

  if (isPlainObject(files)) {
    for (const [path, content] of Object.entries(files)) {
      if (!pathMatchesIndexHtml(path, context)) continue;
      if (typeof content === 'string' && looksLikeHtml(stripCodeFence(content))) {
        return stripCodeFence(content);
      }
      if (isPlainObject(content)) {
        const nested = content.content || content.html || content.body;
        if (typeof nested === 'string' && looksLikeHtml(stripCodeFence(nested))) {
          return stripCodeFence(nested);
        }
      }
    }
  }

  return '';
}

function htmlFromModelResult(result, context = {}, seen = new Set(), depth = 0) {
  if (!result || depth > 6) return '';

  if (typeof result === 'string') {
    const parsed = parseJsonObject(result);
    if (parsed) return htmlFromModelResult(parsed, context, seen, depth + 1);
    const normalized = stripCodeFence(result);
    return looksLikeHtml(normalized) ? normalized : '';
  }

  if (!isPlainObject(result) || seen.has(result)) return '';
  seen.add(result);

  const directKeys = ['html', 'indexHtml', 'indexHTML', 'index_html', 'index', 'content', 'fileContent', 'code'];
  for (const key of directKeys) {
    const value = result[key];
    if (typeof value !== 'string') continue;
    const parsed = parseJsonObject(value);
    if (parsed) {
      const nestedHtml = htmlFromModelResult(parsed, context, seen, depth + 1);
      if (nestedHtml) return nestedHtml;
    }
    const normalized = stripCodeFence(value);
    if (looksLikeHtml(normalized)) return normalized;
  }

  const fileHtml = htmlFromFiles(result.files || result.outputFiles || result.generatedFiles, context);
  if (fileHtml) return fileHtml;

  const nestedKeys = ['result', 'data', 'output', 'response', 'message'];
  for (const key of nestedKeys) {
    const nestedHtml = htmlFromModelResult(result[key], context, seen, depth + 1);
    if (nestedHtml) return nestedHtml;
  }

  return '';
}

function summarizeShape(value, depth = 0) {
  if (value === null || value === undefined) return { type: String(value) };
  if (typeof value === 'string') {
    return {
      type: 'string',
      length: value.length,
      looksLikeHtml: looksLikeHtml(value),
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

function writeMissingHtmlDiagnostic({ body, modelResult, context }) {
  mkdirSync('.pages-artifacts', { recursive: true });
  const diagnostic = {
    reason: 'missing_html',
    publishingJobId: context.publishingJobId,
    allowedPath: context.allowedPath,
    modelName: context.modelName || null,
    responseShape: summarizeShape(body),
    modelResultShape: summarizeShape(modelResult),
  };
  writeFileSync('.pages-artifacts/agent-debug.json', `${JSON.stringify(diagnostic, null, 2)}\n`);
  console.error(
    JSON.stringify({
      service: 'pages-agent-coding',
      message: 'coding_agent_missing_html',
      publishingJobId: context.publishingJobId,
      allowedPath: context.allowedPath,
      modelName: context.modelName || null,
      responseShape: diagnostic.responseShape,
      modelResultShape: diagnostic.modelResultShape,
    })
  );
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

  const requestBody = {
    model: context.modelName || undefined,
    messages: buildCodingMessages(context),
    max_tokens: Number(env.AGENT_CODE_MAX_OUTPUT_TOKENS || 4096),
    response_format: { type: 'json_object' },
  };
  const temperature = optionalNumber(env.AGENT_CODE_TEMPERATURE || env.AGENT_MODEL_TEMPERATURE);
  if (temperature !== undefined) {
    requestBody.temperature = temperature;
  }

  const response = await fetchImpl(companyChatCompletionsUrl(context.gatewayUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${context.apiKey}`,
    },
    body: JSON.stringify(requestBody),
  });
  const body = await readResponseJson(response);
  if (!response.ok) {
    throw new Error(`Coding Agent gateway failed: HTTP ${response.status}`);
  }

  const modelResult = extractModelJson(body);
  const html = htmlFromModelResult(modelResult, context);
  if (!html.trim()) {
    writeMissingHtmlDiagnostic({ body, modelResult, context });
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
