import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentTraceQuery } from './get-deployment-trace.js';

const deployment = {
  id: 'dep_1',
  traceId: 'dtr_1',
  status: 'failed',
  failureStage: 'provider_verify',
  errorCode: 'DEPLOYMENT_VERIFY_FAILED',
  errorMessage: 'Deployment verification failed.',
};

const event = {
  id: 'dpe_1',
  traceId: 'dtr_1',
  inboundRayId: 'ray-1',
  deploymentId: 'dep_1',
  siteId: 'site_1',
  attempt: 1,
  stage: 'provider_verify',
  operation: 'worker_get',
  status: 'failed',
  startedAt: '2026-08-21T00:00:00.000Z',
  completedAt: '2026-08-21T00:00:01.000Z',
  durationMs: 1000,
  errorCode: 'DEPLOYMENT_VERIFY_FAILED',
  errorMessage: 'Deployment verification failed.',
  diagnostics: { safe: true, token: 'must-not-return' },
};

function createApplication(overrides = {}) {
  return createDeploymentTraceQuery({
    deployments: { get: async () => deployment },
    events: {
      listByDeployment: async () => [event],
      listByTrace: async () => [event],
    },
    diagnostics: { sanitize: () => ({ safe: true }) },
    ...overrides,
  });
}

test('deployment trace query resolves a deployment timeline and sanitizes event diagnostics', async () => {
  const calls = [];
  const application = createApplication({
    deployments: {
      async get(id, environment) {
        calls.push(['deployment', id, environment]);
        return deployment;
      },
    },
    events: {
      async listByDeployment(input) {
        calls.push(['events', input]);
        return [event];
      },
      listByTrace: async () => assert.fail('trace lookup must not run'),
    },
    diagnostics: {
      sanitize(input) {
        calls.push(['sanitize', input]);
        return { safe: true };
      },
    },
  });

  assert.deepEqual(
    await application.byDeployment({ environment: 'production', deploymentId: 'dep_1' }),
    {
      ok: true,
      value: {
        trace: { traceId: 'dtr_1', inboundRayId: 'ray-1', deploymentId: 'dep_1' },
        deployment: {
          id: 'dep_1',
          traceId: 'dtr_1',
          inboundRayId: 'ray-1',
          status: 'failed',
          failureStage: 'provider_verify',
          errorCode: 'DEPLOYMENT_VERIFY_FAILED',
          errorMessage: 'Deployment verification failed.',
        },
        events: [
          {
            id: 'dpe_1',
            traceId: 'dtr_1',
            inboundRayId: 'ray-1',
            deploymentId: 'dep_1',
            siteId: 'site_1',
            attempt: 1,
            stage: 'provider_verify',
            operation: 'worker_get',
            status: 'failed',
            startedAt: '2026-08-21T00:00:00.000Z',
            completedAt: '2026-08-21T00:00:01.000Z',
            durationMs: 1000,
            errorCode: 'DEPLOYMENT_VERIFY_FAILED',
            errorMessage: 'Deployment verification failed.',
            diagnostics: { safe: true },
          },
        ],
      },
    }
  );
  assert.deepEqual(calls, [
    ['deployment', 'dep_1', 'production'],
    ['events', { environment: 'production', deploymentId: 'dep_1' }],
    ['sanitize', event.diagnostics],
  ]);
});

test('deployment trace query distinguishes a missing deployment without reading events', async () => {
  const application = createApplication({
    deployments: { get: async () => null },
    events: {
      listByDeployment: async () => assert.fail('missing deployment must stop event lookup'),
      listByTrace: async () => [],
    },
  });

  assert.deepEqual(await application.byDeployment({ environment: 'production', deploymentId: 'dep_missing' }), {
    ok: false,
    reason: 'deployment_not_found',
  });
});

test('deployment trace query resolves a pre-deployment timeline by trace id', async () => {
  const preDeploymentEvent = { ...event, traceId: 'dtr_pre', deploymentId: null, inboundRayId: 'ray-pre' };
  const application = createApplication({
    deployments: { get: async () => assert.fail('pre-deployment trace has no deployment lookup') },
    events: {
      listByDeployment: async () => [],
      listByTrace: async () => [preDeploymentEvent],
    },
  });

  const result = await application.byTraceId({ environment: 'production', traceId: 'dtr_pre' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.value.trace, { traceId: 'dtr_pre', inboundRayId: 'ray-pre', deploymentId: null });
  assert.equal(result.value.deployment, null);
});

test('deployment trace query rejects invalid or empty trace lookups', async () => {
  const application = createApplication({
    events: {
      listByDeployment: async () => [],
      listByTrace: async () => [],
    },
  });

  assert.deepEqual(await application.byTraceId({ environment: 'production', traceId: 'invalid' }), {
    ok: false,
    reason: 'trace_not_found',
  });
  assert.deepEqual(await application.byTraceId({ environment: 'production', traceId: 'dtr_missing' }), {
    ok: false,
    reason: 'trace_not_found',
  });
});

test('deployment trace query requires narrow repositories and sanitizer', () => {
  assert.throws(
    () => createDeploymentTraceQuery({ deployments: {}, events: {}, diagnostics: {} }),
    /deployments\.get is required/
  );
});
