export const CALLBACK_STAGE_RESULTS = {
  index_ready: {
    status: 'generating_page',
    patch(body) {
      return { indexSnapshotId: body.indexSnapshotId || body.index_snapshot_id || null };
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
      return { branchName: body.branchName || body.branch_name || null };
    },
  },
  pr_created: {
    status: 'pr_created',
    patch(body) {
      return {
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
      return { previewUrl: body.previewUrl || body.preview_url || null };
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

export async function applyExecutorCallback(store, jobId, stageResult, status, patch) {
  const existing = await store.getJob(jobId);
  if (!existing) return null;

  if (STALE_CALLBACK_PATCH_STATUSES[stageResult]?.has(existing.status)) {
    return await store.patchJob(jobId, patch);
  }

  return await store.updateJob(jobId, status, patch);
}
