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
    iss: 'pages-v2',
    aud: 'pages-kv-gateway',
    env: 'production',
    siteId: 'q2-report',
    siteUuid,
    scope: ['kv:get', 'kv:set'],
    nbf: now - 10,
    iat: now - 10,
    exp: now + 50,
    jti: 'capability-1',
    ...overrides,
  };
}

function dataClaims(dataScope, overrides = {}) {
  return claims({
    apiVersion: 2,
    dataScope,
    sub: dataScope === 'user' ? 'usr_123' : 'anonymous',
    anonymous: dataScope !== 'user',
    scope:
      dataScope === 'user'
        ? ['data:user:get', 'data:user:set', 'data:user:delete']
        : ['data:site:get', 'data:site:set', 'data:site:delete'],
    ...overrides,
  });
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

test('parseKeyRegistry trims key registry fields', () => {
  const registry = parseKeyRegistry(
    testEnv({
      PAGES_CAP_JWT_KEYS: ' prod-hs-2026-06 : HS256 : PAGES_CAP_JWT_SECRET_202606 ',
    })
  );

  assert.deepEqual(registry.get('prod-hs-2026-06'), { alg: 'HS256', secret: 'test-secret' });
});

test('valid HS256 token verifies and returns claims', async () => {
  const jwt = await token();

  const verified = await verifyCapability(`Bearer ${jwt}`, testEnv(), { requiredScope: 'kv:get', now });

  assert.equal(verified.siteId, 'q2-report');
  assert.equal(verified.siteUuid, siteUuid);
  assert.equal(verified.jti, 'capability-1');
});

test('valid site data capability requires matching data scope', async () => {
  const jwt = await token(dataClaims('site'));

  const verified = await verifyCapability(`Bearer ${jwt}`, testEnv(), {
    requiredScope: 'data:site:get',
    requiredDataScope: 'site',
    now,
  });

  assert.equal(verified.dataScope, 'site');
  assert.equal(verified.sub, 'anonymous');
});

test('rejects data capability when path data scope does not match', async () => {
  const jwt = await token(dataClaims('site'));

  await assert.rejects(
    verifyCapability(`Bearer ${jwt}`, testEnv(), {
      requiredScope: 'data:user:get',
      requiredDataScope: 'user',
      now,
    }),
    /data scope/i
  );
});

test('legacy capability verifies only for legacy site data paths', async () => {
  const jwt = await token();

  const verified = await verifyCapability(`Bearer ${jwt}`, testEnv(), {
    requiredScope: 'kv:get',
    requiredDataScope: 'legacy-site',
    now,
  });

  assert.equal(verified.dataScope, 'site');
  await assert.rejects(
    verifyCapability(`Bearer ${jwt}`, testEnv(), {
      requiredScope: 'data:site:get',
      requiredDataScope: 'site',
      now,
    }),
    /data scope/i
  );
});

test('rejects malformed user data subject claims', async () => {
  const anonymousUser = await token(dataClaims('user', { sub: 'anonymous', anonymous: true }));

  const verified = await verifyCapability(`Bearer ${anonymousUser}`, testEnv(), {
    requiredScope: 'data:user:get',
    requiredDataScope: 'user',
    now,
  });

  assert.equal(verified.anonymous, true);
  await assert.rejects(
    verifyCapability(
      `Bearer ${await token(dataClaims('user', { sub: 'user@example.com', anonymous: false }))}`,
      testEnv(),
      {
        requiredScope: 'data:user:get',
        requiredDataScope: 'user',
        now,
      }
    ),
    /subject|user/i
  );
});

test('valid HS256 token verifies against v2 PAGES_ENV', async () => {
  const jwt = await token();
  const env = testEnv({ PAGES_ENV: 'production' });
  delete env.XD_PAGES_ENV;

  const verified = await verifyCapability(`Bearer ${jwt}`, env, { requiredScope: 'kv:get', now });

  assert.equal(verified.env, 'production');
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

test('rejects expired capability tokens', async () => {
  const jwt = await token(claims({ exp: now - 1 }));

  await assert.rejects(
    verifyCapability(`Bearer ${jwt}`, testEnv(), { requiredScope: 'kv:get', now }),
    /exp|expired/i
  );
});

test('rejects capability tokens that exceed max ttl', async () => {
  const jwt = await token(claims({ iat: now - 10, exp: now + 120 }));

  await assert.rejects(
    verifyCapability(`Bearer ${jwt}`, testEnv(), { requiredScope: 'kv:get', now }),
    /ttl|exp/i
  );
});

test('rejects invalid siteUuid', async () => {
  const jwt = await token(claims({ siteUuid: 'not-a-uuid' }));

  await assert.rejects(
    verifyCapability(`Bearer ${jwt}`, testEnv(), { requiredScope: 'kv:get', now }),
    /site uuid/i
  );
});
