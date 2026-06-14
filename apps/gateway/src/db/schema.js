import { sql } from 'drizzle-orm';
import { char, datetime, index, int, json, mysqlEnum, mysqlTable, text, uniqueIndex, varchar } from 'drizzle-orm/mysql-core';

const id = (name) => varchar(name, { length: 64 });
const externalId = (name) => varchar(name, { length: 255 });
const url = (name) => varchar(name, { length: 1024 });
const hash = (name) => char(name, { length: 64 });
const gitSha = (name) => char(name, { length: 40 });
const createdAt = () =>
  datetime('created_at', { mode: 'date', fsp: 3 })
    .default(sql`CURRENT_TIMESTAMP(3)`)
    .notNull();
const updatedAt = () =>
  datetime('updated_at', { mode: 'date', fsp: 3 })
    .default(sql`CURRENT_TIMESTAMP(3)`)
    .$onUpdate(() => new Date())
    .notNull();

export const publishingJobStatusValues = [
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
  'approved',
  'merging',
  'merged',
  'deploying',
  'deployed',
  'failed',
  'cancelled',
];

export const slackProcessingStatusValues = ['received', 'processing', 'processed', 'ignored', 'failed'];
export const slackResultTypeValues = [
  'none',
  'agent_replied',
  'clarification_requested',
  'job_created',
  'followup_appended',
  'status_returned',
  'session_closed',
];
export const agentRunStatusValues = ['running', 'completed', 'failed'];
export const slackSessionStatusValues = ['active', 'closed', 'expired'];

export const publishingJobs = mysqlTable(
  'publishing_jobs',
  {
    id: id('id').primaryKey(),
    source: mysqlEnum('source', ['slack', 'api', 'admin', 'system']).notNull(),
    requestedByType: varchar('requested_by_type', { length: 64 }).notNull(),
    requestedById: varchar('requested_by_id', { length: 255 }).notNull(),
    idempotencyKey: varchar('idempotency_key', { length: 255 }).notNull(),
    siteProjectId: id('site_project_id'),
    ownerScopeId: id('owner_scope_id'),
    employeeId: id('employee_id'),
    employeeSlug: varchar('employee_slug', { length: 80 }).notNull(),
    siteSlug: varchar('site_slug', { length: 120 }).notNull(),
    intent: varchar('intent', { length: 80 }).notNull(),
    approvalMode: varchar('approval_mode', { length: 64 }).notNull(),
    status: mysqlEnum('status', publishingJobStatusValues).notNull(),
    title: varchar('title', { length: 255 }),
    summary: text('summary'),
    slackThreadJson: json('slack_thread_json'),
    slackSessionId: id('slack_session_id'),
    slackSessionKey: varchar('slack_session_key', { length: 255 }),
    issueNumber: int('issue_number'),
    issueUrl: url('issue_url'),
    prNumber: int('pr_number'),
    prUrl: url('pr_url'),
    branchName: varchar('branch_name', { length: 255 }),
    baseRef: varchar('base_ref', { length: 128 }),
    headSha: gitSha('head_sha'),
    indexSnapshotId: id('index_snapshot_id'),
    previewUrl: url('preview_url'),
    errorCode: varchar('error_code', { length: 128 }),
    errorMessage: text('error_message'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    idempotencyUk: uniqueIndex('publishing_jobs_idempotency_uk').on(
      table.source,
      table.requestedByType,
      table.requestedById,
      table.idempotencyKey
    ),
    statusUpdatedIdx: index('publishing_jobs_status_updated_idx').on(table.status, table.updatedAt),
    targetIdx: index('publishing_jobs_target_idx').on(table.employeeSlug, table.siteSlug),
    slackSessionIdx: index('publishing_jobs_slack_session_idx').on(table.slackSessionId),
    issueIdx: index('publishing_jobs_issue_idx').on(table.issueNumber),
    prIdx: index('publishing_jobs_pr_idx').on(table.prNumber),
  })
);

export const jobEvents = mysqlTable(
  'job_events',
  {
    id: id('id').primaryKey(),
    publishingJobId: id('publishing_job_id').notNull(),
    status: mysqlEnum('status', publishingJobStatusValues).notNull(),
    message: text('message'),
    requestId: varchar('request_id', { length: 128 }),
    createdAt: createdAt(),
  },
  (table) => ({
    jobCreatedIdx: index('job_events_job_created_idx').on(table.publishingJobId, table.createdAt),
    statusCreatedIdx: index('job_events_status_created_idx').on(table.status, table.createdAt),
  })
);

