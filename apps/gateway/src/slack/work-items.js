import { slackActorFromBody } from './session.js';
import { compactUserFacingText } from './text.js';

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
];

const ACTIONABLE_WORK_ITEM_STATUS_SET = new Set(ACTIONABLE_WORK_ITEM_STATUSES);

export function slackJobVisibleToActor(job, body) {
  if (!job) return true;
  const actor = slackActorFromBody(body);
  return job.source === 'slack' && job.requestedById === actor.requestedById;
}

export function isActionableSlackWorkItem(job = {}) {
  return ACTIONABLE_WORK_ITEM_STATUS_SET.has(job.status);
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
  };
  if (status === 'cancelled' && job.errorCode === 'github_issue_closed') return 'Issue 已关闭';
  return labels[status] || status || '处理中';
}

export function inactiveSlackWorkItemReply(job = {}) {
  const label = slackStatusLabel(job.status, job);
  return `这个发布任务当前是「${label}」，不能继续修改。可以说「我的 PR」查看可继续任务，或重新描述一个新需求。`;
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
  const parts = [
    `*${compactUserFacingText(job.title || job.siteSlug || '未命名任务').slice(0, 80)}*`,
    `站点：${job.siteSlug || '-'}`,
    `状态：${slackStatusLabel(job.status, job)}`,
  ];
  if (job.issueNumber) parts.push(`Issue：#${job.issueNumber}`);
  if (job.prNumber) parts.push(`PR：#${job.prNumber}`);
  if (job.previewUrl) parts.push('Preview：已生成');
  return parts.join('\n');
}

export function slackWorkItemListText(jobs = [], options = {}) {
  if (!jobs.length) return '我还没有找到你的发布任务。可以先描述一个个人网站需求，我会整理后等你确认创建。';
  if (options.includeInactive) return `找到你最近的 ${jobs.length} 个发布任务。已关闭、已取消或失败的任务只展示状态，不会继续修改。`;
  return `找到你最近的 ${jobs.length} 个发布任务。选择一个后，这个对话会继续围绕它修改。`;
}

export function slackWorkItemListBlocks(slackSession, jobs = [], options = {}) {
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
      text: { type: 'plain_text', text: '你的发布任务' },
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: options.includeInactive
            ? '历史任务仅用于查看状态；只有可继续任务会出现「继续修改」。'
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
        value: slackButtonValue({ sessionId: slackSession.id, jobId: job.id }),
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
  const queryOptions = {
    ...options,
    statuses: options.includeInactive ? options.statuses : options.statuses || ACTIONABLE_WORK_ITEM_STATUSES,
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
  const job = store.findJobByPrNumber ? await store.findJobByPrNumber(prNumber) : null;
  if (!job || !slackJobVisibleToActor(job, body)) return null;
  return job;
}
