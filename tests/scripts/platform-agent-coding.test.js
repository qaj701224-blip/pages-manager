import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { companyChatCompletionsUrl, runPlatformCodingAgent } from '../../scripts/platform-agent-coding.mjs';

const env = {
  PLATFORM_DEV_ITEM_ID: 'pdev_abc123',
  AGENT_MODE: 'initial',
  ISSUE_NUMBER: '77',
  REQUEST_TITLE: '平台需求',
  REQUEST_SUMMARY: '实现 Slack 到平台 PR 的闭环。',
  ISSUE_TYPE: 'type:dev',
  AREAS: 'area:gateway,area:github',
  RISK: 'risk:medium',
  BASE_REF: 'master',
  AGENT_GATEWAY_URL: 'https://agent.example',
  AGENT_CODE_API_KEY: 'code-key',
  AGENT_MODEL_NAME: 'company-coder',
};

async function initGitRepo(dir) {
  execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  await writeFile(path.join(dir, '.gitignore'), '.pages-artifacts/\n');
  execFileSync('git', ['add', '.gitignore'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
}

async function writePlatformAgentSkillsFixture(dir) {
  const skillsDir = path.join(dir, 'scripts/platform-agent-skills');
  await mkdir(skillsDir, { recursive: true });
  await writeFile(
    path.join(skillsDir, '00-project-rules.md'),
    ['# Project Rules', '', '- Do not merge or auto-merge into master.', '- Keep docs and code synchronized.', ''].join('\n')
  );
  await writeFile(
    path.join(skillsDir, '10-code-map.md'),
    ['# Code Map', '', '- Gateway code lives under apps/gateway.', '- Worker jobs live under apps/worker.', ''].join('\n')
  );
  await writeFile(
    path.join(skillsDir, '20-validation.md'),
    ['# Validation', '', '- Run focused node:test coverage.', '- Run lint before handoff.', ''].join('\n')
  );
}

function responseFor(content) {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify(content),
          },
        },
      ],
    }),
    { status: 200 }
  );
}

test('normalizes company platform coding gateway URL', () => {
  assert.equal(companyChatCompletionsUrl('https://agent.example'), 'https://agent.example/v1/chat/completions');
  assert.equal(companyChatCompletionsUrl('https://agent.example/v1'), 'https://agent.example/v1/chat/completions');
  assert.equal(
    companyChatCompletionsUrl('https://agent.example/v1/chat/completions'),
    'https://agent.example/v1/chat/completions'
  );
});

test('runs Platform Coding Agent and writes repo relative files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'platform-agent-coding-'));
  const previousCwd = process.cwd();
  const calls = [];
  try {
    await writePlatformAgentSkillsFixture(dir);
    process.chdir(dir);
    await writeFile('package.json', '{"private":true}\n');
    await runPlatformCodingAgent({
      env,
      async fetchImpl(url, request) {
        calls.push({ url: String(url), request });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    files: [
                      {
                        path: 'docs/architecture/platform-dev-lane.md',
                        content: '# Platform Dev Lane\n\nImplemented.\n',
                      },
                      {
                        path: 'tests/platform.test.js',
                        content: "import test from 'node:test';\n",
                      },
                    ],
                    summary: 'Updated platform docs and tests.',
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      },
    });

    const requestBody = JSON.parse(calls[0].request.body);
    const requestContext = JSON.parse(requestBody.messages[1].content);
    const doc = await readFile(path.join(dir, 'docs/architecture/platform-dev-lane.md'), 'utf8');
    const report = JSON.parse(await readFile(path.join(dir, '.pages-artifacts/platform-agent-report.json'), 'utf8'));

    assert.equal(calls[0].url, 'https://agent.example/v1/chat/completions');
    assert.equal(calls[0].request.headers.Authorization, 'Bearer code-key');
    assert.equal(requestBody.model, 'company-coder');
    assert.equal(requestBody.reasoning_effort, 'medium');
    assert.match(requestBody.messages[0].content, /Platform Coding Agent/);
    assert.deepEqual(
      requestContext.preloadedSkills.map((skill) => skill.path),
      [
        'scripts/platform-agent-skills/00-project-rules.md',
        'scripts/platform-agent-skills/10-code-map.md',
        'scripts/platform-agent-skills/20-validation.md',
      ]
    );
    assert.match(requestContext.preloadedSkills[0].content, /Do not merge or auto-merge/);
    assert.match(doc, /Implemented/);
    assert.equal(report.platformDevItemId, 'pdev_abc123');
    assert.deepEqual(report.generatedFiles, ['docs/architecture/platform-dev-lane.md', 'tests/platform.test.js']);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects high risk platform coding without gate', async () => {
  await assert.rejects(
    () =>
      runPlatformCodingAgent({
        env: { ...env, RISK: 'risk:high' },
        fetchImpl: async () => {
          throw new Error('fetch should not be called');
        },
      }),
    /High risk platform work/
  );
});

