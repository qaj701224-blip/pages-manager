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

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    echo "::error::${name} is required" >&2
    exit 1
  fi
}

put_secret() {
  local secret_name="$1"
  local secret_value="${!secret_name-}"

  if [ -z "$secret_value" ]; then
    echo "::error::${secret_name} is required" >&2
    exit 1
  fi

  if [ "${DRY_RUN:-}" = "1" ]; then
    printf 'would inject %s into %s\n' "$secret_name" "$APP_DIR"
    return 0
  fi

  printf '%s' "$secret_value" | pnpm --dir "$APP_DIR" exec wrangler secret put "$secret_name"
}

delete_optional_secret_if_unset() {
  local secret_name="$1"

  if [ "${DRY_RUN:-}" = "1" ]; then
    printf 'would delete %s if present\n' "$secret_name"
    return 0
  fi

  local listed_secrets
  if ! listed_secrets="$(pnpm --dir "$APP_DIR" exec wrangler secret list --format json 2>/dev/null)"; then
    echo "::error::optional secret list failed" >&2
    return 1
  fi

  local secret_present
  if ! secret_present="$(printf '%s' "$listed_secrets" | node -e '
    let input = "";
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      try {
        const secrets = JSON.parse(input);
        const name = process.argv[1];
        const present = Array.isArray(secrets) && secrets.some((item) => item && item.name === name);
        process.stdout.write(present ? "1" : "0");
      } catch {
        process.exitCode = 1;
      }
    });
  ' "$secret_name")"; then
    echo "::error::optional secret list returned invalid JSON" >&2
    return 1
  fi

  if [ "$secret_present" = "1" ]; then
    pnpm --dir "$APP_DIR" exec wrangler secret delete "$secret_name"
  fi
}

has_seen() {
  local haystack="$1"
  local needle="$2"
  case "$haystack" in
    *"|$needle|"*) return 0 ;;
    *) return 1 ;;
  esac
}

collect_session_jwt_secrets() {
  require_env PAGES_SESSION_JWT_ACTIVE_KID
  require_env PAGES_SESSION_JWT_KEYS

  local active_kid
  active_kid="$(trim "$PAGES_SESSION_JWT_ACTIVE_KID")"
  local seen_kids="|"
  local seen_secret_names="|"
  local active_kid_found=0
  IFS=',' read -r -a entries <<<"$PAGES_SESSION_JWT_KEYS"

  for raw_entry in "${entries[@]}"; do
    local entry kid alg secret_name extra
    entry="$(trim "$raw_entry")"
    if [ -z "$entry" ]; then
      continue
    fi

    IFS=':' read -r kid alg secret_name extra <<<"$entry"
    kid="$(trim "${kid:-}")"
    alg="$(trim "${alg:-}")"
    secret_name="$(trim "${secret_name:-}")"

    if [ -n "${extra:-}" ] || [ -z "$kid" ] || [ -z "$alg" ] || [ -z "$secret_name" ]; then
      echo "::error::Malformed PAGES_SESSION_JWT_KEYS entry" >&2
      exit 1
    fi
    if [ "$alg" != "HS256" ]; then
      echo "::error::Unsupported session key alg: $alg" >&2
      exit 1
    fi
    if has_seen "$seen_kids" "$kid"; then
      echo "::error::Duplicate session key kid: $kid" >&2
      exit 1
    fi
    seen_kids="${seen_kids}${kid}|"
    if [ "$kid" = "$active_kid" ]; then
      active_kid_found=1
    fi
    if [[ ! "$secret_name" =~ ^PAGES_SESSION_JWT_SECRET_[A-Z0-9_]+$ ]]; then
      echo "::error::Unsupported session secret env var name: $secret_name" >&2
      exit 1
    fi
    if ! has_seen "$seen_secret_names" "$secret_name"; then
      seen_secret_names="${seen_secret_names}${secret_name}|"
      SECRET_NAMES+=("$secret_name")
    fi
  done

  if [ "$active_kid_found" -ne 1 ]; then
    echo "::error::PAGES_SESSION_JWT_ACTIVE_KID is not present in PAGES_SESSION_JWT_KEYS: $active_kid" >&2
    exit 1
  fi
}

