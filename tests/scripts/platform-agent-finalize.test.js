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

test('finalizer removes write credentials from finalization repair environment', async () => {
  await createRepositoryFixture(async ({ remote, work }) => {
    await writeFile(path.join(work, 'target.txt'), 'scrubbed repair env\n');
    const runnerPath = await createMockRepairRunner(
      work,
      [
        "writeFileSync('.pages-artifacts/repair-env.json', JSON.stringify({",
        "  ghToken: process.env.GH_TOKEN || null,",
        "  githubToken: process.env.GITHUB_TOKEN || null,",
        "  callbackToken: process.env.PAGES_CALLBACK_TOKEN || null,",
        "  pushRemoteUrl: process.env.PLATFORM_AGENT_PUSH_REMOTE_URL || null,",
        "  path: process.env.PATH || null,",
        "}, null, 2));",
        "execFileSync('git', ['commit', '--amend', '-m', 'fix(gateway): 修复收尾环境隔离'], { stdio: 'inherit' });",
      ].join('\n')
    );
    const outputPath = path.join(work, '.pages-artifacts/github-output.txt');

    const result = await runPlatformAgentFinalizer({
      cwd: work,
      env: {
        ...baseEnv({ remote, runnerPath, outputPath }),
        PLATFORM_AGENT_COMMIT_MESSAGE: 'bad message',
        GITHUB_TOKEN: 'ghs_should_not_reach_repair',
        PAGES_CALLBACK_TOKEN: 'callback_should_not_reach_repair',
      },
    });

    const repairEnv = JSON.parse(await readFile(path.join(work, '.pages-artifacts/repair-env.json'), 'utf8'));
    assert.equal(result.changed, true);
    assert.equal(repairEnv.ghToken, null);
    assert.equal(repairEnv.githubToken, null);
    assert.equal(repairEnv.callbackToken, null);
    assert.equal(repairEnv.pushRemoteUrl, null);
    assert.match(repairEnv.path, /finalization-repair-bin/);
  });
});

test('finalizer blocks git push commands during finalization repair', async () => {
  await createRepositoryFixture(async ({ remote, work }) => {
    await writeFile(path.join(work, 'target.txt'), 'blocked repair push\n');
    const runnerPath = await createMockRepairRunner(
      work,
      [
        'let pushStatus = 0;',
        "let pushStderr = '';",
        'try {',
        "  execFileSync('git', ['push', 'origin', 'HEAD:refs/heads/blocked-repair-push'], { stdio: 'pipe' });",
        '} catch (error) {',
        '  pushStatus = error.status || 1;',
        "  pushStderr = error.stderr ? error.stderr.toString() : '';",
        '}',
        "writeFileSync('.pages-artifacts/repair-push.json', JSON.stringify({ pushStatus, pushStderr }, null, 2));",
        'if (pushStatus === 0) process.exit(9);',
        "execFileSync('git', ['commit', '--amend', '-m', 'fix(gateway): 修复收尾推送隔离'], { stdio: 'inherit' });",
      ].join('\n')
    );
    const outputPath = path.join(work, '.pages-artifacts/github-output.txt');

    const result = await runPlatformAgentFinalizer({
      cwd: work,
      env: {
        ...baseEnv({ remote, runnerPath, outputPath }),
        PLATFORM_AGENT_COMMIT_MESSAGE: 'bad message',
      },
    });

    const repairPush = JSON.parse(await readFile(path.join(work, '.pages-artifacts/repair-push.json'), 'utf8'));
    const blockedRemote = await git(work, ['ls-remote', remote, 'refs/heads/blocked-repair-push']);
    assert.equal(result.changed, true);
    assert.equal(repairPush.pushStatus, 126);
    assert.match(repairPush.pushStderr, /cannot run git push/);
    assert.equal(blockedRemote, '');
  });
});

test('finalizer asks Platform Agent to merge stale branch on latest master before push', async () => {
  await createRepositoryFixture(async ({ remote, seed, work }) => {
    await writeFile(path.join(seed, 'master-only.txt'), 'new master\n');
    await git(seed, ['checkout', 'master']);
    await git(seed, ['add', 'master-only.txt']);
    await git(seed, ['commit', '-m', 'chore: 推进 master']);
    await git(seed, ['push', 'origin', 'master']);

    await writeFile(path.join(work, 'target.txt'), 'stale base repair\n');
    const runnerPath = await createMockRepairRunner(
      work,
      "execFileSync('git', ['merge', 'origin/master', '-m', 'fix(gateway): 合并最新 master'], { stdio: 'inherit' });"
    );
    const outputPath = path.join(work, '.pages-artifacts/github-output.txt');

    const result = await runPlatformAgentFinalizer({
      cwd: work,
      env: baseEnv({ remote, runnerPath, outputPath }),
    });

    assert.equal(result.changed, true);
    assert.equal(await git(work, ['merge-base', '--is-ancestor', 'origin/master', 'HEAD']).then(() => 'yes'), 'yes');
    const context = await readFile(path.join(work, '.pages-artifacts/repair-contexts.log'), 'utf8');
    assert.match(context, /base_not_current/);
    assert.match(context, /conventional Chinese commit subject/);
    assert.match(context, /do not rebase published branch history/);
  });
});

