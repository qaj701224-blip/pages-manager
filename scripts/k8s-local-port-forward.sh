#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/k8s-local-lib.sh
source "${ROOT}/scripts/k8s-local-lib.sh"
pages_load_env_file "${ROOT}"

CLUSTER_NAME="$(pages_k8s_cluster_name)"
NAMESPACE="$(pages_k8s_namespace)"
LOCAL_PORT="${PAGES_K8S_GATEWAY_LOCAL_PORT:-8788}"
RETRY_SECONDS="${PAGES_K8S_PORT_FORWARD_RETRY_SECONDS:-2}"
RUN_ONCE="${PAGES_K8S_PORT_FORWARD_ONCE:-false}"

pages_use_target_context "${CLUSTER_NAME}"

while true; do
  set +e
  kubectl -n "${NAMESPACE}" port-forward "svc/pages-gateway" "${LOCAL_PORT}:8788"
  exit_code="$?"
  set -e

  if [ "${RUN_ONCE}" = "true" ] || [ "${RUN_ONCE}" = "1" ]; then
    exit "${exit_code}"
  fi

  echo "[k8s-port-forward] port-forward exited with ${exit_code}; retrying in ${RETRY_SECONDS}s" >&2
  sleep "${RETRY_SECONDS}"
done
