import assert from 'node:assert/strict';
import test from 'node:test';

import { createSiteRouteSnapshots } from './site-route-snapshots.js';

test('deployment snapshot commit reloads site authority and ACL before writing', async () => {
  const calls = [];
  const latestSite = { id: 'site_1', slug: 'guide', requiredSessionVersion: 2 };
  const aclEntries = [{ effect: 'allow', subjectType: 'user', subjectValue: 'usr_2' }];
  const route = { id: 'route_1', activeVersionId: 'ver_2' };
  const version = { id: 'ver_2' };
  const snapshot = { routeId: 'route_1', activeVersionId: 'ver_2' };
  const routeSnapshots = createSiteRouteSnapshots({
    store: {
      async listSiteAclEntries(siteId) {
        calls.push(['listSiteAclEntries', siteId]);
        return aclEntries;
      },
      async getSite(siteId) {
        calls.push(['getSite', siteId]);
        return latestSite;
      },
    },
    buildSnapshot(input) {
      calls.push(['buildSnapshot', input]);
      return snapshot;
    },
    async writeSnapshot(input) {
      calls.push(['writeSnapshot', input]);
    },
  });

  assert.equal(
    await routeSnapshots.commitDeployment({ site: { id: 'site_1', slug: 'stale' }, route, version }),
    snapshot
  );
  assert.deepEqual(calls, [
    ['listSiteAclEntries', 'site_1'],
    ['getSite', 'site_1'],
    ['buildSnapshot', { site: latestSite, route, version, aclEntries }],
    ['writeSnapshot', snapshot],
  ]);
});
