import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CONSOLE_SESSION_CACHE_KEY,
  CONSOLE_SESSION_CACHE_TTL_MS,
  clearCachedConsoleSession,
  readCachedConsoleSession,
  writeCachedConsoleSession,
} from './session-cache.js';

function memoryStorage() {
  const entries = new Map();
  return {
    getItem(key) {
      return entries.has(key) ? entries.get(key) : null;
    },
    removeItem(key) {
      entries.delete(key);
    },
    setItem(key, value) {
      entries.set(key, value);
    },
  };
}

test('console session cache stores authenticated sessions with freshness metadata', () => {
  const storage = memoryStorage();
  const session = {
    authenticated: true,
    user: {
      userId: 'usr_1',
      email: 'root@example.com',
      isPlatformAdmin: true,
    },
  };

  writeCachedConsoleSession(session, storage, 1_000);

  assert.deepEqual(readCachedConsoleSession(storage, 1_010), {
    session,
    cachedAt: 1_000,
    ageMs: 10,
    fresh: true,
  });
  assert.equal(readCachedConsoleSession(storage, 1_000 + CONSOLE_SESSION_CACHE_TTL_MS).fresh, false);
});

test('console session cache clears anonymous sessions and ignores invalid payloads', () => {
  const storage = memoryStorage();

  writeCachedConsoleSession({ authenticated: true, user: { userId: 'usr_1' } }, storage, 1_000);
  assert.ok(storage.getItem(CONSOLE_SESSION_CACHE_KEY));

  writeCachedConsoleSession({ authenticated: false, user: null }, storage, 2_000);
  assert.equal(storage.getItem(CONSOLE_SESSION_CACHE_KEY), null);

  storage.setItem(CONSOLE_SESSION_CACHE_KEY, '{bad json');
  assert.equal(readCachedConsoleSession(storage, 3_000), null);

  storage.setItem(CONSOLE_SESSION_CACHE_KEY, JSON.stringify({ cachedAt: 3_000, session: { authenticated: false } }));
  assert.equal(readCachedConsoleSession(storage, 3_001), null);

  clearCachedConsoleSession(storage);
  assert.equal(storage.getItem(CONSOLE_SESSION_CACHE_KEY), null);
});
