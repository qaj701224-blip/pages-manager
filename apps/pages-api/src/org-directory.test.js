import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.js';
import { fetchOrgUsersByEmail, normalizeXdsUserItem, signXdsRequest } from './org-directory.js';
import { createTestPagesStore } from './test-store.js';

test('signXdsRequest signs timestamp, nonce, and token without returning the token', async () => {
  const signed = await signXdsRequest({
    ts: 1_700_000_000,
    nonce: 'nonce-test',
    token: 'secret-token',
  });

  assert.deepEqual(signed, {
    ts: '1700000000',
    nonce: 'nonce-test',
    sign: '6ad66fd2f8af5808198606749f2573619d8d95d9',
  });
  assert.equal(Object.values(signed).includes('secret-token'), false);
});

test('normalizeXdsUserItem extracts email, user id, status, name, and department path', () => {
  assert.deepEqual(
    normalizeXdsUserItem({
      email: ' User@XD.com ',
      userId: 'oa_123',
      realname: ' 示例用户 ',
      employee_status: '1',
      department_path: ' 心动 / 平台支撑部 / Web ',
    }),
    {
      email: 'user@xd.com',
      userId: 'oa_123',
      name: '示例用户',
      employeeStatus: 'active',
      departmentPath: '心动/平台支撑部/Web',
    }
  );
});

test('normalizeXdsUserItem tolerates XDS responses that only include department path', () => {
  assert.deepEqual(
    normalizeXdsUserItem({
      email: 'user@xd.com',
      deptPath: '心动/发行服务/平台支撑部',
    }),
    {
      email: 'user@xd.com',
      userId: null,
      name: null,
      employeeStatus: 'unknown',
      departmentPath: '心动/发行服务/平台支撑部',
    }
  );
});

test('fetchOrgUsersByEmail posts emails with signed XDS headers', async () => {
  const users = await fetchOrgUsersByEmail({
    emails: [' User@XD.com '],
    token: 'secret-token',
    nowSeconds: () => 1_700_000_000,
    nonce: () => 'nonce-test',
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://xds.xindong.com/xds-open-api/v1/oa-user/list-by-email');
      assert.equal(init.method, 'POST');
      assert.equal(init.headers['Content-Type'], 'application/json');
      assert.equal(init.headers['x-ts'], '1700000000');
      assert.equal(init.headers['x-nonce'], 'nonce-test');
      assert.equal(init.headers['x-sign'], '6ad66fd2f8af5808198606749f2573619d8d95d9');
      assert.deepEqual(JSON.parse(init.body), { emails: ['user@xd.com'] });
      return Response.json({
        code: 0,
        data: [
          {
            email: 'user@xd.com',
            departmentPath: '心动/技术平台/Web',
          },
        ],
      });
    },
  });

  assert.deepEqual(users, [
    {
      email: 'user@xd.com',
      userId: null,
      name: null,
      employeeStatus: 'unknown',
      departmentPath: '心动/技术平台/Web',
    },
  ]);
});

test('fetchOrgUsersByEmail defaults timestamp and nonce providers', async () => {
  const originalDateNow = Date.now;
  const originalRandomUuid = globalThis.crypto.randomUUID;
  Date.now = () => 1_700_000_123_456;
  globalThis.crypto.randomUUID = () => 'uuid-test';

  try {
    await fetchOrgUsersByEmail({
      emails: ['user@xd.com'],
      token: 'secret-token',
      fetchImpl: async (_url, init) => {
        assert.equal(init.headers['x-ts'], '1700000123');
        assert.equal(init.headers['x-nonce'], 'uuid-test');
        return Response.json({ code: 0, data: [] });
      },
    });
  } finally {
    Date.now = originalDateNow;
    globalThis.crypto.randomUUID = originalRandomUuid;
  }
});

test('fetchOrgUsersByEmail maps XDS transport and business failures to stable errors', async () => {
  await assert.rejects(
    fetchOrgUsersByEmail({
      emails: ['user@xd.com'],
      token: 'secret-token',
      fetchImpl: async () => new Response('unavailable', { status: 503 }),
    }),
    { code: 'XDS_REQUEST_FAILED' }
  );

  await assert.rejects(
    fetchOrgUsersByEmail({
      emails: ['user@xd.com'],
      token: 'secret-token',
      fetchImpl: async () => Response.json({ code: 10001, message: 'secret provider detail' }),
    }),
    { code: 'XDS_RESPONSE_FAILED' }
  );
});

test('internal department hydration requires internal host and hydrates the department team', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T10:00:00.000Z' });
  await store.createUser({
    userId: 'usr_1',
    email: 'user@xd.com',
    employeeStatus: 'active',
  });

  const publicResponse = await worker.fetch(
    jsonRequest(
      'https://api.pages.xd.team/.xd-pages/internal/users/hydrate-department',
      {
        userId: 'usr_1',
        email: 'user@xd.com',
        environment: 'production',
      },
      { 'CF-Connecting-IP': '10.1.2.3' }
    ),
    { PAGES_ENV: 'production', PAGES_STORE: store, IP_ALLOWLIST: '10.0.0.0/8' }
  );
  assert.equal(publicResponse.status, 404);

  const internalResponse = await worker.fetch(
    jsonRequest('https://pages-api.internal/.xd-pages/internal/users/hydrate-department', {
      userId: 'usr_1',
      email: 'user@xd.com',
      environment: 'production',
    }),
    {
      PAGES_ENV: 'production',
      PAGES_STORE: store,
      XDS_OPENAI_TOKEN: 'secret-token',
      now: () => '2026-07-01T10:00:00.000Z',
      XDS_FETCH: async () =>
        Response.json({
          code: 0,
          data: [{ email: 'user@xd.com', departmentPath: '心动/平台支撑部/Web' }],
        }),
    }
  );

  assert.equal(internalResponse.status, 200, await internalResponse.clone().text());
  const body = await internalResponse.json();
  assert.equal(body.hydration.status, 'hydrated');
  assert.equal(body.hydration.departmentPath, '心动/平台支撑部/Web');
  assert.equal((await store.getUser('usr_1')).departmentPath, '心动/平台支撑部/Web');
  assert.equal((await store.getUser('usr_1')).departmentCheckedAt, '2026-07-01T10:00:00.000Z');

  const teams = await store.listTeamsForUser({ environment: 'production', userId: 'usr_1' });
  assert.deepEqual(
    teams.map((team) => [team.name, team.teamType, team.currentUserRole]),
    [['心动/平台支撑部/Web', 'department', 'admin']]
  );
});

