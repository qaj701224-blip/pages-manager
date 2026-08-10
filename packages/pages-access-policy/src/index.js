export const EXPOSURES = Object.freeze(['internal', 'public']);
export const ACCESS_MODES = Object.freeze(['anonymous', 'org', 'acl', 'owner', 'disabled']);
export const LEGACY_VISIBILITIES = Object.freeze(['internal', 'org', 'acl', 'owner', 'disabled']);

const ACCESS_MODE_SET = new Set(ACCESS_MODES);

export function accessModeFromVisibility(value) {
  if (value === 'internal') return 'anonymous';
  if (value === 'org' || value === 'acl' || value === 'owner' || value === 'disabled') return value;
  return null;
}

export function visibilityFromAccessMode(value) {
  if (value === 'anonymous') return 'internal';
  return ACCESS_MODE_SET.has(value) ? value : null;
}

export function normalizeExposure(value) {
  return value === 'public' ? 'public' : 'internal';
}

export function isValidAccessMode(value) {
  return ACCESS_MODE_SET.has(value);
}

export function normalizeSnapshotPolicy({ exposure, accessMode } = {}) {
  return {
    exposure: normalizeExposure(exposure),
    accessMode: isValidAccessMode(accessMode) ? accessMode : null,
  };
}
