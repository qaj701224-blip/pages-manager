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
  return splitDocPaths.map((file) => readRepoFile(file)).join('\n');
}

test('XD Cell docs are split into indexed topic files', () => {
  const index = readRepoFile('docs/pages-v2-wfp-architecture.md');

  assert.match(index, /本文是 XD Cell 架构文档索引/);
  for (const file of splitDocPaths.slice(1)) {
    assert.match(index, new RegExp(escapeRegExp(file.replace('docs/', './'))), `${file} should be linked`);
    const lineCount = readRepoFile(file).split('\n').length;
    assert.ok(lineCount <= maxReviewableMarkdownLines, `${file} should stay reviewable, got ${lineCount} lines`);
  }
  assert.equal(existsSync(join(repoRoot, 'docs/人工配置待办.md')), false);
});

test('current docs stay short enough to review', () => {
  const docs = listMarkdownFiles('docs').filter((file) => !file.startsWith('docs/superpowers/'));

  for (const file of ['README.md', 'AGENTS.md', ...docs]) {
    const lineCount = readRepoFile(file).split('\n').length;
    assert.ok(
      lineCount <= maxReviewableMarkdownLines,
      `${file} should be split when it exceeds ${maxReviewableMarkdownLines} lines, got ${lineCount}`
    );
  }
});

