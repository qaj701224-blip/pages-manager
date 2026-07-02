import { useEffect, useState } from 'react';

import { getAdminOps } from '../api.js';
import { AdminError, formatDate } from './AdminDashboard.jsx';

export function AdminOps() {
  const [state, setState] = useState({ status: 'loading', ops: [], error: null });

  useEffect(() => {
    let active = true;
    getAdminOps()
      .then((data) => {
        if (active) setState({ status: 'ready', ops: data.ops || [], error: null });
      })
      .catch((error) => {
        if (active) setState({ status: 'error', ops: [], error });
      });
    return () => {
      active = false;
    };
  }, []);

  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error') return <AdminError title="运维诊断加载失败" error={state.error} />;
  if (state.ops.length === 0) return <div className="placeholder">暂无运维诊断</div>;

  return (
    <div className="table-shell">
      <table className="admin-table">
        <thead>
          <tr>
            <th>项目</th>
            <th>状态</th>
            <th>来源</th>
            <th>检查时间</th>
          </tr>
        </thead>
        <tbody>
          {state.ops.map((item) => (
            <tr key={item.id}>
              <td>
                <strong>{item.label}</strong>
                <span>{item.id}</span>
              </td>
              <td>{item.status}</td>
              <td>{item.source}</td>
              <td>{formatDate(item.checkedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
