#!/usr/bin/env bash
set -euo pipefail

# One-off historical domain migration tool.
# Sensitive Cloudflare config is read from .env or the current shell environment.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${ENV_FILE:-${REPO_ROOT}/.env}"

strip_quotes() {
  local value="$1"
  value="${value%$'\r'}"
  if [[ "$value" == \"*\" && "$value" == *\" ]]; then
    value="${value:1:${#value}-2}"
  elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf '%s' "$value"
}

load_env_file() {
  [ -f "$ENV_FILE" ] || return 0

  local key value
  while IFS='=' read -r key value || [ -n "$key" ]; do
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    [[ -z "$key" || "$key" == \#* ]] && continue
    [[ "$key" == export\ * ]] && key="${key#export }"
    [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]] || continue

    value="$(strip_quotes "${value:-}")"
    if [ -z "${!key:-}" ]; then
      export "$key=$value"
    fi
  done < "$ENV_FILE"
}

require_value() {
  local name="$1"
  local value="$2"
  if [ -z "$value" ]; then
    echo "missing required config: ${name}"
    echo "set it in ${ENV_FILE} or export it before running this script"
    exit 1
  fi
}

normalize_https_url() {
  local host_or_url="$1"
  if [[ "$host_or_url" =~ ^https?:// ]]; then
    printf '%s' "$host_or_url"
  else
    printf 'https://%s' "$host_or_url"
  fi
}

load_env_file

command -v curl >/dev/null || {
  echo "missing required command: curl"
  exit 1
}
command -v python3 >/dev/null || {
  echo "missing required command: python3"
  exit 1
}

OLD_DOMAIN="${OLD_SITE_DOMAIN:-xd-ads.com}"
NEW_DOMAIN="${NEW_SITE_DOMAIN:-${DOMAIN_BASE:-workers.xd.team}}"
WORKER_PREFIX="${WORKER_PREFIX:-pages-}"
NEW_ZONE_ID="${NEW_ZONE_ID:-${CF_ZONE_ID_NEW:-${CF_ZONE_ID:-}}}"
KV_NS="${KV_NS:-${SITES_KV_NAMESPACE_ID:-}}"
ACCT_ID="${ACCT_ID:-${CLOUDFLARE_ACCOUNT_ID:-${CF_ACCOUNT_ID:-}}}"
CF_TOKEN="${CLOUDFLARE_API_TOKEN:-${CF_API_TOKEN:-}}"
DRY_RUN="${DRY_RUN:-false}"
SKIP_NAMES=" ${SKIP_NAMES:-test} "

if [ -n "${PAGES_API:-}" ]; then
  API="$(normalize_https_url "$PAGES_API")"
elif [ -n "${NEW_API_HOST:-}" ]; then
  API="$(normalize_https_url "$NEW_API_HOST")"
else
  API="https://api.${NEW_DOMAIN}"
fi

if [ "$DRY_RUN" != "true" ]; then
  require_value "CF_ZONE_ID_NEW" "$NEW_ZONE_ID"
  require_value "SITES_KV_NAMESPACE_ID" "$KV_NS"
  require_value "CLOUDFLARE_ACCOUNT_ID" "$ACCT_ID"
  require_value "CLOUDFLARE_API_TOKEN or CF_API_TOKEN" "$CF_TOKEN"
fi

CF="https://api.cloudflare.com/client/v4"
AUTH_H="Authorization: Bearer ${CF_TOKEN}"
OK=0
FAIL=0
SKIP=0

sites_json="$(curl -fsS "${API}/list")"
sites="$(
  OLD_DOMAIN="$OLD_DOMAIN" python3 -c '
import json
import os
import sys

data = json.load(sys.stdin)
old_domain = os.environ["OLD_DOMAIN"]
for site in data.get("sites", []):
    if old_domain in site.get("url", ""):
        print(site["name"])
' <<< "$sites_json"
)"

if [ -z "$sites" ]; then
  echo "no sites to migrate"
  exit 0
fi

echo "=== sites to migrate ==="
echo "$sites"
echo ""

for name in $sites; do
  worker="${WORKER_PREFIX}${name}"
  pattern="${name}.${NEW_DOMAIN}/*"
  new_url="https://${name}.${NEW_DOMAIN}"

  echo "--- $name ---"

  if echo "$SKIP_NAMES" | grep -q " ${name} "; then
    echo "  SKIP (excluded)"
    SKIP=$((SKIP + 1))
    echo ""
    continue
  fi

  if [ "$DRY_RUN" = "true" ]; then
    echo "  [DRY] Route: $pattern -> $worker"
    echo "  [DRY] KV url: $new_url"
    SKIP=$((SKIP + 1))
    echo ""
    continue
  fi

  echo "  route: $pattern -> $worker"
  rr="$(
    curl -s -X POST "$CF/zones/$NEW_ZONE_ID/workers/routes" \
      -H "$AUTH_H" \
      -H "Content-Type: application/json" \
      -d "{\"pattern\":\"$pattern\",\"script\":\"$worker\"}"
  )"

  rok="$(
    python3 -c '
import json
import sys

data = json.load(sys.stdin)
if data.get("success"):
    print("ok")
elif any(error.get("code") == 10020 for error in data.get("errors", [])):
    print("dup")
else:
    print("fail")
' <<< "$rr"
  )"

  if [ "$rok" = "fail" ]; then
    echo "  FAIL route: $rr"
    FAIL=$((FAIL + 1))
    continue
  fi
  if [ "$rok" = "dup" ]; then
    echo "  route exists, ok"
  else
    echo "  route created"
  fi

  echo "  verify: $new_url"
  rc="$(curl -s -o /dev/null -w '%{http_code}' "${new_url}/" --max-time 10 || true)"
  echo "  -> $rc"

  echo "  update KV url"
  kv="$(curl -s "$CF/accounts/$ACCT_ID/storage/kv/namespaces/$KV_NS/values/$name" -H "$AUTH_H")"

  upd="$(
    NEW_URL="$new_url" python3 -c '
import json
import os
import sys

try:
    data = json.load(sys.stdin)
    data["url"] = os.environ["NEW_URL"]
    print(json.dumps(data, ensure_ascii=False))
except Exception:
    print("")
' <<< "$kv"
  )"

  if [ -z "$upd" ]; then
    echo "  FAIL KV read"
    FAIL=$((FAIL + 1))
    continue
  fi

  pr="$(
    curl -s -X PUT "$CF/accounts/$ACCT_ID/storage/kv/namespaces/$KV_NS/values/$name" \
      -H "$AUTH_H" \
      -H "Content-Type: application/json" \
      -d "$upd"
  )"

  pok="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("success", False))' <<< "$pr")"
  if [ "$pok" != "True" ]; then
    echo "  FAIL KV write: $pr"
    FAIL=$((FAIL + 1))
    continue
  fi
  echo "  KV updated"

  OK=$((OK + 1))
  echo ""
done

echo "=== done ==="
echo "ok: $OK / fail: $FAIL / skip: $SKIP"
