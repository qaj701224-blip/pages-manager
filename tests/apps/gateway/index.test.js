import assert from 'node:assert/strict';
import test from 'node:test';

import { createGatewayApp } from '../../../apps/gateway/src/index.js';

async function json(response) {
  return response.json();
}

async function githubSignature(secret, body) {
  const key = await crypto.subtle.importKey(
    'raw',
    new globalThis.TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new globalThis.TextEncoder().encode(body));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

async function moveJobToPrCreated(app, options = {}) {
  const createBody = await json(
    await app.fetch(
      new Request('http://gateway.test/api/publishing-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': options.idempotencyKey || `api-pr-${options.prNumber || 12}`,
          'X-Pages-Actor-Id': 'usr_1',
        },
        body: JSON.stringify({ employeeSlug: 'zhangsan', siteSlug: 'profile' }),
      })
    )
  );

  for (const stageResult of ['issue_created', 'index_ready', 'pr_created']) {
    const response = await app.fetch(
      new Request('http://gateway.test/internal/executor-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publishingJobId: createBody.job.id,
          stageResult,
          issueNumber: 1,
          indexSnapshotId: 'idxsnap_1',
          branchName: `sites/job-${createBody.job.id}-zhangsan-profile`,
          prNumber: options.prNumber || 12,
          prUrl: `https://github.example/org/pages-manager/pull/${options.prNumber || 12}`,
          baseRef: 'staging',
          headSha: options.headSha || 'a'.repeat(40),
        }),
      })
    );
    assert.equal(response.status, 200);
  }

  return createBody.job.id;
}

test('API creates a PublishingJob without requiring GitHub repo user permissions', async () => {
  const app = createGatewayApp();
  const response = await app.fetch(
    new Request('http://gateway.test/api/publishing-jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'api-smoke-1',
        'X-Pages-Actor-Id': 'usr_no_github_access',
      },
      body: JSON.stringify({
        employeeSlug: 'zhangsan',
        siteSlug: 'profile',
        brief: 'Create a profile page',
      }),
    })
  );

  const body = await json(response);
  assert.equal(response.status, 201);
  assert.equal(body.created, true);
  assert.equal(body.job.requestedById, 'usr_no_github_access');
  assert.equal(body.job.status, 'received');
});

test('API create is idempotent by actor and idempotency key', async () => {
  const app = createGatewayApp();
  const request = () =>
    new Request('http://gateway.test/api/publishing-jobs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Idempotency-Key': 'api-smoke-2',
        'X-Pages-Actor-Id': 'usr_1',
      },
      body: JSON.stringify({ employeeSlug: 'zhangsan', siteSlug: 'profile' }),
    });

  const first = await json(await app.fetch(request()));
  const secondResponse = await app.fetch(request());
  const second = await json(secondResponse);

  assert.equal(secondResponse.status, 200);
  assert.equal(first.job.id, second.job.id);
  assert.equal(second.created, false);
});

test('Slack event creates a slack-sourced job', async () => {
  const app = createGatewayApp();
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000100',
          text: 'issue: 帮我创建 profile 页面',
        },
      }),
    })
  );

  const body = await json(response);
  assert.equal(response.status, 200);
  assert.equal(body.ok, true);

  const jobResponse = await app.fetch(new Request(`http://gateway.test/api/publishing-jobs/${body.jobId}`));
  const jobBody = await json(jobResponse);
  assert.equal(jobBody.job.source, 'slack');
  assert.equal(jobBody.job.requestedById, 'slack:T1:U1');
  assert.equal(jobBody.job.slackSessionId, body.slackSessionId);
  assert.match(jobBody.job.slackSessionKey, /^dm:D1:1710000000\.000100$/);
  assert.deepEqual(jobBody.job.slackThread, {
    teamId: 'T1',
    channelId: 'D1',
    channelType: 'im',
    messageTs: '1710000000.000100',
    threadTs: null,
    userId: 'U1',
  });
});

