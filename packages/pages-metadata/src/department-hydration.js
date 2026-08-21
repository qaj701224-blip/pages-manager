import { normalizeDepartmentPath } from './department-path.js';

const DEPARTMENT_HYDRATION_SUCCESS_TTL_SECONDS = 24 * 60 * 60;
const DEPARTMENT_HYDRATION_FAILURE_RETRY_SECONDS = 10 * 60;

export async function hydrateUserDepartment({ store, environment, user, directory, clock = {} }) {
  const userId = normalizeRequiredString(user?.id || user?.userId);
  const email = normalizeEmail(user?.email);
  if (!userId || !email || !environment) return unavailableHydration();

  const checkedAt = new Date(readNow(clock) * 1000).toISOString();
  if (typeof directory?.findUsersByEmail !== 'function') {
    return recordUnavailableDepartmentCheck({ store, userId, checkedAt });
  }
  let directoryUsers;
  try {
    directoryUsers = await directory.findUsersByEmail([email]);
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

  const result = await store.hydrateDepartmentMembership({ environment, userId, departmentPath });
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
  const ttlSeconds = user.departmentPath ? DEPARTMENT_HYDRATION_SUCCESS_TTL_SECONDS : DEPARTMENT_HYDRATION_FAILURE_RETRY_SECONDS;
  return now - checkedAtSeconds >= ttlSeconds;
}

function normalizeRequiredString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function readNow(clock) {
  if (Number.isInteger(clock?.now)) return clock.now;
  if (typeof clock?.nowSeconds === 'function') return clock.nowSeconds();
  if (typeof clock?.now === 'function') {
    const value = clock.now();
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
