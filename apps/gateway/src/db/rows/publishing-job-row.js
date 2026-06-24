import { fromDbJson, toDate, toDbJson, toIso } from '../sql.js';

export function jobToRow(job) {
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
    workflow_name: job.workflowName,
    workflow_run_id: job.workflowRunId,
    index_snapshot_id: job.indexSnapshotId,
    preview_url: job.previewUrl,
    error_code: job.errorCode,
    error_message: job.errorMessage,
    created_at: toDate(job.createdAt),
    updated_at: toDate(job.updatedAt),
  };
}

export function rowToJob(row) {
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
    workflowName: row.workflow_name || null,
    workflowRunId: row.workflow_run_id || null,
    indexSnapshotId: row.index_snapshot_id || null,
    previewUrl: row.preview_url || null,
    errorCode: row.error_code || null,
    errorMessage: row.error_message || null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function eventToRow(event) {
  return {
    id: event.id,
    publishing_job_id: event.publishingJobId,
    status: event.status,
    message: event.message,
    request_id: event.requestId || null,
    created_at: toDate(event.createdAt),
  };
}

export function rowToEvent(row) {
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
