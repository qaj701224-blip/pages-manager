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
  'gate_pending',
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
  received: ['triaging', 'issue_creating', 'gate_pending', 'failed', 'cancelled'],
  triaging: ['issue_creating', 'gate_pending', 'failed', 'cancelled'],
  issue_creating: ['issue_created', 'failed', 'cancelled'],
  issue_created: ['gate_pending', 'agent_queued', 'agent_running', 'closed_unmerged', 'failed', 'cancelled'],
  gate_pending: ['agent_queued', 'agent_running', 'closed_unmerged', 'failed', 'cancelled'],
  agent_queued: ['agent_running', 'failed', 'cancelled'],
  agent_running: ['branch_committed', 'pr_created', 'ci_running', 'failed', 'cancelled'],
  branch_committed: ['pr_created', 'ci_running', 'failed', 'cancelled'],
  pr_created: ['ci_running', 'review_waiting', 'review_blocked', 'ready_to_merge', 'closed_unmerged', 'failed', 'cancelled'],
  ci_running: ['ci_failed', 'review_waiting', 'review_blocked', 'ready_to_merge', 'failed', 'cancelled'],
  ci_failed: ['agent_queued', 'agent_running', 'failed', 'cancelled'],
  review_waiting: ['review_blocked', 'ready_to_merge', 'closed_unmerged', 'failed', 'cancelled'],
  review_blocked: ['agent_queued', 'agent_running', 'ci_running', 'review_waiting', 'failed', 'cancelled'],
  ready_to_merge: ['merged', 'review_blocked', 'ci_running', 'closed_unmerged', 'failed', 'cancelled'],
  merged: [],
  closed_unmerged: [],
  failed: [],
  cancelled: [],
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
  gate_pending: {
    received: ['issue_creating', 'issue_created', 'gate_pending'],
    triaging: ['issue_creating', 'issue_created', 'gate_pending'],
    issue_creating: ['issue_created', 'gate_pending'],
  },
  agent_queued: {
    received: ['issue_creating', 'issue_created', 'agent_queued'],
    triaging: ['issue_creating', 'issue_created', 'agent_queued'],
    issue_creating: ['issue_created', 'agent_queued'],
    gate_pending: ['agent_queued'],
  },
  agent_running: {
    received: ['issue_creating', 'issue_created', 'agent_queued', 'agent_running'],
    triaging: ['issue_creating', 'issue_created', 'agent_queued', 'agent_running'],
    issue_creating: ['issue_created', 'agent_queued', 'agent_running'],
    issue_created: ['agent_queued', 'agent_running'],
    gate_pending: ['agent_queued', 'agent_running'],
  },
  branch_committed: {
    received: ['issue_creating', 'issue_created', 'agent_queued', 'agent_running', 'branch_committed'],
    triaging: ['issue_creating', 'issue_created', 'agent_queued', 'agent_running', 'branch_committed'],
    issue_creating: ['issue_created', 'agent_queued', 'agent_running', 'branch_committed'],
    issue_created: ['agent_queued', 'agent_running', 'branch_committed'],
    gate_pending: ['agent_queued', 'agent_running', 'branch_committed'],
    agent_queued: ['agent_running', 'branch_committed'],
  },
  pr_created: {
    received: ['issue_creating', 'issue_created', 'agent_queued', 'agent_running', 'branch_committed', 'pr_created'],
    triaging: ['issue_creating', 'issue_created', 'agent_queued', 'agent_running', 'branch_committed', 'pr_created'],
    issue_creating: ['issue_created', 'agent_queued', 'agent_running', 'branch_committed', 'pr_created'],
    issue_created: ['agent_queued', 'agent_running', 'branch_committed', 'pr_created'],
    gate_pending: ['agent_queued', 'agent_running', 'branch_committed', 'pr_created'],
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
    gate_pending: ['agent_queued', 'agent_running', 'branch_committed', 'pr_created', 'ci_running'],
    agent_queued: ['agent_running', 'branch_committed', 'pr_created', 'ci_running'],
    agent_running: ['branch_committed', 'pr_created', 'ci_running'],
    branch_committed: ['pr_created', 'ci_running'],
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

export function platformDevTransitionPath(from, to) {
  assertPlatformDevItemStatus(from);
  assertPlatformDevItemStatus(to);
  if (from === to || canTransitionPlatformDevItem(from, to)) return [to];
  const bridge = PLATFORM_DEV_CALLBACK_BRIDGES[to]?.[from];
  if (bridge) return bridge;
  assertPlatformDevItemTransition(from, to);
}

export function transitionPlatformDevItemWithBridge(item, status, patch = {}, now = new Date(), onBridge = null) {
  const path = platformDevTransitionPath(item.status, status);
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
  const rawRequiresHumanGate = input.requiresHumanGate ?? input.requires_human_gate;
  const agentEligible = normalizeBoolean(rawAgentEligible, !['type:feedback', 'type:question'].includes(issueType));
  const requiresRiskGate = risk === 'risk:high' || HIGH_RISK_PLATFORM_DEV_ISSUE_TYPES.has(issueType);
  const requiresHumanGate = requiresRiskGate ? true : normalizeBoolean(rawRequiresHumanGate, false);

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
    requiresHumanGate,
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
    gateStatus: input.gateStatus || input.gate_status || (requiresHumanGate ? 'pending' : 'not_required'),
    gateReason: input.gateReason || input.gate_reason || null,
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
