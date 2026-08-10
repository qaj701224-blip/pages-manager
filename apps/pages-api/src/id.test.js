import assert from 'node:assert/strict';
import test from 'node:test';

import { newId, nextId } from './id.js';

test('injected ID generators cannot bypass production prefix validation', () => {
  let calls = 0;
  const env = {
    nextId(prefix) {
      calls += 1;
      return `${prefix}_fixture`;
    },
  };

  for (const prefix of ['a', '1a', 'Deploylock', 'deploy_lock', 'deploy-lock', 'abcdefghijklmnopq']) {
    assert.throws(() => nextId(env, prefix), /ID prefix must be lowercase alphanumeric/);
    assert.throws(() => newId(prefix), /ID prefix must be lowercase alphanumeric/);
  }
  assert.equal(calls, 0);
  assert.equal(nextId(env, 'ab'), 'ab_fixture');
  assert.equal(nextId(env, 'deploylock'), 'deploylock_fixture');
  assert.equal(nextId(env, 'abcdefghijklmnop'), 'abcdefghijklmnop_fixture');
  assert.equal(calls, 3);

  assert.match(nextId({ nextId: () => '' }, 'route'), /^route_[0-9a-f]{32}$/);
  assert.match(nextId({ nextId: () => undefined }, 'route'), /^route_[0-9a-f]{32}$/);
  assert.match(newId('route', { bytes: new Uint8Array([1, 2]) }), /^route_0102$/);
});
