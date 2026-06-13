import { jsonResponse } from '@xd/worker-kit';

import { isAllowedReviewAgent, normalizeReviewAgentWebhook } from './github-review.js';
import { classifySlackIntake, slackStatusReply } from './slack-intake.js';
import {
  notificationTextForCallback,
  notificationTextForReviewAction,
  notifySlackJob,
  notifySlackJobStatus,
} from './slack-notifier.js';
import { selectSlackSession, slackActorFromBody, surfaceForSlackBody } from './slack-session.js';

const CALLBACK_STAGE_RESULTS = {
  index_ready: {
    status: 'generating_page',
    patch(body) {
      return { indexSnapshotId: body.indexSnapshotId || body.index_snapshot_id || null };
    },
  },
  issue_created: {
    status: 'issue_created',
    patch(body) {
      return {
        issueNumber: body.issueNumber || body.issue_number || null,
        issueUrl: body.issueUrl || body.issue_url || null,
      };
    },
  },
  patch_generated: { status: 'patch_generated' },
  branch_committed: {
    status: 'branch_committed',
    patch(body) {
      return { branchName: body.branchName || body.branch_name || null };
    },
  },
  pr_created: {
    status: 'pr_created',
    patch(body) {
      return {
        branchName: body.branchName || body.branch_name || null,
        prNumber: body.prNumber || body.pr_number || null,
        prUrl: body.prUrl || body.pr_url || null,
        baseRef: body.baseRef || body.base_ref || null,
        headSha: body.headSha || body.head_sha || null,
      };
    },
  },
  reviewing: {
    status: 'reviewing',
    patch(body) {
      return {
        branchName: body.branchName || body.branch_name || null,
        prNumber: body.prNumber || body.pr_number || null,
        prUrl: body.prUrl || body.pr_url || null,
        baseRef: body.baseRef || body.base_ref || null,
        headSha: body.headSha || body.head_sha || null,
      };
    },
  },
  previewing: { status: 'previewing' },
  preview_deployed: {
    status: 'preview_deployed',
    patch(body) {
      return { previewUrl: body.previewUrl || body.preview_url || null };
    },
  },
};

const STALE_CALLBACK_PATCH_STATUSES = {
  issue_created: new Set([
    'indexing',
    'generating_page',
    'patch_generated',
    'branch_committed',
    'pr_created',
    'reviewing',
    'changes_requested',
    'fixing',
    'previewing',
    'preview_deployed',
  ]),
};

async function readJson(request) {
  const text = await request.text();
  return parseJsonText(text);
}

function parseJsonText(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('Invalid JSON body');
    error.status = 400;
    throw error;
  }
}

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualString(a, b) {
  const left = new globalThis.TextEncoder().encode(a);
  const right = new globalThis.TextEncoder().encode(b);
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let i = 0; i < left.length; i++) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}

async function verifyGithubWebhookSignature(request, env, rawBody) {
  if (!env.GITHUB_WEBHOOK_SECRET) return;

  const header = request.headers.get('X-Hub-Signature-256') || '';
  if (!header.startsWith('sha256=')) {
    const error = new Error('Missing GitHub webhook signature');
    error.status = 401;
    throw error;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new globalThis.TextEncoder().encode(env.GITHUB_WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const digest = await crypto.subtle.sign('HMAC', key, new globalThis.TextEncoder().encode(rawBody));
  const expected = `sha256=${bytesToHex(digest)}`;

  if (!timingSafeEqualString(header, expected)) {
    const error = new Error('Invalid GitHub webhook signature');
    error.status = 401;
    throw error;
  }
}

function required(value, name) {
  if (value === undefined || value === null || value === '') {
    const error = new Error(`${name} is required`);
    error.status = 400;
    throw error;
  }
  return value;
}

function isUnaddressedChannelThreadMessage(body = {}) {
  const event = body.event || {};
  return event.type === 'message' && event.channel_type !== 'im' && Boolean(event.thread_ts);
}

function existingSlackThreadSession(store, body = {}) {
  const actor = slackActorFromBody(body);
  const surface = surfaceForSlackBody(body);
  const sessionKey = `thread:${surface.channelId || 'unknown'}:${surface.threadTs || surface.messageTs || 'unknown'}`;
  return store.findSlackSessionByScope?.(actor.teamId, actor.slackUserId, sessionKey) || null;
}

function publishingJobIdFromIssueBody(body) {
  const match = String(body || '').match(/^PublishingJob:\s*(job_[A-Za-z0-9_]{1,80})\s*$/m);
  return match ? match[1] : '';
}

function issueUrl(issue = {}) {
  return issue.html_url || issue.url || null;
}

function applyExecutorCallback(store, jobId, stageResult, status, patch) {
  const existing = store.getJob(jobId);
  if (!existing) return null;

  if (STALE_CALLBACK_PATCH_STATUSES[stageResult]?.has(existing.status)) {
    return store.patchJob(jobId, patch);
  }

  return store.updateJob(jobId, status, patch);
}

async function handleGithubIssueWebhook({ body, action, store, env, result }) {
  const issue = body.issue || {};
  if (issue.pull_request) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'pull_request_issue' });
  }

  if (!['opened', 'reopened', 'edited'].includes(action)) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'unsupported_issue_action' });
  }

  const jobId = publishingJobIdFromIssueBody(issue.body);
  if (!jobId) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'non_pages_issue' });
  }

  let job = store.getJob(jobId);
  if (!job) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'job_not_found', jobId });
  }

  const issueNumber = issue.number || null;
  if (job.issueNumber && issueNumber && Number(job.issueNumber) !== Number(issueNumber)) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'issue_number_mismatch', job });
  }

  if (!job.issueNumber || ['received', 'issue_creating'].includes(job.status)) {
    job = store.updateJob(job.id, 'issue_created', {
      issueNumber,
      issueUrl: issueUrl(issue),
    });
  }
  store.linkJobToSlackSession(job);

  let workerStart = null;
  let issueAction = 'recorded';

  if (job.status === 'issue_created') {
    job = store.updateJob(job.id, 'generating_page');
    store.linkJobToSlackSession(job);
    await notifySlackJobStatus(env, store, job, {
      stage: 'issue_created',
      text: 'GitHub issue 已创建，准备启动页面生成。',
    });
    workerStart = await startWorkerForJobIfConfigured(job, env);
    issueAction = workerStart?.started ? 'pages_agent_dispatched' : 'pages_agent_ready';
  } else if (['generating_page', 'patch_generated', 'branch_committed', 'pr_created', 'reviewing'].includes(job.status)) {
    issueAction = 'already_running_or_completed';
  }

  return jsonResponse({
    ok: true,
    created: true,
    delivery: result.delivery,
    issueAction,
    job,
    ...(workerStart ? { workerStart } : {}),
  });
}

