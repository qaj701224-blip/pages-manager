import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { runCodexPreflight, runPlatformAgentRunner } from '../../scripts/platform-agent-runner.mjs';

const execFileAsync = promisify(execFile);

const baseEnv = {
  PLATFORM_DEV_ITEM_ID: 'pdev_runner123',
  AGENT_MODE: 'fix',
  ISSUE_NUMBER: '77',
  PR_NUMBER: '88',
  HEAD_SHA: 'b'.repeat(40),
  REQUEST_TITLE: '平台 Agent runner',
  REQUEST_SUMMARY: 'Replace one-shot Platform Agent generation with a real runner loop.',
  ISSUE_TYPE: 'type:dev',
  AREAS: 'area:gateway,area:github',
  RISK: 'risk:medium',
  BASE_REF: 'master',
  AGENT_BACKEND: 'mock-codex',
  AGENT_GATEWAY_URL: 'https://agent.example/v1/chat/completions',
  AGENT_CODE_API_KEY: 'code-key',
  REVIEW_CONTEXT: 'Review context for PR #88:\n1. [blocking] runner must retry failed checks.',
  MEMORY_CONTEXT: 'Session summary: previous round introduced platform-agent-coding.mjs.',
  STATUS_CONTEXT: 'status: review_blocked',
  FOLLOWUP_CONTEXT: 'Slack follow-up: also include changed files in the report.',
};

