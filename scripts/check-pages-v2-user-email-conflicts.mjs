#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const USERS_TABLE_SQL = `
  SELECT COUNT(*) AS users_table_count
  FROM sqlite_schema
  WHERE type = 'table' AND name = 'users'
`;

const EMAIL_CONFLICTS_SQL = `
  SELECT COUNT(*) AS conflict_group_count
  FROM (
    SELECT 1
    FROM users
    GROUP BY lower(trim(email))
    HAVING COUNT(*) > 1
  )
`;

function extractCount(raw, field) {
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new Error('Wrangler D1 query returned invalid JSON');
  }

  const entries = Array.isArray(payload) ? payload : [payload];
  if (entries.length === 0 || entries.some((entry) => entry?.success === false)) {
    throw new Error('Wrangler D1 query failed');
  }

  const rows = entries.flatMap((entry) => entry?.results || entry?.result?.results || []);
  const value = Number(rows[0]?.[field]);
  if (rows.length !== 1 || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Wrangler D1 query did not return a valid ${field}`);
  }
  return value;
}

function executeWrangler(databaseName, sql) {
  const result = spawnSync(
    'pnpm',
    ['--dir', 'apps/pages-api', 'exec', 'wrangler', 'd1', 'execute', databaseName, '--remote', '--json', '--command', sql],
    { encoding: 'utf8' }
  );

  if (result.error) {
    throw new Error(`Unable to run Wrangler D1 query: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`Wrangler D1 query failed with exit code ${result.status}`);
  }
  return result.stdout;
}

export function checkUserEmailConflicts(databaseName, execute = executeWrangler) {
  if (!databaseName) throw new Error('D1 database name is required');

  const usersTableCount = extractCount(execute(databaseName, USERS_TABLE_SQL), 'users_table_count');
  if (usersTableCount === 0) {
    return { status: 'skipped', conflictGroupCount: 0 };
  }
  if (usersTableCount !== 1) {
    throw new Error('Unexpected users table count');
  }

  const conflictGroupCount = extractCount(execute(databaseName, EMAIL_CONFLICTS_SQL), 'conflict_group_count');
  if (conflictGroupCount > 0) {
    throw new Error(
      `Found ${conflictGroupCount} normalized email conflict groups. ` +
        'Resolve them using docs/operations/resources-and-deployment.md before retrying; no email values were printed.'
    );
  }
  return { status: 'ok', conflictGroupCount };
}

function main() {
  try {
    const result = checkUserEmailConflicts(process.argv[2]);
    if (result.status === 'skipped') {
      console.log('Normalized email conflict check skipped: users table does not exist yet.');
    } else {
      console.log('Normalized email conflict check passed: 0 conflict groups.');
    }
  } catch (error) {
    console.error(`Normalized email conflict check failed: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
