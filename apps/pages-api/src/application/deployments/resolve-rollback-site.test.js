import assert from 'node:assert/strict';
import test from 'node:test';

import { createRollbackSiteResolution } from './resolve-rollback-site.js';

const actor = { actorId: 'usr_1', userId: 'usr_1', type: 'user' };
const version = { id: 'ver_1', siteId: 'site_1' };
const site = { id: 'site_1', ownerType: 'user', ownerId: 'usr_1', ownerUserId: 'usr_1' };

test('rollback site resolution normalizes requested identity and returns the authorized site', async () => {
  const calls = [];
  const resolve = createRollbackSiteResolution({
    sites: {
      async getVersion(versionId, environment) {
        calls.push(['version', versionId, environment]);
        return version;
      },
      async findBySlug(environment, slug) {
        calls.push(['slug', environment, slug]);
        return site;
      },
      async getForActor(siteId, userId, receivedActor, environment) {
        calls.push(['site', siteId, userId, receivedActor, environment]);
        return site;
      },
    },
  });

  const result = await resolve({
    versionId: 'ver_1',
    environment: 'production',
    actor,
    siteId: ' site_1 ',
    siteSlug: ' Site-One ',
  });

  assert.deepEqual(result, { ok: true, site, version });
  assert.deepEqual(calls, [
    ['version', 'ver_1', 'production'],
    ['slug', 'production', 'site-one'],
    ['site', 'site_1', 'usr_1', actor, 'production'],
  ]);
});

test('rollback site resolution preserves version and requested-site failure precedence', async () => {
  const missingVersion = createRollbackSiteResolution({
    sites: { getVersion: async () => null, getForActor: async () => site },
  });
  assert.deepEqual(await missingVersion({ versionId: 'missing', environment: 'production', actor }), {
    ok: false,
    error: { code: 'VERSION_NOT_FOUND' },
  });

  let siteRead = false;
  const mismatch = createRollbackSiteResolution({
    sites: {
      getVersion: async () => version,
      getForActor: async () => {
        siteRead = true;
        return site;
      },
    },
  });
  assert.deepEqual(await mismatch({ versionId: 'ver_1', environment: 'production', actor, siteId: 'site_other' }), {
    ok: false,
    error: { code: 'ROLLBACK_SITE_MISMATCH' },
  });
  assert.equal(siteRead, false);
});

test('rollback site resolution distinguishes missing slug, mismatch, and authorization failure', async () => {
  const base = { getVersion: async () => version, getForActor: async () => site };
  const missing = createRollbackSiteResolution({ sites: { ...base, findBySlug: async () => null } });
  assert.deepEqual(await missing({ versionId: 'ver_1', environment: 'production', actor, siteSlug: 'missing' }), {
    ok: false,
    error: { code: 'SITE_NOT_FOUND' },
  });

  const mismatch = createRollbackSiteResolution({
    sites: { ...base, findBySlug: async () => ({ id: 'site_other' }) },
  });
  assert.deepEqual(await mismatch({ versionId: 'ver_1', environment: 'production', actor, siteSlug: 'other' }), {
    ok: false,
    error: { code: 'ROLLBACK_SITE_MISMATCH' },
  });

  const forbidden = createRollbackSiteResolution({
    sites: { getVersion: async () => version, getForActor: async () => ({ ...site, ownerUserId: 'usr_other' }) },
  });
  assert.deepEqual(await forbidden({ versionId: 'ver_1', environment: 'production', actor }), {
    ok: false,
    error: { code: 'ROLLBACK_FORBIDDEN' },
  });
});

test('rollback site resolution keeps legacy slug checks optional when the port is unavailable', async () => {
  const resolve = createRollbackSiteResolution({
    sites: { getVersion: async () => version, getForActor: async () => site },
  });
  assert.equal((await resolve({ versionId: 'ver_1', environment: 'production', actor, siteSlug: 'unresolved' })).ok, true);
});
