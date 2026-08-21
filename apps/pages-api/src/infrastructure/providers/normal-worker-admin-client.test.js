import assert from 'node:assert/strict';
import test from 'node:test';

import { createNormalWorkerAdminClient } from './normal-worker-admin-client.js';

test('normal worker admin client deletes the encoded Cloudflare script', async () => {
  const calls = [];
  const client = createNormalWorkerAdminClient({
    accountId: ' account-id ',
    apiToken: ' token ',
    fetch: async (...args) => {
      calls.push(args);
      return Response.json({ success: true, result: { deleted: true } });
    },
  });

  assert.deepEqual(await client.deleteWorker({ workerName: 'slot/one' }), { deleted: true });
  assert.equal(calls[0][0], 'https://api.cloudflare.com/client/v4/accounts/account-id/workers/scripts/slot%2Fone');
  assert.deepEqual(calls[0][1], {
    method: 'DELETE',
    headers: { Authorization: 'Bearer token' },
  });
});

test('normal worker admin client treats missing scripts as already deleted', async () => {
  const client = createNormalWorkerAdminClient({
    accountId: 'account-id',
    apiToken: 'token',
    fetch: async () => new Response(null, { status: 404 }),
  });

  assert.equal(await client.deleteWorker({ workerName: 'slot-one' }), null);
});

test('normal worker admin client classifies Cloudflare conflicts without exposing response details', async () => {
  const client = createNormalWorkerAdminClient({
    accountId: 'account-id',
    apiToken: 'token',
    fetch: async () =>
      Response.json({ success: false, errors: [{ message: 'still bound' }] }, { status: 409 }),
  });

  await assert.rejects(
    () => client.deleteWorker({ workerName: 'slot-one' }),
    (error) =>
      error.code === 'NORMAL_WORKER_DELETE_BLOCKED' &&
      error.status === 409 &&
      error.cloudflareErrors[0].message === 'still bound'
  );
});

test('normal worker admin client accepts an injected adapter and rejects missing configuration', () => {
  const injected = { deleteWorker: async () => null };
  assert.equal(createNormalWorkerAdminClient({ client: injected }), injected);
  assert.throws(() => createNormalWorkerAdminClient(), /NORMAL_WORKER_ADMIN_CLIENT_UNAVAILABLE/);
});
