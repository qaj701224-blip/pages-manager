import assert from 'node:assert/strict';
import test from 'node:test';
import { handleDeploy } from './deploy.js';

const existingUuid = '4b4c8e8361ef4b47b64f5c20a7db7c47';

function deployRequest({ token, kv, preset = 'static', files = [{ field: 'index', body: 'ok', name: 'index.html' }] } = {}) {
  const form = new FormData();
  form.set('name', 'demo');
  form.set('preset', preset);
  if (kv !== undefined) form.set('kv', kv);
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
    KV_GATEWAY_SERVICE: 'pages-kv-gateway',
    PAGES_CAP_JWT_ACTIVE_KID: 'prod-hs-2026-06',
    PAGES_CAP_JWT_KEYS: 'prod-hs-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606',
    PAGES_CAP_JWT_SECRET_202606: 'test-secret',
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

async function getDeployMetadata(calls) {
  const deployCall = calls.find(
    (call) => call.options.method === 'PUT' && call.url.includes('/workers/scripts/pages-demo')
  );
  assert.ok(deployCall, 'expected worker deploy call');
  const blob = deployCall.options.body.get('metadata');
  return JSON.parse(await blob.text());
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

test('deploy rejects static kv before touching Cloudflare', async () => {
  const mock = installCloudflareMock();
  try {
    const response = await handleDeploy(
      deployRequest({ token: 'pages_owner@xd.com', kv: 'true', preset: 'static' }),
      envForDeploy(null)
    );
    const body = await response.json();

    assert.equal(response.status, 400);
    assert.equal(body.error, 'static preset 暂不支持 kv');
    assert.equal(body.field, 'preset');
    assert.equal(body.value, 'static');
    assert.match(body.hint, /spa|worker/);
    assert.equal(mock.calls.length, 0);
  } finally {
    mock.restore();
  }
});

test('kv=true deploy preserves existing siteUuid and returns kv flag without leaking capability', async () => {
  const mock = installCloudflareMock();
  const putCalls = [];

  try {
    const response = await handleDeploy(
      deployRequest({ token: 'pages_owner@xd.com', kv: 'true', preset: 'spa' }),
      envForDeploy(
        {
          token: 'pages_owner@xd.com',
          siteUuid: existingUuid,
          siteGeneration: 2,
          createdAt: '2026-01-01T00:00:00.000Z',
        },
        putCalls
      )
    );
    const body = await response.json();
    const metadata = await getDeployMetadata(mock.calls);

    assert.equal(response.status, 200);
    assert.equal(body.kv, true);
    assert.equal(putCalls[0].value.kvEnabled, true);
    assert.equal(putCalls[0].value.siteUuid, existingUuid);
    assert.equal(putCalls[0].value.siteGeneration, 3);
    assert.equal(putCalls[0].options.metadata.kvEnabled, true);
    assert.equal(putCalls[0].options.metadata.siteUuid, existingUuid);
    assert.equal(putCalls[0].options.metadata.siteGeneration, 3);
    assert.ok(metadata.bindings.some((binding) => binding.name === 'XD_PAGES_KV_CAPABILITY'));
    assert.doesNotMatch(JSON.stringify(body), /capability|jwt|test-secret/i);
    assert.doesNotMatch(JSON.stringify(putCalls), /capability|jwt|test-secret/i);
  } finally {
    mock.restore();
  }
});

test('kv=true deploy logs do not leak capability, jwt or secrets echoed by Cloudflare', async () => {
  const mock = installCloudflareMock({
    deployResult: {
      id: 'pages-demo',
      metadata: {
        bindings: [{ name: 'XD_PAGES_KV_CAPABILITY', text: 'capability.jwt' }],
      },
      secret: 'test-secret',
      jwt: 'upload-jwt',
    },
  });
  const originalLog = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.map(String).join(' '));

  try {
    const response = await handleDeploy(
      deployRequest({ token: 'pages_owner@xd.com', kv: 'true', preset: 'spa' }),
      envForDeploy({
        token: 'pages_owner@xd.com',
        siteUuid: existingUuid,
        siteGeneration: 2,
        createdAt: '2026-01-01T00:00:00.000Z',
      })
    );
    await response.json();

    const text = logs.join('\n');
    assert.doesNotMatch(text, /XD_PAGES_KV_CAPABILITY/);
    assert.doesNotMatch(text, /capability\.jwt/);
    assert.doesNotMatch(text, /test-secret/);
    assert.doesNotMatch(text, /upload-jwt/);
    assert.doesNotMatch(text, /jwt/i);
  } finally {
    console.log = originalLog;
    mock.restore();
  }
});

test('deploy failure response redacts Cloudflare capability and JWT echo', async () => {
  const mock = installCloudflareMock({
    deployFailure: {
      status: 400,
      body: {
        success: false,
        errors: [
          {
            code: 10021,
            message: [
              'metadata XD_PAGES_KV_CAPABILITY capability.jwt',
              'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature',
              'PAGES_CAP_JWT_SECRET_202606',
            ].join(' '),
          },
        ],
      },
    },
  });

  try {
    const response = await handleDeployHttpResponse(
      deployRequest({ token: 'pages_owner@xd.com', kv: 'true', preset: 'spa' }),
      envForDeploy({ token: 'pages_owner@xd.com', siteUuid: existingUuid, siteGeneration: 2 })
    );
    const body = await response.json();
    const text = JSON.stringify(body);

    assert.equal(response.status, 400);
    assert.doesNotMatch(text, /XD_PAGES_KV_CAPABILITY/);
    assert.doesNotMatch(text, /capability\.jwt/);
    assert.doesNotMatch(text, /eyJhbGciOiJIUzI1NiJ9\.eyJzdWIiOiIxIn0\.signature/);
    assert.doesNotMatch(text, /Bearer /);
    assert.doesNotMatch(text, /PAGES_CAP_JWT_SECRET/);
  } finally {
    mock.restore();
  }
});

test('missing or false kv does not require JWT env vars and returns kv false', async () => {
  for (const kv of [undefined, 'false']) {
    const mock = installCloudflareMock();
    try {
      const env = envForDeploy(null);
      delete env.PAGES_CAP_JWT_ACTIVE_KID;
      delete env.PAGES_CAP_JWT_KEYS;
      delete env.PAGES_CAP_JWT_SECRET_202606;

      const response = await handleDeploy(deployRequest({ token: 'pages_owner@xd.com', kv }), env);
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.kv, false);
    } finally {
      mock.restore();
    }
  }
});

