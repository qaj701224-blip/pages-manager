import { slackActorFromBody } from './session.js';
import {
  platformAreaLabel,
  platformIssueTypeLabel,
  platformRiskLabel,
  userFacingPlatformTitle,
} from './issue-confirmation.js';
import { compactUserFacingText } from './text.js';
import { normalizeSlackWorkItemQueryState } from './work-item-query.js';

export const ACTIONABLE_WORK_ITEM_STATUSES = [
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
  'triaging',
  'gate_pending',
  'agent_queued',
  'agent_running',
  'ci_running',
  'ci_failed',
  'review_waiting',
  'review_blocked',
  'ready_to_merge',
];

export const INACTIVE_WORK_ITEM_STATUSES = ['approved', 'merged', 'deployed', 'failed', 'cancelled', 'closed_unmerged'];

const ACTIONABLE_WORK_ITEM_STATUS_SET = new Set(ACTIONABLE_WORK_ITEM_STATUSES);

export function slackJobVisibleToActor(job, body) {
  if (!job) return true;
  const actor = slackActorFromBody(body);
  return job.source === 'slack' && job.requestedById === actor.requestedById;
}

function workItemKind(job = {}) {
  return job.workItemKind || (job.githubIssueNumber !== undefined ? 'platform_dev' : 'site_publishing');
}

export function isActionableSlackWorkItem(job = {}) {
  return ACTIONABLE_WORK_ITEM_STATUS_SET.has(job.status);
}

export function reopenTargetForSlackWorkItem(job = {}) {
  if (workItemKind(job) === 'platform_dev') {
    if (job.status !== 'closed_unmerged' && job.status !== 'cancelled' && job.status !== 'failed') return null;
    if (job.githubPrNumber || job.prNumber) return 'pr';
    if (job.githubIssueNumber || job.issueNumber) return 'issue';
    return null;
  }
  if (job.status !== 'cancelled') return null;
  if (job.errorCode === 'github_pr_closed' && job.prNumber) return 'pr';
  if (job.errorCode === 'github_issue_closed' && job.issueNumber) return 'issue';
  return null;
}

export function isReopenableSlackWorkItem(job = {}) {
  return Boolean(reopenTargetForSlackWorkItem(job));
}

export function slackStatusLabel(status = '', job = {}) {
  const labels = {
    received: '整理需求',
    issue_creating: '创建 Issue',
    issue_created: 'Issue 已创建',
    indexing: '固定索引',
    generating_page: '生成页面',
    pr_created: 'PR 已创建',
    reviewing: '等待 Review',
    changes_requested: '等待修复',
    fixing: '修复中',
    previewing: '生成 Preview',
    preview_deployed: 'Preview 已生成',
    failed: '失败',
    cancelled: '已取消',
    triaging: '确认处理策略',
    gate_pending: '等待人工确认',
    agent_queued: '等待自动开发',
    agent_running: '自动开发中',
    ci_running: 'CI 验证中',
    ci_failed: 'CI 未通过',
    review_waiting: '等待 Review',
    review_blocked: '等待修复',
    ready_to_merge: '可合并',
    closed_unmerged: '已关闭',
  };
  if (status === 'cancelled' && job.errorCode === 'github_issue_closed') return 'Issue 已关闭';
  if (status === 'cancelled' && job.errorCode === 'github_pr_closed') return 'PR 已关闭';
  return labels[status] || status || '处理中';
}

export function inactiveSlackWorkItemReply(job = {}) {
  const label = slackStatusLabel(job.status, job);
  const target = workItemKind(job) === 'platform_dev' ? '平台需求' : '发布任务';
  const reopenHint = isReopenableSlackWorkItem(job)
    ? '可以说「查看我已关闭的任务」，然后在卡片里点击「重新打开」。'
    : '可以说「我的 PR」查看可继续任务，或重新描述一个新需求。';
  return `这个${target}当前是「${label}」，不能继续修改。${reopenHint}`;
}

export function unsupportedDestructiveRequestReply() {
  return '我不能批量关闭或删除你名下的 GitHub issue / PR / 发布任务。为了避免误操作，请先说「我的 PR」查看可继续任务，或明确指定一个 PR / issue 再处理。';
}

export function slackButtonValue(value = {}) {
  return JSON.stringify(value).slice(0, 1900);
}

