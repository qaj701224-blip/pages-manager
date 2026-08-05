import { useEffect, useMemo, useState } from 'react';

import { listAdminV1Sites } from '../api.js';
import { filterV1Sites, isV1SiteStale } from '../admin-resource-governance-model.js';
import { AdminError, formatDate } from './AdminDashboard.jsx';

const V1_SITE_FILTERS = [
  ['all', '全部'],
  ['stale', '疑似废弃'],
  ['migrated', '已迁移候选'],
];

export function AdminV1Sites() {
  const [state, setState] = useState({ status: 'loading', sites: [], error: null });
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [referenceNow] = useState(() => Date.now());
  const [reloadVersion, setReloadVersion] = useState(0);

  useEffect(() => {
    let active = true;
    listAdminV1Sites()
      .then((data) => {
        if (active) setState({ status: 'ready', sites: data.sites || [], error: null });
      })
      .catch((error) => {
        if (active) setState({ status: 'error', sites: [], error });
      });
    return () => {
      active = false;
    };
  }, [reloadVersion]);

  function reload() {
    setState({ status: 'loading', sites: [], error: null });
    setReloadVersion((current) => current + 1);
  }

  const visibleSites = useMemo(
    () => filterV1Sites(state.sites, { query, filter, now: referenceNow }),
    [state.sites, query, filter, referenceNow]
  );

  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error') {
    return <AdminError title="Legacy v1 Sites 加载失败" error={state.error} onRetry={reload} />;
  }

  return (
    <div className="admin-stack">
      <div className="governance-intro">
        <div>
          <strong>Legacy v1 Sites 只读盘点</strong>
          <span>疑似废弃表示 metadata 更新时间距今至少 180 天；缺失或非法日期不会被自动归类。</span>
        </div>
      </div>
      <div className="list-toolbar admin-list-toolbar" aria-label="Legacy v1 Sites 筛选">
        <label className="list-search">
          <span>搜索站点</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、URL、Preset、Worker" />
        </label>
        <div className="segmented compact-segmented" role="tablist" aria-label="v1 站点分类">
          {V1_SITE_FILTERS.map(([value, label]) => (
            <button className={filter === value ? 'active' : ''} key={value} type="button" onClick={() => setFilter(value)}>
              {label}
            </button>
          ))}
        </div>
        <span className="toolbar-count">
          {visibleSites.length} / {state.sites.length}
        </span>
      </div>
      {visibleSites.length > 0 ? (
        <div className="table-shell">
          <table className="admin-table">
            <thead>
              <tr>
                <th>站点</th>
                <th>Preset / 网络</th>
                <th>v1 Worker</th>
                <th>Metadata 更新时间</th>
                <th>v2 对账</th>
              </tr>
            </thead>
            <tbody>
              {visibleSites.map((site) => (
                <V1SiteRow key={site.name} now={referenceNow} site={site} />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="placeholder">{state.sites.length === 0 ? '暂无 v1 站点' : '没有匹配的 v1 站点'}</div>
      )}
    </div>
  );
}

function V1SiteRow({ site, now }) {
  const stale = isV1SiteStale(site.updatedAt, now);
  return (
    <tr>
      <td data-label="站点">
        <strong>{site.name}</strong>
        <span>{site.url || '无 URL'}</span>
      </td>
      <td data-label="Preset / 网络">
        <strong>{site.preset || '未记录'}</strong>
        <span>{site.ipRestrict === true ? '限制公司网络' : site.ipRestrict === false ? '未限制网络' : '网络策略未知'}</span>
      </td>
      <td data-label="v1 Worker">
        <strong>{site.workerName || '未发现'}</strong>
        <span>{site.workerModifiedOn ? `更新 ${formatDate(site.workerModifiedOn)}` : '无 Worker 时间'}</span>
      </td>
      <td data-label="Metadata 更新时间">
        <strong>{formatDate(site.updatedAt)}</strong>
        <span className={stale ? 'tag tag-disabled' : 'tag'}>{stale ? '疑似废弃' : '近期或未知'}</span>
      </td>
      <td data-label="v2 对账">
        <span className={site.migratedCandidate ? 'tag tag-success' : 'tag muted'}>
          {site.migratedCandidate ? '已迁移候选' : '未匹配同名 v2 站点'}
        </span>
      </td>
    </tr>
  );
}