test('new kv=true site generates 32 lowercase hex siteUuid', async () => {
  const mock = installCloudflareMock();
  const putCalls = [];

  try {
    const response = await handleDeploy(
      deployRequest({ token: 'pages_owner@xd.com', kv: 'true', preset: 'spa' }),
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
      deployRequest({ token: 'pages_owner@xd.com', kv: 'true', preset: 'spa' }),
      envForDeploy({ token: 'pages_owner@xd.com', siteUuid: existingUuid, siteGeneration: 4 }, putCalls)
    );
    assert.equal(sameTokenResponse.status, 200);
    assert.equal(putCalls[0].value.siteUuid, existingUuid);
    assert.equal(putCalls[0].value.siteGeneration, 5);

    const conflictResponse = await handleDeploy(
      deployRequest({ token: 'pages_other@xd.com', kv: 'true', preset: 'spa' }),
      envForDeploy({ token: 'pages_owner@xd.com', siteUuid: existingUuid, siteGeneration: 4 })
    );
    const body = await conflictResponse.json();
    assert.equal(conflictResponse.status, 409);
    assert.equal(body.error, '站点名称已被占用');
  } finally {
    mock.restore();
  }
});

test('worker preset with kv warning includes bundling and capability boundary', async () => {
  const mock = installCloudflareMock();
  try {
    const response = await handleDeploy(
      deployRequest({
        token: 'pages_owner@xd.com',
        kv: 'true',
        preset: 'worker',
        files: [
          {
            field: 'worker',
            body: 'export default { async fetch() { return new Response("ok"); } };',
            name: '_worker.js',
            type: 'application/javascript',
          },
        ],
      }),
      envForDeploy(null)
    );
    const body = await response.json();

    assert.equal(response.status, 200);
    assert.match(body.warning, /@xd\/pages-sdk\/worker/);
    assert.match(body.warning, /capability/);
    assert.match(body.warning, /暴露/);
  } finally {
    mock.restore();
  }
});
