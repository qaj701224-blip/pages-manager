import assert from 'node:assert/strict';
import test from 'node:test';

import {
  bindDeploymentTrace,
  createDeploymentTraceContext,
  finishDeploymentStage,
  providerDiagnosticsFromError,
  recordDeploymentStage,
  startDeploymentStage,
  withDeploymentTraceHeader,
} from './deployment-trace.js';

test('deployment trace context owns the trace id and accepts only a safe inbound Ray id', () => {
  const request = new Request('https://api.pages.xd.team/.xd-pages/api/deployments', {
    headers: {
      'cf-ray': 'a2dfd41a7a7796d2-SIN',
      'x-deployment-trace-id': 'dtr_client_controlled',
    },
  });
  const trace = createDeploymentTraceContext(
    request,
    { nextId: (prefix) => `${prefix}_test` },
    { environment: 'production', operation: 'deploy' }
  );

  assert.equal(trace.traceId, 'dtr_test');
  assert.equal(trace.inboundRayId, 'a2dfd41a7a7796d2-SIN');
  assert.equal(trace.environment, 'production');
  assert.equal(trace.operation, 'deploy');
  assert.equal(trace.attempt, 1);
  assert.equal(trace.deploymentId, null);
  assert.equal(trace.siteId, null);

  const unsafe = createDeploymentTraceContext(
    new Request('https://api.pages.xd.team/.xd-pages/api/deployments', {
      headers: { 'cf-ray': 'Bearer secret value' },
    }),
    { nextId: () => 'dtr_safe' },
    { environment: 'production', operation: 'deploy' }
  );
  assert.equal(unsafe.inboundRayId, null);

  const urlLike = createDeploymentTraceContext(
    new Request('https://api.pages.xd.team/.xd-pages/api/deployments', {
      headers: { 'cf-ray': 'ray-prefix-https://private.example.test/path' },
    }),
    { nextId: () => 'dtr_safe' },
    { environment: 'production', operation: 'deploy' }
  );
  assert.equal(urlLike.inboundRayId, null);

  for (const sensitiveRayId of ['token_secret', 'Bearer-secret']) {
    const sensitive = createDeploymentTraceContext(
      new Request('https://api.pages.xd.team/.xd-pages/api/deployments', {
        headers: { 'cf-ray': sensitiveRayId },
      }),
      { nextId: () => 'dtr_safe' },
      { environment: 'production', operation: 'deploy' }
    );
    assert.equal(sensitive.inboundRayId, null);
  }

  const jwtLike = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhc3NldHMifQ.signature1234';
  const jwtRay = createDeploymentTraceContext(
    new Request('https://api.pages.xd.team/.xd-pages/api/deployments', {
      headers: { 'cf-ray': jwtLike },
    }),
    { nextId: () => 'dtr_safe' },
    { environment: 'production', operation: 'deploy' }
  );
  assert.equal(jwtRay.inboundRayId, null);
});

test('deployment trace binding can adopt an existing deployment trace without accepting invalid input', () => {
  const trace = createDeploymentTraceContext(
    new Request('https://example.test'),
    { nextId: () => 'dtr_test' },
    {
      environment: 'staging',
      operation: 'rollback',
    }
  );

  assert.equal(
    bindDeploymentTrace(trace, { traceId: 'dtr_existing', deploymentId: 'dep_1', siteId: 'site_1', attempt: 2 }),
    trace
  );
  bindDeploymentTrace(trace, { traceId: 'bad trace id', deploymentId: 'bad id', siteId: '', attempt: 0 });

  assert.equal(trace.traceId, 'dtr_existing');
  assert.equal(trace.deploymentId, 'dep_1');
  assert.equal(trace.siteId, 'site_1');
  assert.equal(trace.attempt, 2);
});

