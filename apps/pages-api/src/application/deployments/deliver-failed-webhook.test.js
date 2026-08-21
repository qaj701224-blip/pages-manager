import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentFailedWebhook } from './deliver-failed-webhook.js';

const command = {
  environment: 'production',
  actor: { type: 'access_key', userId: 'usr_1', email: 'owner@example.com', realname: 'Owner' },
  site: {
    id: 'site_1',
    slug: 'guide',
    ownerType: 'user',
    ownerId: 'usr_1',
    ownerUserId: 'usr_1',
    defaultVisibility: 'internal',
    route: {
      hostname: 'guide.workers.xd.team',
      visibility: 'org',
      routeStatus: 'active',
    },
  },
  deployment: {
    id: 'dep_1',
    status: 'failed',
    source: 'api',
    operation: 'rollback',
    createdAt: '2026-08-21T00:00:00.000Z',
    completedAt: '2026-08-21T00:01:00.000Z',
    failureStage: 'rollback_activate_route',
    errorCode: 'ROUTE_ACTIVATION_CONFLICT',
  },
};

function createApplication(overrides = {}) {
  return createDeploymentFailedWebhook({
    teams: { get: null },
    webhooks: { deliver: async () => [] },
    telemetry: { start: () => null, finish: async () => null },
    clock: { now: () => '2026-08-21T00:02:00.000Z' },
    ids: { next: () => 'evt_1' },
    ...overrides,
  });
}

test('failed deployment webhook builds the stable safe event and reports delivery success', async () => {
  const calls = [];
  const application = createApplication({
    webhooks: {
      async deliver(event, options) {
        calls.push({ event, now: options.now() });
        return [{ deliveryStatus: 'succeeded' }];
      },
    },
  });

  assert.deepEqual(await application.deliver(command), { status: 'succeeded' });
  assert.deepEqual(calls, [
    {
      event: {
        id: 'evt_1',
        type: 'site.failed',
        environment: 'production',
        occurredAt: '2026-08-21T00:01:00.000Z',
        actor: {
          type: 'access_key',
          userId: 'usr_1',
          email: 'owner@example.com',
          name: 'Owner',
        },
        site: {
          id: 'site_1',
          slug: 'guide',
          hostname: 'guide.workers.xd.team',
          ownerType: 'user',
          ownerId: 'usr_1',
          visibility: 'org',
          status: 'active',
        },
        team: undefined,
        deployment: {
          id: 'dep_1',
          status: 'failed',
          source: 'api',
          operation: 'rollback',
          createdAt: '2026-08-21T00:00:00.000Z',
          completedAt: '2026-08-21T00:01:00.000Z',
          failureStage: 'rollback_activate_route',
          errorCode: 'ROUTE_ACTIVATION_CONFLICT',
        },
      },
      now: '2026-08-21T00:01:00.000Z',
    },
  ]);
});

test('failed deployment webhook enriches teams but tolerates optional team lookup failure', async () => {
  const calls = [];
  const teamSite = { ...command.site, ownerType: 'team', ownerId: 'team_1' };
  const enriched = createApplication({
    teams: {
      async get(teamId) {
        calls.push(['team', teamId]);
        return { id: teamId, name: 'Docs', teamType: 'custom' };
      },
    },
    webhooks: {
      async deliver(event) {
        calls.push(['webhook', event.team]);
        return [];
      },
    },
  });
  assert.deepEqual(await enriched.deliver({ ...command, site: teamSite }), { status: 'skipped' });
  assert.deepEqual(calls, [
    ['team', 'team_1'],
    ['webhook', { id: 'team_1', name: 'Docs', teamType: 'custom' }],
  ]);

  let delivered;
  const unavailable = createApplication({
    teams: {
      get: async () => {
        throw new Error('team store unavailable');
      },
    },
    webhooks: {
      async deliver(event) {
        delivered = event;
        return [{ deliveryStatus: 'succeeded' }];
      },
    },
  });
  assert.deepEqual(await unavailable.deliver({ ...command, site: teamSite }), { status: 'succeeded' });
  assert.equal(delivered.team, undefined);
});

test('failed deployment webhook isolates failed deliveries and integration exceptions', async () => {
  const failedDelivery = createApplication({
    webhooks: { deliver: async () => [{ deliveryStatus: 'failed' }, { deliveryStatus: 'succeeded' }] },
  });
  assert.deepEqual(await failedDelivery.deliver(command), {
    status: 'failed',
    causeClass: 'webhook_delivery_error',
  });

  const failedDispatch = createApplication({
    webhooks: {
      deliver: async () => {
        throw new Error('secret webhook detail');
      },
    },
  });
  assert.deepEqual(await failedDispatch.deliver(command), {
    status: 'failed',
    causeClass: 'webhook_delivery_error',
  });
});

test('failed deployment webhook keeps the actor optional', async () => {
  let delivered;
  const application = createApplication({
    webhooks: {
      async deliver(event) {
        delivered = event;
        return [];
      },
    },
  });

  await application.deliver({ ...command, actor: null });
  assert.equal(delivered.actor, undefined);
});

test('failed deployment webhook starts telemetry before deferring delivery and preserves its outcome', async () => {
  const calls = [];
  const stage = { operation: 'site_failed' };
  const application = createApplication({
    webhooks: {
      async deliver() {
        calls.push(['deliver']);
        return [{ deliveryStatus: 'succeeded' }];
      },
    },
    telemetry: {
      start() {
        calls.push(['start']);
        return stage;
      },
      async finish(receivedStage, outcome) {
        calls.push(['finish', receivedStage, outcome]);
      },
    },
  });

  const delivery = application.deliver(command);
  assert.deepEqual(calls, [['start']]);
  assert.deepEqual(await delivery, { status: 'succeeded' });
  assert.deepEqual(calls, [
    ['start'],
    ['deliver'],
    ['finish', stage, { status: 'succeeded' }],
  ]);
});

test('failed deployment webhook leaves telemetry start failures outside best-effort delivery isolation', () => {
  const startError = new Error('invalid trace');
  const application = createApplication({
    webhooks: { deliver: async () => assert.fail('delivery must not run') },
    telemetry: {
      start() {
        throw startError;
      },
      finish: async () => assert.fail('finish must not run'),
    },
  });

  assert.throws(() => application.deliver(command), (error) => error === startError);
});

test('failed deployment webhook requires only its narrow capabilities', () => {
  assert.throws(
    () =>
      createDeploymentFailedWebhook({
        teams: {},
        webhooks: {},
        telemetry: {},
        clock: { now() {} },
        ids: { next() {} },
      }),
    /webhooks\.deliver is required/
  );
});
