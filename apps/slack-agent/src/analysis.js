import {
  slackAgentCapabilityForIntent,
  slackAgentCapabilityForTool,
  SLACK_AGENT_CONFIRMATION_TYPES,
  SLACK_AGENT_DIALOG_ACTS,
} from '@xd/workflow-core';

import { compileSlackAgentPolicy } from './policy/compiler.js';
import { SLACK_AGENT_POLICY_PACKAGE_VERSION } from './policy/package.js';

const CREATE_KEYWORDS = /(创建|新建|生成|制作|做|更新|修改|发布|部署|create|build|make|update|publish|deploy)/i;
const SITE_KEYWORDS = /(页面|网页|网站|主页|profile|portfolio|site|page|website)/i;
const PLATFORM_KEYWORDS =
  /(pages-manager|平台|仓库|repo|代码|PR|issue|label|template|模版|gateway|worker|slack-agent|slack-notifier|Slack|GitHub|webhook|CI|CD|workflow|Actions|MySQL|数据库|状态机|权限|review|rebase|branch|分支|k8s|ECS|部署脚本|文档|架构)/i; // eslint-disable-line max-len
const LIST_WORK_ITEMS_RE =
  /^(我的|查看|看看|列出|查询|当前|目前|现在).*(PR|pr|issue|issues|需求|任务|发布任务|网站|项目)|^(PR|pr|issue|issues|需求|任务|发布任务|网站|项目)(列表|清单)$/i;
const STATUS_QUERY_RE =
  /(?:^(?:status|状态)\b(?:\s+job_[A-Za-z0-9_]+)?$)|(?:(?:现在|当前|目前|这会儿|此刻).{0,12}(?:进度|状态).{0,12}(?:怎么样|如何|咋样|到哪了|呢))|(?:(?:进度|状态).{0,12}(?:怎么样|如何|咋样|到哪了|呢|查一下|查下|看一下|看下))/i;
