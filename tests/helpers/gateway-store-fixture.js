import {
  buildPublishingJob,
  buildPlatformDevItem,
  canTransition,
  eventForStatus,
  idempotencyScopeForInput,
  idempotencyScopeForJob,
  idempotencyScopeForPlatformDevItem,
  makeId,
  platformDevItemEvent,
  transitionPlatformDevItem,
  transitionPlatformDevItemWithBridge,
  transitionJob,
} from '../../packages/workflow-core/src/index.js';

import { classifyReviewAgentComment } from '../../apps/gateway/src/github/review.js';

const CALLBACK_BRIDGES = {
  issue_created: {
    received: ['issue_creating', 'issue_created'],
  },
  generating_page: {
    issue_created: ['indexing', 'generating_page'],
  },
  pr_created: {
    issue_created: ['generating_page', 'pr_created'],
  },
  preview_deployed: {
    pr_created: ['previewing', 'preview_deployed'],
    reviewing: ['previewing', 'preview_deployed'],
  },
};

const REVIEW_ACTIVE_JOB_STATUSES = new Set(['pr_created', 'reviewing', 'changes_requested', 'fixing', 'previewing']);
const REVIEW_ACTIVE_PLATFORM_STATUSES = new Set([
  'pr_created',
  'ci_running',
  'review_waiting',
  'review_blocked',
  'ready_to_merge',
  'failed',
]);
const SLACK_ACTIVE_JOB_STATUSES = new Set([
  'received',
  'summarizing',
  'issue_creating',
  'issue_created',
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
]);
const SLACK_ACTIVE_PLATFORM_STATUSES = new Set([
  'received',
  'triaging',
  'issue_creating',
  'issue_created',
  'auto_dev_pending',
  'agent_queued',
  'agent_running',
  'branch_committed',
  'pr_created',
  'ci_running',
  'ci_failed',
  'review_waiting',
  'review_blocked',
  'ready_to_merge',
]);

function fieldOrExisting(input, existing, key) {
  return Object.hasOwn(input, key) ? input[key] : (existing?.[key] ?? null);
}

function jobKeepsSlackSessionActive(job = {}) {
  return SLACK_ACTIVE_JOB_STATUSES.has(job.status);
}

function platformDevKeepsSlackSessionActive(item = {}) {
  return SLACK_ACTIVE_PLATFORM_STATUSES.has(item.status);
}

function shaMatches(left, right) {
  if (!left || !right) return false;
  const normalizedLeft = String(left).toLowerCase();
  const normalizedRight = String(right).toLowerCase();
  if (normalizedLeft.length < 7 || normalizedRight.length < 7) return false;
  return normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}

function slackStatusScopeKey(input = {}) {
  if (input.scopeKey) return String(input.scopeKey);
  if (input.slackSessionId) return `session:${input.slackSessionId}`;
  return 'job';
}

export class GatewayStoreFixture {
  constructor() {
    this.backend = 'memory';
    this.jobs = new Map();
    this.idempotency = new Map();
    this.events = new Map();
    this.platformDevItems = new Map();
    this.platformDevIdempotency = new Map();
    this.platformDevEvents = new Map();
    this.githubDeliveries = new Map();
    this.slackDeliveries = new Map();
    this.reviewAgentComments = new Map();
    this.siteCheckRuns = new Map();
    this.slackNotifications = new Set();
    this.slackJobStatusMessages = new Map();
    this.slackAgentReplyMessages = new Map();
    this.agentRunEvents = new Map();
    this.agentRunEventByDedupeKey = new Map();
    this.slackSessions = new Map();
    this.slackSessionByScopeKey = new Map();
    this.sessionMemories = new Map();
    this.issueLinks = new Map();
    this.issueLinkByIssueNumber = new Map();
    this.issueLinkByPrNumber = new Map();
    this.workItemLinks = new Map();
    this.workItemLinkByIssueNumber = new Map();
    this.workItemLinkByPrNumber = new Map();
    this.slackWorkItemStatusMessages = new Map();
    this.agentRuns = new Map();
  }

  async health() {
    return { ok: true, backend: this.backend };
  }

  createJob(input) {
    const scope = idempotencyScopeForInput(input);
    if (this.idempotency.has(scope)) {
      return { job: this.jobs.get(this.idempotency.get(scope)), created: false };
    }

    const job = buildPublishingJob(input);
    this.jobs.set(job.id, job);
    this.idempotency.set(idempotencyScopeForJob(job), job.id);
    this.appendEvent(job, 'PublishingJob received');
    return { job, created: true };
  }

  getJob(jobId) {
    return this.jobs.get(jobId) || null;
  }

  createPlatformDevItem(input) {
    const scope = idempotencyScopeForInput({ source: 'slack', ...input });
    if (this.platformDevIdempotency.has(scope)) {
      return { item: this.platformDevItems.get(this.platformDevIdempotency.get(scope)), created: false };
    }

    const item = buildPlatformDevItem(input);
    this.platformDevItems.set(item.id, item);
    this.platformDevIdempotency.set(idempotencyScopeForPlatformDevItem(item), item.id);
    this.appendPlatformDevEvent(item, 'PlatformDevItem received');
    return { item, created: true };
  }

  getPlatformDevItem(itemId) {
    return this.platformDevItems.get(itemId) || null;
  }

  listPlatformDevItems(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const offset = Math.max(Number(options.offset) || 0, 0);
    const items = [...this.platformDevItems.values()]
      .filter((item) => {
        if (options.source && item.source !== options.source) return false;
        if (options.requestedById && item.requestedById !== options.requestedById) return false;
        if (options.status && item.status !== options.status) return false;
        if (options.statuses?.length && !options.statuses.includes(item.status)) return false;
        return true;
      })
      .sort((left, right) => {
        const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
        const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
        return rightTime - leftTime;
      });
    return {
      items: items.slice(offset, offset + limit),
      total: items.length,
      limit,
      offset,
    };
  }

