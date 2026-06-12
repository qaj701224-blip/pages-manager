import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readWorkflow(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

const deployWorkflows = [
  ['production', '.github/workflows/deploy.yml'],
  ['staging', '.github/workflows/deploy-staging.yml'],
];

test('deploy workflows expose component choice for manual deploys', () => {
  for (const [name, path] of deployWorkflows) {
    const workflow = readWorkflow(path);

    assert.match(workflow, /workflow_dispatch:\n(?: {4}.+\n)* {4}inputs:/, `${name} has workflow_dispatch inputs`);
    assert.match(workflow, /component:\n(?: {8}.+\n)* {8}type: choice/, `${name} component is a choice`);
    assert.match(workflow, /default: all/, `${name} defaults to all`);
    assert.match(workflow, /- all/, `${name} supports all deploys`);
    assert.match(workflow, /- server/, `${name} supports server deploys`);
    assert.match(workflow, /- kv-gateway/, `${name} supports kv-gateway deploys`);
  }
});

test('deploy workflows guard server steps and keep kv-gateway in lockstep with server deploys', () => {
  for (const [name, path] of deployWorkflows) {
    const workflow = readWorkflow(path);

    assert.match(workflow, /DEPLOY_COMPONENT: .+inputs\.component.+all/, `${name} has component default env`);
    assert.match(
      workflow,
      /name: Generate Server Wrangler config\n {8}if: env\.DEPLOY_COMPONENT == 'all' \|\| env\.DEPLOY_COMPONENT == 'server'/,
      `${name} guards server config generation`,
    );
    assert.match(
      workflow,
      /name: Validate Server secrets\n {8}if: env\.DEPLOY_COMPONENT == 'all' \|\| env\.DEPLOY_COMPONENT == 'server'/,
      `${name} guards server secret validation`,
    );
    assert.match(
      workflow,
      /name: Deploy Worker\n {8}if: env\.DEPLOY_COMPONENT == 'all' \|\| env\.DEPLOY_COMPONENT == 'server'/,
      `${name} guards server deployment`,
    );
    assert.match(workflow, /run: pnpm --dir apps\/server deploy/, `${name} builds SDK before server deploy`);
    assert.match(
      workflow,
      /name: Inject Worker secrets\n {8}if: env\.DEPLOY_COMPONENT == 'all' \|\| env\.DEPLOY_COMPONENT == 'server'/,
      `${name} guards server secret injection`,
    );
    assert.match(
      workflow,
      new RegExp(
        "name: Generate KV Gateway Wrangler config\\n {8}if: env\\.DEPLOY_COMPONENT == 'all' " +
          "\\|\\| env\\.DEPLOY_COMPONENT == 'server' \\|\\| env\\.DEPLOY_COMPONENT == 'kv-gateway'",
      ),
      `${name} deploys kv-gateway when server deploys`,
    );
    assert.match(
      workflow,
      new RegExp(
        "name: Validate KV Gateway secrets\\n {8}if: env\\.DEPLOY_COMPONENT == 'all' " +
          "\\|\\| env\\.DEPLOY_COMPONENT == 'server' \\|\\| env\\.DEPLOY_COMPONENT == 'kv-gateway'",
      ),
      `${name} validates kv-gateway secrets when server deploys`,
    );
    assert.match(
      workflow,
      new RegExp(
        "name: Deploy KV Gateway\\n {8}if: env\\.DEPLOY_COMPONENT == 'all' " +
          "\\|\\| env\\.DEPLOY_COMPONENT == 'server' \\|\\| env\\.DEPLOY_COMPONENT == 'kv-gateway'",
      ),
      `${name} deploys kv-gateway when server deploys`,
    );
    assert.match(
      workflow,
      new RegExp(
        "name: Inject KV Gateway secrets\\n {8}if: env\\.DEPLOY_COMPONENT == 'all' " +
          "\\|\\| env\\.DEPLOY_COMPONENT == 'server' \\|\\| env\\.DEPLOY_COMPONENT == 'kv-gateway'",
      ),
      `${name} injects kv-gateway secrets when server deploys`,
    );
  }
});

test('deploy workflows keep production manual and reuse wrangler token for runtime CF secret', () => {
  const production = readWorkflow('.github/workflows/deploy.yml');
  const staging = readWorkflow('.github/workflows/deploy-staging.yml');
  const combined = `${production}\n${staging}`;
  const productionTriggers = production.match(/^on:\n([\s\S]*?)^permissions:/m)?.[1] || '';

  assert.match(productionTriggers, /^ {2}workflow_dispatch:/m, 'production deploy is manually dispatchable');
  assert.doesNotMatch(
    productionTriggers,
    /^ {2}(?!workflow_dispatch:)\S/m,
    'production deploy has no non-manual trigger',
  );
  assert.match(staging, /\n {2}push:\n {4}branches: \[staging\]/, 'staging deploy keeps staging push trigger');
  assert.doesNotMatch(combined, /secrets\.CF_API_TOKEN/, 'no new CF_API_TOKEN GitHub secret is required');
  assert.match(combined, /RUNTIME_CF_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(combined, /secret put CF_API_TOKEN/);
});

test('deploy workflows inject all capability secrets from the key registry', () => {
  for (const [name, path] of deployWorkflows) {
    const workflow = readWorkflow(path);

    assert.match(workflow, /PAGES_CAP_JWT_KEYS: \$\{\{ vars\.PAGES_CAP_JWT_KEYS \}\}/);
    assert.match(workflow, /DRY_RUN=1 scripts\/put-capability-secrets\.sh apps\/server/);
    assert.match(workflow, /DRY_RUN=1 scripts\/put-capability-secrets\.sh apps\/kv-gateway/);
    assert.match(workflow, /scripts\/put-capability-secrets\.sh apps\/server/);
    assert.match(workflow, /scripts\/put-capability-secrets\.sh apps\/kv-gateway/);
    assert.doesNotMatch(
      workflow,
      /secret put PAGES_CAP_JWT_SECRET_202606/,
      `${name} does not hard-code one capability secret injection`,
    );
  }
});
