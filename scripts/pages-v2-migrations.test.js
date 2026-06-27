import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createSchemaSql } from '../apps/pages-api/src/schema.js';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const migration = readFileSync(
  join(repoRoot, 'apps/pages-api/migrations/0001_pages_v2_initial.sql'),
  'utf8'
);
const slotIdMigration = readFileSync(
  join(repoRoot, 'apps/pages-api/migrations/0003_environment_scoped_worker_slot_ids.sql'),
  'utf8'
);
const resolvedMetadataMigration = readFileSync(
  join(repoRoot, 'apps/pages-api/migrations/0004_pages_v2_resolved_deployment_metadata.sql'),
  'utf8'
);
const hostnameClaimsMigration = readFileSync(
  join(repoRoot, 'apps/pages-api/migrations/0005_hostname_claims.sql'),
  'utf8'
);
const routeDeletedHostnameReuseMigration = readFileSync(
  join(repoRoot, 'apps/pages-api/migrations/0006_site_route_deleted_hostname_reuse.sql'),
  'utf8'
);
const hostnameClaimSlugCoexistenceMigration = readFileSync(
  join(repoRoot, 'apps/pages-api/migrations/0007_hostname_claim_slug_coexistence.sql'),
  'utf8'
);
const runtimeBindingsMigration = readFileSync(
  join(repoRoot, 'apps/pages-api/migrations/0008_runtime_bindings.sql'),
  'utf8'
);
const runtimeConfigGenerationMigration = readFileSync(
  join(repoRoot, 'apps/pages-api/migrations/0009_runtime_config_generation.sql'),
  'utf8'
);
const siteVarsMigration = readFileSync(
  join(repoRoot, 'apps/pages-api/migrations/0010_site_vars.sql'),
  'utf8'
);