  updatePlatformDevItem(itemId, status, patch = {}) {
    const item = this.getPlatformDevItem(itemId);
    if (!item) return null;
    const updated = transitionPlatformDevItemWithBridge(item, status, patch, new Date(), (bridgedItem, nextStatus) => {
      this.platformDevItems.set(itemId, bridgedItem);
      this.appendPlatformDevEvent(bridgedItem, `PlatformDevItem moved to ${nextStatus}`);
    });
    if (updated === item) return item;
    this.platformDevItems.set(itemId, updated);
    this.appendPlatformDevEvent(updated, `PlatformDevItem moved to ${status}`);
    return updated;
  }

  patchPlatformDevItem(itemId, patch = {}) {
    const item = this.getPlatformDevItem(itemId);
    if (!item) return null;
    const updated = {
      ...item,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.platformDevItems.set(itemId, updated);
    return updated;
  }

  triggerPlatformDevAutoDev(itemId, patch = {}) {
    const item = this.getPlatformDevItem(itemId);
    if (!item) return null;
    if (item.autoDevStatus === 'triggered') {
      return { item, triggered: false, alreadyTriggered: true };
    }
    if (item.autoDevStatus !== 'pending') {
      return { item, triggered: false, alreadyTriggered: false };
    }
    const updated = {
      ...item,
      ...patch,
      autoDevStatus: 'triggered',
      updatedAt: new Date().toISOString(),
    };
    this.platformDevItems.set(itemId, updated);
    return { item: updated, triggered: true, alreadyTriggered: false };
  }

  failPlatformDevItem(itemId, errorCode, errorMessage, patch = {}) {
    const item = this.getPlatformDevItem(itemId);
    if (!item) return null;
    const updated = transitionPlatformDevItem(item, 'failed', { ...patch, errorCode, errorMessage });
    this.platformDevItems.set(itemId, updated);
    this.appendPlatformDevEvent(updated, errorMessage || errorCode || 'PlatformDevItem failed');
    return updated;
  }

  listJobs(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const offset = Math.max(Number(options.offset) || 0, 0);
    const status = options.status ? String(options.status) : null;
    const source = options.source ? String(options.source) : null;
    const requestedById = options.requestedById ? String(options.requestedById) : null;
    const query = options.q ? String(options.q).trim().toLowerCase() : '';

    const jobs = [...this.jobs.values()]
      .filter((job) => {
        if (status && job.status !== status) return false;
        if (options.statuses?.length && !options.statuses.includes(job.status)) return false;
        if (source && job.source !== source) return false;
        if (requestedById && job.requestedById !== requestedById) return false;
        if (!query) return true;

        return [
          job.id,
          job.title,
          job.summary,
          job.employeeSlug,
          job.siteSlug,
          job.requestedById,
          job.issueNumber,
          job.prNumber,
          job.previewUrl,
        ]
          .filter((value) => value !== undefined && value !== null)
          .some((value) => String(value).toLowerCase().includes(query));
      })
      .sort((left, right) => {
        const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
        const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
        return rightTime - leftTime;
      });

    return {
      jobs: jobs.slice(offset, offset + limit),
      total: jobs.length,
      limit,
      offset,
    };
  }

  listEvents(jobId) {
    return this.events.get(jobId) || [];
  }

  updateJob(jobId, status, patch = {}) {
    const job = this.getJob(jobId);
    if (!job) return null;

    const updated = this.transitionWithBridge(job, status, patch);
    this.jobs.set(jobId, updated);
    this.appendEvent(updated, `PublishingJob moved to ${status}`);
    return updated;
  }

  moveJobToFixing(jobId, patch = {}) {
    let job = this.getJob(jobId);
    if (!job) return null;

    if (job.status === 'fixing') {
      return this.patchJob(jobId, patch);
    }

    if (job.status === 'pr_created') {
      job = this.updateJob(jobId, 'reviewing');
    }

    if (!canTransition(job.status, 'fixing')) {
      return null;
    }

    return this.updateJob(jobId, 'fixing', patch);
  }

  patchJob(jobId, patch = {}) {
    const job = this.getJob(jobId);
    if (!job) return null;

    const updated = {
      ...job,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(jobId, updated);
    return updated;
  }

  transitionWithBridge(job, status, patch) {
    if (canTransition(job.status, status)) {
      return transitionJob(job, status, patch);
    }

    const bridge = CALLBACK_BRIDGES[status]?.[job.status];
    if (!bridge) return transitionJob(job, status, patch);

    let current = job;
    for (const nextStatus of bridge) {
      current = transitionJob(current, nextStatus, nextStatus === status ? patch : {});
      if (nextStatus !== status) {
        this.appendEvent(current, `PublishingJob moved to ${nextStatus}`);
      }
    }
    return current;
  }

  failJob(jobId, errorCode, errorMessage, patch = {}) {
    const job = this.getJob(jobId);
    if (!job) return null;

    const updated = transitionJob(job, 'failed', { ...patch, errorCode, errorMessage });
    this.jobs.set(jobId, updated);
    this.appendEvent(updated, errorMessage || errorCode || 'PublishingJob failed');
    return updated;
  }

  cancelJob(jobId, errorCode = 'cancelled', errorMessage = 'PublishingJob cancelled') {
    const job = this.getJob(jobId);
    if (!job) return null;

    const updated = {
      ...job,
      status: 'cancelled',
      errorCode,
      errorMessage,
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(jobId, updated);
    this.appendEvent(updated, errorMessage || errorCode || 'PublishingJob cancelled');
    return updated;
  }

  appendEvent(job, message) {
    const events = this.events.get(job.id) || [];
    events.push(eventForStatus(job, message));
    this.events.set(job.id, events);
  }

  appendPlatformDevEvent(item, message) {
    const events = this.platformDevEvents.get(item.id) || [];
    events.push(platformDevItemEvent(item, message));
    this.platformDevEvents.set(item.id, events);
  }

  recordGithubDelivery({ repoFullName, deliveryId, eventName, action }) {
    const key = `${repoFullName}:${deliveryId}`;
    if (this.githubDeliveries.has(key)) {
      return { delivery: this.githubDeliveries.get(key), created: false };
    }

    const delivery = {
      repoFullName,
      deliveryId,
      eventName,
      action: action || null,
      status: 'received',
      createdAt: new Date().toISOString(),
    };
    this.githubDeliveries.set(key, delivery);
    return { delivery, created: true };
  }

  updateGithubDelivery(input = {}, patch = {}, now = new Date()) {
    const repoFullName = input.repoFullName || input.repo_full_name;
    const deliveryId = input.deliveryId || input.delivery_id;
    const key = `${repoFullName}:${deliveryId}`;
    const existing = this.githubDeliveries.get(key);
    if (!existing) return null;
    const updated = {
      ...existing,
      ...patch,
      status: patch.status || existing.status || 'received',
      requestId:
        Object.hasOwn(patch, 'requestId') || Object.hasOwn(patch, 'request_id')
          ? patch.requestId || patch.request_id || null
          : existing.requestId || null,
      payloadHash:
        Object.hasOwn(patch, 'payloadHash') || Object.hasOwn(patch, 'payload_hash')
          ? patch.payloadHash || patch.payload_hash || null
          : existing.payloadHash || null,
      updatedAt: now.toISOString(),
    };
    this.githubDeliveries.set(key, updated);
    return updated;
  }

  slackDeliveryKey(teamId, eventId) {
    return `${teamId || 'unknown-team'}:${eventId || 'unknown-event'}`;
  }

  recordSlackDelivery(input = {}) {
    const key = this.slackDeliveryKey(input.teamId, input.eventId);
    if (this.slackDeliveries.has(key)) {
      return { delivery: this.slackDeliveries.get(key), created: false };
    }

    const now = new Date().toISOString();
    const delivery = {
      teamId: input.teamId || 'unknown-team',
      eventId: input.eventId || 'unknown-event',
      eventType: input.eventType || null,
      action: input.action || null,
      processingStatus: input.processingStatus || input.processing_status || 'received',
      resultType: input.resultType || input.result_type || 'none',
      ignoredReason: input.ignoredReason || input.ignored_reason || null,
      errorCode: input.errorCode || input.error_code || null,
      errorMessage: input.errorMessage || input.error_message || null,
      retryNum: input.retryNum || input.retry_num || 0,
      retryReason: input.retryReason || input.retry_reason || null,
      requestId: input.requestId || input.request_id || null,
      channelId: input.channelId || input.channel_id || null,
      threadTs: input.threadTs || input.thread_ts || null,
      slackUserId: input.slackUserId || input.slack_user_id || null,
      slackSessionId: input.slackSessionId || input.slack_session_id || null,
      publishingJobId: input.publishingJobId || input.publishing_job_id || null,
      workItemKind: input.workItemKind || input.work_item_kind || null,
      workItemId: input.workItemId || input.work_item_id || null,
      platformDevItemId: input.platformDevItemId || input.platform_dev_item_id || null,
      agentRunId: input.agentRunId || input.agent_run_id || null,
      payloadRedacted: input.payloadRedacted || input.payload_redacted || input.payloadRedactedJson || null,
      payloadHash: input.payloadHash || input.payload_hash || null,
      receivedAt: input.receivedAt || input.received_at || now,
      createdAt: now,
      updatedAt: now,
    };
    this.slackDeliveries.set(key, delivery);
    return { delivery, created: true };
  }

  updateSlackDelivery(input = {}, patch = {}, now = new Date()) {
    const key = input.key || this.slackDeliveryKey(input.teamId, input.eventId);
    const existing = this.slackDeliveries.get(key);
    if (!existing) return null;

    const updated = {
      ...existing,
      ...patch,
      processingStatus: patch.processingStatus || patch.processing_status || existing.processingStatus,
      resultType: patch.resultType || patch.result_type || existing.resultType || 'none',
      ignoredReason:
        Object.hasOwn(patch, 'ignoredReason') || Object.hasOwn(patch, 'ignored_reason')
          ? patch.ignoredReason || patch.ignored_reason || null
          : existing.ignoredReason || null,
      errorCode:
        Object.hasOwn(patch, 'errorCode') || Object.hasOwn(patch, 'error_code')
          ? patch.errorCode || patch.error_code || null
          : existing.errorCode || null,
      errorMessage:
        Object.hasOwn(patch, 'errorMessage') || Object.hasOwn(patch, 'error_message')
          ? patch.errorMessage || patch.error_message || null
          : existing.errorMessage || null,
      retryNum:
        Object.hasOwn(patch, 'retryNum') || Object.hasOwn(patch, 'retry_num')
          ? Number(patch.retryNum ?? patch.retry_num ?? 0)
          : existing.retryNum || 0,
      retryReason:
        Object.hasOwn(patch, 'retryReason') || Object.hasOwn(patch, 'retry_reason')
          ? patch.retryReason || patch.retry_reason || null
          : existing.retryReason || null,
      updatedAt: now.toISOString(),
    };
    this.slackDeliveries.set(key, updated);
    return updated;
  }

  listSlackDeliveries(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const offset = Math.max(Number(options.offset) || 0, 0);
    const deliveries = [...this.slackDeliveries.values()]
      .filter((delivery) => {
        if (options.teamId && delivery.teamId !== options.teamId) return false;
        if (options.eventId && delivery.eventId !== options.eventId) return false;
        if (options.slackSessionId && delivery.slackSessionId !== options.slackSessionId) return false;
        if (options.publishingJobId && delivery.publishingJobId !== options.publishingJobId) return false;
        if (options.workItemKind && delivery.workItemKind !== options.workItemKind) return false;
        if (options.workItemId && delivery.workItemId !== options.workItemId) return false;
        if (options.platformDevItemId && delivery.platformDevItemId !== options.platformDevItemId) return false;
        if (options.processingStatus && delivery.processingStatus !== options.processingStatus) return false;
        if (options.channelId && delivery.channelId !== options.channelId) return false;
        return true;
      })
      .sort((left, right) => {
        const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
        const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
        return rightTime - leftTime;
      });

    return {
      deliveries: deliveries.slice(offset, offset + limit),
      total: deliveries.length,
      limit,
      offset,
    };
  }

  findJobByPrNumber(prNumber, options = {}) {
    const normalized = Number(prNumber);
    const candidates = [...this.jobs.values()].filter((job) => Number(job.prNumber) === normalized).reverse();
    if (!candidates.length) return null;

    if (options.headSha) {
      const matched = candidates.find((job) => shaMatches(job.headSha, options.headSha));
      if (matched) return matched;
      return null;
    }

    return candidates.find((job) => REVIEW_ACTIVE_JOB_STATUSES.has(job.status)) || candidates[0];
  }

  findPlatformDevItemByIssueNumber(issueNumber) {
    const normalized = Number(issueNumber);
    return (
      [...this.platformDevItems.values()]
        .filter((item) => Number(item.githubIssueNumber) === normalized)
        .sort((left, right) => {
          const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
          const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
          return rightTime - leftTime;
        })[0] || null
    );
  }

  findPlatformDevItemByPrNumber(prNumber, options = {}) {
    const normalized = Number(prNumber);
    const candidates = [...this.platformDevItems.values()].filter((item) => Number(item.githubPrNumber) === normalized).reverse();
    if (!candidates.length) return null;

    if (options.headSha) {
      const matched = candidates.find((item) => shaMatches(item.headSha, options.headSha));
      if (matched) return matched;
      return null;
    }

    return candidates.find((item) => REVIEW_ACTIVE_PLATFORM_STATUSES.has(item.status)) || candidates[0];
  }

  recordReviewAgentComment(comment) {
    const key = `${comment.repoFullName}:${comment.githubCommentNodeId}`;
    const now = new Date().toISOString();
    const existing = this.reviewAgentComments.get(key);
    const stored = {
      ...(existing || {}),
      ...comment,
      firstSeenDeliveryId: existing?.firstSeenDeliveryId || comment.firstSeenDeliveryId,
      lastSeenDeliveryId: comment.lastSeenDeliveryId || comment.firstSeenDeliveryId,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.reviewAgentComments.set(key, stored);
    return { comment: stored, created: !existing };
  }

  recordSiteCheckRun(run) {
    const key = `${run.repoFullName}:${run.checkRunNodeId || run.checkRunId}`;
    const now = new Date().toISOString();
    const existing = this.siteCheckRuns.get(key);
    const stored = {
      ...(existing || {}),
      ...run,
      firstSeenDeliveryId: existing?.firstSeenDeliveryId || run.firstSeenDeliveryId,
      lastSeenDeliveryId: run.lastSeenDeliveryId || run.firstSeenDeliveryId,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.siteCheckRuns.set(key, stored);
    return { run: stored, created: !existing };
  }

  listSiteCheckRuns(repoFullName, prNumber, options = {}) {
    const normalized = Number(prNumber);
    return [...this.siteCheckRuns.values()]
      .filter((run) => {
        if (run.repoFullName !== repoFullName || Number(run.prNumber) !== normalized) return false;
        if (!options.headSha) return true;
        return shaMatches(run.headSha, options.headSha);
      })
      .sort((left, right) => {
        const leftTime = new Date(left.completedAt || left.updatedAt || left.createdAt || 0).getTime();
        const rightTime = new Date(right.completedAt || right.updatedAt || right.createdAt || 0).getTime();
        return rightTime - leftTime;
      });
  }

  siteCheckGateForPr(repoFullName, prNumber, options = {}) {
    const runs = this.listSiteCheckRuns(repoFullName, prNumber, options);
    const latest = runs[0] || null;
    const passed = latest?.status === 'completed' && latest.conclusion === 'success';

    return {
      prNumber: Number(prNumber),
      required: true,
      passed,
      status: latest?.status || 'missing',
      conclusion: latest?.conclusion || null,
      checkName: latest?.checkName || null,
      checkRunId: latest?.checkRunId || null,
      detailsUrl: latest?.detailsUrl || latest?.htmlUrl || null,
      latestRun: latest,
    };
  }

  listReviewAgentComments(repoFullName, prNumber, options = {}) {
    const normalized = Number(prNumber);
    return [...this.reviewAgentComments.values()].filter((comment) => {
      if (comment.repoFullName !== repoFullName || Number(comment.prNumber) !== normalized) return false;
      if (!options.headSha) return true;
      return shaMatches(comment.headSha, options.headSha);
    });
  }

  listReviewAgentCommentsForPrNumber(prNumber, options = {}) {
    const normalized = Number(prNumber);
    if (!Number.isFinite(normalized)) return [];
    return [...this.reviewAgentComments.values()]
      .filter((comment) => {
        if (Number(comment.prNumber) !== normalized) return false;
        if (options.repoFullName && comment.repoFullName !== options.repoFullName) return false;
        if (!options.headSha) return true;
        return shaMatches(comment.headSha, options.headSha);
      })
      .sort((left, right) => {
        const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
        const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
        return rightTime - leftTime;
      });
  }

  listGithubDeliveries(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const offset = Math.max(Number(options.offset) || 0, 0);
    const deliveries = [...this.githubDeliveries.values()]
      .filter((delivery) => {
        if (options.repoFullName && delivery.repoFullName !== options.repoFullName) return false;
        if (options.eventName && delivery.eventName !== options.eventName) return false;
        if (options.action && delivery.action !== options.action) return false;
        return true;
      })
      .sort((left, right) => {
        const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
        const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
        return rightTime - leftTime;
      });

    return {
      deliveries: deliveries.slice(offset, offset + limit),
      total: deliveries.length,
      limit,
      offset,
    };
  }

  reviewGateForPr(repoFullName, prNumber, options = {}) {
    const openComments = this.listReviewAgentComments(repoFullName, prNumber, options)
      .filter((comment) => comment.status === 'open')
      .map((comment) => ({
        ...comment,
        classification: classifyReviewAgentComment(comment),
      }));
    const blocking = openComments.filter((comment) => comment.classification === 'blocking');
    const unknown = openComments.filter((comment) => comment.classification === 'unknown');

    return {
      prNumber: Number(prNumber),
      openCount: openComments.length,
      blockingCount: blocking.length,
      unknownCount: unknown.length,
      suggestionCount: openComments.filter((comment) => comment.classification === 'suggestion').length,
      noteCount: openComments.filter((comment) => comment.classification === 'note').length,
      canPreview: blocking.length === 0 && unknown.length === 0,
    };
  }

  previewGateForPr(repoFullName, prNumber, options = {}) {
    const reviewGate = this.reviewGateForPr(repoFullName, prNumber, options);
    const siteCheckGate = this.siteCheckGateForPr(repoFullName, prNumber, options);

    return {
      ...reviewGate,
      reviewGate,
      siteCheck: siteCheckGate,
      siteCheckPassed: siteCheckGate.passed,
      canPreview: reviewGate.canPreview && siteCheckGate.passed,
    };
  }

  hasSlackNotification(jobId, key) {
    return this.slackNotifications.has(`${jobId}:${key}`);
  }

  recordSlackNotification(jobId, key) {
    this.slackNotifications.add(`${jobId}:${key}`);
  }

  claimSlackNotification(jobId, key) {
    const notificationKey = `${jobId}:${key}`;
    if (this.slackNotifications.has(notificationKey)) return false;
    this.slackNotifications.add(notificationKey);
    return true;
  }

  releaseSlackNotification(jobId, key) {
    this.slackNotifications.delete(`${jobId}:${key}`);
  }

  getSlackJobStatusMessage(jobId, options = {}) {
    return this.slackJobStatusMessages.get(`${jobId}:${slackStatusScopeKey(options)}`) || null;
  }

  recordSlackJobStatusMessage(jobId, input = {}, now = new Date()) {
    const scopeKey = slackStatusScopeKey(input);
    const existing = this.getSlackJobStatusMessage(jobId, { scopeKey });
    const nowIso = now.toISOString();
    const message = {
      ...(existing || {}),
      id: existing?.id || makeId('slackmsg'),
      jobId,
      slackSessionId: input.slackSessionId ?? existing?.slackSessionId ?? null,
      scopeKey,
      channel: input.channel ?? existing?.channel ?? null,
      threadTs: input.threadTs ?? existing?.threadTs ?? null,
      messageTs: input.messageTs ?? input.ts ?? existing?.messageTs ?? null,
      stage: input.stage ?? existing?.stage ?? null,
      status: input.status ?? existing?.status ?? null,
      updatedAt: nowIso,
      createdAt: existing?.createdAt || nowIso,
    };
    this.slackJobStatusMessages.set(`${jobId}:${scopeKey}`, message);
    return message;
  }

  getSlackWorkItemStatusMessage(workItemKind, workItemId, options = {}) {
    const scopeKey = options.scopeKey || (options.slackSessionId ? `session:${options.slackSessionId}` : 'work-item');
    return this.slackWorkItemStatusMessages.get(`${workItemKind}:${workItemId}:${scopeKey}`) || null;
  }

  recordSlackWorkItemStatusMessage(workItemKind, workItemId, input = {}, now = new Date()) {
    const scopeKey = input.scopeKey || (input.slackSessionId ? `session:${input.slackSessionId}` : 'work-item');
    const existing = this.getSlackWorkItemStatusMessage(workItemKind, workItemId, { scopeKey });
    const nowIso = now.toISOString();
    const message = {
      ...(existing || {}),
      id: existing?.id || makeId('slackmsg'),
      workItemKind,
      workItemId,
      slackSessionId: input.slackSessionId ?? existing?.slackSessionId ?? null,
      scopeKey,
      channel: input.channel ?? existing?.channel ?? null,
      threadTs: input.threadTs ?? existing?.threadTs ?? null,
      messageTs: input.messageTs ?? input.ts ?? existing?.messageTs ?? null,
      stage: input.stage ?? existing?.stage ?? null,
      status: input.status ?? existing?.status ?? null,
      updatedAt: nowIso,
      createdAt: existing?.createdAt || nowIso,
    };
    this.slackWorkItemStatusMessages.set(`${workItemKind}:${workItemId}:${scopeKey}`, message);
    return message;
  }

  getSlackAgentReplyMessage(agentRunId) {
    return this.slackAgentReplyMessages.get(agentRunId) || null;
  }

  getLatestSlackAgentReplyMessageForSession(slackSessionId) {
    if (!slackSessionId) return null;
    return (
      [...this.slackAgentReplyMessages.values()]
        .filter((message) => message.slackSessionId === slackSessionId)
        .sort((left, right) => {
          const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
          const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
          return rightTime - leftTime;
        })[0] || null
    );
  }

  recordSlackAgentReplyMessage(agentRunId, input = {}, now = new Date()) {
    const existing = this.getSlackAgentReplyMessage(agentRunId);
    const nowIso = now.toISOString();
    const message = {
      ...(existing || {}),
      id: existing?.id || makeId('slackreply'),
      slackSessionId: input.slackSessionId ?? existing?.slackSessionId ?? null,
      agentRunId,
      channel: input.channel ?? existing?.channel ?? null,
      threadTs: input.threadTs ?? existing?.threadTs ?? null,
      messageTs: input.messageTs ?? input.ts ?? existing?.messageTs ?? null,
      textSnapshot: input.textSnapshot ?? input.text ?? existing?.textSnapshot ?? '',
      lastSequence: input.lastSequence ?? input.sequence ?? existing?.lastSequence ?? 0,
      status: input.status ?? existing?.status ?? 'running',
      updatedAt: nowIso,
      createdAt: existing?.createdAt || nowIso,
    };
    this.slackAgentReplyMessages.set(agentRunId, message);
    return message;
  }

  recordAgentRunEvent(input = {}, now = new Date()) {
    const dedupeKey = input.dedupeKey || input.dedupe_key || null;
    if (dedupeKey && this.agentRunEventByDedupeKey.has(dedupeKey)) {
      return { event: this.agentRunEvents.get(this.agentRunEventByDedupeKey.get(dedupeKey)), created: false };
    }

    const nowIso = now.toISOString();
    const event = {
      id: input.id || makeId('agentevent'),
      publishingJobId: input.publishingJobId || input.publishing_job_id || null,
      workItemKind: input.workItemKind || input.work_item_kind || null,
      workItemId: input.workItemId || input.work_item_id || null,
      slackSessionId: input.slackSessionId || input.slack_session_id || null,
      agentRunId: input.agentRunId || input.agent_run_id || null,
      type: input.type || 'job_progress',
      stage: input.stage || null,
      text: input.text || '',
      status: input.status || 'recorded',
      dedupeKey,
      slackChannelId: input.slackChannelId || input.slack_channel_id || null,
      slackThreadTs: input.slackThreadTs || input.slack_thread_ts || null,
      slackMessageTs: input.slackMessageTs || input.slack_message_ts || null,
      createdAt: nowIso,
    };
    this.agentRunEvents.set(event.id, event);
    if (dedupeKey) this.agentRunEventByDedupeKey.set(dedupeKey, event.id);
    return { event, created: true };
  }

  listAgentRunEventsForJob(publishingJobId) {
    return [...this.agentRunEvents.values()]
      .filter((event) => event.publishingJobId === publishingJobId)
      .sort((left, right) => {
        const leftTime = new Date(left.createdAt || 0).getTime();
        const rightTime = new Date(right.createdAt || 0).getTime();
        return leftTime - rightTime;
      });
  }

  listAgentRunEventsForWorkItem(workItemKind, workItemId) {
    return [...this.agentRunEvents.values()]
      .filter((event) => event.workItemKind === workItemKind && event.workItemId === workItemId)
      .sort((left, right) => {
        const leftTime = new Date(left.createdAt || 0).getTime();
        const rightTime = new Date(right.createdAt || 0).getTime();
        return leftTime - rightTime;
      });
  }

  slackSessionScopeKey(input) {
    return [input.teamId, input.primarySlackUserId, input.sessionKey].join(':');
  }

  findSlackSessionByScope(teamId, slackUserId, sessionKey) {
    const sessionId = this.slackSessionByScopeKey.get([teamId, slackUserId, sessionKey].join(':'));
    return sessionId ? this.getSlackSession(sessionId) : null;
  }

  upsertSlackSession(input, now = new Date()) {
    const scopeKey = this.slackSessionScopeKey(input);
    const existingId = input.id || this.slackSessionByScopeKey.get(scopeKey);
    const existing = existingId ? this.slackSessions.get(existingId) : null;
    const nowIso = now.toISOString();
    const session = {
      id: existing?.id || input.id || makeId('sess'),
      teamId: input.teamId,
      sessionKey: input.sessionKey,
      sessionTitle: input.sessionTitle || existing?.sessionTitle || 'Slack conversation',
      channelId: input.channelId ?? existing?.channelId ?? null,
      threadTs: input.threadTs ?? existing?.threadTs ?? null,
      dmChannelId: input.dmChannelId ?? existing?.dmChannelId ?? null,
      surfaceContext: input.surfaceContext || existing?.surfaceContext || {},
      primarySlackUserId: input.primarySlackUserId,
      ownerScopeId: fieldOrExisting(input, existing, 'ownerScopeId'),
      activeJobId: fieldOrExisting(input, existing, 'activeJobId'),
      activeWorkItemKind: fieldOrExisting(input, existing, 'activeWorkItemKind'),
      activeWorkItemId: fieldOrExisting(input, existing, 'activeWorkItemId'),
      activeIssueNumber: fieldOrExisting(input, existing, 'activeIssueNumber'),
      activePrNumber: fieldOrExisting(input, existing, 'activePrNumber'),
      activePreviewUrl: fieldOrExisting(input, existing, 'activePreviewUrl'),
      activeContextExpiresAt: fieldOrExisting(input, existing, 'activeContextExpiresAt'),
      status: input.status || existing?.status || 'active',
      lastIntent: input.lastIntent || existing?.lastIntent || null,
      lastActiveAt: input.lastActiveAt || nowIso,
      closedAt: Object.hasOwn(input, 'closedAt') ? input.closedAt : (existing?.closedAt ?? null),
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
    };

    this.slackSessions.set(session.id, session);
    this.slackSessionByScopeKey.set(scopeKey, session.id);
    if (!this.sessionMemories.has(session.id)) {
      this.getSessionMemory(session.id);
    }
    return session;
  }

  getSlackSession(sessionId) {
    return this.slackSessions.get(sessionId) || null;
  }

  findSlackSessionsForUser(teamId, slackUserId, options = {}) {
    const sessions = [...this.slackSessions.values()].filter((session) => {
      if (session.teamId !== teamId || session.primarySlackUserId !== slackUserId) return false;
      if (options.statuses && !options.statuses.includes(session.status)) return false;
      return true;
    });

    return sessions.sort((left, right) => {
      const leftTime = new Date(left.lastActiveAt || left.updatedAt || left.createdAt || 0).getTime();
      const rightTime = new Date(right.lastActiveAt || right.updatedAt || right.createdAt || 0).getTime();
      return rightTime - leftTime;
    });
  }

  getSessionMemory(sessionId) {
    const existing = this.sessionMemories.get(sessionId);
    if (existing) return existing;

    const now = new Date().toISOString();
    const memory = {
      id: makeId('mem'),
      slackSessionId: sessionId,
      summary: '',
      requirements: {},
      pendingQuestions: [],
      preferences: {},
      repoQuestionContext: {},
      conversationContext: {},
      lastPreviewFeedback: null,
      lastAgentResponse: null,
      createdAt: now,
      updatedAt: now,
    };
    this.sessionMemories.set(sessionId, memory);
    return memory;
  }

  updateSessionMemory(sessionId, patch = {}, now = new Date()) {
    const existing = this.getSessionMemory(sessionId);
    const memory = {
      ...existing,
      ...patch,
      slackSessionId: sessionId,
      updatedAt: now.toISOString(),
    };
    this.sessionMemories.set(sessionId, memory);
    return memory;
  }

  closeSlackSession(sessionId, now = new Date()) {
    const existing = this.getSlackSession(sessionId);
    if (!existing) return null;

    const closedAt = now.toISOString();
    const session = {
      ...existing,
      status: 'closed',
      activeJobId: null,
      activeWorkItemKind: null,
      activeWorkItemId: null,
      activeIssueNumber: null,
      activePrNumber: null,
      activePreviewUrl: null,
      activeContextExpiresAt: null,
      closedAt,
      lastActiveAt: closedAt,
      updatedAt: closedAt,
    };
    this.slackSessions.set(sessionId, session);
    return session;
  }

  linkJobToSlackSession(job, session, now = new Date()) {
    if (!job?.id) return null;
    const existingByJob = this.findIssueLinkByJobId(job.id);
    const slackSessionId = session?.id || job.slackSessionId || existingByJob?.slackSessionId;
    if (!slackSessionId) return null;

    const existing = this.findIssueLinkForSlackSessionAndJob(slackSessionId, job.id);
    const nowIso = now.toISOString();
    const link = {
      id: existing?.id || makeId('issuelink'),
      slackSessionId,
      publishingJobId: job.id,
      issueNumber: job.issueNumber ?? existing?.issueNumber ?? null,
      prNumber: job.prNumber ?? existing?.prNumber ?? null,
      branchName: job.branchName ?? existing?.branchName ?? null,
      previewUrl: job.previewUrl ?? existing?.previewUrl ?? null,
      headSha: job.headSha ?? existing?.headSha ?? null,
      relationship: existing?.relationship || 'primary',
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
    };
    this.issueLinks.set(link.id, link);
    if (link.issueNumber) this.issueLinkByIssueNumber.set(String(link.issueNumber), link);
    if (link.prNumber) this.issueLinkByPrNumber.set(String(link.prNumber), link);

    const currentSession = this.getSlackSession(slackSessionId);
    if (currentSession && currentSession.status !== 'closed') {
      const active = jobKeepsSlackSessionActive(job);
      this.upsertSlackSession(
        {
          ...currentSession,
          status: 'active',
          closedAt: null,
          activeJobId: active ? job.id : null,
          activeWorkItemKind: active ? 'site_publishing' : null,
          activeWorkItemId: active ? job.id : null,
          activeIssueNumber: active ? link.issueNumber : null,
          activePrNumber: active ? link.prNumber : null,
          activePreviewUrl: active ? link.previewUrl : null,
          activeContextExpiresAt: active ? currentSession.activeContextExpiresAt : null,
        },
        now
      );
    }

    return link;
  }

  findIssueLinkForSlackSessionAndJob(slackSessionId, jobId) {
    return (
      [...this.issueLinks.values()].find((link) => link.slackSessionId === slackSessionId && link.publishingJobId === jobId) ||
      null
    );
  }

  findIssueLinkByJobId(jobId) {
    return (
      [...this.issueLinks.values()]
        .filter((link) => link.publishingJobId === jobId)
        .sort((left, right) => {
          const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
          const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
          return rightTime - leftTime;
        })[0] || null
    );
  }

  findIssueLinkByIssueNumber(issueNumber) {
    return this.issueLinkByIssueNumber.get(String(issueNumber)) || null;
  }

  findIssueLinkByPrNumber(prNumber) {
    return this.issueLinkByPrNumber.get(String(prNumber)) || null;
  }

  findIssueLinksForSlackSession(slackSessionId) {
    return [...this.issueLinks.values()]
      .filter((link) => link.slackSessionId === slackSessionId)
      .sort((left, right) => {
        const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
        const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
        return rightTime - leftTime;
      });
  }

  linkPlatformDevItemToSlackSession(item, session, now = new Date()) {
    return this.linkWorkItemToSlackSession({ ...item, workItemKind: 'platform_dev' }, session, now);
  }

  linkWorkItemToSlackSession(workItem, session, now = new Date()) {
    if (!workItem?.id) return null;
    const workItemKind = workItem.workItemKind || 'platform_dev';
    const slackSessionId = session?.id || workItem.slackSessionId || null;
    if (!slackSessionId) return null;
    const existing = this.findWorkItemLink(workItemKind, workItem.id, 'primary');
    const nowIso = now.toISOString();
    const link = {
      id: existing?.id || makeId('wilink'),
      workItemKind,
      workItemId: workItem.id,
      slackSessionId,
      publishingJobId: workItemKind === 'site_publishing' ? workItem.id : null,
      platformDevItemId: workItemKind === 'platform_dev' ? workItem.id : null,
      issueNumber: workItem.issueNumber ?? workItem.githubIssueNumber ?? existing?.issueNumber ?? null,
      prNumber: workItem.prNumber ?? workItem.githubPrNumber ?? existing?.prNumber ?? null,
      branchName: workItem.branchName ?? existing?.branchName ?? null,
      previewUrl: workItem.previewUrl ?? existing?.previewUrl ?? null,
      headSha: workItem.headSha ?? existing?.headSha ?? null,
      relationship: existing?.relationship || 'primary',
      createdAt: existing?.createdAt || nowIso,
      updatedAt: nowIso,
    };
    this.workItemLinks.set(link.id, link);
    if (link.issueNumber) this.workItemLinkByIssueNumber.set(String(link.issueNumber), link);
    if (link.prNumber) this.workItemLinkByPrNumber.set(String(link.prNumber), link);

    const currentSession = this.getSlackSession(slackSessionId);
    if (currentSession && currentSession.status !== 'closed') {
      const active =
        workItemKind === 'platform_dev' ? platformDevKeepsSlackSessionActive(workItem) : jobKeepsSlackSessionActive(workItem);
      this.upsertSlackSession(
        {
          ...currentSession,
          status: 'active',
          closedAt: null,
          activeJobId: workItemKind === 'site_publishing' && active ? workItem.id : null,
          activeWorkItemKind: active ? workItemKind : null,
          activeWorkItemId: active ? workItem.id : null,
          activeIssueNumber: active ? link.issueNumber : null,
          activePrNumber: active ? link.prNumber : null,
          activePreviewUrl: active ? link.previewUrl : null,
          activeContextExpiresAt: active ? currentSession.activeContextExpiresAt : null,
        },
        now
      );
    }

    return link;
  }

  findWorkItemLink(workItemKind, workItemId, relationship = 'primary') {
    return (
      [...this.workItemLinks.values()].find(
        (link) => link.workItemKind === workItemKind && link.workItemId === workItemId && link.relationship === relationship
      ) || null
    );
  }

  findWorkItemLinkByIssueNumber(issueNumber) {
    return this.workItemLinkByIssueNumber.get(String(issueNumber)) || null;
  }

  findWorkItemLinkByPrNumber(prNumber) {
    return this.workItemLinkByPrNumber.get(String(prNumber)) || null;
  }

  listWorkItemLinksForSlackSession(slackSessionId) {
    return [...this.workItemLinks.values()]
      .filter((link) => link.slackSessionId === slackSessionId)
      .sort((left, right) => {
        const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
        const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
        return rightTime - leftTime;
      });
  }

  listWorkItemsForSlackUser(teamId, slackUserId, options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 5, 1), 20);
    const requestedById = `slack:${teamId || 'unknown-team'}:${slackUserId || 'unknown-user'}`;
    const siteJobs = [...this.jobs.values()]
      .filter((job) => job.source === 'slack' && job.requestedById === requestedById)
      .filter((job) => {
        if (!options.statuses?.length) return true;
        return options.statuses.includes(job.status);
      })
      .map((job) => ({ ...job, workItemKind: 'site_publishing' }));
    const platformItems = [...this.platformDevItems.values()]
      .filter((item) => item.source === 'slack' && item.requestedById === requestedById)
      .filter((item) => {
        if (!options.statuses?.length) return true;
        return options.statuses.includes(item.status);
      })
      .map((item) => ({
        ...item,
        workItemKind: 'platform_dev',
        issueNumber: item.githubIssueNumber,
        issueUrl: item.githubIssueUrl,
        prNumber: item.githubPrNumber,
        prUrl: item.githubPrUrl,
        siteSlug: 'pages-manager',
      }));
    const jobs = [...siteJobs, ...platformItems]
      .sort((left, right) => {
        const leftTime = new Date(left.updatedAt || left.createdAt || 0).getTime();
        const rightTime = new Date(right.updatedAt || right.createdAt || 0).getTime();
        return rightTime - leftTime;
      })
      .slice(0, limit);

    return {
      jobs,
      total: jobs.length,
      limit,
      offset: 0,
    };
  }

  listAgentRunsForJob(publishingJobId) {
    return [...this.agentRuns.values()]
      .filter((run) => run.publishingJobId === publishingJobId)
      .sort((left, right) => {
        const leftTime = new Date(left.createdAt || 0).getTime();
        const rightTime = new Date(right.createdAt || 0).getTime();
        return leftTime - rightTime;
      });
  }

  listAgentRunsForSlackSession(slackSessionId) {
    return [...this.agentRuns.values()]
      .filter((run) => run.slackSessionId === slackSessionId)
      .sort((left, right) => {
        const leftTime = new Date(left.createdAt || 0).getTime();
        const rightTime = new Date(right.createdAt || 0).getTime();
        return leftTime - rightTime;
      });
  }

  createAgentRun(input, now = new Date()) {
    const nowIso = now.toISOString();
    const agentKind = input.agentKind || 'slack_agent';
    const relatedRuns = [...this.agentRuns.values()].filter(
      (run) => run.agentKind === agentKind && run.slackSessionId === input.slackSessionId
    );
    const run = {
      id: input.id || makeId('agent'),
      agentKind,
      slackSessionId: input.slackSessionId || null,
      publishingJobId: input.publishingJobId || null,
      workItemKind: input.workItemKind || null,
      workItemId: input.workItemId || null,
      status: input.status || 'running',
      roundNo: input.roundNo || relatedRuns.length + 1,
      provider: input.provider || 'deterministic',
      model: input.model || null,
      modelApiStyle: input.modelApiStyle || null,
      promptVersion: input.promptVersion || null,
      policyVersion: input.policyVersion || null,
      inputSummaryHash: input.inputSummaryHash || null,
      outputHash: input.outputHash || null,
      report: input.report || {},
      errorCode: null,
      errorMessage: null,
      leaseExpiresAt: input.leaseExpiresAt || null,
      timeoutAt: input.timeoutAt || null,
      startedAt: input.startedAt || nowIso,
      completedAt: null,
      createdAt: nowIso,
      updatedAt: nowIso,
    };
    this.agentRuns.set(run.id, run);
    return run;
  }

  getAgentRun(agentRunId) {
    return this.agentRuns.get(agentRunId) || null;
  }

  completeAgentRun(agentRunId, patch = {}, now = new Date()) {
    const existing = this.agentRuns.get(agentRunId);
    if (!existing) return null;
    if (existing.status !== 'running') return existing;
    const updated = {
      ...existing,
      ...patch,
      status: 'completed',
      completedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.agentRuns.set(agentRunId, updated);
    return updated;
  }

  failAgentRun(agentRunId, errorCode, errorMessage, now = new Date()) {
    const existing = this.agentRuns.get(agentRunId);
    if (!existing) return null;
    if (existing.status !== 'running') return existing;
    const updated = {
      ...existing,
      status: 'failed',
      errorCode: errorCode || 'agent_failed',
      errorMessage: errorMessage || errorCode || 'Agent run failed',
      completedAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    this.agentRuns.set(agentRunId, updated);
    return updated;
  }

  clearSlackAgentLeaseForSession() {
    return true;
  }

  acquireSlackAgentLease(slackSessionId, config, now = new Date()) {
    const nowMs = now.getTime();
    const running = [...this.agentRuns.values()].find((run) => {
      if (run.agentKind !== 'slack_agent' || run.slackSessionId !== slackSessionId || run.status !== 'running') {
        return false;
      }
      return run.leaseExpiresAt && new Date(run.leaseExpiresAt).getTime() > nowMs;
    });

    if (running) {
      return { acquired: false, agentRun: running };
    }

    for (const run of this.agentRuns.values()) {
      if (run.agentKind !== 'slack_agent' || run.slackSessionId !== slackSessionId || run.status !== 'running') {
        continue;
      }
      if (run.leaseExpiresAt && new Date(run.leaseExpiresAt).getTime() <= nowMs) {
        this.failAgentRun(run.id, 'agent_lease_expired', 'Slack Agent lease expired', now);
      }
    }

    const agentRun = this.createAgentRun(
      {
        agentKind: 'slack_agent',
        slackSessionId,
        leaseExpiresAt: new Date(nowMs + config.slackAgentSessionLeaseMs).toISOString(),
        timeoutAt: new Date(nowMs + config.slackAgentTurnTimeoutMs).toISOString(),
      },
      now
    );
    return { acquired: true, agentRun };
  }
}
