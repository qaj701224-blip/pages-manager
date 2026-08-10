import assert from 'node:assert/strict';
import test from 'node:test';

import {
  accessModeFromVisibility,
  normalizeExposure,
  normalizeSnapshotPolicy,
} from './index.js';

test('maps every supported legacy visibility to its canonical access mode', () => {
  assert.equal(accessModeFromVisibility('internal'), 'anonymous');
  assert.equal(accessModeFromVisibility('org'), 'org');
  assert.equal(accessModeFromVisibility('acl'), 'acl');
  assert.equal(accessModeFromVisibility('owner'), 'owner');
  assert.equal(accessModeFromVisibility('disabled'), 'disabled');
});

test('does not map unknown visibility to an access mode', () => {
  assert.equal(accessModeFromVisibility('public'), null);
  assert.equal(accessModeFromVisibility(''), null);
  assert.equal(accessModeFromVisibility(null), null);
});

test('normalizes only explicit public exposure', () => {
  assert.equal(normalizeExposure(undefined), 'internal');
  assert.equal(normalizeExposure('invalid'), 'internal');
  assert.deepEqual(normalizeSnapshotPolicy({ exposure: 'public', accessMode: 'org' }), {
    exposure: 'public',
    accessMode: 'org',
  });
});

test('rejects invalid access mode in a snapshot policy without opening access', () => {
  assert.deepEqual(normalizeSnapshotPolicy({ exposure: 'public', accessMode: 'invalid' }), {
    exposure: 'public',
    accessMode: null,
  });
});
