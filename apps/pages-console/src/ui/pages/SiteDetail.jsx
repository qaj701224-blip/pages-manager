import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowLeft,
  LockKeyhole,
  Pencil,
  Plus,
  Rocket,
  Save,
  Search,
  Settings,
  ShieldCheck,
  SlidersHorizontal,
  Trash2,
  X,
} from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';

import {
  deleteAdminSite,
  deleteAdminSiteRuntimeSecret,
  deleteAdminSiteRuntimeVar,
  deleteSite,
  deleteSiteRuntimeSecret,
  deleteSiteRuntimeVar,
  fetchJson,
  getAdminSite,
  getAdminSiteAccess,
  getAdminSiteConfig,
  getAdminSiteDeployments,
  updateAdminSiteExposure,
  listAdminTeams,
  listAdminUsers,
  listConsoleUsers,
  listTeams,
  putAdminSiteRuntimeSecret,
  putAdminSiteRuntimeVar,
  putSiteRuntimeSecret,
  putSiteRuntimeVar,
  updateAdminSiteSettings,
  updateAdminSiteAccess,
  updateSiteSettings,
  updateSiteAccess,
} from '../api.js';
import { AppDialog, ConfirmDialog, SelectField } from '../components/RadixPrimitives.jsx';
import { Sidebar } from '../components/Sidebar.jsx';
import {
  aclSubjectPlaceholder,
  aclSubjectTypeLabel,
  appendAclEntry,
  formatSiteActionError,
  getSiteCapabilities,
  normalizeAclEntriesForForm,
  removeAclEntryAt,
  siteAccessEffectLabel,
  siteAccessOptionLabel,
  siteAccessRequirementDescription,
  siteNetworkRangeView,
  siteExposureAuditWarning,
  toAclUpdatePayload,
} from '../site-detail-model.js';
import {
  buildSiteOwnerSettingsForm,
  filterSiteOwnerCandidates,
  getSiteSettingsErrorMessage,
  normalizeSiteOwnerSettingsPayload,
  siteOwnerCandidateLabel,
  siteOwnerCandidateMeta,
} from '../site-settings-model.js';
import { adminDeploymentActorView, siteVisibilityLabel } from '../site-display-model.js';
import { PageHeading } from './SitesDirectory.jsx';

const SITE_TABS = new Set(['overview', 'deployments', 'access', 'config', 'settings']);
const RESOURCE_TABS = new Set(['deployments', 'access', 'config']);
const VISIBILITY_OPTIONS = ['internal', 'org', 'acl', 'owner', 'disabled'];
const ACL_SUBJECT_OPTIONS = [
  { value: 'email', label: '邮箱' },
  { value: 'department', label: '部门' },
];

function createSiteApi(scope) {
  if (scope === 'admin') {
    return {
      backTo: '/admin/sites',
      backLabel: '返回站点管理',
      deletedRedirect: '/admin/sites',
      basePath: (siteId) => `/admin/sites/${encodeURIComponent(siteId)}`,
      getSite: getAdminSite,
      getResource: (siteId, resource) => {
        if (resource === 'deployments') return getAdminSiteDeployments(siteId);
        if (resource === 'access') return getAdminSiteAccess(siteId);
        if (resource === 'config') return getAdminSiteConfig(siteId);
        return Promise.resolve(null);
      },
      updateAccess: updateAdminSiteAccess,
      updateExposure: updateAdminSiteExposure,
      updateSettings: updateAdminSiteSettings,
      listOwnerUsers: ({ query } = {}) => listAdminUsers({ query }),
      listOwnerTeams: () => listAdminTeams({ status: 'active' }),
      putRuntimeVar: putAdminSiteRuntimeVar,
      deleteRuntimeVar: deleteAdminSiteRuntimeVar,
      putRuntimeSecret: putAdminSiteRuntimeSecret,
      deleteRuntimeSecret: deleteAdminSiteRuntimeSecret,
      deleteSite: deleteAdminSite,
    };
  }

  return {
    backTo: '/workspace/published',
    backLabel: '所有站点',
    deletedRedirect: '/workspace/published',
    basePath: (siteId) => `/workspace/sites/${encodeURIComponent(siteId)}`,
    getSite: (siteId) => fetchJson(`/api/console/sites/${encodeURIComponent(siteId)}`),
    getResource: (siteId, resource) => fetchJson(`/api/console/sites/${encodeURIComponent(siteId)}/${resource}`),
    updateAccess: updateSiteAccess,
    updateSettings: updateSiteSettings,
    listOwnerUsers: ({ query } = {}) => listConsoleUsers({ query }),
    listOwnerTeams: () => listTeams(),
    putRuntimeVar: putSiteRuntimeVar,
    deleteRuntimeVar: deleteSiteRuntimeVar,
    putRuntimeSecret: putSiteRuntimeSecret,
    deleteRuntimeSecret: deleteSiteRuntimeSecret,
    deleteSite,
  };
}

