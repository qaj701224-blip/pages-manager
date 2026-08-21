import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_RUNTIME_VAR_VALUE_BYTES,
  normalizeRuntimeSecretName,
  normalizeRuntimeVars,
  runtimeConfigSnapshot,
  validateRuntimeBindingQuotas,
} from './rules.js';

test('runtime config rules normalize names and reject reserved or sensitive bindings', () => {
  assert.deepEqual(normalizeRuntimeVars({ FEATURE_FLAG: 'on' }), { FEATURE_FLAG: 'on' });
  assert.equal(normalizeRuntimeSecretName(' API_TOKEN '), 'API_TOKEN');
  assert.throws(() => normalizeRuntimeVars({ ACCESS_TOKEN: 'secret' }), /RUNTIME_VARS_INVALID/);
  assert.throws(() => normalizeRuntimeSecretName('XD_INTERNAL'), /RUNTIME_BINDING_NAME_RESERVED/);
});

test('runtime config quotas enforce byte limits and cross-kind name uniqueness', () => {
  assert.equal(validateRuntimeBindingQuotas({ VALUE: 'x'.repeat(MAX_RUNTIME_VAR_VALUE_BYTES) }, []), true);
  assert.throws(
    () => validateRuntimeBindingQuotas({ VALUE: 'x'.repeat(MAX_RUNTIME_VAR_VALUE_BYTES + 1) }, []),
    /RUNTIME_BINDINGS_LIMIT_EXCEEDED/
  );
  assert.throws(
    () => validateRuntimeBindingQuotas({ SHARED_NAME: 'value' }, [{ name: 'SHARED_NAME', value: 'secret' }]),
    /RUNTIME_BINDING_NAME_CONFLICT/
  );
});

test('runtime config snapshots are deterministic and never include secret values', () => {
  assert.deepEqual(
    runtimeConfigSnapshot(
      [
        { name: 'B', value: '2', revision: 2 },
        { name: 'A', value: '1' },
      ],
      [{ name: 'TOKEN', value: 'must-not-leak', revision: 3, valueHash: 'sha256:test' }]
    ),
    {
      vars: [
        { name: 'A', value: '1', revision: 0 },
        { name: 'B', value: '2', revision: 2 },
      ],
      secrets: [{ name: 'TOKEN', revision: 3, valueHash: 'sha256:test' }],
    }
  );
});
