import { ShieldCheck, ShieldOff } from 'lucide-react';
import { useEffect, useState } from 'react';

import { grantPlatformAdmin, listAdminUsers, revokePlatformAdmin } from '../api.js';
import { AdminError, formatDate } from './AdminDashboard.jsx';

export function AdminUsers() {
  const [state, setState] = useState({ status: 'loading', users: [], error: null });
  const [actionState, setActionState] = useState({ userId: '', status: 'idle', error: null });

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

  const updatePlatformAdmin = async (user, shouldGrant) => {
    const reason = window.prompt(shouldGrant ? '设置为平台管理员的原因（可选）' : '撤销平台管理员的原因（可选）', '');
    if (reason === null) return;

    setActionState({ userId: user.id, status: 'saving', error: null });
    try {
      if (shouldGrant) {
        await grantPlatformAdmin(user.id, { reason });
      } else {
        await revokePlatformAdmin(user.id, { reason });
      }
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
    <div className="table-shell">
      <table className="admin-table">
        <thead>
          <tr>
            <th>用户</th>
            <th>部门</th>
            <th>状态</th>
            <th>平台管理员</th>
            <th>最后登录</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {state.users.map((user) => (
            <tr key={user.id}>
              <td>
                <strong>{user.realname || user.email}</strong>
                <span>{user.email}</span>
              </td>
              <td>{user.departmentPath || '无'}</td>
              <td>{user.employeeStatus}</td>
              <td>
                <span className={user.isPlatformAdmin ? 'tag' : 'tag muted'}>{user.isPlatformAdmin ? 'admin' : 'user'}</span>
                {actionState.userId === user.id && actionState.status === 'error' ? (
                  <span className="row-error">{actionState.error?.code || 'ADMIN_UPDATE_FAILED'}</span>
                ) : null}
              </td>
              <td>{formatDate(user.lastLoginAt)}</td>
              <td>
                <button
                  className="table-action"
                  type="button"
                  disabled={actionState.status === 'saving'}
                  onClick={() => updatePlatformAdmin(user, !user.isPlatformAdmin)}
                >
                  {user.isPlatformAdmin ? <ShieldOff size={15} /> : <ShieldCheck size={15} />}
                  <span>
                    {actionState.userId === user.id && actionState.status === 'saving'
                      ? '处理中'
                      : user.isPlatformAdmin
                        ? '撤销'
                        : '设为管理员'}
                  </span>
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
