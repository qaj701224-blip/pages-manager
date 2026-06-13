#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/k8s-local-lib.sh
source "${ROOT}/scripts/k8s-local-lib.sh"
pages_load_env_file "${ROOT}"

CLUSTER_NAME="$(pages_k8s_cluster_name)"
NAMESPACE="$(pages_k8s_namespace)"
BUILD_IMAGES="${PAGES_K8S_BUILD_IMAGES:-true}"
WAIT_ROLLOUT="${PAGES_K8S_WAIT:-false}"

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl is required" >&2
  exit 1
fi

pages_use_target_context "${CLUSTER_NAME}"

if [ "${BUILD_IMAGES}" = "true" ] || [ "${BUILD_IMAGES}" = "1" ]; then
  "${ROOT}/scripts/k8s-local-build.sh"
fi

kubectl apply -f "${ROOT}/k8s/base/pages-system/namespace.yaml"

apply_secret_if_any() {
  local name="$1"
  shift
  local args=()

  while [ "$#" -gt 0 ]; do
    local key="$1"
    local value="${2:-}"
    shift 2

    if [ -n "${value}" ]; then
      args+=(--from-literal="${key}=${value}")
    fi
  done

  if [ "${#args[@]}" -eq 0 ]; then
    echo "Skipped secret ${name}; no matching environment variables are set."
    return
  fi

  kubectl -n "${NAMESPACE}" create secret generic "${name}" \
    "${args[@]}" \
    --dry-run=client \
    -o yaml | kubectl apply -f -
}

apply_secret_if_any slack-platform-secret \
  slack-bot-token "${SLACK_BOT_TOKEN:-}" \
  slack-app-token "${SLACK_APP_TOKEN:-}" \
  slack-signing-secret "${SLACK_SIGNING_SECRET:-}" \
  slack-app-id "${SLACK_APP_ID:-}" \
  slack-bot-user-id "${SLACK_BOT_USER_ID:-}" \
  slack-connector-shared-secret "${SLACK_CONNECTOR_SHARED_SECRET:-${PAGES_GATEWAY_CONNECTOR_TOKEN:-}}" \
  slack-agent-shared-secret "${SLACK_AGENT_SHARED_SECRET:-}"

apply_secret_if_any model-provider-secret \
  slack-agent-api-key "${SLACK_AGENT_API_KEY:-}" \
  coding-agent-api-key "${AGENT_CODE_API_KEY:-}"

apply_secret_if_any github-platform-secret \
  github-app-installation-token "${GITHUB_APP_INSTALLATION_TOKEN:-}" \
  github-token "${GITHUB_TOKEN:-}" \
  github-webhook-secret "${GITHUB_WEBHOOK_SECRET:-}"

apply_secret_if_any cloudflare-preview-secret \
  pages-preview-token "${PAGES_PREVIEW_TOKEN:-}" \
  pages-token "${PAGES_TOKEN:-}"

apply_secret_if_any callback-secrets \
  internal-callback-token "${INTERNAL_CALLBACK_TOKEN:-${PAGES_CALLBACK_TOKEN:-}}" \
  pages-worker-shared-secret "${PAGES_WORKER_SHARED_SECRET:-}"

kubectl apply -k "${ROOT}/k8s/base/pages-system"

config_patched=false

