import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createConnectionJwksCache,
  isConnectionAssertionCandidate,
  readConnectionAuthConfig,
  verifyConnectionAssertion,
} from './connection-assertion.js';

const ISSUER = 'https://auth-dev.cindy.test';
const OTHER_ISSUER = 'https://auth.cindy.test';
const AUDIENCE = 'xd:xd-sites';
const NOW_SECONDS = Math.floor(Date.parse('2026-08-04T04:00:00Z') / 1000);

const CONFIG = { audience: AUDIENCE, orgSlug: 'xd', issuers: [ISSUER, OTHER_ISSUER] };

const encoder = new globalThis.TextEncoder();

async function createSigningKey(kid) {
  const { publicKey, privateKey } = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify']
  );
  const exported = await crypto.subtle.exportKey('jwk', publicKey);
  return { privateKey, jwk: { kty: 'RSA', kid, use: 'sig', alg: 'RS256', n: exported.n, e: exported.e } };
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function encodeSegment(value) {
  return base64UrlEncode(encoder.encode(JSON.stringify(value)));
}

function buildPayload(overrides = {}) {
  return {
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
  };
}

async function signAssertion(privateKey, payload, header = {}) {
  const headerSegment = encodeSegment({ alg: 'RS256', kid: 'kid_1', ...header });
  const payloadSegment = encodeSegment(payload);
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, privateKey, encoder.encode(`${headerSegment}.${payloadSegment}`))
  );
  return `${headerSegment}.${payloadSegment}.${base64UrlEncode(signature)}`;
}

function jwksFetchStub(keysByUrl) {
  const calls = [];
  return {
    calls,
    fn: async (url) => {
      calls.push(url);
      const keys = typeof keysByUrl === 'function' ? keysByUrl(url) : keysByUrl;
      return { ok: true, json: async () => ({ keys }) };
    },
  };
}

function verifyOptions(fetchStub, overrides = {}) {
  return { nowSeconds: NOW_SECONDS, fetchFn: fetchStub.fn, cache: createConnectionJwksCache(), ...overrides };
}

test('verifies a valid connection assertion and returns only contract claims', async () => {
  const { privateKey, jwk } = await createSigningKey('kid_1');
  const fetchStub = jwksFetchStub([jwk]);
  const token = await signAssertion(privateKey, buildPayload({ email: 'Someone@XD.com ' }));

  const result = await verifyConnectionAssertion(token, CONFIG, verifyOptions(fetchStub));

  assert.equal(result.ok, true);
  assert.deepEqual(result.claims, {
    membershipId: 'mem_1',
    email: 'someone@xd.com',
    orgSlug: 'xd',
    issuer: ISSUER,
    jti: 'jti_1',
    expiresAt: new Date((NOW_SECONDS + 1740) * 1000).toISOString(),
  });
  assert.deepEqual(fetchStub.calls, [`${ISSUER}/.well-known/jwks.json`]);
});

test('ignores contract-external payload fields instead of failing on them', async () => {
  const { privateKey, jwk } = await createSigningKey('kid_1');
  const fetchStub = jwksFetchStub([jwk]);
  const token = await signAssertion(
    privateKey,
    buildPayload({ role: 'admin', identities: [{ provider: 'x' }], tokenVersion: 9, amr: ['pwd'] })
  );

  const result = await verifyConnectionAssertion(token, CONFIG, verifyOptions(fetchStub));

  assert.equal(result.ok, true);
  assert.equal('role' in result.claims, false);
});

test('rejects an expired assertion but tolerates the 60-second skew', async () => {
  const { privateKey, jwk } = await createSigningKey('kid_1');
  const fetchStub = jwksFetchStub([jwk]);

  const expired = await verifyConnectionAssertion(
    await signAssertion(privateKey, buildPayload({ exp: NOW_SECONDS - 61 })),
    CONFIG,
    verifyOptions(fetchStub)
  );
  assert.equal(expired.ok, false);
  assert.equal(expired.reason, 'expired');

  const withinSkew = await verifyConnectionAssertion(
    await signAssertion(privateKey, buildPayload({ exp: NOW_SECONDS - 30 })),
    CONFIG,
    verifyOptions(fetchStub)
  );
  assert.equal(withinSkew.ok, true);
});

