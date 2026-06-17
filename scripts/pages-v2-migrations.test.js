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
});

test('slot id migration scopes legacy worker slot ids by environment', () => {
  assert.match(slotIdMigration, /UPDATE site_routes\s+SET slot_id = 'slot_' \|\| environment \|\| '_' \|\| substr\(slot_id, 6\)/);
  assert.match(slotIdMigration, /UPDATE site_versions\s+SET slot_id =/);
  assert.match(slotIdMigration, /FROM sites\s+WHERE sites\.id = site_versions\.site_id/);
  assert.match(slotIdMigration, /UPDATE worker_slots\s+SET id = 'slot_' \|\| environment \|\| '_' \|\| substr\(id, 6\)/);
  assert.match(slotIdMigration, /WHERE id GLOB 'slot_\[0-9\]\[0-9\]\[0-9\]'/);
  assert.doesNotMatch(slotIdMigration, /DROP TABLE/i);
});
