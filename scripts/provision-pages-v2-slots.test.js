import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSlotRecord,
  CloudflareWorkersClient,
  cleanupNormalWorkerSlots,
  planNormalWorkerSlotCleanup,
  planNormalWorkerSlotProvisioning,
  provisionNormalWorkerSlots,
  renderSlotBindingName,
  renderSlotWorkerName,
} from './provision-pages-v2-slots.mjs';

const baseConfig = {
  environment: 'staging',
  minAvailable: 1,
  expandBy: 2,
  maxTotal: 100,
  cleanupRetentionSeconds: 7 * 24 * 60 * 60,
};

test('plans initial normal-worker-slot expansion from an empty D1 table', () => {
  const plan = planNormalWorkerSlotProvisioning([], baseConfig);

  assert.equal(plan.availableCount, 0);
  assert.equal(plan.previousBindingCount, 0);
  assert.equal(plan.bindingCount, 2);
  assert.deepEqual(plan.createSlotNumbers, [1, 2]);
});

test('keeps all historical slot bindings when available capacity is enough', () => {
  const slots = [
    buildSlotRecord({ environment: 'staging', slotNumber: 1, status: 'assigned' }),
    buildSlotRecord({ environment: 'staging', slotNumber: 2, status: 'disabled' }),
    buildSlotRecord({ environment: 'staging', slotNumber: 3, status: 'available' }),
  ];

  const plan = planNormalWorkerSlotProvisioning(slots, baseConfig);

  assert.equal(plan.availableCount, 1);
  assert.equal(plan.previousBindingCount, 3);
  assert.equal(plan.bindingCount, 3);
  assert.deepEqual(plan.createSlotNumbers, []);
});

test('wfp mode keeps historical slot binding count without expanding', async () => {
  const d1 = {
    async listWorkerSlots() {
      return [
        buildSlotRecord({ environment: 'staging', slotNumber: 1, status: 'assigned' }),
        buildSlotRecord({ environment: 'staging', slotNumber: 4, status: 'cleanup_pending' }),
      ];
    },
  };
  const result = await provisionNormalWorkerSlots({
    phase: 'prepare',
    config: { ...baseConfig, executionMode: 'wfp' },
    d1,
    cloudflare: {
      async putWorker() {
        throw new Error('should not create slot workers in wfp mode');
      },
    },
  });

  assert.equal(result.bindingCount, 4);
  assert.deepEqual(result.createSlotNumbers, []);
});

test('caps expansion at max total and fails closed when capacity cannot be restored', () => {
  const slotsAt99 = Array.from({ length: 99 }, (_, index) =>
    buildSlotRecord({ environment: 'staging', slotNumber: index + 1, status: 'assigned' })
  );
  const cappedPlan = planNormalWorkerSlotProvisioning(slotsAt99, baseConfig);

  assert.deepEqual(cappedPlan.createSlotNumbers, [100]);
  assert.equal(cappedPlan.bindingCount, 100);

  const slotsAt100 = Array.from({ length: 100 }, (_, index) =>
    buildSlotRecord({ environment: 'staging', slotNumber: index + 1, status: 'assigned' })
  );

  assert.throws(() => planNormalWorkerSlotProvisioning(slotsAt100, baseConfig), /SLOT_CAPACITY_EXHAUSTED/);
});