export function SiteDetail({
  siteId,
  tab = 'overview',
  sessionState,
  scope = 'workspace',
  embedded = false,
  basePath,
  backTo,
  backLabel,
}) {
  const activeTab = SITE_TABS.has(tab) ? tab : 'overview';
  const navigate = useNavigate();
  const siteApi = useMemo(() => createSiteApi(scope), [scope]);
  const resolvedBasePath = basePath || siteApi.basePath(siteId);
  const resolvedBackTo = backTo || siteApi.backTo;
  const resolvedBackLabel = backLabel || siteApi.backLabel;
  const [state, setState] = useState({ status: 'loading', site: null, error: null });
  const [resourceState, setResourceState] = useState({ status: 'idle', data: null, error: null });

  const fetchActiveResource = useCallback(() => siteApi.getResource(siteId, activeTab), [activeTab, siteApi, siteId]);

  const reloadResource = useCallback(async () => {
    if (!RESOURCE_TABS.has(activeTab)) return null;
    setResourceState({ status: 'loading', data: null, error: null });
    try {
      const data = await fetchActiveResource();
      setResourceState({ status: 'ready', data, error: null });
      return data;
    } catch (error) {
      setResourceState({ status: 'error', data: null, error });
      throw error;
    }
  }, [activeTab, fetchActiveResource]);

  useEffect(() => {
    let active = true;
    setState({ status: 'loading', site: null, error: null });
    siteApi
      .getSite(siteId)
      .then((data) => {
        if (active) setState({ status: 'ready', site: data.site || null, error: null });
      })
      .catch((error) => {
        if (active) setState({ status: 'error', site: null, error });
      });
    return () => {
      active = false;
    };
  }, [siteApi, siteId]);

  useEffect(() => {
    if (!RESOURCE_TABS.has(activeTab)) {
      setResourceState({ status: 'idle', data: null, error: null });
      return undefined;
    }

    let active = true;
    setResourceState({ status: 'loading', data: null, error: null });
    fetchActiveResource()
      .then((data) => {
        if (active) setResourceState({ status: 'ready', data, error: null });
      })
      .catch((error) => {
        if (active) setResourceState({ status: 'error', data: null, error });
      });
    return () => {
      active = false;
    };
  }, [activeTab, fetchActiveResource]);

  const title = state.site?.slug || siteId;

  const content = (
    <>
      {embedded ? (
        <div className="admin-detail-head">
          <Link className="table-action" to={resolvedBackTo}>
            {resolvedBackLabel}
          </Link>
          <PageHeading title={title} meta="站点详情" />
          <SiteDetailTabs activeTab={activeTab} basePath={resolvedBasePath} />
        </div>
      ) : (
        <PageHeading title={title} meta="站点" />
      )}
      {state.status === 'loading' ? <div className="placeholder">加载中</div> : null}
      {state.status === 'error' ? <div className="placeholder">无法加载站点</div> : null}
      {state.status === 'ready' && state.site ? (
        <SiteTabContent
          site={state.site}
          scope={scope}
          siteApi={siteApi}
          tab={activeTab}
          resourceState={resourceState}
          onResourceUpdate={(data) => setResourceState({ status: 'ready', data, error: null })}
          onSitePatch={(patch) =>
            setState((current) => (current.site ? { ...current, site: { ...current.site, ...patch }, error: null } : current))
          }
          onResourceReload={reloadResource}
          onSiteDeleted={() => navigate(siteApi.deletedRedirect)}
        />
      ) : null}
    </>
  );

  if (embedded) return <div className="admin-stack admin-site-detail">{content}</div>;

  return (
    <div className="workspace-layout context-layout">
      <SiteContextSidebar
        activeTab={activeTab}
        backLabel={resolvedBackLabel}
        backTo={resolvedBackTo}
        basePath={resolvedBasePath}
        sessionState={sessionState}
      />
      <main className="page workspace-page">{content}</main>
    </div>
  );
}

function SiteContextSidebar({ activeTab, backLabel, backTo, basePath, sessionState }) {
  return (
    <Sidebar active="personal" sessionState={sessionState}>
      <Link className="back-link" to={backTo}>
        <ArrowLeft size={16} />
        <span>{backLabel}</span>
      </Link>
      <nav className="side-section" aria-label="站点导航">
        <ContextLink href={basePath} active={activeTab === 'overview'} icon={<ShieldCheck size={17} />} label="概览" />
        <ContextLink
          href={`${basePath}/deployments`}
          active={activeTab === 'deployments'}
          icon={<Rocket size={17} />}
          label="部署记录"
        />
        <ContextLink
          href={`${basePath}/access`}
          active={activeTab === 'access'}
          icon={<LockKeyhole size={17} />}
          label="访问控制"
        />
        <ContextLink
          href={`${basePath}/config`}
          active={activeTab === 'config'}
          icon={<SlidersHorizontal size={17} />}
          label="运行配置"
        />
        <ContextLink href={`${basePath}/settings`} active={activeTab === 'settings'} icon={<Settings size={17} />} label="设置" />
      </nav>
    </Sidebar>
  );
}

function SiteDetailTabs({ activeTab, basePath }) {
  return (
    <nav className="detail-tabs" aria-label="站点详情导航">
      {[
        ['overview', '概览', basePath],
        ['deployments', '部署记录', `${basePath}/deployments`],
        ['access', '访问控制', `${basePath}/access`],
        ['config', '运行配置', `${basePath}/config`],
        ['settings', '设置', `${basePath}/settings`],
      ].map(([id, label, href]) => (
        <Link className={activeTab === id ? 'active' : ''} key={id} to={href}>
          {label}
        </Link>
      ))}
    </nav>
  );
}

function ContextLink({ href, active, icon, label }) {
  return (
    <Link className={active ? 'side-link active' : 'side-link'} to={href}>
      {icon}
      <span>{label}</span>
    </Link>
  );
}

function SiteTabContent({
  site,
  scope,
  siteApi,
  tab,
  resourceState,
  onResourceUpdate,
  onSitePatch,
  onResourceReload,
  onSiteDeleted,
}) {
  if (tab === 'deployments') return <DeploymentsPanel state={resourceState} site={site} scope={scope} />;
  if (tab === 'access') {
    return (
      <AccessPanel
        site={site}
        scope={scope}
        siteApi={siteApi}
        state={resourceState}
        fallbackVisibility={site.access?.visibility}
        onResourceUpdate={onResourceUpdate}
        onSitePatch={onSitePatch}
        onResourceReload={onResourceReload}
      />
    );
  }
  if (tab === 'config') {
    return <ConfigPanel site={site} siteApi={siteApi} state={resourceState} onResourceReload={onResourceReload} />;
  }
  if (tab === 'settings')
    return <SiteSettingsPanel site={site} siteApi={siteApi} onSiteDeleted={onSiteDeleted} onSiteUpdate={onSitePatch} />;
  return <SiteOverview site={site} />;
}

