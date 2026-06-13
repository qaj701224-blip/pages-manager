# pages-manager-preview ACK Overlay

This overlay deploys the `pages-manager` control plane to the shared ACK
preview cluster while keeping employee site previews on Cloudflare.

This is the platform CI/CD path for `pages-manager` itself. It builds and rolls
the long-running control-plane services (`pages-gateway`, `pages-worker`,
`slack-agent`, and `slack-notifier`). Slack Events API requests are received
directly by `pages-gateway`; Slack Web API output is sent by `slack-notifier`.

It is separate from the user-triggered publishing pipeline. User requests are
advanced by `pages-worker` through `project-index.yml`, `pages-agent.yml`, and
`pages-preview.yml` (or by local preview deploy mode); those workflows generate
or preview employee sites and must not build or deploy the platform Pods.

## Isolation Contract

Keep these paths separate:

```text
Platform ACK preview CI/CD:
  .github/workflows/deploy-ack-preview.yml
  k8s/overlays/pages-manager-preview/*
  public/pages-manager/* images
  pages-manager-preview namespace

Platform Cloudflare CI/CD:
  .github/workflows/deploy-staging.yml
  .github/workflows/deploy.yml
  apps/server and apps/kv-gateway Workers

User-site publishing:
  project-index.yml, pages-agent.yml, pages-preview.yml
  sites/<employeeSlug>/<siteSlug>/*
  generated GitHub issues and PRs
```

Generated user-site PRs must stay under one `sites/<employee>/<site>/` root.
They must not touch platform code, GitHub Actions, Kubernetes manifests,
Dockerfiles, deployment secrets, or ACR/ACK configuration. Platform deploy
workflows must not run from generated user-site-only changes.

It intentionally uses its own namespace and image paths:

```text
namespace: pages-manager-preview
images: xdclaw-hub-registry-vpc.cn-shanghai.cr.aliyuncs.com/public/pages-manager/*
host: pages-manager-preview.xdclaw-dev.xindong.com
```

It may reference shared cluster infrastructure that is already owned by the ACK
preview platform, such as `StorageClass/xdclaw-essd-pl1`,
`Secret/acr-credential-secret-aggregation`, and the wildcard TLS secret. This
overlay must only reference those shared resources; it must not modify or
recreate them.

Do not deploy these resources into unrelated platform namespaces,
`xdclaw-system`, `gitlab-runner`, or any `instance-*` namespace.

## Required Platform Resources

Create these outside Git before running the GitHub Actions workflow:

```text
namespace: pages-manager-preview
imagePullSecret: acr-credential-secret-aggregation
TLS secret: xdclaw-xindong-com-wildcard-tls
Ingress class: nginx
StorageClass: xdclaw-essd-pl1
MySQL database reachable from pages-manager-preview Pods
Redis reachable from pages-manager-preview Pods
```

Runtime secrets must be created in `pages-manager-preview`:

```text
slack-platform-secret
github-platform-secret
callback-secrets
model-provider-secret
database-secret
redis-secret
```

These keys are required for the public ACK preview ingress to start safely:

```text
callback-secrets:
  internal-callback-token
  pages-worker-shared-secret

github-platform-secret:
  github-webhook-secret
  github-app-installation-token or github-token

slack-platform-secret:
  slack-signing-secret
  slack-bot-token
  slack-agent-shared-secret
  slack-notifier-shared-secret

model-provider-secret:
  slack-agent-api-key
  slack-agent-gateway-url
  slack-agent-model-name

database-secret:
  database-url

redis-secret:
  redis-url
```

`internal-callback-token` and `github-webhook-secret` protect the public
`/internal/executor-callback` and `/integrations/github/webhook` endpoints.
`slack-signing-secret` protects the public `/integrations/slack/events` and
`/integrations/slack/interactions` endpoints.
`slack-bot-token` lets `slack-notifier` add reactions, post replies, and update
the Slack status card. It should not be injected into `pages-gateway` in the
formal ACK path.
`slack-agent-shared-secret` protects gateway-to-Slack-Agent calls inside the
namespace.
`slack-notifier-shared-secret` protects gateway-to-slack-notifier calls inside
the namespace.
`slack-agent-api-key`, `slack-agent-gateway-url`, and `slack-agent-model-name`
configure the company OpenAI-compatible model gateway used by Slack Agent.
`pages-worker-shared-secret` protects gateway-to-worker dispatch inside the
namespace.
`database-url` enables the gateway MySQL-backed runtime store. Test deployments
do not migrate the old PVC/file store data; losing old test jobs is acceptable.
`redis-url` is injected now for queue/lease parity with the long-term runtime.
`pages-gateway` uses `/health` for process liveness and `/ready` for DB-backed
store readiness; ACK rollout must not pass if MySQL is unreachable.

