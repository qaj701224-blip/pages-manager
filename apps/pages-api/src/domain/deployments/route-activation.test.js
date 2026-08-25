import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveDeploymentRouteActivation } from './route-activation.js';

const site = { id: 'site_1', defaultVisibility: 'org' };
const routeBeforeActivation = {
  id: 'route_1',
  activeVersionId: 'ver_1',
  visibility: 'internal',
  exposure: 'internal',
  policyVersion: 2,
  routeGeneration: 3,
  runtimeConfigGeneration: 4,
};

test('deployment route activation uses the site default when visibility did not change during upload', () => {
  const latestRoute = { ...routeBeforeActivation, exposure: null };

  const result = resolveDeploymentRouteActivation({
    site,
    routeBeforeActivation,
    latestRoute,
    uploadExposure: 'internal',
    ownerTransferApplied: false,
  });

  assert.deepEqual(result, {
    ok: true,
    activation: {
      exposure: 'internal',
      visibility: 'org',
      expectedRoute: { ...latestRoute, exposure: 'internal' },
    },
  });
  assert.notEqual(result.activation.expectedRoute, latestRoute);
});

test('deployment route activation preserves a visibility policy change made during upload', () => {
  const latestRoute = { ...routeBeforeActivation, visibility: 'owner' };

  const result = resolveDeploymentRouteActivation({
    site,
    routeBeforeActivation,
    latestRoute,
    uploadExposure: 'internal',
    ownerTransferApplied: false,
  });

  assert.equal(result.ok, true);
  assert.equal(result.activation.visibility, 'owner');
});

test('deployment route activation applies an explicitly requested transfer visibility', () => {
  const latestRoute = { ...routeBeforeActivation, visibility: 'owner', exposure: 'public' };

  const result = resolveDeploymentRouteActivation({
    site: { ...site, defaultVisibility: 'disabled' },
    routeBeforeActivation,
    latestRoute,
    uploadExposure: 'public',
    ownerTransferApplied: true,
    ownerTransferVisibility: 'disabled',
  });

  assert.equal(result.ok, true);
  assert.equal(result.activation.exposure, 'public');
  assert.equal(result.activation.visibility, 'disabled');
  assert.equal(result.activation.expectedRoute.exposure, 'public');
});

test('deployment route activation preserves latest visibility when transfer visibility is omitted', () => {
  const latestRoute = { ...routeBeforeActivation, visibility: 'disabled' };

  const result = resolveDeploymentRouteActivation({
    site,
    routeBeforeActivation,
    latestRoute,
    uploadExposure: 'internal',
    ownerTransferApplied: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.activation.visibility, 'disabled');
});

test('deployment route activation rejects a missing latest route', () => {
  assert.deepEqual(
    resolveDeploymentRouteActivation({
      site,
      routeBeforeActivation,
      latestRoute: null,
      uploadExposure: 'internal',
      ownerTransferApplied: false,
    }),
    { ok: false, error: { code: 'ROUTE_ACTIVATION_CONFLICT', reason: 'route_missing' } }
  );
});

test('deployment route activation rejects exposure drift after upload', () => {
  assert.deepEqual(
    resolveDeploymentRouteActivation({
      site,
      routeBeforeActivation,
      latestRoute: { ...routeBeforeActivation, exposure: 'public' },
      uploadExposure: 'internal',
      ownerTransferApplied: false,
    }),
    { ok: false, error: { code: 'ROUTE_ACTIVATION_CONFLICT', reason: 'exposure_changed' } }
  );
});
