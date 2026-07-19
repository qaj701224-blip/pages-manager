import assert from 'node:assert/strict';
import test from 'node:test';

import {
  logRuntimeConfigFailure,
  markRuntimeConfigError,
  readRuntimeConfigErrorDiagnostic,
} from './runtime-config-diagnostics.js';

test('runtime config diagnostics emit only the closed safe schema', () => {
  const lines = [];

  logRuntimeConfigFailure(
    { logRuntimeConfigFailure: (line) => lines.push(line) },
    {
      operation: 'var_put',
      environment: 'staging',
      siteId: 'site_01f96d7134e334c6107d91411b3d74e2',
      stage: 'mutation_batch',
      reason: 'schema_missing',
      errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
      value: 'must-not-be-logged',
      error: new Error('must-not-be-logged'),
    }
  );

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    event: 'pages_runtime_config_failure',
    operation: 'var_put',
    environment: 'staging',
    siteId: 'site_01f96d7134e334c6107d91411b3d74e2',
    stage: 'mutation_batch',
    reason: 'schema_missing',
    errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
  });
  assert.doesNotMatch(lines[0], /must-not-be-logged/);
});

test('runtime config diagnostics replace invalid dynamic fields with unknown', () => {
  const lines = [];
  const sentinel = 'SENSITIVE_SENTINEL';

  logRuntimeConfigFailure(
    { logRuntimeConfigFailure: (line) => lines.push(line) },
    {
      operation: `var_put\n${sentinel}`,
      environment: `staging\n${sentinel}`,
      siteId: `site_1\n${sentinel}`,
      stage: `mutation_batch\n${sentinel}`,
      reason: `schema_missing\n${sentinel}`,
      errorCode: `RUNTIME_CONFIG_UNSUPPORTED\n${sentinel}`,
    }
  );

  assert.deepEqual(JSON.parse(lines[0]), {
    event: 'pages_runtime_config_failure',
    operation: 'unknown',
    environment: 'unknown',
    siteId: 'unknown',
    stage: 'unknown',
    reason: 'unknown',
    errorCode: 'unknown',
  });
  assert.doesNotMatch(lines[0], new RegExp(sentinel));
});

test('runtime config diagnostics isolate logger failures', () => {
  assert.doesNotThrow(() => {
    logRuntimeConfigFailure(
      {
        logRuntimeConfigFailure() {
          throw new Error('LOGGER_FAILED');
        },
      },
      {
        operation: 'var_delete',
        environment: 'production',
        siteId: 'site_1',
        stage: 'capability_check',
        reason: 'capability_unavailable',
        errorCode: 'RUNTIME_CONFIG_UNSUPPORTED',
      }
    );
  });
});

test('runtime config errors expose only a safe internal stage and reason', () => {
  const error = new Error('D1_ERROR: no such column: SENSITIVE_SENTINEL');
  error.name = 'SENSITIVE_NAME';
  error.code = 'SENSITIVE_CODE';
  error.stack = 'SENSITIVE_STACK';
  error.cause = new Error('SENSITIVE_CAUSE');

  const marked = markRuntimeConfigError(error, { stage: 'mutation_batch' });

  assert.equal(marked, error);
  assert.deepEqual(readRuntimeConfigErrorDiagnostic(marked), {
    stage: 'mutation_batch',
    reason: 'schema_missing',
  });
  assert.deepEqual(Object.keys(marked), ['name', 'code', 'cause']);
});

test('runtime config errors keep the first safe diagnostic marker', () => {
  const error = markRuntimeConfigError(new Error('D1_ERROR: database is locked'), { stage: 'lock_acquire' });

  markRuntimeConfigError(error, { stage: 'post_commit_read', reason: 'store_operation_failed' });

  assert.deepEqual(readRuntimeConfigErrorDiagnostic(error), {
    stage: 'lock_acquire',
    reason: 'database_busy',
  });
});

test('runtime config diagnostics accept the closed statement build stage', () => {
  const error = markRuntimeConfigError(new Error('D1_TYPE_ERROR: SENSITIVE_VALUE'), {
    stage: 'statement_build',
  });

  assert.deepEqual(readRuntimeConfigErrorDiagnostic(error), {
    stage: 'statement_build',
    reason: 'store_operation_failed',
  });
});

test('runtime config diagnostics preserve primitive thrown values', () => {
  const error = 'SENSITIVE_PRIMITIVE_ERROR';

  assert.equal(markRuntimeConfigError(error, { stage: 'mutation_batch' }), error);
  assert.deepEqual(readRuntimeConfigErrorDiagnostic(error, { stage: 'unknown', reason: 'store_operation_failed' }), {
    stage: 'unknown',
    reason: 'store_operation_failed',
  });
});
