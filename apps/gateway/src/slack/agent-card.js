import { compactUserFacingText, redactSecretLikeText } from './text.js';

const INTERNAL_CARD_TERMS_RE = new RegExp(
  [
    '\\b(?:gateway|worker|mysql|redis|callback|status card|slackSessionId|sessionKey',
    '|activeJobId|activeIssueNumber|activePrNumber|activePreviewUrl',
    '|job_[A-Za-z0-9_]+|sess_[A-Za-z0-9_]+)\\b',
  ].join(''),
  'i'
);
const DANGEROUS_ACTION_LABEL_RE = new RegExp(
  [
    '删除|删掉|清空|销毁|移除|批量|全部|所有|合并|自动合并|部署|生产|上线|密钥|令牌|私钥|凭据',
    '\\bdelete\\b|\\bremove\\b|\\bdestroy\\b|\\bdrop\\b|\\bpurge\\b|\\bmerge\\b|\\bdeploy\\b',
    '\\bproduction\\b|\\bprod\\b|\\bsecret\\b|\\btoken\\b|\\bcredential\\b',
  ].join('|'),
  'i'
);
const ACTION_LABEL_ALLOWLIST = {
  append_diagnosis_to_issue: /(?:追加|写入|记录|保存|Issue|issue|诊断|comment)/i,
  close_session: /(?:关闭|结束|收起|先到这里|不用了|close|end)/i,
  confirm_create_issue: /(?:确认|创建|开始|提交|记录|生成|处理|issue|任务)/i,
  confirm_platform_issue: /(?:确认|创建|开始|提交|记录|处理|平台|需求|issue|任务)/i,
  continue_work_item: /(?:继续|接着|补充|修改|选择|处理|聚焦|推进|再)/i,
  human_triage: /(?:人工|排查|协助|转交|triage|handoff)/i,
  open_issue: /(?:Issue|issue|需求|任务)/i,
  open_pr: /(?:PR|pr|pull request|合并请求)/i,
  open_preview: /(?:Preview|preview|预览)/i,
  reopen_work_item: /(?:重新|恢复|打开|reopen|restore|Issue|issue|PR|pr)/i,
  retry_work_item: /(?:重试|重新|再跑|再试|retry)/i,
};

function cleanCardText(value = '', limit = 600) {
  const text = compactUserFacingText(redactSecretLikeText(value));
  if (!text || INTERNAL_CARD_TERMS_RE.test(text)) return '';
  return text.length > limit ? `${text.slice(0, Math.max(0, limit - 3))}...` : text;
}

function cardObject(analysis = {}, expectedKind = '') {
  const card = analysis?.card && typeof analysis.card === 'object' && !Array.isArray(analysis.card) ? analysis.card : null;
  if (!card) return null;
  if (expectedKind && card.kind && card.kind !== expectedKind) return null;
  return card;
}

function normalizeAction(action) {
  if (typeof action === 'string') return { id: action, label: '' };
  if (!action || typeof action !== 'object' || Array.isArray(action)) return null;
  const id = String(action.id || action.name || action.action || action.kind || '').trim();
  if (!id) return null;
  return {
    id,
    label: cleanCardText(action.label || action.text || action.title || '', 40),
    style: ['primary', 'danger'].includes(action.style) ? action.style : null,
  };
}

function normalizeActions(actions = []) {
  return (Array.isArray(actions) ? actions : []).map(normalizeAction).filter(Boolean);
}

export function slackAgentCardIntent(analysis = {}, expectedKind = '') {
  const card = cardObject(analysis, expectedKind);
  if (!card) return null;
  const fields = (Array.isArray(card.fields) ? card.fields : [])
    .map((field) => {
      if (typeof field === 'string') return { label: '', value: cleanCardText(field, 180) };
      if (!field || typeof field !== 'object' || Array.isArray(field)) return null;
      return {
        label: cleanCardText(field.label || field.name || field.title || '', 40),
        value: cleanCardText(field.value || field.text || field.summary || '', 180),
      };
    })
    .filter((field) => field?.value)
    .slice(0, 8);

  return {
    kind: card.kind || expectedKind || 'status',
    title: cleanCardText(card.title || analysis.title || '', 120),
    summary: cleanCardText(card.summary || analysis.visibleReply || analysis.summary || '', 1000),
    context: cleanCardText(card.context || card.footer || card.hint || '', 220),
    fields,
    actions: normalizeActions(card.actions),
  };
}

export function slackAgentCardTitle(analysis = {}, expectedKind = '', fallback = '') {
  return slackAgentCardIntent(analysis, expectedKind)?.title || fallback;
}

export function slackAgentCardSummary(analysis = {}, expectedKind = '', fallback = '') {
  return slackAgentCardIntent(analysis, expectedKind)?.summary || fallback;
}

export function slackAgentCardContext(analysis = {}, expectedKind = '', fallback = '') {
  return slackAgentCardIntent(analysis, expectedKind)?.context || fallback;
}

export function slackAgentCardFields(analysis = {}, expectedKind = '') {
  return slackAgentCardIntent(analysis, expectedKind)?.fields || [];
}

export function slackAgentCardActions(analysis = {}, expectedKind = '') {
  return slackAgentCardIntent(analysis, expectedKind)?.actions || [];
}

export function slackAgentActionLabel(analysis = {}, expectedKind = '', actionId = '', fallback = '') {
  const action = slackAgentCardActions(analysis, expectedKind).find((entry) => entry.id === actionId);
  const label = action?.label || '';
  if (!label) return fallback;
  const allowlist = ACTION_LABEL_ALLOWLIST[actionId];
  if (allowlist && !allowlist.test(label)) return fallback;
  if (DANGEROUS_ACTION_LABEL_RE.test(label)) return fallback;
  return label;
}

export function orderSlackActionsByAgentIntent(elements = [], analysis = {}, expectedKind = '') {
  const actions = slackAgentCardActions(analysis, expectedKind);
  if (!actions.length) return elements;
  const order = new Map(actions.map((action, index) => [action.id, index]));
  return [...elements].sort((left, right) => {
    const leftOrder = order.has(left.agent_action_id) ? order.get(left.agent_action_id) : Number.MAX_SAFE_INTEGER;
    const rightOrder = order.has(right.agent_action_id) ? order.get(right.agent_action_id) : Number.MAX_SAFE_INTEGER;
    return leftOrder - rightOrder;
  });
}

export function slackActionElement(element = {}) {
  const slackElement = { ...element };
  delete slackElement.agent_action_id;
  return slackElement;
}