export function parseSlackButtonValue(value = '') {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function workItemLine(job = {}) {
  const kind = workItemKind(job);
  const title =
    kind === 'platform_dev'
      ? userFacingPlatformTitle({ title: job.title, summary: job.summary })
      : compactUserFacingText(job.title || job.siteSlug || '未命名任务').slice(0, 80);
  const parts = [
    `*${title}*`,
    kind === 'platform_dev'
      ? `类型：${platformIssueTypeLabel(job.issueType)} · 风险：${platformRiskLabel(job.risk)}`
      : `站点：${job.siteSlug || '-'}`,
    `状态：${slackStatusLabel(job.status, job)}`,
  ];
  if (kind === 'platform_dev' && Array.isArray(job.areas) && job.areas.length) {
    const areaLabels = Array.from(new Set(job.areas.map((area) => platformAreaLabel(area))));
    parts.push(`范围：${areaLabels.join('、')}`);
  }
  if (job.issueNumber) parts.push(`Issue：#${job.issueNumber}`);
  if (job.prNumber) parts.push(`PR：#${job.prNumber}`);
  if (job.previewUrl) parts.push('Preview：已生成');
  return parts.join('\n');
}

export function slackWorkItemTargetLabel(job = {}) {
  if (job.prNumber) return `PR #${job.prNumber}`;
  if (job.issueNumber) return `Issue #${job.issueNumber}`;
  return workItemKind(job) === 'platform_dev' ? '这个平台需求' : '这个发布任务';
}

export function slackWorkItemListText(jobs = [], options = {}) {
  const state = normalizeSlackWorkItemQueryState(options.workItemState || (options.includeInactive ? 'all' : 'active'));
  const hasPlatformDev = jobs.some((job) => workItemKind(job) === 'platform_dev');
  const target = hasPlatformDev ? '任务' : '发布任务';
  if (!jobs.length) {
    if (state === 'closed') return '我还没有找到你已关闭、已取消或失败的任务。';
    return '我还没有找到你的任务。可以先描述一个个人网站或平台改造需求，我会整理后等你确认创建。';
  }
  if (state === 'closed') return `找到你最近的 ${jobs.length} 个已关闭、已取消或失败的${target}。可恢复的任务会显示「重新打开」。`;
  if (state === 'all') return `找到你最近的 ${jobs.length} 个${target}。已关闭、已取消或失败的任务只展示状态，不会继续修改。`;
  return `找到你最近的 ${jobs.length} 个${target}。选择一个后，这个对话会继续围绕它修改。`;
}

export function slackWorkItemListBlocks(slackSession, jobs = [], options = {}) {
  const state = normalizeSlackWorkItemQueryState(options.workItemState || (options.includeInactive ? 'all' : 'active'));
  const hasPlatformDev = jobs.some((job) => workItemKind(job) === 'platform_dev');
  if (!jobs.length) {
    return [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: slackWorkItemListText(jobs, options) },
      },
    ];
  }

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: hasPlatformDev ? '你的任务' : '你的发布任务' },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text:
            state === 'closed'
              ? '这些任务当前不可继续修改；可恢复的任务会出现「重新打开」。'
              : state === 'all'
                ? '历史任务仅用于查看状态；只有可继续任务会出现「继续修改」。'
                : hasPlatformDev
                  ? '点「继续修改」后，后续回复会进入选中的任务。'
                  : '点「继续修改」后，后续回复会进入选中的 PR / Preview。',
        },
      ],
    },
  ];

  for (const job of jobs.slice(0, 6)) {
    const elements = [];
    if (isActionableSlackWorkItem(job)) {
      elements.push({
        type: 'button',
        text: { type: 'plain_text', text: '继续修改' },
        style: 'primary',
        action_id: 'pages_select_work_item',
        value: slackButtonValue({ sessionId: slackSession.id, jobId: job.id, workItemKind: workItemKind(job) }),
      });
    } else if (options.includeInactive && isReopenableSlackWorkItem(job)) {
      const target = reopenTargetForSlackWorkItem(job);
      elements.push({
        type: 'button',
        text: { type: 'plain_text', text: target === 'pr' ? '重新打开 PR' : '重新打开 Issue' },
        style: 'primary',
        action_id: 'pages_reopen_work_item',
        value: slackButtonValue({
          sessionId: slackSession.id,
          jobId: job.id,
          workItemKind: workItemKind(job),
          target,
          includeInactive: true,
          workItemState: state,
        }),
      });
    }
    if (job.issueUrl) {
      elements.push({
        type: 'button',
        text: { type: 'plain_text', text: '打开 Issue' },
        url: job.issueUrl,
        action_id: 'open_issue',
      });
    }
    if (job.prUrl) {
      elements.push({
        type: 'button',
        text: { type: 'plain_text', text: '打开 PR' },
        url: job.prUrl,
        action_id: 'open_pr',
      });
    }
    if (job.previewUrl) {
      elements.push({
        type: 'button',
        text: { type: 'plain_text', text: '打开 Preview' },
        url: job.previewUrl,
        action_id: 'open_preview',
      });
    }
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: workItemLine(job) } });
    if (elements.length) blocks.push({ type: 'actions', elements });
  }

  return blocks;
}

