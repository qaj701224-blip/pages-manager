import assert from 'node:assert/strict';
import test from 'node:test';
import { handleDeploy } from './deploy.js';

const existingUuid = '4b4c8e8361ef4b47b64f5c20a7db7c47';

function deployRequest({
  name = 'demo',
  token,
  kv,
  ipRestrict,
  preset = 'static',
  files = [{ field: 'index', body: 'ok', name: 'index.html' }],
} = {}) {
  const form = new FormData();
  form.set('name', name);
  form.set('preset', preset);
  if (kv !== undefined) form.set('kv', kv);
  if (ipRestrict !== undefined) form.set('ip_restrict', ipRestrict);
  for (const file of files) {
    form.append(file.field, new Blob([file.body], { type: file.type || 'text/html' }), file.name);
  }

  return new Request('https://api.workers.xd.team/deploy', {
    method: 'POST',
    headers: token ? { 'X-Pages-Token': token } : {},
    body: form,
  });
}

function envWithExistingSite(existing) {
  return {
    CF_API_TOKEN: 'dummy-token',
    CF_ACCOUNT_ID: 'dummy-account',
    CF_ZONE_ID_NEW: 'dummy-zone',
    WORKER_PREFIX: 'pages-',
    DOMAIN_LABEL: '',
    DOMAIN_BASE: 'workers.xd.team',
    WORKERS_DEV_SUBDOMAIN: 'xd-cf-2022',
    IP_ALLOWLIST: '127.0.0.1',
    PUBLIC_ENVIRONMENT: 'production',
    SITES: {
      async get() {
        return existing;
      },
      async put() {
        throw new Error('conflicting deployments must not write metadata');
      },
    },
  };
}

function hostnameClaimsBinding(handler) {
  return {
    async fetch(request) {
      const operation = new URL(request.url).pathname.split('/').pop();
      const body = await request.json();
      const result = await handler(operation, body.claim);
      if (result instanceof Response) return result;
      if (result?.ok === false) {
        return Response.json({ error: { code: result.code, message: result.message } }, { status: 409 });
      }
      return Response.json(result || { claim: body.claim });
    },
  };
}

test('deploy rejects requests without a token before touching storage or Cloudflare', async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    return new Response(JSON.stringify({ success: true, result: {} }));
  };

  try {
    const response = await handleDeploy(deployRequest(), {
      SITES: {
        async get() {
          throw new Error('missing token requests must not read metadata');
        },
      },
    });

    const body = await response.json();
    assert.equal(response.status, 400);
    assert.equal(body.error, '缺少部署者 token');
    assert.equal(body.field, 'token');
    assert.equal(calls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deploy conflict response does not expose existing owner token', async () => {
  const response = await handleDeploy(
    deployRequest({ token: 'pages_other@xd.com' }),
    envWithExistingSite({ token: 'pages_owner@xd.com', createdAt: '2026-01-01T00:00:00.000Z' })
  );

  const body = await response.json();
  assert.equal(response.status, 409);
  assert.equal(body.error, '站点名称已被占用');
  assert.equal(body.name, 'demo');
  assert.equal(body.owner, undefined);
  assert.doesNotMatch(JSON.stringify(body), /pages_owner@xd\.com/);
});

