import assert from 'node:assert/strict';
import test from 'node:test';

import { createRuntimeConfigMutations } from './mutations.js';

test('runtime config mutations use explicit repository, clock, and id ports', async () => {
  const calls = [];
  const service = createRuntimeConfigMutations({
    repository: {
      async mutateSiteVar(input) {
        calls.push(['var', input]);
        return { record: { name: input.name }, vars: [] };
      },
      async putSiteSecretWithAudit(input) {
        calls.push(['secret-put', input]);
        return { name: input.name };
      },
      async deleteSiteSecretWithAudit(input) {
        calls.push(['secret-delete', input]);
        return { name: input.name };
      },
    },
    sync: {
      async syncPlainText(input) {
        calls.push(['var-sync', input]);
        return { appliesTo: 'active_worker' };
      },
      async syncSecret(input) {
        calls.push(['secret-sync', input]);
      },
    },
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
    ids: { next: (prefix) => `${prefix}_fixed` },
  });
  const site = { id: 'site_1', slug: 'demo', route: { id: 'route_1' } };
  const actor = { type: 'user', userId: 'usr_1' };

  await service.mutateVar({ environment: 'production', site, actor, operation: 'put', name: 'API_BASE', value: 'x' });
  await service.putSecret({ environment: 'production', site, actor, name: 'API_TOKEN', value: 'secret' });
  await service.deleteSecret({ environment: 'production', site, actor, name: 'API_TOKEN' });

  assert.deepEqual(calls, [
    [
      'var',
      {
        environment: 'production',
        siteId: 'site_1',
        operation: 'put',
        name: 'API_BASE',
        value: 'x',
        actorId: 'usr_1',
        updatedAt: '2027-01-15T08:00:00.000Z',
      },
    ],
    [
      'var-sync',
      {
        site,
        snapshot: { record: { name: 'API_BASE' }, vars: [] },
      },
    ],
    [
      'secret-put',
      {
        id: 'sec_fixed',
        environment: 'production',
        siteId: 'site_1',
        siteSlug: 'demo',
        name: 'API_TOKEN',
        value: 'secret',
        actorId: 'usr_1',
        actorType: 'user',
        routeId: 'route_1',
        auditId: 'aud_fixed',
        updatedAt: '2027-01-15T08:00:00.000Z',
      },
    ],
    [
      'secret-sync',
      {
        site,
        mutation: { operation: 'put', name: 'API_TOKEN', value: 'secret' },
      },
    ],
    [
      'secret-delete',
      {
        environment: 'production',
        siteId: 'site_1',
        siteSlug: 'demo',
        name: 'API_TOKEN',
        actorId: 'usr_1',
        actorType: 'user',
        routeId: 'route_1',
        auditId: 'aud_fixed',
        deletedAt: '2027-01-15T08:00:00.000Z',
      },
    ],
    [
      'secret-sync',
      {
        site,
        mutation: { operation: 'delete', name: 'API_TOKEN' },
      },
    ],
  ]);
});

test('runtime config mutations fail with a stable capability code when a narrow port is absent', async () => {
  const service = createRuntimeConfigMutations({
    repository: {},
    sync: {},
    clock: { now: () => '2027-01-15T08:00:00.000Z' },
    ids: { next: (prefix) => `${prefix}_fixed` },
  });

  await assert.rejects(
    service.mutateVar({
      environment: 'production',
      site: { id: 'site_1' },
      actor: { userId: 'usr_1' },
      operation: 'delete',
      name: 'API_BASE',
    }),
    (error) => error.code === 'RUNTIME_CONFIG_UNSUPPORTED'
  );
});
