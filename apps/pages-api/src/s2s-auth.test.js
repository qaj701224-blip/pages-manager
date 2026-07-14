import assert from 'node:assert/strict';
import test from 'node:test';

import { authenticateS2SRequest, buildS2SCanonicalInput, createS2SSignature } from './s2s-auth.js';
import { createTestPagesStore } from './test-store.js';

const environment = 'production';
const nowSeconds = 1_700_000_000;
const env = {
  S2S_CLIENT_KEYS: 'client_demo:key_1:S2S_SECRET_CLIENT_DEMO',
  S2S_SECRET_CLIENT_DEMO: 'test-secret',
};

test('builds the exact S2S canonical input and signs it with base64url HMAC-SHA256', async () => {
  const canonical = await buildS2SCanonicalInput({
    environment,
    clientId: 'client_demo',
    keyId: 'key_1',
    method: 'post',
    pathname: '/.xd-pages/api/s2s/publish',
    timestamp: nowSeconds,
    nonce: 'nonce_ABC12345',
    rawBody: '{"name":"demo"}',
  });

  assert.equal(
    canonical,
    [
      'xd-cell-s2s-v1',
      'production',
      'client_demo',
      'key_1',
      'POST',
      '/.xd-pages/api/s2s/publish',
      String(nowSeconds),
      'nonce_ABC12345',
      'd7d234f759ec34fd6298b7e32318614760070aaef9f4e92ced928324b49a0602',
    ].join('\n'),
  );

  const signature = await createS2SSignature({ secret: 'test-secret', canonicalInput: canonical });
  assert.match(signature, /^[A-Za-z0-9_-]+$/);
  assert.doesNotMatch(signature, /=/);
  assert.equal(signature, 'ZrMmm7uDU93LWkM9-vP1K9qg9w0oXMSGLD7CkWpXS6E');
});

test('authenticates a valid request and returns the raw body without consuming the nonce twice', async () => {
  const store = createTestPagesStore();
  const request = await signedRequest({ rawBody: '{"name":"demo"}' });

  const first = await authenticateS2SRequest({ request, env, environment, store, nowSeconds });
  assert.deepEqual(first, {
    ok: true,
    clientId: 'client_demo',
    keyId: 'key_1',
    timestamp: nowSeconds,
    nonce: 'nonce_ABC12345',
    rawBody: '{"name":"demo"}',
  });

  const replay = await authenticateS2SRequest({
    request: await signedRequest({ rawBody: '{"name":"demo"}' }),
    env,
    environment,
    store,
    nowSeconds,
  });
  assert.equal(replay.ok, false);
  assert.equal(replay.code, 'S2S_REPLAY_DETECTED');
  assert.equal(replay.status, 409);
  assert.equal(replay.message, 'S2S request has already been received.');
  assert.equal(replay.action, 'Generate a new nonce and retry.');
  assert.equal(replay.clientId, 'client_demo');
  assert.equal(replay.keyId, 'key_1');
});