async function withFixture(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), 'platform-agent-runner-'));
  try {
    await execFileAsync('git', ['init'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.name', 'Runner Test'], { cwd: dir });
    await execFileAsync('git', ['config', 'user.email', 'runner-test@example.test'], { cwd: dir });
    await mkdir(path.join(dir, 'apps/gateway/src/control-plane'), { recursive: true });
    await writeFile(path.join(dir, 'package.json'), '{"private":true,"type":"module"}\n');
    await writeFile(
      path.join(dir, 'apps/gateway/src/control-plane/runner-target.js'),
      "export const value = 'before';\n"
    );
    await execFileAsync('git', ['add', '.'], { cwd: dir });
    await execFileAsync('git', ['commit', '-m', 'initial'], { cwd: dir });
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function readReport(cwd) {
  return JSON.parse(await readFile(path.join(cwd, '.pages-artifacts/platform-agent-report.json'), 'utf8'));
}

function createBackend(run) {
  return {
    name: 'mock-codex',
    run,
  };
}

test('writes task.md with PR, review, followup, memory, status, and repository inspection instructions', async () => {
  await withFixture(async (cwd) => {
    const backendCalls = [];
    await runPlatformAgentRunner({
      cwd,
      env: baseEnv,
      maxRounds: 1,
      backend: createBackend(async ({ taskPath, round }) => {
        const task = await readFile(taskPath, 'utf8');
        backendCalls.push({ round, taskPath, task });
        assert.match(task, /PR\s*#?88|prNumber[":\s]+88/i);
        assert.match(task, /headSha[":\s]+bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb|bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb/i);
        assert.match(task, /runner must retry failed checks/);
        assert.match(task, /also include changed files in the report/);
        assert.match(task, /previous round introduced platform-agent-coding\.mjs/);
        assert.match(task, /status:\s*review_blocked/);
        assert.match(task, /inspect existing files before editing/i);
        assert.match(task, /apps\/gateway\/src\/control-plane\/runner-target\.js/);
        await writeFile(
          path.join(cwd, 'apps/gateway/src/control-plane/runner-target.js'),
          "export const value = 'after';\n"
        );
      }),
      runChecks: async () => ({ ok: true, name: 'mock-check', log: 'checks passed' }),
    });

    assert.equal(backendCalls.length, 1);
    assert.match(backendCalls[0].taskPath, /\.pages-artifacts\/platform-agent-task\.md$/);
  });
});

test('codex backend maps company gateway URL and key env into CLI provider config', async () => {
  await withFixture(async (cwd) => {
    await mkdir(path.join(cwd, '.pages-artifacts'), { recursive: true });
    const commandPath = path.join(cwd, '.pages-artifacts/mock-codex.mjs');
    await writeFile(
      commandPath,
      [
        '#!/usr/bin/env node',
        "import { writeFileSync } from 'node:fs';",
        "const out = process.env.MOCK_CODEX_ARGS_PATH;",
        "writeFileSync(out, JSON.stringify({ args: process.argv.slice(2), key: process.env.AGENT_CODE_API_KEY }, null, 2));",
      ].join('\n')
    );
    await chmod(commandPath, 0o755);

    await assert.rejects(
      () =>
        runPlatformAgentRunner({
          cwd,
          env: {
            ...baseEnv,
            AGENT_BACKEND: 'codex',
            PLATFORM_AGENT_CODEX_COMMAND: commandPath,
            MOCK_CODEX_ARGS_PATH: path.join(cwd, '.pages-artifacts/codex-args.json'),
          },
          maxRounds: 1,
          runChecks: async () => ({ ok: true, name: 'mock-check', log: 'checks passed' }),
        }),
      /backend produced no repository changes/
    );

    const invocation = JSON.parse(await readFile(path.join(cwd, '.pages-artifacts/codex-args.json'), 'utf8'));
    assert.ok(invocation.args.includes('--ignore-user-config'));
    const providerIndex = invocation.args.indexOf('model_provider="platform_agent_gateway"');
    assert.notEqual(providerIndex, -1);
    const providerArg = invocation.args[providerIndex + 2];
    assert.match(providerArg, /^model_providers\.platform_agent_gateway=\{name="Platform Agent Gateway"/);
    assert.match(providerArg, /base_url="https:\/\/agent\.example\/v1"/);
    assert.match(providerArg, /env_key="AGENT_CODE_API_KEY"/);
    assert.match(providerArg, /wire_api="responses"\}$/);
    assert.doesNotMatch(providerArg, /\{,|,\}/);
    assert.equal(invocation.key, 'code-key');
  });
});

test('codex preflight validates the same provider config before running the agent', async () => {
  await withFixture(async (cwd) => {
    await mkdir(path.join(cwd, '.pages-artifacts'), { recursive: true });
    const commandPath = path.join(cwd, '.pages-artifacts/mock-codex-preflight.mjs');
    await writeFile(
      commandPath,
      [
        '#!/usr/bin/env node',
        "import { writeFileSync } from 'node:fs';",
        "const payload = { args: process.argv.slice(2), key: process.env.AGENT_CODE_API_KEY };",
        "writeFileSync(process.env.MOCK_CODEX_PREFLIGHT_ARGS_PATH, JSON.stringify(payload, null, 2));",
        "process.stdout.write('{\"models\":[]}\\n');",
      ].join('\n')
    );
    await chmod(commandPath, 0o755);

    const result = await runCodexPreflight({
      cwd,
      env: {
        ...baseEnv,
        AGENT_BACKEND: 'codex',
        PLATFORM_AGENT_CODEX_COMMAND: commandPath,
        MOCK_CODEX_PREFLIGHT_ARGS_PATH: path.join(cwd, '.pages-artifacts/codex-preflight-args.json'),
      },
    });

    const invocation = JSON.parse(
      await readFile(path.join(cwd, '.pages-artifacts/codex-preflight-args.json'), 'utf8')
    );
    assert.equal(result.ok, true);
    assert.equal(result.skipped, false);
    assert.deepEqual(invocation.args.slice(0, 3), ['debug', 'models', '--bundled']);
    const providerIndex = invocation.args.indexOf('model_provider="platform_agent_gateway"');
    assert.notEqual(providerIndex, -1);
    assert.match(invocation.args[providerIndex + 2], /wire_api="responses"\}$/);
    assert.equal(invocation.key, 'code-key');
  });
});

test('codex provider id is validated before building CLI config paths', async () => {
  await withFixture(async (cwd) => {
    await assert.rejects(
      () =>
        runCodexPreflight({
          cwd,
          env: {
            ...baseEnv,
            AGENT_BACKEND: 'codex',
            PLATFORM_AGENT_CODEX_PROVIDER_ID: 'bad.provider',
          },
        }),
      /PLATFORM_AGENT_CODEX_PROVIDER_ID/
    );
  });
});

test('runs a second fix round when the first check fails and includes failure log context', async () => {
  await withFixture(async (cwd) => {
    const tasks = [];
    const checkRounds = [];

    await runPlatformAgentRunner({
      cwd,
      env: baseEnv,
      maxRounds: 2,
      backend: createBackend(async ({ taskPath, round }) => {
        const task = await readFile(taskPath, 'utf8');
        tasks.push(task);
        if (round === 1) {
          await writeFile(
            path.join(cwd, 'apps/gateway/src/control-plane/runner-target.js'),
            "export const value = 'broken';\n"
          );
          return;
        }
        assert.match(task, /pnpm test failed/i);
        assert.match(task, /Expected value to equal 'fixed'/);
        await writeFile(
          path.join(cwd, 'apps/gateway/src/control-plane/runner-target.js'),
          "export const value = 'fixed';\n"
        );
      }),
      runChecks: async ({ round }) => {
        checkRounds.push(round);
        if (round === 1) {
          return {
            ok: false,
            name: 'pnpm test',
            log: "pnpm test failed\nExpected value to equal 'fixed'",
          };
        }
        return { ok: true, name: 'pnpm test', log: 'tests passed' };
      },
    });

    const report = await readReport(cwd);
    assert.equal(tasks.length, 2);
    assert.deepEqual(checkRounds, [1, 2]);
    assert.equal(report.rounds.length, 2);
    assert.equal(report.checks[0].ok, false);
    assert.equal(report.checks[1].ok, true);
  });
});

test('fails with an actionable diagnostic when backend run leaves no git diff', async () => {
  await withFixture(async (cwd) => {
    await assert.rejects(
      () =>
        runPlatformAgentRunner({
          cwd,
          env: baseEnv,
          maxRounds: 1,
          backend: createBackend(async () => {
            // Intentionally leave the repository unchanged.
          }),
          runChecks: async () => ({ ok: true, name: 'mock-check', log: 'checks passed' }),
        }),
      /no repository changes|no git diff|backend produced no changes/i
    );

    const diagnostic = JSON.parse(
      await readFile(path.join(cwd, '.pages-artifacts/platform-agent-debug.json'), 'utf8')
    );
    const report = await readReport(cwd);
    assert.equal(diagnostic.reason, 'no_git_diff');
    assert.equal(diagnostic.platformDevItemId, 'pdev_runner123');
    assert.match(diagnostic.message, /backend produced no repository changes|inspect existing files|modify tracked files/i);
    assert.equal(report.failed, true);
    assert.equal(report.failureReason, 'no_git_diff');
    assert.deepEqual(report.changedFiles, []);
  });
});

test('writes debug and report artifacts when backend execution fails', async () => {
  await withFixture(async (cwd) => {
    await assert.rejects(
      () =>
        runPlatformAgentRunner({
          cwd,
          env: baseEnv,
          maxRounds: 1,
          backend: createBackend(async () => {
            throw new Error('codex backend exited with status 1');
          }),
          runChecks: async () => ({ ok: true, name: 'mock-check', log: 'checks passed' }),
        }),
      /codex backend exited/
    );

    const diagnostic = JSON.parse(
      await readFile(path.join(cwd, '.pages-artifacts/platform-agent-debug.json'), 'utf8')
    );
    const report = await readReport(cwd);
    assert.equal(diagnostic.reason, 'backend_failed');
    assert.equal(diagnostic.backend, 'mock-codex');
    assert.equal(report.failed, true);
    assert.equal(report.failureReason, 'backend_failed');
    assert.equal(report.rounds[0].failureReason, 'backend_failed');
  });
});

test('report JSON records backend, rounds, checks, and changed files', async () => {
  await withFixture(async (cwd) => {
    await runPlatformAgentRunner({
      cwd,
      env: baseEnv,
      maxRounds: 1,
      backend: createBackend(async () => {
        await writeFile(
          path.join(cwd, 'apps/gateway/src/control-plane/runner-target.js'),
          "export const value = 'reported';\n"
        );
      }),
      runChecks: async ({ round }) => ({ ok: true, name: 'pnpm test', round, log: 'tests passed' }),
    });

    const report = await readReport(cwd);
    assert.equal(report.platformDevItemId, 'pdev_runner123');
    assert.equal(report.backend, 'mock-codex');
    assert.equal(report.rounds.length, 1);
    assert.equal(report.rounds[0].round, 1);
    assert.equal(report.checks.length, 1);
    assert.equal(report.checks[0].name, 'pnpm test');
    assert.equal(report.checks[0].ok, true);
    assert.deepEqual(report.changedFiles, ['apps/gateway/src/control-plane/runner-target.js']);
  });
});
