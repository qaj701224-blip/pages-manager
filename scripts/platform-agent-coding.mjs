import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, normalize, posix, relative, sep } from 'node:path';

const DEFAULT_AGENT_MAX_STEPS = 30;
const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
const DEFAULT_TOOL_OUTPUT_MAX_CHARS = 12_000;
const DEFAULT_READ_MAX_LINES = 220;
const DEFAULT_PATCH_MAX_CHARS = 250_000;
const PLATFORM_AGENT_SKILLS_DIR = 'scripts/platform-agent-skills';
const PLATFORM_AGENT_SKILL_MAX_FILES = 12;
const PLATFORM_AGENT_SKILL_MAX_CHARS = 20_000;
const PLATFORM_AGENT_CONTEXT_MAX_CHARS = 12_000;

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function optionalNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function optionalPositiveInteger(value, fallback) {
  const number = optionalNumber(value);
  if (number === undefined || number <= 0) return fallback;
  return Math.floor(number);
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

function truncateText(value, maxChars = DEFAULT_TOOL_OUTPUT_MAX_CHARS) {
  const text = String(value || '');
  if (text.length <= maxChars) return text;
  const omitted = text.length - maxChars;
  return `${text.slice(0, maxChars)}\n[truncated ${omitted} chars]`;
}

function sensitiveEnvEntries(env = process.env) {
  return Object.entries(env).filter(
    ([key, value]) =>
      /TOKEN|SECRET|KEY|PASSWORD|COOKIE|AUTH|CREDENTIAL/i.test(key) && typeof value === 'string' && value.length >= 8
  );
}

function sanitizedChildEnv(env = process.env) {
  const safeEnv = { ...env };
  for (const [key] of sensitiveEnvEntries(env)) {
    delete safeEnv[key];
  }
  return safeEnv;
}

function redactSensitiveText(value) {
  let text = String(value || '');
  for (const [, secret] of sensitiveEnvEntries()) {
    text = text.split(secret).join('[redacted]');
  }
  return text;
}

const NON_CODING_ISSUE_TYPES = new Set(['type:feedback', 'type:question']);

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
    requestTitle: env.REQUEST_TITLE || 'Platform change',
    requestSummary: env.REQUEST_SUMMARY || 'No summary provided.',
    issueType: required(env.ISSUE_TYPE, 'ISSUE_TYPE'),
    areas: env.AREAS || '',
    risk: required(env.RISK, 'RISK'),
    effectiveRisk: required(env.RISK, 'RISK'),
    gateApproved: String(env.GATE_APPROVED || 'false').toLowerCase() === 'true',
    baseRef: env.BASE_REF || 'master',
    branchName: env.AGENT_BRANCH_NAME || env.BRANCH_NAME || '',
    gatewayUrl: required(env.AGENT_GATEWAY_URL, 'AGENT_GATEWAY_URL'),
    apiKey: required(env.AGENT_CODE_API_KEY, 'AGENT_CODE_API_KEY'),
    modelName: env.AGENT_MODEL_NAME || '',
    reviewContext: env.REVIEW_CONTEXT || '',
    memoryContext: env.MEMORY_CONTEXT || '',
    statusContext: env.STATUS_CONTEXT || '',
  };
}

function validateContext(context) {
  if (!/^pdev_[A-Za-z0-9_]{1,80}$/.test(context.platformDevItemId)) {
    throw new Error('PLATFORM_DEV_ITEM_ID must be a pdev_ id');
  }
  if (!/^type:(dev|bug|docs|feedback|question|ci|ops|security)$/.test(context.issueType)) {
    throw new Error('ISSUE_TYPE is invalid');
  }
  if (NON_CODING_ISSUE_TYPES.has(context.issueType)) {
    throw new Error(
      `${context.issueType} is not code-eligible; keep it as a GitHub issue record without dispatching Platform Agent`
    );
  }
  if (!/^risk:(low|medium|high)$/.test(context.risk)) {
    throw new Error('RISK is invalid');
  }
  context.effectiveRisk = ['type:ci', 'type:ops', 'type:security'].includes(context.issueType) ? 'risk:high' : context.risk;
  if (context.effectiveRisk === 'risk:high' && !context.gateApproved) {
    throw new Error('High risk platform work must be gate-approved before coding agent execution');
  }
}

function safeReadFile(path, maxLength = 50_000) {
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf8');
  return content.length > maxLength ? content.slice(0, maxLength) : content;
}

