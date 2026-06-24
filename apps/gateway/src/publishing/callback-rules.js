import { canTransition } from '@xd/workflow-core';

function workflowPatch(body = {}) {
  return {
    workflowName: body.workflowName || body.workflow_name || null,
    workflowRunId: body.workflowRunId || body.workflow_run_id || null,
  };
}

function optionalPatch(fields = {}) {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

export const CALLBACK_STAGE_RESULTS = {
  index_ready: {
    status: 'generating_page',
    patch(body) {
      return {
        ...workflowPatch(body),
        indexSnapshotId: body.indexSnapshotId || body.index_snapshot_id || null,
      };
    },
  },
  issue_created: {
    status: 'issue_created',
    patch(body) {
      return {
        issueNumber: body.issueNumber || body.issue_number || null,
        issueUrl: body.issueUrl || body.issue_url || null,
      };
    },
  },
  patch_generated: { status: 'patch_generated' },
  branch_committed: {
    status: 'branch_committed',
    patch(body) {
      return {
        ...workflowPatch(body),
        branchName: body.branchName || body.branch_name || null,
      };
    },
  },
  pr_created: {
    status: 'pr_created',
    patch(body) {
      return {
        ...workflowPatch(body),
        branchName: body.branchName || body.branch_name || null,
        prNumber: body.prNumber || body.pr_number || null,
        prUrl: body.prUrl || body.pr_url || null,
        baseRef: body.baseRef || body.base_ref || null,
        headSha: body.headSha || body.head_sha || null,
      };
    },
  },
  reviewing: {
    status: 'reviewing',
    patch(body) {
      return {
        ...workflowPatch(body),
        branchName: body.branchName || body.branch_name || null,
        prNumber: body.prNumber || body.pr_number || null,
        prUrl: body.prUrl || body.pr_url || null,
        baseRef: body.baseRef || body.base_ref || null,
        headSha: body.headSha || body.head_sha || null,
      };
    },
  },
  previewing: { status: 'previewing' },
  preview_deployed: {
    status: 'preview_deployed',
    patch(body) {
      return optionalPatch({
        ...workflowPatch(body),
        previewUrl: body.previewUrl || body.preview_url || null,
        prNumber: body.prNumber || body.pr_number || undefined,
        headSha: body.headSha || body.head_sha || undefined,
      });
    },
  },
};

export const STALE_CALLBACK_PATCH_STATUSES = {
  issue_created: new Set([
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
  ]),
};

const TERMINAL_JOB_STATUSES = new Set(['failed', 'cancelled', 'merged', 'deployed']);

function shaMatches(left, right) {
  if (!left || !right) return false;
  const normalizedLeft = String(left).toLowerCase();
  const normalizedRight = String(right).toLowerCase();
  if (normalizedLeft.length < 7 || normalizedRight.length < 7) return false;
  return normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}

function shouldIgnoreExecutorCallback(existing = {}, stageResult = '', patch = {}) {
  if (TERMINAL_JOB_STATUSES.has(existing.status)) return true;
  if (
    stageResult === 'issue_created' &&
    existing.issueNumber &&
    patch.issueNumber &&
    Number(existing.issueNumber) === Number(patch.issueNumber) &&
    existing.status !== 'received' &&
    existing.status !== 'issue_creating'
  ) {
    return true;
  }
  if (stageResult === 'preview_deployed' && patch.headSha && existing.headSha && !shaMatches(existing.headSha, patch.headSha)) {
    return true;
  }
  return false;
}

export async function applyExecutorCallback(store, jobId, stageResult, status, patch) {
  const existing = await store.getJob(jobId);
  if (!existing) return { job: null, ignored: false };

  if (shouldIgnoreExecutorCallback(existing, stageResult, patch)) {
    return { job: existing, ignored: true };
  }

  if (status === 'reviewing' && !canTransition(existing.status, status)) {
    const paths = {
      issue_created: ['generating_page', 'pr_created', 'reviewing'],
      generating_page: ['pr_created', 'reviewing'],
      patch_generated: ['branch_committed', 'pr_created', 'reviewing'],
      branch_committed: ['pr_created', 'reviewing'],
      fixing: ['reviewing'],
    };
    const path = paths[existing.status];
    if (path) {
      let current = existing;
      for (const nextStatus of path) {
        current = await store.updateJob(jobId, nextStatus, nextStatus === status ? patch : {});
        if (!current) return { job: null, ignored: false };
      }
      return { job: current, ignored: false };
    }
  }

  if (STALE_CALLBACK_PATCH_STATUSES[stageResult]?.has(existing.status)) {
    return { job: await store.patchJob(jobId, patch), ignored: false };
  }

  return { job: await store.updateJob(jobId, status, patch), ignored: false };
}