test('Slack event can use Slack Agent analysis before creating a job', async () => {
  const app = createGatewayApp();
  const agentCalls = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-agent-1',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000101',
          text: 'issue: 帮我创建 profile 页面',
        },
      }),
    }),
    {
      SLACK_AGENT_ANALYZE_URL: 'http://slack-agent.test/internal/slack-agent/analyze',
      SLACK_AGENT_SHARED_SECRET: 'agent-secret',
      async SLACK_AGENT_FETCH(url, request) {
        agentCalls.push({ url: String(url), request });
        assert.equal(request.headers['X-Pages-Slack-Agent-Token'], 'agent-secret');
        const payload = JSON.parse(request.body);
        assert.equal(payload.slackSession.primarySlackUserId, 'U1');
        assert.equal(payload.sessionMemory.slackSessionId, payload.slackSession.id);
        assert.equal(payload.agentRun.agentKind, 'slack_agent');
        return new Response(
          JSON.stringify({
            ok: true,
            analysis: {
              intent: 'create_or_update_site',
              employeeSlug: 'alice',
              siteSlug: 'portfolio',
              title: 'Agent title',
              summary: 'Agent summary',
              approvalMode: 'manual_required',
            },
          }),
          { status: 200 }
        );
      },
    }
  );

  const body = await json(response);
  const jobBody = await json(await app.fetch(new Request(`http://gateway.test/api/publishing-jobs/${body.jobId}`)));

  assert.equal(response.status, 200);
  assert.equal(agentCalls.length, 1);
  assert.equal(body.slackAgentAnalysis.summary, 'Agent summary');
  assert.equal(jobBody.job.employeeSlug, 'alice');
  assert.equal(jobBody.job.siteSlug, 'portfolio');
  assert.equal(jobBody.job.intent, 'create_or_update_site');
  assert.equal(jobBody.job.summary, 'Agent summary');
});

test('executor callbacks notify the source Slack thread', async () => {
  const app = createGatewayApp();
  const slackMessages = [];
  const createResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-slack-notify-1',
        event: {
          type: 'app_mention',
          user: 'U1',
          channel: 'C1',
          channel_type: 'channel',
          ts: '1710000000.000200',
          text: 'issue: 帮我创建 profile 页面',
        },
      }),
    })
  );
  const created = await json(createResponse);

  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: created.jobId,
        stageResult: 'issue_created',
        issueNumber: 8,
        issueUrl: 'https://github.example/org/pages-manager/issues/8',
      }),
    }),
    {
      SLACK_BOT_TOKEN: 'xoxb-test',
      async SLACK_FETCH(url, request) {
        slackMessages.push({ url: String(url), request });
        assert.equal(request.headers.Authorization, 'Bearer xoxb-test');
        return new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '1710000001.000100' }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.slackNotification.ok, true);
  assert.equal(slackMessages.length, 1);
  assert.deepEqual(JSON.parse(slackMessages[0].request.body), {
    channel: 'C1',
    thread_ts: '1710000000.000200',
    text: '<@U1> 已创建 GitHub issue：#8\nhttps://github.example/org/pages-manager/issues/8',
  });
  assert.equal(body.job.issueUrl, 'https://github.example/org/pages-manager/issues/8');

  const duplicate = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: created.jobId,
        stageResult: 'issue_created',
        issueNumber: 8,
        issueUrl: 'https://github.example/org/pages-manager/issues/8',
      }),
    }),
    {
      SLACK_BOT_TOKEN: 'xoxb-test',
      async SLACK_FETCH() {
        throw new Error('duplicate callback should not post to Slack');
      },
    }
  );
  const duplicateBody = await json(duplicate);
  assert.equal(duplicateBody.slackNotification.skipped, true);
});

test('Slack help and ping messages do not create jobs', async () => {
  const app = createGatewayApp();
  const workerStarts = [];

  for (const [eventId, text, action] of [
    ['Ev-help-1', '帮助', 'help'],
    ['Ev-ping-1', '1', 'ping'],
  ]) {
    const response = await app.fetch(
      new Request('http://gateway.test/integrations/slack/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          team_id: 'T1',
          event_id: eventId,
          event: {
            type: 'message',
            user: 'U1',
            channel_type: 'im',
            text,
          },
        }),
      }),
      {
        PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
        async WORKER_FETCH(url, request) {
          workerStarts.push({ url: String(url), request });
          return new Response(JSON.stringify({ ok: true }), { status: 200 });
        },
      }
    );
    const body = await json(response);
    assert.equal(response.status, 200);
    assert.equal(body.action, action);
    assert.equal(body.accepted, false);
    assert.equal(body.jobId, undefined);
    assert.match(body.replyText, action === 'help' ? /推荐用消息命令写法/ : /我在/);
  }

  assert.equal(workerStarts.length, 0);
});

