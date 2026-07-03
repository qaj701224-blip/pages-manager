import { Monitor, Moon, Sun } from 'lucide-react';

import { buildAccountProfile } from '../account-profile-model.js';
import { AppTabs, SelectField } from '../components/RadixPrimitives.jsx';
import { Sidebar } from '../components/Sidebar.jsx';
import { usePreferences } from '../preferences-context.jsx';
import { PageHeading } from './SitesDirectory.jsx';

export function AccountSettings({ sessionState }) {
  const session = sessionState?.status === 'ready' ? sessionState.session : { authenticated: false, user: null };
  const profile = buildAccountProfile(session);
  const { theme, setTheme, locale, setLocale, t } = usePreferences();

  return (
    <div className="workspace-layout">
      <Sidebar active="settings" sessionState={sessionState} />
      <main className="page workspace-page account-settings-page">
        <PageHeading title={t('accountSettings')} meta={t('accountMeta')} />
        <AppTabs.Root className="settings-tabs" defaultValue="basic">
          <AppTabs.List className="tabs-list" aria-label={t('accountSettings')}>
            <AppTabs.Trigger className="tabs-trigger" value="basic">
              {t('basic')}
            </AppTabs.Trigger>
            <AppTabs.Trigger className="tabs-trigger" value="preferences">
              {t('preferences')}
            </AppTabs.Trigger>
          </AppTabs.List>

          <AppTabs.Content value="basic">
            <section className="settings-card">
              <h2>{t('basicInfo')}</h2>
              <dl className="profile-list">
                <ProfileRow label={t('name')} value={profile.displayName} note={profile.ssoSource} />
                <ProfileRow label={t('email')} value={profile.email} />
                <ProfileRow label={t('department')} value={profile.departmentPath} />
              </dl>
            </section>
          </AppTabs.Content>

          <AppTabs.Content value="preferences">
            <section className="settings-card settings-form-card">
              <h2>{t('preferenceSettings')}</h2>
              <div className="settings-form-grid">
                <SelectField
                  label={t('themeMode')}
                  value={theme}
                  options={[
                    { value: 'system', label: t('followSystem') },
                    { value: 'light', label: t('light') },
                    { value: 'dark', label: t('dark') },
                  ]}
                  onChange={setTheme}
                />
                <SelectField
                  label={t('languageMode')}
                  value={locale}
                  options={[
                    { value: 'zh-CN', label: t('Chinese') },
                    { value: 'en', label: t('English') },
                  ]}
                  onChange={setLocale}
                />
              </div>
              <div className="preference-preview">
                <span>{themeIcon(theme)}</span>
                <span>{theme === 'system' ? t('followSystem') : theme === 'dark' ? t('dark') : t('light')}</span>
              </div>
            </section>
          </AppTabs.Content>
        </AppTabs.Root>
      </main>
    </div>
  );
}

function ProfileRow({ label, value, note }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <span className="profile-value">{value || '-'}</span>
        {note ? <span>{note}</span> : null}
      </dd>
    </div>
  );
}

function themeIcon(theme) {
  if (theme === 'dark') return <Moon size={16} />;
  if (theme === 'light') return <Sun size={16} />;
  return <Monitor size={16} />;
}