patch_config_value() {
  local key="$1"
  local value="${2:-}"

  if [ -z "${value}" ]; then
    return
  fi

  local escaped
  escaped="$(printf '%s' "${value}" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  kubectl -n "${NAMESPACE}" patch configmap pages-config \
    --type merge \
    -p "{\"data\":{\"${key}\":\"${escaped}\"}}"
  config_patched=true
}

patch_config_value PAGES_GATEWAY_PUBLIC_URL "${PAGES_GATEWAY_PUBLIC_URL:-}"
patch_config_value PAGES_GATEWAY_CALLBACK_URL "${PAGES_GATEWAY_CALLBACK_URL:-${PAGES_GATEWAY_PUBLIC_URL:+${PAGES_GATEWAY_PUBLIC_URL%/}/internal/executor-callback}}"
patch_config_value GITHUB_REPO "${GITHUB_REPO:-${GITHUB_REPOSITORY:-}}"
patch_config_value GITHUB_ENTERPRISE_API_BASE_URL "${GITHUB_ENTERPRISE_API_BASE_URL:-${GITHUB_API_BASE_URL:-}}"
patch_config_value PAGES_EXECUTOR_MODE "${PAGES_EXECUTOR_MODE:-}"
patch_config_value PAGES_ISSUE_MODE "${PAGES_ISSUE_MODE:-}"
patch_config_value PAGES_SMOKE_ISSUE_SCOPE "${PAGES_SMOKE_ISSUE_SCOPE:-}"
patch_config_value PAGES_PR_MODE "${PAGES_PR_MODE:-}"
patch_config_value PAGES_SMOKE_PR_BRANCH "${PAGES_SMOKE_PR_BRANCH:-}"
patch_config_value PAGES_WORKFLOW_REF "${PAGES_WORKFLOW_REF:-}"
patch_config_value PAGES_BASE_REF "${PAGES_BASE_REF:-${PAGES_PR_BASE_REF:-}}"
patch_config_value PAGES_PREVIEW_MODE "${PAGES_PREVIEW_MODE:-}"
patch_config_value PAGES_PREVIEW_IP_RESTRICT "${PAGES_PREVIEW_IP_RESTRICT:-}"
patch_config_value PAGES_PREVIEW_SITE_NAME_PATTERN "${PAGES_PREVIEW_SITE_NAME_PATTERN:-}"
patch_config_value PAGES_PREVIEW_HOSTNAME_PATTERN "${PAGES_PREVIEW_HOSTNAME_PATTERN:-}"
patch_config_value PAGES_API "${PAGES_API:-}"
patch_config_value GITHUB_REVIEW_AGENT_LOGINS "${GITHUB_REVIEW_AGENT_LOGINS:-}"
patch_config_value AGENT_MODEL_PROVIDER "${AGENT_MODEL_PROVIDER:-${SLACK_AGENT_MODEL_PROVIDER:-}}"
patch_config_value AGENT_MODEL_NAME "${AGENT_MODEL_NAME:-${SLACK_AGENT_MODEL_NAME:-}}"
patch_config_value AGENT_GATEWAY_URL "${AGENT_GATEWAY_URL:-${SLACK_AGENT_GATEWAY_URL:-}}"
patch_config_value SLACK_AGENT_MAX_CONTEXT_MESSAGES "${SLACK_AGENT_MAX_CONTEXT_MESSAGES:-}"
patch_config_value SLACK_AGENT_MAX_OUTPUT_TOKENS "${SLACK_AGENT_MAX_OUTPUT_TOKENS:-}"
patch_config_value SLACK_AGENT_REQUEST_TIMEOUT_SECONDS "${SLACK_AGENT_REQUEST_TIMEOUT_SECONDS:-}"
patch_config_value SLACK_AGENT_ACTIVE_CONTEXT_TTL_HOURS "${SLACK_AGENT_ACTIVE_CONTEXT_TTL_HOURS:-}"
patch_config_value SLACK_AGENT_ACTIVE_CONTEXT_TTL_DAYS "${SLACK_AGENT_ACTIVE_CONTEXT_TTL_DAYS:-}"
patch_config_value SLACK_AGENT_WAITING_CLARIFICATION_TTL_DAYS "${SLACK_AGENT_WAITING_CLARIFICATION_TTL_DAYS:-}"
patch_config_value SLACK_AGENT_RECENT_SESSION_DAYS "${SLACK_AGENT_RECENT_SESSION_DAYS:-}"
patch_config_value SLACK_AGENT_ARCHIVE_AFTER_DAYS "${SLACK_AGENT_ARCHIVE_AFTER_DAYS:-}"
patch_config_value SLACK_AGENT_TURN_TIMEOUT_SECONDS "${SLACK_AGENT_TURN_TIMEOUT_SECONDS:-}"
patch_config_value SLACK_AGENT_SESSION_LEASE_SECONDS "${SLACK_AGENT_SESSION_LEASE_SECONDS:-}"
patch_config_value SLACK_AGENT_PROVIDER_THREAD_TTL_HOURS "${SLACK_AGENT_PROVIDER_THREAD_TTL_HOURS:-}"
patch_config_value CODING_AGENT_RUN_TIMEOUT_MINUTES "${CODING_AGENT_RUN_TIMEOUT_MINUTES:-}"
patch_config_value SLACK_CONNECTOR_DM_POLL_ENABLED "${SLACK_CONNECTOR_DM_POLL_ENABLED:-}"
patch_config_value SLACK_CONNECTOR_DM_POLL_INTERVAL_SECONDS "${SLACK_CONNECTOR_DM_POLL_INTERVAL_SECONDS:-}"
patch_config_value SLACK_CONNECTOR_DM_POLL_CHANNEL_LIMIT "${SLACK_CONNECTOR_DM_POLL_CHANNEL_LIMIT:-}"
patch_config_value SLACK_CONNECTOR_DM_POLL_BATCH_SIZE "${SLACK_CONNECTOR_DM_POLL_BATCH_SIZE:-}"

if [ "${config_patched}" = "true" ]; then
  kubectl -n "${NAMESPACE}" rollout restart \
    deployment/pages-gateway \
    deployment/pages-worker \
    deployment/slack-connector \
    deployment/slack-agent
fi

if [ "${WAIT_ROLLOUT}" = "true" ] || [ "${WAIT_ROLLOUT}" = "1" ]; then
  kubectl -n "${NAMESPACE}" rollout status deployment/pages-gateway
  kubectl -n "${NAMESPACE}" rollout status deployment/pages-worker
  kubectl -n "${NAMESPACE}" rollout status deployment/slack-agent
  kubectl -n "${NAMESPACE}" rollout status deployment/slack-connector
fi

echo "pages-system applied. Use: kubectl -n ${NAMESPACE} get pods"
