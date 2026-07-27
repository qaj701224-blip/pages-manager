import assert from 'node:assert/strict';
import test from 'node:test';

import * as siteDisplayModel from './site-display-model.js';
import { adminSiteOwnerView, siteCardOwnerLabel, sitePublicUrl, siteVisibilityLabel } from './site-display-model.js';

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

test('siteVisibilityLabel maps access policy values to readable copy', () => {
  assert.equal(siteVisibilityLabel('internal'), '内网可见');
  assert.equal(siteVisibilityLabel('org'), '企业成员可见');
  assert.equal(siteVisibilityLabel('acl'), '指定成员可见');
  assert.equal(siteVisibilityLabel('owner'), '仅归属方可见');
  assert.equal(siteVisibilityLabel('disabled'), '已停用');
  assert.equal(siteVisibilityLabel('custom'), 'custom');
});

test('admin site deployment shapes use readable labels with safe fallbacks', () => {
  assert.equal(typeof siteDisplayModel.siteDeploymentShapeLabel, 'function');
  assert.equal(siteDisplayModel.siteDeploymentShapeLabel('assets-only'), '静态资源');
  assert.equal(siteDisplayModel.siteDeploymentShapeLabel('worker-only'), 'Worker');
  assert.equal(siteDisplayModel.siteDeploymentShapeLabel('worker-with-assets'), 'Worker + 静态资源');
  assert.equal(siteDisplayModel.siteDeploymentShapeLabel(null), '未部署');
  assert.equal(siteDisplayModel.siteDeploymentShapeLabel('future-shape'), '未知类型');
});

test('admin site filters combine deployment shape with existing filters', () => {
  assert.equal(typeof siteDisplayModel.filterAdminSites, 'function');
  const sites = [
    adminSite({ id: 'assets', deploymentShape: 'assets-only' }),
    adminSite({ id: 'worker', deploymentShape: 'worker-only', owner: { type: 'team', displayName: 'Platform' } }),
    adminSite({ id: 'worker-assets', deploymentShape: 'worker-with-assets', status: 'disabled' }),
    adminSite({ id: 'empty', deploymentShape: null }),
    adminSite({ id: 'future', deploymentShape: 'future-shape' }),
  ];

  assert.deepEqual(
    siteDisplayModel.filterAdminSites(sites, {
      query: '',
      ownerType: 'all',
      status: 'all',
      deploymentShape: 'worker-only',
    }),
    [sites[1]]
  );
  assert.deepEqual(
    siteDisplayModel.filterAdminSites(sites, {
      query: '',
      ownerType: 'all',
      status: 'all',
      deploymentShape: 'un-deployed',
    }),
    [sites[3]]
  );
  assert.deepEqual(
    siteDisplayModel.filterAdminSites(sites, {
      query: 'worker',
      ownerType: 'user',
      status: 'disabled',
      deploymentShape: 'worker-with-assets',
    }),
    [sites[2]]
  );
  assert.equal(
    siteDisplayModel.filterAdminSites(sites, {
      query: '',
      ownerType: 'all',
      status: 'all',
      deploymentShape: 'future-shape',
    }).length,
    0
  );
  assert.equal(
    siteDisplayModel.filterAdminSites(sites, {
      query: '',
      ownerType: 'all',
      status: 'all',
      deploymentShape: 'all',
    }).length,
    5
  );
});

function adminSite(overrides) {
  return {
    id: overrides.id,
    slug: `${overrides.id}-site`,
    hostname: `${overrides.id}.workers.xd.team`,
    visibility: 'internal',
    status: 'active',
    owner: { type: 'user', email: `${overrides.id}@example.com` },
    ...overrides,
  };
}
