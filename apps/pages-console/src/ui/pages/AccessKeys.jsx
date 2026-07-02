import { useEffect, useState } from 'react';
import { Check, ChevronDown, Plus, RotateCw, Terminal, Trash2, X } from 'lucide-react';

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
  buildAccessKeyCreateBody,
  initialAccessKeyForm,
} from '../access-keys-model.js';
import { Sidebar } from '../components/Sidebar.jsx';
import { PageHeading } from './SitesDirectory.jsx';

export function WorkspaceAccessKeys() {
  return (
    <div className="workspace-layout">
      <Sidebar active="access-keys" />
      <main className="page workspace-page">
        <PageHeading title="Access Keys" meta="工作台" />
        <AccessKeysPanel ownerType="user" />
      </main>
    </div>
  );
}

export function AccessKeysPanel({ ownerType, teamId, canManage = true }) {
  const [state, setState] = useState({ status: 'loading', accessKeys: [], error: null });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [createdSecret, setCreatedSecret] = useState(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

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
    setError(null);
    setCreatedSecret(null);
    try {
      if (ownerType === 'team') {
        await revokeTeamAccessKey(teamId, accessKey.id);
      } else {
        await revokeAccessKey(accessKey.id);
      }
      await load();
    } catch (nextError) {
      setError(nextError);
    }
  };

  return (
    <>
      <section className="api-token-card" aria-label="API Token">
        <div className="api-token-card__head">
          <div>
            <h2>API Token</h2>
            <p>用于 CLI / CI 中无浏览器场景</p>
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
              <span>新建 Token</span>
            </button>
          ) : null}
        </div>

        {!canManage ? <div className="panel-empty">仅团队 admin 可管理团队 Access Keys</div> : null}

        {createdSecret ? (
          <div className="secret-once api-token-secret">
            <p>Token 只显示一次，离开页面后不可再次查看。</p>
            <pre className="code-preview">{createdSecret}</pre>
          </div>
        ) : null}

        {error && !dialogOpen ? <div className="form-error api-token-error">{error.code || error.message}</div> : null}

        <AccessKeyList state={state} canManage={canManage} onRefresh={load} onRevoke={revoke} />
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
    </>
  );
}

function AccessKeyDialog({ error, ownerType, saving, onClose, onSubmit }) {
  const [form, setForm] = useState(() => initialAccessKeyForm(ownerType));
  const ownershipLabel = ownerType === 'team' ? '团队归属' : '个人归属';

  const updatePermission = (permission, checked) => {
    setForm((current) => {
      const permissions = new Set(current.permissions);
      if (checked) permissions.add(permission);
      if (!checked) permissions.delete(permission);
      return { ...current, permissions: [...permissions] };
    });
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="dialog access-token-dialog" role="dialog" aria-modal="true" aria-labelledby="access-token-dialog-title">
        <div className="dialog-head">
          <div>
            <p>{ownershipLabel}</p>
            <h2 id="access-token-dialog-title">新建 API Token</h2>
          </div>
          <button className="icon-button compact" type="button" title="关闭" onClick={onClose}>
            <X size={15} />
          </button>
        </div>

        <form
          className="dialog-body api-token-form"
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
          </fieldset>

          <div className="field">
            <span>有效期</span>
            <ExpiryDropdown
              value={form.expiresInDays}
              onChange={(expiresInDays) => setForm({ ...form, expiresInDays })}
            />
          </div>

          {error ? <div className="form-error">{error.code || error.message}</div> : null}

          <div className="dialog-actions">
            <button className="secondary-button" type="button" onClick={onClose}>
              取消
            </button>
            <button className="primary-button" type="submit" disabled={saving || form.permissions.length === 0}>
              <span>{saving ? '创建中' : '创建 Token'}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function ExpiryDropdown({ value, onChange }) {
  const [open, setOpen] = useState(false);
  const selected = ACCESS_KEY_EXPIRY_OPTIONS.find((option) => option.days === value) || ACCESS_KEY_EXPIRY_OPTIONS[1];

  return (
    <div
      className="expiry-dropdown"
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') setOpen(false);
      }}
    >
      <button
        aria-expanded={open}
        aria-haspopup="listbox"
        className="expiry-dropdown__button"
        type="button"
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selected.label}</span>
        <ChevronDown size={16} />
      </button>
      {open ? (
        <div className="expiry-dropdown__menu" role="listbox" aria-label="有效期">
          {ACCESS_KEY_EXPIRY_OPTIONS.map((option) => {
            const active = option.days === selected.days;
            return (
              <button
                aria-selected={active}
                className={active ? 'expiry-dropdown__option active' : 'expiry-dropdown__option'}
                key={option.days}
                role="option"
                type="button"
                onClick={() => {
                  onChange(option.days);
                  setOpen(false);
                }}
              >
                <span className="expiry-dropdown__check">{active ? <Check size={13} /> : null}</span>
                <span>{option.label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function AccessKeyList({ state, canManage, onRefresh, onRevoke }) {
  if (state.status === 'loading') return <div className="panel-empty">加载中</div>;
  if (state.status === 'error') return <div className="panel-empty">无法加载 Access Keys</div>;

  if (!state.accessKeys.length) {
    return (
      <div className="api-token-empty">
        <div className="token-terminal-icon">
          <Terminal size={24} />
        </div>
        <strong>还没有 Token</strong>
        <p>新建 Token 后可以在 CLI / CI 里登录、发布站点。</p>
      </div>
    );
  }

  return (
    <section className="table-list api-token-list" aria-label="Access Keys">
      <div className="table-toolbar">
        <strong>Access Keys</strong>
        <button className="secondary-button" type="button" onClick={onRefresh}>
          <RotateCw size={15} />
          刷新
        </button>
      </div>
      {state.accessKeys.map((accessKey) => (
        <div className="table-row access-key-row" key={accessKey.id}>
          <div>
            <strong>{accessKey.name || accessKey.id}</strong>
            <span>{accessKey.id}</span>
          </div>
          <div className="tag-row compact-tags">
            <span className="tag">{ownerLabel(accessKey)}</span>
            {(accessKey.scopes || []).map((scope) => (
              <span className="tag muted" key={scope}>
                {scope}
              </span>
            ))}
          </div>
          <div className="row-actions">
            <span>{expiryLabel(accessKey)}</span>
            {canManage && !accessKey.revokedAt ? (
              <button className="icon-button compact" type="button" title="撤销" onClick={() => onRevoke(accessKey)}>
                <Trash2 size={15} />
              </button>
            ) : null}
          </div>
        </div>
      ))}
    </section>
  );
}

function ownerLabel(accessKey) {
  return accessKey.ownerType === 'team' ? 'team-owned' : 'user-owned';
}

function expiryLabel(accessKey) {
  if (accessKey.revokedAt) return '已撤销';
  if (!accessKey.expiresAt) return '无到期时间';
  return `到期 ${formatDate(accessKey.expiresAt)}`;
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(date);
}
