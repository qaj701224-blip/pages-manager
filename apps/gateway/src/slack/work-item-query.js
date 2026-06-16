const CLOSED_WORK_ITEM_QUERY_RE =
  /(?:已关闭|关闭的|关掉的|被关闭|已取消|取消的|已失败|失败的|归档|closed|cancelled|canceled|failed|inactive)/i;
const ALL_WORK_ITEM_QUERY_RE = /(?:历史|全部|所有|所有的|全量|all|history|historical)/i;

export function normalizeSlackWorkItemQueryState(value = '') {
  const text = String(value || '')
    .trim()
    .toLowerCase();
  if (['closed', 'cancelled', 'canceled', 'failed', 'inactive'].includes(text)) return 'closed';
  if (['all', 'history', 'any'].includes(text)) return 'all';
  return 'active';
}

export function slackWorkItemQueryStateFromText(text = '') {
  const value = String(text || '');
  if (CLOSED_WORK_ITEM_QUERY_RE.test(value)) return 'closed';
  if (ALL_WORK_ITEM_QUERY_RE.test(value)) return 'all';
  return 'active';
}

export function slackWorkItemIncludesInactive(state = 'active') {
  return normalizeSlackWorkItemQueryState(state) !== 'active';
}
