import { useEffect, useMemo, useState } from 'react';

import { fetchJson } from '../api.js';
import { Sidebar } from '../components/Sidebar.jsx';
import { PageHeading, SiteWaterfall } from './SitesDirectory.jsx';

export function WorkspaceSites({ owner = 'personal' }) {
  const [state, setState] = useState({ status: 'loading', sites: [], error: null });
  const [teamsState, setTeamsState] = useState({ status: 'idle', teams: [], error: null });
  const [teamId, setTeamId] = useState('');
  const ownerLabel = owner === 'team' ? '团队站点' : '个人站点';

  useEffect(() => {
    let active = true;
    const search = new URLSearchParams({ owner });
    if (owner === 'team' && teamId) search.set('teamId', teamId);
    fetchJson(`/api/console/workspace/sites?${search.toString()}`)
      .then((data) => {
        if (active) setState({ status: 'ready', sites: data.sites || [], error: null });
      })
      .catch((error) => {
        if (active) setState({ status: 'error', sites: [], error });
      });
    return () => {
      active = false;
    };
  }, [owner, teamId]);

  useEffect(() => {
    if (owner !== 'team') {
      setTeamsState({ status: 'idle', teams: [], error: null });
      setTeamId('');
      return undefined;
    }

    let active = true;
    setTeamsState({ status: 'loading', teams: [], error: null });
    fetchJson('/api/console/teams')
      .then((data) => {
        if (active) setTeamsState({ status: 'ready', teams: data.teams || [], error: null });
      })
      .catch((error) => {
        if (active) setTeamsState({ status: 'error', teams: [], error });
      });
    return () => {
      active = false;
    };
  }, [owner]);

  const active = useMemo(() => (owner === 'team' ? 'team-sites' : 'personal'), [owner]);

  return (
    <div className="workspace-layout">
      <Sidebar active={active} />
      <main className="page workspace-page">
        <PageHeading title={ownerLabel} meta="工作台" />
        {owner === 'team' ? <TeamSitesFilter teamsState={teamsState} teamId={teamId} onTeamIdChange={setTeamId} /> : null}
        <SiteWaterfall state={state} />
      </main>
    </div>
  );
}

function TeamSitesFilter({ teamsState, teamId, onTeamIdChange }) {
  if (teamsState.status === 'error') return <div className="form-error">无法加载团队筛选</div>;

  return (
    <section className="list-filter-bar" aria-label="团队站点筛选">
      <label className="field inline-field">
        <span>团队</span>
        <select
          disabled={teamsState.status === 'loading'}
          value={teamId}
          onChange={(event) => onTeamIdChange(event.target.value)}
        >
          <option value="">全部团队</option>
          {teamsState.teams.map((team) => (
            <option key={team.id} value={team.id}>
              {team.name}
            </option>
          ))}
        </select>
      </label>
    </section>
  );
}

export function WorkspacePlaceholder({ active, title }) {
  return (
    <div className="workspace-layout">
      <Sidebar active={active} />
      <main className="page workspace-page">
        <PageHeading title={title} meta="工作台" />
        <div className="placeholder">暂无内容</div>
      </main>
    </div>
  );
}
