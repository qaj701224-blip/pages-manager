import { canTransition, makeId, transitionJob } from '@xd/workflow-core';

import { MemoryGatewayStore } from '../store.js';
import { createMysqlPool } from './client.js';

function toDb(value) {
  return value === undefined ? null : value;
}

function toDbJson(value) {
  if (value === undefined || value === null) return null;
  return JSON.stringify(value);
}

function fromDbJson(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  }
  return value;
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  return new Date(value);
}

function toIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function queryPlaceholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

function quote(name) {
  return `\`${name}\``;
}

function limitOffsetSql(limit, offset) {
  return `LIMIT ${Number(limit)} OFFSET ${Number(offset)}`;
}

async function execute(pool, sql, params = []) {
  const [rows] = await pool.execute(sql, params.map(toDb));
  return rows;
}

async function upsertRow(pool, table, row, options = {}) {
  const columns = Object.keys(row);
  const insertColumns = columns.map(quote).join(', ');
  const placeholders = queryPlaceholders(columns.length);
  const excluded = new Set(options.excludeUpdate || []);
  const updateColumns = columns.filter((column) => !excluded.has(column));
  const updateSql = updateColumns.map((column) => `${quote(column)} = VALUES(${quote(column)})`).join(', ');

  await execute(
    pool,
    [
      `INSERT INTO ${quote(table)} (${insertColumns}) VALUES (${placeholders})`,
      updateSql ? `ON DUPLICATE KEY UPDATE ${updateSql}` : '',
    ]
      .filter(Boolean)
      .join(' '),
    columns.map((column) => row[column])
  );
}

function slackStatusScopeKey(input = {}) {
  if (input.scopeKey) return String(input.scopeKey);
  if (input.slackSessionId) return `session:${input.slackSessionId}`;
  return 'job';
}

function jobToRow(job) {
  return {
    id: job.id,
    source: job.source,
    requested_by_type: job.requestedByType,
    requested_by_id: job.requestedById,
    idempotency_key: job.idempotencyKey,
    site_project_id: job.siteProjectId,
    owner_scope_id: job.ownerScopeId,
    employee_id: job.employeeId,
    employee_slug: job.employeeSlug,
    site_slug: job.siteSlug,
    intent: job.intent,
    approval_mode: job.approvalMode,
    status: job.status,
    title: job.title,
    summary: job.summary,
    requester_profile_json: toDbJson(job.requesterProfile),
    slack_thread_json: toDbJson(job.slackThread),
    slack_session_id: job.slackSessionId,
    slack_session_key: job.slackSessionKey,
    issue_number: job.issueNumber,
    issue_url: job.issueUrl,
    pr_number: job.prNumber,
    pr_url: job.prUrl,
    branch_name: job.branchName,
    base_ref: job.baseRef,
    head_sha: job.headSha,
    index_snapshot_id: job.indexSnapshotId,
    preview_url: job.previewUrl,
    error_code: job.errorCode,
    error_message: job.errorMessage,
    created_at: toDate(job.createdAt),
    updated_at: toDate(job.updatedAt),
  };
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    requestedByType: row.requested_by_type,
    requestedById: row.requested_by_id,
    idempotencyKey: row.idempotency_key,
    siteProjectId: row.site_project_id || null,
    ownerScopeId: row.owner_scope_id || null,
    employeeId: row.employee_id || null,
    employeeSlug: row.employee_slug,
    siteSlug: row.site_slug,
    intent: row.intent,
    approvalMode: row.approval_mode,
    status: row.status,
    title: row.title || null,
    summary: row.summary || '',
    requesterProfile: fromDbJson(row.requester_profile_json, null),
    slackThread: fromDbJson(row.slack_thread_json, null),
    slackSessionId: row.slack_session_id || null,
    slackSessionKey: row.slack_session_key || null,
    issueNumber: row.issue_number ?? null,
    issueUrl: row.issue_url || null,
    prNumber: row.pr_number ?? null,
    prUrl: row.pr_url || null,
    branchName: row.branch_name || null,
    baseRef: row.base_ref || null,
    headSha: row.head_sha || null,
    indexSnapshotId: row.index_snapshot_id || null,
    previewUrl: row.preview_url || null,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function eventToRow(event) {
  return {
    id: event.id,
    publishing_job_id: event.publishingJobId,
    status: event.status,
    message: event.message,
    request_id: event.requestId || null,
    created_at: toDate(event.createdAt),
  };
}

function rowToEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    publishingJobId: row.publishing_job_id,
    status: row.status,
    message: row.message || '',
    requestId: row.request_id || null,
    createdAt: toIso(row.created_at),
  };
}

function githubDeliveryToRow(delivery) {
  return {
    id: delivery.id || makeId('ghdeliv'),
    repo_full_name: delivery.repoFullName,
    delivery_id: delivery.deliveryId,
    event_name: delivery.eventName,
    action: delivery.action || null,
    status: delivery.status || 'received',
    request_id: delivery.requestId || null,
    payload_hash: delivery.payloadHash || null,
    created_at: toDate(delivery.createdAt),
    updated_at: toDate(delivery.updatedAt || delivery.createdAt),
  };
}

