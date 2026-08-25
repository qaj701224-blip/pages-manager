import assert from 'node:assert/strict';
import test from 'node:test';

import { createSiteMetadataPort } from './site-metadata.js';

test('site metadata port exposes only the required store operations', () => {
  const store = Object.fromEntries(
    [
      'withSiteCommitLock',
      'getSite',
      'getSiteForUser',
      'getAccessKeyById',
      'getUser',
      'getTeam',
      'isPlatformAdmin',
      'getRouteBySiteId',
      'listSiteRetiringHostnameClaims',
      'listSitesPendingSlugRouting',
      'markSiteSlugRoutingReconcileAttempted',
      'commitSiteMetadata',
      'completeSiteSlugRelease',
      'markSiteSlugRoutingSynced',
    ].map((name) => [
      name,
      function operation() {
        return this;
      },
    ])
  );
  const port = createSiteMetadataPort(store);

  assert.deepEqual(Object.keys(port), Object.keys(store));
  assert.equal(port.getSite(), store);
});

test('site metadata port rejects incomplete stores', () => {
  assert.throws(() => createSiteMetadataPort({}), /site metadata port method is required/);
});