function SiteOverview({ site }) {
  const permissionRows = useMemo(
    () => [
      ['当前角色', roleLabel(site.permissions?.role)],
      ['可管理站点', site.permissions?.canManage ? '是' : '否'],
      ['可管理访问控制', site.permissions?.canManageAccess ? '是' : '否'],
    ],
    [site]
  );

  return (
    <section className="detail-stack">
      <SiteStatusSummary site={site} />
      <InfoList
        title="站点信息"
        rows={[
          ['Slug', site.slug || '-'],
          ['Hostname', site.hostname || '-'],
          ['Owner', ownerLabel(site.owner)],
        ]}
      />
      <InfoList title="权限" rows={permissionRows} />
    </section>
  );
}

function SiteStatusSummary({ site }) {
  const visibility = site.access?.visibility || site.visibility || 'internal';
  const status = site.status || 'active';
  const disabled = status === 'disabled' || visibility === 'disabled';

  return (
    <section className={disabled ? 'site-status-summary disabled' : 'site-status-summary'} aria-label="站点状态">
      <div className="site-status-summary__main">
        <span className={disabled ? 'status-dot disabled' : 'status-dot active'} />
        <div>
          <p>服务状态</p>
          <h2>{disabled ? '已停用' : '正常服务'}</h2>
          <span>{disabled ? '站点当前不会对外提供访问。' : '站点处于可访问状态，具体访问范围由访问控制决定。'}</span>
        </div>
      </div>
      <div className="site-status-summary__meta">
        <span>
          <strong>{siteVisibilityText(visibility)}</strong>
          <small>访问范围</small>
        </span>
        <span>
          <strong>{ownerLabel(site.owner)}</strong>
          <small>归属</small>
        </span>
        <span>
          <strong>{roleLabel(site.permissions?.role)}</strong>
          <small>当前角色</small>
        </span>
      </div>
    </section>
  );
}

function DeploymentsPanel({ state, site, scope }) {
  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error') return <div className="placeholder">无法加载部署记录</div>;
  const deployments = state.data?.deployments || [];
  if (!deployments.length) return <div className="placeholder">暂无部署记录</div>;

  return (
    <section className="table-list deployment-list" aria-label="部署记录">
      <div className="table-toolbar">
        <strong>部署记录</strong>
        <span className="tag muted">{deployments.length}</span>
      </div>
      <div className="deployment-table-head">
        <span>Deployment</span>
        <span>来源</span>
        {scope === 'admin' ? <span>操作人</span> : <span>归属</span>}
        <span>状态</span>
        <span>创建时间</span>
        <span>完成时间</span>
      </div>
      {deployments.map((deployment) => (
        <div className="deployment-entry" key={deployment.id}>
          <div className="table-row deployment-row">
            <div>
              <strong title={deployment.id}>{deployment.id}</strong>
              <span>{deployment.operation || '-'}</span>
            </div>
            <span>{deployment.source || 'unknown'}</span>
            {scope === 'admin' ? (
              <DeploymentActorCell actor={adminDeploymentActorView(deployment.actor)} />
            ) : (
              <span title={deploymentOwnerLabel(deployment, site)}>{deploymentOwnerLabel(deployment, site)}</span>
            )}
            <span className="tag muted">{deployment.status || 'unknown'}</span>
            <span>{formatDate(deployment.createdAt)}</span>
            <span>{formatDate(deployment.completedAt)}</span>
          </div>
          <DeploymentDiagnostics deployment={deployment} />
        </div>
      ))}
    </section>
  );
}

function DeploymentActorCell({ actor }) {
  return (
    <span title={actor.secondary ? `${actor.primary} · ${actor.secondary}` : actor.primary}>
      {actor.primary}
      {actor.secondary ? ` · ${actor.secondary}` : ''}
    </span>
  );
}

function DeploymentDiagnostics({ deployment }) {
  const summary = deploymentFailureSummary(deployment);
  if (!summary.length) return null;

  return (
    <div className="deployment-diagnostics" aria-label="部署失败诊断">
      {summary.map(([label, value]) => (
        <span className="deployment-diagnostic-item" key={label}>
          <strong>{label}</strong>
          {value}
        </span>
      ))}
    </div>
  );
}

function deploymentFailureSummary(deployment) {
  const diagnostics = deployment.failureDiagnostics || {};
  const cause = diagnostics.cause || {};
  return [
    ['阶段', deployment.failureStage || diagnostics.stage],
    ['错误', deployment.errorCode || cause.code],
    ['说明', deployment.errorMessage],
    ['影响', deploymentTrafficImpactLabel(diagnostics.trafficImpact)],
    ['建议', deploymentOperatorActionLabel(diagnostics.operatorAction)],
    ['清理', diagnostics.uploadedWorkerCleanup],
  ].filter(([, value]) => value);
}

function deploymentTrafficImpactLabel(value) {
  if (value === 'old_version_retained') return '旧版本继续服务';
  return value || '';
}

function deploymentOperatorActionLabel(value) {
  if (value === 'retry_deploy') return '重新部署';
  if (value === 'manual_cleanup') return '人工清理';
  if (value === 'wait_drain') return '等待 drain';
  return value || '';
}

function AccessPanel({ site, scope, siteApi, state, fallbackVisibility, onResourceUpdate, onSitePatch, onResourceReload }) {
  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error') return <div className="placeholder">无法加载访问控制</div>;
  const access = state.data?.access || { visibility: fallbackVisibility || 'internal', aclEntries: [] };
  const entries = access.aclEntries || [];
  const capabilities = getSiteCapabilities(site);

  return (
    <section className="detail-stack">
      {scope === 'admin' && siteApi.updateExposure ? (
        <AdminExposurePanel
          site={site}
          access={access}
          updateExposure={siteApi.updateExposure}
          onResourceUpdate={onResourceUpdate}
          onSitePatch={onSitePatch}
          onResourceReload={onResourceReload}
        />
      ) : null}
      {capabilities.canEditAccess ? (
        <AccessPolicyForm
          site={site}
          siteApi={siteApi}
          access={access}
          onResourceUpdate={onResourceUpdate}
          onSitePatch={onSitePatch}
        />
      ) : (
        <ReadOnlyAccessPolicy access={access} entries={entries} />
      )}
    </section>
  );
}

