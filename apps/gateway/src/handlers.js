import { jsonResponse } from '@xd/worker-kit';

import {
  classifyReviewAgentComment,
  isAllowedReviewAgent,
  isAllowedSiteCheckRun,
  normalizeReviewAgentWebhook,
  normalizeSiteCheckRunWebhook,
} from './github-review.js';
import { readSlackRequest, slackAckResponse, slackChallengeResponse } from './slack-http.js';
import { classifySlackIntake, slackStatusReply } from './slack-intake.js';
import {
  addSlackReaction,
  mentionSlackUser,
  notificationTextForCallback,
  notificationTextForReviewAction,
  notifySlackJob,
  notifySlackJobStatus,
  postSlackMessage,
} from './slack-notifier.js';
import { selectSlackSession, slackActorFromBody, slackUserIdFromBody, surfaceForSlackBody } from './slack-session.js';

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
  const surface = surfaceForSlackBody(body);
  return event.type === 'message' && surface.channelType !== 'im' && Boolean(event.thread_ts);
}

async function existingSlackThreadSession(store, body = {}) {
  const actor = slackActorFromBody(body);
  const surface = surfaceForSlackBody(body);
  const sessionKey = `thread:${surface.channelId || 'unknown'}:${surface.threadTs || surface.messageTs || 'unknown'}`;
  return store.findSlackSessionByScope ? await store.findSlackSessionByScope(actor.teamId, actor.slackUserId, sessionKey) : null;
}

function publishingJobIdFromIssueBody(body) {
  const match = String(body || '').match(/^PublishingJob:\s*(job_[A-Za-z0-9_]{1,80})\s*$/m);
  return match ? match[1] : '';
}

function issueUrl(issue = {}) {
  return issue.html_url || issue.url || null;
}

async function applyExecutorCallback(store, jobId, stageResult, status, patch) {
  const existing = await store.getJob(jobId);
  if (!existing) return null;

  if (STALE_CALLBACK_PATCH_STATUSES[stageResult]?.has(existing.status)) {
    return await store.patchJob(jobId, patch);
  }

  return await store.updateJob(jobId, status, patch);
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

  let job = await store.getJob(jobId);
  if (!job) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'job_not_found', jobId });
  }

  const issueNumber = issue.number || null;
  if (job.issueNumber && issueNumber && Number(job.issueNumber) !== Number(issueNumber)) {
    return jsonResponse({ ok: true, created: true, delivery: result.delivery, ignored: 'issue_number_mismatch', job });
  }

  if (!job.issueNumber || ['received', 'issue_creating'].includes(job.status)) {
    job = await store.updateJob(job.id, 'issue_created', {
      issueNumber,
      issueUrl: issueUrl(issue),
    });
  }
  await store.linkJobToSlackSession(job);

  let workerStart = null;
  let issueAction = 'recorded';

  if (job.status === 'issue_created') {
    job = await store.updateJob(job.id, 'generating_page');
    await store.linkJobToSlackSession(job);
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

function shouldDispatchPreviewForReview(updatedJob, normalized, gate) {
  if (!updatedJob || updatedJob.previewUrl || !gate.canPreview) return false;
  if (!['review_summary', 'issue_comment'].includes(normalized.sourceType)) return false;
  if (!['note', 'suggestion'].includes(normalized.classification)) return false;
  return ['pr_created', 'reviewing', 'changes_requested', 'previewing'].includes(updatedJob.status);
}

function shouldReportSiteCheckWaiting(updatedJob, normalized, gate) {
  if (!updatedJob || updatedJob.previewUrl || gate.canPreview) return false;
  if (gate.blockingCount > 0 || gate.unknownCount > 0) return false;
  if (gate.siteCheck?.passed) return false;
  if (!['review_summary', 'issue_comment'].includes(normalized.sourceType)) return false;
  if (!['note', 'suggestion'].includes(normalized.classification)) return false;
  return ['pr_created', 'reviewing', 'changes_requested', 'previewing'].includes(updatedJob.status);
}

async function previewGateForPr(store, repoFullName, prNumber, options = {}) {
  if (store.previewGateForPr) return await store.previewGateForPr(repoFullName, prNumber, options);

  const reviewGate = await store.reviewGateForPr(repoFullName, prNumber, options);
  const siteCheckGate = store.siteCheckGateForPr
    ? await store.siteCheckGateForPr(repoFullName, prNumber, options)
    : { required: true, passed: false, status: 'missing', conclusion: null };
  return {
    ...reviewGate,
    reviewGate,
    siteCheck: siteCheckGate,
    siteCheckPassed: siteCheckGate.passed,
    canPreview: reviewGate.canPreview && siteCheckGate.passed,
  };
}

function repoFullNameForJob(job, env) {
  if (env.GITHUB_REPO) return env.GITHUB_REPO;

  for (const value of [job.prUrl, job.issueUrl]) {
    if (!value) continue;
    try {
      const url = new URL(value);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    } catch {
      // Ignore malformed stored URLs.
    }
  }

  return null;
}

async function previewTriggerFromStoredReviews(store, job, env) {
  if (!job?.prNumber || job.previewUrl) return null;
  if (!['pr_created', 'reviewing', 'changes_requested', 'previewing'].includes(job.status)) return null;

  const repoFullName = repoFullNameForJob(job, env);
  if (!repoFullName) return null;

  const options = job.headSha ? { headSha: job.headSha } : {};
  const gate = await previewGateForPr(store, repoFullName, job.prNumber, options);
  if (!gate.canPreview) return null;

  const comments = await store.listReviewAgentComments(repoFullName, job.prNumber, options);
  const reviewComment = comments.find((comment) => {
    if (comment.status !== 'open') return false;
    if (!['review_summary', 'issue_comment'].includes(comment.sourceType)) return false;
    return ['note', 'suggestion'].includes(classifyReviewAgentComment(comment));
  });

  return reviewComment ? { gate, reviewComment } : null;
}

async function dispatchPreviewFromStoredReviewIfReady(job, store, env) {
  const trigger = await previewTriggerFromStoredReviews(store, job, env);
  if (!trigger) return null;

  const updatedJob =
    job.status === 'previewing' ? job : await store.updateJob(job.id, 'previewing', job.headSha ? { headSha: job.headSha } : {});
  const workerStart = await startWorkerForJobIfConfigured(updatedJob, env);

  return {
    reviewAction: 'preview_dispatched',
    job: updatedJob,
    workerStart,
    gate: trigger.gate,
    reviewComment: trigger.reviewComment,
  };
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
    requesterProfile: body.requesterProfile || body.requester_profile || null,
  };
}