test('provisions missing slot workers, writes pending rows, and activates only after router deploy', async () => {
  const calls = [];
  const d1 = {
    slots: [],
    async listWorkerSlots(environment) {
      calls.push(['list', environment]);
      return this.slots;
    },
    async insertPendingWorkerSlot(slot) {
      calls.push(['insert', slot.id, slot.status]);
      this.slots.push(slot);
      return slot;
    },
    async activatePendingWorkerSlots({ environment, maxSlotNumber }) {
      calls.push(['activate', environment, maxSlotNumber]);
      for (const slot of this.slots) {
        if (slot.environment === environment && slot.status === 'available_pending_router' && slot.slotNumber <= maxSlotNumber) {
          slot.status = 'available';
        }
      }
      return this.slots.filter((slot) => slot.status === 'available').length;
    },
  };
  const cloudflare = {
    async putWorker({ workerName }) {
      calls.push(['putWorker', workerName]);
    },
  };

  const prepared = await provisionNormalWorkerSlots({
    phase: 'prepare',
    config: baseConfig,
    d1,
    cloudflare,
  });

  assert.equal(prepared.bindingCount, 2);
  assert.deepEqual(
    calls.filter((call) => call[0] === 'putWorker').map((call) => call[1]),
    ['pages-v2-staging-slot-001', 'pages-v2-staging-slot-002']
  );
  assert.deepEqual(
    d1.slots.map((slot) => [slot.id, slot.bindingName, slot.status]),
    [
      ['slot_001', 'SITE_SLOT_001', 'available_pending_router'],
      ['slot_002', 'SITE_SLOT_002', 'available_pending_router'],
    ]
  );

  const activated = await provisionNormalWorkerSlots({
    phase: 'activate',
    config: { ...baseConfig, bindingCount: prepared.bindingCount },
    d1,
    cloudflare,
  });

  assert.equal(activated.activatedCount, 2);
  assert.deepEqual(d1.slots.map((slot) => slot.status), ['available', 'available']);
});

test('plan phase computes slot expansion without writing Cloudflare or D1', async () => {
  const calls = [];
  const githubEnvWrites = [];
  const d1 = {
    async listWorkerSlots() {
      return [];
    },
    async insertPendingWorkerSlot() {
      throw new Error('plan must not insert slots');
    },
    async activatePendingWorkerSlots() {
      throw new Error('plan must not activate slots');
    },
  };
  const cloudflare = {
    async putWorker() {
      throw new Error('plan must not create workers');
    },
  };

  const result = await provisionNormalWorkerSlots({
    phase: 'plan',
    config: baseConfig,
    d1,
    cloudflare,
    env: {
      GITHUB_ENV: {
        async write(value) {
          githubEnvWrites.push(value);
        },
      },
      appendFile: async (...args) => calls.push(args),
    },
  });

  assert.equal(result.phase, 'plan');
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.createSlotNumbers, [1, 2]);
  assert.equal(result.bindingCount, 2);
  assert.deepEqual(calls, []);
  assert.deepEqual(githubEnvWrites, []);
});

test('Cloudflare slot provisioner disables workers.dev for placeholder workers', async () => {
  const requests = [];
  const client = new CloudflareWorkersClient({
    accountId: 'account_1',
    apiToken: 'cf_secret_token',
    fetchImpl: async (url, init = {}) => {
      requests.push({ url: String(url), init });
      return Response.json({ success: true, result: { id: 'ok' } });
    },
  });

  await client.putWorker({ workerName: 'pages-v2-staging-slot-001', environment: 'staging' });

  assert.equal(requests[0].init.method, 'PUT');
  assert.match(requests[0].url, /\/workers\/scripts\/pages-v2-staging-slot-001$/);
  assert.equal(requests[1].init.method, 'POST');
  assert.match(
    requests[1].url,
    /\/workers\/services\/pages-v2-staging-slot-001\/environments\/production\/subdomain$/
  );
  assert.deepEqual(JSON.parse(requests[1].init.body), { enabled: false });
});

test('plans cleanup only for inactive retained slots after the retention window', () => {
  const slots = [
    retainedSlot({ slotNumber: 1, assignedVersionId: 'ver_old', assignedAt: '2026-06-01T00:00:00.000Z' }),
    retainedSlot({ slotNumber: 2, assignedVersionId: 'ver_active', assignedAt: '2026-06-01T00:00:00.000Z' }),
    retainedSlot({ slotNumber: 3, assignedVersionId: 'ver_fresh', assignedAt: '2026-06-17T11:00:00.000Z' }),
    retainedSlot({
      slotNumber: 4,
      status: 'cleanup_pending',
      assignedVersionId: 'ver_pending',
      assignedAt: '2026-06-01T00:00:00.000Z',
    }),
  ];

  const plan = planNormalWorkerSlotCleanup({
    slots,
    activeRoutes: [{ slotId: 'slot_002', activeVersionId: 'ver_active' }],
    config: baseConfig,
    now: '2026-06-17T12:00:00.000Z',
  });

  assert.deepEqual(
    plan.cleanupSlots.map((slot) => slot.id),
    ['slot_001', 'slot_004']
  );
  assert.equal(plan.retainedSlots.find((slot) => slot.id === 'slot_002').reason, 'active');
  assert.equal(plan.retainedSlots.find((slot) => slot.id === 'slot_003').reason, 'retention_window');
});

