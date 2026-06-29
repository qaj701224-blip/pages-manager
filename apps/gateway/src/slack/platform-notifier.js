import { postSlackMessage, updateSlackMessage } from './notifier.js';
import {
  platformIssueTypeLabel,
  platformRiskLabel,
  userFacingPlatformSummary,
  userFacingPlatformTitle,
} from './issue-confirmation.js';

const PLATFORM_STAGE_ORDER = [
  'received',
  'triaging',
  'issue_creating',
  'issue_created',
  'auto_dev_pending',
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

function stageRank(stage) {
  const index = PLATFORM_STAGE_ORDER.indexOf(stage);
  return index === -1 ? -1 : index;
}

function isStaleStageUpdate(existingStage, nextStage) {
  const existingRank = stageRank(existingStage);
  const nextRank = stageRank(nextStage);
  return existingRank >= 0 && nextRank >= 0 && existingRank > nextRank;
}

function targetForItem(item = {}) {
  const thread = item.slackThread || {};
  if (!thread.channelId) return null;
  return {
    channel: thread.channelId,
    thread_ts: thread.threadTs || undefined,
  };
}

function platformStageLabel(stage, item = {}) {
  const normalized = stage || item.status;
  const labels = {
    received: '整理需求',
    triaging: '确认处理策略',
    issue_creating: '创建 GitHub issue',
    issue_created: 'Issue 已创建',
    auto_dev_pending: 'Issue 已创建，待手动启动',
    agent_queued: '自动开发排队中',
    agent_running: '自动开发中',
    branch_committed: '已提交分支',
    pr_created: 'PR 已创建',
    ci_running: 'CI 验证中',
    ci_failed: 'CI 未通过',
    review_waiting: '等待 Review',
    review_blocked: '等待修复 Review 意见',
    ready_to_merge: '可合并',
    merged: '已合并',
    closed_unmerged: '已关闭',
    failed: '失败',
    cancelled: '已取消',
  };
  return labels[normalized] || normalized || '处理中';
}

function linkFields(item = {}) {
  const fields = [];
  if (item.githubIssueNumber || item.githubIssueUrl) {
    const issueLabel = item.githubIssueUrl
      ? `<${item.githubIssueUrl}|#${item.githubIssueNumber || 'issue'}>`
      : `#${item.githubIssueNumber}`;
    fields.push({
      type: 'mrkdwn',
      text: `*Issue*\n${issueLabel}`,
    });
  }
  if (item.githubPrNumber || item.githubPrUrl) {
    fields.push({
      type: 'mrkdwn',
      text: `*PR*\n${item.githubPrUrl ? `<${item.githubPrUrl}|#${item.githubPrNumber || 'PR'}>` : `#${item.githubPrNumber}`}`,
    });
  }
  if (item.errorMessage || item.errorCode) {
    const errorText = userFacingPlatformSummary({ summary: item.errorMessage }, item.errorCode || '处理失败，请查看 Issue 记录。');
    fields.push({
      type: 'mrkdwn',
      text: `*错误*\n${errorText.slice(0, 280)}`,
    });
  }
  return fields;
}

function contextText(item = {}, statusText = '') {
  if (item.status === 'auto_dev_pending') {
    return `${statusText || ':hourglass_flowing_sand: Issue 已创建，待手动启动'} · 默认不会自动开发；需要继续时点击「自动开发」。`;
  }
  if (item.status === 'merged') return `${statusText || ':white_check_mark: 已完成'} · PR 已合并。`;
  if (item.status === 'failed') return `${statusText || ':x: 失败'} · 可以打开 Issue 查看记录。`;
  if (item.status === 'closed_unmerged' || item.status === 'cancelled') {
    return `${statusText || ':white_check_mark: 已停止'} · 这个需求不会继续自动处理。`;
  }
  return `${statusText || ':hourglass_flowing_sand: 处理中'} · 后续进度会继续在当前对话更新。`;
}

export function platformNotificationText(stage, item = {}) {
  if (stage === 'issue_created') {
    if (item.githubIssueUrl) return `已创建 GitHub issue：#${item.githubIssueNumber}\n${item.githubIssueUrl}`;
    if (item.githubIssueNumber) return `已创建 GitHub issue：#${item.githubIssueNumber}`;
    return '已创建 GitHub issue。';
  }
  if (stage === 'auto_dev_pending') return '已创建 GitHub issue，等待手动启动自动开发。';
  if (stage === 'agent_running') return '自动开发已开始。';
  if (stage === 'pr_created') {
    if (item.githubPrUrl) return `已创建 PR：#${item.githubPrNumber}\n${item.githubPrUrl}`;
    if (item.githubPrNumber) return `已创建 PR：#${item.githubPrNumber}`;
    return '已创建 PR。';
  }
  if (stage === 'ci_running') return 'CI 正在验证。';
  if (stage === 'ci_failed') return 'CI 未通过，等待修复。';
  if (stage === 'review_blocked') return 'Review 提出需要修复的问题。';
  if (stage === 'ready_to_merge') return 'CI 和 Review 已满足合并条件。';
  if (stage === 'merged') return 'PR 已合并。';
  if (stage === 'closed_unmerged') return 'PR 或 Issue 已关闭，需求已停止。';
  return null;
}

function buildPlatformStatusBlocks(item = {}, options = {}) {
  const stage = options.stage || item.status;
  const label = platformStageLabel(stage, item);
  const statusText = options.statusText || options.text || ':hourglass_flowing_sand: 处理中';
  const title = userFacingPlatformTitle({
    title: options.cardTitle || item.title,
    summary: item.summary || item.title || label,
  });
  const summary = userFacingPlatformSummary({ summary: options.finalSummary || item.summary }, item.title || '暂无摘要');
  const currentChange = String(options.currentChange || '').trim();
  const fields = [
    { type: 'mrkdwn', text: `*当前阶段*\n${label}` },
    ...linkFields(item),
    { type: 'mrkdwn', text: `*类型*\n${platformIssueTypeLabel(item.issueType)}` },
    { type: 'mrkdwn', text: `*风险*\n${platformRiskLabel(item.risk)}` },
  ];
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Pages 平台需求进度' } },
    { type: 'section', text: { type: 'mrkdwn', text: `*${title.slice(0, 180)}*` } },
    { type: 'section', fields: fields.slice(0, 10) },
    { type: 'section', text: { type: 'mrkdwn', text: `*需求摘要*\n${summary.slice(0, 1000)}` } },
    ...(currentChange ? [{ type: 'section', text: { type: 'mrkdwn', text: `*本轮补充*\n${currentChange.slice(0, 800)}` } }] : []),
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: contextText(item, statusText),
        },
      ],
    },
  ];
  const actions = [
    stage === 'auto_dev_pending' && item.agentEligible
      ? {
          type: 'button',
          text: { type: 'plain_text', text: '自动开发' },
          style: 'primary',
          action_id: 'pages_trigger_platform_auto_dev',
          value: JSON.stringify({
            workItemKind: 'platform_dev',
            workItemId: item.id,
            sessionId: item.slackSessionId || null,
          }),
        }
      : null,
    item.githubIssueUrl
      ? { type: 'button', text: { type: 'plain_text', text: '查看 Issue' }, url: item.githubIssueUrl, action_id: 'open_issue' }
      : null,
    item.githubPrUrl
      ? { type: 'button', text: { type: 'plain_text', text: '查看 PR' }, url: item.githubPrUrl, action_id: 'open_pr' }
      : null,
    item.slackSessionId
      ? {
          type: 'button',
          text: { type: 'plain_text', text: '关闭会话' },
          style: 'danger',
          action_id: 'pages_close_session',
          value: item.slackSessionId,
        }
      : null,
  ].filter(Boolean);
  if (actions.length) blocks.push({ type: 'actions', elements: actions });
  return blocks;
}

