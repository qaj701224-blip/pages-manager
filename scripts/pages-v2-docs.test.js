import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('XD Pages architecture documents exact deploy workflow config names', () => {
  const doc = readRepoFile('docs/pages-v2-wfp-architecture.md');

  for (const name of [
    'CLOUDFLARE_ACCOUNT_ID',
    'CLOUDFLARE_API_TOKEN',
    'CF_API_TOKEN',
    'IP_ALLOWLIST',
    'SLACK_PAGES_ALERT_WEBHOOK_URL',
    'SLACK_PAGES_ALERT_MENTION_USER_ID',
    'PAGES_V2_D1_DATABASE_ID',
    'PAGES_V2_ROUTE_SNAPSHOTS_KV_ID',
    'PAGES_V2_SITE_DATA_KV_ID',
    'SSO_CLIENT_SECRET',
    'ACCESS_KEY_PEPPER_*',
    'PAGES_SESSION_JWT_SECRET_*',
    'PAGES_CAP_JWT_SECRET_*',
    'ROUTER_IP_ALLOWLIST_CIDRS',
  ]) {
    assert.match(doc, new RegExp(escapeRegExp(name)), `${name} should be documented`);
  }

  assert.match(doc, /Deploy XD Pages Production[\s\S]*workflow_dispatch/);
  assert.match(doc, /Deploy XD Pages Staging[\s\S]*component=all/);
  assert.match(doc, /docs\/xd-sso\.md # 期望失败/);
});

test('XD Pages architecture release gate names the checked workflow and secret scripts', () => {
  const doc = readRepoFile('docs/pages-v2-wfp-architecture.md');

  assert.match(
    doc,
    /node --test scripts\/render-pages-v2-wrangler\.test\.js scripts\/pages-v2-secrets\.test\.js scripts\/workflows\.test\.js/,
  );
  assert.match(doc, /DRY_RUN=1 scripts\/put-pages-v2-secrets\.sh/);
  assert.match(doc, /deploy-pages-v2\.yml/);
  assert.match(doc, /deploy-pages-v2-staging\.yml/);
});

test('XD Pages architecture keeps execution provider internal to the platform', () => {
  const doc = readRepoFile('docs/pages-v2-wfp-architecture.md');

  for (const text of [
    'PAGES_EXECUTION_MODE',
    'PAGES_NORMAL_WORKER_SLOT_MIN_AVAILABLE',
    'PAGES_NORMAL_WORKER_SLOT_EXPAND_BY',
    'PAGES_NORMAL_WORKER_SLOT_MAX_TOTAL',
    'PAGES_NORMAL_WORKER_SLOT_BINDING_COUNT',
    'normal-worker-slot',
    'worker_slots',
    'available_pending_router',
    'schemaVersion": 2',
    'CF-Platform-KV-Capability',
  ]) {
    assert.match(doc, new RegExp(escapeRegExp(text)), `${text} should be documented`);
  }

  assert.match(doc, /slot 兼容层不是用户可选 provider/);
  assert.match(doc, /CLI 不自动读取、不自动生成隐式项目绑定文件/);
  assert.match(doc, /pages deploy --config pages\.config\.json/);
  assert.match(doc, /pages deploy \.\/dist foo --access-key <key> --json/);
  assert.match(doc, /--visibility internal\|org\|acl\|owner\|disabled/);
  assert.match(doc, /未知 visibility，包括旧的 public，必须 fail closed/);
  assert.doesNotMatch(doc, /\.pages\.json/);
  assert.doesNotMatch(doc, /--save-config/);
  assert.doesNotMatch(doc, /--slug/);
  assert.doesNotMatch(doc, /--site/);
  assert.doesNotMatch(doc, /--execution-provider/);
  assert.doesNotMatch(doc, /--runtime wfp/);
  assert.doesNotMatch(doc, /pages deploy --runtime/);
  assert.doesNotMatch(doc, /pages deploy \.\/dist --name/);
});

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
