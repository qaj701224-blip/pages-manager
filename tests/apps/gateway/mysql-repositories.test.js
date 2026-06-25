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

test('MySQL PlatformDevItem creation writes item event and gate in one transaction', async () => {
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
    requiresHumanGate: true,
    gateStatus: 'pending',
  });

  assert.equal(result.created, true);
  assert.deepEqual(
    pool.calls.filter((call) => ['getConnection', 'begin', 'commit', 'rollback', 'release'].includes(call)),
    ['getConnection', 'begin', 'commit', 'release']
  );
  assert.ok(pool.calls.some((call) => /^INSERT INTO `platform_dev_items`/.test(call)));
  assert.ok(pool.calls.some((call) => /^INSERT INTO `platform_dev_events`/.test(call)));
  assert.ok(pool.calls.some((call) => /^INSERT INTO `work_item_gates`/.test(call)));
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
