import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actorCanDeploySite,
  actorCanManageSite,
  actorCanTransferSiteOwnership,
  actorCanReadSite,
  actorCanReadSitesApi,
  viewerCanAdminSite,
  viewerCanPublishSite,
} from './authorization.js';

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
