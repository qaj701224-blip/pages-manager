#!/usr/bin/env bash
set -euo pipefail

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

urlencode() {
  printf '%s' "$1" | od -An -v -t x1 | tr ' ' '\n' | while IFS= read -r hex; do
    [ -n "$hex" ] || continue
    case "$hex" in
      2d|2e|5f|7e|30|31|32|33|34|35|36|37|38|39|41|42|43|44|45|46|47|48|49|4a|4b|4c|4d|4e|4f|50|51|52|53|54|55|56|57|58|59|5a|61|62|63|64|65|66|67|68|69|6a|6b|6c|6d|6e|6f|70|71|72|73|74|75|76|77|78|79|7a)
        printf '%b' "\\x$hex"
        ;;
      *)
        printf '%%%s' "$(printf '%s' "$hex" | tr 'a-f' 'A-F')"
        ;;
    esac
  done
}

json_value() {
  key="$1"
  sed -n "s/.*\"$key\"[[:space:]]*:[[:space:]]*\"\\([^\"]*\\)\".*/\\1/p" | head -n 1
}

redact_acr_response() {
  sed -E \
    -e 's/"AuthorizationToken"[[:space:]]*:[[:space:]]*"[^"]*"/"AuthorizationToken":"<redacted>"/g' \
    -e 's/"TempUsername"[[:space:]]*:[[:space:]]*"[^"]*"/"TempUsername":"<redacted>"/g'
}

require_cmd base64
require_cmd curl
require_cmd date
require_cmd head
require_cmd mktemp
require_cmd od
require_cmd openssl
require_cmd sed
require_cmd tr

ACR_ACCESS_KEY_ID="${ACR_ACCESS_KEY_ID:-${ALIYUN_ACCESS_KEY_ID:-}}"
ACR_ACCESS_KEY_SECRET="${ACR_ACCESS_KEY_SECRET:-${ALIYUN_ACCESS_KEY_SECRET:-}}"

: "${ACR_ACCESS_KEY_ID:?Set ACR_ACCESS_KEY_ID or ALIYUN_ACCESS_KEY_ID}"
: "${ACR_ACCESS_KEY_SECRET:?Set ACR_ACCESS_KEY_SECRET or ALIYUN_ACCESS_KEY_SECRET}"
: "${ACR_INSTANCE_ID:?Set ACR_INSTANCE_ID to the ACR Enterprise Edition instance id}"
: "${ACR_REGISTRY:?Set ACR_REGISTRY to the registry host}"

ACR_REGION="${ACR_REGION:-${ACR_REGION_ID:-cn-shanghai}}"
ACR_OPENAPI_ENDPOINT="${ACR_OPENAPI_ENDPOINT:-cr.${ACR_REGION}.aliyuncs.com}"
ACR_OPENAPI_ENDPOINT="${ACR_OPENAPI_ENDPOINT#http://}"
ACR_OPENAPI_ENDPOINT="${ACR_OPENAPI_ENDPOINT#https://}"
ACR_OPENAPI_ENDPOINT="${ACR_OPENAPI_ENDPOINT%/}"
DOCKER_CONFIG="${DOCKER_CONFIG:-${HOME}/.docker}"

timestamp="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
nonce="$(date +%s)-$$-$(od -An -N4 -tx1 /dev/urandom | tr -d ' \n')"

canonical_query="AccessKeyId=$(urlencode "$ACR_ACCESS_KEY_ID")"
canonical_query="${canonical_query}&Action=GetAuthorizationToken"
canonical_query="${canonical_query}&Format=JSON"
canonical_query="${canonical_query}&InstanceId=$(urlencode "$ACR_INSTANCE_ID")"
canonical_query="${canonical_query}&SignatureMethod=HMAC-SHA1"
canonical_query="${canonical_query}&SignatureNonce=$(urlencode "$nonce")"
canonical_query="${canonical_query}&SignatureVersion=1.0"
canonical_query="${canonical_query}&Timestamp=$(urlencode "$timestamp")"
canonical_query="${canonical_query}&Version=2018-12-01"

string_to_sign="GET&$(urlencode "/")&$(urlencode "$canonical_query")"
signature="$(
  printf '%s' "$string_to_sign" |
    openssl dgst -sha1 -hmac "${ACR_ACCESS_KEY_SECRET}&" -binary |
    base64 | tr -d '\n'
)"

request_url="https://${ACR_OPENAPI_ENDPOINT}/?${canonical_query}&Signature=$(urlencode "$signature")"
response_file="$(mktemp)"

cleanup() {
  rm -f "$response_file"
}
trap cleanup EXIT

if ! curl -fsS -o "$response_file" "$request_url"; then
  echo "failed to get ACR authorization token from ${ACR_OPENAPI_ENDPOINT}" >&2
  redact_acr_response < "$response_file" >&2 || true
  exit 1
fi

temp_username="$(json_value TempUsername < "$response_file")"
authorization_token="$(json_value AuthorizationToken < "$response_file")"

if [ -z "$temp_username" ] || [ -z "$authorization_token" ]; then
  echo "ACR authorization token response did not contain TempUsername/AuthorizationToken" >&2
  redact_acr_response < "$response_file" >&2 || true
  exit 1
fi

registry_host="${ACR_REGISTRY#http://}"
registry_host="${registry_host#https://}"
registry_auth="$(printf '%s:%s' "$temp_username" "$authorization_token" | base64 | tr -d '\n')"

mkdir -p "$DOCKER_CONFIG"
config_file="$DOCKER_CONFIG/config.json"
if [ -f "$config_file" ] && command -v jq >/dev/null 2>&1; then
  jq --arg host "$registry_host" --arg auth "$registry_auth" \
    '.auths[$host] = {"auth": $auth}' "$config_file" > "${config_file}.tmp" \
    && mv "${config_file}.tmp" "$config_file"
else
  printf '{"auths":{"%s":{"auth":"%s"}}}\n' "$registry_host" "$registry_auth" > "$config_file"
fi

echo "[acr-write-docker-config] wrote docker auth for ${registry_host}"
