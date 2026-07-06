import { GitMerge, RefreshCw } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { listAdminTeams, mergeAdminDepartmentTeam } from '../api.js';
import { AdminError, formatDate } from './AdminDashboard.jsx';

export function AdminTeams() {
  const [state, setState] = useState({ status: 'loading', teams: [], error: null });
  const [filter, setFilter] = useState('all');
  const [mergeForm, setMergeForm] = useState({ sourceTeamId: '', targetTeamId: '', reason: '' });
  const [mergeState, setMergeState] = useState({ status: 'idle', error: null });

  const loadTeams = () => {
    setState((current) => ({ ...current, status: 'loading', error: null }));
    listAdminTeams()
      .then((data) => setState({ status: 'ready', teams: data.teams || [], error: null }))
      .catch((error) => setState({ status: 'error', teams: [], error }));
  };

  useEffect(() => {
    let active = true;
    listAdminTeams()
      .then((data) => {
        if (active) setState({ status: 'ready', teams: data.teams || [], error: null });
      })
      .catch((error) => {
        if (active) setState({ status: 'error', teams: [], error });
      });
    return () => {
      active = false;
    };
  }, []);

  const visibleTeams = useMemo(() => {
    if (filter === 'department') return state.teams.filter((team) => team.teamType === 'department');
    if (filter === 'custom') return state.teams.filter((team) => team.teamType === 'custom');
    return state.teams;
  }, [filter, state.teams]);
  const activeDepartmentTeams = state.teams.filter((team) => team.teamType === 'department' && team.status === 'active');
  const mergeDisabled =
    mergeState.status === 'saving' ||
    !mergeForm.sourceTeamId ||
    !mergeForm.targetTeamId ||
    mergeForm.sourceTeamId === mergeForm.targetTeamId;

  const submitMerge = async (event) => {
    event.preventDefault();
    if (mergeDisabled) return;
    setMergeState({ status: 'saving', error: null });
    try {
      await mergeAdminDepartmentTeam(mergeForm.sourceTeamId, {
        targetTeamId: mergeForm.targetTeamId,
        reason: mergeForm.reason,
      });
      setMergeForm({ sourceTeamId: '', targetTeamId: '', reason: '' });
      setMergeState({ status: 'idle', error: null });
      loadTeams();
    } catch (error) {
      setMergeState({ status: 'error', error });
    }
  };

  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error') return <AdminError title="团队列表加载失败" error={state.error} />;

  return (
    <div className="admin-stack">
      <div className="admin-toolbar">
        <div className="segmented" role="tablist" aria-label="团队类型">
          {[
            ['all', '全部'],
            ['department', '部门团队'],
            ['custom', '自建团队'],
          ].map(([value, label]) => (
            <button className={filter === value ? 'active' : ''} key={value} type="button" onClick={() => setFilter(value)}>
              {label}
            </button>
          ))}
        </div>
        <button className="secondary-button" type="button" onClick={loadTeams}>
          <RefreshCw size={15} />
          <span>刷新</span>
        </button>
      </div>

      <form className="merge-panel" onSubmit={submitMerge}>
        <div>
          <h2>部门合并</h2>
          <p>部门名称变化时迁移资产</p>
        </div>
        <select
          value={mergeForm.sourceTeamId}
          onChange={(event) => setMergeForm((current) => ({ ...current, sourceTeamId: event.target.value }))}
          required
        >
          <option value="">源部门团队</option>
          {activeDepartmentTeams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
        <select
          value={mergeForm.targetTeamId}
          onChange={(event) => setMergeForm((current) => ({ ...current, targetTeamId: event.target.value }))}
          required
        >
          <option value="">目标部门团队</option>
          {activeDepartmentTeams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
        <input
          value={mergeForm.reason}
          onChange={(event) => setMergeForm((current) => ({ ...current, reason: event.target.value }))}
          placeholder="原因"
        />
        <button className="primary-button" type="submit" disabled={mergeDisabled}>
          <GitMerge size={15} />
          <span>{mergeState.status === 'saving' ? '合并中' : '合并'}</span>
        </button>
        {mergeState.status === 'error' ? <span className="merge-error">{mergeState.error?.code || 'MERGE_FAILED'}</span> : null}
      </form>

      {visibleTeams.length === 0 ? (
        <div className="placeholder">暂无团队数据</div>
      ) : (
        <div className="table-shell">
          <table className="admin-table">
            <thead>
              <tr>
                <th>团队</th>
                <th>类型</th>
                <th>状态</th>
                <th>合并到</th>
                <th>更新时间</th>
                <th>操作</th>
              </tr>
            </thead>
            <tbody>
              {visibleTeams.map((team) => (
                <tr key={team.id}>
                  <td data-label="团队">
                    <strong>{team.name}</strong>
                    <span>{team.departmentPath || team.id}</span>
                  </td>
                  <td data-label="类型">
                    <span className={team.teamType === 'department' ? 'tag' : 'tag muted'}>{team.teamType}</span>
                  </td>
                  <td data-label="状态">{team.status}</td>
                  <td data-label="合并到">{team.mergedIntoTeamId || '无'}</td>
                  <td data-label="更新时间">{formatDate(team.updatedAt)}</td>
                  <td data-label="操作">
                    <Link className="table-action" to={`/workspace/teams/${encodeURIComponent(team.id)}/settings`}>
                      团队设置
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
