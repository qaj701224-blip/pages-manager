import { useEffect, useMemo, useState } from 'react';
import { Bell, Globe2, KeyRound, LogIn, Moon, ShieldCheck, UserCircle } from 'lucide-react';

import { getConsoleEnvironmentBanner, readTopNavUserState } from '../top-nav-model.js';

export function TopNav({ activeSection }) {
  const [sessionState, setSessionState] = useState(null);
  const banner = getConsoleEnvironmentBanner(globalThis.location?.hostname || '');
  const userState = useMemo(() => readTopNavUserState(sessionState), [sessionState]);
  const workspaceHref = userState.authenticated ? '/workspace/published' : '/login?returnTo=/workspace/published';

  useEffect(() => {
    let active = true;
    fetch('/api/console/auth/session', { credentials: 'same-origin' })
      .then((response) => response.json())
      .then((payload) => {
        if (active) setSessionState(payload);
      })
      .catch(() => {
        if (active) setSessionState(null);
      });
    return () => {
      active = false;
    };
  }, []);

  return (
    <header className="top-nav">
      <div className="top-nav__left">
        <a className="brand" href="/">
          <span className="brand-mark">XD</span>
          <span className="brand-copy">
            <strong>XD Cell</strong>
            <span>站点平台</span>
          </span>
        </a>
        <a className={activeSection === 'sites' ? 'nav-link active' : 'nav-link'} href="/">
          Sites
        </a>
        <a className={activeSection === 'workspace' ? 'nav-link active' : 'nav-link'} href={workspaceHref}>
          工作台
        </a>
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
        {userState.showAdmin ? (
          <a className="user-menu" href="/admin">
            <ShieldCheck size={18} />
            <span>管理员后台</span>
          </a>
        ) : null}
        {userState.authenticated ? (
          <>
            <a className="user-menu" href="/workspace/access-keys">
              <KeyRound size={18} />
              <span>Access Keys</span>
            </a>
            <a className="user-menu" href="/workspace/settings">
              <UserCircle size={18} />
              <span>{userState.label}</span>
            </a>
          </>
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
