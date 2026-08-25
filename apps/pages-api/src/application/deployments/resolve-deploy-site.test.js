import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploySiteResolution } from './resolve-deploy-site.js';

const userActor = { actorId: 'usr_1', userId: 'usr_1', type: 'user' };
const personalSite = {
  id: 'site_1',
  slug: 'guide',
  ownerType: 'user',
  ownerId: 'usr_1',
  ownerUserId: 'usr_1',
  defaultVisibility: 'org',
  route: { visibility: 'internal' },
};

test('deploy site resolution loads existing sites by id or normalized transport slug', async () => {
  const calls = [];
  const resolve = createDeploySiteResolution({
    sites: {
      async getForActor(siteId, userId, actor, environment) {
        calls.push(['site', siteId, userId, actor, environment]);
        return personalSite;
      },
      async findBySlug(environment, slug) {
        calls.push(['slug', environment, slug]);
        return personalSite;
      },
      supportsOwnerTransfer: true,
    },
    prepareSite() {
      assert.fail('existing sites must not be prepared again');
    },
  });

  assert.deepEqual(
    await resolve({
      actor: userActor,
      environment: 'production',
      siteId: 'site_1',
      siteSlug: 'ignored',
      teamId: '',
      visibility: 'org',
      requestedVisibility: '',
    }),
    { ok: true, site: personalSite }
  );
  assert.deepEqual(
    await resolve({
      actor: userActor,
      environment: 'production',
      siteId: '',
      siteSlug: 'guide',
      teamId: '',
      visibility: 'org',
      requestedVisibility: '',
    }),
    { ok: true, site: personalSite }
  );
  assert.deepEqual(calls, [
    ['site', 'site_1', 'usr_1', userActor, 'production'],
    ['slug', 'production', 'guide'],
    ['site', 'site_1', 'usr_1', userActor, 'production'],
  ]);
});

test('deploy site resolution keeps id and slug visibility failures distinct', async () => {
  const resolve = createDeploySiteResolution({
    sites: {
      getForActor: async () => null,
      findBySlug: async () => personalSite,
      supportsOwnerTransfer: true,
    },
    prepareSite() {
      assert.fail('inaccessible existing sites must not be prepared');
    },
  });

  assert.deepEqual(await resolve({ actor: userActor, environment: 'production', siteId: 'missing', siteSlug: '', teamId: '' }), {
    ok: false,
    error: { code: 'SITE_NOT_FOUND_BY_ID' },
  });
  assert.deepEqual(await resolve({ actor: userActor, environment: 'production', siteId: '', siteSlug: 'guide', teamId: '' }), {
    ok: false,
    error: { code: 'SITE_NOT_FOUND_BY_SLUG_SCOPE' },
  });
});

test('owner-scoped access keys prepare personal sites without committing them', async () => {
  const prepared = [];
  const actor = {
    actorId: 'access_key:key_1',
    userId: 'usr_1',
    type: 'access_key',
    scopes: ['deploy:site'],
    ownerType: 'user',
    ownerId: 'usr_1',
  };
  const resolve = createDeploySiteResolution({
    sites: { getForActor: async () => null, findBySlug: async () => null, supportsOwnerTransfer: true },
    prepareSite(input) {
      prepared.push(input);
      return {
        id: 'site_new',
        slug: input.slug,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        ownerUserId: input.ownerUserId,
        title: input.title,
        siteUuid: 'uuid_new',
        defaultVisibility: input.visibility,
        environment: input.environment,
        routeId: 'route_new',
        hostname: 'new-guide.workers.xd.team',
      };
    },
  });

  const result = await resolve({
    actor,
    environment: 'production',
    siteId: '',
    siteSlug: 'new-guide',
    teamId: '',
    visibility: 'internal',
    requestedVisibility: 'internal',
    title: 'New guide',
  });

  assert.equal(result.ok, true);
  assert.equal(result.site.id, 'site_new');
  assert.equal(result.site.managementRole, null);
  assert.equal(result.site.pendingSiteCreation.hostname, 'new-guide.workers.xd.team');
  assert.deepEqual(prepared, [
    {
      environment: 'production',
      slug: 'new-guide',
      ownerType: 'user',
      ownerId: 'usr_1',
      ownerUserId: 'usr_1',
      visibility: 'internal',
      title: 'New guide',
    },
  ]);
  assert.equal(result.site.pendingSiteCreation.title, 'New guide');
});

