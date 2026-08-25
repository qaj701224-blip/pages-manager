import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildSiteOwnershipReauthHref,
  buildSiteOwnershipTransferForm,
  filterSiteOwnerCandidates,
  getSiteOwnershipTransferErrorMessage,
  getSiteMetadataErrorMessage,
  isCurrentSiteOwner,
  normalizeSiteSlugMetadataPayload,
  normalizeSiteTitleMetadataPayload,
  normalizeSiteOwnershipTransferPayload,
  shouldLeaveSiteAfterOwnershipTransfer,
  siteHostnameForSlug,
  siteOwnerCandidateLabel,
  siteOwnerCandidateMeta,
  siteOwnerView,
  siteOwnershipTransferLosesAccess,
} from './site-settings-model.js';

test('site metadata payloads keep title and slug mutations independent', () => {
  assert.deepEqual(normalizeSiteTitleMetadataPayload('  产品文档  '), { title: '产品文档' });
  assert.deepEqual(normalizeSiteTitleMetadataPayload('   '), { title: null });
  assert.deepEqual(normalizeSiteSlugMetadataPayload('  Product-Docs  '), { slug: 'product-docs' });
});

test('site slug hostname preview preserves the environment suffix', () => {
  assert.equal(
    siteHostnameForSlug({ slug: 'guide', hostname: 'guide.workers.xd.team' }, 'product-docs'),
    'product-docs.workers.xd.team'
  );
  assert.equal(
    siteHostnameForSlug({ slug: 'guide', hostname: 'guide-staging.workers.xd.team' }, 'product-docs'),
    'product-docs-staging.workers.xd.team'
  );
  assert.equal(siteHostnameForSlug({ slug: 'guide', hostname: 'guideline.workers.xd.team' }, 'product-docs'), 'product-docs');
});

test('site metadata errors provide field-specific actionable messages', () => {
  assert.match(getSiteMetadataErrorMessage({ code: 'SITE_TITLE_INVALID' }), /1–80/);
  assert.match(getSiteMetadataErrorMessage({ code: 'SITE_SLUG_CONFLICT' }), /已被占用/);
  assert.match(getSiteMetadataErrorMessage({ code: 'SITE_METADATA_CONFLICT' }), /刷新/);
});

test('site ownership transfer form starts from current owner', () => {
  assert.deepEqual(buildSiteOwnershipTransferForm({ owner: { type: 'team', id: 'team_1' } }), {
    ownerType: 'team',
    ownerId: 'team_1',
    query: '',
  });
});

test('site ownership transfer payload uses user owner id or team id', () => {
  assert.deepEqual(normalizeSiteOwnershipTransferPayload({ ownerType: 'user', ownerId: 'usr_1' }), {
    ownerType: 'user',
    ownerId: 'usr_1',
  });
  assert.deepEqual(normalizeSiteOwnershipTransferPayload({ ownerType: 'team', ownerId: 'team_1' }), {
    ownerType: 'team',
    teamId: 'team_1',
  });
  assert.throws(() => normalizeSiteOwnershipTransferPayload({ ownerType: 'team', ownerId: '' }), {
    code: 'TEAM_REQUIRED',
  });
});

test('site owner candidate helpers show only active manageable workspace teams', () => {
  const teams = [
    { id: 'team_viewer', name: 'Viewer Team', status: 'active', currentUserRole: 'viewer' },
    {
      id: 'team_pub',
      name: 'Publisher Team',
      departmentPath: 'XD/Platform',
      status: 'active',
      currentUserRole: 'publisher',
    },
    { id: 'team_inactive', name: 'Inactive Team', status: 'inactive', currentUserRole: 'admin' },
  ];

  assert.deepEqual(filterSiteOwnerCandidates(teams, 'pub', 'team'), [teams[1]]);
  assert.equal(siteOwnerCandidateLabel(teams[1], 'team'), 'Publisher Team');
  assert.equal(siteOwnerCandidateMeta(teams[1], 'team'), 'XD/Platform');
  assert.equal(siteOwnerCandidateLabel({ id: 'usr_1', realname: '徐天麒', email: 'x@example.com' }, 'user'), '徐天麒');
});

