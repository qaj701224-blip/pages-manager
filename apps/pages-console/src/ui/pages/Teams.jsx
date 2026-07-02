import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, KeyRound, Plus, Save, Settings, Trash2, UsersRound } from 'lucide-react';
import { Link } from 'react-router-dom';

import { deleteTeam, fetchJson, removeTeamMember, updateTeamMember, updateTeamSettings } from '../api.js';
import { Sidebar } from '../components/Sidebar.jsx';
import {
  canDeleteTeam,
  canEditTeamSettings,
  getTeamDeleteErrorMessage,
  getTeamSettingsReadOnlyReason,
  normalizeTeamSettingsForm,
} from '../team-settings-model.js';
import { AccessKeysPanel } from './AccessKeys.jsx';
import { PageHeading } from './SitesDirectory.jsx';

const TEAM_TABS = new Set(['members', 'access-keys', 'settings']);
const TEAM_ROLE_OPTIONS = ['viewer', 'publisher', 'admin'];

export function TeamsList() {
  const [state, setState] = useState({ status: 'loading', teams: [], error: null });

  useEffect(() => {
    let active = true;
    fetchJson('/api/console/teams')
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

  return (
    <div className="workspace-layout">
      <Sidebar active="teams" />
      <main className="page workspace-page">
        <PageHeading title="团队" meta="协作" />
        <TeamsContent state={state} />
      </main>
    </div>
  );
}

export function TeamDetail({ teamId, tab = 'members' }) {
  const activeTab = TEAM_TABS.has(tab) ? tab : 'members';
  const [state, setState] = useState({ status: 'loading', team: null, error: null });
  const [membersState, setMembersState] = useState({ status: 'idle', members: [], error: null });

  const updateTeam = (team) => {
    setState((current) => ({ ...current, team }));
  };

  const fetchTeamMembers = useCallback(() => fetchJson(`/api/console/teams/${encodeURIComponent(teamId)}/members`), [teamId]);

  const reloadMembers = useCallback(async () => {
    setMembersState({ status: 'loading', members: [], error: null });
    try {
      const data = await fetchTeamMembers();
      setMembersState({ status: 'ready', members: data.members || [], error: null });
    } catch (error) {
      setMembersState({ status: 'error', members: [], error });
      throw error;
    }
  }, [fetchTeamMembers]);

  useEffect(() => {
    let active = true;
    setState({ status: 'loading', team: null, error: null });
    fetchJson(`/api/console/teams/${encodeURIComponent(teamId)}`)
      .then((data) => {
        if (active) setState({ status: 'ready', team: data.team || null, error: null });
      })
      .catch((error) => {
        if (active) setState({ status: 'error', team: null, error });
      });
    return () => {
      active = false;
    };
  }, [teamId]);

  useEffect(() => {
    if (activeTab !== 'members') {
      setMembersState({ status: 'idle', members: [], error: null });
      return undefined;
    }

    let active = true;
    setMembersState({ status: 'loading', members: [], error: null });
    fetchTeamMembers()
      .then((data) => {
        if (active) setMembersState({ status: 'ready', members: data.members || [], error: null });
      })
      .catch((error) => {
        if (active) setMembersState({ status: 'error', members: [], error });
      });
    return () => {
      active = false;
    };
  }, [activeTab, fetchTeamMembers]);

  const title = state.team?.name || teamId;

  return (
    <div className="workspace-layout context-layout">
      <TeamContextSidebar team={state.team} teamId={teamId} activeTab={activeTab} />
      <main className="page workspace-page">
        <PageHeading title={title} meta="团队" />
        {state.status === 'loading' ? <div className="placeholder">加载中</div> : null}
        {state.status === 'error' ? <div className="placeholder">无法加载团队</div> : null}
        {state.status === 'ready' && state.team ? (
          <TeamTabContent
            team={state.team}
            tab={activeTab}
            membersState={membersState}
            onTeamUpdate={updateTeam}
            onMembersReload={reloadMembers}
          />
        ) : null}
      </main>
    </div>
  );
}

function TeamsContent({ state }) {
  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error') return <div className="placeholder">无法加载团队</div>;
  if (!state.teams.length) return <div className="placeholder">暂无团队</div>;

  return (
    <section className="team-list" aria-label="团队列表">
      {state.teams.map((team) => (
        <Link className="team-row" to={`/workspace/teams/${encodeURIComponent(team.id)}`} key={team.id}>
          <div>
            <strong>{team.name}</strong>
            <span>{team.description || team.departmentPath || team.id}</span>
          </div>
          <div className="tag-row compact-tags">
            {team.teamType === 'department' ? <span className="tag">部门团队</span> : null}
            <span className="tag muted">{team.currentUserRole || 'viewer'}</span>
          </div>
        </Link>
      ))}
    </section>
  );
}

function TeamContextSidebar({ team, teamId, activeTab }) {
  const base = `/workspace/teams/${encodeURIComponent(teamId)}`;
  return (
    <aside className="sidebar context-sidebar">
      <Link className="back-link" to="/workspace/teams">
        <ArrowLeft size={16} />
        <span>所有团队</span>
      </Link>
      <div className="context-title">
        <h2>{team?.name || teamId}</h2>
        {team?.description ? <p>{team.description}</p> : null}
        <div className="tag-row compact-tags">
          {team?.teamType === 'department' ? <span className="tag">部门团队</span> : null}
          <span className="tag muted">{team?.currentUserRole || 'viewer'}</span>
        </div>
      </div>
      <nav className="side-section" aria-label="团队导航">
        <ContextLink href={`${base}/members`} active={activeTab === 'members'} icon={<UsersRound size={17} />} label="成员" />
        <ContextLink
          href={`${base}/access-keys`}
          active={activeTab === 'access-keys'}
          icon={<KeyRound size={17} />}
          label="Access Keys"
        />
        <ContextLink href={`${base}/settings`} active={activeTab === 'settings'} icon={<Settings size={17} />} label="设置" />
      </nav>
    </aside>
  );
}

function ContextLink({ href, active, icon, label }) {
  return (
    <Link className={active ? 'side-link active' : 'side-link'} to={href}>
      {icon}
      <span>{label}</span>
    </Link>
  );
}

function TeamTabContent({ team, tab, membersState, onTeamUpdate, onMembersReload }) {
  if (tab === 'access-keys') return <TeamAccessKeys team={team} />;
  if (tab === 'settings') return <TeamSettings team={team} onTeamUpdate={onTeamUpdate} />;
  return <TeamMembers team={team} state={membersState} onReload={onMembersReload} />;
}

function TeamMembers({ team, state, onReload }) {
  const canManage = team.currentUserRole === 'admin';

  return (
    <section className="detail-stack">
      {canManage ? (
        <TeamMemberForm team={team} onReload={onReload} />
      ) : (
        <div className="placeholder">仅团队 admin 可管理成员</div>
      )}
      <section className="table-list" aria-label="团队成员">
        <div className="table-toolbar">
          <strong>团队成员</strong>
          <span className="tag muted">{state.members.length}</span>
        </div>
        {state.status === 'loading' ? <div className="placeholder">加载中</div> : null}
        {state.status === 'error' ? <div className="placeholder">无法加载成员</div> : null}
        {state.status === 'ready' && !state.members.length ? <div className="placeholder">暂无成员</div> : null}
        {state.status === 'ready'
          ? state.members.map((member) => (
              <div className="table-row member-row" key={`${member.teamId}:${member.userId}`}>
                <div>
                  <strong>{member.userId}</strong>
                  <span>{formatDate(member.updatedAt)}</span>
                </div>
                <div className="tag-row compact-tags">
                  <span className="tag muted">{membershipSourceLabel(member.membershipSource)}</span>
                  {member.departmentPath ? <span className="tag muted">{member.departmentPath}</span> : null}
                </div>
                {canManage ? (
                  <TeamMemberActions team={team} member={member} onReload={onReload} />
                ) : (
                  <span className="tag muted">{member.role}</span>
                )}
              </div>
            ))
          : null}
      </section>
    </section>
  );
}

function TeamMemberForm({ team, onReload }) {
  const [form, setForm] = useState({ userId: '', role: 'viewer' });
  const [status, setStatus] = useState({ saving: false, error: '' });

  const submit = async (event) => {
    event.preventDefault();
    const userId = form.userId.trim();
    if (!userId) return;

    setStatus({ saving: true, error: '' });
    try {
      await updateTeamMember(team.id, userId, { role: form.role });
      setForm({ userId: '', role: 'viewer' });
      await onReload?.();
      setStatus({ saving: false, error: '' });
    } catch (error) {
      setStatus({ saving: false, error: error?.code || error?.message || '保存成员失败' });
    }
  };

  return (
    <form className="info-list team-member-form" onSubmit={submit}>
      <div className="panel-head">
        <div>
          <p>Admin</p>
          <h2>添加或更新成员</h2>
        </div>
        <button className="primary-button" type="submit" disabled={status.saving || !form.userId.trim()}>
          <Plus size={16} />
          {status.saving ? '保存中' : '保存'}
        </button>
      </div>
      <div className="team-member-form-body">
        <label className="field">
          <span>用户 ID / 邮箱</span>
          <input value={form.userId} onChange={(event) => setForm((current) => ({ ...current, userId: event.target.value }))} />
        </label>
        <label className="field">
          <span>角色</span>
          <select value={form.role} onChange={(event) => setForm((current) => ({ ...current, role: event.target.value }))}>
            {TEAM_ROLE_OPTIONS.map((role) => (
              <option key={role} value={role}>
                {role}
              </option>
            ))}
          </select>
        </label>
        {status.error ? <div className="form-error">{status.error}</div> : null}
      </div>
    </form>
  );
}

function TeamMemberActions({ team, member, onReload }) {
  const [role, setRole] = useState(member.role);
  const [status, setStatus] = useState({ saving: false, removing: false, error: '' });

  useEffect(() => {
    setRole(member.role);
    setStatus({ saving: false, removing: false, error: '' });
  }, [member.role, member.userId]);

  const save = async () => {
    setStatus({ saving: true, removing: false, error: '' });
    try {
      await updateTeamMember(team.id, member.userId, { role });
      await onReload?.();
      setStatus({ saving: false, removing: false, error: '' });
    } catch (error) {
      setStatus({ saving: false, removing: false, error: error?.code || error?.message || '保存角色失败' });
    }
  };

  const remove = async () => {
    const confirmed = globalThis.confirm?.(`确认从团队中移除 ${member.userId}？`);
    if (!confirmed) return;

    setStatus({ saving: false, removing: true, error: '' });
    try {
      await removeTeamMember(team.id, member.userId);
      await onReload?.();
      setStatus({ saving: false, removing: false, error: '' });
    } catch (error) {
      setStatus({ saving: false, removing: false, error: error?.code || error?.message || '移除成员失败' });
    }
  };

  return (
    <div className="member-role-actions">
      <select disabled={status.saving || status.removing} value={role} onChange={(event) => setRole(event.target.value)}>
        {TEAM_ROLE_OPTIONS.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <button
        className="icon-button compact"
        type="button"
        title="保存角色"
        disabled={status.saving || role === member.role}
        onClick={save}
      >
        <Save size={15} />
      </button>
      <button className="icon-button compact" type="button" title="移除成员" disabled={status.removing} onClick={remove}>
        <Trash2 size={15} />
      </button>
      {status.error ? <span className="row-error">{status.error}</span> : null}
    </div>
  );
}

function TeamAccessKeys({ team }) {
  return <AccessKeysPanel ownerType="team" teamId={team.id} canManage={team.currentUserRole === 'admin'} />;
}

function TeamSettings({ team, onTeamUpdate }) {
  const [form, setForm] = useState({ name: team.name || '', description: team.description || '' });
  const [status, setStatus] = useState({ saving: false, deleting: false, error: '', notice: '' });
  const editable = canEditTeamSettings(team);
  const deletable = canDeleteTeam(team);
  const readOnlyReason = getTeamSettingsReadOnlyReason(team);

  useEffect(() => {
    setForm({ name: team.name || '', description: team.description || '' });
  }, [team.id, team.name, team.description]);

  useEffect(() => {
    setStatus({ saving: false, deleting: false, error: '', notice: '' });
  }, [team.id]);

  const rows = useMemo(
    () => [
      ['名称', team.name || '-'],
      ['描述', team.description || '-'],
      ['类型', team.teamType === 'department' ? '部门团队' : '自建团队'],
      ['状态', team.status || 'active'],
    ],
    [team]
  );

  const save = async (event) => {
    event.preventDefault();
    setStatus({ saving: true, deleting: false, error: '', notice: '' });
    try {
      const body = normalizeTeamSettingsForm(form);
      const data = await updateTeamSettings(team.id, body);
      if (data?.team) onTeamUpdate(data.team);
      setStatus({ saving: false, deleting: false, error: '', notice: '团队信息已保存' });
    } catch (error) {
      setStatus({
        saving: false,
        deleting: false,
        error: error?.code === 'TEAM_NAME_REQUIRED' ? '团队名称不能为空。' : error?.code || error?.message || '保存失败',
        notice: '',
      });
    }
  };

  const remove = async () => {
    const confirmed = globalThis.confirm?.('删除前请确认团队站点已手动删除或转移、团队 Access Keys 已撤销。此操作不可恢复。');
    if (!confirmed) return;

    setStatus({ saving: false, deleting: true, error: '', notice: '' });
    try {
      await deleteTeam(team.id);
      globalThis.location.assign('/workspace/teams');
    } catch (error) {
      setStatus({
        saving: false,
        deleting: false,
        error: getTeamDeleteErrorMessage(error),
        notice: '',
      });
    }
  };

  return (
    <section className="detail-stack">
      <section className="info-list">
        <h2>团队设置</h2>
        <dl>
          {rows.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      </section>
      <form className="info-list team-settings-form" onSubmit={save}>
        <div className="panel-head">
          <div>
            <p>团队信息</p>
            <h2>名称与描述</h2>
          </div>
          {editable ? (
            <button className="primary-button" type="submit" disabled={status.saving || status.deleting}>
              <Save size={16} />
              {status.saving ? '保存中' : '保存'}
            </button>
          ) : null}
        </div>
        <div className="team-settings-form-body">
          <label className="field">
            <span>名称</span>
            <input
              disabled={!editable || status.saving || status.deleting}
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              required
            />
          </label>
          <label className="field">
            <span>描述</span>
            <textarea
              disabled={!editable || status.saving || status.deleting}
              value={form.description}
              onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
            />
          </label>
          {!editable ? <div className="form-note">{readOnlyReason}</div> : null}
          {status.notice ? <div className="form-note success">{status.notice}</div> : null}
          {status.error ? <div className="form-error">{status.error}</div> : null}
        </div>
      </form>
      <section className="info-list danger-zone">
        <div className="panel-head">
          <div>
            <p>危险操作</p>
            <h2>删除团队</h2>
          </div>
          {deletable ? (
            <button
              className="secondary-button danger-button"
              type="button"
              disabled={status.deleting || status.saving}
              onClick={remove}
            >
              <Trash2 size={16} />
              {status.deleting ? '删除中' : '删除团队'}
            </button>
          ) : null}
        </div>
        <div className="danger-zone-body">
          <p>删除前必须先手动删除或转移团队站点，并撤销团队归属的 Access Keys。</p>
          {!deletable ? <p>{readOnlyReason}</p> : null}
        </div>
      </section>
    </section>
  );
}

function membershipSourceLabel(value) {
  if (value === 'department_auto') return '部门自动成员';
  if (value === 'manual') return '手动成员';
  return value || '成员';
}

function formatDate(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}
