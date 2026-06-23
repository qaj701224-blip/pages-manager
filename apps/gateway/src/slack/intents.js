export const CREATE_JOB_INTENTS = new Set(['create_or_update_site', 'new_site_request', 'create_site', 'update_site']);
export const CREATE_PLATFORM_INTENTS = new Set(['create_platform_issue', 'platform_dev', 'platform_feedback']);
export const FOLLOWUP_INTENTS = new Set(['modify_existing_preview', 'append_requirement']);
export const NON_FOLLOWUP_ACTIONS = new Set([
  'help',
  'ping',
  'status',
  'diagnose_work_item',
  'cancel',
  'close_session',
  'empty',
  'missing_requirement',
  'unsupported_destructive_request',
  'repo_question',
  'answer_repo_question',
]);
export const LIST_WORK_ITEM_INTENTS = new Set(['list_work_items']);
export const SWITCH_WORK_ITEM_INTENTS = new Set(['switch_work_item']);
export const UNSUPPORTED_DESTRUCTIVE_INTENTS = new Set(['unsupported_destructive_request']);