test('Slack status message reads an existing job without creating a new one', async () => {
  const app = createGatewayApp();
  const createResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-create-before-status',
        event: {
          type: 'message',
          user: 'U1',
          channel_type: 'im',
          text: 'issue: 创建一个 issue',
        },
      }),
    })
  );
  const created = await json(createResponse);

  const statusResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-status-1',
        event: {
          type: 'message',
          user: 'U1',
          channel_type: 'im',
          text: `状态 ${created.jobId}`,
        },
      }),
    })
  );
  const body = await json(statusResponse);

  assert.equal(statusResponse.status, 200);
  assert.equal(body.action, 'status');
  assert.equal(body.accepted, false);
  assert.equal(body.jobId, undefined);
  assert.match(body.replyText, new RegExp(created.jobId));
  assert.match(body.replyText, /状态：received/);
});

test('Slack event can start the worker without requiring user GitHub permissions', async () => {
  const app = createGatewayApp();
  const workerStarts = [];
  const response = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-worker-1',
        event: {
          type: 'message',
          user: 'U1',
          channel_type: 'im',
          text: 'issue: 帮我创建 profile 页面',
        },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      PAGES_WORKER_SHARED_SECRET: 'worker-secret',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        assert.equal(request.headers['X-Pages-Worker-Token'], 'worker-secret');
        assert.equal(JSON.parse(request.body).job.requestedById, 'slack:T1:U1');
        return new Response(JSON.stringify({ ok: true, result: { action: 'issue_created_and_project_index_dispatched' } }), {
          status: 200,
        });
      },
    }
  );

  const body = await json(response);
  assert.equal(response.status, 200);
  assert.equal(body.workerStart.started, true);
  assert.equal(workerStarts.length, 1);
});

test('index_ready callback can start worker to dispatch pages-agent', async () => {
  const app = createGatewayApp();
  const createBody = await json(
    await app.fetch(
      new Request('http://gateway.test/api/publishing-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'api-index-ready-worker',
          'X-Pages-Actor-Id': 'usr_1',
        },
        body: JSON.stringify({ employeeSlug: 'zhangsan', siteSlug: 'profile' }),
      })
    )
  );
  const workerStarts = [];

  const issueResponse = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: createBody.job.id,
        stageResult: 'issue_created',
        issueNumber: 9,
      }),
    })
  );
  assert.equal(issueResponse.status, 200);

  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: createBody.job.id,
        stageResult: 'index_ready',
        indexSnapshotId: 'idxsnap_1',
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        const body = JSON.parse(request.body);
        assert.equal(body.job.status, 'generating_page');
        assert.equal(body.job.indexSnapshotId, 'idxsnap_1');
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_agent_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.job.status, 'generating_page');
  assert.equal(body.workerStart.started, true);
  assert.equal(workerStarts.length, 1);
});

test('Slack connector token is enforced when configured', async () => {
  const app = createGatewayApp();
  const request = (token) =>
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'X-Pages-Slack-Connector-Token': token } : {}),
      },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-secure-1',
        event: {
          type: 'message',
          user: 'U1',
          channel_type: 'im',
          text: 'secure request',
        },
      }),
    });

  const rejected = await app.fetch(request('wrong'), { SLACK_CONNECTOR_SHARED_SECRET: 'secret' });
  assert.equal(rejected.status, 401);

  const accepted = await app.fetch(request('secret'), { SLACK_CONNECTOR_SHARED_SECRET: 'secret' });
  assert.equal(accepted.status, 200);
});

test('executor callback advances the preview loop', async () => {
  const app = createGatewayApp();
  const createBody = await json(
    await app.fetch(
      new Request('http://gateway.test/api/publishing-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'api-smoke-3',
          'X-Pages-Actor-Id': 'usr_1',
        },
        body: JSON.stringify({ employeeSlug: 'zhangsan', siteSlug: 'profile' }),
      })
    )
  );

  for (const stageResult of ['issue_created', 'index_ready', 'patch_generated', 'branch_committed', 'pr_created']) {
    const response = await app.fetch(
      new Request('http://gateway.test/internal/executor-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publishingJobId: createBody.job.id,
          stageResult,
          issueNumber: 1,
          indexSnapshotId: 'idxsnap_1',
          branchName: 'sites/job-test-zhangsan-profile',
          prNumber: 2,
        }),
      })
    );
    assert.equal(response.status, 200);
  }

  const previewResponse = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: createBody.job.id,
        stageResult: 'preview_deployed',
        previewUrl: 'https://preview.example.test',
      }),
    })
  );
  const body = await json(previewResponse);

  assert.equal(body.job.status, 'preview_deployed');
  assert.equal(body.job.previewUrl, 'https://preview.example.test');
});

