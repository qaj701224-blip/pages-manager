import { normalizeSlackWorkItemQueryState, slackWorkItemQueryStateFromText } from './work-item-query.js';

export function slackAgentToolArgs(slackAgentAnalysis = {}) {
  const analysis = slackAgentAnalysis || {};
  const toolCall = analysis.toolCall || analysis.tool_call || {};
  const args = toolCall.args || toolCall.arguments || analysis.toolArgs || analysis.tool_args || {};
  return args && typeof args === 'object' ? args : {};
}

export function slackAgentToolName(slackAgentAnalysis = {}) {
  const analysis = slackAgentAnalysis || {};
  const toolCall = analysis.toolCall || analysis.tool_call || {};
  const rawName = toolCall.name || analysis.tool || analysis.toolName || analysis.tool_name || analysis.action;
  const name = String(rawName || '')
    .trim()
    .toLowerCase();
  const aliases = {
    list_work_items: 'list_my_work_items',
    list_tasks: 'list_my_work_items',
    search_work_items: 'list_my_work_items',
    switch_pr: 'switch_work_item',
    switch_to_work_item: 'switch_work_item',
    reopen: 'reopen_work_item',
    reopen_issue: 'reopen_work_item',
    reopen_pr: 'reopen_work_item',
    reopen_work_item: 'reopen_work_item',
    restore_work_item: 'reopen_work_item',
    status_query: 'get_current_status',
    get_status: 'get_current_status',
    close: 'close_session',
    reject_unsupported_destructive_request: 'unsupported_destructive_request',
    unsupported_destructive: 'unsupported_destructive_request',
    create_issue: 'confirm_create_issue',
    create_job: 'confirm_create_issue',
    confirm_issue: 'confirm_create_issue',
    confirm_before_issue: 'confirm_create_issue',
    create_or_update_site: 'confirm_create_issue',
    new_site_request: 'confirm_create_issue',
    create_site: 'confirm_create_issue',
    update_site: 'confirm_create_issue',
    update_current_work_item: 'record_followup',
    followup: 'record_followup',
    modify_existing_preview: 'record_followup',
  };
  return aliases[name] || name || null;
}

export function slackAgentWorkItemState(intake = {}, slackAgentAnalysis = {}) {
  const analysis = slackAgentAnalysis || {};
  const args = slackAgentToolArgs(slackAgentAnalysis);
  const explicit =
    args.state ||
    args.workItemState ||
    args.work_item_state ||
    analysis.workItemState ||
    analysis.work_item_state ||
    intake.workItemState;
  if (explicit) return normalizeSlackWorkItemQueryState(explicit);

  return slackWorkItemQueryStateFromText(
    [intake.text, args.query, analysis.visibleReply, analysis.summary, analysis.title, analysis.clarifyingQuestion]
      .filter(Boolean)
      .join('\n')
  );
}
