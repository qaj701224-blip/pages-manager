import { ShieldCheck, ShieldOff, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import { grantPlatformAdmin, listAdminUsers, revokePlatformAdmin } from '../api.js';
import { readCachedConsoleSession } from '../session-cache.js';
import { AdminError, formatDate } from './AdminDashboard.jsx';

export function AdminUsers() {
  const [state, setState] = useState({ status: 'loading', users: [], error: null });
  const [actionState, setActionState] = useState({ userId: '', status: 'idle', error: null });
  const [actionDialog, setActionDialog] = useState(null);
  const [query, setQuery] = useState('');
  const [adminFilter, setAdminFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const currentUser = readCachedConsoleSession()?.session?.user || null;

  const loadUsers = () => {
    setState((current) => ({ ...current, status: 'loading', error: null }));
    return listAdminUsers()
      .then((data) => {
        setState({ status: 'ready', users: data.users || [], error: null });
      })
      .catch((error) => {
        setState({ status: 'error', users: [], error });
      });
  };

  useEffect(() => {
    let active = true;
    listAdminUsers()
      .then((data) => {
        if (active) setState({ status: 'ready', users: data.users || [], error: null });
      })
      .catch((error) => {
        if (active) setState({ status: 'error', users: [], error });
      });
    return () => {
      active = false;
    };
  }, []);
  const visibleUsers = useMemo(
    () => filterAdminUsers(state.users, { query, adminFilter, statusFilter }),
    [state.users, query, adminFilter, statusFilter]
  );

  const updatePlatformAdmin = async ({ user, shouldGrant, reason }) => {
    setActionState({ userId: user.id, status: 'saving', error: null });
    try {
      if (shouldGrant) {
        await grantPlatformAdmin(user.id, { reason });
      } else {
        await revokePlatformAdmin(user.id, { reason });
      }
      setActionDialog(null);
      await loadUsers();
      setActionState({ userId: '', status: 'idle', error: null });
    } catch (error) {
      setActionState({ userId: user.id, status: 'error', error });
    }
  };

  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error') return <AdminError title="用户列表加载失败" error={state.error} />;
  if (state.users.length === 0) return <div className="placeholder">暂无用户数据</div>;

  return (
    <>
      <div className="list-toolbar admin-list-toolbar" aria-label="用户筛选">
        <label className="list-search">
          <span>搜索用户</span>
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索姓名、邮箱、SSO 部门" />
        </label>
        <div className="segmented compact-segmented" role="tablist" aria-label="管理员状态">
          {[
            ['all', '全部'],
            ['admin', 'Admin'],
            ['user', 'User'],
          ].map(([value, label]) => (
            <button className={adminFilter === value ? 'active' : ''} key={value} type="button" onClick={() => setAdminFilter(value)}>
              {label}
            </button>
          ))}
        </div>
        <div className="segmented compact-segmented" role="tablist" aria-label="员工状态">
          {[
            ['all', '全部状态'],
            ['active', 'Active'],
            ['inactive', 'Inactive'],
          ].map(([value, label]) => (
            <button className={statusFilter === value ? 'active' : ''} key={value} type="button" onClick={() => setStatusFilter(value)}>
              {label}
            </button>
          ))}
        </div>
        <span className="toolbar-count">{visibleUsers.length} / {state.users.length}</span>
      </div>
      {visibleUsers.length ? (
        <div className="table-shell">
          <table className="admin-table">
            <thead>
              <tr>
                <th>用户</th>
                <th>SSO 部门</th>
                <th>状态</th>
                <th>平台管理员</th>
                <th>最后登录</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleUsers.map((user) => {
                const isCurrentUser = user.id === currentUser?.userId || user.email === currentUser?.email;
                const disableRevokeSelf = isCurrentUser && user.isPlatformAdmin;
                return (
                  <tr key={user.id}>
                    <td data-label="用户">
                      <strong>{user.realname || user.email}</strong>
                      <span>{user.email}</span>
                    </td>
                    <td data-label="SSO 部门">{user.departmentPath || '无'}</td>
                    <td data-label="状态">{user.employeeStatus}</td>
                    <td data-label="平台管理员">
                      <span className={user.isPlatformAdmin ? 'tag' : 'tag muted'}>{user.isPlatformAdmin ? 'admin' : 'user'}</span>
                      {actionState.userId === user.id && actionState.status === 'error' ? (
                        <span className="row-error">{actionState.error?.code || 'ADMIN_UPDATE_FAILED'}</span>
                      ) : null}
                    </td>
                    <td data-label="最后登录">{formatDate(user.lastLoginAt)}</td>
                    <td data-label="操作">
                      <button
                        className="table-action"
                        type="button"
                        disabled={actionState.status === 'saving' || disableRevokeSelf}
                        title={disableRevokeSelf ? '不能撤销当前登录用户' : undefined}
                        onClick={() => setActionDialog({ user, shouldGrant: !user.isPlatformAdmin, reason: '' })}
                      >
                        {user.isPlatformAdmin ? <ShieldOff size={15} /> : <ShieldCheck size={15} />}
                        <span>
                          {actionState.userId === user.id && actionState.status === 'saving'
                            ? '处理中'
                            : user.isPlatformAdmin
                              ? '撤销管理员'
                              : '设为管理员'}
                        </span>
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="placeholder">没有匹配的用户</div>
      )}
      {actionDialog ? (
        <AdminUserActionDialog
          action={actionDialog}
          error={actionState.userId === actionDialog.user.id && actionState.status === 'error' ? actionState.error : null}
          saving={actionState.userId === actionDialog.user.id && actionState.status === 'saving'}
          onChange={setActionDialog}
          onClose={() => setActionDialog(null)}
          onConfirm={updatePlatformAdmin}
        />
      ) : null}
    </>
  );
}

function filterAdminUsers(users, { query, adminFilter, statusFilter }) {
  const normalizedQuery = query.trim().toLowerCase();
  return users.filter((user) => {
    if (adminFilter === 'admin' && !user.isPlatformAdmin) return false;
    if (adminFilter === 'user' && user.isPlatformAdmin) return false;
    if (statusFilter === 'active' && user.employeeStatus !== 'active') return false;
    if (statusFilter === 'inactive' && user.employeeStatus === 'active') return false;
    if (!normalizedQuery) return true;
    return [user.realname, user.email, user.departmentPath, user.employeeStatus, user.isPlatformAdmin ? 'admin' : 'user']
      .filter(Boolean)
      .join(' ')
      .toLowerCase()
      .includes(normalizedQuery);
  });
}

function AdminUserActionDialog({ action, error, saving, onChange, onClose, onConfirm }) {
  const title = action.shouldGrant ? '设为平台管理员' : '撤销平台管理员';
  const description = action.shouldGrant ? '确认后该用户可访问管理员后台。' : '确认后该用户将失去管理员后台权限。';
  const Icon = action.shouldGrant ? ShieldCheck : ShieldOff;

  return (
    <div className="modal-backdrop" role="presentation">
      <div className="dialog admin-user-action-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-user-action-title">
        <div className="dialog-head">
          <div>
            <p>平台管理员</p>
            <h2 id="admin-user-action-title">{title}</h2>
          </div>
          <button className="icon-button compact" type="button" title="关闭" onClick={onClose}>
            <X size={15} />
          </button>
        </div>
        <div className="dialog-body">
          <div className="admin-user-action-summary">
            <Icon size={18} />
            <span>
              <strong>{action.user.realname || action.user.email}</strong>
              <small>{action.user.email}</small>
            </span>
          </div>
          <p className="dialog-description">{description}</p>
          <label className="field">
            <span>原因（可选）</span>
            <textarea
              value={action.reason}
              onChange={(event) => onChange({ ...action, reason: event.target.value })}
              placeholder="例如：平台运维负责人"
            />
          </label>
          {error ? <div className="form-error">{error.code || error.message || 'ADMIN_UPDATE_FAILED'}</div> : null}
          <div className="dialog-actions">
            <button className="secondary-button" type="button" onClick={onClose} disabled={saving}>
              取消
            </button>
            <button className="primary-button" type="button" onClick={() => onConfirm(action)} disabled={saving}>
              <Icon size={15} />
              <span>{saving ? '处理中' : '确认'}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