function AccessPolicyForm({ site, siteApi, access, onResourceUpdate, onSitePatch }) {
  const [visibility, setVisibility] = useState(access.visibility || 'internal');
  const [entries, setEntries] = useState(() => normalizeAclEntriesForForm(access.aclEntries || []));
  const [draft, setDraft] = useState({ subjectType: 'email', subjectValue: '' });
  const [aclDialogOpen, setAclDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const aclEnabled = visibility === 'acl';
  const currentExposure = access.exposure === 'public' ? 'public' : 'internal';
  const currentAccessMode = visibility === 'internal' ? 'anonymous' : visibility;

  useEffect(() => {
    setVisibility(access.visibility || 'internal');
    setEntries(normalizeAclEntriesForForm(access.aclEntries || []));
    setDraft({ subjectType: 'email', subjectValue: '' });
    setAclDialogOpen(false);
    setError(null);
  }, [access]);
  const initialEntries = useMemo(() => normalizeAclEntriesForForm(access.aclEntries || []), [access.aclEntries]);
  const isDirty = useMemo(
    () =>
      visibility !== (access.visibility || 'internal') ||
      JSON.stringify(toAclUpdatePayload(entries)) !== JSON.stringify(toAclUpdatePayload(initialEntries)),
    [visibility, access.visibility, entries, initialEntries]
  );

  const addEntry = () => {
    setError(null);
    try {
      setEntries((current) => appendAclEntry(current, draft));
      setDraft((current) => ({ ...current, subjectValue: '' }));
      setAclDialogOpen(false);
    } catch (nextError) {
      setError(nextError);
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    if (saving || !isDirty) return;
    setSaving(true);
    setError(null);
    try {
      const data = await siteApi.updateAccess(site.id, {
        visibility,
        aclEntries: toAclUpdatePayload(entries),
      });
      onResourceUpdate?.({ access: { ...access, ...data.access } });
      onSitePatch?.({
        access: { ...(site.access || {}), ...data.access },
        visibility: data.access?.visibility || visibility,
      });
    } catch (nextError) {
      setError(nextError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="info-list" onSubmit={submit}>
      <div className="panel-head">
        <h2>访问权限</h2>
        <button className="primary-button" type="submit" disabled={saving || !isDirty}>
          <Save size={16} />
          {saving ? '保存中' : '保存'}
        </button>
      </div>
      <div className="access-policy-body">
        <SelectField
          label="访问对象"
          value={visibility}
          options={VISIBILITY_OPTIONS.map((option) => ({ value: option, label: siteAccessOptionLabel(option) }))}
          onChange={setVisibility}
        />
        <p className="access-policy-description">{siteAccessRequirementDescription(visibility)}</p>
        {aclEnabled ? (
          <div className="acl-editor">
            <div className="acl-editor__head">
              <div>
                <strong>ACL 条目</strong>
                <span>允许指定邮箱或部门访问，部门路径包含其下级部门。</span>
              </div>
              <button className="secondary-button acl-add-button" type="button" onClick={() => setAclDialogOpen(true)}>
                <Plus size={16} />
                <span>添加访问对象</span>
              </button>
            </div>
            <AclEntriesTable entries={entries} onRemove={(index) => setEntries((current) => removeAclEntryAt(current, index))} />
          </div>
        ) : (
          <div className="acl-policy-summary">ACL 条目仅在访问对象选择“指定成员”时生效。</div>
        )}
        {currentExposure === 'public' ? (
          <div className={currentAccessMode === 'anonymous' ? 'form-error' : 'form-note exposure-combination-note'}>
            当前组合：{siteAccessEffectLabel({ exposure: currentExposure, accessMode: currentAccessMode })}。
          </div>
        ) : null}
        {error ? <div className="form-error">{formatSiteActionError(error)}</div> : null}
      </div>
      <AclEntryDialog
        draft={draft}
        error={error}
        open={aclDialogOpen}
        onDraftChange={setDraft}
        onOpenChange={setAclDialogOpen}
        onSubmit={addEntry}
      />
    </form>
  );
}

function AdminExposurePanel({ site, access, updateExposure, onResourceUpdate, onSitePatch, onResourceReload }) {
  const [exposure, setExposure] = useState(access.exposure || 'internal');
  const [reason, setReason] = useState('');
  const [dialog, setDialog] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [auditWarning, setAuditWarning] = useState(null);
  const rangeView = siteNetworkRangeView(exposure);

  useEffect(() => {
    setExposure(access.exposure || 'internal');
    setReason('');
    setDialog(null);
    setSaving(false);
    setError(null);
  }, [access.exposure]);

  const openPublicDialog = () => {
    setReason('');
    setError(null);
    setAuditWarning(null);
    setDialog('public');
  };

  const submitPublic = async (event) => {
    event.preventDefault();
    if (!reason.trim() || saving) return;
    await saveExposure('public', reason.trim());
  };

  const saveExposure = async (nextExposure, nextReason = null) => {
    setSaving(true);
    setError(null);
    try {
      const data = await updateExposure(site.id, {
        exposure: nextExposure,
        ...(nextReason ? { reason: nextReason } : {}),
      });
      const nextAccess = { ...access, ...(data.access || {}), exposure: nextExposure };
      setExposure(nextExposure);
      setDialog(null);
      setReason('');
      setAuditWarning(
        data.auditStatus === 'unconfirmed'
          ? siteExposureAuditWarning(nextExposure)
          : null
      );
      onResourceUpdate?.({ access: nextAccess });
      onSitePatch?.({ access: { ...(site.access || {}), ...nextAccess } });
    } catch (nextError) {
      if (nextError?.code === 'SITE_EXPOSURE_AUDIT_FAILED') {
        setExposure(nextExposure);
        setAuditWarning(siteExposureAuditWarning(nextExposure));
        try {
          await onResourceReload?.();
        } catch {
          // Keep the locally confirmed effective state and warning when the refresh is unavailable.
        }
      } else {
        setError(nextError);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <section className="info-list exposure-policy-card" aria-label="网络范围控制">
        <div className="panel-head">
          <h2>网络范围</h2>
          <span className={exposure === 'public' ? 'tag tag-success' : 'tag muted'}>
            {rangeView.status}
          </span>
        </div>
        <div className="access-policy-body">
          <div className="exposure-policy-summary">
            <div>
              <strong>{rangeView.effect}</strong>
              <span>{rangeView.description}</span>
            </div>
            {exposure === 'public' ? (
              <button className="secondary-button" type="button" disabled={saving} onClick={() => setDialog('internal')}>
                {rangeView.action}
              </button>
            ) : (
              <button className="primary-button" type="button" disabled={saving} onClick={openPublicDialog}>
                {rangeView.action}
              </button>
            )}
          </div>
          {exposure === 'public' && access.exposureReason?.text ? (
            <div className="exposure-policy-reason" aria-label="最近一次允许互联网访问原因">
              <div>
                <span>最近一次开启原因</span>
                <strong>{access.exposureReason.text}</strong>
              </div>
              <span>开启时间：{formatDate(access.exposureReason.changedAt)}</span>
            </div>
          ) : null}
          {auditWarning ? <div className="form-note">{auditWarning}</div> : null}
          {error ? <div className="form-error">{formatSiteActionError(error)}</div> : null}
        </div>
      </section>
      <AppDialog open={dialog === 'public'} title="允许互联网访问" eyebrow="网络范围" onOpenChange={(open) => !saving && !open && setDialog(null)}>
        <form className="dialog-form" onSubmit={submitPublic}>
          <p className="dialog-description">
            允许后，站点会绕过公司网络 IP 门禁。当前 Worker 会移除 XD_OFFICE_NET 绑定并校验不存在。
          </p>
          <label className="field">
            <span>开启原因</span>
            <textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="例如：staging 互联网验收"
              maxLength={500}
              autoFocus
            />
          </label>
          {error ? <div className="form-error">{formatSiteActionError(error)}</div> : null}
          <div className="dialog-actions">
            <button className="secondary-button" type="button" disabled={saving} onClick={() => setDialog(null)}>
              取消
            </button>
            <button className="primary-button" type="submit" disabled={saving || !reason.trim()}>
              {saving ? '保存中' : '确认允许'}
            </button>
          </div>
        </form>
      </AppDialog>
      <ConfirmDialog
        open={dialog === 'internal'}
        title="限制为公司网络？"
        eyebrow="网络范围"
        target={site.slug || site.id}
        targetMeta="限制后恢复公司网络 IP 门禁，访问权限与 ACL 保持不变；不会立即恢复 XD_OFFICE_NET。"
        description="确认将该站点限制为仅公司网络可访问吗？"
        confirmLabel={saving ? '保存中' : '确认限制'}
        confirming={saving}
        error={error ? formatSiteActionError(error) : ''}
        onOpenChange={(open) => !saving && !open && setDialog(null)}
        onCancel={() => setDialog(null)}
        onConfirm={() => saveExposure('internal')}
      />
    </>
  );
}

function AclEntryDialog({ open, draft, error, onDraftChange, onOpenChange, onSubmit }) {
  return (
    <AppDialog open={open} title="添加访问对象" eyebrow="ACL" onOpenChange={onOpenChange}>
      <form
        className="dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <p className="dialog-description">可以添加公司邮箱或部门路径。部门路径会覆盖该部门及其下级部门。</p>
        <SelectField
          label="类型"
          value={draft.subjectType}
          options={ACL_SUBJECT_OPTIONS}
          onChange={(subjectType) => onDraftChange((current) => ({ ...current, subjectType }))}
        />
        <label className="field">
          <span>{aclSubjectTypeLabel(draft.subjectType)}</span>
          <input
            value={draft.subjectValue}
            onChange={(event) => onDraftChange((current) => ({ ...current, subjectValue: event.target.value }))}
            placeholder={aclSubjectPlaceholder(draft.subjectType)}
            autoFocus
          />
        </label>
        {error ? <div className="form-error">{formatSiteActionError(error)}</div> : null}
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={() => onOpenChange(false)}>
            取消
          </button>
          <button className="primary-button" type="submit" disabled={!draft.subjectValue.trim()}>
            <Plus size={16} />
            <span>添加访问对象</span>
          </button>
        </div>
      </form>
    </AppDialog>
  );
}

function ReadOnlyAccessPolicy({ access, entries }) {
  const visibility = access.visibility || 'internal';
  return (
    <>
      <section className="info-list">
        <div className="panel-head">
          <h2>访问权限</h2>
        </div>
        <div className="access-policy-body">
          <dl>
            <div>
              <dt>访问对象</dt>
              <dd>{siteAccessOptionLabel(access.visibility || 'internal')}</dd>
            </div>
            <div>
              <dt>访问要求</dt>
              <dd>{siteAccessRequirementDescription(access.visibility || 'internal')}</dd>
            </div>
          </dl>
        </div>
      </section>
      {visibility === 'acl' ? <ReadOnlyAclList entries={entries} /> : null}
    </>
  );
}

function ReadOnlyAclList({ entries }) {
  if (!entries.length) return <div className="placeholder">暂无 ACL 条目</div>;
  return (
    <section className="table-list acl-list" aria-label="ACL">
      <div className="table-toolbar">
        <strong>ACL 条目</strong>
        <span className="tag muted">{entries.length}</span>
      </div>
      <AclEntriesTable entries={entries} />
    </section>
  );
}

function AclEntriesTable({ entries, onRemove }) {
  const normalizedEntries = normalizeAclEntriesForForm(entries);
  if (!normalizedEntries.length) return <div className="placeholder acl-empty">暂无 ACL 条目</div>;
  return (
    <div className={onRemove ? 'acl-table acl-table--editable' : 'acl-table'} role="table" aria-label="ACL 条目">
      <div className="acl-table-head" role="row">
        <span>类型</span>
        <span>对象</span>
        <span>权限</span>
        {onRemove ? <span>操作</span> : null}
      </div>
      {normalizedEntries.map((entry, index) => (
        <div className="acl-row" role="row" key={`${entry.subjectType}:${entry.subjectValue}:${index}`}>
          <span className="tag muted">{aclSubjectTypeLabel(entry.subjectType)}</span>
          <strong title={entry.subjectValue}>{entry.subjectValue}</strong>
          <span className="tag muted">{entry.accessRole || 'viewer'}</span>
          {onRemove ? (
            <button className="table-action danger" type="button" onClick={() => onRemove(index)}>
              <Trash2 size={15} />
              <span>移除</span>
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}

function ConfigPanel({ site, siteApi, state, onResourceReload }) {
  const [varDialogOpen, setVarDialogOpen] = useState(false);
  const [secretDialogOpen, setSecretDialogOpen] = useState(false);
  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error') return <div className="placeholder">无法加载运行配置</div>;
  const config = state.data?.config || { vars: [], secrets: [] };
  const capabilities = getSiteCapabilities(site);

  return (
    <section className="detail-stack">
      {!capabilities.canEditVars ? <div className="placeholder">当前角色只能查看运行配置</div> : null}
      <RuntimeVarList
        vars={config.vars || []}
        canEdit={capabilities.canEditVars}
        siteId={site.id}
        siteApi={siteApi}
        onAdd={() => setVarDialogOpen(true)}
        onResourceReload={onResourceReload}
      />
      <RuntimeSecretList
        secrets={config.secrets || []}
        canEdit={capabilities.canEditSecrets}
        siteId={site.id}
        siteApi={siteApi}
        onAdd={() => setSecretDialogOpen(true)}
        onResourceReload={onResourceReload}
      />
      {capabilities.canEditVars ? (
        <RuntimeVarDialog
          open={varDialogOpen}
          siteId={site.id}
          siteApi={siteApi}
          onOpenChange={setVarDialogOpen}
          onResourceReload={onResourceReload}
        />
      ) : null}
      {capabilities.canEditSecrets ? (
        <RuntimeSecretDialog
          open={secretDialogOpen}
          siteId={site.id}
          siteApi={siteApi}
          onOpenChange={setSecretDialogOpen}
          onResourceReload={onResourceReload}
        />
      ) : null}
    </section>
  );
}

function RuntimeVarDialog({ open, siteId, siteApi, onOpenChange, onResourceReload }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setValue('');
    setSaving(false);
    setError(null);
  }, [open]);

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await siteApi.putRuntimeVar(siteId, name.trim(), value);
      setName('');
      setValue('');
      await onResourceReload?.();
      onOpenChange(false);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppDialog open={open} title="添加环境变量" eyebrow="运行配置" onOpenChange={onOpenChange}>
      <form className="dialog-form" onSubmit={submit}>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field">
          <span>Value</span>
          <input value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        {error ? <div className="form-error">{formatSiteActionError(error)}</div> : null}
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </button>
          <button className="primary-button" type="submit" disabled={saving || !name.trim()}>
            <Plus size={16} />
            <span>{saving ? '保存中' : '保存'}</span>
          </button>
        </div>
      </form>
    </AppDialog>
  );
}

function RuntimeVarList({ vars, canEdit, siteId, siteApi, onAdd, onResourceReload }) {
  const [error, setError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState('');
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    if (!deleteTarget) return;
    setError(null);
    setDeleting(true);
    try {
      await siteApi.deleteRuntimeVar(siteId, deleteTarget);
      await onResourceReload?.();
      setDeleteTarget('');
    } catch (nextError) {
      setError(nextError);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="table-list" aria-label="环境变量">
      <div className="table-toolbar">
        <strong>环境变量</strong>
        <div className="runtime-list-actions">
          <span className="tag muted">{vars.length}</span>
          {canEdit ? (
            <button className="secondary-button" type="button" onClick={onAdd}>
              <Plus size={16} />
              <span>添加变量</span>
            </button>
          ) : null}
        </div>
      </div>
      {error ? <div className="form-error">{formatSiteActionError(error)}</div> : null}
      {vars.length ? (
        vars.map((item) => (
          <div className="table-row runtime-row" key={item.name}>
            <div>
              <strong title={item.name}>{item.name}</strong>
              <span title={item.value || '-'}>{item.value || '-'}</span>
            </div>
            <span className="tag muted">版本 {item.revision || 0}</span>
            <div className="row-actions">
              <span>{formatDate(item.updatedAt)}</span>
              {canEdit ? (
                <button
                  className="table-action danger"
                  type="button"
                  title={`删除变量 ${item.name}`}
                  onClick={() => {
                    setError(null);
                    setDeleteTarget(item.name);
                  }}
                >
                  <Trash2 size={15} />
                  <span>删除变量</span>
                </button>
              ) : null}
            </div>
          </div>
        ))
      ) : (
        <div className="placeholder">暂无环境变量</div>
      )}
      <RuntimeDeleteDialog
        open={Boolean(deleteTarget)}
        title="删除变量"
        targetName={deleteTarget}
        description="删除后，运行时将不再获得该环境变量。"
        confirmLabel="删除变量"
        deleting={deleting}
        error={error}
        onCancel={() => {
          if (!deleting) setDeleteTarget('');
        }}
        onConfirm={remove}
      />
    </section>
  );
}

function RuntimeSecretDialog({ open, siteId, siteApi, onOpenChange, onResourceReload }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) return;
    setName('');
    setValue('');
    setSaving(false);
    setError(null);
  }, [open]);

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await siteApi.putRuntimeSecret(siteId, name.trim(), value);
      setName('');
      setValue('');
      await onResourceReload?.();
      onOpenChange(false);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <AppDialog open={open} title="添加 Secret" eyebrow="运行配置" onOpenChange={onOpenChange}>
      <form className="dialog-form" onSubmit={submit}>
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} />
        </label>
        <label className="field">
          <span>Value</span>
          <input type="password" value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        {error ? <div className="form-error">{formatSiteActionError(error)}</div> : null}
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={() => onOpenChange(false)} disabled={saving}>
            取消
          </button>
          <button className="primary-button" type="submit" disabled={saving || !name.trim() || !value}>
            <Save size={16} />
            <span>{saving ? '保存中' : '保存'}</span>
          </button>
        </div>
      </form>
    </AppDialog>
  );
}

function RuntimeSecretList({ secrets, canEdit, siteId, siteApi, onAdd, onResourceReload }) {
  const [error, setError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState('');
  const [deleting, setDeleting] = useState(false);

  const remove = async () => {
    if (!deleteTarget) return;
    setError(null);
    setDeleting(true);
    try {
      await siteApi.deleteRuntimeSecret(siteId, deleteTarget);
      await onResourceReload?.();
      setDeleteTarget('');
    } catch (nextError) {
      setError(nextError);
    } finally {
      setDeleting(false);
    }
  };

  return (
    <section className="table-list" aria-label="Secrets">
      <div className="table-toolbar">
        <strong>Secrets</strong>
        <div className="runtime-list-actions">
          <span className="tag muted">{secrets.length}</span>
          {canEdit ? (
            <button className="secondary-button" type="button" onClick={onAdd}>
              <Plus size={16} />
              <span>添加 Secret</span>
            </button>
          ) : null}
        </div>
      </div>
      {error ? <div className="form-error">{formatSiteActionError(error)}</div> : null}
      {secrets.length ? (
        secrets.map((item) => (
          <div className="table-row runtime-row" key={item.name}>
            <div>
              <strong title={item.name}>{item.name}</strong>
              <span title={formatDate(item.updatedAt)}>{formatDate(item.updatedAt)}</span>
            </div>
            <span className="tag muted">版本 {item.revision || 0}</span>
            <div className="row-actions">
              <span>值已隐藏</span>
              {canEdit ? (
                <button
                  className="table-action danger"
                  type="button"
                  title={`删除 Secret ${item.name}`}
                  onClick={() => {
                    setError(null);
                    setDeleteTarget(item.name);
                  }}
                >
                  <Trash2 size={15} />
                  <span>删除 Secret</span>
                </button>
              ) : null}
            </div>
          </div>
        ))
      ) : (
        <div className="placeholder">暂无 Secrets</div>
      )}
      <RuntimeDeleteDialog
        open={Boolean(deleteTarget)}
        title="删除 Secret"
        targetName={deleteTarget}
        description="删除后，运行时将不再获得该 Secret。"
        confirmLabel="删除 Secret"
        deleting={deleting}
        error={error}
        onCancel={() => {
          if (!deleting) setDeleteTarget('');
        }}
        onConfirm={remove}
      />
    </section>
  );
}

function RuntimeDeleteDialog({ open, title, targetName, description, confirmLabel, deleting, error, onCancel, onConfirm }) {
  return (
    <ConfirmDialog
      open={open}
      title={title}
      target={targetName}
      targetMeta={description}
      description={description}
      confirmLabel={deleting ? '删除中' : confirmLabel}
      confirming={deleting}
      error={error}
      icon={<Trash2 size={16} />}
      onCancel={onCancel}
      onConfirm={onConfirm}
    />
  );
}

function SiteSettingsPanel({ site, siteApi, onSiteDeleted, onSiteUpdate }) {
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => buildSiteOwnerSettingsForm(site));
  const [ownerOptions, setOwnerOptions] = useState({ status: 'idle', users: [], teams: [], error: null });
  const [saveState, setSaveState] = useState({ saving: false, error: '', notice: '' });
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [deleteState, setDeleteState] = useState({ deleting: false, error: null });
  const canEdit = Boolean(site.permissions?.canManage);
  const canDelete = Boolean(site.permissions?.canManageAccess);

  useEffect(() => {
    setForm(buildSiteOwnerSettingsForm(site));
    setEditing(false);
    setOwnerOptions({ status: 'idle', users: [], teams: [], error: null });
    setSaveState({ saving: false, error: '', notice: '' });
  }, [site.id, site.owner?.type, site.owner?.id]);

  useEffect(() => {
    if (!editing) return undefined;
    let active = true;
    const timer = setTimeout(
      () => {
        setOwnerOptions((current) => ({ ...current, status: 'loading', error: null }));
        const load =
          form.ownerType === 'team'
            ? siteApi.listOwnerTeams().then((data) => ({ teams: data.teams || [] }))
            : siteApi.listOwnerUsers({ query: form.query }).then((data) => ({ users: data.users || [] }));
        load
          .then((data) => {
            if (!active) return;
            setOwnerOptions((current) => ({
              status: 'ready',
              users: data.users || current.users,
              teams: data.teams || current.teams,
              error: null,
            }));
          })
          .catch((error) => {
            if (active) setOwnerOptions((current) => ({ ...current, status: 'error', error }));
          });
      },
      form.ownerType === 'user' && form.query ? 180 : 0
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [editing, form.ownerType, form.query, siteApi]);

  const beginEdit = () => {
    setForm(buildSiteOwnerSettingsForm(site));
    setSaveState({ saving: false, error: '', notice: '' });
    setEditing(true);
  };

  const cancelEdit = () => {
    setForm(buildSiteOwnerSettingsForm(site));
    setSaveState({ saving: false, error: '', notice: '' });
    setEditing(false);
  };

  const updateOwnerType = (ownerType) => {
    setForm({ ownerType, ownerId: '', query: '' });
    setOwnerOptions((current) => ({ ...current, status: 'idle', error: null }));
  };

  const save = async (event) => {
    event.preventDefault();
    if (!canEdit || !editing) return;
    setSaveState({ saving: true, error: '', notice: '' });
    try {
      const data = await siteApi.updateSettings(site.id, normalizeSiteOwnerSettingsPayload(form));
      if (data?.site) onSiteUpdate?.(data.site);
      setEditing(false);
      setSaveState({ saving: false, error: '', notice: '站点设置已保存' });
    } catch (error) {
      setSaveState({ saving: false, error: getSiteSettingsErrorMessage(error), notice: '' });
    }
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    setDeleteState({ deleting: true, error: null });
    try {
      await siteApi.deleteSite(site.id);
      setDeleteState({ deleting: false, error: null });
      onSiteDeleted?.();
    } catch (error) {
      setDeleteState({ deleting: false, error });
    }
  };

  return (
    <section className="detail-stack">
      <form className="info-list site-settings-card" onSubmit={save}>
        <div className="panel-head">
          <div>
            <p>设置</p>
            <h2>{site.slug || site.id || '站点'}</h2>
          </div>
          <div className="panel-actions">
            {canEdit && !editing ? (
              <button
                className="secondary-button"
                type="button"
                disabled={saveState.saving || deleteState.deleting}
                onClick={beginEdit}
              >
                <Pencil size={15} />
                修改
              </button>
            ) : null}
            {canEdit && editing ? (
              <>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={saveState.saving || deleteState.deleting}
                  onClick={cancelEdit}
                >
                  <X size={15} />
                  取消
                </button>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={saveState.saving || deleteState.deleting || !form.ownerId}
                >
                  <Save size={16} />
                  {saveState.saving ? '保存中' : '保存'}
                </button>
              </>
            ) : null}
          </div>
        </div>
        <dl className={editing ? 'site-settings-rows editing' : 'site-settings-rows'}>
          <div>
            <dt>Slug</dt>
            <dd title={site.slug || '-'}>{site.slug || '-'}</dd>
          </div>
          <div>
            <dt>Hostname</dt>
            <dd title={site.hostname || '-'}>{site.hostname || '-'}</dd>
          </div>
          <div>
            <dt>Owner</dt>
            <dd title={editing ? undefined : ownerLabel(site.owner)}>
              {editing ? (
                <SiteOwnerEditor form={form} ownerOptions={ownerOptions} onChange={setForm} onOwnerTypeChange={updateOwnerType} />
              ) : (
                ownerLabel(site.owner)
              )}
            </dd>
          </div>
        </dl>
        {!canEdit || saveState.notice || saveState.error ? (
          <div className="site-settings-card-footer">
            {!canEdit ? <div className="form-note">仅站点 owner 或团队 publisher/admin 可修改站点设置。</div> : null}
            {saveState.notice ? <div className="form-note success">{saveState.notice}</div> : null}
            {saveState.error ? <div className="form-error">{saveState.error}</div> : null}
          </div>
        ) : null}
      </form>
      <section className="info-list danger-zone">
        <h2>删除站点</h2>
        <div className="danger-zone-body">
          <p>删除前请确认站点不再需要访问。删除后站点会停止服务，域名会进入短暂保留期。</p>
          {canDelete ? (
            <button className="secondary-button danger-button" type="button" onClick={() => setDeleteTarget(site)}>
              <Trash2 size={15} />
              <span>删除站点</span>
            </button>
          ) : (
            <button className="secondary-button" type="button" disabled>
              仅站点 owner 或团队 admin 可删除
            </button>
          )}
        </div>
      </section>
      <RuntimeDeleteDialog
        open={Boolean(deleteTarget)}
        title="删除站点"
        targetName={site.slug || site.id}
        description="此操作会停止站点访问并释放当前路由，删除后不可恢复。"
        confirmLabel="删除站点"
        deleting={deleteState.deleting}
        error={deleteState.error}
        onCancel={() => {
          setDeleteTarget(null);
          setDeleteState({ deleting: false, error: null });
        }}
        onConfirm={confirmDelete}
      />
    </section>
  );
}

function SiteOwnerEditor({ form, ownerOptions, onChange, onOwnerTypeChange }) {
  const rawCandidates = form.ownerType === 'team' ? ownerOptions.teams : ownerOptions.users;
  const candidates = filterSiteOwnerCandidates(rawCandidates, form.query, form.ownerType);
  const emptyText = form.ownerType === 'team' ? '没有可用团队' : '没有匹配用户';

  return (
    <div className="site-owner-editor">
      <div className="segmented compact-segmented" role="tablist" aria-label="Owner 类型">
        {[
          ['user', '个人'],
          ['team', '团队'],
        ].map(([value, label]) => (
          <button
            className={form.ownerType === value ? 'active' : ''}
            key={value}
            type="button"
            onClick={() => onOwnerTypeChange(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <label className="owner-search">
        <Search size={15} />
        <input
          value={form.query}
          onChange={(event) => onChange((current) => ({ ...current, query: event.target.value }))}
          placeholder={form.ownerType === 'team' ? '搜索团队名称或部门路径' : '搜索姓名、邮箱或部门'}
        />
      </label>
      <div className="owner-picker-list">
        {ownerOptions.status === 'loading' ? <span className="owner-picker-empty">加载中</span> : null}
        {ownerOptions.status === 'error' ? <span className="owner-picker-empty">加载失败</span> : null}
        {ownerOptions.status !== 'loading' && candidates.length === 0 ? (
          <span className="owner-picker-empty">{emptyText}</span>
        ) : null}
        {candidates.map((candidate) => {
          const selected = form.ownerId === candidate.id;
          return (
            <button
              className={selected ? 'owner-picker-row selected' : 'owner-picker-row'}
              key={candidate.id}
              type="button"
              aria-pressed={selected}
              onClick={() => onChange((current) => ({ ...current, ownerId: candidate.id }))}
            >
              <strong>{siteOwnerCandidateLabel(candidate, form.ownerType)}</strong>
              <span>{siteOwnerCandidateMeta(candidate, form.ownerType)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function InfoList({ title, rows }) {
  return (
    <section className="info-list">
      <h2>{title}</h2>
      <dl>
        {rows.map(([label, value]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd title={String(value)}>{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

function ownerLabel(owner) {
  if (!owner) return '个人';
  if (owner.displayName) return owner.displayName;
  return owner.type === 'team' ? '团队' : '个人';
}

function deploymentOwnerLabel(deployment, site) {
  return ownerLabel(deployment.owner || site?.owner);
}

function siteVisibilityText(visibility) {
  return siteVisibilityLabel(visibility) || '免登录访问';
}

function roleLabel(role) {
  if (role === 'admin') return 'admin';
  if (role === 'publisher') return 'publisher';
  if (role === 'viewer') return 'viewer';
  return role || 'viewer';
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}
