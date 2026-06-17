import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { afterEach } from 'node:test';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(repoRoot, 'scripts/test-pages-v2-demos.sh');
const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function tempEnv(content) {
  const dir = mkdtempSync(join(tmpdir(), 'pages-v2-demo-env-'));
  tempDirs.push(dir);
  const file = join(dir, '.env');
  writeFileSync(file, content);
  return file;
}

function cleanEnv(overrides = {}) {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    ...overrides,
  };
}

function run(args, env = cleanEnv()) {
  return spawnSync('bash', [scriptPath, ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
}

test('dry-run plans v2 staging vue demo without requiring legacy token', () => {
  const envFile = tempEnv('');
  const result = run(['--dry-run', '--env-file', envFile]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PAGES_V2_DEMO_TARGET=staging/);
  assert.match(result.stdout, /PAGES_V2_API=https:\/\/api-staging\.pages\.xd\.team/);
  assert.match(result.stdout, /PAGES_V2_SITE=https:\/\/demo-vue-app-staging\.pages\.xd\.team/);
  assert.match(result.stdout, /PAGES_V2_DEMO_VISIBILITY=internal/);
  assert.match(result.stdout, /demo-vue-app\s+spa\s+demos\/vue-app/);
  assert.doesNotMatch(result.stdout, /PAGES_TOKEN|workers\.xd\.team|pages_demo@xd\.com/);
  assert.doesNotMatch(result.stderr, /PAGES_TOKEN|workers\.xd\.team|pages_demo@xd\.com/);
});

test('dry-run supports production target and custom slug', () => {
  const envFile = tempEnv('PAGES_V2_DEMO_TARGET=production\nPAGES_V2_DEMO_SLUG=xtq-vue\n');
  const result = run(['--dry-run', '--env-file', envFile]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PAGES_V2_DEMO_TARGET=production/);
  assert.match(result.stdout, /PAGES_V2_API=https:\/\/api\.pages\.xd\.team/);
  assert.match(result.stdout, /PAGES_V2_SITE=https:\/\/xtq-vue\.pages\.xd\.team/);
  assert.match(result.stdout, /xtq-vue\s+spa\s+demos\/vue-app/);
});

test('rejects invalid v2 target and slug values', () => {
  const badTarget = run(['--dry-run', '--env-file', tempEnv(''), '--target', 'preview']);
  assert.notEqual(badTarget.status, 0);
  assert.match(`${badTarget.stderr}${badTarget.stdout}`, /PAGES_V2_DEMO_TARGET must be staging or production/);

  const badSlug = run(['--dry-run', '--env-file', tempEnv('PAGES_V2_DEMO_SLUG=api\n')]);
  assert.notEqual(badSlug.status, 0);
  assert.match(`${badSlug.stderr}${badSlug.stdout}`, /reserved v2 demo slug/);
});

test('script invokes v2 CLI instead of legacy Pages API', () => {
  const script = readFileSync(scriptPath, 'utf8');
  const demoReadme = readFileSync(join(repoRoot, 'demos/README.md'), 'utf8');

  assert.match(script, /apps\/pages-cli\/src\/main\.js/);
  assert.match(script, /--artifact-kind spa/);
  assert.match(script, /PAGES_CLI_ENV="\$PAGES_V2_DEMO_TARGET"/);
  assert.match(script, /deploy dist "\$PAGES_V2_DEMO_SLUG"/);
  assert.doesNotMatch(script, /--slug "\$PAGES_V2_DEMO_SLUG"/);
  assert.doesNotMatch(script, /X-Pages-Token|PAGES_TOKEN|api-staging\.workers\.xd\.team|\/deploy/);

  assert.match(demoReadme, /scripts\/test-pages-v2-demos\.sh/);
  assert.match(demoReadme, /api-staging\.pages\.xd\.team/);
});
