import {
  platformIssueTypeLabel,
  platformRiskLabel,
  userFacingPlatformSummary,
  userFacingPlatformTitle,
} from './issue-confirmation.js';
import { compactUserFacingText, redactSecretLikeText } from './text.js';
import { slackStatusLabel, slackButtonValue } from './work-items.js';
import {
  orderSlackActionsByAgentIntent,
  slackActionElement,
  slackAgentActionLabel,
  slackAgentCardFields,
  slackAgentCardSummary,
  slackAgentCardTitle,
} from './agent-card.js';

const PLATFORM_RETRYABLE_STATUSES = new Set([
  'issue_created',
  'pr_created',
  'ci_failed',
  'review_waiting',
  'review_blocked',
  'ready_to_merge',
  'agent_queued',
]);
const SITE_RETRYABLE_STATUSES = new Set([
  'issue_created',
  'indexing',
  'pr_created',
  'reviewing',
  'changes_requested',
  'preview_deployed',
]);

const STAGE_DETAILS = {
  received: ['任务已接收。', '等待进入后台处理。'],
  summarizing: ['正在整理需求。', '如果长时间停留，可能是需求整理未完成。'],
  issue_creating: ['正在创建 Issue。', '如果失败，通常和 GitHub 权限、仓库配置或输入校验有关。'],
  issue_created: ['Issue 已创建。', '下一步应该进入自动处理或等待确认。'],
  indexing: ['正在固定项目索引。', '如果卡住，可以检查索引 workflow 是否完成。'],
  generating_page: ['正在生成页面改动。', '如果卡住，可以检查页面生成 workflow。'],
  patch_generated: ['页面改动已生成。', '下一步应该提交分支并创建 PR。'],
  branch_committed: ['分支已提交。', '下一步应该创建 PR。'],
  pr_created: ['PR 已创建。', '下一步应该进入 CI、Review 或 Preview。'],
  reviewing: ['正在等待 Review。', 'Review 通过后会继续生成 Preview。'],
  changes_requested: ['Review 要求修改。', '下一步应该进入修复流程。'],
  fixing: ['正在修复。', '修复完成后会重新进入 Review。'],
  previewing: ['正在生成 Preview。', '如果失败，通常和部署 API、站点检查或进度同步有关。'],
  preview_deployed: ['Preview 已生成。', '可以查看 Preview，或继续在当前 thread 里提修改意见。'],
  approved: ['已批准。', '等待后续合并或部署。'],
  merged: ['PR 已合并。', '任务主流程已完成。'],
  deployed: ['已部署。', '任务已完成。'],
  triaging: ['正在确认处理策略。', '下一步会决定是否创建 Issue 或等待人工确认。'],
  gate_pending: ['等待人工确认。', '高风险或敏感范围需要人工批准后才能自动开发。'],
  agent_queued: ['等待自动开发。', '后台处理已排队，下一步应开始自动开发。'],
  agent_running: ['自动开发中。', '如果长时间没有 PR，可以检查自动开发 workflow。'],
  ci_running: ['CI 正在验证。', '等待 GitHub Actions 结束。'],
  ci_failed: ['CI 未通过。', '需要查看失败 workflow，并决定重试或修复。'],
  review_waiting: ['等待 Review。', 'Review 完成后会更新任务状态。'],
  review_blocked: ['Review 要求修复。', '需要修复 blocking 评论后重新验证。'],
  ready_to_merge: ['已满足合并条件。', '合并仍需要人工按仓库规则处理。'],
  closed_unmerged: ['任务已关闭。', '如需继续，需要明确恢复任务。'],
  failed: ['任务失败。', '建议查看失败原因，并选择追加诊断或转人工排查。'],
  cancelled: ['任务已取消。', '如需继续，需要重新打开或创建新任务。'],
};

const PLATFORM_LINK_FIELDS = {
  issueNumber: 'githubIssueNumber',
  issueUrl: 'githubIssueUrl',
  prNumber: 'githubPrNumber',
  prUrl: 'githubPrUrl',
};

