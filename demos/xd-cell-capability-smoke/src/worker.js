const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') return jsonResponse(healthPayload(env));
    if (url.pathname === '/api/env') return jsonResponse(envPayload(env));
    if (url.pathname === '/api/echo') return echoRequest(request, env);
    if (url.pathname.startsWith('/api/runtime-data/')) return handleRuntimeDataRequest(request, env);
    if (url.pathname === '/api/routes') return jsonResponse(routePayload());

    return env.ASSETS.fetch(request);
  },
};

function healthPayload(env) {
  return {
    ok: true,
    demo: 'xd-cell-capability-smoke',
    checks: {
      assetsBinding: Boolean(env.ASSETS),
      kvGatewayBinding: Boolean(env.XD_PAGES_KV_GATEWAY),
      vars: {
        API_BASE: env.API_BASE || null,
        DEMO_LABEL: env.DEMO_LABEL || null,
        FEATURE_FLAG: env.FEATURE_FLAG || null,
      },
      secrets: {
        hasApiToken: typeof env.API_TOKEN === 'string' && env.API_TOKEN.length > 0,
      },
    },
  };
}

function envPayload(env) {
  return {
    vars: {
      API_BASE: env.API_BASE || null,
      DEMO_LABEL: env.DEMO_LABEL || null,
      FEATURE_FLAG: env.FEATURE_FLAG || null,
    },
    secrets: {
      hasApiToken: typeof env.API_TOKEN === 'string' && env.API_TOKEN.length > 0,
    },
    bindings: {
      ASSETS: Boolean(env.ASSETS),
      XD_PAGES_KV_GATEWAY: Boolean(env.XD_PAGES_KV_GATEWAY),
    },
  };
}

async function echoRequest(request, env) {
  const url = new URL(request.url);
  return jsonResponse({
    method: request.method,
    path: url.pathname,
    search: url.search,
    featureFlag: env.FEATURE_FLAG || null,
    userAgent: request.headers.get('user-agent') || null,
  });
}

async function handleRuntimeDataRequest(request, env) {
  const body = request.method === 'POST' ? await readJson(request) : {};
  return jsonResponse({
    ok: true,
    requestedKey: typeof body.key === 'string' ? body.key : null,
    gatewayBindingPresent: Boolean(env.XD_PAGES_KV_GATEWAY),
    sdkRecommended: '@xd-cell/worker-sdk createRuntime({ env, request }).kv',
    note: 'This demo avoids raw gateway calls because runtime data requires router-injected capabilities.',
  });
}

function routePayload() {
  return {
    routes: [
      { method: 'GET', path: '/api/health' },
      { method: 'GET', path: '/api/env' },
      { method: 'GET', path: '/api/echo' },
      { method: 'POST', path: '/api/runtime-data/check' },
      { method: 'GET', path: '/*', handledBy: 'ASSETS with SPA fallback' },
    ],
  };
}

async function readJson(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: JSON_HEADERS,
  });
}
