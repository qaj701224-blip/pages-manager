import assert from 'node:assert/strict';
import test from 'node:test';

import { hydrateUserDepartment, shouldHydrateUserDepartment } from './department-hydration.js';
import { deriveDepartmentTeamIdentity } from './department-path.js';

test('hydrates identity metadata through explicit directory and store ports', async () => {
  const calls = [];
  const result = await hydrateUserDepartment({
    environment: 'production',
    user: { id: 'usr_1', email: ' User@XD.COM ' },
    clock: { now: 1_800_000_000 },
    directory: {
      async findUsersByEmail(emails) {
        calls.push(['directory', emails]);
        return [{ email: 'user@xd.com', departmentPath: ' 心动 / 平台支撑部 / Web ' }];
      },
    },
    store: {
      async updateUserDepartmentFromDirectory(input) {
        calls.push(['user', input]);
        return { id: input.userId };
      },
      async hydrateDepartmentMembership(input) {
        calls.push(['membership', input]);
        return { team: { id: 'team_web' } };
      },
    },
  });

  assert.deepEqual(result, {
    status: 'hydrated',
    departmentPath: '心动/平台支撑部/Web',
    teamId: 'team_web',
  });
  assert.deepEqual(calls, [
    ['directory', ['user@xd.com']],
    [
      'user',
      {
        userId: 'usr_1',
        departmentPath: '心动/平台支撑部/Web',
        departmentCheckedAt: '2027-01-15T08:00:00.000Z',
      },
    ],
    [
      'membership',
      {
        environment: 'production',
        userId: 'usr_1',
        departmentPath: '心动/平台支撑部/Web',
      },
    ],
  ]);
});

test('records an unavailable directory check without creating membership', async () => {
  let update;
  const result = await hydrateUserDepartment({
    environment: 'production',
    user: { id: 'usr_1', email: 'user@xd.com' },
    clock: { now: 1_800_000_000 },
    directory: null,
    store: {
      async updateUserDepartmentFromDirectory(input) {
        update = input;
      },
      async hydrateDepartmentMembership() {
        assert.fail('membership must not be hydrated without a directory result');
      },
    },
  });

  assert.deepEqual(result, { status: 'unavailable' });
  assert.deepEqual(update, {
    userId: 'usr_1',
    departmentPath: null,
    departmentCheckedAt: '2027-01-15T08:00:00.000Z',
  });
});

test('department identity and refresh policy remain deterministic', () => {
  assert.deepEqual(deriveDepartmentTeamIdentity('心动/发行服务/平台支撑部/技术/Web'), {
    fullPath: '心动/发行服务/平台支撑部/技术/Web',
    teamPath: '心动/发行服务/平台支撑部',
    displayName: '平台支撑部',
  });
  assert.equal(
    shouldHydrateUserDepartment(
      { email: 'user@xd.com', departmentPath: '心动/平台', departmentCheckedAt: '2027-01-15T07:59:59.000Z' },
      { now: 1_800_000_000 }
    ),
    false
  );
  assert.equal(
    shouldHydrateUserDepartment(
      { email: 'user@xd.com', departmentPath: null, departmentCheckedAt: '2027-01-15T07:49:59.000Z' },
      { now: 1_800_000_000 }
    ),
    true
  );
});
