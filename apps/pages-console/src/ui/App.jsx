import { useEffect, useState } from 'react';
import { LogIn, ShieldAlert, ShieldCheck } from 'lucide-react';

import { buildAdminLoginPath, getAdminRouteAccess } from './admin-route-model.js';
import { TopNav } from './components/TopNav.jsx';
import { AdminShell } from './pages/Admin.jsx';
import { WorkspaceAccessKeys } from './pages/AccessKeys.jsx';
import { LoginPage } from './pages/Login.jsx';
import { SiteDetail } from './pages/SiteDetail.jsx';
import { SitesDirectory } from './pages/SitesDirectory.jsx';
import { TeamDetail, TeamsList } from './pages/Teams.jsx';
import { WorkspacePlaceholder, WorkspaceSites } from './pages/WorkspaceSites.jsx';
import { clearCachedConsoleSession, readCachedConsoleSession, writeCachedConsoleSession } from './session-cache.js';

export function App() {
  const path = window.location.pathname;
  const route = readRoute(path);
  const sessionState = useConsoleSession();

  return (
    <div className="app-shell">
      <TopNav activeSection={route.section} sessionState={sessionState} />
      {route.view === 'login' ? <LoginPage /> : null}
      {route.view === 'directory' ? <SitesDirectory /> : null}
      {route.view === 'admin' ? (
        <AdminRouteGuard currentPath={`${window.location.pathname}${window.location.search}`} sessionState={sessionState}>
          <AdminShell page={route.page} />
        </AdminRouteGuard>
      ) : null}
      {route.view === 'workspace-personal' ? <WorkspaceSites owner="personal" /> : null}
      {route.view === 'workspace-team' ? <WorkspaceSites owner="team" /> : null}
      {route.view === 'site-detail' ? <SiteDetail siteId={route.siteId} tab={route.tab} /> : null}
      {route.view === 'teams' ? <TeamsList /> : null}
      {route.view === 'team-detail' ? <TeamDetail teamId={route.teamId} tab={route.tab} /> : null}
      {route.view === 'access-keys' ? <WorkspaceAccessKeys /> : null}
      {route.view === 'settings' ? <WorkspacePlaceholder active="settings" title="账号设置" /> : null}
    </div>
  );
}

function useConsoleSession() {
  const [state, setState] = useState(() => {
    const cached = readCachedConsoleSession();
    if (cached) return { status: 'ready', session: cached.session, source: 'cache' };
    return { status: 'loading', session: null, source: 'network' };
  });

  useEffect(() => {
    const cached = readCachedConsoleSession();
    if (cached?.fresh) return undefined;

    let active = true;
    fetch('/api/console/auth/session', { credentials: 'same-origin' })
      .then((response) => response.json())
      .then((session) => {
        if (!active) return;
        if (session?.authenticated) {
          writeCachedConsoleSession(session);
        } else {
          clearCachedConsoleSession();
        }
        setState({ status: 'ready', session, source: 'network' });
      })
      .catch(() => {
        if (!active) return;
        clearCachedConsoleSession();
        setState({ status: 'ready', session: { authenticated: false, user: null }, source: 'network' });
      });
    return () => {
      active = false;
    };
  }, []);

  return state;
}

function AdminRouteGuard({ children, currentPath, sessionState }) {
  const access = sessionState.status === 'ready' ? getAdminRouteAccess(sessionState.session) : 'loading';
  const loginPath = buildAdminLoginPath(currentPath);

  useEffect(() => {
    if (access === 'login') window.location.replace(loginPath);
  }, [access, loginPath]);

  if (sessionState.status === 'loading') {
    return (
      <AdminAccessPanel
        icon={<ShieldCheck size={22} />}
        eyebrow="XD Cell"
        title="正在校验管理员权限"
        text="请稍候。"
      />
    );
  }

  if (access === 'login') {
    return (
      <AdminAccessPanel
        icon={<LogIn size={22} />}
        eyebrow="XD Cell"
        title="需要登录"
        text="正在跳转到登录页。"
        action={{ href: loginPath, label: '登录' }}
      />
    );
  }

  if (access === 'forbidden') {
    return (
      <AdminAccessPanel
        icon={<ShieldAlert size={22} />}
        eyebrow="管理员后台"
        title="无权访问"
        text="当前账号不是平台管理员。"
        action={{ href: '/', label: '返回 Sites' }}
      />
    );
  }

  return children;
}

function AdminAccessPanel({ icon, eyebrow, title, text, action }) {
  return (
    <main className="auth-page">
      <section className="auth-panel" aria-labelledby="admin-access-title">
        <div className="auth-panel__mark">{icon}</div>
        <p className="auth-panel__eyebrow">{eyebrow}</p>
        <h1 id="admin-access-title">{title}</h1>
        <p className="auth-panel__text">{text}</p>
        {action ? (
          <a className="primary-button" href={action.href}>
            <span>{action.label}</span>
          </a>
        ) : null}
      </section>
    </main>
  );
}

function readRoute(path) {
  if (path === '/login') return { section: 'login', view: 'login' };
  const adminRoute = readAdminRoute(path);
  if (adminRoute) return { section: 'admin', view: 'admin', ...adminRoute };
  if (path === '/workspace' || path === '/workspace/' || path === '/workspace/published') {
    return { section: 'workspace', view: 'workspace-personal' };
  }
  if (path === '/workspace/team-sites') return { section: 'workspace', view: 'workspace-team' };
  const siteRoute = readSiteRoute(path);
  if (siteRoute) return { section: 'workspace', view: 'site-detail', ...siteRoute };
  if (path === '/workspace/teams') return { section: 'workspace', view: 'teams' };
  const teamRoute = readTeamRoute(path);
  if (teamRoute) return { section: 'workspace', view: 'team-detail', ...teamRoute };
  if (path === '/workspace/access-keys') return { section: 'workspace', view: 'access-keys' };
  if (path === '/workspace/settings') return { section: 'workspace', view: 'settings' };
  return { section: 'sites', view: 'directory' };
}

function readAdminRoute(path) {
  if (path === '/admin' || path === '/admin/') return { page: 'dashboard' };
  const match = path.match(/^\/admin\/([^/]+)$/);
  if (!match) return null;
  return { page: match[1] || 'dashboard' };
}

function readSiteRoute(path) {
  const match = path.match(/^\/workspace\/sites\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return null;
  return {
    siteId: decodeURIComponent(match[1]),
    tab: match[2] || 'overview',
  };
}

function readTeamRoute(path) {
  const match = path.match(/^\/workspace\/teams\/([^/]+)(?:\/([^/]+))?$/);
  if (!match) return null;
  return {
    teamId: decodeURIComponent(match[1]),
    tab: match[2] || 'members',
  };
}
