import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const LOG_LIMIT = 24_000;
const COMMIT_SUBJECT_RE = /^(feat|fix|refactor|perf|chore|docs|test|revert|build|ci)(\([a-z0-9-]+\))?: .+\S$/;
const CJK_RE = /[\u3400-\u9fff]/;
const NON_FAST_FORWARD_RE = /(non-fast-forward|fetch first|stale info|failed to push some refs)/i;

function required(value, name) {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function numberFromEnv(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function truncateLog(value = '', limit = LOG_LIMIT) {
  const text = String(value || '');
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[truncated ${text.length - limit} chars]`;
}

function redact(value = '', env = {}) {
  let text = String(value || '');
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'AGENT_CODE_API_KEY', 'PAGES_CALLBACK_TOKEN']) {
    const secret = env[key];
    if (secret) text = text.split(secret).join(`[REDACTED_${key}]`);
  }
  return text;
}

async function runProcess(command, args, options = {}) {
  const { cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  return await new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
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
      resolve({ ok: false, code: null, stdout, stderr: `${stderr}\n${error.message}`.trim(), timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut });
    });
  });
}

async function git(cwd, args, options = {}) {
  const result = await runProcess('git', args, { cwd, env: options.env || process.env, timeoutMs: options.timeoutMs || 60_000 });
  if (!result.ok) {
    const log = truncateLog(`${result.stdout}\n${result.stderr}`.trim());
    throw new Error(`git ${args.join(' ')} failed${log ? `:\n${log}` : ''}`);
  }
  return result.stdout.trim();
}

async function tryGit(cwd, args, options = {}) {
  return await runProcess('git', args, { cwd, env: options.env || process.env, timeoutMs: options.timeoutMs || 60_000 });
}

async function stageRepositoryChanges(cwd) {
  await git(cwd, ['add', '-A', '--', '.', ':(exclude).pages-artifacts', ':(exclude).pages-trusted']);
}

async function hasStagedChanges(cwd) {
  const result = await tryGit(cwd, ['diff', '--cached', '--quiet']);
  return result.code !== 0;
}

async function hasWorktreeChanges(cwd) {
  const result = await tryGit(cwd, ['diff', '--quiet']);
  if (result.code !== 0) return true;
  const staged = await tryGit(cwd, ['diff', '--cached', '--quiet']);
  return staged.code !== 0;
}

async function commitSubject(cwd) {
  return await git(cwd, ['log', '-1', '--pretty=%s']);
}

async function headSha(cwd) {
  return await git(cwd, ['rev-parse', 'HEAD']);
}

function defaultCommitMessage(env) {
  return env.PLATFORM_AGENT_COMMIT_MESSAGE || `feat: 处理平台需求 ${required(env.PLATFORM_DEV_ITEM_ID, 'PLATFORM_DEV_ITEM_ID')}`;
}

function defaultRemoteUrl(env) {
  if (env.PLATFORM_AGENT_PUSH_REMOTE_URL) return env.PLATFORM_AGENT_PUSH_REMOTE_URL;
  const token = required(env.GH_TOKEN, 'GH_TOKEN');
  return `https://x-access-token:${token}@github.com/${required(env.GITHUB_REPOSITORY, 'GITHUB_REPOSITORY')}.git`;
}

async function currentBranch(cwd) {
  return await git(cwd, ['branch', '--show-current']);
}

async function gitStatus(cwd) {
  return await git(cwd, ['status', '--short', '--branch', '--untracked-files=all']);
}

async function recentCommits(cwd) {
  return await git(cwd, ['log', '--oneline', '--decorate', '--max-count=8']);
}

async function writeFinalizationContext({ cwd, env, artifactsDir, branch, baseRef, failureKind, failureLog }) {
  await mkdir(artifactsDir, { recursive: true });
  const contextPath = path.join(artifactsDir, 'platform-agent-finalization-failure.md');
  const subject = await commitSubject(cwd).catch(() => '(unavailable)');
  const status = await gitStatus(cwd).catch((error) => error.message);
  const commits = await recentCommits(cwd).catch((error) => error.message);
  const current = await currentBranch(cwd).catch(() => '(detached or unavailable)');
  const context = [
    '# Platform Agent Finalization Failure',
    '',
    `Failure kind: ${failureKind}`,
    `Target branch: ${branch}`,
    `Base ref: ${baseRef}`,
    `Current branch: ${current}`,
    `HEAD: ${await headSha(cwd).catch(() => '(unavailable)')}`,
    `Commit subject: ${subject}`,
    '',
    '## Failure Log',
    '',
    '```text',
    truncateLog(redact(failureLog, env)),
    '```',
    '',
    '## Git Status',
    '',
    '```text',
    status,
    '```',
    '',
    '## Recent Commits',
    '',
    '```text',
    commits,
    '```',
    '',
    '## Expected Repair',
    '',
    '- Fix local git state only; do not push or force-push.',
    '- If the branch is behind, fetch/rebase onto the latest local origin refs and resolve conflicts.',
    '- If the commit message is invalid, amend it to match `<type>(<scope>): <精准中文描述>` or `<type>: <精准中文描述>`.',
    '- Leave the branch ready for the workflow finalizer to retry push/PR creation.',
    '',
  ].join('\n');
  await writeFile(contextPath, context);
  return contextPath;
}

async function runRepairRound({ cwd, env, contextPath }) {
  const runnerPath = required(
    env.PLATFORM_AGENT_RUNNER_PATH || path.join(env.RUNNER_TEMP || '', 'platform-agent-runner.mjs'),
    'PLATFORM_AGENT_RUNNER_PATH'
  );
  if (!existsSync(runnerPath)) throw new Error(`Platform Agent runner not found: ${runnerPath}`);
  const repairEnv = {
    ...env,
    GH_TOKEN: '',
    GITHUB_TOKEN: '',
    PAGES_CALLBACK_TOKEN: '',
    PLATFORM_AGENT_REPAIR_MODE: 'finalization',
    PLATFORM_AGENT_FINALIZATION_CONTEXT_FILE: contextPath,
    PLATFORM_AGENT_MAX_ROUNDS:
      env.PLATFORM_AGENT_FINALIZATION_REPAIR_MAX_ROUNDS || env.PLATFORM_AGENT_MAX_ROUNDS || '3',
  };
  const result = await runProcess(process.execPath, [runnerPath], {
    cwd,
    env: repairEnv,
    timeoutMs: numberFromEnv(env.PLATFORM_AGENT_FINALIZATION_REPAIR_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  });
  if (!result.ok) {
    throw new Error(
      `Platform Agent finalization repair failed${result.timedOut ? ' (timeout)' : ''}:\n${truncateLog(
        redact(`${result.stdout}\n${result.stderr}`.trim(), env)
      )}`
    );
  }
}

async function amendStagedRepairChanges(cwd) {
  await stageRepositoryChanges(cwd);
  if (await hasStagedChanges(cwd)) {
    await git(cwd, ['commit', '--amend', '--no-edit']);
  }
}

async function repairFinalization({ cwd, env, artifactsDir, branch, baseRef, failureKind, failureLog }) {
  const contextPath = await writeFinalizationContext({
    cwd,
    env,
    artifactsDir,
    branch,
    baseRef,
    failureKind,
    failureLog,
  });
  await runRepairRound({ cwd, env, contextPath });
  await amendStagedRepairChanges(cwd);
}

async function validateCommitMessageOrRepair(params) {
  const subject = await commitSubject(params.cwd);
  if (COMMIT_SUBJECT_RE.test(subject) && CJK_RE.test(subject)) return true;
  await repairFinalization({
    ...params,
    failureKind: 'invalid_commit_message',
    failureLog: `Commit subject does not match pages-manager convention: ${subject}`,
  });
  return false;
}

async function ensureLatestBaseOrRepair(params) {
  const { cwd, env, baseRef } = params;
  await tryGit(cwd, ['fetch', 'origin', `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`], { env });
  const result = await tryGit(cwd, ['merge-base', '--is-ancestor', `origin/${baseRef}`, 'HEAD'], { env });
  if (result.ok) return true;
  await repairFinalization({
    ...params,
    failureKind: 'base_not_current',
    failureLog: `HEAD does not contain latest origin/${baseRef}. Rebase the Platform Agent branch before finalizing.`,
  });
  return false;
}

async function pushOrRepair(params) {
  const { cwd, env, branch, remoteUrl } = params;
  const result = await tryGit(cwd, ['push', remoteUrl, `HEAD:${branch}`], { env });
  if (result.ok) return true;
  const log = redact(`${result.stdout}\n${result.stderr}`.trim(), env);
  if (!NON_FAST_FORWARD_RE.test(log)) {
    throw new Error(`git push failed for a non-retryable reason:\n${truncateLog(log)}`);
  }
  await tryGit(cwd, ['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`], { env });
  await repairFinalization({
    ...params,
    failureKind: 'push_non_fast_forward',
    failureLog: log,
  });
  return false;
}

function appendGithubOutput(env, values) {
  const outputPath = env.GITHUB_OUTPUT;
  if (!outputPath) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  const previous = existsSync(outputPath) ? readFileSync(outputPath, 'utf8') : '';
  return writeFile(outputPath, `${previous}${lines.join('\n')}\n`);
}

export async function runPlatformAgentFinalizer(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const env = options.env || process.env;
  if (!existsSync(path.join(cwd, '.git'))) {
    throw new Error(`Platform Agent finalizer must run inside a git checkout: ${cwd}`);
  }

  const branch = required(env.AGENT_BRANCH_NAME || env.BRANCH_NAME, 'AGENT_BRANCH_NAME');
  const baseRef = env.BASE_REF || 'master';
  const artifactsDir = path.join(cwd, '.pages-artifacts');
  const remoteUrl = defaultRemoteUrl(env);
  const maxAttempts = numberFromEnv(env.PLATFORM_AGENT_FINALIZATION_MAX_ATTEMPTS, DEFAULT_MAX_ATTEMPTS);

  await git(cwd, ['config', 'user.name', env.PLATFORM_AGENT_GIT_USER_NAME || 'pages-platform-agent']);
  await git(cwd, ['config', 'user.email', env.PLATFORM_AGENT_GIT_USER_EMAIL || 'pages-platform-agent@users.noreply.github.com']);
  await stageRepositoryChanges(cwd);
  if (!(await hasStagedChanges(cwd))) {
    throw new Error('Platform Coding Agent produced no repository changes.');
  }
  await git(cwd, ['commit', '-m', defaultCommitMessage(env)]);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    await amendStagedRepairChanges(cwd);
    const params = { cwd, env, artifactsDir, branch, baseRef, remoteUrl };
    if (!(await validateCommitMessageOrRepair(params))) continue;
    if (!(await ensureLatestBaseOrRepair(params))) continue;
    if (await pushOrRepair(params)) {
      const sha = await headSha(cwd);
      await appendGithubOutput(env, {
        changed: 'true',
        head_sha: sha,
      });
      return { changed: true, headSha: sha, attempts: attempt };
    }
  }

  const dirty = await hasWorktreeChanges(cwd);
  throw new Error(
    `Platform Agent finalization did not complete after ${maxAttempts} attempt(s). Worktree has changes: ${dirty}`
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runPlatformAgentFinalizer()
    .then((result) => {
      console.log(JSON.stringify({ ok: true, generatedBy: 'platform-agent-finalize', ...result }));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    });
}
