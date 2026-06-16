import { makeId } from '@xd/workflow-core';

import { toDate, toIso } from '../sql.js';

export function reviewCommentToRow(comment) {
  return {
    id: comment.id || makeId('review'),
    repo_full_name: comment.repoFullName,
    pr_number: comment.prNumber,
    github_comment_node_id: comment.githubCommentNodeId,
    source_type: comment.sourceType,
    review_agent_login: comment.reviewAgentLogin || null,
    classification: comment.classification || null,
    status: comment.status || 'open',
    path: comment.path || null,
    line: comment.line || null,
    body_redacted: comment.bodyRedacted || comment.body || null,
    body_hash: comment.bodyHash || null,
    head_sha: comment.headSha || null,
    first_seen_delivery_id: comment.firstSeenDeliveryId || null,
    last_seen_delivery_id: comment.lastSeenDeliveryId || comment.firstSeenDeliveryId || null,
    created_at: toDate(comment.createdAt),
    updated_at: toDate(comment.updatedAt || comment.createdAt),
  };
}

export function rowToReviewComment(row) {
  if (!row) return null;
  return {
    id: row.id,
    repoFullName: row.repo_full_name,
    prNumber: row.pr_number,
    githubCommentNodeId: row.github_comment_node_id,
    sourceType: row.source_type,
    reviewAgentLogin: row.review_agent_login || null,
    classification: row.classification || null,
    status: row.status || 'open',
    path: row.path || null,
    line: row.line ?? null,
    body: row.body_redacted || '',
    bodyRedacted: row.body_redacted || '',
    bodyHash: row.body_hash || null,
    headSha: row.head_sha || null,
    firstSeenDeliveryId: row.first_seen_delivery_id || null,
    lastSeenDeliveryId: row.last_seen_delivery_id || null,
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}

export function siteCheckRunToRow(run) {
  return {
    id: run.id || makeId('sitecheck'),
    repo_full_name: run.repoFullName,
    pr_number: run.prNumber,
    check_run_id: run.checkRunId || null,
    check_run_node_id: run.checkRunNodeId,
    check_name: run.checkName,
    app_slug: run.appSlug || null,
    app_name: run.appName || null,
    status: run.status || null,
    conclusion: run.conclusion || null,
    head_sha: run.headSha || null,
    details_url: run.detailsUrl || null,
    html_url: run.htmlUrl || null,
    output_summary: run.outputSummary || null,
    first_seen_delivery_id: run.firstSeenDeliveryId || null,
    last_seen_delivery_id: run.lastSeenDeliveryId || run.firstSeenDeliveryId || null,
    completed_at: toDate(run.completedAt),
    created_at: toDate(run.createdAt),
    updated_at: toDate(run.updatedAt || run.createdAt),
  };
}

export function rowToSiteCheckRun(row) {
  if (!row) return null;
  return {
    id: row.id,
    repoFullName: row.repo_full_name,
    prNumber: row.pr_number,
    checkRunId: row.check_run_id || null,
    checkRunNodeId: row.check_run_node_id,
    checkName: row.check_name,
    appSlug: row.app_slug || null,
    appName: row.app_name || null,
    status: row.status || null,
    conclusion: row.conclusion || null,
    headSha: row.head_sha || null,
    detailsUrl: row.details_url || null,
    htmlUrl: row.html_url || null,
    outputSummary: row.output_summary || '',
    firstSeenDeliveryId: row.first_seen_delivery_id || null,
    lastSeenDeliveryId: row.last_seen_delivery_id || null,
    completedAt: toIso(row.completed_at),
    createdAt: toIso(row.created_at),
    updatedAt: toIso(row.updated_at),
  };
}
