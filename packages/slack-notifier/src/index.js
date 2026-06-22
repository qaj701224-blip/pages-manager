function slackTargetForJob(job) {
  const thread = job?.slackThread;
  if (!thread?.channelId) return null;

  return {
    channel: thread.channelId,
    thread_ts: thread.threadTs || undefined,
  };
}

function slackUserMention(userId) {
  const normalized = String(userId || '').trim();
  if (!normalized || normalized === 'unknown-user') return '';
  if (!/^[A-Z0-9]+$/i.test(normalized)) return '';
  return `<@${normalized}>`;
}

export function mentionSlackUser(text, userId) {
  const mention = slackUserMention(userId);
  if (!mention) return text;
  if (String(text).startsWith(mention)) return text;
  return `${mention} ${text}`;
}

function truncateText(value = '', max = 1800) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}...`;
}

function cleanCardText(value = '') {
  return String(value || '')
    .replace(/^\s*#+\s*Slack Follow-up\s*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function splitSlackFollowupSummary(summary = '') {
  const parts = String(summary || '')
    .split(/^\s*##\s*Slack Follow-up\s*$/gim)
    .map((part) => cleanCardText(part))
    .filter(Boolean);
  const base = parts.shift() || '';
  return { base, followups: parts };
}

function formatFinalSummary(job = {}, options = {}) {
  const explicit = cleanCardText(options.finalSummary);
  if (explicit) return truncateText(explicit, 1000);

  const { base, followups } = splitSlackFollowupSummary(job.summary || '');
  const seed = cleanCardText(base || job.brief || job.title || '');
  if (!followups.length) return truncateText(seed || '暂无摘要', 1000);

  const visibleFollowups = followups.slice(-4).map((item, index) => `${index + 1}. ${truncateText(item, 220)}`);
  const hiddenCount = Math.max(0, followups.length - visibleFollowups.length);
  const lines = [
    seed || '已记录初始需求。',
    '',
    '*已追加修改*',
    hiddenCount ? `...前面还有 ${hiddenCount} 轮修改` : null,
    ...visibleFollowups,
  ].filter(Boolean);

  return truncateText(lines.join('\n'), 1000);
}

function formatCurrentChange(job = {}, options = {}) {
  const explicit = cleanCardText(options.currentChange || options.cardSummary).replace(/^本轮修改[：:]\s*/u, '');
  if (explicit) return truncateText(explicit, 700);

  const { followups } = splitSlackFollowupSummary(job.summary || '');
  const latest = cleanCardText(followups.at(-1) || '');
  return latest ? truncateText(latest, 700) : '';
}

function slackText(text, emoji = true) {
  return {
    type: 'mrkdwn',
    text: emoji
      ? String(text || '')
      : String(text || '')
          .replaceAll(/:[a-z0-9_+-]+:/gi, '')
          .trim(),
  };
}

function stageLabel(stage, job = {}) {
  const normalized = stage || job.status;
  if (normalized === 'cancelled' && job.errorCode === 'github_issue_closed') return 'Issue 已关闭';
  const labels = {
    received: '整理需求',
    issue_creating: '创建 issue',
    issue_created: 'Issue 已创建',
    indexing: '固定项目索引',
    index_ready: '项目索引已固定',
    generating_page: '生成页面',
    patch_generated: '生成代码变更',
    branch_committed: '提交分支',
    pr_created: 'PR 已创建',
    reviewing: '等待 Agent Review',
    changes_requested: '等待修复 Review 意见',
    fixing: '修复中',
    previewing: '生成 Preview',
    preview_deployed: 'Preview 已生成',
    failed: '失败',
    cancelled: '已取消',
  };
  return labels[normalized] || normalized || '处理中';
}

const STAGE_ORDER = [
  'received',
  'issue_creating',
  'issue_created',
  'indexing',
  'index_ready',
  'generating_page',
  'patch_generated',
  'branch_committed',
  'pr_created',
  'reviewing',
  'changes_requested',
  'fixing',
  'previewing',
  'preview_deployed',
  'approved',
  'merging',
  'merged',
  'deploying',
  'deployed',
  'failed',
  'cancelled',
];

function stageRank(stage) {
  const index = STAGE_ORDER.indexOf(stage);
  return index === -1 ? -1 : index;
}

function isStaleStageUpdate(existingStage, nextStage) {
  const existingRank = stageRank(existingStage);
  const nextRank = stageRank(nextStage);
  return existingRank >= 0 && nextRank >= 0 && existingRank > nextRank;
}

function sameSlackStatusTarget(message = {}, job = {}) {
  const target = slackTargetForJob(job);
  if (!message?.messageTs || !target?.channel) return false;
  return message.channel === target.channel && (message.threadTs || null) === (target.thread_ts || null);
}

function jobLinkFields(job = {}) {
  const fields = [];
  if (job.issueNumber || job.issueUrl) {
    const value = job.issueUrl ? `<${job.issueUrl}|#${job.issueNumber || 'issue'}>` : `#${job.issueNumber}`;
    fields.push(slackText(`*Issue*\n${value}`));
  }
  if (job.prNumber || job.prUrl) {
    const value = job.prUrl ? `<${job.prUrl}|#${job.prNumber || 'PR'}>` : `#${job.prNumber}`;
    fields.push(slackText(`*PR*\n${value}`));
  }
  if (job.previewUrl) {
    fields.push(slackText(`*Preview*\n<${job.previewUrl}|打开 Preview>`));
  }
  if (job.errorMessage || job.errorCode) {
    fields.push(slackText(`*错误*\n${truncateText(job.errorMessage || job.errorCode, 280)}`));
  }
  return fields;
}

