export const CONSOLE_SESSION_CACHE_KEY = 'xd_cell_console_session_v1';
export const CONSOLE_SESSION_CACHE_TTL_MS = 30_000;

export function readCachedConsoleSession(storage = globalThis.sessionStorage, now = Date.now()) {
  if (!storage) return null;

  try {
    const raw = storage.getItem(CONSOLE_SESSION_CACHE_KEY);
    if (!raw) return null;

    const parsed = JSON.parse(raw);
    const cachedAt = Number(parsed?.cachedAt || 0);
    const session = parsed?.session;
    if (!session?.authenticated || !session.user || !Number.isFinite(cachedAt)) return null;

    return {
      session,
      cachedAt,
      ageMs: Math.max(0, now - cachedAt),
      fresh: now - cachedAt < CONSOLE_SESSION_CACHE_TTL_MS,
    };
  } catch {
    return null;
  }
}

export function writeCachedConsoleSession(session, storage = globalThis.sessionStorage, now = Date.now()) {
  if (!storage) return;
  if (!session?.authenticated || !session.user) {
    clearCachedConsoleSession(storage);
    return;
  }

  try {
    storage.setItem(
      CONSOLE_SESSION_CACHE_KEY,
      JSON.stringify({
        cachedAt: now,
        session,
      })
    );
  } catch {
    // Session caching is an optimization only. Ignore storage quota/private mode failures.
  }
}

export function clearCachedConsoleSession(storage = globalThis.sessionStorage) {
  if (!storage) return;
  try {
    storage.removeItem(CONSOLE_SESSION_CACHE_KEY);
  } catch {
    // Ignore storage failures.
  }
}