test('site owner candidates require explicit active status and admin can use every active team', () => {
  const users = [
    { id: 'usr_inactive', realname: 'Inactive User', employeeStatus: 'inactive' },
    { id: 'usr_unknown', realname: 'Unknown User', employeeStatus: 'unknown' },
    { id: 'usr_active', realname: 'Active User', employeeStatus: 'active' },
  ];
  const teams = [
    { id: 'team_viewer', name: 'Viewer Team', status: 'active', currentUserRole: 'viewer' },
    { id: 'team_unknown', name: 'Unknown Team', status: 'unknown', currentUserRole: 'admin' },
  ];

  assert.deepEqual(filterSiteOwnerCandidates(users, 'user', 'user'), [users[2]]);
  assert.deepEqual(filterSiteOwnerCandidates(teams, '', 'team', 'workspace'), []);
  assert.deepEqual(filterSiteOwnerCandidates(teams, '', 'team', 'admin'), [teams[0]]);
});

test('site ownership model rejects the current owner and predicts post-transfer access', () => {
  const site = { owner: { type: 'user', id: 'usr_owner' } };
  assert.equal(isCurrentSiteOwner(site, { ownerType: 'user', ownerId: 'usr_owner' }), true);
  assert.equal(isCurrentSiteOwner(site, { ownerType: 'team', ownerId: 'usr_owner' }), false);
  assert.equal(siteOwnershipTransferLosesAccess('workspace', { ownerType: 'user', ownerId: 'usr_self' }, 'usr_self'), false);
  assert.equal(siteOwnershipTransferLosesAccess('workspace', { ownerType: 'user', ownerId: 'usr_other' }, 'usr_self'), true);
  assert.equal(siteOwnershipTransferLosesAccess('workspace', { ownerType: 'team', currentUserRole: 'publisher' }), false);
  assert.equal(siteOwnershipTransferLosesAccess('admin', { ownerType: 'user' }), false);
  assert.equal(shouldLeaveSiteAfterOwnershipTransfer('workspace', { permissions: { canManage: false } }), true);
  assert.equal(shouldLeaveSiteAfterOwnershipTransfer('workspace', { permissions: { canManage: true } }), false);
  assert.equal(shouldLeaveSiteAfterOwnershipTransfer('admin', { permissions: { canManage: false } }), false);
});

test('site ownership model builds a bounded reauthentication URL and readable owner view', () => {
  const href = buildSiteOwnershipReauthHref('site/unsafe', 'workspace');
  const url = new URL(href, 'https://console.example.test');
  assert.equal(url.pathname, '/api/console/auth/login');
  assert.equal(url.searchParams.get('reauth'), '1');
  assert.equal(url.searchParams.get('returnTo'), '/workspace/sites/site%2Funsafe/settings');
  assert.equal(url.searchParams.has('ownerId'), false);
  assert.deepEqual(siteOwnerView({ type: 'user', id: 'usr_1', displayName: '目标用户', email: 'target@example.com' }), {
    typeLabel: '个人',
    label: '目标用户',
    meta: 'target@example.com',
  });
});

test('site ownership errors provide actionable transfer guidance', () => {
  assert.match(getSiteOwnershipTransferErrorMessage({ code: 'CONSOLE_RECENT_LOGIN_REQUIRED' }), /重新验证身份/);
  assert.match(getSiteOwnershipTransferErrorMessage({ code: 'SITE_ADMIN_REQUIRED' }), /团队 admin/);
  assert.match(getSiteOwnershipTransferErrorMessage({ code: 'SITE_VISIBILITY_INVALID' }), /访问模式/);
  assert.match(getSiteOwnershipTransferErrorMessage({ code: 'ROUTE_POLICY_REPAIR_REQUIRED' }), /刷新确认/);
});
