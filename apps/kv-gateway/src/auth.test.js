import assert from 'node:assert/strict';
import test from 'node:test';
import { createHs256Jwt, parseKeyRegistry, verifyCapability } from './auth.js';

const now = 1_700_000_000;
const siteUuid = '4b4c8e8361ef4b47b64f5c20a7db7c47';

function testEnv(overrides = {}) {
  return {
    XD_PAGES_ENV: 'production',
    PAGES_CAP_JWT_ACTIVE_KID: 'prod-hs-2026-06',
    PAGES_CAP_JWT_KEYS: 'prod-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606',
    PAGES_CAP_JWT_SECRET_202606: 'test-secret',
    ...overrides,
  };
}

function claims(overrides = {}) {
  return {
    iss: 'pages-manager',
    aud: 'pages-kv-gateway',
    env: 'production',
    siteId: 'q2-report',
    siteUuid,
    scope: ['kv:get', 'kv:put'],
    nbf: now - 10,
    iat: now - 10,
    jti: 'capability-1',
    ...overrides,
  };
}

async function token(payload = claims(), options = {}) {
  return createHs256Jwt({
    kid: 'prod-hs-2026-06',
    secret: 'test-secret',
    payload,
    ...options,
  });
}

test('parseKeyRegistry returns configured HS256 key entries', () => {
  const registry = parseKeyRegistry(testEnv());

  assert.equal(registry.size, 1);
  assert.deepEqual(registry.get('prod-hs-2026-06'), { alg: 'HS256', secret: 'test-secret' });
});

test('valid HS256 token verifies and returns claims', async () => {
  const jwt = await token();

  const verified = await verifyCapability(`Bearer ${jwt}`, testEnv(), { requiredScope: 'kv:get', now });

  assert.equal(verified.siteId, 'q2-report');
  assert.equal(verified.siteUuid, siteUuid);
  assert.equal(verified.jti, 'capability-1');
});

test('rejects alg mismatch', async () => {
  const jwt = await token(claims(), { header: { alg: 'HS512' } });

  await assert.rejects(
    verifyCapability(`Bearer ${jwt}`, testEnv(), { requiredScope: 'kv:get', now }),
    /alg/i
  );
});

test('rejects malformed token and unknown kid', async () => {
  await assert.rejects(verifyCapability('Bearer not-a-jwt', testEnv(), { requiredScope: 'kv:get', now }), /malformed/i);

  const jwt = await createHs256Jwt({
    kid: 'unknown',
    secret: 'test-secret',
    payload: claims(),
  });

  await assert.rejects(verifyCapability(`Bearer ${jwt}`, testEnv(), { requiredScope: 'kv:get', now }), /unknown kid/i);
});

test('rejects env mismatch', async () => {
  const jwt = await token(claims({ env: 'staging' }));

  await assert.rejects(
    verifyCapability(`Bearer ${jwt}`, testEnv(), { requiredScope: 'kv:get', now }),
    /environment/i
  );
});

test('rejects missing scope with distinguishable scope message', async () => {
  const jwt = await token(claims({ scope: ['kv:get'] }));

  await assert.rejects(
    verifyCapability(`Bearer ${jwt}`, testEnv(), { requiredScope: 'kv:delete', now }),
    /scope/i
  );
});

test('rejects invalid siteUuid', async () => {
  const jwt = await token(claims({ siteUuid: 'not-a-uuid' }));

  await assert.rejects(
    verifyCapability(`Bearer ${jwt}`, testEnv(), { requiredScope: 'kv:get', now }),
    /site uuid/i
  );
});
