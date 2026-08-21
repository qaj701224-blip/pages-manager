import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentTraceContext, startDeploymentStage } from '../../deployment-trace.js';
import {
  clearRequestTraceStage,
  discardReplayRequestTrace,
  ensureRequestFailureTraced,
  finishRequestAuthStage,
  finishRequestAuthStageFromResponse,
  finishValidatedRequestTrace,
  queueRequestTraceSuccess,
  setRequestTraceStage,
  traceFailureResponse,
  traceUnexpectedRequestFailure,
  withRequestTraceHeader,
} from './deployment-request-trace.js';

function createTrace() {
  const events = [];
  let id = 0;
  let now = Date.parse('2026-08-21T00:00:00.000Z');
  const trace = createDeploymentTraceContext(
    null,
    { nextId: (prefix) => (prefix === 'dtr' ? 'dtr_1' : `${prefix}_${++id}`) },
    {
      environment: 'production',
      operation: 'deploy',
      store: { createDeploymentEvent: async (event) => events.push(event) },
      now: () => now++,
    }
  );
  return { trace, events };
}

test('deployment request trace flushes validated stages in response order', async () => {
  const { trace, events } = createTrace();
  queueRequestTraceSuccess(trace, 'intake', 'accept_request');
  queueRequestTraceSuccess(trace, 'payload_validation', 'validate_deployment_payload');
  const authStage = startDeploymentStage(trace, {
    stage: 'auth_and_site_resolution',
    operation: 'authenticate_request',
  });

  await finishValidatedRequestTrace(trace, authStage);
  assert.deepEqual(
    events.map(({ stage, operation, status }) => [stage, operation, status]),
    [
      ['intake', 'accept_request', 'succeeded'],
      ['auth_and_site_resolution', 'authenticate_request', 'succeeded'],
      ['payload_validation', 'validate_deployment_payload', 'succeeded'],
    ]
  );
  assert.equal(await finishRequestAuthStage(authStage, { status: 'failed' }), null);
});

test('deployment request trace records safe response errors after pending successes', async () => {
  const { trace, events } = createTrace();
  queueRequestTraceSuccess(trace, 'intake', 'accept_request');
  const authStage = startDeploymentStage(trace, {
    stage: 'auth_and_site_resolution',
    operation: 'resolve_site',
  });
  await finishRequestAuthStageFromResponse(
    authStage,
    new Response(JSON.stringify({ error: { code: 'SITE_NOT_FOUND', message: 'Site not found.' } }), {
      status: 404,
    }),
    'site_resolution_error'
  );

  assert.deepEqual(
    events.map(({ stage, status, errorCode, diagnostics }) => [stage, status, errorCode, diagnostics]),
    [
      ['intake', 'succeeded', null, null],
      [
        'auth_and_site_resolution',
        'failed',
        'SITE_NOT_FOUND',
        { causeClass: 'site_resolution_error' },
      ],
    ]
  );
});

test('deployment request trace records a response failure once and preserves the response', async () => {
  const { trace, events } = createTrace();
  setRequestTraceStage(trace, 'payload_validation', 'validate_content_hash');
  const response = new Response(
    JSON.stringify({ error: { code: 'CONTENT_HASH_MISMATCH', message: 'Content hash is invalid.' } }),
    { status: 400 }
  );

  assert.equal(await ensureRequestFailureTraced(trace, response), response);
  assert.equal(await ensureRequestFailureTraced(trace, response), response);
  assert.deepEqual(
    events.map(({ stage, operation, status, errorCode }) => [stage, operation, status, errorCode]),
    [['payload_validation', 'validate_content_hash', 'failed', 'CONTENT_HASH_MISMATCH']]
  );

  const ignored = new Response(null, { status: 500 });
  assert.equal(await traceFailureResponse(null, ignored, {}), ignored);
});

test('deployment request trace records one unexpected fallback and supports replay discard', async () => {
  const { trace, events } = createTrace();
  await traceUnexpectedRequestFailure(trace, {
    fallbackStage: 'intake',
    fallbackOperation: 'orchestrate_deployment_request',
  });
  await traceUnexpectedRequestFailure(trace, {
    fallbackStage: 'deployment_operation',
    fallbackOperation: 'must_not_replace',
  });
  assert.deepEqual(
    events.map(({ stage, operation, status, errorCode }) => [stage, operation, status, errorCode]),
    [['intake', 'orchestrate_deployment_request', 'failed', 'DEPLOYMENT_REQUEST_FAILED']]
  );

  clearRequestTraceStage(trace);
  queueRequestTraceSuccess(trace, 'intake', 'accept_request');
  const authStage = startDeploymentStage(trace, {
    stage: 'auth_and_site_resolution',
    operation: 'authenticate_request',
  });
  discardReplayRequestTrace(trace, authStage);
  assert.equal(await finishRequestAuthStage(authStage, { status: 'succeeded' }), null);
  assert.equal(events.length, 1);
});

test('deployment request trace header keeps an existing server trace id', () => {
  const { trace } = createTrace();
  const existing = withRequestTraceHeader(
    new Response(null, { headers: { 'X-Deployment-Trace-Id': 'dtr_existing' } }),
    trace
  );
  assert.equal(existing.headers.get('X-Deployment-Trace-Id'), 'dtr_existing');
  assert.equal(withRequestTraceHeader(existing, null), existing);
});
