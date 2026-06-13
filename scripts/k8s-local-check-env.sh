#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck source=scripts/k8s-local-lib.sh
source "${ROOT}/scripts/k8s-local-lib.sh"
pages_load_env_file "${ROOT}"

missing=()
warnings=()

is_placeholder_value() {
  local value="$1"

  case "${value}" in
    ""|replace-me|changeme|CHANGE_ME|example|example-*|*-example|pages_yourname@xd.com|*'...'*) return 0 ;;
    *replace-me*|*yourname*|*example.com*) return 0 ;;
    *) return 1 ;;
  esac
}

require_var() {
  local name="$1"
  local value="${!name:-}"

  if is_placeholder_value "${value}"; then
    missing+=("${name}")
  fi
}

require_any() {
  local label="$1"
  shift

  for name in "$@"; do
    if ! is_placeholder_value "${!name:-}"; then
      return
    fi
  done

  missing+=("${label}")
}

warn_var() {
  local name="$1"
  local value="${!name:-}"

  if is_placeholder_value "${value}"; then
    warnings+=("${name}")
  fi
}

require_prefix() {
  local name="$1"
  local prefix="$2"
  local value="${!name:-}"

  if is_placeholder_value "${value}"; then
    missing+=("${name}")
    return
  fi

  case "${value}" in
    "${prefix}"*) ;;
    *)
      missing+=("${name} must start with ${prefix}")
      ;;
  esac
}

require_https_url() {
  local name="$1"
  local value="${!name:-}"

  if is_placeholder_value "${value}"; then
    missing+=("${name}")
    return
  fi

  case "${value}" in
    https://*) ;;
    *)
      missing+=("${name} must be an https URL")
      ;;
  esac
}

require_prefix SLACK_BOT_TOKEN xoxb-
require_prefix SLACK_APP_TOKEN xapp-
require_any "SLACK_CONNECTOR_SHARED_SECRET or PAGES_GATEWAY_CONNECTOR_TOKEN" \
  SLACK_CONNECTOR_SHARED_SECRET \
  PAGES_GATEWAY_CONNECTOR_TOKEN
require_https_url PAGES_GATEWAY_PUBLIC_URL
require_var GITHUB_REPO
require_any "GITHUB_APP_INSTALLATION_TOKEN or GITHUB_TOKEN" GITHUB_APP_INSTALLATION_TOKEN GITHUB_TOKEN
require_any "INTERNAL_CALLBACK_TOKEN or PAGES_CALLBACK_TOKEN" INTERNAL_CALLBACK_TOKEN PAGES_CALLBACK_TOKEN
require_var PAGES_WORKER_SHARED_SECRET

if [ "${PAGES_PREVIEW_MODE:-actions}" = "local_deploy" ]; then
  require_any "PAGES_PREVIEW_TOKEN or PAGES_TOKEN" PAGES_PREVIEW_TOKEN PAGES_TOKEN
fi

warn_var GITHUB_WEBHOOK_SECRET
warn_var SLACK_AGENT_SHARED_SECRET
warn_var AGENT_GATEWAY_URL
warn_var SLACK_AGENT_API_KEY

if [ "${#missing[@]}" -gt 0 ]; then
  echo "Missing required local K8s environment variables:"
  printf '  - %s\n' "${missing[@]}"
  echo ""
  echo "Set them in the repository root .env file."
  exit 1
fi

echo "Required local K8s environment variables are present."

if [ "${#warnings[@]}" -gt 0 ]; then
  echo "Recommended variables not set:"
  printf '  - %s\n' "${warnings[@]}"
fi
