import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTeamCards, buildTeamFilterOptions } from './team-list-model.js';

test('team cards expose skill-hub style display fields', () => {
  const cards = buildTeamCards([
    {
      id: 'team_test',
      name: 'test',
      description: '测试',
      currentUserRole: 'admin',
      teamType: 'custom',
    },
    {
      id: 'dept_xd',
      name: 'XD / Web',
      departmentPath: 'XD/Platform/Web',
      currentUserRole: 'publisher',
      teamType: 'department',
    },
  ]);

  assert.deepEqual(cards[0], {
    id: 'team_test',
    name: 'test',
    avatarText: 't',
    description: '测试',
    roleLabel: 'admin',
    typeLabel: '自建团队',
  });
  assert.deepEqual(cards[1], {
    id: 'dept_xd',
    name: 'XD / Web',
    avatarText: 'X',
    description: 'XD/Platform/Web',
    roleLabel: 'publisher',
    typeLabel: '部门团队',
  });
});

test('team filter options keep the all-teams option visible', () => {
  assert.deepEqual(
    buildTeamFilterOptions([
      { id: 'team_a', name: 'Team A' },
      { id: 'team_b', name: 'Team B' },
    ]),
    [
      { value: '', label: '全部团队' },
      { value: 'team_a', label: 'Team A' },
      { value: 'team_b', label: 'Team B' },
    ]
  );
});
