export function cloudflareFailureCause(error) {
  // Only surface fixed internal error codes; upstream messages may embed resource details.
  const candidates = [error?.code, error?.message];
  const code = candidates.find((value) => typeof value === 'string' && /^[A-Z][A-Z0-9_]{2,63}$/.test(value));
  const status = Number.isInteger(error?.status) ? ` (HTTP ${error.status})` : '';
  const detail =
    typeof error?.detail === 'string' && /^[a-zA-Z0-9_,. -]{1,160}$/.test(error.detail)
      ? ` [${error.detail}]`
      : '';
  return `${code || 'UNEXPECTED'}${status}${detail}`;
}

export function normalizeRequiredString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

export function normalizeNullableString(value) {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return normalized ? normalized : null;
}

export function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}
