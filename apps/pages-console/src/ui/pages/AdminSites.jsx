import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { listAdminSites } from '../api.js';
import { adminSiteOwnerView, filterAdminSites, siteDeploymentShapeLabel, sitePublicUrl } from '../site-display-model.js';
import { AdminError, formatDate } from './AdminDashboard.jsx';
import { SiteDetail } from './SiteDetail.jsx';

export function AdminSites({ siteId, subpage }) {
  const [state, setState] = useState({ status: 'loading', sites: [], error: null });
  const [query, setQuery] = useState('');
  const [ownerType, setOwnerType] = useState('all');
  const [status, setStatus] = useState('all');
  const [deploymentShape, setDeploymentShape] = useState('all');

  useEffect(() => {
    let active = true;
    listAdminSites()
      .then((data) => {
        if (active) setState({ status: 'ready', sites: data.sites || [], error: null });
      })
      .catch((error) => {
        if (active) setState({ status: 'error', sites: [], error });
      });
    return () => {
      active = false;
    };
  }, []);
  const visibleSites = useMemo(
    () => filterAdminSites(state.sites, { query, ownerType, status, deploymentShape }),
    [state.sites, query, ownerType, status, deploymentShape]
  );
  const selectedSite = useMemo(() => {
    if (!siteId) return null;
    return state.sites.find((site) => site.id === siteId) || null;
  }, [siteId, state.sites]);

  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error') return <AdminError title="站点列表加载失败" error={state.error} />;
  if (siteId) {
    if (!selectedSite) {
      return <AdminNotFound backTo="/admin/sites" label="返回站点管理" title="站点不存在" />;
    }
    return (
      <SiteDetail
        siteId={siteId}
        tab={subpage || 'overview'}
        scope="admin"
        embedded
        basePath={`/admin/sites/${encodeURIComponent(siteId)}`}
        backTo="/admin/sites"
        backLabel="返回站点管理"
      />
    );
  }
  if (state.sites.length === 0) return <div className="placeholder">暂无站点数据</div>;

  return (
    <>
      <div className="list-toolbar admin-list-toolbar" aria-label="站点管理筛选">
        <label className="list-search">
          <span>搜索站点</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索 slug、域名、Owner" />
        </label>
        <div className="segmented compact-segmented" role="tablist" aria-label="Owner 类型">
          {[
            ['all', '全部'],
            ['user', '用户'],
            ['team', '团队'],
          ].map(([value, label]) => (
            <button className={ownerType === value ? 'active' : ''} key={value} type="button" onClick={() => setOwnerType(value)}>
              {label}
            </button>
          ))}
        </div>
        <div className="segmented compact-segmented" role="tablist" aria-label="站点状态">
          {[
            ['all', '全部状态'],
            ['active', 'Active'],
            ['disabled', 'Disabled'],
          ].map(([value, label]) => (
            <button className={status === value ? 'active' : ''} key={value} type="button" onClick={() => setStatus(value)}>
              {label}
            </button>
          ))}
        </div>
        <select
          aria-label="站点类型"
          className="list-search"
          value={deploymentShape}
          onChange={(event) => setDeploymentShape(event.target.value)}
        >
          <option value="all">全部类型</option>
          <option value="assets-only">静态资源</option>
          <option value="worker-only">Worker</option>
          <option value="worker-with-assets">Worker + 静态资源</option>
          <option value="un-deployed">未部署</option>
        </select>
        <span className="toolbar-count">{visibleSites.length} / {state.sites.length}</span>
      </div>
      {visibleSites.length ? (
        <div className="table-shell">
          <table className="admin-table">
            <thead>
              <tr>
                <th>站点</th>
                <th>Owner</th>
                <th>站点类型</th>
                <th>可见性</th>
                <th>状态</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleSites.map((site) => (
                <AdminSiteRow key={site.id} site={site} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="placeholder">没有匹配的站点</div>
      )}
    </>
  );
}

function AdminSiteRow({ site }) {
  const owner = adminSiteOwnerView(site.owner);
  const url = sitePublicUrl(site.hostname);
  return (
    <tr>
      <td data-label="站点">
        <strong>{site.slug}</strong>
        {url && isSafeExternalUrl(url) ? (
          <a href={url} target="_blank" rel="noopener noreferrer">
            {url}
          </a>
        ) : (
          <span>{site.id}</span>
        )}
      </td>
      <td data-label="Owner">
        <div className="owner-cell">
          <span className={owner.type === 'team' ? 'tag owner-tag team' : 'tag owner-tag user'}>{owner.tag}</span>
          <div>
            <strong>{owner.primary}</strong>
            {owner.secondary ? <span>{owner.secondary}</span> : null}
          </div>
        </div>
      </td>
      <td data-label="站点类型">
        <span className="tag muted">{siteDeploymentShapeLabel(site.deploymentShape)}</span>
      </td>
      <td data-label="可见性">
        <span className={site.visibility === 'disabled' ? 'tag tag-disabled' : 'tag'}>{site.visibility}</span>
      </td>
      <td data-label="状态">
        <span className={site.status === 'active' ? 'tag tag-success' : 'tag tag-disabled'}>{site.status}</span>
      </td>
      <td data-label="更新时间">{formatDate(site.updatedAt)}</td>
      <td data-label="操作">
        <Link className="table-action" to={`/admin/sites/${encodeURIComponent(site.id)}`}>
          查看详情
        </Link>
      </td>
    </tr>
  );
}

function isSafeExternalUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

function AdminNotFound({ backTo, label, title }) {
  return (
    <div className="empty-panel warning">
      <strong>{title}</strong>
      <span>请返回列表确认对象是否仍存在。</span>
      <Link className="table-action" to={backTo}>
        {label}
      </Link>
    </div>
  );
}
