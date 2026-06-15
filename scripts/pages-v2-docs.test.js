import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('pages v2 architecture documents exact deploy workflow config names', () => {
  const doc = readRepoFile('docs/pages-v2-wfp-architecture.md');

  for (const name of [
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
    'CF_API_TOKEN',
    'PAGES_V2_D1_DATABASE_ID',
    'PAGES_V2_ROUTE_SNAPSHOTS_KV_ID',
    'SSO_CLIENT_SECRET',
    'ACCESS_KEY_PEPPER_*',
    'PAGES_SESSION_JWT_SECRET_*',
    'ROUTER_IP_ALLOWLIST_CIDRS',
  ]) {
    assert.match(doc, new RegExp(escapeRegExp(name)), `${name} should be documented`);
  }

  assert.match(doc, /Deploy Pages V2 Production[\s\S]*workflow_dispatch/);
  assert.match(doc, /Deploy Pages V2 Staging[\s\S]*component=all/);
  assert.match(doc, /docs\/xd-sso\.md # 期望失败/);
});

test('pages v2 architecture release gate names the checked workflow and secret scripts', () => {
  const doc = readRepoFile('docs/pages-v2-wfp-architecture.md');

  assert.match(
    doc,
    /node --test scripts\/render-pages-v2-wrangler\.test\.js scripts\/pages-v2-secrets\.test\.js scripts\/workflows\.test\.js/,
  );
  assert.match(doc, /DRY_RUN=1 scripts\/put-pages-v2-secrets\.sh/);
  assert.match(doc, /deploy-pages-v2\.yml/);
  assert.match(doc, /deploy-pages-v2-staging\.yml/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
