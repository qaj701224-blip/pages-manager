import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.js';
import { createTestPagesStore } from './test-store.js';

test('platform admin store grants, lists, checks, and revokes active admins while preserving one admin', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T00:00:00.000Z' });
  await seedConsoleUser(store, 'usr_admin');
  await seedConsoleUser(store, 'usr_root');

  const granted = await store.grantPlatformAdmin({
    environment: 'production',
    userId: 'usr_admin',
    grantedByUserId: 'usr_root',
    grantReason: 'bootstrap',
  });

  assert.equal(granted.environment, 'production');
  assert.equal(granted.userId, 'usr_admin');
  assert.equal(granted.grantedByUserId, 'usr_root');
  assert.equal(granted.grantReason, 'bootstrap');
  assert.equal(granted.revokedAt, null);
  assert.equal(await store.isPlatformAdmin({ environment: 'production', userId: 'usr_admin' }), true);
  assert.equal(await store.isPlatformAdmin({ environment: 'staging', userId: 'usr_admin' }), false);
  assert.deepEqual(
    (await store.listPlatformAdmins({ environment: 'production' })).map((admin) => admin.userId),
    ['usr_admin']
  );
  await assert.rejects(
    () =>
      store.revokePlatformAdmin({
        environment: 'production',
        userId: 'usr_admin',
        revokedByUserId: 'usr_root',
        revokeReason: 'rotation',
      }),
    /PLATFORM_ADMIN_LAST_ACTIVE/
  );
  await store.grantPlatformAdmin({
    environment: 'production',
    userId: 'usr_root',
    grantedByUserId: 'usr_root',
    grantReason: 'bootstrap',
  });

  const revoked = await store.revokePlatformAdmin({
    environment: 'production',
    userId: 'usr_admin',
    revokedByUserId: 'usr_root',
    revokeReason: 'rotation',
  });

  assert.equal(revoked.revokedAt, '2026-07-01T00:00:00.000Z');
  assert.equal(revoked.revokedByUserId, 'usr_root');
  assert.equal(revoked.revokeReason, 'rotation');
  assert.equal(await store.isPlatformAdmin({ environment: 'production', userId: 'usr_admin' }), false);
  assert.deepEqual(
    (await store.listPlatformAdmins({ environment: 'production' })).map((admin) => admin.userId),
    ['usr_root']
  );

  assert.deepEqual(
    (await store.listAuditEvents()).map((event) => ({
      eventType: event.eventType,
      actorUserId: event.actorUserId,
      decision: event.decision,
      statusCode: event.statusCode,
      metadata: event.metadata,
    })),
    [
      {
        eventType: 'admin.platform_admin.grant',
        actorUserId: 'usr_root',
        decision: 'allow',
        statusCode: 200,
        metadata: {
          environment: 'production',
          targetUserId: 'usr_admin',
        },
      },
      {
        eventType: 'admin.platform_admin.grant',
        actorUserId: 'usr_root',
        decision: 'allow',
        statusCode: 200,
        metadata: {
          environment: 'production',
          targetUserId: 'usr_root',
        },
      },
      {
        eventType: 'admin.platform_admin.revoke',
        actorUserId: 'usr_root',
        decision: 'allow',
        statusCode: 200,
        metadata: {
          environment: 'production',
          targetUserId: 'usr_admin',
        },
      },
    ]
  );
});

test('platform admin revoke guard ignores non-active admin grants', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T00:00:00.000Z' });
  await store.createUser({
    userId: 'usr_root',
    email: 'root@example.com',
    employeeStatus: 'active',
  });
  await store.createUser({
    userId: 'usr_disabled',
    email: 'disabled@example.com',
    employeeStatus: 'disabled',
  });
  await store.grantPlatformAdmin({
    environment: 'production',
    userId: 'usr_root',
    grantedByUserId: 'usr_bootstrap',
    grantReason: 'bootstrap',
  });
  await store.grantPlatformAdmin({
    environment: 'production',
    userId: 'usr_disabled',
    grantedByUserId: 'usr_root',
    grantReason: 'legacy grant',
  });

  await assert.rejects(
    () =>
      store.revokePlatformAdmin({
        environment: 'production',
        userId: 'usr_root',
        revokedByUserId: 'usr_root',
        revokeReason: 'self revoke',
      }),
    /PLATFORM_ADMIN_LAST_ACTIVE/
  );

  const revoked = await store.revokePlatformAdmin({
    environment: 'production',
    userId: 'usr_disabled',
    revokedByUserId: 'usr_root',
    revokeReason: 'inactive cleanup',
  });
  assert.equal(revoked.revokedAt, '2026-07-01T00:00:00.000Z');
  assert.equal(await store.isPlatformAdmin({ environment: 'production', userId: 'usr_root' }), true);
});

