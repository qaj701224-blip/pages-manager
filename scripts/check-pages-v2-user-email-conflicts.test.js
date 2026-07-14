import assert from 'node:assert/strict';
import test from 'node:test';

import { checkUserEmailConflicts } from './check-pages-v2-user-email-conflicts.mjs';

function wranglerResult(rows, success = true) {
  return JSON.stringify([{ results: rows, success }]);
}

test('email conflict preflight allows a new D1 database without a users table', () => {
  const commands = [];
  const result = checkUserEmailConflicts('pages-v2-metadata-staging', (_databaseName, sql) => {
    commands.push(sql);
    return wranglerResult([{ users_table_count: 0 }]);
  });

  assert.deepEqual(result, { status: 'skipped', conflictGroupCount: 0 });
  assert.equal(commands.length, 1);
  assert.match(commands[0], /sqlite_schema/);
});

test('email conflict preflight accepts an existing users table without normalized duplicates', () => {
  const commands = [];
  const responses = [wranglerResult([{ users_table_count: 1 }]), wranglerResult([{ conflict_group_count: 0 }])];
  const result = checkUserEmailConflicts('pages-v2-metadata', (_databaseName, sql) => {
    commands.push(sql);
    return responses.shift();
  });

  assert.deepEqual(result, { status: 'ok', conflictGroupCount: 0 });
  assert.equal(commands.length, 2);
  assert.match(commands[1], /SELECT COUNT\(\*\) AS conflict_group_count/);
  assert.match(commands[1], /GROUP BY lower\(trim\(email\)\)/);
  assert.doesNotMatch(commands[1], /SELECT\s+lower\(trim\(email\)\)/);
});

test('email conflict preflight blocks migration without printing email values', () => {
  const responses = [wranglerResult([{ users_table_count: 1 }]), wranglerResult([{ conflict_group_count: 2 }])];

  assert.throws(
    () => checkUserEmailConflicts('pages-v2-metadata', () => responses.shift()),
    /Found 2 normalized email conflict groups.*docs\/operations\/resources-and-deployment\.md/
  );
});

test('email conflict preflight fails closed on an invalid Wrangler response', () => {
  assert.throws(
    () => checkUserEmailConflicts('pages-v2-metadata', () => JSON.stringify([{ success: false, results: [] }])),
    /Wrangler D1 query failed/
  );
});
