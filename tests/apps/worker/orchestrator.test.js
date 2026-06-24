import assert from 'node:assert/strict';
import test from 'node:test';

import { readWorkerConfig } from '../../../apps/worker/src/config.js';
import { createWorkerApp } from '../../../apps/worker/src/index.js';
import { runWorkerForJob, runWorkerForWorkItem } from '../../../apps/worker/src/orchestrator.js';

const baseJob = {
  id: 'job_123',
  source: 'slack',
  requestedByType: 'user',
  requestedById: 'slack:T1:U1',
  employeeSlug: 'zhangsan',
  siteSlug: 'profile',
  siteProjectId: 'site_1',
  approvalMode: 'manual_required',
  status: 'received',
  title: 'Profile page',
  summary: 'Create a personal profile page.',
};

const platformItem = {
  id: 'pdev_123',
  source: 'slack',
  requestedByType: 'user',
  requestedById: 'slack:T1:U1',
  status: 'received',
  title: '支持 Slack 创建平台开发 issue',
  summary: '通过 Slack 创建 pages-manager 自身开发 issue，并跟踪 PR 进度。',
  issueType: 'type:dev',
  areas: ['area:gateway', 'area:github'],
  risk: 'risk:medium',
  agentEligible: true,
  requiresHumanGate: false,
};

function config() {
  return {
    executorMode: 'actions',
    workflowRef: 'staging',
    platformWorkflowRef: 'master',
    baseRef: 'staging',
    platformBaseRef: 'master',
    previewHostnamePattern: 'pr-{prNumber}-{employeeSlug}-{siteSlug}-staging.workers.xd.team',
    callbackUrl: 'http://gateway.test/internal/executor-callback',
    callbackToken: 'callback-secret',
    workerSharedSecret: 'worker-secret',
    github: {
      token: 'ghs_test',
      repoFullName: 'org/pages-manager',
    },
  };
}

test('worker config defaults generated work to staging base ref', () => {
  const workerConfig = readWorkerConfig({
    GITHUB_APP_INSTALLATION_TOKEN: 'ghs_test',
    GITHUB_REPO: 'org/pages-manager',
  });

  assert.equal(workerConfig.workflowRef, 'master');
  assert.equal(workerConfig.platformWorkflowRef, 'master');
  assert.equal(workerConfig.baseRef, 'staging');
  assert.equal(workerConfig.platformBaseRef, 'master');
  assert.equal(workerConfig.prMode, 'per_job');
  assert.equal(workerConfig.previewMode, 'actions');
  assert.equal(workerConfig.previewSiteNamePattern, 'pm-pr-{prNumber}-{employeeSlug}-{siteSlug}');
  assert.equal(workerConfig.previewTokenPattern, '');
  assert.equal(workerConfig.previewIpRestrict, true);
  assert.equal(workerConfig.callbackUrl, 'http://localhost:8788/internal/executor-callback');
  assert.equal(workerConfig.workerCallbackUrl, 'http://localhost:8788/internal/executor-callback');
});

test('worker config keeps platform workflow ref separate from site workflow ref', () => {
  const workerConfig = readWorkerConfig({
    GITHUB_APP_INSTALLATION_TOKEN: 'ghs_test',
    GITHUB_REPO: 'org/pages-manager',
    PAGES_WORKFLOW_REF: 'staging',
    PAGES_PLATFORM_WORKFLOW_REF: 'master',
    PAGES_BASE_REF: 'staging',
    PAGES_PLATFORM_BASE_REF: 'master',
  });

  assert.equal(workerConfig.workflowRef, 'staging');
  assert.equal(workerConfig.platformWorkflowRef, 'master');
  assert.equal(workerConfig.baseRef, 'staging');
  assert.equal(workerConfig.platformBaseRef, 'master');
});

test('worker config can pin platform workflow and base refs to the same test branch', () => {
  const workerConfig = readWorkerConfig({
    GITHUB_APP_INSTALLATION_TOKEN: 'ghs_test',
    GITHUB_REPO: 'org/pages-manager',
    PAGES_WORKFLOW_REF: 'staging',
    PAGES_BASE_REF: 'staging',
    PAGES_PLATFORM_WORKFLOW_REF: 'feat/slack-preview-gateway',
    PAGES_PLATFORM_BASE_REF: 'feat/slack-preview-gateway',
  });

  assert.equal(workerConfig.workflowRef, 'staging');
  assert.equal(workerConfig.baseRef, 'staging');
  assert.equal(workerConfig.platformWorkflowRef, 'feat/slack-preview-gateway');
  assert.equal(workerConfig.platformBaseRef, 'feat/slack-preview-gateway');
});