export const slackEvents = mysqlTable(
  'slack_events',
  {
    id: id('id').primaryKey(),
    teamId: externalId('team_id').notNull(),
    eventId: externalId('event_id').notNull(),
    eventType: varchar('event_type', { length: 80 }),
    action: varchar('action', { length: 120 }),
    processingStatus: mysqlEnum('processing_status', slackProcessingStatusValues).notNull().default('received'),
    resultType: mysqlEnum('result_type', slackResultTypeValues).notNull().default('none'),
    ignoredReason: varchar('ignored_reason', { length: 255 }),
    errorCode: varchar('error_code', { length: 128 }),
    errorMessage: text('error_message'),
    retryNum: int('retry_num').notNull().default(0),
    retryReason: varchar('retry_reason', { length: 255 }),
    requestId: varchar('request_id', { length: 128 }),
    channelId: externalId('channel_id'),
    threadTs: varchar('thread_ts', { length: 64 }),
    slackUserId: externalId('slack_user_id'),
    slackSessionId: id('slack_session_id'),
    publishingJobId: id('publishing_job_id'),
    agentRunId: id('agent_run_id'),
    payloadRedactedJson: json('payload_redacted_json'),
    payloadHash: hash('payload_hash'),
    receivedAt: datetime('received_at', { mode: 'date', fsp: 3 })
      .default(sql`CURRENT_TIMESTAMP(3)`)
      .notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    eventUk: uniqueIndex('slack_events_team_event_uk').on(table.teamId, table.eventId),
    processingIdx: index('slack_events_processing_idx').on(table.processingStatus, table.createdAt),
    resultIdx: index('slack_events_result_idx').on(table.resultType, table.createdAt),
    sessionIdx: index('slack_events_session_idx').on(table.slackSessionId, table.createdAt),
    jobIdx: index('slack_events_job_idx').on(table.publishingJobId, table.createdAt),
  })
);

