import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, LockKeyhole, Plus, Rocket, Save, Settings, ShieldCheck, SlidersHorizontal, Trash2 } from 'lucide-react';
import { Link } from 'react-router-dom';

import {
  deleteSiteRuntimeSecret,
  deleteSiteRuntimeVar,
  fetchJson,
  putSiteRuntimeSecret,
  putSiteRuntimeVar,
  updateSiteAccess,
} from '../api.js';
import { Sidebar } from '../components/Sidebar.jsx';
import { getSiteCapabilities, parseAclEntriesInput } from '../site-detail-model.js';
import { PageHeading } from './SitesDirectory.jsx';

const SITE_TABS = new Set(['overview', 'deployments', 'access', 'config', 'settings']);
const RESOURCE_TABS = new Set(['deployments', 'access', 'config']);
const VISIBILITY_OPTIONS = ['internal', 'org', 'acl', 'owner', 'disabled'];

export function SiteDetail({ siteId, tab = 'overview', sessionState }) {
  const activeTab = SITE_TABS.has(tab) ? tab : 'overview';
  const [state, setState] = useState({ status: 'loading', site: null, error: null });
  const [resourceState, setResourceState] = useState({ status: 'idle', data: null, error: null });

  const fetchActiveResource = useCallback(
    () => fetchJson(`/api/console/sites/${encodeURIComponent(siteId)}/${activeTab}`),
    [activeTab, siteId]
  );

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
    fetchJson(`/api/console/sites/${encodeURIComponent(siteId)}`)
      .then((data) => {
        if (active) setState({ status: 'ready', site: data.site || null, error: null });
      })
      .catch((error) => {
        if (active) setState({ status: 'error', site: null, error });
      });
    return () => {
      active = false;
    };
  }, [siteId]);

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

  return (
    <div className="workspace-layout context-layout">
      <SiteContextSidebar site={state.site} siteId={siteId} activeTab={activeTab} sessionState={sessionState} />
      <main className="page workspace-page">
        <PageHeading title={title} meta="站点" />
        {state.status === 'loading' ? <div className="placeholder">加载中</div> : null}
        {state.status === 'error' ? <div className="placeholder">无法加载站点</div> : null}
        {state.status === 'ready' && state.site ? (
          <SiteTabContent
            site={state.site}
            tab={activeTab}
            resourceState={resourceState}
            onResourceUpdate={(data) => setResourceState({ status: 'ready', data, error: null })}
            onSitePatch={(patch) =>
              setState((current) => (current.site ? { ...current, site: { ...current.site, ...patch }, error: null } : current))
            }
            onResourceReload={reloadResource}
          />
        ) : null}
      </main>
    </div>
  );
}

