import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, KeyRound, Plus, Save, Search, Settings, Trash2, UserPlus, UsersRound } from 'lucide-react';
import { Link } from 'react-router-dom';

import { createTeam, deleteTeam, fetchJson, listConsoleUsers, removeTeamMember, updateTeamMember, updateTeamSettings } from '../api.js';
import { AppDialog, SelectField } from '../components/RadixPrimitives.jsx';
import { Sidebar } from '../components/Sidebar.jsx';
import { usePreferences } from '../preferences-context.jsx';
import { buildTeamMemberView, buildUserPickerRows } from '../team-members-model.js';
import { buildTeamCards } from '../team-list-model.js';
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

export function TeamsList({ sessionState }) {
  const [state, setState] = useState({ status: 'loading', teams: [], error: null });
  const [dialogOpen, setDialogOpen] = useState(false);
  const { t } = usePreferences();

  const loadTeams = useCallback(async () => {
    const data = await fetchJson('/api/console/teams');
    setState({ status: 'ready', teams: data.teams || [], error: null });
    return data.teams || [];
  }, []);

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
      <Sidebar active="teams" sessionState={sessionState} />
      <main className="page workspace-page">
        <div className="page-heading-row">
          <PageHeading title={t('teams')} meta={t('collaboration')} />
          <button className="primary-button" type="button" onClick={() => setDialogOpen(true)}>
            <Plus size={16} />
            <span>{t('createTeam')}</span>
          </button>
        </div>
        <TeamsContent state={state} onCreate={() => setDialogOpen(true)} />
        <CreateTeamDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onCreated={async () => {
            await loadTeams();
          }}
        />
      </main>
    </div>
  );
}