test('Slack follow-up on an active preview dispatches a fix round instead of creating a new job', async () => {
  const app = createGatewayApp();
  const createResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-followup-create',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000000.000100',
          text: 'issue: 帮我创建 profile 页面',
        },
      }),
    })
  );
  const created = await json(createResponse);

  for (const [stageResult, patch] of [
    [
      'issue_created',
      {
        issueNumber: 21,
        issueUrl: 'https://github.example/org/pages-manager/issues/21',
      },
    ],
    [
      'pr_created',
      {
        issueNumber: 21,
        branchName: 'sites/job-followup-smoke-profile',
        prNumber: 31,
        prUrl: 'https://github.example/org/pages-manager/pull/31',
        headSha: '1'.repeat(40),
      },
    ],
    [
      'preview_deployed',
      {
        previewUrl: 'https://preview.example.test',
      },
    ],
  ]) {
    const response = await app.fetch(
      new Request('http://gateway.test/internal/executor-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publishingJobId: created.jobId,
          stageResult,
          ...patch,
        }),
      })
    );
    assert.equal(response.status, 200);
  }

  const workerStarts = [];
  const followupResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-followup-fix',
        event: {
          type: 'message',
          user: 'U1',
          channel: 'D1',
          channel_type: 'im',
          ts: '1710000010.000100',
          text: '这个 preview 不满意，把标题改成中文，再加一个项目经历区域',
        },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        const body = JSON.parse(request.body);
        assert.equal(body.job.id, created.jobId);
        assert.equal(body.job.status, 'fixing');
        assert.equal(body.job.prNumber, 31);
        assert.match(body.job.summary, /Slack Follow-up/);
        assert.match(body.job.summary, /标题改成中文/);
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_agent_fix_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const followup = await json(followupResponse);
  const jobBody = await json(await app.fetch(new Request(`http://gateway.test/api/publishing-jobs/${created.jobId}`)));

  assert.equal(followupResponse.status, 200);
  assert.equal(followup.action, 'followup_fix_dispatched');
  assert.equal(followup.jobId, created.jobId);
  assert.match(followup.replyText, /同一个 PR/);
  assert.equal(jobBody.job.status, 'fixing');
  assert.equal(workerStarts.length, 1);
});

test('pages-agent fix callback moves a fixing job back to reviewing', async () => {
  const app = createGatewayApp();
  const jobId = await moveJobToPrCreated(app, {
    prNumber: 32,
    headSha: '2'.repeat(40),
    idempotencyKey: 'api-fix-callback',
  });
  const job = app.store.updateJob(jobId, 'reviewing');
  const fixing = app.store.moveJobToFixing(job.id, { summary: `${job.summary}\n\n## Slack Follow-up\n\n改标题。` });
  assert.equal(fixing.status, 'fixing');

  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: jobId,
        stageResult: 'reviewing',
        branchName: 'sites/job-fix-callback-zhangsan-profile',
        prNumber: 32,
        prUrl: 'https://github.example/org/pages-manager/pull/32',
        baseRef: 'staging',
        headSha: '3'.repeat(40),
      }),
    })
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.job.status, 'reviewing');
  assert.equal(body.job.prNumber, 32);
  assert.equal(body.job.headSha, '3'.repeat(40));
});

test('pages-agent issue webhook callback can move issue_created directly to pr_created', async () => {
  const app = createGatewayApp();
  const createBody = await json(
    await app.fetch(
      new Request('http://gateway.test/api/publishing-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'api-issue-webhook-pr',
          'X-Pages-Actor-Id': 'usr_1',
        },
        body: JSON.stringify({ employeeSlug: 'zhangsan', siteSlug: 'profile' }),
      })
    )
  );

  await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: createBody.job.id,
        stageResult: 'issue_created',
        issueNumber: 8,
        issueUrl: 'https://github.example/issues/8',
      }),
    })
  );

  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: createBody.job.id,
        stageResult: 'pr_created',
        issueNumber: 8,
        branchName: 'sites/job-test-zhangsan-profile',
        prNumber: 22,
        prUrl: 'https://github.example/pull/22',
        baseRef: 'staging',
        headSha: 'c'.repeat(40),
      }),
    })
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.job.status, 'pr_created');
  assert.equal(body.job.prNumber, 22);
  assert.equal(body.job.issueNumber, 8);
});