async function readResponseJson(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function getStore(env) {
  if (!env.store) {
    env.store = env.GATEWAY_STORE || globalThis.__PAGES_GATEWAY_STORE__;
  }
  if (!env.store) {
    const error = new Error('Gateway store is not configured');
    error.status = 500;
    throw error;
  }
  return env.store;
}

function shouldStartWorkerForJob(job) {
  return job.status === 'received' || job.status === 'generating_page' || job.status === 'fixing' || job.status === 'previewing';
}

async function startWorkerForJobIfConfigured(job, env) {
  if (!env.PAGES_WORKER_START_URL || !shouldStartWorkerForJob(job)) return null;

  const headers = {
    'Content-Type': 'application/json',
  };

  if (env.PAGES_WORKER_SHARED_SECRET) {
    headers['X-Pages-Worker-Token'] = env.PAGES_WORKER_SHARED_SECRET;
  }

  const fetchImpl = env.WORKER_FETCH || fetch;
  const response = await fetchImpl(env.PAGES_WORKER_START_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({ job }),
  });
  const body = await readResponseJson(response);

  if (!response.ok || body?.ok === false) {
    return {
      started: false,
      error: body?.error || response.statusText || `HTTP ${response.status}`,
    };
  }

  return {
    started: true,
    response: body,
  };
}

function requireSlackConnectorAuth(request, env) {
  if (!env.SLACK_CONNECTOR_SHARED_SECRET) return;

  const token = request.headers.get('X-Pages-Slack-Connector-Token');
  if (token !== env.SLACK_CONNECTOR_SHARED_SECRET) {
    const error = new Error('Invalid Slack connector token');
    error.status = 401;
    throw error;
  }
}

async function analyzeSlackEventIfConfigured(body, intake, env, context = {}) {
  if (!env.SLACK_AGENT_ANALYZE_URL) return null;

  const headers = {
    'Content-Type': 'application/json',
  };

  if (env.SLACK_AGENT_SHARED_SECRET) {
    headers['X-Pages-Slack-Agent-Token'] = env.SLACK_AGENT_SHARED_SECRET;
  }

  const fetchImpl = env.SLACK_AGENT_FETCH || fetch;
  const response = await fetchImpl(env.SLACK_AGENT_ANALYZE_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      ...body,
      text: intake.text,
      employeeSlug: body.employeeSlug || body.employee_slug,
      siteSlug: body.siteSlug || body.site_slug,
      slackSession: context.slackSession || null,
      sessionMemory: context.sessionMemory || null,
      issueLinks: context.issueLinks || [],
      agentRun: context.agentRun || null,
    }),
  });
  const result = await readResponseJson(response);

  if (!response.ok || result?.ok === false) {
    const error = new Error(result?.error || response.statusText || `HTTP ${response.status}`);
    error.status = 502;
    throw error;
  }

  return result?.analysis || null;
}

