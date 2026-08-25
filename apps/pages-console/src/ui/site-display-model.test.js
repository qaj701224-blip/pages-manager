import assert from 'node:assert/strict';
import test from 'node:test';

import * as siteDisplayModel from './site-display-model.js';
import {
  adminDeploymentActorView,
  adminDeploymentOwnerView,
  adminSiteOwnerView,
  patchSiteSummaryForId,
  siteCardOwnerLabel,
  sitePublicUrl,
  siteVisibilityLabel,
} from './site-display-model.js';

test('site summary patches keep admin list names in sync with detail mutations', () => {
  const untouched = { id: 'site_2', title: 'Two', displayName: 'Two', slug: 'two' };
  const sites = [
    { id: 'site_1', title: 'One', displayName: 'One', slug: 'one' },
    untouched,
  ];

  const renamed = patchSiteSummaryForId(sites, 'site_1', { title: null, slug: 'renamed' });

  assert.deepEqual(renamed[0], { id: 'site_1', title: null, displayName: 'renamed', slug: 'renamed' });
  assert.strictEqual(renamed[1], untouched);
});

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

test('adminDeploymentOwnerView distinguishes an uncreated site from persisted ownership', () => {
  assert.deepEqual(adminDeploymentOwnerView({ state: 'not_created' }), {
    state: 'not_created',
    type: 'not_created',
    tag: '未创建',
    primary: '站点未创建',
    secondary: '',
  });
  assert.deepEqual(
    adminDeploymentOwnerView({
      state: 'persisted',
      type: 'team',
      id: 'team_1',
      displayName: 'Platform',
      departmentPath: 'XD/Platform',
    }),
    {
      state: 'persisted',
      type: 'team',
      tag: 'team',
      primary: 'XD/Platform',
      secondary: 'Platform',
    }
  );
});

test('adminDeploymentActorView falls back from actor profile to safe identifiers', () => {
  assert.deepEqual(
    adminDeploymentActorView({ type: 'access_key', id: 'ak_1', userId: 'usr_1', email: 'actor@example.com' }),
    {
      type: 'access_key',
      tag: 'access_key',
      primary: 'actor@example.com',
      secondary: 'usr_1',
    }
  );
  assert.deepEqual(adminDeploymentActorView({ type: 'system', id: 'system:deploy' }), {
    type: 'system',
    tag: 'system',
    primary: 'system:deploy',
    secondary: '',
  });
  assert.deepEqual(adminDeploymentActorView({ type: 'user', id: 'usr_missing' }), {
    type: 'user',
    tag: 'user',
    primary: 'usr_missing',
    secondary: '',
  });
  assert.deepEqual(adminDeploymentActorView({}), {
    type: 'unknown',
    tag: 'unknown',
    primary: '未知操作人',
    secondary: '',
  });
});

test('siteCardOwnerLabel shows only the concrete owner object name', () => {
  assert.equal(siteCardOwnerLabel({ type: 'user', displayName: '徐天麒' }), '徐天麒');
  assert.equal(siteCardOwnerLabel({ type: 'team', displayName: 'XD Cell' }), 'XD Cell');
  assert.equal(siteCardOwnerLabel({ type: 'team', departmentPath: '心动/平台支撑部' }), '心动/平台支撑部');
  assert.equal(siteCardOwnerLabel({ type: 'user' }), '');
  assert.equal(siteCardOwnerLabel(null), '');
});

