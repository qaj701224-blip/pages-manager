export const ACCESS_KEY_PERMISSION_OPTIONS = [
  { value: 'read', label: 'read', scope: 'read:site' },
  { value: 'publish', label: 'publish', scope: 'deploy:site' },
];

export const ACCESS_KEY_EXPIRY_OPTIONS = [
  { days: 30, label: '30 天' },
  { days: 90, label: '90 天' },
  { days: 180, label: '180 天' },
  { days: 365, label: '365 天' },
];

const PERMISSION_TO_SCOPE = new Map(ACCESS_KEY_PERMISSION_OPTIONS.map((option) => [option.value, option.scope]));
const DEFAULT_EXPIRY_DAYS = 90;

export function initialAccessKeyForm() {
  return {
    name: '',
    permissions: ['read', 'publish'],
    expiresInDays: DEFAULT_EXPIRY_DAYS,
  };
}

export function buildAccessKeyCreateBody(form, now = new Date()) {
  const permissions = Array.isArray(form.permissions) ? form.permissions : [];
  if (!permissions.length) throw new Error('ACCESS_KEY_PERMISSION_REQUIRED');

  const scopes = permissions.map((permission) => {
    const scope = PERMISSION_TO_SCOPE.get(permission);
    if (!scope) throw new Error('ACCESS_KEY_PERMISSION_UNSUPPORTED');
    return scope;
  });
  if (!scopes.length) throw new Error('ACCESS_KEY_PERMISSION_REQUIRED');

  const expiresInDays = normalizeExpiryDays(form.expiresInDays);
  return {
    name: String(form.name || '').trim(),
    scopes,
    expiresAt: addUtcDays(now, expiresInDays).toISOString(),
  };
}

function normalizeExpiryDays(value) {
  const days = Number(value);
  return ACCESS_KEY_EXPIRY_OPTIONS.some((option) => option.days === days) ? days : DEFAULT_EXPIRY_DAYS;
}

function addUtcDays(value, days) {
  const date = new Date(value);
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}
