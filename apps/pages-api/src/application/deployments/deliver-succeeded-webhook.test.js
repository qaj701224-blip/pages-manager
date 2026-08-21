import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentSucceededWebhook } from './deliver-succeeded-webhook.js';

const command = {
  environment: 'production',
  actor: { type: 'access_key', userId: 'usr_1', email: 'owner@example.com', name: 'Owner' },
  site: {
    id: 'site_1',
    slug: 'guide',
    ownerType: 'user',
    ownerId: 'usr_1',
    ownerUserId: 'usr_1',
    defaultVisibility: 'internal',
  },
  route: {
    hostname: 'guide.workers.xd.team',
    visibility: 'org',
    routeStatus: 'active',
  },
  deployment: {
    id: 'dep_1',
    status: 'succeeded',
    source: 'api',
    operation: 'deploy',
    createdAt: '2026-08-21T00:00:00.000Z',
    completedAt: '2026-08-21T00:01:00.000Z',
  },
};

function createApplication(overrides = {}) {
  return createDeploymentSucceededWebhook({
    teams: { get: null },
    webhooks: { deliver: async () => [] },
    telemetry: { start: () => null, finish: async () => null },
    clock: { now: () => '2026-08-21T00:02:00.000Z' },
    ids: { next: () => 'evt_1' },
    ...overrides,
  });
}

test('successful deployment webhook builds the stable event and reports delivery success', async () => {
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
        type: 'site.deployed',
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
          status: 'succeeded',
          source: 'api',
          operation: 'deploy',
          createdAt: '2026-08-21T00:00:00.000Z',
          completedAt: '2026-08-21T00:01:00.000Z',
        },
      },
      now: '2026-08-21T00:01:00.000Z',
    },
  ]);
});

test('successful deployment webhook enriches team-owned sites through the narrow teams port', async () => {
  const calls = [];
  const application = createApplication({
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

  assert.deepEqual(
    await application.deliver({
      ...command,
      site: { ...command.site, ownerType: 'team', ownerId: 'team_1' },
    }),
    { status: 'skipped' }
  );
  assert.deepEqual(calls, [
    ['team', 'team_1'],
    ['webhook', { id: 'team_1', name: 'Docs', teamType: 'custom' }],
  ]);
});

test('successful deployment webhook isolates failed deliveries and integration exceptions', async () => {
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

  const failedLookup = createApplication({
    teams: {
      get: async () => {
        throw new Error('secret database detail');
      },
    },
  });
  assert.deepEqual(
    await failedLookup.deliver({
      ...command,
      site: { ...command.site, ownerType: 'team', ownerId: 'team_1' },
    }),
    { status: 'failed', causeClass: 'webhook_delivery_error' }
  );
});

test('successful deployment webhook traces around delivery and preserves its outcome', async () => {
  const calls = [];
  const stage = { operation: 'site_deployed' };
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

  assert.deepEqual(await application.deliver(command), { status: 'succeeded' });
  assert.deepEqual(calls, [
    ['start'],
    ['deliver'],
    ['finish', stage, { status: 'succeeded' }],
  ]);
});

test('successful deployment webhook requires only its narrow capabilities', () => {
  assert.throws(
    () =>
      createDeploymentSucceededWebhook({
        teams: {},
        webhooks: {},
        telemetry: {},
        clock: { now() {} },
        ids: { next() {} },
      }),
    /webhooks\.deliver is required/
  );
});