test('deployment trace response header preserves the response body, status, and existing headers', async () => {
  const response = withDeploymentTraceHeader(
    new Response(JSON.stringify({ code: 'DEPLOYMENT_UPLOAD_FAILED' }), {
      status: 502,
      headers: {
        'content-type': 'application/json',
        'x-deployment-trace-id': 'dtr_spoofed',
      },
    }),
    'dtr_server'
  );

  assert.equal(response.status, 502);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('x-deployment-trace-id'), 'dtr_server');
  assert.deepEqual(await response.json(), { code: 'DEPLOYMENT_UPLOAD_FAILED' });
});

test('deployment stages write one normalized terminal event with non-negative duration', async () => {
  const events = [];
  const times = [Date.parse('2026-08-20T08:00:00.000Z'), Date.parse('2026-08-20T08:00:00.025Z')];
  const trace = createDeploymentTraceContext(
    new Request('https://example.test', { headers: { 'cf-ray': 'ray-1/SIN' } }),
    {
      nextId: (prefix) => (prefix === 'dtr' ? 'dtr_test' : 'dpe_test'),
    },
    {
      environment: 'production',
      operation: 'deploy',
      store: { createDeploymentEvent: async (event) => events.push(event) },
      now: () => times.shift(),
    }
  );
  bindDeploymentTrace(trace, { deploymentId: 'dep_test', siteId: 'site_test', attempt: 3 });

  const handle = startDeploymentStage(trace, {
    stage: 'provider_upload',
    operation: 'worker_put',
  });
  const event = await finishDeploymentStage(handle, {
    status: 'failed',
    errorCode: 'DEPLOYMENT_UPLOAD_FAILED',
    errorMessage: 'Upload failed.',
    diagnostics: {
      causeClass: 'provider_upload_error',
      trafficImpact: 'old_version_retained',
      authorization: 'Bearer must-not-persist',
    },
  });

  assert.equal(events.length, 1);
  assert.deepEqual(event, {
    id: 'dpe_test',
    environment: 'production',
    traceId: 'dtr_test',
    inboundRayId: 'ray-1/SIN',
    deploymentId: 'dep_test',
    siteId: 'site_test',
    attempt: 3,
    stage: 'provider_upload',
    operation: 'worker_put',
    status: 'failed',
    startedAt: '2026-08-20T08:00:00.000Z',
    completedAt: '2026-08-20T08:00:00.025Z',
    durationMs: 25,
    errorCode: 'DEPLOYMENT_UPLOAD_FAILED',
    errorMessage: 'Upload failed.',
    diagnostics: {
      causeClass: 'provider_upload_error',
      trafficImpact: 'old_version_retained',
    },
    createdAt: '2026-08-20T08:00:00.025Z',
  });
});

test('deployment stage validation rejects unknown stages and terminal statuses', async () => {
  const trace = createDeploymentTraceContext(
    new Request('https://example.test'),
    { nextId: () => 'dtr_test' },
    {
      environment: 'production',
      operation: 'deploy',
    }
  );

  assert.throws(
    () => startDeploymentStage(trace, { stage: 'authorization_header', operation: 'log_secret' }),
    /DEPLOYMENT_TRACE_STAGE_INVALID/
  );
  const handle = startDeploymentStage(trace, { stage: 'intake', operation: 'parse_multipart' });
  await assert.rejects(() => finishDeploymentStage(handle, { status: 'started' }), /DEPLOYMENT_TRACE_STATUS_INVALID/);

  assert.equal(
    startDeploymentStage(trace, { stage: 'runtime_config', operation: 'worker_secret_put' }).operation,
    'worker_secret_put'
  );
});

