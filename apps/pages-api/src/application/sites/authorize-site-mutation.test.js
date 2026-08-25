import assert from 'node:assert/strict';
import test from 'node:test';

import { authorizeSiteMutation } from './authorize-site-mutation.js';

test('site mutation authorization uses current team membership', async () => {
  const actor = { type: 'user', userId: 'usr_1' };
  const site = { id: 'site_1', environment: 'production', ownerType: 'team', ownerId: 'team_1' };

  await assert.rejects(
    authorizeSiteMutation({
      sites: authorizationPort({
        getSiteForUser: async () => ({ ...site, managementRole: 'viewer' }),
      }),
      environment: 'production',
      siteId: site.id,
      actor,
      now: '2027-01-15T08:00:00.000Z',
    }),
    (error) => error.code === 'SITE_NOT_FOUND'
  );
});

test('site mutation authorization rejects an inactive team owner after reading the site', async () => {
  const calls = [];
  const site = {
    id: 'site_1',
    environment: 'production',
    ownerType: 'team',
    ownerId: 'team_1',
    managementRole: 'publisher',
  };

  await assert.rejects(
    authorizeSiteMutation({
      sites: authorizationPort({
        getSiteForUser: async () => {
          calls.push('site');
          return site;
        },
        getTeam: async () => {
          calls.push('team');
          return null;
        },
      }),
      environment: 'production',
      siteId: site.id,
      actor: { type: 'user', userId: 'usr_1' },
      now: '2027-01-15T08:00:00.000Z',
    }),
    (error) => error.code === 'SITE_NOT_FOUND'
  );
  assert.deepEqual(calls, ['site', 'team']);
});

test('site mutation authorization rebuilds access-key scope and binding from the current record', async () => {
  const seen = [];
  const actor = {
    type: 'access_key',
    tokenId: 'ak_1',
    userId: 'usr_1',
    ownerType: 'user',
    ownerId: 'usr_1',
    scopes: ['deploy:site'],
    siteId: 'site_1',
  };

  await assert.rejects(
    authorizeSiteMutation({
      sites: authorizationPort({
        getAccessKeyById: async () => ({
          id: 'ak_1',
          ownerType: 'user',
          ownerId: 'usr_1',
          ownerUserId: 'usr_1',
          scopes: ['read:site'],
          siteId: 'site_2',
        }),
        getSiteForUser: async (_siteId, _userId, currentActor) => {
          seen.push(currentActor);
          return {
            id: 'site_1',
            environment: 'production',
            ownerType: 'user',
            ownerId: 'usr_1',
          };
        },
      }),
      environment: 'production',
      siteId: 'site_1',
      actor,
      now: '2027-01-15T08:00:00.000Z',
    }),
    (error) => error.code === 'SITE_NOT_FOUND'
  );
  assert.deepEqual(seen[0].scopes, ['read:site']);
  assert.equal(seen[0].siteId, 'site_2');
});

test('site mutation authorization rejects a revoked access key before reading the site', async () => {
  let siteRead = false;
  await assert.rejects(
    authorizeSiteMutation({
      sites: authorizationPort({
        getAccessKeyById: async () => ({
          id: 'ak_1',
          ownerType: 'user',
          ownerId: 'usr_1',
          scopes: ['deploy:site'],
          revokedAt: '2027-01-15T07:59:00.000Z',
        }),
        getSiteForUser: async () => {
          siteRead = true;
        },
      }),
      environment: 'production',
      siteId: 'site_1',
      actor: { type: 'access_key', tokenId: 'ak_1' },
      now: '2027-01-15T08:00:00.000Z',
    }),
    (error) => error.code === 'SITE_NOT_FOUND'
  );
  assert.equal(siteRead, false);
});

