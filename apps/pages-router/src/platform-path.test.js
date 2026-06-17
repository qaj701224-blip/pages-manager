import assert from 'node:assert/strict';
import test from 'node:test';

import { isPlatformPath } from './platform-path.js';

test('detects platform reserved paths', () => {
  assert.equal(isPlatformPath('/.xd-pages'), true);
  assert.equal(isPlatformPath('/.xd-pages/auth/callback'), true);
  assert.equal(isPlatformPath('/.xd-pages/runtime/v1/kv/get'), true);
  assert.equal(isPlatformPath('/.xd-pages/health'), true);
});

test('does not reserve normal user paths', () => {
  assert.equal(isPlatformPath('/'), false);
  assert.equal(isPlatformPath('/app/.xd-pages'), false);
  assert.equal(isPlatformPath('/xd-pages/auth/callback'), false);
});
