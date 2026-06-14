#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/k8s-local-lib.sh
source "${ROOT}/scripts/k8s-local-lib.sh"
pages_load_env_file "${ROOT}"

CLUSTER_NAME="$(pages_k8s_cluster_name)"
NAMESPACE="$(pages_k8s_namespace)"
ROLLOUT_TIMEOUT="${PAGES_K8S_SMOKE_ROLLOUT_TIMEOUT:-180s}"
HEALTH_TIMEOUT_SECONDS="${PAGES_K8S_SMOKE_HEALTH_TIMEOUT_SECONDS:-30}"
GATEWAY_LOCAL_PORT="${PAGES_K8S_SMOKE_GATEWAY_PORT:-18788}"
WORKER_LOCAL_PORT="${PAGES_K8S_SMOKE_WORKER_PORT:-18790}"
SLACK_AGENT_LOCAL_PORT="${PAGES_K8S_SMOKE_SLACK_AGENT_PORT:-18791}"
SLACK_NOTIFIER_LOCAL_PORT="${PAGES_K8S_SMOKE_SLACK_NOTIFIER_PORT:-18792}"

PORT_FORWARD_PIDS=()
PORT_FORWARD_LOGS=()

cleanup() {
  local pid
  for pid in "${PORT_FORWARD_PIDS[@]:-}"; do
    if kill -0 "${pid}" >/dev/null 2>&1; then
      kill "${pid}" >/dev/null 2>&1 || true
      wait "${pid}" >/dev/null 2>&1 || true
    fi
  done

  local log_file
  for log_file in "${PORT_FORWARD_LOGS[@]:-}"; do
    rm -f "${log_file}"
  done
}

trap cleanup EXIT

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

log() {
  echo "[k8s-smoke] $*"
}

require_cmd kubectl
require_cmd curl
require_cmd node

pages_use_target_context "${CLUSTER_NAME}"

log "checking namespace ${NAMESPACE}"
kubectl get namespace "${NAMESPACE}" >/dev/null

wait_deployment() {
  local name="$1"

  log "waiting deployment/${name}"
  kubectl -n "${NAMESPACE}" rollout status "deployment/${name}" --timeout="${ROLLOUT_TIMEOUT}"
}

wait_deployment pages-gateway
wait_deployment pages-worker
wait_deployment slack-agent
wait_deployment slack-notifier

secret_key_present() {
  local secret_name="$1"
  local key="$2"

  kubectl -n "${NAMESPACE}" get secret "${secret_name}" -o json 2>/dev/null \
    | node -e '
      const key = process.argv[1];
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        input += chunk;
      });
      process.stdin.on("end", () => {
        const secret = JSON.parse(input);
        process.exit(secret.data && secret.data[key] ? 0 : 1);
      });
    ' "${key}"
}

require_secret_key() {
  local secret_name="$1"
  local key="$2"

  if ! secret_key_present "${secret_name}" "${key}"; then
    echo "[k8s-smoke] missing secret key: ${secret_name}/${key}" >&2
    exit 1
  fi
}

require_any_secret_key() {
  local secret_name="$1"
  shift

  local key
  for key in "$@"; do
    if secret_key_present "${secret_name}" "${key}"; then
      return
    fi
  done

  echo "[k8s-smoke] missing one of secret keys in ${secret_name}: $*" >&2
  exit 1
}

log "checking required secret keys"
require_secret_key slack-platform-secret slack-bot-token
require_secret_key slack-platform-secret slack-signing-secret
require_secret_key slack-platform-secret slack-notifier-shared-secret
require_any_secret_key github-platform-secret github-app-installation-token github-token
require_secret_key callback-secrets internal-callback-token
require_secret_key callback-secrets pages-worker-shared-secret
require_secret_key database-secret mysql-addr
require_secret_key database-secret mysql-user
require_secret_key database-secret mysql-password
require_secret_key database-secret mysql-database
require_secret_key redis-secret redis-url

preview_mode="$(
  kubectl -n "${NAMESPACE}" get configmap pages-config \
    -o 'go-template={{ index .data "PAGES_PREVIEW_MODE" }}' 2>/dev/null || true
)"

if [ "${preview_mode}" = "local_deploy" ]; then
  require_any_secret_key cloudflare-preview-secret pages-preview-token pages-token
fi

config_value() {
  local key="$1"

  kubectl -n "${NAMESPACE}" get configmap pages-config \
    -o "go-template={{ index .data \"${key}\" }}" 2>/dev/null || true
}

require_runtime_config() {
  local key="$1"
  local value

  value="$(config_value "${key}")"
  if [ -z "${value}" ] || is_placeholder_value "${value}"; then
    echo "[k8s-smoke] invalid runtime config: ${key}" >&2
    exit 1
  fi
}

require_runtime_config GITHUB_REPO
require_runtime_config PAGES_WORKFLOW_REF
require_runtime_config PAGES_BASE_REF
require_runtime_config PAGES_GATEWAY_CALLBACK_URL
require_runtime_config PAGES_GATEWAY_PUBLIC_URL

require_runtime_config SLACK_EVENTS_PROCESSING_MODE
require_runtime_config SLACK_SIGNATURE_REQUIRED
require_runtime_config SLACK_SIGNATURE_MAX_SKEW_SECONDS
require_runtime_config SLACK_NOTIFIER_URL

probe_http() {
  local service_name="$1"
  local service_port="$2"
  local local_port="$3"
  local path="$4"
  local log_file
  local pid
  local attempt

  log_file="$(mktemp "${TMPDIR:-/tmp}/pages-k8s-smoke-${service_name}.XXXXXX.log")"
  PORT_FORWARD_LOGS+=("${log_file}")

  kubectl -n "${NAMESPACE}" port-forward "svc/${service_name}" "${local_port}:${service_port}" \
    >"${log_file}" 2>&1 &
  pid="$!"
  PORT_FORWARD_PIDS+=("${pid}")

  for attempt in $(seq 1 "${HEALTH_TIMEOUT_SECONDS}"); do
    if ! kill -0 "${pid}" >/dev/null 2>&1; then
      echo "[k8s-smoke] port-forward for ${service_name} exited early" >&2
      sed -n '1,80p' "${log_file}" >&2
      exit 1
    fi

    if curl -fsS "http://127.0.0.1:${local_port}${path}" >/dev/null 2>&1; then
      log "probe ok: ${service_name}${path}"
      return
    fi

    sleep 1
  done

  echo "[k8s-smoke] probe timed out for ${service_name}${path}" >&2
  sed -n '1,80p' "${log_file}" >&2
  exit 1
}

probe_http pages-gateway 8788 "${GATEWAY_LOCAL_PORT}" /ready
probe_http pages-worker 8790 "${WORKER_LOCAL_PORT}" /health
probe_http slack-agent 8791 "${SLACK_AGENT_LOCAL_PORT}" /health
probe_http slack-notifier 8792 "${SLACK_NOTIFIER_LOCAL_PORT}" /health

log "pods summary"
kubectl -n "${NAMESPACE}" get pods

log "all smoke checks passed"
