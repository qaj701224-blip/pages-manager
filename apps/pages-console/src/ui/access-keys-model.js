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

export function buildAccessKeyRows(accessKeys) {
  return (Array.isArray(accessKeys) ? accessKeys : [])
    .filter((accessKey) => !accessKey.revokedAt)
    .map((accessKey) => ({
      id: accessKey.id,
      name: accessKey.name || accessKey.id,
      ownerLabel: accessKey.ownerType === 'team' ? '团队' : '个人',
      sourceLabel: formatSourceLabel(accessKey.issuedSource),
      sourceKind: formatSourceKind(accessKey.issuedSource),
      tokenPreview: accessKey.tokenPreview || previewAccessKeyId(accessKey.id),
      scopeLabels: (accessKey.scopes || []).map(formatScopeLabel),
      createdLabel: formatRelativeTime(accessKey.createdAt),
      expiresLabel: formatExpiryLabel(accessKey.expiresAt),
      raw: accessKey,
    }));
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

function previewAccessKeyId(id) {
  const value = String(id || '').trim();
  if (!value) return '-';
  return value.length > 11 ? value.slice(0, 11) : value;
}

function formatScopeLabel(scope) {
  if (scope === 'read:site') return 'read';
  if (scope === 'deploy:site') return 'deploy';
  return scope;
}

function formatSourceLabel(source) {
  if (source === 'xdmaker_s2s') return 'XDMaker';
  if (source === 'console') return 'Console';
  if (source === 'cli') return 'CLI';
  if (source === 'legacy') return '历史';
  return '其它';
}

function formatSourceKind(source) {
  if (source === 'xdmaker_s2s') return 'xdmaker';
  if (source === 'console' || source === 'cli' || source === 'legacy') return source;
  return 'other';
}

function formatExpiryLabel(value) {
  if (!value) return '永久';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatRelativeTime(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const diffMs = Date.now() - date.getTime();
  const absMs = Math.abs(diffMs);
  const units = [
    ['year', 365 * 24 * 60 * 60 * 1000],
    ['month', 30 * 24 * 60 * 60 * 1000],
    ['day', 24 * 60 * 60 * 1000],
    ['hour', 60 * 60 * 1000],
    ['minute', 60 * 1000],
  ];
  const formatter = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
  for (const [unit, size] of units) {
    if (absMs >= size) return formatter.format(Math.round(-diffMs / size), unit);
  }
  return '刚刚';
}
