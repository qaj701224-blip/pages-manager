import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { newId, nextId } from './id.js';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));

test('injected ID generators cannot bypass production prefix validation', () => {
  let calls = 0;
  const env = {
    nextId(prefix) {
      calls += 1;
      return `${prefix}_fixture`;
    },
  };

  for (const prefix of ['a', '1a', 'Deploylock', 'deploy_lock', 'deploy-lock', 'abcdefghijklmnopq']) {
    assert.throws(() => nextId(env, prefix), /ID prefix must be lowercase alphanumeric/);
  }
  assert.equal(calls, 0);
  assert.equal(nextId(env, 'ab'), 'ab_fixture');
  assert.equal(nextId(env, 'deploylock'), 'deploylock_fixture');
  assert.equal(nextId(env, 'abcdefghijklmnop'), 'abcdefghijklmnop_fixture');
  assert.equal(calls, 3);
  assert.match(newId('route', { bytes: new Uint8Array([1, 2]) }), /^route_0102$/);
});

test('production modules use the shared injected ID generator boundary', () => {
  const offenders = javascriptSources(sourceDirectory)
    .filter((filePath) => filePath !== fileURLToPath(import.meta.url) && !filePath.endsWith('.test.js'))
    .filter((filePath) => /\benv\?*\.nextId\b/.test(readFileSync(filePath, 'utf8')))
    .map((filePath) => filePath.slice(sourceDirectory.length + 1));

  assert.deepEqual(offenders, ['id.js']);
});

function javascriptSources(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...javascriptSources(filePath));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(filePath);
  }
  return files;
}
