import assert from 'node:assert/strict';
import test from 'node:test';

import { SCHEMA_VERSION, createSchemaSql } from './schema.js';

test('schema defines all v2 authority tables', () => {
  const sql = createSchemaSql().join('\n');
  const tables = [
    'users',
    'sites',
    'site_routes',
    'hostname_claims',
    'hostname_claim_conflicts',
    'site_versions',
    'site_secrets',
    'site_vars',
    'worker_slots',
    'deployments',
    'site_members',
    'site_acl_entries',
    'access_keys',
    'auth_sessions_index',
    'audit_events',
  ];

  assert.equal(SCHEMA_VERSION, 10);
  for (const table of tables) {
    assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\b`));
  }
});

test('schema includes authority indexes for routing, idempotency, and access keys', () => {
  const sql = createSchemaSql().join('\n');

  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_environment_slug/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_site_routes_hostname_live/);
  assert.match(sql, /WHERE route_status != 'deleted'/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_hostname_claims_hostname/);
  assert.doesNotMatch(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_hostname_claims_environment_slug_live/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_hostname_claims_environment_slug_live/);
  assert.match(sql, /WHERE status IN \('pending', 'active', 'held', 'conflicted'\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_deployments_idempotency/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_site_acl_entries_site/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_site_acl_entries_unique_subject/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_access_keys_owner/);
  assert.match(sql, /execution_provider TEXT/);
  assert.match(sql, /dispatch_binding_name TEXT/);
  assert.match(sql, /deployment_shape TEXT/);
  assert.match(sql, /assets_config_json TEXT/);
  assert.match(sql, /var_names_json TEXT/);
  assert.match(sql, /secret_names_json TEXT/);
  assert.match(sql, /encrypted_value TEXT NOT NULL/);
  assert.match(sql, /value TEXT NOT NULL/);
  assert.match(sql, /runtime_config_generation INTEGER NOT NULL DEFAULT 0/);
  assert.match(sql, /runtime_config_lock_id TEXT/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_site_secrets_live/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_site_vars_live/);
  assert.match(sql, /artifact_availability TEXT NOT NULL DEFAULT 'active'/);
  assert.doesNotMatch(sql, /\bartifact_kind\b/);
  assert.match(sql, /user_id TEXT PRIMARY KEY/);
  assert.match(sql, /account_id TEXT/);
  assert.match(sql, /employeenum TEXT/);
  assert.match(sql, /reuse_hold_until TEXT/);
  assert.match(sql, /lease_expires_at TEXT/);
  assert.doesNotMatch(sql, /X-Pages-Token/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_worker_slots_environment_binding/);
  assert.doesNotMatch(sql, /workers\.xd\.team/);
});
