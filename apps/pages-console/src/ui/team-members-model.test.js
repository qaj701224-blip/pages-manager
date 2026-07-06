import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTeamMemberSourceLine, buildTeamMemberView, buildUserPickerRows } from './team-members-model.js';

test('team member view prefers SSO realname and email over opaque user id', () => {
  const view = buildTeamMemberView({
    userId: 'b8a0c9c937c84754a4af44ac49c16686',
    user: {
      id: 'usr_xutianqi',
      realname: '徐天麒',
      email: 'xutianqi@xd.com',
      account: 'xutianqi',
      departmentPath: 'XD/Platform',
    },
    role: 'admin',
    membershipSource: 'manual',
    updatedAt: '2026-07-03T12:35:33.000Z',
  });

  assert.equal(view.displayName, '徐天麒');
  assert.equal(view.email, 'xutianqi@xd.com');
  assert.equal(view.avatarText, '徐');
  assert.equal(view.userTitle, '徐天麒 xutianqi@xd.com');
});

test('user picker rows mark users already in the team', () => {
  const rows = buildUserPickerRows({
    users: [
      { id: 'usr_xutianqi', realname: '徐天麒', email: 'xutianqi@xd.com' },
      { id: 'usr_other', realname: '其他用户', email: 'other@xd.com' },
    ],
    members: [{ userId: 'usr_xutianqi' }],
  });

  assert.deepEqual(
    rows.map((row) => ({ id: row.id, displayName: row.displayName, alreadyMember: row.alreadyMember })),
    [
      { id: 'usr_xutianqi', displayName: '徐天麒', alreadyMember: true },
      { id: 'usr_other', displayName: '其他用户', alreadyMember: false },
    ]
  );
});

test('team member source line omits generic manual member copy', () => {
  assert.equal(
    buildTeamMemberSourceLine({
      membershipSource: 'manual',
      departmentPath: '',
    }),
    ''
  );
  assert.equal(
    buildTeamMemberSourceLine({
      membershipSource: 'department_auto',
      departmentPath: 'XD/Platform/Web',
    }),
    '部门成员 · XD/Platform/Web'
  );
});
