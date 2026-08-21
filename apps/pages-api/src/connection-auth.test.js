import assert from 'node:assert/strict';
import test from 'node:test';

import { handleAccessKeysApi } from './access-keys.js';
import { authenticateApiRequest } from './auth.js';
import { createConnectionJwksCache } from './connection-assertion.js';
import { createTestPagesStore } from '../test-support/pages-store-fixture.js';
import { handleWhoamiApi } from './whoami.js';

const ISSUER = 'https://auth-dev.cindy.test';
const AUDIENCE = 'xd:xd-sites';
const NOW_ISO = '2026-08-04T04:00:00.000Z';
const NOW_SECONDS = Math.floor(Date.parse(NOW_ISO) / 1000);
const CONFIG = { environment: 'staging' };

const encoder = new globalThis.TextEncoder();

let signingKey;
async function testSigningKey() {
  if (!signingKey) {
    const { publicKey, privateKey } = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify']
    );
    const exported = await crypto.subtle.exportKey('jwk', publicKey);
    signingKey = { privateKey, jwk: { kty: 'RSA', kid: 'kid_test', use: 'sig', alg: 'RS256', n: exported.n, e: exported.e } };
  }
  return signingKey;
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeSegment(value) {
  return base64UrlEncode(encoder.encode(JSON.stringify(value)));
}

async function signAssertion(overrides = {}) {
  const { privateKey } = await testSigningKey();
  const headerSegment = encodeSegment({ alg: 'RS256', kid: 'kid_test' });
  const payloadSegment = encodeSegment({
    iss: ISSUER,
    aud: AUDIENCE,
    typ: 'connection',
    sub: 'mem_1',
    ctx: 'org',
    orgSlug: 'xd',
    email: 'someone@xd.com',
    iat: NOW_SECONDS - 60,
    exp: NOW_SECONDS + 1740,
    jti: 'jti_1',
    ...overrides,
  });
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, privateKey, encoder.encode(`${headerSegment}.${payloadSegment}`))
  );
  return `${headerSegment}.${payloadSegment}.${base64UrlEncode(signature)}`;
}

async function connectionEnv(overrides = {}) {
  const { jwk } = await testSigningKey();
  let counter = 0;
  return {
    CINDY_CONNECTION_ISSUERS: ISSUER,
    CINDY_CONNECTION_AUDIENCE: AUDIENCE,
    connectionJwksFetch: async () => ({ ok: true, json: async () => ({ keys: [jwk] }) }),
    connectionJwksCache: createConnectionJwksCache(),
    now: () => NOW_ISO,
    nextId: (prefix) => `${prefix}_${(counter += 1)}`,
    ...overrides,
  };
}

