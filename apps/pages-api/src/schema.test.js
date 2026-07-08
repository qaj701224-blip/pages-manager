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
    'deployment_resource_cleanup_tasks',
    'site_members',
    'site_acl_entries',
    'access_keys',
    'auth_sessions_index',
    'audit_events',
    'teams',
    'team_members',
    'platform_admins',
    'webhook_subscriptions',
    'webhook_deliveries',
  ];

  assert.equal(SCHEMA_VERSION, 13);
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
  assert.match(sql, /failure_stage TEXT/);
  assert.match(sql, /failure_diagnostics_json TEXT/);
  assert.match(sql, /resource_type TEXT NOT NULL/);
  assert.match(sql, /cleanup_after TEXT NOT NULL/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_cleanup_tasks_environment_status/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_site_acl_entries_site/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_site_acl_entries_unique_subject/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_access_keys_owner/);
  assert.match(sql, /department_path TEXT/);
  assert.match(sql, /department_checked_at TEXT/);
  assert.match(sql, /owner_type TEXT NOT NULL DEFAULT 'user'/);
  assert.match(sql, /owner_id TEXT/);
  assert.match(sql, /team_type TEXT NOT NULL/);
  assert.match(sql, /membership_source TEXT NOT NULL/);
  assert.match(sql, /role_overridden_at TEXT/);
  assert.match(sql, /removed_at TEXT/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_teams_department_active/);
  assert.match(sql, /WHERE team_type = 'department' AND status = 'active'/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_team_members_team_user/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_team_members_user_active/);
  assert.match(sql, /encrypted_url_ciphertext TEXT NOT NULL/);
  assert.match(sql, /url_fingerprint TEXT NOT NULL/);
  assert.match(sql, /payload_hash TEXT/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_webhook_subscriptions_environment/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_subscription/);
  assert.doesNotMatch(sql, /\bwebhook_signing_secret\b/);
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
