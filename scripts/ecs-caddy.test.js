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

test('ECS node-service image includes repo question context paths', () => {
  const dockerfile = readRepoFile('Dockerfile.node-service');
  const dockerignore = readRepoFile('.dockerignore');

  for (const path of ['docs', 'scripts', '.github']) {
    assert.match(dockerfile, new RegExp(`COPY ${path.replaceAll('.', '\\.')} `), `copies ${path}`);
    assert.doesNotMatch(dockerignore, new RegExp(`(^|\\n)${path.replaceAll('.', '\\.')}(\\n|$)`), `does not ignore ${path}`);
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