function stableSlugHash(value = '') {
  let hash = 2166136261;
  for (const char of String(value || '')) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36).padStart(6, '0').slice(0, 6);
}

function slugSegment(value, fallback, maxLength = 48) {
  const normalized = String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replaceAll(/[\u0300-\u036f]/g, '')
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .replaceAll(/-{2,}/g, '-');
  const slug = normalized || fallback;
  return slug.slice(0, maxLength).replaceAll(/-+$/g, '') || fallback;
}

function requesterSlugBase(profileInput = {}, slackUserId) {
  const profile = profileInput || {};
  const email = String(profile.email || '')
    .trim()
    .toLowerCase();
  if (email.includes('@')) return email.split('@')[0].split('+')[0];
  return profile.displayName || profile.display_name || profile.realName || profile.real_name || profile.name || slackUserId;
}

function employeeSlugForSlack({ teamId, slackUserId, requesterProfile }) {
  const identityKey = `${teamId || 'unknown-team'}:${slackUserId || 'unknown-user'}`;
  const suffix = stableSlugHash(identityKey);
  const base = slugSegment(requesterSlugBase(requesterProfile, slackUserId), 'slack-user', 40);
  return `${base}-${suffix}`;
}

function siteSlugForSlack(analysis = {}, body = {}) {
  return slugSegment(analysis.siteSlug || analysis.site_slug || body.siteSlug || body.site_slug || 'profile', 'profile', 72);
}

function slackJobInput(body) {
  const event = body.event || {};
  const analysis = body.slackAgentAnalysis || {};
  const slackSession = body.slackSession || null;
  const teamId = body.team_id || body.team?.id || 'unknown-team';
  const slackUserId = slackUserIdFromBody(body);
  const intake = body.intake || classifySlackIntake(body);
  const surface = surfaceForSlackBody(body);
  const text = intake.text || event.text || body.text || '';
  const idempotencyKey = body.event_id || body.trigger_id || `${teamId}:${event.ts || body.event_ts || Date.now()}`;
  const requesterProfile = body.requesterProfile || body.requester_profile || null;

  return {
    source: 'slack',
    requestedByType: 'user',
    requestedById: `slack:${teamId}:${slackUserId}`,
    idempotencyKey,
    employeeSlug: employeeSlugForSlack({ teamId, slackUserId, requesterProfile }),
    siteSlug: siteSlugForSlack(analysis, body),
    intent: analysis.intent || 'create_site',
    approvalMode: analysis.approvalMode || body.approvalMode || body.approval_mode || 'manual_required',
    title: body.title || analysis.title || text.slice(0, 80) || 'Slack publishing request',
    summary: body.summary || analysis.summary || text,
    requesterProfile,
    slackSessionId: slackSession?.id || body.slackSessionId || null,
    slackSessionKey: slackSession?.sessionKey || body.slackSessionKey || null,
    slackThread: {
      teamId,
      channelId: surface.channelId,
      channelType: surface.channelType,
      messageTs: surface.messageTs,
      threadTs: surface.threadTs,
      userId: slackUserId,
    },
  };
}

function slackJobVisibleToActor(job, body) {
  if (!job) return true;
  const actor = slackActorFromBody(body);
  return job.source === 'slack' && job.requestedById === actor.requestedById;
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
  if (analysis?.intent) return CREATE_JOB_INTENTS.has(analysis.intent) && looksLikeSlackFollowupText(intake.text);
  return looksLikeSlackFollowupText(intake.text);
}

async function activeJobForSlackSession(store, slackSession) {
  if (slackSession?.activeJobId) {
    const job = await store.getJob(slackSession.activeJobId);
    if (job) return job;
  }

  const links = await store.findIssueLinksForSlackSession(slackSession.id);
  const link = links[0];
  return link?.publishingJobId ? await store.getJob(link.publishingJobId) : null;
}

function followupSummary(existingSummary, text) {
  const cleanText = String(text || '').trim();
  if (!cleanText) return existingSummary || '';
  const previous = String(existingSummary || '').trim();
  const block = ['## Slack Follow-up', '', cleanText].join('\n');
  return previous ? `${previous}\n\n${block}` : block;
}

