import {
  buildAgentProgressBlocks,
  buildJobStatusBlocks,
  buildSlackStatusText,
  mentionSlackUser,
  notificationTextForCallback,
  notificationTextForReviewAction,
  addSlackReaction as addSlackReactionDirect,
  notifySlackJob as notifySlackJobDirect,
  notifySlackJobStatus as notifySlackJobStatusDirect,
  postSlackMessage as postSlackMessageDirect,
  removeSlackReaction as removeSlackReactionDirect,
  updateSlackMessage as updateSlackMessageDirect,
} from '@xd/slack-notifier-core';

function remoteNotifierUrl(env = {}, path) {
  const base = env.SLACK_NOTIFIER_URL || env.PAGES_SLACK_NOTIFIER_URL;
  if (!base) return null;
  return `${String(base).replace(/\/+$/, '')}${path}`;
}

function remoteNotifierToken(env = {}) {
  return env.SLACK_NOTIFIER_SHARED_SECRET || env.PAGES_SLACK_NOTIFIER_SHARED_SECRET;
}

function remoteNotifierHeaders(env = {}) {
  return {
    'Content-Type': 'application/json; charset=utf-8',
    'X-Pages-Slack-Notifier-Token': remoteNotifierToken(env),
  };
}

const STAGE_ORDER = [
  'received',
  'issue_creating',
  'issue_created',
  'indexing',
  'index_ready',
  'generating_page',
  'patch_generated',
  'branch_committed',
  'pr_created',
  'reviewing',
  'changes_requested',
  'fixing',
  'previewing',
  'preview_deployed',
  'approved',
  'merging',
  'merged',
  'deploying',
  'deployed',
  'failed',
  'cancelled',
];

function stageRank(stage) {
  const index = STAGE_ORDER.indexOf(stage);
  return index === -1 ? -1 : index;
}

function isStaleStageUpdate(existingStage, nextStage) {
  const existingRank = stageRank(existingStage);
  const nextRank = stageRank(nextStage);
  return existingRank >= 0 && nextRank >= 0 && existingRank > nextRank;
}

function sameSlackStatusTarget(message = {}, job = {}) {
  const thread = job.slackThread || {};
  if (!message?.messageTs || !thread.channelId) return false;
  return message.channel === thread.channelId && (message.threadTs || null) === (thread.threadTs || null);
}

async function callRemoteNotifier(env, path, payload) {
  const url = remoteNotifierUrl(env, path);
  if (!url) return null;

  if (!remoteNotifierToken(env)) {
    return {
      ok: false,
      error: 'Slack notifier shared secret is required',
      status: 500,
    };
  }

  const fetchImpl = env.SLACK_NOTIFIER_FETCH || env.SLACK_FETCH || fetch;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: remoteNotifierHeaders(env),
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);

  if (!response.ok || body?.ok === false) {
    return {
      ok: false,
      error: body?.error || response.statusText || `HTTP ${response.status}`,
      status: response.status,
    };
  }

  return body;
}

export {
  buildAgentProgressBlocks,
  buildJobStatusBlocks,
  buildSlackStatusText,
  mentionSlackUser,
  notificationTextForCallback,
  notificationTextForReviewAction,
};

export async function postSlackMessage(env, payload) {
  if (!remoteNotifierUrl(env, '/internal/slack-notifier/message')) {
    return postSlackMessageDirect(env, payload);
  }

  return callRemoteNotifier(env, '/internal/slack-notifier/message', { payload });
}

export async function updateSlackMessage(env, payload) {
  if (!remoteNotifierUrl(env, '/internal/slack-notifier/update')) {
    return updateSlackMessageDirect(env, payload);
  }

  return callRemoteNotifier(env, '/internal/slack-notifier/update', { payload });
}

export async function addSlackReaction(env, payload) {
  if (!remoteNotifierUrl(env, '/internal/slack-notifier/reaction')) {
    return addSlackReactionDirect(env, payload);
  }

  return callRemoteNotifier(env, '/internal/slack-notifier/reaction', { payload });
}

export async function removeSlackReaction(env, payload) {
  if (!remoteNotifierUrl(env, '/internal/slack-notifier/reaction-remove')) {
    return removeSlackReactionDirect(env, payload);
  }

  return callRemoteNotifier(env, '/internal/slack-notifier/reaction-remove', { payload });
}

export async function notifySlackJob(env, store, job, text, key) {
  if (!remoteNotifierUrl(env, '/internal/slack-notifier/job-message')) {
    return notifySlackJobDirect(env, store, job, text, key);
  }

  if (!text || !job?.id) return null;
  if (store?.hasSlackNotification && (await store.hasSlackNotification(job.id, key))) {
    return { skipped: true, reason: 'duplicate', key };
  }

  const result = await callRemoteNotifier(env, '/internal/slack-notifier/job-message', { job, text, key });
  if (result?.ok) {
    await store?.recordSlackNotification?.(job.id, key);
  }
  return result;
}

export async function notifySlackJobStatus(env, store, job, options = {}) {
  if (!remoteNotifierUrl(env, '/internal/slack-notifier/job-status')) {
    return notifySlackJobStatusDirect(env, store, job, options);
  }

  if (!job?.id) return null;

  const stage = options.stage || job.status;
  const dedupeKey = options.dedupeKey || `job-status:${job.id}:${stage}`;
  const slackSessionId = options.slackSessionId || job.slackSessionId || null;
  const scopeKey = options.scopeKey || (slackSessionId ? `session:${slackSessionId}` : 'job');
  const existing = store?.getSlackJobStatusMessage ? await store.getSlackJobStatusMessage(job.id, { scopeKey }) : null;
  const fallbackExisting =
    !existing && scopeKey !== 'job' && store?.getSlackJobStatusMessage
      ? await store.getSlackJobStatusMessage(job.id, { scopeKey: 'job' })
      : null;
  const reusableFallback = sameSlackStatusTarget(fallbackExisting, job) ? fallbackExisting : null;
  const existingMessage = existing || reusableFallback;
  if (existingMessage?.messageTs && isStaleStageUpdate(existingMessage.stage, stage) && options.allowRegression !== true) {
    return { skipped: true, reason: 'stale_stage', key: dedupeKey, message: existingMessage };
  }
  if (existingMessage?.messageTs && existingMessage.stage === stage && options.skipDuplicate !== false) {
    return { skipped: true, reason: 'duplicate_stage', key: dedupeKey, message: existingMessage };
  }

  const progress = store?.recordAgentRunEvent
    ? await store.recordAgentRunEvent({
        publishingJobId: job.id,
        slackSessionId,
        agentRunId: options.agentRunId || null,
        type: options.type || 'job_progress',
        stage,
        text: options.text || stage,
        status: options.status || job.status || 'running',
        dedupeKey,
        slackChannelId: job.slackThread?.channelId || null,
        slackThreadTs: job.slackThread?.threadTs || null,
      })
    : null;

  const result = await callRemoteNotifier(env, '/internal/slack-notifier/job-status', {
    job,
    options: { ...options, slackSessionId, scopeKey },
    existingMessage: existingMessage || null,
  });

  if (!result?.ok) {
    return {
      ok: false,
      key: dedupeKey,
      error: result?.error || 'Slack notifier request failed',
      event: progress?.event || null,
    };
  }

  const message =
    result.message && store?.recordSlackJobStatusMessage
      ? await store.recordSlackJobStatusMessage(job.id, { ...result.message, slackSessionId, scopeKey })
      : null;
  return {
    ...result,
    key: result.key || dedupeKey,
    message: message || result.message || null,
    event: progress?.event || result.event || null,
  };
}