function actorFromHeaders(request, fallback = {}) {
  return {
    requestedByType: request.headers.get('X-Pages-Actor-Type') || fallback.requestedByType || 'user',
    requestedById: request.headers.get('X-Pages-Actor-Id') || fallback.requestedById,
  };
}

function normalizePublishingJobInput(body, request) {
  const actor = actorFromHeaders(request, body);
  const idempotencyKey = request.headers.get('Idempotency-Key') || body.idempotencyKey || body.idempotency_key || body.requestId;

  return {
    source: body.source || 'api',
    requestedByType: actor.requestedByType,
    requestedById: required(actor.requestedById, 'requestedById'),
    idempotencyKey: required(idempotencyKey, 'idempotencyKey'),
    employeeSlug: required(body.employeeSlug || body.employee_slug, 'employeeSlug'),
    siteSlug: required(body.siteSlug || body.site_slug, 'siteSlug'),
    siteProjectId: body.siteProjectId || body.site_project_id || null,
    ownerScopeId: body.ownerScopeId || body.owner_scope_id || null,
    employeeId: body.employeeId || body.employee_id || null,
    intent: body.intent || 'create_site',
    approvalMode: body.approvalMode || body.approval_mode || 'manual_required',
    title: body.title,
    summary: body.summary || body.brief || '',
    brief: body.brief,
  };
}

function slackJobInput(body) {
  const event = body.event || {};
  const analysis = body.slackAgentAnalysis || {};
  const slackSession = body.slackSession || null;
  const teamId = body.team_id || body.team?.id || 'unknown-team';
  const slackUserId = event.user || body.user_id || body.user?.id || body.source_user_id || 'unknown-user';
  const intake = body.intake || classifySlackIntake(body);
  const text = intake.text || event.text || body.text || '';
  const idempotencyKey = body.event_id || body.trigger_id || `${teamId}:${event.ts || body.event_ts || Date.now()}`;

  return {
    source: 'slack',
    requestedByType: 'user',
    requestedById: `slack:${teamId}:${slackUserId}`,
    idempotencyKey,
    employeeSlug: analysis.employeeSlug || body.employeeSlug || body.employee_slug || 'smoke',
    siteSlug: analysis.siteSlug || body.siteSlug || body.site_slug || 'profile',
    intent: analysis.intent || 'create_site',
    approvalMode: analysis.approvalMode || body.approvalMode || body.approval_mode || 'manual_required',
    title: body.title || analysis.title || text.slice(0, 80) || 'Slack publishing request',
    summary: body.summary || analysis.summary || text,
    slackSessionId: slackSession?.id || body.slackSessionId || null,
    slackSessionKey: slackSession?.sessionKey || body.slackSessionKey || null,
    slackThread: {
      teamId,
      channelId: event.channel || null,
      channelType: event.channel_type || null,
      messageTs: event.ts || body.event_ts || null,
      threadTs: event.channel_type === 'im' ? null : event.thread_ts || event.ts || null,
      userId: slackUserId,
    },
  };
}

const CREATE_JOB_INTENTS = new Set(['create_or_update_site', 'new_site_request', 'create_site', 'update_site']);
const FOLLOWUP_INTENTS = new Set(['modify_existing_preview', 'append_requirement']);
const NON_FOLLOWUP_ACTIONS = new Set(['help', 'ping', 'status', 'cancel', 'close_session', 'empty', 'missing_requirement']);

function hasActiveSlackTarget(slackSession) {
  return Boolean(
    slackSession?.activeJobId || slackSession?.activeIssueNumber || slackSession?.activePrNumber || slackSession?.activePreviewUrl
  );
}

function shouldAnalyzeSlackTurn(intake, slackSession) {
  if (NON_FOLLOWUP_ACTIONS.has(intake.action)) return false;
  if (intake.command && !intake.shouldCreateJob) return false;
  return Boolean(intake.shouldAnalyze || intake.shouldCreateJob || hasActiveSlackTarget(slackSession));
}

function looksLikeSlackFollowupText(text = '') {
  return /(preview|预览|不满意|继续|调整|修改|改成|换成|加|增加|删除|删掉|标题|文案|颜色|布局|风格|重新|再来)/i.test(text);
}

function isSlackFollowupIntent(analysis, intake) {
  if (analysis?.needsClarification) return false;
  if (FOLLOWUP_INTENTS.has(analysis?.intent)) return true;
  if (analysis?.intent === 'create_or_update_site' && looksLikeSlackFollowupText(intake.text)) return true;
  return looksLikeSlackFollowupText(intake.text);
}

function activeJobForSlackSession(store, slackSession) {
  if (slackSession?.activeJobId) {
    const job = store.getJob(slackSession.activeJobId);
    if (job) return job;
  }

  const link = store.findIssueLinksForSlackSession(slackSession.id)[0];
  return link?.publishingJobId ? store.getJob(link.publishingJobId) : null;
}