test('finalizer allows high-risk files that already belong to latest master', async () => {
  await createRepositoryFixture(async ({ remote, seed, work }) => {
    await git(seed, ['checkout', 'master']);
    await mkdir(path.join(seed, '.github/workflows'), { recursive: true });
    await writeFile(path.join(seed, '.github/workflows/base.yml'), 'name: base\n');
    await git(seed, ['add', '.github/workflows/base.yml']);
    await git(seed, ['commit', '-m', 'ci: 更新 master 工作流']);
    await git(seed, ['push', 'origin', 'master']);

    await writeFile(path.join(work, 'target.txt'), 'stale base with upstream workflow\n');
    const runnerPath = await createMockRepairRunner(
      work,
      "execFileSync('git', ['merge', 'origin/master', '-m', 'fix(gateway): 合并最新 master'], { stdio: 'inherit' });"
    );
    const outputPath = path.join(work, '.pages-artifacts/github-output.txt');

    const result = await runPlatformAgentFinalizer({
      cwd: work,
      env: {
        ...baseEnv({ remote, runnerPath, outputPath }),
        RISK: 'risk:medium',
        EFFECTIVE_RISK: 'risk:medium',
      },
    });

    assert.equal(result.changed, true);
    assert.equal(await git(work, ['merge-base', '--is-ancestor', 'origin/master', 'HEAD']).then(() => 'yes'), 'yes');
  });
});

test('finalizer preserves fast-forward push when repairing a published branch against latest master', async () => {
  await createRepositoryFixture(async ({ remote, seed, work }) => {
    await git(seed, ['checkout', 'feat/platform-pdev_runner123-test']);
    await writeFile(path.join(seed, 'published.txt'), 'published branch commit\n');
    await git(seed, ['add', 'published.txt']);
    await git(seed, ['commit', '-m', 'fix(gateway): 已发布分支提交']);
    await git(seed, ['push', 'origin', 'feat/platform-pdev_runner123-test']);

    await git(work, [
      'fetch',
      'origin',
      '+refs/heads/feat/platform-pdev_runner123-test:refs/remotes/origin/feat/platform-pdev_runner123-test',
    ]);
    await git(work, ['reset', '--hard', 'origin/feat/platform-pdev_runner123-test']);

    await git(seed, ['checkout', 'master']);
    await writeFile(path.join(seed, 'master-only.txt'), 'new master after branch publish\n');
    await git(seed, ['add', 'master-only.txt']);
    await git(seed, ['commit', '-m', 'chore: 推进 master']);
    await git(seed, ['push', 'origin', 'master']);

    await writeFile(path.join(work, 'target.txt'), 'published branch base repair\n');
    const runnerPath = await createMockRepairRunner(
      work,
      "execFileSync('git', ['merge', 'origin/master', '-m', 'fix(gateway): 合并最新 master'], { stdio: 'inherit' });"
    );
    const outputPath = path.join(work, '.pages-artifacts/github-output.txt');

    const result = await runPlatformAgentFinalizer({
      cwd: work,
      env: baseEnv({ remote, runnerPath, outputPath }),
    });

    assert.equal(result.changed, true);
    assert.equal(await git(work, ['merge-base', '--is-ancestor', 'origin/master', 'HEAD']).then(() => 'yes'), 'yes');
    assert.equal(
      await git(work, [
        'merge-base',
        '--is-ancestor',
        'origin/feat/platform-pdev_runner123-test',
        'HEAD',
      ]).then(() => 'yes'),
      'yes'
    );
    const remoteLog = await git(work, ['ls-remote', remote, 'refs/heads/feat/platform-pdev_runner123-test']);
    assert.match(remoteLog, new RegExp(result.headSha));
  });
});

