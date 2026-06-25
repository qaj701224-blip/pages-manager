import assert from 'node:assert/strict';
import test from 'node:test';

import {
  allowedPathForJob,
  appendFollowupIssueComment,
  branchNameForJob,
  buildFollowupIssueComment,
  buildPagesAgentInputs,
  buildPagesPreviewInputs,
  buildPlatformAgentInputs,
  buildPlatformDevIssue,
  buildPlatformDevFollowupComment,
  buildProjectIndexInputs,
  buildPublishingIssue,
  buildSmokeIssue,
  buildSmokeIssueComment,
  dispatchWorkflow,
  ensurePlatformDevIssue,
  ensureSmokeIssue,
  ensurePublishingIssue,
  githubApiUrl,
  parseRepoFullName,
  platformDevItemMarker,
  publishingJobMarker,
  smokeIssueMarker,
} from '../../../packages/git-client/src/index.js';

const job = {
  id: 'job_123',
  source: 'slack',
  requestedByType: 'user',
  requestedById: 'slack:T1:U1',
  employeeSlug: 'zhangsan',
  siteSlug: 'profile',
  siteProjectId: 'site_1',
  approvalMode: 'manual_required',
  title: 'Profile page',
  summary: 'Create a personal profile page.',
  requesterProfile: {
    slackTeamId: 'T1',
    slackUserId: 'U1',
    displayName: '张三',
    email: 'zhangsan@example.com',
  },
  slackThread: {
    teamId: 'T1',
    channelId: 'D1',
    threadTs: '1710000000.000100',
    userId: 'U1',
  },
  issueNumber: 7,
  indexSnapshotId: 'idxsnap_1',
  prNumber: 12,
  headSha: 'a'.repeat(40),
};

const platformItem = {
  id: 'pdev_123',
  source: 'slack',
  requestedByType: 'user',
  requestedById: 'slack:T1:U1',
  title: '支持 Slack 创建平台开发 issue',
  summary: '通过 Slack 创建 pages-manager 自身开发 issue，并跟踪 PR 进度。',
  issueType: 'type:dev',
  areas: ['area:gateway', 'area:github'],
  risk: 'risk:medium',
  agentEligible: true,
  requiresHumanGate: false,
  requesterProfile: job.requesterProfile,
  slackThread: job.slackThread,
  githubIssueNumber: 31,
};

test('parses GitHub repo full name and API URLs', () => {
  assert.deepEqual(parseRepoFullName('org/pages-manager'), { owner: 'org', repo: 'pages-manager' });
  assert.throws(() => parseRepoFullName('bad'), /owner\/repo/);
  assert.equal(
    githubApiUrl({ apiBaseUrl: 'https://github.example/api/v3/' }, '/repos/org/repo').toString(),
    'https://github.example/api/v3/repos/org/repo'
  );
});

test('builds publishing issue with stable job marker and path boundary', () => {
  const issue = buildPublishingIssue(job, {
    baseRef: 'staging',
    callbackUrl: 'https://gateway.example/internal/executor-callback',
  });
  assert.equal(issue.title, '[pages] zhangsan/profile：Profile page');
  assert.ok(issue.body.includes(publishingJobMarker('job_123')));
  assert.ok(issue.body.includes('Allowed path: sites/zhangsan/profile'));
  assert.ok(issue.body.includes('Base ref: staging'));
  assert.ok(issue.body.includes('Pipeline: user-site publishing'));
  assert.ok(issue.body.includes('Platform deployment: out of scope'));
  assert.ok(issue.body.includes('## 发布需求'));
  assert.ok(issue.body.includes('- 发起人：张三'));
  assert.doesNotMatch(issue.body, /zhangsan@example\.com|Slack 用户|user:slack:T1:U1|Team：|Channel：|Thread：/);
  assert.ok(
    issue.body.includes('不允许修改平台代码、GitHub Actions、Kubernetes manifests、Dockerfile、部署脚本或任何 secret 配置')
  );
  assert.deepEqual(issue.labels, ['pages-publishing-job', 'site-change']);
});