test('provider diagnostics keep only safe bounded fields and redact credentials', () => {
  const error = new Error('must-not-persist');
  error.status = 502;
  error.code = 'WFP_API_ERROR';
  error.providerCode = 10090;
  error.providerMessage = `manifest\nrejected at https://api.cloudflare.com/accounts/private/workers ${'x'.repeat(800)}`;
  error.providerRequestId = 'provider-ray-1';
  error.authorization = 'Bearer must-not-persist';
  error.url = 'https://api.cloudflare.com/accounts/private';

  const diagnostics = providerDiagnosticsFromError(error);

  assert.deepEqual(
    {
      causeClass: diagnostics.causeClass,
      httpStatus: diagnostics.httpStatus,
      clientCode: diagnostics.clientCode,
      providerCode: diagnostics.providerCode,
      providerRequestId: diagnostics.providerRequestId,
    },
    {
      causeClass: 'provider_error',
      httpStatus: 502,
      clientCode: 'WFP_API_ERROR',
      providerCode: '10090',
      providerRequestId: 'provider-ray-1',
    }
  );
  assert.equal(diagnostics.providerMessage.length <= 512, true);
  assert.equal(
    [...diagnostics.providerMessage].some((character) => {
      const code = character.codePointAt(0);
      return code <= 0x1f || code === 0x7f;
    }),
    false
  );
  assert.doesNotMatch(diagnostics.providerMessage, /api\.cloudflare\.com|accounts\/private|https:\/\//);
  assert.match(diagnostics.providerMessage, /manifest rejected/);
  assert.match(diagnostics.providerMessage, /\[redacted-url\]/);
  assert.equal('authorization' in diagnostics, false);
  assert.equal('url' in diagnostics, false);

  for (const providerMessage of [
    'Bearer super-secret',
    '{"token":"json-secret"}',
    "password='quoted secret value'",
    'password is hunter2',
    'token is abc123',
    'secret was hidden-value',
    'Authorization: Basic dXNlcjpwYXNz',
    'upload rejected eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhc3NldHMifQ.signature1234',
  ]) {
    const credentialError = new Error('unsafe');
    credentialError.providerMessage = providerMessage;
    assert.equal('providerMessage' in providerDiagnosticsFromError(credentialError), false);
  }

  const unsafe = new Error('unsafe');
  unsafe.status = 999;
  unsafe.code = 'WFP_API_ERROR\nsecret';
  unsafe.providerCode = 'https://private.example.test/code';
  unsafe.providerRequestId = 'ray-prefix-https://private.example.test/path';
  assert.deepEqual(providerDiagnosticsFromError(unsafe), { causeClass: 'provider_error' });

  for (const providerRequestId of ['token_secret', 'Bearer-secret']) {
    const sensitiveIdError = new Error('unsafe');
    sensitiveIdError.providerRequestId = providerRequestId;
    assert.deepEqual(providerDiagnosticsFromError(sensitiveIdError), { causeClass: 'provider_error' });
  }

  const jwtIdError = new Error('unsafe');
  jwtIdError.providerRequestId = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJhc3NldHMifQ.signature1234';
  assert.deepEqual(providerDiagnosticsFromError(jwtIdError), { causeClass: 'provider_error' });
});

test('deployment stage diagnostics sanitize nested failure and compensation details', async () => {
  const events = [];
  const trace = createDeploymentTraceContext(
    new Request('https://example.test'),
    { nextId: (prefix) => `${prefix}_test` },
    {
      environment: 'production',
      operation: 'deploy',
      store: { createDeploymentEvent: async (event) => events.push(event) },
      now: () => Date.parse('2026-08-20T08:00:00.000Z'),
    }
  );

  await recordDeploymentStage(trace, {
    stage: 'cleanup_or_compensation',
    operation: 'worker_delete',
    status: 'failed',
    diagnostics: {
      cleanupStatus: 'failed',
      cleanupTaskId: 'cleanup_1',
      operatorAction: 'retry_deploy',
      originalFailure: {
        stage: 'provider_verify',
        code: 'DEPLOYMENT_VERIFY_FAILED',
        secret: 'must-not-persist',
      },
      compensation: {
        status: 'failed',
        operation: 'worker_delete',
        providerRequestId: 'provider-ray-2',
        password: 'must-not-persist',
      },
      requestBody: 'must-not-persist',
    },
  });

  assert.deepEqual(events[0].diagnostics, {
    cleanupStatus: 'failed',
    operatorAction: 'retry_deploy',
    cleanupTaskId: 'cleanup_1',
    originalFailure: {
      stage: 'provider_verify',
      code: 'DEPLOYMENT_VERIFY_FAILED',
    },
    compensation: {
      status: 'failed',
      operation: 'worker_delete',
      providerRequestId: 'provider-ray-2',
    },
  });
  assert.doesNotMatch(JSON.stringify(events[0]), /must-not-persist/);

  await recordDeploymentStage(trace, {
    stage: 'cleanup_or_compensation',
    operation: 'token_secret',
    status: 'failed',
    diagnostics: {
      causeClass: 'token_secret',
      trafficImpact: 'password',
      cleanupStatus: 'authorization',
      operatorAction: 'bearer_secret',
      cleanupTaskId: 'token_secret',
      originalFailure: {
        stage: 'provider_verify',
        code: 'PASSWORD',
      },
      compensation: {
        status: 'failed',
        operation: 'token_secret',
        providerRequestId: 'provider-ray-2',
      },
    },
  });

  assert.equal(events[1].operation, null);
  assert.deepEqual(events[1].diagnostics, {
    originalFailure: { stage: 'provider_verify' },
    compensation: {
      status: 'failed',
      providerRequestId: 'provider-ray-2',
    },
  });
  assert.doesNotMatch(JSON.stringify(events[1]), /token|secret|password|authorization|bearer/i);
});

test('deployment event store failures are isolated and emit only the safe fallback log schema', async () => {
  const lines = [];
  const trace = createDeploymentTraceContext(
    new Request('https://example.test'),
    { nextId: (prefix) => `${prefix}_test` },
    {
      environment: 'production',
      operation: 'deploy',
      store: {
        async createDeploymentEvent() {
          const error = new Error('SQL failed with Bearer secret and request body');
          error.stack = 'https://private.example.test/path';
          throw error;
        },
      },
      logger: (line) => lines.push(line),
      now: () => Date.parse('2026-08-20T08:00:00.000Z'),
    }
  );
  bindDeploymentTrace(trace, { deploymentId: 'dep_test' });

  await assert.doesNotReject(() =>
    recordDeploymentStage(trace, {
      stage: 'provider_upload',
      operation: 'worker_put',
      status: 'failed',
    })
  );

  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), {
    event: 'pages_deployment_trace_write_failed',
    traceId: 'dtr_test',
    deploymentId: 'dep_test',
    stage: 'provider_upload',
    operation: 'worker_put',
    causeClass: 'event_store_error',
  });
  assert.doesNotMatch(lines[0], /SQL|Bearer|request body|https:/);
});

