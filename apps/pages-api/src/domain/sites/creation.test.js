import assert from 'node:assert/strict';
import test from 'node:test';

import { hostnameForSiteSlug } from './creation.js';

test('site hostname derivation keeps production and staging namespaces isolated', () => {
  assert.equal(
    hostnameForSiteSlug('guide', { environment: 'production', siteDomainSuffix: 'workers.xd.team' }),
    'guide.workers.xd.team'
  );
  assert.equal(
    hostnameForSiteSlug('guide', { environment: 'staging', siteDomainSuffix: 'workers.xd.team' }),
    'guide-staging.workers.xd.team'
  );
});
