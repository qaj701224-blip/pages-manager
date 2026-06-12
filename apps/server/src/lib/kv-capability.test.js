import assert from 'node:assert/strict';
import test from 'node:test';
import { verifyCapability } from '../../../kv-gateway/src/auth.js';
import { parseCapabilitySigningKey, signKvCapability } from './kv-capability.js';

const now = 1_700_000_000;
const siteUuid = '4b4c8e8361ef4b47b64f5c20a7db7c47';

function testEnv(overrides = {}) {
  return {
    XD_PAGES_ENV: 'production',
    PAGES_CAP_JWT_ACTIVE_KID: 'prod-hs-2026-06',
    PAGES_CAP_JWT_KEYS: 'old-hs:HS256:PAGES_CAP_JWT_SECRET_OLD,prod-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606',
    PAGES_CAP_JWT_SECRET_OLD: 'old-test-secret',
    PAGES_CAP_JWT_SECRET_202606: 'test-secret',
    ...overrides,
  };
}

function decodeBase64UrlJson(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
}

test('parseCapabilitySigningKey returns active HS256 key', () => {
  assert.deepEqual(parseCapabilitySigningKey(testEnv()), {
    kid: 'prod-hs-2026-06',
    alg: 'HS256',
    secret: 'test-secret',
  });
});

test('signKvCapability signs with active kid and no exp', async () => {
  const jwt = await signKvCapability(
    {
      siteId: 'q2-report',
      siteUuid,
      siteGeneration: 7,
      envName: 'production',
      now,
      jti: 'capability-1',
    },
    testEnv()
  );
  const [encodedHeader, encodedPayload] = jwt.split('.');
  const header = decodeBase64UrlJson(encodedHeader);
  const payload = decodeBase64UrlJson(encodedPayload);

  assert.deepEqual(header, { typ: 'JWT', alg: 'HS256', kid: 'prod-hs-2026-06' });
  assert.equal(payload.iss, 'pages-manager');
  assert.equal(payload.aud, 'pages-kv-gateway');
  assert.equal(payload.env, 'production');
  assert.equal(payload.siteId, 'q2-report');
  assert.equal(payload.siteUuid, siteUuid);
  assert.equal(payload.siteGeneration, 7);
  assert.deepEqual(payload.scope, ['kv:get', 'kv:put', 'kv:delete']);
  assert.equal(payload.iat, now);
  assert.equal(payload.nbf, now);
  assert.equal(payload.jti, 'capability-1');
  assert.equal(payload.exp, undefined);

  const verified = await verifyCapability(`Bearer ${jwt}`, testEnv(), { requiredScope: 'kv:delete', now });
  assert.equal(verified.siteUuid, siteUuid);
});

test('parseCapabilitySigningKey rejects missing active kid', () => {
  assert.throws(() => parseCapabilitySigningKey(testEnv({ PAGES_CAP_JWT_ACTIVE_KID: '' })), /active kid/i);
});

test('parseCapabilitySigningKey rejects missing active registry entry', () => {
  assert.throws(() => parseCapabilitySigningKey(testEnv({ PAGES_CAP_JWT_ACTIVE_KID: 'missing' })), /active kid/i);
});

test('parseCapabilitySigningKey rejects empty registry', () => {
  assert.throws(() => parseCapabilitySigningKey(testEnv({ PAGES_CAP_JWT_KEYS: ' , ' })), /empty/i);
});

test('parseCapabilitySigningKey rejects duplicate kids', () => {
  assert.throws(
    () =>
      parseCapabilitySigningKey(
        testEnv({
          PAGES_CAP_JWT_KEYS:
            'prod-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606, prod-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_OLD',
        })
      ),
    /duplicate/i
  );
});

test('parseCapabilitySigningKey rejects malformed inactive entries', () => {
  assert.throws(
    () =>
      parseCapabilitySigningKey(
        testEnv({
          PAGES_CAP_JWT_KEYS: 'inactive:HS256, prod-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606',
        })
      ),
    /malformed/i
  );
});

test('parseCapabilitySigningKey rejects unsupported alg', () => {
  assert.throws(
    () =>
      parseCapabilitySigningKey(
        testEnv({
          PAGES_CAP_JWT_KEYS: 'prod-hs-2026-06:RS256:PAGES_CAP_JWT_SECRET_202606',
        })
      ),
    /unsupported/i
  );
});

test('parseCapabilitySigningKey rejects unsupported inactive alg', () => {
  assert.throws(
    () =>
      parseCapabilitySigningKey(
        testEnv({
          PAGES_CAP_JWT_KEYS: 'inactive:RS256:PAGES_CAP_JWT_SECRET_OLD, prod-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606',
        })
      ),
    /unsupported/i
  );
});

test('parseCapabilitySigningKey rejects missing secret', () => {
  assert.throws(
    () => parseCapabilitySigningKey(testEnv({ PAGES_CAP_JWT_SECRET_202606: '' })),
    /missing capability secret/i
  );
});

test('parseCapabilitySigningKey rejects missing inactive secret', () => {
  assert.throws(
    () =>
      parseCapabilitySigningKey(
        testEnv({
          PAGES_CAP_JWT_KEYS: 'inactive:HS256:PAGES_CAP_JWT_SECRET_MISSING, prod-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606',
        })
      ),
    /missing capability secret/i
  );
});