function collectPreloadedSkills() {
  if (!existsSync(PLATFORM_AGENT_SKILLS_DIR)) return [];
  return readdirSync(PLATFORM_AGENT_SKILLS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.name.startsWith('.') && entry.name.endsWith('.md'))
    .map((entry) => posix.join(PLATFORM_AGENT_SKILLS_DIR, entry.name))
    .sort()
    .slice(0, PLATFORM_AGENT_SKILL_MAX_FILES)
    .map((path) => ({ path, content: safeReadFile(path, PLATFORM_AGENT_SKILL_MAX_CHARS) }))
    .filter((file) => file.content !== null);
}

function collectContextFiles() {
  const paths = [
    'AGENTS.md',
    'package.json',
    'apps/slack-agent/src/analysis.js',
    'apps/gateway/src/control-plane/handlers.js',
    'apps/gateway/src/slack/issue-confirmation.js',
    'apps/gateway/src/slack/platform-input.js',
    'apps/gateway/src/slack/platform-notifier.js',
    'apps/worker/src/jobs/platform-dev.js',
    'packages/workflow-core/src/index.js',
    'packages/git-client/src/index.js',
    'docs/architecture/platform-agent.md',
  ];

  return paths.map((path) => ({ path, content: safeReadFile(path) })).filter((file) => file.content !== null);
}

