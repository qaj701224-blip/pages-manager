#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/k8s-local-lib.sh
source "${ROOT}/scripts/k8s-local-lib.sh"
pages_load_env_file "${ROOT}"

CLUSTER_NAME="$(pages_k8s_cluster_name)"
NAMESPACE="$(pages_k8s_namespace)"
TARGET="${PAGES_K8S_LOG_TARGET:-pages-gateway}"
TAIL="${PAGES_K8S_LOG_TAIL:-200}"
FOLLOW="${PAGES_K8S_LOG_FOLLOW:-false}"

pages_use_target_context "${CLUSTER_NAME}"

args=(-n "${NAMESPACE}" logs "deployment/${TARGET}" "--tail=${TAIL}")

if [ "${FOLLOW}" = "true" ] || [ "${FOLLOW}" = "1" ]; then
  args+=(-f)
fi

kubectl "${args[@]}"