test('rejects wrong audience, type, context, org, and issuer claims', async () => {
  const { privateKey, jwk } = await createSigningKey('kid_1');

  const cases = [
    [{ aud: 'xd:other-plugin' }, 'aud_mismatch'],
    [{ aud: 'evil:xd-sites' }, 'aud_mismatch'],
    [{ typ: 'access' }, 'typ_mismatch'],
    [{ ctx: 'personal' }, 'ctx_mismatch'],
    [{ orgSlug: 'evil' }, 'org_mismatch'],
    [{ iss: 'https://evil.cindy.test' }, 'iss_untrusted'],
  ];
  for (const [overrides, reason] of cases) {
    const fetchStub = jwksFetchStub([jwk]);
    const result = await verifyConnectionAssertion(
      await signAssertion(privateKey, buildPayload(overrides)),
      CONFIG,
      verifyOptions(fetchStub)
    );
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(overrides)}`);
    assert.equal(result.reason, reason);
  }
});

test('never fetches key material for an untrusted issuer', async () => {
  const { privateKey, jwk } = await createSigningKey('kid_1');
  const fetchStub = jwksFetchStub([jwk]);

  const result = await verifyConnectionAssertion(
    await signAssertion(privateKey, buildPayload({ iss: 'https://evil.cindy.test' })),
    CONFIG,
    verifyOptions(fetchStub)
  );

  assert.equal(result.ok, false);
  assert.deepEqual(fetchStub.calls, []);
});

test('rejects tampered payloads and signatures from a different key', async () => {
  const { privateKey, jwk } = await createSigningKey('kid_1');
  const attacker = await createSigningKey('kid_1');
  const fetchStub = jwksFetchStub([jwk]);

  const token = await signAssertion(privateKey, buildPayload());
  const [header, , signature] = token.split('.');
  const tampered = `${header}.${encodeSegment(buildPayload({ email: 'other@xd.com' }))}.${signature}`;
  const tamperedResult = await verifyConnectionAssertion(tampered, CONFIG, verifyOptions(fetchStub));
  assert.equal(tamperedResult.ok, false);
  assert.equal(tamperedResult.reason, 'signature_invalid');

  const forged = await signAssertion(attacker.privateKey, buildPayload());
  const forgedResult = await verifyConnectionAssertion(forged, CONFIG, verifyOptions(fetchStub));
  assert.equal(forgedResult.ok, false);
  assert.equal(forgedResult.reason, 'signature_invalid');
});

test('rejects HS256 and none algorithm downgrades before touching keys', async () => {
  const { jwk } = await createSigningKey('kid_1');
  const fetchStub = jwksFetchStub([jwk]);

  const hsHeader = encodeSegment({ alg: 'HS256', kid: 'kid_1' });
  const noneHeader = encodeSegment({ alg: 'none', kid: 'kid_1' });
  const payloadSegment = encodeSegment(buildPayload());
  const fakeSignature = base64UrlEncode(encoder.encode('forged'));

  for (const headerSegment of [hsHeader, noneHeader]) {
    const result = await verifyConnectionAssertion(
      `${headerSegment}.${payloadSegment}.${fakeSignature}`,
      CONFIG,
      verifyOptions(fetchStub)
    );
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'alg_rejected');
  }
  assert.deepEqual(fetchStub.calls, []);

  const emptySignature = await verifyConnectionAssertion(`${noneHeader}.${payloadSegment}.`, CONFIG, verifyOptions(fetchStub));
  assert.equal(emptySignature.ok, false);
});

test('accepts a rotated kid by refetching the issuer JWKS after the cooldown', async () => {
  const keyOne = await createSigningKey('kid_1');
  const keyTwo = await createSigningKey('kid_2');
  let published = [keyOne.jwk];
  const fetchStub = jwksFetchStub(() => published);
  const cache = createConnectionJwksCache();

  const first = await verifyConnectionAssertion(
    await signAssertion(keyOne.privateKey, buildPayload(), { kid: 'kid_1' }),
    CONFIG,
    verifyOptions(fetchStub, { cache })
  );
  assert.equal(first.ok, true);

  published = [keyOne.jwk, keyTwo.jwk];
  const rotated = await verifyConnectionAssertion(
    await signAssertion(keyTwo.privateKey, buildPayload(), { kid: 'kid_2' }),
    CONFIG,
    verifyOptions(fetchStub, { cache, nowSeconds: NOW_SECONDS + 40 })
  );
  assert.equal(rotated.ok, true);
  assert.equal(fetchStub.calls.length, 2);
});

test('does not refetch the JWKS for an unknown kid within the 30-second cooldown', async () => {
  const keyOne = await createSigningKey('kid_1');
  const keyTwo = await createSigningKey('kid_2');
  const fetchStub = jwksFetchStub([keyOne.jwk]);
  const cache = createConnectionJwksCache();

  const first = await verifyConnectionAssertion(
    await signAssertion(keyOne.privateKey, buildPayload(), { kid: 'kid_1' }),
    CONFIG,
    verifyOptions(fetchStub, { cache })
  );
  assert.equal(first.ok, true);

  const unknownKid = await verifyConnectionAssertion(
    await signAssertion(keyTwo.privateKey, buildPayload(), { kid: 'kid_2' }),
    CONFIG,
    verifyOptions(fetchStub, { cache, nowSeconds: NOW_SECONDS + 10 })
  );
  assert.equal(unknownKid.ok, false);
  assert.equal(unknownKid.reason, 'kid_unknown');
  assert.equal(fetchStub.calls.length, 1);
});

test('rejects assertions whose total lifetime exceeds the fail-closed cap', async () => {
  const { privateKey, jwk } = await createSigningKey('kid_1');
  const fetchStub = jwksFetchStub([jwk]);

  const longLived = await verifyConnectionAssertion(
    await signAssertion(privateKey, buildPayload({ iat: NOW_SECONDS - 60, exp: NOW_SECONDS + 7200 })),
    CONFIG,
    verifyOptions(fetchStub)
  );
  assert.equal(longLived.ok, false);
  assert.equal(longLived.reason, 'lifetime_invalid');

  const inverted = await verifyConnectionAssertion(
    await signAssertion(privateKey, buildPayload({ iat: NOW_SECONDS - 60, exp: NOW_SECONDS - 60 })),
    CONFIG,
    verifyOptions(fetchStub)
  );
  assert.equal(inverted.ok, false);
  assert.equal(inverted.reason, 'lifetime_invalid');

  const contractTtl = await verifyConnectionAssertion(
    await signAssertion(privateKey, buildPayload({ iat: NOW_SECONDS - 60, exp: NOW_SECONDS + 1740 })),
    CONFIG,
    verifyOptions(fetchStub)
  );
  assert.equal(contractTtl.ok, true);
});

test('keeps reporting a retryable outage within the cooldown after a failed JWKS fetch', async () => {
  const { privateKey, jwk } = await createSigningKey('kid_1');
  let broken = true;
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    if (broken) throw new Error('network down');
    return { ok: true, json: async () => ({ keys: [jwk] }) };
  };
  const cache = createConnectionJwksCache();
  const token = await signAssertion(privateKey, buildPayload());

  const first = await verifyConnectionAssertion(token, CONFIG, { nowSeconds: NOW_SECONDS, fetchFn, cache });
  assert.equal(first.unavailable, true);

  // Within the cooldown the outage must stay a 503-style outcome, not degrade to kid_unknown.
  const second = await verifyConnectionAssertion(token, CONFIG, { nowSeconds: NOW_SECONDS + 10, fetchFn, cache });
  assert.equal(second.unavailable, true);
  assert.equal(calls.length, 1);

  broken = false;
  const recovered = await verifyConnectionAssertion(token, CONFIG, { nowSeconds: NOW_SECONDS + 40, fetchFn, cache });
  assert.equal(recovered.ok, true);
  assert.equal(calls.length, 2);
});

test('reports the JWKS as unavailable when the fetch fails', async () => {
  const { privateKey } = await createSigningKey('kid_1');
  const token = await signAssertion(privateKey, buildPayload());

  const thrown = await verifyConnectionAssertion(token, CONFIG, {
    nowSeconds: NOW_SECONDS,
    cache: createConnectionJwksCache(),
    fetchFn: async () => {
      throw new Error('network down');
    },
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.unavailable, true);

  const httpError = await verifyConnectionAssertion(token, CONFIG, {
    nowSeconds: NOW_SECONDS,
    cache: createConnectionJwksCache(),
    fetchFn: async () => ({ ok: false, status: 502 }),
  });
  assert.equal(httpError.ok, false);
  assert.equal(httpError.unavailable, true);
});

test('rejects assertions without a kid or with missing contract claims', async () => {
  const { privateKey, jwk } = await createSigningKey('kid_1');
  const fetchStub = jwksFetchStub([jwk]);

  const noKid = await verifyConnectionAssertion(
    await signAssertion(privateKey, buildPayload(), { kid: undefined }),
    CONFIG,
    verifyOptions(fetchStub)
  );
  assert.equal(noKid.ok, false);
  assert.equal(noKid.reason, 'kid_invalid');

  for (const overrides of [{ sub: '' }, { jti: undefined }, { email: 'not-an-email' }]) {
    const result = await verifyConnectionAssertion(
      await signAssertion(privateKey, buildPayload(overrides)),
      CONFIG,
      verifyOptions(fetchStub)
    );
    assert.equal(result.ok, false, `expected rejection for ${JSON.stringify(overrides)}`);
    assert.equal(result.reason, 'claims_invalid');
  }
});

test('recognizes connection assertion candidates by JWT shape', () => {
  assert.equal(isConnectionAssertionCandidate('aaa.bbb.ccc'), true);
  assert.equal(isConnectionAssertionCandidate('xdp_stg_ak_1_abc'), false);
  assert.equal(isConnectionAssertionCandidate('aaa.bbb'), false);
  assert.equal(isConnectionAssertionCandidate('aaa.bbb.'), false);
  assert.equal(isConnectionAssertionCandidate(`${'a'.repeat(9000)}.b.c`), false);
});

test('reads the connection auth config only when both vars are valid', () => {
  assert.deepEqual(
    readConnectionAuthConfig({
      CINDY_CONNECTION_ISSUERS: ' https://auth.cindy.com.cn , https://auth.cindy.app ',
      CINDY_CONNECTION_AUDIENCE: 'xd:xd-sites',
    }),
    { audience: 'xd:xd-sites', orgSlug: 'xd', issuers: ['https://auth.cindy.com.cn', 'https://auth.cindy.app'] }
  );

  assert.equal(readConnectionAuthConfig({}), null);
  assert.equal(readConnectionAuthConfig({ CINDY_CONNECTION_AUDIENCE: 'xd:xd-sites' }), null);
  assert.equal(
    readConnectionAuthConfig({ CINDY_CONNECTION_ISSUERS: 'http://auth.cindy.com.cn', CINDY_CONNECTION_AUDIENCE: 'xd:xd-sites' }),
    null
  );
  assert.equal(
    readConnectionAuthConfig({
      CINDY_CONNECTION_ISSUERS: 'https://auth.cindy.com.cn/path',
      CINDY_CONNECTION_AUDIENCE: 'xd:xd-sites',
    }),
    null
  );
  assert.equal(
    readConnectionAuthConfig({ CINDY_CONNECTION_ISSUERS: 'https://auth.cindy.com.cn', CINDY_CONNECTION_AUDIENCE: 'xd-sites' }),
    null
  );
});
