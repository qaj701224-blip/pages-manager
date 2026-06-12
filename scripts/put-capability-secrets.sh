#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 <app-dir>" >&2
  exit 2
fi

APP_DIR="$1"

trim() {
  local value="$*"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf '%s' "$value"
}

require_capability_registry() {
  if [ -z "${PAGES_CAP_JWT_ACTIVE_KID:-}" ]; then
    echo "::error::PAGES_CAP_JWT_ACTIVE_KID is required" >&2
    exit 1
  fi

  if [ -z "${PAGES_CAP_JWT_KEYS:-}" ]; then
    echo "::error::PAGES_CAP_JWT_KEYS is required" >&2
    exit 1
  fi
}

put_secret() {
  local secret_name="$1"
  local secret_value="${!secret_name-}"

  if [ -z "$secret_value" ]; then
    echo "::error::${secret_name} is required by PAGES_CAP_JWT_KEYS" >&2
    exit 1
  fi

  if [ "${DRY_RUN:-}" = "1" ]; then
    printf 'would inject %s into %s\n' "$secret_name" "$APP_DIR"
    return 0
  fi

  printf '%s' "$secret_value" | pnpm --dir "$APP_DIR" exec wrangler secret put "$secret_name"
}

require_capability_registry

active_kid="$(trim "$PAGES_CAP_JWT_ACTIVE_KID")"
seen_secret_names="|"
active_kid_found=0
secret_names=()
IFS=',' read -r -a entries <<<"$PAGES_CAP_JWT_KEYS"

has_seen_secret_name() {
  local needle="$1"
  case "$seen_secret_names" in
    *"|$needle|"*) return 0 ;;
    *) return 1 ;;
  esac
}

for raw_entry in "${entries[@]}"; do
  entry="$(trim "$raw_entry")"
  if [ -z "$entry" ]; then
    continue
  fi

  IFS=':' read -r kid alg secret_name extra <<<"$entry"
  kid="$(trim "${kid:-}")"
  alg="$(trim "${alg:-}")"
  secret_name="$(trim "${secret_name:-}")"

  if [ -n "${extra:-}" ] || [ -z "$kid" ] || [ -z "$alg" ] || [ -z "$secret_name" ]; then
    echo "::error::Malformed PAGES_CAP_JWT_KEYS entry" >&2
    exit 1
  fi

  if [ "$alg" != "HS256" ]; then
    echo "::error::Unsupported capability key alg: $alg" >&2
    exit 1
  fi

  if [ "$kid" = "$active_kid" ]; then
    active_kid_found=1
  fi

  if [[ ! "$secret_name" =~ ^PAGES_CAP_JWT_SECRET_[A-Z0-9_]+$ ]]; then
    echo "::error::Unsupported capability secret env var name: $secret_name" >&2
    exit 1
  fi

  if has_seen_secret_name "$secret_name"; then
    continue
  fi

  seen_secret_names="${seen_secret_names}${secret_name}|"
  secret_names+=("$secret_name")
done

if [ "${#secret_names[@]}" -eq 0 ]; then
  echo "::error::PAGES_CAP_JWT_KEYS does not contain any capability secret" >&2
  exit 1
fi

if [ "$active_kid_found" -ne 1 ]; then
  echo "::error::PAGES_CAP_JWT_ACTIVE_KID is not present in PAGES_CAP_JWT_KEYS: $active_kid" >&2
  exit 1
fi

for secret_name in "${secret_names[@]}"; do
  put_secret "$secret_name"
done