function buildCodingMessages(context) {
  return [
    {
      role: 'system',
      content: [
        'You are the pages-manager Platform Coding Agent.',
        'Implement changes for the pages-manager repository itself.',
        'Respond only with a JSON object.',
        'Use this tool protocol unless you are returning a legacy full-file result:',
        '{"action":"search","query":"text or regex","glob":"optional path glob"}',
        '{"action":"read_file","path":"repo/relative/path","startLine":1,"maxLines":220}',
        '{"action":"apply_patch","patch":"unified git diff"}',
        '{"action":"run_command","cmd":"node|pnpm|npm|npx|rg|git","args":["safe","args"]}',
        '{"action":"git_diff"}',
        '{"action":"git_status"}',
        '{"action":"finish","summary":"short summary","tests":["test command and result"]}',
        'Legacy compatibility is allowed: {"files":[{"path":"repo/relative/path","content":"complete file content"}],"summary":"short summary","tests":["test command"]}.',
        'Keep changes directly scoped to the Platform Dev issue.',
        'Every repository behavior/code change must include a matching documentation update; ordinary Markdown docs must stay under 700 lines.',
        'Do not include secrets, tokens, cookies, private credentials, local env values, or real internal account data.',
        'Do not modify production deploy behavior, Cloudflare runtime resources, Aliyun credentials, ACK/K8s secrets, or user site content unless the issue explicitly asks and risk gate has approved it.',
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
        issueType: context.issueType,
        areas: context.areas,
        risk: context.effectiveRisk,
        declaredRisk: context.risk,
        gateApproved: context.gateApproved,
        baseRef: context.baseRef,
        branchName: context.branchName || null,
        requestTitle: context.requestTitle,
        requestSummary: context.requestSummary,
        reviewContext: truncateText(context.reviewContext, PLATFORM_AGENT_CONTEXT_MAX_CHARS),
        memoryContext: truncateText(context.memoryContext, PLATFORM_AGENT_CONTEXT_MAX_CHARS),
        statusContext: truncateText(context.statusContext, PLATFORM_AGENT_CONTEXT_MAX_CHARS),
        preloadedSkills: collectPreloadedSkills(),
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

function requiresHighRiskGateForPath(path) {
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

function assertAllowedRepoWritePath(path, context, subject = 'Generated path') {
  if (isForbiddenPath(path)) throw new Error(`${subject} is forbidden for Platform Agent: ${path}`);
  if (requiresHighRiskGateForPath(path) && (context.effectiveRisk !== 'risk:high' || !context.gateApproved)) {
    throw new Error(`${subject} requires a high-risk gate approval: ${path}`);
  }
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
    assertAllowedRepoWritePath(path, context, 'Generated path');
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

function testsFromResult(result) {
  if (!isPlainObject(result) || !Array.isArray(result.tests)) return [];
  return result.tests
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

function localPathForRepoPath(path) {
  return normalize(path).split(posix.sep).join(sep);
}

function safeReadRepoFile(rawPath, maxLength = 50_000) {
  const path = normalizeRepoPath(rawPath);
  if (isForbiddenPath(path)) throw new Error(`Read path is forbidden for Platform Agent: ${path}`);
  return { path, content: safeReadFile(localPathForRepoPath(path), maxLength) };
}

function runProcess(cmd, args = [], options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: process.cwd(),
    env: sanitizedChildEnv(),
    encoding: 'utf8',
    timeout: options.timeoutMs || DEFAULT_COMMAND_TIMEOUT_MS,
    maxBuffer: options.maxBuffer || 1024 * 1024 * 20,
    shell: false,
  });

  return {
    status: typeof result.status === 'number' ? result.status : result.error ? 1 : 0,
    signal: result.signal || null,
    timedOut: result.error?.code === 'ETIMEDOUT' || Boolean(result.signal),
    error: result.error ? String(result.error.message || result.error) : '',
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

function formatProcessResult(result, maxChars = DEFAULT_TOOL_OUTPUT_MAX_CHARS) {
  return {
    status: result.status,
    signal: result.signal,
    timedOut: result.timedOut,
    error: truncateText(redactSensitiveText(result.error), maxChars),
    stdout: truncateText(redactSensitiveText(result.stdout), maxChars),
    stderr: truncateText(redactSensitiveText(result.stderr), maxChars),
  };
}

function gitOutput(args, options = {}) {
  const result = runProcess('git', args, options);
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${truncateText(result.stderr || result.stdout || result.error, 2_000)}`);
  }
  return result.stdout;
}

function parseGitDiffNameStatus(output) {
  const files = new Set();
  for (const rawLine of String(output || '').split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const fields = line.split('\t').filter(Boolean);
    if (!fields.length) continue;
    const status = fields[0];
    for (const rawPath of fields.slice(1)) {
      if (!rawPath) continue;
      const normalized = normalizeRepoPath(rawPath);
      files.add(normalized);
      if (status.startsWith('R') || status.startsWith('C')) continue;
    }
  }
  return [...files].sort();
}

function changedFilesFromGit() {
  const stagedAndUnstaged = parseGitDiffNameStatus(gitOutput(['diff', '--name-status']));
  const staged = parseGitDiffNameStatus(gitOutput(['diff', '--cached', '--name-status']));
  const untracked = gitOutput(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((path) => normalizeRepoPath(path));
  return [...new Set([...stagedAndUnstaged, ...staged, ...untracked])].sort();
}

function classifyChangedFiles(files) {
  const docs = [];
  const nonDocs = [];
  for (const file of files) {
    if (file.startsWith('docs/') || file === 'README.md' || file === 'AGENTS.md' || file.endsWith('/README.md')) {
      docs.push(file);
    } else {
      nonDocs.push(file);
    }
  }
  return { docs, nonDocs };
}

function lineCount(path) {
  const content = safeReadFile(localPathForRepoPath(path), 1_000_000);
  if (content === null) return 0;
  if (!content) return 0;
  return content.endsWith('\n') ? content.split('\n').length - 1 : content.split('\n').length;
}

function validateMarkdownLineCounts(files) {
  for (const file of files) {
    if (!file.endsWith('.md')) continue;
    if (file.startsWith('docs/superpowers/')) continue;
    const count = lineCount(file);
    if (count > 700) {
      throw new Error(`Markdown document exceeds 700 lines: ${file} has ${count} lines`);
    }
  }
}

function validateChangedFiles(context, options = {}) {
  const changedFiles = changedFilesFromGit();
  for (const path of changedFiles) {
    assertAllowedRepoWritePath(path, context, 'Changed path');
    const content = safeReadFile(localPathForRepoPath(path), 1_000_000);
    if (content !== null && hasSecretLikeContent(content)) {
      throw new Error(`Changed file contains secret-looking content: ${path}`);
    }
  }
  validateMarkdownLineCounts(changedFiles);
  const { docs, nonDocs } = classifyChangedFiles(changedFiles);
  if (options.requireDocs && nonDocs.length && !docs.length) {
    throw new Error('Platform Coding Agent changed repository behavior/code without a matching documentation update');
  }
  return changedFiles;
}

function extractPatchPaths(patch) {
  const paths = new Set();
  for (const rawLine of String(patch || '').split('\n')) {
    const line = rawLine.trimEnd();
    let rawPath = null;
    if (line.startsWith('diff --git ')) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      if (match) {
        rawPath = match[1] === '/dev/null' ? match[2] : match[1];
        paths.add(normalizeRepoPath(rawPath));
        paths.add(normalizeRepoPath(match[2]));
      }
      continue;
    }
    if (line.startsWith('+++ ') || line.startsWith('--- ')) {
      rawPath = line.slice(4).trim();
      if (rawPath === '/dev/null') continue;
      rawPath = rawPath.replace(/^[ab]\//, '');
      paths.add(normalizeRepoPath(rawPath));
    }
  }
  return [...paths].filter((path) => path && path !== '/dev/null').sort();
}

function validatePatch(patch, context, maxChars) {
  let normalizedPatch = stripCodeFence(patch);
  if (!normalizedPatch.trim()) throw new Error('apply_patch requires a non-empty unified diff');
  if (!normalizedPatch.endsWith('\n')) normalizedPatch = `${normalizedPatch}\n`;
  if (normalizedPatch.length > maxChars) {
    throw new Error(`apply_patch diff is too large: ${normalizedPatch.length} chars`);
  }
  const paths = extractPatchPaths(normalizedPatch);
  if (!paths.length) throw new Error('apply_patch diff did not include any file paths');
  for (const path of paths) {
    assertAllowedRepoWritePath(path, context, 'Patch path');
  }
  return { patch: normalizedPatch, paths };
}

function applyGitPatch(patch, context, limits) {
  const validated = validatePatch(patch, context, limits.patchMaxChars);
  const result = spawnSync('git', ['apply', '--whitespace=nowarn'], {
    cwd: process.cwd(),
    env: sanitizedChildEnv(),
    input: validated.patch,
    encoding: 'utf8',
    timeout: limits.commandTimeoutMs,
    maxBuffer: 1024 * 1024 * 20,
    shell: false,
  });
  const processResult = {
    status: typeof result.status === 'number' ? result.status : result.error ? 1 : 0,
    signal: result.signal || null,
    timedOut: result.error?.code === 'ETIMEDOUT' || Boolean(result.signal),
    error: result.error ? String(result.error.message || result.error) : '',
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
  if (processResult.status !== 0) {
    return {
      ok: false,
      paths: validated.paths,
      ...formatProcessResult(processResult, limits.toolOutputMaxChars),
    };
  }
  const changedFiles = validateChangedFiles(context);
  return {
    ok: true,
    paths: validated.paths,
    changedFiles,
    status: 0,
    stdout: '',
    stderr: '',
  };
}

function parseAction(modelResult) {
  if (!isPlainObject(modelResult)) return null;
  const action = typeof modelResult.action === 'string' ? modelResult.action.trim() : '';
  return action ? { ...modelResult, action } : null;
}

function buildRequestBody(context, messages, env) {
  const requestBody = {
    model: context.modelName || undefined,
    messages,
    max_tokens: Number(env.AGENT_CODE_MAX_OUTPUT_TOKENS || 16_384),
    max_completion_tokens: Number(env.AGENT_CODE_MAX_COMPLETION_TOKENS || env.AGENT_CODE_MAX_OUTPUT_TOKENS || 16_384),
    response_format: { type: 'json_object' },
  };
  const temperature = optionalNumber(env.AGENT_CODE_TEMPERATURE || env.AGENT_MODEL_TEMPERATURE);
  if (temperature !== undefined) requestBody.temperature = temperature;
  const reasoningEffort = optionalReasoningEffort(env.AGENT_CODE_REASONING_EFFORT);
  if (reasoningEffort !== undefined) requestBody.reasoning_effort = reasoningEffort;
  return requestBody;
}

async function requestModel({ context, messages, env, fetchImpl }) {
  const response = await fetchImpl(companyChatCompletionsUrl(context.gatewayUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${context.apiKey}`,
    },
    body: JSON.stringify(buildRequestBody(context, messages, env)),
  });
  const body = await readResponseJson(response);
  if (!response.ok) throw new Error(`Platform Coding Agent gateway failed: HTTP ${response.status}`);
  return { body, modelResult: extractModelJson(body) };
}

function buildToolObservation(name, payload, limits) {
  return {
    role: 'user',
    content: JSON.stringify({
      tool: name,
      result: payload,
      outputLimit: limits.toolOutputMaxChars,
    }),
  };
}

function buildToolLimits(env) {
  return {
    maxSteps: optionalPositiveInteger(env.AGENT_CODE_MAX_STEPS, DEFAULT_AGENT_MAX_STEPS),
    commandTimeoutMs: optionalPositiveInteger(env.AGENT_CODE_COMMAND_TIMEOUT_MS, DEFAULT_COMMAND_TIMEOUT_MS),
    toolOutputMaxChars: optionalPositiveInteger(env.AGENT_CODE_TOOL_OUTPUT_MAX_CHARS, DEFAULT_TOOL_OUTPUT_MAX_CHARS),
    readMaxLines: optionalPositiveInteger(env.AGENT_CODE_READ_MAX_LINES, DEFAULT_READ_MAX_LINES),
    patchMaxChars: optionalPositiveInteger(env.AGENT_CODE_PATCH_MAX_CHARS, DEFAULT_PATCH_MAX_CHARS),
  };
}

function ensureStringArray(value, name) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) {
    throw new Error(`${name} must be an array of strings`);
  }
  return value;
}

function assertSafeCommand(cmd, args) {
  if (!['node', 'pnpm', 'npm', 'npx', 'rg', 'git'].includes(cmd)) {
    throw new Error(`run_command executable is not allowed: ${cmd}`);
  }
  if (cmd === 'git') {
    const subcommand = args[0] || '';
    if (!['diff', 'status', 'show', 'ls-files', 'grep'].includes(subcommand)) {
      throw new Error(`run_command git subcommand is not allowed: ${subcommand}`);
    }
  }
  for (const arg of args) {
    if (arg.includes('\0') || arg.includes('\n') || arg.includes('\r')) {
      throw new Error('run_command args must not contain control line breaks');
    }
  }
}

function runAgentCommand(action, context, limits) {
  const cmd = String(action.cmd || '').trim();
  const args = ensureStringArray(action.args, 'run_command args');
  if (!cmd) throw new Error('run_command requires cmd');
  assertSafeCommand(cmd, args);
  const result = runProcess(cmd, args, { timeoutMs: limits.commandTimeoutMs });
  const formatted = formatProcessResult(result, limits.toolOutputMaxChars);
  const changedFiles = validateChangedFiles(context);
  return changedFiles.length ? { ...formatted, changedFiles } : formatted;
}

function runSearch(action, limits) {
  const query = String(action.query || action.pattern || '').trim();
  if (!query) throw new Error('search requires query');
  const args = [
    '--line-number',
    '--hidden',
    '--glob',
    '!node_modules/**',
    '--glob',
    '!.git/**',
    '--glob',
    '!.pages-artifacts/**',
    '--glob',
    '!.env*',
    '--glob',
    '!**/.env*',
    '--glob',
    '!**/wrangler.toml',
  ];
  if (typeof action.glob === 'string' && action.glob.trim()) {
    args.push('--glob', action.glob.trim());
  }
  args.push(query, '.');
  const result = runProcess('rg', args, { timeoutMs: limits.commandTimeoutMs });
  return formatProcessResult(result, limits.toolOutputMaxChars);
}

function runReadFile(action, limits) {
  const path = normalizeRepoPath(action.path);
  const startLine = Math.max(1, optionalPositiveInteger(action.startLine, 1));
  const maxLines = Math.min(optionalPositiveInteger(action.maxLines, limits.readMaxLines), limits.readMaxLines);
  const file = safeReadRepoFile(path, 500_000);
  if (file.content === null) {
    return { path, exists: false, startLine, maxLines, content: '' };
  }
  const lines = file.content.split('\n');
  const selected = lines.slice(startLine - 1, startLine - 1 + maxLines);
  return {
    path,
    exists: true,
    startLine,
    maxLines,
    totalLines: file.content.endsWith('\n') ? lines.length - 1 : lines.length,
    content: truncateText(selected.join('\n'), limits.toolOutputMaxChars),
  };
}

function executeToolAction(action, context, limits) {
  switch (action.action) {
    case 'search':
      return { observation: buildToolObservation('search', runSearch(action, limits), limits) };
    case 'read_file':
      return { observation: buildToolObservation('read_file', runReadFile(action, limits), limits) };
    case 'apply_patch':
      return {
        observation: buildToolObservation(
          'apply_patch',
          applyGitPatch(action.patch || action.diff || '', context, limits),
          limits
        ),
      };
    case 'run_command':
      return { observation: buildToolObservation('run_command', runAgentCommand(action, context, limits), limits) };
    case 'git_diff':
      return {
        observation: buildToolObservation(
          'git_diff',
          {
            diff: truncateText(gitOutput(['diff', '--', '.'], { timeoutMs: limits.commandTimeoutMs }), limits.toolOutputMaxChars),
          },
          limits
        ),
      };
    case 'git_status':
      return {
        observation: buildToolObservation(
          'git_status',
          {
            status: truncateText(
              gitOutput(['status', '--short'], { timeoutMs: limits.commandTimeoutMs }),
              limits.toolOutputMaxChars
            ),
          },
          limits
        ),
      };
    default:
      throw new Error(`Unknown Platform Coding Agent action: ${action.action}`);
  }
}

function writeReport(context, report) {
  mkdirSync('.pages-artifacts', { recursive: true });
  const finalReport = {
    platformDevItemId: context.platformDevItemId,
    issueNumber: context.issueNumber || null,
    issueType: context.issueType,
    areas: context.areas,
    risk: context.effectiveRisk,
    declaredRisk: context.risk,
    gateApproved: context.gateApproved,
    baseRef: context.baseRef,
    modelName: context.modelName || null,
    contextReceived: {
      review: Boolean(String(context.reviewContext || '').trim()),
      memory: Boolean(String(context.memoryContext || '').trim()),
      status: Boolean(String(context.statusContext || '').trim()),
    },
    ...report,
  };
  writeFileSync('.pages-artifacts/platform-agent-report.json', `${JSON.stringify(finalReport, null, 2)}\n`);
  return finalReport;
}

function validateGeneratedFileSet(files) {
  for (const file of files) {
    if (!file.path.endsWith('.md') || file.path.startsWith('docs/superpowers/')) continue;
    const count = file.content.endsWith('\n') ? file.content.split('\n').length - 1 : file.content.split('\n').length;
    if (count > 700) throw new Error(`Markdown document exceeds 700 lines: ${file.path} has ${count} lines`);
  }
  const { docs, nonDocs } = classifyChangedFiles(files.map((file) => file.path));
  if (nonDocs.length && !docs.length) {
    throw new Error('Platform Coding Agent changed repository behavior/code without a matching documentation update');
  }
}

function writeLegacyGeneratedResult({ context, modelResult, files, toolMode = false, steps = [] }) {
  validateGeneratedFileSet(files);
  writeGeneratedFiles(files);
  const report = writeReport(context, {
    generatedFiles: files.map((file) => file.path),
    toolMode,
    steps,
    summary: summaryFromResult(modelResult),
    tests: testsFromResult(modelResult),
  });
  return { context, modelResult, report };
}

export async function runPlatformCodingAgent(options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const context = contextFromEnv(env);
  validateContext(context);
  const limits = buildToolLimits(env);
  const messages = buildCodingMessages(context);
  const steps = [];
  let lastBody = null;
  let lastModelResult = null;

  for (let step = 1; step <= limits.maxSteps; step += 1) {
    const { body, modelResult } = await requestModel({ context, messages, env, fetchImpl });
    lastBody = body;
    lastModelResult = modelResult;
    messages.push({ role: 'assistant', content: JSON.stringify(modelResult || {}) });

    let files = generatedFilesFromResult(modelResult, context);
    if (files.length) {
      try {
        files = validateGeneratedFiles(files, context);
        return writeLegacyGeneratedResult({ context, modelResult, files, toolMode: steps.length > 0, steps });
      } catch (error) {
        writeDiagnostic({ body, modelResult, context, reason: 'invalid_files' });
        throw error;
      }
    }

    const action = parseAction(modelResult);
    if (!action) {
      try {
        validateGeneratedFiles([], context);
      } catch (error) {
        writeDiagnostic({
          body,
          modelResult,
          context,
          reason: error.code === 'missing_files' ? 'missing_files' : 'invalid_action',
        });
        throw error;
      }
    }

    if (action.action === 'finish') {
      const changedFiles = validateChangedFiles(context, { requireDocs: true });
      if (!changedFiles.length) {
        writeDiagnostic({ body, modelResult, context, reason: 'no_changes' });
        throw new Error('Platform Coding Agent finished without repository changes');
      }
      const tests = ensureStringArray(action.tests, 'finish tests')
        .map((item) => item.trim())
        .filter(Boolean);
      const report = writeReport(context, {
        generatedFiles: changedFiles,
        toolMode: true,
        steps,
        summary: String(action.summary || '').trim(),
        tests,
      });
      return { context, modelResult, report };
    }

    let observation;
    try {
      ({ observation } = executeToolAction(action, context, limits));
    } catch (error) {
      observation = buildToolObservation(
        action.action || 'invalid',
        { ok: false, error: truncateText(error.message || String(error), limits.toolOutputMaxChars) },
        limits
      );
    }
    steps.push({ step, action: action.action });
    messages.push(observation);
  }

  writeDiagnostic({ body: lastBody, modelResult: lastModelResult, context, reason: 'max_steps_exceeded' });
  throw new Error(`Platform Coding Agent exceeded max tool steps: ${limits.maxSteps}`);
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
