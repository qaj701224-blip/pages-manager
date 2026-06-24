import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { runPlatformCodingAgent } from './platform-agent-coding.mjs';

const NON_CODING_ISSUE_TYPES = new Set(['type:feedback', 'type:question']);
const LEGACY_BACKENDS = new Set(['company-json', 'legacy-json', 'platform-agent-coding']);
const DEFAULT_CHECK_COMMANDS = ['pnpm lint', 'pnpm test'];
const DEFAULT_MAX_ROUNDS = 3;
const DEFAULT_BACKEND_TIMEOUT_MS = 45 * 60 * 1000;
const DEFAULT_CHECK_TIMEOUT_MS = 20 * 60 * 1000;
const LOG_LIMIT = 24_000;
const TASK_CONTEXT_LIMIT = 30_000;
const FILE_LIST_LIMIT = 1_200;

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function trimText(value = '', limit = TASK_CONTEXT_LIMIT) {
  const text = String(value || '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} chars]`;
}

function truncateLog(value = '', limit = LOG_LIMIT) {
  const text = String(value || '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} chars]`;
}

function numberFromEnv(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function boolFromEnv(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
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
    gateApproved: boolFromEnv(env.GATE_APPROVED, false),
    baseRef: env.BASE_REF || 'master',
    branchName: env.AGENT_BRANCH_NAME || env.BRANCH_NAME || '',
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

async function ensureArtifacts(cwd) {
  const artifactsDir = path.join(cwd, '.pages-artifacts');
  await mkdir(artifactsDir, { recursive: true });
  return artifactsDir;
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function runProcess(command, args, options = {}) {
  const { cwd, env, input, timeoutMs = DEFAULT_BACKEND_TIMEOUT_MS, shell = false } = options;
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      shell,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 5_000).unref();
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout = truncateLog(stdout + chunk.toString(), LOG_LIMIT * 2);
    });
    child.stderr.on('data', (chunk) => {
      stderr = truncateLog(stderr + chunk.toString(), LOG_LIMIT * 2);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ ok: false, code: null, signal: null, stdout, stderr: `${stderr}\n${error.message}`.trim(), timedOut });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, signal, stdout, stderr, timedOut });
    });
    if (input) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function gitOutput(cwd, args) {
  const result = await runProcess('git', args, { cwd, timeoutMs: 60_000 });
  if (!result.ok) {
    const log = truncateLog(`${result.stdout}\n${result.stderr}`.trim());
    throw new Error(`git ${args.join(' ')} failed${log ? `:\n${log}` : ''}`);
  }
  return result.stdout;
}

function parsePorcelainStatus(stdout) {
  return stdout
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const file = line.slice(3);
      const renameIndex = file.lastIndexOf(' -> ');
      return renameIndex >= 0 ? file.slice(renameIndex + 4) : file;
    })
    .filter((file) => file && !file.startsWith('.pages-artifacts/') && !file.startsWith('.pages-trusted/'))
    .sort();
}

async function changedFiles(cwd) {
  const stdout = await gitOutput(cwd, ['status', '--porcelain', '--untracked-files=all']);
  return parsePorcelainStatus(stdout);
}

async function repositoryFiles(cwd) {
  const stdout = await gitOutput(cwd, ['ls-files']);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, FILE_LIST_LIMIT);
}

async function currentDiff(cwd) {
  const diff = await gitOutput(cwd, ['diff', '--', '.']);
  return truncateLog(diff, LOG_LIMIT);
}

function contextReceived(context) {
  return {
    review: Boolean(context.reviewContext.trim()),
    memory: Boolean(context.memoryContext.trim()),
    status: Boolean(context.statusContext.trim()),
    followup: Boolean(context.followupContext.trim()),
  };
}

