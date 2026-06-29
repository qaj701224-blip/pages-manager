import assert from 'node:assert/strict';
import test from 'node:test';

import { MySqlGatewayStore } from '../../../apps/gateway/src/db/gateway-store.js';

function transactionalPool() {
  const calls = [];
  const connection = {
    async beginTransaction() {
      calls.push('begin');
    },
    async commit() {
      calls.push('commit');
    },
    async rollback() {
      calls.push('rollback');
    },
    release() {
      calls.push('release');
    },
    async execute(sql) {
      calls.push(sql);
      if (/^SELECT \* FROM (?:publishing_jobs|platform_dev_items)/.test(sql)) return [[]];
      return [{ affectedRows: 1 }];
    },
  };
  return {
    calls,
    async getConnection() {
      calls.push('getConnection');
      return connection;
    },
    async execute(sql) {
      calls.push(sql);
      if (/^SELECT \* FROM (?:publishing_jobs|platform_dev_items)/.test(sql)) return [[]];
      return [{ affectedRows: 1 }];
    },
  };
}

test('MySQL PublishingJob creation writes job and initial event in one transaction', async () => {
  const pool = transactionalPool();
  const store = new MySqlGatewayStore(pool);

  const result = await store.createJob({
    source: 'api',
    requestedByType: 'user',
    requestedById: 'usr_1',
    idempotencyKey: 'txn-job',
    employeeSlug: 'zhangsan',
    siteSlug: 'profile',
    summary: 'Create a profile page.',
  });

  assert.equal(result.created, true);
  assert.deepEqual(
    pool.calls.filter((call) => ['getConnection', 'begin', 'commit', 'rollback', 'release'].includes(call)),
    ['getConnection', 'begin', 'commit', 'release']
  );
  assert.ok(pool.calls.some((call) => /^INSERT INTO `publishing_jobs`/.test(call)));
  assert.ok(pool.calls.some((call) => /^INSERT INTO `job_events`/.test(call)));
});

test('MySQL PublishingJob creation re-reads an idempotency duplicate instead of upserting', async () => {
  const calls = [];
  let selectCount = 0;
  const duplicate = Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
  const existingRow = {
    id: 'job_existing',
    source: 'api',
    requested_by_type: 'user',
    requested_by_id: 'usr_1',
    idempotency_key: 'txn-job-race',
    employee_slug: 'zhangsan',
    site_slug: 'profile',
    intent: 'create_site',
    approval_mode: 'manual_required',
    status: 'received',
    title: 'Existing profile',
    summary: 'Existing profile job.',
    created_at: new Date('2026-06-14T00:00:00.000Z'),
    updated_at: new Date('2026-06-14T00:00:00.000Z'),
  };
  const connection = {
    async beginTransaction() {
      calls.push({ sql: 'begin' });
    },
    async commit() {
      calls.push({ sql: 'commit' });
    },
    async rollback() {
      calls.push({ sql: 'rollback' });
    },
    release() {
      calls.push({ sql: 'release' });
    },
    async execute(sql, params = []) {
      calls.push({ sql, params, scope: 'transaction' });
      if (/^INSERT INTO `publishing_jobs`/.test(sql)) throw duplicate;
      return [{ affectedRows: 1 }];
    },
  };
  const pool = {
    async getConnection() {
      calls.push({ sql: 'getConnection' });
      return connection;
    },
    async execute(sql, params = []) {
      calls.push({ sql, params, scope: 'pool' });
      if (/^SELECT \* FROM publishing_jobs/.test(sql)) {
        selectCount += 1;
        return [selectCount === 1 ? [] : [existingRow], []];
      }
      return [[], []];
    },
  };
  const store = new MySqlGatewayStore(pool);

  const result = await store.createJob({
    source: 'api',
    requestedByType: 'user',
    requestedById: 'usr_1',
    idempotencyKey: 'txn-job-race',
    employeeSlug: 'zhangsan',
    siteSlug: 'profile',
    summary: 'Create a profile page.',
  });

  assert.equal(result.created, false);
  assert.equal(result.job.id, 'job_existing');
  assert.equal(calls.some((call) => /^INSERT INTO `job_events`/.test(call.sql)), false);
  assert.equal(calls.some((call) => /ON DUPLICATE KEY UPDATE/.test(call.sql)), false);
});