function redactSecretLikeText(text = '') {
  return String(text || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{8,})\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/\b(xapp-[A-Za-z0-9-]{8,})\b/g, '[REDACTED_SLACK_APP_TOKEN]')
    .replace(/\b(ghp_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_API_KEY]')
    .replace(/("(?:api[_-]?key|token|secret|password|passwd|pwd)"\s*:\s*")[^"]+(")/gi, '$1[REDACTED_SECRET]$2')
    .replace(/\b(api[_-]?key|token|secret|password|passwd|pwd)\b\s*[:=]\s*["']?[^"',\s}]+/gi, '$1=[REDACTED_SECRET]');
}

function redactSlackAnalysisValue(value) {
  if (typeof value === 'string') return redactSecretLikeText(value);
  if (Array.isArray(value)) return value.map((item) => redactSlackAnalysisValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactSlackAnalysisValue(entry)]));
  }
  return value;
}

function redactSlackAnalysis(analysis) {
  return analysis ? redactSlackAnalysisValue(analysis) : analysis;
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

function explicitSlackCreateConfirmation(text = '') {
  return /(?:信息|需求|内容).{0,8}(?:足够|完整|明确)|(?:直接|马上|现在).{0,8}(?:创建|提交|开始)|(?:确认|可以|同意).{0,8}(?:创建|提交|开始|发布)|(?:创建|提交|开始).{0,8}(?:发布任务|issue|任务)|(?:生成|创建).{0,8}(?:preview|预览)|go ahead|ship it/i.test(
    text
  );
}

function shouldAskBeforeCreatingIssue(intake, slackAgentAnalysis, slackSession) {
  if (!slackAgentAnalysis || slackAgentAnalysis.needsClarification) return false;
  if (!CREATE_JOB_INTENTS.has(slackAgentAnalysis.intent)) return false;
  if (intake.command) return false;
  if (!['agent_turn', 'create_job'].includes(intake.action)) return false;
  if (hasActiveSlackTarget(slackSession)) return false;
  return !explicitSlackCreateConfirmation(intake.text);
}

function slackIssueConfirmationText(slackAgentAnalysis = {}) {
  const summary = String(slackAgentAnalysis.summary || '').trim();
  const site = String(slackAgentAnalysis.siteSlug || slackAgentAnalysis.site_slug || 'profile').trim();
  const title = String(slackAgentAnalysis.title || '').trim();
  const lines = ['我先整理一下，目前还不会创建 issue：'];
  if (title) lines.push(`标题：${title}`);
  if (site) lines.push(`站点：${site}`);
  if (summary) lines.push(`需求摘要：${summary}`);
  lines.push('如果确认无误，请回复“确认创建发布任务”；如果还想调整，直接继续补充需求。');
  return lines.join('\n');
}

function slackAgentReplyText(intake, slackAgentAnalysis, fallbackText = null, options = {}) {
  return redactSecretLikeText(
    (options.preferFallback ? fallbackText : null) ||
      slackAgentAnalysis?.clarifyingQuestion ||
      slackAgentAnalysis?.clarifying_question ||
      slackAgentAnalysis?.summary ||
      fallbackText ||
      intake.replyText ||
      '我已记录这轮消息，但还需要再确认一下需求。'
  );
}

function slackEventId(body = {}) {
  return body.event_id || body.trigger_id || body.event?.client_msg_id || null;
}

function inferSlackChannelType(event = {}) {
  if (event.channel_type) return event.channel_type;
  return String(event.channel || '').startsWith('D') ? 'im' : null;
}

function ignoredSlackEventReason(body = {}) {
  const event = body.event || {};
  if (body.type && body.type !== 'event_callback') return null;
  if (event.subtype && event.subtype !== 'bot_message') return `ignored_subtype:${event.subtype}`;
  if (event.bot_id || event.subtype === 'bot_message') return 'ignored_bot_event';
  if (event.type === 'app_mention') return null;
  if (event.type === 'message' && inferSlackChannelType(event) === 'im') return null;
  if (event.type === 'message' && event.thread_ts) return null;
  return 'unsupported_event';
}

function shouldPostSlackResultReply(result = {}) {
  if (!result.replyText) return false;
  if (result.reply === false || result.noReply) return false;
  if (result.action === 'ignored_untracked_thread_message') return false;
  return true;
}

function slackDeliveryContextFromBody(body = {}) {
  const event = body.event || {};
  const surface = surfaceForSlackBody(body);
  return {
    teamId: body.team_id || body.team?.id || event.team || 'unknown-team',
    eventId: slackEventId(body) || 'unknown-event',
    channelId: surface.channelId || null,
    threadTs: surface.threadTs || surface.messageTs || null,
    slackUserId: slackUserIdFromBody(body, null),
    requestId: body.event_context || body.trigger_id || null,
  };
}

function slackResultType(result = {}) {
  if (result.action === 'close_session') return 'session_closed';
  if (result.action === 'clarification_needed') return 'clarification_requested';
  if (result.action === 'status' || result.action === 'status_query') return 'status_returned';
  if (String(result.action || '').startsWith('followup_')) return 'followup_appended';
  if (result.jobId) return 'job_created';
  if (result.replyText) return 'agent_replied';
  return 'none';
}

function slackProcessingStatus(result = {}, overrides = {}) {
  if (overrides.processingStatus) return overrides.processingStatus;
  if (result.action === 'ignored_slack_event' || result.action === 'ignored_untracked_thread_message') return 'ignored';
  return 'processed';
}

function slackDeliveryPatchForResult(result = {}, overrides = {}) {
  const processingStatus = slackProcessingStatus(result, overrides);
  return {
    processingStatus,
    resultType: overrides.resultType || slackResultType(result),
    ignoredReason:
      overrides.ignoredReason || (processingStatus === 'ignored' ? result.reason || result.action || 'ignored' : null),
    errorCode: overrides.errorCode || null,
    errorMessage: overrides.errorMessage || null,
    slackSessionId: result.slackSessionId || null,
    publishingJobId: result.jobId || null,
    agentRunId: result.agentRunId || null,
  };
}

function canSendSlackOutput(env = {}) {
  const hasNotifierUrl = Boolean(env.SLACK_NOTIFIER_URL || env.PAGES_SLACK_NOTIFIER_URL);
  const hasNotifierSecret = Boolean(env.SLACK_NOTIFIER_SHARED_SECRET || env.PAGES_SLACK_NOTIFIER_SHARED_SECRET);
  return Boolean(env.SLACK_BOT_TOKEN || (hasNotifierUrl && hasNotifierSecret));
}

function slackApiMethodUrl(env = {}, method) {
  if (env.SLACK_API_BASE_URL) {
    return `${String(env.SLACK_API_BASE_URL).replace(/\/+$/, '')}/${method}`;
  }

  return String(env.SLACK_API_URL || 'https://slack.com/api/chat.postMessage').replace(/\/chat\.postMessage$/, `/${method}`);
}

function remoteSlackNotifierUrl(env = {}, path) {
  const base = env.SLACK_NOTIFIER_URL || env.PAGES_SLACK_NOTIFIER_URL;
  if (!base) return null;
  return `${String(base).replace(/\/+$/, '')}${path}`;
}

function remoteSlackNotifierToken(env = {}) {
  return env.SLACK_NOTIFIER_SHARED_SECRET || env.PAGES_SLACK_NOTIFIER_SHARED_SECRET;
}

function requesterProfileFromSlackUser(body = {}, slackUser = {}) {
  const event = body.event || {};
  const profile = slackUser.profile || {};
  const slackUserId = slackUser.id || slackUserIdFromBody(body, null);
  const slackTeamId = slackUser.team_id || body.team_id || body.team?.id || event.team || null;
  const displayName = profile.display_name || profile.display_name_normalized || null;
  const realName = profile.real_name || profile.real_name_normalized || slackUser.real_name || null;
  const name = slackUser.name || profile.name || null;

  return {
    source: 'slack.users.info',
    slackTeamId,
    slackUserId,
    name,
    displayName,
    realName,
    email: profile.email || null,
  };
}

async function fetchSlackRequesterProfileFromNotifier(env = {}, slackUserId) {
  const url = remoteSlackNotifierUrl(env, '/internal/slack-notifier/user-info');
  const token = remoteSlackNotifierToken(env);
  if (!url || !token || !slackUserId) return null;

  const fetchImpl = env.SLACK_NOTIFIER_FETCH || env.SLACK_FETCH || fetch;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Pages-Slack-Notifier-Token': token,
    },
    body: JSON.stringify({ user: slackUserId }),
  });
  const body = await response.json().catch(() => null);

  if (!response.ok || body?.ok === false || !body?.profile) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_user_profile_lookup_failed',
        slackUserId,
        via: 'slack-notifier',
        error: body?.error || response.statusText || `HTTP ${response.status}`,
      })
    );
    return null;
  }

  return body.profile;
}

