const INTERNAL_AUTH_BASE = 'https://pages-auth.internal';

async function callPagesAuth(env, path, body) {
  if (!env?.PAGES_AUTH || typeof env.PAGES_AUTH.fetch !== 'function') {
    throw new Error('PAGES_AUTH binding is missing');
  }

  const response = await env.PAGES_AUTH.fetch(
    new Request(`${INTERNAL_AUTH_BASE}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'pages-auth.internal',
      },
      body: JSON.stringify(body),
    })
  );

  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const code = payload?.error?.code || 'PAGES_AUTH_FAILED';
    throw new Error(code);
  }
  return payload;
}

export function normalizeConsoleReturnTo(value) {
  const raw = String(value || '').trim() || '/';
  if (raw.startsWith('//')) return '/';

  let url;
  try {
    url = new URL(raw, 'https://workers.xd.team');
  } catch {
    return '/';
  }

  if (url.origin !== 'https://workers.xd.team' || url.username || url.password || url.hash) return '/';
  const path = `${url.pathname}${url.search}`;
  if (url.pathname === '/' || url.pathname === '/workspace' || url.pathname.startsWith('/workspace/')) return path;
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return path;
  return '/';
}

export async function createConsoleLogin(env, returnTo, { reauth = false } = {}) {
  const body = {
    returnTo: normalizeConsoleReturnTo(returnTo),
  };
  if (reauth) body.reauth = true;
  return callPagesAuth(env, '/.xd-pages/internal/console/login-code', body);
}

export async function exchangeConsoleCode(env, code) {
  if (!code) throw new Error('CONSOLE_CODE_REQUIRED');
  return callPagesAuth(env, '/.xd-pages/internal/console/exchange', { code });
}
