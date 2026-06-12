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

const capabilityActiveKidEnvPattern =
  String.raw`PAGES_CAP_JWT_ACTIVE_KID: \$\{\{ vars\.PAGES_CAP_JWT_ACTIVE_KID \}\}`;

function workflowStepPattern(stepName, commandPattern) {
  return new RegExp([`name: ${stepName}`, capabilityActiveKidEnvPattern, commandPattern].join(String.raw`[\s\S]*`));
}

const lockstepComponentGuard =
  "env\\.DEPLOY_COMPONENT == 'all' \\|\\| env\\.DEPLOY_COMPONENT == 'server' " +
  "\\|\\| env\\.DEPLOY_COMPONENT == 'kv-gateway'";

function guardedLockstepStepPattern(stepName) {
  return new RegExp(`name: ${stepName}\\n {8}if: ${lockstepComponentGuard}`);
}

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

test('deploy workflows keep server and kv-gateway in lockstep for component deploys', () => {
  for (const [name, path] of deployWorkflows) {
    const workflow = readWorkflow(path);

    assert.match(workflow, /DEPLOY_COMPONENT: .+inputs\.component.+all/, `${name} has component default env`);
    assert.match(
      workflow,
      guardedLockstepStepPattern('Generate Server Wrangler config'),
      `${name} generates server config when gateway deploys`,
    );
    assert.match(
      workflow,
      guardedLockstepStepPattern('Validate Server secrets'),
      `${name} validates server secrets when gateway deploys`,
    );
    assert.match(
      workflow,
      guardedLockstepStepPattern('Deploy Worker'),
      `${name} deploys server when gateway deploys`,
    );
    assert.match(workflow, /run: pnpm --dir apps\/server run deploy/, `${name} builds SDK before server deploy`);
    assert.doesNotMatch(workflow, /run: pnpm --dir apps\/server deploy\b/, `${name} uses the deploy script explicitly`);
    assert.match(
      workflow,
      guardedLockstepStepPattern('Inject Worker secrets'),
      `${name} injects server secrets when gateway deploys`,
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

test('deploy workflows keep production manual and separate wrangler token from runtime CF secret', () => {
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
  assert.match(combined, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(combined, /CF_API_TOKEN: \$\{\{ secrets\.CF_API_TOKEN \}\}/);
  assert.match(combined, /: "\$\{CF_API_TOKEN:\?CF_API_TOKEN is required\}"/);
  assert.match(combined, /printf '%s' "\$CF_API_TOKEN" \| pnpm --dir apps\/server exec wrangler secret put CF_API_TOKEN/);
  assert.doesNotMatch(combined, /RUNTIME_CF_API_TOKEN/);
  assert.doesNotMatch(combined, /CF_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
});

test('deploy workflows inject all capability secrets from the key registry', () => {
  for (const [name, path] of deployWorkflows) {
    const workflow = readWorkflow(path);

    assert.match(workflow, /PAGES_CAP_JWT_KEYS: \$\{\{ vars\.PAGES_CAP_JWT_KEYS \}\}/);
    assert.match(
      workflow,
      workflowStepPattern(
        'Validate Server secrets',
        String.raw`DRY_RUN=1 scripts\/put-capability-secrets\.sh apps\/server`,
      ),
      `${name} validates server active capability kid before deploy`,
    );
    assert.match(
      workflow,
      workflowStepPattern(
        'Validate KV Gateway secrets',
        String.raw`DRY_RUN=1 scripts\/put-capability-secrets\.sh apps\/kv-gateway`,
      ),
      `${name} validates kv-gateway active capability kid before deploy`,
    );
    assert.match(
      workflow,
      workflowStepPattern(
        'Inject KV Gateway secrets',
        String.raw`scripts\/put-capability-secrets\.sh apps\/kv-gateway`,
      ),
      `${name} injects kv-gateway secrets with active capability kid validation`,
    );
    assert.match(
      workflow,
      workflowStepPattern('Inject Worker secrets', String.raw`scripts\/put-capability-secrets\.sh apps\/server`),
      `${name} injects server secrets with active capability kid validation`,
    );
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