function followupSummary(existingSummary, text) {
  const cleanText = String(text || '').trim();
  if (!cleanText) return existingSummary || '';
  const previous = String(existingSummary || '').trim();
  const block = ['## Slack Follow-up', '', cleanText].join('\n');
  return previous ? `${previous}\n\n${block}` : block;
}

function canDispatchFixForJob(job) {
  return ['pr_created', 'reviewing', 'changes_requested', 'fixing', 'preview_deployed'].includes(job.status);
}

function shouldCloseSlackSession(intake, slackAgentAnalysis) {
  return intake.action === 'close_session' || slackAgentAnalysis?.intent === 'close_session';
}

function shouldCreateSlackJob(intake, slackAgentAnalysis) {
  if (!slackAgentAnalysis) return Boolean(intake.shouldCreateJob);
  if (slackAgentAnalysis.needsClarification) return false;
  return CREATE_JOB_INTENTS.has(slackAgentAnalysis.intent);
}

function slackAgentReplyText(intake, slackAgentAnalysis, fallbackText = null) {
  return (
    slackAgentAnalysis?.clarifyingQuestion ||
    slackAgentAnalysis?.clarifying_question ||
    slackAgentAnalysis?.summary ||
    fallbackText ||
    intake.replyText ||
    '我已记录这轮消息，但还需要再确认一下需求。'
  );
}

function handleCloseSlackSession({ store, intake, slackSession, sessionMemory, agentRun, slackAgentAnalysis }) {
  const closedSession = store.closeSlackSession(slackSession.id);
  store.updateSessionMemory(slackSession.id, {
    summary: sessionMemory.summary || intake.text,
    lastAgentResponse: '会话已关闭。',
    pendingQuestions: [],
  });
  completeSlackAgentRun(store, agentRun, {
    report: {
      action: 'close_session',
      accepted: true,
      intent: slackAgentAnalysis?.intent || null,
    },
  });

  return jsonResponse({
    ok: true,
    action: 'close_session',
    accepted: true,
    slackSessionId: slackSession.id,
    agentRunId: agentRun?.id,
    replyText: '已关闭当前会话。后续你可以用 `issue: ...` 开一个新任务，或者带上 job id 查询旧任务。',
    session: closedSession,
  });
}

function handleSlackAgentStatusQuery({ store, intake, slackSession, sessionMemory, agentRun, slackAgentAnalysis }) {
  const job = activeJobForSlackSession(store, slackSession);
  const replyText = job
    ? slackStatusReply(job.id, job)
    : '我还没有在当前会话里找到发布任务。你可以带上 job id，例如 `status: job_xxx`。';

  store.updateSessionMemory(slackSession.id, {
    summary: slackAgentAnalysis?.summary || sessionMemory.summary || intake.text,
    lastAgentResponse: replyText,
  });
  completeSlackAgentRun(store, agentRun, {
    publishingJobId: job?.id || null,
    provider: slackAgentAnalysis?.modelProvider || (slackAgentAnalysis ? 'unknown' : 'deterministic'),
    model: slackAgentAnalysis?.modelName || null,
    modelApiStyle: slackAgentAnalysis?.modelApiStyle || null,
    report: {
      action: 'status_query',
      accepted: false,
      intent: slackAgentAnalysis?.intent || null,
    },
  });

  return jsonResponse({
    ok: true,
    action: 'status_query',
    accepted: false,
    replyText,
    slackSessionId: slackSession.id,
    agentRunId: agentRun?.id,
    ...(slackAgentAnalysis ? { slackAgentAnalysis } : {}),
  });
}

function handleSlackAgentNonPublishingTurn({
  store,
  intake,
  slackSession,
  sessionMemory,
  agentRun,
  slackAgentAnalysis,
  action,
  replyText,
}) {
  const finalReplyText = slackAgentReplyText(intake, slackAgentAnalysis, replyText);
  store.updateSessionMemory(slackSession.id, {
    summary: slackAgentAnalysis?.summary || sessionMemory.summary || intake.text,
    requirements: slackAgentAnalysis || sessionMemory.requirements || {},
    lastAgentResponse: finalReplyText,
    pendingQuestions: slackAgentAnalysis?.needsClarification ? [finalReplyText] : sessionMemory.pendingQuestions || [],
  });
  completeSlackAgentRun(store, agentRun, {
    provider: slackAgentAnalysis?.modelProvider || (slackAgentAnalysis ? 'unknown' : 'deterministic'),
    model: slackAgentAnalysis?.modelName || null,
    modelApiStyle: slackAgentAnalysis?.modelApiStyle || null,
    report: {
      action,
      accepted: false,
      slackAgentUsed: Boolean(slackAgentAnalysis),
      intent: slackAgentAnalysis?.intent || null,
      needsClarification: Boolean(slackAgentAnalysis?.needsClarification),
    },
  });
  console.log(
    JSON.stringify({
      service: 'pages-gateway',
      message: 'slack_agent_turn_recorded',
      action,
      intent: slackAgentAnalysis?.intent || null,
      needsClarification: Boolean(slackAgentAnalysis?.needsClarification),
      text: intake.text,
    })
  );

  return jsonResponse({
    ok: true,
    action,
    accepted: false,
    replyText: finalReplyText,
    slackSessionId: slackSession.id,
    agentRunId: agentRun?.id,
    ...(slackAgentAnalysis ? { slackAgentAnalysis } : {}),
  });
}