test('Console architecture separates its directory lane from Cindy Public Sites', () => {
  const doc = readRepoFile('docs/architecture/xd-cell-console.md');

  assert.match(doc, /### Console directory 与 Cindy Public Sites/);
  assert.match(doc, /Console directory[\s\S]*pages-console` BFF[\s\S]*pages-api\.internal/);
  assert.match(doc, /Console directory[\s\S]*Console session[\s\S]*公司网络 IP allowlist/);
  assert.match(doc, /production 目录可在 BFF 边界内匿名/);
  assert.match(doc, /Console directory[\s\S]*latest route[\s\S]*不要求 route active 或存在 active version/);
  assert.match(doc, /Console directory[^\n]*可展示 `status=disabled`[^\n]*`routingStatus=pending`/);
  assert.match(doc, /active route 与 active version[^\n]*Cindy Public Sites[^\n]*不是 Console directory 的入选条件/);
  assert.match(doc, /Cindy Public Sites[\s\S]*active user Bearer credential/);
  assert.match(doc, /Cindy connection assertion、CLI 登录凭证或合格的个人 read key/);
  assert.match(doc, /不提供匿名目录/);
  assert.match(doc, /active-only minimal projection/);
  assert.match(doc, /Owner 安全展示名[^\n]*个人直接归属标记[^\n]*point-in-time `permissions\.canDeploy`/);
  assert.match(doc, /`permissions\.canDeploy`[^\n]*当前请求凭证[^\n]*部署入口[^\n]*重新鉴权/);
  assert.match(
    doc,
    /不返回 Owner 邮箱、内部 user\/team ID、部门路径、team role、ACL、route\/version、runtime 或 provider metadata/
  );
  assert.match(doc, /`public`[^\n]*API lane[^\n]*不是 `exposure=public`/);
  assert.match(doc, /Console 内部匿名目录能力[^\n]*active user Bearer 要求/);
  assert.doesNotMatch(doc, /未登录时[^\n]*active `internal` 站点/);
});

test('documentation truth source matrix names current owners', () => {
  const doc = readRepoFile('docs/README.md');

  for (const text of [
    '真相源矩阵',
    'README.md',
    'AGENTS.md',
    'apps/pages-api/src/openapi.js',
    'apps/pages-skill/skill/SKILL.md',
    'apps/worker-sdk/README.md',
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
  const architectureDocs = ['docs/architecture/xd-pages-overview.md', 'docs/architecture/publishing-and-runtime.md']
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
    assert.ok(lineCount <= maxReviewableMarkdownLines, `${file} should stay reviewable, got ${lineCount} lines`);
  }
});

test('XD Cell architecture documents exact deploy workflow config names', () => {
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

  assert.match(doc, /Deploy XD Cell Production[\s\S]*workflow_dispatch/);
  assert.match(doc, /Deploy XD Cell Staging[\s\S]*component=all/);
  assert.match(doc, /git ls-files --error-unmatch '\*sso\*\.md' # 期望失败/);
  assert.doesNotMatch(doc, /docs\/xd-sso\.md/);
});

test('XD Cell architecture release gate names the checked workflow and secret scripts', () => {
  const doc = readPagesDocs();

  assert.match(
    doc,
    /node --test scripts\/render-pages-v2-wrangler\.test\.js scripts\/pages-v2-secrets\.test\.js scripts\/workflows\.test\.js/
  );
  assert.match(doc, /DRY_RUN=1 scripts\/put-pages-v2-secrets\.sh/);
  assert.match(doc, /deploy-pages-v2\.yml/);
  assert.match(doc, /deploy-pages-v2-staging\.yml/);
});

test('XD Cell architecture keeps execution provider internal to the platform', () => {
  const doc = readPagesDocs();

  for (const text of [
    'PAGES_EXECUTION_MODE',
    'PAGES_NORMAL_WORKER_SLOT_MIN_AVAILABLE',
    'PAGES_NORMAL_WORKER_SLOT_EXPAND_BY',
    'PAGES_NORMAL_WORKER_SLOT_MAX_TOTAL',
    'PAGES_NORMAL_WORKER_SLOT_CLEANUP_RETENTION_SECONDS',
    'PAGES_NORMAL_WORKER_SLOT_BINDINGS_JSON',
    'Legacy Normal Workers',
    'normal-worker-slot',
    'worker_slots',
    'available_pending_router',
    'schemaVersion": 4',
    'CF-Platform-KV-Capability',
  ]) {
    assert.match(doc, new RegExp(escapeRegExp(text)), `${text} should be documented`);
  }

  assert.match(doc, /slot 兼容层不是用户可选 provider/);
  assert.match(doc, /CLI 不自动读取、不自动生成隐式项目绑定文件/);
  assert.match(doc, /xd-cell deploy --config xd-cell\.config\.json/);
  assert.match(doc, /xd-cell deploy \.\/dist foo --token <token> --json/);
  assert.match(doc, /--visibility internal\|org\|acl\|owner\|disabled/);
  assert.match(doc, /未知 visibility，包括旧的 public，必须 fail closed/);
  assert.doesNotMatch(doc, /\.pages\.json/);
  assert.doesNotMatch(doc, /--save-config/);
  assert.doesNotMatch(doc, /--slug/);
  assert.doesNotMatch(doc, /--site/);
  assert.doesNotMatch(doc, /--execution-provider/);
  assert.doesNotMatch(doc, /--runtime wfp/);
  assert.doesNotMatch(doc, /xd-cell deploy --runtime/);
  assert.doesNotMatch(doc, /xd-cell deploy \.\/dist --name/);
});

test('XD Cell architecture documents site metadata compatibility and staged rollout', () => {
  const doc = readPagesDocs();

  for (const text of [
    'SITE_METADATA_MUTATIONS_ENABLED',
    '0021_site_metadata.sql',
    'dataNamespace',
    'site_slug_renamed_pending_cleanup',
    'kind=serve',
    '旧地址不跳转',
    '缩略图与 R2 延期',
    'failure_stage=site_metadata',
    'deployment GET 不触发恢复',
    '不承诺跨进程 exactly-once',
  ]) {
    assert.match(doc, new RegExp(escapeRegExp(text)), `${text} should be documented`);
  }
  assert.match(doc, /当前默认均为 `true`/);
  assert.match(doc, /显式携带 `title` 的部署[^。\n]*省略 `title` 的部署不受影响/);
  assert.match(doc, /consumer-before-producer/);
  assert.doesNotMatch(doc, /历史地址以 308|schema v4 redirect snapshot/);
  assert.match(doc, /production[^。\n]*只通过 `Deploy XD Cell Production` 手动发布/);
  assert.match(doc, /首个 schema v4 pointer[^。\n]*不得降级[^。\n]*旧 pages-router 或 pages-kv-gateway/);
  assert.match(doc, /尚未发生 slug rename[^。\n]*只回滚 pages-api[^。\n]*保留新版 pages-router 和 pages-kv-gateway/);
  assert.match(doc, /首次 slug rename[^。\n]*pages-api、pages-router 与 pages-kv-gateway[^。\n]*roll forward/);
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
