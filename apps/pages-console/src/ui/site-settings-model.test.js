import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSiteOwnerSettingsForm,
  filterSiteOwnerCandidates,
  normalizeSiteOwnerSettingsPayload,
  siteOwnerCandidateLabel,
  siteOwnerCandidateMeta,
} from './site-settings-model.js';

test('site owner settings form starts from current owner', () => {
  assert.deepEqual(buildSiteOwnerSettingsForm({ owner: { type: 'team', id: 'team_1' } }), {
    ownerType: 'team',
    ownerId: 'team_1',
    query: '',
  });
});

test('site owner settings payload uses user owner id or team id', () => {
  assert.deepEqual(normalizeSiteOwnerSettingsPayload({ ownerType: 'user', ownerId: 'usr_1' }), {
    ownerType: 'user',
    ownerId: 'usr_1',
  });
  assert.deepEqual(normalizeSiteOwnerSettingsPayload({ ownerType: 'team', ownerId: 'team_1' }), {
    ownerType: 'team',
    teamId: 'team_1',
  });
  assert.throws(() => normalizeSiteOwnerSettingsPayload({ ownerType: 'team', ownerId: '' }), {
    code: 'TEAM_REQUIRED',
  });
});

test('site owner candidate helpers filter manageable teams and format labels', () => {
  const teams = [
    { id: 'team_viewer', name: 'Viewer Team', currentUserRole: 'viewer' },
    { id: 'team_pub', name: 'Publisher Team', departmentPath: 'XD/Platform', currentUserRole: 'publisher' },
  ];

  assert.deepEqual(filterSiteOwnerCandidates(teams, 'pub', 'team'), [teams[1]]);
  assert.equal(siteOwnerCandidateLabel(teams[1], 'team'), 'Publisher Team');
  assert.equal(siteOwnerCandidateMeta(teams[1], 'team'), 'XD/Platform');
  assert.equal(siteOwnerCandidateLabel({ id: 'usr_1', realname: '徐天麒', email: 'x@example.com' }, 'user'), '徐天麒');
});

test('site owner user candidates hide inactive users', () => {
  const users = [
    { id: 'usr_inactive', realname: 'Inactive User', employeeStatus: 'inactive' },
    { id: 'usr_active', realname: 'Active User', employeeStatus: 'active' },
  ];

  assert.deepEqual(filterSiteOwnerCandidates(users, 'user', 'user'), [users[1]]);
});
