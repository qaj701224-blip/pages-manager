import { useEffect, useMemo, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { Check, ClipboardCopy, MoreHorizontal, Plus, Terminal, Trash2 } from 'lucide-react';

import {
  createAccessKey,
  createTeamAccessKey,
  listAccessKeys,
  listTeamAccessKeys,
  revokeAccessKey,
  revokeTeamAccessKey,
} from '../api.js';
import {
  ACCESS_KEY_EXPIRY_OPTIONS,
  ACCESS_KEY_PERMISSION_OPTIONS,
  buildAccessKeyRows,
  buildAccessKeyCreateBody,
  initialAccessKeyForm,
} from '../access-keys-model.js';
import { AppDialog, ConfirmDialog, SelectField } from '../components/RadixPrimitives.jsx';
import { Sidebar } from '../components/Sidebar.jsx';
import { usePreferences } from '../preferences-context.jsx';
import { buildTokenCopyFeedback } from '../token-copy-model.js';
import { PageHeading } from './SitesDirectory.jsx';

export function WorkspaceAccessKeys({ sessionState }) {
  const { t } = usePreferences();
  return (
    <div className="workspace-layout">
      <Sidebar active="access-keys" sessionState={sessionState} />
      <main className="page workspace-page">
        <PageHeading title={t('accessKeys')} meta={t('workspace')} />
        <AccessKeysPanel ownerType="user" />
      </main>
    </div>
  );
}

export function AccessKeysPanel({ ownerType, teamId, canManage = true }) {
  const [state, setState] = useState({ status: 'loading', accessKeys: [], error: null });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [createdSecret, setCreatedSecret] = useState(null);
  const [revokeTarget, setRevokeTarget] = useState(null);
  const [saving, setSaving] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const [error, setError] = useState(null);
  const { t } = usePreferences();

  const load = async () => {
    setState((current) => ({ ...current, status: 'loading', error: null }));
    try {
      const data = ownerType === 'team' ? await listTeamAccessKeys(teamId) : await listAccessKeys();
      setState({ status: 'ready', accessKeys: data.accessKeys || [], error: null });
    } catch (nextError) {
      setState({ status: 'error', accessKeys: [], error: nextError });
    }
  };

  useEffect(() => {
    let active = true;
    const run = async () => {
      try {
        const data = ownerType === 'team' ? await listTeamAccessKeys(teamId) : await listAccessKeys();
        if (active) setState({ status: 'ready', accessKeys: data.accessKeys || [], error: null });
      } catch (nextError) {
        if (active) setState({ status: 'error', accessKeys: [], error: nextError });
      }
    };
    run();
    return () => {
      active = false;
    };
  }, [ownerType, teamId]);

  const submit = async (form) => {
    setSaving(true);
    setError(null);
    setCreatedSecret(null);
    try {
      const body = buildAccessKeyCreateBody(form);
      const data = ownerType === 'team' ? await createTeamAccessKey(teamId, body) : await createAccessKey(body);
      setCreatedSecret(data.accessKey?.plaintext || null);
      await load();
      return true;
    } catch (nextError) {
      setError(nextError);
      return false;
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (accessKey) => {
    setRevoking(true);
    setError(null);
    setCreatedSecret(null);
    try {
      if (ownerType === 'team') {
        await revokeTeamAccessKey(teamId, accessKey.id);
      } else {
        await revokeAccessKey(accessKey.id);
      }
      await load();
      setRevokeTarget(null);
    } catch (nextError) {
      setError(nextError);
    } finally {
      setRevoking(false);
    }
  };

  return (
    <>
      <section className="api-token-card" aria-label="API Token">
        <div className="api-token-card__head">
          <div>
            <h2>{t('apiToken')}</h2>
            <p>{t('tokenUsage')}</p>
          </div>
          {canManage ? (
            <button
              className="primary-button"
              type="button"
              onClick={() => {
                setError(null);
                setDialogOpen(true);
              }}
            >
              <Plus size={15} />
              <span>{t('newToken')}</span>
            </button>
          ) : null}
        </div>

        {!canManage ? <div className="panel-empty">仅团队 admin 可管理团队 Access Keys</div> : null}

        {error && !dialogOpen ? <div className="form-error api-token-error">{error.code || error.message}</div> : null}

        <AccessKeyList
          state={state}
          canManage={canManage}
          onRevoke={(accessKey) => {
            setError(null);
            setRevokeTarget(accessKey);
          }}
        />
      </section>

      {dialogOpen ? (
        <AccessKeyDialog
          error={error}
          ownerType={ownerType}
          saving={saving}
          onClose={() => {
            setDialogOpen(false);
            setError(null);
          }}
          onSubmit={submit}
        />
      ) : null}
      <TokenCreatedDialog token={createdSecret} onClose={() => setCreatedSecret(null)} />
      <RevokeAccessKeyDialog
        accessKey={revokeTarget}
        saving={revoking}
        error={error}
        onClose={() => setRevokeTarget(null)}
        onConfirm={revoke}
      />
    </>
  );
}

function AccessKeyDialog({ error, ownerType, saving, onClose, onSubmit }) {
  const [form, setForm] = useState(() => initialAccessKeyForm());
  const ownershipLabel = ownerType === 'team' ? '团队归属' : '个人归属';
  const { t } = usePreferences();

  const updatePermission = (permission, checked) => {
    setForm((current) => {
      const permissions = new Set(current.permissions);
      if (checked) permissions.add(permission);
      if (!checked) permissions.delete(permission);
      return { ...current, permissions: [...permissions] };
    });
  };

  return (
    <AppDialog open title={t('newToken')} eyebrow={ownershipLabel} onOpenChange={(open) => !open && onClose()}>
      <form
        className="api-token-form dialog-form"
        onSubmit={async (event) => {
          event.preventDefault();
          const ok = await onSubmit(form);
          if (ok) onClose();
        }}
      >
        <label className="field">
          <span>名称</span>
          <input
            value={form.name}
            onChange={(event) => setForm({ ...form, name: event.target.value })}
            placeholder="例如：本地开发 / CI 流水线"
            required
          />
        </label>

        <fieldset className="field-set">
          <legend>权限</legend>
          <div className="checkbox-row plain-checkbox-row">
            {ACCESS_KEY_PERMISSION_OPTIONS.map((permission) => (
              <label key={permission.value}>
                <input
                  checked={form.permissions.includes(permission.value)}
                  type="checkbox"
                  onChange={(event) => updatePermission(permission.value, event.target.checked)}
                />
                <span>{permission.label}</span>
              </label>
            ))}
          </div>
          <p className="form-hint">publish 表示可通过 CLI / CI / agent 发布站点，并可按 Token 归属创建新站点。</p>
        </fieldset>

        <div className="field">
          <span>有效期</span>
          <SelectField
            label=""
            value={String(form.expiresInDays)}
            options={ACCESS_KEY_EXPIRY_OPTIONS.map((option) => ({ value: String(option.days), label: option.label }))}
            onChange={(expiresInDays) => setForm({ ...form, expiresInDays: Number(expiresInDays) })}
          />
        </div>

        {error ? <div className="form-error">{error.code || error.message}</div> : null}

        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={onClose}>
            {t('cancel')}
          </button>
          <button className="primary-button" type="submit" disabled={saving || !form.name.trim() || form.permissions.length === 0}>
            <span>{saving ? '创建中' : '创建 Token'}</span>
          </button>
        </div>
      </form>
    </AppDialog>
  );
}

function AccessKeyList({ state, canManage, onRevoke }) {
  const { t } = usePreferences();
  const [query, setQuery] = useState('');
  const rows = useMemo(() => buildAccessKeyRows(state.accessKeys), [state.accessKeys]);
  const visibleRows = useMemo(() => filterAccessKeyRows(rows, query), [rows, query]);
  if (state.status === 'loading') return <div className="panel-empty">加载中</div>;
  if (state.status === 'error') return <div className="panel-empty">无法加载 Access Keys</div>;

  if (!rows.length) {
    return (
      <div className="api-token-empty">
        <div className="token-terminal-icon">
          <Terminal size={24} />
        </div>
        <strong>{t('noTokens')}</strong>
        <p>{t('noTokensHint')}</p>
      </div>
    );
  }

  return (
    <section className="table-list api-token-list" aria-label="Access Keys">
      <div className="list-toolbar api-token-toolbar" aria-label="Access Keys 筛选">
        <label className="list-search">
          <span>搜索 Token</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、权限、预览" />
        </label>
        <span className="toolbar-count">{visibleRows.length} / {rows.length}</span>
      </div>
      <div className="api-token-table-head">
        <span>{t('tokenNamePermission')}</span>
        <span>{t('tokenPreview')}</span>
        <span>{t('createdAt')}</span>
        <span>{t('expiresAt')}</span>
        <span />
      </div>
      {visibleRows.length ? visibleRows.map((row) => (
        <div className="table-row access-key-row" key={row.id}>
          <div>
            <strong>{row.name}</strong>
            <span className="token-scope-row">
              <span className={`tag token-source-tag token-source-tag--${row.sourceKind}`}>{row.sourceLabel}</span>
              {row.scopeLabels.map((scope) => (
                <span className="tag token-scope-tag" key={scope}>
                  {scope}
                </span>
              ))}
            </span>
          </div>
          <code>{row.tokenPreview}</code>
          <span>{row.createdLabel}</span>
          <span>{row.expiresLabel}</span>
          <div className="row-actions">
            {canManage ? (
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button className="icon-button compact" type="button" title="更多">
                    <MoreHorizontal size={15} />
                  </button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="radix-menu-content" align="end" sideOffset={6}>
                    <DropdownMenu.Item className="radix-menu-item danger" onSelect={() => onRevoke(row.raw)}>
                      <Trash2 size={15} />
                      <span>撤销 Token</span>
                    </DropdownMenu.Item>
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            ) : null}
          </div>
        </div>
      )) : <div className="panel-empty">没有匹配的 Access Key</div>}
    </section>
  );
}

function filterAccessKeyRows(rows, query) {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return rows;
  return rows.filter((row) =>
    [row.name, row.tokenPreview, row.ownerLabel, row.sourceLabel, ...(row.scopeLabels || [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(normalized)
  );
}

function RevokeAccessKeyDialog({ accessKey, saving, error, onClose, onConfirm }) {
  if (!accessKey) return null;
  return (
    <ConfirmDialog
      open
      title="撤销 Token"
      target={accessKey.name || accessKey.id}
      targetMeta={accessKey.tokenPreview || accessKey.id}
      description="撤销后，使用该 Token 的 CLI / CI / agent 将无法继续读取或发布站点。"
      confirmLabel={saving ? '撤销中' : '撤销 Token'}
      confirming={saving}
      error={error}
      icon={<Trash2 size={16} />}
      onCancel={onClose}
      onConfirm={() => onConfirm(accessKey)}
    />
  );
}

function TokenCreatedDialog({ token, onClose }) {
  const { t } = usePreferences();
  const [copyState, setCopyState] = useState('idle');
  const open = Boolean(token);

  useEffect(() => {
    setCopyState('idle');
  }, [token]);

  const copy = async () => {
    if (!token) return;
    const writeText = globalThis.navigator?.clipboard?.writeText;
    if (typeof writeText !== 'function') {
      setCopyState('failed');
      return;
    }
    try {
      await writeText.call(globalThis.navigator.clipboard, token);
      setCopyState('copied');
    } catch {
      setCopyState('failed');
    }
  };
  const copyFeedback = buildTokenCopyFeedback(copyState, t);

  return (
    <AppDialog open={open} title={t('tokenOnceTitle')} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <div className="token-created-body">
        <p>{t('tokenOnceMessage')}</p>
        <code>{token}</code>
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={copy}>
            {copyState === 'copied' ? <Check size={16} /> : <ClipboardCopy size={16} />}
            <span className={copyFeedback.className} aria-live={copyFeedback.ariaLive}>
              {copyFeedback.label}
            </span>
          </button>
          <button className="primary-button" type="button" onClick={onClose}>
            {t('tokenSaved')}
          </button>
        </div>
      </div>
    </AppDialog>
  );
}
