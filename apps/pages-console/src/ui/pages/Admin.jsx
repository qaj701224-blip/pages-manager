import { Activity, FileClock, LayoutDashboard, Send, ShieldCheck, UsersRound, Wrench } from 'lucide-react';

import { AdminAudit } from './AdminAudit.jsx';
import { AdminDashboard } from './AdminDashboard.jsx';
import { AdminOps } from './AdminOps.jsx';
import { AdminSites } from './AdminSites.jsx';
import { AdminTeams } from './AdminTeams.jsx';
import { AdminUsers } from './AdminUsers.jsx';
import { AdminWebhooks } from './AdminWebhooks.jsx';

const ADMIN_NAV = [
  {
    group: '运营',
    items: [
      { id: 'dashboard', label: 'Dashboard · 平台概览', href: '/admin/dashboard', icon: LayoutDashboard },
      { id: 'ops', label: 'Ops 运维', href: '/admin/ops', icon: Wrench },
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

export function AdminShell({ page = 'dashboard' }) {
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
                  <a className={item.id === current ? 'side-link active' : 'side-link'} href={item.href} key={item.id}>
                    <Icon size={17} />
                    <span>{item.label}</span>
                  </a>
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
        <AdminPageContent page={current} empty={config.empty} />
      </main>
    </div>
  );
}

function AdminPageContent({ page, empty }) {
  if (page === 'dashboard') return <AdminDashboard />;
  if (page === 'ops') return <AdminOps />;
  if (page === 'users') return <AdminUsers />;
  if (page === 'sites') return <AdminSites />;
  if (page === 'teams') return <AdminTeams />;
  if (page === 'webhooks') return <AdminWebhooks />;
  if (page === 'audit') return <AdminAudit />;
  return <div className="placeholder">{empty}</div>;
}
