import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { listAdminSites } from '../api.js';
import { adminSiteOwnerView, sitePublicUrl } from '../site-display-model.js';
import { AdminError, formatDate } from './AdminDashboard.jsx';

export function AdminSites({ siteId }) {
  const [state, setState] = useState({ status: 'loading', sites: [], error: null });
  const [query, setQuery] = useState('');
  const [ownerType, setOwnerType] = useState('all');
  const [status, setStatus] = useState('all');

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
    () => filterAdminSites(state.sites, { query, ownerType, status }),
    [state.sites, query, ownerType, status]
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
    return <AdminSiteDetail site={selectedSite} />;
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
        <span className="toolbar-count">{visibleSites.length} / {state.sites.length}</span>
      </div>
      {visibleSites.length ? (
        <div className="table-shell">
          <table className="admin-table">
            <thead>
              <tr>
                <th>站点</th>
                <th>Owner</th>
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
        <span>{url || site.id}</span>
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

function AdminSiteDetail({ site }) {
  const owner = adminSiteOwnerView(site.owner);
  const url = sitePublicUrl(site.hostname);
  return (
    <div className="admin-stack">
      <div className="panel-head flat">
        <div>
          <p>站点详情</p>
          <h2>{site.slug}</h2>
        </div>
        <Link className="table-action" to="/admin/sites">
          返回站点管理
        </Link>
      </div>
      <section className="info-list">
        <h2>基础信息</h2>
        <dl>
          <InfoRow label="站点 ID" value={site.id} />
          <InfoRow label="Slug" value={site.slug} />
          <InfoRow label="访问地址" value={url || '无'} />
          <InfoRow label="可见性" value={site.visibility || '无'} />
          <InfoRow label="状态" value={site.status || '无'} />
          <InfoRow label="创建时间" value={formatDate(site.createdAt)} />
          <InfoRow label="更新时间" value={formatDate(site.updatedAt)} />
        </dl>
      </section>
      <section className="info-list">
        <h2>归属对象</h2>
        <dl>
          <InfoRow label="类型" value={owner.type === 'team' ? '团队' : '用户'} />
          <InfoRow label="名称" value={owner.primary} />
          <InfoRow label="补充信息" value={owner.secondary || '无'} />
        </dl>
      </section>
    </div>
  );
}

function InfoRow({ label, value }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd title={String(value || '')}>{value || '无'}</dd>
    </div>
  );
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

function filterAdminSites(sites, { query, ownerType, status }) {
  const normalizedQuery = query.trim().toLowerCase();
  return sites.filter((site) => {
    const owner = adminSiteOwnerView(site.owner);
    if (ownerType !== 'all' && owner.type !== ownerType) return false;
    if (status !== 'all' && site.status !== status) return false;
    if (!normalizedQuery) return true;
    return [site.slug, site.hostname, sitePublicUrl(site.hostname), site.visibility, site.status, owner.primary, owner.secondary, owner.type]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery);
  });
}
