import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStorageKey } from '@xd/pages-runtime-protocol';
import worker from './index.js';
import { createHs256Jwt } from './auth.js';

const siteId = 'q2-report';
const siteUuid = '4b4c8e8361ef4b47b64f5c20a7db7c47';
const otherUuid = '11111111111111111111111111111111';

class MemoryKv {
  constructor() {
    this.values = new Map();
    this.puts = [];
    this.deletes = [];
    this.failPut = null;
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async put(key, value, options) {
    if (this.failPut) throw this.failPut;
    this.values.set(key, value);
    this.puts.push({ key, value, options });
  }

  async delete(key) {
    this.values.delete(key);
    this.deletes.push(key);
  }
}

function env(overrides = {}) {
  return {
    XD_PAGES_ENV: 'production',
    PAGES_CAP_JWT_KEYS: 'prod-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606',
    PAGES_CAP_JWT_SECRET_202606: 'test-secret',
    SITE_DATA: new MemoryKv(),
    ...overrides,
  };
}

function claims(overrides = {}) {
  const issuedAt = Math.floor(Date.now() / 1000) - 10;
  return {
    iss: 'pages-v2',
    aud: 'pages-kv-gateway',
    env: 'production',
    siteId,
    siteUuid,
    scope: ['kv:get', 'kv:set', 'kv:delete'],
    nbf: issuedAt,
    iat: issuedAt,
    exp: issuedAt + 50,
    ...overrides,
  };
}

async function authHeader(payload = claims()) {
  const jwt = await createHs256Jwt({ kid: 'prod-hs-2026-06', secret: 'test-secret', payload });
  return `Bearer ${jwt}`;
}

async function request(path, body, { method = 'POST', authorization } = {}) {
  const headers = new Headers();
  if (authorization) headers.set('Authorization', authorization);
  if (body !== undefined) headers.set('Content-Type', 'application/json');

  return new Request(`https://gateway.example${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function json(response) {
  return response.json();
}

test('get reads only JWT-derived prefix and ignores body siteId', async () => {
  const gatewayEnv = env();
  const key = buildStorageKey({ siteSlug: siteId, siteUuid, userKey: 'app/config' });
  const evilKey = buildStorageKey({ siteSlug: 'evil', siteUuid, userKey: 'app/config' });
  gatewayEnv.SITE_DATA.values.set(key, JSON.stringify({ theme: 'light' }));
  gatewayEnv.SITE_DATA.values.set(evilKey, JSON.stringify({ theme: 'dark' }));

  const response = await worker.fetch(
    await request('/v1/kv/get', { key: 'app/config', siteId: 'evil' }, { authorization: await authHeader() }),
    gatewayEnv
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { ok: true, key: 'app/config', found: true, value: { theme: 'light' } });
});

test('set stores text and ttl metadata under prefixed key', async () => {
  const gatewayEnv = env();

  const response = await worker.fetch(
    await request(
      '/v1/kv/set',
      { key: 'notes/welcome', value: 'hello', type: 'text', expirationTtl: 60 },
      { authorization: await authHeader() }
    ),
    gatewayEnv
  );

  const storageKey = buildStorageKey({ siteSlug: siteId, siteUuid, userKey: 'notes/welcome' });
  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { ok: true, key: 'notes/welcome' });
  assert.equal(gatewayEnv.SITE_DATA.puts[0].key, storageKey);
  assert.equal(gatewayEnv.SITE_DATA.puts[0].value, 'hello');
  assert.equal(gatewayEnv.SITE_DATA.puts[0].options.expirationTtl, 60);
  assert.deepEqual(gatewayEnv.SITE_DATA.puts[0].options.metadata, {
    siteId,
    type: 'text',
    updatedAt: gatewayEnv.SITE_DATA.puts[0].options.metadata.updatedAt,
  });
  assert.match(gatewayEnv.SITE_DATA.puts[0].options.metadata.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('set rejects missing json value before writing', async () => {
  const gatewayEnv = env();

  const response = await worker.fetch(
    await request('/v1/kv/set', { key: 'app/config', type: 'json' }, { authorization: await authHeader() }),
    gatewayEnv
  );

  assert.equal(response.status, 400);
  assert.equal((await json(response)).error.code, 'INVALID_JSON');
  assert.equal(gatewayEnv.SITE_DATA.puts.length, 0);
});

test('set rejects missing text value before writing', async () => {
  const gatewayEnv = env();

  const response = await worker.fetch(
    await request('/v1/kv/set', { key: 'app/config', type: 'text' }, { authorization: await authHeader() }),
    gatewayEnv
  );

  assert.equal(response.status, 400);
  assert.equal((await json(response)).error.code, 'INVALID_JSON');
  assert.equal(gatewayEnv.SITE_DATA.puts.length, 0);
});

test('set rejects null text value before writing', async () => {
  const gatewayEnv = env();

  const response = await worker.fetch(
    await request('/v1/kv/set', { key: 'app/config', value: null, type: 'text' }, { authorization: await authHeader() }),
    gatewayEnv
  );

  assert.equal(response.status, 400);
  assert.equal((await json(response)).error.code, 'INVALID_JSON');
  assert.equal(gatewayEnv.SITE_DATA.puts.length, 0);
});

test('delete requires kv:delete scope', async () => {
  const gatewayEnv = env();

  const response = await worker.fetch(
    await request('/v1/kv/delete', { key: 'app/config' }, { authorization: await authHeader(claims({ scope: ['kv:get'] })) }),
    gatewayEnv
  );

  assert.equal(response.status, 403);
  assert.equal((await json(response)).error.code, 'CAPABILITY_SCOPE_DENIED');
});

test('provider value-too-large errors are standardized', async () => {
  const gatewayEnv = env();
  gatewayEnv.SITE_DATA.failPut = new Error('KV value is too large for namespace limit');

  const response = await worker.fetch(
    await request('/v1/kv/set', { key: 'app/config', value: 'hello', type: 'text' }, { authorization: await authHeader() }),
    gatewayEnv
  );

  assert.equal(response.status, 413);
  assert.equal((await json(response)).error.code, 'KV_VALUE_TOO_LARGE');
});

test('provider value-size errors are standardized', async () => {
  const gatewayEnv = env();
  gatewayEnv.SITE_DATA.failPut = new Error('Value length exceeds maximum allowed size');

  const response = await worker.fetch(
    await request('/v1/kv/set', { key: 'app/config', value: 'hello', type: 'text' }, { authorization: await authHeader() }),
    gatewayEnv
  );

  assert.equal(response.status, 413);
  assert.equal((await json(response)).error.code, 'KV_VALUE_TOO_LARGE');
});

test('generic provider value errors are not mapped to too-large responses', async () => {
  const gatewayEnv = env();
  gatewayEnv.SITE_DATA.failPut = new Error('value must be a string');

  const response = await worker.fetch(
    await request('/v1/kv/set', { key: 'app/config', value: 'hello', type: 'text' }, { authorization: await authHeader() }),
    gatewayEnv
  );

  assert.equal(response.status, 500);
  assert.equal((await json(response)).error.code, 'KV_FAILED');
});

test('provider rate limit errors are not mapped to too-large responses', async () => {
  const gatewayEnv = env();
  gatewayEnv.SITE_DATA.failPut = new Error('Rate limit exceeded');

  const response = await worker.fetch(
    await request('/v1/kv/set', { key: 'app/config', value: 'hello', type: 'text' }, { authorization: await authHeader() }),
    gatewayEnv
  );

  assert.equal(response.status, 500);
  assert.equal((await json(response)).error.code, 'KV_FAILED');
});

test('invalid JSON returns INVALID_JSON', async () => {
  const response = await worker.fetch(
    await request('/v1/kv/get', '{"key":', { authorization: await authHeader() }),
    env()
  );

  assert.equal(response.status, 400);
  assert.equal((await json(response)).error.code, 'INVALID_JSON');
});

test('JSON decode failure returns KV_DECODE_FAILED', async () => {
  const gatewayEnv = env();
  const key = buildStorageKey({ siteSlug: siteId, siteUuid, userKey: 'bad-json' });
  gatewayEnv.SITE_DATA.values.set(key, '{bad');

  const response = await worker.fetch(
    await request('/v1/kv/get', { key: 'bad-json', type: 'json' }, { authorization: await authHeader() }),
    gatewayEnv
  );

  assert.equal(response.status, 500);
  assert.equal((await json(response)).error.code, 'KV_DECODE_FAILED');
});

test('path and method handling use JSON envelopes', async () => {
  const gatewayEnv = env();

  const missing = await worker.fetch(await request('/v1/nope', undefined, { authorization: await authHeader() }), gatewayEnv);
  const wrongMethod = await worker.fetch(
    await request('/v1/kv/get', undefined, { method: 'GET', authorization: await authHeader() }),
    gatewayEnv
  );

  assert.equal(missing.status, 404);
  assert.equal((await json(missing)).ok, false);
  assert.equal(wrongMethod.status, 405);
  assert.equal((await json(wrongMethod)).error.code, 'METHOD_NOT_ALLOWED');
});

test('body/header/env siteUuid is ignored and JWT siteUuid determines prefix', async () => {
  const gatewayEnv = env({ XD_PAGES_SITE_UUID: otherUuid });
  const auth = await authHeader(claims({ siteUuid: otherUuid }));
  const headers = new Headers({ Authorization: auth, 'Content-Type': 'application/json', 'X-Site-Uuid': siteUuid });
  const requestWithHeader = new Request('https://gateway.example/v1/kv/set', {
    method: 'POST',
    headers,
    body: JSON.stringify({ key: 'app/config', value: { ok: true }, siteUuid }),
  });

  const response = await worker.fetch(requestWithHeader, gatewayEnv);

  const storageKey = buildStorageKey({ siteSlug: siteId, siteUuid: otherUuid, userKey: 'app/config' });
  assert.equal(response.status, 200);
  assert.equal(gatewayEnv.SITE_DATA.puts[0].key, storageKey);
});
