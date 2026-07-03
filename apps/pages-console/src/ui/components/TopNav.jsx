import { useMemo } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Bell,
  ChevronDown,
  Globe2,
  KeyRound,
  LogIn,
  LogOut,
  Monitor,
  Moon,
  Settings,
  ShieldCheck,
  Sun,
  UserCircle,
} from 'lucide-react';
import { Link } from 'react-router-dom';

import { IconDropdown, MenuItem } from './RadixPrimitives.jsx';
import { getConsoleEnvironmentBanner, readTopNavUserState } from '../top-nav-model.js';
import { usePreferences } from '../preferences-context.jsx';
import { clearCachedConsoleSession } from '../session-cache.js';

export function TopNav({ activeSection, sessionState }) {
  const banner = getConsoleEnvironmentBanner(globalThis.location?.hostname || '');
  const sessionPayload = sessionState?.status === 'ready' ? sessionState.session : null;
  const userState = useMemo(() => readTopNavUserState(sessionPayload), [sessionPayload]);
  const workspaceHref = userState.authenticated ? '/workspace/published' : '/login?returnTo=/workspace/published';
  const { theme, setTheme, locale, setLocale, t } = usePreferences();

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
          {t('sites')}
        </Link>
        <Link className={activeSection === 'workspace' ? 'nav-link active' : 'nav-link'} to={workspaceHref}>
          {t('workspace')}
        </Link>
        {banner ? <span className="environment-badge">{banner}</span> : null}
      </div>
      <div className="top-nav__actions" aria-label="全局操作">
        <IconDropdown label={t('theme')} icon={theme === 'dark' ? <Moon size={18} /> : <Sun size={18} />}>
          <MenuItem active={theme === 'system'} icon={<Monitor size={15} />} onSelect={() => setTheme('system')}>
            {t('followSystem')}
          </MenuItem>
          <MenuItem active={theme === 'light'} icon={<Sun size={15} />} onSelect={() => setTheme('light')}>
            {t('light')}
          </MenuItem>
          <MenuItem active={theme === 'dark'} icon={<Moon size={15} />} onSelect={() => setTheme('dark')}>
            {t('dark')}
          </MenuItem>
        </IconDropdown>
        <IconDropdown label={t('language')} icon={<Globe2 size={18} />}>
          <MenuItem active={locale === 'zh-CN'} icon={<Globe2 size={15} />} onSelect={() => setLocale('zh-CN')}>
            {t('Chinese')}
          </MenuItem>
          <MenuItem active={locale === 'en'} icon={<Globe2 size={15} />} onSelect={() => setLocale('en')}>
            {t('English')}
          </MenuItem>
        </IconDropdown>
        <button className="icon-button" type="button" aria-label={t('notifications')}>
          <Bell size={18} />
        </button>
        {userState.authenticated ? (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button className="account-menu__button" type="button" aria-label="用户菜单">
                <UserCircle size={18} />
                <span>{userState.displayName}</span>
                <ChevronDown size={14} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content className="account-menu__popover" sideOffset={8} align="end">
                <div className="account-menu__identity">
                  <strong>{userState.displayName}</strong>
                  <span>{userState.label}</span>
                  {userState.departmentPath ? <span>{userState.departmentPath}</span> : null}
                </div>
                <div className="account-menu__group">
                  <DropdownMenu.Item asChild>
                    <Link to="/workspace/settings">
                      <Settings size={17} />
                      <span>{t('accountSettings')}</span>
                    </Link>
                  </DropdownMenu.Item>
                  <DropdownMenu.Item asChild>
                    <Link to="/workspace/access-keys">
                      <KeyRound size={17} />
                      <span>{t('accessKeys')}</span>
                    </Link>
                  </DropdownMenu.Item>
                </div>
                {userState.showAdmin ? (
                  <div className="account-menu__group">
                    <DropdownMenu.Item asChild>
                      <Link className="account-menu__admin" to="/admin">
                        <ShieldCheck size={17} />
                        <span>{t('adminConsole')}</span>
                      </Link>
                    </DropdownMenu.Item>
                  </div>
                ) : null}
                <div className="account-menu__group">
                  <DropdownMenu.Item asChild>
                    <a href="/api/console/auth/logout" onClick={() => clearCachedConsoleSession()}>
                      <LogOut size={17} />
                      <span>{t('logout')}</span>
                    </a>
                  </DropdownMenu.Item>
                </div>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : (
          <a className="user-menu" href="/api/console/auth/login?returnTo=/workspace/published">
            <LogIn size={18} />
            <span>{t('login')}</span>
          </a>
        )}
      </div>
    </header>
  );
}
