const DEFAULT_REVIEW_AGENT_LOGINS = [
  'greptile[bot]',
  'greptile-bot',
  'copilot-pull-request-reviewer[bot]',
  'chatgpt-codex-connector',
  'chatgpt-codex-connector[bot]',
];

const NOTE_PATTERNS = [
  /\bno blockers?\b/i,
  /\bno blocking issues?\b/i,
  /\bnot blocking\b/i,
  /\bwithout blocking\b/i,
  /\bapproved\b/i,
  /\blgtm\b/i,
  /\blooks good\b/i,
  /\bno (major )?issues\b/i,
  /\bdid(?: not|n't) find (any )?(major )?issues\b/i,
  /\bpassed\b/i,
];

const DEFAULT_SITE_CHECK_NAMES = ['site-check', 'Site Check / site-check'];
const DEFAULT_PLATFORM_CI_CHECK_NAMES = ['Platform CI'];
const DEFAULT_SITE_CHECK_APP_LOGINS = ['github-actions', 'github-actions[bot]', 'GitHub Actions'];
const DEFAULT_PLATFORM_CI_APP_LOGINS = ['github-actions', 'github-actions[bot]', 'GitHub Actions'];

function listFromDelimited(value = '') {
  return String(value)
    .split(/[,\s]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function listFromCsv(value = '') {
  return String(value)
    .split(',')
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
    ...listFromDelimited(env.GITHUB_REVIEW_AGENT_LOGINS),
    ...parseAllowlistJson(env.GITHUB_REVIEW_AGENT_ALLOWLIST),
  ];
  return new Set((configured.length ? configured : DEFAULT_REVIEW_AGENT_LOGINS).map((login) => login.toLowerCase()));
}

function configuredSet(value, fallback, parser = listFromDelimited) {
  const configured = parser(value);
  return new Set((configured.length ? configured : fallback).map((item) => item.toLowerCase()));
}

export function siteCheckNames(env = {}) {
  return configuredSet(env.GITHUB_SITE_CHECK_NAMES, DEFAULT_SITE_CHECK_NAMES, listFromCsv);
}

export function platformCiCheckNames(env = {}) {
  return configuredSet(env.GITHUB_PLATFORM_CI_CHECK_NAMES, DEFAULT_PLATFORM_CI_CHECK_NAMES, listFromCsv);
}

export function siteCheckAppLogins(env = {}) {
  return configuredSet(env.GITHUB_SITE_CHECK_APP_LOGINS, DEFAULT_SITE_CHECK_APP_LOGINS);
}

export function platformCiAppLogins(env = {}) {
  return configuredSet(env.GITHUB_PLATFORM_CI_APP_LOGINS, DEFAULT_PLATFORM_CI_APP_LOGINS);
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

function reviewPriorityFromBody(body = '') {
  const match = String(body).match(/\bP([0-3])\s+Badge\b/i) || String(body).match(/badge\/P([0-3])-/i);
  return match ? Number(match[1]) : null;
}

export function classifyReviewAgentComment(input) {
  const body = String(input.body || '');
  const state = String(input.reviewState || '').toLowerCase();
  const priority = reviewPriorityFromBody(body);

  if (state === 'changes_requested') return 'blocking';
  if (state === 'approved') return 'note';
  if (priority === 0 || priority === 1) return 'blocking';
  if (priority === 2 || priority === 3) return 'suggestion';
  if (NOTE_PATTERNS.some((pattern) => pattern.test(body)) || /(通过|没问题|无阻塞)/.test(body)) {
    return 'note';
  }
  if (/\b(blocking|must fix|required|failing|failed|failure|security|critical|error)\b/i.test(body)) return 'blocking';
  if (/(必须|阻塞|失败|需要修复|安全风险|严重)/.test(body)) return 'blocking';
  if (/\b(suggestions?|nit|optional|consider)\b/i.test(body) || /(建议|可以考虑|优化建议)/.test(body)) {
    return 'suggestion';
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

export function normalizeSiteCheckRunWebhook(body, eventName, deliveryId, repoFullName) {
  if (eventName !== 'check_run') return null;
  const checkRun = body.check_run || {};
  const pullRequest = checkRun.pull_requests?.[0];
  if (!pullRequest || (!checkRun.id && !checkRun.node_id)) return null;

  return {
    repoFullName,
    prNumber: pullRequest.number,
    checkRunId: checkRun.id ? String(checkRun.id) : null,
    checkRunNodeId: checkRun.node_id || `site-check:${checkRun.id}`,
    checkName: checkRun.name || '',
    appSlug: checkRun.app?.slug || null,
    appName: checkRun.app?.name || null,
    status: checkRun.status || null,
    conclusion: checkRun.conclusion || null,
    headSha: checkRun.head_sha || null,
    detailsUrl: checkRun.details_url || checkRun.html_url || null,
    htmlUrl: checkRun.html_url || null,
    outputSummary: [checkRun.output?.title, checkRun.output?.summary, checkRun.output?.text].filter(Boolean).join('\n\n'),
    action: body.action || null,
    firstSeenDeliveryId: deliveryId,
    lastSeenDeliveryId: deliveryId,
    completedAt: checkRun.completed_at || null,
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

export function isAllowedSiteCheckRun(checkRun, env = {}) {
  if (!checkRun?.checkName) return false;

  const names = siteCheckNames(env);
  const apps = siteCheckAppLogins(env);
  const appCandidates = [checkRun.appSlug, checkRun.appName].filter(Boolean).map((value) => value.toLowerCase());

  return names.has(String(checkRun.checkName).toLowerCase()) && appCandidates.some((candidate) => apps.has(candidate));
}

export function isAllowedPlatformCiRun(checkRun, env = {}) {
  if (!checkRun?.checkName) return false;

  const names = platformCiCheckNames(env);
  const apps = platformCiAppLogins(env);
  const appCandidates = [checkRun.appSlug, checkRun.appName].filter(Boolean).map((value) => value.toLowerCase());

  return names.has(String(checkRun.checkName).toLowerCase()) && appCandidates.some((candidate) => apps.has(candidate));
}
