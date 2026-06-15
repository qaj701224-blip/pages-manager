import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTH_SESSION_COOKIE,
  SITE_SESSION_COOKIE,
  buildAuthSessionCookie,
  buildClearAuthSessionCookie,
  buildClearSiteSessionCookie,
  buildSiteSessionCookie,
  isAuthSessionHost,
  isSiteSessionHost,
} from './cookies.js';

test('builds host-only auth_session cookies without Domain', () => {
  const cookie = buildAuthSessionCookie('jwt.auth', { maxAgeSeconds: 1209600 });

  assert.match(cookie, new RegExp(`^${AUTH_SESSION_COOKIE}=jwt\\.auth;`));
  assert.match(cookie, /Secure/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  assert.match(cookie, /Path=\//);
  assert.match(cookie, /Max-Age=1209600/);
  assert.doesNotMatch(cookie, /Domain=/i);
});

test('builds host-only site_session cookies without Domain', () => {
  const cookie = buildSiteSessionCookie('jwt.site', { maxAgeSeconds: 604800 });

  assert.match(cookie, new RegExp(`^${SITE_SESSION_COOKIE}=jwt\\.site;`));
  assert.doesNotMatch(cookie, /Domain=/i);
});

test('rejects unsafe session cookie values before serialization', () => {
  const unsafeValues = [
    'ok\r\nSet-Cookie: injected=1',
    'ok; Domain=.pages.xd.team',
    'has space',
    'has"quote',
    'has,comma',
    'has\\backslash',
  ];

  for (const value of unsafeValues) {
    assert.throws(() => buildAuthSessionCookie(value, { maxAgeSeconds: 1209600 }), /Cookie value contains unsafe characters/);
  }
});

test('builds clearing cookies for host-only sessions', () => {
  assert.match(buildClearAuthSessionCookie(), new RegExp(`^${AUTH_SESSION_COOKIE}=;`));
  assert.match(buildClearAuthSessionCookie(), /Max-Age=0/);
  assert.match(buildClearSiteSessionCookie(), new RegExp(`^${SITE_SESSION_COOKIE}=;`));
  assert.match(buildClearSiteSessionCookie(), /Max-Age=0/);
});

test('validates auth host by environment', () => {
  assert.equal(isAuthSessionHost('auth.pages.xd.team', 'production'), true);
  assert.equal(isAuthSessionHost('auth-staging.pages.xd.team', 'staging'), true);
  assert.equal(isAuthSessionHost('auth.pages.xd.team', 'staging'), false);
  assert.equal(isAuthSessionHost('api.pages.xd.team', 'production'), false);
});

test('validates site session host by environment and rejects platform hosts', () => {
  assert.equal(isSiteSessionHost('demo.pages.xd.team', 'production'), true);
  assert.equal(isSiteSessionHost('demo-staging.pages.xd.team', 'staging'), true);
  assert.equal(isSiteSessionHost('demo.pages.xd.team', 'staging'), false);
  assert.equal(isSiteSessionHost('auth.pages.xd.team', 'production'), false);
  assert.equal(isSiteSessionHost('demo.workers.xd.team', 'production'), false);
});
