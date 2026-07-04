import assert from 'node:assert/strict';
import test from 'node:test';

import { adminSiteOwnerView, siteCardOwnerLabel, sitePublicUrl } from './site-display-model.js';

test('sitePublicUrl displays hostnames with https protocol', () => {
  assert.equal(sitePublicUrl('demo.workers.xd.team'), 'https://demo.workers.xd.team');
  assert.equal(sitePublicUrl('https://demo.workers.xd.team'), 'https://demo.workers.xd.team');
  assert.equal(sitePublicUrl(''), '');
});

test('adminSiteOwnerView prefers user email and team department path', () => {
  assert.deepEqual(adminSiteOwnerView({ type: 'user', id: 'usr_1', email: 'alice@xd.com' }), {
    type: 'user',
    tag: 'user',
    primary: 'alice@xd.com',
    secondary: 'usr_1',
  });
  assert.deepEqual(
    adminSiteOwnerView({
      type: 'team',
      id: 'team_xd_web',
      displayName: 'XD Web',
      departmentPath: 'XD/Platform/Web',
    }),
    {
      type: 'team',
      tag: 'team',
      primary: 'XD/Platform/Web',
      secondary: 'XD Web',
    }
  );
});

test('siteCardOwnerLabel shows only the concrete owner object name', () => {
  assert.equal(siteCardOwnerLabel({ type: 'user', displayName: '徐天麒' }), '徐天麒');
  assert.equal(siteCardOwnerLabel({ type: 'team', displayName: 'XD Cell' }), 'XD Cell');
  assert.equal(siteCardOwnerLabel({ type: 'team', departmentPath: '心动/平台支撑部' }), '心动/平台支撑部');
  assert.equal(siteCardOwnerLabel({ type: 'user' }), '');
  assert.equal(siteCardOwnerLabel(null), '');
});