test('GitHub issue webhook routes platform issue through gateway before starting pages-agent', async () => {
  const app = createGatewayApp();
  const createBody = await json(
    await app.fetch(
      new Request('http://gateway.test/api/publishing-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'api-issue-webhook-dispatch',
          'X-Pages-Actor-Id': 'usr_1',
        },
        body: JSON.stringify({
          employeeSlug: 'zhangsan',
          siteSlug: 'profile',
          summary: 'Create a personal website.',
        }),
      })
    )
  );

  const issueBody = [
    `PublishingJob: ${createBody.job.id}`,
    '',
    'Target: zhangsan/profile',
    'Allowed path: sites/zhangsan/profile',
    'Base ref: staging',
    '',
    '## Requirement Summary',
    '',
    'Create a personal website.',
  ].join('\n');
  const workerStarts = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-issue-1',
        'X-GitHub-Event': 'issues',
      },
      body: JSON.stringify({
        action: 'opened',
        repository: { full_name: 'org/pages-manager' },
        issue: {
          number: 31,
          html_url: 'https://github.example/org/pages-manager/issues/31',
          body: issueBody,
        },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_agent_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);
  const workerBody = JSON.parse(workerStarts[0].request.body);

  assert.equal(response.status, 200);
  assert.equal(body.issueAction, 'pages_agent_dispatched');
  assert.equal(body.job.status, 'generating_page');
  assert.equal(body.job.issueNumber, 31);
  assert.equal(workerStarts.length, 1);
  assert.equal(workerStarts[0].url, 'http://worker.test/internal/publishing-jobs/start');
  assert.equal(workerBody.job.id, createBody.job.id);
  assert.equal(workerBody.job.status, 'generating_page');
  assert.equal(workerBody.job.issueNumber, 31);
});

test('late issue_created callback is idempotent after GitHub issue webhook started pages-agent', async () => {
  const app = createGatewayApp();
  const createBody = await json(
    await app.fetch(
      new Request('http://gateway.test/api/publishing-jobs', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': 'api-issue-webhook-callback-race',
          'X-Pages-Actor-Id': 'usr_1',
        },
        body: JSON.stringify({
          employeeSlug: 'zhangsan',
          siteSlug: 'profile',
          summary: 'Create a personal website.',
        }),
      })
    )
  );

  const issueBody = [
    `PublishingJob: ${createBody.job.id}`,
    '',
    'Target: zhangsan/profile',
    'Allowed path: sites/zhangsan/profile',
  ].join('\n');

  await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-issue-race-1',
        'X-GitHub-Event': 'issues',
      },
      body: JSON.stringify({
        action: 'opened',
        repository: { full_name: 'org/pages-manager' },
        issue: {
          number: 32,
          html_url: 'https://github.example/org/pages-manager/issues/32',
          body: issueBody,
        },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH() {
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_agent_dispatched' } }), {
          status: 200,
        });
      },
    }
  );

  const response = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: createBody.job.id,
        stageResult: 'issue_created',
        issueNumber: 32,
        issueUrl: 'https://github.example/org/pages-manager/issues/32',
      }),
    })
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.job.status, 'generating_page');
  assert.equal(body.job.issueNumber, 32);
});

test('GitHub Review Agent approval dispatches staging preview', async () => {
  const app = createGatewayApp();
  const headSha = 'b'.repeat(40);
  const jobId = await moveJobToPrCreated(app, { prNumber: 12, headSha, idempotencyKey: 'api-review-preview' });
  const workerStarts = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-approved',
        'X-GitHub-Event': 'pull_request_review',
      },
      body: JSON.stringify({
        action: 'submitted',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 12, head: { sha: headSha } },
        review: {
          id: 100,
          node_id: 'PRR_100',
          state: 'approved',
          body: 'LGTM, no issues found.',
          user: { login: 'greptile[bot]' },
        },
        sender: { login: 'greptile[bot]' },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      PAGES_WORKER_SHARED_SECRET: 'worker-secret',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        assert.equal(request.headers['X-Pages-Worker-Token'], 'worker-secret');
        const body = JSON.parse(request.body);
        assert.equal(body.job.id, jobId);
        assert.equal(body.job.status, 'previewing');
        assert.equal(body.job.prNumber, 12);
        assert.equal(body.job.headSha, headSha);
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_preview_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'preview_dispatched');
  assert.equal(body.reviewComment.classification, 'note');
  assert.equal(body.gate.canPreview, true);
  assert.equal(body.job.status, 'previewing');
  assert.equal(body.workerStart.started, true);
  assert.equal(workerStarts.length, 1);
});