test('siteVisibilityLabel maps access policy values to readable copy', () => {
  assert.equal(siteVisibilityLabel('internal'), '免登录访问');
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

test('deploymentTraceEventView maps trace diagnostics into safe readable timeline fields', () => {
  assert.equal(typeof siteDisplayModel.deploymentTraceEventView, 'function');
  const longMessage = `Provider failed ${'x'.repeat(120)}\u0000hidden`;
  const view = siteDisplayModel.deploymentTraceEventView({
    stage: 'provider_verify',
    status: 'failed',
    startedAt: '2026-08-20T07:54:17.000Z',
    durationMs: 125,
    operation: 'worker_get',
    errorCode: 'DEPLOYMENT_VERIFY_FAILED',
    errorMessage: longMessage,
    diagnostics: {
      httpStatus: 404,
      clientCode: 'WFP_API_ERROR',
      providerCode: '10007',
      providerMessage: 'Worker lookup rejected',
      providerRequestId: 'ray-verify-safe',
      trafficImpact: 'old_version_retained',
      operatorAction: 'retry_deploy',
      cleanupStatus: 'scheduled',
      cleanupTaskId: 'cln_cleanup_safe',
      compensation: {
        status: 'failed',
        operation: 'worker_delete',
        providerRequestId: 'ray-cleanup-safe',
      },
    },
  });

  assert.equal(view.stage, 'Provider 校验');
  assert.equal(view.status, '失败');
  assert.equal(view.duration, '125 ms');
  assert.equal(view.operation, 'worker_get');
  assert.equal(view.provider, 'HTTP 404 · WFP_API_ERROR · 10007 · Worker lookup rejected');
  assert.equal(view.providerTitle, 'HTTP 404 · WFP_API_ERROR · 10007 · Worker lookup rejected');
  assert.equal(view.providerRequestId, 'ray-verify-safe');
  assert.equal(view.impact, '旧版本继续服务');
  assert.equal(view.operatorAction, '重新部署');
  assert.equal(view.cleanup, '已调度 · cln_cleanup_safe');
  assert.equal(view.compensation, '失败 · worker_delete · ray-cleanup-safe');
  assert.match(view.error, /…$/);
  assert.match(view.errorTitle, /^DEPLOYMENT_VERIFY_FAILED · Provider failed/);
  assert.equal(JSON.stringify(view).includes('\u0000'), false);
});

test('deploymentTraceEventView labels unexpected rollback orchestration failures', () => {
  const view = siteDisplayModel.deploymentTraceEventView({
    stage: 'deployment_operation',
    status: 'failed',
    operation: 'orchestrate_rollback_request',
    diagnostics: {
      operatorAction: 'retry_rollback',
    },
  });

  assert.equal(view.stage, '部署编排');
  assert.equal(view.operatorAction, '重新回滚');
});

test('deploymentTraceEventView labels Worker source fixes as a code change', () => {
  const view = siteDisplayModel.deploymentTraceEventView({
    stage: 'provider_upload',
    status: 'failed',
    diagnostics: {
      operatorAction: 'fix_worker_source',
    },
  });

  assert.equal(view.operatorAction, '修复 Worker 源码');
});

test('deploymentTraceEventView preserves safe unknown values and empty fallbacks', () => {
  assert.equal(typeof siteDisplayModel.deploymentTraceEventView, 'function');
  assert.deepEqual(
    siteDisplayModel.deploymentTraceEventView({
      stage: 'future_stage',
      status: 'future_status',
      operation: 'future_operation',
      errorMessage: 'line one\u0007line two',
    }),
    {
      time: '-',
      timeTitle: '',
      stage: 'future_stage',
      status: 'future_status',
      statusCode: 'future_status',
      duration: '-',
      operation: 'future_operation',
      error: 'line one line two',
      errorTitle: 'line one line two',
      provider: '-',
      providerTitle: '',
      providerRequestId: '-',
      providerRequestIdTitle: '',
      impact: '-',
      operatorAction: '-',
      cleanup: '-',
      compensation: '-',
    }
  );
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

test('admin site filters and labels distinguish network exposure from visibility', () => {
  const sites = [
    adminSite({ id: 'public', exposure: 'public', visibility: 'internal' }),
    adminSite({ id: 'internal', exposure: 'internal', visibility: 'org' }),
  ];

  assert.equal(siteDisplayModel.siteExposureLabel('public'), '公网');
  assert.equal(siteDisplayModel.siteExposureLabel('internal'), '公司网络');
  assert.deepEqual(siteDisplayModel.filterAdminSites(sites, { exposure: 'public' }), [sites[0]]);
  assert.deepEqual(siteDisplayModel.filterAdminSites(sites, { exposure: 'internal' }), [sites[1]]);
  assert.equal(siteDisplayModel.filterAdminSites(sites, { query: '公网' }).length, 1);
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
