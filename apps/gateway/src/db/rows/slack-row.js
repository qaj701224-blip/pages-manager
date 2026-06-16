import { makeId } from '@xd/workflow-core';

import { fromDbJson, toDate, toDbJson, toIso } from '../sql.js';

export function slackStatusScopeKey(input = {}) {
  if (input.scopeKey) return String(input.scopeKey);
  if (input.slackSessionId) return `session:${input.slackSessionId}`;
  return 'job';
}

export function slackDeliveryToRow(delivery) {
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

export function rowToSlackDelivery(row) {
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

export function sessionToRow(session) {
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

export function rowToSession(row) {
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

export function memoryToRow(memory) {
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

export function rowToMemory(row) {
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

export function issueLinkToRow(link) {
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

export function rowToIssueLink(row) {
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

export function slackJobStatusMessageToRow(message) {
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

export function rowToSlackJobStatusMessage(row) {
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

export function slackAgentReplyMessageToRow(message) {
  return {
    id: message.id || makeId('slackreply'),
    slack_session_id: message.slackSessionId,
    agent_run_id: message.agentRunId,
    channel: message.channel,
    thread_ts: message.threadTs,
    message_ts: message.messageTs,
    text_snapshot: message.textSnapshot,
    last_sequence: message.lastSequence || 0,
    status: message.status || 'running',
    created_at: toDate(message.createdAt),
    updated_at: toDate(message.updatedAt),
  };
}

export function rowToSlackAgentReplyMessage(row) {
  if (!row) return null;
  return {
    id: row.id,
    slackSessionId: row.slack_session_id,
    agentRunId: row.agent_run_id,
    channel: row.channel || null,
    threadTs: row.thread_ts || null,
    messageTs: row.message_ts || null,
    textSnapshot: row.text_snapshot || '',
    lastSequence: row.last_sequence || 0,
    status: row.status || 'running',
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}