async function fetchSlackRequesterProfile(env = {}, body = {}) {
  if (String(env.SLACK_USER_PROFILE_LOOKUP || 'true').toLowerCase() === 'false') return null;

  const slackUserId = slackUserIdFromBody(body, null);
  if (!slackUserId) return null;

  const notifierProfile = await fetchSlackRequesterProfileFromNotifier(env, slackUserId);
  if (notifierProfile) return notifierProfile;

  if (!env.SLACK_BOT_TOKEN) return requesterProfileFromSlackUser(body, { id: slackUserId });

  const fetchImpl = env.SLACK_PROFILE_FETCH || env.SLACK_FETCH || fetch;
  let response;
  let payload;
  try {
    response = await fetchImpl(slackApiMethodUrl(env, 'users.info'), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8',
      },
      body: new URLSearchParams({ user: slackUserId }).toString(),
    });
    payload = await response.json().catch(() => null);
  } catch (error) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_user_profile_lookup_failed',
        slackUserId,
        error: error.message,
      })
    );
    return requesterProfileFromSlackUser(body, { id: slackUserId });
  }

  if (!response.ok || payload?.ok === false || !payload?.user) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_user_profile_lookup_failed',
        slackUserId,
        error: payload?.error || response.statusText || `HTTP ${response.status}`,
      })
    );
    return requesterProfileFromSlackUser(body, { id: slackUserId });
  }

  return requesterProfileFromSlackUser(body, payload.user);
}

async function addWorkingReactionForSlackEvent(env, body = {}) {
  if (!canSendSlackOutput(env)) return null;
  if (String(env.SLACK_REACTION_ON_RECEIVE || 'false').toLowerCase() !== 'true') return null;
  if (ignoredSlackEventReason(body)) return null;

  const event = body.event || {};
  const channel = event.channel || body.channel_id;
  const timestamp = event.ts || body.event_ts;
  const name = String(env.SLACK_WORKING_REACTION || 'eyes').replace(/^:+|:+$/g, '');
  if (!channel || !timestamp || !name) return null;

  const result = await addSlackReaction(env, { channel, timestamp, name });
  if (!result?.ok) {
    console.log(
      JSON.stringify({
        service: 'pages-gateway',
        message: 'slack_reaction_failed',
        channel,
        timestamp,
        reaction: name,
        error: result?.error || 'unknown_error',
      })
    );
  }
  return result;
}

async function postSlackResultReply(env, body = {}, result = {}) {
  if (!canSendSlackOutput(env) || !shouldPostSlackResultReply(result)) return null;

  const event = body.event || {};
  const surface = surfaceForSlackBody(body);
  const channel = surface.channelId;
  if (!channel) return null;

  return postSlackMessage(env, {
    channel,
    thread_ts: surface.threadTs || event.ts || undefined,
    text: mentionSlackUser(result.replyText, slackUserIdFromBody(body, null)),
  });
}

function runSlackBackground(env, task) {
  const promise = Promise.resolve()
    .then(task)
    .catch((err) => {
      console.log(
        JSON.stringify({
          service: 'pages-gateway',
          message: 'slack_event_background_failed',
          error: err.message,
        })
      );
    });

  if (typeof env.waitUntil === 'function') {
    env.waitUntil(promise);
  }

  return promise;
}

function shouldProcessSlackEventsAsync(env = {}) {
  if (env.SLACK_EVENTS_PROCESSING_MODE === 'sync') return false;
  if (env.SLACK_EVENTS_PROCESSING_MODE === 'async') return true;
  return Boolean(env.SLACK_SIGNING_SECRET);
}

