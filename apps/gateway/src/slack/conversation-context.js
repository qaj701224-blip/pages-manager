import { redactSecretLikeText } from './text.js';

const MAX_RECENT_TURNS = 10;
const MAX_TEXT_LENGTH = 900;

function compactText(text = '', maxLength = MAX_TEXT_LENGTH) {
  const value = redactSecretLikeText(String(text || '').replaceAll(/\s+/g, ' ').trim());
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function normalizeRole(role = '') {
  if (role === 'assistant' || role === 'bot') return 'assistant';
  if (role === 'system') return 'system';
  return 'user';
}

function normalizeRecentTurn(turn = {}) {
  const text = compactText(turn.text || turn.summary || '');
  if (!text) return null;
  return {
    role: normalizeRole(turn.role),
    text,
    messageTs: turn.messageTs || turn.message_ts || null,
    kind: turn.kind || 'plain',
  };
}

function normalizeRecentTurns(turns = []) {
  return (Array.isArray(turns) ? turns : []).map(normalizeRecentTurn).filter(Boolean).slice(-MAX_RECENT_TURNS);
}

function lastTurnByRole(turns = [], role) {
  return [...turns].reverse().find((turn) => turn.role === role && turn.text) || null;
}

function workItemLabel(item = {}) {
  if (item.prNumber) return `PR #${item.prNumber}`;
  if (item.issueNumber) return `Issue #${item.issueNumber}`;
  if (item.id) return item.kind === 'platform_dev' ? '平台需求' : '发布任务';
  return null;
}

function normalizeWorkItem(item = {}) {
  const label = workItemLabel(item);
  if (!label) return null;
  return {
    kind: item.prNumber ? 'pr' : item.issueNumber ? 'issue' : item.workItemKind || item.kind || 'work_item',
    number: item.prNumber || item.issueNumber || null,
    label,
  };
}

function lastWorkItemListFromMemory(memory = {}) {
  const list = memory.lastWorkItemList || null;
  if (!list || typeof list !== 'object') return null;
  const shown = (Array.isArray(list.shown) ? list.shown : []).map(normalizeWorkItem).filter(Boolean);
  return {
    scope: list.scope || 'current_session',
    workItemState: list.workItemState || null,
    total: Number(list.total || shown.length || 0),
    shown,
  };
}

function activeFocusFromSession(slackSession = {}) {
  if (slackSession.activePrNumber) {
    return {
      kind: 'pr',
      number: slackSession.activePrNumber,
      label: `PR #${slackSession.activePrNumber}`,
      source: 'active_session',
    };
  }
  if (slackSession.activeIssueNumber) {
    return {
      kind: 'issue',
      number: slackSession.activeIssueNumber,
      label: `Issue #${slackSession.activeIssueNumber}`,
      source: 'active_session',
    };
  }
  if (slackSession.activeWorkItemId) {
    return { kind: 'work_item', number: null, label: '当前任务', source: 'active_session' };
  }
  return null;
}

function focusFromLastWorkItemList(list = null) {
  if (!list?.shown?.length) return null;
  if (list.shown.length === 1) {
    return { ...list.shown[0], source: 'last_work_item_list', scope: list.scope || 'current_session' };
  }
  return { kind: 'work_item', number: null, label: `${list.shown.length} 个任务`, source: 'last_work_item_list', scope: list.scope };
}

export function buildConversationContext({ slackSession = {}, sessionMemory = {}, intake = null } = {}) {
  const existing = sessionMemory.conversationContext || {};
  const recentTurns = normalizeRecentTurns(existing.recentTurns);
  const currentText = compactText(intake?.text || '');
  if (currentText) {
    recentTurns.push({
      role: 'user',
      text: currentText,
      messageTs: intake?.messageTs || null,
      kind: 'plain',
    });
  }
  const trimmedTurns = recentTurns.slice(-MAX_RECENT_TURNS);
  const lastAssistantText = compactText(sessionMemory.lastAgentResponse || existing.lastAssistantMessage?.text || '');
  const lastAssistantMessage = lastAssistantText
    ? {
        role: 'assistant',
        text: lastAssistantText,
        messageTs: existing.lastAssistantMessage?.messageTs || null,
        kind: existing.lastAssistantMessage?.kind || 'agent_reply',
        referents: existing.lastAssistantMessage?.referents || [],
      }
    : lastTurnByRole(trimmedTurns, 'assistant');
  const lastWorkItemList = lastWorkItemListFromMemory(sessionMemory) || existing.lastWorkItemList || null;
  const focus = activeFocusFromSession(slackSession) || focusFromLastWorkItemList(lastWorkItemList) || existing.focus || null;

  return {
    recentTurns: trimmedTurns,
    lastAssistantMessage,
    focus,
    currentFocus: focus,
    lastWorkItemList,
  };
}

export function appendAssistantConversationTurn(conversationContext = {}, text = '', options = {}) {
  const safeText = compactText(text);
  if (!safeText) return conversationContext || {};
  const recentTurns = normalizeRecentTurns(conversationContext.recentTurns);
  recentTurns.push({
    role: 'assistant',
    text: safeText,
    messageTs: options.messageTs || null,
    kind: options.kind || 'agent_reply',
  });
  return {
    ...(conversationContext || {}),
    recentTurns: recentTurns.slice(-MAX_RECENT_TURNS),
    lastAssistantMessage: {
      role: 'assistant',
      text: safeText,
      messageTs: options.messageTs || null,
      kind: options.kind || 'agent_reply',
      referents: options.referents || [],
    },
  };
}

export function repeatPreviousMessageFromContext(conversationContext = {}, target = 'previous_visible_message') {
  const turns = normalizeRecentTurns(conversationContext.recentTurns);
  if (target === 'previous_assistant_message') {
    return conversationContext.lastAssistantMessage?.text || lastTurnByRole(turns, 'assistant')?.text || null;
  }
  if (target === 'previous_user_message') {
    const users = turns.filter((turn) => turn.role === 'user');
    return users.length >= 2 ? users[users.length - 2].text : null;
  }
  const priorVisibleTurns = turns.filter((turn) => turn.role !== 'system').slice(0, -1);
  return (
    conversationContext.lastAssistantMessage?.text ||
    priorVisibleTurns.at(-1)?.text ||
    null
  );
}
