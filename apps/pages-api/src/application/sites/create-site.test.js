import assert from 'node:assert/strict';
import test from 'node:test';

import { createSiteCreation } from './create-site.js';

test('site creation prepares one canonical input and returns the requested route', async () => {
  const createdInputs = [];
  const ids = { site: 0, route: 0 };
  const creation = createSiteCreation({
    siteCreation: {
      async createSite(input) {
        createdInputs.push(input);
        return { ...input, createdAt: '2027-01-15T08:00:00.000Z' };
      },
      async getRouteBySiteId(siteId, environment) {
        assert.equal(siteId, 'site_1');
        assert.equal(environment, 'production');
        return { id: 'route_1', siteId };
      },
    },
    async legacyV1Takeover() {
      assert.fail('legacy takeover must not run without the capability');
    },
    ids: { next: (prefix) => `${prefix}_${++ids[prefix]}` },
    siteUuids: { next: () => 'uuid_1' },
    hostnameForSlug: (slug) => `${slug}.workers.xd.team`,
  });

  const result = await creation.create({
    environment: 'production',
    slug: 'guide',
    ownerType: 'team',
    ownerId: 'team_1',
    ownerUserId: 'usr_1',
    visibility: 'internal',
    title: 'Product guide',
    actor: { type: 'user', userId: 'usr_1' },
    includeRoute: true,
  });

  assert.deepEqual(createdInputs, [
    {
      id: 'site_1',
      slug: 'guide',
      ownerType: 'team',
      ownerId: 'team_1',
      ownerUserId: 'usr_1',
      title: 'Product guide',
      siteUuid: 'uuid_1',
      defaultVisibility: 'internal',
      environment: 'production',
      routeId: 'route_1',
      hostname: 'guide.workers.xd.team',
    },
  ]);
  assert.equal(result.site.id, 'site_1');
  assert.deepEqual(result.route, { id: 'route_1', siteId: 'site_1' });
});

test('pending deployment creation reuses its prepared input through legacy takeover', async () => {
  const takeoverCalls = [];
  const creation = createSiteCreation({
    siteCreation: {
      async createSite() {
        assert.fail('regular create must not run when legacy takeover is enabled');
      },
      async getRouteBySiteId() {
        assert.fail('commit does not load a response projection');
      },
    },
    async legacyV1Takeover(input) {
      takeoverCalls.push(input);
      return { ...input.siteInput, createdAt: '2027-01-15T08:00:00.000Z' };
    },
    ids: { next: (prefix) => `${prefix}_prepared` },
    siteUuids: { next: () => 'uuid_prepared' },
    hostnameForSlug: (slug) => `${slug}-staging.workers.xd.team`,
  });
  const actor = { type: 'user', userId: 'usr_1' };
  const siteInput = creation.prepare({
    environment: 'staging',
    slug: 'guide',
    ownerType: 'user',
    ownerId: 'usr_1',
    ownerUserId: 'usr_1',
    visibility: 'org',
    title: 'Legacy guide',
  });

  const site = await creation.commit({ actor, siteInput, allowLegacyV1Takeover: true });

  assert.equal(site.id, 'site_prepared');
  assert.equal(siteInput.title, 'Legacy guide');
  assert.deepEqual(takeoverCalls, [{ actor, siteInput }]);
});