async function handleSlackFollowup({ store, env, intake, slackSession, sessionMemory, agentRun, slackAgentAnalysis }) {
  const job = activeJobForSlackSession(store, slackSession);
  const feedback = slackAgentAnalysis?.summary || intake.text;

  if (!job) {
    completeSlackAgentRun(store, agentRun, {
      report: { action: 'followup_missing_job', accepted: false },
    });
    return jsonResponse({
      ok: true,
      action: 'followup_missing_job',
      accepted: false,
      replyText: '我找到了当前会话，但没有找到可继续修改的发布任务。可以用 `issue: ...` 新开一个任务。',
      slackSessionId: slackSession.id,
      agentRunId: agentRun?.id,
    });
  }

  const patch = {
    intent: slackAgentAnalysis?.intent || 'modify_existing_preview',
    title: slackAgentAnalysis?.title || job.title,
    summary: followupSummary(job.summary, feedback),
  };
  store.updateSessionMemory(slackSession.id, {
    summary: followupSummary(sessionMemory.summary, feedback),
    requirements: slackAgentAnalysis || { text: intake.text, action: 'followup' },
    lastPreviewFeedback: feedback,
    lastAgentResponse: null,
  });

  let updatedJob = null;
  let workerStart = null;
  let action = 'followup_recorded';
  let replyText = `收到，已把这轮修改意见关联到 ${job.id}。`;

  if (canDispatchFixForJob(job)) {
    updatedJob = store.moveJobToFixing(job.id, patch);
    if (updatedJob) {
      store.linkJobToSlackSession(updatedJob, slackSession);
      workerStart = await startWorkerForJobIfConfigured(updatedJob, env);
      action = workerStart?.started ? 'followup_fix_dispatched' : 'followup_fix_ready';
      replyText = workerStart?.started
        ? `收到，已把修改意见追加到 ${job.id}，并启动同一个 PR 的修复轮次。`
        : `收到，已把修改意见追加到 ${job.id}，等待 worker 启动修复轮次。`;
    }
  }

  if (!updatedJob) {
    updatedJob = store.patchJob(job.id, patch);
    store.linkJobToSlackSession(updatedJob, slackSession);
    replyText = `收到，已记录到 ${job.id}。当前任务还在 ${job.status}，会优先保留在同一个会话里。`;
  }

  completeSlackAgentRun(store, agentRun, {
    publishingJobId: updatedJob.id,
    provider: slackAgentAnalysis?.modelProvider || (slackAgentAnalysis ? 'unknown' : 'deterministic'),
    model: slackAgentAnalysis?.modelName || null,
    modelApiStyle: slackAgentAnalysis?.modelApiStyle || null,
    report: {
      action,
      accepted: true,
      intent: slackAgentAnalysis?.intent || null,
    },
  });

  console.log(
    JSON.stringify({
      service: 'pages-gateway',
      message: 'slack_followup_recorded',
      action,
      jobId: updatedJob.id,
      slackSessionId: slackSession.id,
      workerStarted: workerStart?.started ?? null,
      workerError: workerStart?.error || null,
    })
  );

  return jsonResponse({
    ok: true,
    action,
    accepted: true,
    jobId: updatedJob.id,
    slackSessionId: slackSession.id,
    agentRunId: agentRun?.id,
    replyText,
    job: updatedJob,
    ...(slackAgentAnalysis ? { slackAgentAnalysis } : {}),
    ...(workerStart ? { workerStart } : {}),
  });
}

function completeSlackAgentRun(store, agentRun, patch = {}) {
  if (!agentRun) return null;
  return store.completeAgentRun(agentRun.id, patch);
}

export async function handleHealth() {
  return jsonResponse({ status: 'ok', service: 'pages-gateway' });
}

export async function handleCreatePublishingJob(request, env) {
  const store = getStore(env);
  const body = await readJson(request);
  const { job, created } = store.createJob(normalizePublishingJobInput(body, request));
  const workerStart = created ? await startWorkerForJobIfConfigured(job, env) : null;

  return jsonResponse({ job, created, ...(workerStart ? { workerStart } : {}) }, created ? 201 : 200);
}

