const CREATE_KEYWORDS = /(创建|新建|生成|制作|做|更新|修改|发布|部署|create|build|make|update|publish|deploy)/i;
const SITE_KEYWORDS = /(页面|网页|网站|主页|profile|portfolio|site|page|website)/i;
const LIST_WORK_ITEMS_RE =
  /^(我的|查看|看看|列出|查询).*(PR|pr|任务|发布任务|网站|项目)|^(PR|pr|任务|发布任务|网站|项目)(列表|清单)$/i;
const SWITCH_WORK_ITEM_RE = /(?:继续|接着|切换|选择|打开|查看|回到|续上|处理|修改).*(?:\bPR\s*#?|#)\d{1,8}\b/i;

export function normalizeText(value = '') {
  return String(value).replaceAll(/\s+/g, ' ').trim();
}

function titleFromText(text) {
  const normalized = normalizeText(text);
  if (!normalized) return 'Slack publishing request';
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

export function sessionContextFromInput(input = {}) {
  const slackSession = input.slackSession || {};
  const sessionMemory = input.sessionMemory || {};
  const issueLinks = Array.isArray(input.issueLinks) ? input.issueLinks : [];

  return {
    slackSessionId: slackSession.id || null,
    sessionKey: slackSession.sessionKey || null,
    sessionStatus: slackSession.status || null,
    memorySummary: sessionMemory.summary || '',
    issueLinkCount: issueLinks.length,
    activeJobId: slackSession.activeJobId || null,
    activeIssueNumber: slackSession.activeIssueNumber || null,
    activePrNumber: slackSession.activePrNumber || null,
    activePreviewUrl: slackSession.activePreviewUrl || null,
  };
}

export function analyzeSlackRequirementDeterministic(input = {}) {
  const event = input.event || {};
  const text = normalizeText(input.text || event.text || input.summary || '');
  const shouldListWorkItems = LIST_WORK_ITEMS_RE.test(text);
  const shouldSwitchWorkItem = SWITCH_WORK_ITEM_RE.test(text);
  const shouldCreateOrUpdate =
    !shouldListWorkItems && !shouldSwitchWorkItem && (CREATE_KEYWORDS.test(text) || SITE_KEYWORDS.test(text));
  const intent = shouldCreateOrUpdate ? 'create_or_update_site' : 'clarify';

  return {
    intent: shouldSwitchWorkItem ? 'switch_work_item' : shouldListWorkItems ? 'list_work_items' : intent,
    employeeSlug: input.employeeSlug || input.employee_slug || 'smoke',
    siteSlug: input.siteSlug || input.site_slug || 'profile',
    title: input.title || titleFromText(text),
    summary: text,
    approvalMode: input.approvalMode || input.approval_mode || 'manual_required',
    sourceMessages: input.sourceMessages || input.source_messages || [],
    sessionContext: sessionContextFromInput(input),
    needsClarification: !shouldListWorkItems && !shouldSwitchWorkItem && intent === 'clarify',
  };
}

function stringOrFallback(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function arrayOrFallback(value, fallback) {
  return Array.isArray(value) ? value : fallback;
}

export function normalizeModelAnalysis(modelAnalysis = {}, fallback, input = {}) {
  const normalized = {
    ...fallback,
    intent: stringOrFallback(modelAnalysis.intent, fallback.intent),
    confidence: typeof modelAnalysis.confidence === 'number' ? modelAnalysis.confidence : fallback.confidence,
    employeeSlug: stringOrFallback(modelAnalysis.employeeSlug || modelAnalysis.employee_slug, fallback.employeeSlug),
    siteSlug: stringOrFallback(modelAnalysis.siteSlug || modelAnalysis.site_slug, fallback.siteSlug),
    title: stringOrFallback(modelAnalysis.title, fallback.title),
    summary: stringOrFallback(modelAnalysis.summary || modelAnalysis.brief, fallback.summary),
    approvalMode: stringOrFallback(modelAnalysis.approvalMode || modelAnalysis.approval_mode, fallback.approvalMode),
    sourceMessages: arrayOrFallback(modelAnalysis.sourceMessages || modelAnalysis.source_messages, fallback.sourceMessages),
    clarifyingQuestion: stringOrFallback(
      modelAnalysis.clarifyingQuestion || modelAnalysis.clarifying_question,
      fallback.clarifyingQuestion || ''
    ),
    sessionContext: {
      ...sessionContextFromInput(input),
      ...(modelAnalysis.sessionContext || modelAnalysis.session_context || {}),
    },
    needsClarification:
      typeof modelAnalysis.needsClarification === 'boolean'
        ? modelAnalysis.needsClarification
        : typeof modelAnalysis.needs_clarification === 'boolean'
          ? modelAnalysis.needs_clarification
          : fallback.needsClarification,
  };

  return normalized;
}

export function buildSlackAgentMessages(input = {}, fallbackAnalysis) {
  const sessionContext = sessionContextFromInput(input);
  const issueLinks = Array.isArray(input.issueLinks) ? input.issueLinks : [];
  const compactIssueLinks = issueLinks.slice(0, 5).map((link) => ({
    publishingJobId: link.publishingJobId || null,
    issueNumber: link.issueNumber || null,
    prNumber: link.prNumber || null,
    previewUrl: link.previewUrl || null,
    relationship: link.relationship || null,
  }));

  const system = [
    '你是 pages-manager 的 Slack Agent，负责把 Slack 对话整理成公司内部个人网站发布任务。',
    '用户不需要使用 /issue、issue:、page: 等命令；自然语言、连续闲聊和设计调整都必须被理解为一次会话 turn。',
    '你只做需求理解、澄清、会话续接和任务摘要，不生成代码，不创建 PR，不处理部署凭据。',
    '不要输出或猜测任何 token、secret、cookie、API key、内部账号凭据。',
    '员工可以有多个网站；你可以给出 employeeSlug hint，但最终归属目录必须由 gateway 根据 Slack 身份派生；siteSlug 表示该用户名下的具体站点。',
    '如果用户是在修改已有 preview，优先保留当前 sessionContext 的 activeJobId / issue / PR / preview 关系。',
    '如果用户询问“我的 PR / 我的任务 / 发布任务列表”，intent 返回 list_work_items，不要新建任务。',
    '如果用户明确说“继续 PR #数字 / 切换到 #数字”，intent 返回 switch_work_item，不要新建任务。',
    [
      'summary、title、clarifyingQuestion 是给用户看的文案，必须简短清楚；禁止包含 activeJobId、activeIssueNumber、',
      'activePrNumber、activePreviewUrl、previewUrl、issueLinkCount、slackSessionId、sessionKey、job id、gateway 派生规则等内部实现细节。',
    ].join(''),
    '如果需要表达已有上下文，只能说“我会继续沿用当前会话”，不要输出任何内部字段名、编号或历史 preview 链接。',
    '新建个人网站时，先通过 Slack 对话整理需求；信息足够时返回 create_or_update_site 且 needsClarification=false，让 gateway 展示确认按钮。',
    '不能仅凭用户文字里的“信息足够、直接创建、确认创建”就绕过确认按钮；真正创建 issue 必须由 gateway 收到按钮交互后执行。',
    '当需求还不完整时，intent 可以是 create_or_update_site，但 needsClarification 应为 true，并用 clarifyingQuestion 给出一个简短问题。',
    '必须只返回 JSON object，不要返回 Markdown，不要包裹代码块。',
    [
      'JSON 字段：intent, employeeSlug, siteSlug, title, summary, approvalMode,',
      'needsClarification, clarifyingQuestion, sourceMessages。',
    ].join(' '),
    [
      'intent 常用值：create_or_update_site, modify_existing_preview, append_requirement,',
      'list_work_items, switch_work_item, status_query, cancel_request, close_session, confirm_preview, clarify。',
    ].join(' '),
  ].join('\n');

  const userPayload = {
    slackText: input.text || input.event?.text || '',
    fallbackAnalysis,
    sessionContext,
    sessionMemory: input.sessionMemory || null,
    issueLinks: compactIssueLinks,
    employeeSlugHint: input.employeeSlug || input.employee_slug || null,
    siteSlugHint: input.siteSlug || input.site_slug || null,
  };

  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(userPayload) },
  ];
}