function SiteContextSidebar({ site, siteId, activeTab, sessionState }) {
  const base = `/workspace/sites/${encodeURIComponent(siteId)}`;
  const slug = site?.slug || siteId;
  return (
    <Sidebar active="personal" sessionState={sessionState}>
      <Link className="back-link" to="/workspace/published">
        <ArrowLeft size={16} />
        <span>所有站点</span>
      </Link>
      <div className="context-title">
        <h2 title={slug}>{slug}</h2>
        {site?.hostname ? <p title={site.hostname}>{site.hostname}</p> : null}
        <div className="tag-row compact-tags">
          <span className="tag">{site?.visibility || site?.access?.visibility || 'internal'}</span>
          <span className="tag muted">{site?.status || 'active'}</span>
        </div>
      </div>
      <nav className="side-section" aria-label="站点导航">
        <ContextLink href={base} active={activeTab === 'overview'} icon={<ShieldCheck size={17} />} label="概览" />
        <ContextLink
          href={`${base}/deployments`}
          active={activeTab === 'deployments'}
          icon={<Rocket size={17} />}
          label="部署记录"
        />
        <ContextLink href={`${base}/access`} active={activeTab === 'access'} icon={<LockKeyhole size={17} />} label="访问控制" />
        <ContextLink
          href={`${base}/config`}
          active={activeTab === 'config'}
          icon={<SlidersHorizontal size={17} />}
          label="运行配置"
        />
        <ContextLink href={`${base}/settings`} active={activeTab === 'settings'} icon={<Settings size={17} />} label="设置" />
      </nav>
    </Sidebar>
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

function SiteTabContent({ site, tab, resourceState, onResourceUpdate, onSitePatch, onResourceReload }) {
  if (tab === 'deployments') return <DeploymentsPanel state={resourceState} />;
  if (tab === 'access') {
    return (
      <AccessPanel
        site={site}
        state={resourceState}
        fallbackVisibility={site.access?.visibility}
        onResourceUpdate={onResourceUpdate}
        onSitePatch={onSitePatch}
      />
    );
  }
  if (tab === 'config') {
    return <ConfigPanel site={site} state={resourceState} onResourceReload={onResourceReload} />;
  }
  if (tab === 'settings') return <SiteSettingsPanel site={site} />;
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
      <InfoList
        title="站点信息"
        rows={[
          ['Slug', site.slug || '-'],
          ['Hostname', site.hostname || '-'],
          ['Owner', ownerLabel(site.owner)],
          ['Visibility', site.access?.visibility || site.visibility || 'internal'],
          ['Status', site.status || 'active'],
        ]}
      />
      <InfoList title="权限" rows={permissionRows} />
    </section>
  );
}

function DeploymentsPanel({ state }) {
  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error') return <div className="placeholder">无法加载部署记录</div>;
  const deployments = state.data?.deployments || [];
  if (!deployments.length) return <div className="placeholder">暂无部署记录</div>;

  return (
    <section className="table-list" aria-label="部署记录">
      {deployments.map((deployment) => (
        <div className="table-row" key={deployment.id}>
          <div>
            <strong>{deployment.id}</strong>
            <span>{deployment.source || 'unknown'}</span>
          </div>
          <span className="tag muted">{deployment.status || 'unknown'}</span>
          <span>{formatDate(deployment.createdAt)}</span>
        </div>
      ))}
    </section>
  );
}

function AccessPanel({ site, state, fallbackVisibility, onResourceUpdate, onSitePatch }) {
  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error') return <div className="placeholder">无法加载访问控制</div>;
  const access = state.data?.access || { visibility: fallbackVisibility || 'internal', aclEntries: [] };
  const entries = access.aclEntries || [];
  const capabilities = getSiteCapabilities(site);

  return (
    <section className="detail-stack">
      <InfoList title="访问策略" rows={[['Visibility', access.visibility || 'internal']]} />
      {capabilities.canEditAccess ? (
        <AccessPolicyForm site={site} access={access} onResourceUpdate={onResourceUpdate} onSitePatch={onSitePatch} />
      ) : (
        <div className="placeholder">当前角色只能查看访问控制</div>
      )}
      {entries.length ? (
        <section className="table-list" aria-label="ACL">
          {entries.map((entry) => (
            <div className="table-row" key={entry.id}>
              <div>
                <strong>{entry.subjectValue}</strong>
                <span>{entry.subjectType}</span>
              </div>
              <span className="tag muted">{entry.accessRole || 'viewer'}</span>
              <span>{entry.effect || 'allow'}</span>
            </div>
          ))}
        </section>
      ) : (
        <div className="placeholder">暂无 ACL 条目</div>
      )}
    </section>
  );
}

function AccessPolicyForm({ site, access, onResourceUpdate, onSitePatch }) {
  const [visibility, setVisibility] = useState(access.visibility || 'internal');
  const [aclText, setAclText] = useState(() => JSON.stringify(access.aclEntries || [], null, 2));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    setVisibility(access.visibility || 'internal');
    setAclText(JSON.stringify(access.aclEntries || [], null, 2));
  }, [access]);

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const data = await updateSiteAccess(site.id, {
        visibility,
        aclEntries: parseAclEntriesInput(aclText),
      });
      onResourceUpdate?.({ access: data.access });
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
        <div>
          <p>Admin</p>
          <h2>编辑访问控制</h2>
        </div>
        <button className="primary-button" type="submit" disabled={saving}>
          <Save size={16} />
          {saving ? '保存中' : '保存'}
        </button>
      </div>
      <div className="dialog-body">
        <label className="field">
          <span>Visibility</span>
          <select value={visibility} onChange={(event) => setVisibility(event.target.value)}>
            {VISIBILITY_OPTIONS.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          <span>ACL JSON</span>
          <textarea value={aclText} onChange={(event) => setAclText(event.target.value)} spellCheck="false" />
        </label>
        {error ? <div className="form-error">{error.code || error.message}</div> : null}
      </div>
    </form>
  );
}

function ConfigPanel({ site, state, onResourceReload }) {
  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error') return <div className="placeholder">无法加载运行配置</div>;
  const config = state.data?.config || { vars: [], secrets: [] };
  const capabilities = getSiteCapabilities(site);

  return (
    <section className="detail-stack">
      {capabilities.canEditVars ? (
        <RuntimeVarForm siteId={site.id} onResourceReload={onResourceReload} />
      ) : (
        <div className="placeholder">当前角色只能查看运行配置</div>
      )}
      <RuntimeVarList
        vars={config.vars || []}
        canEdit={capabilities.canEditVars}
        siteId={site.id}
        onResourceReload={onResourceReload}
      />
      {capabilities.canEditSecrets ? <RuntimeSecretForm siteId={site.id} onResourceReload={onResourceReload} /> : null}
      <RuntimeSecretList
        secrets={config.secrets || []}
        canEdit={capabilities.canEditSecrets}
        siteId={site.id}
        onResourceReload={onResourceReload}
      />
    </section>
  );
}