test('validates malformed requests and registry entries with stable failure codes', async (t) => {
  const cases = [
    [
      'missing required headers',
      () => new Request('https://api.example.test/publish', { method: 'POST', body: '{}' }),
      'S2S_AUTH_REQUIRED',
    ],
    ['wrong method', () => signedRequest({ method: 'GET' }), 'S2S_REQUEST_INVALID'],
    ['query string', () => signedRequest({ query: '?x=1' }), 'S2S_REQUEST_INVALID'],
    ['missing content type', () => signedRequest({ contentType: '' }), 'S2S_REQUEST_INVALID'],
    ['content type', () => signedRequest({ contentType: 'text/plain' }), 'S2S_REQUEST_INVALID'],
    ['nonce', () => signedRequest({ nonce: 'bad' }), 'S2S_REQUEST_INVALID'],
    ['timestamp', () => signedRequest({ timestamp: nowSeconds - 301 }), 'S2S_TIMESTAMP_INVALID'],
    ['signature', () => signedRequest({ signature: 'bad' }), 'S2S_SIGNATURE_INVALID'],
    ['body size', () => signedRequest({ rawBody: 'x'.repeat(16 * 1024 + 1) }), 'S2S_REQUEST_INVALID'],
  ];

  for (const [name, requestFactory, code] of cases) {
    await t.test(name, async () => {
      const request = await requestFactory();
      const result = await authenticateS2SRequest({
        request,
        env,
        environment,
        store: createTestPagesStore(),
        nowSeconds,
      });
      assert.equal(result.ok, false);
      assert.equal(result.code, code);
      assert.equal(typeof result.message, 'string');
      assert.equal(typeof result.action, 'string');
      if (['timestamp', 'signature'].includes(name)) {
        assert.equal(result.clientId, 'client_demo');
        assert.equal(result.keyId, 'key_1');
      }
    });
  }

  const invalidRegistry = await authenticateS2SRequest({
    request: await signedRequest(),
    env: {
      S2S_CLIENT_KEYS: 'client_demo:key_1:S2S_SECRET_CLIENT_DEMO,client_demo:key_1:S2S_SECRET_CLIENT_DEMO',
      S2S_SECRET_CLIENT_DEMO: 'secret',
    },
    environment,
    store: createTestPagesStore(),
    nowSeconds,
  });
  assert.equal(invalidRegistry.code, 'S2S_CLIENT_INVALID');

  const unsafeSecretRegistry = await authenticateS2SRequest({
    request: await signedRequest(),
    env: { S2S_CLIENT_KEYS: 'client_demo:key_1:CLIENT_DEMO_SECRET', CLIENT_DEMO_SECRET: 'test-secret' },
    environment,
    store: createTestPagesStore(),
    nowSeconds,
  });
  assert.equal(unsafeSecretRegistry.code, 'S2S_CLIENT_INVALID');

  const knownRegistrationWithoutSecret = await authenticateS2SRequest({
    request: await signedRequest({ timestamp: nowSeconds - 301 }),
    env: { S2S_CLIENT_KEYS: 'client_demo:key_1:S2S_SECRET_CLIENT_DEMO' },
    environment,
    store: createTestPagesStore(),
    nowSeconds,
  });
  assert.equal(knownRegistrationWithoutSecret.code, 'S2S_TIMESTAMP_INVALID');
  assert.equal(knownRegistrationWithoutSecret.clientId, 'client_demo');
  assert.equal(knownRegistrationWithoutSecret.keyId, 'key_1');

  const unknownClient = await authenticateS2SRequest({
    request: await signedRequest(),
    env: { S2S_CLIENT_KEYS: 'other_client:key_1:S2S_SECRET_OTHER', S2S_SECRET_OTHER: 'secret' },
    environment,
    store: createTestPagesStore(),
    nowSeconds,
  });
  assert.equal(unknownClient.code, 'S2S_CLIENT_INVALID');

  const unknownKey = await authenticateS2SRequest({
    request: await signedRequest(),
    env: {
      S2S_CLIENT_KEYS: 'client_demo:key_2:S2S_SECRET_CLIENT_DEMO',
      S2S_SECRET_CLIENT_DEMO: 'test-secret',
    },
    environment,
    store: createTestPagesStore(),
    nowSeconds,
  });
  assert.equal(unknownKey.code, 'S2S_CLIENT_INVALID');

  const rotatedEnv = {
    S2S_CLIENT_KEYS: 'client_demo:key_1:S2S_SECRET_CLIENT_DEMO,client_demo:key_2:S2S_SECRET_CLIENT_DEMO_NEXT',
    S2S_SECRET_CLIENT_DEMO: 'test-secret',
    S2S_SECRET_CLIENT_DEMO_NEXT: 'next-test-secret',
  };
  const rotatedStore = createTestPagesStore();
  const currentKeyResult = await authenticateS2SRequest({
    request: await signedRequest({ nonce: 'nonce_rotate01' }),
    env: rotatedEnv,
    environment,
    store: rotatedStore,
    nowSeconds,
  });
  const nextKeyResult = await authenticateS2SRequest({
    request: await signedRequest({
      keyId: 'key_2',
      secret: rotatedEnv.S2S_SECRET_CLIENT_DEMO_NEXT,
      nonce: 'nonce_rotate02',
    }),
    env: rotatedEnv,
    environment,
    store: rotatedStore,
    nowSeconds,
  });
  assert.equal(currentKeyResult.ok, true);
  assert.equal(nextKeyResult.ok, true);

  const overConfigured = await authenticateS2SRequest({
    request: await signedRequest(),
    env: {
      S2S_CLIENT_KEYS: [
        'client_demo:key_1:S2S_SECRET_CLIENT_DEMO',
        'client_demo:key_2:S2S_SECRET_CLIENT_DEMO_NEXT',
        'client_demo:key_3:S2S_SECRET_CLIENT_DEMO_THIRD',
      ].join(','),
      S2S_SECRET_CLIENT_DEMO: 'test-secret',
      S2S_SECRET_CLIENT_DEMO_NEXT: 'next-test-secret',
      S2S_SECRET_CLIENT_DEMO_THIRD: 'third-test-secret',
    },
    environment,
    store: createTestPagesStore(),
    nowSeconds,
  });
  assert.equal(overConfigured.code, 'S2S_CLIENT_INVALID');
});

