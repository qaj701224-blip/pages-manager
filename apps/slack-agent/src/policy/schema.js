import {
  PLATFORM_DEV_ISSUE_TYPES,
  PLATFORM_DEV_RISKS,
  SLACK_AGENT_CAPABILITY_NAMES,
  SLACK_AGENT_REPEAT_TARGETS,
  SLACK_AGENT_WORK_ITEM_STATES,
} from '@xd/workflow-core';

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

export const SLACK_AGENT_TOOL_NAMES = SLACK_AGENT_CAPABILITY_NAMES;

export const PLATFORM_ISSUE_TYPES = PLATFORM_DEV_ISSUE_TYPES;

export const PLATFORM_RISKS = PLATFORM_DEV_RISKS;

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

export const WORK_ITEM_STATES = SLACK_AGENT_WORK_ITEM_STATES;

export const REPEAT_PREVIOUS_MESSAGE_TARGETS = SLACK_AGENT_REPEAT_TARGETS;
