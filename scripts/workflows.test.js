import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readWorkflow(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const deployWorkflows = [
  ['production', '.github/workflows/deploy.yml'],
  ['staging', '.github/workflows/deploy-staging.yml'],
];

const pagesV2DeployWorkflows = [
  ['production', '.github/workflows/deploy-pages-v2.yml', 'production'],
  ['staging', '.github/workflows/deploy-pages-v2-staging.yml', 'staging'],
];

const publishingExecutorWorkflows = [
  ['project index', '.github/workflows/project-index.yml'],
  ['pages agent', '.github/workflows/pages-agent.yml'],
  ['pages preview', '.github/workflows/pages-preview.yml'],
];

test('deploy workflows expose component choice for manual deploys', () => {
  for (const [name, path] of deployWorkflows) {
    const workflow = readWorkflow(path);

    assert.match(workflow, /workflow_dispatch:\n(?: {4}.+\n)* {4}inputs:/, `${name} has workflow_dispatch inputs`);
    assert.match(workflow, /component:\n(?: {8}.+\n)* {8}type: choice/, `${name} component is a choice`);
    assert.match(workflow, /default: all/, `${name} defaults to all`);
    assert.match(workflow, /- all/, `${name} supports all deploys`);
    assert.match(workflow, /- server/, `${name} supports server deploys`);
    assert.doesNotMatch(workflow, /- kv-gateway/, `${name} no longer deploys v1 KV gateway`);
  }
});

test('deploy workflows only deploy the v1 server component', () => {
  for (const [name, path] of deployWorkflows) {
    const workflow = readWorkflow(path);
    const serverOnlyIf = String.raw`if: env\.DEPLOY_COMPONENT == 'all' \|\| env\.DEPLOY_COMPONENT == 'server'`;

    assert.match(workflow, /DEPLOY_COMPONENT: .+inputs\.component.+all/, `${name} has component default env`);
    assert.match(workflow, new RegExp(`name: Generate Server Wrangler config\\n {8}${serverOnlyIf}`));
    assert.match(workflow, new RegExp(`name: Validate Server secrets\\n {8}${serverOnlyIf}`));
    assert.match(workflow, new RegExp(`name: Deploy Worker\\n {8}${serverOnlyIf}`));
    assert.match(workflow, /run: pnpm --dir apps\/server run deploy/, `${name} builds SDK before server deploy`);
    assert.doesNotMatch(workflow, /run: pnpm --dir apps\/server deploy\b/, `${name} uses the deploy script explicitly`);
    assert.match(workflow, new RegExp(`name: Inject Worker secrets\\n {8}${serverOnlyIf}`));
    assert.doesNotMatch(workflow, /Generate KV Gateway Wrangler config/);
    assert.doesNotMatch(workflow, /Validate KV Gateway secrets/);
    assert.doesNotMatch(workflow, /Deploy KV Gateway/);
    assert.doesNotMatch(workflow, /Inject KV Gateway secrets/);
    assert.doesNotMatch(workflow, /PAGES_CAP_JWT/);
    assert.doesNotMatch(workflow, /SITE_DATA_KV_NAMESPACE_ID/);
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
  assert.match(staging, /\n {4}paths:/, 'staging deploy is path-scoped to v1 platform files');
  assert.doesNotMatch(staging, /\n {4}paths-ignore:/, 'staging deploy must not run for arbitrary v2 changes');
  assert.match(combined, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(combined, /CF_API_TOKEN: \$\{\{ secrets\.CF_API_TOKEN \}\}/);
  assert.match(combined, /: "\$\{CF_API_TOKEN:\?CF_API_TOKEN is required\}"/);
  assert.match(combined, /printf '%s' "\$CF_API_TOKEN" \| pnpm --dir apps\/server exec wrangler secret put CF_API_TOKEN/);
  assert.doesNotMatch(combined, /RUNTIME_CF_API_TOKEN/);
  assert.doesNotMatch(combined, /CF_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
});

test('PR classification, platform CI, and site check keep platform and site lanes separate', () => {
  const classify = readWorkflow('.github/workflows/pr-classify.yml');
  const compatibilityCi = readWorkflow('.github/workflows/ci.yml');
  const ci = readWorkflow('.github/workflows/pr-platform.yml');
  const staging = readWorkflow('.github/workflows/deploy-staging.yml');
  const siteCheck = readWorkflow('.github/workflows/pr-site.yml');

  assert.match(classify, /^name: PR Classify$/m);
  assert.match(classify, /Required PR gate\. It makes the lane visible and rejects mixed platform\/site PRs\./);
  assert.match(classify, /^\s*workflow_dispatch:/m);
  assert.match(classify, /^\s*pull_request:/m);
  assert.doesNotMatch(classify, /^\s*push:/m);
  assert.ok(classify.includes(
    'Mixed PRs are not supported: split personal site changes and PageManager platform changes into separate PRs.',
  ));
  assert.match(classify, /Site PRs must modify exactly one site root/);
  assert.match(classify, /Site PR must only modify expected site root/);
  assert.match(classify, /echo "lane=site"/);
  assert.match(classify, /echo "lane=platform"/);
  assert.match(classify, /echo "origin=site-agent"/);
  assert.match(classify, /echo "origin=platform-agent"/);
  assert.match(classify, /echo "origin=manual"/);
  assert.match(classify, /base="\$\(git merge-base "\$PR_BASE_SHA" "\$PR_HEAD_SHA"\)"/);

  assert.match(compatibilityCi, /^name: CI$/m);
  assert.match(compatibilityCi, /Compatibility workflow for staging sync during the PR lane split\./);
  assert.match(compatibilityCi, /^\s*workflow_dispatch:/m);
  assert.doesNotMatch(compatibilityCi, /^\s*pull_request:/m);
  assert.doesNotMatch(compatibilityCi, /^\s*push:/m);
  assert.match(compatibilityCi, /name: Detect platform changes/);
  assert.match(compatibilityCi, /Skip platform CI for personal-site-only changes/);
  assert.match(compatibilityCi, /if: steps\.changes\.outputs\.platform_changed == 'true'[\s\S]*pnpm lint/);
  assert.match(compatibilityCi, /if: steps\.changes\.outputs\.platform_changed == 'true'[\s\S]*pnpm test/);

  assert.match(ci, /^name: Platform CI$/m);
  assert.match(ci, /PageManager platform CI\. Personal site PRs are validated by PR Classify and Site Check\./);
  assert.match(ci, /\n {2}pull_request:\n {2}push:/);
  assert.doesNotMatch(ci, /paths-ignore:/);
  assert.match(ci, /name: Detect platform changes/);
  assert.match(ci, /site_changed=false/);
  assert.match(ci, /platform_changed=false/);
  assert.ok(ci.includes(
    'Mixed PRs are not supported: split personal site changes and PageManager platform changes into separate PRs.',
  ));
  assert.match(ci, /elif \[\[ "\$EVENT_NAME" == "push" \]\]; then[\s\S]*platform_changed=true/);
  assert.match(ci, /Skip platform CI for personal-site-only changes/);
  assert.match(ci, /Personal-site-only PR; PR Classify and Site Check own validation\./);
  assert.match(ci, /workflow_dispatch:[\s\S]*baseSha:[\s\S]*headSha:[\s\S]*allowedPath:/);
  assert.match(ci, /EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(ci, /INPUT_BASE_SHA: \$\{\{ inputs\.baseSha \}\}/);
  assert.match(ci, /INPUT_HEAD_SHA: \$\{\{ inputs\.headSha \}\}/);
  assert.match(ci, /INPUT_ALLOWED_PATH: \$\{\{ inputs\.allowedPath \}\}/);
  assert.match(ci, /PUSH_BEFORE_SHA: \$\{\{ github\.event\.before \}\}/);
  assert.match(ci, /PUSH_HEAD_SHA: \$\{\{ github\.sha \}\}/);
  assert.match(ci, /"\$INPUT_ALLOWED_PATH"\/\*/);
  assert.match(ci, /base="\$\(git merge-base "\$PR_BASE_SHA" "\$PR_HEAD_SHA"\)"/);
  assert.match(ci, /if: steps\.changes\.outputs\.platform_changed == 'true'[\s\S]*pnpm lint/);
  assert.match(ci, /if: steps\.changes\.outputs\.platform_changed == 'true'[\s\S]*pnpm test/);
  assert.match(staging, /V1 platform staging deploy only\. V2 app changes must not redeploy/);
  assert.match(staging, /\n {2}push:\n {4}branches: \[staging\]\n {4}paths:/);
  assert.match(staging, /- 'apps\/server\/\*\*'/);
  assert.match(staging, /- 'packages\/ip-guard\/\*\*'/);
  assert.match(staging, /- 'packages\/worker-kit\/\*\*'/);
  assert.match(staging, /- 'scripts\/gen-wrangler\.sh'/);
  assert.doesNotMatch(staging, /paths-ignore:/);
  assert.doesNotMatch(staging, /apps\/pages-api|apps\/pages-auth|apps\/pages-router|apps\/kv-gateway/);

  assert.match(siteCheck, /Personal site PR guard only\. Platform code PRs are validated by PR Classify and Platform CI\./);
  assert.match(siteCheck, /\n {2}pull_request:\n {4}paths:\n {6}- sites\/\*\*/);
  assert.match(siteCheck, /Site Check only accepts personal site PRs\. Split PageManager platform changes into a separate PR:/);
  assert.match(siteCheck, /base="\$\(git merge-base "\$PR_BASE_SHA" "\$PR_HEAD_SHA"\)"/);
  assert.match(siteCheck, /SITE_ROOT=\$site_roots/);
  assert.match(siteCheck, /manifest="\$SITE_ROOT\/site\.json"/);
  assert.match(siteCheck, /Site Check requires \$manifest/);
  assert.match(siteCheck, /while IFS= read -r file/);
  assert.match(siteCheck, /node -e 'JSON\.parse\(require\("fs"\)\.readFileSync/);
  assert.match(siteCheck, /done < <\(find "\$SITE_ROOT"/);
  assert.doesNotMatch(siteCheck, /\bpnpm lint\b|\bpnpm test\b|wrangler|kubectl|docker build|ACR_|KUBE_CONFIG_B64/);
});

test('user-triggered publishing executor workflows stay separate from platform deploys', () => {
  for (const [name, path] of publishingExecutorWorkflows) {
    const workflow = readWorkflow(path);
    const triggers = workflow.match(/^on:\n([\s\S]*?)^permissions:/m)?.[1] || '';

    assert.match(triggers, /^ {2}workflow_dispatch:/m, `${name} is dispatched by pages-worker`);
    assert.doesNotMatch(triggers, /^ {2}(?!workflow_dispatch:)\S/m, `${name} has no push or PR trigger`);
    assert.match(workflow, /publishingJobId:/, `${name} is tied to a PublishingJob`);
    assert.doesNotMatch(workflow, /docker buildx?|kubectl|wrangler|ACR_|KUBE_CONFIG_B64|ALIYUN_ACCESS_KEY|CLOUDFLARE_API_TOKEN/);
  }
});

test('v1 deploy workflows do not inject KV capability secrets', () => {
  for (const [name, path] of deployWorkflows) {
    const workflow = readWorkflow(path);

    assert.doesNotMatch(workflow, /PAGES_CAP_JWT_KEYS/, `${name} has no capability key registry`);
    assert.doesNotMatch(workflow, /PAGES_CAP_JWT_ACTIVE_KID/, `${name} has no active capability kid`);
    assert.doesNotMatch(workflow, /put-capability-secrets\.sh/, `${name} does not inject capability secrets`);
    assert.doesNotMatch(workflow, /apps\/kv-gateway/, `${name} does not deploy the v2-owned gateway`);
  }
});

test('pages v2 deploy workflows keep production manual and staging scoped to v2 files', () => {
  const production = readWorkflow('.github/workflows/deploy-pages-v2.yml');
  const staging = readWorkflow('.github/workflows/deploy-pages-v2-staging.yml');
  const productionTriggers = production.match(/^on:\n([\s\S]*?)^permissions:/m)?.[1] || '';

  assert.match(productionTriggers, /^ {2}workflow_dispatch:/m, 'pages v2 production deploy is manual');
  assert.doesNotMatch(
    productionTriggers,
    /^ {2}(?!workflow_dispatch:)\S/m,
    'pages v2 production has no non-manual trigger',
  );
  assert.match(staging, /\n {2}push:\n {4}branches: \[staging\]/, 'pages v2 staging deploys on staging push');
  assert.match(staging, /- 'apps\/pages-api\/\*\*'/);
  assert.match(staging, /- 'apps\/pages-auth\/\*\*'/);
  assert.match(staging, /- 'apps\/pages-router\/\*\*'/);
  assert.match(staging, /- 'apps\/kv-gateway\/\*\*'/);
  assert.match(staging, /- 'packages\/pages-runtime-protocol\/\*\*'/);
  assert.match(staging, /- 'packages\/wfp-client\/\*\*'/);
  assert.match(staging, /- 'scripts\/provision-pages-v2-slots\.mjs'/);
  assert.doesNotMatch(staging, /sites\/\*\*/);
});

test('pages v2 deploy workflows expose only v2 component choices', () => {
  for (const [name, path] of pagesV2DeployWorkflows) {
    const workflow = readWorkflow(path);

    assert.match(workflow, /workflow_dispatch:\n(?: {4}.+\n)* {4}inputs:/, `${name} has workflow_dispatch inputs`);
    assert.match(workflow, /component:\n(?: {8}.+\n)* {8}type: choice/, `${name} component is a choice`);
    assert.match(workflow, /default: all/, `${name} defaults to all`);
    assert.match(workflow, /- all/, `${name} supports all deploys`);
    assert.match(workflow, /- pages-api/, `${name} supports pages-api deploys`);
    assert.match(workflow, /- pages-auth/, `${name} supports pages-auth deploys`);
    assert.match(workflow, /- pages-router/, `${name} supports pages-router deploys`);
    assert.match(workflow, /- pages-kv-gateway/, `${name} supports pages-kv-gateway deploys`);
    assert.doesNotMatch(workflow, /- server\b|- kv-gateway\b/, `${name} does not expose v1 components`);
  }
});

test('pages v2 deploy workflows use explicit v2 templates and secret injection', () => {
  for (const [name, path, environment] of pagesV2DeployWorkflows) {
    const workflow = readWorkflow(path);

    assert.match(
      workflow,
      new RegExp(`node scripts/render-pages-v2-wrangler\\.mjs apps/pages-api ${environment}`),
      `${name} renders pages-api ${environment} template`,
    );
    assert.match(
      workflow,
      new RegExp(`node scripts/render-pages-v2-wrangler\\.mjs apps/pages-auth ${environment}`),
      `${name} renders pages-auth ${environment} template`,
    );
    assert.match(
      workflow,
      new RegExp(
        String.raw`name: Generate Pages Auth Wrangler config[\s\S]*`
          + String.raw`D1_DATABASE_ID: \$\{\{ vars\.PAGES_V2_D1_DATABASE_ID \}\}[\s\S]*`
          + String.raw`node scripts/render-pages-v2-wrangler\.mjs apps/pages-auth`,
      ),
      `${name} gives pages-auth the shared metadata D1 id`,
    );
    assert.match(
      workflow,
      /name: Apply Pages API D1 migrations\n {8}if: .+pages-auth/,
      `${name} applies D1 migrations for pages-auth deploys`,
    );
    assert.ok(
      workflow.indexOf(`node scripts/render-pages-v2-wrangler.mjs apps/pages-auth ${environment}`) <
        workflow.indexOf('pnpm --dir apps/pages-auth exec wrangler deploy'),
      `${name} renders auth before deploying auth`,
    );
    assert.ok(
      workflow.indexOf(
        `wrangler d1 migrations apply ${
          environment === 'staging' ? 'pages-v2-metadata-staging' : 'pages-v2-metadata'
        } --remote`,
      ) <
        workflow.indexOf('pnpm --dir apps/pages-auth exec wrangler deploy'),
      `${name} applies D1 migrations before deploying auth`,
    );
    assert.ok(
      workflow.indexOf('pnpm --dir apps/pages-auth exec wrangler deploy') <
        workflow.indexOf('pnpm --dir apps/pages-api exec wrangler deploy'),
      `${name} deploys auth before api because api has a PAGES_AUTH service binding`,
    );
    assert.match(workflow, new RegExp(`node scripts/provision-pages-v2-slots\\.mjs ${environment} prepare`));
    assert.match(
      workflow,
      new RegExp(`node scripts/render-pages-v2-wrangler\\.mjs apps/pages-router ${environment}`),
      `${name} renders pages-router ${environment} template after slot provisioning`,
    );
    assert.ok(
      workflow.indexOf(`node scripts/provision-pages-v2-slots.mjs ${environment} prepare`) <
        workflow.indexOf(`node scripts/render-pages-v2-wrangler.mjs apps/pages-router ${environment}`),
      `${name} provisions slots before rendering router bindings`,
    );
    assert.ok(
      workflow.indexOf(`node scripts/render-pages-v2-wrangler.mjs apps/pages-router ${environment}`) <
        workflow.indexOf('pnpm --dir apps/pages-router exec wrangler deploy'),
      `${name} renders router before deploying router`,
    );
    assert.match(workflow, new RegExp(`node scripts/provision-pages-v2-slots\\.mjs ${environment} activate`));
    assert.match(
      workflow,
      new RegExp(`node scripts/render-pages-v2-wrangler\\.mjs apps/kv-gateway ${environment}`),
      `${name} renders kv-gateway ${environment} template`,
    );
    assert.match(workflow, /CLOUDFLARE_ACCOUNT_ID: \$\{\{ vars\.CLOUDFLARE_ACCOUNT_ID \}\}/);
    assert.match(workflow, /D1_DATABASE_ID: \$\{\{ vars\.PAGES_V2_D1_DATABASE_ID \}\}/);
    assert.match(workflow, /ROUTE_SNAPSHOTS_KV_ID: \$\{\{ vars\.PAGES_V2_ROUTE_SNAPSHOTS_KV_ID \}\}/);
    assert.match(workflow, /IP_ALLOWLIST: \$\{\{ vars\.IP_ALLOWLIST \}\}/);
    assert.match(workflow, /SITE_DATA_KV_ID: \$\{\{ vars\.PAGES_V2_SITE_DATA_KV_ID \}\}/);
    assert.doesNotMatch(
      workflow,
      /secrets\.(?:CLOUDFLARE_ACCOUNT_ID|PAGES_V2_D1_DATABASE_ID|PAGES_V2_ROUTE_SNAPSHOTS_KV_ID|PAGES_V2_SITE_DATA_KV_ID)/,
    );
    assert.doesNotMatch(workflow, /PAGES_EXECUTION_MODE: \$\{\{ vars\.PAGES_EXECUTION_MODE \}\}/);
    assert.match(workflow, /provision-pages-v2-slots\.mjs/);
    assert.doesNotMatch(workflow, /PAGES_NORMAL_WORKER_SLOT_COUNT: \$\{\{ vars\.PAGES_NORMAL_WORKER_SLOT_COUNT \}\}/);
    assert.match(workflow, /ACCESS_KEY_ACTIVE_PEPPER_ID: pepper_2026_06/);
    assert.match(workflow, /ACCESS_KEY_PEPPERS: "pepper_2026_06:ACCESS_KEY_PEPPER_202606"/);
    assert.match(workflow, /PAGES_SESSION_JWT_ACTIVE_KID: pages-session-2026-06/);
    assert.match(
      workflow,
      /PAGES_SESSION_JWT_KEYS: "pages-session-2026-06:HS256:PAGES_SESSION_JWT_SECRET_202606"/,
    );
    assert.match(workflow, /PAGES_CAP_JWT_ACTIVE_KID: pages-cap-2026-06/);
    assert.match(workflow, /PAGES_CAP_JWT_KEYS: "pages-cap-2026-06:HS256:PAGES_CAP_JWT_SECRET_202606"/);
    assert.doesNotMatch(workflow, /vars\.(?:ACCESS_KEY|PAGES_SESSION_JWT|PAGES_CAP_JWT)/);
    assert.doesNotMatch(
      workflow,
      new RegExp(
        String.raw`vars\.(?:PAGES_EXECUTION_MODE|PAGES_NORMAL_WORKER_SLOT_COUNT`
          + String.raw`|WFP_COMPATIBILITY_DATE|SSO_AUTHORIZATION_URL|SSO_TOKEN_URL|SSO_PROFILE_URL|SSO_CLIENT_ID`
          + String.raw`|OAUTH_STATE_TTL_SECONDS`
          + String.raw`|CLI_LOGIN_TTL_SECONDS|AUTH_SESSION_IDLE_TTL_SECONDS|AUTH_SESSION_ABSOLUTE_TTL_SECONDS`
          + String.raw`|SITE_SESSION_IDLE_TTL_SECONDS|SITE_SESSION_ABSOLUTE_TTL_SECONDS`
          + String.raw`|ROUTE_CACHE_TTL_SECONDS|SITE_SESSION_FRESHNESS_TTL_SECONDS`
          + String.raw`|INTERNAL_WORKER_JWT_TTL_SECONDS)`,
      ),
    );
    assert.match(workflow, /PAGES_CAP_JWT_SECRET_202606: \$\{\{ secrets\.PAGES_CAP_JWT_SECRET_202606 \}\}/);
    assert.match(workflow, /SLACK_PAGES_ALERT_WEBHOOK_URL: \$\{\{ secrets\.SLACK_PAGES_ALERT_WEBHOOK_URL \}\}/);
    assert.match(workflow, /DRY_RUN=1 scripts\/put-pages-v2-secrets\.sh apps\/pages-api/);
    assert.match(workflow, /DRY_RUN=1 scripts\/put-pages-v2-secrets\.sh apps\/pages-auth/);
    assert.match(workflow, /DRY_RUN=1 scripts\/put-pages-v2-secrets\.sh apps\/pages-router/);
    assert.match(workflow, /DRY_RUN=1 scripts\/put-pages-v2-secrets\.sh apps\/kv-gateway/);
    assert.match(workflow, /scripts\/put-pages-v2-secrets\.sh apps\/pages-api/);
    assert.match(workflow, /scripts\/put-pages-v2-secrets\.sh apps\/pages-auth/);
    assert.match(workflow, /scripts\/put-pages-v2-secrets\.sh apps\/pages-router/);
    assert.match(workflow, /scripts\/put-pages-v2-secrets\.sh apps\/kv-gateway/);
    const d1DatabaseName = environment === 'staging' ? 'pages-v2-metadata-staging' : 'pages-v2-metadata';
    assert.match(workflow, new RegExp(`wrangler d1 migrations apply ${d1DatabaseName} --remote`));
    assert.doesNotMatch(workflow, /wrangler d1 migrations apply .+ --yes/);
    assert.match(workflow, /pnpm --dir apps\/pages-api exec wrangler deploy/);
    assert.match(workflow, /pnpm --dir apps\/pages-auth exec wrangler deploy/);
    assert.match(workflow, /pnpm --dir apps\/pages-router exec wrangler deploy/);
    assert.match(workflow, /pnpm --dir apps\/kv-gateway exec wrangler deploy/);
  }
});

test('pages v2 deploy workflows stay isolated from v1 and non-Cloudflare deploy lanes', () => {
  const combined = pagesV2DeployWorkflows.map(([, path]) => readWorkflow(path)).join('\n');

  assert.doesNotMatch(combined, /scripts\/gen-wrangler\.sh/);
  assert.doesNotMatch(combined, /apps\/server/);
  assert.doesNotMatch(combined, /CF_ZONE_ID_NEW/);
  assert.doesNotMatch(combined, /docker buildx?|kubectl|ACR_|KUBE_CONFIG_B64|ALIYUN_ACCESS_KEY/);
  assert.match(combined, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(combined, /CF_API_TOKEN: \$\{\{ secrets\.CF_API_TOKEN \}\}/);
  assert.match(combined, /SLACK_PAGES_ALERT_WEBHOOK_URL: \$\{\{ secrets\.SLACK_PAGES_ALERT_WEBHOOK_URL \}\}/);
  assert.doesNotMatch(combined, /CF_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.doesNotMatch(combined, /SLACK_PAGES_ALERT_WEBHOOK_URL: \$\{\{ vars\.SLACK_PAGES_ALERT_WEBHOOK_URL \}\}/);
});

test('router slot expansion workflow is manual and only touches router slot resources', () => {
  const workflow = readWorkflow('.github/workflows/expand-pages-router-slots.yml');
  const triggers = workflow.match(/^on:\n([\s\S]*?)^permissions:/m)?.[1] || '';

  assert.match(workflow, /^name: Expand XD Pages Router Slots$/m);
  assert.match(triggers, /^ {2}workflow_dispatch:/m, 'router slot expansion is manual');
  assert.doesNotMatch(triggers, /^ {2}(?!workflow_dispatch:)\S/m, 'router slot expansion has no push or PR trigger');
  assert.match(workflow, /environment:[\s\S]*type: choice[\s\S]*- staging[\s\S]*- production/);
  assert.match(workflow, /operation:[\s\S]*type: choice[\s\S]*- expand[\s\S]*- cleanup/);
  assert.match(workflow, /dry_run:[\s\S]*type: boolean[\s\S]*default: true/);
  assert.match(workflow, /environment: \$\{\{ inputs\.environment \}\}/);
  assert.match(workflow, /concurrency:\n {2}group: pages-router-slots-\$\{\{ inputs\.environment \}\}/);
  assert.match(
    workflow,
    new RegExp(
      String.raw`node --test scripts/provision-pages-v2-slots\.test\.js `
        + String.raw`scripts/render-pages-v2-wrangler\.test\.js apps/pages-router/src/\*\.test\.js`,
    ),
  );
  assert.match(workflow, /node scripts\/provision-pages-v2-slots\.mjs "\$TARGET_ENV" plan/);
  assert.match(workflow, /node scripts\/provision-pages-v2-slots\.mjs "\$TARGET_ENV" cleanup-plan/);
  assert.match(workflow, /node scripts\/provision-pages-v2-slots\.mjs "\$TARGET_ENV" prepare/);
  assert.match(workflow, /node scripts\/provision-pages-v2-slots\.mjs "\$TARGET_ENV" cleanup/);
  assert.match(workflow, /node scripts\/render-pages-v2-wrangler\.mjs apps\/pages-router "\$TARGET_ENV"/);
  assert.match(workflow, /pnpm --dir apps\/pages-router exec wrangler deploy/);
  assert.match(workflow, /scripts\/put-pages-v2-secrets\.sh apps\/pages-router/);
  assert.match(workflow, /node scripts\/provision-pages-v2-slots\.mjs "\$TARGET_ENV" activate/);
  assert.ok(
    workflow.indexOf('node scripts/provision-pages-v2-slots.mjs "$TARGET_ENV" prepare') <
      workflow.indexOf('node scripts/render-pages-v2-wrangler.mjs apps/pages-router "$TARGET_ENV"'),
    'prepare happens before router config rendering',
  );
  assert.ok(
    workflow.indexOf('node scripts/render-pages-v2-wrangler.mjs apps/pages-router "$TARGET_ENV"') <
      workflow.indexOf('pnpm --dir apps/pages-router exec wrangler deploy'),
    'router config renders before deploy',
  );
  assert.ok(
    workflow.indexOf('pnpm --dir apps/pages-router exec wrangler deploy') <
      workflow.indexOf('node scripts/provision-pages-v2-slots.mjs "$TARGET_ENV" activate'),
    'slots activate only after router deploy',
  );
  assert.doesNotMatch(workflow, /pnpm --dir apps\/pages-api exec wrangler deploy/);
  assert.doesNotMatch(workflow, /pnpm --dir apps\/pages-auth exec wrangler deploy/);
  assert.doesNotMatch(workflow, /pnpm --dir apps\/kv-gateway exec wrangler deploy/);
});

test('staging sync explicitly dispatches deploy workflows for deploy-affecting paths', () => {
  const workflow = readWorkflow('.github/workflows/sync-master-pr-to-staging.yml');

  for (const path of [
    'apps/server/*',
    'packages/ip-guard/*',
    'packages/worker-kit/*',
    'scripts/gen-wrangler.sh',
    'package.json',
    'pnpm-lock.yaml',
    '.github/workflows/deploy-staging.yml',
  ]) {
    assert.match(workflow, new RegExp(escapeRegExp(path)), `v1 staging sync watches ${path}`);
  }
  assert.doesNotMatch(workflow, /scripts\/render-server-config\.mjs/, 'v1 staging sync must use the real wrangler script');

  for (const path of [
    'apps/pages-api/*',
    'apps/pages-auth/*',
    'apps/pages-router/*',
    'apps/kv-gateway/*',
    'packages/ip-guard/*',
    'packages/pages-runtime-protocol/*',
    'packages/worker-kit/*',
    'packages/wfp-client/*',
    'scripts/render-pages-v2-wrangler.mjs',
    'scripts/provision-pages-v2-slots.mjs',
    'scripts/put-pages-v2-secrets.sh',
    'package.json',
    'pnpm-lock.yaml',
    '.github/workflows/deploy-pages-v2-staging.yml',
    '.github/workflows/expand-pages-router-slots.yml',
    'docs/README.md',
    'docs/api-boundary.md',
    'docs/pages-v2-wfp-architecture.md',
    'docs/architecture/*',
    'docs/operations/*',
    'docs/security/*',
    'docs/adr/*',
  ]) {
    assert.match(workflow, new RegExp(escapeRegExp(path)), `v2 staging sync watches ${path}`);
  }
  assert.doesNotMatch(workflow, /docs\/人工配置待办\.md/, 'deleted manual config todo must not be watched');
});

test('ack preview deploy is manual and isolated from Cloudflare production deploy', () => {
  const workflow = readWorkflow('.github/workflows/deploy-ack-preview.yml');
  const triggers = workflow.match(/^on:\n([\s\S]*?)^permissions:/m)?.[1] || '';

  assert.match(workflow, /^name: Deploy Pages Manager Platform ACK Preview$/m);
  assert.match(workflow, /Platform CI\/CD only: builds and deploys the pages-manager control plane to ACK/);
  assert.match(workflow, /User-triggered publishing stays on project-index\.yml, pages-agent\.yml, and pages-preview\.yml/);
  assert.match(triggers, /^ {2}workflow_dispatch:/m, 'ACK preview deploy is manually dispatchable');
  assert.match(
    triggers,
    /component:[\s\S]*type: choice[\s\S]*- all[\s\S]*- gateway[\s\S]*- worker[\s\S]*- slack-agent[\s\S]*- slack-notifier/,
  );
  assert.doesNotMatch(triggers, /^ {2}(?!workflow_dispatch:)\S/m, 'ACK preview deploy has no non-manual trigger');
  assert.match(workflow, /concurrency:\n {2}group: pages-manager-ack-preview\n {2}cancel-in-progress: false/);
  assert.match(workflow, /runs-on: ubuntu-24\.04/);
  assert.doesNotMatch(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /KUBE_NAMESPACE: pages-manager-preview/);
  assert.match(workflow, /KUSTOMIZE_OVERLAY: k8s\/overlays\/pages-manager-preview/);
  assert.match(workflow, /ACR_REGISTRY: xdclaw-hub-registry\.cn-shanghai\.cr\.aliyuncs\.com/);
  assert.match(workflow, /ACR_PULL_REGISTRY: xdclaw-hub-registry-vpc\.cn-shanghai\.cr\.aliyuncs\.com/);
  assert.match(workflow, /ACR_REGION: cn-shanghai/);
  assert.match(workflow, /KUBECTL_VERSION: v1\.35\.2/);
  assert.match(workflow, /NODE_IMAGE: node:22-bookworm-slim/);
  assert.match(workflow, /name: Install pinned kubectl/);
  assert.match(workflow, /dl\.k8s\.io\/release\/\$\{KUBECTL_VERSION\}\/bin\/linux\/amd64\/kubectl/);
  assert.match(workflow, /sha256sum --check/);
  assert.match(workflow, /name: Print deployment tool versions/);
  assert.match(workflow, /docker buildx version/);
  assert.match(workflow, /kubectl version --client=true --output=yaml/);
  assert.match(workflow, /docker\/setup-buildx-action@v3/);
  assert.match(workflow, /name: Configure kubeconfig[\s\S]*KUBE_CONFIG_B64/);
  assert.match(
    workflow,
    /name: Validate target namespace access[\s\S]*name: Configure ACR docker auth/,
    'K8s access is validated before ACR auth and image build',
  );
  assert.doesNotMatch(workflow, /aliyun\/setup-aliyun-cli-action/);
  assert.match(workflow, /ALIYUN_ACCESS_KEY_ID/);
  assert.match(workflow, /ALIYUN_ACCESS_KEY_SECRET/);
  assert.match(workflow, /ACR_INSTANCE_ID/);
  assert.match(workflow, /scripts\/acr-write-docker-config\.sh/);
  assert.doesNotMatch(workflow, /aliyun cr GetAuthorizationToken/);
  assert.doesNotMatch(workflow, /--output json/);
  assert.doesNotMatch(workflow, /\.IsSuccess/);
  assert.doesNotMatch(workflow, /docker login/);
  assert.match(workflow, /name: Validate target namespace access/);
  assert.match(workflow, /"create pods\/exec"/);
  assert.match(workflow, /"create configmaps"/);
  assert.match(workflow, /"create serviceaccounts"/);
  assert.match(workflow, /"create ingresses\.networking\.k8s\.io"/);
  assert.match(workflow, /"patch deployments\.apps"/);
  assert.match(workflow, /"patch configmaps"/);
  assert.match(workflow, /DEPLOY_COMPONENT=\$component/);
  assert.match(workflow, /DEPLOY_SERVICES=%s\\n/);
  assert.match(workflow, /case "\$component" in/);
  assert.match(workflow, /services=\(gateway worker slack-agent slack-notifier\)/);
  assert.match(workflow, /gateway\|worker\|slack-agent\|slack-notifier/);
  assert.match(workflow, /docker buildx build/);
  assert.doesNotMatch(workflow, /cache_ref/);
  assert.doesNotMatch(workflow, /--cache-from/);
  assert.doesNotMatch(workflow, /--cache-to/);
  assert.match(workflow, /--build-arg "NODE_IMAGE=\$NODE_IMAGE"/);
  assert.match(workflow, /kubectl kustomize "\$KUSTOMIZE_OVERLAY"/);
  assert.match(workflow, /if \[\[ "\$DEPLOY_COMPONENT" == "all" \]\]; then/);
  assert.match(workflow, /kubectl apply -f "\$rendered"/);
  assert.match(workflow, /kubectl apply --dry-run=server -f "\$rendered"/);
  assert.match(workflow, /validated overlay without applying unselected latest image placeholders/);
  assert.match(workflow, /if \[\[ "\$DEPLOY_COMPONENT" != "all" && "\$DEPLOY_COMPONENT" != "worker" \]\]; then/);
  assert.match(workflow, /Skipping workflow ref patch for \$DEPLOY_COMPONENT deploy/);
  assert.match(workflow, /read -r -a services <<<"\$DEPLOY_SERVICES"/);
  assert.match(workflow, /slack-agent\|slack-notifier/);
  assert.match(workflow, /kubectl -n "\$KUBE_NAMESPACE" set image "deployment\/\$deployment"/);
  assert.match(workflow, /kubectl -n "\$KUBE_NAMESPACE" rollout restart "deployment\/\$deployment"/);
  assert.match(workflow, /kubectl -n "\$KUBE_NAMESPACE" rollout status "deployment\/\$deployment" --timeout=300s/);
  assert.match(workflow, /name: Smoke platform health endpoints/);
  assert.match(workflow, /kubectl -n "\$KUBE_NAMESPACE" exec "deployment\/\$deployment" -c "\$container"/);
  assert.match(workflow, /http:\/\/127\.0\.0\.1:\$\{port\}\/health/);
  assert.match(workflow, /AbortSignal\.timeout\(5000\)/);
  assert.doesNotMatch(workflow, /slack-connector/);
  assert.doesNotMatch(workflow, /CLOUDFLARE_API_TOKEN/);
  assert.doesNotMatch(workflow, /CF_API_TOKEN/);
  assert.doesNotMatch(workflow, /PAGES_PREVIEW_TOKEN/);
});

test('ack preview README documents GitHub Actions kubeconfig generation, not GitLab runner setup', () => {
  const readme = readWorkflow('k8s/overlays/pages-manager-preview/README.md');

  assert.match(readme, /uses GitHub[\s\S]*Actions, GitHub environment secrets, and a `KUBE_CONFIG_B64` secret/);
  assert.match(readme, /do not\s+reuse xdclaw's `gitlab-runner` namespace/);
  assert.match(readme, /ca_file="\$\(mktemp\)"/);
  assert.match(readme, /--certificate-authority="\$ca_file" \\\n\s+--embed-certs=true/);
  assert.doesNotMatch(readme, /--certificate-authority-data/);
  assert.doesNotMatch(readme, /xdclaw-ack-preview/);
});
