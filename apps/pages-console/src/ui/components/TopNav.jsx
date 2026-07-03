import { useMemo } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  Bell,
  ChevronDown,
  Inbox,
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
  const localeLabel = locale === 'zh-CN' ? t('Chinese') : t('English');

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
          <span>{t('sites')}</span>
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
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="language-menu__button" type="button" aria-label={t('language')}>
              <span>{localeLabel}</span>
              <ChevronDown size={14} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="radix-menu-content language-menu__content" sideOffset={8} align="end">
              <DropdownMenu.Item
                className={locale === 'zh-CN' ? 'language-menu__item active' : 'language-menu__item'}
                onSelect={() => setLocale('zh-CN')}
              >
                {t('Chinese')}
              </DropdownMenu.Item>
              <DropdownMenu.Item
                className={locale === 'en' ? 'language-menu__item active' : 'language-menu__item'}
                onSelect={() => setLocale('en')}
              >
                {t('English')}
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button className="icon-button" type="button" aria-label={t('notifications')}>
              <Bell size={18} />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="notification-menu" sideOffset={8} align="end">
              <div className="notification-empty">
                <Inbox size={18} />
                <strong>暂无通知</strong>
                <span>新的平台提醒会显示在这里。</span>
              </div>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
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