function workItemKind(item = {}) {
  return item.workItemKind || (item.githubIssueNumber !== undefined ? 'platform_dev' : 'site_publishing');
}

function issueNumber(item = {}) {
  return item.issueNumber || item[PLATFORM_LINK_FIELDS.issueNumber] || null;
}

function issueUrl(item = {}) {
  return item.issueUrl || item[PLATFORM_LINK_FIELDS.issueUrl] || null;
}

function prNumber(item = {}) {
  return item.prNumber || item[PLATFORM_LINK_FIELDS.prNumber] || null;
}

function prUrl(item = {}) {
  return item.prUrl || item[PLATFORM_LINK_FIELDS.prUrl] || null;
}

function titleForWorkItem(item = {}) {
  if (workItemKind(item) === 'platform_dev') {
    return userFacingPlatformTitle({ title: item.title, summary: item.summary });
  }
  return compactUserFacingText(item.title || item.siteSlug || '发布任务');
}

function stageDetails(item = {}) {
  return STAGE_DETAILS[item.status] || ['任务正在处理中。', '可以查看关联链接或稍后重试诊断。'];
}

function latestStage(events = [], item = {}) {
  const last = events.at(-1);
  if (!last) return item.status;
  return last.status || item.status;
}

function latestEventText(events = []) {
  const last = events.at(-1);
  if (!last) return null;
  return redactSecretLikeText(String(last.message || last.errorMessage || last.status || '').trim()).slice(0, 180);
}

function reasonForWorkItem(item = {}, events = []) {
  if (item.errorMessage || item.errorCode) {
    const fallback = '处理失败，请查看 Issue 记录或转人工排查。';
    if (workItemKind(item) === 'platform_dev') {
      return userFacingPlatformSummary({ summary: item.errorMessage }, fallback).slice(0, 240);
    }
    return redactSecretLikeText(item.errorMessage || item.errorCode).slice(0, 240);
  }
  const [, hint] = stageDetails(item);
  const eventText = latestEventText(events);
  if (item.status === 'issue_created' && !prNumber(item)) return 'Issue 已创建，但还没有看到 PR。可以检查自动处理是否已启动。';
  if (item.status === 'agent_running' && !prNumber(item)) return '自动开发已开始，但还没有看到 PR。可以检查对应 workflow 是否仍在运行。';
  if (item.status === 'branch_committed' && !prNumber(item)) return '分支已提交，但还没有看到 PR。可以检查 PR 创建步骤。';
  if (item.status === 'pr_created' && !item.previewUrl && workItemKind(item) !== 'platform_dev') {
    return 'PR 已创建，但 Preview 还没有生成。可以检查 Review、site-check 或 Preview workflow。';
  }
  if (item.status === 'ci_failed') return 'CI 未通过。建议打开 Workflow 查看失败 job，或把诊断追加到 Issue。';
  if (item.status === 'review_blocked') return 'Review 还有 blocking 意见。建议修复后重新验证。';
  if (eventText && !/^PublishingJob moved|PlatformDevItem moved/.test(eventText)) return eventText;
  return hint;
}

function nextActionForWorkItem(item = {}) {
  if (item.status === 'gate_pending') return '请先确认是否批准自动开发。';
  if (item.status === 'ci_failed') return '可以查看 Workflow，或把诊断追加到 Issue 后安排修复。';
  if (item.status === 'review_blocked' || item.status === 'changes_requested') return '可以继续在当前 thread 里描述修复要求。';
  if (item.status === 'failed') return '可以把诊断追加到 Issue，或转人工排查。';
  if (item.status === 'cancelled' || item.status === 'closed_unmerged') return '如果还要继续，需要先恢复任务。';
  if (item.status === 'preview_deployed') return '可以打开 Preview 检查，或继续提出修改意见。';
  if (item.status === 'ready_to_merge') return '可以查看 PR，按仓库规则人工合并。';
  return '如果长时间没有变化，可以稍后再查，或把诊断追加到 Issue。';
}

