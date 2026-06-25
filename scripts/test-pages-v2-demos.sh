#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
DRY_RUN="false"
TARGET_ARG=""
SLUG_ARG=""
VISIBILITY_ARG=""

usage() {
  cat <<'EOF'
Usage: scripts/test-pages-v2-demos.sh [options]

Build and deploy the Vue demo through the v2 Pages CLI, then verify the published URL.

Options:
  --dry-run            Print the v2 demo plan without installing, building, deploying, or fetching URLs.
  --env-file <path>   Load environment variables from a specific file. Defaults to .env.
  --target <env>      Target environment: staging or production. Defaults to staging.
  --slug <slug>       v2 site slug. Defaults to demo-vue-app.
  --visibility <mode> Site visibility for first creation. Defaults to internal.
  -h, --help          Show this help.

Environment:
  PAGES_ACCESS_KEY          Optional. Used by xd-cell CLI for non-interactive deploys.
  PAGES_V2_DEMO_TARGET      Optional. Defaults to staging. Overridden by --target.
  PAGES_V2_DEMO_SLUG        Optional. Defaults to demo-vue-app. Overridden by --slug.
  PAGES_V2_DEMO_VISIBILITY  Optional. Defaults to internal. Overridden by --visibility.
  PAGES_CLI_BIN             Optional. Defaults to xd-cell.
  PAGES_DEMO_SKIP_INSTALL   Optional. Set true to skip dependency install before build.

EOF
}

die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN="true"
      shift
      ;;
    --env-file)
      ENV_FILE="${2:-}"
      [[ -n "$ENV_FILE" ]] || die "--env-file requires a path"
      shift 2
      ;;
    --target)
      TARGET_ARG="${2:-}"
      [[ -n "$TARGET_ARG" ]] || die "--target requires staging or production"
      shift 2
      ;;
    --slug)
      SLUG_ARG="${2:-}"
      [[ -n "$SLUG_ARG" ]] || die "--slug requires a site slug"
      shift 2
      ;;
    --visibility)
      VISIBILITY_ARG="${2:-}"
      [[ -n "$VISIBILITY_ARG" ]] || die "--visibility requires internal, org, acl, owner, or disabled"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      die "unknown argument: $1"
      ;;
  esac
done

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

PAGES_V2_DEMO_TARGET="${TARGET_ARG:-${PAGES_V2_DEMO_TARGET:-staging}}"
PAGES_V2_DEMO_SLUG="${SLUG_ARG:-${PAGES_V2_DEMO_SLUG:-demo-vue-app}}"
PAGES_V2_DEMO_VISIBILITY="${VISIBILITY_ARG:-${PAGES_V2_DEMO_VISIBILITY:-internal}}"

case "$PAGES_V2_DEMO_TARGET" in
  staging)
    PAGES_V2_API="https://api-staging.pages.xd.team"
    PAGES_V2_SITE="https://${PAGES_V2_DEMO_SLUG}-staging.pages.xd.team"
    ;;
  production)
    PAGES_V2_API="https://api.pages.xd.team"
    PAGES_V2_SITE="https://${PAGES_V2_DEMO_SLUG}.pages.xd.team"
    ;;
  *)
    die "PAGES_V2_DEMO_TARGET must be staging or production"
    ;;
esac

validate_slug() {
  local slug="$1"
  [[ "$slug" =~ ^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$ ]] || die "invalid v2 demo slug: $slug"
  case "$slug" in
    api | api-staging | auth | auth-staging | admin | admin-staging | manager | manager-staging | router | router-staging | \
      kv-gateway | kv-gateway-staging | pages | www | mail | static | assets | login | logout | callback | oauth | sso | \
      internal | status | health | docs | readme | skill | openapi | help | support | console | dashboard | portal | \
      site | sites | deploy | deployments | version | versions | rollback | access | access-keys | token | tokens | env | \
      environments | runtime | data | kv | storage | worker | workers | dispatch | gateway | metrics | logs | audit | \
      events | webhook | webhooks | monitor | monitoring | pages-api | pages-api-staging | pages-auth | pages-auth-staging | \
      pages-router | pages-router-staging | pages-kv-gateway | pages-kv-gateway-staging | production-slot-* | \
      staging-slot-* | v2-production-slot-* | v2-staging-slot-* | pages-v2-production-slot-* | pages-v2-staging-slot-*)
      die "reserved v2 demo slug: $slug"
      ;;
    staging | staging-*)
      [[ "$PAGES_V2_DEMO_TARGET" == "staging" ]] || die "reserved v2 demo slug: $slug"
      ;;
    *-staging)
      [[ "$PAGES_V2_DEMO_TARGET" == "staging" ]] || die "production v2 demo slug must not end with -staging"
      ;;
  esac
}

