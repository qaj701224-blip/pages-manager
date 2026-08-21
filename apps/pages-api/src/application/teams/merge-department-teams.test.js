import assert from 'node:assert/strict';
import test from 'node:test';

import { createDepartmentTeamMerge } from './merge-department-teams.js';

test('department team merge forwards the environment, actor, and reason to the transaction', async () => {
  const calls = [];
  const application = createDepartmentTeamMerge({
    teams: { merge: async (input) => (calls.push(input), { counts: { sites: 1 } }) },
  });

  const result = await application.execute({
    sourceTeamId: 'team_source',
    targetTeamId: 'team_target',
    actorUserId: 'usr_admin',
    reason: 'department renamed',
    environment: 'production',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      sourceTeamId: 'team_source',
      targetTeamId: 'team_target',
      actorUserId: 'usr_admin',
      reason: 'department renamed',
      environment: 'production',
    },
  ]);
});

test('department team merge returns expected transaction conflicts and rethrows unknown failures', async () => {
  const conflict = createDepartmentTeamMerge({
    teams: {
      merge: async () => {
        throw new Error('TEAM_MERGE_ENVIRONMENT_MISMATCH: staging');
      },
    },
  });
  const unexpected = createDepartmentTeamMerge({
    teams: {
      merge: async () => {
        throw new Error('database unavailable');
      },
    },
  });

  assert.deepEqual(await conflict.execute({}), {
    ok: false,
    errorCode: 'TEAM_MERGE_ENVIRONMENT_MISMATCH',
  });
  await assert.rejects(() => unexpected.execute({}), /database unavailable/);
});

test('department team merge requires its transaction port', () => {
  assert.throws(() => createDepartmentTeamMerge({ teams: {} }), /teams\.merge is required/);
});