test('internal department hydration sends XDS requests through the VPC network binding', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T10:00:00.000Z' });
  await store.createUser({
    userId: 'usr_1',
    email: 'user@xd.com',
    employeeStatus: 'active',
  });
  let vpcFetchCalled = false;

  const response = await worker.fetch(
    jsonRequest('https://pages-api.internal/.xd-pages/internal/users/hydrate-department', {
      userId: 'usr_1',
      email: 'user@xd.com',
      environment: 'production',
    }),
    {
      PAGES_ENV: 'production',
      PAGES_STORE: store,
      XDS_OPENAI_TOKEN: 'secret-token',
      now: () => '2026-07-01T10:00:00.000Z',
      XD_OFFICE_NET: {
        fetch: async (url, init) => {
          vpcFetchCalled = true;
          assert.equal(url, 'https://xds.xindong.com/xds-open-api/v1/oa-user/list-by-email');
          assert.equal(init.method, 'POST');
          return Response.json({
            code: 0,
            data: [{ email: 'user@xd.com', departmentPath: '心动/平台支撑部/Web' }],
          });
        },
      },
    }
  );

  assert.equal(response.status, 200, await response.clone().text());
  assert.equal(vpcFetchCalled, true);
  assert.equal((await store.getUser('usr_1')).departmentPath, '心动/平台支撑部/Web');
});

test('internal department hydration returns unavailable when XDS VPC binding is missing', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T10:00:00.000Z' });
  await store.createUser({
    userId: 'usr_1',
    email: 'user@xd.com',
    employeeStatus: 'active',
  });
  const originalFetch = globalThis.fetch;
  let publicFetchCalled = false;

  globalThis.fetch = async () => {
    publicFetchCalled = true;
    return Response.json({
      code: 0,
      data: [{ email: 'user@xd.com', departmentPath: '心动/平台支撑部/Web' }],
    });
  };

  let response;
  try {
    response = await worker.fetch(
      jsonRequest('https://pages-api.internal/.xd-pages/internal/users/hydrate-department', {
        userId: 'usr_1',
        email: 'user@xd.com',
        environment: 'production',
      }),
      {
        PAGES_ENV: 'production',
        PAGES_STORE: store,
        XDS_OPENAI_TOKEN: 'secret-token',
      }
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { hydration: { status: 'unavailable' } });
  assert.equal(publicFetchCalled, false);
  assert.equal((await store.getUser('usr_1')).departmentPath, null);
});

test('internal department hydration returns unavailable without provider details', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T10:00:00.000Z' });
  await store.createUser({
    userId: 'usr_1',
    email: 'user@xd.com',
    employeeStatus: 'active',
  });

  const noToken = await worker.fetch(
    jsonRequest('https://pages-api.internal/.xd-pages/internal/users/hydrate-department', {
      userId: 'usr_1',
      email: 'user@xd.com',
      environment: 'production',
    }),
    { PAGES_ENV: 'production', PAGES_STORE: store }
  );
  assert.equal(noToken.status, 200);
  assert.deepEqual(await noToken.json(), { hydration: { status: 'unavailable' } });

  const failedXds = await worker.fetch(
    jsonRequest('https://pages-api.internal/.xd-pages/internal/users/hydrate-department', {
      userId: 'usr_1',
      email: 'user@xd.com',
      environment: 'production',
    }),
    {
      PAGES_ENV: 'production',
      PAGES_STORE: store,
      XDS_OPENAI_TOKEN: 'secret-token',
      XDS_FETCH: async () => Response.json({ code: 500, message: 'secret provider detail' }),
    }
  );
  const text = await failedXds.text();
  assert.equal(failedXds.status, 200);
  assert.equal(text.includes('secret provider detail'), false);
  assert.deepEqual(JSON.parse(text), { hydration: { status: 'unavailable' } });
});

test('internal department hydration rejects environment mismatch before calling XDS', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-01T10:00:00.000Z' });
  await store.createUser({
    userId: 'usr_1',
    email: 'user@xd.com',
    employeeStatus: 'active',
  });
  let xdsCalled = false;

  const response = await worker.fetch(
    jsonRequest('https://pages-api.internal/.xd-pages/internal/users/hydrate-department', {
      userId: 'usr_1',
      email: 'user@xd.com',
      environment: 'staging',
    }),
    {
      PAGES_ENV: 'production',
      PAGES_STORE: store,
      XDS_OPENAI_TOKEN: 'secret-token',
      XDS_FETCH: async () => {
        xdsCalled = true;
        return Response.json({ code: 0, data: [] });
      },
    }
  );

  assert.equal(response.status, 403);
  assert.equal((await response.json()).error.code, 'DEPARTMENT_HYDRATION_ENV_MISMATCH');
  assert.equal(xdsCalled, false);
});

function jsonRequest(url, body, headers = {}) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}