export async function handleGetPublishingJob(_request, env, params) {
  const job = getStore(env).getJob(params.jobId);
  if (!job) return jsonResponse({ error: 'PublishingJob not found' }, 404);
  return jsonResponse({ job });
}

export async function handleGetPublishingJobEvents(_request, env, params) {
  const store = getStore(env);
  if (!store.getJob(params.jobId)) return jsonResponse({ error: 'PublishingJob not found' }, 404);
  return jsonResponse({ events: store.listEvents(params.jobId) });
}

export async function handleSlackEvents(request, env) {
  requireSlackConnectorAuth(request, env);

  const store = getStore(env);
  const body = await readJson(request);

  if (body.type === 'url_verification' && body.challenge) {
    return jsonResponse({ challenge: body.challenge });
  }

  const intake = classifySlackIntake(body);
  if (isUnaddressedChannelThreadMessage(body) && !existingSlackThreadSession(store, body)) {
    return jsonResponse({
      ok: true,
      action: 'ignored_untracked_thread_message',
      accepted: false,
      reply: false,
    });
  }

  const sessionSelection = selectSlackSession(store, body, intake, env);

  if (sessionSelection.ambiguous) {
    return jsonResponse({
      ok: true,
      action: sessionSelection.action,
      accepted: false,
      replyText: sessionSelection.replyText,
      sessions: sessionSelection.sessions.map((session) => ({
        id: session.id,
        title: session.sessionTitle,
        activeJobId: session.activeJobId,
        activeIssueNumber: session.activeIssueNumber,
        activePrNumber: session.activePrNumber,
        activePreviewUrl: session.activePreviewUrl,
      })),
    });
  }

  const slackSession = sessionSelection.session;
  const sessionMemory = sessionSelection.memory;
  const lease = slackSession ? store.acquireSlackAgentLease(slackSession.id, sessionSelection.config) : null;

  if (lease && !lease.acquired) {
    return jsonResponse({
      ok: true,
      action: 'agent_busy',
      accepted: false,
      replyText: '上一轮会话还在处理中，请稍等一下再发。',
      slackSessionId: slackSession.id,
      agentRunId: lease.agentRun.id,
    });
  }

  const agentRun = lease?.agentRun || null;

  if (intake.action === 'status') {
    completeSlackAgentRun(store, agentRun, {
      report: { action: intake.action, jobId: intake.jobId || null },
    });
    return jsonResponse({
      ok: true,
      action: intake.action,
      accepted: false,
      replyText: intake.jobId ? slackStatusReply(intake.jobId, store.getJob(intake.jobId)) : intake.replyText,
      ...(slackSession ? { slackSessionId: slackSession.id } : {}),
      ...(agentRun ? { agentRunId: agentRun.id } : {}),
    });
  }

  try {
    let slackAgentAnalysis = null;
    if (intake.action === 'close_session') {
      return handleCloseSlackSession({
        store,
        intake,
        slackSession,
        sessionMemory,
        agentRun,
        slackAgentAnalysis,
      });
    }

    if (shouldAnalyzeSlackTurn(intake, slackSession)) {
      slackAgentAnalysis = await analyzeSlackEventIfConfigured(body, intake, env, {
        slackSession,
        sessionMemory,
        issueLinks: store.findIssueLinksForSlackSession(slackSession.id),
        agentRun,
      });

      if (shouldCloseSlackSession(intake, slackAgentAnalysis)) {
        return handleCloseSlackSession({
          store,
          intake,
          slackSession,
          sessionMemory,
          agentRun,
          slackAgentAnalysis,
        });
      }

      if (slackAgentAnalysis?.intent === 'status_query') {
        return handleSlackAgentStatusQuery({
          store,
          intake,
          slackSession,
          sessionMemory,
          agentRun,
          slackAgentAnalysis,
        });
      }

      if (slackAgentAnalysis?.intent === 'cancel_request') {
        return handleSlackAgentNonPublishingTurn({
          store,
          intake,
          slackSession,
          sessionMemory,
          agentRun,
          slackAgentAnalysis,
          action: 'cancel_request',
          replyText: '收到取消意图。当前 MVP 还没有自动取消 job；如果已经创建了 issue，可以先在 issue 里补充“取消”。',
        });
      }

      if (hasActiveSlackTarget(slackSession) && isSlackFollowupIntent(slackAgentAnalysis, intake)) {
        return handleSlackFollowup({
          store,
          env,
          intake,
          slackSession,
          sessionMemory,
          agentRun,
          slackAgentAnalysis,
        });
      }
    }

    if (slackAgentAnalysis?.needsClarification) {
      return handleSlackAgentNonPublishingTurn({
        store,
        intake,
        slackSession,
        sessionMemory,
        agentRun,
        slackAgentAnalysis,
        action: 'clarification_needed',
      });
    }

    if (!shouldCreateSlackJob(intake, slackAgentAnalysis)) {
      return handleSlackAgentNonPublishingTurn({
        store,
        intake,
        slackSession,
        sessionMemory,
        agentRun,
        slackAgentAnalysis,
        action: slackAgentAnalysis ? 'agent_turn_recorded' : intake.action,
      });
    }

    store.updateSessionMemory(slackSession.id, {
      summary: slackAgentAnalysis?.summary || intake.text,
      requirements: slackAgentAnalysis || { text: intake.text, action: intake.action },
      lastAgentResponse: slackAgentAnalysis?.needsClarification ? slackAgentAnalysis.summary : null,
    });
    const { job, created } = store.createJob(slackJobInput({ ...body, intake, slackAgentAnalysis, slackSession }));
    const issueLink = store.linkJobToSlackSession(job, slackSession);
    const slackStatusNotification = created
      ? await notifySlackJobStatus(env, store, job, {
          stage: 'received',
          agentRunId: agentRun?.id || null,
          text: '已收到 Slack 发布需求，正在整理任务。',
          statusText: ':hourglass_flowing_sand: 我已收到需求，正在整理...',
        })
      : null;
    const workerStart = created ? await startWorkerForJobIfConfigured(job, env) : null;
    completeSlackAgentRun(store, agentRun, {
      publishingJobId: job.id,
      provider: slackAgentAnalysis?.modelProvider || (slackAgentAnalysis ? 'unknown' : 'deterministic'),
      model: slackAgentAnalysis?.modelName || null,
      modelApiStyle: slackAgentAnalysis?.modelApiStyle || null,
      report: {
        action: intake.action,
        accepted: true,
        slackAgentUsed: Boolean(slackAgentAnalysis),
        intent: slackAgentAnalysis?.intent || null,
        modelApiStyle: slackAgentAnalysis?.modelApiStyle || null,
      },
    });
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_job_created',
        action: intake.action,
        jobId: job.id,
        created,
        slackSessionId: slackSession.id,
        slackAgentUsed: Boolean(slackAgentAnalysis),
        workerStarted: workerStart?.started ?? null,
        workerError: workerStart?.error || null,
      })
    );
    return jsonResponse({
      ok: true,
      action: intake.action,
      accepted: true,
      jobId: job.id,
      slackSessionId: slackSession.id,
      agentRunId: agentRun?.id,
      issueLink,
      created,
      ...(slackStatusNotification ? { slackStatusNotification } : {}),
      ...(slackAgentAnalysis ? { slackAgentAnalysis } : {}),
      ...(workerStart ? { workerStart } : {}),
    });
  } catch (err) {
    if (agentRun) {
      store.failAgentRun(agentRun.id, 'slack_agent_failed', err.message);
    }
    throw err;
  }
}

