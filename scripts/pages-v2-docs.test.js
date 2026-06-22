import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const splitDocPaths = [
  'docs/pages-v2-wfp-architecture.md',
  'docs/architecture/xd-pages-overview.md',
  'docs/operations/resources-and-deployment.md',
  'docs/architecture/data-model.md',
  'docs/operations/consistency-and-state.md',
  'docs/security/routing-and-access.md',
  'docs/architecture/publishing-and-runtime.md',
  'docs/operations/observability-and-rollout.md',
];
const maxReviewableMarkdownLines = 700;

function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function readPagesDocs() {
  return splitDocPaths
    .map((file) => readRepoFile(file))
    .join('\n');
}

test('XD Pages docs are split into indexed topic files', () => {
  const index = readRepoFile('docs/pages-v2-wfp-architecture.md');

  assert.match(index, /本文是 XD Pages 架构文档索引/);
  for (const file of splitDocPaths.slice(1)) {
    assert.match(index, new RegExp(escapeRegExp(file.replace('docs/', './'))), `${file} should be linked`);
    const lineCount = readRepoFile(file).split('\n').length;
    assert.ok(
      lineCount <= maxReviewableMarkdownLines,
      `${file} should stay reviewable, got ${lineCount} lines`,
    );
  }
  assert.equal(existsSync(join(repoRoot, 'docs/人工配置待办.md')), false);
});

test('current docs stay short enough to review', () => {
  const docs = listMarkdownFiles('docs')
    .filter((file) => !file.startsWith('docs/superpowers/'));

  for (const file of ['README.md', 'AGENTS.md', ...docs]) {
    const lineCount = readRepoFile(file).split('\n').length;
    assert.ok(
      lineCount <= maxReviewableMarkdownLines,
      `${file} should be split when it exceeds ${maxReviewableMarkdownLines} lines, got ${lineCount}`,
    );
  }
});

test('documentation truth source matrix names current owners', () => {
  const doc = readRepoFile('docs/README.md');

  for (const text of [
    '真相源矩阵',
    'README.md',
    'AGENTS.md',
    'apps/pages-api/src/openapi.js',
    'apps/pages-skill/skill/SKILL.md',
    'apps/pages-sdk/README.md',
    'apps/pages-skill/skill/references/sdk.md',
    'docs/api-boundary.md',
    'docs/pages-v2-wfp-architecture.md',
    'apps/server',
    'v1 legacy',
  ]) {
    assert.match(doc, new RegExp(escapeRegExp(text)), `${text} should be in docs truth source matrix`);
  }
  assert.doesNotMatch(doc, /docs\/人工配置待办\.md/);
});

test('active architecture docs do not become API contract truth sources', () => {
  const architectureDocs = [
    'docs/architecture/xd-pages-overview.md',
    'docs/architecture/publishing-and-runtime.md',
  ]
    .map((file) => readRepoFile(file))
    .join('\n');

  assert.doesNotMatch(architectureDocs, /docs\/xd-sso\.md/);
  assert.doesNotMatch(architectureDocs, /### 最小 API 契约/);
  assert.doesNotMatch(architectureDocs, /\|\s*Method\s*\|\s*Path\s*\|\s*Auth\s*\|/);
  assert.match(architectureDocs, /docs\/api-boundary\.md/);
  assert.match(architectureDocs, /apps\/pages-api\/src\/openapi\.js/);
});

test('v1 legacy DNS docs are colocated with apps/server', () => {
  const serverReadme = readRepoFile('apps/server/README.md');

  assert.equal(existsSync(join(repoRoot, 'docs/cloudflare-partial-zone-cname.md')), false);
  assert.equal(existsSync(join(repoRoot, 'docs/dns-fix-workers-xd-team.md')), false);
  assert.equal(existsSync(join(repoRoot, 'apps/server/docs/cloudflare-partial-zone-cname.md')), true);
  assert.equal(existsSync(join(repoRoot, 'apps/server/docs/dns-fix-workers-xd-team.md')), true);
  assert.match(serverReadme, /v1 legacy/);
  assert.match(serverReadme, /docs\/cloudflare-partial-zone-cname\.md/);
  assert.match(serverReadme, /docs\/dns-fix-workers-xd-team\.md/);
});

test('ADR 0001 is an index over split topic files', () => {
  const index = readRepoFile('docs/adr/0001-pages-v2-artifact-detection.md');
  const files = [
    'docs/adr/0001-pages-v2-artifact-detection/context-and-model.md',
    'docs/adr/0001-pages-v2-artifact-detection/detection-and-preflight.md',
    'docs/adr/0001-pages-v2-artifact-detection/api-storage-and-implementation.md',
    'docs/adr/0001-pages-v2-artifact-detection/tradeoffs-tests-and-references.md',
  ];

  assert.match(index, /原单体 ADR 已按主题拆分/);
  for (const file of files) {
    assert.match(index, new RegExp(escapeRegExp(file.replace('docs/adr/', './'))), `${file} should be linked`);
    const lineCount = readRepoFile(file).split('\n').length;
    assert.ok(
      lineCount <= maxReviewableMarkdownLines,
      `${file} should stay reviewable, got ${lineCount} lines`,
    );
  }
});

test('XD Pages architecture documents exact deploy workflow config names', () => {
  const doc = readPagesDocs();

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
  assert.match(doc, /git ls-files --error-unmatch '\*sso\*\.md' # 期望失败/);
  assert.doesNotMatch(doc, /docs\/xd-sso\.md/);
});

test('XD Pages architecture release gate names the checked workflow and secret scripts', () => {
  const doc = readPagesDocs();

  assert.match(
    doc,
    /node --test scripts\/render-pages-v2-wrangler\.test\.js scripts\/pages-v2-secrets\.test\.js scripts\/workflows\.test\.js/,
  );
  assert.match(doc, /DRY_RUN=1 scripts\/put-pages-v2-secrets\.sh/);
  assert.match(doc, /deploy-pages-v2\.yml/);
  assert.match(doc, /deploy-pages-v2-staging\.yml/);
});

test('XD Pages architecture keeps execution provider internal to the platform', () => {
  const doc = readPagesDocs();

  for (const text of [
    'PAGES_EXECUTION_MODE',
    'PAGES_NORMAL_WORKER_SLOT_MIN_AVAILABLE',
    'PAGES_NORMAL_WORKER_SLOT_EXPAND_BY',
    'PAGES_NORMAL_WORKER_SLOT_MAX_TOTAL',
    'PAGES_NORMAL_WORKER_SLOT_CLEANUP_RETENTION_SECONDS',
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
  assert.match(doc, /pages deploy \.\/dist foo --token <token> --json/);
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

function listMarkdownFiles(dir) {
  const fullDir = join(repoRoot, dir);
  return readdirSync(fullDir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      return listMarkdownFiles(path);
    }
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : [];
  });
}
