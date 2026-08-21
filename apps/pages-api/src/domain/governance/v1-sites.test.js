import assert from 'node:assert/strict';
import test from 'node:test';

import {
  expectedV1WorkerName,
  isManagedV1WorkerName,
  isValidV1SiteScriptName,
  readV1Hostname,
  readV1SiteRecord,
  v1HostnameClaimMatches,
} from './v1-sites.js';

test('v1 site rules keep production and staging Worker namespaces isolated', () => {
  assert.equal(expectedV1WorkerName('demo', 'production'), 'pages-demo');
  assert.equal(expectedV1WorkerName('demo', 'staging'), 'pages-staging-demo');
  assert.equal(isManagedV1WorkerName('pages-demo', 'production'), true);
  assert.equal(isManagedV1WorkerName('pages-staging-demo', 'production'), false);
  assert.equal(isManagedV1WorkerName('pages-staging-demo', 'staging'), true);
  assert.equal(isManagedV1WorkerName('pages-v2-demo', 'production'), false);
  assert.equal(isValidV1SiteScriptName('demo', 'pages-demo', 'production'), true);
  assert.equal(isValidV1SiteScriptName('demo', 'pages-other', 'production'), false);
});

test('v1 site rules normalize records and accept only exact workers.xd.team hostnames', () => {
  assert.deepEqual(
    readV1SiteRecord({
      name: ' demo ',
      metadata: { scriptName: ' pages-demo ', url: ' https://demo.workers.xd.team ', secret: 'hidden' },
    }),
    {
      name: 'demo',
      metadata: { scriptName: ' pages-demo ', url: ' https://demo.workers.xd.team ', secret: 'hidden' },
      scriptName: 'pages-demo',
      url: 'https://demo.workers.xd.team',
    }
  );
  assert.equal(readV1Hostname('https://demo.workers.xd.team'), 'demo.workers.xd.team');
  assert.equal(readV1Hostname('https://demo.workers.xd.team/path'), null);
  assert.equal(readV1Hostname('https://workers.xd.team'), null);
});

test('v1 hostname claim matching requires the exact environment and owner', () => {
  const claim = {
    environment: 'production',
    ownerSystem: 'v1',
    ownerId: 'v1:production:demo',
    ownerRef: 'pages-demo',
  };
  assert.equal(
    v1HostnameClaimMatches(claim, {
      environment: 'production',
      siteName: 'demo',
      workerName: 'pages-demo',
    }),
    true
  );
  assert.equal(
    v1HostnameClaimMatches(claim, {
      environment: 'staging',
      siteName: 'demo',
      workerName: 'pages-staging-demo',
    }),
    false
  );
});
