import assert from 'node:assert/strict';
import test from 'node:test';

import { createTeamManagement } from './manage-team.js';

test('platform admin updates custom team settings without membership', async () => {
  const calls = [];
  const application = createApplication({
    updateSettings: async (input) => (calls.push(input), { id: input.teamId, name: input.name }),
  });

  const result = await application.updateSettings(command({ capability: 'platform_admin', name: 'Renamed' }));

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      teamId: 'team_1',
      name: 'Renamed',
      description: 'Description',
      actorUserId: 'usr_actor',
    },
  ]);
});

test('team settings require team admin capability and reject department teams', async () => {
  const viewer = createApplication({ member: { role: 'viewer' } });
  const department = createApplication({
    team: { id: 'team_1', environment: 'production', status: 'active', teamType: 'department' },
  });

  assert.equal((await viewer.updateSettings(command())).reason, 'team_admin_required');
  assert.equal(
    (await department.updateSettings(command({ capability: 'platform_admin' }))).reason,
    'department_settings_readonly'
  );
});

test('team deletion preserves department and blocking asset guards', async () => {
  const department = createApplication({
    team: { id: 'team_1', environment: 'production', status: 'active', teamType: 'department' },
  });
  const blocked = createApplication({
    deleteCustom: async () => {
      throw new Error('TEAM_HAS_BLOCKING_ASSETS');
    },
  });

  assert.equal(
    (await department.deleteTeam(command({ capability: 'platform_admin' }))).reason,
    'department_delete_forbidden'
  );
  assert.equal((await blocked.deleteTeam(command({ capability: 'platform_admin' }))).reason, 'blocking_assets');
});

test('team management requires narrow team and membership repositories', () => {
  assert.throws(() => createTeamManagement({ teams: {}, members: {} }), /teams\.get is required/);
});

function createApplication({
  team = { id: 'team_1', environment: 'production', status: 'active', teamType: 'custom' },
  member = { role: 'admin' },
  updateSettings = async (input) => input,
  deleteCustom = async (input) => input,
} = {}) {
  return createTeamManagement({
    teams: {
      get: async () => team,
      updateSettings,
      deleteCustom,
    },
    members: { get: async () => member },
  });
}

function command(overrides = {}) {
  return {
    environment: 'production',
    teamId: 'team_1',
    actorUserId: 'usr_actor',
    capability: 'team_admin',
    name: 'Team',
    description: 'Description',
    ...overrides,
  };
}
