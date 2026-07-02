import assert from 'node:assert/strict';
import test from 'node:test';

import { signSessionJwt, verifySessionJwt } from './jwt.js';

const now = 1_700_000_000;
const encoder = new globalThis.TextEncoder();

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

test('signs and verifies local auth_session tokens for local SSO development', async () => {
  const jwt = await signSessionJwt(
    {
      purpose: 'auth_session',
      audience: 'pages-auth-local',
      subject: 'usr_123',
      now,
      ttlSeconds: 3600,
      claims: {
        sid: 'sid_auth',
      },
    },
    testEnv({ PAGES_ENV: 'local' })
  );

  const verified = await verifySessionJwt(jwt, testEnv({ PAGES_ENV: 'local' }), {
    purpose: 'auth_session',
    audience: 'pages-auth-local',
    now,
  });

  assert.equal(verified.env, 'local');
  assert.equal(verified.sid, 'sid_auth');
});

test('signs and verifies a console_session token with purpose and audience binding', async () => {
  const jwt = await signSessionJwt(
    {
      purpose: 'console_session',
      audience: 'xd-cell-console',
      subject: 'usr_console',
      now,
      ttlSeconds: 12 * 60 * 60,
      claims: {
        email: 'console@example.com',
        employeeStatus: 'active',
        isPlatformAdmin: true,
        sessionVersion: 4,
      },
    },
    testEnv()
  );

  const verified = await verifySessionJwt(jwt, testEnv(), {
    purpose: 'console_session',
    audience: 'xd-cell-console',
    now,
  });

  assert.equal(verified.iss, 'pages-auth');
  assert.equal(verified.aud, 'xd-cell-console');
  assert.equal(verified.purpose, 'console_session');
  assert.equal(verified.sub, 'usr_console');
  assert.equal(verified.email, 'console@example.com');
  assert.equal(verified.isPlatformAdmin, true);
  assert.equal(verified.sessionVersion, 4);
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

test('rejects unsupported session JWT purposes', async () => {
  await assert.rejects(
    () =>
      signSessionJwt(
        {
          purpose: 'admin_session',
          audience: 'pages-auth',
          subject: 'usr_123',
          now,
          ttlSeconds: 10,
        },
        testEnv()
      ),
    /purpose/i
  );

  const token = await signRawJwt({
    iss: 'pages-auth',
    aud: 'pages-auth',
    env: 'production',
    purpose: 'admin_session',
    sub: 'usr_123',
    iat: now,
    nbf: now,
    exp: now + 10,
  });

  await assert.rejects(
    () =>
      verifySessionJwt(token, testEnv(), {
        purpose: 'admin_session',
        audience: 'pages-auth',
        now,
      }),
    /purpose/i
  );
});

test('requires cli_token JWT IDs and rejects malformed jti values', async () => {
  await assert.rejects(
    () =>
      signSessionJwt(
        {
          purpose: 'cli_token',
          audience: 'pages-api',
          subject: 'usr_123',
          now,
          ttlSeconds: 10,
        },
        testEnv()
      ),
    /jti/i
  );
  await assert.rejects(
    () =>
      signSessionJwt(
        {
          purpose: 'cli_token',
          audience: 'pages-api',
          subject: 'usr_123',
          now,
          ttlSeconds: 10,
          claims: { jti: 'bad jti' },
        },
        testEnv()
      ),
    /jti/i
  );

  const missingJti = await signRawJwt({
    iss: 'pages-auth',
    aud: 'pages-api',
    env: 'production',
    purpose: 'cli_token',
    sub: 'usr_123',
    iat: now,
    nbf: now,
    exp: now + 10,
  });
  const malformedJti = await signRawJwt({
    iss: 'pages-auth',
    aud: 'pages-api',
    env: 'production',
    purpose: 'cli_token',
    sub: 'usr_123',
    iat: now,
    nbf: now,
    exp: now + 10,
    jti: '',
  });

  await assert.rejects(
    () =>
      verifySessionJwt(missingJti, testEnv(), {
        purpose: 'cli_token',
        audience: 'pages-api',
        now,
      }),
    /jti/i
  );
  await assert.rejects(
    () =>
      verifySessionJwt(malformedJti, testEnv(), {
        purpose: 'cli_token',
        audience: 'pages-api',
        now,
      }),
    /jti/i
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

async function signRawJwt(payload, env = testEnv()) {
  const header = { alg: 'HS256', typ: 'JWT', kid: env.PAGES_SESSION_JWT_ACTIVE_KID };
  const signingInput = `${base64UrlEncodeJson(header)}.${base64UrlEncodeJson(payload)}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.PAGES_SESSION_JWT_SECRET_TEST),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));
  return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
}

function base64UrlEncodeJson(value) {
  return base64UrlEncodeBytes(encoder.encode(JSON.stringify(value)));
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
