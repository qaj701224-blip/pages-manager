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
    'siteCheckRuns',
    'slackNotificationDedupes',
    'slackAgentReplyMessages',
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

test('MySQL gateway store records Slack Agent reply messages', async () => {
  const calls = [];
  const store = new MySqlGatewayStore({
    async execute(sql, params) {
      calls.push({ sql, params });
      if (/SELECT \* FROM slack_agent_reply_messages/.test(sql)) return [[], []];
      return [[], []];
    },
    async end() {},
  });

  const message = await store.recordSlackAgentReplyMessage('agent_db', {
    slackSessionId: 'sess_db',
    channel: 'D1',
    threadTs: '1710000000.000100',
    messageTs: '1710000001.000100',
    textSnapshot: '我已收到。',
    lastSequence: 2,
    status: 'running',
  });

  assert.equal(message.agentRunId, 'agent_db');
  assert.equal(message.slackSessionId, 'sess_db');
  assert.equal(calls.length, 2);
  assert.match(calls[1].sql, /slack_agent_reply_messages/);
  assert.deepEqual(calls[1].params.slice(1, 4), ['sess_db', 'agent_db', 'D1']);
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

test('MySQL gateway store health checks Redis when Redis is configured', async () => {
  const calls = [];
  const redisCalls = [];
  const store = new MySqlGatewayStore(
    {
      async execute(sql, params) {
        calls.push({ sql, params });
        return [[], []];
      },
      async end() {},
    },
    {
      redis: {
        async ping() {
          redisCalls.push('ping');
          return 'PONG';
        },
      },
    }
  );

  const health = await store.health();

  assert.deepEqual(health, { ok: true, backend: 'mysql' });
  assert.equal(calls.length, 1);
  assert.deepEqual(redisCalls, ['ping']);
});

test('MySQL gateway store health fails when configured Redis is unavailable', async () => {
  const store = new MySqlGatewayStore(
    {
      async execute() {
        return [[], []];
      },
      async end() {},
    },
    {
      redis: {
        async ping() {
          throw new Error('redis unavailable');
        },
      },
    }
  );

  await assert.rejects(() => store.health(), /redis unavailable/);
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

test('MySQL gateway store records Slack deliveries with duplicate-key idempotency', async () => {
  const calls = [];
  const store = new MySqlGatewayStore({
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO `slack_events`')) {
        const error = new Error('Duplicate entry');
        error.code = 'ER_DUP_ENTRY';
        error.errno = 1062;
        throw error;
      }
      if (sql.includes('SELECT * FROM slack_events')) {
        return [
          [
            {
              id: 'slackevt_existing',
              team_id: 'T1',
              event_id: 'Ev1',
              event_type: 'message',
              processing_status: 'received',
              result_type: 'none',
              retry_num: 0,
              created_at: new Date('2026-06-14T00:00:00.000Z'),
              updated_at: new Date('2026-06-14T00:00:00.000Z'),
            },
          ],
          [],
        ];
      }
      return [[], []];
    },
    async end() {},
  });

  const result = await store.recordSlackDelivery({
    teamId: 'T1',
    eventId: 'Ev1',
    eventType: 'message',
  });

  assert.equal(result.created, false);
  assert.equal(result.delivery.id, 'slackevt_existing');
  assert.match(calls[0].sql, /INSERT INTO `slack_events`/);
  assert.doesNotMatch(calls[0].sql, /INSERT IGNORE/);
  assert.match(calls[1].sql, /SELECT \* FROM slack_events/);
});

test('MySQL gateway store does not suppress non-duplicate Slack delivery insert errors', async () => {
  const store = new MySqlGatewayStore({
    async execute(sql) {
      if (sql.includes('INSERT INTO `slack_events`')) {
        const error = new Error('Data truncated for column processing_status');
        error.code = 'WARN_DATA_TRUNCATED';
        throw error;
      }
      return [[], []];
    },
    async end() {},
  });

  await assert.rejects(
    () =>
      store.recordSlackDelivery({
        teamId: 'T1',
        eventId: 'Ev1',
        eventType: 'message',
      }),
    /Data truncated/
  );
});

test('MySQL gateway store records GitHub deliveries with duplicate-key idempotency', async () => {
  const calls = [];
  const store = new MySqlGatewayStore({
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO `github_webhook_deliveries`')) {
        return [{ affectedRows: 1 }, []];
      }
      if (sql.includes('SELECT * FROM github_webhook_deliveries')) {
        return [
          [
            {
              id: 'ghdeliv_created',
              repo_full_name: 'xindong/pages-manager',
              delivery_id: 'delivery-1',
              event_name: 'issues',
              action: 'opened',
              status: 'received',
              created_at: new Date('2026-06-14T00:00:00.000Z'),
              updated_at: new Date('2026-06-14T00:00:00.000Z'),
            },
          ],
          [],
        ];
      }
      return [[], []];
    },
    async end() {},
  });

  const result = await store.recordGithubDelivery({
    repoFullName: 'xindong/pages-manager',
    deliveryId: 'delivery-1',
    eventName: 'issues',
    action: 'opened',
  });

  assert.equal(result.created, true);
  assert.equal(result.delivery.id, 'ghdeliv_created');
  assert.match(calls[0].sql, /INSERT INTO `github_webhook_deliveries`/);
  assert.doesNotMatch(calls[0].sql, /INSERT IGNORE/);
  assert.match(calls[1].sql, /SELECT \* FROM github_webhook_deliveries/);
});

