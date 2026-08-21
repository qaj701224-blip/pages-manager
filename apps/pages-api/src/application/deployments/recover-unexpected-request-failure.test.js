import assert from 'node:assert/strict';
import test from 'node:test';

import { createUnexpectedRequestFailureRecovery } from './recover-unexpected-request-failure.js';

const trace = {
  traceId: 'dtr_1',
  deploymentId: 'dep_1',
  siteId: 'site_1',
  operation: 'rollback',
};
const deployment = { id: 'dep_1', siteId: 'site_1', versionId: 'ver_1', status: 'activating' };
const site = { id: 'site_1', route: { activeVersionId: 'ver_previous' } };
const actor = { type: 'user', userId: 'usr_1' };
const failedPatch = { errorCode: 'DEPLOYMENT_REQUEST_FAILED', failureStage: 'deployment_operation' };
const command = {
  trace,
  actor,
  environment: 'production',
  fallbackOperation: 'orchestrate_rollback_request',
};

function createDependencies(overrides = {}) {
  return {
    requestTrace: { failUnexpected: async () => null },
    deployments: { get: async () => deployment },
    commits: { reconcile: async (value) => value },
    sites: { load: async () => site },
    failures: {
      patch: () => failedPatch,
      complete: async () => ({ ...deployment, status: 'failed' }),
    },
    logs: { stateWriteFailed: () => null },
    repairs: { report: () => null },
    ...overrides,
  };
}

test('unexpected request recovery traces a pre-deployment failure and stops without state reads', async () => {
  const calls = [];
  const application = createUnexpectedRequestFailureRecovery(
    createDependencies({
      requestTrace: {
        async failUnexpected(receivedTrace, input) {
          calls.push([receivedTrace, input]);
        },
      },
      deployments: { get: async () => assert.fail('deployment must not be read') },
    })
  );
  const preDeploymentTrace = { traceId: 'dtr_intake', deploymentId: null };

  assert.equal(await application.recover({ ...command, trace: preDeploymentTrace }), null);
  assert.deepEqual(calls, [
    [
      preDeploymentTrace,
      {
        fallbackStage: 'intake',
        fallbackOperation: 'orchestrate_rollback_request',
      },
    ],
  ]);
});

test('unexpected request recovery ignores trace persistence failure and continues terminal recovery', async () => {
  const calls = [];
  const recovered = { ...deployment, status: 'failed' };
  const application = createUnexpectedRequestFailureRecovery(
    createDependencies({
      requestTrace: {
        async failUnexpected() {
          calls.push('trace');
          throw new Error('trace unavailable');
        },
      },
      deployments: {
        async get() {
          calls.push('get');
          return deployment;
        },
      },
      commits: {
        async reconcile() {
          calls.push('reconcile');
          return deployment;
        },
      },
      sites: {
        async load() {
          calls.push('site');
          return site;
        },
      },
      failures: {
        patch: () => failedPatch,
        async complete() {
          calls.push('complete');
          return recovered;
        },
      },
    })
  );

  assert.equal(await application.recover(command), recovered);
  assert.deepEqual(calls, ['trace', 'get', 'reconcile', 'site', 'complete']);
});

test('unexpected request recovery logs an unreadable deployment and returns null', async () => {
  const logs = [];
  const application = createUnexpectedRequestFailureRecovery(
    createDependencies({
      deployments: {
        get: async () => {
          throw new Error('deployment store unavailable');
        },
      },
      logs: { stateWriteFailed: (input) => logs.push(input) },
      commits: { reconcile: async () => assert.fail('missing state must not reconcile') },
    })
  );

  assert.equal(await application.recover(command), null);
  assert.deepEqual(logs, [
    {
      traceId: 'dtr_1',
      deploymentId: 'dep_1',
      operation: 'persist_unexpected_deployment_failure',
    },
  ]);
});