function RuntimeVarForm({ siteId, onResourceReload }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await putSiteRuntimeVar(siteId, name.trim(), value);
      setName('');
      setValue('');
      await onResourceReload?.();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="info-list" onSubmit={submit}>
      <div className="panel-head">
        <div>
          <p>Publisher</p>
          <h2>环境变量</h2>
        </div>
        <button className="primary-button" type="submit" disabled={saving || !name.trim()}>
          <Plus size={16} />
          {saving ? '保存中' : '保存'}
        </button>
      </div>
      <div className="form-grid runtime-form-body">
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="API_BASE" />
        </label>
        <label className="field">
          <span>Value</span>
          <input value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        {error ? <div className="form-error">{error.code || error.message}</div> : null}
      </div>
    </form>
  );
}

function RuntimeVarList({ vars, canEdit, siteId, onResourceReload }) {
  const [error, setError] = useState(null);

  const remove = async (name) => {
    setError(null);
    try {
      await deleteSiteRuntimeVar(siteId, name);
      await onResourceReload?.();
    } catch (nextError) {
      setError(nextError);
    }
  };

  return (
    <section className="table-list" aria-label="环境变量">
      <div className="table-toolbar">
        <strong>环境变量</strong>
        <span className="tag muted">{vars.length}</span>
      </div>
      {error ? <div className="form-error">{error.code || error.message}</div> : null}
      {vars.length ? (
        vars.map((item) => (
          <div className="table-row runtime-row" key={item.name}>
            <div>
              <strong title={item.name}>{item.name}</strong>
              <span title={item.value || '-'}>{item.value || '-'}</span>
            </div>
            <span className="tag muted">rev {item.revision || 0}</span>
            <div className="row-actions">
              <span>{formatDate(item.updatedAt)}</span>
              {canEdit ? (
                <button className="icon-button compact" type="button" title="删除" onClick={() => remove(item.name)}>
                  <Trash2 size={15} />
                </button>
              ) : null}
            </div>
          </div>
        ))
      ) : (
        <div className="placeholder">暂无环境变量</div>
      )}
    </section>
  );
}

function RuntimeSecretForm({ siteId, onResourceReload }) {
  const [name, setName] = useState('');
  const [value, setValue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  const submit = async (event) => {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await putSiteRuntimeSecret(siteId, name.trim(), value);
      setName('');
      setValue('');
      await onResourceReload?.();
    } catch (nextError) {
      setError(nextError);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="info-list" onSubmit={submit}>
      <div className="panel-head">
        <div>
          <p>Admin</p>
          <h2>Secrets</h2>
        </div>
        <button className="primary-button" type="submit" disabled={saving || !name.trim() || !value}>
          <Save size={16} />
          {saving ? '保存中' : '保存'}
        </button>
      </div>
      <div className="form-grid runtime-form-body">
        <label className="field">
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="API_TOKEN" />
        </label>
        <label className="field">
          <span>Value</span>
          <input type="password" value={value} onChange={(event) => setValue(event.target.value)} />
        </label>
        {error ? <div className="form-error">{error.code || error.message}</div> : null}
      </div>
    </form>
  );
}

function RuntimeSecretList({ secrets, canEdit, siteId, onResourceReload }) {
  const [error, setError] = useState(null);

  const remove = async (name) => {
    setError(null);
    try {
      await deleteSiteRuntimeSecret(siteId, name);
      await onResourceReload?.();
    } catch (nextError) {
      setError(nextError);
    }
  };

  return (
    <section className="table-list" aria-label="Secrets">
      <div className="table-toolbar">
        <strong>Secrets</strong>
        <span className="tag muted">{secrets.length}</span>
      </div>
      {error ? <div className="form-error">{error.code || error.message}</div> : null}
      {secrets.length ? (
        secrets.map((item) => (
          <div className="table-row runtime-row" key={item.name}>
            <div>
              <strong title={item.name}>{item.name}</strong>
              <span title={formatDate(item.updatedAt)}>{formatDate(item.updatedAt)}</span>
            </div>
            <span className="tag muted">rev {item.revision || 0}</span>
            <div className="row-actions">
              <span>值已隐藏</span>
              {canEdit ? (
                <button className="icon-button compact" type="button" title="删除" onClick={() => remove(item.name)}>
                  <Trash2 size={15} />
                </button>
              ) : null}
            </div>
          </div>
        ))
      ) : (
        <div className="placeholder">暂无 Secrets</div>
      )}
    </section>
  );
}

function SiteSettingsPanel({ site }) {
  return (
    <section className="detail-stack">
      <InfoList
        title="设置"
        rows={[
          ['Slug', site.slug || '-'],
          ['Hostname', site.hostname || '-'],
          ['Owner', ownerLabel(site.owner)],
        ]}
      />
      <div className="placeholder">暂不支持控制台修改站点设置</div>
    </section>
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
