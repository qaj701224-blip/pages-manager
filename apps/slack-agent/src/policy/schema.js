export const SLACK_AGENT_LANES = ['site-publishing', 'platform-dev', 'repo-question', 'unknown'];

export const SLACK_AGENT_INTENTS = [
  'create_or_update_site',
  'modify_existing_preview',
  'append_requirement',
  'create_platform_issue',
  'platform_feedback',
  'repo_question',
  'architecture_question',
  'list_work_items',
  'switch_work_item',
  'reopen_work_item',
  'diagnose_work_item',
  'repeat_previous_message',
  'status_query',
  'cancel_request',
  'close_session',
  'unsupported_destructive_request',
  'clarify',
];

export const SLACK_AGENT_TOOL_NAMES = [
  'list_my_work_items',
  'switch_work_item',
  'reopen_work_item',
  'get_current_status',
  'diagnose_current_work_item',
  'answer_repo_question',
  'repeat_previous_message',
  'record_followup',
  'confirm_create_issue',
  'confirm_platform_issue',
  'close_session',
  'cancel_request',
  'unsupported_destructive_request',
];

export const PLATFORM_ISSUE_TYPES = [
  'type:dev',
  'type:bug',
  'type:docs',
  'type:feedback',
  'type:question',
  'type:ci',
  'type:ops',
  'type:security',
];

export const PLATFORM_RISKS = ['risk:low', 'risk:medium', 'risk:high'];

export const PLATFORM_AREAS = [
  'area:gateway',
  'area:worker',
  'area:github',
  'area:ci',
  'area:db',
  'area:slack-agent',
  'area:slack-notifier',
  'area:slack',
  'area:docs',
  'area:ops',
  'area:platform',
];

export const WORK_ITEM_STATES = ['active', 'all', 'closed'];

export const REPEAT_PREVIOUS_MESSAGE_TARGETS = [
  'previous_visible_message',
  'previous_user_message',
  'previous_assistant_message',
];