test('GitHub Review Agent nonblocking summary dispatches staging preview', async () => {
  const app = createGatewayApp();
  const headSha = '1'.repeat(40);
  const jobId = await moveJobToPrCreated(app, {
    prNumber: 22,
    headSha,
    idempotencyKey: 'api-review-codex-preview',
  });
  const workerStarts = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-codex-summary',
        'X-GitHub-Event': 'pull_request_review',
      },
      body: JSON.stringify({
        action: 'submitted',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 22, head: { sha: headSha } },
        review: {
          id: 101,
          node_id: 'PRR_101',
          state: 'commented',
          body: 'Here are some automated review suggestions for this pull request.',
          user: { login: 'chatgpt-codex-connector' },
        },
        sender: { login: 'chatgpt-codex-connector' },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        const body = JSON.parse(request.body);
        assert.equal(body.job.id, jobId);
        assert.equal(body.job.status, 'previewing');
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_preview_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'preview_dispatched');
  assert.equal(body.reviewComment.classification, 'suggestion');
  assert.equal(body.gate.canPreview, true);
  assert.equal(body.job.status, 'previewing');
  assert.equal(body.workerStart.started, true);
  assert.equal(workerStarts.length, 1);
});

test('GitHub Review Agent issue comment summary dispatches staging preview', async () => {
  const app = createGatewayApp();
  const headSha = '2'.repeat(40);
  const jobId = await moveJobToPrCreated(app, {
    prNumber: 23,
    headSha,
    idempotencyKey: 'api-review-codex-issue-comment-preview',
  });
  const workerStarts = [];

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-codex-issue-comment',
        'X-GitHub-Event': 'issue_comment',
      },
      body: JSON.stringify({
        action: 'created',
        repository: { full_name: 'org/pages-manager' },
        issue: { number: 23, pull_request: { url: 'https://github.example/org/pages-manager/pulls/23' } },
        comment: {
          id: 102,
          node_id: 'IC_102',
          body: "Codex Review: Didn't find any major issues.",
          user: { login: 'chatgpt-codex-connector' },
        },
        sender: { login: 'chatgpt-codex-connector' },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        const body = JSON.parse(request.body);
        assert.equal(body.job.id, jobId);
        assert.equal(body.job.status, 'previewing');
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_preview_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'preview_dispatched');
  assert.equal(body.reviewComment.classification, 'note');
  assert.equal(body.gate.canPreview, true);
  assert.equal(body.job.status, 'previewing');
  assert.equal(body.workerStart.started, true);
  assert.equal(workerStarts.length, 1);
});

test('GitHub Review Agent issue comment targets latest reused PR job by reviewed commit', async () => {
  const app = createGatewayApp();
  const oldHeadSha = '3'.repeat(40);
  const newHeadSha = '4'.repeat(40);
  const oldJobId = await moveJobToPrCreated(app, {
    prNumber: 24,
    headSha: oldHeadSha,
    idempotencyKey: 'api-review-reused-pr-old',
  });
  const newJobId = await moveJobToPrCreated(app, {
    prNumber: 24,
    headSha: newHeadSha,
    idempotencyKey: 'api-review-reused-pr-new',
  });
  const workerStarts = [];

  const oldPreview = await app.fetch(
    new Request('http://gateway.test/internal/executor-callback', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        publishingJobId: oldJobId,
        stageResult: 'preview_deployed',
        previewUrl: 'https://old-preview.example.test',
      }),
    })
  );
  assert.equal(oldPreview.status, 200);

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-reused-pr-new',
        'X-GitHub-Event': 'issue_comment',
      },
      body: JSON.stringify({
        action: 'created',
        repository: { full_name: 'org/pages-manager' },
        issue: { number: 24, pull_request: { url: 'https://github.example/org/pages-manager/pulls/24' } },
        comment: {
          id: 103,
          node_id: 'IC_103',
          body: `Codex Review: Didn't find any major issues.\n\n**Reviewed commit:** \`${newHeadSha.slice(0, 10)}\``,
          user: { login: 'chatgpt-codex-connector' },
        },
        sender: { login: 'chatgpt-codex-connector' },
      }),
    }),
    {
      PAGES_WORKER_START_URL: 'http://worker.test/internal/publishing-jobs/start',
      async WORKER_FETCH(url, request) {
        workerStarts.push({ url: String(url), request });
        const body = JSON.parse(request.body);
        assert.equal(body.job.id, newJobId);
        assert.equal(body.job.status, 'previewing');
        assert.equal(body.job.headSha, newHeadSha);
        return new Response(JSON.stringify({ ok: true, result: { action: 'pages_preview_dispatched' } }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);
  const oldJob = await json(await app.fetch(new Request(`http://gateway.test/api/publishing-jobs/${oldJobId}`)));

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'preview_dispatched');
  assert.equal(body.reviewComment.headSha, newHeadSha.slice(0, 10));
  assert.equal(body.job.id, newJobId);
  assert.equal(body.job.status, 'previewing');
  assert.equal(oldJob.job.status, 'preview_deployed');
  assert.equal(workerStarts.length, 1);
});

