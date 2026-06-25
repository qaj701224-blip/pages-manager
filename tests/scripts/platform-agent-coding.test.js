import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { companyChatCompletionsUrl, runPlatformCodingAgent } from '../../scripts/platform-agent-coding.mjs';

const env = {
  PLATFORM_DEV_ITEM_ID: 'pdev_abc123',
  AGENT_MODE: 'initial',
  ISSUE_NUMBER: '77',
  PR_NUMBER: '88',
  HEAD_SHA: 'a'.repeat(40),
  REQUEST_TITLE: '平台需求',
  REQUEST_SUMMARY: '实现 Slack 到平台 PR 的闭环。',
  ISSUE_TYPE: 'type:dev',
  AREAS: 'area:gateway,area:github',
  RISK: 'risk:medium',
  BASE_REF: 'master',
  REVIEW_CONTEXT: 'Review context for PR #88:\n1. [blocking] README 缺说明',
  MEMORY_CONTEXT: 'Session summary: previous run changed docs.',
  STATUS_CONTEXT: 'status: review_blocked',
  FOLLOWUP_CONTEXT: 'Slack follow-up: 继续收紧文案。',
  AGENT_GATEWAY_URL: 'https://agent.example',
  AGENT_CODE_API_KEY: 'code-key',
  AGENT_MODEL_NAME: 'company-coder',
};

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
    const doc = await readFile(path.join(dir, 'docs/architecture/platform-dev-lane.md'), 'utf8');
    const report = JSON.parse(await readFile(path.join(dir, '.pages-artifacts/platform-agent-report.json'), 'utf8'));

    assert.equal(calls[0].url, 'https://agent.example/v1/chat/completions');
    assert.equal(calls[0].request.headers.Authorization, 'Bearer code-key');
    assert.equal(requestBody.model, 'company-coder');
    assert.equal(requestBody.reasoning_effort, 'medium');
    assert.match(requestBody.messages[0].content, /Platform Coding Agent/);
    const userPayload = JSON.parse(requestBody.messages[1].content);
    assert.equal(userPayload.mode, 'initial');
    assert.equal(userPayload.prNumber, '88');
    assert.equal(userPayload.headSha, 'a'.repeat(40));
    assert.match(userPayload.reviewContext, /README 缺说明/);
    assert.match(userPayload.memoryContext, /previous run/);
    assert.match(userPayload.statusContext, /review_blocked/);
    assert.match(userPayload.followupContext, /继续收紧文案/);
    assert.match(doc, /Implemented/);
    assert.equal(report.platformDevItemId, 'pdev_abc123');
    assert.equal(report.prNumber, '88');
    assert.equal(report.headSha, 'a'.repeat(40));
    assert.deepEqual(report.contextReceived, {
      review: true,
      memory: true,
      status: true,
      followup: true,
    });
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
    assert.match(workflow, /Platform Agent/);
    assert.match(caddyfile, /respond "ok"/);
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
