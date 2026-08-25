export function sitePublicUrl(hostname) {
  const value = String(hostname || '').trim();
  if (!value) return '';
  if (/^https?:\/\//i.test(value)) return value;
  return `https://${value}`;
}

export function siteCardOwnerLabel(owner) {
  if (!owner) return '';
  if (owner.type === 'team') return normalizeOwnerLabel(owner.displayName || owner.name || owner.departmentPath);
  return normalizeOwnerLabel(owner.displayName || owner.realname || owner.name);
}

export function siteVisibilityLabel(visibility) {
  const value = String(visibility || '').trim();
  const labels = {
    internal: '免登录访问',
    org: '企业成员可见',
    acl: '指定成员可见',
    owner: '仅归属方可见',
    disabled: '已停用',
  };
  return labels[value] || value;
}

export function siteExposureLabel(exposure) {
  return exposure === 'public' ? '公网' : '公司网络';
}

export function siteDeploymentShapeLabel(deploymentShape) {
  const value = String(deploymentShape || '').trim();
  if (!value) return '未部署';
  const labels = {
    'assets-only': '静态资源',
    'worker-only': 'Worker',
    'worker-with-assets': 'Worker + 静态资源',
  };
  return labels[value] || '未知类型';
}

const DEPLOYMENT_PROVIDER_OPERATION_LABELS = {
  assets_upload_session: '创建 Assets 上传会话',
  assets_upload: '上传 Assets',
  worker_put: '提交 Worker',
  worker_get: '读取 Worker',
};

const DEPLOYMENT_TRACE_STAGE_LABELS = {
  intake: '内容接收',
  auth_and_site_resolution: '认证与站点解析',
  payload_validation: '内容校验',
  deployment_record: '部署记录',
  deployment_operation: '部署编排',
  runtime_config: '运行配置',
  provider_upload: 'Provider 上传',
  provider_verify: 'Provider 校验',
  runtime_config_commit: '运行配置提交',
  version_create: '版本创建',
  route_policy_lock: '路由策略锁',
  office_net: '办公网策略',
  route_activate: '路由激活',
  route_snapshot: '路由快照',
  deployment_state_persist: '部署状态落库',
  cleanup_or_compensation: '清理 / 补偿',
  webhook_delivery: 'Webhook 投递',
};

const DEPLOYMENT_TRACE_STATUS_LABELS = {
  succeeded: '成功',
  failed: '失败',
  compensated: '已补偿',
  skipped: '已跳过',
};

const DEPLOYMENT_TRACE_IMPACT_LABELS = {
  old_version_retained: '旧版本继续服务',
  no_traffic_change: '流量未变更',
  new_version_active: '新版本已生效',
};

const DEPLOYMENT_TRACE_ACTION_LABELS = {
  retry_deploy: '重新部署',
  retry_rollback: '重新回滚',
  fix_worker_source: '修复 Worker 源码',
  manual_cleanup: '人工清理',
  wait_drain: '等待 drain',
};

const DEPLOYMENT_CLEANUP_STATUS_LABELS = {
  succeeded: '成功',
  failed: '失败',
  not_needed: '无需清理',
  scheduled: '已调度',
  unknown: '状态未知',
};

export function deploymentTraceEventView(event = {}) {
  const diagnostics = isPlainObject(event.diagnostics) ? event.diagnostics : {};
  const compensation = isPlainObject(diagnostics.compensation) ? diagnostics.compensation : {};
  const timeTitle = normalizeDeploymentDiagnosticText(event.startedAt);
  const stageCode = normalizeDeploymentDiagnosticText(event.stage);
  const statusCode = normalizeDeploymentDiagnosticText(event.status);
  const operation = normalizeDeploymentDiagnosticText(event.operation);
  const errorCode = normalizeDeploymentDiagnosticText(event.errorCode);
  const errorMessage = normalizeDeploymentDiagnosticText(event.errorMessage || diagnostics.providerMessage);
  const errorTitle = [errorCode, errorMessage].filter(Boolean).join(' · ');
  const providerParts = [
    Number.isInteger(diagnostics.httpStatus) && diagnostics.httpStatus >= 100 && diagnostics.httpStatus <= 599
      ? `HTTP ${diagnostics.httpStatus}`
      : '',
    safeDeploymentDiagnosticText(diagnostics.clientCode, 64),
    safeDeploymentDiagnosticText(diagnostics.providerCode, 64),
    safeDeploymentDiagnosticText(diagnostics.providerMessage, 512),
  ].filter(Boolean);
  const providerTitle = providerParts.join(' · ');
  const providerRequestIdTitle = normalizeDeploymentDiagnosticText(diagnostics.providerRequestId);
  const impactCode = normalizeDeploymentDiagnosticText(diagnostics.trafficImpact);
  const actionCode = normalizeDeploymentDiagnosticText(diagnostics.operatorAction);
  const cleanupStatus = normalizeDeploymentDiagnosticText(diagnostics.cleanupStatus);
  const cleanupTaskId = safeDeploymentDiagnosticText(diagnostics.cleanupTaskId, 128);
  const compensationParts = [
    traceStatusLabel(compensation.status),
    normalizeDeploymentDiagnosticText(compensation.operation),
    normalizeDeploymentDiagnosticText(compensation.providerRequestId || compensation.providerCode),
  ].filter(Boolean);

  return {
    time: timeTitle || '-',
    timeTitle,
    stage: DEPLOYMENT_TRACE_STAGE_LABELS[stageCode] || stageCode || '-',
    status: DEPLOYMENT_TRACE_STATUS_LABELS[statusCode] || statusCode || '-',
    statusCode: statusCode || 'unknown',
    duration: Number.isInteger(event.durationMs) && event.durationMs >= 0 ? `${event.durationMs} ms` : '-',
    operation: operation || '-',
    error: truncateDeploymentDiagnosticText(errorTitle, 96) || '-',
    errorTitle,
    provider: truncateDeploymentDiagnosticText(providerTitle, 120) || '-',
    providerTitle,
    providerRequestId: truncateDeploymentDiagnosticText(providerRequestIdTitle, 128) || '-',
    providerRequestIdTitle,
    impact: DEPLOYMENT_TRACE_IMPACT_LABELS[impactCode] || impactCode || '-',
    operatorAction: DEPLOYMENT_TRACE_ACTION_LABELS[actionCode] || actionCode || '-',
    cleanup: [DEPLOYMENT_CLEANUP_STATUS_LABELS[cleanupStatus] || cleanupStatus, cleanupTaskId].filter(Boolean).join(' · ') || '-',
    compensation: compensationParts.join(' · ') || '-',
  };
}

export function deploymentProviderView(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return [];

  const name = safeDeploymentDiagnosticText(provider.name);
  const operationCode = safeDeploymentDiagnosticText(provider.operation);
  const operation = DEPLOYMENT_PROVIDER_OPERATION_LABELS[operationCode] || operationCode;
  const httpStatus =
    Number.isInteger(provider.httpStatus) && provider.httpStatus >= 100 && provider.httpStatus <= 599
      ? String(provider.httpStatus)
      : '';
  const clientCode = safeDeploymentDiagnosticText(provider.clientCode);
  const providerCode = safeDeploymentDiagnosticText(provider.providerCode, 64);
  const providerMessage = safeDeploymentDiagnosticText(provider.providerMessage, 512);
  const providerRequestId = safeDeploymentDiagnosticText(provider.providerRequestId, 128);

  if (!name && !operation && !httpStatus && !clientCode && !providerCode && !providerMessage && !providerRequestId) return [];
  return [
    ['Provider', name],
    ['操作', operation],
    ['HTTP', httpStatus],
    ['客户端码', clientCode],
    ['Provider 码', providerCode],
    ['摘要', providerMessage],
    ['Request ID', providerRequestId],
  ].filter(([, value]) => value);
}

export function filterAdminSites(
  sites,
  { query = '', ownerType = 'all', status = 'all', deploymentShape = 'all', exposure = 'all' } = {}
) {
  const normalizedQuery = query.trim().toLowerCase();
  const knownDeploymentShapes = new Set(['assets-only', 'worker-only', 'worker-with-assets']);
  return sites.filter((site) => {
    const owner = adminSiteOwnerView(site.owner);
    if (ownerType !== 'all' && owner.type !== ownerType) return false;
    if (status !== 'all' && site.status !== status) return false;
    if (exposure !== 'all' && (site.exposure || 'internal') !== exposure) return false;
    if (deploymentShape === 'un-deployed') {
      if (site.deploymentShape) return false;
    } else if (deploymentShape !== 'all') {
      if (!knownDeploymentShapes.has(deploymentShape) || site.deploymentShape !== deploymentShape) return false;
    }
    if (!normalizedQuery) return true;
    return [
      site.title,
      site.displayName,
      site.slug,
      site.hostname,
      sitePublicUrl(site.hostname),
      site.visibility,
      siteExposureLabel(site.exposure),
      site.status,
      owner.primary,
      owner.secondary,
      owner.type,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery);
  });
}

export function patchSiteSummaryForId(sites, siteId, patch) {
  return sites.map((site) => {
    if (site.id !== siteId) return site;
    const updated = { ...site, ...patch };
    return { ...updated, displayName: updated.title || updated.slug };
  });
}

export function adminSiteOwnerView(owner = {}) {
  const type = owner.type === 'team' ? 'team' : 'user';
  if (type === 'team') {
    return {
      type,
      tag: 'team',
      primary: owner.departmentPath || owner.displayName || owner.id || '团队',
      secondary: owner.departmentPath && owner.displayName ? owner.displayName : owner.id || '',
    };
  }

  return {
    type,
    tag: 'user',
    primary: owner.email || owner.displayName || owner.id || '用户',
    secondary: owner.email && owner.id ? owner.id : '',
  };
}

export function adminDeploymentOwnerView(owner = {}) {
  if (owner?.state === 'not_created') {
    return {
      state: 'not_created',
      type: 'not_created',
      tag: '未创建',
      primary: '站点未创建',
      secondary: '',
    };
  }

  return {
    state: 'persisted',
    ...adminSiteOwnerView(owner),
  };
}

export function adminDeploymentActorView(actor = {}) {
  const type = normalizeOwnerLabel(actor?.type) || 'unknown';
  const displayName = normalizeOwnerLabel(actor?.displayName || actor?.realname || actor?.name);
  const email = normalizeOwnerLabel(actor?.email);
  const userId = normalizeOwnerLabel(actor?.userId);
  const actorId = normalizeOwnerLabel(actor?.id);
  const fallbackId = userId || actorId;
  const primary = displayName || email || fallbackId || '未知操作人';
  const secondary = displayName && email ? email : primary === email ? fallbackId : '';

  return {
    type,
    tag: type,
    primary,
    secondary,
  };
}

function normalizeOwnerLabel(value) {
  return String(value || '').trim();
}

function safeDeploymentDiagnosticText(value, maxLength = 256) {
  return normalizeDeploymentDiagnosticText(value).slice(0, maxLength);
}

function normalizeDeploymentDiagnosticText(value) {
  if (typeof value !== 'string' && (typeof value !== 'number' || !Number.isFinite(value))) return '';
  let normalized = '';
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    normalized += code <= 0x1f || code === 0x7f ? ' ' : character;
  }
  return normalized.trim();
}

function truncateDeploymentDiagnosticText(value, maxLength) {
  if (!value || value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(1, maxLength - 1))}…`;
}

function traceStatusLabel(value) {
  const normalized = normalizeDeploymentDiagnosticText(value);
  return DEPLOYMENT_TRACE_STATUS_LABELS[normalized] || normalized;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
