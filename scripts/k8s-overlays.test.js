import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('pages-manager preview overlay derives preview owner markers per employee', () => {
  const configMapPatch = readRepoFile('k8s/overlays/pages-manager-preview/configmap-patch.yaml');
  const baseConfigMap = readRepoFile('k8s/base/pages-system/configmap.yaml');
  const baseGateway = readRepoFile('k8s/base/pages-system/gateway.yaml');

  assert.match(configMapPatch, /PAGES_PREVIEW_MODE: local_deploy/);
  assert.match(baseConfigMap, /PAGES_PLATFORM_WORKFLOW_REF: master/);
  assert.match(baseConfigMap, /PAGES_PLATFORM_BASE_REF: master/);
  assert.match(baseConfigMap, /PAGES_PLATFORM_GATE_APPROVERS: ''/);
  assert.match(baseConfigMap, /PAGES_PLATFORM_GATE_APPROVER_IDS: ''/);
  assert.match(baseGateway, /envFrom:[\s\S]*configMapRef:[\s\S]*name: pages-config/);
  assert.match(configMapPatch, /PAGES_PLATFORM_WORKFLOW_REF: master/);
  assert.match(configMapPatch, /PAGES_PLATFORM_BASE_REF: master/);
  assert.match(configMapPatch, /PAGES_PREVIEW_IP_RESTRICT: 'true'/);
  assert.match(configMapPatch, /PAGES_PREVIEW_SITE_NAME_PATTERN: pm-\{publishingJobId\}/);
  assert.match(configMapPatch, /PAGES_PREVIEW_TOKEN_PATTERN: pages_\{employeeSlug\}@xd\.com/);
  assert.doesNotMatch(configMapPatch, /PAGES_PREVIEW_TOKEN:/);
});

test('pages-manager preview overlay keeps namespace bootstrap separate from deploy apply', () => {
  const kustomization = readRepoFile('k8s/overlays/pages-manager-preview/kustomization.yaml');
  const namespace = readRepoFile('k8s/overlays/pages-manager-preview/namespace.yaml');

  assert.match(kustomization, /namespace: pages-manager-preview/);
  assert.match(kustomization, /resources:\n\s+- \.\.\/\.\.\/base\/pages-system/);
  assert.doesNotMatch(kustomization, /- namespace\.yaml/);
  assert.doesNotMatch(kustomization, /namespace-delete/);
  assert.doesNotMatch(kustomization, /pvc-patch/);
  assert.match(namespace, /name: pages-manager-preview/);
  assert.match(namespace, /pages\.xd\.team\/environment: ack-preview/);
});

test('pages-manager preview ingress only exposes required public callbacks and webhooks', () => {
  const ingress = readRepoFile('k8s/overlays/pages-manager-preview/ingress.yaml');

  assert.match(ingress, /path: \/internal\/executor-callback\n\s+pathType: Exact/);
  assert.match(ingress, /path: \/integrations\/github\/webhook\n\s+pathType: Exact/);
  assert.match(ingress, /path: \/integrations\/slack\/events\n\s+pathType: Exact/);
  assert.match(ingress, /path: \/integrations\/slack\/interactions\n\s+pathType: Exact/);
  assert.doesNotMatch(ingress, /path: \/\n\s+pathType: Prefix/);
});

