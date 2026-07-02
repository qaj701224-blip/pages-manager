import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canDeleteTeam,
  canEditTeamSettings,
  getTeamDeleteErrorMessage,
  getTeamSettingsReadOnlyReason,
  normalizeTeamSettingsForm,
} from './team-settings-model.js';

test('custom team admin can edit settings and delete team', () => {
  const team = {
    teamType: 'custom',
    currentUserRole: 'admin',
  };

  assert.equal(canEditTeamSettings(team), true);
  assert.equal(canDeleteTeam(team), true);
  assert.equal(getTeamSettingsReadOnlyReason(team), '');
});

test('department team settings are read-only even for admin', () => {
  const team = {
    teamType: 'department',
    currentUserRole: 'admin',
  };

  assert.equal(canEditTeamSettings(team), false);
  assert.equal(canDeleteTeam(team), false);
  assert.equal(getTeamSettingsReadOnlyReason(team), '部门团队信息由 XDS 部门路径同步，不能在工作台编辑或删除。');
});

test('non-admin custom team member cannot edit settings or delete team', () => {
  const team = {
    teamType: 'custom',
    currentUserRole: 'publisher',
  };

  assert.equal(canEditTeamSettings(team), false);
  assert.equal(canDeleteTeam(team), false);
  assert.equal(getTeamSettingsReadOnlyReason(team), '仅团队 admin 可编辑团队信息或删除团队。');
});

test('normalizeTeamSettingsForm trims name and description', () => {
  assert.deepEqual(normalizeTeamSettingsForm({ name: ' Console Team ', description: ' Owners ' }), {
    name: 'Console Team',
    description: 'Owners',
  });

  assert.deepEqual(normalizeTeamSettingsForm({ name: 'Console Team', description: '   ' }), {
    name: 'Console Team',
    description: null,
  });
});

test('normalizeTeamSettingsForm rejects empty name', () => {
  assert.throws(() => normalizeTeamSettingsForm({ name: ' ', description: 'Owners' }), {
    code: 'TEAM_NAME_REQUIRED',
  });
});

test('team delete error message explains blocking assets', () => {
  assert.equal(
    getTeamDeleteErrorMessage({ code: 'TEAM_HAS_BLOCKING_ASSETS' }),
    '团队仍拥有站点或有效 Access Key。请先手动删除或转移团队站点，并撤销团队 Access Keys。'
  );
  assert.equal(getTeamDeleteErrorMessage({ code: 'DEPARTMENT_TEAM_DELETE_FORBIDDEN' }), '部门团队不能在工作台删除。');
  assert.equal(getTeamDeleteErrorMessage(new Error('oops')), '删除团队失败，请稍后重试。');
});
