import { makeId } from '@xd/workflow-core';

import { classifyReviewAgentComment } from '../../github/review.js';
import { reviewCommentToRow, rowToReviewComment, rowToSiteCheckRun, siteCheckRunToRow } from '../rows/review-row.js';
import { execute, upsertRow } from '../sql.js';

function shaMatches(left, right) {
  if (!left || !right) return false;
  const normalizedLeft = String(left).toLowerCase();
  const normalizedRight = String(right).toLowerCase();
  if (normalizedLeft.length < 7 || normalizedRight.length < 7) return false;
  return normalizedLeft.startsWith(normalizedRight) || normalizedRight.startsWith(normalizedLeft);
}

export const reviewGateRepositoryMethods = {
  async recordReviewAgentComment(comment) {
    const rows = await execute(
      this.pool,
      'SELECT * FROM review_agent_comments WHERE repo_full_name = ? AND github_comment_node_id = ? LIMIT 1',
      [comment.repoFullName, comment.githubCommentNodeId]
    );
    const existing = rowToReviewComment(rows[0]);
    if (existing) this.cacheReviewComment(existing);

    const now = new Date().toISOString();
    const stored = {
      ...(existing || {}),
      ...comment,
      id: existing?.id || comment.id || makeId('review'),
      firstSeenDeliveryId: existing?.firstSeenDeliveryId || comment.firstSeenDeliveryId,
      lastSeenDeliveryId: comment.lastSeenDeliveryId || comment.firstSeenDeliveryId,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.cacheReviewComment(stored);
    await upsertRow(this.pool, 'review_agent_comments', reviewCommentToRow(stored), {
      excludeUpdate: ['id', 'created_at'],
    });
    return { comment: stored, created: !existing };
  },

  async recordSiteCheckRun(run) {
    const rows = await execute(
      this.pool,
      'SELECT * FROM site_check_runs WHERE repo_full_name = ? AND check_run_node_id = ? LIMIT 1',
      [run.repoFullName, run.checkRunNodeId]
    );
    const existing = rowToSiteCheckRun(rows[0]);
    if (existing) this.cacheSiteCheckRun(existing);

    const now = new Date().toISOString();
    const stored = {
      ...(existing || {}),
      ...run,
      id: existing?.id || run.id || makeId('sitecheck'),
      firstSeenDeliveryId: existing?.firstSeenDeliveryId || run.firstSeenDeliveryId,
      lastSeenDeliveryId: run.lastSeenDeliveryId || run.firstSeenDeliveryId,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
    };
    this.cacheSiteCheckRun(stored);
    await upsertRow(this.pool, 'site_check_runs', siteCheckRunToRow(stored), {
      excludeUpdate: ['id', 'created_at'],
    });
    return { run: stored, created: !existing };
  },

  async listSiteCheckRuns(repoFullName, prNumber, options = {}) {
    const rows = await execute(
      this.pool,
      [
        'SELECT * FROM site_check_runs WHERE repo_full_name = ? AND pr_number = ?',
        'ORDER BY COALESCE(completed_at, updated_at, created_at) DESC',
      ].join(' '),
      [repoFullName, Number(prNumber)]
    );
    const runs = rows.map((row) => this.cacheSiteCheckRun(rowToSiteCheckRun(row)));
    if (!options.headSha) return runs;
    return runs.filter((run) => shaMatches(run.headSha, options.headSha));
  },

  async siteCheckGateForPr(repoFullName, prNumber, options = {}) {
    const runs = await this.listSiteCheckRuns(repoFullName, prNumber, options);
    const latest = runs[0] || null;
    const passed = latest?.status === 'completed' && latest.conclusion === 'success';
    return {
      prNumber: Number(prNumber),
      required: true,
      passed,
      status: latest?.status || 'missing',
      conclusion: latest?.conclusion || null,
      checkName: latest?.checkName || null,
      checkRunId: latest?.checkRunId || null,
      detailsUrl: latest?.detailsUrl || latest?.htmlUrl || null,
      latestRun: latest,
    };
  },

  async listReviewAgentComments(repoFullName, prNumber, options = {}) {
    const rows = await execute(
      this.pool,
      'SELECT * FROM review_agent_comments WHERE repo_full_name = ? AND pr_number = ? ORDER BY updated_at DESC',
      [repoFullName, Number(prNumber)]
    );
    const comments = rows.map((row) => this.cacheReviewComment(rowToReviewComment(row)));
    if (!options.headSha) return comments;
    return comments.filter((comment) => shaMatches(comment.headSha, options.headSha));
  },

  async listReviewAgentCommentsForPrNumber(prNumber, options = {}) {
    const rows = await execute(this.pool, 'SELECT * FROM review_agent_comments WHERE pr_number = ? ORDER BY updated_at DESC', [
      Number(prNumber),
    ]);
    const comments = rows.map((row) => this.cacheReviewComment(rowToReviewComment(row)));
    return comments.filter((comment) => {
      if (options.repoFullName && comment.repoFullName !== options.repoFullName) return false;
      if (!options.headSha) return true;
      return shaMatches(comment.headSha, options.headSha);
    });
  },

  async reviewGateForPr(repoFullName, prNumber, options = {}) {
    const comments = await this.listReviewAgentComments(repoFullName, prNumber, options);
    const openComments = comments
      .filter((comment) => comment.status === 'open')
      .map((comment) => ({
        ...comment,
        classification: comment.classification || classifyReviewAgentComment(comment),
      }));
    const blocking = openComments.filter((comment) => comment.classification === 'blocking');
    const unknown = openComments.filter((comment) => comment.classification === 'unknown');
    return {
      prNumber: Number(prNumber),
      openCount: openComments.length,
      blockingCount: blocking.length,
      unknownCount: unknown.length,
      suggestionCount: openComments.filter((comment) => comment.classification === 'suggestion').length,
      noteCount: openComments.filter((comment) => comment.classification === 'note').length,
      canPreview: blocking.length === 0 && unknown.length === 0,
    };
  },

  async previewGateForPr(repoFullName, prNumber, options = {}) {
    const reviewGate = await this.reviewGateForPr(repoFullName, prNumber, options);
    const siteCheckGate = await this.siteCheckGateForPr(repoFullName, prNumber, options);
    return {
      ...reviewGate,
      reviewGate,
      siteCheck: siteCheckGate,
      siteCheckPassed: siteCheckGate.passed,
      canPreview: reviewGate.canPreview && siteCheckGate.passed,
    };
  },
};