collect_capability_jwt_secrets() {
  require_env PAGES_CAP_JWT_ACTIVE_KID
  require_env PAGES_CAP_JWT_KEYS

  local active_kid
  active_kid="$(trim "$PAGES_CAP_JWT_ACTIVE_KID")"
  local seen_kids="|"
  local seen_secret_names="|"
  local active_kid_found=0
  IFS=',' read -r -a entries <<<"$PAGES_CAP_JWT_KEYS"

  for raw_entry in "${entries[@]}"; do
    local entry kid alg secret_name extra
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
    if has_seen "$seen_kids" "$kid"; then
      echo "::error::Duplicate capability key kid: $kid" >&2
      exit 1
    fi
    seen_kids="${seen_kids}${kid}|"
    if [ "$kid" = "$active_kid" ]; then
      active_kid_found=1
    fi
    if [[ ! "$secret_name" =~ ^PAGES_CAP_JWT_SECRET_[A-Z0-9_]+$ ]]; then
      echo "::error::Unsupported capability secret env var name: $secret_name" >&2
      exit 1
    fi
    if ! has_seen "$seen_secret_names" "$secret_name"; then
      seen_secret_names="${seen_secret_names}${secret_name}|"
      SECRET_NAMES+=("$secret_name")
    fi
  done

  if [ "$active_kid_found" -ne 1 ]; then
    echo "::error::PAGES_CAP_JWT_ACTIVE_KID is not present in PAGES_CAP_JWT_KEYS: $active_kid" >&2
    exit 1
  fi
}

collect_access_key_pepper_secrets() {
  require_env ACCESS_KEY_ACTIVE_PEPPER_ID
  require_env ACCESS_KEY_PEPPERS

  local active_id
  active_id="$(trim "$ACCESS_KEY_ACTIVE_PEPPER_ID")"
  local seen_ids="|"
  local seen_secret_names="|"
  local active_id_found=0
  IFS=',' read -r -a entries <<<"$ACCESS_KEY_PEPPERS"

  for raw_entry in "${entries[@]}"; do
    local entry pepper_id secret_name extra
    entry="$(trim "$raw_entry")"
    if [ -z "$entry" ]; then
      continue
    fi

    IFS=':' read -r pepper_id secret_name extra <<<"$entry"
    pepper_id="$(trim "${pepper_id:-}")"
    secret_name="$(trim "${secret_name:-}")"

    if [ -n "${extra:-}" ] || [ -z "$pepper_id" ] || [ -z "$secret_name" ]; then
      echo "::error::Malformed ACCESS_KEY_PEPPERS entry" >&2
      exit 1
    fi
    if has_seen "$seen_ids" "$pepper_id"; then
      echo "::error::Duplicate access key pepper id: $pepper_id" >&2
      exit 1
    fi
    seen_ids="${seen_ids}${pepper_id}|"
    if [ "$pepper_id" = "$active_id" ]; then
      active_id_found=1
    fi
    if [[ ! "$secret_name" =~ ^ACCESS_KEY_PEPPER_[A-Z0-9_]+$ ]]; then
      echo "::error::Unsupported access key pepper secret env var name: $secret_name" >&2
      exit 1
    fi
    if ! has_seen "$seen_secret_names" "$secret_name"; then
      seen_secret_names="${seen_secret_names}${secret_name}|"
      SECRET_NAMES+=("$secret_name")
    fi
  done

  if [ "$active_id_found" -ne 1 ]; then
    echo "::error::ACCESS_KEY_ACTIVE_PEPPER_ID is not present in ACCESS_KEY_PEPPERS: $active_id" >&2
    exit 1
  fi
}

SECRET_NAMES=()
OPTIONAL_SECRET_NAME=''

case "$APP_DIR" in
  apps/pages-api)
    SECRET_NAMES+=(CF_ACCOUNT_ID CF_API_TOKEN SLACK_PAGES_ALERT_WEBHOOK_URL SITE_SECRET_ENCRYPTION_KEY WEBHOOK_URL_ENCRYPTION_KEY XDS_OPENAI_TOKEN)
    if [ -n "${PAGES_V1_SITES_KV_NAMESPACE_ID:-}" ]; then
      SECRET_NAMES+=(PAGES_V1_SITES_KV_NAMESPACE_ID)
    else
      OPTIONAL_SECRET_NAME='PAGES_V1_SITES_KV_NAMESPACE_ID'
    fi
    collect_access_key_pepper_secrets
    ;;
  apps/pages-auth)
    SECRET_NAMES+=(SSO_CLIENT_SECRET XDS_OPENAI_TOKEN)
    collect_session_jwt_secrets
    ;;
  apps/pages-router)
    collect_session_jwt_secrets
    collect_capability_jwt_secrets
    ;;
  apps/kv-gateway)
    collect_capability_jwt_secrets
    ;;
  apps/pages-console)
    collect_session_jwt_secrets
    ;;
  *)
    echo "::error::unsupported app: $APP_DIR" >&2
    exit 2
    ;;
esac

if [ "${#SECRET_NAMES[@]}" -eq 0 ]; then
  echo "::error::no secrets to inject" >&2
  exit 1
fi

for secret_name in "${SECRET_NAMES[@]}"; do
  put_secret "$secret_name"
done

if [ -n "$OPTIONAL_SECRET_NAME" ]; then
  delete_optional_secret_if_unset "$OPTIONAL_SECRET_NAME"
fi