test('MySQL gateway store records agent run events with duplicate-key idempotency', async () => {
  const calls = [];
  const store = new MySqlGatewayStore({
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO `agent_run_events`')) {
        const error = new Error('Duplicate entry');
        error.code = 'ER_DUP_ENTRY';
        error.errno = 1062;
        throw error;
      }
      if (sql.includes('SELECT * FROM agent_run_events WHERE dedupe_key = ?')) {
        return [
          [
            {
              id: 'agentevent_existing',
              publishing_job_id: 'job_1',
              slack_session_id: 'sess_1',
              type: 'job_progress',
              stage: 'fixing',
              text: 'already recorded',
              status: 'recorded',
              dedupe_key: 'progress:job_1:fixing',
              created_at: new Date('2026-06-14T00:00:00.000Z'),
            },
          ],
          [],
        ];
      }
      return [[], []];
    },
    async end() {},
  });

  const result = await store.recordAgentRunEvent({
    publishingJobId: 'job_1',
    slackSessionId: 'sess_1',
    type: 'job_progress',
    stage: 'fixing',
    text: 'already recorded',
    dedupeKey: 'progress:job_1:fixing',
  });

  assert.equal(result.created, false);
  assert.equal(result.event.id, 'agentevent_existing');
  assert.match(calls[0].sql, /INSERT INTO `agent_run_events`/);
  assert.match(calls[1].sql, /SELECT \* FROM agent_run_events WHERE dedupe_key = \?/);
});

test('MySQL gateway store returns canonical Slack session after unique-scope upsert', async () => {
  const calls = [];
  let scopeSelects = 0;
  const store = new MySqlGatewayStore({
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('SELECT * FROM slack_sessions WHERE team_id = ?')) {
        scopeSelects += 1;
        if (scopeSelects === 1) return [[], []];
        return [
          [
            {
              id: 'sess_canonical',
              team_id: 'T1',
              primary_slack_user_id: 'U1',
              session_key: 'dm:D1:current',
              session_title: 'Slack conversation',
              status: 'active',
              created_at: new Date('2026-06-14T00:00:00.000Z'),
              updated_at: new Date('2026-06-14T00:00:00.000Z'),
            },
          ],
          [],
        ];
      }
      if (sql.includes('SELECT * FROM session_memories')) return [[], []];
      return [[], []];
    },
    async end() {},
  });

  const session = await store.upsertSlackSession({
    id: 'sess_generated',
    teamId: 'T1',
    primarySlackUserId: 'U1',
    sessionKey: 'dm:D1:current',
  });

  const memoryInsert = calls.find((call) => call.sql.includes('INSERT INTO `session_memories`'));
  assert.equal(session.id, 'sess_canonical');
  assert.equal(memoryInsert.params[1], 'sess_canonical');
});

test('MySQL gateway store uses Redis SET NX as Slack Agent lease when Redis is configured', async () => {
  const calls = [];
  const redisCalls = [];
  const redis = {
    async set(...args) {
      redisCalls.push(['set', ...args]);
      return 'OK';
    },
    async get(...args) {
      redisCalls.push(['get', ...args]);
      return null;
    },
    async del(...args) {
      redisCalls.push(['del', ...args]);
      return 1;
    },
  };
  const store = new MySqlGatewayStore(
    {
      async execute(sql, params) {
        calls.push({ sql, params });
        if (sql.includes('SELECT * FROM agent_runs')) return [[], []];
        if (sql.includes('INSERT INTO `agent_runs`')) return [{ affectedRows: 1 }, []];
        return [[], []];
      },
      async end() {},
    },
    { redis }
  );

  const lease = await store.acquireSlackAgentLease(
    'sess_lease',
    { slackAgentSessionLeaseMs: 180_000, slackAgentTurnTimeoutMs: 300_000 },
    new Date('2026-06-14T00:00:00.000Z')
  );

  assert.equal(lease.acquired, true);
  assert.equal(lease.agentRun.slackSessionId, 'sess_lease');
  assert.deepEqual(redisCalls[0].slice(0, 4), ['set', 'pages-manager:slack-agent:lease:sess_lease', lease.agentRun.id, 'PX']);
  assert.equal(redisCalls[0][5], 'NX');
  assert.ok(calls.some((call) => call.sql.includes('INSERT INTO `agent_runs`')));
});

