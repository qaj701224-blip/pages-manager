import assert from 'node:assert/strict';
import test from 'node:test';

import { signSessionJwt } from '@xd/session-kit';
import { clearConsoleSessionCookie, readConsoleSession, serializeConsoleSessionCookie, signConsoleSession } from './session.js';

const now = 1_800_000_000;

function env(overrides = {}) {
  return {
    PAGES_ENV: 'production',
    PAGES_SESSION_JWT_KEYS: 'kid-test:HS256:PAGES_SESSION_JWT_SECRET_TEST',
    PAGES_SESSION_JWT_SECRET_TEST: 'test-session-secret',
    now: () => now,
    ...overrides,
  };
}

async function signedConsoleSessionToken(claims = {}, overrides = {}) {
  return signSessionJwt(
    {
      purpose: 'console_session',
      audience: overrides.audience || 'workers.xd.team',
      subject: 'user-1',
      now: overrides.now || now,
      ttlSeconds: overrides.ttlSeconds || 600,
      claims: {
        email: 'user@example.com',
        isPlatformAdmin: true,
        sessionVersion: 7,
        authTime: now - 100,
        ...claims,
      },
    },
    {
      PAGES_ENV: 'production',
      PAGES_SESSION_JWT_ACTIVE_KID: 'kid-test',
      PAGES_SESSION_JWT_KEYS: 'kid-test:HS256:PAGES_SESSION_JWT_SECRET_TEST',
      PAGES_SESSION_JWT_SECRET_TEST: 'test-session-secret',
    }
  );
}

test('session cookie is host-only and browser hardened', async () => {
  const header = serializeConsoleSessionCookie(await signedConsoleSessionToken());

  assert.match(header, /^__Host-xd_cell_session=/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.match(header, /SameSite=Lax/);
  assert.match(header, /Path=\//);
  assert.match(header, /Max-Age=604800/);
  assert.doesNotMatch(header, /Domain=/i);
});

test('valid host-bound console_session JWT cookie returns session identity', async () => {
  const header = serializeConsoleSessionCookie(await signedConsoleSessionToken());
  const cookie = header.split(';')[0];

  const session = await readConsoleSession(
    new Request('https://workers.xd.team/workspace', {
      headers: { Cookie: cookie },
    }),
    env()
  );

  assert.equal(session.userId, 'user-1');
  assert.equal(session.email, 'user@example.com');
  assert.equal(session.isPlatformAdmin, true);
  assert.equal(session.sessionVersion, 7);
  assert.equal(session.authTime, now - 100);
});

test('legacy console_session JWT without auth time remains readable', async () => {
  const header = serializeConsoleSessionCookie(await signedConsoleSessionToken({ authTime: undefined }));
  const session = await readConsoleSession(
    new Request('https://workers.xd.team/workspace', {
      headers: { Cookie: header.split(';')[0] },
    }),
    env()
  );

  assert.equal(session.userId, 'user-1');
  assert.equal(session.authTime, undefined);
});

test('console_session signer preserves compatibility when auth time is missing', async () => {
  const token = await signConsoleSession(
    { userId: 'user-1' },
    env({ PAGES_SESSION_JWT_ACTIVE_KID: 'kid-test' }),
    'workers.xd.team'
  );
  const session = await readConsoleSession(
    new Request('https://workers.xd.team/workspace', {
      headers: { Cookie: serializeConsoleSessionCookie(token).split(';')[0] },
    }),
    env()
  );

  assert.equal(session.userId, 'user-1');
  assert.equal(session.authTime, undefined);
});

test('console_session rejects invalid auth time claims', async () => {
  const header = serializeConsoleSessionCookie(await signedConsoleSessionToken({ authTime: '1800000000' }));
  const session = await readConsoleSession(
    new Request('https://workers.xd.team/workspace', {
      headers: { Cookie: header.split(';')[0] },
    }),
    env()
  );

  assert.equal(session, null);
  await assert.rejects(() => signConsoleSession({ userId: 'user-1', authTime: -1 }, env(), 'workers.xd.team'), /auth time/i);
});

test('console_session JWT is scoped to the current console host', async () => {
  const header = serializeConsoleSessionCookie(await signedConsoleSessionToken({}, { audience: 'workers.xd.team' }));
  const cookie = header.split(';')[0];

  const session = await readConsoleSession(
    new Request('https://staging.workers.xd.team/workspace', {
      headers: { Cookie: cookie },
    }),
    env({ PAGES_ENV: 'staging' })
  );

  assert.equal(session, null);
});

test('tampered JWT returns null', async () => {
  const header = serializeConsoleSessionCookie(await signedConsoleSessionToken({ isPlatformAdmin: false }));
  const cookie = `${header.split(';')[0]}bad`;

  const session = await readConsoleSession(
    new Request('https://workers.xd.team/workspace', {
      headers: { Cookie: cookie },
    }),
    env()
  );

  assert.equal(session, null);
});

test('expired console_session JWT returns null', async () => {
  const header = serializeConsoleSessionCookie(
    await signedConsoleSessionToken({ isPlatformAdmin: false }, { now: now - 700, ttlSeconds: 60 })
  );
  const cookie = header.split(';')[0];

  const session = await readConsoleSession(
    new Request('https://workers.xd.team/workspace', {
      headers: { Cookie: cookie },
    }),
    env()
  );

  assert.equal(session, null);
});

test('clear cookie expires the host-only session cookie', () => {
  const header = clearConsoleSessionCookie();

  assert.match(header, /^__Host-xd_cell_session=/);
  assert.match(header, /Max-Age=0/);
  assert.match(header, /HttpOnly/);
  assert.match(header, /Secure/);
  assert.doesNotMatch(header, /Domain=/i);
});