function rowToGithubDelivery(row) {
  if (!row) return null;
  return {
    id: row.id,
    repoFullName: row.repo_full_name,
    deliveryId: row.delivery_id,
    eventName: row.event_name,
    action: row.action || null,
    status: row.status || 'received',
    requestId: row.request_id || null,
    payloadHash: row.payload_hash || null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function slackDeliveryToRow(delivery) {
  return {
    id: delivery.id || makeId('slackevt'),
    team_id: delivery.teamId,
    event_id: delivery.eventId,
    event_type: delivery.eventType,
    action: delivery.action,
    processing_status: delivery.processingStatus || 'received',
    result_type: delivery.resultType || 'none',
    ignored_reason: delivery.ignoredReason,
    error_code: delivery.errorCode,
    error_message: delivery.errorMessage,
    retry_num: delivery.retryNum || 0,
    retry_reason: delivery.retryReason,
    request_id: delivery.requestId,
    channel_id: delivery.channelId,
    thread_ts: delivery.threadTs,
    slack_user_id: delivery.slackUserId,
    slack_session_id: delivery.slackSessionId,
    publishing_job_id: delivery.publishingJobId,
    agent_run_id: delivery.agentRunId,
    payload_redacted_json: toDbJson(delivery.payloadRedacted || delivery.payloadRedactedJson || null),
    payload_hash: delivery.payloadHash || null,
    received_at: toDate(delivery.receivedAt),
    created_at: toDate(delivery.createdAt),
    updated_at: toDate(delivery.updatedAt || delivery.createdAt),
  };
}

function rowToSlackDelivery(row) {
  if (!row) return null;
  return {
    id: row.id,
    teamId: row.team_id,
    eventId: row.event_id,
    eventType: row.event_type || null,
    action: row.action || null,
    processingStatus: row.processing_status || 'received',
    resultType: row.result_type || 'none',
    ignoredReason: row.ignored_reason || null,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    retryNum: row.retry_num || 0,
    retryReason: row.retry_reason || null,
    requestId: row.request_id || null,
    channelId: row.channel_id || null,
    threadTs: row.thread_ts || null,
    slackUserId: row.slack_user_id || null,
    slackSessionId: row.slack_session_id || null,
    publishingJobId: row.publishing_job_id || null,
    agentRunId: row.agent_run_id || null,
    payloadRedacted: fromDbJson(row.payload_redacted_json, null),
    payloadHash: row.payload_hash || null,
    receivedAt: toIso(row.received_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function reviewCommentToRow(comment) {
  return {
    id: comment.id || makeId('review'),
    repo_full_name: comment.repoFullName,
    pr_number: comment.prNumber,
    github_comment_node_id: comment.githubCommentNodeId,
    source_type: comment.sourceType,
    review_agent_login: comment.reviewAgentLogin || null,
    classification: comment.classification || null,
    status: comment.status || 'open',
    path: comment.path || null,
    line: comment.line || null,
    body_redacted: comment.bodyRedacted || comment.body || null,
    body_hash: comment.bodyHash || null,
    head_sha: comment.headSha || null,
    first_seen_delivery_id: comment.firstSeenDeliveryId || null,
    last_seen_delivery_id: comment.lastSeenDeliveryId || comment.firstSeenDeliveryId || null,
    created_at: toDate(comment.createdAt),
    updated_at: toDate(comment.updatedAt || comment.createdAt),
  };
}

function rowToReviewComment(row) {
  if (!row) return null;
  return {
    id: row.id,
    repoFullName: row.repo_full_name,
    prNumber: row.pr_number,
    githubCommentNodeId: row.github_comment_node_id,
    sourceType: row.source_type,
    reviewAgentLogin: row.review_agent_login || null,
    classification: row.classification || null,
    status: row.status || 'open',
    path: row.path || null,
    line: row.line ?? null,
    body: row.body_redacted || '',
    bodyRedacted: row.body_redacted || '',
    bodyHash: row.body_hash || null,
    headSha: row.head_sha || null,
    firstSeenDeliveryId: row.first_seen_delivery_id || null,
    lastSeenDeliveryId: row.last_seen_delivery_id || null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function siteCheckRunToRow(run) {
  return {
    id: run.id || makeId('sitecheck'),
    repo_full_name: run.repoFullName,
    pr_number: run.prNumber,
    check_run_id: run.checkRunId || null,
    check_run_node_id: run.checkRunNodeId,
    check_name: run.checkName,
    app_slug: run.appSlug || null,
    app_name: run.appName || null,
    status: run.status || null,
    conclusion: run.conclusion || null,
    head_sha: run.headSha || null,
    details_url: run.detailsUrl || null,
    html_url: run.htmlUrl || null,
    output_summary: run.outputSummary || null,
    first_seen_delivery_id: run.firstSeenDeliveryId || null,
    last_seen_delivery_id: run.lastSeenDeliveryId || run.firstSeenDeliveryId || null,
    completed_at: toDate(run.completedAt),
    created_at: toDate(run.createdAt),
    updated_at: toDate(run.updatedAt || run.createdAt),
  };
}

function rowToSiteCheckRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    repoFullName: row.repo_full_name,
    prNumber: row.pr_number,
    checkRunId: row.check_run_id || null,
    checkRunNodeId: row.check_run_node_id,
    checkName: row.check_name,
    appSlug: row.app_slug || null,
    appName: row.app_name || null,
    status: row.status || null,
    conclusion: row.conclusion || null,
    headSha: row.head_sha || null,
    detailsUrl: row.details_url || null,
    htmlUrl: row.html_url || null,
    outputSummary: row.output_summary || '',
    firstSeenDeliveryId: row.first_seen_delivery_id || null,
    lastSeenDeliveryId: row.last_seen_delivery_id || null,
    completedAt: toIso(row.completed_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function sessionToRow(session) {
  return {
    id: session.id,
    team_id: session.teamId,
    session_key: session.sessionKey,
    session_title: session.sessionTitle,
    channel_id: session.channelId,
    thread_ts: session.threadTs,
    dm_channel_id: session.dmChannelId,
    surface_context_json: toDbJson(session.surfaceContext || {}),
    primary_slack_user_id: session.primarySlackUserId,
    owner_scope_id: session.ownerScopeId,
    active_job_id: session.activeJobId,
    active_issue_number: session.activeIssueNumber,
    active_pr_number: session.activePrNumber,
    active_preview_url: session.activePreviewUrl,
    active_context_expires_at: toDate(session.activeContextExpiresAt),
    status: session.status || 'active',
    last_intent: session.lastIntent,
    last_active_at: toDate(session.lastActiveAt),
    closed_at: toDate(session.closedAt),
    created_at: toDate(session.createdAt),
    updated_at: toDate(session.updatedAt),
  };
}

function rowToSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    teamId: row.team_id,
    sessionKey: row.session_key,
    sessionTitle: row.session_title || 'Slack conversation',
    channelId: row.channel_id || null,
    threadTs: row.thread_ts || null,
    dmChannelId: row.dm_channel_id || null,
    surfaceContext: fromDbJson(row.surface_context_json, {}),
    primarySlackUserId: row.primary_slack_user_id,
    ownerScopeId: row.owner_scope_id || null,
    activeJobId: row.active_job_id || null,
    activeIssueNumber: row.active_issue_number ?? null,
    activePrNumber: row.active_pr_number ?? null,
    activePreviewUrl: row.active_preview_url || null,
    activeContextExpiresAt: toIso(row.active_context_expires_at),
    status: row.status || 'active',
    lastIntent: row.last_intent || null,
    lastActiveAt: toIso(row.last_active_at),
    closedAt: toIso(row.closed_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function memoryToRow(memory) {
  return {
    id: memory.id,
    slack_session_id: memory.slackSessionId,
    summary: memory.summary || '',
    requirements_json: toDbJson(memory.requirements || {}),
    pending_questions_json: toDbJson(memory.pendingQuestions || []),
    preferences_json: toDbJson(memory.preferences || {}),
    last_preview_feedback: memory.lastPreviewFeedback || null,
    last_agent_response: memory.lastAgentResponse || null,
    created_at: toDate(memory.createdAt),
    updated_at: toDate(memory.updatedAt),
  };
}

function rowToMemory(row) {
  if (!row) return null;
  return {
    id: row.id,
    slackSessionId: row.slack_session_id,
    summary: row.summary || '',
    requirements: fromDbJson(row.requirements_json, {}),
    pendingQuestions: fromDbJson(row.pending_questions_json, []),
    preferences: fromDbJson(row.preferences_json, {}),
    lastPreviewFeedback: row.last_preview_feedback || null,
    lastAgentResponse: row.last_agent_response || null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function issueLinkToRow(link) {
  return {
    id: link.id,
    slack_session_id: link.slackSessionId,
    publishing_job_id: link.publishingJobId,
    issue_number: link.issueNumber,
    pr_number: link.prNumber,
    branch_name: link.branchName,
    preview_url: link.previewUrl,
    head_sha: link.headSha,
    relationship: link.relationship || 'primary',
    created_at: toDate(link.createdAt),
    updated_at: toDate(link.updatedAt),
  };
}

function rowToIssueLink(row) {
  if (!row) return null;
  return {
    id: row.id,
    slackSessionId: row.slack_session_id,
    publishingJobId: row.publishing_job_id,
    issueNumber: row.issue_number ?? null,
    prNumber: row.pr_number ?? null,
    branchName: row.branch_name || null,
    previewUrl: row.preview_url || null,
    headSha: row.head_sha || null,
    relationship: row.relationship || 'primary',
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function agentRunToRow(run) {
  return {
    id: run.id,
    agent_kind: run.agentKind,
    slack_session_id: run.slackSessionId,
    publishing_job_id: run.publishingJobId,
    status: run.status,
    round_no: run.roundNo || 1,
    provider: run.provider,
    model: run.model,
    model_api_style: run.modelApiStyle,
    prompt_version: run.promptVersion,
    policy_version: run.policyVersion,
    input_summary_hash: run.inputSummaryHash,
    output_hash: run.outputHash,
    report_json: toDbJson(run.report || {}),
    error_code: run.errorCode,
    error_message: run.errorMessage,
    lease_expires_at: toDate(run.leaseExpiresAt),
    timeout_at: toDate(run.timeoutAt),
    started_at: toDate(run.startedAt),
    completed_at: toDate(run.completedAt),
    created_at: toDate(run.createdAt),
    updated_at: toDate(run.updatedAt),
  };
}

function rowToAgentRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentKind: row.agent_kind,
    slackSessionId: row.slack_session_id || null,
    publishingJobId: row.publishing_job_id || null,
    status: row.status,
    roundNo: row.round_no || 1,
    provider: row.provider || null,
    model: row.model || null,
    modelApiStyle: row.model_api_style || null,
    promptVersion: row.prompt_version || null,
    policyVersion: row.policy_version || null,
    inputSummaryHash: row.input_summary_hash || null,
    outputHash: row.output_hash || null,
    report: fromDbJson(row.report_json, {}),
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    leaseExpiresAt: toIso(row.lease_expires_at),
    timeoutAt: toIso(row.timeout_at),
    startedAt: toIso(row.started_at),
    completedAt: toIso(row.completed_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

function agentRunEventToRow(event) {
  return {
    id: event.id,
    publishing_job_id: event.publishingJobId,
    slack_session_id: event.slackSessionId,
    agent_run_id: event.agentRunId,
    type: event.type,
    stage: event.stage,
    text: event.text,
    status: event.status,
    dedupe_key: event.dedupeKey,
    slack_channel_id: event.slackChannelId,
    slack_thread_ts: event.slackThreadTs,
    slack_message_ts: event.slackMessageTs,
    created_at: toDate(event.createdAt),
  };
}

function rowToAgentRunEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    publishingJobId: row.publishing_job_id || null,
    slackSessionId: row.slack_session_id || null,
    agentRunId: row.agent_run_id || null,
    type: row.type,
    stage: row.stage || null,
    text: row.text || '',
    status: row.status || 'recorded',
    dedupeKey: row.dedupe_key || null,
    slackChannelId: row.slack_channel_id || null,
    slackThreadTs: row.slack_thread_ts || null,
    slackMessageTs: row.slack_message_ts || null,
    createdAt: toIso(row.created_at),
  };
}

function slackJobStatusMessageToRow(message) {
  return {
    id: message.id || makeId('slackmsg'),
    job_id: message.jobId,
    slack_session_id: message.slackSessionId || null,
    scope_key: message.scopeKey || 'job',
    channel: message.channel,
    thread_ts: message.threadTs,
    message_ts: message.messageTs,
    stage: message.stage,
    status: message.status,
    created_at: toDate(message.createdAt),
    updated_at: toDate(message.updatedAt),
  };
}

function rowToSlackJobStatusMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    jobId: row.job_id,
    slackSessionId: row.slack_session_id || null,
    scopeKey: row.scope_key || 'job',
    channel: row.channel || null,
    threadTs: row.thread_ts || null,
    messageTs: row.message_ts || null,
    stage: row.stage || null,
    status: row.status || null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export class MySqlGatewayStore extends MemoryGatewayStore {
  constructor(pool) {
    super();
    this.backend = 'mysql';
    this.pool = pool;
  }

  static async create(env = process.env) {
    return new MySqlGatewayStore(createMysqlPool(env));
  }

  async health() {
    await execute(this.pool, 'SELECT 1');
    return { ok: true, backend: this.backend };
  }

  async flush() {}

  async close() {
    await this.pool.end();
  }

  cacheJob(job) {
    if (!job) return null;
    this.jobs.set(job.id, job);
    this.idempotency.set([job.source, job.requestedByType, job.requestedById, job.idempotencyKey].join(':'), job.id);
    return job;
  }

  cacheGithubDelivery(delivery) {
    if (delivery) this.githubDeliveries.set(`${delivery.repoFullName}:${delivery.deliveryId}`, delivery);
    return delivery;
  }

  cacheSlackDelivery(delivery) {
    if (delivery) this.slackDeliveries.set(this.slackDeliveryKey(delivery.teamId, delivery.eventId), delivery);
    return delivery;
  }

  cacheReviewComment(comment) {
    if (comment) this.reviewAgentComments.set(`${comment.repoFullName}:${comment.githubCommentNodeId}`, comment);
    return comment;
  }

  cacheSiteCheckRun(run) {
    if (run) this.siteCheckRuns.set(`${run.repoFullName}:${run.checkRunNodeId || run.checkRunId}`, run);
    return run;
  }

  cacheSession(session) {
    if (!session) return null;
    this.slackSessions.set(session.id, session);
    this.slackSessionByScopeKey.set(this.slackSessionScopeKey(session), session.id);
    return session;
  }

  cacheMemory(memory) {
    if (memory) this.sessionMemories.set(memory.slackSessionId, memory);
    return memory;
  }

  cacheIssueLink(link) {
    if (!link) return null;
    this.issueLinks.set(link.id, link);
    if (link.issueNumber) this.issueLinkByIssueNumber.set(String(link.issueNumber), link);
    if (link.prNumber) this.issueLinkByPrNumber.set(String(link.prNumber), link);
    return link;
  }

  cacheAgentRun(run) {
    if (run) this.agentRuns.set(run.id, run);
    return run;
  }

  cacheAgentRunEvent(event) {
    if (!event) return null;
    this.agentRunEvents.set(event.id, event);
    if (event.dedupeKey) this.agentRunEventByDedupeKey.set(event.dedupeKey, event.id);
    return event;
  }

  cacheSlackJobStatusMessage(message) {
    if (message) this.slackJobStatusMessages.set(`${message.jobId}:${message.scopeKey || 'job'}`, message);
    return message;
  }

  async upsertJob(job) {
    await upsertRow(this.pool, 'publishing_jobs', jobToRow(job), { excludeUpdate: ['id', 'created_at'] });
  }

  async insertEvents(events = []) {
    for (const event of events) {
      await upsertRow(this.pool, 'job_events', eventToRow(event), { excludeUpdate: ['id', 'created_at'] });
    }
  }

  async getJobByIdempotency(input) {
    const rows = await execute(
      this.pool,
      [
        'SELECT * FROM publishing_jobs',
        'WHERE source = ? AND requested_by_type = ? AND requested_by_id = ? AND idempotency_key = ?',
        'LIMIT 1',
      ].join(' '),
      [
        input.source || 'api',
        input.requestedByType || input.requested_by_type || 'user',
        input.requestedById || input.requested_by_id,
        input.idempotencyKey || input.idempotency_key,
      ]
    );
    return this.cacheJob(rowToJob(rows[0]));
  }

  async createJob(input) {
    const existing = await this.getJobByIdempotency(input);
    if (existing) return { job: existing, created: false };

    const beforeCount = this.events.get(input.id)?.length || 0;
    const result = super.createJob(input);
    const events = this.events.get(result.job.id)?.slice(beforeCount) || [];

    try {
      await this.upsertJob(result.job);
      await this.insertEvents(events);
    } catch (error) {
      if (String(error.code || '').includes('ER_DUP_ENTRY')) {
        const duplicate = await this.getJobByIdempotency(input);
        if (duplicate) return { job: duplicate, created: false };
      }
      throw error;
    }

    return result;
  }

  async getJob(jobId) {
    const rows = await execute(this.pool, 'SELECT * FROM publishing_jobs WHERE id = ? LIMIT 1', [jobId]);
    return this.cacheJob(rowToJob(rows[0]));
  }

  async listJobs(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const offset = Math.max(Number(options.offset) || 0, 0);
    const where = [];
    const params = [];

    if (options.status) {
      where.push('status = ?');
      params.push(String(options.status));
    }
    if (options.source) {
      where.push('source = ?');
      params.push(String(options.source));
    }
    if (options.q) {
      const like = `%${String(options.q).trim().toLowerCase()}%`;
      where.push(
        [
          'LOWER(id) LIKE ?',
          'LOWER(title) LIKE ?',
          'LOWER(summary) LIKE ?',
          'LOWER(employee_slug) LIKE ?',
          'LOWER(site_slug) LIKE ?',
          'LOWER(requested_by_id) LIKE ?',
          'CAST(issue_number AS CHAR) LIKE ?',
          'CAST(pr_number AS CHAR) LIKE ?',
          'LOWER(preview_url) LIKE ?',
        ].join(' OR ')
      );
      params.push(like, like, like, like, like, like, like, like, like);
    }

    const whereSql = where.length ? `WHERE ${where.map((item) => `(${item})`).join(' AND ')}` : '';
    const countRows = await execute(this.pool, `SELECT COUNT(*) AS total FROM publishing_jobs ${whereSql}`, params);
    const rows = await execute(
      this.pool,
      `SELECT * FROM publishing_jobs ${whereSql} ORDER BY updated_at DESC ${limitOffsetSql(limit, offset)}`,
      params
    );

    const jobs = rows.map((row) => this.cacheJob(rowToJob(row)));
    return {
      jobs,
      total: Number(countRows[0]?.total || 0),
      limit,
      offset,
    };
  }

  async listEvents(jobId) {
    const rows = await execute(this.pool, 'SELECT * FROM job_events WHERE publishing_job_id = ? ORDER BY created_at ASC', [
      jobId,
    ]);
    const events = rows.map(rowToEvent);
    this.events.set(jobId, events);
    return events;
  }

  async updateJob(jobId, status, patch = {}) {
    const job = await this.getJob(jobId);
    if (!job) return null;
    const beforeCount = this.events.get(jobId)?.length || 0;
    const updated = this.transitionWithBridge(job, status, patch);
    this.jobs.set(jobId, updated);
    this.appendEvent(updated, `PublishingJob moved to ${status}`);
    const events = this.events.get(jobId)?.slice(beforeCount) || [];
    await this.upsertJob(updated);
    await this.insertEvents(events);
    return updated;
  }

  async moveJobToFixing(jobId, patch = {}) {
    let job = await this.getJob(jobId);
    if (!job) return null;
    if (job.status === 'fixing') return this.patchJob(jobId, patch);
    if (job.status === 'pr_created') job = await this.updateJob(jobId, 'reviewing');
    if (!canTransition(job.status, 'fixing')) return null;
    return this.updateJob(jobId, 'fixing', patch);
  }

  async patchJob(jobId, patch = {}) {
    const job = await this.getJob(jobId);
    if (!job) return null;
    const updated = {
      ...job,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.jobs.set(jobId, updated);
    await this.upsertJob(updated);
    return updated;
  }

  async failJob(jobId, errorCode, errorMessage) {
    const job = await this.getJob(jobId);
    if (!job) return null;
    const beforeCount = this.events.get(jobId)?.length || 0;
    const updated = transitionJob(job, 'failed', { errorCode, errorMessage });
    this.jobs.set(jobId, updated);
    this.appendEvent(updated, errorMessage || errorCode || 'PublishingJob failed');
    const events = this.events.get(jobId)?.slice(beforeCount) || [];
    await this.upsertJob(updated);
    await this.insertEvents(events);
    return updated;
  }

  async recordGithubDelivery(input) {
    const rows = await execute(
      this.pool,
      'SELECT * FROM github_webhook_deliveries WHERE repo_full_name = ? AND delivery_id = ? LIMIT 1',
      [input.repoFullName, input.deliveryId]
    );
    const existing = rowToGithubDelivery(rows[0]);
    if (existing) return { delivery: this.cacheGithubDelivery(existing), created: false };

    const now = new Date().toISOString();
    const delivery = {
      id: makeId('ghdeliv'),
      repoFullName: input.repoFullName,
      deliveryId: input.deliveryId,
      eventName: input.eventName,
      action: input.action || null,
      status: 'received',
      createdAt: now,
      updatedAt: now,
    };
    await upsertRow(this.pool, 'github_webhook_deliveries', githubDeliveryToRow(delivery), {
      excludeUpdate: ['id', 'created_at'],
    });
    return { delivery: this.cacheGithubDelivery(delivery), created: true };
  }

  async listGithubDeliveries(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const offset = Math.max(Number(options.offset) || 0, 0);
    const where = [];
    const params = [];
    if (options.repoFullName) {
      where.push('repo_full_name = ?');
      params.push(options.repoFullName);
    }
    if (options.eventName) {
      where.push('event_name = ?');
      params.push(options.eventName);
    }
    if (options.action) {
      where.push('action = ?');
      params.push(options.action);
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countRows = await execute(this.pool, `SELECT COUNT(*) AS total FROM github_webhook_deliveries ${whereSql}`, params);
    const rows = await execute(
      this.pool,
      `SELECT * FROM github_webhook_deliveries ${whereSql} ORDER BY updated_at DESC ${limitOffsetSql(limit, offset)}`,
      params
    );
    return {
      deliveries: rows.map((row) => this.cacheGithubDelivery(rowToGithubDelivery(row))),
      total: Number(countRows[0]?.total || 0),
      limit,
      offset,
    };
  }

  async recordSlackDelivery(input = {}) {
    const rows = await execute(this.pool, 'SELECT * FROM slack_events WHERE team_id = ? AND event_id = ? LIMIT 1', [
      input.teamId || 'unknown-team',
      input.eventId || 'unknown-event',
    ]);
    const existing = rowToSlackDelivery(rows[0]);
    if (existing) return { delivery: this.cacheSlackDelivery(existing), created: false };

    const result = super.recordSlackDelivery({ ...input, id: makeId('slackevt') });
    result.delivery.id = result.delivery.id || makeId('slackevt');
    await upsertRow(this.pool, 'slack_events', slackDeliveryToRow(result.delivery), {
      excludeUpdate: ['id', 'created_at'],
    });
    return result;
  }

  async updateSlackDelivery(input = {}, patch = {}, now = new Date()) {
    const existing = await this.findSlackDelivery(input.teamId, input.eventId);
    if (!existing) return null;
    this.cacheSlackDelivery(existing);
    const updated = super.updateSlackDelivery(input, patch, now);
    await upsertRow(this.pool, 'slack_events', slackDeliveryToRow(updated), { excludeUpdate: ['id', 'created_at'] });
    return updated;
  }

  async findSlackDelivery(teamId, eventId) {
    const rows = await execute(this.pool, 'SELECT * FROM slack_events WHERE team_id = ? AND event_id = ? LIMIT 1', [
      teamId || 'unknown-team',
      eventId || 'unknown-event',
    ]);
    return this.cacheSlackDelivery(rowToSlackDelivery(rows[0]));
  }

  async listSlackDeliveries(options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 50, 1), 200);
    const offset = Math.max(Number(options.offset) || 0, 0);
    const where = [];
    const params = [];
    for (const [optionName, column] of [
      ['teamId', 'team_id'],
      ['eventId', 'event_id'],
      ['slackSessionId', 'slack_session_id'],
      ['publishingJobId', 'publishing_job_id'],
      ['processingStatus', 'processing_status'],
      ['channelId', 'channel_id'],
    ]) {
      if (options[optionName]) {
        where.push(`${column} = ?`);
        params.push(options[optionName]);
      }
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const countRows = await execute(this.pool, `SELECT COUNT(*) AS total FROM slack_events ${whereSql}`, params);
    const rows = await execute(
      this.pool,
      `SELECT * FROM slack_events ${whereSql} ORDER BY updated_at DESC ${limitOffsetSql(limit, offset)}`,
      params
    );
    return {
      deliveries: rows.map((row) => this.cacheSlackDelivery(rowToSlackDelivery(row))),
      total: Number(countRows[0]?.total || 0),
      limit,
      offset,
    };
  }

  async findJobByPrNumber(prNumber, options = {}) {
    const rows = await execute(this.pool, 'SELECT * FROM publishing_jobs WHERE pr_number = ? ORDER BY updated_at DESC', [
      Number(prNumber),
    ]);
    const candidates = rows.map((row) => this.cacheJob(rowToJob(row)));
    if (!candidates.length) return null;
    if (options.headSha) {
      const matched = candidates.find((job) => {
        const left = String(job.headSha || '').toLowerCase();
        const right = String(options.headSha || '').toLowerCase();
        return left.length >= 7 && right.length >= 7 && (left.startsWith(right) || right.startsWith(left));
      });
      if (matched) return matched;
    }
    return (
      candidates.find((job) => ['pr_created', 'reviewing', 'changes_requested', 'fixing', 'previewing'].includes(job.status)) ||
      candidates[0]
    );
  }

  async recordReviewAgentComment(comment) {
    const rows = await execute(
      this.pool,
      'SELECT * FROM review_agent_comments WHERE repo_full_name = ? AND github_comment_node_id = ? LIMIT 1',
      [comment.repoFullName, comment.githubCommentNodeId]
    );
    const existing = rowToReviewComment(rows[0]);
    if (existing) this.cacheReviewComment(existing);

    const result = super.recordReviewAgentComment({ ...comment, id: existing?.id || comment.id || makeId('review') });
    await upsertRow(this.pool, 'review_agent_comments', reviewCommentToRow(result.comment), {
      excludeUpdate: ['id', 'created_at'],
    });
    return result;
  }

  async recordSiteCheckRun(run) {
    const rows = await execute(
      this.pool,
      'SELECT * FROM site_check_runs WHERE repo_full_name = ? AND check_run_node_id = ? LIMIT 1',
      [run.repoFullName, run.checkRunNodeId]
    );
    const existing = rowToSiteCheckRun(rows[0]);
    if (existing) this.cacheSiteCheckRun(existing);

    const result = super.recordSiteCheckRun({ ...run, id: existing?.id || run.id || makeId('sitecheck') });
    await upsertRow(this.pool, 'site_check_runs', siteCheckRunToRow(result.run), {
      excludeUpdate: ['id', 'created_at'],
    });
    return result;
  }

  async listSiteCheckRuns(repoFullName, prNumber, options = {}) {
    const rows = await execute(
      this.pool,
      [
        'SELECT * FROM site_check_runs WHERE repo_full_name = ? AND pr_number = ?',
        'ORDER BY COALESCE(completed_at, updated_at, created_at) DESC',
      ].join(' '),
      [repoFullName, Number(prNumber)]
    );
    const runs = rows.map((row) => this.cacheSiteCheckRun(rowToSiteCheckRun(row)));
    if (!options.headSha) return runs;
    const normalized = String(options.headSha).toLowerCase();
    return runs.filter((run) => {
      const current = String(run.headSha || '').toLowerCase();
      return current.length >= 7 && normalized.length >= 7 && (current.startsWith(normalized) || normalized.startsWith(current));
    });
  }

  async siteCheckGateForPr(repoFullName, prNumber, options = {}) {
    const runs = await this.listSiteCheckRuns(repoFullName, prNumber, options);
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

  async listReviewAgentComments(repoFullName, prNumber, options = {}) {
    const rows = await execute(
      this.pool,
      'SELECT * FROM review_agent_comments WHERE repo_full_name = ? AND pr_number = ? ORDER BY updated_at DESC',
      [repoFullName, Number(prNumber)]
    );
    const comments = rows.map((row) => this.cacheReviewComment(rowToReviewComment(row)));
    if (!options.headSha) return comments;
    const normalized = String(options.headSha).toLowerCase();
    return comments.filter((comment) => {
      const current = String(comment.headSha || '').toLowerCase();
      return current.length >= 7 && normalized.length >= 7 && (current.startsWith(normalized) || normalized.startsWith(current));
    });
  }

  async listReviewAgentCommentsForPrNumber(prNumber, options = {}) {
    const rows = await execute(this.pool, 'SELECT * FROM review_agent_comments WHERE pr_number = ? ORDER BY updated_at DESC', [
      Number(prNumber),
    ]);
    const comments = rows.map((row) => this.cacheReviewComment(rowToReviewComment(row)));
    return comments.filter((comment) => {
      if (options.repoFullName && comment.repoFullName !== options.repoFullName) return false;
      if (!options.headSha) return true;
      const left = String(comment.headSha || '').toLowerCase();
      const right = String(options.headSha || '').toLowerCase();
      return left.length >= 7 && right.length >= 7 && (left.startsWith(right) || right.startsWith(left));
    });
  }

  async reviewGateForPr(repoFullName, prNumber, options = {}) {
    const comments = await this.listReviewAgentComments(repoFullName, prNumber, options);
    const openComments = comments
      .filter((comment) => comment.status === 'open')
      .map((comment) => ({ ...comment, classification: comment.classification || 'unknown' }));
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

  async previewGateForPr(repoFullName, prNumber, options = {}) {
    const reviewGate = await this.reviewGateForPr(repoFullName, prNumber, options);
    const siteCheckGate = await this.siteCheckGateForPr(repoFullName, prNumber, options);
    return {
      ...reviewGate,
      reviewGate,
      siteCheck: siteCheckGate,
      siteCheckPassed: siteCheckGate.passed,
      canPreview: reviewGate.canPreview && siteCheckGate.passed,
    };
  }

  async hasSlackNotification(jobId, key) {
    const rows = await execute(
      this.pool,
      'SELECT id FROM slack_notification_dedupes WHERE job_id = ? AND dedupe_key = ? LIMIT 1',
      [jobId, key]
    );
    return rows.length > 0;
  }

  async recordSlackNotification(jobId, key) {
    this.slackNotifications.add(`${jobId}:${key}`);
    await upsertRow(
      this.pool,
      'slack_notification_dedupes',
      { id: makeId('slackdedupe'), job_id: jobId, dedupe_key: key, created_at: new Date() },
      { excludeUpdate: ['id', 'created_at'] }
    );
  }

  async getSlackJobStatusMessage(jobId, options = {}) {
    const scopeKey = slackStatusScopeKey(options);
    const rows = await execute(this.pool, 'SELECT * FROM slack_job_status_messages WHERE job_id = ? AND scope_key = ? LIMIT 1', [
      jobId,
      scopeKey,
    ]);
    return this.cacheSlackJobStatusMessage(rowToSlackJobStatusMessage(rows[0]));
  }

  async recordSlackJobStatusMessage(jobId, input = {}, now = new Date()) {
    const scopeKey = slackStatusScopeKey(input);
    const existing = await this.getSlackJobStatusMessage(jobId, { scopeKey });
    const nowIso = now.toISOString();
    const message = {
      ...(existing || {}),
      id: existing?.id || input.id || makeId('slackmsg'),
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
    this.cacheSlackJobStatusMessage(message);
    await upsertRow(this.pool, 'slack_job_status_messages', slackJobStatusMessageToRow(message), {
      excludeUpdate: ['id', 'created_at'],
    });
    return message;
  }

  async recordAgentRunEvent(input = {}, now = new Date()) {
    const dedupeKey = input.dedupeKey || input.dedupe_key || null;
    if (dedupeKey) {
      const rows = await execute(this.pool, 'SELECT * FROM agent_run_events WHERE dedupe_key = ? LIMIT 1', [dedupeKey]);
      const existing = rowToAgentRunEvent(rows[0]);
      if (existing) return { event: this.cacheAgentRunEvent(existing), created: false };
    }
    const result = super.recordAgentRunEvent(input, now);
    await upsertRow(this.pool, 'agent_run_events', agentRunEventToRow(result.event), {
      excludeUpdate: ['id', 'created_at'],
    });
    return result;
  }

  async listAgentRunEventsForJob(publishingJobId) {
    const rows = await execute(this.pool, 'SELECT * FROM agent_run_events WHERE publishing_job_id = ? ORDER BY created_at ASC', [
      publishingJobId,
    ]);
    return rows.map((row) => this.cacheAgentRunEvent(rowToAgentRunEvent(row)));
  }

  async findSlackSessionByScope(teamId, slackUserId, sessionKey) {
    const rows = await execute(
      this.pool,
      'SELECT * FROM slack_sessions WHERE team_id = ? AND primary_slack_user_id = ? AND session_key = ? LIMIT 1',
      [teamId, slackUserId, sessionKey]
    );
    return this.cacheSession(rowToSession(rows[0]));
  }

  async upsertSlackSession(input, now = new Date()) {
    let existing = null;
    if (input.id) existing = await this.getSlackSession(input.id);
    if (!existing) existing = await this.findSlackSessionByScope(input.teamId, input.primarySlackUserId, input.sessionKey);
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
    this.cacheSession(session);
    await upsertRow(this.pool, 'slack_sessions', sessionToRow(session), { excludeUpdate: ['id', 'created_at'] });
    await this.getSessionMemory(session.id);
    return session;
  }

  async getSlackSession(sessionId) {
    const rows = await execute(this.pool, 'SELECT * FROM slack_sessions WHERE id = ? LIMIT 1', [sessionId]);
    return this.cacheSession(rowToSession(rows[0]));
  }

  async findSlackSessionsForUser(teamId, slackUserId, options = {}) {
    const rows = await execute(
      this.pool,
      [
        'SELECT * FROM slack_sessions',
        'WHERE team_id = ? AND primary_slack_user_id = ?',
        'ORDER BY last_active_at DESC, updated_at DESC',
      ].join(' '),
      [teamId, slackUserId]
    );
    return rows
      .map((row) => this.cacheSession(rowToSession(row)))
      .filter((session) => !options.statuses || options.statuses.includes(session.status));
  }

  async getSessionMemory(sessionId) {
    const rows = await execute(this.pool, 'SELECT * FROM session_memories WHERE slack_session_id = ? LIMIT 1', [sessionId]);
    const existing = rowToMemory(rows[0]);
    if (existing) return this.cacheMemory(existing);
    const memory = super.getSessionMemory(sessionId);
    await upsertRow(this.pool, 'session_memories', memoryToRow(memory), { excludeUpdate: ['id', 'created_at'] });
    return memory;
  }

  async updateSessionMemory(sessionId, patch = {}, now = new Date()) {
    const existing = await this.getSessionMemory(sessionId);
    const memory = {
      ...existing,
      ...patch,
      slackSessionId: sessionId,
      updatedAt: now.toISOString(),
    };
    this.cacheMemory(memory);
    await upsertRow(this.pool, 'session_memories', memoryToRow(memory), { excludeUpdate: ['id', 'created_at'] });
    return memory;
  }

  async closeSlackSession(sessionId, now = new Date()) {
    const existing = await this.getSlackSession(sessionId);
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
    this.cacheSession(session);
    await upsertRow(this.pool, 'slack_sessions', sessionToRow(session), { excludeUpdate: ['id', 'created_at'] });
    return session;
  }

  async linkJobToSlackSession(job, session, now = new Date()) {
    if (!job?.id) return null;
    const existingByJob = await this.findIssueLinkByJobId(job.id);
    const slackSessionId = session?.id || job.slackSessionId || existingByJob?.slackSessionId;
    if (!slackSessionId) return null;
    const existing = await this.findIssueLinkForSlackSessionAndJob(slackSessionId, job.id);

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
    this.cacheIssueLink(link);
    await upsertRow(this.pool, 'issue_links', issueLinkToRow(link), { excludeUpdate: ['id', 'created_at'] });

    const currentSession = session || (await this.getSlackSession(slackSessionId));
    if (currentSession) {
      await this.upsertSlackSession(
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

  async findIssueLinkForSlackSessionAndJob(slackSessionId, jobId) {
    const rows = await execute(
      this.pool,
      'SELECT * FROM issue_links WHERE slack_session_id = ? AND publishing_job_id = ? LIMIT 1',
      [slackSessionId, jobId]
    );
    return this.cacheIssueLink(rowToIssueLink(rows[0]));
  }

  async findIssueLinkByJobId(jobId) {
    const rows = await execute(
      this.pool,
      'SELECT * FROM issue_links WHERE publishing_job_id = ? ORDER BY updated_at DESC LIMIT 1',
      [jobId]
    );
    return this.cacheIssueLink(rowToIssueLink(rows[0]));
  }

  async findIssueLinkByIssueNumber(issueNumber) {
    const rows = await execute(this.pool, 'SELECT * FROM issue_links WHERE issue_number = ? ORDER BY updated_at DESC LIMIT 1', [
      Number(issueNumber),
    ]);
    return this.cacheIssueLink(rowToIssueLink(rows[0]));
  }

  async findIssueLinkByPrNumber(prNumber) {
    const rows = await execute(this.pool, 'SELECT * FROM issue_links WHERE pr_number = ? ORDER BY updated_at DESC LIMIT 1', [
      Number(prNumber),
    ]);
    return this.cacheIssueLink(rowToIssueLink(rows[0]));
  }

  async findIssueLinksForSlackSession(slackSessionId) {
    const rows = await execute(this.pool, 'SELECT * FROM issue_links WHERE slack_session_id = ? ORDER BY updated_at DESC', [
      slackSessionId,
    ]);
    return rows.map((row) => this.cacheIssueLink(rowToIssueLink(row)));
  }

  async listWorkItemsForSlackUser(teamId, slackUserId, options = {}) {
    const limit = Math.min(Math.max(Number(options.limit) || 5, 1), 20);
    const requestedById = `slack:${teamId || 'unknown-team'}:${slackUserId || 'unknown-user'}`;
    const where = ['source = ?', 'requested_by_id = ?'];
    const params = ['slack', requestedById];
    if (options.statuses?.length) {
      where.push(`status IN (${queryPlaceholders(options.statuses.length)})`);
      params.push(...options.statuses);
    }
    const whereSql = `WHERE ${where.join(' AND ')}`;
    const countRows = await execute(this.pool, `SELECT COUNT(*) AS total FROM publishing_jobs ${whereSql}`, params);
    const rows = await execute(
      this.pool,
      `SELECT * FROM publishing_jobs ${whereSql} ORDER BY updated_at DESC ${limitOffsetSql(limit, 0)}`,
      params
    );
    return {
      jobs: rows.map((row) => this.cacheJob(rowToJob(row))),
      total: Number(countRows[0]?.total || 0),
      limit,
      offset: 0,
    };
  }

  async listAgentRunsForJob(publishingJobId) {
    const rows = await execute(this.pool, 'SELECT * FROM agent_runs WHERE publishing_job_id = ? ORDER BY created_at ASC', [
      publishingJobId,
    ]);
    return rows.map((row) => this.cacheAgentRun(rowToAgentRun(row)));
  }

  async listAgentRunsForSlackSession(slackSessionId) {
    const rows = await execute(this.pool, 'SELECT * FROM agent_runs WHERE slack_session_id = ? ORDER BY created_at ASC', [
      slackSessionId,
    ]);
    return rows.map((row) => this.cacheAgentRun(rowToAgentRun(row)));
  }

  async createAgentRun(input, now = new Date()) {
    const relatedRuns = input.slackSessionId ? await this.listAgentRunsForSlackSession(input.slackSessionId) : [];
    for (const run of relatedRuns) this.cacheAgentRun(run);
    const run = super.createAgentRun(
      {
        ...input,
        roundNo: input.roundNo || relatedRuns.filter((item) => item.agentKind === (input.agentKind || 'slack_agent')).length + 1,
      },
      now
    );
    await upsertRow(this.pool, 'agent_runs', agentRunToRow(run), { excludeUpdate: ['id', 'created_at'] });
    return run;
  }

  async completeAgentRun(agentRunId, patch = {}, now = new Date()) {
    const current = await this.getAgentRun(agentRunId);
    if (!current) return null;
    this.cacheAgentRun(current);
    const run = super.completeAgentRun(agentRunId, patch, now);
    await upsertRow(this.pool, 'agent_runs', agentRunToRow(run), { excludeUpdate: ['id', 'created_at'] });
    return run;
  }

  async failAgentRun(agentRunId, errorCode, errorMessage, now = new Date()) {
    const current = await this.getAgentRun(agentRunId);
    if (!current) return null;
    this.cacheAgentRun(current);
    const run = super.failAgentRun(agentRunId, errorCode, errorMessage, now);
    await upsertRow(this.pool, 'agent_runs', agentRunToRow(run), { excludeUpdate: ['id', 'created_at'] });
    return run;
  }

  async getAgentRun(agentRunId) {
    const rows = await execute(this.pool, 'SELECT * FROM agent_runs WHERE id = ? LIMIT 1', [agentRunId]);
    return this.cacheAgentRun(rowToAgentRun(rows[0]));
  }

  async acquireSlackAgentLease(slackSessionId, config, now = new Date()) {
    const runs = await this.listAgentRunsForSlackSession(slackSessionId);
    for (const run of runs) this.cacheAgentRun(run);

    const nowMs = now.getTime();
    const running = runs.find((run) => {
      if (run.agentKind !== 'slack_agent' || run.slackSessionId !== slackSessionId || run.status !== 'running') {
        return false;
      }
      return run.leaseExpiresAt && new Date(run.leaseExpiresAt).getTime() > nowMs;
    });

    if (running) {
      return { acquired: false, agentRun: running };
    }

    for (const run of runs) {
      if (run.agentKind !== 'slack_agent' || run.slackSessionId !== slackSessionId || run.status !== 'running') {
        continue;
      }
      if (run.leaseExpiresAt && new Date(run.leaseExpiresAt).getTime() <= nowMs) {
        await this.failAgentRun(run.id, 'agent_lease_expired', 'Slack Agent lease expired', now);
      }
    }

    const agentRun = await this.createAgentRun(
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