`cloudflare-preview-secret` is only needed when falling back to a single
service-level preview owner marker. This overlay derives the legacy owner marker
from `PAGES_PREVIEW_TOKEN_PATTERN=pages_{employeeSlug}@xd.com`.

The workflow expects these GitHub Actions secrets:

```text
ALIYUN_ACCESS_KEY_ID
ALIYUN_ACCESS_KEY_SECRET
ACR_INSTANCE_ID
KUBE_CONFIG_B64
```

`ALIYUN_ACCESS_KEY_ID` and `ALIYUN_ACCESS_KEY_SECRET` are RAM AccessKey
credentials. The workflow signs the ACR OpenAPI request with
`scripts/acr-write-docker-config.sh`, exchanges the AccessKey pair for a
temporary ACR registry token, and writes Docker auth without relying on the
Aliyun CLI. The RAM user must be allowed to call `cr:GetAuthorizationToken` and
push images under `public/pages-manager/*`.

The workflow pins its GitHub-hosted runner and deploy client versions:

```text
runner: ubuntu-24.04
kubectl: v1.35.2
pnpm in image build: 9.15.0
Node base image: configured by `NODE_IMAGE` in the ACK preview deploy workflow
```

This differs from xdclaw's GitLab runner setup. `pages-manager` uses GitHub
Actions, GitHub environment secrets, and a `KUBE_CONFIG_B64` secret; do not
reuse xdclaw's `gitlab-runner` namespace, GitLab runner tags, or GitLab CI
variables for this workflow.

For GitHub Actions, prefer a namespace-scoped deployer kubeconfig instead of a
cluster-admin kubeconfig. Apply the optional RBAC once with a bootstrap-capable
kubeconfig:

```bash
kubectl apply -f k8s/overlays/pages-manager-preview/namespace.yaml
kubectl apply -f k8s/ci/ack-preview-deployer-rbac.yaml
```

Then create a bounded ServiceAccount token and encode a kubeconfig for the
`KUBE_CONFIG_B64` GitHub secret:

```bash
export NS=pages-manager-preview
export SA=pages-manager-ack-preview-deployer
export OUT=./pages-manager-ack-preview.kubeconfig

cluster="$(kubectl config view --minify -o jsonpath='{.clusters[0].name}')"
server="$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')"
ca_data="$(kubectl config view --raw --minify -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')"
token="$(kubectl -n "$NS" create token "$SA" --duration=720h)"
ca_file="$(mktemp)"
trap 'rm -f "$ca_file"' EXIT
printf '%s' "$ca_data" | base64 -d > "$ca_file"

kubectl config --kubeconfig "$OUT" set-cluster "$cluster" \
  --server="$server" \
  --certificate-authority="$ca_file" \
  --embed-certs=true
kubectl config --kubeconfig "$OUT" set-credentials "$SA" --token="$token"
kubectl config --kubeconfig "$OUT" set-context "$SA@$cluster" \
  --cluster="$cluster" \
  --user="$SA" \
  --namespace="$NS"
kubectl config --kubeconfig "$OUT" use-context "$SA@$cluster"
base64 < "$OUT" | tr -d '\n'
```

The workflow validates the needed namespace permissions before building and
deploying, including `pods/exec` for the post-rollout health smoke.

## Deploy

Use the manual workflow:

```text
.github/workflows/deploy-ack-preview.yml
```

The workflow is named `Deploy Pages Manager Platform ACK Preview`. It builds and
pushes platform images to the public ACR endpoint, applies this overlay, and
rolls the ACK deployments to the VPC ACR image URLs.

The workflow serializes all ACK preview deploys with a single GitHub Actions
concurrency group. This avoids overlapping manual deploys racing on the shared
ConfigMap, image tags, and Deployment rollout state.

For routine preview updates, choose a single `component` input (`gateway`,
`worker`, `slack-agent`, or `slack-notifier`) to build and roll only that
Deployment. Choose `all` for full platform refreshes. The workflow does not use
ACR registry cache because GitHub-hosted runners have repeatedly timed out on
ACR blob `HEAD` requests in this environment.

Single-component deploys assume the overlay has already been bootstrapped by an
`all` deploy. They server-side validate the rendered overlay but intentionally
skip applying the full overlay, so unselected Deployments are not reset to the
manifest placeholder `:latest` image.

