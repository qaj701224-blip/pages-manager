#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/k8s-local-lib.sh
source "${ROOT}/scripts/k8s-local-lib.sh"
pages_load_env_file "${ROOT}"

CLUSTER_NAME="$(pages_k8s_cluster_name)"
CLUSTER_TOOL="$(pages_detect_cluster_tool "${CLUSTER_NAME}")"
LOCAL_STORAGE_DIR="${PAGES_K3D_STORAGE_DIR:-${XDG_DATA_HOME:-${HOME}/.local/share}/pages-manager/k3d/${CLUSTER_NAME}/storage}"
K3D_API_PORT="${PAGES_K3D_API_PORT:-6551}"
K3D_HTTP_PORT="${PAGES_K3D_HTTP_PORT:-0}"
K3D_HTTPS_PORT="${PAGES_K3D_HTTPS_PORT:-0}"
K3D_APP_PORT="${PAGES_K3D_APP_PORT:-0}"
K3S_IMAGE="${PAGES_K3S_IMAGE:-rancher/k3s:v1.31.6-k3s1}"

if [ "${CLUSTER_TOOL}" = "none" ]; then
  echo "k3d or kind is required" >&2
  exit 1
fi

if pages_cluster_exists "${CLUSTER_NAME}"; then
  pages_use_target_context "${CLUSTER_NAME}" "${CLUSTER_TOOL}"
  echo "Cluster ${CLUSTER_NAME} already exists; context is set to $(kubectl config current-context)."
  exit 0
fi

case "${CLUSTER_TOOL}" in
  k3d)
    mkdir -p "${LOCAL_STORAGE_DIR}"

    create_args=(
      cluster create "${CLUSTER_NAME}"
      --servers 1
      --agents 0
      --wait
      --kubeconfig-update-default
      --kubeconfig-switch-context
      --image "${K3S_IMAGE}"
      --api-port "127.0.0.1:${K3D_API_PORT}"
      --k3s-arg "--disable=traefik@server:0"
      --volume "${LOCAL_STORAGE_DIR}:/var/lib/rancher/k3s/storage@server:0"
    )

    if [ "${K3D_HTTP_PORT}" != "0" ]; then
      create_args+=(--port "${K3D_HTTP_PORT}:80@loadbalancer")
    fi
    if [ "${K3D_HTTPS_PORT}" != "0" ]; then
      create_args+=(--port "${K3D_HTTPS_PORT}:443@loadbalancer")
    fi
    if [ "${K3D_APP_PORT}" != "0" ]; then
      create_args+=(--port "${K3D_APP_PORT}:80@loadbalancer")
    fi

    k3d "${create_args[@]}"
    ;;
  kind)
    kind create cluster --name "${CLUSTER_NAME}"
    ;;
  *)
    echo "Unsupported PAGES_K8S_CLUSTER_TOOL=${CLUSTER_TOOL}" >&2
    exit 1
    ;;
esac

pages_use_target_context "${CLUSTER_NAME}" "${CLUSTER_TOOL}"
kubectl wait --for=condition=Ready nodes --all --timeout=180s
echo "Cluster ${CLUSTER_NAME} is ready; context is set to $(kubectl config current-context)."

default_storage_class="$(kubectl get sc -o jsonpath='{range .items[?(@.metadata.annotations.storageclass\.kubernetes\.io/is-default-class=="true")]}{.metadata.name}{"\n"}{end}' | head -n1 || true)"
echo "Default storage class: ${default_storage_class:-unknown}"

if [ "${CLUSTER_TOOL}" = "k3d" ]; then
  echo "Local path host storage: ${LOCAL_STORAGE_DIR}"
fi
