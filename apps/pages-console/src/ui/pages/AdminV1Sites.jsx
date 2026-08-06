import { Archive, RefreshCw, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { bulkRetireAdminV1Sites, deleteAdminV1Site, listAdminV1Sites } from '../api.js';
import { filterV1Sites, isV1SiteStale } from '../admin-resource-governance-model.js';
import { AdminError, formatDate } from './AdminDashboard.jsx';

const V1_SITE_FILTERS = [
  ['all', '全部'],
  ['stale', '疑似废弃'],
  ['migrated', '已迁移候选'],
];

export function AdminV1Sites() {
  const [state, setState] = useState({ status: 'loading', sites: [], unregisteredWorkers: [], error: null, notice: null });
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [referenceNow] = useState(() => Date.now());
  const [reloadVersion, setReloadVersion] = useState(0);
  const [selectedNames, setSelectedNames] = useState(() => new Set());
  const [busyName, setBusyName] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);

  useEffect(() => {
    let active = true;
    listAdminV1Sites()
      .then((data) => {
        if (active) {
          setState({
            status: 'ready',
            sites: data.sites || [],
            unregisteredWorkers: data.unregisteredWorkers || [],
            error: null,
            notice: null,
          });
          setSelectedNames(new Set());
        }
      })
      .catch((error) => {
        if (active) setState({ status: 'error', sites: [], unregisteredWorkers: [], error, notice: null });
      });
    return () => {
      active = false;
    };
  }, [reloadVersion]);

  function reload() {
    setState({ status: 'loading', sites: [], unregisteredWorkers: [], error: null, notice: null });
    setReloadVersion((current) => current + 1);
  }

  const visibleSites = useMemo(
    () => filterV1Sites(state.sites, { query, filter, now: referenceNow }),
    [state.sites, query, filter, referenceNow]
  );
  const deletableSites = visibleSites.filter((site) => site.canRetire === true);
  const selectedDeletableSites = deletableSites.filter((site) => selectedNames.has(site.name));
  const allDeletableSelected = deletableSites.length > 0 && selectedDeletableSites.length === deletableSites.length;
  const hasCurrentFilter = Boolean(query.trim()) || filter !== 'all';

  function toggleSite(site) {
    if (site.canRetire !== true || busyName || bulkBusy) return;
    setSelectedNames((current) => {
      const next = new Set(current);
      if (next.has(site.name)) next.delete(site.name);
      else next.add(site.name);
      return next;
    });
  }

  function toggleAllFiltered() {
    if (!hasCurrentFilter || deletableSites.length === 0 || busyName || bulkBusy) return;
    setSelectedNames((current) => {
      const next = new Set(current);
      if (allDeletableSelected) {
        for (const site of deletableSites) next.delete(site.name);
      } else {
        for (const site of deletableSites) next.add(site.name);
      }
      return next;
    });
  }

  async function retireSite(site) {
    if (site.canRetire !== true || busyName || bulkBusy) return;
    const confirmation = globalThis.prompt?.(`输入站点名 ${site.name} 确认退役该 v1 站点`);
    if (confirmation === null || confirmation === undefined) return;
    if (confirmation.trim() !== site.name) {
      setState((current) => ({
        ...current,
        error: new Error(`确认输入与站点名不一致，已取消退役。请输入 ${site.name} 后重试。`),
        notice: null,
      }));
      return;
    }
    setBusyName(site.name);
    setState((current) => ({ ...current, error: null, notice: null }));
    try {
      await deleteAdminV1Site(site.name, { reason: 'retired from admin console' });
      setState((current) => ({
        ...current,
        sites: current.sites.filter((item) => item.name !== site.name),
        notice: { message: `${site.name} 已退役。` },
      }));
      setSelectedNames((current) => {
        const next = new Set(current);
        next.delete(site.name);
        return next;
      });
    } catch (error) {
      setState((current) => ({ ...current, error, notice: null }));
    } finally {
      setBusyName('');
    }
  }

  async function retireSelectedSites() {
    const names = selectedDeletableSites.map((site) => site.name);
    if (names.length === 0 || bulkBusy || busyName) return;
    const confirmation = globalThis.prompt?.(`输入 BULK RETIRE ${names.length} 确认批量退役 v1 站点：${names.join(', ')}`);
    if (confirmation === null || confirmation === undefined) return;
    if (confirmation.trim() !== `BULK RETIRE ${names.length}`) {
      setState((current) => ({
        ...current,
        error: new Error(`确认输入不正确，已取消批量退役。请输入 BULK RETIRE ${names.length} 后重试。`),
        notice: null,
      }));
      return;
    }
    setBulkBusy(true);
    setState((current) => ({ ...current, error: null, notice: null }));
    try {
      const data = await bulkRetireAdminV1Sites(names, { reason: 'bulk retired from admin console' });
      const results = Array.isArray(data.results) ? data.results : [];
      const succeeded = new Set(
        results
          .filter((result) => result.status === 'retired' || result.status === 'succeeded' || result.retired === true)
          .map((result) => result.name || result.siteName)
          .filter(Boolean)
      );
      setState((current) => ({
        ...current,
        sites: current.sites.filter((site) => !succeeded.has(site.name)),
        error: data.summary?.failed ? new Error(`有 ${data.summary.failed} 个 v1 站点退役失败。`) : null,
        notice: { message: `批量退役完成：成功 ${succeeded.size}，失败 ${data.summary?.failed || 0}。` },
      }));
      setSelectedNames(new Set());
    } catch (error) {
      setState((current) => ({ ...current, error, notice: null }));
    } finally {
      setBulkBusy(false);
    }
  }

  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error') {
    return <AdminError title="Legacy v1 Sites 加载失败" error={state.error} onRetry={reload} />;
  }

  return (
    <div className="admin-stack">
      {state.notice ? <div className="form-note success">{state.notice.message}</div> : null}
      {state.error ? <div className="form-error">{state.error.message || state.error.code || 'V1_SITE_RETIRE_FAILED'}</div> : null}
      <div className="governance-intro">
        <div>
          <strong>Legacy v1 Sites 只读盘点</strong>
          <span>退役仅针对明确不再使用的站点，必须人工逐项确认；疑似废弃只是筛选提示。</span>
        </div>
        <button className="secondary-button" type="button" onClick={reload} disabled={bulkBusy || Boolean(busyName)}>
          <RefreshCw size={15} />
          刷新
        </button>
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
      <div className="admin-toolbar" aria-label="v1 站点批量退役">
        {hasCurrentFilter ? (
          <button className="table-action" type="button" disabled={deletableSites.length === 0 || bulkBusy || Boolean(busyName)} onClick={toggleAllFiltered}>
            {allDeletableSelected ? '取消全选筛选结果' : '全选当前筛选结果'}
          </button>
        ) : null}
        <span className="toolbar-count">{selectedDeletableSites.length} 个已选择</span>
        <button className="table-action danger" type="button" disabled={selectedDeletableSites.length === 0 || bulkBusy || Boolean(busyName)} onClick={retireSelectedSites}>
          <Archive size={16} />
          批量退役
        </button>
      </div>
      {visibleSites.length > 0 ? (
        <div className="table-shell">
          <table className="admin-table">
            <thead>
              <tr>
                <th>选择</th>
                <th>站点</th>
                <th>Preset / 网络</th>
                <th>v1 Worker</th>
                <th>Metadata 更新时间</th>
                <th>v2 对账</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleSites.map((site) => (
                <V1SiteRow
                  busy={busyName === site.name}
                  key={site.name}
                  now={referenceNow}
                  onRetire={retireSite}
                  onToggle={toggleSite}
                  selected={selectedNames.has(site.name)}
                  site={site}
                  disabled={bulkBusy || Boolean(busyName)}
                />
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="placeholder">{state.sites.length === 0 ? '暂无 v1 站点' : '没有匹配的 v1 站点'}</div>
      )}
      <UnregisteredWorkerTable workers={state.unregisteredWorkers} />
    </div>
  );
}

function V1SiteRow({ site, now, selected, onToggle, onRetire, busy, disabled }) {
  const stale = isV1SiteStale(site.updatedAt, now);
  const canRetire = site.canRetire === true;
  const blockedReason = v1RetireBlockedLabel(site.retireBlockedReason);
  const url = safeExternalUrl(site.url);
  return (
    <tr>
      <td data-label="选择">
        <input
          type="checkbox"
          checked={selected}
          disabled={!canRetire || disabled}
          aria-label={`选择 ${site.name}`}
          title={canRetire ? '选择后可批量退役' : blockedReason}
          onChange={() => onToggle(site)}
        />
      </td>
      <td data-label="站点">
        <strong>{site.name}</strong>
        {!canRetire ? <span className="tag muted">{blockedReason}</span> : null}
        {url ? (
          <a href={url} target="_blank" rel="noopener noreferrer">
            {site.url}
          </a>
        ) : (
          <span>无 URL</span>
        )}
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
      <td data-label="操作">
        <button
          className="table-action danger"
          type="button"
          disabled={!canRetire || disabled || busy}
          title={canRetire ? `输入 ${site.name} 确认退役` : blockedReason}
          onClick={() => onRetire(site)}
        >
          <Trash2 size={16} />
        </button>
      </td>
    </tr>
  );
}

function v1RetireBlockedLabel(reason) {
  return (
    {
      platform_reserved: '平台保留 Worker',
      script_name_missing: '缺少 Worker metadata',
      script_name_invalid: 'Worker 名称非法',
      script_name_mismatch: 'Worker 与站点名不匹配',
      worker_missing: '对应 Worker 不存在',
      unknown_worker: '未注册 Worker 不可退役',
    }[reason] || '该站点不可退役'
  );
}

function UnregisteredWorkerTable({ workers }) {
  if (!Array.isArray(workers) || workers.length === 0) return null;
  return (
    <section className="table-section">
      <div className="panel-head flat">
        <div>
          <p>Account Worker 对账</p>
          <h2>未注册 Worker（仅展示）</h2>
        </div>
      </div>
      <div className="form-note">Unknown 与 platform_reserved Worker 永远不可选、不可退役。</div>
      <div className="table-shell">
        <table className="admin-table">
          <thead>
            <tr>
              <th>选择</th>
              <th>Worker</th>
              <th>分类</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {workers.map((worker) => (
              <tr key={worker.workerName}>
                <td data-label="选择">
                  <input type="checkbox" checked={false} disabled aria-label={`不可选 ${worker.workerName}`} />
                </td>
                <td data-label="Worker"><strong>{worker.workerName}</strong></td>
                <td data-label="分类">
                  <span className={worker.platformReserved ? 'tag tag-success' : 'tag muted'}>
                    {worker.classification === 'platform_reserved' ? 'platform_reserved' : 'unknown'}
                  </span>
                  <span>{worker.platformReserved ? '平台保留 Worker' : 'KV 无对应站点'}</span>
                </td>
                <td data-label="更新时间">{formatDate(worker.modifiedOn)}</td>
                <td data-label="操作"><span className="tag muted">不可退役</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function safeExternalUrl(value) {
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw)) return '';
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return '';
    return parsed.href;
  } catch {
    return '';
  }
}
