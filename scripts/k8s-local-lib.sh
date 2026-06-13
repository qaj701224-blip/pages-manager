#!/usr/bin/env bash

pages_load_env_file() {
  local root="$1"
  local env_file="${PAGES_LOCAL_ENV_FILE:-${root}/.env}"

  if [ -f "${env_file}" ]; then
    set -a
    # shellcheck disable=SC1090
    source "${env_file}"
    set +a
  fi
}

pages_k8s_cluster_name() {
  printf '%s\n' "${PAGES_K8S_CLUSTER_NAME:-pages-manager}"
}

pages_k8s_namespace() {
  printf '%s\n' "${PAGES_K8S_NAMESPACE:-pages-system}"
}

pages_k8s_cluster_tool() {
  printf '%s\n' "${PAGES_K8S_CLUSTER_TOOL:-auto}"
}

is_placeholder_value() {
  local value="$1"

  case "${value}" in
    ""|replace-me|changeme|CHANGE_ME|example|example-*|*-example|pages_yourname@xd.com|*'...'*) return 0 ;;
    *replace-me*|*yourname*|*example.com*) return 0 ;;
    *) return 1 ;;
  esac
}

pages_cluster_exists() {
  local cluster_name="$1"
  local tool="${2:-auto}"

  case "${tool}" in
    k3d)
      command -v k3d >/dev/null 2>&1 && k3d cluster list "${cluster_name}" >/dev/null 2>&1
      ;;
    kind)
      command -v kind >/dev/null 2>&1 && kind get clusters 2>/dev/null | grep -Fxq "${cluster_name}"
      ;;
    auto|"")
      pages_cluster_exists "${cluster_name}" k3d || pages_cluster_exists "${cluster_name}" kind
      ;;
    *)
      return 1
      ;;
  esac
}

pages_detect_cluster_tool() {
  local cluster_name="$1"
  local preferred="${2:-auto}"

  case "${preferred}" in
    k3d|kind)
      printf '%s\n' "${preferred}"
      return
      ;;
    auto|"")
      if pages_cluster_exists "${cluster_name}" k3d; then
        printf '%s\n' k3d
      elif pages_cluster_exists "${cluster_name}" kind; then
        printf '%s\n' kind
      elif command -v k3d >/dev/null 2>&1; then
        printf '%s\n' k3d
      elif command -v kind >/dev/null 2>&1; then
        printf '%s\n' kind
      else
        printf '%s\n' none
      fi
      ;;
    *)
      printf '%s\n' none
      ;;
  esac
}

pages_use_target_context() {
  local cluster_name="$1"
  local tool="${2:-$(pages_detect_cluster_tool "${cluster_name}")}"
  local context_name

  case "${tool}" in
    k3d)
      context_name="k3d-${cluster_name}"
      ;;
    kind)
      context_name="kind-${cluster_name}"
      ;;
    *)
      echo "Cannot determine Kubernetes context for cluster ${cluster_name}" >&2
      return 1
      ;;
  esac

  kubectl config use-context "${context_name}" >/dev/null
}