function buildTaskMarkdown(context, details) {
  const { round, maxRounds, repoFiles, diff, previousFailure } = details;
  const contextJson = {
    platformDevItemId: context.platformDevItemId,
    mode: context.agentMode,
    issueNumber: context.issueNumber || null,
    prNumber: context.prNumber || null,
    headSha: context.headSha || null,
    issueType: context.issueType,
    areas: context.areas,
    risk: context.effectiveRisk,
    declaredRisk: context.risk,
    gateApproved: context.gateApproved,
    baseRef: context.baseRef,
    branchName: context.branchName || null,
  };

  return [
    '# Platform Agent Task',
    '',
    `Round ${round} of ${maxRounds}. Work in this repository checkout and leave the final file edits in the working tree.`,
    '',
    '## Critical Instructions',
    '',
    '- Inspect existing files before editing. Never rewrite an existing file from memory or from a partial prompt.',
    '- Use normal repo tools: read files, edit narrowly, run focused commands, and preserve existing behavior unless the task asks otherwise.',
    '- Do not modify `master` / `main`, do not merge PRs, and do not change production deploy triggers.',
    '- Do not write secrets, tokens, cookies, local env values, real Cloudflare/Aliyun/Kubernetes credentials, or private account data.',
    '- Do not write files under `.git/`, `.pages-artifacts/`, `.pages-trusted/`, `node_modules/`, `dist/`, `build/`, local env files, or `wrangler.toml`.',
    '- Keep documentation and code synchronized. Normal Markdown docs must stay under 700 lines.',
    '- When this is a fix round, address the review/comment context directly and keep the PR branch moving forward.',
    '',
    '## Structured Context',
    '',
    '```json',
    JSON.stringify(contextJson, null, 2),
    '```',
    '',
    '## Request',
    '',
    `Title: ${context.requestTitle}`,
    '',
    trimText(context.requestSummary) || '(empty)',
    '',
    '## Review Context',
    '',
    trimText(context.reviewContext) || '(none)',
    '',
    '## Follow-up Context',
    '',
    trimText(context.followupContext) || '(none)',
    '',
    '## Memory Context',
    '',
    trimText(context.memoryContext) || '(none)',
    '',
    '## Status Context',
    '',
    trimText(context.statusContext) || '(none)',
    '',
    previousFailure
      ? ['## Previous Validation Failure', '', trimText(previousFailure.log, LOG_LIMIT), ''].join('\n')
      : '## Previous Validation Failure\n\n(none)\n',
    '## Repository Files To Inspect',
    '',
    repoFiles.length ? repoFiles.map((file) => `- \`${file}\``).join('\n') : '(none listed by git)',
    '',
    '## Current Git Diff Before This Round',
    '',
    diff ? ['```diff', diff, '```'].join('\n') : '(clean working tree)',
    '',
    '## Completion Criteria',
    '',
    '- Relevant files are changed directly in the repo worktree.',
    '- Validation commands pass or the remaining failure is explained in the final response.',
    '- `git diff --name-only` shows the intended code/docs/test changes.',
    '',
  ].join('\n');
}

async function writeTaskFiles(cwd, context, details) {
  const artifactsDir = await ensureArtifacts(cwd);
  const repoFiles = await repositoryFiles(cwd);
  const diff = await currentDiff(cwd);
  const task = buildTaskMarkdown(context, { ...details, repoFiles, diff });
  const taskPath = path.join(artifactsDir, 'platform-agent-task.md');
  const roundTaskPath = path.join(artifactsDir, `platform-agent-task-round-${details.round}.md`);
  await writeFile(taskPath, task);
  await writeFile(roundTaskPath, task);
  await writeJson(path.join(artifactsDir, 'platform-agent-context.json'), {
    ...context,
    contextReceived: contextReceived(context),
  });
  return taskPath;
}

function backendNameFromEnv(env) {
  return String(env.PLATFORM_AGENT_BACKEND || env.AGENT_BACKEND || 'codex')
    .trim()
    .toLowerCase();
}

function codexModelFromEnv(env) {
  return env.PLATFORM_AGENT_CODEX_MODEL || env.CODEX_MODEL || env.AGENT_MODEL_NAME || '';
}

function tomlString(value) {
  return JSON.stringify(String(value || ''));
}

function normalizeAgentGatewayBaseUrl(value) {
  const normalized = String(value || '').replace(/\/+$/, '');
  if (!normalized) return '';
  if (normalized.endsWith('/chat/completions')) return normalized.slice(0, -'/chat/completions'.length);
  if (normalized.endsWith('/responses')) return normalized.slice(0, -'/responses'.length);
  if (normalized.endsWith('/v1')) return normalized;
  return `${normalized}/v1`;
}

function codexBaseUrlFromEnv(env) {
  return (
    env.PLATFORM_AGENT_CODEX_BASE_URL ||
    env.CODEX_BASE_URL ||
    normalizeAgentGatewayBaseUrl(env.AGENT_GATEWAY_URL || '')
  );
}

function requireCodexGatewayEnv(env) {
  if (!codexBaseUrlFromEnv(env)) {
    throw new Error('AGENT_GATEWAY_URL or PLATFORM_AGENT_CODEX_BASE_URL is required for Codex Platform Agent backend');
  }
  if (!env.AGENT_CODE_API_KEY) {
    throw new Error('AGENT_CODE_API_KEY is required for Codex Platform Agent backend');
  }
}