test('GitHub Review Agent blocking comment moves job to changes_requested', async () => {
  const app = createGatewayApp();
  const headSha = 'c'.repeat(40);
  await moveJobToPrCreated(app, { prNumber: 13, headSha, idempotencyKey: 'api-review-blocking' });

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-blocking',
        'X-GitHub-Event': 'pull_request_review_comment',
      },
      body: JSON.stringify({
        action: 'created',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 13, head: { sha: headSha } },
        comment: {
          id: 200,
          node_id: 'PRRC_200',
          body: 'Must fix the broken HTML before preview.',
          path: 'sites/zhangsan/profile/src/index.html',
          line: 3,
          user: { login: 'greptile[bot]' },
        },
        sender: { login: 'greptile[bot]' },
      }),
    })
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'changes_requested');
  assert.equal(body.reviewComment.classification, 'blocking');
  assert.equal(body.gate.blockingCount, 1);
  assert.equal(body.gate.canPreview, false);
  assert.equal(body.job.status, 'changes_requested');
});

test('GitHub Review Agent blocking comment notifies Slack thread', async () => {
  const app = createGatewayApp();
  const slackMessages = [];
  const createResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-review-slack-notify',
        event: {
          type: 'app_mention',
          user: 'U1',
          channel: 'C1',
          channel_type: 'channel',
          ts: '1710000000.000300',
          text: 'issue: 帮我创建 profile 页面',
        },
      }),
    })
  );
  const created = await json(createResponse);
  const headSha = 'e'.repeat(40);

  for (const stageResult of ['issue_created', 'index_ready', 'pr_created']) {
    const response = await app.fetch(
      new Request('http://gateway.test/internal/executor-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publishingJobId: created.jobId,
          stageResult,
          issueNumber: 8,
          indexSnapshotId: 'idxsnap_1',
          branchName: 'sites/job-review-slack-smoke-profile',
          prNumber: 15,
          prUrl: 'https://github.example/org/pages-manager/pull/15',
          headSha,
        }),
      })
    );
    assert.equal(response.status, 200);
  }

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-slack-blocking',
        'X-GitHub-Event': 'pull_request_review_comment',
      },
      body: JSON.stringify({
        action: 'created',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 15, head: { sha: headSha } },
        comment: {
          id: 201,
          node_id: 'PRRC_201',
          body: 'Must fix this before preview.',
          path: 'sites/zhangsan/profile/src/index.html',
          line: 4,
          user: { login: 'greptile[bot]' },
        },
      }),
    }),
    {
      SLACK_BOT_TOKEN: 'xoxb-test',
      async SLACK_FETCH(url, request) {
        slackMessages.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '1710000002.000100' }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'changes_requested');
  assert.equal(body.slackNotification.ok, true);
  assert.equal(slackMessages.length, 1);
  assert.match(JSON.parse(slackMessages[0].request.body).text, /^<@U1> .*blocking comment/s);
});