export function TeamDetail({ teamId, tab = 'members', sessionState }) {
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
      <TeamContextSidebar teamId={teamId} activeTab={activeTab} sessionState={sessionState} />
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

function TeamsContent({ state, onCreate }) {
  if (state.status === 'loading') return <div className="placeholder">加载中</div>;
  if (state.status === 'error') return <div className="placeholder">无法加载团队</div>;
  const cards = buildTeamCards(state.teams);

  return (
    <section className="team-card-grid" aria-label="团队列表">
      {cards.map((team) => (
        <Link className="team-card" to={`/workspace/teams/${encodeURIComponent(team.id)}`} key={team.id}>
          <div className="team-card__top">
            <span className="team-card__avatar">{team.avatarText}</span>
            <div>
              <strong>{team.name}</strong>
              <span>你的角色：{team.roleLabel}</span>
            </div>
          </div>
          <p>{team.description}</p>
          <div className="team-card__footer">
            <span className="tag">{team.typeLabel}</span>
            <span className="tag muted">{team.roleLabel}</span>
          </div>
        </Link>
      ))}
      <button className="team-card team-card--create" type="button" onClick={onCreate}>
        <Plus size={22} />
        <span>创建新团队</span>
      </button>
    </section>
  );
}

function CreateTeamDialog({ open, onOpenChange, onCreated }) {
  const { t } = usePreferences();
  const [form, setForm] = useState({ name: '', description: '' });
  const [status, setStatus] = useState({ saving: false, error: '' });

  useEffect(() => {
    if (open) {
      setForm({ name: '', description: '' });
      setStatus({ saving: false, error: '' });
    }
  }, [open]);

  const submit = async (event) => {
    event.preventDefault();
    if (!form.name.trim()) return;
    setStatus({ saving: true, error: '' });
    try {
      await createTeam({ name: form.name.trim(), description: form.description.trim() });
      await onCreated?.();
      setStatus({ saving: false, error: '' });
      onOpenChange(false);
    } catch (error) {
      setStatus({ saving: false, error: error?.code || error?.message || '创建团队失败' });
    }
  };

  return (
    <AppDialog open={open} title={t('createTeamTitle')} eyebrow={t('collaboration')} onOpenChange={onOpenChange}>
      <form className="dialog-form" onSubmit={submit}>
        <p className="dialog-description">{t('createTeamDescription')}</p>
        <label className="field">
          <span>{t('teamName')}</span>
          <input
            value={form.name}
            onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
            placeholder="Console Team"
            required
          />
        </label>
        <label className="field">
          <span>{t('teamDescription')}</span>
          <textarea
            value={form.description}
            onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
            placeholder="站点协作团队"
          />
        </label>
        {status.error ? <div className="form-error">{status.error}</div> : null}
        <div className="dialog-actions">
          <button className="secondary-button" type="button" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </button>
          <button className="primary-button" type="submit" disabled={status.saving || !form.name.trim()}>
            <Plus size={16} />
            <span>{status.saving ? t('creating') : t('create')}</span>
          </button>
        </div>
      </form>
    </AppDialog>
  );
}

function TeamContextSidebar({ teamId, activeTab, sessionState }) {
  const base = `/workspace/teams/${encodeURIComponent(teamId)}`;
  return (
    <Sidebar active="teams" sessionState={sessionState}>
      <Link className="back-link" to="/workspace/teams">
        <ArrowLeft size={16} />
        <span>所有团队</span>
      </Link>
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
    </Sidebar>
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
  const [addDialogOpen, setAddDialogOpen] = useState(false);
  const members = state.members || [];

  return (
    <section className="detail-stack">
      <section className="table-list team-members-panel" aria-label="团队成员">
        <div className="member-panel-head">
          <div>
            <strong>{team.name} · 成员</strong>
            <span>{members.length} 名成员</span>
          </div>
          {canManage ? (
            <button className="primary-button" type="button" onClick={() => setAddDialogOpen(true)}>
              <UserPlus size={16} />
              <span>添加成员</span>
            </button>
          ) : null}
        </div>
        {state.status === 'loading' ? <div className="placeholder">加载中</div> : null}
        {state.status === 'error' ? <div className="placeholder">无法加载成员</div> : null}
        {state.status === 'ready' && !members.length ? <div className="placeholder">暂无成员</div> : null}
        {state.status === 'ready' && members.length ? (
          <>
            <div className="member-table-head">
              <span>姓名 / 邮箱</span>
              <span>角色</span>
              <span>加入时间</span>
              <span>操作</span>
            </div>
            {members.map((member) => (
              <TeamMemberRow
                canManage={canManage}
                key={`${member.teamId}:${member.userId}`}
                member={member}
                team={team}
                onReload={onReload}
              />
            ))}
          </>
        ) : null}
      </section>
      {canManage ? (
        <AddTeamMemberDialog
          open={addDialogOpen}
          team={team}
          members={members}
          onOpenChange={setAddDialogOpen}
          onReload={onReload}
        />
      ) : null}
    </section>
  );
}

function TeamMemberRow({ team, member, canManage, onReload }) {
  const view = buildTeamMemberView(member);
  return (
    <div className="table-row member-row">
      <div className="member-identity" title={view.userTitle}>
        <span className="member-avatar">{view.avatarText}</span>
        <div>
          <strong>{view.displayName}</strong>
          <span>{view.email || member.userId}</span>
          <span className="member-source-line">
            {membershipSourceLabel(member.membershipSource)}
            {view.departmentPath ? ` · ${view.departmentPath}` : ''}
          </span>
        </div>
      </div>
      {canManage ? (
        <TeamMemberActions team={team} member={member} onReload={onReload} />
      ) : (
        <>
          <span className="tag muted">{member.role}</span>
          <span>{formatDate(member.createdAt || member.updatedAt)}</span>
          <span className="muted-cell">-</span>
        </>
      )}
    </div>
  );
}

function TeamMemberActions({ team, member, onReload }) {
  const [role, setRole] = useState(member.role);
  const [status, setStatus] = useState({ saving: false, removing: false, error: '' });
  const [confirmRemove, setConfirmRemove] = useState(false);
  const view = buildTeamMemberView(member);

  useEffect(() => {
    setRole(member.role);
    setStatus({ saving: false, removing: false, error: '' });
    setConfirmRemove(false);
  }, [member.role, member.userId]);

  const save = async (nextRole) => {
    if (nextRole === member.role) {
      setRole(nextRole);
      return;
    }
    setRole(nextRole);
    setStatus({ saving: true, removing: false, error: '' });
    try {
      await updateTeamMember(team.id, member.userId, { role: nextRole });
      await onReload?.();
      setStatus({ saving: false, removing: false, error: '' });
    } catch (error) {
      setRole(member.role);
      setStatus({ saving: false, removing: false, error: error?.code || error?.message || '保存角色失败' });
    }
  };

  const remove = async () => {
    setStatus({ saving: false, removing: true, error: '' });
    try {
      await removeTeamMember(team.id, member.userId);
      await onReload?.();
      setStatus({ saving: false, removing: false, error: '' });
      setConfirmRemove(false);
    } catch (error) {
      setStatus({ saving: false, removing: false, error: error?.code || error?.message || '移除成员失败' });
    }
  };

  return (
    <>
      <div className="member-role-actions">
        <SelectField
          disabled={status.saving || status.removing}
          value={role}
          options={TEAM_ROLE_OPTIONS.map((option) => ({ value: option, label: option }))}
          onChange={save}
        />
        {status.saving ? <span>保存中</span> : null}
        {status.error ? <span className="row-error">{status.error}</span> : null}
      </div>
      <span>{formatDate(member.createdAt || member.updatedAt)}</span>
      <div className="member-row-actions">
        <button
          className="table-action danger"
          type="button"
          title="移除成员"
          disabled={status.removing}
          onClick={() => setConfirmRemove(true)}
        >
          <Trash2 size={15} />
          <span>{status.removing ? '移除中' : '移除成员'}</span>
        </button>
      </div>
      <AppDialog
        open={confirmRemove}
        title="移除成员"
        eyebrow="高风险操作"
        onOpenChange={(open) => {
          if (!open && !status.removing) setConfirmRemove(false);
        }}
      >
        <div className="dialog-form">
          <div className="danger-summary">
            <Trash2 size={18} />
            <span>
              <strong>{view.displayName}</strong>
              <small>{view.email || member.userId}</small>
            </span>
          </div>
          <p className="dialog-description">移除后，该用户将失去此团队及团队站点的相关权限。</p>
          {status.error ? <div className="form-error">{status.error}</div> : null}
          <div className="dialog-actions">
            <button className="secondary-button" type="button" onClick={() => setConfirmRemove(false)} disabled={status.removing}>
              取消
            </button>
            <button className="primary-button danger-primary-button" type="button" onClick={remove} disabled={status.removing}>
              <Trash2 size={15} />
              <span>{status.removing ? '移除中' : '移除成员'}</span>
            </button>
          </div>
        </div>
      </AppDialog>
    </>
  );
}

function AddTeamMemberDialog({ open, team, members, onOpenChange, onReload }) {
  const [query, setQuery] = useState('');
  const [role, setRole] = useState('viewer');
  const [state, setState] = useState({ status: 'idle', users: [], error: null });
  const [action, setAction] = useState({ userId: '', status: 'idle', error: null });

  useEffect(() => {
    if (!open) return undefined;
    setQuery('');
    setRole('viewer');
    setAction({ userId: '', status: 'idle', error: null });
    return undefined;
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    let active = true;
    const timer = setTimeout(() => {
      setState((current) => ({ status: 'loading', users: current.users, error: null }));
      listConsoleUsers({ query })
        .then((data) => {
          if (active) setState({ status: 'ready', users: data.users || [], error: null });
        })
        .catch((error) => {
          if (active) setState({ status: 'error', users: [], error });
        });
    }, query ? 180 : 0);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [open, query]);

  const rows = useMemo(() => buildUserPickerRows({ users: state.users, members }), [members, state.users]);

  const addUser = async (row) => {
    if (row.alreadyMember || action.status === 'saving') return;
    setAction({ userId: row.id, status: 'saving', error: null });
    try {
      await updateTeamMember(team.id, row.id, { role });
      await onReload?.();
      setAction({ userId: '', status: 'idle', error: null });
    } catch (error) {
      setAction({ userId: row.id, status: 'error', error });
    }
  };

  return (
    <AppDialog open={open} title="添加成员" onOpenChange={onOpenChange}>
      <div className="member-picker">
        <label className="field">
          <span>公司用户</span>
          <span className="member-search-input">
            <Search size={16} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索姓名、邮箱或 SSO ID"
              autoFocus
            />
          </span>
        </label>
        <SelectField
          label="角色"
          value={role}
          options={TEAM_ROLE_OPTIONS.map((option) => ({ value: option, label: option }))}
          onChange={setRole}
        />
        <p className="dialog-description">默认角色是 viewer。添加前可以选择其他角色，之后也可以从成员列表调整。</p>
        <div className="member-picker-list">
          {state.status === 'loading' ? <div className="panel-empty">搜索中</div> : null}
          {state.status === 'error' ? <div className="form-error">{state.error?.code || 'USER_SEARCH_FAILED'}</div> : null}
          {state.status === 'ready' && !rows.length ? <div className="panel-empty">暂无匹配用户</div> : null}
          {state.status === 'ready'
            ? rows.map((row) => (
                <button
                  className="member-picker-row"
                  type="button"
                  key={row.id}
                  disabled={row.alreadyMember || action.status === 'saving'}
                  onClick={() => addUser(row)}
                >
                  <span className="member-avatar">{row.avatarText}</span>
                  <span className="member-picker-identity">
                    <strong>{row.displayName}</strong>
                    <small>{row.email || row.id}</small>
                  </span>
                  {row.alreadyMember ? (
                    <span className="tag muted">已在团队</span>
                  ) : (
                    <span className="table-action">
                      <Plus size={15} />
                      {action.userId === row.id && action.status === 'saving' ? '添加中' : '添加'}
                    </span>
                  )}
                  {action.userId === row.id && action.status === 'error' ? (
                    <span className="row-error">{action.error?.code || 'ADD_MEMBER_FAILED'}</span>
                  ) : null}
                </button>
              ))
            : null}
        </div>
      </div>
    </AppDialog>
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
      ['ID', team.id || '-'],
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
              <dd title={String(value)}>{value}</dd>
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
