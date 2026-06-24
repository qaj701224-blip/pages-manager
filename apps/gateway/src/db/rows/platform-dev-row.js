import { fromDbJson, toDate, toDbJson, toIso } from '../sql.js';

export function platformDevItemToRow(item) {
  return {
    id: item.id,
    source: item.source,
    requested_by_type: item.requestedByType,
    requested_by_id: item.requestedById,
    idempotency_key: item.idempotencyKey,
    title: item.title,
    summary: item.summary,
    issue_type: item.issueType,
    areas_json: toDbJson(item.areas || []),
    risk: item.risk,
    agent_eligible: Boolean(item.agentEligible),
    requires_human_gate: Boolean(item.requiresHumanGate),
    status: item.status,
    requester_profile_json: toDbJson(item.requesterProfile),
    slack_thread_json: toDbJson(item.slackThread),
    slack_session_id: item.slackSessionId,
    slack_session_key: item.slackSessionKey,
    github_issue_number: item.githubIssueNumber,
    github_issue_url: item.githubIssueUrl,
    github_pr_number: item.githubPrNumber,
    github_pr_url: item.githubPrUrl,
    branch_name: item.branchName,
    base_ref: item.baseRef,
    head_sha: item.headSha,
    workflow_name: item.workflowName,
    workflow_run_id: item.workflowRunId,
    gate_status: item.gateStatus || 'not_required',
    gate_reason: item.gateReason,
    error_code: item.errorCode,
    error_message: item.errorMessage,
    created_at: toDate(item.createdAt),
    updated_at: toDate(item.updatedAt),
  };
}

export function rowToPlatformDevItem(row) {
  if (!row) return null;
  return {
    id: row.id,
    source: row.source,
    requestedByType: row.requested_by_type,
    requestedById: row.requested_by_id,
    idempotencyKey: row.idempotency_key,
    title: row.title,
    summary: row.summary || '',
    issueType: row.issue_type,
    areas: fromDbJson(row.areas_json, []),
    risk: row.risk,
    agentEligible: Boolean(row.agent_eligible),
    requiresHumanGate: Boolean(row.requires_human_gate),
    status: row.status,
    requesterProfile: fromDbJson(row.requester_profile_json, null),
    slackThread: fromDbJson(row.slack_thread_json, null),
    slackSessionId: row.slack_session_id || null,
    slackSessionKey: row.slack_session_key || null,
    githubIssueNumber: row.github_issue_number ?? null,
    githubIssueUrl: row.github_issue_url || null,
    githubPrNumber: row.github_pr_number ?? null,
    githubPrUrl: row.github_pr_url || null,
    branchName: row.branch_name || null,
    baseRef: row.base_ref || null,
    headSha: row.head_sha || null,
    workflowName: row.workflow_name || null,
    workflowRunId: row.workflow_run_id || null,
    gateStatus: row.gate_status || 'not_required',
    gateReason: row.gate_reason || null,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function platformDevEventToRow(event) {
  return {
    id: event.id,
    platform_dev_item_id: event.platformDevItemId,
    status: event.status,
    message: event.message,
    request_id: event.requestId || null,
    created_at: toDate(event.createdAt),
  };
}

export function rowToPlatformDevEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    platformDevItemId: row.platform_dev_item_id,
    status: row.status,
    message: row.message || '',
    requestId: row.request_id || null,
    createdAt: toIso(row.created_at),
  };
}
