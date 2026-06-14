import assert from 'node:assert/strict';
import test from 'node:test';

import { databaseUrlFromEnv, resolveMysqlConfig, resolveRedisConfig } from '../../../apps/gateway/src/db/config.js';
import { MySqlGatewayStore } from '../../../apps/gateway/src/db/gateway-store.js';
import { createBullMqRedisClient, createRedisClient } from '../../../apps/gateway/src/db/redis.js';
import * as schema from '../../../apps/gateway/src/db/schema.js';

test('gateway DB config parses DATABASE_URL without exposing secrets', () => {
  const config = resolveMysqlConfig({
    DATABASE_URL: 'mysql://pages_user:secret%21@mysql.internal:3307/pages_manager_preview',
  });

  assert.deepEqual(config, {
    host: 'mysql.internal',
    port: 3307,
    user: 'pages_user',
    password: 'secret!',
    database: 'pages_manager_preview',
  });
});

test('gateway DB config supports xdclaw-style MYSQL_ADDR inputs', () => {
  const config = resolveMysqlConfig({
    MYSQL_ADDR: '127.0.0.1:3306',
    MYSQL_USER: 'root',
    MYSQL_PASSWORD: '',
    MYSQL_DATABASE: 'pages_manager',
  });

  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.port, 3306);
  assert.equal(config.user, 'root');
  assert.equal(config.database, 'pages_manager');
});

test('drizzle config can build a local default URL for generation', () => {
  assert.equal(databaseUrlFromEnv({}, { allowDefaults: true }), 'mysql://root:@127.0.0.1:3306/pages_manager');
});

test('redis config fails closed when REDIS_URL is missing', () => {
  assert.throws(() => resolveRedisConfig({}), /REDIS_URL is required/);
});

test('redis clients separate gateway and BullMQ retry semantics', () => {
  const env = { REDIS_URL: 'redis://:secret@redis.internal:6379/2' };
  const gatewayRedis = createRedisClient(env);
  const bullMqRedis = createBullMqRedisClient(env);

  try {
    assert.equal(gatewayRedis.options.lazyConnect, true);
    assert.equal(gatewayRedis.options.maxRetriesPerRequest, 1);
    assert.equal(bullMqRedis.options.maxRetriesPerRequest, null);
    assert.equal(bullMqRedis.options.enableReadyCheck, false);
  } finally {
    gatewayRedis.disconnect();
    bullMqRedis.disconnect();
  }
});

test('core gateway schema exports runtime truth-source tables', () => {
  for (const tableName of [
    'publishingJobs',
    'jobEvents',
    'slackEvents',
    'slackSessions',
    'sessionMemories',
    'issueLinks',
    'agentRuns',
    'githubWebhookDeliveries',
    'reviewAgentComments',
    'slackNotificationDedupes',
    'auditLogs',
    'externalApiCallLogs',
  ]) {
    assert.ok(schema[tableName], `${tableName} should be exported`);
  }
});

test('MySQL gateway store writes Slack notification dedupe rows', async () => {
  const calls = [];
  const store = new MySqlGatewayStore({
    async execute(sql, params) {
      calls.push({ sql, params });
      return [[], []];
    },
    async end() {},
  });

  await store.recordSlackNotification('job_db', 'callback:issue_created');

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /slack_notification_dedupes/);
  assert.deepEqual(calls[0].params.slice(1, 3), ['job_db', 'callback:issue_created']);
});

test('MySQL gateway store health checks the database connection', async () => {
  const calls = [];
  const store = new MySqlGatewayStore({
    async execute(sql, params) {
      calls.push({ sql, params });
      return [[], []];
    },
    async end() {},
  });

  const health = await store.health();

  assert.deepEqual(health, { ok: true, backend: 'mysql' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].sql, 'SELECT 1');
});

test('MySQL gateway store transitions jobs against relational tables', async () => {
  const calls = [];
  const jobRow = {
    id: 'job_db_transition',
    source: 'api',
    requested_by_type: 'user',
    requested_by_id: 'usr_db',
    idempotency_key: 'db-transition',
    employee_slug: 'alice',
    site_slug: 'profile',
    intent: 'create_site',
    approval_mode: 'manual_required',
    status: 'received',
    title: 'Profile',
    summary: 'Create profile',
    created_at: new Date('2026-06-14T00:00:00.000Z'),
    updated_at: new Date('2026-06-14T00:00:00.000Z'),
  };
  const store = new MySqlGatewayStore({
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('SELECT * FROM publishing_jobs WHERE id = ?')) {
        return [[jobRow], []];
      }
      return [[], []];
    },
    async end() {},
  });

  const updated = await store.updateJob('job_db_transition', 'issue_created', {
    issueNumber: 42,
    issueUrl: 'https://github.example/org/pages-manager/issues/42',
  });

  assert.equal(updated.status, 'issue_created');
  assert.equal(updated.issueNumber, 42);
  assert.ok(calls.some((call) => call.sql.includes('INSERT INTO `publishing_jobs`')));
  assert.ok(calls.some((call) => call.sql.includes('INSERT INTO `job_events`')));
});

test('MySQL gateway store records Slack status messages without relying on sync base lookups', async () => {
  const calls = [];
  const store = new MySqlGatewayStore({
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('SELECT * FROM slack_job_status_messages')) {
        return [[], []];
      }
      return [[], []];
    },
    async end() {},
  });

  const message = await store.recordSlackJobStatusMessage(
    'job_db_status',
    {
      channel: 'C1',
      threadTs: '1710000000.000100',
      messageTs: '1710000001.000100',
      stage: 'received',
      status: 'received',
    },
    new Date('2026-06-14T00:00:00.000Z')
  );

  assert.equal(message.jobId, 'job_db_status');
  assert.equal(message.messageTs, '1710000001.000100');
  assert.ok(calls.some((call) => call.sql.includes('INSERT INTO `slack_job_status_messages`')));
});