test('site mutation authorization rejects an access key whose personal owner is inactive', async () => {
  let siteRead = false;
  await assert.rejects(
    authorizeSiteMutation({
      sites: authorizationPort({
        getAccessKeyById: async () => ({
          id: 'ak_1',
          ownerType: 'user',
          ownerId: 'usr_1',
          scopes: ['deploy:site'],
        }),
        getUser: async () => ({ id: 'usr_1', employeeStatus: 'inactive' }),
        getSiteForUser: async () => {
          siteRead = true;
        },
      }),
      environment: 'production',
      siteId: 'site_1',
      actor: { type: 'access_key', tokenId: 'ak_1' },
      now: '2027-01-15T08:00:00.000Z',
    }),
    (error) => error.code === 'SITE_NOT_FOUND'
  );
  assert.equal(siteRead, false);
});

test('site mutation authorization rejects an access key whose team owner is not currently active', async () => {
  for (const team of [
    null,
    { id: 'team_1', environment: 'staging', status: 'active', deletedAt: null },
    { id: 'team_1', environment: 'production', status: 'inactive', deletedAt: null },
    { id: 'team_1', environment: 'production', status: 'active', deletedAt: '2027-01-15T07:59:00.000Z' },
  ]) {
    let siteRead = false;
    await assert.rejects(
      authorizeSiteMutation({
        sites: authorizationPort({
          getAccessKeyById: async () => ({
            id: 'ak_team_1',
            ownerType: 'team',
            ownerId: 'team_1',
            ownerUserId: 'usr_creator',
            scopes: ['deploy:site'],
          }),
          getTeam: async () => team,
          getSiteForUser: async () => {
            siteRead = true;
          },
        }),
        environment: 'production',
        siteId: 'site_1',
        actor: { type: 'access_key', tokenId: 'ak_team_1' },
        now: '2027-01-15T08:00:00.000Z',
      }),
      (error) => error.code === 'SITE_NOT_FOUND'
    );
    assert.equal(siteRead, false);
  }
});

test('site mutation authorization rechecks cli-login revocation and session version', async () => {
  for (const accessKey of [
    {
      id: 'ak_cli_1',
      ownerType: 'user',
      ownerId: 'usr_1',
      issuedSource: 'cli_login',
      issuedSessionVersion: 3,
      revokedAt: '2027-01-15T07:59:00.000Z',
    },
    {
      id: 'ak_cli_1',
      ownerType: 'user',
      ownerId: 'usr_1',
      issuedSource: 'cli_login',
      issuedSessionVersion: 2,
      revokedAt: null,
    },
  ]) {
    await assert.rejects(
      authorizeSiteMutation({
        sites: authorizationPort({
          getAccessKeyById: async () => accessKey,
          getUser: async () => ({ id: 'usr_1', employeeStatus: 'active', sessionVersion: 3 }),
        }),
        environment: 'production',
        siteId: 'site_1',
        actor: { type: 'user', userId: 'usr_1', tokenId: 'ak_cli_1', source: 'cli' },
        now: '2027-01-15T08:00:00.000Z',
      }),
      (error) => error.code === 'SITE_NOT_FOUND'
    );
  }
});

test('platform admin capability explicitly bypasses owner and inactive-team authorization', async () => {
  const site = { id: 'site_1', environment: 'production', ownerType: 'team', ownerId: 'team_orphaned' };
  const result = await authorizeSiteMutation({
    sites: authorizationPort({
      getSite: async () => site,
      getSiteForUser: async () => assert.fail('platform admins must not use user ownership lookup'),
      getTeam: async () => assert.fail('platform admins must retain repair access to orphaned team sites'),
      isPlatformAdmin: async () => true,
    }),
    environment: 'production',
    siteId: site.id,
    actor: { type: 'user', userId: 'usr_admin' },
    capability: 'platform_admin',
    now: '2027-01-15T08:00:00.000Z',
  });

  assert.equal(result.site, site);
});

function authorizationPort(overrides = {}) {
  return {
    async getSite() {
      return null;
    },
    async getSiteForUser() {
      return null;
    },
    async getAccessKeyById() {
      return null;
    },
    async getUser(userId) {
      return { id: userId, employeeStatus: 'active' };
    },
    async getTeam(teamId) {
      return { id: teamId, environment: 'production', status: 'active', deletedAt: null };
    },
    async isPlatformAdmin() {
      return false;
    },
    ...overrides,
  };
}