test('worker config falls back platform base ref to platform workflow ref when omitted', () => {
  const workerConfig = readWorkerConfig({
    GITHUB_APP_INSTALLATION_TOKEN: 'ghs_test',
    GITHUB_REPO: 'org/pages-manager',
    GITHUB_REF_NAME: 'feat/slack-preview-gateway',
    PAGES_PLATFORM_WORKFLOW_REF: 'feat/slack-preview-gateway',
  });

  assert.equal(workerConfig.platformWorkflowRef, 'feat/slack-preview-gateway');
  assert.equal(workerConfig.platformBaseRef, 'feat/slack-preview-gateway');
});

test('platform dev item creates issue and dispatches platform-agent workflow', async () => {
  const requests = [];
  const callbacks = [];
  const result = await runWorkerForWorkItem(
    { workItemKind: 'platform_dev', platformDevItem: platformItem },
    config(),
    {
      async fetchImpl(url, request) {
        requests.push({ url: String(url), request });
        if (String(url).includes('/search/issues')) {
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        if (String(url).endsWith('/repos/org/pages-manager/issues')) {
          const body = JSON.parse(request.body).body;
          assert.match(body, /PlatformDevItem: pdev_123/);
          assert.match(body, /Lane: platform-dev/);
          return new Response(JSON.stringify({ number: 31, html_url: 'https://github.example/issues/31' }), {
            status: 201,
          });
        }
        if (String(url).endsWith('/actions/workflows/platform-agent.yml/dispatches')) {
          const body = JSON.parse(request.body);
          assert.equal(body.ref, 'master');
          assert.equal(body.inputs.platformDevItemId, 'pdev_123');
          assert.equal(body.inputs.issueNumber, '31');
          assert.equal(body.inputs.issueType, 'type:dev');
          assert.equal(body.inputs.gateApproved, 'true');
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request ${request.method} ${url}`);
      },
      async postExecutorCallback(fetchImpl, cfg, payload) {
        callbacks.push(payload);
        return { ok: true };
      },
    }
  );

  assert.equal(result.action, 'platform_issue_created_and_agent_dispatched');
  assert.equal(result.issueNumber, 31);
  assert.equal(result.workflow.workflowId, 'platform-agent.yml');
  assert.deepEqual(
    callbacks.map((payload) => payload.stageResult),
    ['issue_created', 'agent_running']
  );
  assert.equal(requests.length, 3);
});

test('platform dev high risk item creates issue and waits for gate', async () => {
  const callbacks = [];
  const result = await runWorkerForWorkItem(
    {
      workItemKind: 'platform_dev',
      platformDevItem: {
        ...platformItem,
        issueType: 'type:ci',
        risk: 'risk:high',
        requiresHumanGate: true,
      },
    },
    config(),
    {
      async fetchImpl(url, request) {
        if (String(url).includes('/search/issues')) {
          return new Response(JSON.stringify({ items: [] }), { status: 200 });
        }
        if (String(url).endsWith('/repos/org/pages-manager/issues')) {
          return new Response(JSON.stringify({ number: 32, html_url: 'https://github.example/issues/32' }), {
            status: 201,
          });
        }
        throw new Error(`Unexpected request ${request.method} ${url}`);
      },
      async postExecutorCallback(fetchImpl, cfg, payload) {
        callbacks.push(payload);
        return { ok: true };
      },
    }
  );

  assert.equal(result.action, 'platform_issue_created_waiting_for_gate');
  assert.deepEqual(
    callbacks.map((payload) => payload.stageResult),
    ['gate_pending']
  );
});

test('platform dev high risk item dispatches platform-agent workflow after gate approval', async () => {
  const callbacks = [];
  const result = await runWorkerForWorkItem(
    {
      workItemKind: 'platform_dev',
      platformDevItem: {
        ...platformItem,
        issueType: 'type:ci',
        risk: 'risk:high',
        requiresHumanGate: true,
        gateStatus: 'approved',
        status: 'agent_queued',
        githubIssueNumber: 32,
        githubIssueUrl: 'https://github.example/issues/32',
      },
    },
    config(),
    {
      async fetchImpl(url, request) {
        if (String(url).includes('/search/issues')) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  number: 32,
                  html_url: 'https://github.example/issues/32',
                  body: 'PlatformDevItem: pdev_123',
                },
              ],
            }),
            { status: 200 }
          );
        }
        if (String(url).endsWith('/actions/workflows/platform-agent.yml/dispatches')) {
          const body = JSON.parse(request.body);
          assert.equal(body.inputs.risk, 'risk:high');
          assert.equal(body.inputs.gateApproved, 'true');
          assert.equal(body.inputs.issueNumber, '32');
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request ${request.method} ${url}`);
      },
      async postExecutorCallback(fetchImpl, cfg, payload) {
        callbacks.push(payload);
        return { ok: true };
      },
    }
  );

  assert.equal(result.action, 'platform_issue_created_and_agent_dispatched');
  assert.deepEqual(
    callbacks.map((payload) => payload.stageResult),
    ['agent_queued', 'agent_running']
  );
});

test('platform dev fix item dispatches platform-agent fix workflow without duplicating follow-up issue comment', async () => {
  const callbacks = [];
  const result = await runWorkerForWorkItem(
    {
      workItemKind: 'platform_dev',
      platformDevItem: {
        ...platformItem,
        status: 'agent_queued',
        githubIssueNumber: 32,
        githubIssueUrl: 'https://github.example/issues/32',
        githubPrNumber: 45,
        githubPrUrl: 'https://github.example/pulls/45',
        headSha: 'b'.repeat(40),
        branchName: 'platform/item-pdev-123',
        reviewContext: 'Review context for PR #45:\n1. [blocking] README 缺说明',
        memoryContext: 'Session summary: 用户希望自动修复 Review 意见。',
        statusContext: 'status: review_blocked',
        summary: '初始需求\n\n## Slack Follow-up\n\n继续收紧文案。',
      },
    },
    config(),
    {
      async fetchImpl(url, request) {
        if (String(url).includes('/search/issues')) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  number: 32,
                  html_url: 'https://github.example/issues/32',
                  body: 'PlatformDevItem: pdev_123',
                },
              ],
            }),
            { status: 200 }
          );
        }
        assert.doesNotMatch(String(url), /\/repos\/org\/pages-manager\/issues\/32\/comments$/);
        if (String(url).endsWith('/actions/workflows/platform-agent.yml/dispatches')) {
          const body = JSON.parse(request.body);
          assert.equal(body.inputs.mode, 'fix');
          assert.equal(body.inputs.branchName, 'platform/item-pdev-123');
          assert.equal(body.inputs.issueNumber, '32');
          assert.equal(body.inputs.prNumber, '45');
          assert.equal(body.inputs.headSha, 'b'.repeat(40));
          assert.match(body.inputs.reviewContext, /README 缺说明/);
          assert.match(body.inputs.memoryContext, /自动修复 Review/);
          assert.match(body.inputs.statusContext, /review_blocked/);
          assert.match(body.inputs.followupContext, /继续收紧文案/);
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request ${request.method} ${url}`);
      },
      async postExecutorCallback(fetchImpl, cfg, payload) {
        callbacks.push(payload);
        return { ok: true };
      },
    }
  );

  assert.equal(result.action, 'platform_agent_fix_dispatched');
  assert.equal(result.issueComment, undefined);
  assert.deepEqual(
    callbacks.map((payload) => payload.stageResult),
    ['agent_queued', 'agent_running']
  );
});

test('worker config honors preview deploy IP restriction env override', () => {
  const workerConfig = readWorkerConfig({
    GITHUB_APP_INSTALLATION_TOKEN: 'ghs_test',
    GITHUB_REPO: 'org/pages-manager',
    PAGES_PREVIEW_IP_RESTRICT: 'false',
  });

  assert.equal(workerConfig.previewIpRestrict, false);
});

test('worker config can enable smoke PR reuse', () => {
  const workerConfig = readWorkerConfig({
    GITHUB_APP_INSTALLATION_TOKEN: 'ghs_test',
    GITHUB_REPO: 'org/pages-manager',
    PAGES_PR_MODE: 'smoke_single',
    PAGES_SMOKE_PR_BRANCH: 'sites/smoke-local-slack-smoke-profile',
  });

  assert.equal(workerConfig.prMode, 'smoke_single');
  assert.equal(workerConfig.smokePrBranch, 'sites/smoke-local-slack-smoke-profile');
});

test('worker app enforces worker shared secret', async () => {
  const app = createWorkerApp({ config: config() });
  const response = await app.fetch(
    new Request('http://worker.test/internal/publishing-jobs/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Pages-Worker-Token': 'wrong' },
      body: JSON.stringify({ job: baseJob }),
    })
  );

  assert.equal(response.status, 401);
});

test('worker app fails closed when worker shared secret is missing', async () => {
  const app = createWorkerApp({ config: { ...config(), workerSharedSecret: '' } });
  const response = await app.fetch(
    new Request('http://worker.test/internal/publishing-jobs/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job: baseJob }),
    })
  );
  const body = await response.json();

  assert.equal(response.status, 500);
  assert.equal(body.error, 'Worker shared secret is not configured');
});

test('issue_only mode creates issue and skips workflow dispatch', async () => {
  const requests = [];
  const result = await runWorkerForJob(baseJob, { ...config(), executorMode: 'issue_only' }, {
    async fetchImpl(url, request) {
      requests.push({ url: String(url), request });

      if (String(url).includes('/search/issues')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }

      if (String(url).endsWith('/repos/org/pages-manager/issues')) {
        const body = JSON.parse(request.body).body;
        assert.match(body, /PublishingJob: job_123/);
        assert.match(body, /Base ref: staging/);
        return new Response(JSON.stringify({ number: 10, html_url: 'https://github.example/issues/10' }), {
          status: 201,
        });
      }

      if (String(url) === 'http://gateway.test/internal/executor-callback') {
        return new Response(JSON.stringify({ job: { ...baseJob, issueNumber: 10 } }), { status: 200 });
      }

      throw new Error(`Unexpected request ${request.method} ${url}`);
    },
  });

  assert.deepEqual(result, {
    action: 'issue_created',
    issueNumber: 10,
    issueUrl: 'https://github.example/issues/10',
    issueCreated: true,
  });
  assert.equal(requests.length, 3);
});

test('github_issue_webhook mode creates issue and waits for GitHub issues webhook', async () => {
  const requests = [];
  const result = await runWorkerForJob(baseJob, { ...config(), executorMode: 'github_issue_webhook' }, {
    async fetchImpl(url, request) {
      requests.push({ url: String(url), request });

      if (String(url).includes('/search/issues')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }

      if (String(url).endsWith('/repos/org/pages-manager/issues')) {
        return new Response(JSON.stringify({ number: 11, html_url: 'https://github.example/issues/11' }), {
          status: 201,
        });
      }

      if (String(url) === 'http://gateway.test/internal/executor-callback') {
        return new Response(JSON.stringify({ job: { ...baseJob, issueNumber: 11 } }), { status: 200 });
      }

      throw new Error(`Unexpected request ${request.method} ${url}`);
    },
  });

  assert.deepEqual(result, {
    action: 'issue_created_waiting_for_github_issue_webhook',
    issueNumber: 11,
    issueUrl: 'https://github.example/issues/11',
    issueCreated: true,
  });
  assert.equal(requests.length, 3);
  assert.equal(requests.some((request) => request.url.includes('/actions/workflows/')), false);
});

test('github_issue_webhook mode dispatches project index when reusing an existing issue', async () => {
  const requests = [];
  const result = await runWorkerForJob(baseJob, { ...config(), executorMode: 'github_issue_webhook' }, {
    async fetchImpl(url, request) {
      requests.push({ url: String(url), request });

      if (String(url).includes('/search/issues')) {
        return new Response(
          JSON.stringify({
            items: [
              {
                number: 11,
                body: 'PublishingJob: job_123',
                html_url: 'https://github.example/issues/11',
              },
            ],
          }),
          { status: 200 }
        );
      }

      if (String(url) === 'http://gateway.test/internal/executor-callback') {
        return new Response(JSON.stringify({ job: { ...baseJob, issueNumber: 11 } }), { status: 200 });
      }

      if (String(url).endsWith('/actions/workflows/project-index.yml/dispatches')) {
        const body = JSON.parse(request.body);
        assert.equal(body.inputs.issueNumber, '11');
        return new Response(null, { status: 204 });
      }

      throw new Error(`Unexpected request ${request.method} ${url}`);
    },
  });

  assert.equal(result.action, 'issue_created_and_project_index_dispatched');
  assert.equal(result.issueCreated, false);
  assert.equal(requests.some((request) => request.url.includes('/actions/workflows/project-index.yml/dispatches')), true);
});

test('smoke_single issue mode reuses a smoke issue and still callbacks gateway', async () => {
  const requests = [];
  const result = await runWorkerForJob(
    baseJob,
    { ...config(), executorMode: 'issue_only', issueMode: 'smoke_single', smokeIssueScope: 'slack-local' },
    {
      async fetchImpl(url, request) {
        requests.push({ url: String(url), request });

        if (String(url).includes('/search/issues')) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  number: 12,
                  body: 'PagesSmokeIssue: slack-local',
                  html_url: 'https://github.example/issues/12',
                },
              ],
            }),
            { status: 200 }
          );
        }

        if (String(url).endsWith('/issues/12/comments')) {
          return new Response(JSON.stringify({ id: 77 }), { status: 201 });
        }

        if (String(url) === 'http://gateway.test/internal/executor-callback') {
          return new Response(JSON.stringify({ job: { ...baseJob, issueNumber: 12 } }), { status: 200 });
        }

        throw new Error(`Unexpected request ${request.method} ${url}`);
      },
    }
  );

  assert.deepEqual(result, {
    action: 'issue_created',
    issueNumber: 12,
    issueUrl: 'https://github.example/issues/12',
    issueCreated: false,
  });
  assert.equal(requests.length, 3);
});

test('received job creates or reuses issue then dispatches project index workflow', async () => {
  const requests = [];
  const result = await runWorkerForJob(baseJob, config(), {
    async fetchImpl(url, request) {
      requests.push({ url: String(url), request });

      if (String(url).includes('/search/issues')) {
        return new Response(JSON.stringify({ items: [] }), { status: 200 });
      }

      if (String(url).endsWith('/repos/org/pages-manager/issues')) {
        assert.equal(request.method, 'POST');
        const issueBody = JSON.parse(request.body).body;
        assert.match(issueBody, /Base ref: staging/);
        return new Response(JSON.stringify({ number: 9, html_url: 'https://github.example/issues/9' }), {
          status: 201,
        });
      }

      if (String(url) === 'http://gateway.test/internal/executor-callback') {
        assert.equal(request.headers['X-Pages-Callback-Token'], 'callback-secret');
        assert.deepEqual(JSON.parse(request.body), {
          publishingJobId: 'job_123',
          executorType: 'pages_worker',
          status: 'succeeded',
          stageResult: 'issue_created',
          issueNumber: 9,
          issueUrl: 'https://github.example/issues/9',
        });
        return new Response(JSON.stringify({ job: { ...baseJob, issueNumber: 9 } }), { status: 200 });
      }

      if (String(url).endsWith('/actions/workflows/project-index.yml/dispatches')) {
        const body = JSON.parse(request.body);
        assert.equal(body.ref, 'staging');
        assert.equal(body.inputs.publishingJobId, 'job_123');
        assert.equal(body.inputs.allowedPath, 'sites/zhangsan/profile');
        assert.equal(body.inputs.baseRef, 'staging');
        assert.equal(body.inputs.issueNumber, '9');
        return new Response(null, { status: 204 });
      }

      throw new Error(`Unexpected request ${request.method} ${url}`);
    },
  });

  assert.equal(result.action, 'issue_created_and_project_index_dispatched');
  assert.equal(result.issueNumber, 9);
  assert.equal(result.issueCreated, true);
  assert.equal(requests.length, 4);
});

test('generating_page job dispatches pages-agent workflow', async () => {
  const result = await runWorkerForJob(
    {
      ...baseJob,
      status: 'generating_page',
      issueNumber: 9,
      indexSnapshotId: 'idxsnap_123',
    },
    config(),
    {
      async fetchImpl(url, request) {
        assert.equal(
          String(url),
          'https://api.github.com/repos/org/pages-manager/actions/workflows/pages-agent.yml/dispatches'
        );
        assert.equal(request.method, 'POST');
        assert.deepEqual(JSON.parse(request.body), {
          ref: 'staging',
          inputs: {
            publishingJobId: 'job_123',
            mode: 'initial',
            employeeSlug: 'zhangsan',
            siteSlug: 'profile',
            allowedPath: 'sites/zhangsan/profile',
            baseRef: 'staging',
            indexSnapshotId: 'idxsnap_123',
            issueNumber: '9',
            requestTitle: 'Profile page',
            requestSummary: 'Create a personal profile page.',
            callbackUrl: 'http://gateway.test/internal/executor-callback',
            branchName: '',
          },
        });
        return new Response(null, { status: 204 });
      },
    }
  );

  assert.equal(result.action, 'pages_agent_dispatched');
});

test('generating_page smoke_single PR mode dispatches pages-agent with reusable branch', async () => {
  const result = await runWorkerForJob(
    {
      ...baseJob,
      status: 'generating_page',
      issueNumber: 9,
      indexSnapshotId: 'idxsnap_123',
    },
    { ...config(), prMode: 'smoke_single', smokeIssueScope: 'slack-local' },
    {
      async fetchImpl(url, request) {
        assert.equal(
          String(url),
          'https://api.github.com/repos/org/pages-manager/actions/workflows/pages-agent.yml/dispatches'
        );
        assert.deepEqual(JSON.parse(request.body).inputs.branchName, 'sites/smoke-slack-local-zhangsan-profile');
        return new Response(null, { status: 204 });
      },
    }
  );

  assert.equal(result.action, 'pages_agent_dispatched');
});

test('fixing job appends issue comment and dispatches pages-agent fix mode on the same branch', async () => {
  const requests = [];
  const result = await runWorkerForJob(
    {
      ...baseJob,
      status: 'fixing',
      issueNumber: 9,
      branchName: 'sites/job-job_123-zhangsan-profile',
      prNumber: 12,
      summary: 'Original request.\n\n## Slack Follow-up\n\n把标题改成中文。',
    },
    config(),
    {
      async fetchImpl(url, request) {
        requests.push({ url: String(url), request });

        if (String(url).endsWith('/issues/9/comments')) {
          const body = JSON.parse(request.body).body;
          assert.match(body, /## Slack Follow-up/);
          assert.match(body, /把标题改成中文/);
          return new Response(JSON.stringify({ id: 501 }), { status: 201 });
        }

        if (String(url).endsWith('/actions/workflows/pages-agent.yml/dispatches')) {
          assert.deepEqual(JSON.parse(request.body), {
            ref: 'staging',
            inputs: {
              publishingJobId: 'job_123',
              mode: 'fix',
              employeeSlug: 'zhangsan',
              siteSlug: 'profile',
              allowedPath: 'sites/zhangsan/profile',
              baseRef: 'staging',
              indexSnapshotId: '',
              issueNumber: '9',
              requestTitle: 'Profile page',
              requestSummary: 'Original request.\n\n## Slack Follow-up\n\n把标题改成中文。',
              callbackUrl: 'http://gateway.test/internal/executor-callback',
              branchName: 'sites/job-job_123-zhangsan-profile',
            },
          });
          return new Response(null, { status: 204 });
        }

        throw new Error(`Unexpected request ${request.method} ${url}`);
      },
    }
  );

  assert.equal(result.action, 'pages_agent_fix_dispatched');
  assert.equal(result.issueComment.id, 501);
  assert.equal(requests.length, 2);
});

test('previewing job dispatches pages-preview workflow', async () => {
  const result = await runWorkerForJob(
    {
      ...baseJob,
      status: 'previewing',
      prNumber: 12,
      headSha: 'a'.repeat(40),
    },
    config(),
    {
      async fetchImpl(url, request) {
        assert.equal(
          String(url),
          'https://api.github.com/repos/org/pages-manager/actions/workflows/pages-preview.yml/dispatches'
        );
        assert.equal(request.method, 'POST');
        assert.deepEqual(JSON.parse(request.body), {
          ref: 'staging',
          inputs: {
            publishingJobId: 'job_123',
            prNumber: '12',
            headSha: 'a'.repeat(40),
            siteProjectId: 'site_1',
            employeeSlug: 'zhangsan',
            siteSlug: 'profile',
            allowedPath: 'sites/zhangsan/profile',
            previewSiteName: 'pm-pr-12-zhangsan-profile',
            previewHostname: 'pr-12-zhangsan-profile-staging.workers.xd.team',
            callbackUrl: 'http://gateway.test/internal/executor-callback',
          },
        });
        return new Response(null, { status: 204 });
      },
    }
  );

  assert.equal(result.action, 'pages_preview_dispatched');
});

test('previewing job can deploy through local pages-manager API', async () => {
  const headSha = 'b'.repeat(40);
  const requests = [];
  const result = await runWorkerForJob(
    {
      ...baseJob,
      status: 'previewing',
      prNumber: 19,
      headSha,
    },
    {
      ...config(),
      previewMode: 'local_deploy',
      pagesApi: 'https://api-staging.workers.xd.team',
      previewTokenPattern: 'pages_{employeeSlug}@xd.com',
      previewIpRestrict: true,
      callbackUrl: 'https://gateway.example/internal/executor-callback',
      workerCallbackUrl: 'http://pages-gateway:8788/internal/executor-callback',
    },
    {
      async fetchImpl(url, request = {}) {
        requests.push({ url: String(url), request });

        if (String(url).includes(`/git/trees/${headSha}`)) {
          return new Response(
            JSON.stringify({
              tree: [
                { type: 'blob', path: 'sites/zhangsan/profile/src/index.html', sha: 'blob_html' },
                { type: 'blob', path: 'sites/zhangsan/profile/site.json', sha: 'blob_site_json' },
              ],
            }),
            { status: 200 }
          );
        }

        if (String(url).endsWith('/git/blobs/blob_html')) {
          return new Response(
            JSON.stringify({ encoding: 'base64', content: Buffer.from('<h1>hello</h1>').toString('base64') }),
            { status: 200 }
          );
        }

        if (String(url) === 'https://api-staging.workers.xd.team/deploy') {
          assert.equal(request.method, 'POST');
          assert.equal(request.headers['X-Pages-Token'], 'pages_zhangsan@xd.com');
          assert.equal(request.body.get('name'), 'pm-pr-19-zhangsan-profile');
          assert.equal(request.body.get('preset'), 'static');
          assert.equal(request.body.get('ip_restrict'), 'true');
          assert.equal(request.body.get('file-0').name, 'index.html');
          return new Response(
            JSON.stringify({
              status: 'ok',
              name: 'pm-pr-19-zhangsan-profile',
              url: 'https://pm-pr-19-zhangsan-profile.staging.workers.xd.team',
              preset: 'static',
              fileCount: 1,
            }),
            { status: 200 }
          );
        }

        if (String(url) === 'http://pages-gateway:8788/internal/executor-callback') {
          const body = JSON.parse(request.body);
          assert.equal(body.stageResult, 'preview_deployed');
          assert.equal(body.previewUrl, 'https://pm-pr-19-zhangsan-profile.staging.workers.xd.team');
          assert.equal(body.headSha, headSha);
          return new Response(JSON.stringify({ ok: true, job: { ...baseJob, status: 'preview_deployed' } }), {
            status: 200,
          });
        }

        throw new Error(`Unexpected request ${request.method || 'GET'} ${url}`);
      },
    }
  );

  assert.equal(result.action, 'pages_preview_deployed');
  assert.equal(result.previewUrl, 'https://pm-pr-19-zhangsan-profile.staging.workers.xd.team');
  assert.equal(requests.length, 4);
});

test('previewing job local deploy refuses to upload the whole allowedPath when src is missing', async () => {
  const headSha = 'c'.repeat(40);
  const requests = [];
  await assert.rejects(
    runWorkerForJob(
      {
        ...baseJob,
        status: 'previewing',
        prNumber: 20,
        headSha,
      },
      {
        ...config(),
        previewMode: 'local_deploy',
        pagesApi: 'https://api-staging.workers.xd.team',
        pagesToken: 'pages-preview@xd.com',
      },
      {
        async fetchImpl(url, request = {}) {
          requests.push({ url: String(url), request });

          if (String(url).includes(`/git/trees/${headSha}`)) {
            return new Response(
              JSON.stringify({
                tree: [{ type: 'blob', path: 'sites/zhangsan/profile/index.html', sha: 'blob_root_html' }],
              }),
              { status: 200 }
            );
          }

          throw new Error(`Unexpected request ${request.method || 'GET'} ${url}`);
        },
      }
    ),
    /No preview files found under sites\/zhangsan\/profile\/src\//
  );

  assert.equal(requests.length, 1);
});