function createCodexBackend(env) {
  requireCodexGatewayEnv(env);
  return {
    name: 'codex',
    async run({ cwd, taskPath, round }) {
      const task = await readFile(taskPath, 'utf8');
      const command = env.PLATFORM_AGENT_CODEX_COMMAND || env.CODEX_COMMAND || 'codex';
      const timeoutMs = numberFromEnv(env.PLATFORM_AGENT_BACKEND_TIMEOUT_MS, DEFAULT_BACKEND_TIMEOUT_MS);
      const lastMessagePath = path.join(cwd, '.pages-artifacts', `platform-agent-codex-round-${round}.md`);
      const providerId = env.PLATFORM_AGENT_CODEX_PROVIDER_ID || 'platform_agent_gateway';
      const providerConfig = [
        '{',
        `name=${tomlString('Platform Agent Gateway')}`,
        `base_url=${tomlString(codexBaseUrlFromEnv(env))}`,
        'env_key="AGENT_CODE_API_KEY"',
        'wire_api="responses"',
        '}',
      ].join(',');
      const args = [
        'exec',
        '--cd',
        cwd,
        '--dangerously-bypass-approvals-and-sandbox',
        '--dangerously-bypass-hook-trust',
        '--ephemeral',
        '--color',
        'never',
        '-o',
        lastMessagePath,
        '-c',
        `model_provider=${tomlString(providerId)}`,
        '-c',
        `model_providers.${providerId}=${providerConfig}`,
      ];
      const model = codexModelFromEnv(env);
      if (model) args.push('--model', model);
      args.push('-');

      const result = await runProcess(command, args, {
        cwd,
        env: { ...process.env, ...env },
        input: task,
        timeoutMs,
      });
      if (!result.ok) {
        const error = new Error(
          `Codex backend failed in round ${round}${result.timedOut ? ' (timeout)' : ''}:\n${truncateLog(
            `${result.stdout}\n${result.stderr}`.trim()
          )}`
        );
        error.code = 'backend_failed';
        error.result = result;
        throw error;
      }
      return {
        stdout: truncateLog(result.stdout),
        stderr: truncateLog(result.stderr),
        lastMessagePath,
      };
    },
  };
}

function createLegacyBackend() {
  return {
    name: 'legacy-json',
    async run({ env }) {
      await runPlatformCodingAgent({ env });
      return { legacy: true };
    },
  };
}

function resolveBackend(options, env) {
  if (options.backend) return options.backend;
  const name = backendNameFromEnv(env);
  if (LEGACY_BACKENDS.has(name)) return createLegacyBackend();
  if (name === 'codex' || name === 'codex-cli') return createCodexBackend(env);
  throw new Error(`Unsupported Platform Agent backend: ${name}`);
}

function parseCheckCommands(env) {
  const raw = env.PLATFORM_AGENT_CHECK_COMMANDS || env.AGENT_CHECK_COMMANDS || '';
  const commands = raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
  return commands.length ? commands : DEFAULT_CHECK_COMMANDS;
}

async function runShellCheck(command, { cwd, env, round }) {
  const timeoutMs = numberFromEnv(env.PLATFORM_AGENT_CHECK_TIMEOUT_MS, DEFAULT_CHECK_TIMEOUT_MS);
  const result = await runProcess(command, [], {
    cwd,
    env: { ...process.env, ...env },
    shell: true,
    timeoutMs,
  });
  return {
    round,
    name: command,
    ok: result.ok,
    code: result.code,
    timedOut: result.timedOut,
    log: truncateLog(`${result.stdout}\n${result.stderr}`.trim()),
  };
}

