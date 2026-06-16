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
  ]) {
    assert.match(migration, new RegExp(`\\b${column}\\b`));
  }

  assert.match(migration, /idx_worker_slots_environment_number/);
  assert.match(migration, /idx_deployments_idempotency/);
});