test('deployment trace fallback logging never replaces the deployment result', async () => {
  const trace = createDeploymentTraceContext(
    new Request('https://example.test'),
    { nextId: (prefix) => `${prefix}_test` },
    {
      environment: 'production',
      operation: 'deploy',
      store: { createDeploymentEvent: async () => Promise.reject(new Error('STORE_FAILED')) },
      logger() {
        throw new Error('LOGGER_FAILED');
      },
      now: () => Date.parse('2026-08-20T08:00:00.000Z'),
    }
  );

  await assert.doesNotReject(() =>
    recordDeploymentStage(trace, {
      stage: 'deployment_state_persist',
      operation: 'mark_failed',
      status: 'failed',
    })
  );
});

test('deployment trace fallback logs reject sensitive operation values', async () => {
  const lines = [];
  const trace = createDeploymentTraceContext(
    new Request('https://example.test'),
    { nextId: (prefix) => `${prefix}_test` },
    {
      environment: 'production',
      operation: 'deploy',
      store: { createDeploymentEvent: async () => Promise.reject(new Error('STORE_FAILED')) },
      logger: (line) => lines.push(line),
      now: () => Date.parse('2026-08-20T08:00:00.000Z'),
    }
  );

  await recordDeploymentStage(trace, {
    stage: 'provider_upload',
    operation: 'token_secret',
    status: 'failed',
  });

  assert.equal(JSON.parse(lines[0]).operation, null);
  assert.doesNotMatch(lines[0], /token_secret/);
});
