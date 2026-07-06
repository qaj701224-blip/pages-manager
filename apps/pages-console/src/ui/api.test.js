import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createAdminWebhook,
  createAccessKey,
  createTeam,
  createWorkspaceSite,
  createTeamAccessKey,
  deleteAdminSite,
  deleteAdminSiteRuntimeSecret,
  deleteAdminSiteRuntimeVar,
  deleteAdminTeam,
  deleteTeam,
  deleteSite,
  deleteSiteRuntimeSecret,
  deleteSiteRuntimeVar,
  disableAdminWebhook,
  fetchJson,
  getAdminDashboard,
  getAdminOps,
  getAdminSiteAccess,
  getAdminSiteConfig,
  grantPlatformAdmin,
  listAccessKeys,
  listAdminAuditEvents,
  listAdminSites,
  listAdminTeams,
  listAdminUsers,
  listConsoleUsers,
  listAdminWebhookDeliveries,
  listAdminWebhooks,
  listTeamAccessKeys,
  mergeAdminDepartmentTeam,
  readCsrfToken,
  removeTeamMember,
  revokeAccessKey,
  revokePlatformAdmin,
  revokeTeamAccessKey,
  putSiteRuntimeSecret,
  putSiteRuntimeVar,
  putAdminSiteRuntimeSecret,
  putAdminSiteRuntimeVar,
  updateSiteAccess,
  updateAdminSiteAccess,
  updateAdminWebhook,
  updateAdminTeamSettings,
  updateTeamMember,
  updateTeamSettings,
} from './api.js';

test('fetchJson returns JSON payload', async () => {
  const payload = await fetchJson('/api/console/directory', {
    fetchImpl: async (url, init) => {
      assert.equal(url, '/api/console/directory');
      assert.equal(init.method, 'GET');
      return Response.json({ sites: [] });
    },
  });

  assert.deepEqual(payload, { sites: [] });
});

test('fetchJson throws API error code', async () => {
  await assert.rejects(
    () =>
      fetchJson('/api/console/directory', {
        fetchImpl: async () =>
          Response.json(
            {
              error: {
                code: 'CONSOLE_AUTH_REQUIRED',
                message: 'Console authentication required.',
                action: 'Sign in and retry.',
              },
            },
            { status: 401 }
          ),
      }),
    (error) =>
      error.code === 'CONSOLE_AUTH_REQUIRED' &&
      error.status === 401 &&
      error.message === 'Console authentication required.' &&
      error.action === 'Sign in and retry.'
  );
});

test('fetchJson sends csrf header for write requests', async () => {
  const payload = await fetchJson('/api/console/auth/logout', {
    method: 'POST',
    csrfToken: 'csrf-1',
    fetchImpl: async (url, init) => {
      assert.equal(url, '/api/console/auth/logout');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['X-CSRF-Token'], 'csrf-1');
      assert.equal(init.headers['Content-Type'], 'application/json');
      return new Response(null, { status: 204 });
    },
  });

  assert.deepEqual(payload, null);
});

test('readCsrfToken reads xd_cell_csrf cookie when document is available', () => {
  const previousDocument = globalThis.document;
  globalThis.document = {
    cookie: 'theme=light; xd_cell_csrf=csrf-2; other=value',
  };

  try {
    assert.equal(readCsrfToken(), 'csrf-2');
  } finally {
    if (previousDocument === undefined) {
      delete globalThis.document;
    } else {
      globalThis.document = previousDocument;
    }
  }
});

