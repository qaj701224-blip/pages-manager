import assert from 'node:assert/strict';
import test from 'node:test';

import { readConsoleSessionHeaders, requireRecentConsoleLogin } from './console-auth.js';

const NOW_SECONDS = 1781481600;
const TEST_ENV = { now: () => '2026-06-15T00:00:00.000Z' };

test('console session headers accept only positive integer authTime values', () => {
  assert.equal(readSession('1781481600').authTime, NOW_SECONDS);
  for (const value of [null, '', '0', '-1', '1781481600.5', 'not-a-time', '9007199254740992']) {
    assert.equal(readSession(value).authTime, null, String(value));
  }
});

test('recent console login accepts the 15 minute and future-skew boundaries', () => {
  assert.equal(requireRecentConsoleLogin({ authTime: NOW_SECONDS }, TEST_ENV), null);
  assert.equal(requireRecentConsoleLogin({ authTime: NOW_SECONDS - 900 }, TEST_ENV), null);
  assert.equal(requireRecentConsoleLogin({ authTime: NOW_SECONDS + 30 }, TEST_ENV), null);
});

test('recent console login rejects missing, stale, and future authTime values', async () => {
  for (const authTime of [null, NOW_SECONDS - 901, NOW_SECONDS + 31]) {
    const response = requireRecentConsoleLogin({ authTime }, TEST_ENV);
    assert.equal(response.status, 401);
    assert.equal((await response.json()).error.code, 'CONSOLE_RECENT_LOGIN_REQUIRED');
  }
});

function readSession(authTime) {
  const headers = {
    Host: 'pages-api.internal',
    'X-Console-BFF': 'pages-console',
    'X-Console-User-Id': 'usr_1',
  };
  if (authTime !== null) headers['X-Console-Auth-Time'] = authTime;
  return readConsoleSessionHeaders(new Request('https://pages-api.internal', { headers }));
}
