import {
  Activity,
  Archive,
  FileClock,
  LayoutDashboard,
  Recycle,
  Send,
  ServerCog,
  ShieldCheck,
  UsersRound,
  Wrench,
} from 'lucide-react';
import { Link } from 'react-router-dom';

import { AdminAudit } from './AdminAudit.jsx';
import { AdminDashboard } from './AdminDashboard.jsx';
import { AdminDeploymentCleanups } from './AdminDeploymentCleanups.jsx';
import { AdminNormalWorkers } from './AdminNormalWorkers.jsx';
import { AdminOps } from './AdminOps.jsx';
import { AdminSites } from './AdminSites.jsx';
import { AdminTeams } from './AdminTeams.jsx';
import { AdminUsers } from './AdminUsers.jsx';
import { AdminV1Sites } from './AdminV1Sites.jsx';
import { AdminWebhooks } from './AdminWebhooks.jsx';

const ADMIN_NAV = [
  {
    group: '运营',
    items: [
      { id: 'dashboard', label: 'Dashboard · 平台概览', href: '/admin/dashboard', icon: LayoutDashboard },
      { id: 'ops', label: 'Ops 运维', href: '/admin/ops', icon: Wrench },
      { id: 'deployment-cleanups', label: 'Deployment Cleanups', href: '/admin/deployment-cleanups', icon: Recycle },
      { id: 'normal-workers', label: 'Legacy Normal Workers', href: '/admin/normal-workers', icon: ServerCog },
      { id: 'v1-sites', label: 'Legacy v1 Sites', href: '/admin/v1-sites', icon: Archive },
    ],
  },
  {
    group: '审核 / 管理',
    items: [
      { id: 'users', label: '用户', href: '/admin/users', icon: UsersRound },
      { id: 'sites', label: '站点管理', href: '/admin/sites', icon: Activity },
      { id: 'teams', label: '团队管理', href: '/admin/teams', icon: ShieldCheck },
    ],
  },
  {
    group: '审计',
    items: [
      { id: 'webhooks', label: 'Webhook', href: '/admin/webhooks', icon: Send },
      { id: 'audit', label: '审计日志', href: '/admin/audit', icon: FileClock },
    ],
  },
];

const ADMIN_PAGES = {
  dashboard: {
    title: '平台概览',
    meta: '运营',
    empty: '暂无平台概览数据',
  },
  ops: {
    title: 'Ops 运维',
    meta: '运营',
    empty: '暂无运维任务',
  },
  'normal-workers': {
    title: 'Legacy Normal Workers',
    meta: '运营',
    empty: '暂无 legacy Worker',
  },
  'deployment-cleanups': {
    title: 'Deployment Cleanups',
    meta: '运营',
    empty: '暂无 cleanup task',
  },
  'v1-sites': {
    title: 'Legacy v1 Sites',
    meta: '运营',
    empty: '暂无 v1 站点',
  },
  users: {
    title: '用户',
    meta: '审核 / 管理',
    empty: '暂无用户数据',
  },
  sites: {
    title: '站点管理',
    meta: '审核 / 管理',
    empty: '暂无站点数据',
  },
  teams: {
    title: '团队管理',
    meta: '审核 / 管理',
    empty: '暂无团队数据',
  },
  webhooks: {
    title: 'Webhook',
    meta: '审计',
    empty: '还没有 Webhook',
  },
  audit: {
    title: '审计日志',
    meta: '审计',
    empty: '暂无审计日志',
  },
};

export function AdminShell({ page = 'dashboard', resourceId, subpage }) {
  const current = ADMIN_PAGES[page] ? page : 'dashboard';
  const config = ADMIN_PAGES[current];

  return (
    <div className="workspace-layout admin-layout">
      <aside className="sidebar admin-sidebar">
        <nav aria-label="管理员后台导航">
          {ADMIN_NAV.map((section) => (
            <div className="side-section" key={section.group}>
              <p className="side-title">{section.group}</p>
              {section.items.map((item) => {
                const Icon = item.icon;
                return (
                  <Link className={item.id === current ? 'side-link active' : 'side-link'} to={item.href} key={item.id}>
                    <Icon size={17} />
                    <span>{item.label}</span>
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>
      </aside>
      <main className="page workspace-page admin-page">
        <div className="page-heading">
          <h1>{config.title}</h1>
          <p>{config.meta}</p>
        </div>
        <AdminPageContent page={current} empty={config.empty} resourceId={resourceId} subpage={subpage} />
      </main>
    </div>
  );
}

function AdminPageContent({ page, empty, resourceId, subpage }) {
  if (page === 'dashboard') return <AdminDashboard />;
  if (page === 'ops') return <AdminOps />;
  if (page === 'deployment-cleanups') return <AdminDeploymentCleanups />;
  if (page === 'normal-workers') return <AdminNormalWorkers />;
  if (page === 'v1-sites') return <AdminV1Sites />;
  if (page === 'users') return <AdminUsers />;
  if (page === 'sites') return <AdminSites siteId={resourceId} subpage={subpage} />;
  if (page === 'teams') return <AdminTeams teamId={resourceId} subpage={subpage} />;
  if (page === 'webhooks') return <AdminWebhooks />;
  if (page === 'audit') return <AdminAudit />;
  return <div className="placeholder">{empty}</div>;
}
