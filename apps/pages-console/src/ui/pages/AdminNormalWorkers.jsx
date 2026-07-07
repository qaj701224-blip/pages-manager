import { Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';

import { deleteAdminNormalWorker, listAdminNormalWorkers } from '../api.js';
import { AdminError, formatDate } from './AdminDashboard.jsx';

export function AdminNormalWorkers() {
  const [state, setState] = useState({ status: 'loading', workers: [], error: null, notice: null });
  const [busyId, setBusyId] = useState('');

  useEffect(() => {
    let active = true;
    listAdminNormalWorkers()
      .then((data) => {
        if (active) setState({ status: 'ready', workers: data.workers || [], error: null, notice: null });
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
        <div className="form-error">{state.error.code || state.error.message || 'NORMAL_WORKER_DELETE_FAILED'}</div>
      ) : null}
      <div className="table-shell">
        <table className="admin-table">
          <thead>
            <tr>
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
                    disabled={!worker.canDelete || busyId === worker.id}
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
