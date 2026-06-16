import assert from 'node:assert/strict';
import test from 'node:test';

import { PagesSDKError, createPagesClient } from '../dist/browser.js';

test("createPagesClient().kv.get posts to the runtime get endpoint and returns value", async () => {
  let captured;
  const client = createPagesClient({
    fetch: async (url, init) => {
      captured = { url, init };
      return Response.json({ ok: true, found: true, value: { theme: 'dark' } });
    },
  });

  const value = await client.kv.get('app/config');

  assert.deepEqual(value, { theme: 'dark' });
  assert.equal(captured.url, '/.xd-pages/runtime/v1/kv/get');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['Content-Type'], 'application/json');
  assert.equal(captured.init.headers['X-XD-Pages-Runtime'], '1');
  assert.deepEqual(JSON.parse(captured.init.body), { key: 'app/config', type: 'json' });
});

test('createPagesClient().kv.get returns null when runtime reports missing key', async () => {
  const client = createPagesClient({
    fetch: async () => Response.json({ ok: true, found: false }),
  });

  assert.equal(await client.kv.get('missing'), null);
});

test('createPagesClient().kv.set posts to the runtime set endpoint', async () => {
  let captured;
  const client = createPagesClient({
    fetch: async (url, init) => {
      captured = { url, init };
      return Response.json({ ok: true });
    },
  });

  await client.kv.set('app/config', { theme: 'light' }, { expirationTtl: 60 });

  assert.equal(captured.url, '/.xd-pages/runtime/v1/kv/set');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['Content-Type'], 'application/json');
  assert.equal(captured.init.headers['X-XD-Pages-Runtime'], '1');
  assert.deepEqual(JSON.parse(captured.init.body), {
    key: 'app/config',
    value: { theme: 'light' },
    type: 'json',
    expirationTtl: 60,
  });
});

test('createPagesClient().kv.delete posts to the runtime delete endpoint', async () => {
  let captured;
  const client = createPagesClient({
    fetch: async (url, init) => {
      captured = { url, init };
      return Response.json({ ok: true });
    },
  });

  await client.kv.delete('app/config');

  assert.equal(captured.url, '/.xd-pages/runtime/v1/kv/delete');
  assert.equal(captured.init.method, 'POST');
  assert.equal(captured.init.headers['Content-Type'], 'application/json');
  assert.equal(captured.init.headers['X-XD-Pages-Runtime'], '1');
  assert.deepEqual(JSON.parse(captured.init.body), { key: 'app/config' });
});

test('createPagesClient throws PagesSDKError for non-JSON runtime response', async () => {
  const client = createPagesClient({
    fetch: async () => new Response('not json', { headers: { 'Content-Type': 'text/plain' } }),
  });

  await assert.rejects(() => client.kv.get('app/config'), (error) => {
    assert.ok(error instanceof PagesSDKError);
    assert.equal(error.code, 'INVALID_RUNTIME_RESPONSE');
    return true;
  });
});

test('createPagesClient throws runtime error envelopes with code and message', async () => {
  const client = createPagesClient({
    fetch: async () => Response.json({ ok: false, error: { code: 'KV_FAILED', message: 'KV failed' } }, { status: 502 }),
  });

  await assert.rejects(() => client.kv.get('app/config'), (error) => {
    assert.ok(error instanceof PagesSDKError);
    assert.equal(error.code, 'KV_FAILED');
    assert.equal(error.message, 'KV failed');
    assert.equal(error.status, 502);
    return true;
  });
});

test('createPagesClient throws invalid runtime response for get envelopes without found', async () => {
  const client = createPagesClient({
    fetch: async () => Response.json({ ok: true }),
  });

  await assert.rejects(() => client.kv.get('app/config'), {
    code: 'INVALID_RUNTIME_RESPONSE',
  });
});
