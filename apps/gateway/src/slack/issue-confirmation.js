import { stableSlugHash } from './job-input.js';
import { slackUserIdFromBody } from './session.js';
import { compactUserFacingText } from './text.js';
import { interactionChannelId, interactionChannelType, interactionThreadTs } from './delivery.js';
import { CREATE_JOB_INTENTS } from './intents.js';

function userFacingSlackSummary(analysis = {}, fallback = '') {
  const sourceMessages = Array.isArray(analysis.sourceMessages || analysis.source_messages)
    ? analysis.sourceMessages || analysis.source_messages
    : [];
  const candidates = [analysis.summary, fallback, ...sourceMessages]
    .map((value) => compactUserFacingText(value))
    .filter(Boolean)
    .filter((value) => !/\b(activeJobId|activeIssueNumber|previewUrl|slackSessionId|sessionKey)\b/i.test(value));

  return candidates[0] || '已记录你的个人网站需求。';
}

function userFacingSlackTitle(analysis = {}) {
  const title = compactUserFacingText(analysis.title || '');
  if (title) return title.slice(0, 80);
  const summary = userFacingSlackSummary(analysis);
  return summary.length > 48 ? `${summary.slice(0, 45)}...` : summary;
}

export function slackIssueConfirmationText(slackAgentAnalysis = {}) {
  const summary = userFacingSlackSummary(slackAgentAnalysis);
  const site = String(slackAgentAnalysis.siteSlug || slackAgentAnalysis.site_slug || 'profile').trim();
  const title = userFacingSlackTitle(slackAgentAnalysis);
  const lines = ['我整理好了，先等你确认。', '', `标题：${title}`, `站点：${site}`];
  if (summary) lines.push('', `需求：${summary}`);
  lines.push('', '下一步：点击「确认创建发布任务」。');
  return lines.join('\n');
}

export function slackIssueConfirmationBlocks(slackSession, slackAgentAnalysis = {}, options = {}) {
  const sessionId = slackSession?.id || '';
  const title = userFacingSlackTitle(slackAgentAnalysis);
  const site = String(slackAgentAnalysis.siteSlug || slackAgentAnalysis.site_slug || 'profile').trim();
  const summary = userFacingSlackSummary(slackAgentAnalysis);
  const status = options.statusLabel || '待确认';
  const contextText = options.contextText || '点击确认后，我会创建 issue 并开始生成 PR。';
  const fields = [
    {
      type: 'mrkdwn',
      text: `*站点*\n${site}`,
    },
    {
      type: 'mrkdwn',
      text: `*状态*\n${status}`,
    },
  ];

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: options.header || '确认发布需求' },
    },
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*${title}*\n${summary.slice(0, 900)}`,
      },
    },
    {
      type: 'section',
      fields,
    },
    {
      type: 'context',
      elements: [
        {
          type: 'mrkdwn',
          text: contextText,
        },
      ],
    },
  ];

  if (options.actions !== false) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '确认创建发布任务' },
          style: 'primary',
          action_id: 'pages_confirm_issue',
          value: sessionId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '继续补充需求' },
          action_id: 'pages_continue_modifying',
          value: sessionId,
        },
        {
          type: 'button',
          text: { type: 'plain_text', text: '关闭会话' },
          style: 'danger',
          action_id: 'pages_close_session',
          value: sessionId,
        },
      ],
    });
  }

  return blocks;
}

export function slackIssueConfirmedText(slackAgentAnalysis = {}) {
  const title = userFacingSlackTitle(slackAgentAnalysis);
  return `已确认：${title}\n我会开始创建 issue，后续进度会在当前对话更新。`;
}

export function slackIssueConfirmedBlocks(slackSession, slackAgentAnalysis = {}) {
  return slackIssueConfirmationBlocks(slackSession, slackAgentAnalysis, {
    header: '发布需求已确认',
    statusLabel: '已确认',
    contextText: '我会开始创建 issue；后续请看当前对话里的发布进度卡。',
    actions: false,
  });
}

export function slackIssueWaitingMoreText(slackAgentAnalysis = {}) {
  const title = userFacingSlackTitle(slackAgentAnalysis);
  return `继续补充：${title}\n直接在当前对话回复新的要求，我会重新整理。`;
}

export function slackIssueWaitingMoreBlocks(slackSession, slackAgentAnalysis = {}) {
  return slackIssueConfirmationBlocks(slackSession, slackAgentAnalysis, {
    header: '继续补充需求',
    statusLabel: '等待补充',
    contextText: '直接在当前对话回复新的要求；确认前不会创建 issue。',
  });
}

export function draftAnalysisFromMemory(memory = {}) {
  const requirements = memory.requirements && typeof memory.requirements === 'object' ? memory.requirements : {};
  return {
    ...requirements,
    intent: requirements.intent || 'create_or_update_site',
    summary: requirements.summary || memory.summary || '',
    title: requirements.title || memory.summary || 'Slack publishing request',
    siteSlug: requirements.siteSlug || requirements.site_slug || 'profile',
    approvalMode: requirements.approvalMode || requirements.approval_mode || 'manual_required',
    needsClarification: Boolean(requirements.needsClarification || requirements.needs_clarification),
  };
}

export function hasConfirmableDraft(analysis = {}) {
  return (
    CREATE_JOB_INTENTS.has(analysis.intent) &&
    !analysis.needsClarification &&
    Boolean(String(analysis.summary || '').trim())
  );
}

export function confirmedSlackJobBodyFromInteraction(body = {}, session, analysis = {}, requesterProfile = null) {
  const teamId = body.team?.id || body.team_id || session.teamId || 'unknown-team';
  const slackUserId = slackUserIdFromBody(body);
  const channelId = interactionChannelId(body, session);
  const threadTs = interactionThreadTs(body, session);
  const messageTs = body.message?.ts || body.container?.message_ts || threadTs || null;
  const draftHash = stableSlugHash(JSON.stringify({ analysis, sessionId: session.id }));

  return {
    team_id: teamId,
    trigger_id: body.trigger_id || `confirm:${session.id}`,
    idempotencyKey: `slack-confirm:${session.id}:${draftHash}`,
    event: {
      type: 'block_actions',
      user: slackUserId,
      channel: channelId,
      channel_type: interactionChannelType(channelId, session),
      ts: messageTs,
      thread_ts: threadTs,
      text: analysis.summary || analysis.title || 'Slack confirmed publishing request',
    },
    intake: {
      action: 'confirm_issue',
      shouldCreateJob: true,
      text: analysis.summary || analysis.title || '',
    },
    slackAgentAnalysis: analysis,
    slackSession: session,
    requesterProfile,
  };
}