test('team publishers prepare team-owned sites while viewers are rejected', async () => {
  const prepareSite = (input) => ({
    id: 'site_team',
    slug: input.slug,
    ownerType: input.ownerType,
    ownerId: input.ownerId,
    ownerUserId: input.ownerUserId,
    siteUuid: 'uuid_team',
    defaultVisibility: input.visibility,
    environment: input.environment,
    routeId: 'route_team',
    hostname: 'team-guide.workers.xd.team',
  });
  const command = {
    actor: userActor,
    environment: 'production',
    siteId: '',
    siteSlug: 'team-guide',
    teamId: 'team_1',
    visibility: 'org',
    requestedVisibility: '',
  };
  const publisher = createDeploySiteResolution({
    sites: {
      getForActor: async () => null,
      findBySlug: async () => null,
      getTeam: async () => ({ id: 'team_1', environment: 'production' }),
      getTeamMember: async () => ({ role: 'publisher' }),
      supportsOwnerTransfer: true,
    },
    prepareSite,
  });
  const accepted = await publisher(command);
  assert.equal(accepted.ok, true);
  assert.equal(accepted.site.ownerType, 'team');
  assert.equal(accepted.site.ownerId, 'team_1');
  assert.equal(accepted.site.managementRole, 'publisher');

  const viewer = createDeploySiteResolution({
    sites: {
      getForActor: async () => null,
      findBySlug: async () => null,
      getTeam: async () => ({ id: 'team_1', environment: 'production' }),
      getTeamMember: async () => ({ role: 'viewer' }),
      supportsOwnerTransfer: true,
    },
    prepareSite,
  });
  assert.deepEqual(await viewer(command), { ok: false, error: { code: 'TEAM_PUBLISHER_REQUIRED' } });
});

test('deploy site resolution prepares supported owner transfers without applying them', async () => {
  const resolve = createDeploySiteResolution({
    sites: {
      getForActor: async () => personalSite,
      getTeam: async () => ({ id: 'team_1', environment: 'production' }),
      getTeamMember: async () => ({ role: 'publisher' }),
      supportsOwnerTransfer: true,
    },
    prepareSite() {
      assert.fail('owner transfer must not create a site');
    },
  });

  const result = await resolve({
    actor: userActor,
    environment: 'production',
    siteId: 'site_1',
    siteSlug: '',
    teamId: 'team_1',
    visibility: 'disabled',
    requestedVisibility: 'disabled',
  });

  assert.equal(result.ok, true);
  assert.deepEqual(result.site.pendingOwnerTransfer, { ownerId: 'team_1', visibility: 'disabled' });
  assert.equal(result.site.ownerType, 'user');
});

test('deploy site resolution rejects unsupported transfer, owner, and visibility capabilities', async () => {
  const transferCommand = {
    actor: userActor,
    environment: 'production',
    siteId: 'site_1',
    siteSlug: '',
    teamId: 'team_1',
    visibility: 'org',
    requestedVisibility: '',
  };
  const unsupported = createDeploySiteResolution({
    sites: {
      getForActor: async () => personalSite,
      getTeam: async () => ({ id: 'team_1', environment: 'production' }),
      getTeamMember: async () => ({ role: 'publisher' }),
      supportsOwnerTransfer: false,
    },
    prepareSite() {},
  });
  assert.deepEqual(await unsupported(transferCommand), {
    ok: false,
    error: { code: 'SITE_TRANSFER_UNSUPPORTED' },
  });

  const siteScoped = createDeploySiteResolution({
    sites: { getForActor: async () => null, findBySlug: async () => null, supportsOwnerTransfer: true },
    prepareSite() {},
  });
  assert.deepEqual(
    await siteScoped({
      ...transferCommand,
      siteId: '',
      siteSlug: 'new-guide',
      teamId: '',
      actor: { type: 'access_key', userId: 'usr_1', siteId: 'site_1', scopes: ['deploy:site'] },
    }),
    { ok: false, error: { code: 'SITE_NOT_FOUND_BY_SLUG_SCOPE' } }
  );

  const teamOwnerVisibility = createDeploySiteResolution({
    sites: { getForActor: async () => null, findBySlug: async () => null, supportsOwnerTransfer: true },
    prepareSite() {},
  });
  assert.deepEqual(
    await teamOwnerVisibility({
      ...transferCommand,
      siteId: '',
      siteSlug: 'new-team',
      visibility: 'owner',
      requestedVisibility: 'owner',
      actor: {
        type: 'access_key',
        userId: 'usr_1',
        ownerType: 'team',
        ownerId: 'team_1',
        scopes: ['deploy:site'],
      },
    }),
    { ok: false, error: { code: 'TEAM_OWNER_VISIBILITY_UNSUPPORTED' } }
  );
});
