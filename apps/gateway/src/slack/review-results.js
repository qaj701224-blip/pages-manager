import { classifyReviewAgentComment } from '../github/review.js';
import { previewGateForPr } from '../github/review-gate.js';
import { redactSecretLikeText } from './text.js';
import {
  findVisibleSlackJobByReference,
  findVisibleSlackJobByIssueNumber,
  findVisibleSlackJobByPrNumber,
  slackButtonValue,
  slackJobVisibleToActor,
} from './work-items.js';

const CLASSIFICATION_ORDER = {
  blocking: 0,
  unknown: 1,
  suggestion: 2,
  note: 3,
};
const SOURCE_TYPE_ORDER = {
  inline_comment: 0,
  review_summary: 1,
  issue_comment: 2,
  check_run: 3,
};

function workItemKind(item = {}) {
  return item.workItemKind || (item.githubIssueNumber !== undefined ? 'platform_dev' : 'site_publishing');
}

function prNumberForItem(item = {}) {
  return item.prNumber || item.githubPrNumber || null;
}

function prUrlForItem(item = {}) {
  return item.prUrl || item.githubPrUrl || null;
}

function issueNumberForItem(item = {}) {
  return item.issueNumber || item.githubIssueNumber || null;
}

function repoFullNameForItem(item = {}, env = {}) {
  if (env.GITHUB_REPO) return env.GITHUB_REPO;
  if (env.GITHUB_REPOSITORY) return env.GITHUB_REPOSITORY;
  for (const value of [prUrlForItem(item), item.issueUrl, item.githubIssueUrl]) {
    if (!value) continue;
    try {
      const url = new URL(value);
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length >= 2) return `${parts[0]}/${parts[1]}`;
    } catch {
      // Ignore malformed stored URLs.
    }
  }
  return null;
}

function positiveNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizedTargetKind(value = '') {
  const kind = String(value || '').trim().toLowerCase();
  if (['pr', 'pull_request', 'pull-request', 'pullrequest'].includes(kind)) return 'pr';
  if (['issue', 'issues', 'github_issue'].includes(kind)) return 'issue';
  if (kind === 'current') return 'current';
  return 'unknown';
}

function targetReferenceFromArgs(args = {}) {
  const kind = normalizedTargetKind(args.kind || args.type || args.targetKind || args.target_kind || 'current');
  const number =
    positiveNumber(args.number || args.targetNumber || args.target_number) ||
    positiveNumber(args.prNumber || args.pr_number || args.pullRequestNumber || args.pull_request_number) ||
    positiveNumber(args.issueNumber || args.issue_number);
  return number ? { kind, number } : null;
}

function targetReferenceFromWorkItemLike(item = null) {
  if (!item || typeof item !== 'object') return null;
  const kind = normalizedTargetKind(item.kind || item.targetKind || item.type || '');
  const prNumber = positiveNumber(item.prNumber || item.githubPrNumber || (kind === 'pr' ? item.number : null));
  if (prNumber) return { kind: 'pr', number: prNumber };
  const issueNumber = positiveNumber(item.issueNumber || item.githubIssueNumber || (kind === 'issue' ? item.number : null));
  if (issueNumber) return { kind: 'issue', number: issueNumber };
  const number = positiveNumber(item.number || item.targetNumber);
  return number ? { kind: kind === 'current' ? 'unknown' : kind, number } : null;
}

function targetReferenceFromConversationContext(sessionMemory = {}) {
  const conversationContext = sessionMemory?.conversationContext || {};
  const focusReference = targetReferenceFromWorkItemLike(conversationContext.currentFocus || conversationContext.focus);
  if (focusReference) return focusReference;

  for (const list of [conversationContext.lastWorkItemList, sessionMemory?.lastWorkItemList]) {
    const shown = Array.isArray(list?.shown) ? list.shown : [];
    if (shown.length !== 1) continue;
    const reference = targetReferenceFromWorkItemLike(shown[0]);
    if (reference) return reference;
  }

  return null;
}

async function resolveVisibleReference(store, body, reference = null, targetKind = null) {
  if (!reference?.number) return null;
  const item = await findVisibleSlackJobByReference(store, body, reference);
  if (!item) return null;
  return {
    item,
    targetKind: targetKind || reference.kind || 'unknown',
    targetNumber: reference.number,
  };
}

