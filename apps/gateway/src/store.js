import {
  buildPublishingJob,
  canTransition,
  eventForStatus,
  idempotencyScopeForInput,
  idempotencyScopeForJob,
  makeId,
  transitionJob,
} from '@xd/workflow-core';

import { classifyReviewAgentComment } from './github-review.js';

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

function shaMatches(left, right) {
  if (!left || !right) return false;
  const normalizedLeft = String(left).toLowerCase();
  const normalizedRight = String(right).toLowerCase();
  if (normalizedLeft.length < 7 || normalizedRight.length < 7) return false;
  return normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}

export class MemoryGatewayStore {
  constructor() {
    this.backend = 'memory';
    this.jobs = new Map();
    this.idempotency = new Map();
    this.events = new Map();
    this.githubDeliveries = new Map();
    this.slackDeliveries = new Map();
    this.reviewAgentComments = new Map();
    this.slackNotifications = new Set();
    this.slackJobStatusMessages = new Map();
    this.agentRunEvents = new Map();
    this.agentRunEventByDedupeKey = new Map();
    this.slackSessions = new Map();
    this.slackSessionByScopeKey = new Map();
    this.sessionMemories = new Map();
    this.issueLinks = new Map();
    this.issueLinkByJobId = new Map();
    this.issueLinkByIssueNumber = new Map();
    this.issueLinkByPrNumber = new Map();
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

  listJobs(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const offset = Math.max(Number(options.offset) || 0, 0);
    const status = options.status ? String(options.status) : null;
    const source = options.source ? String(options.source) : null;
    const query = options.q ? String(options.q).trim().toLowerCase() : '';

    const jobs = [...this.jobs.values()]
      .filter((job) => {
        if (status && job.status !== status) return false;
        if (source && job.source !== source) return false;
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

  failJob(jobId, errorCode, errorMessage) {
    const job = this.getJob(jobId);
    if (!job) return null;

    const updated = transitionJob(job, 'failed', { errorCode, errorMessage });
    this.jobs.set(jobId, updated);
    this.appendEvent(updated, errorMessage || errorCode || 'PublishingJob failed');
    return updated;
  }

  appendEvent(job, message) {
    const events = this.events.get(job.id) || [];
    events.push(eventForStatus(job, message));
    this.events.set(job.id, events);
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
      agentRunId: input.agentRunId || input.agent_run_id || null,
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
    }

    return candidates.find((job) => REVIEW_ACTIVE_JOB_STATUSES.has(job.status)) || candidates[0];
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

  hasSlackNotification(jobId, key) {
    return this.slackNotifications.has(`${jobId}:${key}`);
  }

  recordSlackNotification(jobId, key) {
    this.slackNotifications.add(`${jobId}:${key}`);
  }

  getSlackJobStatusMessage(jobId) {
    return this.slackJobStatusMessages.get(jobId) || null;
  }

  recordSlackJobStatusMessage(jobId, input = {}, now = new Date()) {
    const existing = this.getSlackJobStatusMessage(jobId);
    const nowIso = now.toISOString();
    const message = {
      ...(existing || {}),
      jobId,
      channel: input.channel ?? existing?.channel ?? null,
      threadTs: input.threadTs ?? existing?.threadTs ?? null,
      messageTs: input.messageTs ?? input.ts ?? existing?.messageTs ?? null,
      stage: input.stage ?? existing?.stage ?? null,
      status: input.status ?? existing?.status ?? null,
      updatedAt: nowIso,
      createdAt: existing?.createdAt || nowIso,
    };
    this.slackJobStatusMessages.set(jobId, message);
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
      ownerScopeId: input.ownerScopeId ?? existing?.ownerScopeId ?? null,
      activeJobId: input.activeJobId ?? existing?.activeJobId ?? null,
      activeIssueNumber: input.activeIssueNumber ?? existing?.activeIssueNumber ?? null,
      activePrNumber: input.activePrNumber ?? existing?.activePrNumber ?? null,
      activePreviewUrl: input.activePreviewUrl ?? existing?.activePreviewUrl ?? null,
      activeContextExpiresAt: input.activeContextExpiresAt ?? existing?.activeContextExpiresAt ?? null,
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
    const slackSessionId = session?.id || job.slackSessionId || this.issueLinkByJobId.get(job.id)?.slackSessionId;
    if (!slackSessionId) return null;

    const existingId = this.issueLinkByJobId.get(job.id)?.id;
    const existing = existingId ? this.issueLinks.get(existingId) : null;
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
    this.issueLinkByJobId.set(job.id, link);
    if (link.issueNumber) this.issueLinkByIssueNumber.set(String(link.issueNumber), link);
    if (link.prNumber) this.issueLinkByPrNumber.set(String(link.prNumber), link);

    const currentSession = this.getSlackSession(slackSessionId);
    if (currentSession) {
      this.upsertSlackSession(
        {
          ...currentSession,
          status: 'active',
          closedAt: null,
          activeJobId: job.id,
          activeIssueNumber: link.issueNumber,
          activePrNumber: link.prNumber,
          activePreviewUrl: link.previewUrl,
        },
        now
      );
    }

    return link;
  }

  findIssueLinkByJobId(jobId) {
    return this.issueLinkByJobId.get(jobId) || null;
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

  completeAgentRun(agentRunId, patch = {}, now = new Date()) {
    const existing = this.agentRuns.get(agentRunId);
    if (!existing) return null;
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