test('admin webhook API helpers use console admin endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return Response.json(url.includes('deliveries') ? { deliveries: [] } : { webhooks: [] });
  };

  await listAdminWebhooks({ fetchImpl });
  await createAdminWebhook({ name: 'Slack' }, { fetchImpl, csrfToken: 'csrf-1' });
  await updateAdminWebhook('wh_1', { name: 'Slack updated' }, { fetchImpl, csrfToken: 'csrf-1' });
  await disableAdminWebhook('wh_1', { fetchImpl, csrfToken: 'csrf-1' });
  await listAdminWebhookDeliveries('wh_1', { fetchImpl });

  assert.deepEqual(
    calls.map((call) => [call.url, call.init.method]),
    [
      ['/api/console/admin/webhooks', 'GET'],
      ['/api/console/admin/webhooks', 'POST'],
      ['/api/console/admin/webhooks/wh_1', 'PATCH'],
      ['/api/console/admin/webhooks/wh_1', 'DELETE'],
      ['/api/console/admin/webhooks/wh_1/deliveries', 'GET'],
    ]
  );
  assert.equal(calls[1].init.headers['X-CSRF-Token'], 'csrf-1');
  assert.equal(calls[2].init.headers['X-CSRF-Token'], 'csrf-1');
  assert.equal(calls[3].init.headers['X-CSRF-Token'], 'csrf-1');
});

test('admin governance API helpers use console admin endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (url.includes('/dashboard')) return Response.json({ dashboard: {} });
    if (url.includes('/ops')) return Response.json({ ops: [] });
    if (url.includes('/users')) return Response.json({ users: [] });
    if (url.includes('/sites')) return Response.json({ sites: [] });
    if (url.includes('/audit')) return Response.json({ events: [] });
    if (url.includes('/merge')) return Response.json({ merge: {} });
    return Response.json({ teams: [] });
  };

  await getAdminDashboard({ fetchImpl });
  await getAdminOps({ fetchImpl });
  await listAdminUsers({ fetchImpl });
  await listAdminSites({ fetchImpl });
  await listAdminTeams({ fetchImpl, teamType: 'department', status: 'active' });
  await listAdminAuditEvents({ fetchImpl });
  await mergeAdminDepartmentTeam('team_source', { targetTeamId: 'team_target' }, { fetchImpl, csrfToken: 'csrf-1' });
  await grantPlatformAdmin('usr_admin', { reason: 'ops owner' }, { fetchImpl, csrfToken: 'csrf-2' });
  await revokePlatformAdmin('usr_admin', { reason: 'rotation' }, { fetchImpl, csrfToken: 'csrf-3' });

  assert.deepEqual(
    calls.map((call) => [call.url, call.init.method]),
    [
      ['/api/console/admin/dashboard', 'GET'],
      ['/api/console/admin/ops', 'GET'],
      ['/api/console/admin/users', 'GET'],
      ['/api/console/admin/sites', 'GET'],
      ['/api/console/admin/teams?teamType=department&status=active', 'GET'],
      ['/api/console/admin/audit', 'GET'],
      ['/api/console/admin/teams/team_source/merge', 'POST'],
      ['/api/console/admin/platform-admins', 'POST'],
      ['/api/console/admin/platform-admins/usr_admin', 'DELETE'],
    ]
  );
  assert.equal(calls[6].init.headers['X-CSRF-Token'], 'csrf-1');
  assert.equal(calls[7].init.headers['X-CSRF-Token'], 'csrf-2');
  assert.equal(calls[8].init.headers['X-CSRF-Token'], 'csrf-3');
  assert.deepEqual(JSON.parse(calls[7].init.body), { userId: 'usr_admin', reason: 'ops owner' });
  assert.deepEqual(JSON.parse(calls[8].init.body), { reason: 'rotation' });
});

