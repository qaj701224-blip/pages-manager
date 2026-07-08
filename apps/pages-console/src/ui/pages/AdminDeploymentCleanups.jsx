import { RefreshCw, RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';

import { listAdminDeploymentCleanups, runAdminDeploymentCleanup } from '../api.js';
import { AdminError, formatDate } from './AdminDashboard.jsx';

const CLEANUP_FILTERS = [
  ['pending', '待清理'],
  ['failed', '失败'],
  ['succeeded', '已完成'],
  ['all', '全部'],
];

export function AdminDeploymentCleanups() {
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
