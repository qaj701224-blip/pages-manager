import assert from 'node:assert/strict';
import test from 'node:test';

import { createUnexpectedDeploymentRecoveryPort } from './unexpected-deployment-recovery.js';

test('unexpected deployment recovery port exposes bound deployment and site projection capabilities', async () => {
  const store = {
    marker: 'bound',
    getDeployment(id, environment) {
      return [this.marker, 'deployment', id, environment];
    },
    getSite(id, environment) {
      return { marker: this.marker, id, environment };
    },
    getRouteBySiteId(id, environment) {
      return { marker: this.marker, siteId: id, environment };
    },
    updateDeployment() {},
  };
  const port = createUnexpectedDeploymentRecoveryPort(store);

  assert.deepEqual(Object.keys(port), ['getDeployment', 'loadSite']);
  assert.deepEqual(await port.getDeployment('dep_1', 'production'), [
    'bound',
    'deployment',
    'dep_1',
    'production',
  ]);
  assert.deepEqual(await port.loadSite('site_1', 'production'), {
    marker: 'bound',
    id: 'site_1',
    environment: 'production',
    route: { marker: 'bound', siteId: 'site_1', environment: 'production' },
  });
});

test('unexpected deployment recovery port keeps site and route lookups optional', async () => {
  const withoutSites = createUnexpectedDeploymentRecoveryPort({ getDeployment() {} });
  assert.equal(await withoutSites.loadSite('site_1', 'production'), null);

  const site = { id: 'site_1' };
  const withoutRoutes = createUnexpectedDeploymentRecoveryPort({
    getDeployment() {},
    getSite: async () => site,
  });
  assert.equal(await withoutRoutes.loadSite('site_1', 'production'), site);

  const missingRoute = createUnexpectedDeploymentRecoveryPort({
    getDeployment() {},
    getSite: async () => site,
    getRouteBySiteId: async () => null,
  });
  assert.equal(await missingRoute.loadSite('site_1', 'production'), site);
});

test('unexpected deployment recovery port requires deployment lookup', () => {
  assert.throws(
    () => createUnexpectedDeploymentRecoveryPort({}),
    /unexpected deployment recovery port method is required: getDeployment/
  );
});