export async function handleExecutorCallback(request, env) {
  if (env.INTERNAL_CALLBACK_TOKEN) {
    const token = request.headers.get('X-Pages-Callback-Token');
    if (token !== env.INTERNAL_CALLBACK_TOKEN) {
      return jsonResponse({ error: 'Invalid callback token' }, 401);
    }
  }

  const body = await readJson(request);
  const jobId = required(body.publishingJobId || body.publishing_job_id, 'publishingJobId');

  if (body.status === 'failed') {
    const store = getStore(env);
    const job = store.failJob(jobId, body.errorCode || body.error_code, body.errorMessage || body.error_message);
    if (!job) return jsonResponse({ error: 'PublishingJob not found' }, 404);
    store.linkJobToSlackSession(job);
    const slackStatusNotification = await notifySlackJobStatus(env, store, job, {
      stage: 'failed',
      text: job.errorMessage || job.errorCode || '发布任务失败',
      statusText: ':x: 发布任务失败',
    });
    const slackNotification = await notifySlackJob(
      env,
      store,
      job,
      `失败：${job.errorMessage || job.errorCode || '发布任务失败'}`,
      `failed:${job.errorCode || 'unknown'}`
    );
    return jsonResponse({
      job,
      ...(slackStatusNotification ? { slackStatusNotification } : {}),
      ...(slackNotification ? { slackNotification } : {}),
    });
  }

  const stageResult = required(body.stageResult || body.stage_result, 'stageResult');
  const rule = CALLBACK_STAGE_RESULTS[stageResult];
  if (!rule) return jsonResponse({ error: 'Unsupported stageResult', stageResult }, 400);

  const patch = rule.patch ? rule.patch(body) : {};
  const store = getStore(env);
  const job = applyExecutorCallback(store, jobId, stageResult, rule.status, patch);
  if (!job) return jsonResponse({ error: 'PublishingJob not found' }, 404);
  store.linkJobToSlackSession(job);
  const workerStart = await startWorkerForJobIfConfigured(job, env);
  const slackStatusNotification = await notifySlackJobStatus(env, store, job, {
    stage: stageResult,
    text: notificationTextForCallback(stageResult, job) || `PublishingJob moved to ${job.status}`,
  });
  const slackText = notificationTextForCallback(stageResult, job);
  const slackNotification = await notifySlackJob(env, store, job, slackText, `callback:${stageResult}`);

  return jsonResponse({
    job,
    ...(workerStart ? { workerStart } : {}),
    ...(slackStatusNotification ? { slackStatusNotification } : {}),
    ...(slackNotification ? { slackNotification } : {}),
  });
}