test('checks the signature before replay and rate guards', async () => {
  const calls = [];
  const store = createTestPagesStore();
  const originalReserve = store.reserveS2SNonce.bind(store);
  const originalConsume = store.consumeS2SRateLimit.bind(store);
  store.reserveS2SNonce = async (input) => {
    calls.push('reserve');
    return originalReserve(input);
  };
  store.consumeS2SRateLimit = async (input) => {
    calls.push('rate');
    return originalConsume(input);
  };

  const badSignature = await authenticateS2SRequest({
    request: await signedRequest({ signature: 'bad' }),
    env,
    environment,
    store,
    nowSeconds,
  });
  assert.equal(badSignature.code, 'S2S_SIGNATURE_INVALID');
  assert.equal(badSignature.clientId, 'client_demo');
  assert.equal(badSignature.keyId, 'key_1');
  assert.deepEqual(calls, []);

  const validRequest = await signedRequest();
  assert.equal((await authenticateS2SRequest({ request: validRequest, env, environment, store, nowSeconds })).ok, true);
  assert.deepEqual(calls, ['reserve', 'rate']);
  calls.length = 0;
  const replay = await authenticateS2SRequest({
    request: await signedRequest(),
    env,
    environment,
    store,
    nowSeconds,
  });
  assert.equal(replay.code, 'S2S_REPLAY_DETECTED');
  assert.equal(replay.clientId, 'client_demo');
  assert.equal(replay.keyId, 'key_1');
  assert.deepEqual(calls, ['reserve']);
});

test('keeps a future-skewed nonce reserved across the full timestamp acceptance window', async () => {
  const store = createTestPagesStore();
  const timestamp = nowSeconds + 300;
  const nonce = 'nonce_future300';
  const first = await authenticateS2SRequest({
    request: await signedRequest({ timestamp, nonce }),
    env,
    environment,
    store,
    nowSeconds,
  });
  assert.equal(first.ok, true);

  const replayNow = nowSeconds + 600;
  await store.cleanupExpiredS2SGuards(new Date(replayNow * 1000).toISOString());
  const replay = await authenticateS2SRequest({
    request: await signedRequest({ timestamp, nonce }),
    env,
    environment,
    store,
    nowSeconds: replayNow,
  });
  assert.equal(replay.code, 'S2S_REPLAY_DETECTED');
});

test('limits a client to 300 requests per ten-minute bucket', async () => {
  const store = createTestPagesStore();
  for (let index = 0; index < 300; index += 1) {
    const result = await authenticateS2SRequest({
      request: await signedRequest({ nonce: `nonce_${String(index).padStart(8, '0')}` }),
      env,
      environment,
      store,
      nowSeconds,
    });
    assert.equal(result.ok, true);
  }
  const limited = await authenticateS2SRequest({
    request: await signedRequest({ nonce: 'nonce_over_limit' }),
    env,
    environment,
    store,
    nowSeconds,
  });
  assert.equal(limited.ok, false);
  assert.equal(limited.code, 'S2S_RATE_LIMITED');
  assert.equal(limited.status, 429);
  assert.equal(limited.retryAfter, 600);
  assert.equal(limited.clientId, 'client_demo');
  assert.equal(limited.keyId, 'key_1');
});

async function signedRequest({
  method = 'POST',
  query = '',
  rawBody = '{}',
  nonce = 'nonce_ABC12345',
  timestamp = nowSeconds,
  contentType = 'application/json',
  signature,
  clientId = 'client_demo',
  keyId = 'key_1',
  secret = env.S2S_SECRET_CLIENT_DEMO,
} = {}) {
  const pathname = `/publish${query}`;
  const canonical = await buildS2SCanonicalInput({
    environment,
    clientId,
    keyId,
    method,
    pathname: '/publish',
    timestamp,
    nonce,
    rawBody,
  });
  const signed = signature || (await createS2SSignature({ secret, canonicalInput: canonical }));
  return new Request(`https://api.example.test${pathname}`, {
    method,
    headers: {
      'Content-Type': contentType,
      'X-XD-Cell-S2S-Client': clientId,
      'X-XD-Cell-S2S-Key-Id': keyId,
      'X-XD-Cell-S2S-Timestamp': String(timestamp),
      'X-XD-Cell-S2S-Nonce': nonce,
      'X-XD-Cell-S2S-Signature': signed,
    },
    body: method === 'GET' ? undefined : rawBody,
  });
}