test('console admin API requires platform admin identity and manages platform admins', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T00:00:00.000Z' });
  await seedConsoleUser(store, 'usr_user');
  await seedConsoleUser(store, 'usr_admin');
  await seedPlatformAdmin(store);

  const forbidden = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/platform-admins', { userId: 'usr_user' }),
    env(store)
  );
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json()).error.code, 'PLATFORM_ADMIN_REQUIRED');

  const grant = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/platform-admins', {
      userId: 'usr_root',
      admin: true,
      method: 'POST',
      body: {
        userId: 'usr_admin',
        reason: 'bootstrap',
      },
    }),
    env(store)
  );
  assert.equal(grant.status, 200, await grant.clone().text());
  assert.deepEqual(await grant.json(), {
    admin: {
      environment: 'production',
      userId: 'usr_admin',
      grantedByUserId: 'usr_root',
      grantReason: 'bootstrap',
      revokedAt: null,
      createdAt: '2026-07-01T00:00:00.000Z',
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
  });

  const list = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/platform-admins', { userId: 'usr_root', admin: true }),
    env(store)
  );
  assert.equal(list.status, 200, await list.clone().text());
  assert.deepEqual(
    (await list.json()).admins.map((admin) => admin.userId),
    ['usr_admin', 'usr_root']
  );

  const revoke = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/platform-admins/usr_admin', {
      userId: 'usr_root',
      admin: true,
      method: 'DELETE',
      body: {
        reason: 'rotation',
      },
    }),
    env(store)
  );
  assert.equal(revoke.status, 200, await revoke.clone().text());
  assert.equal((await revoke.json()).admin.revokedByUserId, 'usr_root');
  assert.equal(await store.isPlatformAdmin({ environment: 'production', userId: 'usr_admin' }), false);

  const revokeFinal = await worker.fetch(
    internalConsoleRequest('/.xd-pages/api/console/admin/platform-admins/usr_root', {
      userId: 'usr_root',
      admin: true,
      method: 'DELETE',
      body: {
        reason: 'rotation',
      },
    }),
    env(store)
  );
  assert.equal(revokeFinal.status, 409, await revokeFinal.clone().text());
  assert.equal((await revokeFinal.json()).error.code, 'PLATFORM_ADMIN_LAST_ACTIVE');
  assert.equal(await store.isPlatformAdmin({ environment: 'production', userId: 'usr_root' }), true);
});

function env(store, overrides = {}) {
  return {
    PAGES_ENV: 'production',
    PAGES_STORE: store,
    IP_ALLOWLIST: '10.0.0.0/8',
    ...overrides,
  };
}

async function seedConsoleUser(store, userId, overrides = {}) {
  if (await store.getUser(userId)) return;
  await store.createUser({
    userId,
    email: `${userId}@example.com`,
    employeeStatus: 'active',
    sessionVersion: 1,
    ...overrides,
  });
}

async function seedPlatformAdmin(store, userId = 'usr_root') {
  await seedConsoleUser(store, userId, { email: 'root@example.com' });
  await store.grantPlatformAdmin({
    environment: 'production',
    userId,
    grantedByUserId: 'usr_bootstrap',
    grantReason: 'test',
  });
}

function internalConsoleRequest(path, { userId, email = 'user@example.com', admin = false, method = 'GET', body } = {}) {
  const headers = {
    Host: 'pages-api.internal',
    'X-Console-BFF': 'pages-console',
  };
  if (userId) {
    headers['X-Console-User-Id'] = userId;
    headers['X-Console-Email'] = email;
    headers['X-Console-Admin'] = admin ? 'true' : 'false';
  }
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  return new Request(`https://pages-api.internal${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