The optional `workflowRef` input changes the runtime workflow ref consumed by
`pages-worker`; the workflow applies it only during `all` or `worker` deploys.
`gateway`, `slack-agent`, and `slack-notifier` component deploys do not mutate
worker runtime configuration.

After rollout, the workflow runs an in-Pod health smoke for every selected
component. This verifies the new container responds on its own `/health`
endpoint before the workflow is marked successful.

The control plane uses `PAGES_PREVIEW_MODE=local_deploy` so `pages-worker`
deploys site previews through `https://api-staging.workers.xd.team`. Preview
sites keep platform IP restriction enabled, and their legacy owner marker is
derived from the job `employeeSlug`. Ensure the ACK egress IP is allowed by the
staging pages-manager API.

For the 2026-06-13 ACK smoke, the staging GitHub environment variable
`IP_ALLOWLIST` was updated to include ACK egress IP `139.224.118.218`, followed
by a manual `Deploy Staging` workflow run for component `server`. Without this,
`pages-worker` can reach the staging API but `/deploy` fails with `IP 未授权`.

`PAGES_WORKFLOW_REF` is set to `staging` because ACK preview runs the latest
platform worker code while user-site publishing workflows are staged through the
`staging` branch. Keep the worker image and workflow input schema aligned before
switching this value to another ref.

## GitHub Webhook

Repository webhook:

```text
repo: xindong/pages-manager
hook id: 640181175
payload URL: https://pages-manager-preview.xdclaw-dev.xindong.com/integrations/github/webhook
content type: application/json
secret source: GITHUB_WEBHOOK_SECRET, stored only in GitHub webhook config and K8s Secret/github-platform-secret
events:
  - issues
  - issue_comment
  - pull_request_review
  - pull_request_review_comment
  - check_run
```

The ACK ingress exposes the webhook path and returns `401` for unsigned POST
requests, which confirms that the route reaches `pages-gateway` and the
signature guard is active. GitHub ping deliveries currently report `failed to
connect to host` before reaching Nginx ingress logs. If this persists, check the
ACK public SLB / security group / network ACL path for GitHub Hookshot IP ranges
or put a globally reachable reverse proxy in front of this ACK endpoint.

Current ACK smoke requires a temporary transparent local reverse proxy until
GitHub can reliably reach the ACK public ingress directly. Keep the concrete
tunnel origin in GitHub config and private operator notes, not in committed
docs.

```text
local proxy: 127.0.0.1:19088
tunnel: <temporary-tunnel-origin>
temporary payload URL: <temporary-tunnel-origin>/integrations/github/webhook
temporary callback URL: <temporary-tunnel-origin>/internal/executor-callback
target ACK URL: https://pages-manager-preview.xdclaw-dev.xindong.com/integrations/github/webhook
target ACK callback URL: https://pages-manager-preview.xdclaw-dev.xindong.com/internal/executor-callback
```

The local proxy is intentionally transparent: it preserves the raw GitHub
request body and signature headers, then lets the ACK gateway perform webhook
signature verification. It also forwards executor callbacks so GitHub Actions can
call ACK while the direct callback URL is being investigated.

Temporary GitHub config for this smoke:

```text
repo webhook payload URL:
  <temporary-tunnel-origin>/integrations/github/webhook

repo variable PAGES_GATEWAY_CALLBACK_URL:
  <temporary-tunnel-origin>/internal/executor-callback

repo variable PAGES_CALLBACK_ALLOWED_ORIGINS includes:
  https://pages-manager-preview.xdclaw-dev.xindong.com
  <temporary-tunnel-origin>

ACK ConfigMap pages-config live patch:
  PAGES_GATEWAY_CALLBACK_URL=<temporary-tunnel-origin>/internal/executor-callback
```

This is the accepted temporary smoke path while ACK SLB connectivity from GitHub
is blocked. Restore the repository webhook payload URL, callback variable, and
live ConfigMap callback URL to the ACK URL only after the SLB path is fixed and a
GitHub ping reaches the ACK ingress logs directly.

## K8s Hardening

The base manifests include conservative runtime hardening:

```text
automountServiceAccountToken: false
seccompProfile: RuntimeDefault
allowPrivilegeEscalation: false
capabilities: drop ALL
resources: requests and limits on every container
revisionHistoryLimit: 3
```

`pages-gateway` is DB-backed in this branch and no longer mounts the old
`pages-gateway-data` PVC. Keep the default rolling Deployment strategy unless a
future storage backend reintroduces a single-writer volume.
