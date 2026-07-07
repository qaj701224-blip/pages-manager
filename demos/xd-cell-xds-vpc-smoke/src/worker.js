const XDS_SEARCH_URL = 'https://xds.xindong.com/xds-open-api/v1/oa-user/search';
const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') return jsonResponse(healthPayload(env));
    if (url.pathname === '/api/xds-search') return handleXdsSearch(request, env);

    return env.ASSETS.fetch(request);
  },
};

function healthPayload(env) {
  return {
    ok: true,
    demo: 'xd-cell-xds-vpc-smoke',
    vars: {
      XDS_SEARCH_KEYWORD: env.XDS_SEARCH_KEYWORD || null,
    },
    secret: {
      secretPresent: typeof env.XDS_OPENAI_TOKEN === 'string' && env.XDS_OPENAI_TOKEN.length > 0,
    },
    bindings: {
      ASSETS: Boolean(env.ASSETS),
      XD_OFFICE_NET: Boolean(env.XD_OFFICE_NET && typeof env.XD_OFFICE_NET.fetch === 'function'),
    },
  };
}

async function handleXdsSearch(request, env) {
  const token = typeof env.XDS_OPENAI_TOKEN === 'string' ? env.XDS_OPENAI_TOKEN.trim() : '';
  const vpc = env.XD_OFFICE_NET;
  const url = new URL(request.url);
  const keyword = normalizeKeyword(url.searchParams.get('keyword') || env.XDS_SEARCH_KEYWORD);

  if (!token) {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: 'XDS_TOKEN_MISSING',
          message: 'XDS_OPENAI_TOKEN secret is not configured.',
        },
        secret: { secretPresent: false },
      },
      503
    );
  }
  if (!vpc || typeof vpc.fetch !== 'function') {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: 'VPC_BINDING_MISSING',
          message: 'XD_OFFICE_NET VPC Network binding is not available.',
        },
        secret: { secretPresent: true },
      },
      503
    );
  }

  const signed = await signXdsRequest({ token });
  let response;
  try {
    response = await vpc.fetch(XDS_SEARCH_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-ts': signed.ts,
        'x-nonce': signed.nonce,
        'x-sign': signed.sign,
      },
      body: JSON.stringify({ keyword }),
    });
  } catch (error) {
    return jsonResponse(
      {
        ok: false,
        error: {
          code: 'XDS_VPC_FETCH_FAILED',
          message: String(error?.message || error || 'VPC fetch failed.'),
        },
        secret: { secretPresent: true },
      },
      502
    );
  }

  const payload = await readJsonPayload(response);
  return jsonResponse({
    ok: response.ok,
    secret: { secretPresent: true },
    xds: summarizeXdsResponse(response, payload),
  }, response.ok ? 200 : 502);
}

async function signXdsRequest({ token }) {
  const ts = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomUUID().toLowerCase();
  const sign = await sha1Hex(`${ts}${nonce}${token}`);
  return { ts, nonce, sign };
}

function summarizeXdsResponse(response, payload) {
  const items = extractItems(payload);
  return {
    endpoint: '/xds-open-api/v1/oa-user/search',
    status: response.status,
    code: payload && typeof payload.code !== 'undefined' ? payload.code : null,
    itemCount: items.length,
    sampleKeys: items[0] && typeof items[0] === 'object' && !Array.isArray(items[0]) ? Object.keys(items[0]).sort() : [],
  };
}

function extractItems(payload) {
  if (Array.isArray(payload?.data)) return payload.data;
  if (Array.isArray(payload?.data?.list)) return payload.data.list;
  if (Array.isArray(payload?.data?.items)) return payload.data.items;
  if (Array.isArray(payload?.result)) return payload.result;
  if (Array.isArray(payload?.list)) return payload.list;
  return [];
}

async function readJsonPayload(response) {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function normalizeKeyword(value) {
  const keyword = typeof value === 'string' ? value.trim() : '';
  return keyword || 'platform';
}

async function sha1Hex(value) {
  const digest = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: JSON_HEADERS,
  });
}