test('finalizer rejects unsafe files introduced by repair merge commits', async () => {
  await createRepositoryFixture(async ({ remote, seed, work }) => {
    await git(seed, ['checkout', 'master']);
    await writeFile(path.join(seed, 'master-only.txt'), 'new master\n');
    await git(seed, ['add', 'master-only.txt']);
    await git(seed, ['commit', '-m', 'chore: 推进 master']);
    await git(seed, ['push', 'origin', 'master']);

    await writeFile(path.join(work, 'target.txt'), 'stale base with unsafe merge repair\n');
    const runnerPath = await createMockRepairRunner(
      work,
      [
        "execFileSync('git', ['merge', 'origin/master', '--no-commit'], { stdio: 'inherit' });",
        "writeFileSync('.env', 'TOKEN=repair-merge-secret\\n');",
        "execFileSync('git', ['add', '.env'], { stdio: 'inherit' });",
        "execFileSync('git', ['commit', '-m', 'fix(gateway): 合并最新 master'], { stdio: 'inherit' });",
      ].join('\n')
    );
    const outputPath = path.join(work, '.pages-artifacts/github-output.txt');

    await assert.rejects(
      runPlatformAgentFinalizer({
        cwd: work,
        env: {
          ...baseEnv({ remote, runnerPath, outputPath }),
          RISK: 'risk:medium',
          EFFECTIVE_RISK: 'risk:medium',
        },
      }),
      /Refusing to commit local env/
    );

    const remoteLog = await git(work, ['ls-remote', remote, 'refs/heads/feat/platform-pdev_runner123-test']);
    assert.doesNotMatch(remoteLog, /repair-merge-secret/);
  });
});

test('finalizer rejects repair merge commits that change agent-owned files unsafely', async () => {
  await createRepositoryFixture(async ({ remote, seed, work }) => {
    await git(seed, ['checkout', 'master']);
    await writeFile(path.join(seed, 'master-only.txt'), 'new master\n');
    await git(seed, ['add', 'master-only.txt']);
    await git(seed, ['commit', '-m', 'chore: 推进 master']);
    await git(seed, ['push', 'origin', 'master']);

    await writeFile(path.join(work, 'target.txt'), 'stale base with unsafe agent file repair\n');
    const runnerPath = await createMockRepairRunner(
      work,
      [
        "execFileSync('git', ['merge', 'origin/master', '--no-commit'], { stdio: 'inherit' });",
        "writeFileSync('target.txt', 'API_KEY=repair-merge-secret-value\\n');",
        "execFileSync('git', ['add', 'target.txt'], { stdio: 'inherit' });",
        "execFileSync('git', ['commit', '-m', 'fix(gateway): 合并最新 master'], { stdio: 'inherit' });",
      ].join('\n')
    );
    const outputPath = path.join(work, '.pages-artifacts/github-output.txt');

    await assert.rejects(
      runPlatformAgentFinalizer({
        cwd: work,
        env: baseEnv({ remote, runnerPath, outputPath }),
      }),
      /Potential secret detected in changed file: target\.txt/
    );

    const remoteLog = await git(work, ['ls-remote', remote, 'refs/heads/feat/platform-pdev_runner123-test']);
    assert.doesNotMatch(remoteLog, /repair-merge-secret-value/);
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

test('finalizer rejects renames into local env files before the initial commit', async () => {
  await createRepositoryFixture(async ({ remote, work }) => {
    await writeFile(path.join(work, 'safe.txt'), 'TOKEN=renamed-secret\n');
    await git(work, ['add', 'safe.txt']);
    await git(work, ['commit', '-m', 'chore: 添加普通文件']);
    await git(work, ['mv', 'safe.txt', '.env']);
    const runnerPath = await createMockRepairRunner(work, '');
    const outputPath = path.join(work, '.pages-artifacts/github-output.txt');

    await assert.rejects(
      runPlatformAgentFinalizer({
        cwd: work,
        env: baseEnv({ remote, runnerPath, outputPath }),
      }),
      /Refusing to commit local env/
    );

    assert.match(await git(work, ['status', '--porcelain=v1', '-z', '--untracked-files=all']), /\.env/);
    const remoteLog = await git(work, ['ls-remote', remote, 'refs/heads/feat/platform-pdev_runner123-test']);
    assert.doesNotMatch(remoteLog, /renamed-secret/);
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

test('finalizer rejects unsafe files from any commit created during repair', async () => {
  await createRepositoryFixture(async ({ remote, work }) => {
    await writeFile(path.join(work, 'target.txt'), 'multi commit unsafe repair\n');
    const runnerPath = await createMockRepairRunner(
      work,
      [
        "writeFileSync('.env', 'TOKEN=intermediate-secret\\n');",
        "execFileSync('git', ['add', '.env'], { stdio: 'inherit' });",
        "execFileSync('git', ['commit', '-m', 'fix(gateway): 添加临时配置'], { stdio: 'inherit' });",
        "execFileSync('git', ['rm', '.env'], { stdio: 'inherit' });",
        "writeFileSync('target.txt', 'multi commit unsafe repair\\nfinal clean commit\\n');",
        "execFileSync('git', ['add', 'target.txt'], { stdio: 'inherit' });",
        "execFileSync('git', ['commit', '-m', 'fix(gateway): 清理临时配置'], { stdio: 'inherit' });",
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
      /Refusing to commit local env/
    );

    const remoteLog = await git(work, ['ls-remote', remote, 'refs/heads/feat/platform-pdev_runner123-test']);
    assert.doesNotMatch(remoteLog, /intermediate-secret/);
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
