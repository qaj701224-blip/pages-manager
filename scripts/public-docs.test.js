import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readDoc(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('API.md documents CLI-managed deployment boundary', () => {
  const api = readDoc('API.md');

  assert.match(api, /pages detect \.\/dist --json/);
  assert.match(api, /pages deploy \.\/dist demo --dry-run --json/);
  assert.match(api, /fallback/);
  assert.match(api, /CLI 内部协议/);
  assert.doesNotMatch(api, /X-Pages-Token/);
  assert.doesNotMatch(api, /preset/);
  assert.doesNotMatch(api, /api\.workers\.xd\.team/);
});

test('public docs recommend pages CLI instead of legacy deploy curl', () => {
  const docs = [readDoc('API.md'), readDoc('README.md')].join('\n');

  assert.match(docs, /pages deploy \.\/dist demo/);
  assert.match(docs, /pages detect \.\/dist --json/);
  assert.doesNotMatch(docs, /curl -X POST https:\/\/api\.workers\.xd\.team\/deploy/);
  assert.doesNotMatch(docs, /X-Pages-Token/);
});

test('README deploy examples use pages CLI and automatic detection', () => {
  const readme = readDoc('README.md');

  assert.match(readme, /pages deploy \.\/dist demo --visibility org/);
  assert.match(readme, /fallback/);
  assert.match(readme, /"worker": \{/);
  assert.match(readme, /"entry": "\.\/worker\.mjs"/);
  assert.doesNotMatch(readme, /PAGES_TOKEN/);
  assert.doesNotMatch(readme, /--preset/);
  assert.doesNotMatch(readme, /artifactKind/);
});

test('public docs describe config discovery without platform internals', () => {
  const docs = [
    ['API.md', readDoc('API.md')],
    ['README.md', readDoc('README.md').split('## 核心目录')[0]],
    ['pages-deploy.skill.md', readDoc('pages-deploy.skill.md')],
  ];

  for (const [name, doc] of docs) {
    assert.match(doc, /pages\.config\.json/, `${name} mentions the standard config file`);
    assert.doesNotMatch(doc, /不自动发现/, `${name} does not contradict config auto-discovery`);
    assert.doesNotMatch(
      doc,
      /--access-key|--env|pages env|"environment"/,
      `${name} keeps hidden options out of user docs`
    );
    assert.doesNotMatch(
      doc,
      /artifactKind|--artifact-kind|--preset|\bpreset\b/,
      `${name} avoids artifact-kind and preset vocabulary`
    );
    assert.doesNotMatch(doc, /WFP|slot|dispatch namespace|service binding/i, `${name} avoids platform internals`);
  }
});

test('each public doc says v1 Pages KV is retired and avoids private capability text', () => {
  const docs = [
    ['README.md', readDoc('README.md')],
    ['API.md', readDoc('API.md')],
    ['pages-deploy.skill.md', readDoc('pages-deploy.skill.md')],
  ];

  for (const [name, doc] of docs) {
    assert.match(doc, /旧版 Pages KV 已退休|runtime helper 或 KV/, `${name} documents old KV retirement`);
    assert.doesNotMatch(doc, /KV 能力.*平台规划|后续 v2 `pages\.xd\.team`/, `${name} does not describe KV as future-only`);
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
  assert.match(readme, /pnpm --dir apps\/pages-api test/);
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
