import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readDoc(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('API.md documents deploy token ownership and 409 conflicts', () => {
  const api = readDoc('API.md');

  assert.match(api, /X-Pages-Token/);
  assert.match(api, /部署必须携带/);
  assert.match(api, /同名站点/);
  assert.match(api, /409/);
  assert.match(api, /使用原 token/);
  assert.doesNotMatch(api, /新站点可不携带 token/);
  assert.doesNotMatch(api, /无需额外认证/);
});

test('public deploy curl examples include X-Pages-Token', () => {
  const docs = [readDoc('API.md'), readDoc('README.md')].join('\n');
  const deployCommandCount = (docs.match(/curl -X POST https:\/\/api\.workers\.xd\.team\/deploy/g) || []).length;
  const deployTokenHeaderCount = (docs.match(/-H "X-Pages-Token: pages_[^"]+"/g) || []).length;

  assert.ok(deployCommandCount >= 4);
  assert.equal(deployTokenHeaderCount, deployCommandCount);
});

test('README deploy script examples include PAGES_TOKEN', () => {
  const readme = readDoc('README.md');
  const deployScriptCommands = readme.match(/(?:PAGES_TOKEN=[^\s]+ )?bash scripts\/deploy\.sh [^\n]+/g) || [];

  assert.equal(deployScriptCommands.length, 3);
  for (const command of deployScriptCommands) {
    assert.match(command, /^PAGES_TOKEN=pages_[^\s]+ bash scripts\/deploy\.sh /);
  }
  assert.match(readme, /PAGES_TOKEN=pages_[^\s]+ bash scripts\/manage\.sh list/);
});