export async function notifySlackPlatformDevStatus(env, store, item, options = {}) {
  if (!item?.id) return null;
  const target = targetForItem(item);
  if (!target) return null;

  const stage = options.stage || item.status;
  const slackSessionId = options.slackSessionId || item.slackSessionId || null;
  const scopeKey = options.scopeKey || (slackSessionId ? `session:${slackSessionId}` : 'work-item');
  const existing = store?.getSlackWorkItemStatusMessage
    ? await store.getSlackWorkItemStatusMessage('platform_dev', item.id, { scopeKey })
    : null;
  if (existing?.messageTs && isStaleStageUpdate(existing.stage, stage) && options.allowRegression !== true) {
    return { skipped: true, reason: 'stale_stage', message: existing };
  }
  if (existing?.messageTs && existing.stage === stage && options.skipDuplicate !== false) {
    return { skipped: true, reason: 'duplicate_stage', message: existing };
  }

  const blocks = buildPlatformStatusBlocks(item, options);
  const text = `Pages 平台需求进度：${platformStageLabel(stage, item)}`;
  const result = existing?.messageTs
    ? await updateSlackMessage(env, {
        channel: existing.channel || target.channel,
        ts: existing.messageTs,
        text,
        blocks,
      })
    : await postSlackMessage(env, {
        ...target,
        text,
        blocks,
      });

  if (!result?.ok) {
    return { ok: false, error: result?.error || 'Slack notifier request failed' };
  }

  const message = store?.recordSlackWorkItemStatusMessage
    ? await store.recordSlackWorkItemStatusMessage('platform_dev', item.id, {
        slackSessionId,
        scopeKey,
        channel: result.channel || existing?.channel || target.channel,
        threadTs: target.thread_ts || null,
        messageTs: result.ts || existing?.messageTs || null,
        stage,
        status: item.status,
      })
    : null;

  if (store?.recordAgentRunEvent) {
    await store.recordAgentRunEvent({
      workItemKind: 'platform_dev',
      workItemId: item.id,
      slackSessionId,
      type: options.type || 'platform_progress',
      stage,
      text: options.text || platformNotificationText(stage, item) || stage,
      status: item.status,
      dedupeKey: options.dedupeKey || `platform-status:${item.id}:${stage}:${message?.messageTs || result.ts || Date.now()}`,
      slackChannelId: item.slackThread?.channelId || null,
      slackThreadTs: item.slackThread?.threadTs || null,
    });
  }

  return {
    ok: true,
    action: existing?.messageTs ? 'updated' : 'posted',
    message,
    channel: result.channel || target.channel,
    ts: result.ts || null,
  };
}
