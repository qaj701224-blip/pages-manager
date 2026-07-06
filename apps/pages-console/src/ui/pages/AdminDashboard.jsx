import { Activity, AlertTriangle, Boxes, Rocket, UsersRound } from 'lucide-react';
import { useEffect, useState } from 'react';

import { getAdminDashboard } from '../api.js';
import { adminSiteOwnerView } from '../site-display-model.js';

const METRICS = [
  { key: 'sites', label: '站点', icon: Boxes },
  { key: 'users', label: '用户', icon: UsersRound },
  { key: 'teams', label: '团队', icon: Activity },
  { key: 'deployments', label: '部署', icon: Rocket },
  { key: 'failedDeployments', label: '失败部署', icon: AlertTriangle },
];

export function AdminDashboard() {
  const [state, setState] = useState({ status: 'loading', dashboard: null, error: null });

  useEffect(() => {
    let active = true;
    getAdminDashboard()
      .then((data) => {
        if (active) setState({ status: 'ready', dashboard: data.dashboard, error: null });
      })
      .catch((error) => {
        if (active) setState({ status: 'error', dashboard: null, error });
      });
    return () => {
      active = false;
    };
  }, []);

  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error') return <AdminError title="平台概览加载失败" error={state.error} />;

  const counts = state.dashboard?.counts || {};
  const failedDeployments = state.dashboard?.failedDeployments || [];

  return (
    <div className="admin-stack">
      <div className="stats-strip">
        {METRICS.map((metric) => {
          const Icon = metric.icon;
          return (
            <div className="stat-cell" key={metric.key}>
              <Icon size={17} />
              <span>{metric.label}</span>
              <strong>{counts[metric.key] ?? 0}</strong>
            </div>
          );
        })}
      </div>

      <section className="table-section">
        <div className="panel-head flat">
          <div>
            <p>失败部署</p>
            <h2>最近记录</h2>
          </div>
        </div>
        {failedDeployments.length === 0 ? (
          <div className="panel-empty">暂无失败部署</div>
        ) : (
          <div className="table-shell">
            <table className="admin-table">
              <thead>
                <tr>
                  <th>部署</th>
                  <th>站点</th>
                  <th>来源</th>
                  <th>归属</th>
                  <th>操作</th>
                  <th>时间</th>
                </tr>
              </thead>
              <tbody>
                {failedDeployments.map((deployment) => (
                  <FailedDeploymentRow deployment={deployment} key={deployment.id} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function FailedDeploymentRow({ deployment }) {
  const owner = adminSiteOwnerView(deployment.owner);

  return (
    <tr>
      <td data-label="部署">
        <strong>{deployment.id}</strong>
        <span>{deployment.status}</span>
      </td>
      <td data-label="站点">{deployment.siteId}</td>
      <td data-label="来源">{deployment.source || '无'}</td>
      <td data-label="归属">
        <div className="owner-cell">
          <span className={owner.type === 'team' ? 'tag owner-tag team' : 'tag owner-tag user'}>{owner.tag}</span>
          <div>
            <strong>{owner.primary}</strong>
            {owner.secondary ? <span>{owner.secondary}</span> : null}
          </div>
        </div>
      </td>
      <td data-label="操作">{deployment.operation || '无'}</td>
      <td data-label="时间">{formatDate(deployment.createdAt)}</td>
    </tr>
  );
}

export function AdminError({ title, error }) {
  return (
    <div className="empty-panel warning">
      <AlertTriangle size={18} />
      <strong>{title}</strong>
      <span>{error?.code || 'API_REQUEST_FAILED'}</span>
    </div>
  );
}

export function formatDate(value) {
  if (!value) return '无';
  try {
    return new Intl.DateTimeFormat('zh-CN', {
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(value));
  } catch {
    return value;
  }
}
