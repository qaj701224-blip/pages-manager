import assert from 'node:assert/strict';
import test from 'node:test';

import { createSuccessfulDeploymentFinalization } from './finalize-successful-deployment.js';

const deployment = { id: 'dep_1', status: 'activating' };
const completed = { ...deployment, status: 'succeeded', versionId: 'ver_2' };
const version = { id: 'ver_2' };
const previousRoute = { id: 'route_1', activeVersionId: 'ver_1', visibility: 'org' };
const route = { id: 'route_1', activeVersionId: 'ver_2', visibility: 'disabled' };
const actor = { type: 'user', userId: 'usr_1' };
const site = { id: 'site_1', slug: 'guide' };
const command = { deployment, version, previousRoute, route, actor, site, environment: 'production' };

test('successful deployment finalization persists, cleans, and schedules webhooks in order', async () => {
  const calls = [];
  const webhookResult = { status: 'succeeded' };
  const application = createSuccessfulDeploymentFinalization({
    completion: {
      async complete(input) {
        calls.push(['complete', input]);
        return completed;
      },
    },
    cleanup: {
      async cleanup(input) {
        calls.push(['cleanup', input]);
      },
    },
    webhooks: {
      async deliver(input) {
        calls.push(['webhook', input]);
        return webhookResult;
      },
    },
    lifecycle: {
      async emitDisabled(input) {
        calls.push(['disabled', input]);
      },
    },
    taskScheduler: {
      async schedule(task) {
        calls.push(['schedule', await task]);
      },
    },
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
  });

  assert.equal(await application.finalize(command), completed);
  assert.deepEqual(calls, [
    [
      'complete',
      {
        deployment,
        versionId: 'ver_2',
        previousVersionId: 'ver_1',
        completedAt: '2026-08-21T00:00:00.000Z',
      },
    ],
    [
      'cleanup',
      {
        environment: 'production',
        previousRoute,
        activeRoute: route,
        deployment: completed,
      },
    ],
    ['webhook', { actor, site, route, deployment: completed, environment: 'production' }],
    ['schedule', webhookResult],
    ['disabled', { actor, site, previousRoute, route }],
  ]);
});

test('successful deployment finalization preserves an empty previous version', async () => {
  let completionInput;
  const application = createSuccessfulDeploymentFinalization({
    completion: {
      async complete(input) {
        completionInput = input;
        return completed;
      },
    },
    cleanup: { cleanup: async () => null },
    webhooks: { deliver: async () => ({ status: 'skipped' }) },
    lifecycle: { emitDisabled: async () => null },
    taskScheduler: { schedule: async (task) => task },
    clock: { now: () => 'now' },
  });

  await application.finalize({ ...command, previousRoute: null });
  assert.equal(completionInput.previousVersionId, null);
});

test('successful deployment finalization requires its narrow capabilities', () => {
  assert.throws(
    () =>
      createSuccessfulDeploymentFinalization({
        completion: {},
        cleanup: {},
        webhooks: {},
        lifecycle: {},
        taskScheduler: {},
        clock: {},
      }),
    /completion\.complete is required/
  );
  assert.throws(
    () =>
      createSuccessfulDeploymentFinalization({
        completion: { complete() {} },
        cleanup: { cleanup() {} },
        webhooks: { deliver() {} },
        lifecycle: { emitDisabled() {} },
        taskScheduler: {},
        clock: { now() {} },
      }),
    /taskScheduler\.schedule is required/
  );
});
