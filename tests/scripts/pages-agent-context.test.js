import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { resolvePagesAgentContext, writePagesAgentContext } from '../../scripts/pages-agent-context.mjs';

test('resolves pages-agent context from gateway-controlled workflow inputs', () => {
  const context = resolvePagesAgentContext({
    INPUT_PUBLISHING_JOB_ID: 'job_abc123',
    INPUT_AGENT_MODE: 'initial',
    INPUT_EMPLOYEE_SLUG: 'alice',
    INPUT_SITE_SLUG: 'profile',
    INPUT_ALLOWED_PATH: 'sites/alice/profile',
    INPUT_BASE_REF: 'staging',
    INPUT_ISSUE_NUMBER: '42',
    INPUT_REQUEST_TITLE: '[pages] alice/profile: Personal site',
    INPUT_REQUEST_SUMMARY: 'Create a sharp personal homepage.',
    INPUT_CALLBACK_URL: 'https://gateway.example/internal/executor-callback',
  });

  assert.deepEqual(context, {
    publishingJobId: 'job_abc123',
    mode: 'initial',
    employeeSlug: 'alice',
    siteSlug: 'profile',
    allowedPath: 'sites/alice/profile',
    baseRef: 'staging',
    indexSnapshotId: '',
    issueNumber: '42',
    requestTitle: '[pages] alice/profile: Personal site',
    requestSummary: 'Create a sharp personal homepage.',
    callbackUrl: 'https://gateway.example/internal/executor-callback',
    branchName: '',
  });
});

test('writes pages-agent context to GitHub env and artifact file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'pages-agent-context-'));
  const previousCwd = process.cwd();
  try {
    process.chdir(dir);
    const githubEnv = path.join(dir, 'github-env');
    writePagesAgentContext(
      {
        publishingJobId: 'job_abc123',
        mode: 'initial',
        employeeSlug: 'alice',
        siteSlug: 'profile',
        allowedPath: 'sites/alice/profile',
        baseRef: 'staging',
        indexSnapshotId: '',
        issueNumber: '42',
        requestTitle: 'Profile',
        requestSummary: 'Line one\nLine two',
        callbackUrl: 'https://gateway.example/internal/executor-callback',
        branchName: '',
      },
      { GITHUB_ENV: githubEnv }
    );

    const envText = await readFile(githubEnv, 'utf8');
    const json = JSON.parse(await readFile(path.join(dir, '.pages-artifacts/job-context.json'), 'utf8'));

    assert.match(envText, /PUBLISHING_JOB_ID=job_abc123/);
    assert.match(envText, /REQUEST_SUMMARY<<PAGES_REQUEST_SUMMARY_/);
    assert.equal(json.allowedPath, 'sites/alice/profile');
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
});
