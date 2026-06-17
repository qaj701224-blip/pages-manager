import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
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
  assert.match(api, /查询响应不会返回站点 token/);
  assert.match(api, /成功响应不会返回站点 token/);
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
  const manageScriptCommands = readme.match(/(?:PAGES_TOKEN=[^\s]+ )?bash scripts\/manage\.sh (?:list|info|delete)[^\n]*/g) || [];

  assert.equal(deployScriptCommands.length, 3);
  for (const command of deployScriptCommands) {
    assert.match(command, /^PAGES_TOKEN=pages_[^\s]+ bash scripts\/deploy\.sh /);
  }
  assert.equal(manageScriptCommands.length, 3);
  for (const command of manageScriptCommands) {
    assert.match(command, /^PAGES_TOKEN=pages_[^\s]+ bash scripts\/manage\.sh /);
  }
});

test('each public doc says v1 Pages KV is retired and avoids private capability text', () => {
  const docs = [
    ['README.md', readDoc('README.md')],
    ['API.md', readDoc('API.md')],
    ['pages-deploy.skill.md', readDoc('pages-deploy.skill.md')],
  ];

  for (const [name, doc] of docs) {
    assert.match(doc, /v1.*不再提供 Pages KV|Pages KV.*迁入 v2/, `${name} documents v1 KV retirement`);
    assert.doesNotMatch(doc, /KV 能力.*平台规划|后续 v2 `pages\.xd\.team`/, `${name} does not describe v2 KV as future-only`);
    assert.doesNotMatch(doc, /static \+ kv=true/, `${name} no longer documents v1 static KV rejection`);
    assert.doesNotMatch(doc, /\/\.xd-pages\/runtime\/v1/, `${name} does not document retired runtime path`);
    assert.doesNotMatch(doc, /@xd\/pages-sdk\/browser/, `${name} does not document retired browser SDK entry`);
    assert.doesNotMatch(doc, /@xd\/pages-sdk\/worker/, `${name} does not document retired worker SDK entry`);

    assert.doesNotMatch(doc, /PAGES_CAP_JWT_SECRET/, `${name} does not mention internal JWT secret env`);
    assert.doesNotMatch(doc, /SITE_DATA_KV_NAMESPACE_ID/, `${name} does not mention platform KV namespace env`);
    assert.doesNotMatch(doc, /capability\.jwt/, `${name} does not include capability example`);
  }
});

test('README local deployment commands use package scripts or wrangler directly', () => {
  const readme = readDoc('README.md');

  assert.doesNotMatch(readme, /JWT_SIGNING_SECRET_ENV=PAGES_CAP_JWT_SECRET_EXAMPLE/);
  assert.doesNotMatch(readme, /JWT_SIGNING_SECRET_ENV=JWT_SIGNING_SECRET_EXAMPLE/);
  assert.doesNotMatch(readme, /PAGES_CAP_JWT_ACTIVE_KID=prod-hs-example/);
  assert.doesNotMatch(readme, /export PAGES_CAP_JWT_ACTIVE_KID/);
  assert.doesNotMatch(readme, /pnpm --dir apps\/kv-gateway exec wrangler deploy/);
  assert.match(readme, /pnpm --dir apps\/server run deploy/);
  assert.doesNotMatch(readme, /pnpm --dir apps\/server deploy\b/);
  assert.doesNotMatch(readme, /scripts\/put-capability-secrets\.sh apps\/server/);
  assert.doesNotMatch(readme, /pnpm --dir apps\/kv-gateway deploy/);
});

test('published SDK README does not demonstrate bypassing runtime access checks', () => {
  const sdkReadme = readDoc('apps/pages-sdk/README.md');

  assert.doesNotMatch(sdkReadme, /checkAccess:\s*\(\)\s*=>\s*null/);
  assert.match(sdkReadme, /checkAccess/);
  assert.match(sdkReadme, /allowlist|auth|IP/i);
});