test('GitHub Review Agent suggestion comment notifies Slack thread without blocking preview', async () => {
  const app = createGatewayApp();
  const slackMessages = [];
  const createResponse = await app.fetch(
    new Request('http://gateway.test/integrations/slack/events', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        team_id: 'T1',
        event_id: 'Ev-review-slack-suggestion',
        event: {
          type: 'app_mention',
          user: 'U1',
          channel: 'C1',
          channel_type: 'channel',
          ts: '1710000000.000400',
          text: 'issue: 帮我创建 profile 页面',
        },
      }),
    })
  );
  const created = await json(createResponse);
  const headSha = 'f'.repeat(40);

  for (const stageResult of ['issue_created', 'index_ready', 'pr_created']) {
    const response = await app.fetch(
      new Request('http://gateway.test/internal/executor-callback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          publishingJobId: created.jobId,
          stageResult,
          issueNumber: 9,
          indexSnapshotId: 'idxsnap_2',
          branchName: 'sites/job-review-slack-suggestion-smoke-profile',
          prNumber: 16,
          prUrl: 'https://github.example/org/pages-manager/pull/16',
          headSha,
        }),
      })
    );
    assert.equal(response.status, 200);
  }

  const response = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-review-slack-suggestion',
        'X-GitHub-Event': 'pull_request_review_comment',
      },
      body: JSON.stringify({
        action: 'created',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 16, head: { sha: headSha } },
        comment: {
          id: 202,
          node_id: 'PRRC_202',
          body: 'Consider using a richer title.',
          path: 'sites/zhangsan/profile/src/index.html',
          line: 5,
          user: { login: 'greptile[bot]' },
        },
      }),
    }),
    {
      SLACK_BOT_TOKEN: 'xoxb-test',
      async SLACK_FETCH(url, request) {
        slackMessages.push({ url: String(url), request });
        return new Response(JSON.stringify({ ok: true, channel: 'C1', ts: '1710000003.000100' }), {
          status: 200,
        });
      },
    }
  );
  const body = await json(response);
  const slackText = JSON.parse(slackMessages[0].request.body).text;

  assert.equal(response.status, 200);
  assert.equal(body.reviewAction, 'reviewing');
  assert.equal(body.reviewComment.classification, 'suggestion');
  assert.equal(body.gate.canPreview, true);
  assert.equal(body.job.status, 'reviewing');
  assert.equal(body.slackNotification.ok, true);
  assert.match(slackText, /^<@U1> /);
  assert.match(slackText, /suggestion/);
  assert.match(slackText, /sites\/zhangsan\/profile\/src\/index.html:5/);
});

test('GitHub webhook ignores untrusted review agents and deduplicates deliveries', async () => {
  const app = createGatewayApp();
  await moveJobToPrCreated(app, { prNumber: 14, idempotencyKey: 'api-review-dedup' });
  const request = (deliveryId, login) =>
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': deliveryId,
        'X-GitHub-Event': 'pull_request_review',
      },
      body: JSON.stringify({
        action: 'submitted',
        repository: { full_name: 'org/pages-manager' },
        pull_request: { number: 14, head: { sha: 'd'.repeat(40) } },
        review: {
          id: 300,
          node_id: 'PRR_300',
          state: 'approved',
          body: 'LGTM.',
          user: { login },
        },
      }),
    });

  const ignored = await json(await app.fetch(request('delivery-untrusted', 'random-bot[bot]')));
  assert.equal(ignored.ignored, 'review_agent_not_allowed');

  const first = await json(await app.fetch(request('delivery-dedup', 'greptile[bot]')));
  const second = await json(await app.fetch(request('delivery-dedup', 'greptile[bot]')));
  assert.equal(first.created, true);
  assert.equal(second.created, false);
});

test('GitHub webhook signature is enforced when configured', async () => {
  const app = createGatewayApp();
  const payload = JSON.stringify({
    action: 'created',
    repository: { full_name: 'org/pages-manager' },
  });
  const unsigned = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-unsigned',
        'X-GitHub-Event': 'ping',
      },
      body: payload,
    }),
    { GITHUB_WEBHOOK_SECRET: 'secret' }
  );
  assert.equal(unsigned.status, 401);

  const signed = await app.fetch(
    new Request('http://gateway.test/integrations/github/webhook', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Delivery': 'delivery-signed',
        'X-GitHub-Event': 'ping',
        'X-Hub-Signature-256': await githubSignature('secret', payload),
      },
      body: payload,
    }),
    { GITHUB_WEBHOOK_SECRET: 'secret' }
  );
  assert.equal(signed.status, 200);
});
