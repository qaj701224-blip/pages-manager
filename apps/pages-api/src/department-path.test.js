import assert from 'node:assert/strict';
import test from 'node:test';

import { departmentTeamDisplayName, deriveDepartmentTeamIdentity, normalizeDepartmentPath } from './department-path.js';

test('normalizeDepartmentPath trims and joins slash separated XDS paths', () => {
  assert.equal(normalizeDepartmentPath(' 心动 / 发行服务 / 平台支撑部 / 技术 / Web '), '心动/发行服务/平台支撑部/技术/Web');
});

test('deriveDepartmentTeamIdentity keeps full path and collapses deep XDS paths to department team path', () => {
  assert.deepEqual(deriveDepartmentTeamIdentity(' 心动 / 发行服务 / 平台支撑部 / 技术 / Web '), {
    fullPath: '心动/发行服务/平台支撑部/技术/Web',
    teamPath: '心动/发行服务/平台支撑部',
    displayName: '平台支撑部',
  });
});

test('deriveDepartmentTeamIdentity keeps shallow paths as their own department team path', () => {
  assert.deepEqual(deriveDepartmentTeamIdentity('心动/发行服务/平台支撑部'), {
    fullPath: '心动/发行服务/平台支撑部',
    teamPath: '心动/发行服务/平台支撑部',
    displayName: '平台支撑部',
  });
});

test('departmentTeamDisplayName renders department team by canonical display name', () => {
  assert.equal(
    departmentTeamDisplayName({
      teamType: 'department',
      name: '心动/发行服务/平台支撑部/技术/Web',
      departmentPath: '心动/发行服务/平台支撑部/技术/Web',
    }),
    '平台支撑部'
  );
  assert.equal(departmentTeamDisplayName({ teamType: 'custom', name: 'Docs Team' }), 'Docs Team');
});