export async function listSlackWorkItemsForSession(store, body, options = {}) {
  const actor = slackActorFromBody(body);
  const state = normalizeSlackWorkItemQueryState(options.workItemState || (options.includeInactive ? 'all' : 'active'));
  const queryOptions = {
    ...options,
    workItemState: state,
    statuses:
      state === 'active'
        ? options.statuses || ACTIONABLE_WORK_ITEM_STATUSES
        : state === 'closed'
          ? options.statuses || INACTIVE_WORK_ITEM_STATUSES
          : options.statuses,
  };
  if (store.listWorkItemsForSlackUser) {
    return store.listWorkItemsForSlackUser(actor.teamId, actor.slackUserId, queryOptions);
  }
  const result = await store.listJobs({ source: 'slack', limit: queryOptions.limit || 20 });
  const requestedById = actor.requestedById;
  const jobs = (result.jobs || [])
    .filter((job) => job.requestedById === requestedById)
    .filter((job) => !queryOptions.statuses?.length || queryOptions.statuses.includes(job.status))
    .slice(0, queryOptions.limit || 5);
  return { jobs, total: jobs.length, limit: queryOptions.limit || 5, offset: 0 };
}

export async function findVisibleSlackJobByPrNumber(store, body, prNumber) {
  const workItemLink = store.findWorkItemLinkByPrNumber ? await store.findWorkItemLinkByPrNumber(prNumber) : null;
  if (workItemLink?.platformDevItemId && store.getPlatformDevItem) {
    const item = await store.getPlatformDevItem(workItemLink.platformDevItemId);
    if (item && slackJobVisibleToActor(item, body)) {
      return {
        ...item,
        workItemKind: 'platform_dev',
        issueNumber: item.githubIssueNumber,
        issueUrl: item.githubIssueUrl,
        prNumber: item.githubPrNumber,
        prUrl: item.githubPrUrl,
      };
    }
  }
  const link = store.findIssueLinkByPrNumber ? await store.findIssueLinkByPrNumber(prNumber) : null;
  const linkedJob = link?.publishingJobId && store.getJob ? await store.getJob(link.publishingJobId) : null;
  const job = linkedJob || (store.findJobByPrNumber ? await store.findJobByPrNumber(prNumber) : null);
  if (!job || !slackJobVisibleToActor(job, body)) return null;
  return job;
}

export async function findVisibleSlackJobByIssueNumber(store, body, issueNumber) {
  const workItemLink = store.findWorkItemLinkByIssueNumber ? await store.findWorkItemLinkByIssueNumber(issueNumber) : null;
  if (workItemLink?.platformDevItemId && store.getPlatformDevItem) {
    const item = await store.getPlatformDevItem(workItemLink.platformDevItemId);
    if (item && slackJobVisibleToActor(item, body)) {
      return {
        ...item,
        workItemKind: 'platform_dev',
        issueNumber: item.githubIssueNumber,
        issueUrl: item.githubIssueUrl,
        prNumber: item.githubPrNumber,
        prUrl: item.githubPrUrl,
      };
    }
  }
  const link = store.findIssueLinkByIssueNumber ? await store.findIssueLinkByIssueNumber(issueNumber) : null;
  const linkedJob = link?.publishingJobId && store.getJob ? await store.getJob(link.publishingJobId) : null;
  if (linkedJob && slackJobVisibleToActor(linkedJob, body)) return linkedJob;

  const result = await listSlackWorkItemsForSession(store, body, { workItemState: 'all', limit: 20 });
  return (
    (result.jobs || []).find((job) => Number(job.issueNumber) === Number(issueNumber) && slackJobVisibleToActor(job, body)) ||
    null
  );
}

export async function findVisibleSlackJobByReference(store, body, reference = {}) {
  const number = Number(reference.number || reference.targetNumber);
  if (!Number.isFinite(number) || number <= 0) return null;
  if (reference.kind === 'issue' || reference.targetKind === 'issue') {
    return await findVisibleSlackJobByIssueNumber(store, body, number);
  }
  if (reference.kind === 'pr' || reference.targetKind === 'pr') {
    return await findVisibleSlackJobByPrNumber(store, body, number);
  }

  return (
    (await findVisibleSlackJobByPrNumber(store, body, number)) || (await findVisibleSlackJobByIssueNumber(store, body, number))
  );
}
