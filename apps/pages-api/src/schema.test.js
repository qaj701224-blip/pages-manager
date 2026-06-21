import assert from 'node:assert/strict';
import test from 'node:test';

import { SCHEMA_VERSION, createSchemaSql } from './schema.js';

test('schema defines all v2 authority tables', () => {
  const sql = createSchemaSql().join('\n');
  const tables = [
    'users',
    'sites',
    'site_routes',
    'site_versions',
    'worker_slots',
    'deployments',
    'site_members',
    'site_acl_entries',
    'access_keys',
    'auth_sessions_index',
    'audit_events',
  ];

  assert.equal(SCHEMA_VERSION, 5);
  for (const table of tables) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
});

test('schema includes authority indexes for routing, idempotency, and access keys', () => {
  const sql = createSchemaSql().join('\n');

  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_environment_slug/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_site_routes_hostname/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_deployments_idempotency/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_site_acl_entries_site/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_site_acl_entries_unique_subject/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_access_keys_owner/);
  assert.match(sql, /execution_provider TEXT/);
  assert.match(sql, /dispatch_binding_name TEXT/);
  assert.match(sql, /deployment_shape TEXT/);
  assert.match(sql, /assets_config_json TEXT/);
  assert.match(sql, /artifact_availability TEXT NOT NULL DEFAULT 'active'/);
  assert.doesNotMatch(sql, /\bartifact_kind\b/);
  assert.match(sql, /user_id TEXT PRIMARY KEY/);
  assert.match(sql, /account_id TEXT/);
  assert.match(sql, /employeenum TEXT/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_slots_environment_binding/);
  assert.doesNotMatch(sql, /workers\.xd\.team/);
  assert.doesNotMatch(sql, /X-Pages-Token/);
});