test('MySQL gateway store releases Slack Agent leases with atomic Redis compare-delete', async () => {
  const redisCalls = [];
  const redis = {
    async set(...args) {
      redisCalls.push(['set', ...args]);
      return 'OK';
    },
    async eval(...args) {
      redisCalls.push(['eval', ...args]);
      return 1;
    },
  };
  const rows = new Map();
  const store = new MySqlGatewayStore(
    {
      async execute(sql, params) {
        if (sql.includes('SELECT * FROM agent_runs WHERE slack_session_id = ?')) return [[...rows.values()], []];
        if (sql.includes('SELECT * FROM agent_runs WHERE id = ?')) return [[rows.get(params[0])].filter(Boolean), []];
        if (sql.includes('INSERT INTO `agent_runs`')) {
          rows.set(params[0], {
            id: params[0],
            agent_kind: params[1],
            slack_session_id: params[2],
            publishing_job_id: params[3],
            work_item_kind: params[4],
            work_item_id: params[5],
            status: params[6],
            round_no: params[7],
            provider: params[8],
            model: params[9],
            model_api_style: params[10],
            prompt_version: params[11],
            policy_version: params[12],
            input_summary_hash: params[13],
            output_hash: params[14],
            report_json: params[15],
            error_code: params[16],
            error_message: params[17],
            lease_expires_at: new Date(params[18]),
            timeout_at: new Date(params[19]),
            started_at: new Date(params[20]),
            completed_at: params[21] ? new Date(params[21]) : null,
            created_at: new Date(params[22]),
            updated_at: new Date(params[23]),
          });
          return [{ affectedRows: 1 }, []];
        }
        if (sql.includes('UPDATE `agent_runs`')) {
          const row = rows.get(params[0]);
          rows.set(params[0], { ...row, status: params[6], completed_at: new Date(params[21]) });
          return [{ affectedRows: 1 }, []];
        }
        return [[], []];
      },
      async end() {},
    },
    { redis }
  );

  const lease = await store.acquireSlackAgentLease(
    'sess_lease',
    { slackAgentSessionLeaseMs: 180_000, slackAgentTurnTimeoutMs: 300_000 },
    new Date('2026-06-14T00:00:00.000Z')
  );
  await store.completeAgentRun(lease.agentRun.id, {}, new Date('2026-06-14T00:01:00.000Z'));

  const evalCall = redisCalls.find((call) => call[0] === 'eval');
  assert.equal(evalCall?.[2], 1);
  assert.equal(evalCall?.[3], 'pages-manager:slack-agent:lease:sess_lease');
  assert.equal(evalCall?.[4], lease.agentRun.id);
  assert.equal(redisCalls.some((call) => call[0] === 'get'), false);
  assert.equal(redisCalls.some((call) => call[0] === 'del'), false);
});

test('MySQL gateway store refuses a Slack Agent lease when Redis NX sees another holder', async () => {
  const redis = {
    async set() {
      return null;
    },
    async get() {
      return 'agent_existing';
    },
    async eval() {
      return 0;
    },
  };
  const store = new MySqlGatewayStore(
    {
      async execute(sql) {
        if (sql.includes('SELECT * FROM agent_runs')) return [[], []];
        return [[], []];
      },
      async end() {},
    },
    { redis }
  );

  const lease = await store.acquireSlackAgentLease(
    'sess_lease',
    { slackAgentSessionLeaseMs: 180_000, slackAgentTurnTimeoutMs: 300_000 },
    new Date('2026-06-14T00:00:00.000Z')
  );

  assert.equal(lease.acquired, false);
  assert.equal(lease.agentRun.id, 'agent_existing');
});

test('MySQL gateway store uses sanitized pagination SQL for list queries', async () => {
  const calls = [];
  const store = new MySqlGatewayStore({
    async execute(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('COUNT(*)')) return [[{ total: 0 }], []];
      return [[], []];
    },
    async end() {},
  });

  await store.listJobs({ q: 'profile_%\\', limit: 500, offset: -1 });
  await store.listGithubDeliveries({ eventName: 'issues', limit: 20, offset: 5 });
  await store.listSlackDeliveries({ publishingJobId: 'job_db_status', limit: 100, offset: 0 });

  const selectCalls = calls.filter((call) => /ORDER BY updated_at DESC/.test(call.sql));
  assert.equal(selectCalls.length, 3);
  assert.match(selectCalls[0].sql, /LIMIT 200 OFFSET 0$/);
  assert.match(selectCalls[0].sql, /LIKE \? ESCAPE '\\\\'/);
  assert.match(selectCalls[1].sql, /LIMIT 20 OFFSET 5$/);
  assert.match(selectCalls[2].sql, /LIMIT 100 OFFSET 0$/);
  assert.equal(selectCalls[0].params.length, 9);
  assert.ok(selectCalls[0].params.every((param) => param === '%profile\\_\\%\\\\%'));
  assert.deepEqual(selectCalls[1].params, ['issues']);
  assert.deepEqual(selectCalls[2].params, ['job_db_status']);
});
