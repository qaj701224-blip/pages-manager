import { Archive, RefreshCw, RotateCw, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import {
  backfillAdminWorkerOrphans,
  listAdminDeploymentCleanups,
  runAdminDeploymentCleanup,
  runAdminDeploymentCleanupsDue,
  scanAdminWorkerOrphans,
} from '../api.js';
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
  ['active_route', '活跃引用'],
  ['rollback', '可回滚'],
  ['cleanup', '回收中'],
  ['orphan', '孤儿候选'],
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
      <AppTabs.Content className="tabs-content" value="cleanup-tasks">
        <CleanupTasksPanel />
      </AppTabs.Content>
      <AppTabs.Content className="tabs-content" forceMount value="orphan-scan">
        <OrphanScanPanel />
      </AppTabs.Content>
    </AppTabs.Root>
  );
}

function CleanupTasksPanel() {
  const [filter, setFilter] = useState('pending');
  const [state, setState] = useState({ status: 'loading', tasks: [], error: null, notice: null });
  const [busyId, setBusyId] = useState('');
  const [runDueBusy, setRunDueBusy] = useState(false);

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
    const confirmed = globalThis.confirm?.(`确认立即执行 cleanup task？将删除 Worker ${task.resourceRef}。`);
    if (!confirmed) return;
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

  async function runDueCleanups() {
    if (runDueBusy) return;
    setRunDueBusy(true);
    setState((current) => ({ ...current, error: null, notice: null }));
    try {
      const data = await runAdminDeploymentCleanupsDue(50, { reason: 'retry failed cleanup tasks from admin console' });
      const tasks = await loadCleanups(filter);
      setState({
        status: 'ready',
        tasks,
        error: data.summary?.failed ? new Error(`有 ${data.summary.failed} 个 cleanup task 仍然失败。`) : null,
        notice: { message: `已触发 ${data.summary?.processed ?? data.summary?.attempted ?? 0} 个到期 cleanup task。` },
      });
    } catch (error) {
      setState((current) => ({ ...current, error, notice: null }));
    } finally {
      setRunDueBusy(false);
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
        {filter === 'failed' ? (
          <button className="table-action" type="button" disabled={runDueBusy || Boolean(busyId)} onClick={runDueCleanups}>
            <RotateCw size={15} />
            重试全部 failed
          </button>
        ) : null}
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
  const [selectedNames, setSelectedNames] = useState(() => new Set());
  const [backfillBusy, setBackfillBusy] = useState(false);
  const workers = state.scan?.workers || [];
  const visibleWorkers = useMemo(() => filterWorkerOrphanScanWorkers(workers, filter), [workers, filter]);
  const completeScan = state.scan ? state.scan.completeness === 'complete' : false;
  const deletableWorkers = visibleWorkers.filter((worker) => worker.orphanCandidate);
  const selectedWorkers = deletableWorkers.filter((worker) => selectedNames.has(worker.name));
  const selectedRollbackEligibleCount = selectedWorkers.filter((worker) => worker.rollbackEligibleVersion).length;
  const allDeletableSelected = deletableWorkers.length > 0 && selectedWorkers.length === deletableWorkers.length;
  const hasCurrentFilter = filter !== 'all';

  async function runOrphanScan() {
    setState((current) => ({ ...current, status: 'scanning', error: null }));
    try {
      const data = await scanAdminWorkerOrphans();
      setState({ status: 'ready', scan: data.scan || null, error: null });
      setFilter('all');
      setSelectedNames(new Set());
    } catch (error) {
      setState((current) => ({ ...current, status: current.scan ? 'ready' : 'error', error }));
    }
  }

  function toggleWorkerSelection(worker) {
    if (!completeScan || !worker.orphanCandidate || backfillBusy) return;
    setSelectedNames((current) => {
      const next = new Set(current);
      if (next.has(worker.name)) next.delete(worker.name);
      else next.add(worker.name);
      return next;
    });
  }

  function toggleAllFilteredWorkers() {
    if (!completeScan || !hasCurrentFilter || deletableWorkers.length === 0 || backfillBusy) return;
    setSelectedNames((current) => {
      const next = new Set(current);
      if (allDeletableSelected) {
        for (const worker of deletableWorkers) next.delete(worker.name);
      } else {
        for (const worker of deletableWorkers) next.add(worker.name);
      }
      return next;
    });
  }

  async function backfillSelectedWorkers() {
    const names = selectedWorkers.map((worker) => worker.name);
    if (!completeScan || names.length === 0 || backfillBusy) return;
    const rollbackWarning = selectedRollbackEligibleCount > 0 ? '；其中包含删除后不可回滚的版本' : '';
    const confirmed = globalThis.confirm?.(
      `确认把 ${names.length} 个 Worker 转入回收队列${rollbackWarning}？\n${names.join(', ')}`
    );
    if (!confirmed) return;
    setBackfillBusy(true);
    setState((current) => ({ ...current, error: null }));
    try {
      const data = await backfillAdminWorkerOrphans(names, { reason: 'orphan backfill from admin console' });
      setState((current) => ({
        ...current,
        scan: current.scan
          ? {
              ...current.scan,
              workers: current.scan.workers.map((worker) => {
                const result = (data.results || []).find((item) => item.workerName === worker.name);
                return result?.status === 'created' ? { ...worker, hasPendingCleanupTask: true } : worker;
              }),
            }
          : current.scan,
        error: data.summary?.skipped ? new Error(`有 ${data.summary.skipped} 个 Worker 被跳过。`) : null,
      }));
      setSelectedNames(new Set());
    } catch (error) {
      setState((current) => ({ ...current, error }));
    } finally {
      setBackfillBusy(false);
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
          {state.scan.completeness === 'incomplete' ? (
            <div className="governance-incomplete-warning" role="alert">
              <strong>扫描结果可能不完整</strong>
              <span>
                namespace 清单与扫描条数不一致：已扫描 {state.scan.scannedCount ?? 0} 个，
                namespace 报告 {state.scan.namespaceScriptCount ?? 0} 个。请重新扫描后再作判断。
              </span>
            </div>
          ) : null}
          <div className="stats-strip">
            <GovernanceStat label="Worker 总数" value={summary?.total} />
            <GovernanceStat label="活跃引用" value={summary?.referencedByActiveRoute} />
            <GovernanceStat label="可回滚" value={summary?.rollbackEligibleVersion} />
            <GovernanceStat label="回收中" value={summary?.hasPendingCleanupTask} />
            <GovernanceStat label="孤儿候选" value={summary?.orphanCandidates} />
          </div>
          {selectedRollbackEligibleCount > 0 ? (
            <div className="governance-incomplete-warning" role="alert">
              <strong>包含可回滚版本</strong>
              <span>已选择 {selectedRollbackEligibleCount} 个 rollback eligible Worker；删除后该版本不可回滚。</span>
            </div>
          ) : null}
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
            {hasCurrentFilter ? (
              <button className="table-action" type="button" disabled={!completeScan || deletableWorkers.length === 0 || backfillBusy} onClick={toggleAllFilteredWorkers}>
                {allDeletableSelected ? '取消全选筛选结果' : '全选当前筛选结果'}
              </button>
            ) : null}
            <span className="toolbar-count">{selectedWorkers.length} 个候选已选择</span>
            <button
              className="table-action danger"
              type="button"
              disabled={!completeScan || selectedWorkers.length === 0 || backfillBusy}
              title={completeScan ? '仅完整扫描结果允许 backfill' : '扫描不完整，禁止 backfill'}
              onClick={backfillSelectedWorkers}
            >
              <Archive size={16} />
              转入回收队列
            </button>
          </div>
          <div className="governance-scan-meta">扫描时间：{formatDate(state.scan.scannedAt)}</div>
          {visibleWorkers.length > 0 ? (
            <div className="table-shell">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>选择</th>
                    <th>Worker</th>
                    <th>分类</th>
                    <th>候选原因</th>
                    <th>创建时间</th>
                    <th>更新时间</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleWorkers.map((worker) => (
                    <OrphanScanRow
                      key={worker.name}
                      worker={worker}
                      selected={selectedNames.has(worker.name)}
                      onToggle={toggleWorkerSelection}
                      disabled={!completeScan || backfillBusy}
                    />
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

function OrphanScanRow({ worker, selected, onToggle, disabled }) {
  const classifications = [];
  if (worker.referencedByActiveRoute) classifications.push('活跃引用');
  if (worker.rollbackEligibleVersion) classifications.push('可回滚');
  if (worker.hasPendingCleanupTask) classifications.push('回收中');
  if (worker.orphanCandidate) classifications.push('孤儿候选');

  return (
    <tr>
      <td data-label="选择">
        <input
          type="checkbox"
          checked={selected}
          disabled={disabled || !worker.orphanCandidate}
          aria-label={`选择 ${worker.name}`}
          title={worker.orphanCandidate ? '选择后可转入回收队列' : '只有孤儿候选可转入回收队列'}
          onChange={() => onToggle(worker)}
        />
      </td>
      <td data-label="Worker">
        <strong>{worker.name}</strong>
        {safeExternalUrl(worker.hostname || worker.url || worker.activeRouteHostname) ? (
          <a
            href={safeExternalUrl(worker.hostname || worker.url || worker.activeRouteHostname)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {worker.hostname || worker.url || worker.activeRouteHostname}
          </a>
        ) : null}
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

function orphanReasonLabel(reason) {
  if (reason === 'no_d1_reference') return '无 D1 引用';
  if (reason === 'deleted_site') return '站点已删除';
  if (reason === 'stale_previous_version') return '历史旧版本';
  return '—';
}
