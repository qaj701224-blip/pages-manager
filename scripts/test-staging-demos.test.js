import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { afterEach } from 'node:test';
import { tmpdir } from 'node:os';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = join(repoRoot, 'scripts/test-staging-demos.sh');
const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

function tempEnv(content) {
  const dir = mkdtempSync(join(tmpdir(), 'pages-demo-env-'));
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

test('dry-run uses staging api fixed names and hides token', () => {
  const envFile = tempEnv('PAGES_TOKEN=pages_demo@xd.com\n');
  const result = run(['--dry-run', '--env-file', envFile]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PAGES_DEMO_TARGET=staging/);
  assert.match(result.stdout, /PAGES_API=https:\/\/api-staging\.workers\.xd\.team/);
  assert.match(result.stdout, /demo-html-img\s+static\s+demos\/html-img/);
  assert.match(result.stdout, /demo-vue-app\s+spa\s+demos\/vue-app/);
  assert.match(result.stdout, /demo-nuxt-app\s+spa\s+demos\/nuxt-app/);
  assert.match(result.stdout, /demo-api\s+worker\s+demos\/api-demo/);
  assert.doesNotMatch(result.stdout, /pages_demo@xd\.com/);
  assert.doesNotMatch(result.stderr, /pages_demo@xd\.com/);
});

test('dry-run production target uses production api without non-staging override', () => {
  const envFile = tempEnv('PAGES_TOKEN=pages_demo@xd.com\n');
  const result = run(['--dry-run', '--env-file', envFile, '--target', 'production']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PAGES_DEMO_TARGET=production/);
  assert.match(result.stdout, /PAGES_API=https:\/\/api\.workers\.xd\.team/);
  assert.match(result.stdout, /demo-html-img\s+static\s+demos\/html-img/);
});

test('dry-run supports production target from env file', () => {
  const envFile = tempEnv('PAGES_TOKEN=pages_demo@xd.com\nPAGES_DEMO_TARGET=production\n');
  const result = run(['--dry-run', '--env-file', envFile]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PAGES_DEMO_TARGET=production/);
  assert.match(result.stdout, /PAGES_API=https:\/\/api\.workers\.xd\.team/);
});

test('dry-run supports custom fixed prefix from env file', () => {
  const envFile = tempEnv('PAGES_TOKEN=pages_demo@xd.com\nPAGES_DEMO_PREFIX=xtq-demo\n');
  const result = run(['--dry-run', '--env-file', envFile]);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /xtq-demo-html-img\s+static\s+demos\/html-img/);
  assert.match(result.stdout, /xtq-demo-vue-app\s+spa\s+demos\/vue-app/);
  assert.doesNotMatch(result.stdout, /^demo-html-img\s+static/m);
});

test('dry-run can target one demo', () => {
  const envFile = tempEnv('PAGES_TOKEN=pages_demo@xd.com\n');
  const result = run(['--dry-run', '--env-file', envFile, '--demo', 'vue-app']);

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /demo-vue-app\s+spa\s+demos\/vue-app/);
  assert.doesNotMatch(result.stdout, /demo-html-img/);
  assert.doesNotMatch(result.stdout, /demo-nuxt-app/);
});

test('script requires PAGES_TOKEN from env file or environment', () => {
  const envFile = tempEnv('');
  const result = run(['--dry-run', '--env-file', envFile]);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /PAGES_TOKEN is required/);
});

test('script rejects api values that do not match the selected target', () => {
  const envFile = tempEnv('PAGES_TOKEN=pages_demo@xd.com\nPAGES_API=https://api.workers.xd.team\n');
  const result = run(['--dry-run', '--env-file', envFile]);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /PAGES_API does not match target staging/);
});

test('script rejects unknown target values', () => {
  const envFile = tempEnv('PAGES_TOKEN=pages_demo@xd.com\n');
  const result = run(['--dry-run', '--env-file', envFile, '--target', 'preview']);

  assert.notEqual(result.status, 0);
  assert.match(`${result.stderr}${result.stdout}`, /PAGES_DEMO_TARGET must be staging or production/);
});

test('vue demo is a regular spa without v1 Pages KV SDK usage', () => {
  const home = readFileSync(join(repoRoot, 'demos/vue-app/src/views/Home.vue'), 'utf8');
  const packageJson = JSON.parse(readFileSync(join(repoRoot, 'demos/vue-app/package.json'), 'utf8'));
  const demoReadme = readFileSync(join(repoRoot, 'demos/README.md'), 'utf8');
  const script = readFileSync(scriptPath, 'utf8');

  assert.doesNotMatch(home, /apps\/pages-sdk|createPagesClient|PagesSDKError|Pages KV/);
  assert.equal(packageJson.dependencies['@xd/pages-sdk'], undefined);
  assert.doesNotMatch(demoReadme, /kv=true|Pages KV panel|@xd\/pages-sdk|Pages KV 面板/);
  assert.doesNotMatch(script, /pnpm --filter @xd\/pages-sdk build/);
});
