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
      avatarText: '徐',
      displayName: '徐天麒',
      email: 'xutianqi@xd.com',
      departmentPath: '心动/平台支撑部/Web',
      userId: 'usr_1',
      ssoSource: '飞书 SSO 同步，不可改',
    }
  );
});