function jobActionElements(job = {}) {
  return [
    job.issueUrl
      ? {
          type: 'button',
          text: { type: 'plain_text', text: '查看 Issue' },
          url: job.issueUrl,
          action_id: 'open_issue',
        }
      : null,
    job.prUrl
      ? {
          type: 'button',
          text: { type: 'plain_text', text: '查看 PR' },
          url: job.prUrl,
          action_id: 'open_pr',
        }
      : null,
    job.previewUrl
      ? {
          type: 'button',
          text: { type: 'plain_text', text: '打开 Preview' },
          url: job.previewUrl,
          action_id: 'open_preview',
        }
      : null,
    job.slackSessionId
      ? {
          type: 'button',
          text: { type: 'plain_text', text: '关闭会话' },
          style: 'danger',
          action_id: 'pages_close_session',
          value: job.slackSessionId,
        }
      : null,
  ].filter(Boolean);
}

function jobStatusLine(job = {}, options = {}) {
  if (job.status === 'failed') return ':x: 失败';
  if (job.status === 'cancelled' && job.errorCode === 'github_issue_closed') {
    return ':white_check_mark: Issue 已关闭，任务已停止';
  }
  if (job.status === 'cancelled') return ':white_check_mark: 任务已取消';
  return options.statusText || ':hourglass_flowing_sand: 处理中';
}

function jobContextText(job = {}, statusLine = '') {
  if (job.status === 'cancelled' && job.errorCode === 'github_issue_closed') {
    return `${statusLine} · 这个任务不能继续修改；可以打开 Issue 查看记录，或重新描述一个新需求。`;
  }
  if (job.status === 'cancelled' || job.status === 'failed') {
    return `${statusLine} · 这个任务不能继续修改；可以重新描述一个新需求。`;
  }
  return `${statusLine} · 继续修改可以直接在当前对话里回复。`;
}

export function buildJobStatusBlocks(job = {}, options = {}) {
  const stage = options.stage || job.status;
  const label = stageLabel(stage, job);
  const cardTitle = truncateText(options.cardTitle || label, 180);
  const statusLine = jobStatusLine(job, options);
  const finalSummary = formatFinalSummary(job, options);
  const currentChange = formatCurrentChange(job, options);
  const fields = [slackText(`*当前阶段*\n${label}`), slackText(`*站点*\n${job.siteSlug || '-'}`), ...jobLinkFields(job)];
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Pages 发布进度' },
    },
    {
      type: 'section',
      text: slackText(`*${cardTitle}*`),
    },
    {
      type: 'section',
      fields: fields.slice(0, 10),
    },
    {
      type: 'section',
      text: slackText(`*最终需求*\n${finalSummary}`),
    },
    currentChange
      ? {
          type: 'section',
          text: slackText(`*本轮修改*\n${currentChange}`),
        }
      : null,
    {
      type: 'context',
      elements: [slackText(jobContextText(job, statusLine))],
    },
  ].filter(Boolean);
  const actions = jobActionElements(job);
  if (actions.length) {
    blocks.push({ type: 'actions', elements: actions });
  }
  return blocks;
}

