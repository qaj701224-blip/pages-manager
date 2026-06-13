function slackApiUrl(env = {}) {
  return env.SLACK_API_URL || 'https://slack.com/api/chat.postMessage';
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
  const response = await fetchImpl(slackApiUrl(env), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.SLACK_BOT_TOKEN}`,
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({
      ...target,
      text: mentionSlackUser(text, job.slackThread?.userId),
    }),
  });
  const body = await readSlackResponse(response);

  if (!response.ok || body?.ok === false) {
    return {
      ok: false,
      key,
      error: body?.error || response.statusText || `HTTP ${response.status}`,
    };
  }

  store?.recordSlackNotification?.(job.id, key);
  return {
    ok: true,
    key,
    channel: body?.channel || target.channel,
    ts: body?.ts || null,
  };
}