async function processSlackEventBody(body, env) {
  const store = getStore(env);

  if (body.type === 'url_verification' && body.challenge) {
    return { ok: true, action: 'url_verification', challenge: body.challenge };
  }

  const eventId = slackEventId(body);
  const deliveryContext = slackDeliveryContextFromBody(body);
  const updateDelivery = async (patch = {}) => {
    if (!eventId || !store.updateSlackDelivery) return null;
    return await store.updateSlackDelivery(deliveryContext, patch);
  };
  const respond = async (resultOrPromise, overrides = {}) => {
    const result = await resultOrPromise;
    await updateDelivery(slackDeliveryPatchForResult(result, overrides));
    return result;
  };

  if (eventId && store.recordSlackDelivery) {
    const delivery = await store.recordSlackDelivery({
      ...deliveryContext,
      eventId,
      eventType: body.event?.type || body.type || null,
      action: body.event?.subtype || body.action || null,
    });

    if (!delivery.created) {
      return {
        ok: true,
        action: 'duplicate_slack_event',
        accepted: false,
        reply: false,
        delivery: delivery.delivery,
      };
    }
  }

  await updateDelivery({ processingStatus: 'processing' });

  const ignoredReason = ignoredSlackEventReason(body);
  if (ignoredReason) {
    return respond({
      ok: true,
      action: 'ignored_slack_event',
      reason: ignoredReason,
      accepted: false,
      reply: false,
    });
  }

  const intake = classifySlackIntake(body);
  if (isUnaddressedChannelThreadMessage(body) && !(await existingSlackThreadSession(store, body))) {
    return respond({
      ok: true,
      action: 'ignored_untracked_thread_message',
      accepted: false,
      reply: false,
    });
  }

  const sessionSelection = await selectSlackSession(store, body, intake, env);

  if (sessionSelection.forbidden) {
    return respond({
      ok: true,
      action: sessionSelection.action,
      accepted: false,
      replyText: sessionSelection.replyText,
    });
  }

  if (sessionSelection.ambiguous) {
    return respond({
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
  const lease = slackSession ? await store.acquireSlackAgentLease(slackSession.id, sessionSelection.config) : null;

  if (lease && !lease.acquired) {
    return respond({
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
    const statusJob = intake.jobId ? await store.getJob(intake.jobId) : null;
    if (statusJob && !slackJobVisibleToActor(statusJob, body)) {
      await completeSlackAgentRun(store, agentRun, {
        report: { action: intake.action, jobId: intake.jobId, forbidden: true },
      });
      return respond({
        ok: true,
        action: 'forbidden_cross_user_job',
        accepted: false,
        replyText: '这个发布任务不属于当前 Slack 用户，不能查看状态。',
        ...(slackSession ? { slackSessionId: slackSession.id } : {}),
        ...(agentRun ? { agentRunId: agentRun.id } : {}),
      });
    }

    await completeSlackAgentRun(store, agentRun, {
      report: { action: intake.action, jobId: intake.jobId || null },
    });
    return respond({
      ok: true,
      action: intake.action,
      accepted: false,
      replyText: intake.jobId ? slackStatusReply(intake.jobId, statusJob) : intake.replyText,
      ...(slackSession ? { slackSessionId: slackSession.id } : {}),
      ...(agentRun ? { agentRunId: agentRun.id } : {}),
    });
  }

  try {
    let slackAgentAnalysis = null;
    if (intake.action === 'close_session') {
      return respond(
        handleCloseSlackSession({
          store,
          intake,
          slackSession,
          sessionMemory,
          agentRun,
          slackAgentAnalysis,
        })
      );
    }

    if (shouldAnalyzeSlackTurn(intake, slackSession)) {
      slackAgentAnalysis = await analyzeSlackEventIfConfigured(body, intake, env, {
        slackSession,
        sessionMemory,
        issueLinks: await store.findIssueLinksForSlackSession(slackSession.id),
        agentRun,
      });

      if (shouldCloseSlackSession(intake, slackAgentAnalysis)) {
        return respond(
          handleCloseSlackSession({
            store,
            intake,
            slackSession,
            sessionMemory,
            agentRun,
            slackAgentAnalysis,
          })
        );
      }

      if (slackAgentAnalysis?.intent === 'status_query') {
        return respond(
          handleSlackAgentStatusQuery({
            store,
            intake,
            slackSession,
            sessionMemory,
            agentRun,
            slackAgentAnalysis,
          })
        );
      }

      if (slackAgentAnalysis?.intent === 'cancel_request') {
        return respond(
          handleSlackAgentNonPublishingTurn({
            store,
            intake,
            slackSession,
            sessionMemory,
            agentRun,
            slackAgentAnalysis,
            action: 'cancel_request',
            replyText: '收到取消意图。当前 MVP 还没有自动取消 job；如果已经创建了 issue，可以先在 issue 里补充“取消”。',
          })
        );
      }

      if (hasActiveSlackTarget(slackSession) && isSlackFollowupIntent(slackAgentAnalysis, intake)) {
        return respond(
          handleSlackFollowup({
            store,
            env,
            intake,
            slackSession,
            sessionMemory,
            agentRun,
            slackAgentAnalysis,
          })
        );
      }
    }

    if (slackAgentAnalysis?.needsClarification) {
      return respond(
        handleSlackAgentNonPublishingTurn({
          store,
          intake,
          slackSession,
          sessionMemory,
          agentRun,
          slackAgentAnalysis,
          action: 'clarification_needed',
        })
      );
    }

    if (shouldAskBeforeCreatingIssue(intake, slackAgentAnalysis, slackSession)) {
      return respond(
        handleSlackAgentNonPublishingTurn({
          store,
          intake,
          slackSession,
          sessionMemory,
          agentRun,
          slackAgentAnalysis,
          action: 'confirm_before_issue',
          replyText: slackIssueConfirmationText(slackAgentAnalysis),
          preferReplyText: true,
        })
      );
    }

    if (!shouldCreateSlackJob(intake, slackAgentAnalysis)) {
      return respond(
        handleSlackAgentNonPublishingTurn({
          store,
          intake,
          slackSession,
          sessionMemory,
          agentRun,
          slackAgentAnalysis,
          action: slackAgentAnalysis ? 'agent_turn_recorded' : intake.action,
        })
      );
    }

    const redactedIntake = { ...intake, text: redactSecretLikeText(intake.text) };
    const redactedSlackAgentAnalysis = redactSlackAnalysis(slackAgentAnalysis);
    await store.updateSessionMemory(slackSession.id, {
      summary: redactedSlackAgentAnalysis?.summary || redactedIntake.text,
      requirements: redactedSlackAgentAnalysis || { text: redactedIntake.text, action: redactedIntake.action },
      lastAgentResponse: redactedSlackAgentAnalysis?.needsClarification ? redactedSlackAgentAnalysis.summary : null,
    });
    const requesterProfile = await fetchSlackRequesterProfile(env, body);
    const { job, created } = await store.createJob(
      slackJobInput({
        ...body,
        intake: redactedIntake,
        slackAgentAnalysis: redactedSlackAgentAnalysis,
        slackSession,
        requesterProfile,
      })
    );
    const issueLink = await store.linkJobToSlackSession(job, slackSession);
    const slackStatusNotification = created
      ? await notifySlackJobStatus(env, store, job, {
          stage: 'received',
          agentRunId: agentRun?.id || null,
          text: '已收到 Slack 发布需求，正在整理任务。',
          statusText: ':hourglass_flowing_sand: 我已收到需求，正在整理...',
        })
      : null;
    const workerStart = created ? await startWorkerForJobIfConfigured(job, env) : null;
    await completeSlackAgentRun(store, agentRun, {
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
    return respond({
      ok: true,
      action: intake.action,
      accepted: true,
      jobId: job.id,
      slackSessionId: slackSession.id,
      agentRunId: agentRun?.id,
      issueLink,
      created,
      ...(slackStatusNotification ? { slackStatusNotification } : {}),
      ...(redactedSlackAgentAnalysis ? { slackAgentAnalysis: redactedSlackAgentAnalysis } : {}),
      ...(workerStart ? { workerStart } : {}),
    });
  } catch (err) {
    await updateDelivery({
      processingStatus: 'failed',
      resultType: 'none',
      errorCode: 'slack_event_processing_failed',
      errorMessage: err.message,
    });
    if (agentRun) {
      await store.failAgentRun(agentRun.id, 'slack_agent_failed', err.message);
    }
    throw err;
  }
}

async function handleCloseSlackSession({ store, intake, slackSession, sessionMemory, agentRun, slackAgentAnalysis }) {
  const closedSession = await store.closeSlackSession(slackSession.id);
  await store.updateSessionMemory(slackSession.id, {
    summary: redactSecretLikeText(sessionMemory.summary || intake.text),
    lastAgentResponse: '会话已关闭。',
    pendingQuestions: [],
  });
  await completeSlackAgentRun(store, agentRun, {
    report: {
      action: 'close_session',
      accepted: true,
      intent: slackAgentAnalysis?.intent || null,
    },
  });

  return {
    ok: true,
    action: 'close_session',
    accepted: true,
    slackSessionId: slackSession.id,
    agentRunId: agentRun?.id,
    replyText: '已关闭当前会话。后续你可以用 `issue: ...` 开一个新任务，或者带上 job id 查询旧任务。',
    session: closedSession,
  };
}

async function handleSlackAgentStatusQuery({ store, intake, slackSession, sessionMemory, agentRun, slackAgentAnalysis }) {
  const job = await activeJobForSlackSession(store, slackSession);
  const replyText = job
    ? slackStatusReply(job.id, job)
    : '我还没有在当前会话里找到发布任务。你可以带上 job id，例如 `status: job_xxx`。';

  await store.updateSessionMemory(slackSession.id, {
    summary: redactSecretLikeText(slackAgentAnalysis?.summary || sessionMemory.summary || intake.text),
    lastAgentResponse: replyText,
  });
  await completeSlackAgentRun(store, agentRun, {
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

  return {
    ok: true,
    action: 'status_query',
    accepted: false,
    replyText,
    slackSessionId: slackSession.id,
    agentRunId: agentRun?.id,
    ...(slackAgentAnalysis ? { slackAgentAnalysis: redactSlackAnalysis(slackAgentAnalysis) } : {}),
  };
}

async function handleSlackAgentNonPublishingTurn({
  store,
  intake,
  slackSession,
  sessionMemory,
  agentRun,
  slackAgentAnalysis,
  action,
  replyText,
  preferReplyText = false,
}) {
  const redactedIntakeText = redactSecretLikeText(intake.text);
  const redactedSlackAgentAnalysis = redactSlackAnalysis(slackAgentAnalysis);
  const finalReplyText = slackAgentReplyText(intake, redactedSlackAgentAnalysis, replyText, { preferFallback: preferReplyText });
  await store.updateSessionMemory(slackSession.id, {
    summary: redactedSlackAgentAnalysis?.summary || redactSecretLikeText(sessionMemory.summary) || redactedIntakeText,
    requirements: redactedSlackAgentAnalysis || redactSlackAnalysis(sessionMemory.requirements) || {},
    lastAgentResponse: finalReplyText,
    pendingQuestions: redactedSlackAgentAnalysis?.needsClarification
      ? [finalReplyText]
      : redactSlackAnalysis(sessionMemory.pendingQuestions) || [],
  });
  await completeSlackAgentRun(store, agentRun, {
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
      textLength: intake.text.length,
    })
  );

  return {
    ok: true,
    action,
    accepted: false,
    replyText: finalReplyText,
    slackSessionId: slackSession.id,
    agentRunId: agentRun?.id,
    ...(redactedSlackAgentAnalysis ? { slackAgentAnalysis: redactedSlackAgentAnalysis } : {}),
  };
}

async function handleSlackFollowup({ store, env, intake, slackSession, sessionMemory, agentRun, slackAgentAnalysis }) {
  const job = await activeJobForSlackSession(store, slackSession);
  const redactedSlackAgentAnalysis = redactSlackAnalysis(slackAgentAnalysis);
  const feedback = redactSecretLikeText(redactedSlackAgentAnalysis?.summary || intake.text);

  if (!job) {
    await completeSlackAgentRun(store, agentRun, {
      report: { action: 'followup_missing_job', accepted: false },
    });
    return {
      ok: true,
      action: 'followup_missing_job',
      accepted: false,
      replyText: '我找到了当前会话，但没有找到可继续修改的发布任务。可以用 `issue: ...` 新开一个任务。',
      slackSessionId: slackSession.id,
      agentRunId: agentRun?.id,
    };
  }

  const patch = {
    intent: redactedSlackAgentAnalysis?.intent || 'modify_existing_preview',
    title: redactedSlackAgentAnalysis?.title || job.title,
    summary: followupSummary(job.summary, feedback),
    previewUrl: null,
  };
  await store.updateSessionMemory(slackSession.id, {
    summary: followupSummary(sessionMemory.summary, feedback),
    requirements: redactedSlackAgentAnalysis || { text: redactSecretLikeText(intake.text), action: 'followup' },
    lastPreviewFeedback: feedback,
    lastAgentResponse: null,
  });

  let updatedJob = null;
  let workerStart = null;
  let action = 'followup_recorded';
  let replyText = `收到，已把这轮修改意见关联到 ${job.id}。`;

  if (canDispatchFixForJob(job)) {
    updatedJob = await store.moveJobToFixing(job.id, patch);
    if (updatedJob) {
      await store.linkJobToSlackSession(updatedJob, slackSession);
      workerStart = await startWorkerForJobIfConfigured(updatedJob, env);
      action = workerStart?.started ? 'followup_fix_dispatched' : 'followup_fix_ready';
      replyText = workerStart?.started
        ? `收到，已把修改意见追加到 ${job.id}，并启动同一个 PR 的修复轮次。`
        : `收到，已把修改意见追加到 ${job.id}，等待 worker 启动修复轮次。`;
    }
  }

  if (!updatedJob) {
    updatedJob = await store.patchJob(job.id, patch);
    await store.linkJobToSlackSession(updatedJob, slackSession);
    replyText = `收到，已记录到 ${job.id}。当前任务还在 ${job.status}，会优先保留在同一个会话里。`;
  }

  await completeSlackAgentRun(store, agentRun, {
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

  return {
    ok: true,
    action,
    accepted: true,
    jobId: updatedJob.id,
    slackSessionId: slackSession.id,
    agentRunId: agentRun?.id,
    replyText,
    job: updatedJob,
    ...(redactedSlackAgentAnalysis ? { slackAgentAnalysis: redactedSlackAgentAnalysis } : {}),
    ...(workerStart ? { workerStart } : {}),
  };
}

async function completeSlackAgentRun(store, agentRun, patch = {}) {
  if (!agentRun) return null;
  return await store.completeAgentRun(agentRun.id, patch);
}

export async function handleHealth(_request, env = {}) {
  const store = getStore(env);
  return jsonResponse({
    status: 'ok',
    service: 'pages-gateway',
    storeBackend: store.backend || env.PAGES_STORE_BACKEND || 'memory',
  });
}

export async function handleReady(_request, env = {}) {
  const store = getStore(env);

  try {
    const health = store.health ? await store.health() : { ok: true, backend: store.backend || 'unknown' };
    return jsonResponse({
      status: 'ready',
      service: 'pages-gateway',
      storeBackend: health.backend || store.backend || env.PAGES_STORE_BACKEND || 'memory',
    });
  } catch (error) {
    return jsonResponse(
      {
        status: 'not_ready',
        service: 'pages-gateway',
        storeBackend: store.backend || env.PAGES_STORE_BACKEND || 'unknown',
        error: error.message,
      },
      503
    );
  }
}

export async function handleCreatePublishingJob(request, env) {
  const store = getStore(env);
  const body = await readJson(request);
  const { job, created } = await store.createJob(normalizePublishingJobInput(body, request));
  const workerStart = created ? await startWorkerForJobIfConfigured(job, env) : null;

  return jsonResponse({ job, created, ...(workerStart ? { workerStart } : {}) }, created ? 201 : 200);
}

export async function handleListPublishingJobs(request, env) {
  const url = new URL(request.url);
  const result = await getStore(env).listJobs({
    status: url.searchParams.get('status') || undefined,
    source: url.searchParams.get('source') || undefined,
    q: url.searchParams.get('q') || undefined,
    limit: url.searchParams.get('limit') || undefined,
    offset: url.searchParams.get('offset') || undefined,
  });

  return jsonResponse(result);
}

export async function handleGetPublishingJob(_request, env, params) {
  const job = await getStore(env).getJob(params.jobId);
  if (!job) return jsonResponse({ error: 'PublishingJob not found' }, 404);
  return jsonResponse({ job });
}

export async function handleGetPublishingJobEvents(_request, env, params) {
  const store = getStore(env);
  if (!(await store.getJob(params.jobId))) return jsonResponse({ error: 'PublishingJob not found' }, 404);
  return jsonResponse({ events: await store.listEvents(params.jobId) });
}

export async function handleSlackEvents(request, env) {
  const { body } = await readSlackRequest(request, env);

  if (body.type === 'url_verification' && body.challenge) {
    return slackChallengeResponse(body);
  }

  const process = async () => {
    await addWorkingReactionForSlackEvent(env, body);
    const result = await processSlackEventBody(body, env);
    await postSlackResultReply(env, body, result);
    return result;
  };

  if (shouldProcessSlackEventsAsync(env)) {
    runSlackBackground(env, process);
    return slackAckResponse({ ok: true, accepted: true });
  }

  return jsonResponse(await process());
}

export async function handleSlackInteractions(request, env) {
  const { body } = await readSlackRequest(request, env);
  const store = getStore(env);
  const action = body.actions?.[0] || {};
  const actionId = action.action_id || '';
  const teamId = body.team?.id || body.team_id || 'unknown-team';
  const slackUserId = slackUserIdFromBody(body);

  if (actionId === 'pages_close_session') {
    const sessionId = action.value || '';
    const session = await store.getSlackSession(sessionId);
    if (!session || session.teamId !== teamId || session.primarySlackUserId !== slackUserId) {
      return slackAckResponse({
        response_type: 'ephemeral',
        text: '这个会话不属于当前 Slack 用户，不能关闭。',
      });
    }

    await store.closeSlackSession(session.id);
    return slackAckResponse({
      response_type: 'ephemeral',
      text: '已关闭当前会话。后续可以直接发新需求开启新任务。',
    });
  }

  if (actionId === 'pages_continue_modifying') {
    return slackAckResponse({
      response_type: 'ephemeral',
      text: '直接在当前 thread 里回复修改意见即可，我会继续关联到这个任务。',
    });
  }

  return slackAckResponse({ ok: true });
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
    const job = await store.failJob(jobId, body.errorCode || body.error_code, body.errorMessage || body.error_message);
    if (!job) return jsonResponse({ error: 'PublishingJob not found' }, 404);
    await store.linkJobToSlackSession(job);
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
  let job = await applyExecutorCallback(store, jobId, stageResult, rule.status, patch);
  if (!job) return jsonResponse({ error: 'PublishingJob not found' }, 404);
  await store.linkJobToSlackSession(job);
  let workerStart = await startWorkerForJobIfConfigured(job, env);
  const reviewReplay = stageResult === 'pr_created' ? await dispatchPreviewFromStoredReviewIfReady(job, store, env) : null;

  if (reviewReplay) {
    job = reviewReplay.job;
    workerStart = reviewReplay.workerStart;
    await store.linkJobToSlackSession(job);
  }

  const statusText = reviewReplay
    ? notificationTextForReviewAction(reviewReplay.reviewAction, {
        gate: reviewReplay.gate,
        reviewComment: reviewReplay.reviewComment,
      })
    : notificationTextForCallback(stageResult, job) || `PublishingJob moved to ${job.status}`;
  const slackStatusNotification = await notifySlackJobStatus(env, store, job, {
    stage: reviewReplay ? job.status : stageResult,
    text: statusText,
  });
  const slackText = notificationTextForCallback(stageResult, job);
  const slackNotification = await notifySlackJob(env, store, job, slackText, `callback:${stageResult}`);

  return jsonResponse({
    job,
    ...(workerStart ? { workerStart } : {}),
    ...(reviewReplay
      ? {
          reviewReplay: {
            reviewAction: reviewReplay.reviewAction,
            gate: reviewReplay.gate,
            reviewComment: reviewReplay.reviewComment,
          },
        }
      : {}),
    ...(slackStatusNotification ? { slackStatusNotification } : {}),
    ...(slackNotification ? { slackNotification } : {}),
  });
}

async function moveJobToChangesRequestedForSiteCheck(store, job, patch = {}) {
  if (!job) return null;
  if (job.status === 'changes_requested') {
    return await store.patchJob(job.id, patch);
  }

  let current = job;
  if (current.status === 'pr_created') {
    current = await store.updateJob(current.id, 'reviewing', patch);
  }
  if (current.status === 'reviewing') {
    return await store.updateJob(current.id, 'changes_requested', patch);
  }
  return current;
}

async function handleGithubSiteCheckWebhook({ siteCheckRun, store, env, result }) {
  const storedRun = await store.recordSiteCheckRun(siteCheckRun);
  const fullHeadSha = siteCheckRun.headSha && siteCheckRun.headSha.length === 40 ? siteCheckRun.headSha : null;
  let job = await store.findJobByPrNumber(siteCheckRun.prNumber, fullHeadSha ? { headSha: fullHeadSha } : {});
  let gate = job
    ? await previewGateForPr(store, siteCheckRun.repoFullName, siteCheckRun.prNumber, fullHeadSha ? { headSha: fullHeadSha } : {})
    : null;
  let workerStart = null;
  let reviewReplay = null;
  let reviewAction = 'site_check_recorded';
  let slackStatusNotification = null;
  let slackNotification = null;

  if (job && fullHeadSha && job.headSha !== fullHeadSha) {
    job = await store.patchJob(job.id, { headSha: fullHeadSha });
  }

  if (job && siteCheckRun.status === 'completed' && siteCheckRun.conclusion === 'success') {
    reviewReplay = await dispatchPreviewFromStoredReviewIfReady(job, store, env);
    if (reviewReplay) {
      job = reviewReplay.job;
      workerStart = reviewReplay.workerStart;
      gate = reviewReplay.gate;
      reviewAction = reviewReplay.reviewAction;
    } else {
      reviewAction = 'site_check_passed';
    }
  } else if (job && siteCheckRun.status === 'completed' && siteCheckRun.conclusion && siteCheckRun.conclusion !== 'success') {
    job = await moveJobToChangesRequestedForSiteCheck(store, job, fullHeadSha ? { headSha: fullHeadSha } : {});
    gate = await previewGateForPr(
      store,
      siteCheckRun.repoFullName,
      siteCheckRun.prNumber,
      fullHeadSha ? { headSha: fullHeadSha } : {}
    );
    reviewAction = 'site_check_failed';
  } else if (job) {
    reviewAction = 'site_check_waiting';
  }

  if (job) {
    await store.linkJobToSlackSession(job);
    const text = notificationTextForReviewAction(reviewAction, { gate, siteCheckRun: storedRun.run });
    slackStatusNotification = await notifySlackJobStatus(env, store, job, {
      stage: job.status,
      text: text || reviewAction,
      dedupeKey: [
        'site-check-status',
        job.id,
        siteCheckRun.checkRunNodeId,
        siteCheckRun.status || 'unknown',
        siteCheckRun.conclusion || 'none',
      ].join(':'),
      skipDuplicate: false,
    });
    slackNotification = await notifySlackJob(env, store, job, text, `site-check:${reviewAction}:${siteCheckRun.checkRunNodeId}`);
  }

  return jsonResponse({
    ok: true,
    created: true,
    delivery: result.delivery,
    reviewAction,
    siteCheckRun: storedRun.run,
    siteCheckRunCreated: storedRun.created,
    ...(gate ? { gate } : {}),
    ...(job ? { job } : {}),
    ...(workerStart ? { workerStart } : {}),
    ...(reviewReplay
      ? {
          reviewReplay: {
            reviewAction: reviewReplay.reviewAction,
            gate: reviewReplay.gate,
            reviewComment: reviewReplay.reviewComment,
          },
        }
      : {}),
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
  const result = await store.recordGithubDelivery({ repoFullName, deliveryId, eventName, action });

  if (!result.created) {
    return jsonResponse({ ok: true, created: false, delivery: result.delivery });
  }

  if (eventName === 'issues') {
    return handleGithubIssueWebhook({ body, action, store, env, result });
  }

  const siteCheckRun = normalizeSiteCheckRunWebhook(body, eventName, deliveryId, repoFullName);
  if (siteCheckRun && isAllowedSiteCheckRun(siteCheckRun, env)) {
    return handleGithubSiteCheckWebhook({ siteCheckRun, store, env, result });
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

  const reviewComment = await store.recordReviewAgentComment(normalized);
  const job = await store.findJobByPrNumber(normalized.prNumber, { headSha: normalized.headSha });
  const gate = await previewGateForPr(
    store,
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
    updatedJob = await store.patchJob(updatedJob.id, { headSha: fullHeadSha });
  }

  if (updatedJob && updatedJob.status === 'pr_created') {
    updatedJob = await store.updateJob(updatedJob.id, 'reviewing', fullHeadSha ? { headSha: fullHeadSha } : {});
    reviewAction = 'reviewing';
  }

  if (updatedJob && gate.blockingCount > 0 && ['reviewing', 'changes_requested'].includes(updatedJob.status)) {
    updatedJob =
      updatedJob.status === 'changes_requested'
        ? updatedJob
        : await store.updateJob(updatedJob.id, 'changes_requested', fullHeadSha ? { headSha: fullHeadSha } : {});
    reviewAction = 'changes_requested';
  } else if (shouldDispatchPreviewForReview(updatedJob, normalized, gate)) {
    if (updatedJob.status !== 'previewing') {
      updatedJob = await store.updateJob(updatedJob.id, 'previewing', fullHeadSha ? { headSha: fullHeadSha } : {});
    }
    workerStart = await startWorkerForJobIfConfigured(updatedJob, env);
    reviewAction = 'preview_dispatched';
  } else if (shouldReportSiteCheckWaiting(updatedJob, normalized, gate)) {
    reviewAction = 'site_check_waiting';
  }

  if (updatedJob) {
    await store.linkJobToSlackSession(updatedJob);
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