function bearerRequest(token, { method = 'GET', pathname = '/.xd-pages/api/sites' } = {}) {
  return new Request(`https://api-staging.pages.xd.team${pathname}`, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
}

test('authenticates a connection assertion for a user already mapped by membership id', async () => {
  const store = createTestPagesStore({ now: () => NOW_ISO });
  await store.createUser({
    userId: 'usr_mapped',
    email: 'mapped@xd.com',
    realname: 'Mapped User',
    employeeStatus: 'active',
    cindyMembershipId: 'mem_1',
  });

  const auth = await authenticateApiRequest(
    bearerRequest(await signAssertion({ email: 'drifted@xd.com' })),
    await connectionEnv(),
    store,
    CONFIG,
    NOW_ISO
  );

  assert.equal(auth.ok, true);
  assert.deepEqual(auth.actor, {
    type: 'access_key',
    actorId: 'usr_mapped',
    userId: 'usr_mapped',
    email: 'mapped@xd.com',
    name: 'Mapped User',
    tokenId: null,
    ownerType: 'user',
    ownerId: 'usr_mapped',
    scopes: ['deploy:site', 'read:site', 'rollback:site'],
    siteId: null,
    source: 'cindy_connection',
  });
});

test('binds the membership id to an existing user by email on first contact', async () => {
  const store = createTestPagesStore({ now: () => NOW_ISO });
  await store.createUser({
    userId: 'usr_email',
    email: 'someone@xd.com',
    realname: 'Existing User',
    employeeStatus: 'active',
  });

  const auth = await authenticateApiRequest(
    bearerRequest(await signAssertion()),
    await connectionEnv(),
    store,
    CONFIG,
    NOW_ISO
  );

  assert.equal(auth.ok, true);
  assert.equal(auth.actor.userId, 'usr_email');
  assert.equal((await store.getUser('usr_email')).cindyMembershipId, 'mem_1');

  const linkEvents = (await store.listAuditEvents({ environment: 'staging' })).filter(
    (event) => event.eventType === 'connection.user.link'
  );
  assert.equal(linkEvents.length, 1);
  assert.equal(linkEvents[0].actorType, 'connection');
  assert.equal(linkEvents[0].metadata.membershipId, 'mem_1');
  assert.equal(linkEvents[0].metadata.jti, 'jti_1');
  assert.equal(linkEvents[0].metadata.issuer, ISSUER);
  assert.equal(linkEvents[0].metadata.email, 'someone@xd.com');
  assert.equal(linkEvents[0].metadata.orgSlug, 'xd');
  assert.equal(linkEvents[0].metadata.audience, AUDIENCE);
  assert.equal(linkEvents[0].metadata.assertionIssuedAt, new Date((NOW_SECONDS - 60) * 1000).toISOString());
  assert.equal(linkEvents[0].metadata.assertionExpiresAt, new Date((NOW_SECONDS + 1740) * 1000).toISOString());
});

test('creates a new user keyed on the membership id and reuses it on the next request', async () => {
  const store = createTestPagesStore({ now: () => NOW_ISO });
  const env = await connectionEnv();

  const first = await authenticateApiRequest(bearerRequest(await signAssertion()), env, store, CONFIG, NOW_ISO);
  assert.equal(first.ok, true);

  const created = await store.getUserByCindyMembershipId('mem_1');
  assert.equal(created.email, 'someone@xd.com');
  assert.equal(created.createdSource, 'cindy');
  assert.equal(created.employeeStatus, 'active');
  assert.equal(created.realname, null);
  assert.equal(first.actor.userId, created.id);

  const second = await authenticateApiRequest(bearerRequest(await signAssertion()), env, store, CONFIG, NOW_ISO);
  assert.equal(second.ok, true);
  assert.equal(second.actor.userId, created.id);

  const createEvents = (await store.listAuditEvents({ environment: 'staging' })).filter(
    (event) => event.eventType === 'connection.user.create'
  );
  assert.equal(createEvents.length, 1);
  assert.equal(createEvents[0].metadata.membershipId, 'mem_1');
});

test('rejects an email already bound to a different membership id', async () => {
  const store = createTestPagesStore({ now: () => NOW_ISO });
  await store.createUser({
    userId: 'usr_other',
    email: 'someone@xd.com',
    employeeStatus: 'active',
    cindyMembershipId: 'mem_other',
  });

  const auth = await authenticateApiRequest(
    bearerRequest(await signAssertion()),
    await connectionEnv(),
    store,
    CONFIG,
    NOW_ISO
  );

  assert.equal(auth.ok, false);
  assert.equal(auth.error.code, 'CONNECTION_IDENTITY_CONFLICT');
  assert.equal(auth.error.status, 409);

  const denyEvents = (await store.listAuditEvents({ environment: 'staging' })).filter(
    (event) => event.eventType === 'connection.request.deny'
  );
  assert.equal(denyEvents.length, 1);
  assert.equal(denyEvents[0].decision, 'deny');
  assert.equal(denyEvents[0].statusCode, 409);
  assert.equal(denyEvents[0].metadata.reason, 'CONNECTION_IDENTITY_CONFLICT');
  assert.equal(denyEvents[0].metadata.membershipId, 'mem_1');
  assert.equal(denyEvents[0].metadata.email, 'someone@xd.com');
  assert.equal(denyEvents[0].metadata.jti, 'jti_1');
});

test('rejects inactive users without binding the membership id', async () => {
  const store = createTestPagesStore({ now: () => NOW_ISO });
  await store.createUser({
    userId: 'usr_left',
    email: 'someone@xd.com',
    employeeStatus: 'left',
  });

  const byEmail = await authenticateApiRequest(
    bearerRequest(await signAssertion()),
    await connectionEnv(),
    store,
    CONFIG,
    NOW_ISO
  );
  assert.equal(byEmail.ok, false);
  assert.equal(byEmail.error.code, 'PAGES_USER_INACTIVE');
  assert.equal(byEmail.error.status, 403);
  assert.equal((await store.getUser('usr_left')).cindyMembershipId, null);

  const inactiveDenies = (await store.listAuditEvents({ environment: 'staging' })).filter(
    (event) => event.eventType === 'connection.request.deny' && event.metadata.reason === 'PAGES_USER_INACTIVE'
  );
  assert.equal(inactiveDenies.length, 1);
  assert.equal(inactiveDenies[0].statusCode, 403);

  await store.createUser({
    userId: 'usr_disabled',
    email: 'disabled@xd.com',
    employeeStatus: 'disabled',
    cindyMembershipId: 'mem_disabled',
  });
  const byMembership = await authenticateApiRequest(
    bearerRequest(await signAssertion({ sub: 'mem_disabled', email: 'disabled@xd.com', jti: 'jti_2' })),
    await connectionEnv(),
    store,
    CONFIG,
    NOW_ISO
  );
  assert.equal(byMembership.ok, false);
  assert.equal(byMembership.error.code, 'PAGES_USER_INACTIVE');
});

test('keeps the legacy CLI token rejection for JWT bearers when connection auth is not configured', async () => {
  const store = createTestPagesStore({ now: () => NOW_ISO });
  const env = await connectionEnv({ CINDY_CONNECTION_ISSUERS: undefined, CINDY_CONNECTION_AUDIENCE: undefined });

  const auth = await authenticateApiRequest(bearerRequest(await signAssertion()), env, store, CONFIG, NOW_ISO);

  assert.equal(auth.ok, false);
  assert.equal(auth.error.code, 'CLI_TOKEN_INVALID');
  assert.equal(auth.error.status, 401);
});

test('maps verification failures to 401 and JWKS outages to 503', async () => {
  const store = createTestPagesStore({ now: () => NOW_ISO });

  const expired = await authenticateApiRequest(
    bearerRequest(await signAssertion({ exp: NOW_SECONDS - 3600 })),
    await connectionEnv(),
    store,
    CONFIG,
    NOW_ISO
  );
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, 'CONNECTION_ASSERTION_INVALID');
  assert.equal(expired.error.status, 401);

  const outage = await authenticateApiRequest(
    bearerRequest(await signAssertion()),
    await connectionEnv({
      connectionJwksFetch: async () => {
        throw new Error('network down');
      },
    }),
    store,
    CONFIG,
    NOW_ISO
  );
  assert.equal(outage.ok, false);
  assert.equal(outage.error.code, 'CONNECTION_KEYS_UNAVAILABLE');
  assert.equal(outage.error.status, 503);
  assert.equal(await store.getUserByCindyMembershipId('mem_1'), null);

  // Verification failures never write to the store: no users and no audit rows.
  assert.equal((await store.listAuditEvents({ environment: 'staging' })).length, 0);
});