test('cleanup overwrites inactive retained slot with placeholder before releasing it', async () => {
  const calls = [];
  const d1 = cleanupD1([
    retainedSlot({ slotNumber: 1, assignedVersionId: 'ver_old', assignedAt: '2026-06-01T00:00:00.000Z' }),
  ], calls);
  const cloudflare = {
    async putWorker({ workerName, environment }) {
      calls.push(['putWorker', workerName, environment]);
    },
  };

  const result = await cleanupNormalWorkerSlots({
    config: baseConfig,
    d1,
    cloudflare,
    now: '2026-06-17T12:00:00.000Z',
  });

  assert.deepEqual(result.cleanedSlotIds, ['slot_001']);
  assert.deepEqual(result.failedSlotIds, []);
  assert.deepEqual(calls, [
    ['mark', 'slot_001'],
    ['putWorker', 'pages-v2-staging-slot-001', 'staging'],
    ['release', 'slot_001'],
  ]);
  assert.equal(d1.slots[0].status, 'available');
  assert.equal(d1.slots[0].assignedVersionId, null);
  assert.equal(d1.slots[0].lastDeployedVersionId, 'ver_old');
});

test('cleanup leaves slot cleanup_pending when placeholder overwrite fails', async () => {
  const d1 = cleanupD1([
    retainedSlot({ slotNumber: 1, assignedVersionId: 'ver_old', assignedAt: '2026-06-01T00:00:00.000Z' }),
  ]);
  const cloudflare = {
    async putWorker() {
      throw new Error('cloudflare failed');
    },
  };

  const result = await cleanupNormalWorkerSlots({
    config: baseConfig,
    d1,
    cloudflare,
    now: '2026-06-17T12:00:00.000Z',
  });

  assert.deepEqual(result.cleanedSlotIds, []);
  assert.deepEqual(result.failedSlotIds, ['slot_001']);
  assert.equal(d1.slots[0].status, 'cleanup_pending');
  assert.equal(d1.slots[0].assignedVersionId, 'ver_old');
});

test('slot worker and binding names are stable across deploys', () => {
  assert.equal(renderSlotWorkerName('production', 7), 'pages-v2-production-slot-007');
  assert.equal(renderSlotWorkerName('staging', 7), 'pages-v2-staging-slot-007');
  assert.equal(renderSlotBindingName(7), 'SITE_SLOT_007');
});

function retainedSlot({
  slotNumber,
  status = 'assigned',
  assignedVersionId,
  assignedAt,
}) {
  const slot = buildSlotRecord({ environment: 'staging', slotNumber, status });
  return {
    ...slot,
    assignedSiteId: 'site_1',
    assignedRouteId: 'route_1',
    assignedVersionId,
    assignedAt,
    lastDeployedVersionId: assignedVersionId,
  };
}

function cleanupD1(slots, calls = []) {
  return {
    slots,
    async listWorkerSlots() {
      return this.slots;
    },
    async listActiveSlotReferences() {
      return [];
    },
    async markWorkerSlotCleanupPending(slot) {
      calls.push(['mark', slot.id]);
      const current = this.slots.find((candidate) => candidate.id === slot.id);
      if (!current || current.status === 'available') return null;
      current.status = 'cleanup_pending';
      return current;
    },
    async releaseCleanupWorkerSlot(slot) {
      calls.push(['release', slot.id]);
      const current = this.slots.find((candidate) => candidate.id === slot.id);
      if (!current || current.status !== 'cleanup_pending') return null;
      current.status = 'available';
      current.lastDeployedVersionId = current.assignedVersionId;
      current.assignedSiteId = null;
      current.assignedRouteId = null;
      current.assignedVersionId = null;
      current.assignedAt = null;
      return current;
    },
  };
}
