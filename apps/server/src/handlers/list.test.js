import assert from 'node:assert/strict';
import test from 'node:test';
import { handleList } from './list.js';

function envWithSites(keys) {
  return {
    SITES: {
      async list() {
        return { keys };
      },
    },
  };
}

test('list requires a token', async () => {
  const response = await handleList(
    new Request('https://api.workers.xd.team/list'),
    envWithSites([{ name: 'demo', metadata: { token: 'pages_user@xd.com' } }])
  );
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error, '缺少 token');
});

test('list filters by token and does not expose tokens', async () => {
  const response = await handleList(
    new Request('https://api.workers.xd.team/list', {
      headers: { 'X-Pages-Token': 'pages_user@xd.com' },
    }),
    envWithSites([
      {
        name: 'owned',
        metadata: {
          url: 'https://owned.workers.xd.team',
          token: 'pages_user@xd.com',
        },
      },
      {
        name: 'other',
        metadata: {
          url: 'https://other.workers.xd.team',
          token: 'pages_other@xd.com',
        },
      },
    ])
  );
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, {
    sites: [
      {
        name: 'owned',
        url: 'https://owned.workers.xd.team',
      },
    ],
    filtered: true,
  });
});