export function buildAgentProgressBlocks(job = {}, options = {}) {
  return buildJobStatusBlocks(job, options);
}

function agentReplyStatusText(status) {
  if (status === 'failed') return ':x: 处理失败';
  if (status === 'completed') return ':white_check_mark: 已整理';
  return ':hourglass_flowing_sand: 正在整理';
}

function shouldUseAgentReplyCard(options = {}) {
  return (
    options.presentation === 'card' ||
    options.layout === 'card' ||
    (Array.isArray(options.actions) && options.actions.length > 0)
  );
}

export function buildSlackAgentReplyBlocks(reply = {}, options = {}) {
  const title = truncateText(options.title || reply.title || '需求整理', 120);
  const text = truncateText(options.text || reply.text || reply.visibleText || '我正在整理这轮需求。', 2400);
  const context = options.context || `${agentReplyStatusText(options.status || reply.status)} · 可以继续在当前对话里补充。`;
  const blocks = shouldUseAgentReplyCard(options)
    ? [
        {
          type: 'header',
          text: { type: 'plain_text', text: title },
        },
        {
          type: 'section',
          text: slackText(text),
        },
        {
          type: 'context',
          elements: [slackText(context)],
        },
      ]
    : [
        {
          type: 'section',
          text: slackText(text),
        },
      ];

  if (Array.isArray(options.actions) && options.actions.length) {
    blocks.push({ type: 'actions', elements: options.actions });
  }

  return blocks;
}

export function buildSlackStatusText(job = {}, stage) {
  return mentionSlackUser(`Pages 发布进度：${stageLabel(stage, job)}`, job.slackThread?.userId);
}

function formatReviewLocation(comment = {}) {
  if (!comment.path) return '';
  return comment.line ? `（${comment.path}:${comment.line}）` : `（${comment.path}）`;
}

function recordedReviewText(comment = {}, location = '') {
  if (comment.classification === 'blocking') {
    return `Review Agent 提交了 blocking comment${location}，已记录。`;
  }
  if (comment.classification === 'suggestion') {
    return `Review Agent 提交了 suggestion${location}，已记录，不阻塞 Preview。`;
  }
  if (comment.classification === 'unknown') {
    return `Review Agent 提交了无法自动判断的 comment${location}，需要人工确认，暂不进入 Preview。`;
  }
  if (comment.classification === 'note') {
    return `Review Agent 提交了 note${location}，已记录。`;
  }
  return null;
}

export function notificationTextForCallback(stageResult, job) {
  if (stageResult === 'issue_created') {
    if (job.issueNumber && job.issueUrl) return `已创建 GitHub issue：#${job.issueNumber}\n${job.issueUrl}`;
    if (job.issueNumber) return `已创建 GitHub issue：#${job.issueNumber}`;
    if (job.issueUrl) return `已创建 GitHub issue：${job.issueUrl}`;
    return '已创建 GitHub issue。';
  }
  if (stageResult === 'index_ready') {
    return job.indexSnapshotId ? `已固定项目索引：${job.indexSnapshotId}` : '已固定项目索引。';
  }
  if (stageResult === 'pr_created') {
    return job.prUrl ? `已创建 PR：#${job.prNumber}\n${job.prUrl}` : `已创建 PR：#${job.prNumber}`;
  }
  if (stageResult === 'reviewing') {
    return job.prUrl
      ? `修复轮次已提交，等待 Review Agent：#${job.prNumber}\n${job.prUrl}`
      : '修复轮次已提交，等待 Review Agent。';
  }
  if (stageResult === 'preview_deployed') {
    return job.previewUrl ? `Preview 已生成：${job.previewUrl}` : 'Preview 已生成。';
  }
  return null;
}

