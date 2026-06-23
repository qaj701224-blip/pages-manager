const CREATE_KEYWORDS = /(创建|新建|生成|制作|做|更新|修改|发布|部署|create|build|make|update|publish|deploy)/i;
const SITE_KEYWORDS = /(页面|网页|网站|主页|profile|portfolio|site|page|website)/i;
const PLATFORM_KEYWORDS =
  /(pages-manager|平台|仓库|repo|代码|PR|issue|label|template|模版|gateway|worker|slack-agent|slack-notifier|Slack|GitHub|webhook|CI|CD|workflow|Actions|MySQL|数据库|状态机|权限|review|rebase|branch|分支|k8s|ECS|部署脚本|文档|架构)/i; // eslint-disable-line max-len
const LIST_WORK_ITEMS_RE =
  /^(我的|查看|看看|列出|查询).*(PR|pr|任务|发布任务|网站|项目)|^(PR|pr|任务|发布任务|网站|项目)(列表|清单)$/i;
const SWITCH_WORK_ITEM_RE =
  /(?:继续|接着|切换|选择|打开|查看|回到|续上|处理|修改).*(?:(?:\bPR|pull\s*request|issue|issues|需求|任务)\s*#?|#)\d{1,8}\b/i;
const REOPEN_WORK_ITEM_RE =
  /(?:重新打开|恢复|重开|reopen).*(?:(?:\bPR|pull\s*request|issue|issues|需求|任务)\s*#?|#)\d{1,8}\b/i;
const DIAGNOSIS_QUERY_RE =
  /(为什么|为啥|原因|失败|没成功|没有成功|没出来|卡住|卡在哪|卡在|诊断|排查|查一下|看一下|重试|查.*(?:日志|log|workflow|actions))/i;
const ISSUE_NUMBER_RE = /(?:issue|issues|需求|任务)\s*#?\s*(\d{1,8})\b/i;
const PR_NUMBER_RE = /\b(?:PR|pull\s*request|pull-request|pullrequest)\s*#?\s*(\d{1,8})\b/i;
const BARE_WORK_ITEM_NUMBER_RE = /#(\d{1,8})\b/;
const UNSUPPORTED_DESTRUCTIVE_INTENT = 'unsupported_destructive_request';
const UNSUPPORTED_BULK_DESTRUCTIVE_RE = new RegExp(
  [
    '(?:关闭|关掉|删除|删掉|清理|清空|取消|归档|close|delete|remove|cancel|archive).*(?:全部|所有|我名下|我的|all|every).*(?:issues?|PR|pr|任务|发布任务)',
    '(?:全部|所有|我名下|我的|all|every).*(?:issues?|PR|pr|任务|发布任务).*(?:关闭|关掉|删除|删掉|清理|清空|取消|归档|close|delete|remove|cancel|archive)',
  ].join('|'),
  'i'
);
const CLOSED_WORK_ITEM_QUERY_RE =
  /(?:已关闭|关闭的|关掉的|被关闭|已取消|取消的|已失败|失败的|归档|closed|cancelled|canceled|failed|inactive)/i;
const ALL_WORK_ITEM_QUERY_RE = /(?:历史|全部|所有|所有的|全量|all|history|historical)/i;

function isUnsupportedBulkDestructiveRequest(text = '') {
  return UNSUPPORTED_BULK_DESTRUCTIVE_RE.test(String(text || ''));
}

function unsupportedBulkDestructiveQuestion() {
  return '我不能批量关闭或删除你名下的 GitHub issue / PR / 发布任务。请先查看可继续任务，或明确指定一个 PR / issue。';
}

export function normalizeText(value = '') {
  return String(value).replaceAll(/\s+/g, ' ').trim();
}

function titleFromText(text) {
  const normalized = normalizeText(text);
  if (!normalized) return 'Slack publishing request';
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function workItemStateFromText(text = '') {
  const value = String(text || '');
  if (CLOSED_WORK_ITEM_QUERY_RE.test(value)) return 'closed';
  if (ALL_WORK_ITEM_QUERY_RE.test(value)) return 'all';
  return 'active';
}

function workItemReferenceFromText(text = '') {
  const value = String(text || '');
  const issueMatch = value.match(ISSUE_NUMBER_RE);
  if (issueMatch) return { kind: 'issue', number: Number(issueMatch[1]) };
  const prMatch = value.match(PR_NUMBER_RE);
  if (prMatch) return { kind: 'pr', number: Number(prMatch[1]) };
  const bareMatch = value.match(BARE_WORK_ITEM_NUMBER_RE);
  if (bareMatch) return { kind: 'unknown', number: Number(bareMatch[1]) };
  return null;
}

function toolCallForIntent(intent, text = '') {
  if (intent === 'list_work_items') return { name: 'list_my_work_items', args: { state: workItemStateFromText(text) } };
  if (intent === 'switch_work_item') {
    const reference = workItemReferenceFromText(text);
    return { name: 'switch_work_item', args: reference ? { kind: reference.kind, number: reference.number } : {} };
  }
  if (intent === 'reopen_work_item') {
    const reference = workItemReferenceFromText(text);
    return { name: 'reopen_work_item', args: reference ? { kind: reference.kind, number: reference.number } : {} };
  }
  if (intent === 'diagnose_work_item') return { name: 'diagnose_current_work_item', args: { timeWindowMinutes: 30 } };
  if (intent === 'status_query') return { name: 'get_current_status', args: {} };
  if (intent === 'close_session') return { name: 'close_session', args: {} };
  if (intent === 'cancel_request') return { name: 'cancel_request', args: {} };
  if (intent === UNSUPPORTED_DESTRUCTIVE_INTENT) return { name: 'unsupported_destructive_request', args: {} };
  if (['modify_existing_preview', 'append_requirement'].includes(intent)) return { name: 'record_followup', args: {} };
  if (['create_or_update_site', 'new_site_request', 'create_site', 'update_site'].includes(intent)) {
    return { name: 'confirm_create_issue', args: {} };
  }
  if (['create_platform_issue', 'platform_dev', 'platform_feedback'].includes(intent)) {
    return { name: 'confirm_platform_issue', args: {} };
  }
  return null;
}

function inferPlatformIssueType(text = '') {
  if (/安全|secret|token|权限|auth|security/i.test(text)) return 'type:security';
  if (/\b(CI|CD)\b|workflow|Actions|构建|测试|lint|\bdeploy\b|部署/i.test(text)) return 'type:ci';
  if (/\bk8s\b|\bECS\b|\bDocker\b|\bACK\b|运维|\bops\b/i.test(text)) return 'type:ops';
  if (/bug|报错|失败|异常|修复|fix/i.test(text)) return 'type:bug';
  if (/文档|架构|说明|宣讲|doc/i.test(text)) return 'type:docs';
  if (/反馈|建议|意见|想法|question|问题/i.test(text)) return 'type:feedback';
  return 'type:dev';
}

function inferPlatformAreas(text = '') {
  const entries = [
    [/gateway|网关|控制面/i, 'area:gateway'],
    [/worker|调度/i, 'area:worker'],
    [/GitHub|webhook|\bPR\b|issue|Actions|workflow/i, 'area:github'],
    [/\b(CI|CD)\b|workflow|Actions|构建|测试|\bdeploy\b/i, 'area:ci'],
    [/MySQL|数据库|schema|迁移/i, 'area:db'],
    [/slack-agent|Slack Agent|需求整理/i, 'area:slack-agent'],
    [/slack-notifier|通知|消息/i, 'area:slack-notifier'],
    [/Slack/i, 'area:slack'],
    [/文档|架构|说明|宣讲|doc/i, 'area:docs'],
    [/\bk8s\b|\bECS\b|\bDocker\b|\bACK\b|运维/i, 'area:ops'],
  ];
  const areas = entries.filter(([pattern]) => pattern.test(text)).map(([, label]) => label);
  return areas.length ? [...new Set(areas)] : ['area:platform'];
}

function inferPlatformRisk(text = '', issueType = 'type:dev') {
  if (['type:ci', 'type:ops', 'type:security'].includes(issueType)) return 'risk:high';
  if (/生产|prod|production|token|secret|权限|部署|k8s|ECS|workflow|Actions|数据库|schema|迁移/i.test(text)) {
    return 'risk:high';
  }
  if (/gateway|worker|GitHub|Slack|状态机|数据库|review|PR/i.test(text)) return 'risk:medium';
  return 'risk:low';
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
  const isUnsupportedBulkDestructive = isUnsupportedBulkDestructiveRequest(text);
  const shouldListWorkItems = !isUnsupportedBulkDestructive && LIST_WORK_ITEMS_RE.test(text);
  const shouldReopenWorkItem = !isUnsupportedBulkDestructive && REOPEN_WORK_ITEM_RE.test(text);
  const shouldSwitchWorkItem = SWITCH_WORK_ITEM_RE.test(text);
  const shouldDiagnoseWorkItem =
    !isUnsupportedBulkDestructive && !shouldListWorkItems && !shouldSwitchWorkItem && DIAGNOSIS_QUERY_RE.test(text);
  const shouldCreateOrUpdate =
    !isUnsupportedBulkDestructive &&
    !shouldListWorkItems &&
    !shouldSwitchWorkItem &&
    !shouldDiagnoseWorkItem &&
    (CREATE_KEYWORDS.test(text) || SITE_KEYWORDS.test(text));
  const shouldCreatePlatform =
    !isUnsupportedBulkDestructive &&
    !shouldListWorkItems &&
    !shouldSwitchWorkItem &&
    !shouldDiagnoseWorkItem &&
    PLATFORM_KEYWORDS.test(text) &&
    (CREATE_KEYWORDS.test(text) || /(需求|建议|反馈|优化|改造|支持|接入|流程|能力)/i.test(text));
  const intent = shouldCreatePlatform ? 'create_platform_issue' : shouldCreateOrUpdate ? 'create_or_update_site' : 'clarify';
  const finalIntent = isUnsupportedBulkDestructive
    ? UNSUPPORTED_DESTRUCTIVE_INTENT
    : shouldReopenWorkItem
      ? 'reopen_work_item'
      : shouldSwitchWorkItem
        ? 'switch_work_item'
        : shouldListWorkItems
          ? 'list_work_items'
          : shouldDiagnoseWorkItem
            ? 'diagnose_work_item'
            : intent;

  return {
    lane: shouldCreatePlatform ? 'platform-dev' : shouldCreateOrUpdate ? 'site-publishing' : 'unknown',
    intent: finalIntent,
    employeeSlug: input.employeeSlug || input.employee_slug || 'smoke',
    siteSlug: input.siteSlug || input.site_slug || 'profile',
    title: input.title || titleFromText(text),
    summary: text,
    issueType: shouldCreatePlatform ? inferPlatformIssueType(text) : undefined,
    areas: shouldCreatePlatform ? inferPlatformAreas(text) : undefined,
    risk: shouldCreatePlatform ? inferPlatformRisk(text, inferPlatformIssueType(text)) : undefined,
    agentEligible: shouldCreatePlatform ? !['type:feedback', 'type:question'].includes(inferPlatformIssueType(text)) : undefined,
    requiresHumanGate: shouldCreatePlatform ? inferPlatformRisk(text, inferPlatformIssueType(text)) === 'risk:high' : undefined,
    workItemState: shouldListWorkItems ? workItemStateFromText(text) : undefined,
    toolCall: toolCallForIntent(finalIntent, text),
    approvalMode: input.approvalMode || input.approval_mode || 'manual_required',
    sourceMessages: input.sourceMessages || input.source_messages || [],
    sessionContext: sessionContextFromInput(input),
    needsClarification:
      !isUnsupportedBulkDestructive &&
      !shouldListWorkItems &&
      !shouldSwitchWorkItem &&
      !shouldDiagnoseWorkItem &&
      intent === 'clarify',
    clarifyingQuestion: isUnsupportedBulkDestructive ? unsupportedBulkDestructiveQuestion() : undefined,
  };
}

function stringOrFallback(value, fallback) {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function arrayOrFallback(value, fallback) {
  return Array.isArray(value) ? value : fallback;
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function normalizeToolCall(value, fallbackToolCall = null) {
  const raw = objectOrNull(value);
  if (!raw) return fallbackToolCall || null;
  const name = stringOrFallback(raw.name || raw.tool || raw.action, fallbackToolCall?.name || '');
  if (!name) return fallbackToolCall || null;
  const args = objectOrNull(raw.args || raw.arguments || raw.input) || fallbackToolCall?.args || {};
  return { name, args };
}

export function normalizeModelAnalysis(modelAnalysis = {}, fallback, input = {}) {
  const modelToolCall =
    modelAnalysis.toolCall ||
    modelAnalysis.tool_call ||
    (modelAnalysis.tool || modelAnalysis.toolName || modelAnalysis.tool_name
      ? {
          name: modelAnalysis.tool || modelAnalysis.toolName || modelAnalysis.tool_name,
          args: modelAnalysis.toolArgs || modelAnalysis.tool_args || {},
        }
      : null);
  const normalized = {
    ...fallback,
    intent: stringOrFallback(modelAnalysis.intent, fallback.intent),
    lane: stringOrFallback(modelAnalysis.lane, fallback.lane || 'unknown'),
    confidence: typeof modelAnalysis.confidence === 'number' ? modelAnalysis.confidence : fallback.confidence,
    employeeSlug: stringOrFallback(modelAnalysis.employeeSlug || modelAnalysis.employee_slug, fallback.employeeSlug),
    siteSlug: stringOrFallback(modelAnalysis.siteSlug || modelAnalysis.site_slug, fallback.siteSlug),
    title: stringOrFallback(modelAnalysis.title, fallback.title),
    summary: stringOrFallback(modelAnalysis.summary || modelAnalysis.brief, fallback.summary),
    issueType: stringOrFallback(modelAnalysis.issueType || modelAnalysis.issue_type, fallback.issueType || ''),
    areas: arrayOrFallback(modelAnalysis.areas || modelAnalysis.areaLabels || modelAnalysis.area_labels, fallback.areas || []),
    risk: stringOrFallback(modelAnalysis.risk, fallback.risk || ''),
    agentEligible:
      typeof modelAnalysis.agentEligible === 'boolean'
        ? modelAnalysis.agentEligible
        : typeof modelAnalysis.agent_eligible === 'boolean'
          ? modelAnalysis.agent_eligible
          : fallback.agentEligible,
    requiresHumanGate:
      typeof modelAnalysis.requiresHumanGate === 'boolean'
        ? modelAnalysis.requiresHumanGate
        : typeof modelAnalysis.requires_human_gate === 'boolean'
          ? modelAnalysis.requires_human_gate
          : fallback.requiresHumanGate,
    workItemState: stringOrFallback(
      modelAnalysis.workItemState || modelAnalysis.work_item_state,
      fallback.workItemState || workItemStateFromText(input.text || input.event?.text || fallback.summary || '')
    ),
    toolCall: normalizeToolCall(modelToolCall, fallback.toolCall || toolCallForIntent(fallback.intent, fallback.summary)),
    visibleReply: stringOrFallback(
      modelAnalysis.visibleReply || modelAnalysis.visible_reply,
      fallback.visibleReply || fallback.visible_reply || ''
    ),
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

export function visibleSlackAgentReply(analysis = {}) {
  const intent = analysis.intent || 'clarify';
  if (analysis.visibleReply || analysis.visible_reply) return analysis.visibleReply || analysis.visible_reply;

  if (analysis.needsClarification) {
    return (
      analysis.clarifyingQuestion ||
      analysis.clarifying_question ||
      analysis.summary ||
      '我需要再确认一个信息，然后再继续整理需求。'
    );
  }

  if (intent === UNSUPPORTED_DESTRUCTIVE_INTENT) {
    return analysis.clarifyingQuestion || analysis.summary || unsupportedBulkDestructiveQuestion();
  }

  if (intent === 'list_work_items') return '我来整理你当前可以继续处理的发布任务。';
  if (intent === 'switch_work_item') return '我会尝试切换到你指定的任务。';
  if (intent === 'reopen_work_item') return '我会尝试恢复你指定的 Issue 或 PR。';
  if (intent === 'status_query') return '我来查询当前发布进度。';
  if (intent === 'close_session') return '收到，我会关闭当前会话。';
  if (intent === 'cancel_request') return '收到，我先记录取消意图。';

  if (['create_platform_issue', 'platform_dev', 'platform_feedback'].includes(intent)) {
    return analysis.summary ? `我已整理好这轮平台需求：${analysis.summary}` : '我已整理好这轮平台需求。';
  }

  if (['create_or_update_site', 'modify_existing_preview', 'append_requirement'].includes(intent)) {
    return analysis.summary ? `我已整理好这轮需求：${analysis.summary}` : '我已整理好这轮需求。';
  }

  return analysis.summary || '我已记录这轮消息。';
}

export function buildSlackAgentTurn(input = {}, analysis = {}) {
  const agentRun = input.agentRun || {};
  const slackSession = input.slackSession || {};
  const agentRunId = input.agentRunId || input.agent_run_id || agentRun.id || null;
  const slackSessionId = input.slackSessionId || input.slack_session_id || slackSession.id || null;
  const visibleText = visibleSlackAgentReply(analysis);
  const base = {
    agentRunId,
    slackSessionId,
    visibleToUser: true,
  };

  return {
    agentRunId,
    slackSessionId,
    visibleText,
    events: [
      { ...base, type: 'reply_started', sequence: 1 },
      { ...base, type: 'reply_delta', sequence: 2, text: visibleText },
      { ...base, type: 'analysis_final', sequence: 3, analysis },
      { ...base, type: 'reply_completed', sequence: 4 },
    ],
    analysis,
  };
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
    '你是 pages-manager 的 Slack Agent，负责把 Slack 对话整理成两类需求：个人站点发布，或 pages-manager 平台自身研发。',
    '用户不需要使用 /issue、issue:、page: 等命令；自然语言、连续闲聊和设计调整都必须被理解为一次会话 turn。',
    '你只做需求理解、澄清、会话续接和任务摘要，不生成代码，不创建 PR，不处理部署凭据。',
    '不要输出或猜测任何 token、secret、cookie、API key、内部账号凭据。',
    '员工可以有多个网站；你可以给出 employeeSlug hint，但最终归属目录必须由 gateway 根据 Slack 身份派生；siteSlug 表示该用户名下的具体站点。',
    '如果用户是在修改已有 preview，优先保留当前 sessionContext 的 activeJobId / issue / PR / preview 关系。',
    '如果用户询问“我的 PR / 我的任务 / 发布任务列表”，intent 返回 list_work_items，不要新建任务，并设置 toolCall.name=list_my_work_items。',
    '查询当前可继续任务时 toolCall.args.state=active；查询历史/全部时 state=all；查询已关闭/已取消/失败时 state=closed。',
    [
      '如果用户明确说“继续 PR #数字 / issue #数字 / 切换到 #数字”，intent 返回 switch_work_item，',
      '不要新建任务，并设置 toolCall.name=switch_work_item；能识别目标时把 toolCall.args.kind=pr|issue、number=数字。',
    ].join(''),
    [
      '如果用户明确说“重新打开 / 恢复 / reopen PR #数字 或 issue #数字”，intent 返回 reopen_work_item，',
      '不要新建任务，并设置 toolCall.name=reopen_work_item；无法识别具体编号时先澄清。',
    ].join(''),
    [
      '如果用户要求关闭、删除、取消“所有 / 全部 / 我名下 / 我的” GitHub issue、PR 或发布任务，',
      '这是危险批量操作；intent 必须返回 unsupported_destructive_request，不要返回 list_work_items，不要假装已执行。',
    ].join(''),
    '关闭 Slack 会话只适用于“关闭会话 / 结束对话 / 这个 preview 不用了”这类当前上下文操作；不要把“关闭所有 issue”理解为 close_session。',
    [
      'summary、title、clarifyingQuestion 是给用户看的文案，必须简短清楚；禁止包含 activeJobId、activeIssueNumber、',
      'activePrNumber、activePreviewUrl、previewUrl、issueLinkCount、slackSessionId、sessionKey、job id、gateway 派生规则等内部实现细节。',
    ].join(''),
    '如果需要表达已有上下文，只能说“我会继续沿用当前会话”，不要输出任何内部字段名、编号或历史 preview 链接。',
    '新建个人网站时，先通过 Slack 对话整理需求；信息足够时返回 create_or_update_site 且 needsClarification=false，让 gateway 展示确认按钮。',
    [
      '当用户要求修改 pages-manager 自身、Slack 流程、gateway、worker、GitHub issue/PR、CI/CD、数据库、架构文档、',
      '权限、状态机、通知、部署脚本或仓库代码时，lane 必须是 platform-dev，intent 返回 create_platform_issue，',
      'toolCall.name 返回 confirm_platform_issue。',
    ].join(''),
    'Platform Dev Lane 下必须给出 issueType、areas、risk、agentEligible、requiresHumanGate。',
    [
      'type:feedback 和 type:question 默认 agentEligible=false；type:ci、type:ops、type:security 默认',
      'risk=risk:high 且 requiresHumanGate=true。',
    ].join(' '),
    [
      '不能仅凭用户文字里的“信息足够、直接创建、确认创建”就绕过确认按钮；',
      '真正创建 issue 必须由 gateway 收到按钮交互后执行。',
    ].join(''),
    [
      '你可以通过 toolCall 告诉 gateway 执行受控操作；gateway 会自动限制当前 Slack 用户、当前 session',
      '和该用户名下的 GitHub issue / PR。',
    ].join(' '),
    [
      '当用户询问任务状态、为什么失败、为什么 Issue 后没有 PR、卡在哪一步、查日志、查 workflow、能否重试、',
      '追加诊断或转人工排查时，intent 返回 diagnose_work_item，toolCall.name 返回 diagnose_current_work_item。',
      'Slack 先返回诊断摘要和受控按钮；不要在自然语言 turn 里直接请求执行重试、追加诊断或转人工。',
      '不要输出 gateway、worker、MySQL、status card、callback、job id 或原始日志。',
    ].join(''),
    [
      'toolCall.name 可选：list_my_work_items, switch_work_item, reopen_work_item, get_current_status,',
      'diagnose_current_work_item, close_session, unsupported_destructive_request, cancel_request, record_followup,',
      'confirm_create_issue, confirm_platform_issue。',
    ].join(' '),
    [
      '不要请求查询或操作其它 Slack 用户、其它 session 或其它人的 GitHub issue / PR；',
      '即使用户这样要求，也只按当前用户权限处理。',
    ].join(''),
    [
      '当需求还不完整时，intent 可以是 create_or_update_site，但 needsClarification 应为 true，',
      '并用 clarifyingQuestion 给出一个简短问题。',
    ].join(''),
    '必须只返回 JSON object，不要返回 Markdown，不要包裹代码块。',
    [
      'JSON 字段：visibleReply, lane, intent, toolCall, workItemState, employeeSlug, siteSlug, issueType, areas, risk,',
      'agentEligible, requiresHumanGate, title, summary, approvalMode, needsClarification, clarifyingQuestion, sourceMessages。',
    ].join(' '),
    [
      'visibleReply 是 Slack 用户可见回复，必须自然、简短、可直接展示；',
      '请把 visibleReply 放在 JSON object 的第一个字段，便于平台做语义分块准流式输出。',
    ].join(''),
    [
      'intent 常用值：create_or_update_site, modify_existing_preview, append_requirement,',
      'list_work_items, switch_work_item, reopen_work_item, diagnose_work_item, get_work_item_timeline,',
      'explain_work_item_blocker, get_workflow_status, retry_work_item, append_diagnosis_comment, human_triage,',
      'status_query, cancel_request, close_session, unsupported_destructive_request, confirm_preview, clarify。',
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