validate_visibility() {
  case "$1" in
    internal | org | acl | owner | disabled) ;;
    *) die "PAGES_V2_DEMO_VISIBILITY must be internal, org, acl, owner, or disabled" ;;
  esac
}

validate_slug "$PAGES_V2_DEMO_SLUG"
validate_visibility "$PAGES_V2_DEMO_VISIBILITY"

print_plan() {
  printf 'PAGES_V2_DEMO_TARGET=%s\n' "$PAGES_V2_DEMO_TARGET"
  printf 'PAGES_V2_API=%s\n' "$PAGES_V2_API"
  printf 'PAGES_V2_SITE=%s\n' "$PAGES_V2_SITE"
  printf 'PAGES_V2_DEMO_VISIBILITY=%s\n' "$PAGES_V2_DEMO_VISIBILITY"
  printf '\n'
  printf '%-24s %-12s %s\n' 'site' 'fallback' 'source'
  printf '%-24s %-12s %s\n' "$PAGES_V2_DEMO_SLUG" 'auto' 'demos/vue-app'
}

run_cmd() {
  printf '+ %s\n' "$*" >&2
  "$@" >&2
}

install_and_build_vue() {
  local dir="$REPO_ROOT/demos/vue-app"

  if [[ "${PAGES_DEMO_SKIP_INSTALL:-false}" != "true" ]]; then
    if [[ -f "$dir/package-lock.json" ]]; then
      run_cmd npm --prefix "$dir" ci
    else
      run_cmd pnpm --dir "$dir" install
    fi
  fi

  if [[ -f "$dir/package-lock.json" ]]; then
    run_cmd npm --prefix "$dir" run build
  else
    run_cmd pnpm --dir "$dir" run build
  fi
}

deploy_vue() {
  local output url
  output="$(
    cd "$REPO_ROOT/demos/vue-app"
    PAGES_CLI_ENV="$PAGES_V2_DEMO_TARGET" "${PAGES_CLI_BIN:-xd-cell}" \
      deploy dist "$PAGES_V2_DEMO_SLUG" \
      --env "$PAGES_V2_DEMO_TARGET" \
      --visibility "$PAGES_V2_DEMO_VISIBILITY"
  )" || {
    printf '%s\n' "$output" >&2
    return 1
  }

  printf '%s\n' "$output" >&2
  url="$(printf '%s\n' "$output" | awk '/^URL https:\/\// { print $2; exit }')"
  [[ -n "$url" ]] || die "xd-cell CLI deploy output did not include a URL"
  printf '%s' "$url"
}

verify_url_path() {
  local url="$1"
  local path="$2"
  local expected="$3"
  local tmp http_code
  tmp="$(mktemp)"

  http_code="$(curl -L -sS -w '%{http_code}' -o "$tmp" "${url%/}${path}")"
  if [[ "$http_code" != "200" ]]; then
    printf 'Verify failed: %s%s returned HTTP %s\n' "$url" "$path" "$http_code" >&2
    rm -f "$tmp"
    return 1
  fi

  if ! grep -q "$expected" "$tmp"; then
    printf 'Verify failed: %s%s did not contain expected text: %s\n' "$url" "$path" "$expected" >&2
    rm -f "$tmp"
    return 1
  fi

  rm -f "$tmp"
  printf 'Verified %s%s\n' "$url" "$path" >&2
}

if [[ "$DRY_RUN" == "true" ]]; then
  print_plan
  exit 0
fi

print_plan
install_and_build_vue
published_url="$(deploy_vue)"
verify_url_path "$published_url" '/' 'id="app"'
verify_url_path "$published_url" '/about' 'id="app"'

printf '\nPages v2 Vue demo deployed and verified: %s\n' "$published_url"