test('pages-manager preview overlay requires public callback and webhook auth secrets', () => {
  const deploymentPatch = readRepoFile('k8s/overlays/pages-manager-preview/deployment-patch.yaml');
  const readme = readRepoFile('k8s/overlays/pages-manager-preview/README.md');
  const baseGateway = readRepoFile('k8s/base/pages-system/gateway.yaml');
  const baseKustomization = readRepoFile('k8s/base/pages-system/kustomization.yaml');
  const gatewayPatch = deploymentPatch.match(/name: pages-gateway[\s\S]*?^---$/m)?.[0] || '';
  const notifierPatch = deploymentPatch.match(/name: slack-notifier[\s\S]*/)?.[0] || '';

  assert.match(
    deploymentPatch,
    /name: INTERNAL_CALLBACK_TOKEN[\s\S]*?key: internal-callback-token[\s\S]*?optional: false/
  );
  assert.match(
    deploymentPatch,
    /name: PAGES_WORKER_SHARED_SECRET[\s\S]*?key: pages-worker-shared-secret[\s\S]*?optional: false/
  );
  assert.match(deploymentPatch, /name: GITHUB_WEBHOOK_SECRET[\s\S]*?key: github-webhook-secret[\s\S]*?optional: false/);
  assert.match(deploymentPatch, /name: SLACK_SIGNING_SECRET[\s\S]*?key: slack-signing-secret[\s\S]*?optional: false/);
  assert.match(deploymentPatch, /name: SLACK_BOT_TOKEN[\s\S]*?key: slack-bot-token[\s\S]*?optional: false/);
  assert.match(
    deploymentPatch,
    /name: SLACK_NOTIFIER_SHARED_SECRET[\s\S]*?key: slack-notifier-shared-secret[\s\S]*?optional: false/
  );
  assert.doesNotMatch(gatewayPatch, /name: SLACK_BOT_TOKEN/);
  assert.match(notifierPatch, /name: SLACK_BOT_TOKEN[\s\S]*?key: slack-bot-token[\s\S]*?optional: false/);
  assert.match(
    deploymentPatch,
    /name: SLACK_AGENT_SHARED_SECRET[\s\S]*?key: slack-agent-shared-secret[\s\S]*?optional: false/
  );
  assert.match(deploymentPatch, /name: SLACK_AGENT_API_KEY[\s\S]*?key: slack-agent-api-key[\s\S]*?optional: false/);
  assert.match(deploymentPatch, /name: AGENT_GATEWAY_URL[\s\S]*?key: slack-agent-gateway-url[\s\S]*?optional: false/);
  assert.match(deploymentPatch, /name: AGENT_MODEL_NAME[\s\S]*?key: slack-agent-model-name[\s\S]*?optional: false/);
  assert.match(deploymentPatch, /name: MYSQL_ADDR[\s\S]*?name: database-secret[\s\S]*?key: mysql-addr[\s\S]*?optional: false/);
  assert.match(deploymentPatch, /name: MYSQL_USER[\s\S]*?name: database-secret[\s\S]*?key: mysql-user[\s\S]*?optional: false/);
  assert.match(
    deploymentPatch,
    /name: MYSQL_PASSWORD[\s\S]*?name: database-secret[\s\S]*?key: mysql-password[\s\S]*?optional: false/
  );
  assert.match(
    deploymentPatch,
    /name: MYSQL_DATABASE[\s\S]*?name: database-secret[\s\S]*?key: mysql-database[\s\S]*?optional: false/
  );
  assert.match(deploymentPatch, /name: REDIS_URL[\s\S]*?name: redis-secret[\s\S]*?key: redis-url[\s\S]*?optional: false/);

  assert.match(readme, /callback-secrets:[\s\S]*internal-callback-token[\s\S]*pages-worker-shared-secret/);
  assert.match(readme, /github-platform-secret:[\s\S]*github-webhook-secret/);
  assert.match(readme, /github-app-installation-token or github-token/);
  assert.match(
    readme,
    new RegExp(
      [
        'slack-platform-secret:',
        'slack-signing-secret',
        'slack-bot-token',
        'slack-agent-shared-secret',
        'slack-notifier-shared-secret',
      ].join('[\\s\\S]*')
    )
  );
  assert.match(readme, /model-provider-secret:[\s\S]*slack-agent-api-key[\s\S]*slack-agent-gateway-url/);
  assert.match(readme, /database-secret:[\s\S]*mysql-addr[\s\S]*mysql-user[\s\S]*mysql-password[\s\S]*mysql-database/);
  assert.match(readme, /redis-secret:[\s\S]*redis-url/);
  assert.doesNotMatch(baseGateway, /PAGES_GATEWAY_STORE_FILE|pages-gateway-data|mountPath: \/data/);
  assert.match(baseGateway, /readinessProbe:[\s\S]*path: \/ready/);
  assert.doesNotMatch(baseKustomization, /gateway-pvc\.yaml/);
});

