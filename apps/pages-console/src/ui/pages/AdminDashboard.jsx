import { Activity, AlertTriangle, Archive, Boxes, Clock3, Recycle, Rocket, UsersRound } from 'lucide-react';
import { useEffect, useState } from 'react';

import { getAdminDashboard } from '../api.js';
import { formatCleanupBacklogAge } from '../admin-resource-governance-model.js';
import { adminDeploymentActorView, adminDeploymentOwnerView } from '../site-display-model.js';

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
  const resourceCleanup = state.dashboard?.resourceCleanup || {};

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
            <p>资源回收概览</p>
            <h2>Cleanup backlog</h2>
          </div>
        </div>
        <div className="stats-strip">
          <DashboardResourceStat icon={Recycle} label="Pending tasks" value={resourceCleanup.pendingTasks ?? 0} />
          <DashboardResourceStat icon={AlertTriangle} label="Failed tasks" value={resourceCleanup.failedTasks ?? 0} />
          <DashboardResourceStat
            icon={Clock3}
            label="最老 Pending"
            title={resourceCleanup.oldestPendingAt || ''}
            value={formatCleanupBacklogAge(resourceCleanup.oldestPendingAgeSeconds)}
          />
          <DashboardResourceStat
            icon={Boxes}
            label="Orphan 候选 · 按需扫描"
            value={resourceCleanup.orphanCandidates === null ? '—' : (resourceCleanup.orphanCandidates ?? '—')}
          />
          <DashboardResourceStat
            icon={Archive}
            label="v1 站点 · 按需扫描"
            value={resourceCleanup.v1Sites === null ? '—' : (resourceCleanup.v1Sites ?? '—')}
          />
        </div>
      </section>

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
                  <th>客户端来源</th>
                  <th>站点归属</th>
                  <th>操作人</th>
                  <th>阶段</th>
                  <th>错误</th>
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

function DashboardResourceStat({ icon: Icon, label, value, title = '' }) {
  return (
    <div className="stat-cell">
      <Icon size={17} />
      <span>{label}</span>
      <strong title={title}>{value}</strong>
    </div>
  );
}

function FailedDeploymentRow({ deployment }) {
  const owner = adminDeploymentOwnerView(deployment.owner);
  const actor = adminDeploymentActorView(deployment.actor);

  return (
    <tr>
      <td data-label="部署">
        <strong>{deployment.id}</strong>
        <span>{deployment.status}</span>
      </td>
      <td data-label="站点" title={deployment.siteId}>
        {deployment.siteSlug || deployment.siteId}
      </td>
      <td data-label="客户端来源">{deployment.source || '无'}</td>
      <td data-label="站点归属">
        <div className="owner-cell">
          <span
            className={
              owner.type === 'team' ? 'tag owner-tag team' : owner.type === 'not_created' ? 'tag owner-tag not-created' : 'tag owner-tag user'
            }
          >
            {owner.tag}
          </span>
          <div>
            <strong>{owner.primary}</strong>
            {owner.secondary ? <span>{owner.secondary}</span> : null}
          </div>
        </div>
      </td>
      <td data-label="操作人">
        <div className="owner-cell">
          <span className="tag owner-tag actor">{actor.tag}</span>
          <div>
            <strong>{actor.primary}</strong>
            {actor.secondary ? <span>{actor.secondary}</span> : null}
          </div>
        </div>
      </td>
      <td data-label="阶段">
        <span className="tag tag-disabled">{deployment.failureStage || deployment.operation || 'unknown'}</span>
      </td>
      <td data-label="错误" title={deployment.errorMessage || deployment.errorCode || ''}>
        {deployment.errorCode || deployment.errorMessage || '无'}
      </td>
      <td data-label="时间">{formatDate(deployment.createdAt)}</td>
    </tr>
  );
}

export function AdminError({ title, error, onRetry }) {
  return (
    <div className="empty-panel warning">
      <AlertTriangle size={18} />
      <strong>{title}</strong>
      <span>{error?.code || 'API_REQUEST_FAILED'}</span>
      {error?.message ? <span>{error.message}</span> : null}
      {error?.action ? <span>{error.action}</span> : null}
      {onRetry ? (
        <button className="secondary-button" type="button" onClick={onRetry}>
          重试
        </button>
      ) : null}
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
