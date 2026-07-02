import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAdminLoginPath, getAdminRouteAccess } from './admin-route-model.js';

test('admin route access requires authenticated platform admin session', () => {
  assert.equal(getAdminRouteAccess(null), 'login');
  assert.equal(getAdminRouteAccess({ authenticated: false, user: null }), 'login');
  assert.equal(
    getAdminRouteAccess({
      authenticated: true,
      user: { email: 'user@example.com', isPlatformAdmin: false },
    }),
    'forbidden'
  );
  assert.equal(
    getAdminRouteAccess({
      authenticated: true,
      user: { email: 'root@example.com', isPlatformAdmin: true },
    }),
    'allowed'
  );
});

test('admin login path only preserves admin return targets', () => {
  const previousLocation = globalThis.location;
  globalThis.location = { origin: 'https://workers.xd.team' };

  try {
    assert.equal(buildAdminLoginPath('/admin/users?status=active'), '/login?returnTo=%2Fadmin%2Fusers%3Fstatus%3Dactive');
    assert.equal(buildAdminLoginPath('/workspace/published'), '/login?returnTo=%2Fadmin');
    assert.equal(buildAdminLoginPath('https://evil.example.com/admin'), '/login?returnTo=%2Fadmin');
  } finally {
    if (previousLocation === undefined) {
      delete globalThis.location;
    } else {
      globalThis.location = previousLocation;
    }
  }
});
