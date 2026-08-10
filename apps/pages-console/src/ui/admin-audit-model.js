export function filterAuditEvents(events, { query, decision }) {
  const normalizedQuery = query.trim().toLowerCase();
  return events.filter((event) => {
    if (decision !== 'all' && event.decision !== decision) return false;
    if (!normalizedQuery) return true;
    const actor = auditActorView(event);
    return [
      event.eventType,
      event.id,
      event.actorUserId,
      event.actorType,
      actor.primary,
      actor.secondary,
      event.decision,
      auditMetadataSummary(event.metadata),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery);
  });
}

export function auditActorView(event) {
  const actor = event.actor || {};
  const displayName = normalizeText(actor.displayName || actor.realname || actor.name);
  const email = normalizeText(actor.email);
  if (event.actorType === 'system') {
    return {
      primary: displayName || '系统',
      secondary: email || shortId(event.actorUserId || event.actorType),
    };
  }
  if (event.actorType === 'access_key') {
    return {
      primary: displayName || 'Access Key',
      secondary: email || shortId(event.actorUserId || event.actorType),
    };
  }
  return {
    primary: displayName || email || event.actorType || '未知',
    secondary: email && displayName ? email : shortId(event.actorUserId || actor.userId || event.actorType),
  };
}

export function auditMetadataSummary(metadata) {
  if (!metadata || typeof metadata !== 'object') return '无附加信息';
  const keys = Object.keys(metadata);
  if (!keys.length) return '无附加信息';
  const preferred = ['stage', 'failureCode', 'siteSlug', 'siteId', 'teamId', 'targetTeamId', 'userId', 'action', 'reason'];
  const parts = preferred.filter((key) => metadata[key]).map((key) => `${key}: ${metadata[key]}`);
  if (parts.length) return parts.slice(0, 2).join(' · ');
  return `${keys.length} 个字段`;
}

export function shortId(value) {
  const text = String(value || '').trim();
  if (!text) return '-';
  return text.length > 18 ? `${text.slice(0, 10)}...${text.slice(-5)}` : text;
}

function normalizeText(value) {
  return String(value || '').trim();
}
