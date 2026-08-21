import assert from 'node:assert/strict';
import test from 'node:test';

import { createTeamMemberManagement } from './manage-team-members.js';

test('platform admin updates a member through the shared mutation without team membership', async () => {
  const calls = [];
  const application = createApplication({
    upsert: async (input) => (calls.push(input), { ...input, user: { employeeStatus: 'active' } }),
  });

  const result = await application.update(command({ capability: 'platform_admin' }));

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      teamId: 'team_1',
      userId: 'usr_target',
      role: 'viewer',
      membershipSource: 'manual',
      actorUserId: 'usr_actor',
    },
  ]);
});

test('team member mutation requires an active team admin outside platform admin scope', async () => {
  const missingActor = createApplication();
  const viewerActor = createApplication({
    memberByUserId: new Map([['usr_actor', { userId: 'usr_actor', role: 'viewer' }]]),
  });

  assert.equal((await missingActor.update(command())).reason, 'team_not_found');
  assert.equal((await viewerActor.update(command())).reason, 'team_admin_required');
});

test('team member mutation preserves the last active admin invariant', async () => {
  const memberByUserId = new Map([
    ['usr_actor', { userId: 'usr_actor', role: 'admin' }],
    ['usr_target', { userId: 'usr_target', role: 'admin' }],
  ]);
  const application = createApplication({
    memberByUserId,
    listedMembers: [{ userId: 'usr_target', role: 'admin', user: { employeeStatus: 'active' } }],
  });

  assert.equal((await application.update(command())).reason, 'last_admin');
  assert.equal((await application.remove(command())).reason, 'last_admin');
});

test('team member removal reports a missing target after authorization', async () => {
  const application = createApplication({
    memberByUserId: new Map([['usr_actor', { userId: 'usr_actor', role: 'admin' }]]),
    remove: async () => null,
  });

  assert.equal((await application.remove(command())).reason, 'member_not_found');
});

test('team member management requires narrow repositories', () => {
  assert.throws(() => createTeamMemberManagement({ teams: {}, users: {}, members: {} }), /teams\.get is required/);
});

function createApplication({
  team = { id: 'team_1', environment: 'production', status: 'active', deletedAt: null },
  user = { id: 'usr_target' },
  memberByUserId = new Map(),
  listedMembers = [],
  upsert = async (input) => input,
  remove = async (input) => input,
} = {}) {
  return createTeamMemberManagement({
    teams: { get: async () => team },
    users: { get: async () => user },
    members: {
      get: async ({ userId }) => memberByUserId.get(userId) || null,
      list: async () => listedMembers,
      upsert,
      remove,
    },
  });
}

function command(overrides = {}) {
  return {
    environment: 'production',
    teamId: 'team_1',
    userId: 'usr_target',
    role: 'viewer',
    actorUserId: 'usr_actor',
    capability: 'team_admin',
    ...overrides,
  };
}
