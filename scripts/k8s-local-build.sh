#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/k8s-local-lib.sh
source "${ROOT}/scripts/k8s-local-lib.sh"
pages_load_env_file "${ROOT}"

TAG="${PAGES_K8S_IMAGE_TAG:-local}"
CLUSTER_NAME="$(pages_k8s_cluster_name)"
CLUSTER_TOOL="$(pages_k8s_cluster_tool)"
LOAD_IMAGES="${PAGES_K8S_LOAD_IMAGES:-auto}"

SERVICES=(
  gateway
  worker
  slack-agent
  slack-notifier
)

for service in "${SERVICES[@]}"; do
  docker build \
    -f "${ROOT}/Dockerfile.node-service" \
    --build-arg "SERVICE=${service}" \
    -t "pages-manager/${service}:${TAG}" \
    "${ROOT}"
done

should_load_images() {
  case "${LOAD_IMAGES}" in
    1|true|yes|on)
      return 0
      ;;
    0|false|no|off)
      return 1
      ;;
    auto)
      pages_cluster_exists "${CLUSTER_NAME}"
      return
      ;;
    *)
      echo "未知 PAGES_K8S_LOAD_IMAGES=${LOAD_IMAGES}" >&2
      return 1
      ;;
  esac
}

if ! should_load_images; then
  echo "Images built. Skipped cluster image load."
  exit 0
fi

case "$(pages_detect_cluster_tool "${CLUSTER_NAME}" "${CLUSTER_TOOL}")" in
  kind)
    for service in "${SERVICES[@]}"; do
      kind load docker-image "pages-manager/${service}:${TAG}" --name "${CLUSTER_NAME}"
    done
    ;;
  k3d)
    for service in "${SERVICES[@]}"; do
      k3d image import "pages-manager/${service}:${TAG}" --cluster "${CLUSTER_NAME}"
    done
    ;;
  none)
    echo "No kind/k3d cluster named ${CLUSTER_NAME}; images were built but not loaded."
    ;;
esac