test('connection actors cannot list or create access keys', async () => {
  const store = createTestPagesStore({ now: () => NOW_ISO });
  const env = await connectionEnv();

  const list = await handleAccessKeysApi(
    bearerRequest(await signAssertion(), { pathname: '/.xd-pages/api/access-keys' }),
    env,
    CONFIG,
    store
  );
  assert.equal(list.status, 403);
  assert.equal((await list.json()).error.code, 'ACCESS_KEY_MANAGEMENT_FORBIDDEN');

  const create = await handleAccessKeysApi(
    new Request('https://api-staging.pages.xd.team/.xd-pages/api/access-keys', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${await signAssertion()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ name: 'escalation attempt', siteId: 'site_1' }),
    }),
    env,
    CONFIG,
    store
  );
  assert.equal(create.status, 403);
  assert.equal((await create.json()).error.code, 'ACCESS_KEY_CREATE_FORBIDDEN');
});

test('whoami reports a connection credential without inventing an access key id', async () => {
  const store = createTestPagesStore({ now: () => NOW_ISO });
  await store.createUser({
    userId: 'usr_mapped',
    email: 'someone@xd.com',
    realname: 'Mapped User',
    employeeStatus: 'active',
    cindyMembershipId: 'mem_1',
  });

  const response = await handleWhoamiApi(
    bearerRequest(await signAssertion(), { pathname: '/.xd-pages/api/auth/whoami' }),
    await connectionEnv(),
    CONFIG,
    store
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.actor, {
    type: 'user',
    credentialType: 'connection',
    userId: 'usr_mapped',
    email: 'someone@xd.com',
    name: 'Mapped User',
    scopes: ['deploy:site', 'read:site', 'rollback:site'],
  });
});