async function runDefaultChecks({ cwd, env, round }) {
  const results = [];
  for (const command of parseCheckCommands(env)) {
    const result = await runShellCheck(command, { cwd, env, round });
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}

function normalizeCheckResults(result, round) {
  const items = Array.isArray(result) ? result : [result];
  return items.map((item, index) => ({
    round,
    name: item?.name || `check-${index + 1}`,
    ok: Boolean(item?.ok),
    code: item?.code ?? null,
    timedOut: Boolean(item?.timedOut),
    log: truncateLog(item?.log || item?.stdout || item?.stderr || ''),
  }));
}

function failedCheckLog(checks) {
  return checks
    .filter((check) => !check.ok)
    .map((check) => [`${check.name} failed`, check.log].filter(Boolean).join('\n'))
    .join('\n\n');
}

async function writeDebug(cwd, value) {
  const artifactsDir = await ensureArtifacts(cwd);
  await writeJson(path.join(artifactsDir, 'platform-agent-debug.json'), value);
}

async function writeReport(cwd, report) {
  const artifactsDir = await ensureArtifacts(cwd);
  await writeJson(path.join(artifactsDir, 'platform-agent-report.json'), report);
}

function relativeTaskPath(cwd, taskPath) {
  return path.relative(cwd, taskPath).split(path.sep).join('/');
}

function baseReport(context, backendName, extra = {}) {
  return {
    platformDevItemId: context.platformDevItemId,
    issueNumber: context.issueNumber || null,
    prNumber: context.prNumber || null,
    headSha: context.headSha || null,
    mode: context.agentMode,
    issueType: context.issueType,
    areas: context.areas,
    risk: context.effectiveRisk,
    declaredRisk: context.risk,
    gateApproved: context.gateApproved,
    baseRef: context.baseRef,
    backend: backendName,
    backendKind: LEGACY_BACKENDS.has(backendName) ? 'legacy-json' : 'repo-editing',
    contextReceived: contextReceived(context),
    ...extra,
  };
}

export async function runPlatformAgentRunner(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  if (!existsSync(path.join(cwd, '.git'))) {
    throw new Error(`Platform Agent runner must run inside a git checkout: ${cwd}`);
  }

  const env = options.env || process.env;
  const context = contextFromEnv(env);
  validateContext(context);
  await ensureArtifacts(cwd);

  const maxRounds = options.maxRounds || numberFromEnv(env.PLATFORM_AGENT_MAX_ROUNDS, DEFAULT_MAX_ROUNDS);
  const backend = resolveBackend(options, env);
  const runChecks = options.runChecks || runDefaultChecks;
  const allChecks = [];
  const rounds = [];
  let previousFailure = null;
  let finalChangedFiles = [];

  for (let round = 1; round <= maxRounds; round += 1) {
    const taskPath = await writeTaskFiles(cwd, context, {
      round,
      maxRounds,
      previousFailure,
    });
    let backendResult;
    try {
      backendResult = await backend.run({
        cwd,
        env,
        context,
        taskPath,
        round,
        previousFailure,
      });
    } catch (error) {
      finalChangedFiles = await changedFiles(cwd);
      const message = error instanceof Error ? error.message : String(error);
      const failedRound = {
        round,
        taskPath: relativeTaskPath(cwd, taskPath),
        changedFiles: finalChangedFiles,
        failureReason: 'backend_failed',
      };
      await writeDebug(cwd, {
        reason: 'backend_failed',
        platformDevItemId: context.platformDevItemId,
        backend: backend.name,
        round,
        message: truncateLog(message),
        changedFiles: finalChangedFiles,
      });
      await writeReport(
        cwd,
        baseReport(context, backend.name, {
          rounds: [...rounds, failedRound],
          checks: allChecks,
          changedFiles: finalChangedFiles,
          failed: true,
          failureReason: 'backend_failed',
        })
      );
      throw error;
    }

    finalChangedFiles = await changedFiles(cwd);
    const roundInfo = {
      round,
      taskPath: relativeTaskPath(cwd, taskPath),
      changedFiles: finalChangedFiles,
      backendResult: backendResult ? { keys: Object.keys(backendResult) } : null,
    };
    rounds.push(roundInfo);

    if (!finalChangedFiles.length) {
      const message =
        'Platform Agent backend produced no repository changes. Inspect existing files before editing and modify tracked files directly in the repo worktree.';
      await writeDebug(cwd, {
        reason: 'no_git_diff',
        platformDevItemId: context.platformDevItemId,
        backend: backend.name,
        round,
        message,
      });
      await writeReport(
        cwd,
        baseReport(context, backend.name, {
          rounds,
          checks: allChecks,
          changedFiles: finalChangedFiles,
          failed: true,
          failureReason: 'no_git_diff',
        })
      );
      throw new Error(message);
    }

    const checks = normalizeCheckResults(await runChecks({ cwd, env, context, round, changedFiles: finalChangedFiles }), round);
    allChecks.push(...checks);
    roundInfo.checks = checks.map((check) => ({
      name: check.name,
      ok: check.ok,
      timedOut: check.timedOut,
    }));

    if (checks.every((check) => check.ok)) {
      const report = baseReport(context, backend.name, {
        rounds,
        checks: allChecks,
        changedFiles: finalChangedFiles,
      });
      await writeReport(cwd, report);
      return { context, report };
    }

    previousFailure = {
      round,
      checks,
      log: failedCheckLog(checks),
    };
  }

  const report = baseReport(context, backend.name, {
    rounds,
    checks: allChecks,
    changedFiles: finalChangedFiles,
    failed: true,
  });
  await writeReport(cwd, report);
  await writeDebug(cwd, {
    reason: 'checks_failed',
    platformDevItemId: context.platformDevItemId,
    backend: backend.name,
    message: `Platform Agent checks failed after ${maxRounds} round(s).`,
    failedChecks: allChecks.filter((check) => !check.ok),
  });
  throw new Error(`Platform Agent checks failed after ${maxRounds} round(s).`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPlatformAgentRunner().then((result) => {
    console.log(
      JSON.stringify({
        ok: true,
        generatedBy: 'platform-agent-runner',
        backend: result.report.backend,
        changedFiles: result.report.changedFiles,
      })
    );
  });
}
