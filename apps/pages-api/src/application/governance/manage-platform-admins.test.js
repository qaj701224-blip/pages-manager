import assert from 'node:assert/strict';
import test from 'node:test';

import { createPlatformAdminManagement } from './manage-platform-admins.js';

test('platform admin management lists projected environment-scoped grants', async () => {
  const calls = [];
  const application = createApplication({
    list: async (input) => {
      calls.push(input);
      return [admin({ secret: 'hidden' })];
    },
  });

  const result = await application.list({ environment: 'production' });

  assert.deepEqual(calls, [{ environment: 'production' }]);
  assert.equal(result[0].userId, 'usr_target');
  assert.equal(Object.hasOwn(result[0], 'secret'), false);
});

test('platform admin grant requires an existing user and records the actor', async () => {
  const calls = [];
  const missing = createApplication({ user: null });
  const application = createApplication({
    grant: async (input) => (calls.push(input), admin(input)),
  });

  assert.equal((await missing.grant(command())).reason, 'user_not_found');
  assert.equal((await application.grant(command())).ok, true);
  assert.deepEqual(calls, [
    {
      environment: 'production',
      userId: 'usr_target',
      grantedByUserId: 'usr_actor',
      grantReason: 'rotation',
    },
  ]);
});

test('platform admin revoke preserves last-active and not-found outcomes', async () => {
  const lastActive = createApplication({
    revoke: async () => {
      throw new Error('PLATFORM_ADMIN_LAST_ACTIVE');
    },
  });
  const missing = createApplication({ revoke: async () => null });

  assert.equal((await lastActive.revoke(command())).reason, 'last_active');
  assert.equal((await missing.revoke(command())).reason, 'admin_not_found');
});

test('platform admin management requires narrow admin and user repositories', () => {
  assert.throws(() => createPlatformAdminManagement({ admins: {}, users: {} }), /admins\.list is required/);
});

function createApplication({
  user = { id: 'usr_target' },
  list = async () => [],
  grant = async (input) => admin(input),
  revoke = async (input) => admin({ ...input, revokedAt: '2026-08-21T00:00:00.000Z' }),
} = {}) {
  return createPlatformAdminManagement({
    admins: { list, grant, revoke },
    users: { get: async () => user },
  });
}

function command(overrides = {}) {
  return {
    environment: 'production',
    userId: 'usr_target',
    actorUserId: 'usr_actor',
    reason: 'rotation',
    ...overrides,
  };
}

function admin(overrides = {}) {
  return {
    environment: 'production',
    userId: 'usr_target',
    grantedByUserId: 'usr_actor',
    grantReason: 'rotation',
    revokedAt: null,
    createdAt: '2026-08-21T00:00:00.000Z',
    updatedAt: '2026-08-21T00:00:00.000Z',
    ...overrides,
  };
}