async function resolveCurrentSlackSessionTarget(store, body, slackSession) {
  let item = null;
  if (slackSession?.activeWorkItemKind === 'platform_dev' && slackSession.activeWorkItemId && store.getPlatformDevItem) {
    const platformItem = await store.getPlatformDevItem(slackSession.activeWorkItemId);
    if (platformItem && !slackJobVisibleToActor(platformItem, body)) {
      return { forbidden: true, targetKind: 'current', targetNumber: null };
    }
    if (platformItem) {
      return {
        item: {
          ...platformItem,
          workItemKind: 'platform_dev',
          issueNumber: platformItem.githubIssueNumber,
          issueUrl: platformItem.githubIssueUrl,
          prNumber: platformItem.githubPrNumber,
          prUrl: platformItem.githubPrUrl,
        },
        targetKind: 'current',
      };
    }
  }
  if (slackSession?.activeJobId && store.getJob) {
    const job = await store.getJob(slackSession.activeJobId);
    if (job && !slackJobVisibleToActor(job, body)) {
      return { forbidden: true, targetKind: 'current', targetNumber: null };
    }
    if (job) return { item: job, targetKind: 'current' };
  }
  if (slackSession?.activePrNumber) {
    item = await findVisibleSlackJobByPrNumber(store, body, slackSession.activePrNumber);
    if (item) return { item, targetKind: 'current', targetNumber: slackSession.activePrNumber };
  }
  if (slackSession?.activeIssueNumber) {
    item = await findVisibleSlackJobByIssueNumber(store, body, slackSession.activeIssueNumber);
    if (item) return { item, targetKind: 'current', targetNumber: slackSession.activeIssueNumber };
  }
  return null;
}

export async function resolveReviewResultsTarget(store, body, slackSession, args = {}, context = {}) {
  const argsReference = targetReferenceFromArgs(args);
  if (args.explicitUserTarget && argsReference) {
    const result = await resolveVisibleReference(store, body, argsReference, argsReference.kind);
    return result || { forbidden: true, targetKind: argsReference.kind, targetNumber: argsReference.number };
  }

  const currentResult = await resolveCurrentSlackSessionTarget(store, body, slackSession);
  if (currentResult) return currentResult;

  const contextReference = targetReferenceFromConversationContext(context.sessionMemory);
  const contextResult = await resolveVisibleReference(store, body, contextReference, contextReference?.kind);
  if (contextResult) return contextResult;

  if (argsReference) {
    const result = await resolveVisibleReference(store, body, argsReference, argsReference.kind);
    return result || { forbidden: true, targetKind: argsReference.kind, targetNumber: argsReference.number };
  }

  return { item: null, targetKind: 'current' };
}

