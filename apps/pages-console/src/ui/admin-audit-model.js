const EVENT_LABELS = {
  'admin.platform_admin.grant': '授予平台管理员',
  'admin.platform_admin.revoke': '撤销平台管理员',
  'admin.department_team.merge': '合并部门团队',
  'system.department_team.create': '创建部门团队',
  'system.department_membership.join': '同步部门团队成员',
  'system.department_membership.migrate': '迁移部门团队成员',
  'team.delete': '删除团队',
  'site_secret.put': '更新站点 Secret',
  'site_secret.delete': '删除站点 Secret',
  'site.owner.transfer': '转移站点归属',
  'site.v1_takeover': '接管 v1 同名站点',
  'connection.user.link': '连接已有用户',
  'connection.user.create': '通过连接创建用户',
  'connection.request.deny': '拒绝连接请求',
  'admin.site.exposure': '调整站点公网暴露',
  'admin.v1_site_retire': '退役 v1 站点',
  'admin.cleanup_run_due': '批量执行到期清理',
  'admin.worker_orphan_backfill': '回填孤儿 Worker 清理任务',
  'admin.cleanup_run': '执行部署资源清理',
};

export function filterAuditEvents(events, { query, decision }) {
  const normalizedQuery = query.trim().toLowerCase();
  return events.filter((event) => {
    if (decision !== 'all' && event.decision !== decision) return false;
    if (!normalizedQuery) return true;
    const actor = auditActorView(event);
    return [
      eventLabelText(event.eventType),
      event.eventType,
      event.id,
      event.actorUserId,
      event.actorType,
      actor.primary,
      actor.secondary,
      event.decision,
      event.statusCode,
      event.siteId,
      event.routeId,
      event.versionId,
      serializeAuditSearchValue(event.metadata),
    ]
      .filter((value) => value !== null && value !== undefined && value !== '')
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery);
  });
}

export function auditEventLabel(eventType) {
  return {
    title: EVENT_LABELS[eventType] || eventType || '未知事件',
    technical: eventType || '未知事件',
  };
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

export function auditMetadataSummary(event) {
  const metadata = event?.metadata;
  const eventType = event?.eventType || '';
  const resourceParts = [
    ['siteId', event?.siteId],
    ['routeId', event?.routeId],
    ['versionId', event?.versionId],
  ]
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${summaryValue(value)}`);
  if (!metadata || typeof metadata !== 'object') return resourceParts.slice(0, 2).join(' · ') || '无附加信息';
  const shapeSummary = formatKnownMetadataSummary(metadata, eventType);
  if (shapeSummary) return shapeSummary;
  if (resourceParts.length) return resourceParts.slice(0, 2).join(' · ');
  const preferred = preferredSummaryKeys(eventType);
  const parts = preferred
    .filter((key) => metadata[key] !== undefined && metadata[key] !== null && metadata[key] !== '')
    .map((key) => `${key}: ${summaryValue(metadata[key])}`);
  if (parts.length) return parts.slice(0, 2).join(' · ');

  const primitiveParts = Object.entries(metadata)
    .filter(([, value]) => isPrimitive(value))
    .slice(0, 3)
    .map(([key, value]) => `${key}: ${summaryValue(value)}`);
  if (primitiveParts.length) return primitiveParts.join(' · ');

  const objectCount = Object.keys(metadata).length;
  return objectCount ? `${objectCount} 个字段；可查看详情` : '无附加信息';
}

export function serializeAuditMetadata(metadata) {
  return JSON.stringify(metadata, null, 2);
}

export function serializeAuditSearchValue(value) {
  try {
    return JSON.stringify(value, (_key, entryValue) => {
      if (typeof entryValue === 'string') return entryValue.slice(0, 512);
      if (Array.isArray(entryValue)) return entryValue.slice(0, 30);
      return entryValue;
    });
  } catch {
    return '';
  }
}

export function shortId(value) {
  const text = String(value || '').trim();
  if (!text) return '-';
  return text.length > 18 ? `${text.slice(0, 10)}...${text.slice(-5)}` : text;
}

function preferredSummaryKeys(eventType) {
  if (eventType === 'site.owner.transfer') return ['siteSlug', 'fromOwner', 'toOwner'];
  if (eventType === 'admin.department_team.merge') return ['sourceTeamId', 'targetTeamId', 'sites', 'accessKeys', 'members'];
  if (eventType === 'admin.cleanup_run_due' || eventType === 'admin.cleanup_run') {
    return ['requested', 'processed', 'succeeded', 'failed', 'skipped', 'status'];
  }
  if (eventType === 'admin.v1_site_retire') return ['siteName', 'stage', 'hostname'];
  if (eventType === 'connection.request.deny') return ['email', 'reason', 'reasonCode'];
  return ['stage', 'failureCode', 'siteSlug', 'siteId', 'teamId', 'targetTeamId', 'userId', 'action', 'reason', 'status'];
}

function formatKnownMetadataSummary(metadata, eventType) {
  if (eventType === 'site.owner.transfer') {
    const fromOwner = formatOwner(metadata.fromOwner);
    const toOwner = formatOwner(metadata.toOwner);
    if (metadata.siteSlug && fromOwner && toOwner) return `${metadata.siteSlug}；${fromOwner} → ${toOwner}`;
  }

  if (eventType === 'admin.department_team.merge') {
    const counts = metadata.counts && typeof metadata.counts === 'object' ? metadata.counts : {};
    const countParts = [
      ['sites', '站点'],
      ['accessKeys', 'Access Key'],
      ['members', '成员'],
    ]
      .filter(([key]) => counts[key] !== undefined && counts[key] !== null)
      .map(([key, label]) => `${label} ${counts[key]}`);
    if (metadata.sourceTeamId && metadata.targetTeamId && countParts.length) {
      return `${metadata.sourceTeamId} → ${metadata.targetTeamId}；${countParts.join(' / ')}`;
    }
  }

  if (eventType === 'admin.v1_site_retire') {
    const siteName = metadata.siteName || metadata.name;
    if (siteName && metadata.stage && metadata.hostname) {
      return `${siteName}；阶段 ${metadata.stage}；${metadata.hostname}`;
    }
  }

  return '';
}

function formatOwner(owner) {
  if (!owner || typeof owner !== 'object' || !owner.type || !owner.id) return '';
  return `${owner.type}:${owner.id}`;
}

function eventLabelText(eventType) {
  const label = auditEventLabel(eventType);
  return `${label.title} ${label.technical}`;
}

function summaryValue(value) {
  if (isPrimitive(value)) return String(value);
  if (Array.isArray(value)) return `${value.length} 项`;
  if (value && typeof value === 'object') return Object.keys(value).join('/') || '对象';
  return '-';
}

function isPrimitive(value) {
  return value === null || ['string', 'number', 'boolean'].includes(typeof value);
}

function normalizeText(value) {
  return String(value || '').trim();
}
