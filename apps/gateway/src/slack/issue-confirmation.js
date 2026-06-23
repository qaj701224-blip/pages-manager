import { stableSlugHash } from './job-input.js';
import { slackUserIdFromBody } from './session.js';
import { compactUserFacingText } from './text.js';
import { interactionChannelId, interactionChannelType, interactionThreadTs } from './delivery.js';
import { CREATE_JOB_INTENTS } from './intents.js';
import { normalizePlatformAreas, normalizePlatformIssueType, normalizePlatformRisk } from './platform-input.js';

const INTERNAL_PLATFORM_TERMS = new RegExp(
  [
    '\\b(?:activeJobId|activeIssueNumber|previewUrl|slackSessionId|sessionKey|workItemKind',
    '|PublishingJob|GitHub webhook|status card|gateway|worker|mysql)\\b',
    '状态卡',
  ].join('|'),
  'i'
);

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

export function userFacingPlatformSummary(analysis = {}, fallback = '') {
  const sourceMessages = Array.isArray(analysis.sourceMessages || analysis.source_messages)
    ? analysis.sourceMessages || analysis.source_messages
    : [];
  const candidates = [analysis.summary, fallback, ...sourceMessages]
    .map((value) => compactUserFacingText(value))
    .filter(Boolean)
    .filter((value) => !INTERNAL_PLATFORM_TERMS.test(value));

  return candidates[0] || '已记录 pages-manager 平台改造需求。';
}

export function userFacingPlatformTitle(analysis = {}) {
  const title = compactUserFacingText(analysis.title || '');
  if (title && !INTERNAL_PLATFORM_TERMS.test(title)) return title.slice(0, 100);
  const summary = userFacingPlatformSummary(analysis);
  return summary.length > 60 ? `${summary.slice(0, 57)}...` : summary;
}

export function platformIssueTypeLabel(issueType) {
  const labels = {
    'type:dev': '功能改造',
    'type:bug': '问题修复',
    'type:docs': '文档调整',
    'type:feedback': '反馈收集',
    'type:question': '问题咨询',
    'type:ci': '自动化流程调整',
    'type:ops': '运维配置调整',
    'type:security': '安全相关调整',
  };
  return labels[issueType] || '平台改造';
}

export function platformRiskLabel(risk) {
  const labels = {
    'risk:low': '低',
    'risk:medium': '中',
    'risk:high': '高，需要人工确认',
  };
  return labels[risk] || '中';
}

export function platformAreaLabel(area) {
  const labels = {
    'area:platform': '平台能力',
    'area:github': '代码协作',
    'area:slack': 'Slack 入口',
    'area:ci': '自动化流程',
    'area:ops': '运维配置',
    'area:docs': '文档',
    'area:security': '安全',
    'area:db': '数据存储',
    'area:gateway': '平台入口',
    'area:worker': '后台处理',
  };
  return labels[area] || '平台能力';
}

