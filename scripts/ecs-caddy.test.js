import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('ECS Caddy routes public callbacks with and without public path prefix', () => {
  const caddyfile = readRepoFile('deploy/ecs/Caddyfile');

  for (const route of [
    '/integrations/slack/events',
    '/integrations/slack/interactions',
    '/integrations/github/webhook',
    '/internal/executor-callback',
  ]) {
    assert.match(caddyfile, new RegExp(route.replaceAll('/', '\\/')), `routes ${route}`);
    assert.match(
      caddyfile,
      new RegExp(`\\{\\$PUBLIC_PATH_PREFIX\\}${route.replaceAll('/', '\\/')}`),
      `routes prefixed ${route}`
    );
  }

  assert.match(caddyfile, /uri strip_prefix \{\$PUBLIC_PATH_PREFIX\}/);
  assert.match(caddyfile, /reverse_proxy pages-gateway:8788/);
});

test('ECS Caddy routes health checks with and without public path prefix', () => {
  const caddyfile = readRepoFile('deploy/ecs/Caddyfile');

  for (const route of ['/health', '/ready']) {
    assert.match(caddyfile, new RegExp(`handle ${route.replaceAll('/', '\\/')}`), `routes ${route}`);
    assert.match(
      caddyfile,
      new RegExp(`\\{\\$PUBLIC_PATH_PREFIX\\}${route.replaceAll('/', '\\/')}`),
      `routes prefixed ${route}`
    );
  }
});

test('ECS node-service image includes repo question context paths', () => {
  const dockerfile = readRepoFile('Dockerfile.node-service');
  const dockerignore = readRepoFile('.dockerignore');

  for (const path of ['docs', 'scripts', '.github']) {
    assert.match(dockerfile, new RegExp(`COPY ${path.replaceAll('.', '\\.')} `), `copies ${path}`);
    assert.doesNotMatch(dockerignore, new RegExp(`(^|\\n)${path.replaceAll('.', '\\.')}(\\n|$)`), `does not ignore ${path}`);
  }
});

test('ECS Docker context excludes local secrets and runtime config', () => {
  const dockerignoreLines = readRepoFile('.dockerignore').split(/\r?\n/);

  for (const pattern of ['.dev.vars', '**/.dev.vars', '**/.pages.json', '**/wrangler.toml', '.staging.env']) {
    assert.ok(dockerignoreLines.includes(pattern), `ignores ${pattern}`);
  }
});

test('ECS gateway scans the full repo snapshot for Slack repo questions', () => {
  const compose = readRepoFile('docker-compose.ecs.yml');
  const envExample = readRepoFile('.env.ecs.example');

  assert.match(compose, /pages-gateway:[\s\S]*PAGES_REPO_ROOT: \$\{PAGES_REPO_ROOT:-\/app\}/);
  assert.match(envExample, /^PAGES_REPO_ROOT=\/app$/m);
});

test('ECS worker exposes platform workflow and base refs separately', () => {
  const compose = readRepoFile('docker-compose.ecs.yml');
  const envExample = readRepoFile('.env.ecs.example');

  assert.match(compose, /PAGES_WORKFLOW_REF: \$\{PAGES_WORKFLOW_REF:-staging\}/);
  assert.match(compose, /PAGES_BASE_REF: \$\{PAGES_BASE_REF:-staging\}/);
  assert.match(compose, /PAGES_PLATFORM_WORKFLOW_REF: \$\{PAGES_PLATFORM_WORKFLOW_REF:-master\}/);
  assert.match(compose, /PAGES_PLATFORM_BASE_REF: \$\{PAGES_PLATFORM_BASE_REF:-master\}/);
  assert.match(envExample, /^PAGES_WORKFLOW_REF=staging$/m);
  assert.match(envExample, /^PAGES_BASE_REF=staging$/m);
  assert.match(envExample, /^PAGES_PLATFORM_WORKFLOW_REF=master$/m);
  assert.match(envExample, /^PAGES_PLATFORM_BASE_REF=master$/m);
});

test('ECS gateway exposes platform gate approver allowlist', () => {
  const compose = readRepoFile('docker-compose.ecs.yml');
  const envExample = readRepoFile('.env.ecs.example');

  assert.match(compose, /PAGES_PLATFORM_GATE_APPROVERS: \$\{PAGES_PLATFORM_GATE_APPROVERS:-\}/);
  assert.match(compose, /PAGES_PLATFORM_GATE_APPROVER_IDS: \$\{PAGES_PLATFORM_GATE_APPROVER_IDS:-\}/);
  assert.match(envExample, /^PAGES_PLATFORM_GATE_APPROVERS=$/m);
  assert.match(envExample, /^PAGES_PLATFORM_GATE_APPROVER_IDS=$/m);
});

test('ECS local preview stays IP restricted unless explicitly disabled', () => {
  const compose = readRepoFile('docker-compose.ecs.yml');
  const envExample = readRepoFile('.env.ecs.example');

  assert.match(compose, /PAGES_PREVIEW_IP_RESTRICT: \$\{PAGES_PREVIEW_IP_RESTRICT:-true\}/);
  assert.match(envExample, /^PAGES_PREVIEW_IP_RESTRICT=true$/m);
});