test('unexpected request recovery returns missing or terminal deployment state unchanged', async () => {
  for (const value of [null, { ...deployment, status: 'succeeded' }, { ...deployment, status: 'failed' }]) {
    const application = createUnexpectedRequestFailureRecovery(
      createDependencies({
        deployments: { get: async () => value },
        commits: { reconcile: async () => assert.fail('terminal state must not reconcile') },
        failures: {
          patch: () => assert.fail('terminal state must not build a failure patch'),
          complete: async () => assert.fail('terminal state must not be failed'),
        },
      })
    );
    assert.equal(await application.recover(command), value);
  }
});

test('unexpected request recovery returns a reconciled terminal deployment before loading webhook context', async () => {
  const reconciled = { ...deployment, status: 'succeeded' };
  const application = createUnexpectedRequestFailureRecovery(
    createDependencies({
      commits: {
        async reconcile(value, environment, receivedTrace) {
          assert.equal(value, deployment);
          assert.equal(environment, 'production');
          assert.equal(receivedTrace, trace);
          return reconciled;
        },
      },
      sites: { load: async () => assert.fail('committed deployment does not need site context') },
      failures: {
        patch: () => assert.fail('committed deployment must not build a failure patch'),
        complete: async () => assert.fail('committed deployment must not be failed'),
      },
    })
  );

  assert.equal(await application.recover(command), reconciled);
});

test('unexpected request recovery reports commit reconciliation failure and preserves deployment state', async () => {
  const reports = [];
  const application = createUnexpectedRequestFailureRecovery(
    createDependencies({
      commits: {
        reconcile: async () => {
          throw new Error('route state unavailable');
        },
      },
      repairs: { report: (input) => reports.push(input) },
      failures: {
        patch: () => assert.fail('uncertain commit must not build a failure patch'),
        complete: async () => assert.fail('uncertain commit must not be failed'),
      },
    })
  );

  assert.equal(await application.recover(command), deployment);
  assert.deepEqual(reports, [
    {
      environment: 'production',
      siteId: 'site_1',
      deploymentId: 'dep_1',
      reason: 'deployment_commit_reconciliation_failed',
    },
  ]);
});

test('unexpected request recovery completes terminal failure with optional site context', async () => {
  const calls = [];
  const recovered = { ...deployment, status: 'failed' };
  const application = createUnexpectedRequestFailureRecovery(
    createDependencies({
      failures: {
        patch(operation) {
          assert.equal(operation, 'rollback');
          return failedPatch;
        },
        async complete(input) {
          calls.push(input);
          return recovered;
        },
      },
    })
  );

  assert.equal(await application.recover(command), recovered);
  assert.deepEqual(calls, [
    {
      deploymentId: 'dep_1',
      patch: failedPatch,
      actor,
      site,
      trace,
    },
  ]);

  const withoutSite = createUnexpectedRequestFailureRecovery(
    createDependencies({
      sites: {
        load: async () => {
          throw new Error('site projection unavailable');
        },
      },
      failures: {
        patch: () => failedPatch,
        async complete(input) {
          assert.equal(input.site, null);
          return recovered;
        },
      },
    })
  );
  assert.equal(await withoutSite.recover(command), recovered);
});

test('unexpected request recovery preserves state-write failure precedence and rethrows other completion errors', async () => {
  const stateError = new Error('failure state unavailable');
  stateError.code = 'DEPLOYMENT_STATE_WRITE_FAILED';
  const stateFailure = createUnexpectedRequestFailureRecovery(
    createDependencies({
      failures: {
        patch: () => failedPatch,
        complete: async () => {
          throw stateError;
        },
      },
    })
  );
  assert.equal(await stateFailure.recover(command), deployment);

  const unexpected = new Error('unexpected completion failure');
  const otherFailure = createUnexpectedRequestFailureRecovery(
    createDependencies({
      failures: {
        patch: () => failedPatch,
        complete: async () => {
          throw unexpected;
        },
      },
    })
  );
  await assert.rejects(() => otherFailure.recover(command), (error) => error === unexpected);
});

test('unexpected request recovery requires its narrow capabilities', () => {
  assert.throws(
    () =>
      createUnexpectedRequestFailureRecovery({
        requestTrace: {},
        deployments: {},
        commits: {},
        sites: {},
        failures: {},
        logs: {},
        repairs: {},
      }),
    /requestTrace\.failUnexpected is required/
  );
});
