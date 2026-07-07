import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./pages/AdminUsers.jsx', import.meta.url), 'utf8');

test('admin user role changes use an in-page confirmation dialog instead of browser prompt', () => {
  assert.doesNotMatch(source, /window\.prompt/);
  assert.match(source, /admin-user-action-dialog/);
  assert.match(source, /AdminUserActionDialog/);
});
