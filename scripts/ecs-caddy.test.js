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

test('ECS compose defaults to production runtime database name', () => {
  const compose = readRepoFile('docker-compose.ecs.yml');
  const envExample = readRepoFile('.env.ecs.example');

  assert.match(compose, /MYSQL_DATABASE: \$\{MYSQL_DATABASE:-pages_manager\}/);
  assert.match(envExample, /^MYSQL_DATABASE=pages_manager$/m);
  assert.doesNotMatch(compose, /pages_manager_preview/);
  assert.doesNotMatch(envExample, /pages_manager_preview/);
});

test('ECS gateway exposes check allowlists for review gate webhooks', () => {
  const compose = readRepoFile('docker-compose.ecs.yml');
  const envExample = readRepoFile('.env.ecs.example');

  for (const name of [
    'GITHUB_SITE_CHECK_NAMES',
    'GITHUB_SITE_CHECK_APP_LOGINS',
    'GITHUB_PLATFORM_CI_CHECK_NAMES',
    'GITHUB_PLATFORM_CI_APP_LOGINS',
  ]) {
    assert.match(compose, new RegExp(`${name}: \\$\\{${name}:-\\}`), `compose forwards ${name}`);
    assert.match(envExample, new RegExp(`^${name}=`, 'm'), `.env.ecs.example documents ${name}`);
  }
});

test('ECS gateway container healthcheck uses liveness while deploy script waits for readiness', () => {
  const compose = readRepoFile('docker-compose.ecs.yml');
  const deployScript = readRepoFile('scripts/deploy-ecs.sh');

  assert.match(compose, /pages-gateway:[\s\S]*127\.0\.0\.1:8788\/health/);
  assert.doesNotMatch(compose, /pages-gateway:[\s\S]*127\.0\.0\.1:8788\/ready[\s\S]*pages-worker:/);
  assert.match(
    deployScript,
    /smoke_service_health pages-gateway "gateway ready" "http:\/\/127\.0\.0\.1:8788\/ready"/
  );
  assert.match(deployScript, /if contains_service gateway "\$\{smoke_targets\[@\]\}" && ! smoke_gateway_frontdoor; then/);
});

test('ECS local preview stays IP restricted unless explicitly disabled', () => {
  const compose = readRepoFile('docker-compose.ecs.yml');
  const envExample = readRepoFile('.env.ecs.example');

  assert.match(compose, /PAGES_PREVIEW_IP_RESTRICT: \$\{PAGES_PREVIEW_IP_RESTRICT:-true\}/);
  assert.match(envExample, /^PAGES_PREVIEW_IP_RESTRICT=true$/m);
});