function platformAreaLabels(areas = []) {
  const labels = areas.map((area) => platformAreaLabel(area));
  return Array.from(new Set(labels));
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

export function slackPlatformIssueConfirmationText(slackAgentAnalysis = {}) {
  const title = userFacingPlatformTitle(slackAgentAnalysis);
  const summary = userFacingPlatformSummary(slackAgentAnalysis);
  const issueType = normalizePlatformIssueType(slackAgentAnalysis.issueType || slackAgentAnalysis.issue_type);
  const risk = normalizePlatformRisk(slackAgentAnalysis.risk, issueType);
  const areas = normalizePlatformAreas(
    slackAgentAnalysis.areas || slackAgentAnalysis.areaLabels || slackAgentAnalysis.area_labels
  );
  const areaLabels = platformAreaLabels(areas);
  const lines = [
    '我整理好了，先等你确认。',
    '',
    `标题：${title}`,
    `类型：${platformIssueTypeLabel(issueType)}`,
    `范围：${areaLabels.join('、')}`,
    `风险：${platformRiskLabel(risk)}`,
    '',
    `需求：${summary}`,
    '',
    risk === 'risk:high'
      ? '下一步：点击「确认创建平台需求」后，会先创建 GitHub issue，并等待人工确认后再进入自动开发。'
      : '下一步：点击「确认创建平台需求」后，会创建 GitHub issue，并按策略进入后续处理。',
  ];
  return lines.join('\n');
}

export function slackPlatformIssueConfirmationBlocks(slackSession, slackAgentAnalysis = {}, options = {}) {
  const sessionId = slackSession?.id || '';
  const title = userFacingPlatformTitle(slackAgentAnalysis);
  const summary = userFacingPlatformSummary(slackAgentAnalysis);
  const issueType = normalizePlatformIssueType(slackAgentAnalysis.issueType || slackAgentAnalysis.issue_type);
  const risk = normalizePlatformRisk(slackAgentAnalysis.risk, issueType);
  const areas = normalizePlatformAreas(
    slackAgentAnalysis.areas || slackAgentAnalysis.areaLabels || slackAgentAnalysis.area_labels
  );
  const areaLabels = platformAreaLabels(areas);
  const status = options.statusLabel || '待确认';
  const contextText =
    options.contextText ||
    (risk === 'risk:high'
      ? '确认后会先创建 GitHub issue；高风险需求需要人工确认后再进入自动开发。'
      : '确认后会创建 GitHub issue；后续进度会在当前对话更新。');

  const blocks = [
    {
      type: 'header',
      text: { type: 'plain_text', text: options.header || '确认平台需求' },
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
      fields: [
        { type: 'mrkdwn', text: `*类型*\n${platformIssueTypeLabel(issueType)}` },
        { type: 'mrkdwn', text: `*状态*\n${status}` },
        { type: 'mrkdwn', text: `*范围*\n${areaLabels.join('、')}` },
        { type: 'mrkdwn', text: `*风险*\n${platformRiskLabel(risk)}` },
      ],
    },
    {
      type: 'context',
      elements: [{ type: 'mrkdwn', text: contextText }],
    },
  ];

  if (options.actions !== false) {
    blocks.push({
      type: 'actions',
      elements: [
        {
          type: 'button',
          text: { type: 'plain_text', text: '确认创建平台需求' },
          style: 'primary',
          action_id: 'pages_confirm_platform_issue',
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

export function slackPlatformIssueConfirmedText(slackAgentAnalysis = {}) {
  const title = userFacingPlatformTitle(slackAgentAnalysis);
  return `已确认：${title}\n我会开始创建 GitHub issue，后续进度会在当前对话更新。`;
}

export function slackPlatformIssueConfirmedBlocks(slackSession, slackAgentAnalysis = {}) {
  return slackPlatformIssueConfirmationBlocks(slackSession, slackAgentAnalysis, {
    header: '平台需求已确认',
    statusLabel: '已确认',
    contextText: '我会开始创建 GitHub issue；后续请看当前对话里的进度消息。',
    actions: false,
  });
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

export function hasConfirmablePlatformDraft(analysis = {}) {
  return (
    (analysis.lane === 'platform-dev' || analysis.lane === 'platform_dev' || analysis.intent === 'create_platform_issue') &&
    !analysis.needsClarification &&
    Boolean(String(analysis.summary || '').trim())
  );
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

export function confirmedSlackPlatformBodyFromInteraction(body = {}, session, analysis = {}, requesterProfile = null) {
  const teamId = body.team?.id || body.team_id || session.teamId || 'unknown-team';
  const slackUserId = slackUserIdFromBody(body);
  const channelId = interactionChannelId(body, session);
  const threadTs = interactionThreadTs(body, session);
  const messageTs = body.message?.ts || body.container?.message_ts || threadTs || null;
  const draftHash = stableSlugHash(JSON.stringify({ analysis, sessionId: session.id }));

  return {
    team_id: teamId,
    trigger_id: body.trigger_id || `confirm-platform:${session.id}`,
    idempotencyKey: `slack-confirm-platform:${session.id}:${draftHash}`,
    event: {
      type: 'block_actions',
      user: slackUserId,
      channel: channelId,
      channel_type: interactionChannelType(channelId, session),
      ts: messageTs,
      thread_ts: threadTs,
      text: analysis.summary || analysis.title || 'Slack confirmed platform request',
    },
    intake: {
      action: 'confirm_platform_issue',
      shouldCreateJob: false,
      text: analysis.summary || analysis.title || '',
    },
    slackAgentAnalysis: {
      ...analysis,
      lane: 'platform-dev',
      intent: analysis.intent || 'create_platform_issue',
    },
    slackSession: session,
    requesterProfile,
  };
}