test('redacts public issue text before publishing GitHub issues and comments', () => {
  const secretSummary = [
    '请使用 CF_API_TOKEN=cf-secret-value。',
    'Bearer bearer-secret-value',
    '{"AGENT_CODE_API_KEY":"sk-secret-value-1234567890"}',
  ].join('\n');
  const secretTitle = '处理 DATABASE_PASSWORD=db-secret-value 和 Bearer bearer-title-secret';
  const issue = buildPublishingIssue({ ...job, title: secretTitle, summary: secretSummary });
  const platformIssue = buildPlatformDevIssue({ ...platformItem, title: secretTitle, summary: secretSummary });
  const smokeIssue = buildSmokeIssue({ ...job, summary: secretSummary });
  const smokeComment = buildSmokeIssueComment({ ...job, summary: secretSummary });
  const followup = buildFollowupIssueComment({ ...job, summary: secretSummary });
  const platformFollowup = buildPlatformDevFollowupComment({ ...platformItem, summary: secretSummary });
  const publicText = [
    issue.title,
    issue.body,
    platformIssue.title,
    platformIssue.body,
    smokeIssue.body,
    smokeComment,
    followup,
    platformFollowup,
  ].join('\n');

  assert.match(publicText, /CF_API_TOKEN=\[REDACTED_SECRET\]/);
  assert.match(publicText, /DATABASE_PASSWORD=\[REDACTED_SECRET\]/);
  assert.match(publicText, /Bearer \[REDACTED_TOKEN\]/);
  assert.match(publicText, /"AGENT_CODE_API_KEY":"\[REDACTED_SECRET\]"/);
  assert.doesNotMatch(publicText, /cf-secret-value|db-secret-value|bearer-secret-value|bearer-title-secret|sk-secret-value/);
  assert.doesNotMatch(publicText, /zhangsan@example\.com|slack:T1:U1|Team：|Channel：|Thread：/);
});

test('builds platform dev issue with stable marker and enterprise boundaries', () => {
  const issue = buildPlatformDevIssue(platformItem, { baseRef: 'master' });

  assert.equal(issue.title, '[pages-platform] 支持 Slack 创建平台开发 issue');
  assert.ok(issue.body.includes(platformDevItemMarker('pdev_123')));
  assert.ok(issue.body.includes('Lane: platform-dev'));
  assert.ok(issue.body.includes('Repo 范围：全目录，按风险 gate、CI、review 和 GitHub Rulesets 控制'));
  assert.ok(issue.body.includes('Site publishing: out of scope'));
  assert.deepEqual(issue.labels, ['pages-platform-dev', 'type:dev', 'risk:medium', 'area:gateway', 'area:github']);
});

