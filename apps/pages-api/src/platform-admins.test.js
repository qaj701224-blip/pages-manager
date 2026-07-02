import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.js';
import { createTestPagesStore } from './test-store.js';

test('platform admin store grants, lists, checks, and revokes active admins', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T00:00:00.000Z' });

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
  assert.deepEqual(await store.listPlatformAdmins({ environment: 'production' }), []);

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

test('console admin API requires platform admin identity and manages platform admins', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T00:00:00.000Z' });

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
    ['usr_admin']
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
});

function env(store, overrides = {}) {
  return {
    PAGES_ENV: 'production',
    PAGES_STORE: store,
    IP_ALLOWLIST: '10.0.0.0/8',
    ...overrides,
  };
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