test('deploy rejects platform reserved site names before touching storage or Cloudflare', async () => {
  const reservedNames = [
    'api',
    'api-staging',
    'manager',
    'manager-staging',
    'kv-gateway',
    'kv-gateway-staging',
    'auth',
    'auth-staging',
    'router',
    'router-staging',
    'v2-production-slot-001',
    'v2-staging-slot-001',
  ];
  const fetchCalls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    fetchCalls.push(String(url));
    return Response.json({ success: true, result: {} });
  };

  try {
    for (const name of reservedNames) {
      const response = await handleDeploy(deployRequest({ name, token: 'pages_owner@xd.com' }), {
        SITES: {
          async get() {
            throw new Error('reserved names must not read metadata');
          },
        },
      });
      const body = await response.json();

      assert.equal(response.status, 400);
      assert.equal(body.error, '站点名称为平台保留名称');
      assert.equal(body.name, name);
      assert.match(body.hint, /平台保留|保留名称/);
    }

    assert.equal(fetchCalls.length, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function installCloudflareMock({ deployResult = { ok: true }, deployFailure = null } = {}) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options = {}) => {
    const call = { url: String(url), options };
    calls.push(call);

    if (call.url.includes('/assets-upload-session')) {
      return Response.json({ success: true, result: { jwt: 'upload-jwt', buckets: [] } });
    }
    if (call.url.includes('/workers/routes') && options.method !== 'POST' && options.method !== 'PUT') {
      return Response.json({ success: true, result: [] });
    }
    if (call.url.includes('/workers/scripts/pages-demo') && options.method === 'PUT') {
      if (deployFailure) return Response.json(deployFailure.body, { status: deployFailure.status || 400 });
      return Response.json({ success: true, result: deployResult });
    }
    return Response.json({ success: true, result: { ok: true } });
  };

  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function envForDeploy(existing, putCalls = []) {
  return {
    ...envWithExistingSite(existing),
    SITES: {
      async get() {
        return existing;
      },
      async put(key, value, options) {
        putCalls.push({ key, value: JSON.parse(value), options });
      },
    },
  };
}

async function handleDeployHttpResponse(request, env) {
  try {
    return await handleDeploy(request, env);
  } catch (err) {
    return Response.json({ error: err.message, errors: err.errors }, { status: err.status || 500 });
  }
}

test('deploy rejects invalid kv before touching Cloudflare', async () => {
  const mock = installCloudflareMock();
  try {
    const response = await handleDeploy(deployRequest({ token: 'pages_owner@xd.com', kv: 'worker' }), envForDeploy(null));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.deepEqual(body, {
      error: '无效的 kv 参数',
      field: 'kv',
      value: 'worker',
      hint: 'kv 仅支持 true 或 false',
    });
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('deploy rejects kv=true because v1 Pages KV is retired before touching Cloudflare', async () => {
  const mock = installCloudflareMock();
  try {
    const response = await handleDeploy(
      deployRequest({ token: 'pages_owner@xd.com', kv: 'true', preset: 'spa' }),
      envForDeploy(null)
    );
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.code, 'KV_NOT_SUPPORTED');
    assert.equal(body.field, 'kv');
    assert.equal(body.value, 'true');
    assert.match(body.hint, /v2|pages\.xd\.team/);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('deploy rejects ip_restrict=false before touching Cloudflare', async () => {
  const mock = installCloudflareMock();

  try {
    const response = await handleDeploy(deployRequest({ token: 'pages_owner@xd.com', ipRestrict: 'false' }), envForDeploy(null));
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, '当前版本不支持关闭 IP 限制');
    assert.equal(body.field, 'ip_restrict');
    assert.equal(body.value, 'false');
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('deploy enforces hostname claim before touching Cloudflare', async () => {
  const mock = installCloudflareMock();
  const claimCalls = [];

  try {
    const env = {
      ...envForDeploy(null),
      HOSTNAME_CLAIMS_MODE: 'enforce',
      HOSTNAME_CLAIMS: hostnameClaimsBinding(async (operation, input) => {
        assert.equal(operation, 'acquire');
        claimCalls.push(input);
        return {
          ok: false,
          code: 'HOSTNAME_CLAIM_CONFLICT',
          message: 'hostname is already claimed',
        };
      }),
    };

    const response = await handleDeploy(deployRequest({ token: 'pages_owner@xd.com', preset: 'spa' }), env);
    const body = await response.json();

    assert.equal(response.status, 409);
    assert.equal(body.code, 'HOSTNAME_CLAIM_CONFLICT');
    assert.equal(mock.calls.length, 0);
    assert.deepEqual(claimCalls, [
      {
        environment: 'production',
        hostname: 'demo.workers.xd.team',
        normalizedSlug: 'demo',
        hostnameFamily: 'workers',
        ownerSystem: 'v1',
        ownerId: 'v1:production:demo',
        ownerRef: 'pages-demo',
        source: 'v1_deploy',
        status: 'pending',
      },
    ]);
  } finally {
    mock.restore();
  }
});

test('deploy record_only hostname claim mode records but does not block deploy', async () => {
  const mock = installCloudflareMock();
  const putCalls = [];
  const claimCalls = [];

  try {
    const env = {
      ...envForDeploy(null, putCalls),
      HOSTNAME_CLAIMS_MODE: 'record_only',
      HOSTNAME_CLAIMS: hostnameClaimsBinding(async (operation, input) => {
        assert.equal(operation, 'acquire');
        claimCalls.push(input);
        return { ok: false, code: 'HOSTNAME_CLAIM_CONFLICT' };
      }),
    };

    const response = await handleDeploy(deployRequest({ token: 'pages_owner@xd.com', preset: 'spa' }), env);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.name, 'demo');
    assert.equal(putCalls.length, 1);
    assert.equal(claimCalls.length, 1);
    assert.ok(mock.calls.some((call) => call.url.includes('/workers/scripts/pages-demo')));
  } finally {
    mock.restore();
  }
});

test('deploy record_only hostname claim mode ignores claim service failures', async () => {
  const mock = installCloudflareMock();
  const putCalls = [];

  try {
    const env = {
      ...envForDeploy(null, putCalls),
      HOSTNAME_CLAIMS_MODE: 'record_only',
      HOSTNAME_CLAIMS: {
        async acquire() {
          throw new Error('service unavailable');
        },
      },
    };

    const response = await handleDeploy(deployRequest({ token: 'pages_owner@xd.com', preset: 'spa' }), env);
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.equal(body.name, 'demo');
    assert.equal(putCalls.length, 1);
    assert.ok(mock.calls.some((call) => call.url.includes('/workers/scripts/pages-demo')));
  } finally {
    mock.restore();
  }
});

test('deploy confirms pending hostname claims after metadata is written', async () => {
  const mock = installCloudflareMock();
  const operations = [];

  try {
    const env = {
      ...envForDeploy(null),
      HOSTNAME_CLAIMS_MODE: 'enforce',
      HOSTNAME_CLAIMS: hostnameClaimsBinding(async (operation, input) => {
        if (operation === 'acquire') operations.push(['acquire', input.status]);
        if (operation === 'confirm') operations.push(['confirm', input.hostname]);
        return { claim: input };
      }),
    };

    const response = await handleDeploy(deployRequest({ token: 'pages_owner@xd.com', preset: 'spa' }), env);

    assert.equal(response.status, 200);
    assert.deepEqual(operations, [
      ['acquire', 'pending'],
      ['confirm', 'demo.workers.xd.team'],
    ]);
  } finally {
    mock.restore();
  }
});

test('deploy releases pending hostname claim when new site deploy fails', async () => {
  const mock = installCloudflareMock({
    deployFailure: {
      status: 400,
      body: { success: false, errors: [{ message: 'deploy failed' }] },
    },
  });
  const operations = [];

  try {
    const env = {
      ...envForDeploy(null),
      HOSTNAME_CLAIMS_MODE: 'enforce',
      HOSTNAME_CLAIMS: hostnameClaimsBinding(async (operation, input) => {
        if (operation === 'acquire') operations.push(['acquire', input.status]);
        if (operation === 'release') operations.push(['release', input.releaseReason]);
        return { claim: input };
      }),
    };

    await assert.rejects(() => handleDeploy(deployRequest({ token: 'pages_owner@xd.com', preset: 'spa' }), env), /deploy failed/);
    assert.deepEqual(operations, [
      ['acquire', 'pending'],
      ['release', 'v1_deploy_failed'],
    ]);
  } finally {
    mock.restore();
  }
});

test('deploy does not release pending hostname claim after metadata is written', async () => {
  const mock = installCloudflareMock();
  const operations = [];
  const putCalls = [];

  try {
    const env = {
      ...envForDeploy(null, putCalls),
      HOSTNAME_CLAIMS_MODE: 'enforce',
      HOSTNAME_CLAIMS: hostnameClaimsBinding(async (operation, input) => {
        if (operation === 'acquire') {
          operations.push(['acquire', input.status]);
          return { claim: input };
        }
        if (operation === 'confirm') {
          operations.push(['confirm', 'failed']);
          return { ok: false, code: 'HOSTNAME_CLAIM_CONFIRM_FAILED' };
        }
        if (operation === 'release') operations.push(['release', input.releaseReason]);
        return { claim: input };
      }),
    };

    await assert.rejects(
      () => handleDeploy(deployRequest({ token: 'pages_owner@xd.com', preset: 'spa' }), env),
      /HOSTNAME_CLAIM_CONFIRM_FAILED/
    );
    assert.equal(putCalls.length, 1);
    assert.deepEqual(operations, [
      ['acquire', 'pending'],
      ['confirm', 'failed'],
    ]);
  } finally {
    mock.restore();
  }
});

test('deploy can acquire hostname claims through pages-api service binding without leaking token', async () => {
  const mock = installCloudflareMock();
  const serviceRequests = [];

  try {
    const env = {
      ...envForDeploy(null),
      HOSTNAME_CLAIMS_MODE: 'enforce',
      HOSTNAME_CLAIMS: {
        async fetch(request) {
          serviceRequests.push({
            url: request.url,
            method: request.method,
            body: await request.json(),
          });
          return Response.json({ claim: { hostname: 'demo.workers.xd.team' } });
        },
      },
    };

    const response = await handleDeploy(deployRequest({ token: 'pages_owner@xd.com', preset: 'spa' }), env);
    assert.equal(response.status, 200);
    assert.equal(serviceRequests[0].url, 'https://pages-api.internal/.xd-pages/internal/hostname-claims/acquire');
    assert.equal(serviceRequests[0].method, 'POST');
    assert.doesNotMatch(JSON.stringify(serviceRequests[0].body), /pages_owner@xd\.com/);
    assert.equal(serviceRequests[1].url, 'https://pages-api.internal/.xd-pages/internal/hostname-claims/confirm');
  } finally {
    mock.restore();
  }
});

test('deploy uses service binding fetch even when hostname claim RPC-like methods exist', async () => {
  const mock = installCloudflareMock();
  const serviceRequests = [];

  try {
    const env = {
      ...envForDeploy(null),
      HOSTNAME_CLAIMS_MODE: 'enforce',
      HOSTNAME_CLAIMS: {
        async acquire() {
          throw new Error('rpc acquire must not be called');
        },
        async confirm() {
          throw new Error('rpc confirm must not be called');
        },
        async fetch(request) {
          serviceRequests.push({
            url: request.url,
            method: request.method,
          });
          return Response.json({ claim: { hostname: 'demo.workers.xd.team' } });
        },
      },
    };

    const response = await handleDeploy(deployRequest({ token: 'pages_owner@xd.com', preset: 'spa' }), env);

    assert.equal(response.status, 200);
    assert.deepEqual(
      serviceRequests.map((request) => [request.method, request.url]),
      [
        ['POST', 'https://pages-api.internal/.xd-pages/internal/hostname-claims/acquire'],
        ['POST', 'https://pages-api.internal/.xd-pages/internal/hostname-claims/confirm'],
      ]
    );
  } finally {
    mock.restore();
  }
});

test('deploy logs do not leak Cloudflare JWT echoes', async () => {
  const mock = installCloudflareMock({
    deployResult: {
      id: 'pages-demo',
      jwt: 'upload-jwt',
    },
  });
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.map(String).join(' '));

  try {
    const response = await handleDeploy(
      deployRequest({ token: 'pages_owner@xd.com', preset: 'spa' }),
      envForDeploy({
        token: 'pages_owner@xd.com',
        siteUuid: existingUuid,
        siteGeneration: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
      })
    );
    await response.json();

    const text = logs.join('\n');
    assert.doesNotMatch(text, /upload-jwt/);
    assert.doesNotMatch(text, /jwt/i);
  } finally {
    console.log = originalLog;
    mock.restore();
  }
});

test('deploy failure response redacts Cloudflare JWT echo', async () => {
  const mock = installCloudflareMock({
    deployFailure: {
      status: 400,
      body: {
        success: false,
        errors: [
          {
            code: 10021,
            message: ['Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature'].join(' '),
            source: {
              pointer: '/bindings/SECRET/Bearer nested.token.value',
            },
          },
        ],
      },
    },
  });

  try {
    const response = await handleDeployHttpResponse(
      deployRequest({ token: 'pages_owner@xd.com', preset: 'spa' }),
      envForDeploy({ token: 'pages_owner@xd.com', siteUuid: existingUuid, siteGeneration: 2 })
    );
    const body = await response.json();
    const text = JSON.stringify(body);

    assert.equal(response.status, 400);
    assert.doesNotMatch(text, /eyJhbGciOiJIUzI1NiJ9\.eyJzdWIiOiIxIn0\.signature/);
    assert.doesNotMatch(text, /Bearer /);
  } finally {
    mock.restore();
  }
});

test('missing or false kv does not require JWT env vars and returns kv false', async () => {
  for (const kv of [undefined, 'false']) {
    const mock = installCloudflareMock();
    try {
      const env = envForDeploy(null);

      const response = await handleDeploy(deployRequest({ token: 'pages_owner@xd.com', kv }), env);
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.kv, undefined);
    } finally {
      mock.restore();
    }
  }
});

test('new site generates 32 lowercase hex siteUuid for stable metadata', async () => {
  const mock = installCloudflareMock();
  const putCalls = [];

  try {
    const response = await handleDeploy(
      deployRequest({ token: 'pages_owner@xd.com', preset: 'spa' }),
      envForDeploy(null, putCalls)
    );
    await response.json();

    assert.match(putCalls[0].value.siteUuid, /^[0-9a-f]{32}$/);
    assert.equal(putCalls[0].value.siteGeneration, 1);
  } finally {
    mock.restore();
  }
});

test('same token redeploy preserves UUID while different token conflict is rejected', async () => {
  const mock = installCloudflareMock();
  const putCalls = [];

  try {
    const sameTokenResponse = await handleDeploy(
      deployRequest({ token: 'pages_owner@xd.com', preset: 'spa' }),
      envForDeploy({ token: 'pages_owner@xd.com', siteUuid: existingUuid, siteGeneration: 4 }, putCalls)
    );
    assert.equal(sameTokenResponse.status, 200);
    assert.equal(putCalls[0].value.siteUuid, existingUuid);
    assert.equal(putCalls[0].value.siteGeneration, 5);

    const conflictResponse = await handleDeploy(
      deployRequest({ token: 'pages_other@xd.com', preset: 'spa' }),
      envForDeploy({ token: 'pages_owner@xd.com', siteUuid: existingUuid, siteGeneration: 4 })
    );
    const body = await conflictResponse.json();
    assert.equal(conflictResponse.status, 409);
    assert.equal(body.error, '站点名称已被占用');
  } finally {
    mock.restore();
  }
});
