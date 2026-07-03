import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAccountProfile } from './account-profile-model.js';

test('account profile uses SSO realname and department path', () => {
  assert.deepEqual(
    buildAccountProfile({
      authenticated: true,
      user: {
        userId: 'usr_1',
        email: 'xutianqi@xd.com',
        name: 'xutianqi',
        realname: '徐天麒',
        departmentPath: '心动/平台支撑部/Web',
      },
    }),
    {
      displayName: '徐天麒',
      email: 'xutianqi@xd.com',
      departmentPath: '心动/平台支撑部/Web',
      ssoSource: '企业 SSO 同步，不可改',
    }
  );
});

test('account profile does not expose user id as display name', () => {
  assert.equal(
    buildAccountProfile({
      authenticated: true,
      user: {
        userId: 'usr_secret_id',
      },
    }).displayName,
    '用户'
  );
});
