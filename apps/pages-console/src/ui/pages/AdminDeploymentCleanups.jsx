import { RefreshCw, RotateCw, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { listAdminDeploymentCleanups, runAdminDeploymentCleanup, scanAdminWorkerOrphans } from '../api.js';
import { filterWorkerOrphanScanWorkers } from '../admin-resource-governance-model.js';
import { AppTabs } from '../components/RadixPrimitives.jsx';
import { AdminError, formatDate } from './AdminDashboard.jsx';

const CLEANUP_FILTERS = [
  ['pending', '待清理'],
  ['failed', '失败'],
  ['succeeded', '已完成'],
  ['all', '全部'],
];

const ORPHAN_FILTERS = [
  ['all', '全部'],
  ['active_route', 'Active route'],
  ['rollback', 'Rollback eligible'],
  ['cleanup', 'Cleanup task'],
  ['orphan', 'Orphan candidate'],
];

const ORPHAN_REASON_FILTERS = [
  ['no_d1_reference', '无 D1 引用'],
  ['deleted_site', '站点已删除'],
  ['stale_previous_version', '历史旧版本'],
];

export function AdminDeploymentCleanups() {
  return (
    <AppTabs.Root className="admin-governance-tabs" defaultValue="cleanup-tasks">
      <AppTabs.List className="tabs-list" aria-label="资源回收视图">
        <AppTabs.Trigger className="tabs-trigger" value="cleanup-tasks">
          Cleanup Tasks
        </AppTabs.Trigger>
        <AppTabs.Trigger className="tabs-trigger" value="orphan-scan">
          Orphan Scan
        </AppTabs.Trigger>
      </AppTabs.List>
      <AppTabs.Content value="cleanup-tasks">
        <CleanupTasksPanel />
      </AppTabs.Content>
      <AppTabs.Content forceMount value="orphan-scan">
        <OrphanScanPanel />
      </AppTabs.Content>
    </AppTabs.Root>
  );
}

function CleanupTasksPanel() {
  const [filter, setFilter] = useState('pending');
  const [state, setState] = useState({ status: 'loading', tasks: [], error: null, notice: null });
  const [busyId, setBusyId] = useState('');

  useEffect(() => {
    let active = true;
    loadCleanups(filter)
      .then((tasks) => {
        if (active) setState({ status: 'ready', tasks, error: null, notice: null });
      })
      .catch((error) => {
        if (active) setState({ status: 'error', tasks: [], error, notice: null });
      });
    return () => {
      active = false;
    };
  }, [filter]);

  async function reload() {
    setState((current) => ({ ...current, status: current.tasks.length > 0 ? 'ready' : 'loading', error: null, notice: null }));
    try {
      const tasks = await loadCleanups(filter);
      setState({ status: 'ready', tasks, error: null, notice: null });
    } catch (error) {
      setState((current) => ({
        ...current,
        status: current.tasks.length > 0 ? 'ready' : 'error',
        error,
        notice: null,
      }));
    }
  }

  async function runCleanup(task) {
    const confirmation = globalThis.prompt?.(`输入 RUN ${task.id} 确认执行 WFP cleanup`);
    if (confirmation !== `RUN ${task.id}`) return;
    setBusyId(task.id);
    setState((current) => ({ ...current, error: null, notice: null }));
    try {
      const data = await runAdminDeploymentCleanup(task.id, { reason: 'manual WFP cleanup from admin console' });
      setState((current) => ({
        ...current,
        status: 'ready',
        error: null,
        notice: { message: `${data.task?.resourceRef || task.resourceRef} cleanup 已执行。` },
        tasks: current.tasks.map((item) => (item.id === task.id ? data.task : item)),
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        error,
        notice: null,
        status: current.tasks.length > 0 ? 'ready' : 'error',
      }));
    } finally {
      setBusyId('');
    }
  }

  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error' && state.tasks.length === 0) {
    return <AdminError title="Deployment Cleanups 加载失败" error={state.error} />;
  }

  return (
    <div className="admin-stack">
      <div className="admin-toolbar">
        <div className="segmented" role="tablist" aria-label="Cleanup 状态">
          {CLEANUP_FILTERS.map(([value, label]) => (
            <button className={filter === value ? 'active' : ''} key={value} type="button" onClick={() => setFilter(value)}>
              {label}
            </button>
          ))}
        </div>
        <button className="secondary-button" type="button" onClick={reload}>
          <RefreshCw size={15} />
          <span>刷新</span>
        </button>
      </div>
      {state.notice ? <div className="form-note success">{state.notice.message}</div> : null}
      {state.error ? (
        <div className="form-error">{state.error.message || state.error.code || 'CLEANUP_TASK_RUN_FAILED'}</div>
      ) : null}
      {state.tasks.length === 0 ? (
        <div className="placeholder">暂无 cleanup task</div>
      ) : (
        <div className="table-shell">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Worker</th>
                <th>状态</th>
                <th>关联</th>
                <th>执行窗口</th>
                <th>最近错误</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {state.tasks.map((task) => (
                <CleanupRow busy={busyId === task.id} key={task.id} onRun={runCleanup} task={task} />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function OrphanScanPanel() {
  const [filter, setFilter] = useState('all');
  const [state, setState] = useState({ status: 'idle', scan: null, error: null });
  const workers = state.scan?.workers || [];
  const visibleWorkers = useMemo(() => filterWorkerOrphanScanWorkers(workers, filter), [workers, filter]);

  async function runOrphanScan() {
    setState((current) => ({ ...current, status: 'scanning', error: null }));
    try {
      const data = await scanAdminWorkerOrphans();
      setState({ status: 'ready', scan: data.scan || null, error: null });
      setFilter('all');
    } catch (error) {
      setState((current) => ({ ...current, status: current.scan ? 'ready' : 'error', error }));
    }
  }

  const summary = state.scan?.summary;
  return (
    <div className="admin-stack">
      <div className="governance-intro">
        <div>
          <strong>只读盘点 WFP dispatch namespace</strong>
          <span>扫描只做引用分类，不代表资源可以删除。</span>
        </div>
        <button className="secondary-button" type="button" disabled={state.status === 'scanning'} onClick={runOrphanScan}>
          <Search size={15} />
          <span>{state.status === 'scanning' ? '扫描中…' : state.scan ? '重新扫描' : '开始扫描'}</span>
        </button>
      </div>
      {state.error && state.scan ? (
        <div className="form-error">{state.error.message || state.error.code || 'WORKER_ORPHAN_SCAN_FAILED'}</div>
      ) : null}
      {state.status === 'idle' ? <div className="placeholder">点击“开始扫描”后读取本环境 Worker 清单。</div> : null}
      {state.status === 'scanning' && !state.scan ? <div className="placeholder">正在扫描 namespace…</div> : null}
      {state.status === 'error' && !state.scan ? <AdminError title="Orphan Scan 失败" error={state.error} /> : null}
      {state.scan ? (
        <>
          <div className="stats-strip">
            <GovernanceStat label="Worker 总数" value={summary?.total} />
            <GovernanceStat label="Active route" value={summary?.referencedByActiveRoute} />
            <GovernanceStat label="Rollback eligible" value={summary?.rollbackEligibleVersion} />
            <GovernanceStat label="Cleanup task" value={summary?.hasPendingCleanupTask} />
            <GovernanceStat label="Orphan candidate" value={summary?.orphanCandidates} />
          </div>
          <div className="admin-toolbar governance-filter-toolbar">
            <div className="segmented compact-segmented" role="tablist" aria-label="Worker 分类">
              {ORPHAN_FILTERS.map(([value, label]) => (
                <button className={filter === value ? 'active' : ''} key={value} type="button" onClick={() => setFilter(value)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="segmented compact-segmented" role="tablist" aria-label="Orphan 原因">
              {ORPHAN_REASON_FILTERS.map(([value, label]) => (
                <button className={filter === value ? 'active' : ''} key={value} type="button" onClick={() => setFilter(value)}>
                  {label}
                </button>
              ))}
            </div>
            <span className="toolbar-count">
              {visibleWorkers.length} / {workers.length}
            </span>
          </div>
          <div className="governance-scan-meta">扫描时间：{formatDate(state.scan.scannedAt)}</div>
          {visibleWorkers.length > 0 ? (
            <div className="table-shell">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Worker</th>
                    <th>分类</th>
                    <th>候选原因</th>
                    <th>创建时间</th>
                    <th>更新时间</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleWorkers.map((worker) => (
                    <OrphanScanRow key={worker.name} worker={worker} />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="placeholder">没有匹配的 Worker</div>
          )}
        </>
      ) : null}
    </div>
  );
}

function GovernanceStat({ label, value }) {
  return (
    <div className="stat-cell">
      <span>{label}</span>
      <strong>{value ?? 0}</strong>
    </div>
  );
}

async function loadCleanups(filter) {
  const data = await listAdminDeploymentCleanups({ status: filter === 'all' ? '' : filter });
  return data.tasks || [];
}

function CleanupRow({ task, busy, onRun }) {
  const statusClass = task.status === 'succeeded' ? 'tag-success' : task.status === 'pending' ? 'tag-disabled' : '';

  return (
    <tr>
      <td data-label="Worker">
        <strong>{task.resourceRef}</strong>
        <span>
          {task.resourceType} · {task.cleanupReason}
        </span>
      </td>
      <td data-label="状态">
        <span className={`tag ${statusClass}`.trim()}>{task.status}</span>
        <span>{task.canRun ? '可手动执行' : '等待 drain 或已完成'}</span>
      </td>
      <td data-label="关联">
        <strong>{task.siteId || '-'}</strong>
        <span>
          {task.versionId || '-'} · {task.deploymentId || '-'}
        </span>
      </td>
      <td data-label="执行窗口">
        <strong>{formatDate(task.cleanupAfter)}</strong>
        <span>
          attempts {task.attemptCount}
          {task.lockedUntil ? ` · locked ${formatDate(task.lockedUntil)}` : ''}
        </span>
      </td>
      <td data-label="最近错误">
        <strong>{task.lastErrorCode || '-'}</strong>
        <span>{task.lastErrorMessage || '无'}</span>
      </td>
      <td data-label="操作">
        <button
          className="table-action"
          type="button"
          disabled={!task.canRun || busy}
          title={task.canRun ? `RUN ${task.id}` : '当前 task 不可执行'}
          onClick={() => onRun(task)}
        >
          <RotateCw size={16} />
          Run
        </button>
      </td>
    </tr>
  );
}

function OrphanScanRow({ worker }) {
  const classifications = [];
  if (worker.referencedByActiveRoute) classifications.push('active route');
  if (worker.rollbackEligibleVersion) classifications.push('rollback eligible');
  if (worker.hasPendingCleanupTask) classifications.push('cleanup task');
  if (worker.orphanCandidate) classifications.push('orphan candidate');

  return (
    <tr>
      <td data-label="Worker">
        <strong>{worker.name}</strong>
      </td>
      <td data-label="分类">
        <div className="chip-row">
          {(classifications.length > 0 ? classifications : ['无已知引用']).map((label) => (
            <span className={worker.orphanCandidate ? 'tag tag-disabled' : 'tag'} key={label}>
              {label}
            </span>
          ))}
        </div>
      </td>
      <td data-label="候选原因">{orphanReasonLabel(worker.orphanReason)}</td>
      <td data-label="创建时间">{formatDate(worker.createdOn)}</td>
      <td data-label="更新时间">{formatDate(worker.modifiedOn)}</td>
    </tr>
  );
}

function orphanReasonLabel(reason) {
  if (reason === 'no_d1_reference') return '无 D1 引用';
  if (reason === 'deleted_site') return '站点已删除';
  if (reason === 'stale_previous_version') return '历史旧版本';
  return '—';
}
