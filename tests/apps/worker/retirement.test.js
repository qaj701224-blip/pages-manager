import assert from 'node:assert/strict';
import test from 'node:test';

import { createWorkerApp } from '../../../apps/worker/src/index.js';

const config = {
  executorMode: 'actions',
  workflowRef: 'staging',
  platformWorkflowRef: 'master',
  baseRef: 'staging',
  platformBaseRef: 'master',
  callbackUrl: 'http://gateway.test/internal/executor-callback',
  callbackToken: 'callback-secret',
  workerSharedSecret: 'worker-secret',
  github: {
    token: 'test-token',
    repoFullName: 'org/pages-manager',
  },
};

function authorizedRequest(body) {
  return new Request('http://worker.test/internal/publishing-jobs/start', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Pages-Worker-Token': 'worker-secret',
    },
    body: JSON.stringify(body),
  });
}

test('worker rejects direct Site Publishing starts with the retirement protocol', async () => {
  const fetchCalls = [];
  const app = createWorkerApp({
    config,
    adapters: {
      async fetchImpl(url, request) {
        fetchCalls.push({ url: String(url), request });
        return new Response(null, { status: 204 });
      },
    },
  });

  const response = await app.fetch(
    authorizedRequest({
      job: {
        id: 'job_retired',
        source: 'api',
        requestedById: 'usr_retired',
        employeeSlug: 'alice',
        siteSlug: 'profile',
        status: 'previewing',
      },
    })
  );

  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), {
    error: 'PUBLISHING_LANE_RETIRED',
    message: '站点自动发布能力已停止服务，新的发布任务不会再创建或继续执行。',
  });
  assert.equal(fetchCalls.length, 0);
});

test('worker retirement keeps Platform Dev starts active', async () => {
  const fetchCalls = [];
  const callbacks = [];
  const app = createWorkerApp({
    config,
    adapters: {
      async fetchImpl(url, request) {
        fetchCalls.push({ url: String(url), request });
        if (String(url).includes('/search/issues')) {
          return new Response(
            JSON.stringify({
              items: [
                {
                  number: 32,
                  html_url: 'https://github.example/org/pages-manager/issues/32',
                  body: 'PlatformDevItem: pdev_retirement',
                },
              ],
            })
          );
        }
        if (String(url).endsWith('/actions/workflows/platform-agent.yml/dispatches')) {
          return new Response(null, { status: 204 });
        }
        throw new Error(`Unexpected request ${request.method} ${url}`);
      },
      async postExecutorCallback(_fetchImpl, _config, payload) {
        callbacks.push(payload);
        return { ok: true };
      },
    },
  });

  const response = await app.fetch(
    authorizedRequest({
      workItemKind: 'platform_dev',
      platformDevItem: {
        id: 'pdev_retirement',
        source: 'api',
        requestedById: 'usr_platform',
        status: 'agent_queued',
        title: 'Keep Platform Dev active',
        summary: 'Platform Dev remains available.',
        issueType: 'type:dev',
        areas: ['area:gateway'],
        risk: 'risk:medium',
        agentEligible: true,
        autoDevStatus: 'triggered',
        githubIssueNumber: 32,
        githubIssueUrl: 'https://github.example/org/pages-manager/issues/32',
      },
    })
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.result.action, 'platform_issue_created_and_agent_dispatched');
  assert.equal(
    fetchCalls.some((call) => call.url.endsWith('/actions/workflows/platform-agent.yml/dispatches')),
    true
  );
  assert.deepEqual(
    callbacks.map((payload) => payload.stageResult),
    ['agent_queued', 'agent_running']
  );
});
