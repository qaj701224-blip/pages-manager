import { fromDbJson, toDate, toDbJson, toIso } from '../sql.js';

export function agentRunToRow(run) {
  return {
    id: run.id,
    agent_kind: run.agentKind,
    slack_session_id: run.slackSessionId,
    publishing_job_id: run.publishingJobId,
    work_item_kind: run.workItemKind || null,
    work_item_id: run.workItemId || null,
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

export function rowToAgentRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    agentKind: row.agent_kind,
    slackSessionId: row.slack_session_id || null,
    publishingJobId: row.publishing_job_id || null,
    workItemKind: row.work_item_kind || null,
    workItemId: row.work_item_id || null,
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

export function agentRunEventToRow(event) {
  return {
    id: event.id,
    publishing_job_id: event.publishingJobId,
    work_item_kind: event.workItemKind || null,
    work_item_id: event.workItemId || null,
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

export function rowToAgentRunEvent(row) {
  if (!row) return null;
  return {
    id: row.id,
    publishingJobId: row.publishing_job_id || null,
    workItemKind: row.work_item_kind || null,
    workItemId: row.work_item_id || null,
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
