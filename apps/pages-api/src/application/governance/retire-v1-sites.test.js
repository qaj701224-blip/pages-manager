import assert from 'node:assert/strict';
import test from 'node:test';

import { createV1SiteRetirement } from './retire-v1-sites.js';

test('v1 retirement preserves Worker, route, claim, then KV deletion order', async () => {
  const calls = [];
  const application = createApplication({
    siteKeys: [siteKey()],
    claim: activeClaim(),
    deleteWorker: async (input) => calls.push(['worker', input]),
    unbindRoute: async (input) => calls.push(['route', input]),
    releaseClaim: async (input) => (calls.push(['claim', input]), { ok: true }),
    deleteSite: async (name) => calls.push(['kv', name]),
  });

  const outcome = await application.retire(command());

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.result, {
    name: 'demo',
    workerName: 'pages-demo',
    hostname: 'demo.workers.xd.team',
    status: 'retired',
  });
  assert.deepEqual(calls.map(([stage]) => stage), ['worker', 'route', 'claim', 'kv']);
  assert.deepEqual(calls[2][1], {
    environment: 'production',
    hostname: 'demo.workers.xd.team',
    normalizedSlug: 'demo',
    hostnameFamily: 'workers',
    ownerSystem: 'v1',
    ownerId: 'v1:production:demo',
    ownerRef: 'pages-demo',
    source: 'v1_delete',
    status: 'active',
    releaseReason: 'site_retired',
    reuseHoldUntil: '2026-08-21T00:05:00.000Z',
    releasedAt: '2026-08-21T00:00:00.000Z',
  });
});

test('v1 retirement rejects reserved and invalid Worker metadata before destructive calls', async () => {
  let deletes = 0;
  const reserved = createApplication({
    siteKeys: [siteKey()],
    deleteWorker: async () => {
      deletes += 1;
    },
  });
  const invalid = createApplication({
    siteKeys: [siteKey({ metadata: { scriptName: 'pages-other', url: 'https://demo.workers.xd.team' } })],
    deleteWorker: async () => {
      deletes += 1;
    },
  });

  const reservedResult = await reserved.retire(command({ reservedWorkerNames: new Set(['pages-demo']) }));
  const invalidResult = await invalid.retire(command());

  assert.equal(reservedResult.result.errorCode, 'V1_SITE_PLATFORM_RESERVED');
  assert.equal(invalidResult.result.errorCode, 'V1_SITE_SCRIPT_INVALID');
  assert.equal(deletes, 0);
});

test('v1 retirement stops at the failing destructive stage', async () => {
  const calls = [];
  const application = createApplication({
    siteKeys: [siteKey()],
    deleteWorker: async () => calls.push('worker'),
    unbindRoute: async () => {
      calls.push('route');
      const error = new Error('route inventory failed');
      error.code = 'V1_SITE_ROUTE_UNSAFE';
      throw error;
    },
    deleteSite: async () => calls.push('kv'),
  });

  const outcome = await application.retire(command());

  assert.equal(outcome.result.stage, 'route_unbind');
  assert.equal(outcome.result.errorCode, 'V1_SITE_ROUTE_UNBIND_FAILED');
  assert.equal(outcome.result.cause.code, 'V1_SITE_ROUTE_UNSAFE');
  assert.deepEqual(calls, ['worker', 'route']);
});

test('v1 retirement requires the validation audit before deleting resources', async () => {
  let deletes = 0;
  const application = createApplication({
    siteKeys: [siteKey()],
    recordAudit: async ({ stage }) => {
      if (stage === 'validation') throw new Error('audit unavailable');
    },
    deleteWorker: async () => {
      deletes += 1;
    },
  });

  const outcome = await application.retire(command());

  assert.equal(outcome.result.errorCode, 'V1_SITE_AUDIT_FAILED');
  assert.equal(deletes, 0);
});

test('v1 batch retirement keeps input order and at most five destructive operations in flight', async () => {
  const names = Array.from({ length: 6 }, (_, index) => `demo-${index + 1}`);
  let activeDeletes = 0;
  let maxActiveDeletes = 0;
  const application = createApplication({
    siteKeys: names.map((name) => siteKeyFor(name)),
    deleteWorker: async () => {
      activeDeletes += 1;
      maxActiveDeletes = Math.max(maxActiveDeletes, activeDeletes);
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeDeletes -= 1;
    },
  });

  const outcome = await application.retireBatch(command({ names: [...names, 'missing'] }));

  assert.equal(outcome.ok, true);
  assert.deepEqual(outcome.summary, { requested: 7, retired: 6, failed: 1 });
  assert.deepEqual(outcome.results.map((result) => result.name), [...names, 'missing']);
  assert.equal(outcome.results.at(-1).errorCode, 'V1_SITE_NOT_FOUND');
  assert.ok(maxActiveDeletes > 1);
  assert.ok(maxActiveDeletes <= 5);
});

test('v1 retirement requires its narrow state and audit ports', () => {
  assert.throws(
    () => createV1SiteRetirement({ inventory: {}, claims: {}, audits: {}, clock: {} }),
    /inventory\.listSites is required/
  );
});

function createApplication({
  siteKeys = [],
  claim = null,
  deleteWorker = async () => {},
  unbindRoute = async () => {},
  releaseClaim = async () => ({ ok: true }),
  deleteSite = async () => {},
  recordAudit = async () => {},
} = {}) {
  return createV1SiteRetirement({
    inventory: {
      listSites: async () => siteKeys,
      getSiteRecord: async (name) => ({ scriptName: `pages-${name}` }),
      deleteSite,
    },
    workers: { delete: deleteWorker },
    routes: { unbind: unbindRoute },
    claims: {
      get: async () => claim,
      release: releaseClaim,
    },
    audits: { record: recordAudit },
    clock: { now: () => '2026-08-21T00:00:00.000Z' },
  });
}

function command(overrides = {}) {
  return {
    name: 'demo',
    environment: 'production',
    actorUserId: 'usr_admin',
    reservedWorkerNames: new Set(),
    reuseHoldSeconds: 300,
    ...overrides,
  };
}

function siteKey(overrides = {}) {
  return {
    name: 'demo',
    metadata: {
      scriptName: 'pages-demo',
      url: 'https://demo.workers.xd.team',
    },
    ...overrides,
  };
}

function siteKeyFor(name) {
  return {
    name,
    metadata: {
      scriptName: `pages-${name}`,
      url: `https://${name}.workers.xd.team`,
    },
  };
}

function activeClaim() {
  return {
    environment: 'production',
    ownerSystem: 'v1',
    ownerId: 'v1:production:demo',
    ownerRef: 'pages-demo',
    status: 'active',
  };
}