function compactReviewBody(value = '', maxLength = 180) {
  const withoutCode = String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^>\s?.*$/gm, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const text = redactSecretLikeText(withoutCode);
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function enrichedComment(comment = {}) {
  const classification = comment.classification || classifyReviewAgentComment(comment);
  return {
    id: comment.id || comment.githubCommentNodeId || null,
    classification,
    sourceType: comment.sourceType || 'issue_comment',
    status: comment.status || 'open',
    path: comment.path || null,
    line: comment.line || null,
    bodySummary: compactReviewBody(comment.bodyRedacted || comment.body || ''),
    reviewAgentLogin: comment.reviewAgentLogin || null,
    updatedAt: comment.updatedAt || comment.createdAt || null,
    githubCommentNodeId: comment.githubCommentNodeId || null,
  };
}

function commentSortKey(comment = {}) {
  return [
    CLASSIFICATION_ORDER[comment.classification] ?? 9,
    SOURCE_TYPE_ORDER[comment.sourceType] ?? 9,
    comment.path ? 0 : 1,
    comment.line ? 0 : 1,
    -(new Date(comment.updatedAt || 0).getTime() || 0),
  ];
}

function compareComments(left, right) {
  const leftKey = commentSortKey(left);
  const rightKey = commentSortKey(right);
  for (let index = 0; index < leftKey.length; index += 1) {
    if (leftKey[index] < rightKey[index]) return -1;
    if (leftKey[index] > rightKey[index]) return 1;
  }
  return 0;
}

function conclusionFor({ gate, comments }) {
  const openCount = comments.length;
  if (!gate?.siteCheck?.passed && gate?.siteCheck?.status === 'completed') return 'waiting_site_check';
  if (!openCount) return 'waiting_review';
  if (comments.some((comment) => comment.classification === 'blocking') || gate?.blockingCount > 0) return 'blocked';
  if (comments.some((comment) => comment.classification === 'unknown') || gate?.unknownCount > 0) return 'unknown';
  if (!gate?.siteCheck?.passed) return 'waiting_site_check';
  return 'passed';
}

function countByClassification(comments = [], classification) {
  return comments.filter((comment) => comment.classification === classification).length;
}

export async function buildReviewResultsSummary(store, env, item = {}, options = {}) {
  const prNumber = prNumberForItem(item);
  const repoFullName = repoFullNameForItem(item, env);
  if (!prNumber) return { found: false, reason: 'missing_pr', item };
  if (!repoFullName) return { found: false, reason: 'missing_repo', item, prNumber };

  const headSha = item.headSha || null;
  const gateOptions = headSha ? { headSha } : {};
  const gate = store.previewGateForPr
    ? await store.previewGateForPr(repoFullName, prNumber, gateOptions)
    : await previewGateForPr(store, repoFullName, prNumber, gateOptions);
  const commentsRaw = store.listReviewAgentComments
    ? await store.listReviewAgentComments(repoFullName, prNumber, gateOptions)
    : [];
  const includeResolved = Boolean(options.includeResolved);
  const comments = commentsRaw
    .map(enrichedComment)
    .filter((comment) => includeResolved || comment.status === 'open')
    .sort(compareComments);
  const maxItems = Math.min(Math.max(Number(options.maxItems) || 5, 1), 10);
  const shown = comments.slice(0, maxItems);
  const conclusion = conclusionFor({ gate, comments });

  return {
    found: true,
    workItemKind: workItemKind(item),
    workItemId: item.id || null,
    issueNumber: issueNumberForItem(item),
    repoFullName,
    prNumber,
    prUrl: prUrlForItem(item),
    headSha,
    conclusion,
    hasReviewAgentResult: comments.length > 0,
    gate: {
      blockingCount: gate?.blockingCount || 0,
      unknownCount: gate?.unknownCount || 0,
      suggestionCount: gate?.suggestionCount || 0,
      noteCount: gate?.noteCount || 0,
      siteCheckPassed: Boolean(gate?.siteCheck?.passed),
      siteCheckStatus: gate?.siteCheck?.status || 'missing',
      siteCheckConclusion: gate?.siteCheck?.conclusion || null,
      siteCheckDetailsUrl: gate?.siteCheck?.detailsUrl || null,
    },
    comments: shown,
    counts: {
      totalOpen: comments.length,
      blocking: countByClassification(comments, 'blocking'),
      unknown: countByClassification(comments, 'unknown'),
      suggestion: countByClassification(comments, 'suggestion'),
      note: countByClassification(comments, 'note'),
    },
    omitted: {
      total: Math.max(0, comments.length - shown.length),
      blocking: Math.max(0, countByClassification(comments, 'blocking') - countByClassification(shown, 'blocking')),
      unknown: Math.max(0, countByClassification(comments, 'unknown') - countByClassification(shown, 'unknown')),
      suggestion: Math.max(0, countByClassification(comments, 'suggestion') - countByClassification(shown, 'suggestion')),
      note: Math.max(0, countByClassification(comments, 'note') - countByClassification(shown, 'note')),
    },
  };
}

function locationForComment(comment = {}) {
  if (comment.path && comment.line) return `${comment.path}:${comment.line}`;
  if (comment.path) return comment.path;
  return 'PR 级别';
}

function conclusionLine(summary = {}) {
  const counts = summary.counts || {};
  if (summary.conclusion === 'blocked') {
    return `Review 目前有 ${counts.blocking || summary.gate?.blockingCount || 0} 条需要先处理的问题，PR 还不能继续放行。`;
  }
  if (summary.conclusion === 'unknown') {
    return 'Review 结果里有无法判断是否阻塞的内容，需要人工确认。';
  }
  if (summary.conclusion === 'waiting_site_check') {
    return 'Review Agent 没有发现阻塞问题，但 site-check 还没通过。';
  }
  if (summary.conclusion === 'passed') {
    return 'Review Agent 没有发现阻塞问题。';
  }
  return '我还没有看到这个 PR 的 Review Agent 结果。';
}

export function formatSlackReviewResultsText(summary = {}) {
  if (!summary.found) {
    if (summary.reason === 'missing_pr') return '当前会话还没有关联 PR，所以还没有可查看的 Review 结果。';
    return '当前任务还没有足够的 PR 信息，暂时不能查看 Review 结果。';
  }
  const lines = [conclusionLine(summary)];
  if (summary.prNumber) {
    lines.push(`PR：${summary.prUrl ? `<${summary.prUrl}|#${summary.prNumber}>` : `#${summary.prNumber}`}`);
  }
  if (summary.conclusion !== 'waiting_review') {
    const counts = summary.counts || {};
    lines.push(
      `Review 结果：${counts.blocking} 个 blocker，${counts.unknown} 个待确认，${counts.suggestion} 条建议，${counts.note} 条说明。`
    );
  }
  if (summary.comments?.length) {
    lines.push('');
    summary.comments.forEach((comment, index) => {
      lines.push(`${index + 1}. ${locationForComment(comment)}`);
      lines.push(`   ${comment.bodySummary || 'Review Agent 没有提供可展示的摘要。'}`);
    });
  }
  if (summary.omitted?.total > 0) {
    lines.push('');
    lines.push(`另外还有 ${summary.omitted.total} 条 Review 记录未展开，完整讨论可以打开 PR。`);
  }
  if (summary.conclusion === 'waiting_site_check') {
    lines.push('下一步：等待 site-check 完成；如果它失败，我会把失败阶段更新到当前对话。');
  } else if (summary.conclusion === 'waiting_review') {
    lines.push('下一步：继续等待 Review Agent 或 site-check 回写。');
  } else if (summary.conclusion === 'blocked' || summary.conclusion === 'unknown') {
    lines.push('下一步：可以继续在当前 thread 里说明要怎么修，我会沿用这个 PR。');
  } else if (summary.conclusion === 'passed') {
    lines.push('下一步：如果后续流程还有阻塞，我会继续在当前对话更新。');
  }
  return redactSecretLikeText(lines.filter(Boolean).join('\n'));
}

export function buildSlackReviewResultsBlocks(slackSession, summary = {}) {
  const text = formatSlackReviewResultsText(summary);
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Review 结果' } },
    { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } },
  ];
  const actions = [];
  if (summary.prUrl) {
    actions.push({
      type: 'button',
      text: { type: 'plain_text', text: '查看 PR' },
      url: summary.prUrl,
      action_id: 'open_pr',
    });
  }
  if (summary.gate?.siteCheckDetailsUrl) {
    actions.push({
      type: 'button',
      text: { type: 'plain_text', text: '查看 Workflow' },
      url: summary.gate.siteCheckDetailsUrl,
      action_id: 'open_workflow',
    });
  }
  if (slackSession?.id && summary.workItemId) {
    actions.push({
      type: 'button',
      text: { type: 'plain_text', text: '转人工排查' },
      action_id: 'pages_request_human_triage',
      value: slackButtonValue({
        sessionId: slackSession.id,
        workItemKind: summary.workItemKind,
        workItemId: summary.workItemId,
      }),
    });
  }
  if (actions.length) blocks.push({ type: 'actions', elements: actions.slice(0, 5) });
  return blocks;
}

export function reviewResultsMemory(summary = {}) {
  return {
    prNumber: summary.prNumber || null,
    headSha: summary.headSha || null,
    conclusion: summary.conclusion || 'unknown',
    blockingCount: summary.counts?.blocking || 0,
    unknownCount: summary.counts?.unknown || 0,
    suggestionCount: summary.counts?.suggestion || 0,
    noteCount: summary.counts?.note || 0,
    lastSummary: formatSlackReviewResultsText(summary).slice(0, 2000),
    updatedAt: new Date().toISOString(),
  };
}
