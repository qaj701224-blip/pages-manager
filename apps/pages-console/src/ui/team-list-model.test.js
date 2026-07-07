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
      siteCount: 2,
      memberCount: 5,
    },
    {
      id: 'dept_xd',
      name: 'XD / Web',
      departmentPath: 'XD/Platform/Web',
      currentUserRole: 'publisher',
      teamType: 'department',
      siteCount: 1,
      memberCount: 8,
    },
  ]);

  assert.deepEqual(cards[0], {
    id: 'team_test',
    name: 'test',
    avatarText: 't',
    summary: '测试',
    roleLabel: 'admin',
    typeLabel: '',
    siteCount: 2,
    memberCount: 5,
  });
  assert.deepEqual(cards[1], {
    id: 'dept_xd',
    name: 'XD / Web',
    avatarText: 'X',
    summary: '部门路径：XD/Platform/Web',
    roleLabel: 'publisher',
    typeLabel: '部门团队',
    siteCount: 1,
    memberCount: 8,
  });
});

test('department team cards collapse deep XDS paths to the team-level department', () => {
  const [card] = buildTeamCards([
    {
      id: 'dept_platform_support',
      name: '平台支撑部',
      departmentPath: '心动/发行服务/平台支撑部/技术/Web',
      currentUserRole: 'admin',
      teamType: 'department',
    },
  ]);

  assert.equal(card.summary, '部门路径：心动/发行服务/平台支撑部');
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
