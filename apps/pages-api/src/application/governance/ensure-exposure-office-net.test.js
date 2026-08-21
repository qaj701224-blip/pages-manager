import assert from 'node:assert/strict';
import test from 'node:test';

import { createExposureOfficeNetVerification } from './ensure-exposure-office-net.js';

const site = { id: 'site_1' };
const route = { id: 'route_1', workerName: 'worker_1', executionProvider: 'wfp' };
const version = { id: 'ver_1', workerName: 'worker_1', executionProvider: 'wfp', deploymentShape: 'worker-only' };
const lease = { signal: { aborted: false } };
const operation = {
  operationId: 'op_1',
  now: '2026-08-21T00:00:00.000Z',
  auditMetadata: { operationId: 'op_1', requestedExposure: 'public' },
};
const command = {
  environment: 'production',
  actorUserId: 'usr_admin',
  site,
  route,
  version,
  lease,
  exposure: 'public',
  previousExposure: 'internal',
  operation,
};

function createApplication(overrides = {}) {
  return createExposureOfficeNetVerification({
    officeNet: { ensure: async () => ({ status: 'verified' }) },
    audits: { record: async () => null },
    telemetry: { auditUnconfirmed: () => null },
    ...overrides,
  });
}

test('exposure OfficeNet verification runs before recording verified evidence', async () => {
  const calls = [];
  const application = createApplication({
    officeNet: {
      async ensure(input) {
        calls.push(['office-net', input]);
        return { status: 'verified' };
      },
    },
    audits: { record: async (input) => calls.push(['audit', input]) },
  });

  assert.deepEqual(await application.ensure(command), { status: 'verified' });
  assert.deepEqual(calls, [
    [
      'office-net',
      {
        environment: 'production',
        siteId: 'site_1',
        workerName: 'worker_1',
        executionProvider: 'wfp',
        deploymentShape: 'worker-only',
        exposure: 'public',
        signal: lease.signal,
      },
    ],
    [
      'audit',
      {
        id: 'op_1:office_net_removed_verified',
        environment: 'production',
        traceId: 'op_1',
        eventType: 'admin.site.exposure',
        actorUserId: 'usr_admin',
        actorType: 'platform_admin',
        siteId: 'site_1',
        routeId: 'route_1',
        versionId: 'ver_1',
        decision: 'allow',
        statusCode: 200,
        metadata: {
          operationId: 'op_1',
          requestedExposure: 'public',
          previousExposure: 'internal',
          authorityExposure: 'internal',
          effectiveExposure: null,
          officeNetBindingRemoved: true,
          officeNetBindingVerified: true,
          officeNetBindingNotApplicable: false,
          officeNetCheckReason: null,
          stage: 'office_net_removed_verified',
        },
        createdAt: '2026-08-21T00:00:00.000Z',
      },
    ],
  ]);
});

test('exposure OfficeNet verification skips provider and audit for internal exposure', async () => {
  const application = createApplication({
    officeNet: { ensure: async () => assert.fail('internal exposure must not touch OfficeNet') },
    audits: { record: async () => assert.fail('internal exposure must not record OfficeNet audit') },
  });

  assert.equal(await application.ensure({ ...command, exposure: 'internal' }), null);
});

test('exposure OfficeNet verification reports but does not fail on stage audit loss', async () => {
  const cause = new Error('audit unavailable');
  const warnings = [];
  const application = createApplication({
    officeNet: { ensure: async () => ({ status: 'not_applicable', reason: 'assets-only' }) },
    audits: { record: async () => Promise.reject(cause) },
    telemetry: { auditUnconfirmed: (input) => warnings.push(input) },
  });

  assert.deepEqual(await application.ensure(command), { status: 'not_applicable', reason: 'assets-only' });
  assert.deepEqual(warnings, [
    {
      operationId: 'op_1',
      siteId: 'site_1',
      environment: 'production',
      stage: 'office_net_not_applicable',
      cause,
    },
  ]);
});

test('exposure OfficeNet verification requires narrow capabilities', () => {
  assert.throws(
    () => createExposureOfficeNetVerification({ officeNet: {}, audits: {}, telemetry: {} }),
    /officeNet\.ensure is required/
  );
});
