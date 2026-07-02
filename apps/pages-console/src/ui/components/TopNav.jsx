import { useMemo } from 'react';
import {
  Bell,
  ChevronDown,
  Globe2,
  KeyRound,
  LogIn,
  LogOut,
  Moon,
  Settings,
  ShieldCheck,
  UserCircle,
} from 'lucide-react';
import { Link } from 'react-router-dom';

import { getConsoleEnvironmentBanner, readTopNavUserState } from '../top-nav-model.js';
import { clearCachedConsoleSession } from '../session-cache.js';

export function TopNav({ activeSection, sessionState }) {
  const banner = getConsoleEnvironmentBanner(globalThis.location?.hostname || '');
  const sessionPayload = sessionState?.status === 'ready' ? sessionState.session : null;
  const userState = useMemo(() => readTopNavUserState(sessionPayload), [sessionPayload]);
  const workspaceHref = userState.authenticated ? '/workspace/published' : '/login?returnTo=/workspace/published';

  return (
    <header className="top-nav">
      <div className="top-nav__left">
        <Link className="brand" to="/">
          <span className="brand-mark">XD</span>
          <span className="brand-copy">
            <strong>XD Cell</strong>
            <span>站点平台</span>
          </span>
        </Link>
        <Link className={activeSection === 'sites' ? 'nav-link active' : 'nav-link'} to="/">
          Sites
        </Link>
        <Link className={activeSection === 'workspace' ? 'nav-link active' : 'nav-link'} to={workspaceHref}>
          工作台
        </Link>
        {banner ? <span className="environment-badge">{banner}</span> : null}
      </div>
      <div className="top-nav__actions" aria-label="全局操作">
        <button className="icon-button" type="button" aria-label="主题">
          <Moon size={18} />
        </button>
        <button className="icon-button" type="button" aria-label="语言">
          <Globe2 size={18} />
        </button>
        <button className="icon-button" type="button" aria-label="通知">
          <Bell size={18} />
        </button>
        {userState.authenticated ? (
          <details className="account-menu">
            <summary className="account-menu__button" aria-label="用户菜单">
              <UserCircle size={18} />
              <span>{userState.displayName}</span>
              <ChevronDown size={14} />
            </summary>
            <div className="account-menu__popover">
              <div className="account-menu__identity">
                <strong>{userState.displayName}</strong>
                <span>{userState.label}</span>
              </div>
              <div className="account-menu__group">
                <Link to="/workspace/settings">
                  <Settings size={17} />
                  <span>账号设置</span>
                </Link>
                <Link to="/workspace/access-keys">
                  <KeyRound size={17} />
                  <span>Access Keys</span>
                </Link>
              </div>
              {userState.showAdmin ? (
                <div className="account-menu__group">
                  <Link className="account-menu__admin" to="/admin">
                    <ShieldCheck size={17} />
                    <span>管理员后台</span>
                  </Link>
                </div>
              ) : null}
              <div className="account-menu__group">
                <a href="/api/console/auth/logout" onClick={() => clearCachedConsoleSession()}>
                  <LogOut size={17} />
                  <span>退出</span>
                </a>
              </div>
            </div>
          </details>
        ) : (
          <a className="user-menu" href="/api/console/auth/login?returnTo=/workspace/published">
            <LogIn size={18} />
            <span>登录</span>
          </a>
        )}
      </div>
    </header>
  );
}
