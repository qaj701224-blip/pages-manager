import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { bulkDeleteAdminNormalWorkers, deleteAdminNormalWorker, listAdminNormalWorkers } from '../api.js';
import { AdminError, formatDate } from './AdminDashboard.jsx';

export function AdminNormalWorkers() {
  const [state, setState] = useState({ status: 'loading', workers: [], error: null, notice: null });
  const [busyId, setBusyId] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState(() => new Set());

  useEffect(() => {
    let active = true;
    listAdminNormalWorkers()
      .then((data) => {
        if (active) {
          setState({ status: 'ready', workers: data.workers || [], error: null, notice: null });
          setSelectedIds(new Set());
        }
      })
      .catch((error) => {
        if (active) setState({ status: 'error', workers: [], error, notice: null });
      });
    return () => {
      active = false;
    };
  }, []);

  async function retireWorker(worker) {
    const confirmation = globalThis.prompt?.(`输入 DELETE ${worker.workerName} 确认删除空闲 Worker`);
    if (confirmation !== `DELETE ${worker.workerName}`) return;
    setBusyId(worker.id);
    setState((current) => ({ ...current, error: null, notice: null }));
    try {
      const data = await deleteAdminNormalWorker(worker.id, { reason: 'retired from admin console' });
      setState((current) => ({
        ...current,
        status: 'ready',
        error: null,
        notice: data.warning || null,
        workers: current.workers.map((item) => (item.id === worker.id ? data.worker : item)),
      }));
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(worker.id);
        return next;
      });
    } catch (error) {
      setState((current) => ({
        ...current,
        error,
        notice: null,
        status: current.workers.length > 0 ? 'ready' : 'error',
      }));
    } finally {
      setBusyId('');
    }
  }

  // Keep row deletes and bulk deletes mutually exclusive so selection state and row updates cannot race.
  const hasSingleDeleteInFlight = Boolean(busyId);
  const deletableWorkers = state.workers.filter((worker) => worker.canDelete && worker.id !== busyId);
  const selectedDeletableIds = deletableWorkers.filter((worker) => selectedIds.has(worker.id)).map((worker) => worker.id);
  const allDeletableSelected = deletableWorkers.length > 0 && selectedDeletableIds.length === deletableWorkers.length;

  function toggleWorkerSelection(worker) {
    if (!worker.canDelete || worker.id === busyId || bulkBusy || hasSingleDeleteInFlight) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(worker.id)) {
        next.delete(worker.id);
      } else {
        next.add(worker.id);
      }
      return next;
    });
  }

  function toggleAllDeletable() {
    if (deletableWorkers.length === 0 || bulkBusy || hasSingleDeleteInFlight) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (allDeletableSelected) {
        for (const worker of deletableWorkers) next.delete(worker.id);
      } else {
        for (const worker of deletableWorkers) next.add(worker.id);
      }
      return next;
    });
  }

  async function retireSelectedWorkers() {
    const ids = selectedDeletableIds;
    if (ids.length === 0) return;
    const confirmation = globalThis.prompt?.(`输入 BULK DELETE ${ids.length} 确认批量删除空闲 Worker`);
    if (confirmation !== `BULK DELETE ${ids.length}`) return;
    setBulkBusy(true);
    setState((current) => ({ ...current, error: null, notice: null }));
    try {
      const data = await bulkDeleteAdminNormalWorkers(ids, { reason: 'bulk retired from admin console' });
      const resultById = new Map((data.results || []).filter((result) => result.worker).map((result) => [result.id, result]));
      setState((current) => ({
        ...current,
        status: 'ready',
        error: data.summary?.failed ? bulkDeletePartialError(data.summary) : null,
        notice: bulkDeleteNotice(data.summary),
        workers: current.workers.map((item) => resultById.get(item.id)?.worker || item),
      }));
      setSelectedIds(new Set());
    } catch (error) {
      setState((current) => ({
        ...current,
        error,
        notice: null,
        status: current.workers.length > 0 ? 'ready' : 'error',
      }));
    } finally {
      setBulkBusy(false);
    }
  }

  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error' && state.workers.length === 0) {
    return <AdminError title="Legacy Normal Workers 加载失败" error={state.error} />;
  }
  if (state.workers.length === 0) return <div className="placeholder">暂无 legacy Worker</div>;

  return (
    <div className="admin-stack">
      {state.notice ? (
        <div className="form-note success">
          {state.notice.message}
          {state.notice.action ? ` ${state.notice.action}` : ''}
        </div>
      ) : null}
      {state.error ? (
        <div className="form-error">{state.error.message || state.error.code || 'NORMAL_WORKER_DELETE_FAILED'}</div>
      ) : null}
      <div className="admin-toolbar" aria-label="Normal Worker 批量操作">
        <span className="toolbar-count">
          {selectedDeletableIds.length} / {deletableWorkers.length} 可删除已选择
        </span>
        <button
          className="table-action"
          type="button"
          disabled={deletableWorkers.length === 0 || bulkBusy || hasSingleDeleteInFlight}
          onClick={toggleAllDeletable}
        >
          {allDeletableSelected ? '取消全选' : '全选可删除'}
        </button>
        <button
          className="table-action danger"
          type="button"
          disabled={selectedDeletableIds.length === 0 || bulkBusy || hasSingleDeleteInFlight}
          title={selectedDeletableIds.length > 0 ? `BULK DELETE ${selectedDeletableIds.length}` : '先选择可删除 Worker'}
          onClick={retireSelectedWorkers}
        >
          <Trash2 size={16} />
          批量删除
        </button>
      </div>
      <div className="table-shell">
        <table className="admin-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  checked={allDeletableSelected}
                  disabled={deletableWorkers.length === 0 || bulkBusy || hasSingleDeleteInFlight}
                  aria-label="选择全部可删除 Worker"
                  onChange={toggleAllDeletable}
                />
              </th>
              <th>Worker</th>
              <th>状态</th>
              <th>Active route</th>
              <th>更新时间</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            {state.workers.map((worker) => (
              <tr key={worker.id}>
                <td data-label="选择">
                  <input
                    type="checkbox"
                    checked={selectedIds.has(worker.id)}
                    disabled={!worker.canDelete || worker.id === busyId || bulkBusy || hasSingleDeleteInFlight}
                    aria-label={`选择 ${worker.workerName}`}
                    onChange={() => toggleWorkerSelection(worker)}
                  />
                </td>
                <td data-label="Worker">
                  <strong>{worker.workerName}</strong>
                  <span>
                    {worker.bindingName} · #{worker.slotNumber}
                  </span>
                </td>
                <td data-label="状态">
                  <span className={`tag ${worker.lifecycle === 'active' ? 'tag-warn' : ''}`}>{worker.lifecycle}</span>
                  <span>{worker.status}</span>
                </td>
                <td data-label="Active route">
                  <strong>{worker.activeRoute?.hostname || '-'}</strong>
                  <span>{worker.activeRoute?.activeVersionId || '未被 active route 引用'}</span>
                </td>
                <td data-label="更新时间">{formatDate(worker.updatedAt)}</td>
                <td data-label="操作">
                  <button
                    className="table-action danger"
                    type="button"
                    disabled={!worker.canDelete || hasSingleDeleteInFlight || bulkBusy}
                    title={worker.canDelete ? `DELETE ${worker.workerName}` : '仍被 active route 引用，不能删除'}
                    onClick={() => retireWorker(worker)}
                  >
                    <Trash2 size={16} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function bulkDeleteNotice(summary = {}) {
  const retired = summary.retired || 0;
  const pending = summary.pending || 0;
  const failed = summary.failed || 0;
  return {
    message: `批量删除完成：${retired} 个已 retired，${pending} 个等待清理，${failed} 个失败。`,
    action: summary.pending ? '等待下一次手动 router deploy 后重试 delete_pending Worker。' : '',
  };
}

function bulkDeletePartialError(summary = {}) {
  return {
    code: 'NORMAL_WORKER_BULK_DELETE_PARTIAL',
    message: `有 ${summary.failed || 0} 个 Worker 未删除，请检查列表中的 active 或异常状态。`,
  };
}
