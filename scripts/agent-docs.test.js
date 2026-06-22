import assert from 'node:assert/strict';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('CLAUDE.md points at the shared AGENTS.md truth source', () => {
  const claudePath = join(repoRoot, 'CLAUDE.md');
  const stat = lstatSync(claudePath);

  assert.equal(stat.isSymbolicLink(), true, 'CLAUDE.md should be a symlink to AGENTS.md');
  assert.equal(readlinkSync(claudePath), 'AGENTS.md');
});

test('agent instructions describe v2 first and v1 as legacy', () => {
  const doc = readFileSync(join(repoRoot, 'AGENTS.md'), 'utf8');

  assert.match(doc, /XD Pages/);
  assert.match(doc, /apps\/pages-api/);
  assert.match(doc, /apps\/pages-cli/);
  assert.match(doc, /apps\/pages-router/);
  assert.match(doc, /v1[\s\S]*legacy|legacy[\s\S]*v1/i);
  assert.match(doc, /apps\/server/);
  assert.match(doc, /api\.pages\.xd\.team/);
  assert.doesNotMatch(doc, /api\.workers\.xd\.team[\s\S]*生产 API/);
});
