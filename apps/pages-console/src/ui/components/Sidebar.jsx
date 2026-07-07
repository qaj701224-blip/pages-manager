import { Globe2, KeyRound, Settings, UsersRound } from 'lucide-react';
import { Link } from 'react-router-dom';

import { readTopNavUserState } from '../top-nav-model.js';
import { readCachedConsoleSession } from '../session-cache.js';
import { usePreferences } from '../preferences-context.jsx';

export function Sidebar({ active, sessionState, children }) {
  const { t } = usePreferences();
  const session =
    sessionState?.status === 'ready' ? sessionState.session : readCachedConsoleSession()?.session || { authenticated: false };
  const userState = readTopNavUserState(session);

  return (
    <aside className={children ? 'sidebar context-sidebar' : 'sidebar'}>
      {userState.authenticated ? (
        <div className="sidebar-profile">
          <span className="sidebar-profile__avatar">{userState.displayName.slice(0, 1).toUpperCase()}</span>
          <span>
            <strong>{userState.displayName}</strong>
            <small>{userState.label}</small>
          </span>
        </div>
      ) : null}
      {children ? children : null}
      {children ? null : (
        <>
          <nav className="side-section" aria-label="工作台导航">
            <p className="side-title">{t('navSites')}</p>
            <Link className={active === 'personal' ? 'side-link active' : 'side-link'} to="/workspace/published">
              <Globe2 size={17} />
              <span>{t('personalSites')}</span>
            </Link>
            <Link className={active === 'team-sites' ? 'side-link active' : 'side-link'} to="/workspace/team-sites">
              <Globe2 size={17} />
              <span>{t('teamSites')}</span>
            </Link>
          </nav>
          <nav className="side-section" aria-label="协作导航">
            <p className="side-title">{t('collaboration')}</p>
            <Link className={active === 'teams' ? 'side-link active' : 'side-link'} to="/workspace/teams">
              <UsersRound size={17} />
              <span>{t('teams')}</span>
            </Link>
          </nav>
          <nav className="side-section" aria-label="设置导航">
            <p className="side-title">{t('settings')}</p>
            <Link className={active === 'access-keys' ? 'side-link active' : 'side-link'} to="/workspace/access-keys">
              <KeyRound size={17} />
              <span>{t('accessKeys')}</span>
            </Link>
            <Link className={active === 'settings' ? 'side-link active' : 'side-link'} to="/workspace/settings">
              <Settings size={17} />
              <span>{t('accountSettings')}</span>
            </Link>
          </nav>
        </>
      )}
    </aside>
  );
}
