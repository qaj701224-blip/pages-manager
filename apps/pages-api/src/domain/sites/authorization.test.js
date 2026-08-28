import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actorCanDeploySite,
  actorCanManageSite,
  actorCanReadPublicSites,
  actorCanTransferSiteOwnership,
  actorCanReadSite,
  actorCanReadSitesApi,
  viewerCanAdminSite,
  viewerCanPublishSite,
} from './authorization.js';

test('public sites capability requires a user-backed directory reader', () => {
  const cases = [
    {
      name: 'CLI user actor',
      actor: { type: 'user', userId: 'usr_1' },
      expected: true,
    },
    {
      name: 'Cindy-like personal access key',
      actor: {
        type: 'access_key',
        userId: 'usr_1',
        ownerType: 'user',
        siteId: null,
        scopes: ['read:site'],
        source: 'cindy_connection',
      },
      expected: true,
    },
    {
      name: 'unscoped personal read key',
      actor: { type: 'access_key', userId: 'usr_1', scopes: ['read:site'] },
      expected: true,
    },
    {
      name: 'unscoped personal wildcard key',
      actor: { type: 'access_key', userId: 'usr_1', ownerType: 'user', scopes: ['*'] },
      expected: true,
    },
    {
      name: 'personal key with null owner type',
      actor: { type: 'access_key', userId: 'usr_1', ownerType: null, scopes: ['read:site'] },
      expected: true,
    },
    {
      name: 'deploy-only key',
      actor: { type: 'access_key', userId: 'usr_1', scopes: ['deploy:site'] },
      expected: false,
    },
    {
      name: 'team-owned key',
      actor: { type: 'access_key', userId: 'usr_1', ownerType: 'team', scopes: ['read:site'] },
      expected: false,
    },
    {
      name: 'key with unknown owner type',
      actor: { type: 'access_key', userId: 'usr_1', ownerType: 'organization', scopes: ['read:site'] },
      expected: false,
    },
    {
      name: 'key with empty owner type',
      actor: { type: 'access_key', userId: 'usr_1', ownerType: '', scopes: ['read:site'] },
      expected: false,
    },
    {
      name: 'site-scoped key',
      actor: { type: 'access_key', userId: 'usr_1', siteId: 'site_1', scopes: ['read:site'] },
      expected: false,
    },
    ...['', 0, false].map((siteId) => ({
      name: `key with malformed falsey siteId ${JSON.stringify(siteId)}`,
      actor: { type: 'access_key', userId: 'usr_1', siteId, scopes: ['read:site'] },
      expected: false,
    })),
    {
      name: 'unknown actor type',
      actor: { type: 'service', userId: 'usr_1' },
      expected: false,
    },
    {
      name: 'missing actor type',
      actor: { userId: 'usr_1' },
      expected: false,
    },
    {
      name: 'actor without userId',
      actor: { type: 'user' },
      expected: false,
    },
    {
      name: 'actor with blank userId',
      actor: { type: 'user', userId: '  ' },
      expected: false,
    },
    {
      name: 'unknown actor',
      actor: undefined,
      expected: false,
    },
    {
      name: 'null actor',
      actor: null,
      expected: false,
    },
  ];

  for (const { name, actor, expected } of cases) {
    assert.equal(actorCanReadPublicSites(actor), expected, name);
  }
});

test('site management respects owner, team role, scope, and site boundaries', () => {
  const personal = { id: 'site_1', ownerType: 'user', ownerId: 'usr_1', ownerUserId: 'usr_1' };
  const team = { id: 'site_2', ownerType: 'team', ownerId: 'team_1', managementRole: 'publisher' };

  assert.equal(actorCanManageSite({ type: 'user', userId: 'usr_1' }, personal), true);
  assert.equal(actorCanManageSite({ type: 'user', userId: 'usr_2' }, personal), false);
  assert.equal(actorCanManageSite({ type: 'user', userId: 'usr_2' }, team), true);
  assert.equal(
    actorCanManageSite({ type: 'access_key', userId: 'usr_1', siteId: 'site_other', scopes: ['deploy:site'] }, personal),
    false
  );
  assert.equal(actorCanManageSite({ type: 'access_key', userId: 'usr_1', scopes: ['read:site'] }, personal), false);
});

test('deployment and read capabilities preserve their endpoint-specific scope rules', () => {
  const personal = { id: 'site_1', ownerType: 'user', ownerId: 'usr_1', ownerUserId: 'usr_1' };
  const deployKey = { type: 'access_key', userId: 'usr_1', scopes: ['deploy:site'] };
  const readKey = { type: 'access_key', userId: 'usr_1', scopes: ['read:site'] };

  assert.equal(actorCanDeploySite(deployKey, personal, 'deploy:site'), true);
  assert.equal(actorCanDeploySite({ ...deployKey, scopes: ['*'] }, personal, 'deploy:site'), false);
  assert.equal(actorCanReadSite(readKey, personal), true);
  assert.equal(actorCanReadSite(deployKey, personal), false);
  assert.equal(actorCanReadSitesApi(deployKey, 'site_1'), true);
  assert.equal(actorCanReadSitesApi({ ...deployKey, siteId: 'site_2' }, 'site_1'), false);
});

test('console viewer roles distinguish publisher and admin authority', () => {
  assert.equal(viewerCanPublishSite({ ownerType: 'team', managementRole: 'publisher' }), true);
  assert.equal(viewerCanAdminSite({ ownerType: 'team', managementRole: 'publisher' }), false);
  assert.equal(viewerCanAdminSite({ ownerType: 'team', managementRole: 'admin' }), true);
  assert.equal(viewerCanPublishSite({ ownerType: 'user', ownerId: 'usr_1', currentUserId: 'usr_1' }), true);
});

test('ownership transfer requires the personal owner or source team admin and rejects team access tokens', () => {
  const personal = { id: 'site_1', ownerType: 'user', ownerId: 'usr_1', ownerUserId: 'usr_1' };
  const teamAdmin = { id: 'site_2', ownerType: 'team', ownerId: 'team_1', managementRole: 'admin' };
  const teamPublisher = { ...teamAdmin, managementRole: 'publisher' };

  assert.equal(actorCanTransferSiteOwnership({ type: 'user', userId: 'usr_1' }, personal), true);
  assert.equal(actorCanTransferSiteOwnership({ type: 'user', userId: 'usr_2' }, personal), false);
  assert.equal(actorCanTransferSiteOwnership({ type: 'user', userId: 'usr_1' }, teamAdmin), true);
  assert.equal(actorCanTransferSiteOwnership({ type: 'user', userId: 'usr_1' }, teamPublisher), false);
  assert.equal(
    actorCanTransferSiteOwnership(
      { type: 'access_key', ownerType: 'user', ownerId: 'usr_1', userId: 'usr_1', scopes: ['deploy:site'] },
      teamAdmin
    ),
    true
  );
  assert.equal(
    actorCanTransferSiteOwnership(
      { type: 'access_key', ownerType: 'team', ownerId: 'team_1', scopes: ['deploy:site'] },
      teamAdmin
    ),
    false
  );
});
