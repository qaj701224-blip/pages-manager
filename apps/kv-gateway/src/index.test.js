import assert from 'node:assert/strict';
import test from 'node:test';
import { buildStorageKey, buildUserStorageKey } from '@xd/pages-runtime-protocol';
import worker from './index.js';
import { createHs256Jwt } from './auth.js';

const siteId = 'q2-report';
const siteUuid = '4b4c8e8361ef4b47b64f5c20a7db7c47';
const stableSiteId = 'site_4b4c8e8361ef4b47b64f5c20a7db7c47';
const otherUuid = '11111111111111111111111111111111';

class MemoryKv {
  constructor() {
    this.values = new Map();
    this.metadatas = new Map();
    this.gets = [];
    this.puts = [];
    this.deletes = [];
    this.failPut = null;
  }

  async get(key, options) {
    this.gets.push({ key, options });
    const value = this.values.get(key) ?? null;
    if (options?.type === 'json' && typeof value === 'string') return JSON.parse(value);
    return value;
  }

  async getWithMetadata(key, options) {
    return {
      value: await this.get(key, options),
      metadata: this.metadatas.get(key) ?? null,
    };
  }

  async put(key, value, options) {
    if (this.failPut) throw this.failPut;
    this.values.set(key, value);
    if (Object.hasOwn(options || {}, 'metadata')) this.metadatas.set(key, options.metadata);
    this.puts.push({ key, value, options });
  }

  async delete(key) {
    this.values.delete(key);
    this.deletes.push(key);
  }