test('local K8s bootstrap writes gateway API token into callback secrets', () => {
  const script = readRepoFile('scripts/k8s-local-up.sh');

  assert.match(script, /apply_secret_if_any callback-secrets[\s\S]*pages-gateway-api-token/);
  assert.match(script, /pages-gateway-api-token "\$\{PAGES_GATEWAY_API_TOKEN:-\$\{PAGES_INTERNAL_API_TOKEN:-\}\}"/);
});

test('local K8s env check requires Slack Agent config when turn endpoint is enabled', () => {
  const script = readRepoFile('scripts/k8s-local-check-env.sh');

  assert.match(script, /if ! is_placeholder_value "\$\{SLACK_AGENT_TURN_URL:-\}"; then/);
  assert.match(script, /require_var SLACK_AGENT_SHARED_SECRET/);
  assert.match(script, /if \[ "\$\{AGENT_MODEL_PROVIDER:-company-agent\}" != "deterministic" \]; then/);
  assert.match(script, /require_var AGENT_GATEWAY_URL/);
  assert.match(script, /require_var SLACK_AGENT_API_KEY/);
});

test('pages-system workloads declare runtime resource and security guardrails', () => {
  const workloadFiles = [
    'k8s/base/pages-system/gateway.yaml',
    'k8s/base/pages-system/worker.yaml',
    'k8s/base/pages-system/slack-agent.yaml',
    'k8s/base/pages-system/slack-notifier.yaml',
  ];

  for (const file of workloadFiles) {
    const manifest = readRepoFile(file);
    assert.match(manifest, /revisionHistoryLimit: 3/, `${file} keeps rollout history bounded`);
    assert.match(manifest, /automountServiceAccountToken: false/, `${file} does not mount unused K8s tokens`);
    assert.match(manifest, /seccompProfile:\n\s+type: RuntimeDefault/, `${file} uses the runtime default seccomp profile`);
    assert.match(manifest, /allowPrivilegeEscalation: false/, `${file} disables privilege escalation`);
    assert.match(manifest, /capabilities:\n\s+drop:\n\s+- ALL/, `${file} drops Linux capabilities`);
    assert.match(manifest, /resources:\n\s+requests:\n\s+cpu: 100m\n\s+memory: 256Mi/, `${file} declares requests`);
    assert.match(manifest, /limits:\n\s+cpu: '1'\n\s+memory: 512Mi/, `${file} declares limits`);
  }

  const gateway = readRepoFile('k8s/base/pages-system/gateway.yaml');
  assert.doesNotMatch(gateway, /strategy:\n\s+type: Recreate/, 'DB-backed gateway keeps rolling rollout semantics');
});

test('ACK preview deployer RBAC is namespace scoped and excludes secret access', () => {
  const rbac = readRepoFile('k8s/ci/ack-preview-deployer-rbac.yaml');

  assert.match(rbac, /kind: ServiceAccount[\s\S]*name: pages-manager-ack-preview-deployer/);
  assert.match(rbac, /kind: Role[\s\S]*namespace: pages-manager-preview/);
  assert.match(rbac, /kind: RoleBinding[\s\S]*namespace: pages-manager-preview/);
  assert.match(rbac, /resources:\n\s+- pods\/exec\n\s+verbs: \[create\]/);
  assert.match(rbac, /resources:\n\s+- deployments\n\s+verbs: \[get, list, watch, create, patch, update\]/);
  assert.doesNotMatch(rbac, /ClusterRole|ClusterRoleBinding|cluster-admin/);
  assert.doesNotMatch(rbac, /resources:[\s\S]*- secrets/);
});