test('admin site and team edit helpers stay under admin endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ access: {}, config: {}, team: {}, site: {}, var: {}, secret: {} });
  };

  await getAdminSiteAccess('site_1', { fetchImpl });
  await updateAdminSiteAccess('site_1', { visibility: 'acl', aclEntries: [] }, { fetchImpl, csrfToken: 'csrf-1' });
  await getAdminSiteConfig('site_1', { fetchImpl });
  await putAdminSiteRuntimeVar('site_1', 'API_BASE', 'https://api.example.test', { fetchImpl, csrfToken: 'csrf-2' });
  await deleteAdminSiteRuntimeVar('site_1', 'API_BASE', { fetchImpl, csrfToken: 'csrf-3' });
  await putAdminSiteRuntimeSecret('site_1', 'API_TOKEN', 'secret-value', { fetchImpl, csrfToken: 'csrf-4' });
  await deleteAdminSiteRuntimeSecret('site_1', 'API_TOKEN', { fetchImpl, csrfToken: 'csrf-5' });
  await deleteAdminSite('site_1', { fetchImpl, csrfToken: 'csrf-6' });
  await updateAdminTeamSettings('team_1', { name: 'Team', description: 'Admin managed' }, { fetchImpl, csrfToken: 'csrf-7' });
  await deleteAdminTeam('team_1', { fetchImpl, csrfToken: 'csrf-8' });

  assert.deepEqual(
    calls.map((call) => [call.url, call.init.method, call.init.headers['X-CSRF-Token'] || '']),
    [
      ['/api/console/admin/sites/site_1/access', 'GET', ''],
      ['/api/console/admin/sites/site_1/access', 'PATCH', 'csrf-1'],
      ['/api/console/admin/sites/site_1/config', 'GET', ''],
      ['/api/console/admin/sites/site_1/config/vars/API_BASE', 'PUT', 'csrf-2'],
      ['/api/console/admin/sites/site_1/config/vars/API_BASE', 'DELETE', 'csrf-3'],
      ['/api/console/admin/sites/site_1/config/secrets/API_TOKEN', 'PUT', 'csrf-4'],
      ['/api/console/admin/sites/site_1/config/secrets/API_TOKEN', 'DELETE', 'csrf-5'],
      ['/api/console/admin/sites/site_1', 'DELETE', 'csrf-6'],
      ['/api/console/admin/teams/team_1/settings', 'PATCH', 'csrf-7'],
      ['/api/console/admin/teams/team_1', 'DELETE', 'csrf-8'],
    ]
  );
});

test('access key API helpers use workspace and team endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ accessKeys: [], accessKey: { id: 'ak_1' } });
  };

  await listAccessKeys({ fetchImpl });
  await createAccessKey({ name: 'workspace', scopes: ['read:site'] }, { fetchImpl, csrfToken: 'csrf-1' });
  await revokeAccessKey('ak_user', { fetchImpl, csrfToken: 'csrf-2' });
  await listTeamAccessKeys('team_1', { fetchImpl });
  await createTeamAccessKey('team_1', { name: 'team', scopes: ['deploy:site'] }, { fetchImpl, csrfToken: 'csrf-3' });
  await revokeTeamAccessKey('team_1', 'ak_team', { fetchImpl, csrfToken: 'csrf-4' });

  assert.deepEqual(
    calls.map((call) => [call.url, call.init.method]),
    [
      ['/api/console/access-keys', 'GET'],
      ['/api/console/access-keys', 'POST'],
      ['/api/console/access-keys/ak_user', 'DELETE'],
      ['/api/console/teams/team_1/access-keys', 'GET'],
      ['/api/console/teams/team_1/access-keys', 'POST'],
      ['/api/console/teams/team_1/access-keys/ak_team', 'DELETE'],
    ]
  );
  assert.equal(calls[1].init.headers['X-CSRF-Token'], 'csrf-1');
  assert.equal(calls[2].init.headers['X-CSRF-Token'], 'csrf-2');
  assert.equal(calls[4].init.headers['X-CSRF-Token'], 'csrf-3');
  assert.equal(calls[5].init.headers['X-CSRF-Token'], 'csrf-4');
});

test('workspace site API helper creates site records', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ site: { id: 'site_1' } });
  };

  await createWorkspaceSite(
    { slug: 'team-console', ownerType: 'team', teamId: 'team_1', visibility: 'org' },
    { fetchImpl, csrfToken: 'csrf-1' }
  );

  assert.deepEqual(
    calls.map((call) => [call.url, call.init.method, call.init.headers['X-CSRF-Token']]),
    [['/api/console/workspace/sites', 'POST', 'csrf-1']]
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    slug: 'team-console',
    ownerType: 'team',
    teamId: 'team_1',
    visibility: 'org',
  });
});

