function slackApiUrl(env = {}, method = 'chat.postMessage') {
  if (env.SLACK_API_BASE_URL) {
    return `${String(env.SLACK_API_BASE_URL).replace(/\/+$/, '')}/${method}`;
  }

  if (method === 'chat.update') {
    return (
      env.SLACK_UPDATE_API_URL ||
      String(env.SLACK_API_URL || 'https://slack.com/api/chat.postMessage').replace(/\/chat\.postMessage$/, '/chat.update')
    );
  }

  if (method !== 'chat.postMessage') {
    return String(env.SLACK_API_URL || 'https://slack.com/api/chat.postMessage').replace(/\/chat\.postMessage$/, `/${method}`);
  }

  return env.SLACK_POST_API_URL || env.SLACK_API_URL || 'https://slack.com/api/chat.postMessage';
}

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

async function readSlackResponse(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function truncateText(value = '', max = 1800) {
  const text = String(value || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}...`;
}

function slackText(text, emoji = true) {
  return {
    type: 'mrkdwn',
    text: emoji ? String(text || '') : String(text || '').replaceAll(/:[a-z0-9_+-]+:/gi, '').trim(),
  };
}

function stageLabel(stage, job = {}) {
  const normalized = stage || job.status;
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
  };
  return labels[normalized] || normalized || '处理中';
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
          text: { type: 'plain_text', text: '继续修改' },
          action_id: 'pages_continue_modifying',
          value: job.slackSessionId,
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

export function buildJobStatusBlocks(job = {}, options = {}) {
  const stage = options.stage || job.status;
  const label = stageLabel(stage, job);
  const statusLine = job.status === 'failed' ? ':x: 失败' : options.statusText || ':hourglass_flowing_sand: 处理中';
  const summary = truncateText(job.summary || job.brief || job.title || '暂无摘要', 900);
  const fields = [
    slackText(`*当前阶段*\n${label}`),
    slackText(`*目标*\n${job.employeeSlug || '-'}/${job.siteSlug || '-'}`),
    slackText(`*Job*\n${job.id || '-'}`),
    slackText(`*状态*\n${job.status || '-'}`),
    ...jobLinkFields(job),
  ];
  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: 'Pages 发布任务' },
    },
    {
      type: 'section',
      text: slackText(`*${label}*\n${summary}`),
    },
    {
      type: 'section',
      fields: fields.slice(0, 10),
    },
    {
      type: 'context',
      elements: [
        slackText(`${statusLine} · 继续修改可以直接在这个 thread 里回复。`),
      ],
    },
  ];
  const actions = jobActionElements(job);
  if (actions.length) {
    blocks.push({ type: 'actions', elements: actions });
  }
  return blocks;
}

export function buildAgentProgressBlocks(job = {}, options = {}) {
  return buildJobStatusBlocks(job, options);
}

async function callSlackApi(env, method, payload) {
  if (!env.SLACK_BOT_TOKEN) return null;
  const fetchImpl = env.SLACK_FETCH || fetch;
  const response = await fetchImpl(slackApiUrl(env, method), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  });
  const body = await readSlackResponse(response);

  if (!response.ok || body?.ok === false) {
    return {
      ok: false,
      error: body?.error || response.statusText || `HTTP ${response.status}`,
    };
  }

  return {
    ok: true,
    channel: body?.channel || payload.channel,
    ts: body?.ts || payload.ts || null,
  };
}

export function buildSlackStatusText(job = {}, stage) {
  return mentionSlackUser(`Pages 发布任务 ${job.id || ''}：${stageLabel(stage, job)}`, job.slackThread?.userId);
}

export async function postSlackMessage(env, payload) {
  return callSlackApi(env, 'chat.postMessage', payload);
}

export async function updateSlackMessage(env, payload) {
  return callSlackApi(env, 'chat.update', payload);
}

export async function addSlackReaction(env, payload) {
  return callSlackApi(env, 'reactions.add', payload);
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
    return job.prUrl ? `修复轮次已提交，等待 Review Agent：#${job.prNumber}\n${job.prUrl}` : '修复轮次已提交，等待 Review Agent。';
  }
  if (stageResult === 'preview_deployed') {
    return job.previewUrl ? `Preview 已生成：${job.previewUrl}` : 'Preview 已生成。';
  }
  return null;
}

export function notificationTextForReviewAction(reviewAction, payload = {}) {
  const comment = payload.reviewComment || {};
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
  if (reviewAction === 'recorded') {
    return recordedReviewText(comment, location);
  }
  return null;
}

export async function notifySlackJob(env, store, job, text, key) {
  if (!text || !job?.id) return null;
  const target = slackTargetForJob(job);
  if (!target || !env.SLACK_BOT_TOKEN) return null;
  if (store?.hasSlackNotification?.(job.id, key)) {
    return { skipped: true, reason: 'duplicate', key };
  }

  const fetchImpl = env.SLACK_FETCH || fetch;
  const result = await callSlackApi(
    { ...env, SLACK_FETCH: fetchImpl },
    'chat.postMessage',
    {
      ...target,
      text: mentionSlackUser(text, job.slackThread?.userId),
    }
  );

  if (!result?.ok) {
    return {
      ok: false,
      key,
      error: result?.error || 'Slack request failed',
    };
  }

  store?.recordSlackNotification?.(job.id, key);
  return {
    ok: true,
    key,
    channel: result.channel || target.channel,
    ts: result.ts || null,
  };
}

export async function notifySlackJobStatus(env, store, job, options = {}) {
  if (!job?.id) return null;
  const target = slackTargetForJob(job);
  if (!target || !env.SLACK_BOT_TOKEN) return null;

  const stage = options.stage || job.status;
  const dedupeKey = options.dedupeKey || `job-status:${job.id}:${stage}`;
  const existing = store?.getSlackJobStatusMessage?.(job.id);
  if (existing?.messageTs && existing.stage === stage && options.skipDuplicate !== false) {
    return { skipped: true, reason: 'duplicate_stage', key: dedupeKey, message: existing };
  }

  const progress = store?.recordAgentRunEvent?.({
    publishingJobId: job.id,
    slackSessionId: job.slackSessionId || null,
    agentRunId: options.agentRunId || null,
    type: options.type || 'job_progress',
    stage,
    text: options.text || stageLabel(stage, job),
    status: options.status || job.status || 'running',
    dedupeKey,
    slackChannelId: target.channel,
    slackThreadTs: target.thread_ts || null,
  });

  const blocks = buildJobStatusBlocks(job, {
    stage,
    statusText: options.statusText,
  });
  const text = buildSlackStatusText(job, stage);
  let result;

  if (existing?.messageTs) {
    result = await updateSlackMessage(env, {
      channel: existing.channel || target.channel,
      ts: existing.messageTs,
      text,
      blocks,
    });
  } else {
    result = await postSlackMessage(env, {
      ...target,
      text,
      blocks,
    });
  }

  if (!result?.ok) {
    return {
      ok: false,
      key: dedupeKey,
      error: result?.error || 'Slack request failed',
      event: progress?.event || null,
    };
  }

  const message = store?.recordSlackJobStatusMessage?.(job.id, {
    channel: result.channel || target.channel,
    threadTs: target.thread_ts || null,
    messageTs: result.ts || existing?.messageTs || null,
    stage,
    status: job.status,
  });
  return {
    ok: true,
    key: dedupeKey,
    action: existing?.messageTs ? 'updated' : 'posted',
    channel: result.channel || target.channel,
    ts: result.ts || existing?.messageTs || null,
    message,
    event: progress?.event || null,
  };
}