test('treats CI, ops, and security work as high risk even when declared risk is lower', async () => {
  await assert.rejects(
    () =>
      runPlatformCodingAgent({
        env: { ...env, ISSUE_TYPE: 'type:ci', RISK: 'risk:medium' },
        fetchImpl: async () => {
          throw new Error('fetch should not be called');
        },
      }),
    /High risk platform work/
  );
});

test('rejects question and feedback issues before calling Platform Coding Agent', async () => {
  await assert.rejects(
    () =>
      runPlatformCodingAgent({
        env: { ...env, ISSUE_TYPE: 'type:question', RISK: 'risk:low' },
        fetchImpl: async () => {
          throw new Error('fetch should not be called');
        },
      }),
    /not code-eligible/
  );
});

test('allows high risk platform coding after gate approval', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'platform-agent-approved-'));
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    await runPlatformCodingAgent({
      env: { ...env, RISK: 'risk:high', GATE_APPROVED: 'true' },
      async fetchImpl() {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    files: [{ path: 'docs/architecture/platform-dev-lane.md', content: '# Approved\n' }],
                    summary: 'High risk gate approved.',
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      },
    });

    const report = JSON.parse(await readFile(path.join(dir, '.pages-artifacts/platform-agent-report.json'), 'utf8'));
    assert.equal(report.risk, 'risk:high');
    assert.equal(report.gateApproved, true);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects high-risk repository paths without gate approval', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'platform-agent-sensitive-path-'));
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    await assert.rejects(
      () =>
        runPlatformCodingAgent({
          env,
          async fetchImpl() {
            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        files: [{ path: '.github/workflows/platform-agent.yml', content: 'name: Platform Agent\n' }],
                      }),
                    },
                  },
                ],
              }),
              { status: 200 }
            );
          },
        }),
      /high-risk gate approval/
    );
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects root deploy paths without gate approval', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'platform-agent-deploy-path-'));
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    await assert.rejects(
      () =>
        runPlatformCodingAgent({
          env,
          async fetchImpl() {
            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        files: [{ path: 'deploy/ecs/Caddyfile', content: ':80 {\n  respond "ok"\n}\n' }],
                      }),
                    },
                  },
                ],
              }),
              { status: 200 }
            );
          },
        }),
      /high-risk gate approval/
    );
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('allows high-risk repository paths after gate approval', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'platform-agent-sensitive-approved-'));
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    await runPlatformCodingAgent({
      env: { ...env, RISK: 'risk:high', GATE_APPROVED: 'true' },
      async fetchImpl() {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    files: [
                      { path: '.github/workflows/platform-agent.yml', content: 'name: Platform Agent\n' },
                      { path: 'deploy/ecs/Caddyfile', content: ':80 {\n  respond "ok"\n}\n' },
                      { path: 'docs/architecture/platform-agent.md', content: '# Platform Agent\n\nDocumented.\n' },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      },
    });

    const workflow = await readFile(path.join(dir, '.github/workflows/platform-agent.yml'), 'utf8');
    const caddyfile = await readFile(path.join(dir, 'deploy/ecs/Caddyfile'), 'utf8');
    const doc = await readFile(path.join(dir, 'docs/architecture/platform-agent.md'), 'utf8');
    assert.match(workflow, /Platform Agent/);
    assert.match(caddyfile, /respond "ok"/);
    assert.match(doc, /Documented/);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('writes a missing-files diagnostic when model output has no generated files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'platform-agent-missing-files-'));
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    await assert.rejects(
      () =>
        runPlatformCodingAgent({
          env,
          async fetchImpl() {
            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        summary: '这是一个仓库问答，不需要修改文件。',
                      }),
                    },
                  },
                ],
              }),
              { status: 200 }
            );
          },
        }),
      /did not include files/
    );

    const diagnostic = JSON.parse(await readFile(path.join(dir, '.pages-artifacts/platform-agent-debug.json'), 'utf8'));
    assert.equal(diagnostic.reason, 'missing_files');
    assert.equal(diagnostic.platformDevItemId, 'pdev_abc123');
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects forbidden generated paths and writes sanitized diagnostic', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'platform-agent-forbidden-'));
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    await assert.rejects(
      () =>
        runPlatformCodingAgent({
          env,
          async fetchImpl() {
            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        files: [{ path: '.env', content: 'TOKEN=secret' }],
                        summary: 'Bad output.',
                      }),
                    },
                  },
                ],
              }),
              { status: 200 }
            );
          },
        }),
      /forbidden/
    );

    const diagnostic = JSON.parse(await readFile(path.join(dir, '.pages-artifacts/platform-agent-debug.json'), 'utf8'));
    assert.equal(diagnostic.reason, 'invalid_files');
    assert.equal(JSON.stringify(diagnostic).includes('TOKEN=secret'), false);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects secret-looking generated content', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'platform-agent-secret-'));
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    await assert.rejects(
      () =>
        runPlatformCodingAgent({
          env,
          async fetchImpl() {
            return new Response(
              JSON.stringify({
                choices: [
                  {
                    message: {
                      content: JSON.stringify({
                        files: [{ path: 'docs/example.md', content: 'AGENT_CODE_API_KEY=do-not-write' }],
                      }),
                    },
                  },
                ],
              }),
              { status: 200 }
            );
          },
        }),
      /secret-looking/
    );
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('allows documented secret variable names without literal values', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'platform-agent-secret-doc-'));
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    await runPlatformCodingAgent({
      env,
      async fetchImpl() {
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    files: [
                      {
                        path: 'docs/secrets.md',
                        content: [
                          'Use `AGENT_CODE_API_KEY` from GitHub secrets.',
                          'Read `process.env.CF_API_TOKEN` only in deploy jobs.',
                        ].join('\n'),
                      },
                    ],
                  }),
                },
              },
            ],
          }),
          { status: 200 }
        );
      },
    });

    const doc = await readFile(path.join(dir, 'docs/secrets.md'), 'utf8');
    assert.match(doc, /AGENT_CODE_API_KEY/);
    assert.match(doc, /process\.env\.CF_API_TOKEN/);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('runs tool loop with read_file, apply_patch, run_command, and finish', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'platform-agent-tool-loop-'));
  const previousCwd = process.cwd();
  const calls = [];
  try {
    await initGitRepo(dir);
    process.chdir(dir);
    await writeFile(path.join(dir, 'README.md'), '# Repo\n\nOld.\n');
    await writeFile(path.join(dir, 'package.json'), '{"private":true,"type":"module"}\n');
    execFileSync('git', ['add', 'README.md', 'package.json'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: dir, stdio: 'ignore' });

    const responses = [
      { action: 'read_file', path: 'README.md', startLine: 1, maxLines: 20 },
      {
        action: 'apply_patch',
        patch: [
          'diff --git a/README.md b/README.md',
          '--- a/README.md',
          '+++ b/README.md',
          '@@ -1,3 +1,3 @@',
          ' # Repo',
          ' ',
          '-Old.',
          '+New.',
          '',
        ].join('\n'),
      },
      { action: 'run_command', cmd: 'node', args: ['--version'] },
      { action: 'finish', summary: 'Updated README.', tests: ['node --version'] },
    ];

    await runPlatformCodingAgent({
      env: { ...env, AGENT_CODE_MAX_STEPS: '8' },
      async fetchImpl(url, request) {
        calls.push({ url: String(url), request, body: JSON.parse(request.body) });
        return responseFor(responses[calls.length - 1]);
      },
    });

    const readme = await readFile(path.join(dir, 'README.md'), 'utf8');
    const report = JSON.parse(await readFile(path.join(dir, '.pages-artifacts/platform-agent-report.json'), 'utf8'));
    const secondRequest = calls[1].body;
    const commandRequest = calls[3].body;

    assert.match(readme, /New/);
    assert.equal(calls.length, 4);
    assert.equal(report.toolMode, true);
    assert.deepEqual(report.generatedFiles, ['README.md']);
    assert.deepEqual(
      report.steps.map((step) => step.action),
      ['read_file', 'apply_patch', 'run_command']
    );
    assert.deepEqual(report.tests, ['node --version']);
    assert.match(secondRequest.messages.at(-1).content, /"tool":"read_file"/);
    assert.match(secondRequest.messages.at(-1).content, /Old/);
    assert.match(commandRequest.messages.at(-1).content, /"tool":"run_command"/);
    assert.match(commandRequest.messages.at(-1).content, /"status":0/);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('tool loop rejects final code changes without documentation changes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'platform-agent-doc-required-'));
  const previousCwd = process.cwd();
  try {
    await initGitRepo(dir);
    process.chdir(dir);
    await writeFile(path.join(dir, 'scripts.js'), 'export const value = 1;\n');
    execFileSync('git', ['add', 'scripts.js'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: dir, stdio: 'ignore' });

    const responses = [
      {
        action: 'apply_patch',
        patch: [
          'diff --git a/scripts.js b/scripts.js',
          '--- a/scripts.js',
          '+++ b/scripts.js',
          '@@ -1 +1 @@',
          '-export const value = 1;',
          '+export const value = 2;',
          '',
        ].join('\n'),
      },
      { action: 'finish', summary: 'Updated code.', tests: [] },
    ];
    let index = 0;

    await assert.rejects(
      () =>
        runPlatformCodingAgent({
          env,
          async fetchImpl() {
            return responseFor(responses[index++]);
          },
        }),
      /matching documentation update/
    );
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('tool loop rejects unsafe command and allows the model to recover', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'platform-agent-unsafe-command-'));
  const previousCwd = process.cwd();
  const calls = [];
  try {
    await initGitRepo(dir);
    process.chdir(dir);
    await writeFile(path.join(dir, 'README.md'), '# Repo\n\nOld.\n');
    execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: dir, stdio: 'ignore' });

    const responses = [
      { action: 'run_command', cmd: 'bash', args: ['-lc', 'echo unsafe'] },
      {
        action: 'apply_patch',
        patch: [
          'diff --git a/README.md b/README.md',
          '--- a/README.md',
          '+++ b/README.md',
          '@@ -1,3 +1,3 @@',
          ' # Repo',
          ' ',
          '-Old.',
          '+Recovered.',
          '',
        ].join('\n'),
      },
      { action: 'finish', summary: 'Recovered.', tests: [] },
    ];

    await runPlatformCodingAgent({
      env,
      async fetchImpl(url, request) {
        calls.push(JSON.parse(request.body));
        return responseFor(responses[calls.length - 1]);
      },
    });

    const retryRequest = calls[1];
    const readme = await readFile(path.join(dir, 'README.md'), 'utf8');
    assert.match(retryRequest.messages.at(-1).content, /not allowed/);
    assert.match(readme, /Recovered/);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('tool loop rejects high-risk patch paths without gate approval', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'platform-agent-patch-gate-'));
  const previousCwd = process.cwd();
  const calls = [];
  try {
    await initGitRepo(dir);
    process.chdir(dir);
    await writeFile(path.join(dir, 'README.md'), '# Repo\n');
    execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'baseline'], { cwd: dir, stdio: 'ignore' });

    const responses = [
      {
        action: 'apply_patch',
        patch: [
          'diff --git a/.github/workflows/platform-agent.yml b/.github/workflows/platform-agent.yml',
          'new file mode 100644',
          '--- /dev/null',
          '+++ b/.github/workflows/platform-agent.yml',
          '@@ -0,0 +1 @@',
          '+name: Platform Agent',
          '',
        ].join('\n'),
      },
      { action: 'finish', summary: 'No change.', tests: [] },
    ];

    await assert.rejects(
      () =>
        runPlatformCodingAgent({
          env,
          async fetchImpl(url, request) {
            calls.push(JSON.parse(request.body));
            return responseFor(responses[calls.length - 1]);
          },
        }),
      /finished without repository changes/
    );

    assert.match(calls[1].messages.at(-1).content, /high-risk gate approval/);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
});
