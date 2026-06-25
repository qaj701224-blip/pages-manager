#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/k8s-local-lib.sh
source "${ROOT}/scripts/k8s-local-lib.sh"
pages_load_env_file "${ROOT}"

CLUSTER_NAME="$(pages_k8s_cluster_name)"
NAMESPACE="$(pages_k8s_namespace)"

pages_use_target_context "${CLUSTER_NAME}"

kubectl -n "${NAMESPACE}" get deploy,svc,pods