test('site management API helpers use site access and runtime config endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ access: {}, var: {}, secret: {} });
  };

  await updateSiteAccess('site_1', { visibility: 'acl', aclEntries: [] }, { fetchImpl, csrfToken: 'csrf-1' });
  await putSiteRuntimeVar('site_1', 'API_BASE', 'https://api.example.test', { fetchImpl, csrfToken: 'csrf-2' });
  await deleteSiteRuntimeVar('site_1', 'API_BASE', { fetchImpl, csrfToken: 'csrf-3' });
  await putSiteRuntimeSecret('site_1', 'API_TOKEN', 'secret-value', { fetchImpl, csrfToken: 'csrf-4' });
  await deleteSiteRuntimeSecret('site_1', 'API_TOKEN', { fetchImpl, csrfToken: 'csrf-5' });
  await deleteSite('site_1', { fetchImpl, csrfToken: 'csrf-6' });

  assert.deepEqual(
    calls.map((call) => [call.url, call.init.method, call.init.headers['X-CSRF-Token']]),
    [
      ['/api/console/sites/site_1/access', 'PATCH', 'csrf-1'],
      ['/api/console/sites/site_1/config/vars/API_BASE', 'PUT', 'csrf-2'],
      ['/api/console/sites/site_1/config/vars/API_BASE', 'DELETE', 'csrf-3'],
      ['/api/console/sites/site_1/config/secrets/API_TOKEN', 'PUT', 'csrf-4'],
      ['/api/console/sites/site_1/config/secrets/API_TOKEN', 'DELETE', 'csrf-5'],
      ['/api/console/sites/site_1', 'DELETE', 'csrf-6'],
    ]
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), { visibility: 'acl', aclEntries: [] });
  assert.deepEqual(JSON.parse(calls[1].init.body), { value: 'https://api.example.test' });
  assert.deepEqual(JSON.parse(calls[3].init.body), { value: 'secret-value' });
});

test('team settings API helpers use workspace team endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ team: { id: 'team_1' } });
  };

  await updateTeamSettings('team_1', { name: 'Console Team', description: 'Console owners' }, { fetchImpl, csrfToken: 'csrf-1' });
  await deleteTeam('team_1', { fetchImpl, csrfToken: 'csrf-2' });

  assert.deepEqual(
    calls.map((call) => [call.url, call.init.method, call.init.headers['X-CSRF-Token']]),
    [
      ['/api/console/teams/team_1/settings', 'PATCH', 'csrf-1'],
      ['/api/console/teams/team_1', 'DELETE', 'csrf-2'],
    ]
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), { name: 'Console Team', description: 'Console owners' });
});

test('team creation API helper posts custom teams', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return Response.json({ team: { id: 'team_1' } });
  };

  await createTeam({ name: 'Console Team', description: 'Console owners' }, { fetchImpl, csrfToken: 'csrf-1' });

  assert.deepEqual(
    calls.map((call) => [call.url, call.init.method, call.init.headers['X-CSRF-Token']]),
    [['/api/console/teams', 'POST', 'csrf-1']]
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), { name: 'Console Team', description: 'Console owners' });
});

test('team member API helpers use workspace team member endpoints', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return Response.json(url.includes('/users') ? { users: [] } : { member: { teamId: 'team_1', userId: 'usr_1' } });
  };

  await updateTeamMember('team_1', 'usr_1', { role: 'publisher' }, { fetchImpl, csrfToken: 'csrf-1' });
  await removeTeamMember('team_1', 'usr_1', { fetchImpl, csrfToken: 'csrf-2' });
  await listConsoleUsers({ query: 'xutianqi', fetchImpl });

  assert.deepEqual(
    calls.map((call) => [call.url, call.init.method, call.init.headers['X-CSRF-Token']]),
    [
      ['/api/console/teams/team_1/members/usr_1', 'PATCH', 'csrf-1'],
      ['/api/console/teams/team_1/members/usr_1', 'DELETE', 'csrf-2'],
      ['/api/console/users?query=xutianqi', 'GET', undefined],
    ]
  );
  assert.deepEqual(JSON.parse(calls[0].init.body), { role: 'publisher' });
});
