import { useEffect, useState } from 'react';

import { listAdminSites } from '../api.js';
import { AdminError, formatDate } from './AdminDashboard.jsx';

export function AdminSites() {
  const [state, setState] = useState({ status: 'loading', sites: [], error: null });

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

  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error') return <AdminError title="站点列表加载失败" error={state.error} />;
  if (state.sites.length === 0) return <div className="placeholder">暂无站点数据</div>;

  return (
    <div className="table-shell">
      <table className="admin-table">
        <thead>
          <tr>
            <th>站点</th>
            <th>Owner</th>
            <th>可见性</th>
            <th>状态</th>
            <th>更新时间</th>
          </tr>
        </thead>
        <tbody>
          {state.sites.map((site) => (
            <tr key={site.id}>
              <td>
                <strong>{site.slug}</strong>
                <span>{site.hostname || site.id}</span>
              </td>
              <td>
                <strong>{site.owner?.type || 'user'}</strong>
                <span>{site.owner?.id || '无'}</span>
              </td>
              <td>{site.visibility}</td>
              <td>
                <span className={site.status === 'active' ? 'tag' : 'tag muted'}>{site.status}</span>
              </td>
              <td>{formatDate(site.updatedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