test('MySQL PlatformDevItem creation writes item event and manual auto-dev fields in one transaction', async () => {
  const pool = transactionalPool();
  const store = new MySqlGatewayStore(pool);

  const result = await store.createPlatformDevItem({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'txn-platform',
    title: '修改 CI workflow',
    summary: '修改 CI workflow',
    issueType: 'type:ci',
    risk: 'risk:high',
    agentEligible: true,
    autoDevStatus: 'pending',
  });

  assert.equal(result.created, true);
  assert.deepEqual(
    pool.calls.filter((call) => ['getConnection', 'begin', 'commit', 'rollback', 'release'].includes(call)),
    ['getConnection', 'begin', 'commit', 'release']
  );
  assert.ok(pool.calls.some((call) => /^INSERT INTO `platform_dev_items`/.test(call)));
  assert.ok(pool.calls.some((call) => /^INSERT INTO `platform_dev_events`/.test(call)));
  assert.equal(result.item.autoDevStatus, 'pending');
});

test('MySQL PlatformDevItem creation re-reads an idempotency duplicate instead of upserting', async () => {
  const calls = [];
  let selectCount = 0;
  const duplicate = Object.assign(new Error('Duplicate entry'), { code: 'ER_DUP_ENTRY' });
  const existingRow = {
    id: 'pdev_existing',
    source: 'slack',
    requested_by_type: 'user',
    requested_by_id: 'slack:T1:U1',
    idempotency_key: 'txn-platform-race',
    title: 'Existing CI task',
    summary: 'Existing CI task.',
    issue_type: 'type:ci',
    areas_json: '[]',
    risk: 'risk:high',
    agent_eligible: true,
    status: 'auto_dev_pending',
    created_at: new Date('2026-06-14T00:00:00.000Z'),
    updated_at: new Date('2026-06-14T00:00:00.000Z'),
  };
  const connection = {
    async beginTransaction() {
      calls.push({ sql: 'begin' });
    },
    async commit() {
      calls.push({ sql: 'commit' });
    },
    async rollback() {
      calls.push({ sql: 'rollback' });
    },
    release() {
      calls.push({ sql: 'release' });
    },
    async execute(sql, params = []) {
      calls.push({ sql, params, scope: 'transaction' });
      if (/^INSERT INTO `platform_dev_items`/.test(sql)) throw duplicate;
      return [{ affectedRows: 1 }];
    },
  };
  const pool = {
    async getConnection() {
      calls.push({ sql: 'getConnection' });
      return connection;
    },
    async execute(sql, params = []) {
      calls.push({ sql, params, scope: 'pool' });
      if (/^SELECT \* FROM platform_dev_items/.test(sql)) {
        selectCount += 1;
        return [selectCount === 1 ? [] : [existingRow], []];
      }
      return [[], []];
    },
  };
  const store = new MySqlGatewayStore(pool);

  const result = await store.createPlatformDevItem({
    source: 'slack',
    requestedByType: 'user',
    requestedById: 'slack:T1:U1',
    idempotencyKey: 'txn-platform-race',
    title: '修改 CI workflow',
    summary: '修改 CI workflow',
    issueType: 'type:ci',
    risk: 'risk:high',
    agentEligible: true,
  });

  assert.equal(result.created, false);
  assert.equal(result.item.id, 'pdev_existing');
  assert.equal(calls.some((call) => /^INSERT INTO `platform_dev_events`/.test(call.sql)), false);
  assert.equal(calls.some((call) => /ON DUPLICATE KEY UPDATE/.test(call.sql)), false);
});

test('MySQL Slack work item list filters site jobs by Slack requester before limit', async () => {
  const calls = [];
  const pool = {
    async execute(sql, params = []) {
      calls.push({ sql, params });
      if (/COUNT/.test(sql)) return [[{ total: 0 }]];
      return [[]];
    },
  };
  const store = new MySqlGatewayStore(pool);

  await store.listWorkItemsForSlackUser('T1', 'U1', { statuses: ['previewing'] });

  const siteJobsQuery = calls.find((call) => /FROM publishing_jobs/.test(call.sql) && /ORDER BY updated_at/.test(call.sql));
  assert.ok(siteJobsQuery);
  assert.match(siteJobsQuery.sql, /requested_by_id = \?/);
  assert.match(siteJobsQuery.sql, /status IN \(\?\)/);
  assert.deepEqual(siteJobsQuery.params.slice(0, 3), ['slack', 'slack:T1:U1', 'previewing']);
});

test('MySQL PublishingJob moveJobToFixing returns null when intermediate reviewing update disappears', async () => {
  const pool = transactionalPool();
  const store = new MySqlGatewayStore(pool);
  const originalUpdateJob = store.updateJob.bind(store);
  const job = {
    id: 'job_123',
    status: 'pr_created',
    summary: 'Create a profile page.',
  };

  store.getJob = async () => job;
  store.updateJob = async () => null;

  const result = await store.moveJobToFixing('job_123', { summary: 'Follow-up' });

  assert.equal(result, null);
  assert.equal(pool.calls.some((call) => /^INSERT INTO `publishing_jobs`/.test(call)), false);
  store.updateJob = originalUpdateJob;
});
