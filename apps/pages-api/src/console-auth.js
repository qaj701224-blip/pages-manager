import { hydrateUserDepartmentFromDirectory, shouldHydrateUserDepartment } from './department-hydration.js';
import { deriveDepartmentTeamIdentity } from './department-path.js';
import { jsonError } from './http.js';

const CONSOLE_RECENT_LOGIN_SECONDS = 15 * 60;
const CONSOLE_AUTH_TIME_FUTURE_SKEW_SECONDS = 30;

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
    authTime: parseUnixSeconds(request.headers.get('X-Console-Auth-Time')),
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
  if (options.hydrateDepartment && shouldHydrateUserDepartment(user, env)) {
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
  } else if (options.hydrateDepartment && user.departmentPath) {
    await ensureDepartmentMembershipFromStoredPath({
      store,
      environment: config.environment,
      user,
    });
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
    authTime: session.authTime,
    isPlatformAdmin,
    user: currentUser,
  };
}

export function requireRecentConsoleLogin(session, env) {
  const now = currentUnixSeconds(env);
  const authTime = session?.authTime;
  if (
    !Number.isSafeInteger(authTime) ||
    authTime <= 0 ||
    !Number.isSafeInteger(now) ||
    authTime > now + CONSOLE_AUTH_TIME_FUTURE_SKEW_SECONDS ||
    now - authTime > CONSOLE_RECENT_LOGIN_SECONDS
  ) {
    return jsonError(
      'CONSOLE_RECENT_LOGIN_REQUIRED',
      'Recent console login is required.',
      401,
      'Verify your identity again before transferring site ownership.'
    );
  }
  return null;
}

async function ensureDepartmentMembershipFromStoredPath({ store, environment, user }) {
  if (typeof store?.hydrateDepartmentMembership !== 'function') return;
  const identity = deriveDepartmentTeamIdentity(user.departmentPath);
  if (!identity.teamPath) return;
  try {
    if (typeof store.listTeamsForUser === 'function') {
      const teams = await store.listTeamsForUser({ environment, userId: user.id });
      const hasCanonicalDepartmentTeam = teams.some(
        (team) =>
          team.teamType === 'department' &&
          team.status === 'active' &&
          team.currentUserMembershipSource === 'department_auto' &&
          team.departmentPath === identity.teamPath
      );
      if (hasCanonicalDepartmentTeam) return;
    }
    await store.hydrateDepartmentMembership({
      environment,
      userId: user.id,
      departmentPath: user.departmentPath,
    });
  } catch {
    // Best-effort backfill only; session validation remains authoritative.
  }
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

function parseUnixSeconds(value) {
  const normalized = normalizeHeader(value);
  if (!/^[1-9]\d*$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function currentUnixSeconds(env) {
  const value = typeof env?.now === 'function' ? env.now() : Date.now();
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.floor(value > 10_000_000_000 ? value / 1000 : value);
  }
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null;
}
