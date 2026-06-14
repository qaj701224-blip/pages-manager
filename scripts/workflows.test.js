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

const publishingExecutorWorkflows = [
  ['project index', '.github/workflows/project-index.yml'],
  ['pages agent', '.github/workflows/pages-agent.yml'],
  ['pages preview', '.github/workflows/pages-preview.yml'],
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
  assert.match(staging, /\n {4}paths-ignore:\n {6}- 'sites\/\*\*'/, 'staging deploy ignores user-site only changes');
  assert.match(combined, /CLOUDFLARE_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
  assert.match(combined, /CF_API_TOKEN: \$\{\{ secrets\.CF_API_TOKEN \}\}/);
  assert.match(combined, /: "\$\{CF_API_TOKEN:\?CF_API_TOKEN is required\}"/);
  assert.match(combined, /printf '%s' "\$CF_API_TOKEN" \| pnpm --dir apps\/server exec wrangler secret put CF_API_TOKEN/);
  assert.doesNotMatch(combined, /RUNTIME_CF_API_TOKEN/);
  assert.doesNotMatch(combined, /CF_API_TOKEN: \$\{\{ secrets\.CLOUDFLARE_API_TOKEN \}\}/);
});

test('platform CI and staging deploy ignore generated user-site only changes', () => {
  const ci = readWorkflow('.github/workflows/ci.yml');
  const staging = readWorkflow('.github/workflows/deploy-staging.yml');
  const siteCheck = readWorkflow('.github/workflows/site-check.yml');

  assert.match(ci, /Platform CI only\. Generated user-site PRs under sites\/\*\* are validated by Site Check\./);
  assert.match(ci, /\n {2}pull_request:\n {2}push:/);
  assert.match(ci, /\n {2}push:\n {4}branches: \[master\]\n {4}paths-ignore:\n {6}- 'sites\/\*\*'/);
  assert.match(ci, /name: Detect platform changes/);
  assert.match(ci, /platform_changed=false/);
  assert.match(ci, /Skip platform CI for user-site-only changes/);
  assert.match(ci, /User-site-only PR; Site Check owns validation\./);
  assert.match(ci, /if: steps\.changes\.outputs\.platform_changed == 'true'[\s\S]*pnpm lint/);
  assert.match(ci, /if: steps\.changes\.outputs\.platform_changed == 'true'[\s\S]*pnpm test/);
  assert.match(staging, /Platform staging deploy only\. User-site changes under sites\/\*\* must not redeploy/);
  assert.match(staging, /\n {2}push:\n {4}branches: \[staging\]\n {4}paths-ignore:\n {6}- 'sites\/\*\*'/);

  assert.match(siteCheck, /User-site PR guard only\. Platform code PRs are validated by CI\./);
  assert.match(siteCheck, /\n {2}pull_request:\n {4}paths:\n {6}- sites\/\*\*/);
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