function workflowLabel(item = {}) {
  if (workItemKind(item) === 'platform_dev') {
    if (
      ['agent_queued', 'agent_running', 'branch_committed', 'pr_created', 'ci_running', 'ci_failed'].includes(item.status)
    ) {
      return '平台自动开发 / CI';
    }
    return null;
  }
  if (['indexing'].includes(item.status)) return '项目索引';
  if (
    ['generating_page', 'patch_generated', 'branch_committed', 'pr_created', 'reviewing', 'changes_requested', 'fixing'].includes(
      item.status
    )
  ) {
    return '页面生成 / Review';
  }
  if (['previewing', 'preview_deployed'].includes(item.status)) return 'Preview';
  return null;
}

export function buildSlackWorkItemDiagnosis(item = {}, options = {}) {
  const events = options.events || [];
  const statusLabel = slackStatusLabel(item.status, item);
  const [stageSummary] = stageDetails(item);
  const lines = [
    `这个任务当前在「${statusLabel}」。`,
    `当前状态：${statusLabel}`,
  ];
  const issue = issueNumber(item);
  const pr = prNumber(item);
  const issueLink = issueUrl(item);
  const prLink = prUrl(item);
  if (issue) lines.push(`Issue：${issueLink ? `<${issueLink}|#${issue}>` : `#${issue}`}`);
  if (pr) lines.push(`PR：${prLink ? `<${prLink}|#${pr}>` : `#${pr}`}`);
  if (item.previewUrl) lines.push(`Preview：${item.previewUrl}`);
  const workflow = workflowLabel(item);
  if (workflow) lines.push(`Workflow：${workflow}`);
  lines.push(`最近阶段：${slackStatusLabel(latestStage(events, item), item)}`);
  lines.push(`阶段说明：${stageSummary}`);
  lines.push(`可能原因：${reasonForWorkItem(item, events)}`);
  lines.push('关联日志：当前只返回受控摘要；如需扩大范围，需要人工确认。');
  lines.push(`建议操作：${nextActionForWorkItem(item)}`);
  return lines.join('\n');
}

function githubMarkdownDiagnosisText(text = '') {
  return String(text || '').replace(/<([^>|]+)\|([^>]+)>/g, '[$2]($1)');
}

export function buildSlackWorkItemDiagnosisIssueComment(item = {}, options = {}) {
  return [
    '## Slack 任务诊断',
    '',
    githubMarkdownDiagnosisText(buildSlackWorkItemDiagnosis(item, options)),
    '',
    '---',
    '',
    '由 Slack 诊断入口追加。此评论只包含用户可见诊断摘要，不包含原始日志、secret 或内部调试信息。',
  ].join('\n');
}

export function buildSlackWorkItemHumanTriageIssueComment(item = {}, options = {}) {
  return [
    '## 请求人工排查',
    '',
    githubMarkdownDiagnosisText(buildSlackWorkItemDiagnosis(item, options)),
    '',
    '---',
    '',
    '由 Slack 诊断入口请求人工排查。此评论只包含用户可见诊断摘要，不包含原始日志、secret 或内部调试信息。',
  ].join('\n');
}

function canRetryWorkItem(item = {}) {
  if (workItemKind(item) !== 'platform_dev') return SITE_RETRYABLE_STATUSES.has(item.status);
  if (!item.agentEligible) return false;
  if (item.requiresHumanGate && item.gateStatus !== 'approved') return false;
  return PLATFORM_RETRYABLE_STATUSES.has(item.status);
}

export function buildSlackWorkItemDiagnosisBlocks(slackSession, item = {}, options = {}) {
  const kind = workItemKind(item);
  const analysis = options.slackAgentAnalysis || {};
  const text = buildSlackWorkItemDiagnosis(item, options);
  const fields = [
    { type: 'mrkdwn', text: `*当前状态*\n${slackStatusLabel(item.status, item)}` },
    { type: 'mrkdwn', text: `*最近阶段*\n${slackStatusLabel(latestStage(options.events || [], item), item)}` },
  ];
  if (kind === 'platform_dev') {
    fields.push({ type: 'mrkdwn', text: `*类型*\n${platformIssueTypeLabel(item.issueType)}` });
    fields.push({ type: 'mrkdwn', text: `*风险*\n${platformRiskLabel(item.risk)}` });
  } else if (item.siteSlug) {
    fields.push({ type: 'mrkdwn', text: `*站点*\n${compactUserFacingText(item.siteSlug).slice(0, 80)}` });
  }
  for (const field of slackAgentCardFields(analysis, 'diagnosis')) {
    fields.push({ type: 'mrkdwn', text: `*${field.label || '说明'}*\n${field.value}` });
  }
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: slackAgentCardTitle(analysis, 'diagnosis', '任务诊断') } },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${slackAgentCardSummary(analysis, 'diagnosis', titleForWorkItem(item)).slice(0, 180)}*`,
      },
    },
    { type: 'section', fields: fields.slice(0, 10) },
    { type: 'section', text: { type: 'mrkdwn', text: text.slice(0, 2900) } },
  ];
  const actions = [];
  if (issueUrl(item)) {
    actions.push({
      type: 'button',
      text: { type: 'plain_text', text: slackAgentActionLabel(analysis, 'diagnosis', 'open_issue', '查看 Issue') },
      url: issueUrl(item),
      action_id: 'open_issue',
      agent_action_id: 'open_issue',
    });
  }
  if (prUrl(item)) {
    actions.push({
      type: 'button',
      text: { type: 'plain_text', text: slackAgentActionLabel(analysis, 'diagnosis', 'open_pr', '查看 PR') },
      url: prUrl(item),
      action_id: 'open_pr',
      agent_action_id: 'open_pr',
    });
  }
  if (item.previewUrl) {
    actions.push({
      type: 'button',
      text: { type: 'plain_text', text: slackAgentActionLabel(analysis, 'diagnosis', 'open_preview', '查看 Preview') },
      url: item.previewUrl,
      action_id: 'open_preview',
      agent_action_id: 'open_preview',
    });
  }
  if (slackSession?.id && canRetryWorkItem(item)) {
    actions.push({
      type: 'button',
      text: { type: 'plain_text', text: slackAgentActionLabel(analysis, 'diagnosis', 'retry_work_item', '重试') },
      action_id: 'pages_request_retry_work_item',
      agent_action_id: 'retry_work_item',
      value: slackButtonValue({ sessionId: slackSession.id, workItemKind: kind, workItemId: item.id }),
    });
  }
  if (slackSession?.id && issueNumber(item)) {
    actions.push({
      type: 'button',
      text: {
        type: 'plain_text',
        text: slackAgentActionLabel(analysis, 'diagnosis', 'append_diagnosis_to_issue', '追加诊断到 Issue'),
      },
      action_id: 'pages_request_append_diagnosis',
      agent_action_id: 'append_diagnosis_to_issue',
      value: slackButtonValue({ sessionId: slackSession.id, workItemKind: kind, workItemId: item.id }),
    });
  }
  if (slackSession?.id) {
    actions.push({
      type: 'button',
      text: { type: 'plain_text', text: slackAgentActionLabel(analysis, 'diagnosis', 'human_triage', '转人工排查') },
      action_id: 'pages_request_human_triage',
      agent_action_id: 'human_triage',
      value: slackButtonValue({ sessionId: slackSession.id, workItemKind: kind, workItemId: item.id }),
    });
  }
  if (actions.length) {
    blocks.push({
      type: 'actions',
      elements: orderSlackActionsByAgentIntent(actions, analysis, 'diagnosis')
        .slice(0, 5)
        .map(slackActionElement),
    });
  }
  return blocks;
}