  async list(options = {}) {
    const prefix = options.prefix || '';
    const keys = [...this.values.keys()]
      .filter((key) => key.startsWith(prefix))
      .sort()
      .slice(0, options.limit || 1000)
      .map((name) => {
        const metadata = this.metadatas.get(name);
        return metadata ? { name, metadata } : { name };
      });
    return { keys, list_complete: true };
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

function namespaceV2Claims(dataScope = 'site', overrides = {}) {
  return dataClaims(dataScope, {
    namespaceVersion: 2,
    siteId: stableSiteId,
    dataNamespace: siteId,
    ...overrides,
  });
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

test('legacy kv get remains site-level and returns deprecation headers', async () => {
  const gatewayEnv = env();
  const siteKey = buildStorageKey({ siteSlug: siteId, siteUuid, userKey: 'app/config' });
  const userKey = buildUserStorageKey({ siteSlug: siteId, siteUuid, userId: 'usr_123', userKey: 'app/config' });
  gatewayEnv.SITE_DATA.values.set(siteKey, JSON.stringify({ scope: 'site' }));
  gatewayEnv.SITE_DATA.values.set(userKey, JSON.stringify({ scope: 'user' }));

  const response = await worker.fetch(
    await request('/v1/kv/get', { key: 'app/config' }, { authorization: await authHeader() }),
    gatewayEnv
  );

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Deprecation'), 'true');
  assert.equal(response.headers.get('X-XD-Pages-Deprecated'), 'kv-runtime');
  assert.deepEqual(await json(response), { ok: true, key: 'app/config', found: true, value: { scope: 'site' } });
});

test('site data and user data capabilities cannot cross gateway paths', async () => {
  const gatewayEnv = env();
  const siteToUser = await worker.fetch(
    await request('/v1/data/user/get', { key: 'app/config' }, { authorization: await authHeader(dataClaims('site')) }),
    gatewayEnv
  );
  const userToSite = await worker.fetch(
    await request('/v1/data/site/get', { key: 'app/config' }, { authorization: await authHeader(dataClaims('user')) }),
    gatewayEnv
  );
  const userToLegacy = await worker.fetch(
    await request('/v1/kv/get', { key: 'app/config' }, { authorization: await authHeader(dataClaims('user')) }),
    gatewayEnv
  );

  assert.equal(siteToUser.status, 403);
  assert.equal((await json(siteToUser)).error.code, 'CAPABILITY_SCOPE_DENIED');
  assert.equal(userToSite.status, 403);
  assert.equal((await json(userToSite)).error.code, 'CAPABILITY_SCOPE_DENIED');
  assert.equal(userToLegacy.status, 403);
  assert.equal((await json(userToLegacy)).error.code, 'CAPABILITY_SCOPE_DENIED');
});

test('user data reads only claims subject and ignores body userId and scope', async () => {
  const gatewayEnv = env();
  const userKey = buildUserStorageKey({ siteSlug: siteId, siteUuid, userId: 'usr_123', userKey: 'draft' });
  const evilKey = buildUserStorageKey({ siteSlug: siteId, siteUuid, userId: 'usr_evil', userKey: 'draft' });
  gatewayEnv.SITE_DATA.values.set(userKey, JSON.stringify({ owner: 'claims' }));
  gatewayEnv.SITE_DATA.values.set(evilKey, JSON.stringify({ owner: 'body' }));

  const response = await worker.fetch(
    await request(
      '/v1/data/user/get',
      { key: 'draft', userId: 'usr_evil', scope: 'site' },
      { authorization: await authHeader(dataClaims('user')) }
    ),
    gatewayEnv
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), { ok: true, key: 'draft', found: true, value: { owner: 'claims' } });
});

test('user data writes under claims subject prefix', async () => {
  const gatewayEnv = env();

  const response = await worker.fetch(
    await request(
      '/v1/data/user/set',
      { key: 'draft', value: { title: 'hello' }, userId: 'usr_evil' },
      { authorization: await authHeader(dataClaims('user')) }
    ),
    gatewayEnv
  );

  const storageKey = buildUserStorageKey({ siteSlug: siteId, siteUuid, userId: 'usr_123', userKey: 'draft' });
  assert.equal(response.status, 200);
  assert.equal(gatewayEnv.SITE_DATA.puts[0].key, storageKey);
  assert.equal(gatewayEnv.SITE_DATA.puts[0].options.metadata.__xd_pages.userId, 'usr_123');
});

test('anonymous user data get, set, and delete fail with USER_REQUIRED', async () => {
  const gatewayEnv = env();
  const anonymousClaims = dataClaims('user', {
    sub: 'anonymous',
    anonymous: true,
    scope: ['data:user:get', 'data:user:set', 'data:user:delete'],
  });

  const getResponse = await worker.fetch(
    await request('/v1/data/user/get', { key: 'draft' }, { authorization: await authHeader(anonymousClaims) }),
    gatewayEnv
  );
  const setResponse = await worker.fetch(
    await request(
      '/v1/data/user/set',
      { key: 'draft', value: { title: 'hello' } },
      { authorization: await authHeader(anonymousClaims) }
    ),
    gatewayEnv
  );
  const deleteResponse = await worker.fetch(
    await request('/v1/data/user/delete', { key: 'draft' }, { authorization: await authHeader(anonymousClaims) }),
    gatewayEnv
  );

  assert.equal(getResponse.status, 401);
  assert.equal((await json(getResponse)).error.code, 'USER_REQUIRED');
  assert.equal(setResponse.status, 401);
  assert.equal((await json(setResponse)).error.code, 'USER_REQUIRED');
  assert.equal(deleteResponse.status, 401);
  assert.equal((await json(deleteResponse)).error.code, 'USER_REQUIRED');
  assert.equal(gatewayEnv.SITE_DATA.gets.length, 0);
  assert.equal(gatewayEnv.SITE_DATA.puts.length, 0);
  assert.equal(gatewayEnv.SITE_DATA.deletes.length, 0);
});

test('overlong user data storage keys return INVALID_KEY envelopes', async () => {
  const gatewayEnv = env();
  const userClaims = dataClaims('user', {
    siteId: 'a'.repeat(50),
    sub: 'u'.repeat(128),
  });
  const authorization = await authHeader(userClaims);
  const key = '中'.repeat(80);

  const getResponse = await worker.fetch(
    await request('/v1/data/user/get', { key }, { authorization }),
    gatewayEnv
  );
  const setResponse = await worker.fetch(
    await request('/v1/data/user/set', { key, value: { title: 'hello' } }, { authorization }),
    gatewayEnv
  );
  const deleteResponse = await worker.fetch(
    await request('/v1/data/user/delete', { key }, { authorization }),
    gatewayEnv
  );

  assert.equal(getResponse.status, 400);
  assert.deepEqual((await json(getResponse)).error, { code: 'INVALID_KEY', message: 'Invalid data key' });
  assert.equal(setResponse.status, 400);
  assert.deepEqual((await json(setResponse)).error, { code: 'INVALID_KEY', message: 'Invalid data key' });
  assert.equal(deleteResponse.status, 400);
  assert.deepEqual((await json(deleteResponse)).error, { code: 'INVALID_KEY', message: 'Invalid data key' });
  assert.equal(gatewayEnv.SITE_DATA.puts.length, 0);
  assert.equal(gatewayEnv.SITE_DATA.deletes.length, 0);
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
    user: null,
    __xd_pages: {
      schemaVersion: 1,
      siteId,
      type: 'text',
      updatedAt: gatewayEnv.SITE_DATA.puts[0].options.metadata.__xd_pages.updatedAt,
    },
  });
  assert.match(gatewayEnv.SITE_DATA.puts[0].options.metadata.__xd_pages.updatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('namespace v2 capabilities keep storage keys stable while recording the real site id', async () => {
  const gatewayEnv = env();

  const response = await worker.fetch(
    await request(
      '/v1/data/site/set',
      { key: 'app/config', value: { renamed: true } },
      { authorization: await authHeader(namespaceV2Claims('site')) },
    ),
    gatewayEnv,
  );

  const storageKey = buildStorageKey({ siteSlug: siteId, siteUuid, userKey: 'app/config' });
  assert.equal(response.status, 200);
  assert.equal(gatewayEnv.SITE_DATA.puts[0].key, storageKey);
  assert.deepEqual(gatewayEnv.SITE_DATA.puts[0].options.metadata.__xd_pages, {
    schemaVersion: 2,
    siteId: stableSiteId,
    dataNamespace: siteId,
    type: 'json',
    updatedAt: gatewayEnv.SITE_DATA.puts[0].options.metadata.__xd_pages.updatedAt,
  });
});

test('set stores user metadata and absolute expiration without exposing platform metadata', async () => {
  const gatewayEnv = env();

  const response = await worker.fetch(
    await request(
      '/v1/kv/set',
      {
        key: 'notes/welcome',
        value: 'hello',
        type: 'text',
        expiration: 1_900_000_000,
        metadata: { owner: 'docs', tags: ['welcome'] },
      },
      { authorization: await authHeader(claims({ scope: ['kv:set'] })) }
    ),
    gatewayEnv
  );

  const storageKey = buildStorageKey({ siteSlug: siteId, siteUuid, userKey: 'notes/welcome' });
  assert.equal(response.status, 200);
  assert.equal(gatewayEnv.SITE_DATA.puts[0].key, storageKey);
  assert.equal(gatewayEnv.SITE_DATA.puts[0].options.expiration, 1_900_000_000);
  assert.deepEqual(gatewayEnv.SITE_DATA.puts[0].options.metadata, {
    user: { owner: 'docs', tags: ['welcome'] },
    __xd_pages: {
      schemaVersion: 1,
      siteId,
      type: 'text',
      updatedAt: gatewayEnv.SITE_DATA.puts[0].options.metadata.__xd_pages.updatedAt,
    },
  });
});

test('getWithMetadata returns only user metadata and distinguishes missing keys', async () => {
  const gatewayEnv = env();
  const storageKey = buildStorageKey({ siteSlug: siteId, siteUuid, userKey: 'app/config' });
  gatewayEnv.SITE_DATA.values.set(storageKey, JSON.stringify({ enabled: true }));
  gatewayEnv.SITE_DATA.metadatas.set(storageKey, {
    user: { owner: 'docs' },
    __xd_pages: {
      schemaVersion: 1,
      siteId,
      type: 'json',
      updatedAt: '2026-06-26T00:00:00.000Z',
    },
  });

  const found = await worker.fetch(
    await request(
      '/v1/kv/get-with-metadata',
      { key: 'app/config', type: 'json' },
      { authorization: await authHeader(claims({ scope: ['kv:get'] })) }
    ),
    gatewayEnv
  );
  const missing = await worker.fetch(
    await request(
      '/v1/kv/get-with-metadata',
      { key: 'app/missing', type: 'json' },
      { authorization: await authHeader(claims({ scope: ['kv:get'] })) }
    ),
    gatewayEnv
  );

  assert.equal(found.status, 200);
  assert.deepEqual(await json(found), {
    ok: true,
    key: 'app/config',
    found: true,
    value: { enabled: true },
    metadata: { owner: 'docs' },
  });
  assert.equal(missing.status, 200);
  assert.deepEqual(await json(missing), {
    ok: true,
    key: 'app/missing',
    found: false,
    value: null,
    metadata: null,
  });
});

test('list requires kv:list and returns decoded current-site keys only', async () => {
  const gatewayEnv = env();
  const configKey = buildStorageKey({ siteSlug: siteId, siteUuid, userKey: 'app/config' });
  const draftKey = buildStorageKey({ siteSlug: siteId, siteUuid, userKey: 'draft' });
  const otherSiteKey = buildStorageKey({ siteSlug: 'other-site', siteUuid, userKey: 'app/config' });
  gatewayEnv.SITE_DATA.values.set(configKey, 'config');
  gatewayEnv.SITE_DATA.values.set(draftKey, 'draft');
  gatewayEnv.SITE_DATA.values.set(otherSiteKey, 'other');
  gatewayEnv.SITE_DATA.metadatas.set(configKey, {
    user: { owner: 'docs' },
    __xd_pages: { schemaVersion: 1, siteId, type: 'text', updatedAt: '2026-06-26T00:00:00.000Z' },
  });

  const denied = await worker.fetch(
    await request('/v1/kv/list', { prefix: 'app/' }, { authorization: await authHeader(claims({ scope: ['kv:get'] })) }),
    gatewayEnv
  );
  const response = await worker.fetch(
    await request(
      '/v1/kv/list',
      { prefix: 'app/', limit: 10 },
      { authorization: await authHeader(claims({ scope: ['kv:get', 'kv:list'] })) }
    ),
    gatewayEnv
  );

  assert.equal(denied.status, 403);
  assert.equal((await json(denied)).error.code, 'CAPABILITY_SCOPE_DENIED');
  assert.equal(response.status, 200);
  assert.deepEqual(await json(response), {
    ok: true,
    keys: [{ name: 'app/config', metadata: { owner: 'docs' } }],
    list_complete: true,
  });
});

test('list accumulates provider pages until requested prefixed keys are filled', async () => {
  const gatewayEnv = env();
  const seenRequests = [];
  const storageItemsByCursor = new Map([
    [
      null,
      {
        keys: [
          { name: buildStorageKey({ siteSlug: siteId, siteUuid, userKey: 'draft/1' }) },
          { name: buildStorageKey({ siteSlug: siteId, siteUuid, userKey: 'draft/2' }) },
        ],
        list_complete: false,
        cursor: 'provider-page-2',
      },
    ],
    [
      'provider-page-2',
      {
        keys: [
          { name: buildStorageKey({ siteSlug: siteId, siteUuid, userKey: 'app/a' }) },
          { name: buildStorageKey({ siteSlug: siteId, siteUuid, userKey: 'app/b' }) },
        ],
        list_complete: false,
        cursor: 'provider-page-3',
      },
    ],
  ]);
  gatewayEnv.SITE_DATA.list = async (options = {}) => {
    seenRequests.push({ limit: options.limit, cursor: options.cursor ?? null });
    return storageItemsByCursor.get(options.cursor ?? null);
  };

  const response = await worker.fetch(
    await request(
      '/v1/kv/list',
      { prefix: 'app/', limit: 2 },
      { authorization: await authHeader(claims({ scope: ['kv:list'] })) }
    ),
    gatewayEnv
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.deepEqual(body.keys, [{ name: 'app/a' }, { name: 'app/b' }]);
  assert.equal(body.list_complete, false);
  assert.equal(typeof body.cursor, 'string');
  assert.deepEqual(seenRequests, [
    { limit: 2, cursor: null },
    { limit: 2, cursor: 'provider-page-2' },
  ]);
});

test('list cursors continue after returned matching keys without skipping extras', async () => {
  const gatewayEnv = env();
  const storageKeys = ['app/a', 'app/b', 'app/c'].map((userKey) =>
    buildStorageKey({ siteSlug: siteId, siteUuid, userKey })
  );
  const seenRequests = [];
  gatewayEnv.SITE_DATA.list = async (options = {}) => {
    const start = options.cursor ? Number(options.cursor) : 0;
    const end = start + options.limit;
    seenRequests.push({ limit: options.limit, cursor: options.cursor ?? null });
    return {
      keys: storageKeys.slice(start, end).map((name) => ({ name })),
      list_complete: end >= storageKeys.length,
      cursor: end < storageKeys.length ? String(end) : undefined,
    };
  };

  const first = await worker.fetch(
    await request(
      '/v1/kv/list',
      { prefix: 'app/', limit: 2 },
      { authorization: await authHeader(claims({ scope: ['kv:list'] })) }
    ),
    gatewayEnv
  );
  const firstBody = await json(first);
  assert.equal(first.status, 200);
  assert.deepEqual(firstBody.keys, [{ name: 'app/a' }, { name: 'app/b' }]);
  assert.equal(firstBody.list_complete, false);
  assert.equal(typeof firstBody.cursor, 'string');

  const second = await worker.fetch(
    await request(
      '/v1/kv/list',
      { prefix: 'app/', limit: 2, cursor: firstBody.cursor },
      { authorization: await authHeader(claims({ scope: ['kv:list'] })) }
    ),
    gatewayEnv
  );
  const secondBody = await json(second);
  assert.equal(second.status, 200);
  assert.deepEqual(secondBody.keys, [{ name: 'app/c' }]);
  assert.equal(secondBody.list_complete, true);
  assert.deepEqual(seenRequests, [
    { limit: 2, cursor: null },
    { limit: 2, cursor: '2' },
  ]);
});

test('list bounds provider page scans for sparse prefixes', async () => {
  const gatewayEnv = env();
  const seenProviderCursors = [];
  gatewayEnv.SITE_DATA.list = async (options = {}) => {
    const page = options.cursor ? Number(options.cursor) : 0;
    seenProviderCursors.push(options.cursor ?? null);
    return {
      keys: [{ name: buildStorageKey({ siteSlug: siteId, siteUuid, userKey: `draft/${page}` }) }],
      list_complete: false,
      cursor: String(page + 1),
    };
  };

  const response = await worker.fetch(
    await request(
      '/v1/kv/list',
      { prefix: 'app/', limit: 1 },
      { authorization: await authHeader(claims({ scope: ['kv:list'] })) }
    ),
    gatewayEnv
  );
  const body = await json(response);

  assert.equal(response.status, 200);
  assert.deepEqual(body.keys, []);
  assert.equal(body.list_complete, false);
  assert.equal(typeof body.cursor, 'string');
  assert.equal(seenProviderCursors.length, 16);
});

test('list wraps provider cursors and binds them to list context', async () => {
  const gatewayEnv = env();
  const seenProviderCursors = [];
  gatewayEnv.SITE_DATA.list = async (options = {}) => {
    seenProviderCursors.push(options.cursor ?? null);
    return options.cursor
      ? { keys: [], list_complete: true }
      : {
          keys: [{ name: buildStorageKey({ siteSlug: siteId, siteUuid, userKey: 'app/config' }) }],
          list_complete: false,
          cursor: 'raw-provider-cursor',
        };
  };

  const first = await worker.fetch(
    await request(
      '/v1/kv/list',
      { prefix: 'app/', limit: 1 },
      { authorization: await authHeader(claims({ scope: ['kv:list'] })) }
    ),
    gatewayEnv
  );
  const firstBody = await json(first);
  assert.equal(first.status, 200);
  assert.equal(firstBody.list_complete, false);
  assert.equal(typeof firstBody.cursor, 'string');
  assert.notEqual(firstBody.cursor, 'raw-provider-cursor');

  const second = await worker.fetch(
    await request(
      '/v1/kv/list',
      { prefix: 'app/', limit: 1, cursor: firstBody.cursor },
      { authorization: await authHeader(claims({ scope: ['kv:list'] })) }
    ),
    gatewayEnv
  );
  assert.equal(second.status, 200);
  assert.deepEqual(seenProviderCursors, [null, 'raw-provider-cursor']);

  const mismatched = await worker.fetch(
    await request(
      '/v1/kv/list',
      { prefix: 'other/', limit: 1, cursor: firstBody.cursor },
      { authorization: await authHeader(claims({ scope: ['kv:list'] })) }
    ),
    gatewayEnv
  );
  assert.equal(mismatched.status, 400);
  assert.deepEqual((await json(mismatched)).error, { code: 'INVALID_CURSOR', message: 'Invalid data list cursor' });
});

test('a legacy list cursor remains valid with a namespace v2 capability after a slug rename', async () => {
  const gatewayEnv = env();
  const seenProviderCursors = [];
  gatewayEnv.SITE_DATA.list = async (options = {}) => {
    seenProviderCursors.push(options.cursor ?? null);
    return options.cursor
      ? { keys: [], list_complete: true }
      : {
          keys: [{ name: buildStorageKey({ siteSlug: siteId, siteUuid, userKey: 'app/first' }) }],
          list_complete: false,
          cursor: 'legacy-provider-cursor',
        };
  };

  const first = await worker.fetch(
    await request(
      '/v1/kv/list',
      { prefix: 'app/', limit: 1 },
      { authorization: await authHeader(claims({ scope: ['kv:list'] })) },
    ),
    gatewayEnv,
  );
  const legacyCursor = (await json(first)).cursor;
  assert.match(legacyCursor, /^v1\./);

  const resumed = await worker.fetch(
    await request(
      '/v1/kv/list',
      { prefix: 'app/', limit: 1, cursor: legacyCursor },
      { authorization: await authHeader(namespaceV2Claims('site', { scope: ['kv:list'] })) },
    ),
    gatewayEnv,
  );

  assert.equal(resumed.status, 200);
  assert.deepEqual(seenProviderCursors, [null, 'legacy-provider-cursor']);

  const mismatchedEnvelope = await worker.fetch(
    await request(
      '/v1/kv/list',
      { prefix: 'app/', limit: 1, cursor: legacyCursor.replace(/^v1\./, 'v2.') },
      { authorization: await authHeader(namespaceV2Claims('site', { scope: ['kv:list'] })) },
    ),
    gatewayEnv,
  );
  assert.equal(mismatchedEnvelope.status, 400);
  assert.equal((await json(mismatchedEnvelope)).error.code, 'INVALID_CURSOR');
});

test('set validates final wrapped metadata size before provider write', async () => {
  const gatewayEnv = env();

  const response = await worker.fetch(
    await request(
      '/v1/kv/set',
      {
        key: 'notes/welcome',
        value: 'hello',
        type: 'text',
        metadata: { value: 'x'.repeat(980) },
      },
      { authorization: await authHeader(claims({ scope: ['kv:set'] })) }
    ),
    gatewayEnv
  );

  assert.equal(response.status, 400);
  assert.deepEqual((await json(response)).error, { code: 'INVALID_METADATA', message: 'Invalid data metadata' });
  assert.equal(gatewayEnv.SITE_DATA.puts.length, 0);
});

test('set rejects missing json value before writing', async () => {
  const gatewayEnv = env();

  const response = await worker.fetch(
    await request('/v1/kv/set', { key: 'app/config', type: 'json' }, { authorization: await authHeader() }),
    gatewayEnv
  );

  assert.equal(response.status, 400);
  assert.deepEqual((await json(response)).error, { code: 'INVALID_JSON', message: 'Missing data value' });
  assert.equal(gatewayEnv.SITE_DATA.puts.length, 0);
});

test('set rejects missing text value before writing', async () => {
  const gatewayEnv = env();

  const response = await worker.fetch(
    await request('/v1/kv/set', { key: 'app/config', type: 'text' }, { authorization: await authHeader() }),
    gatewayEnv
  );

  assert.equal(response.status, 400);
  assert.deepEqual((await json(response)).error, { code: 'INVALID_JSON', message: 'Missing data value' });
  assert.equal(gatewayEnv.SITE_DATA.puts.length, 0);
});

test('set rejects null text value before writing', async () => {
  const gatewayEnv = env();

  const response = await worker.fetch(
    await request('/v1/kv/set', { key: 'app/config', value: null, type: 'text' }, { authorization: await authHeader() }),
    gatewayEnv
  );

  assert.equal(response.status, 400);
  assert.deepEqual((await json(response)).error, { code: 'INVALID_JSON', message: 'Invalid text data value' });
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
  assert.deepEqual((await json(response)).error, { code: 'KV_VALUE_TOO_LARGE', message: 'Data value is too large' });
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
  assert.deepEqual((await json(response)).error, {
    code: 'KV_DECODE_FAILED',
    message: 'Data value could not be decoded',
  });
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
