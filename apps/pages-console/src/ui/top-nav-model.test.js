import assert from 'node:assert/strict';
import test from 'node:test';

import { getConsoleEnvironmentBanner, readTopNavUserState } from './top-nav-model.js';

test('staging console host gets persistent environment banner', () => {
  assert.equal(
    getConsoleEnvironmentBanner('staging.workers.xd.team'),
    'Staging · 仅平台管理员 · 与 production 数据和执行资源物理隔离'
  );
  assert.equal(getConsoleEnvironmentBanner('workers.xd.team'), '');
});

test('top nav user state exposes admin menu for platform admins', () => {
  assert.deepEqual(readTopNavUserState(null), {
    authenticated: false,
    label: '登录',
    showAdmin: false,
  });
  assert.deepEqual(readTopNavUserState(null), {
    authenticated: false,
    label: '登录',
    showAdmin: false,
  });
  assert.deepEqual(
    readTopNavUserState({
      authenticated: true,
      user: {
        email: 'root@example.com',
        isPlatformAdmin: true,
      },
    }),
    {
      authenticated: true,
      label: 'root@example.com',
      displayName: 'root',
      showAdmin: true,
    }
  );
});

test('top nav prefers SSO realname over latin account name', () => {
  assert.deepEqual(
    readTopNavUserState({
      authenticated: true,
      user: {
        email: 'xutianqi@xd.com',
        name: 'xutianqi',
        realname: '徐天麒',
        departmentPath: '心动/平台支撑部',
      },
    }),
    {
      authenticated: true,
      label: 'xutianqi@xd.com',
      displayName: '徐天麒',
      departmentPath: '心动/平台支撑部',
      showAdmin: false,
    }
  );
});
