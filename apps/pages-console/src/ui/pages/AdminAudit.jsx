import { useEffect, useState } from 'react';

import { listAdminAuditEvents } from '../api.js';
import { AdminError, formatDate } from './AdminDashboard.jsx';

export function AdminAudit() {
  const [state, setState] = useState({ status: 'loading', events: [], error: null });

  useEffect(() => {
    let active = true;
    listAdminAuditEvents()
      .then((data) => {
        if (active) setState({ status: 'ready', events: data.events || [], error: null });
      })
      .catch((error) => {
        if (active) setState({ status: 'error', events: [], error });
      });
    return () => {
      active = false;
    };
  }, []);

  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error') return <AdminError title="审计日志加载失败" error={state.error} />;
  if (state.events.length === 0) return <div className="placeholder">暂无审计日志</div>;

  return (
    <div className="table-shell">
      <table className="admin-table">
        <thead>
          <tr>
            <th>事件</th>
            <th>Actor</th>
            <th>Decision</th>
            <th>Metadata</th>
            <th>时间</th>
          </tr>
        </thead>
        <tbody>
          {state.events.map((event) => (
            <tr key={event.id}>
              <td>
                <strong>{event.eventType}</strong>
                <span>{event.id}</span>
              </td>
              <td>{event.actorUserId || event.actorType}</td>
              <td>{event.decision}</td>
              <td>
                <code className="inline-code">{event.metadata ? JSON.stringify(event.metadata) : '{}'}</code>
              </td>
              <td>{formatDate(event.createdAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
