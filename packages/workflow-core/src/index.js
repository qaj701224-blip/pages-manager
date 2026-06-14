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

export function makeId(prefix) {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
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

export function idempotencyScopeForJob(job) {
  return [job.source, job.requestedByType, job.requestedById, job.idempotencyKey].join(':');
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
