import { isConsoleBffRequest, requireConsoleUserSession } from './console-auth.js';
import { jsonError, jsonOk } from './http.js';

const CONSOLE_PREFIX = '/.xd-pages/api/console';

export async function handleConsoleUsersApi(request, env, config, store) {
  if (!isConsoleBffRequest(request)) return null;

  const url = new URL(request.url);
  if (url.pathname !== `${CONSOLE_PREFIX}/users`) return null;

  const session = await requireConsoleUserSession(request, env, config, store);
  if (session instanceof Response) return session;
  if (request.method !== 'GET') return methodNotAllowed();

  const query = normalizeNullableString(url.searchParams.get('query'));
  const users = await store.listConsoleUsers({ query, limit: 20 });
  return jsonOk({ users: users.map(formatConsoleUser) });
}

export function formatConsoleUser(user) {
  return {
    id: user.id,
    email: user.email || null,
    realname: user.realname || null,
    account: user.account || null,
    departmentPath: user.departmentPath || null,
    employeeStatus: user.employeeStatus || null,
  };
}

function normalizeNullableString(value) {
  const normalized = String(value || '').trim();
  return normalized || null;
}

function methodNotAllowed() {
  return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405, 'Use a supported HTTP method.');
}