export function notificationTextForReviewAction(reviewAction, payload = {}) {
  const comment = payload.reviewComment || {};
  const siteCheck = payload.siteCheckRun || payload.gate?.siteCheck?.latestRun || {};
  const location = formatReviewLocation(comment);

  if (reviewAction === 'reviewing') {
    const recorded = recordedReviewText(comment, location);
    return recorded ? `Agent Review 已开始。\n${recorded}` : 'Agent Review 已开始。';
  }
  if (reviewAction === 'changes_requested') {
    const count = payload.gate?.blockingCount || 1;
    return `Review Agent 发现 ${count} 条 blocking comment，已暂停 Preview。`;
  }
  if (reviewAction === 'preview_dispatched') {
    return 'Review gate 已通过，开始生成 staging Preview。';
  }
  if (reviewAction === 'review_timeout_preview_dispatched') {
    return 'Review Agent 超时未返回。site-check 已通过且无阻塞评论，已记录兜底 Review，开始生成 Preview。';
  }
  if (reviewAction === 'site_check_waiting') {
    return 'Review Agent 已记录，正在等待 site-check 通过后再生成 Preview。';
  }
  if (reviewAction === 'site_check_passed') {
    return 'site-check 已通过，继续等待 Review Agent 结果。';
  }
  if (reviewAction === 'site_check_failed') {
    const detail = siteCheck.detailsUrl || siteCheck.htmlUrl;
    return detail ? `site-check 未通过，已暂停 Preview：${detail}` : 'site-check 未通过，已暂停 Preview。';
  }
  if (reviewAction === 'site_check_recorded') {
    return null;
  }
  if (reviewAction === 'recorded') {
    return recordedReviewText(comment, location);
  }
  return null;
}

export function prepareSlackJobStatusNotification(store, job, options = {}) {
  if (!job?.id) return null;
  const target = slackTargetForJob(job);
  if (!target) return null;

  const stage = options.stage || job.status;
  const dedupeKey = options.dedupeKey || `job-status:${job.id}:${stage}`;
  const slackSessionId = options.slackSessionId || job.slackSessionId || null;
  const scopeKey = options.scopeKey || (slackSessionId ? `session:${slackSessionId}` : 'job');
  const existing = options.existingMessage || null;
  const fallbackExisting = options.fallbackExistingMessage || null;
  const reusableFallback = sameSlackStatusTarget(fallbackExisting, job) ? fallbackExisting : null;
  const existingMessage = existing || reusableFallback;
  if (existingMessage?.messageTs && isStaleStageUpdate(existingMessage.stage, stage) && options.allowRegression !== true) {
    return { skipped: true, reason: 'stale_stage', key: dedupeKey, message: existingMessage };
  }
  if (existingMessage?.messageTs && existingMessage.stage === stage && options.skipDuplicate !== false) {
    return { skipped: true, reason: 'duplicate_stage', key: dedupeKey, message: existingMessage };
  }

  const blocks = buildJobStatusBlocks(job, {
    stage,
    statusText: options.statusText || options.text,
    cardTitle: options.cardTitle,
    cardSummary: options.cardSummary,
    finalSummary: options.finalSummary,
    currentChange: options.currentChange,
  });
  const text = buildSlackStatusText(job, stage);

  return {
    key: dedupeKey,
    stage,
    slackSessionId,
    scopeKey,
    existingMessage,
    action: existingMessage?.messageTs ? 'update' : 'post',
    target,
    payload: existingMessage?.messageTs
      ? {
          channel: existingMessage.channel || target.channel,
          ts: existingMessage.messageTs,
          text,
          blocks,
        }
      : {
          ...target,
          text,
          blocks,
        },
    message: {
        slackSessionId,
        scopeKey,
        channel: existingMessage?.channel || target.channel,
        threadTs: target.thread_ts || null,
        messageTs: existingMessage?.messageTs || null,
        stage,
        status: job.status,
      },
  };
}
