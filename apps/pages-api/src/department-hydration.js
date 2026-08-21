import { fetchOrgUsersByEmail } from './org-directory.js';
import { readOrgDirectoryConfig } from './infrastructure/config/org-directory-config.js';

const DEPARTMENT_HYDRATION_SUCCESS_TTL_SECONDS = 24 * 60 * 60;
const DEPARTMENT_HYDRATION_FAILURE_RETRY_SECONDS = 10 * 60;

export async function hydrateUserDepartmentFromDirectory({ env, store, environment, user }) {
  const userId = normalizeRequiredString(user?.id || user?.userId);
  const email = normalizeEmail(user?.email);
  if (!userId || !email || !environment) return unavailableHydration();

  const checkedAt = new Date(readNow(env) * 1000).toISOString();
  const directoryConfig = readOrgDirectoryConfig(env);
  if (!directoryConfig) return recordUnavailableDepartmentCheck({ store, userId, checkedAt });

  let directoryUsers;
  try {
    directoryUsers = await fetchOrgUsersByEmail({
      emails: [email],
      token: directoryConfig.token,
      fetchImpl: directoryConfig.fetchImpl,
    });
  } catch {
    return recordUnavailableDepartmentCheck({ store, userId, checkedAt });
  }

  const directoryUser =
    directoryUsers.find((item) => item.email === email && item.departmentPath) ||
    directoryUsers.find((item) => item.departmentPath);
  const departmentPath = normalizeDepartmentPath(directoryUser?.departmentPath);
  if (!departmentPath) return recordUnavailableDepartmentCheck({ store, userId, checkedAt });

  const updatedUser = await store.updateUserDepartmentFromDirectory({
    userId,
    departmentPath,
    departmentCheckedAt: checkedAt,
  });
  if (!updatedUser) return { status: 'missing_user' };

  const result = await store.hydrateDepartmentMembership({
    environment,
    userId,
    departmentPath,
  });

  return {
    status: 'hydrated',
    departmentPath,
    teamId: result.team?.id || null,
  };
}

export function shouldHydrateUserDepartment(user, clock = {}) {
  if (!user?.email) return false;
  const checkedAtSeconds = readTimestampSeconds(user.departmentCheckedAt);
  if (!checkedAtSeconds) return true;

  const now = readNow(clock);
  const ttlSeconds = user.departmentPath
    ? DEPARTMENT_HYDRATION_SUCCESS_TTL_SECONDS
    : DEPARTMENT_HYDRATION_FAILURE_RETRY_SECONDS;
  return now - checkedAtSeconds >= ttlSeconds;
}

function normalizeRequiredString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function normalizeDepartmentPath(value) {
  return typeof value === 'string'
    ? value
        .split('/')
        .map((part) => part.trim())
        .filter(Boolean)
        .join('/')
    : '';
}

function readNow(env) {
  if (Number.isInteger(env?.now)) return env.now;
  if (typeof env?.nowSeconds === 'function') return env.nowSeconds();
  if (typeof env?.now === 'function') {
    const value = env.now();
    if (Number.isInteger(value)) return value;
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

function readTimestampSeconds(value) {
  if (!value) return 0;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : Math.floor(parsed / 1000);
}

async function recordUnavailableDepartmentCheck({ store, userId, checkedAt }) {
  try {
    await store.updateUserDepartmentFromDirectory({
      userId,
      departmentPath: null,
      departmentCheckedAt: checkedAt,
    });
  } catch {
    // Best-effort throttling only; hydration remains unavailable.
  }
  return unavailableHydration();
}

function unavailableHydration() {
  return { status: 'unavailable' };
}
