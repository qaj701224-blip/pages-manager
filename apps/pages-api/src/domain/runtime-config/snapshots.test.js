import assert from 'node:assert/strict';
import test from 'node:test';

import { runtimeConfigSnapshotsEqual, runtimeVarSnapshotsEqual } from './snapshots.js';

test('runtime config snapshots compare normalized vars and secret revisions without depending on order', () => {
  const expectedVars = [
    { name: 'Z_FLAG', value: 'last', revision: 2 },
    { name: 'A_FLAG', value: 'first', revision: 1 },
  ];
  const actualVars = [
    { name: 'A_FLAG', value: 'first', revision: 1 },
    { name: 'Z_FLAG', value: 'last', revision: 2 },
  ];
  const expectedSecrets = [
    { name: 'Z_TOKEN', value: 'old-secret', revision: 4 },
    { name: 'A_TOKEN', value: 'old-secret', revision: 3 },
  ];
  const actualSecrets = [
    { name: 'A_TOKEN', value: 'newly-read-secret', revision: 3 },
    { name: 'Z_TOKEN', value: 'newly-read-secret', revision: 4 },
  ];

  assert.equal(runtimeConfigSnapshotsEqual(expectedVars, expectedSecrets, actualVars, actualSecrets), true);
});

test('runtime config snapshots detect var values, var revisions, secret revisions, and entry changes', () => {
  const vars = [{ name: 'FEATURE_FLAG', value: 'on', revision: 2 }];
  const secrets = [{ name: 'API_TOKEN', value: 'secret', revision: 3 }];

  assert.equal(runtimeConfigSnapshotsEqual(vars, secrets, [{ ...vars[0], value: 'off' }], secrets), false);
  assert.equal(runtimeConfigSnapshotsEqual(vars, secrets, [{ ...vars[0], revision: 4 }], secrets), false);
  assert.equal(runtimeConfigSnapshotsEqual(vars, secrets, vars, [{ ...secrets[0], revision: 4 }]), false);
  assert.equal(runtimeConfigSnapshotsEqual(vars, secrets, [], secrets), false);
});

test('runtime var snapshots preserve compatibility with object inputs and implicit revision zero', () => {
  assert.equal(
    runtimeVarSnapshotsEqual({ FEATURE_FLAG: 'on', API_BASE: 'https://api.example.com' }, [
      { name: 'API_BASE', value: 'https://api.example.com', revision: 0 },
      { name: 'FEATURE_FLAG', value: 'on' },
    ]),
    true
  );
});
