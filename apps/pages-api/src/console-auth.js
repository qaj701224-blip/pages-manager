import { hydrateUserDepartmentFromDirectory, shouldHydrateUserDepartment } from './department-hydration.js';
import { jsonError } from './http.js';

export function isConsoleBffRequest(request) {
  const url = new URL(request.url);
  return url.hostname === 'pages-api.internal' && request.headers.get('X-Console-BFF') === 'pages-console';
}

export function readConsoleSessionHeaders(request) {
  const userId = normalizeHeader(request.headers.get('X-Console-User-Id'));
  if (!userId) return null;
  const sessionVersion = Number(request.headers.get('X-Console-Session-Version'));
  return {
    userId,
    email: normalizeHeader(request.headers.get('X-Console-Email')),
    sessionVersion: Number.isInteger(sessionVersion) && sessionVersion > 0 ? sessionVersion : 1,
  };
}

export function consoleRequiresPlatformAdmin(request) {
  return request.headers.get('X-Console-Require-Admin') === 'true';
}

export async function requireConsoleUserSession(request, env, config, store, options = {}) {
  const session = readConsoleSessionHeaders(request);
  if (!session) return consoleAuthRequired();

  const user = await store.getUser(session.userId);
  if (!user || user.employeeStatus !== 'active') {
    return jsonError('CONSOLE_SESSION_INVALID', 'Console session is no longer valid.', 401, 'Sign in again.');
  }
  if (session.sessionVersion !== user.sessionVersion) {
    return jsonError('CONSOLE_SESSION_STALE', 'Console session is stale.', 401, 'Sign in again.');
  }

  let currentUser = user;
  if (options.hydrateDepartment && shouldHydrateUserDepartment(user)) {
    try {
      const hydrated = await hydrateUserDepartmentFromDirectory({
        env,
        store,
        environment: config.environment,
        user,
      });
      if (hydrated.status === 'hydrated') {
        currentUser = (await store.getUser(session.userId)) || user;
      }
    } catch {
      // Department hydration is best-effort; session validation remains authoritative.
    }
  }

  const shouldReadAdmin = options.includePlatformAdmin || options.requirePlatformAdmin || consoleRequiresPlatformAdmin(request);
  const isPlatformAdmin = shouldReadAdmin
    ? await store.isPlatformAdmin({
        environment: config.environment,
        userId: currentUser.id,
      })
    : false;

  if ((options.requirePlatformAdmin || consoleRequiresPlatformAdmin(request)) && !isPlatformAdmin) {
    return jsonError(
      'PLATFORM_ADMIN_REQUIRED',
      'Platform administrator access is required.',
      403,
      'Use a platform administrator account.'
    );
  }

  return {
    userId: currentUser.id,
    email: currentUser.email || session.email,
    employeeStatus: currentUser.employeeStatus,
    sessionVersion: currentUser.sessionVersion,
    isPlatformAdmin,
    user: currentUser,
  };
}

export async function readOptionalConsoleUserSession(request, env, config, store, options = {}) {
  if (!readConsoleSessionHeaders(request)) return null;
  return requireConsoleUserSession(request, env, config, store, options);
}

export function consoleAuthRequired() {
  return jsonError('CONSOLE_AUTH_REQUIRED', 'Console login required.', 401, 'Sign in to XD Cell.');
}

function normalizeHeader(value) {
  return typeof value === 'string' ? value.trim() : '';
}
