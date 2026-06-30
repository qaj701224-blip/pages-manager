import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

import { runPlatformAgentFinalizer } from '../../scripts/platform-agent-finalize.mjs';

const execFileAsync = promisify(execFile);

async function git(cwd, args) {
  const result = await execFileAsync('git', args, { cwd });
  return result.stdout.trim();
}

async function createRepositoryFixture(fn) {
  const root = await mkdtemp(path.join(tmpdir(), 'platform-agent-finalize-'));
  const remote = path.join(root, 'remote.git');
  const seed = path.join(root, 'seed');
  const work = path.join(root, 'work');
  try {
    await mkdir(seed, { recursive: true });
    await git(seed, ['init', '-b', 'master']);
    await git(seed, ['config', 'user.name', 'Finalizer Test']);
    await git(seed, ['config', 'user.email', 'finalizer@example.test']);
    await writeFile(path.join(seed, 'package.json'), '{"private":true,"type":"module"}\n');
    await writeFile(path.join(seed, 'target.txt'), 'base\n');
    await git(seed, ['add', '.']);
    await git(seed, ['commit', '-m', 'chore: 初始化测试仓库']);
    await git(seed, ['init', '--bare', remote]);
    await git(seed, ['remote', 'add', 'origin', remote]);
    await git(seed, ['push', '-u', 'origin', 'master']);
    await git(seed, ['checkout', '-b', 'feat/platform-pdev_runner123-test']);
    await git(seed, ['push', '-u', 'origin', 'feat/platform-pdev_runner123-test']);
    await git(root, ['clone', remote, work]);
    await git(work, ['config', 'user.name', 'Finalizer Test']);
    await git(work, ['config', 'user.email', 'finalizer@example.test']);
    await git(work, ['checkout', 'feat/platform-pdev_runner123-test']);
    return await fn({ root, remote, seed, work });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createMockRepairRunner(cwd, body) {
  const artifacts = path.join(cwd, '.pages-artifacts');
  await mkdir(artifacts, { recursive: true });
  const runnerPath = path.join(artifacts, `mock-repair-${Math.random().toString(16).slice(2)}.mjs`);
  await writeFile(
    runnerPath,
    [
      '#!/usr/bin/env node',
      "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
      "import { execFileSync } from 'node:child_process';",
      "const context = readFileSync(process.env.PLATFORM_AGENT_FINALIZATION_CONTEXT_FILE, 'utf8');",
      "appendFileSync('.pages-artifacts/repair-contexts.log', `---\\n${context}\\n`);",
      body,
      "writeFileSync('.pages-artifacts/platform-agent-report.json', JSON.stringify({ ok: true, repairMode: true }) + '\\n');",
    ].join('\n')
  );
  await chmod(runnerPath, 0o755);
  return runnerPath;
}

function baseEnv({ remote, runnerPath, outputPath }) {
  return {
    PLATFORM_DEV_ITEM_ID: 'pdev_runner123',
    AGENT_BRANCH_NAME: 'feat/platform-pdev_runner123-test',
    BASE_REF: 'master',
    GITHUB_REPOSITORY: 'xindong/pages-manager',
    GH_TOKEN: 'ghs_test_token',
    PLATFORM_AGENT_PUSH_REMOTE_URL: remote,
    PLATFORM_AGENT_RUNNER_PATH: runnerPath,
    PLATFORM_AGENT_FINALIZATION_MAX_ATTEMPTS: '3',
    PLATFORM_AGENT_FINALIZATION_REPAIR_MAX_ROUNDS: '1',
    AGENT_BACKEND: 'mock-codex',
    AGENT_GATEWAY_URL: 'https://agent.example/v1',
    AGENT_CODE_API_KEY: 'code-key',
    REQUEST_TITLE: '平台 Agent 收尾',
    REQUEST_SUMMARY: '测试 Platform Agent finalizer 自修。',
    ISSUE_TYPE: 'type:dev',
    RISK: 'risk:medium',
    AUTO_DEV_TRIGGERED: 'true',
    GITHUB_OUTPUT: outputPath,
  };
}

test('finalizer lets Platform Agent repair invalid commit message before push', async () => {
  await createRepositoryFixture(async ({ remote, work }) => {
    await writeFile(path.join(work, 'target.txt'), 'invalid message repair\n');
    const runnerPath = await createMockRepairRunner(
      work,
      "execFileSync('git', ['commit', '--amend', '-m', 'fix(gateway): 修复 Platform Agent 收尾失败'], { stdio: 'inherit' });"
    );
    const outputPath = path.join(work, '.pages-artifacts/github-output.txt');

    const result = await runPlatformAgentFinalizer({
      cwd: work,
      env: {
        ...baseEnv({ remote, runnerPath, outputPath }),
        PLATFORM_AGENT_COMMIT_MESSAGE: 'bad message',
      },
    });

    assert.equal(result.changed, true);
    assert.match(await git(work, ['log', '-1', '--pretty=%s']), /^fix\(gateway\): 修复 Platform Agent 收尾失败$/);
    assert.match(await readFile(path.join(work, '.pages-artifacts/repair-contexts.log'), 'utf8'), /invalid_commit_message/);
    assert.match(await readFile(outputPath, 'utf8'), /changed=true/);
  });
});

test('finalizer asks Platform Agent to repair non-Chinese commit subjects', async () => {
  await createRepositoryFixture(async ({ remote, work }) => {
    await writeFile(path.join(work, 'target.txt'), 'english message repair\n');
    const runnerPath = await createMockRepairRunner(
      work,
      "execFileSync('git', ['commit', '--amend', '-m', 'fix(gateway): 修复英文提交标题'], { stdio: 'inherit' });"
    );
    const outputPath = path.join(work, '.pages-artifacts/github-output.txt');

    const result = await runPlatformAgentFinalizer({
      cwd: work,
      env: {
        ...baseEnv({ remote, runnerPath, outputPath }),
        PLATFORM_AGENT_COMMIT_MESSAGE: 'fix(gateway): repair finalizer',
      },
    });

    assert.equal(result.changed, true);
    assert.match(await git(work, ['log', '-1', '--pretty=%s']), /^fix\(gateway\): 修复英文提交标题$/);
    assert.match(await readFile(path.join(work, '.pages-artifacts/repair-contexts.log'), 'utf8'), /invalid_commit_message/);
  });
});

test('finalizer lets Platform Agent rebase stale branch on latest master before push', async () => {
  await createRepositoryFixture(async ({ remote, seed, work }) => {
    await writeFile(path.join(seed, 'master-only.txt'), 'new master\n');
    await git(seed, ['checkout', 'master']);
    await git(seed, ['add', 'master-only.txt']);
    await git(seed, ['commit', '-m', 'chore: 推进 master']);
    await git(seed, ['push', 'origin', 'master']);

    await writeFile(path.join(work, 'target.txt'), 'stale base repair\n');
    const runnerPath = await createMockRepairRunner(
      work,
      "execFileSync('git', ['rebase', 'origin/master'], { stdio: 'inherit' });"
    );
    const outputPath = path.join(work, '.pages-artifacts/github-output.txt');

    const result = await runPlatformAgentFinalizer({
      cwd: work,
      env: baseEnv({ remote, runnerPath, outputPath }),
    });

    assert.equal(result.changed, true);
    assert.equal(await git(work, ['merge-base', '--is-ancestor', 'origin/master', 'HEAD']).then(() => 'yes'), 'yes');
    assert.match(await readFile(path.join(work, '.pages-artifacts/repair-contexts.log'), 'utf8'), /base_not_current/);
  });
});

test('finalizer lets Platform Agent repair non-fast-forward push failures', async () => {
  await createRepositoryFixture(async ({ remote, seed, work }) => {
    await git(seed, ['checkout', 'feat/platform-pdev_runner123-test']);
    await writeFile(path.join(seed, 'remote-branch.txt'), 'remote branch advanced\n');
    await git(seed, ['add', 'remote-branch.txt']);
    await git(seed, ['commit', '-m', 'fix(gateway): 远端分支先推进']);
    await git(seed, ['push', 'origin', 'feat/platform-pdev_runner123-test']);

    await writeFile(path.join(work, 'target.txt'), 'push repair\n');
    const runnerPath = await createMockRepairRunner(
      work,
      "execFileSync('git', ['rebase', 'origin/feat/platform-pdev_runner123-test'], { stdio: 'inherit' });"
    );
    const outputPath = path.join(work, '.pages-artifacts/github-output.txt');

    const result = await runPlatformAgentFinalizer({
      cwd: work,
      env: baseEnv({ remote, runnerPath, outputPath }),
    });

    assert.equal(result.changed, true);
    assert.match(await readFile(path.join(work, '.pages-artifacts/repair-contexts.log'), 'utf8'), /push_non_fast_forward/);
    const remoteLog = await git(work, ['ls-remote', remote, 'refs/heads/feat/platform-pdev_runner123-test']);
    assert.match(remoteLog, new RegExp(result.headSha));
  });
});

test('finalizer rejects local env files before the initial commit', async () => {
  await createRepositoryFixture(async ({ remote, work }) => {
    await writeFile(path.join(work, '.env'), 'TOKEN=local-secret\n');
    const runnerPath = await createMockRepairRunner(work, '');
    const outputPath = path.join(work, '.pages-artifacts/github-output.txt');

    await assert.rejects(
      runPlatformAgentFinalizer({
        cwd: work,
        env: baseEnv({ remote, runnerPath, outputPath }),
      }),
      /Refusing to commit local env/
    );

    const remoteLog = await git(work, ['ls-remote', remote, 'refs/heads/feat/platform-pdev_runner123-test']);
    assert.doesNotMatch(remoteLog, /TOKEN/);
  });
});

test('finalizer rejects unsafe repair changes before amend and push', async () => {
  await createRepositoryFixture(async ({ remote, work }) => {
    await writeFile(path.join(work, 'target.txt'), 'unsafe repair\n');
    const runnerPath = await createMockRepairRunner(
      work,
      "writeFileSync('.env', 'TOKEN=repair-secret\\n');"
    );
    const outputPath = path.join(work, '.pages-artifacts/github-output.txt');

    await assert.rejects(
      runPlatformAgentFinalizer({
        cwd: work,
        env: {
          ...baseEnv({ remote, runnerPath, outputPath }),
          PLATFORM_AGENT_COMMIT_MESSAGE: 'bad message',
        },
      }),
      /Refusing to commit local env/
    );

    const remoteLog = await git(work, ['ls-remote', remote, 'refs/heads/feat/platform-pdev_runner123-test']);
    assert.doesNotMatch(remoteLog, /repair-secret/);
  });
});

test('finalizer rejects unauthorized high-risk repair paths before amend and push', async () => {
  await createRepositoryFixture(async ({ remote, work }) => {
    await writeFile(path.join(work, 'target.txt'), 'high risk repair\n');
    const runnerPath = await createMockRepairRunner(
      work,
      "execFileSync('mkdir', ['-p', '.github/workflows']);\nwriteFileSync('.github/workflows/unsafe.yml', 'name: unsafe\\n');"
    );
    const outputPath = path.join(work, '.pages-artifacts/github-output.txt');

    await assert.rejects(
      runPlatformAgentFinalizer({
        cwd: work,
        env: {
          ...baseEnv({ remote, runnerPath, outputPath }),
          PLATFORM_AGENT_COMMIT_MESSAGE: 'bad message',
          RISK: 'risk:medium',
          EFFECTIVE_RISK: 'risk:medium',
        },
      }),
      /High-risk paths require manually triggered high-risk Platform Dev work/
    );

    const remoteLog = await git(work, ['ls-remote', remote, 'refs/heads/feat/platform-pdev_runner123-test']);
    assert.doesNotMatch(remoteLog, /unsafe/);
  });
});

test('finalizer rejects unsafe repair commits even when the repair agent amends HEAD itself', async () => {
  await createRepositoryFixture(async ({ remote, work }) => {
    await writeFile(path.join(work, 'target.txt'), 'committed unsafe repair\n');
    const runnerPath = await createMockRepairRunner(
      work,
      [
        "writeFileSync('target.txt', 'committed unsafe repair\\nAPI_KEY=repair-secret-value\\n');",
        "execFileSync('git', ['add', 'target.txt'], { stdio: 'inherit' });",
        "execFileSync('git', ['commit', '--amend', '--no-edit'], { stdio: 'inherit' });",
      ].join('\n')
    );
    const outputPath = path.join(work, '.pages-artifacts/github-output.txt');

    await assert.rejects(
      runPlatformAgentFinalizer({
        cwd: work,
        env: {
          ...baseEnv({ remote, runnerPath, outputPath }),
          PLATFORM_AGENT_COMMIT_MESSAGE: 'bad message',
        },
      }),
      /Potential secret detected in changed file: target\.txt/
    );

    const remoteLog = await git(work, ['ls-remote', remote, 'refs/heads/feat/platform-pdev_runner123-test']);
    assert.doesNotMatch(remoteLog, /repair-secret-value/);
  });
});

test('finalizer repairs base fetch failures instead of trusting stale origin refs', async () => {
  await createRepositoryFixture(async ({ remote, seed, work }) => {
    await writeFile(path.join(seed, 'master-only.txt'), 'new master\n');
    await git(seed, ['checkout', 'master']);
    await git(seed, ['add', 'master-only.txt']);
    await git(seed, ['commit', '-m', 'chore: 推进 master']);
    await git(seed, ['push', 'origin', 'master']);

    const staleRemote = path.join(path.dirname(remote), 'missing-remote.git');
    await writeFile(path.join(work, 'target.txt'), 'base fetch failed\n');
    const runnerPath = await createMockRepairRunner(work, '');
    const outputPath = path.join(work, '.pages-artifacts/github-output.txt');

    await assert.rejects(
      runPlatformAgentFinalizer({
        cwd: work,
        env: {
          ...baseEnv({ remote: staleRemote, runnerPath, outputPath }),
          PLATFORM_AGENT_FINALIZATION_MAX_ATTEMPTS: '1',
        },
      }),
      /Platform Agent finalization did not complete/
    );

    assert.match(await readFile(path.join(work, '.pages-artifacts/repair-contexts.log'), 'utf8'), /base_fetch_failed/);
    const remoteLog = await git(work, ['ls-remote', remote, 'refs/heads/feat/platform-pdev_runner123-test']);
    assert.doesNotMatch(remoteLog, /base fetch failed/);
  });
});
