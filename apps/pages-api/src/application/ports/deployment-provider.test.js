import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeploymentProviderPort } from './deployment-provider.js';

test('deployment Provider port exposes only bound deployment capabilities', async () => {
  const source = {
    executionProvider: 'wfp',
    marker: 'bound',
    upload() {
      return this.marker;
    },
    verify() {},
    delete() {},
    cleanupRetainedSlot() {},
    removeOfficeNetBinding() {},
    verifyOfficeNetAbsent() {},
    internalMethod() {},
  };
  const port = createDeploymentProviderPort(() => source);
  const provider = port.create({ id: 'site_1' });

  assert.equal(await provider.upload({}), 'bound');
  assert.equal(provider.executionProvider, 'wfp');
  assert.equal(typeof provider.verify, 'function');
  assert.equal(typeof provider.delete, 'function');
  assert.equal(typeof provider.cleanupRetainedSlot, 'function');
  assert.equal(typeof provider.removeOfficeNetBinding, 'function');
  assert.equal(typeof provider.verifyOfficeNetAbsent, 'function');
  assert.equal(provider.internalMethod, undefined);
});

test('deployment Provider port preserves absent optional capabilities', () => {
  const provider = createDeploymentProviderPort(() => ({ executionProvider: 'wfp' })).create({ id: 'site_1' });
  assert.equal(provider.upload, null);
  assert.equal(provider.verify, null);
  assert.equal(provider.delete, null);
});

test('deployment Provider port requires a factory', () => {
  assert.throws(() => createDeploymentProviderPort(), /createProvider is required/);
});
