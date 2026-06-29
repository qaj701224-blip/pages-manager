import { randomUUID } from 'node:crypto';

export const PUBLISHING_JOB_STATUSES = [
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

export const WORK_ITEM_KINDS = ['site_publishing', 'platform_dev'];

export const PLATFORM_DEV_ITEM_STATUSES = [
  'received',
  'triaging',
  'issue_creating',
  'issue_created',
  'auto_dev_pending',
  'agent_queued',
  'agent_running',
  'branch_committed',
  'pr_created',
  'ci_running',
  'ci_failed',
  'review_waiting',
  'review_blocked',
  'ready_to_merge',
  'merged',
  'closed_unmerged',
  'failed',
  'cancelled',
];

export const PLATFORM_DEV_ISSUE_TYPES = [
  'type:dev',
  'type:bug',
  'type:docs',
  'type:feedback',
  'type:question',
  'type:ci',
  'type:ops',
  'type:security',
];

export const PLATFORM_DEV_RISKS = ['risk:low', 'risk:medium', 'risk:high'];
export const PLATFORM_AUTO_DEV_STATUSES = ['pending', 'triggered'];

export const SLACK_AGENT_DIALOG_ACTS = [
  'answer',
  'ask_clarification',
  'request_confirmation',
  'run_tool',
  'deny',
  'handoff',
];

export const SLACK_AGENT_CARD_KINDS = [
  'none',
  'confirmation',
  'task_list',
  'diagnosis',
  'repo_answer',
  'status',
  'handoff',
];

export const SLACK_AGENT_CONFIRMATION_TYPES = [
  'none',
  'create_site_issue',
  'create_platform_issue',
  'continue_work_item',
  'retry_work_item',
  'append_diagnosis_to_issue',
  'human_triage',
  'reopen_work_item',
];

export const SLACK_AGENT_WORK_ITEM_STATES = ['active', 'all', 'closed'];

export const SLACK_AGENT_REPEAT_TARGETS = [
  'previous_visible_message',
  'previous_user_message',
  'previous_assistant_message',
];

export const SLACK_AGENT_REVIEW_RESULT_TARGET_KINDS = ['current', 'issue', 'pr', 'unknown'];

export const SLACK_AGENT_CAPABILITIES = {
  list_my_work_items: {
    name: 'list_my_work_items',
    intents: ['list_work_items'],
    dialogAct: 'run_tool',
    sideEffect: 'read',
    confirmation: 'none',
    cardKind: 'task_list',
    args: {
      state: SLACK_AGENT_WORK_ITEM_STATES,
    },
    description: 'List the current Slack user visible issue, PR, and publishing work items.',
  },
  switch_work_item: {
    name: 'switch_work_item',
    intents: ['switch_work_item'],
    dialogAct: 'run_tool',
    sideEffect: 'write_session',
    confirmation: 'none',
    cardKind: 'status',
    args: {
      kind: ['issue', 'pr', 'unknown'],
      number: 'positive_integer',
    },
    description: 'Switch the current Slack thread focus to one visible issue or PR.',
  },
  reopen_work_item: {
    name: 'reopen_work_item',
    intents: ['reopen_work_item'],
    dialogAct: 'request_confirmation',
    sideEffect: 'write_github',
    confirmation: 'reopen_work_item',
    cardKind: 'confirmation',
    args: {
      kind: ['issue', 'pr', 'unknown'],
      number: 'positive_integer',
    },
    description: 'Request reopening one visible closed issue or PR.',
  },
  get_current_status: {
    name: 'get_current_status',
    intents: ['status_query'],
    dialogAct: 'run_tool',
    sideEffect: 'read',
    confirmation: 'none',
    cardKind: 'status',
    args: {},
    description: 'Read current session progress.',
  },
  diagnose_current_work_item: {
    name: 'diagnose_current_work_item',
    intents: [
      'diagnose_work_item',
      'get_work_item_timeline',
      'explain_work_item_blocker',
      'get_workflow_status',
    ],
    dialogAct: 'run_tool',
    sideEffect: 'read',
    confirmation: 'none',
    cardKind: 'diagnosis',
    args: {
      timeWindowMinutes: 'positive_integer',
    },
    description: 'Explain status, blocker, workflow, and safe log summary for the current work item.',
  },
  summarize_review_results: {
    name: 'summarize_review_results',
    intents: ['summarize_review_results', 'list_review_results'],
    dialogAct: 'run_tool',
    sideEffect: 'read',
    confirmation: 'none',
    cardKind: 'diagnosis',
    args: {
      kind: SLACK_AGENT_REVIEW_RESULT_TARGET_KINDS,
      number: 'positive_integer',
      includeResolved: 'boolean',
      maxItems: 'positive_integer',
    },
    description: 'Summarize visible Review Agent comments and site-check state for the current PR.',
  },
  answer_repo_question: {
    name: 'answer_repo_question',
    intents: ['repo_question', 'architecture_question', 'platform_question'],
    dialogAct: 'run_tool',
    sideEffect: 'read',
    confirmation: 'none',
    cardKind: 'repo_answer',
    args: {
      question: 'string',
    },
    description: 'Answer a repository implementation or architecture question from controlled evidence.',
  },
  repeat_previous_message: {
    name: 'repeat_previous_message',
    intents: ['repeat_previous_message'],
    dialogAct: 'run_tool',
    sideEffect: 'read',
    confirmation: 'none',
    cardKind: 'none',
    args: {
      target: SLACK_AGENT_REPEAT_TARGETS,
    },
    description: 'Repeat the last visible, user, or assistant message from conversation context.',
  },
  record_followup: {
    name: 'record_followup',
    intents: ['append_requirement', 'modify_existing_preview'],
    dialogAct: 'run_tool',
    sideEffect: 'write_issue_or_job',
    confirmation: 'none',
    cardKind: 'status',
    args: {},
    description: 'Record a follow-up against the focused work item and dispatch a fix when allowed.',
  },
  request_retry_work_item: {
    name: 'request_retry_work_item',
    intents: ['retry_work_item'],
    dialogAct: 'request_confirmation',
    sideEffect: 'write_workflow',
    confirmation: 'retry_work_item',
    cardKind: 'diagnosis',
    args: {},
    description: 'Ask the user to confirm retrying a failed or blocked workflow.',
  },
  request_append_diagnosis_comment: {
    name: 'request_append_diagnosis_comment',
    intents: ['append_diagnosis_comment'],
    dialogAct: 'request_confirmation',
    sideEffect: 'write_github',
    confirmation: 'append_diagnosis_to_issue',
    cardKind: 'diagnosis',
    args: {},
    description: 'Ask the user to confirm appending the visible diagnosis to the linked issue.',
  },
  request_human_triage: {
    name: 'request_human_triage',
    intents: ['human_triage'],
    dialogAct: 'request_confirmation',
    sideEffect: 'write_github',
    confirmation: 'human_triage',
    cardKind: 'handoff',
    args: {},
    description: 'Ask the user to confirm recording a human triage request.',
  },
  confirm_create_issue: {
    name: 'confirm_create_issue',
    intents: ['create_or_update_site', 'new_site_request', 'create_site', 'update_site'],
    dialogAct: 'request_confirmation',
    sideEffect: 'write_github',
    confirmation: 'create_site_issue',
    cardKind: 'confirmation',
    args: {},
    description: 'Show a confirmation card before creating a site publishing issue.',
  },
  confirm_platform_issue: {
    name: 'confirm_platform_issue',
    intents: ['create_platform_issue', 'platform_dev', 'platform_feedback'],
    dialogAct: 'request_confirmation',
    sideEffect: 'write_github',
    confirmation: 'create_platform_issue',
    cardKind: 'confirmation',
    args: {},
    description: 'Show a confirmation card before creating a pages-manager platform issue.',
  },
  close_session: {
    name: 'close_session',
    intents: ['close_session'],
    dialogAct: 'run_tool',
    sideEffect: 'write_session',
    confirmation: 'none',
    cardKind: 'status',
    args: {},
    description: 'Close the current Slack session.',
  },
  cancel_request: {
    name: 'cancel_request',
    intents: ['cancel_request'],
    dialogAct: 'answer',
    sideEffect: 'none',
    confirmation: 'none',
    cardKind: 'none',
    args: {},
    description: 'Record a non-destructive cancellation intent.',
  },
  unsupported_destructive_request: {
    name: 'unsupported_destructive_request',
    intents: ['unsupported_destructive_request'],
    dialogAct: 'deny',
    sideEffect: 'none',
    confirmation: 'none',
    cardKind: 'none',
    args: {},
    description: 'Deny unsupported destructive bulk operations.',
  },
};

export const SLACK_AGENT_CAPABILITY_NAMES = Object.keys(SLACK_AGENT_CAPABILITIES);

export function slackAgentCapabilityForTool(name = '') {
  return SLACK_AGENT_CAPABILITIES[String(name || '').trim()] || null;
}

export function slackAgentCapabilityForIntent(intent = '') {
  const normalized = String(intent || '').trim();
  return SLACK_AGENT_CAPABILITY_NAMES.map((name) => SLACK_AGENT_CAPABILITIES[name]).find((capability) =>
    capability.intents.includes(normalized)
  ) || null;
}

export const FIRST_PRIORITY_STATUSES = [
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
  'failed',
  'cancelled',
];

const STATUS_SET = new Set(PUBLISHING_JOB_STATUSES);
const PLATFORM_DEV_STATUS_SET = new Set(PLATFORM_DEV_ITEM_STATUSES);
const PLATFORM_DEV_ISSUE_TYPE_SET = new Set(PLATFORM_DEV_ISSUE_TYPES);
const PLATFORM_DEV_RISK_SET = new Set(PLATFORM_DEV_RISKS);
const HIGH_RISK_PLATFORM_DEV_ISSUE_TYPES = new Set(['type:ci', 'type:ops', 'type:security']);

const ALLOWED_TRANSITIONS = {
  received: ['summarizing', 'issue_creating', 'failed', 'cancelled'],
  summarizing: ['issue_creating', 'failed', 'cancelled'],
  issue_creating: ['issue_created', 'failed', 'cancelled'],
  issue_created: ['indexing', 'generating_page', 'failed', 'cancelled'],
  indexing: ['generating_page', 'failed', 'cancelled'],
  generating_page: ['patch_generated', 'branch_committed', 'pr_created', 'failed', 'cancelled'],
  patch_generated: ['branch_committed', 'failed', 'cancelled'],
  branch_committed: ['pr_created', 'failed', 'cancelled'],
  pr_created: ['reviewing', 'previewing', 'failed', 'cancelled'],
  reviewing: ['changes_requested', 'fixing', 'previewing', 'failed', 'cancelled'],
  changes_requested: ['fixing', 'previewing', 'failed', 'cancelled'],
  fixing: ['reviewing', 'failed', 'cancelled'],
  previewing: ['preview_deployed', 'failed', 'cancelled'],
  preview_deployed: ['fixing', 'approved', 'failed'],
  approved: ['merging', 'failed', 'cancelled'],
  merging: ['merged', 'failed', 'cancelled'],
  merged: ['deploying', 'failed'],
  deploying: ['deployed', 'failed'],
  deployed: [],
  failed: [],
  cancelled: [],
};

const PLATFORM_DEV_ALLOWED_TRANSITIONS = {
  received: ['triaging', 'issue_creating', 'auto_dev_pending', 'failed', 'cancelled'],
  triaging: ['issue_creating', 'auto_dev_pending', 'failed', 'cancelled'],
  issue_creating: ['issue_created', 'failed', 'cancelled'],
  issue_created: ['auto_dev_pending', 'agent_queued', 'agent_running', 'closed_unmerged', 'failed', 'cancelled'],
  auto_dev_pending: ['agent_queued', 'agent_running', 'closed_unmerged', 'failed', 'cancelled'],
  agent_queued: ['agent_running', 'failed', 'cancelled'],
  agent_running: ['branch_committed', 'pr_created', 'ci_running', 'failed', 'cancelled'],
  branch_committed: ['pr_created', 'ci_running', 'failed', 'cancelled'],
  pr_created: [
    'agent_queued',
    'agent_running',
    'ci_running',
    'review_waiting',
    'review_blocked',
    'ready_to_merge',
    'closed_unmerged',
    'failed',
    'cancelled',
  ],
  ci_running: [
    'agent_queued',
    'agent_running',
    'ci_failed',
    'review_waiting',
    'review_blocked',
    'ready_to_merge',
    'failed',
    'cancelled',
  ],
  ci_failed: [
    'agent_queued',
    'agent_running',
    'ci_running',
    'review_waiting',
    'review_blocked',
    'ready_to_merge',
    'failed',
    'cancelled',
  ],
  review_waiting: [
    'agent_queued',
    'agent_running',
    'review_blocked',
    'ready_to_merge',
    'closed_unmerged',
    'failed',
    'cancelled',
  ],
  review_blocked: ['agent_queued', 'agent_running', 'ci_running', 'review_waiting', 'ready_to_merge', 'failed', 'cancelled'],
  ready_to_merge: [
    'agent_queued',
    'agent_running',
    'merged',
    'review_blocked',
    'ci_running',
    'closed_unmerged',
    'failed',
    'cancelled',
  ],
  merged: [],
  failed: ['agent_queued', 'review_blocked', 'cancelled', 'merged'],
  cancelled: ['merged'],
  closed_unmerged: ['issue_created', 'auto_dev_pending', 'agent_queued', 'agent_running', 'pr_created', 'merged'],
};

export function isPublishingJobStatus(status) {
  return STATUS_SET.has(status);
}

export function assertPublishingJobStatus(status) {
  if (!isPublishingJobStatus(status)) {
    throw new Error(`Unknown PublishingJob status: ${status}`);
  }
}

export function canTransition(from, to) {
  assertPublishingJobStatus(from);
  assertPublishingJobStatus(to);
  if (from === to) return true;
  return ALLOWED_TRANSITIONS[from]?.includes(to) || false;
}

export function assertTransition(from, to) {
  if (!canTransition(from, to)) {
    throw new Error(`Invalid PublishingJob transition: ${from} -> ${to}`);
  }
}

export function transitionJob(job, status, patch = {}, now = new Date()) {
  assertTransition(job.status, status);
  return {
    ...job,
    ...patch,
    status,
    updatedAt: now.toISOString(),
  };
}

export function isPlatformDevItemStatus(status) {
  return PLATFORM_DEV_STATUS_SET.has(status);
}

export function assertPlatformDevItemStatus(status) {
  if (!isPlatformDevItemStatus(status)) {
    throw new Error(`Unknown PlatformDevItem status: ${status}`);
  }
}

export function canTransitionPlatformDevItem(from, to) {
  assertPlatformDevItemStatus(from);
  assertPlatformDevItemStatus(to);
  if (from === to) return true;
  return PLATFORM_DEV_ALLOWED_TRANSITIONS[from]?.includes(to) || false;
}

export function assertPlatformDevItemTransition(from, to) {
  if (!canTransitionPlatformDevItem(from, to)) {
    throw new Error(`Invalid PlatformDevItem transition: ${from} -> ${to}`);
  }
}

export function transitionPlatformDevItem(item, status, patch = {}, now = new Date()) {
  assertPlatformDevItemTransition(item.status, status);
  return {
    ...item,
    ...patch,
    status,
    updatedAt: now.toISOString(),
  };
}

const PLATFORM_DEV_CALLBACK_BRIDGES = {
  issue_created: {
    received: ['issue_creating', 'issue_created'],
    triaging: ['issue_creating', 'issue_created'],
  },
  auto_dev_pending: {
    received: ['issue_creating', 'issue_created', 'auto_dev_pending'],
    triaging: ['issue_creating', 'issue_created', 'auto_dev_pending'],
    issue_creating: ['issue_created', 'auto_dev_pending'],
  },
  agent_queued: {
    received: ['issue_creating', 'issue_created', 'agent_queued'],
    triaging: ['issue_creating', 'issue_created', 'agent_queued'],
    issue_creating: ['issue_created', 'agent_queued'],
    auto_dev_pending: ['agent_queued'],
  },
  agent_running: {
    received: ['issue_creating', 'issue_created', 'agent_queued', 'agent_running'],
    triaging: ['issue_creating', 'issue_created', 'agent_queued', 'agent_running'],
    issue_creating: ['issue_created', 'agent_queued', 'agent_running'],
    issue_created: ['agent_queued', 'agent_running'],
    auto_dev_pending: ['agent_queued', 'agent_running'],
    failed: ['agent_queued', 'agent_running'],
  },
  branch_committed: {
    received: ['issue_creating', 'issue_created', 'agent_queued', 'agent_running', 'branch_committed'],
    triaging: ['issue_creating', 'issue_created', 'agent_queued', 'agent_running', 'branch_committed'],
    issue_creating: ['issue_created', 'agent_queued', 'agent_running', 'branch_committed'],
    issue_created: ['agent_queued', 'agent_running', 'branch_committed'],
    auto_dev_pending: ['agent_queued', 'agent_running', 'branch_committed'],
    agent_queued: ['agent_running', 'branch_committed'],
  },
  pr_created: {
    received: ['issue_creating', 'issue_created', 'agent_queued', 'agent_running', 'branch_committed', 'pr_created'],
    triaging: ['issue_creating', 'issue_created', 'agent_queued', 'agent_running', 'branch_committed', 'pr_created'],
    issue_creating: ['issue_created', 'agent_queued', 'agent_running', 'branch_committed', 'pr_created'],
    issue_created: ['agent_queued', 'agent_running', 'branch_committed', 'pr_created'],
    auto_dev_pending: ['agent_queued', 'agent_running', 'branch_committed', 'pr_created'],
    agent_queued: ['agent_running', 'branch_committed', 'pr_created'],
    agent_running: ['branch_committed', 'pr_created'],
  },
  ci_running: {
    // eslint-disable-next-line max-len
    received: ['issue_creating', 'issue_created', 'agent_queued', 'agent_running', 'branch_committed', 'pr_created', 'ci_running'],
    // eslint-disable-next-line max-len
    triaging: ['issue_creating', 'issue_created', 'agent_queued', 'agent_running', 'branch_committed', 'pr_created', 'ci_running'],
    issue_creating: ['issue_created', 'agent_queued', 'agent_running', 'branch_committed', 'pr_created', 'ci_running'],
    issue_created: ['agent_queued', 'agent_running', 'branch_committed', 'pr_created', 'ci_running'],
    auto_dev_pending: ['agent_queued', 'agent_running', 'branch_committed', 'pr_created', 'ci_running'],
    agent_queued: ['agent_running', 'branch_committed', 'pr_created', 'ci_running'],
    agent_running: ['branch_committed', 'pr_created', 'ci_running'],
    branch_committed: ['pr_created', 'ci_running'],
  },
  ci_failed: {
    pr_created: ['ci_running', 'ci_failed'],
    branch_committed: ['pr_created', 'ci_running', 'ci_failed'],
    agent_running: ['branch_committed', 'pr_created', 'ci_running', 'ci_failed'],
  },
  review_waiting: {
    branch_committed: ['pr_created', 'review_waiting'],
    agent_running: ['branch_committed', 'pr_created', 'review_waiting'],
  },
  review_blocked: {
    branch_committed: ['pr_created', 'review_blocked'],
    agent_running: ['branch_committed', 'pr_created', 'review_blocked'],
  },
  ready_to_merge: {
    branch_committed: ['pr_created', 'ready_to_merge'],
    agent_running: ['branch_committed', 'pr_created', 'ready_to_merge'],
  },
  merged: {
    pr_created: ['ready_to_merge', 'merged'],
    ci_running: ['ready_to_merge', 'merged'],
    review_waiting: ['ready_to_merge', 'merged'],
  },
};

function isStalePlatformDevCallback(from, to) {
  if (['merged', 'closed_unmerged', 'cancelled'].includes(from)) return true;
  if (
    from === 'failed' &&
    to !== 'agent_queued' &&
    to !== 'agent_running' &&
    to !== 'review_blocked' &&
    to !== 'cancelled'
  ) {
    return true;
  }
  if (from === 'ready_to_merge' && to === 'ci_failed') return true;
  if (['agent_queued', 'agent_running', 'branch_committed'].includes(from) && to !== 'ready_to_merge') return true;
  return false;
}

export function platformDevTransitionPath(from, to) {
  assertPlatformDevItemStatus(from);
  assertPlatformDevItemStatus(to);
  if (from === to || canTransitionPlatformDevItem(from, to)) return [to];
  if (isStalePlatformDevCallback(from, to)) return [];
  const bridge = PLATFORM_DEV_CALLBACK_BRIDGES[to]?.[from];
  if (bridge) return bridge;
  assertPlatformDevItemTransition(from, to);
}

export function transitionPlatformDevItemWithBridge(item, status, patch = {}, now = new Date(), onBridge = null) {
  const path = platformDevTransitionPath(item.status, status);
  if (!path.length) {
    return item;
  }
  let current = item;
  for (const nextStatus of path) {
    const nextPatch = nextStatus === status ? patch : {};
    current = transitionPlatformDevItem(current, nextStatus, nextPatch, now);
    if (nextStatus !== status && typeof onBridge === 'function') {
      onBridge(current, nextStatus);
    }
  }
  return current;
}

export function makeId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

function cleanString(value, maxLength = 255) {
  const text = String(value || '').trim();
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function normalizeEnum(value, allowed, fallback) {
  const text = cleanString(value, 80);
  return text && allowed.has(text) ? text : fallback;
}

function normalizeStringArray(value, maxItems = 12, maxLength = 80) {
  const raw = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const seen = new Set();
  const items = [];
  for (const entry of raw) {
    const item = cleanString(entry, maxLength);
    if (!item || seen.has(item)) continue;
    seen.add(item);
    items.push(item);
    if (items.length >= maxItems) break;
  }
  return items;
}

function normalizeRequesterProfile(input = {}) {
  const profile = input.requesterProfile || input.requester_profile || input.requester || null;
  if (!profile || typeof profile !== 'object') return null;

  const normalized = {
    source: cleanString(profile.source, 80),
    slackTeamId: cleanString(profile.slackTeamId || profile.slack_team_id, 255),
    slackUserId: cleanString(profile.slackUserId || profile.slack_user_id, 255),
    name: cleanString(profile.name, 255),
    displayName: cleanString(profile.displayName || profile.display_name, 255),
    realName: cleanString(profile.realName || profile.real_name, 255),
    email: cleanString(profile.email, 255),
  };
  const compact = Object.fromEntries(Object.entries(normalized).filter(([, value]) => value));
  return Object.keys(compact).length ? compact : null;
}

export function buildPublishingJob(input, options = {}) {
  const now = options.now || new Date();
  const source = input.source || 'api';
  const requestedByType = input.requestedByType || input.requested_by_type || 'user';
  const requestedById = input.requestedById || input.requested_by_id;
  const idempotencyKey = input.idempotencyKey || input.idempotency_key;
  const employeeSlug = input.employeeSlug || input.employee_slug;
  const siteSlug = input.siteSlug || input.site_slug;
  const ownerScopeId = input.ownerScopeId || input.owner_scope_id || `scope_${employeeSlug || 'unknown'}`;

  if (!requestedById) throw new Error('requestedById is required');
  if (!idempotencyKey) throw new Error('idempotencyKey is required');
  if (!employeeSlug) throw new Error('employeeSlug is required');
  if (!siteSlug) throw new Error('siteSlug is required');

  return {
    id: options.id || makeId('job'),
    source,
    idempotencyKey,
    requestedByType,
    requestedById,
    siteProjectId: input.siteProjectId || input.site_project_id || null,
    ownerScopeId,
    employeeId: input.employeeId || input.employee_id || null,
    employeeSlug,
    siteSlug,
    intent: input.intent || 'create_site',
    approvalMode: input.approvalMode || input.approval_mode || 'manual_required',
    status: 'received',
    title: input.title || input.summary || input.brief || `${employeeSlug}/${siteSlug}`,
    summary: input.summary || input.brief || '',
    requesterProfile: normalizeRequesterProfile(input),
    slackThread: input.slackThread || input.slack_thread || null,
    slackSessionId: input.slackSessionId || input.slack_session_id || null,
    slackSessionKey: input.slackSessionKey || input.slack_session_key || null,
    issueNumber: null,
    issueUrl: null,
    prNumber: null,
    prUrl: null,
    branchName: null,
    baseRef: input.baseRef || input.base_ref || null,
    headSha: null,
    workflowName: null,
    workflowRunId: null,
    indexSnapshotId: null,
    previewUrl: null,
    errorCode: null,
    errorMessage: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

function normalizePlatformDevIssueType(input = {}) {
  return normalizeEnum(
    input.issueType || input.issue_type || input.type || input.label,
    PLATFORM_DEV_ISSUE_TYPE_SET,
    'type:dev'
  );
}

function normalizePlatformDevRisk(input = {}) {
  const issueType = normalizePlatformDevIssueType(input);
  if (HIGH_RISK_PLATFORM_DEV_ISSUE_TYPES.has(issueType)) return 'risk:high';
  const defaultRisk = 'risk:medium';
  return normalizeEnum(input.risk || input.riskLabel || input.risk_label, PLATFORM_DEV_RISK_SET, defaultRisk);
}

function normalizePlatformDevAreas(input = {}) {
  const areas = normalizeStringArray(input.areas || input.areaLabels || input.area_labels || input.area, 16, 80);
  return areas.length ? areas : ['area:platform'];
}

function normalizeBoolean(value, fallback = false) {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())) return false;
  return fallback;
}

export function buildPlatformDevItem(input, options = {}) {
  const now = options.now || new Date();
  const source = input.source || 'slack';
  const requestedByType = input.requestedByType || input.requested_by_type || 'user';
  const requestedById = input.requestedById || input.requested_by_id;
  const idempotencyKey = input.idempotencyKey || input.idempotency_key;
  const issueType = normalizePlatformDevIssueType(input);
  const risk = normalizePlatformDevRisk({ ...input, issueType });
  const rawAgentEligible = input.agentEligible ?? input.agent_eligible;
  const agentEligible = normalizeBoolean(rawAgentEligible, true);

  if (!requestedById) throw new Error('requestedById is required');
  if (!idempotencyKey) throw new Error('idempotencyKey is required');

  return {
    id: options.id || makeId('pdev'),
    source,
    idempotencyKey,
    requestedByType,
    requestedById,
    title: cleanString(input.title || input.summary || input.brief, 255) || 'pages-manager 平台改造需求',
    summary: input.summary || input.brief || '',
    issueType,
    areas: normalizePlatformDevAreas(input),
    risk,
    agentEligible,
    autoDevStatus: 'pending',
    autoDevTriggeredBy: null,
    autoDevTriggeredAt: null,
    autoDevReason: input.autoDevReason || input.auto_dev_reason || null,
    status: options.status || input.status || 'received',
    requesterProfile: normalizeRequesterProfile(input),
    slackThread: input.slackThread || input.slack_thread || null,
    slackSessionId: input.slackSessionId || input.slack_session_id || null,
    slackSessionKey: input.slackSessionKey || input.slack_session_key || null,
    githubIssueNumber: input.githubIssueNumber || input.github_issue_number || null,
    githubIssueUrl: input.githubIssueUrl || input.github_issue_url || null,
    githubPrNumber: input.githubPrNumber || input.github_pr_number || null,
    githubPrUrl: input.githubPrUrl || input.github_pr_url || null,
    branchName: input.branchName || input.branch_name || null,
    baseRef: input.baseRef || input.base_ref || null,
    headSha: input.headSha || input.head_sha || null,
    workflowName: input.workflowName || input.workflow_name || null,
    workflowRunId: input.workflowRunId || input.workflow_run_id || null,
    reviewContext: input.reviewContext || input.review_context || '',
    memoryContext: input.memoryContext || input.memory_context || '',
    statusContext: input.statusContext || input.status_context || '',
    followupContext: input.followupContext || input.followup_context || '',
    reviewSummary: input.reviewSummary || input.review_summary || null,
    errorCode: null,
    errorMessage: null,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  };
}

export function idempotencyScopeForJob(job) {
  return [job.source, job.requestedByType, job.requestedById, job.idempotencyKey].join(':');
}

export function idempotencyScopeForPlatformDevItem(item) {
  return [item.source, item.requestedByType, item.requestedById, item.idempotencyKey].join(':');
}

export function idempotencyScopeForInput(input) {
  const source = input.source || 'api';
  const requestedByType = input.requestedByType || input.requested_by_type || 'user';
  const requestedById = input.requestedById || input.requested_by_id;
  const idempotencyKey = input.idempotencyKey || input.idempotency_key;
  return [source, requestedByType, requestedById, idempotencyKey].join(':');
}

export function eventForStatus(job, message, now = new Date()) {
  return {
    id: makeId('event'),
    publishingJobId: job.id,
    status: job.status,
    message,
    createdAt: now.toISOString(),
  };
}

export function platformDevItemEvent(item, message, now = new Date()) {
  return {
    id: makeId('pdevevt'),
    platformDevItemId: item.id,
    status: item.status,
    message,
    createdAt: now.toISOString(),
  };
}
