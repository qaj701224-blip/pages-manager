#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/k8s-local-lib.sh
source "${ROOT}/scripts/k8s-local-lib.sh"
pages_load_env_file "${ROOT}"

CLUSTER_NAME="$(pages_k8s_cluster_name)"
CLUSTER_TOOL="$(pages_detect_cluster_tool "${CLUSTER_NAME}" "$(pages_k8s_cluster_tool)")"
CONTEXT_NAME="k3d-${CLUSTER_NAME}"
SERVER_CONTAINER="${PAGES_K3D_SERVER_CONTAINER:-k3d-${CLUSTER_NAME}-server-0}"
NAMESPACE="${PAGES_K3D_SECRET_CHECK_NAMESPACE:-pages-persistence-check}"
SECRET_NAME="${PAGES_K3D_SECRET_CHECK_NAME:-test-cred}"
SECRET_KEY="${PAGES_K3D_SECRET_CHECK_KEY:-FOO}"
SECRET_VALUE="${PAGES_K3D_SECRET_CHECK_VALUE:-bar123}"

cleanup() {
  kubectl --context "${CONTEXT_NAME}" delete namespace "${NAMESPACE}" --ignore-not-found >/dev/null 2>&1 || true
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "missing required command: $1" >&2
    exit 1
  }
}

secret_resource_version() {
  kubectl --context "${CONTEXT_NAME}" -n "${NAMESPACE}" get secret "${SECRET_NAME}" \
    -o jsonpath='{.metadata.resourceVersion}'
}

secret_value_hash() {
  local raw
  raw="$(
    kubectl --context "${CONTEXT_NAME}" -n "${NAMESPACE}" get secret "${SECRET_NAME}" \
      -o "go-template={{ index .data \"${SECRET_KEY}\" }}"
  )"
  printf '%s' "${raw}" | openssl base64 -d -A | shasum -a 256 | awk '{print $1}'
}

wait_nodes_ready() {
  local attempt

  for attempt in $(seq 1 60); do
    if kubectl --context "${CONTEXT_NAME}" version >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done

  kubectl --context "${CONTEXT_NAME}" wait --for=condition=Ready node --all --timeout=180s >/dev/null
}

if [ "${CLUSTER_TOOL}" != "k3d" ]; then
  echo "[k3d-secret] this check only supports a k3d cluster; detected ${CLUSTER_TOOL}" >&2
  exit 1
fi

require_cmd kubectl
require_cmd k3d
require_cmd docker
require_cmd openssl
require_cmd shasum

trap cleanup EXIT

pages_use_target_context "${CLUSTER_NAME}" "${CLUSTER_TOOL}"

echo "[k3d-secret] verifying Secret persistence on cluster: ${CLUSTER_NAME}"
kubectl --context "${CONTEXT_NAME}" create namespace "${NAMESPACE}" \
  --dry-run=client -o yaml | kubectl --context "${CONTEXT_NAME}" apply -f - >/dev/null
kubectl --context "${CONTEXT_NAME}" -n "${NAMESPACE}" create secret generic "${SECRET_NAME}" \
  --from-literal="${SECRET_KEY}=${SECRET_VALUE}" \
  --dry-run=client -o yaml | kubectl --context "${CONTEXT_NAME}" apply -f - >/dev/null

rv_initial="$(secret_resource_version)"
hash_initial="$(secret_value_hash)"
echo "[k3d-secret] initial resourceVersion=${rv_initial} hash=${hash_initial}"

echo "[k3d-secret] scenario A: docker restart ${SERVER_CONTAINER}"
docker restart "${SERVER_CONTAINER}" >/dev/null
wait_nodes_ready

rv_after_docker_restart="$(secret_resource_version)"
hash_after_docker_restart="$(secret_value_hash)"
echo "[k3d-secret] after docker restart resourceVersion=${rv_after_docker_restart} hash=${hash_after_docker_restart}"

if [ "${hash_after_docker_restart}" != "${hash_initial}" ]; then
  echo "[k3d-secret] scenario A hash mismatch" >&2
  exit 1
fi

echo "[k3d-secret] scenario B: k3d cluster stop/start ${CLUSTER_NAME}"
k3d cluster stop "${CLUSTER_NAME}" >/dev/null
k3d cluster start "${CLUSTER_NAME}" >/dev/null
wait_nodes_ready

rv_after_cluster_restart="$(secret_resource_version)"
hash_after_cluster_restart="$(secret_value_hash)"
echo "[k3d-secret] after cluster restart resourceVersion=${rv_after_cluster_restart} hash=${hash_after_cluster_restart}"

if [ "${hash_after_cluster_restart}" != "${hash_initial}" ]; then
  echo "[k3d-secret] scenario B hash mismatch" >&2
  exit 1
fi

echo "[k3d-secret] Secret persisted across docker restart and k3d stop/start"