export const slackSessions = mysqlTable(
  'slack_sessions',
  {
    id: id('id').primaryKey(),
    teamId: externalId('team_id').notNull(),
    sessionKey: varchar('session_key', { length: 255 }).notNull(),
    sessionTitle: varchar('session_title', { length: 255 }),
    channelId: externalId('channel_id'),
    threadTs: varchar('thread_ts', { length: 64 }),
    dmChannelId: externalId('dm_channel_id'),
    surfaceContextJson: json('surface_context_json'),
    primarySlackUserId: externalId('primary_slack_user_id').notNull(),
    ownerScopeId: id('owner_scope_id'),
    activeJobId: id('active_job_id'),
    activeIssueNumber: int('active_issue_number'),
    activePrNumber: int('active_pr_number'),
    activePreviewUrl: url('active_preview_url'),
    activeContextExpiresAt: datetime('active_context_expires_at', { mode: 'date', fsp: 3 }),
    status: mysqlEnum('status', slackSessionStatusValues).notNull().default('active'),
    lastIntent: varchar('last_intent', { length: 80 }),
    lastActiveAt: datetime('last_active_at', { mode: 'date', fsp: 3 }),
    closedAt: datetime('closed_at', { mode: 'date', fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    scopeUk: uniqueIndex('slack_sessions_scope_uk').on(table.teamId, table.primarySlackUserId, table.sessionKey),
    userActiveIdx: index('slack_sessions_user_active_idx').on(table.teamId, table.primarySlackUserId, table.lastActiveAt),
    activeJobIdx: index('slack_sessions_active_job_idx').on(table.activeJobId),
  })
);

export const sessionMemories = mysqlTable(
  'session_memories',
  {
    id: id('id').primaryKey(),
    slackSessionId: id('slack_session_id').notNull(),
    summary: text('summary'),
    requirementsJson: json('requirements_json'),
    pendingQuestionsJson: json('pending_questions_json'),
    preferencesJson: json('preferences_json'),
    lastPreviewFeedback: text('last_preview_feedback'),
    lastAgentResponse: text('last_agent_response'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    sessionUk: uniqueIndex('session_memories_session_uk').on(table.slackSessionId),
  })
);

export const issueLinks = mysqlTable(
  'issue_links',
  {
    id: id('id').primaryKey(),
    slackSessionId: id('slack_session_id').notNull(),
    publishingJobId: id('publishing_job_id').notNull(),
    issueNumber: int('issue_number'),
    prNumber: int('pr_number'),
    branchName: varchar('branch_name', { length: 255 }),
    previewUrl: url('preview_url'),
    headSha: gitSha('head_sha'),
    relationship: varchar('relationship', { length: 64 }).notNull().default('primary'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    jobUk: uniqueIndex('issue_links_job_uk').on(table.publishingJobId),
    sessionIdx: index('issue_links_session_idx').on(table.slackSessionId, table.updatedAt),
    issueIdx: index('issue_links_issue_idx').on(table.issueNumber),
    prIdx: index('issue_links_pr_idx').on(table.prNumber),
  })
);

export const agentRuns = mysqlTable(
  'agent_runs',
  {
    id: id('id').primaryKey(),
    agentKind: varchar('agent_kind', { length: 80 }).notNull(),
    slackSessionId: id('slack_session_id'),
    publishingJobId: id('publishing_job_id'),
    status: mysqlEnum('status', agentRunStatusValues).notNull(),
    roundNo: int('round_no').notNull().default(1),
    provider: varchar('provider', { length: 80 }),
    model: varchar('model', { length: 128 }),
    modelApiStyle: varchar('model_api_style', { length: 80 }),
    promptVersion: id('prompt_version'),
    policyVersion: id('policy_version'),
    inputSummaryHash: hash('input_summary_hash'),
    outputHash: hash('output_hash'),
    reportJson: json('report_json'),
    errorCode: varchar('error_code', { length: 128 }),
    errorMessage: text('error_message'),
    leaseExpiresAt: datetime('lease_expires_at', { mode: 'date', fsp: 3 }),
    timeoutAt: datetime('timeout_at', { mode: 'date', fsp: 3 }),
    startedAt: datetime('started_at', { mode: 'date', fsp: 3 }),
    completedAt: datetime('completed_at', { mode: 'date', fsp: 3 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    jobIdx: index('agent_runs_job_idx').on(table.publishingJobId, table.createdAt),
    sessionIdx: index('agent_runs_session_idx').on(table.slackSessionId, table.createdAt),
    leaseIdx: index('agent_runs_lease_idx').on(table.agentKind, table.status, table.leaseExpiresAt),
  })
);

export const agentRunEvents = mysqlTable(
  'agent_run_events',
  {
    id: id('id').primaryKey(),
    publishingJobId: id('publishing_job_id'),
    slackSessionId: id('slack_session_id'),
    agentRunId: id('agent_run_id'),
    type: varchar('type', { length: 80 }).notNull(),
    stage: varchar('stage', { length: 80 }),
    text: text('text'),
    status: varchar('status', { length: 80 }),
    dedupeKey: varchar('dedupe_key', { length: 255 }),
    slackChannelId: externalId('slack_channel_id'),
    slackThreadTs: varchar('slack_thread_ts', { length: 64 }),
    slackMessageTs: varchar('slack_message_ts', { length: 64 }),
    createdAt: createdAt(),
  },
  (table) => ({
    dedupeIdx: index('agent_run_events_dedupe_idx').on(table.dedupeKey),
    jobIdx: index('agent_run_events_job_idx').on(table.publishingJobId, table.createdAt),
    runIdx: index('agent_run_events_run_idx').on(table.agentRunId, table.createdAt),
  })
);

export const githubWebhookDeliveries = mysqlTable(
  'github_webhook_deliveries',
  {
    id: id('id').primaryKey(),
    repoFullName: varchar('repo_full_name', { length: 255 }).notNull(),
    deliveryId: externalId('delivery_id').notNull(),
    eventName: varchar('event_name', { length: 80 }).notNull(),
    action: varchar('action', { length: 80 }),
    status: varchar('status', { length: 80 }).notNull().default('received'),
    requestId: varchar('request_id', { length: 128 }),
    payloadHash: hash('payload_hash'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    deliveryUk: uniqueIndex('github_webhook_deliveries_repo_delivery_uk').on(table.repoFullName, table.deliveryId),
    eventIdx: index('github_webhook_deliveries_event_idx').on(table.eventName, table.createdAt),
  })
);

export const reviewAgentComments = mysqlTable(
  'review_agent_comments',
  {
    id: id('id').primaryKey(),
    repoFullName: varchar('repo_full_name', { length: 255 }).notNull(),
    prNumber: int('pr_number').notNull(),
    githubCommentNodeId: externalId('github_comment_node_id').notNull(),
    sourceType: varchar('source_type', { length: 80 }).notNull(),
    reviewAgentLogin: externalId('review_agent_login'),
    classification: varchar('classification', { length: 80 }),
    status: varchar('status', { length: 80 }).notNull().default('open'),
    path: varchar('path', { length: 1024 }),
    line: int('line'),
    bodyRedacted: text('body_redacted'),
    bodyHash: hash('body_hash'),
    headSha: gitSha('head_sha'),
    firstSeenDeliveryId: externalId('first_seen_delivery_id'),
    lastSeenDeliveryId: externalId('last_seen_delivery_id'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    commentUk: uniqueIndex('review_agent_comments_node_uk').on(table.repoFullName, table.githubCommentNodeId),
    prIdx: index('review_agent_comments_pr_idx').on(table.repoFullName, table.prNumber, table.headSha),
    statusIdx: index('review_agent_comments_status_idx').on(table.status, table.updatedAt),
  })
);

export const slackJobStatusMessages = mysqlTable(
  'slack_job_status_messages',
  {
    jobId: id('job_id').primaryKey(),
    channel: externalId('channel'),
    threadTs: varchar('thread_ts', { length: 64 }),
    messageTs: varchar('message_ts', { length: 64 }),
    stage: varchar('stage', { length: 80 }),
    status: varchar('status', { length: 80 }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (table) => ({
    channelMessageIdx: index('slack_job_status_messages_channel_idx').on(table.channel, table.messageTs),
  })
);

export const slackNotificationDedupes = mysqlTable(
  'slack_notification_dedupes',
  {
    id: id('id').primaryKey(),
    jobId: id('job_id').notNull(),
    dedupeKey: varchar('dedupe_key', { length: 255 }).notNull(),
    createdAt: createdAt(),
  },
  (table) => ({
    jobDedupeUk: uniqueIndex('slack_notification_dedupes_job_key_uk').on(table.jobId, table.dedupeKey),
    jobIdx: index('slack_notification_dedupes_job_idx').on(table.jobId, table.createdAt),
  })
);

export const auditLogs = mysqlTable(
  'audit_logs',
  {
    id: id('id').primaryKey(),
    actorType: varchar('actor_type', { length: 80 }).notNull(),
    actorId: varchar('actor_id', { length: 255 }).notNull(),
    action: varchar('action', { length: 128 }).notNull(),
    targetType: varchar('target_type', { length: 80 }).notNull(),
    targetId: varchar('target_id', { length: 255 }).notNull(),
    requestId: varchar('request_id', { length: 128 }),
    metadataJson: json('metadata_json'),
    createdAt: createdAt(),
  },
  (table) => ({
    actorIdx: index('audit_logs_actor_idx').on(table.actorType, table.actorId, table.createdAt),
    targetIdx: index('audit_logs_target_idx').on(table.targetType, table.targetId, table.createdAt),
  })
);

export const externalApiCallLogs = mysqlTable(
  'external_api_call_logs',
  {
    id: id('id').primaryKey(),
    provider: varchar('provider', { length: 80 }).notNull(),
    operation: varchar('operation', { length: 128 }).notNull(),
    publishingJobId: id('publishing_job_id'),
    slackSessionId: id('slack_session_id'),
    agentRunId: id('agent_run_id'),
    requestId: varchar('request_id', { length: 128 }),
    status: varchar('status', { length: 80 }).notNull(),
    errorCode: varchar('error_code', { length: 128 }),
    durationMs: int('duration_ms'),
    requestSummaryJson: json('request_summary_json'),
    responseSummaryJson: json('response_summary_json'),
    createdAt: createdAt(),
  },
  (table) => ({
    jobIdx: index('external_api_call_logs_job_idx').on(table.publishingJobId, table.createdAt),
    providerIdx: index('external_api_call_logs_provider_idx').on(table.provider, table.operation, table.createdAt),
  })
);
