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

function decodeBase64UrlJson(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

function encodeBase64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
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

test('rejects token when payload is mutated without resigning', async () => {
  const jwt = await token();
  const [header, payload, signature] = jwt.split('.');
  const decodedPayload = decodeBase64UrlJson(payload);
  const mutated = [header, encodeBase64UrlJson({ ...decodedPayload, siteId: 'evil' }), signature].join('.');

  await assert.rejects(
    verifyCapability(`Bearer ${mutated}`, testEnv(), { requiredScope: 'kv:get', now }),
    /signature/i
  );
});

test('rejects token when signature is mutated', async () => {
  const jwt = await token();
  const [header, payload, signature] = jwt.split('.');
  const replacement = signature[0] === 'A' ? 'B' : 'A';
  const mutated = [header, payload, `${replacement}${signature.slice(1)}`].join('.');

  await assert.rejects(
    verifyCapability(`Bearer ${mutated}`, testEnv(), { requiredScope: 'kv:get', now }),
    /signature/i
  );
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

test('rejects nbf greater than now', async () => {
  const jwt = await token(claims({ nbf: now + 1 }));

  await assert.rejects(
    verifyCapability(`Bearer ${jwt}`, testEnv(), { requiredScope: 'kv:get', now }),
    /nbf/i
  );
});

test('rejects iat more than 60 seconds in the future', async () => {
  const jwt = await token(claims({ iat: now + 61 }));

  await assert.rejects(
    verifyCapability(`Bearer ${jwt}`, testEnv(), { requiredScope: 'kv:get', now }),
    /iat/i
  );
});

test('rejects invalid siteUuid', async () => {
  const jwt = await token(claims({ siteUuid: 'not-a-uuid' }));

  await assert.rejects(
    verifyCapability(`Bearer ${jwt}`, testEnv(), { requiredScope: 'kv:get', now }),
    /site uuid/i
  );
});
