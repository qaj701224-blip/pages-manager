import assert from 'node:assert/strict';
import test from 'node:test';

import { siteDeleteErrorResponse } from './site-lifecycle-application.js';
import { siteTransferErrorResponse } from './site-ownership-application.js';

for (const code of ['SITE_POLICY_LOCKED', 'SITE_POLICY_CONFLICT', 'SITE_COMMIT_TIMEOUT']) {
  test(`site transfer maps ${code} to the stable policy conflict response`, async () => {
    const response = siteTransferErrorResponse(Object.assign(new Error(code), { code }));

    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'SITE_POLICY_CONFLICT');
  });
}

for (const [operation, responseFor] of [
  ['transfer', siteTransferErrorResponse],
  ['delete', siteDeleteErrorResponse],
]) {
  test(`site ${operation} preserves the route repair-required error`, async () => {
    const code = 'ROUTE_POLICY_REPAIR_REQUIRED';
    const response = responseFor(Object.assign(new Error(code), { code }));

    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, code);
  });
}
