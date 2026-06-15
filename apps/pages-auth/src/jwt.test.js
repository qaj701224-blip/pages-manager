import assert from 'node:assert/strict';
import test from 'node:test';

import { signSessionJwt, verifySessionJwt } from './jwt.js';

const now = 1_700_000_000;

function testEnv(overrides = {}) {
  return {
    PAGES_ENV: 'production',
    PAGES_SESSION_JWT_ACTIVE_KID: 'prod-hs-2026-06',
    PAGES_SESSION_JWT_KEYS: 'prod-hs-2026-06:HS256:PAGES_SESSION_JWT_SECRET_TEST',
    PAGES_SESSION_JWT_SECRET_TEST: 'test-session-secret',
    ...overrides,
  };
}

test('signs and verifies an auth_session token with purpose and audience binding', async () => {
  const jwt = await signSessionJwt(
    {
      purpose: 'auth_session',
      audience: 'pages-auth',
      subject: 'usr_123',
      now,
      ttlSeconds: 3600,
      claims: {
        sid: 'sid_auth',
        sessionVersion: 3,
        authTime: now,
      },
    },
    testEnv()
  );

  const verified = await verifySessionJwt(jwt, testEnv(), {
    purpose: 'auth_session',
    audience: 'pages-auth',
    now,
  });

  assert.equal(verified.iss, 'pages-auth');
  assert.equal(verified.aud, 'pages-auth');
  assert.equal(verified.env, 'production');
  assert.equal(verified.purpose, 'auth_session');
  assert.equal(verified.sub, 'usr_123');
  assert.equal(verified.sid, 'sid_auth');
  assert.equal(verified.exp, now + 3600);
});

test('rejects tampered tokens, wrong audience, wrong purpose, and wrong env', async () => {
  const jwt = await signSessionJwt(
    {
      purpose: 'site_session',
      audience: 'foo.pages.xd.team',
      subject: 'usr_123',
      now,
      ttlSeconds: 600,
      claims: { sid: 'sid_site', siteId: 'site_demo', policyVersion: 1, sessionVersion: 1 },
    },
    testEnv()
  );

  const [header, payload, signature] = jwt.split('.');
  const tampered = `${header}.${payload}.${signature.slice(0, -1)}x`;

  await assert.rejects(
    () =>
      verifySessionJwt(tampered, testEnv(), {
        purpose: 'site_session',
        audience: 'foo.pages.xd.team',
        now,
      }),
    /signature/i
  );
  await assert.rejects(
    () =>
      verifySessionJwt(jwt, testEnv(), {
        purpose: 'auth_session',
        audience: 'foo.pages.xd.team',
        now,
      }),
    /purpose/i
  );
  await assert.rejects(
    () =>
      verifySessionJwt(jwt, testEnv(), {
        purpose: 'site_session',
        audience: 'bar.pages.xd.team',
        now,
      }),
    /audience/i
  );
  await assert.rejects(
    () =>
      verifySessionJwt(jwt, testEnv({ PAGES_ENV: 'staging' }), {
        purpose: 'site_session',
        audience: 'foo.pages.xd.team',
        now,
      }),
    /environment/i
  );
});

test('rejects expired tokens and future-issued tokens', async () => {
  const expired = await signSessionJwt(
    {
      purpose: 'cli_token',
      audience: 'pages-api',
      subject: 'usr_123',
      now,
      ttlSeconds: 10,
      claims: { jti: 'cli_1' },
    },
    testEnv()
  );
  const future = await signSessionJwt(
    {
      purpose: 'cli_token',
      audience: 'pages-api',
      subject: 'usr_123',
      now: now + 120,
      ttlSeconds: 10,
      claims: { jti: 'cli_2' },
    },
    testEnv()
  );

  await assert.rejects(
    () =>
      verifySessionJwt(expired, testEnv(), {
        purpose: 'cli_token',
        audience: 'pages-api',
        now: now + 11,
      }),
    /expired/i
  );
  await assert.rejects(
    () =>
      verifySessionJwt(future, testEnv(), {
        purpose: 'cli_token',
        audience: 'pages-api',
        now,
      }),
    /iat/i
  );
});

test('rejects missing active key and duplicate key registry entries', async () => {
  await assert.rejects(
    () =>
      signSessionJwt(
        { purpose: 'auth_session', audience: 'pages-auth', subject: 'usr_123', now, ttlSeconds: 10 },
        testEnv({ PAGES_SESSION_JWT_ACTIVE_KID: '' })
      ),
    /active kid/i
  );
  await assert.rejects(
    () =>
      signSessionJwt(
        { purpose: 'auth_session', audience: 'pages-auth', subject: 'usr_123', now, ttlSeconds: 10 },
        testEnv({
          PAGES_SESSION_JWT_KEYS:
            'prod-hs-2026-06:HS256:PAGES_SESSION_JWT_SECRET_TEST,prod-hs-2026-06:HS256:PAGES_SESSION_JWT_SECRET_TEST',
        })
      ),
    /duplicate/i
  );
});

test('rejects extra claims that can rewrite reserved fields during JSON serialization', async () => {
  await assert.rejects(
    () =>
      signSessionJwt(
        {
          purpose: 'auth_session',
          audience: 'pages-auth',
          subject: 'usr_123',
          now,
          ttlSeconds: 10,
          claims: {
            sid: 'sid_auth',
            toJSON() {
              return { iss: 'evil', sid: 'sid_auth' };
            },
          },
        },
        testEnv()
      ),
    /toJSON/i
  );
});

test('rejects inherited and non-string key registry secret bindings', async () => {
  await assert.rejects(
    () =>
      signSessionJwt(
        { purpose: 'auth_session', audience: 'pages-auth', subject: 'usr_123', now, ttlSeconds: 10 },
        testEnv({
          PAGES_SESSION_JWT_KEYS: 'prod-hs-2026-06:HS256:toString',
        })
      ),
    /secret/i
  );
  await assert.rejects(
    () =>
      signSessionJwt(
        { purpose: 'auth_session', audience: 'pages-auth', subject: 'usr_123', now, ttlSeconds: 10 },
        testEnv({
          PAGES_SESSION_JWT_SECRET_TEST: { value: 'test-session-secret' },
        })
      ),
    /secret/i
  );
});