const SWITCH_WORK_ITEM_RE =
  /(?:继续|接着|切换|选择|打开|查看|回到|续上|处理|修改).*(?:https?:\/\/github\.com\/[^/\s<>]+\/[^/\s<>]+\/(?:issues|pull)\/\d{1,8}(?:[/?#][^\s<>]*)?|(?:(?:\bPR|pull\s*request|issue|issues|需求|任务)\s*#?|#)\d{1,8}\b)/i;
const REOPEN_WORK_ITEM_RE =
  /(?:重新打开|恢复|重开|reopen).*(?:https?:\/\/github\.com\/[^/\s<>]+\/[^/\s<>]+\/(?:issues|pull)\/\d{1,8}(?:[/?#][^\s<>]*)?|(?:(?:\bPR|pull\s*request|issue|issues|需求|任务)\s*#?|#)\d{1,8}\b)/i;
const DIAGNOSIS_QUERY_RE =
  /(为什么|为啥|原因|失败|没成功|没有成功|没出来|卡住|卡在哪|卡在|诊断|排查|查一下|看一下|重试|查.*(?:日志|log|workflow|actions))/i;
const REVIEW_RESULTS_QUERY_RE = new RegExp(
  [
    '(?:review|Review|codex\\s+review|Review Agent).*(?:说了什么|结果|过了吗|通过了吗|blocker|blocking|意见|建议|需要改哪里|提了什么)',
    '(?:有哪些|有什么|查看|看看|列出).*(?:blocker|blocking|review 意见|Review 意见|review 建议|Review 建议)',
    '(?:review 结果呢|Review 结果呢)',
  ].join('|'),
  'i'
);
const AMBIGUOUS_REVIEW_RESULTS_QUERY_RE = /(?:需要改哪里|哪些地方要改|哪里要改|具体改哪里)/i;
const REVIEW_RESULTS_FOLLOWUP_RE = /(?:按|根据|照着).*(?:review|Review).*(?:改|修改|修复|处理)|(?:review|Review).*(?:意见|建议).*(?:改|修改|修复|处理)/i;
const QUESTION_CUE_RE =
  /(?:\?|？|怎么|如何|怎样|哪里|在哪|是什么|为啥|为什么|解释|说明|是否|会不会|能否|可以.*吗|是不是|有没有|影响|关系)/i;
const EXECUTION_CUE_RE =
  /(?:开始|直接|马上|现在).*(?:改|修改|修复|实现|创建|部署|提交|push)|(?:帮我|请).*(?:改|修改|修复|实现|创建|部署|提交|push)|(?:创建|新建).*(?:issue|需求|任务)/i;
const SECRET_FIELD_NAME_PATTERN =
  [
    '(?:[A-Za-z0-9]+[_-])*',
    '(?:api[_-]?key|secret(?:[_-]access)?[_-]?key|private[_-]?key|secret|token|password|passwd|pwd)',
    '(?:[_-][A-Za-z0-9]+)*',
  ].join('');
const jsonSecretFieldPattern = new RegExp(`("(?:${SECRET_FIELD_NAME_PATTERN})"\\s*:\\s*)(["'])[^"']*\\2`, 'gi');
const quotedSecretAssignmentPattern = new RegExp(
  `\\b(${SECRET_FIELD_NAME_PATTERN})\\b\\s*([:=])\\s*(["'])[^"']*\\3`,
  'gi'
);
const secretAssignmentPattern = new RegExp(
  `\\b(${SECRET_FIELD_NAME_PATTERN})\\b\\s*([:=])\\s*[^"',\\s}]+`,
  'gi'
);
const REPO_QUESTION_RE = new RegExp(
  [
    '怎么|如何|怎样|哪里|在哪|是什么|为啥|为什么|解释|说明',
    '架构|实现|代码|保存|存储|读取|触发|调用|流程|状态机',
    '数据结构|schema|表|字段|repo|repository|code|影响|关系|边界',
  ].join('|'),
  'i'
);

function redactSecretLikeText(text = '') {
  return String(text || '')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED_TOKEN]')
    .replace(/\b(xox[baprs]-[A-Za-z0-9-]{8,})\b/g, '[REDACTED_SLACK_TOKEN]')
    .replace(/\b(xapp-[A-Za-z0-9-]{8,})\b/g, '[REDACTED_SLACK_APP_TOKEN]')
    .replace(/\b(gh[pousr]_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(github_pat_[A-Za-z0-9_]{20,})\b/g, '[REDACTED_GITHUB_TOKEN]')
    .replace(/\b(sk-[A-Za-z0-9_-]{20,})\b/g, '[REDACTED_API_KEY]')
    .replace(jsonSecretFieldPattern, '$1$2[REDACTED_SECRET]$2')
    .replace(quotedSecretAssignmentPattern, '$1$2$3[REDACTED_SECRET]$3')
    .replace(secretAssignmentPattern, '$1$2[REDACTED_SECRET]');
}
const REPO_QUESTION_SUBJECT_RE = new RegExp(
  [
    'pages-manager|平台|仓库|repo|repository|代码|code|Slack|bot|机器人',
    'session|sessions|会话|对话|workflow|Actions|GitHub|issue|PR|数据库|MySQL|状态机|架构',
  ].join('|'),
  'i'
);
const ISSUE_NUMBER_RE = /(?:issue|issues|需求|任务)\s*#?\s*(\d{1,8})\b/i;
const PR_NUMBER_RE = /\b(?:PR|pull\s*request|pull-request|pullrequest)\s*#?\s*(\d{1,8})\b/i;
const BARE_WORK_ITEM_NUMBER_RE = /#(\d{1,8})\b/;
const GITHUB_WORK_ITEM_URL_RE =
  /https?:\/\/github\.com\/[^/\s<>]+\/[^/\s<>]+\/(issues|pull)\/(\d{1,8})(?:[/?#][^\s<>]*)?/i;
const WORK_ITEM_DESTRUCTIVE_ACTION_RE = /(?:关闭|关掉|删除|删掉|清理|清空|取消|归档|close|delete|remove|cancel|archive)/i;
const WORK_ITEM_CLOSE_CAPABILITY_QUESTION_RE =
  /(?:能不能|能否|可以|是否|是不是|能|可不可以).*(?:主动)?(?:关闭|关掉|取消|归档|close|cancel|archive).*(?:吗|么|\?|？)?/i;
const UNSUPPORTED_DESTRUCTIVE_INTENT = 'unsupported_destructive_request';
const DIRECT_CODE_PR_REQUEST_RE = new RegExp(
  [
    '(?:直接|现在|马上|立刻|自动)?.*',
    '(?:写代码|改代码|生成代码|修改代码|创建\\s*PR|发\\s*PR|开\\s*PR|提交\\s*PR)',
    '|(?:create\\s+PR|open\\s+PR|push|commit|部署|上线|发布到生产|production|prod)',
  ].join(''),
  'i'
);
const DEPLOYMENT_CREDENTIAL_REQUEST_RE =
  /(?:部署凭证|生产凭证|上线凭证|credential|credentials|secret|token|api[_-]?key|私钥|密钥|密码|password|pwd)/i;
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
const ISSUE_LIST_QUERY_RE = /(?:issue|issues|需求).*(?:几个|多少|列表|清单|有哪些|有几个)|(?:几个|多少|哪些).*(?:issue|issues|需求)/i;
const LIST_FOLLOWUP_RE = /(?:只有|就|还|还有|就这|只有这|只有这些).*(?:一个|这些|这个|吗|么)|(?:还有吗|还有么|就这吗|就这些吗)/i;
const REPEAT_PREVIOUS_MESSAGE_RE = /(?:复读|重复|再发|上一条消息|刚才那条|你上一条|我上一条)/i;
const CURRENT_WORK_ITEM_FOLLOWUP_RE =
  /(?:这个|那个|刚才|当前|接着|继续|续上|改为|改成|换成|不再|不要再|补充|追加|调整|修改|修复|重试|重新跑|再跑)/i;
const CURRENT_WORK_ITEM_QUESTION_RE = /(?:需要改哪里|哪些地方要改|哪里要改|具体改哪里)/i;
const EXPLICIT_NEW_WORK_ITEM_RE = /(?:新建|创建|另开|新开|另外|新的).*(?:issue|需求|任务)|(?:另开一个|新开一个)/i;
const CLOSE_SESSION_RE =
  /(?:(?:关闭|结束|停止|退出|close|end)\s*(?:当前)?(?:这个)?\s*(?:会话|对话|session|conversation))|(?:(?:会话|对话|session|conversation).*(?:关闭|结束|停止|退出|close|end))/i;

function isUnsupportedBulkDestructiveRequest(text = '') {
  return UNSUPPORTED_BULK_DESTRUCTIVE_RE.test(String(text || ''));
}

function isExplicitWorkItemDestructiveRequest(text = '') {
  const value = String(text || '');
  return WORK_ITEM_DESTRUCTIVE_ACTION_RE.test(value) && Boolean(workItemReferenceFromText(value));
}

function isUnsupportedDirectExecutionRequest(text = '') {
  const value = String(text || '');
  return DIRECT_CODE_PR_REQUEST_RE.test(value) && DEPLOYMENT_CREDENTIAL_REQUEST_RE.test(value);
}

function unsupportedDestructiveQuestion() {
  return '我不能在 Slack 里直接关闭或删除 GitHub issue / PR / 发布任务，也不能直接写代码、创建 PR、部署上线或处理凭证。可以先整理成需求或诊断记录；如果只是想结束这轮 Slack 对话，请说「关闭会话」。';
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
  if (ALL_WORK_ITEM_QUERY_RE.test(value) || ISSUE_LIST_QUERY_RE.test(value)) return 'all';
  return 'active';
}

function workItemStateForListTurn(text = '', sessionMemory = {}) {
  const state = workItemStateFromText(text);
  if (state !== 'active') return state;
  return sessionMemory?.lastWorkItemList?.workItemState || state;
}

function workItemReferenceFromText(text = '') {
  const value = String(text || '');
  const githubMatch = value.match(GITHUB_WORK_ITEM_URL_RE);
  if (githubMatch) return { kind: githubMatch[1] === 'pull' ? 'pr' : 'issue', number: Number(githubMatch[2]) };
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
  if (intent === 'diagnose_work_item') {
    const reference = workItemReferenceFromText(text);
    return {
      name: 'diagnose_current_work_item',
      args: {
        timeWindowMinutes: 30,
        ...(reference ? { kind: reference.kind, number: reference.number, explicitUserTarget: true } : {}),
      },
    };
  }
  if (['summarize_review_results', 'list_review_results'].includes(intent)) {
    const reference = workItemReferenceFromText(text);
    return {
      name: 'summarize_review_results',
      args: reference
        ? { kind: reference.kind === 'pr' || reference.kind === 'issue' ? reference.kind : 'unknown', number: reference.number }
        : { kind: 'current', maxItems: 5 },
    };
  }
  if (intent === 'repeat_previous_message') {
    return { name: 'repeat_previous_message', args: { target: repeatPreviousMessageTargetFromText(text) } };
  }
  if (['repo_question', 'architecture_question', 'platform_question'].includes(intent)) {
    return { name: 'answer_repo_question', args: { question: text } };
  }
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

function normalizeDialogAct(value, fallback = 'answer') {
  const normalized = String(value || '').trim();
  return SLACK_AGENT_DIALOG_ACTS.includes(normalized) ? normalized : fallback;
}

function normalizeConfirmationRequirement(value, fallback = 'none') {
  const normalized = String(value || '').trim();
  return SLACK_AGENT_CONFIRMATION_TYPES.includes(normalized) ? normalized : fallback;
}

function focusFromSessionContext(context = {}) {
  if (context.activePrNumber) {
    return { kind: 'pr', number: context.activePrNumber, label: `PR #${context.activePrNumber}`, source: 'active_session' };
  }
  if (context.activeIssueNumber) {
    return {
      kind: 'issue',
      number: context.activeIssueNumber,
      label: `Issue #${context.activeIssueNumber}`,
      source: 'active_session',
    };
  }
  if (context.activeWorkItemId) {
    return {
      kind: context.activeWorkItemKind || 'work_item',
      id: context.activeWorkItemId,
      number: null,
      label: '当前任务',
      source: 'active_session',
    };
  }
  return null;
}

function cardForCapability(capability, analysis = {}) {
  if (!capability || capability.cardKind === 'none') return null;
  const defaultActions = {
    confirmation:
      capability.name === 'confirm_platform_issue'
        ? ['confirm_platform_issue', 'continue_work_item', 'close_session']
        : ['confirm_create_issue', 'continue_work_item', 'close_session'],
    task_list: ['continue_work_item', 'open_issue', 'open_pr', 'open_preview', 'reopen_work_item'],
    diagnosis: ['open_issue', 'open_pr', 'open_preview', 'retry_work_item', 'append_diagnosis_to_issue', 'human_triage'],
    repo_answer: ['open_issue'],
    status: ['open_issue', 'open_pr', 'open_preview'],
    handoff: ['human_triage'],
  };
  return {
    kind: capability.cardKind,
    title: analysis.title || '',
    summary: analysis.visibleReply || analysis.summary || '',
    context: '',
    fields: [],
    actions: defaultActions[capability.cardKind] || [],
  };
}

function enrichWithCapabilityContract(analysis = {}) {
  const capability =
    slackAgentCapabilityForTool(analysis.toolCall?.name || analysis.tool_call?.name) ||
    slackAgentCapabilityForIntent(analysis.intent);
  const dialogAct = normalizeDialogAct(analysis.dialogAct || analysis.dialog_act, capability?.dialogAct || 'answer');
  const confirmationRequirement = normalizeConfirmationRequirement(
    analysis.confirmationRequirement || analysis.confirmation_requirement,
    capability?.confirmation || 'none'
  );
  return {
    ...analysis,
    capability: capability?.name || analysis.capability || null,
    dialogAct,
    confirmationRequirement,
    card: objectOrNull(analysis.card) || cardForCapability(capability, analysis),
  };
}

function repeatPreviousMessageTargetFromText(text = '') {
  const value = String(text || '');
  if (/我上一条|我刚才|我发的上一条|上一条我/i.test(value)) return 'previous_user_message';
  if (/你上一条|你刚才|你发的上一条|上一条你|bot 上一条|机器人上一条/i.test(value)) {
    return 'previous_assistant_message';
  }
  return 'previous_visible_message';
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
  const lastWorkItemList = sessionMemory.lastWorkItemList || null;

  return {
    slackSessionId: slackSession.id || null,
    sessionKey: slackSession.sessionKey || null,
    sessionStatus: slackSession.status || null,
    memorySummary: sessionMemory.summary || '',
    issueLinkCount: issueLinks.length,
    activeJobId: slackSession.activeJobId || null,
    activeWorkItemKind: slackSession.activeWorkItemKind || null,
    activeWorkItemId: slackSession.activeWorkItemId || null,
    activeIssueNumber: slackSession.activeIssueNumber || null,
    activePrNumber: slackSession.activePrNumber || null,
    activePreviewUrl: slackSession.activePreviewUrl || null,
    lastWorkItemList: lastWorkItemList
      ? {
          workItemState: lastWorkItemList.workItemState || null,
          total: Number(lastWorkItemList.total || 0),
          shownCount: Array.isArray(lastWorkItemList.shown) ? lastWorkItemList.shown.length : 0,
        }
      : null,
  };
}

function hasCurrentWorkItemContext(input = {}, context = sessionContextFromInput(input)) {
  const memory = input.sessionMemory || {};
  const conversationContext = input.conversationContext || memory.conversationContext || {};
  const focus = conversationContext.focus || conversationContext.currentFocus || null;
  return Boolean(
    context.activeJobId ||
      context.activeWorkItemId ||
      context.activeIssueNumber ||
      context.activePrNumber ||
      context.activePreviewUrl ||
      focus?.kind ||
      memory.lastWorkItemList ||
      conversationContext.lastWorkItemList ||
      (Array.isArray(input.issueLinks) && input.issueLinks.length)
  );
}

function shouldTreatAsCurrentWorkItemFollowup(text = '', input = {}, context = sessionContextFromInput(input)) {
  if (!hasCurrentWorkItemContext(input, context)) return false;
  if (EXPLICIT_NEW_WORK_ITEM_RE.test(text)) return false;
  return CURRENT_WORK_ITEM_FOLLOWUP_RE.test(text) || CURRENT_WORK_ITEM_QUESTION_RE.test(text);
}

function laneForCurrentWorkItem(context = {}) {
  return context.activeWorkItemKind === 'platform_dev' ? 'platform-dev' : 'site-publishing';
}

function hasReviewResultsContext(input = {}, context = sessionContextFromInput(input)) {
  const memory = input.sessionMemory || {};
  const requirements = memory.requirements && typeof memory.requirements === 'object' ? memory.requirements : {};
  const reviewResults =
    requirements.reviewResults && typeof requirements.reviewResults === 'object' ? requirements.reviewResults : null;
  if (reviewResults?.prNumber || reviewResults?.conclusion) return true;
  const lastAssistant = memory.conversationContext?.lastAssistantMessage?.text || '';
  if (/Review Agent|Review 结果|blocker|blocking|site-check/i.test(lastAssistant)) return true;
  return Boolean(context.activePrNumber && /review/i.test(String(context.activeWorkItemKind || '')));
}

function shouldSummarizeReviewResultsTurn(text = '', input = {}, context = sessionContextFromInput(input)) {
  if (REVIEW_RESULTS_QUERY_RE.test(text)) return true;
  return hasReviewResultsContext(input, context) && AMBIGUOUS_REVIEW_RESULTS_QUERY_RE.test(text);
}

function isNaturalCloseSessionTurn(text = '', input = {}, context = sessionContextFromInput(input)) {
  if (!CLOSE_SESSION_RE.test(text)) return false;
  if (workItemReferenceFromText(text)) return false;
  if (WORK_ITEM_DESTRUCTIVE_ACTION_RE.test(text) && hasCurrentWorkItemContext(input, context)) return false;
  return true;
}

export function analyzeSlackRequirementDeterministic(input = {}) {
  const event = input.event || {};
  const text = normalizeText(input.text || event.text || input.summary || '');
  const sessionContext = sessionContextFromInput(input);
  const shouldCloseSession = isNaturalCloseSessionTurn(text, input, sessionContext);
  const isUnsupportedDestructive =
    isUnsupportedBulkDestructiveRequest(text) ||
    isExplicitWorkItemDestructiveRequest(text) ||
    isUnsupportedDirectExecutionRequest(text) ||
    (!shouldCloseSession &&
      hasCurrentWorkItemContext(input, sessionContext) &&
      WORK_ITEM_CLOSE_CAPABILITY_QUESTION_RE.test(text));
  const hasPreviousWorkItemList = Boolean(input.sessionMemory?.lastWorkItemList);
  const shouldListWorkItems =
    !isUnsupportedDestructive && (LIST_WORK_ITEMS_RE.test(text) || (hasPreviousWorkItemList && LIST_FOLLOWUP_RE.test(text)));
  const workItemState = shouldListWorkItems ? workItemStateForListTurn(text, input.sessionMemory) : undefined;
  const shouldReopenWorkItem = !isUnsupportedDestructive && REOPEN_WORK_ITEM_RE.test(text);
  const shouldSwitchWorkItem = SWITCH_WORK_ITEM_RE.test(text);
  const shouldRepeatPreviousMessage = !isUnsupportedDestructive && REPEAT_PREVIOUS_MESSAGE_RE.test(text);
  const shouldStatusQuery =
    !isUnsupportedDestructive &&
    !shouldListWorkItems &&
    !shouldSwitchWorkItem &&
    !shouldReopenWorkItem &&
    !shouldRepeatPreviousMessage &&
    STATUS_QUERY_RE.test(text) &&
    !DIAGNOSIS_QUERY_RE.test(text);
  const shouldSummarizeReviewResults =
    !isUnsupportedDestructive &&
    !shouldListWorkItems &&
    !shouldSwitchWorkItem &&
    !shouldReopenWorkItem &&
    !shouldRepeatPreviousMessage &&
    !shouldStatusQuery &&
    !REVIEW_RESULTS_FOLLOWUP_RE.test(text) &&
    shouldSummarizeReviewResultsTurn(text, input, sessionContext);
  const shouldDiagnoseWorkItem =
    !isUnsupportedDestructive &&
    !shouldListWorkItems &&
    !shouldSwitchWorkItem &&
    !shouldSummarizeReviewResults &&
    !shouldRepeatPreviousMessage &&
    !shouldStatusQuery &&
    DIAGNOSIS_QUERY_RE.test(text);
  const shouldRecordCurrentWorkItemFollowup =
    !isUnsupportedDestructive &&
    !shouldListWorkItems &&
    !shouldSwitchWorkItem &&
    !shouldReopenWorkItem &&
    !shouldRepeatPreviousMessage &&
    !shouldStatusQuery &&
    !shouldDiagnoseWorkItem &&
    shouldTreatAsCurrentWorkItemFollowup(text, input, sessionContext);
  const shouldAnswerRepoQuestion =
    !isUnsupportedDestructive &&
    !shouldListWorkItems &&
    !shouldSwitchWorkItem &&
    !shouldCloseSession &&
    !shouldDiagnoseWorkItem &&
    !shouldRecordCurrentWorkItemFollowup &&
    !shouldStatusQuery &&
    !shouldSummarizeReviewResults &&
    (PLATFORM_KEYWORDS.test(text) || REPO_QUESTION_SUBJECT_RE.test(text)) &&
    (REPO_QUESTION_RE.test(text) || QUESTION_CUE_RE.test(text)) &&
    !EXECUTION_CUE_RE.test(text);
  const shouldCreateOrUpdate =
    !isUnsupportedDestructive &&
    !shouldListWorkItems &&
    !shouldSwitchWorkItem &&
    !shouldCloseSession &&
    !shouldDiagnoseWorkItem &&
    !shouldRecordCurrentWorkItemFollowup &&
    !shouldAnswerRepoQuestion &&
    !shouldStatusQuery &&
    !shouldSummarizeReviewResults &&
    (CREATE_KEYWORDS.test(text) || SITE_KEYWORDS.test(text));
  const shouldCreatePlatform =
    !isUnsupportedDestructive &&
    !shouldListWorkItems &&
    !shouldSwitchWorkItem &&
    !shouldCloseSession &&
    !shouldDiagnoseWorkItem &&
    !shouldAnswerRepoQuestion &&
    !shouldRecordCurrentWorkItemFollowup &&
    !shouldStatusQuery &&
    !shouldSummarizeReviewResults &&
    PLATFORM_KEYWORDS.test(text) &&
    (CREATE_KEYWORDS.test(text) || /(需求|建议|反馈|优化|改造|支持|接入|流程|能力)/i.test(text));
  const intent = shouldCreatePlatform ? 'create_platform_issue' : shouldCreateOrUpdate ? 'create_or_update_site' : 'clarify';
  const finalIntent = isUnsupportedDestructive
    ? UNSUPPORTED_DESTRUCTIVE_INTENT
    : shouldCloseSession
      ? 'close_session'
    : shouldReopenWorkItem
      ? 'reopen_work_item'
      : shouldSwitchWorkItem
        ? 'switch_work_item'
        : shouldRepeatPreviousMessage
          ? 'repeat_previous_message'
          : shouldListWorkItems
            ? 'list_work_items'
            : shouldStatusQuery
              ? 'status_query'
            : shouldSummarizeReviewResults
              ? 'summarize_review_results'
              : shouldDiagnoseWorkItem
                ? 'diagnose_work_item'
                : shouldRecordCurrentWorkItemFollowup
                  ? 'append_requirement'
                  : shouldAnswerRepoQuestion
                    ? 'repo_question'
                    : intent;

  return enrichWithCapabilityContract({
    lane: shouldRecordCurrentWorkItemFollowup
      ? laneForCurrentWorkItem(sessionContext)
      : shouldSummarizeReviewResults
      ? laneForCurrentWorkItem(sessionContext)
      : shouldAnswerRepoQuestion
      ? 'repo-question'
      : shouldCreatePlatform
        ? 'platform-dev'
        : shouldCreateOrUpdate
          ? 'site-publishing'
          : 'unknown',
    intent: finalIntent,
    employeeSlug: input.employeeSlug || input.employee_slug || 'smoke',
    siteSlug: input.siteSlug || input.site_slug || 'profile',
    title: input.title || titleFromText(text),
    summary: text,
    issueType: shouldCreatePlatform ? inferPlatformIssueType(text) : undefined,
    areas: shouldCreatePlatform ? inferPlatformAreas(text) : undefined,
    risk: shouldCreatePlatform ? inferPlatformRisk(text, inferPlatformIssueType(text)) : undefined,
    agentEligible: isUnsupportedDestructive
      ? false
      : shouldCreatePlatform
        ? !['type:feedback', 'type:question'].includes(inferPlatformIssueType(text))
        : undefined,
    requiresHumanGate: isUnsupportedDestructive
      ? false
      : shouldCreatePlatform
        ? inferPlatformRisk(text, inferPlatformIssueType(text)) === 'risk:high'
        : undefined,
    workItemState,
    toolCall:
      finalIntent === 'list_work_items'
        ? { name: 'list_my_work_items', args: { state: workItemState || 'active' } }
        : toolCallForIntent(finalIntent, text),
    approvalMode: input.approvalMode || input.approval_mode || 'manual_required',
    policyVersion: SLACK_AGENT_POLICY_PACKAGE_VERSION,
    sourceMessages: input.sourceMessages || input.source_messages || [],
    sessionContext,
    focus: focusFromSessionContext(sessionContext),
    needsClarification:
      !isUnsupportedDestructive &&
      !shouldListWorkItems &&
      !shouldSwitchWorkItem &&
      !shouldRepeatPreviousMessage &&
      !shouldCloseSession &&
      !shouldStatusQuery &&
      !shouldSummarizeReviewResults &&
      !shouldDiagnoseWorkItem &&
      !shouldRecordCurrentWorkItemFollowup &&
      !shouldAnswerRepoQuestion &&
      intent === 'clarify',
    clarifyingQuestion: isUnsupportedDestructive ? unsupportedDestructiveQuestion() : undefined,
  });
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

function shouldForceIntentToolCall(intent = '') {
  return [
    UNSUPPORTED_DESTRUCTIVE_INTENT,
    'list_work_items',
    'switch_work_item',
    'reopen_work_item',
    'diagnose_work_item',
    'summarize_review_results',
    'list_review_results',
    'status_query',
    'repo_question',
    'architecture_question',
    'platform_question',
    'repeat_previous_message',
    'append_requirement',
    'modify_existing_preview',
  ].includes(intent);
}

function modelMustYieldToSafetyIntent(modelIntent = '', fallbackIntent = '') {
  if (!fallbackIntent || modelIntent === fallbackIntent) return false;
  return fallbackIntent === UNSUPPORTED_DESTRUCTIVE_INTENT;
}

export function normalizeModelAnalysis(modelAnalysis = {}, fallback, input = {}) {
  const inputSessionContext = sessionContextFromInput(input);
  const rawModelIntent = stringOrFallback(modelAnalysis.intent, fallback.intent);
  const toolCallFallbackText = input.text || input.event?.text || modelAnalysis.summary || fallback.summary || '';
  let modelIntent =
    ['create_platform_issue', 'create_or_update_site', 'platform_dev', 'platform_feedback'].includes(rawModelIntent) &&
    shouldTreatAsCurrentWorkItemFollowup(toolCallFallbackText, input, inputSessionContext)
      ? 'append_requirement'
      : rawModelIntent;
  if (modelMustYieldToSafetyIntent(modelIntent, fallback.intent)) {
    modelIntent = fallback.intent;
  }
  const inferredToolCall = modelAnalysis.intent
    ? toolCallForIntent(modelIntent, toolCallFallbackText)
    : fallback.toolCall || toolCallForIntent(fallback.intent, fallback.summary);
  const modelToolCall =
    modelAnalysis.toolCall ||
    modelAnalysis.tool_call ||
    (modelAnalysis.tool || modelAnalysis.toolName || modelAnalysis.tool_name
      ? {
          name: modelAnalysis.tool || modelAnalysis.toolName || modelAnalysis.tool_name,
          args: modelAnalysis.toolArgs || modelAnalysis.tool_args || {},
        }
      : null);
  const normalized = enrichWithCapabilityContract({
    ...fallback,
    intent: modelIntent,
    lane:
      modelIntent === 'append_requirement' && rawModelIntent !== modelIntent
        ? laneForCurrentWorkItem(inputSessionContext)
        : stringOrFallback(modelAnalysis.lane, fallback.lane || 'unknown'),
    confidence: typeof modelAnalysis.confidence === 'number' ? modelAnalysis.confidence : fallback.confidence,
    employeeSlug: stringOrFallback(modelAnalysis.employeeSlug || modelAnalysis.employee_slug, fallback.employeeSlug),
    siteSlug: stringOrFallback(modelAnalysis.siteSlug || modelAnalysis.site_slug, fallback.siteSlug),
    title: redactSecretLikeText(stringOrFallback(modelAnalysis.title, fallback.title)),
    summary: redactSecretLikeText(stringOrFallback(modelAnalysis.summary || modelAnalysis.brief, fallback.summary)),
    issueType: stringOrFallback(modelAnalysis.issueType || modelAnalysis.issue_type, fallback.issueType || ''),
    areas: arrayOrFallback(modelAnalysis.areas || modelAnalysis.areaLabels || modelAnalysis.area_labels, fallback.areas || []),
    risk: stringOrFallback(modelAnalysis.risk, fallback.risk || ''),
    agentEligible:
      modelIntent === UNSUPPORTED_DESTRUCTIVE_INTENT
        ? fallback.agentEligible
        : typeof modelAnalysis.agentEligible === 'boolean'
          ? modelAnalysis.agentEligible
          : typeof modelAnalysis.agent_eligible === 'boolean'
            ? modelAnalysis.agent_eligible
            : fallback.agentEligible,
    requiresHumanGate:
      modelIntent === UNSUPPORTED_DESTRUCTIVE_INTENT
        ? fallback.requiresHumanGate
        : typeof modelAnalysis.requiresHumanGate === 'boolean'
          ? modelAnalysis.requiresHumanGate
          : typeof modelAnalysis.requires_human_gate === 'boolean'
            ? modelAnalysis.requires_human_gate
            : fallback.requiresHumanGate,
    workItemState: stringOrFallback(
      modelAnalysis.workItemState || modelAnalysis.work_item_state,
      fallback.workItemState || workItemStateFromText(input.text || input.event?.text || fallback.summary || '')
    ),
    toolCall: shouldForceIntentToolCall(modelIntent) ? inferredToolCall : normalizeToolCall(modelToolCall, inferredToolCall),
    visibleReply: redactSecretLikeText(
      stringOrFallback(
        modelAnalysis.visibleReply || modelAnalysis.visible_reply,
        fallback.visibleReply || fallback.visible_reply || ''
      )
    ),
    approvalMode: stringOrFallback(modelAnalysis.approvalMode || modelAnalysis.approval_mode, fallback.approvalMode),
    sourceMessages: arrayOrFallback(
      modelAnalysis.sourceMessages || modelAnalysis.source_messages,
      fallback.sourceMessages
    ).map((message) => redactSecretLikeText(message)),
    clarifyingQuestion: redactSecretLikeText(
      stringOrFallback(
        modelAnalysis.clarifyingQuestion || modelAnalysis.clarifying_question,
        fallback.clarifyingQuestion || ''
      )
    ),
    contextResolution:
      objectOrNull(modelAnalysis.contextResolution || modelAnalysis.context_resolution) ||
      objectOrNull(fallback.contextResolution) ||
      null,
    focus:
      objectOrNull(modelAnalysis.focus) ||
      objectOrNull(modelAnalysis.contextFocus || modelAnalysis.context_focus) ||
      objectOrNull(fallback.focus) ||
      focusFromSessionContext(inputSessionContext),
    policyVersion: stringOrFallback(
      modelAnalysis.policyVersion || modelAnalysis.policy_version,
      fallback.policyVersion || SLACK_AGENT_POLICY_PACKAGE_VERSION
    ),
    sessionContext: {
      ...inputSessionContext,
      ...(modelAnalysis.sessionContext || modelAnalysis.session_context || {}),
    },
    needsClarification:
      typeof modelAnalysis.needsClarification === 'boolean'
        ? modelAnalysis.needsClarification
        : typeof modelAnalysis.needs_clarification === 'boolean'
          ? modelAnalysis.needs_clarification
          : fallback.needsClarification,
  });

  return normalized;
}

export function visibleSlackAgentReply(analysis = {}) {
  const intent = analysis.intent || 'clarify';
  if (analysis.visibleReply || analysis.visible_reply) {
    return redactSecretLikeText(analysis.visibleReply || analysis.visible_reply);
  }

  if (analysis.needsClarification) {
    return redactSecretLikeText(
      analysis.clarifyingQuestion ||
        analysis.clarifying_question ||
        analysis.summary ||
        '我需要再确认一个信息，然后再继续整理需求。'
    );
  }

  if (intent === UNSUPPORTED_DESTRUCTIVE_INTENT) {
    return redactSecretLikeText(analysis.clarifyingQuestion || analysis.summary || unsupportedDestructiveQuestion());
  }

  if (intent === 'list_work_items') return '我来整理你当前可以继续处理的发布任务。';
  if (intent === 'switch_work_item') return '我会尝试切换到你指定的任务。';
  if (intent === 'reopen_work_item') return '我会尝试恢复你指定的 Issue 或 PR。';
  if (intent === 'repeat_previous_message') {
    return redactSecretLikeText(analysis.summary || '我来复读当前会话里上一条可见消息。');
  }
  if (['summarize_review_results', 'list_review_results'].includes(intent)) return '我来整理当前 PR 的 Review 结果。';
  if (intent === 'status_query') return '我来查询当前发布进度。';
  if (['repo_question', 'architecture_question', 'platform_question'].includes(intent)) return '我来查一下当前仓库实现。';
  if (intent === 'close_session') return '收到，我会关闭当前会话。';
  if (intent === 'cancel_request') return '收到，我先记录取消意图。';

  if (['create_platform_issue', 'platform_dev', 'platform_feedback'].includes(intent)) {
    return analysis.summary
      ? `我已整理好这轮平台需求：${redactSecretLikeText(analysis.summary)}`
      : '我已整理好这轮平台需求。';
  }

  if (['create_or_update_site', 'modify_existing_preview', 'append_requirement'].includes(intent)) {
    return analysis.summary ? `我已整理好这轮需求：${redactSecretLikeText(analysis.summary)}` : '我已整理好这轮需求。';
  }

  return redactSecretLikeText(analysis.summary || '我已记录这轮消息。');
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
  const policy = compileSlackAgentPolicy(input, fallbackAnalysis, sessionContext);

  return [
    { role: 'system', content: policy.system },
    { role: 'user', content: JSON.stringify(policy.userPayload) },
  ];
}