test('pages v2 D1 migration covers authority schema tables and indexes', () => {
  const schema = createSchemaSql().join('\n');
  for (const table of [
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
  ]) {
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
  }

  for (const column of [
    'execution_mode_override',
    'execution_provider',
    'dispatch_binding_name',
    'slot_id',
    'assigned_version_id',
    'last_deployed_version_id',
    'account_id',
    'employeenum',
  ]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`));
  }

  assert.match(migration, /idx_worker_slots_environment_number/);
  assert.match(migration, /idx_deployments_idempotency/);
  assert.doesNotMatch(schema, /\bartifact_kind\b/);
});

test('slot id migration scopes legacy worker slot ids by environment', () => {
  assert.match(slotIdMigration, /UPDATE site_routes\s+SET slot_id = 'slot_' \|\| environment \|\| '_' \|\| substr\(slot_id, 6\)/);
  assert.match(slotIdMigration, /UPDATE site_versions\s+SET slot_id =/);
  assert.match(slotIdMigration, /FROM sites\s+WHERE sites\.id = site_versions\.site_id/);
  assert.match(slotIdMigration, /UPDATE worker_slots\s+SET id = 'slot_' \|\| environment \|\| '_' \|\| substr\(id, 6\)/);
  assert.match(slotIdMigration, /WHERE id GLOB 'slot_\[0-9\]\[0-9\]\[0-9\]'/);
  assert.doesNotMatch(slotIdMigration, /DROP TABLE/i);
});

test('resolved deployment metadata migration removes artifact kind storage', () => {
  assert.match(resolvedMetadataMigration, /CREATE TABLE site_versions_next \(/);
  assert.match(resolvedMetadataMigration, /\bdeployment_shape TEXT NOT NULL\b/);
  assert.match(resolvedMetadataMigration, /\brequested_fallback TEXT NOT NULL\b/);
  assert.match(resolvedMetadataMigration, /\brouting_mode TEXT NOT NULL\b/);
  assert.match(resolvedMetadataMigration, /SELECT[\s\S]+CASE artifact_kind[\s\S]+FROM site_versions/);
  assert.match(resolvedMetadataMigration, /DROP TABLE site_versions/);
  assert.match(resolvedMetadataMigration, /ALTER TABLE site_versions_next RENAME TO site_versions/);
  assert.doesNotMatch(tableDefinition(resolvedMetadataMigration, 'site_versions_next'), /\bartifact_kind\b/);
});

test('hostname claims migration creates the claim and conflict ledgers', () => {
  assert.match(hostnameClaimsMigration, /CREATE TABLE IF NOT EXISTS hostname_claims \(/);
  assert.match(hostnameClaimsMigration, /CREATE TABLE IF NOT EXISTS hostname_claim_conflicts \(/);
  assert.match(hostnameClaimsMigration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_hostname_claims_hostname/);
  assert.match(hostnameClaimsMigration, /ON hostname_claims\(hostname\)/);
  assert.match(hostnameClaimsMigration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_hostname_claims_environment_slug_live/);
  assert.match(hostnameClaimsMigration, /ON hostname_claims\(environment, normalized_slug\)/);
  assert.match(hostnameClaimsMigration, /WHERE status IN \('pending', 'active', 'held', 'conflicted'\)/);
  assert.doesNotMatch(hostnameClaimsMigration, /X-Pages-Token|PAGES_TOKEN|token/i);
});

test('hostname claim slug coexistence migration keeps hostname unique and makes slug lookups non-unique', () => {
  assert.match(hostnameClaimSlugCoexistenceMigration, /DROP INDEX IF EXISTS idx_hostname_claims_environment_slug_live/);
  assert.match(hostnameClaimSlugCoexistenceMigration, /CREATE INDEX IF NOT EXISTS idx_hostname_claims_environment_slug_live/);
  assert.doesNotMatch(
    hostnameClaimSlugCoexistenceMigration,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_hostname_claims_environment_slug_live/
  );
  assert.match(hostnameClaimSlugCoexistenceMigration, /ON hostname_claims\(environment, normalized_slug\)/);
  assert.match(hostnameClaimSlugCoexistenceMigration, /WHERE status IN \('pending', 'active', 'held', 'conflicted'\)/);
  assert.doesNotMatch(hostnameClaimSlugCoexistenceMigration, /DROP TABLE|DELETE FROM hostname_claims/i);
});

test('deleted route hostname reuse migration keeps only live route hostnames unique', () => {
  assert.match(routeDeletedHostnameReuseMigration, /DROP INDEX IF EXISTS idx_site_routes_hostname/);
  assert.match(routeDeletedHostnameReuseMigration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_site_routes_hostname_live/);
  assert.match(routeDeletedHostnameReuseMigration, /ON site_routes\(hostname\)/);
  assert.match(routeDeletedHostnameReuseMigration, /WHERE route_status != 'deleted'/);
  assert.doesNotMatch(routeDeletedHostnameReuseMigration, /DROP TABLE|DELETE FROM site_routes/i);
});

test('runtime bindings migration adds site-level secret store without value digests', () => {
  assert.match(runtimeBindingsMigration, /ALTER TABLE site_versions ADD COLUMN var_names_json TEXT/);
  assert.match(runtimeBindingsMigration, /ALTER TABLE site_versions ADD COLUMN secret_names_json TEXT/);
  assert.match(runtimeBindingsMigration, /CREATE TABLE IF NOT EXISTS site_secrets \(/);
  assert.match(runtimeBindingsMigration, /\benvironment TEXT NOT NULL\b/);
  assert.match(runtimeBindingsMigration, /\bsite_id TEXT NOT NULL\b/);
  assert.match(runtimeBindingsMigration, /\bname TEXT NOT NULL\b/);
  assert.match(runtimeBindingsMigration, /\bencrypted_value TEXT NOT NULL\b/);
  assert.match(runtimeBindingsMigration, /\brevision INTEGER NOT NULL\b/);
  assert.match(runtimeBindingsMigration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_site_secrets_live/);
  assert.match(runtimeBindingsMigration, /ON site_secrets\(environment, site_id, name\)/);
  assert.match(runtimeBindingsMigration, /WHERE deleted_at IS NULL/);
  assert.doesNotMatch(runtimeBindingsMigration, /value_digest|secret_value|plaintext|DROP TABLE|DELETE FROM/i);
});

test('runtime config generation migration tracks route-level runtime config changes', () => {
  assert.match(
    runtimeConfigGenerationMigration,
    /ALTER TABLE site_routes ADD COLUMN runtime_config_generation INTEGER NOT NULL DEFAULT 0/
  );
  assert.match(runtimeConfigGenerationMigration, /ALTER TABLE site_routes ADD COLUMN runtime_config_lock_id TEXT/);
  assert.doesNotMatch(runtimeConfigGenerationMigration, /DROP TABLE|DELETE FROM site_routes/i);
});

test('site vars migration adds site-level runtime var store without secret encryption fields', () => {
  assert.match(siteVarsMigration, /CREATE TABLE IF NOT EXISTS site_vars \(/);
  assert.match(siteVarsMigration, /\benvironment TEXT NOT NULL\b/);
  assert.match(siteVarsMigration, /\bsite_id TEXT NOT NULL\b/);
  assert.match(siteVarsMigration, /\bname TEXT NOT NULL\b/);
  assert.match(siteVarsMigration, /\bvalue TEXT NOT NULL\b/);
  assert.match(siteVarsMigration, /\brevision INTEGER NOT NULL\b/);
  assert.match(siteVarsMigration, /CREATE UNIQUE INDEX IF NOT EXISTS idx_site_vars_live/);
  assert.match(siteVarsMigration, /ON site_vars\(environment, site_id, name\)/);
  assert.match(siteVarsMigration, /WHERE deleted_at IS NULL/);
  assert.doesNotMatch(siteVarsMigration, /encrypted_value|secret_value|DROP TABLE|DELETE FROM/i);
});

function tableDefinition(sql, tableName) {
  const match = sql.match(new RegExp(`CREATE TABLE ${tableName} \\([\\s\\S]*?\\n\\);`));
  return match?.[0] || '';
}
