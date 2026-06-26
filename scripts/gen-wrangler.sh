#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "Usage: scripts/gen-wrangler.sh <app> <production|staging>" >&2
  echo "Supported apps: apps/server, apps/xdads-302" >&2
}

die() {
  echo "gen-wrangler: $*" >&2
  exit 1
}

require_toml_safe() {
  local name="$1"
  local value="$2"

  if [[ "$value" == *\"* || "$value" == *\\* || "$value" == *$'\n'* || "$value" == *$'\r'* ]]; then
    die "$name contains TOML-unsafe characters"
  fi
}

require_env() {
  local name="$1"
  local value="${!name:-}"

  if [[ -z "$value" ]]; then
    die "$name is required"
  fi

  require_toml_safe "$name" "$value"
}

replace_token() {
  local token="$1"
  local value="$2"

  rendered="${rendered//$token/$value}"
}

if [[ $# -ne 2 ]]; then
  usage
  exit 2
fi

app="$1"
environment="$2"

case "$app" in
  apps/server | apps/xdads-302) ;;
  *)
    usage
    die "unsupported app: $app"
    ;;
esac

case "$environment" in
  production | staging) ;;
  *)
    usage
    die "unsupported environment: $environment"
    ;;
esac

if [[ "$app" == "apps/xdads-302" && "$environment" != "production" ]]; then
  die "apps/xdads-302 only supports production"
fi

require_env CLOUDFLARE_ACCOUNT_ID

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
template_path="$repo_root/$app/wrangler.template.toml"
output_path="$repo_root/$app/wrangler.toml"

[[ -f "$template_path" ]] || die "template not found: $app/wrangler.template.toml"

rendered="$(<"$template_path")"
replace_token "__CLOUDFLARE_ACCOUNT_ID__" "$CLOUDFLARE_ACCOUNT_ID"

if [[ "$app" == "apps/server" ]]; then
  require_env SITES_KV_NAMESPACE_ID
  require_env IP_ALLOWLIST

  ip_allowlist_pattern='^[0-9A-Fa-f:\.,/ _-]+$'
  if [[ ! "$IP_ALLOWLIST" =~ $ip_allowlist_pattern ]]; then
    die "IP_ALLOWLIST contains unsupported characters"
  fi

  domain_base="workers.xd.team"
  workers_dev_subdomain="xd-cf-2022"

  case "$environment" in
    production)
      worker_name="pages-manager"
      public_environment="production"
      public_api_base="https://api.workers.xd.team"
      public_manager_dev_base="https://pages-manager.xd-cf-2022.workers.dev"
      domain_label=""
      worker_prefix="pages-"
      api_route="api.workers.xd.team"
      pages_api_service="pages-api"
      ;;
    staging)
      worker_name="pages-manager-staging"
      public_environment="staging"
      public_api_base="https://api-staging.workers.xd.team"
      public_manager_dev_base="https://pages-manager-staging.xd-cf-2022.workers.dev"
      domain_label="-staging"
      worker_prefix="pages-staging-"
      api_route="api-staging.workers.xd.team"
      pages_api_service="pages-api-staging"
      ;;
  esac
  hostname_claims_mode="${HOSTNAME_CLAIMS_MODE:-record_only}"
  hostname_reuse_hold_seconds="${HOSTNAME_REUSE_HOLD_SECONDS:-300}"
  if [[ ! "$hostname_reuse_hold_seconds" =~ ^[0-9]+$ ]]; then
    die "HOSTNAME_REUSE_HOLD_SECONDS must be a non-negative integer"
  fi

  for name in \
    worker_name \
    public_environment \
    public_api_base \
    public_manager_dev_base \
    domain_base \
    domain_label \
    worker_prefix \
    workers_dev_subdomain \
    hostname_claims_mode \
    hostname_reuse_hold_seconds \
    pages_api_service \
    api_route; do
    require_toml_safe "$name" "${!name}"
  done

  replace_token "__WORKER_NAME__" "$worker_name"
  replace_token "__PUBLIC_ENVIRONMENT__" "$public_environment"
  replace_token "__PUBLIC_API_BASE__" "$public_api_base"
  replace_token "__PUBLIC_MANAGER_DEV_BASE__" "$public_manager_dev_base"
  replace_token "__DOMAIN_BASE__" "$domain_base"
  replace_token "__DOMAIN_LABEL__" "$domain_label"
  replace_token "__WORKER_PREFIX__" "$worker_prefix"
  replace_token "__WORKERS_DEV_SUBDOMAIN__" "$workers_dev_subdomain"
  replace_token "__IP_ALLOWLIST__" "$IP_ALLOWLIST"
  replace_token "__HOSTNAME_CLAIMS_MODE__" "$hostname_claims_mode"
  replace_token "__HOSTNAME_REUSE_HOLD_SECONDS__" "$hostname_reuse_hold_seconds"
  replace_token "__PAGES_API_SERVICE__" "$pages_api_service"
  replace_token "__SITES_KV_NAMESPACE_ID__" "$SITES_KV_NAMESPACE_ID"
  replace_token "__API_ROUTE__" "$api_route"

  if [[ "$environment" == "production" ]]; then
    if [[ "$rendered" == *"pages-manager-staging"* ||
      "$rendered" == *"api-staging.workers.xd.team"* ||
      "$rendered" == *"pages-staging-"* ]]; then
      die "production config contains staging values"
    fi
  else
    if [[ "$rendered" != *'name = "pages-manager-staging"'* ||
      "$rendered" != *'PUBLIC_API_BASE = "https://api-staging.workers.xd.team"'* ||
      "$rendered" != *'DOMAIN_LABEL = "-staging"'* ||
      "$rendered" != *'WORKER_PREFIX = "pages-staging-"'* ||
      "$rendered" != *'pattern = "api-staging.workers.xd.team"'* ]]; then
      die "staging config is missing expected staging values"
    fi
  fi
elif [[ "$app" == "apps/xdads-302" ]]; then
  require_env OLD_ZONE_ID
  replace_token "__OLD_ZONE_ID__" "$OLD_ZONE_ID"
fi

token_placeholder_regex='__[A-Za-z0-9_]+__'
legacy_placeholder_regex='<[^>]+>'
if [[ "$rendered" =~ $token_placeholder_regex || "$rendered" =~ $legacy_placeholder_regex ]]; then
  die "unresolved template placeholders remain in $app/wrangler.template.toml"
fi

printf '%s\n' "$rendered" > "$output_path"
echo "generated $app/wrangler.toml"
