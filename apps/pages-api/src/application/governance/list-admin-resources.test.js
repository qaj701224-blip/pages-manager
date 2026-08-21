import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAdminSitesQuery,
  createAdminTeamsQuery,
  createAdminUsersQuery,
  projectAdminSiteDetail,
  projectAdminTeamMember,
} from './list-admin-resources.js';

test('admin users query preserves repository pagination and projects safe profiles', async () => {
  const calls = [];
  const query = createAdminUsersQuery({
    users: {
      list: async (input) => {
        calls.push(input);
        return {
          users: [{ id: 'usr_1', email: 'user@example.com', isPlatformAdmin: 1, secret: 'hidden' }],
          total: 1,
          limit: 20,
          offset: 0,
        };
      },
    },
  });

  const result = await query.list({ environment: 'production', query: 'user' });

  assert.deepEqual(calls, [{ environment: 'production', query: 'user' }]);
  assert.deepEqual(result.pagination, { total: 1, limit: 20, offset: 0 });
  assert.equal(result.users[0].isPlatformAdmin, true);
  assert.equal(Object.hasOwn(result.users[0], 'secret'), false);
});

test('admin site and team queries project ownership and lifecycle fields', async () => {
  const sites = createAdminSitesQuery({
    sites: {
      list: async () => [
        {
          id: 'site_1',
          slug: 'demo',
          ownerType: 'team',
          ownerId: 'team_1',
          defaultExposure: 'internal',
          defaultVisibility: 'org',
          route: { hostname: 'demo.workers.xd.team', exposure: 'public', routeStatus: 'active' },
        },
      ],
    },
  });
  const teams = createAdminTeamsQuery({
    teams: {
      list: async () => [
        { id: 'team_1', name: 'Web', teamType: 'department', departmentPath: 'XD/Web', status: 'active' },
      ],
    },
  });

  assert.deepEqual((await sites.list({ environment: 'production' }))[0].owner, {
    type: 'team',
    id: 'team_1',
    email: null,
    displayName: null,
    departmentPath: null,
    teamType: null,
  });
  assert.equal((await teams.list({ environment: 'production' }))[0].name, 'Web');
});

test('admin detail projections keep access and member response shapes stable', () => {
  const site = projectAdminSiteDetail({
    id: 'site_1',
    slug: 'demo',
    defaultExposure: 'internal',
    defaultVisibility: 'org',
    route: { visibility: 'acl', accessMode: 'acl' },
  });
  const member = projectAdminTeamMember({ teamId: 'team_1', userId: 'usr_1', role: 'admin' });

  assert.deepEqual(site.access, { exposure: 'internal', accessMode: 'acl', visibility: 'acl' });
  assert.deepEqual(site.permissions, { role: 'admin', canManage: true, canManageAccess: true });
  assert.equal(member.user, null);
  assert.equal(member.role, 'admin');
});

test('admin resource queries require narrow repositories', () => {
  assert.throws(() => createAdminUsersQuery({ users: {} }), /users\.list is required/);
  assert.throws(() => createAdminSitesQuery({ sites: {} }), /sites\.list is required/);
  assert.throws(() => createAdminTeamsQuery({ teams: {} }), /teams\.list is required/);
});
