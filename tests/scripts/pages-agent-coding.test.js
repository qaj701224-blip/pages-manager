import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { companyChatCompletionsUrl, runCodingAgent } from '../../scripts/pages-agent-coding.mjs';

const env = {
  PUBLISHING_JOB_ID: 'job_abc123',
  AGENT_MODE: 'initial',
  EMPLOYEE_SLUG: 'alice',
  SITE_SLUG: 'profile',
  ALLOWED_PATH: 'sites/alice/profile',
  BASE_REF: 'staging',
  ISSUE_NUMBER: '42',
  INDEX_SNAPSHOT_ID: '',
  REQUEST_TITLE: 'Alice profile',
  REQUEST_SUMMARY: 'Build a personal homepage for Alice.',
  AGENT_GATEWAY_URL: 'https://agent.example',
  AGENT_CODE_API_KEY: 'code-key',
  AGENT_MODEL_NAME: 'company-coder',
};

test('normalizes company coding gateway URL', () => {
  assert.equal(companyChatCompletionsUrl('https://agent.example'), 'https://agent.example/v1/chat/completions');
  assert.equal(companyChatCompletionsUrl('https://agent.example/v1'), 'https://agent.example/v1/chat/completions');
  assert.equal(
    companyChatCompletionsUrl('https://agent.example/v1/chat/completions'),
    'https://agent.example/v1/chat/completions'
  );
});

test('runs Coding Agent and writes only the allowed site files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-agent-coding-'));
  const previousCwd = process.cwd();
  const calls = [];
  try {
    process.chdir(dir);
    await runCodingAgent({
      env,
      async fetchImpl(url, request) {
        calls.push({ url: String(url), request });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    html: '<!doctype html><html><body><h1>Alice</h1></body></html>',
                    summary: 'Generated Alice homepage.',
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
    const html = await readFile(path.join(dir, 'sites/alice/profile/src/index.html'), 'utf8');
    const siteJson = JSON.parse(await readFile(path.join(dir, 'sites/alice/profile/site.json'), 'utf8'));
    const report = JSON.parse(await readFile(path.join(dir, '.pages-artifacts/agent-report.json'), 'utf8'));

    assert.equal(calls[0].url, 'https://agent.example/v1/chat/completions');
    assert.equal(calls[0].request.headers.Authorization, 'Bearer code-key');
    assert.equal(requestBody.model, 'company-coder');
    assert.equal('temperature' in requestBody, false);
    assert.deepEqual(requestBody.response_format, { type: 'json_object' });
    assert.match(html, /<h1>Alice<\/h1>/);
    assert.equal(siteJson.generatedBy, 'pages-agent-coding');
    assert.equal(siteJson.publishingJobId, 'job_abc123');
    assert.deepEqual(report.generatedFiles, [
      'sites/alice/profile/src/index.html',
      'sites/alice/profile/site.json',
    ]);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('fix mode sends existing site HTML to the Coding Agent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-agent-coding-fix-'));
  const previousCwd = process.cwd();
  const calls = [];
  try {
    process.chdir(dir);
    await mkdir('sites/alice/profile/src', { recursive: true });
    await writeFile('sites/alice/profile/src/index.html', '<!doctype html><h1>Old title</h1>\n');

    await runCodingAgent({
      env: { ...env, AGENT_MODE: 'fix', REQUEST_SUMMARY: '把标题改成中文' },
      async fetchImpl(url, request) {
        calls.push({ url: String(url), request });
        return new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: JSON.stringify({
                    html: '<!doctype html><html><body><h1>中文标题</h1></body></html>',
                    summary: 'Updated title.',
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
    const userPayload = JSON.parse(requestBody.messages[1].content);
    assert.equal(userPayload.mode, 'fix');
    assert.equal(userPayload.currentFiles[0].path, 'sites/alice/profile/src/index.html');
    assert.match(userPayload.currentFiles[0].content, /Old title/);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
});

test('rejects attempts to write outside the expected allowed path', async () => {
  await assert.rejects(
    () =>
      runCodingAgent({
        env: { ...env, ALLOWED_PATH: 'sites/alice' },
        fetchImpl: async () => {
          throw new Error('fetch should not be called');
        },
      }),
    /ALLOWED_PATH must be sites\/alice\/profile/
  );
});