export async function handleGithubWebhook(request, env) {
  const rawBody = await request.text();
  await verifyGithubWebhookSignature(request, env, rawBody);
  const body = parseJsonText(rawBody);
  const repoFullName = body.repository?.full_name || request.headers.get('X-GitHub-Repository') || 'unknown/repo';
  const deliveryId = required(request.headers.get('X-GitHub-Delivery') || body.deliveryId, 'deliveryId');
  const eventName = request.headers.get('X-GitHub-Event') || body.eventName || 'unknown';
  const action = body.action || null;
  const store = getStore(env);
  const result = store.recordGithubDelivery({ repoFullName, deliveryId, eventName, action });

  if (!result.created) {
    return jsonResponse({ ok: true, created: false, delivery: result.delivery });
  }

  if (eventName === 'issues') {
    return handleGithubIssueWebhook({ body, action, store, env, result });
  }

  const normalized = normalizeReviewAgentWebhook(body, eventName, deliveryId, repoFullName);
  if (!normalized) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'unsupported_event' });
  }

  if (!isAllowedReviewAgent(normalized, env)) {
    return jsonResponse({
      ok: true,
      created: true,
      delivery: result.delivery,
      ignored: 'review_agent_not_allowed',
      reviewAgentLogin: normalized.reviewAgentLogin,
    });
  }

  const reviewComment = store.recordReviewAgentComment(normalized);
  const job = store.findJobByPrNumber(normalized.prNumber, { headSha: normalized.headSha });
  const gate = store.reviewGateForPr(
    repoFullName,
    normalized.prNumber,
    normalized.headSha ? { headSha: normalized.headSha } : {}
  );
  let updatedJob = job;
  let workerStart = null;
  let reviewAction = 'recorded';
  let slackStatusNotification = null;
  let slackNotification = null;

  const fullHeadSha = normalized.headSha && normalized.headSha.length === 40 ? normalized.headSha : null;

  if (updatedJob && fullHeadSha && updatedJob.headSha !== fullHeadSha) {
    updatedJob = store.patchJob(updatedJob.id, { headSha: fullHeadSha });
  }

  if (updatedJob && updatedJob.status === 'pr_created') {
    updatedJob = store.updateJob(updatedJob.id, 'reviewing', fullHeadSha ? { headSha: fullHeadSha } : {});
    reviewAction = 'reviewing';
  }

  if (updatedJob && gate.blockingCount > 0 && ['reviewing', 'changes_requested'].includes(updatedJob.status)) {
    updatedJob =
      updatedJob.status === 'changes_requested'
        ? updatedJob
        : store.updateJob(updatedJob.id, 'changes_requested', fullHeadSha ? { headSha: fullHeadSha } : {});
    reviewAction = 'changes_requested';
  } else if (
    updatedJob &&
    gate.canPreview &&
    ['review_summary', 'issue_comment'].includes(normalized.sourceType) &&
    ['note', 'suggestion'].includes(normalized.classification) &&
    ['pr_created', 'reviewing'].includes(updatedJob.status)
  ) {
    updatedJob = store.updateJob(updatedJob.id, 'previewing', fullHeadSha ? { headSha: fullHeadSha } : {});
    workerStart = await startWorkerForJobIfConfigured(updatedJob, env);
    reviewAction = 'preview_dispatched';
  }

  if (updatedJob) {
    store.linkJobToSlackSession(updatedJob);
    slackStatusNotification = await notifySlackJobStatus(env, store, updatedJob, {
      stage: updatedJob.status,
      text: notificationTextForReviewAction(reviewAction, { gate, reviewComment: reviewComment.comment }) || reviewAction,
    });
    slackNotification = await notifySlackJob(
      env,
      store,
      updatedJob,
      notificationTextForReviewAction(reviewAction, { gate, reviewComment: reviewComment.comment }),
      `review:${reviewAction}:${normalized.githubCommentNodeId}`
    );
  }

  return jsonResponse({
    ok: true,
    created: true,
    delivery: result.delivery,
    reviewAction,
    reviewComment: reviewComment.comment,
    reviewCommentCreated: reviewComment.created,
    gate,
    ...(updatedJob ? { job: updatedJob } : {}),
    ...(workerStart ? { workerStart } : {}),
    ...(slackStatusNotification ? { slackStatusNotification } : {}),
    ...(slackNotification ? { slackNotification } : {}),
  });
}