test('builds smoke issue with reusable marker', () => {
  const issue = buildSmokeIssue(job, { scope: 'slack-local' });
  const comment = buildSmokeIssueComment(job);
  const followup = buildFollowupIssueComment(job);

  assert.equal(issue.title, '[pages-smoke] Slack 发布任务验证（slack-local）');
  assert.ok(issue.body.includes(smokeIssueMarker('slack-local')));
  assert.match(issue.body, /Pipeline: user-site publishing/);
  assert.match(issue.body, /Platform deployment: out of scope/);
  assert.match(comment, /PublishingJob: job_123/);
  assert.match(comment, /Allowed path: sites\/zhangsan\/profile/);
  assert.match(comment, /Platform deployment: out of scope/);
  assert.match(comment, /发起人：张三/);
  assert.match(followup, /## Slack 追加修改/);
  assert.match(followup, /Agent mode: fix/);
  assert.match(followup, /Platform deployment: out of scope/);
});

test('builds workflow inputs from job fields', () => {
  assert.equal(allowedPathForJob(job), 'sites/zhangsan/profile');
  assert.equal(branchNameForJob(job), 'sites/job-job_123-zhangsan-profile');
  assert.deepEqual(buildProjectIndexInputs(job, { callbackUrl: 'https://gateway.test/callback' }), {
    publishingJobId: 'job_123',
    siteProjectId: 'site_1',
    allowedPath: 'sites/zhangsan/profile',
    baseRef: '',
    callbackUrl: 'https://gateway.test/callback',
    issueNumber: '7',
  });
  assert.deepEqual(buildPagesAgentInputs(job, { baseRef: 'staging' }), {
    publishingJobId: 'job_123',
    mode: 'initial',
    employeeSlug: 'zhangsan',
    siteSlug: 'profile',
    allowedPath: 'sites/zhangsan/profile',
    baseRef: 'staging',
    indexSnapshotId: 'idxsnap_1',
    issueNumber: '7',
    requestTitle: 'Profile page',
    requestSummary: 'Create a personal profile page.',
    callbackUrl: '',
    branchName: '',
  });
  assert.deepEqual(buildPagesPreviewInputs(job, { callbackUrl: 'https://gateway.test/callback' }), {
    publishingJobId: 'job_123',
    prNumber: '12',
    headSha: 'a'.repeat(40),
    siteProjectId: 'site_1',
    employeeSlug: 'zhangsan',
    siteSlug: 'profile',
    allowedPath: 'sites/zhangsan/profile',
    previewSiteName: '',
    previewHostname: '',
    callbackUrl: 'https://gateway.test/callback',
  });
  assert.deepEqual(
    buildPlatformAgentInputs(
      {
        ...platformItem,
        githubPrNumber: 45,
        headSha: 'b'.repeat(40),
        reviewContext: 'Review says fix docs.',
        memoryContext: 'Previous run summary.',
        statusContext: 'status: review_blocked',
        followupContext: 'Slack follow-up.',
      },
      { callbackUrl: 'https://gateway.test/callback', baseRef: 'master' }
    ),
    {
      platformDevItemId: 'pdev_123',
      mode: 'initial',
      issueNumber: '31',
      prNumber: '45',
      headSha: 'b'.repeat(40),
      requestTitle: '支持 Slack 创建平台开发 issue',
      requestSummary: '通过 Slack 创建 pages-manager 自身开发 issue，并跟踪 PR 进度。',
      issueType: 'type:dev',
      areas: 'area:gateway,area:github',
      risk: 'risk:medium',
      gateApproved: 'true',
      baseRef: 'master',
      branchName: '',
      callbackUrl: 'https://gateway.test/callback',
      reviewContext: 'Review says fix docs.',
      memoryContext: 'Previous run summary.',
      statusContext: 'status: review_blocked',
      followupContext: 'Slack follow-up.',
    }
  );
  assert.equal(
    buildPlatformAgentInputs(
      { ...platformItem, risk: 'risk:high', requiresHumanGate: true, gateStatus: 'pending' },
      { callbackUrl: 'https://gateway.test/callback', baseRef: 'master' }
    ).gateApproved,
    'false'
  );
  assert.equal(
    buildPlatformAgentInputs(
      { ...platformItem, risk: 'risk:high', requiresHumanGate: true, gateStatus: 'approved' },
      { callbackUrl: 'https://gateway.test/callback', baseRef: 'master' }
    ).gateApproved,
    'true'
  );
});

test('workflow inputs are truncated before dispatch', async () => {
  const longSummary = 'x'.repeat(70000);
  const inputs = buildPagesAgentInputs({ ...job, summary: longSummary });
  assert.equal(inputs.requestSummary.length, 60000);

  await dispatchWorkflow(
    async (_url, request) => {
      const body = JSON.parse(request.body);
      assert.equal(body.inputs.requestSummary.length, 60000);
      return new Response(null, { status: 204 });
    },
    {
      token: 'ghs_test',
      repoFullName: 'org/pages-manager',
    },
    {
      workflowId: 'pages-agent.yml',
      ref: 'master',
      inputs: { requestSummary: longSummary },
    }
  );
});

test('ensurePublishingIssue reuses existing issue by PublishingJob marker', async () => {
  const requests = [];
  const result = await ensurePublishingIssue(
    async (url, request) => {
      requests.push({ url: String(url), request });
      return new Response(
        JSON.stringify({
          items: [{ number: 3, body: `hello\n${publishingJobMarker('job_123')}` }],
        }),
        { status: 200 }
      );
    },
    {
      token: 'ghs_test',
      repoFullName: 'org/pages-manager',
    },
    job
  );

  assert.equal(result.created, false);
  assert.equal(result.issue.number, 3);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].request.method, 'GET');
});

