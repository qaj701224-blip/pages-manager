const DEFAULT_REVIEW_AGENT_LOGINS = [
  'greptile[bot]',
  'greptile-bot',
  'copilot-pull-request-reviewer[bot]',
  'chatgpt-codex-connector',
  'chatgpt-codex-connector[bot]',
];

function listFromCsv(value = '') {
  return String(value)
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseAllowlistJson(value) {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry) => entry && entry.enabled !== false)
      .flatMap((entry) => [...(entry.botLogins || []), entry.githubAppSlug].filter(Boolean));
  } catch {
    return [];
  }
}

export function reviewAgentLogins(env = {}) {
  const configured = [
    ...listFromCsv(env.GITHUB_REVIEW_AGENT_LOGINS),
    ...parseAllowlistJson(env.GITHUB_REVIEW_AGENT_ALLOWLIST),
  ];
  return new Set((configured.length ? configured : DEFAULT_REVIEW_AGENT_LOGINS).map((login) => login.toLowerCase()));
}

function commentStatusForAction(action) {
  if (action === 'deleted') return 'deleted';
  if (action === 'dismissed') return 'dismissed';
  if (action === 'resolved') return 'resolved';
  if (action === 'outdated') return 'outdated';
  return 'open';
}

function reviewedCommitShaFromBody(body = '') {
  const match = String(body).match(/reviewed commit:\**\s*`?([a-f0-9]{7,40})`?/i);
  return match ? match[1] : null;
}

export function classifyReviewAgentComment(input) {
  const body = String(input.body || '');
  const state = String(input.reviewState || '').toLowerCase();

  if (state === 'changes_requested') return 'blocking';
  if (state === 'approved') return 'note';
  if (/\b(blocking|must fix|required|failing|failed|failure|security|critical|error)\b/i.test(body)) return 'blocking';
  if (/(必须|阻塞|失败|需要修复|安全风险|严重)/.test(body)) return 'blocking';
  if (/\b(suggestions?|nit|optional|consider)\b/i.test(body) || /(建议|可以考虑|优化建议)/.test(body)) {
    return 'suggestion';
  }
  if (
    /\b(approved|lgtm|looks good|no (major )?issues|did(?: not|n't) find (any )?(major )?issues|passed)\b/i.test(
      body
    ) ||
    /(通过|没问题|无阻塞)/.test(body)
  ) {
    return 'note';
  }
  if (!body.trim()) return 'note';
  return 'unknown';
}

function normalizePullRequestReview(body, deliveryId, repoFullName) {
  const review = body.review || {};
  const pullRequest = body.pull_request || {};
  if (!review.id && !review.node_id) return null;

  return {
    repoFullName,
    prNumber: pullRequest.number,
    githubReviewId: review.id ? String(review.id) : null,
    githubCommentId: null,
    githubCommentNodeId: review.node_id || `review:${review.id}`,
    sourceType: 'review_summary',
    reviewAgentLogin: review.user?.login || body.sender?.login || '',
    reviewState: review.state || '',
    body: review.body || '',
    path: null,
    line: null,
    diffHunk: null,
    status: commentStatusForAction(body.action),
    firstSeenDeliveryId: deliveryId,
    lastSeenDeliveryId: deliveryId,
    headSha: pullRequest.head?.sha || null,
  };
}

function normalizePullRequestReviewComment(body, deliveryId, repoFullName) {
  const comment = body.comment || {};
  const pullRequest = body.pull_request || {};
  if (!comment.id && !comment.node_id) return null;

  return {
    repoFullName,
    prNumber: pullRequest.number,
    githubReviewId: comment.pull_request_review_id ? String(comment.pull_request_review_id) : null,
    githubCommentId: comment.id ? String(comment.id) : null,
    githubCommentNodeId: comment.node_id || `review-comment:${comment.id}`,
    sourceType: 'inline_comment',
    reviewAgentLogin: comment.user?.login || body.sender?.login || '',
    reviewState: '',
    body: comment.body || '',
    path: comment.path || null,
    line: comment.line || comment.original_line || null,
    diffHunk: comment.diff_hunk || null,
    status: commentStatusForAction(body.action),
    firstSeenDeliveryId: deliveryId,
    lastSeenDeliveryId: deliveryId,
    headSha: pullRequest.head?.sha || null,
  };
}

function normalizeIssueComment(body, deliveryId, repoFullName) {
  const issue = body.issue || {};
  const comment = body.comment || {};
  if (!issue.pull_request || (!comment.id && !comment.node_id)) return null;
  const commentBody = comment.body || '';

  return {
    repoFullName,
    prNumber: issue.number,
    githubReviewId: null,
    githubCommentId: comment.id ? String(comment.id) : null,
    githubCommentNodeId: comment.node_id || `issue-comment:${comment.id}`,
    sourceType: 'issue_comment',
    reviewAgentLogin: comment.user?.login || body.sender?.login || '',
    reviewState: '',
    body: commentBody,
    path: null,
    line: null,
    diffHunk: null,
    status: commentStatusForAction(body.action),
    firstSeenDeliveryId: deliveryId,
    lastSeenDeliveryId: deliveryId,
    headSha: reviewedCommitShaFromBody(commentBody),
  };
}

function normalizeCheckRun(body, deliveryId, repoFullName) {
  const checkRun = body.check_run || {};
  const pullRequest = checkRun.pull_requests?.[0];
  if (!pullRequest || (!checkRun.id && !checkRun.node_id)) return null;

  const output = checkRun.output || {};
  return {
    repoFullName,
    prNumber: pullRequest.number,
    githubReviewId: null,
    githubCommentId: checkRun.id ? String(checkRun.id) : null,
    githubCommentNodeId: checkRun.node_id || `check-run:${checkRun.id}`,
    sourceType: 'check_run',
    reviewAgentLogin: checkRun.app?.slug || checkRun.app?.name || body.sender?.login || '',
    reviewState: checkRun.conclusion === 'failure' ? 'changes_requested' : '',
    body: [output.title, output.summary, output.text].filter(Boolean).join('\n\n'),
    path: null,
    line: null,
    diffHunk: null,
    status: commentStatusForAction(body.action),
    firstSeenDeliveryId: deliveryId,
    lastSeenDeliveryId: deliveryId,
    headSha: checkRun.head_sha || null,
  };
}

export function normalizeReviewAgentWebhook(body, eventName, deliveryId, repoFullName) {
  const normalized =
    eventName === 'pull_request_review'
      ? normalizePullRequestReview(body, deliveryId, repoFullName)
      : eventName === 'pull_request_review_comment'
        ? normalizePullRequestReviewComment(body, deliveryId, repoFullName)
        : eventName === 'issue_comment'
          ? normalizeIssueComment(body, deliveryId, repoFullName)
          : eventName === 'check_run'
            ? normalizeCheckRun(body, deliveryId, repoFullName)
            : null;

  if (!normalized?.prNumber || !normalized.githubCommentNodeId) return null;
  return {
    ...normalized,
    classification: classifyReviewAgentComment(normalized),
  };
}

export function isAllowedReviewAgent(comment, env = {}) {
  if (!comment?.reviewAgentLogin) return false;
  return reviewAgentLogins(env).has(comment.reviewAgentLogin.toLowerCase());
}