test('ensurePublishingIssue creates issue when no marker exists', async () => {
  const requests = [];
  const result = await ensurePublishingIssue(
    async (url, request) => {
      requests.push({ url: String(url), request });
      if (request.method === 'GET') {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      assert.equal(request.method, 'POST');
      assert.match(JSON.parse(request.body).body, /PublishingJob: job_123/);
      return new Response(JSON.stringify({ number: 4, html_url: 'https://github.example/org/repo/issues/4' }), {
        status: 201,
      });
    },
    {
      token: 'ghs_test',
      repoFullName: 'org/pages-manager',
    },
    job
  );

  assert.equal(result.created, true);
  assert.equal(result.issue.number, 4);
  assert.equal(requests.length, 2);
});

test('ensurePlatformDevIssue creates issue by PlatformDev marker', async () => {
  const requests = [];
  const result = await ensurePlatformDevIssue(
    async (url, request) => {
      requests.push({ url: String(url), request });
      if (request.method === 'GET') {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }
      const body = JSON.parse(request.body);
      assert.match(body.body, /PlatformDevItem: pdev_123/);
      assert.deepEqual(body.labels, ['pages-platform-dev', 'type:dev', 'risk:medium', 'area:gateway', 'area:github']);
      return new Response(JSON.stringify({ number: 31, html_url: 'https://github.example/org/repo/issues/31' }), {
        status: 201,
      });
    },
    {
      token: 'ghs_test',
      repoFullName: 'org/pages-manager',
    },
    platformItem
  );

  assert.equal(result.created, true);
  assert.equal(result.issue.number, 31);
  assert.equal(requests.length, 2);
});

test('ensurePublishingIssue retries without labels when label permission fails', async () => {
  const requests = [];
  const result = await ensurePublishingIssue(
    async (url, request) => {
      requests.push({ url: String(url), request });
      if (request.method === 'GET') {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }

      const body = JSON.parse(request.body);
      if (body.labels?.length) {
        return new Response(JSON.stringify({ message: 'You do not have permission to create labels on this repository.' }), {
          status: 403,
        });
      }

      assert.deepEqual(body.labels, []);
      return new Response(JSON.stringify({ number: 5, html_url: 'https://github.example/org/repo/issues/5' }), {
        status: 201,
      });
    },
    {
      token: 'ghs_test',
      repoFullName: 'org/pages-manager',
    },
    job
  );

  assert.equal(result.created, true);
  assert.equal(result.issue.number, 5);
  assert.equal(requests.length, 3);
});

test('ensureSmokeIssue reuses one issue and appends a comment', async () => {
  const requests = [];
  const result = await ensureSmokeIssue(
    async (url, request) => {
      requests.push({ url: String(url), request });
      if (String(url).includes('/search/issues')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                number: 8,
                body: `hello\n${smokeIssueMarker('slack-local')}`,
                html_url: 'https://github.example/issues/8',
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (String(url).endsWith('/issues/8/comments')) {
        assert.equal(request.method, 'POST');
        assert.match(JSON.parse(request.body).body, /PublishingJob: job_123/);
        return new Response(JSON.stringify({ id: 99, html_url: 'https://github.example/issues/8#issuecomment-99' }), {
          status: 201,
        });
      }

      throw new Error(`Unexpected request ${request.method} ${url}`);
    },
    {
      token: 'ghs_test',
      repoFullName: 'org/pages-manager',
    },
    job,
    { scope: 'slack-local' }
  );

  assert.equal(result.created, false);
  assert.equal(result.issue.number, 8);
  assert.equal(result.comment.id, 99);
  assert.equal(requests.length, 2);
});

test('ensureSmokeIssue ignores closed smoke issues and creates a new one', async () => {
  const requests = [];
  const result = await ensureSmokeIssue(
    async (url, request) => {
      requests.push({ url: String(url), request });
      if (String(url).includes('/search/issues')) {
        assert.match(decodeURIComponent(String(url)), /state:open/);
        return new Response(
          JSON.stringify({
            items: [
              {
                number: 8,
                state: 'closed',
                body: `hello\n${smokeIssueMarker('slack-local')}`,
                html_url: 'https://github.example/issues/8',
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (String(url).endsWith('/repos/org/pages-manager/issues')) {
        assert.equal(request.method, 'POST');
        const body = JSON.parse(request.body);
        assert.match(body.body, /PagesSmokeIssue: slack-local/);
        return new Response(JSON.stringify({ number: 9, html_url: 'https://github.example/issues/9' }), {
          status: 201,
        });
      }

      throw new Error(`Unexpected request ${request.method} ${url}`);
    },
    {
      token: 'ghs_test',
      repoFullName: 'org/pages-manager',
    },
    job,
    { scope: 'slack-local' }
  );

  assert.equal(result.created, true);
  assert.equal(result.issue.number, 9);
  assert.equal(result.comment, null);
  assert.equal(requests.length, 2);
});

test('appendFollowupIssueComment posts to the existing publishing issue', async () => {
  const requests = [];
  const result = await appendFollowupIssueComment(
    async (url, request) => {
      requests.push({ url: String(url), request });
      assert.equal(String(url), 'https://api.github.com/repos/org/pages-manager/issues/7/comments');
      assert.equal(request.method, 'POST');
      const body = JSON.parse(request.body).body;
      assert.match(body, /PublishingJob: job_123/);
      assert.match(body, /## Slack 追加修改/);
      return new Response(JSON.stringify({ id: 100, html_url: 'https://github.example/issues/7#issuecomment-100' }), {
        status: 201,
      });
    },
    {
      token: 'ghs_test',
      repoFullName: 'org/pages-manager',
    },
    job
  );

  assert.equal(result.id, 100);
  assert.equal(requests.length, 1);
});

test('dispatchWorkflow posts workflow_dispatch payload', async () => {
  const result = await dispatchWorkflow(
    async (url, request) => {
      assert.equal(String(url), 'https://api.github.com/repos/org/pages-manager/actions/workflows/project-index.yml/dispatches');
      assert.equal(request.method, 'POST');
      assert.deepEqual(JSON.parse(request.body), {
        ref: 'master',
        inputs: { publishingJobId: 'job_123' },
      });
      return new Response(null, { status: 204 });
    },
    {
      token: 'ghs_test',
      repoFullName: 'org/pages-manager',
    },
    {
      workflowId: 'project-index.yml',
      ref: 'master',
      inputs: { publishingJobId: 'job_123' },
    }
  );

  assert.deepEqual(result, { workflowId: 'project-index.yml', ref: 'master', dispatched: true });
});
