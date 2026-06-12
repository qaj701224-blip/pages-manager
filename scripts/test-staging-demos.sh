#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="$REPO_ROOT/.env"
DRY_RUN="false"
ONLY_DEMO=""
TARGET_ARG=""

usage() {
  cat <<'EOF'
Usage: scripts/test-staging-demos.sh [options]

Deploy demo projects through the staging Pages Manager API and verify the returned URLs.

Options:
  --dry-run          Print the plan without installing, building, deploying, or fetching URLs.
  --env-file <path> Load environment variables from a specific file. Defaults to .env.
  --target <env>    Target environment: staging or production. Defaults to staging.
  --demo <id>       Run one demo: html-img, vue-app, nuxt-app, api-demo.
  -h, --help        Show this help.

Environment:
  PAGES_TOKEN              Required. Deployment owner token, usually stored in .env.
  PAGES_DEMO_TARGET        Optional. Defaults to staging. Overridden by --target.
  PAGES_API                Optional. Defaults from target.
  PAGES_DEMO_PREFIX        Optional. Defaults to demo.
  PAGES_DEMO_IP_RESTRICT   Optional. Defaults to true. Set false only for troubleshooting.
  PAGES_DEMO_ALLOW_NON_STAGING
                           Optional. Set true only for a nonstandard PAGES_API.

Note:
  vue-app is deployed with kv=true to exercise the browser Pages KV SDK.
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
    --demo)
      ONLY_DEMO="${2:-}"
      [[ -n "$ONLY_DEMO" ]] || die "--demo requires a demo id"
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

PAGES_DEMO_TARGET="${TARGET_ARG:-${PAGES_DEMO_TARGET:-staging}}"
case "$PAGES_DEMO_TARGET" in
  staging)
    EXPECTED_PAGES_API="https://api-staging.workers.xd.team"
    ;;
  production)
    EXPECTED_PAGES_API="https://api.workers.xd.team"
    ;;
  *)
    die "PAGES_DEMO_TARGET must be staging or production"
    ;;
esac

PAGES_API="${PAGES_API:-$EXPECTED_PAGES_API}"
PAGES_API="${PAGES_API%/}"
PAGES_DEMO_PREFIX="${PAGES_DEMO_PREFIX:-demo}"
PAGES_DEMO_IP_RESTRICT="${PAGES_DEMO_IP_RESTRICT:-true}"
PAGES_DEMO_ALLOW_NON_STAGING="${PAGES_DEMO_ALLOW_NON_STAGING:-false}"

[[ -n "${PAGES_TOKEN:-}" ]] || die "PAGES_TOKEN is required. Put it in .env or pass --env-file."

if [[ "$PAGES_DEMO_ALLOW_NON_STAGING" != "true" && "$PAGES_API" != "$EXPECTED_PAGES_API" ]]; then
  die "PAGES_API does not match target $PAGES_DEMO_TARGET: got $PAGES_API, expected $EXPECTED_PAGES_API. Set PAGES_DEMO_ALLOW_NON_STAGING=true only for a nonstandard API."
fi

case "$PAGES_DEMO_IP_RESTRICT" in
  true | false) ;;
  *) die "PAGES_DEMO_IP_RESTRICT must be true or false" ;;
esac

DEMO_IDS=(html-img vue-app nuxt-app api-demo)

demo_preset() {
  case "$1" in
    html-img) printf 'static' ;;
    vue-app | nuxt-app) printf 'spa' ;;
    api-demo) printf 'worker' ;;
    *) die "unknown demo id: $1" ;;
  esac
}

demo_kv_enabled() {
  case "$1" in
    vue-app) printf 'true' ;;
    html-img | nuxt-app | api-demo) printf 'false' ;;
    *) die "unknown demo id: $1" ;;
  esac
}

demo_dir() {
  case "$1" in
    html-img) printf 'demos/html-img' ;;
    vue-app) printf 'demos/vue-app' ;;
    nuxt-app) printf 'demos/nuxt-app' ;;
    api-demo) printf 'demos/api-demo' ;;
    *) die "unknown demo id: $1" ;;
  esac
}

demo_site_name() {
  case "$1" in
    html-img) printf '%s-html-img' "$PAGES_DEMO_PREFIX" ;;
    vue-app) printf '%s-vue-app' "$PAGES_DEMO_PREFIX" ;;
    nuxt-app) printf '%s-nuxt-app' "$PAGES_DEMO_PREFIX" ;;
    api-demo) printf '%s-api' "$PAGES_DEMO_PREFIX" ;;
    *) die "unknown demo id: $1" ;;
  esac
}

verify_path() {
  case "$1" in
    html-img) printf '/ HTML + Image Demo' ;;
    vue-app) printf '/about id="app"' ;;
    nuxt-app) printf '/ id="__nuxt"' ;;
    api-demo) printf '/about.html 静态资源' ;;
    *) die "unknown demo id: $1" ;;
  esac
}

selected_demos() {
  if [[ -n "$ONLY_DEMO" ]]; then
    demo_preset "$ONLY_DEMO" >/dev/null
    printf '%s\n' "$ONLY_DEMO"
    return
  fi

  printf '%s\n' "${DEMO_IDS[@]}"
}

validate_site_name() {
  local name="$1"
  [[ "$name" =~ ^[a-z0-9][a-z0-9-]{0,48}[a-z0-9]$ ]] || die "invalid generated site name: $name"
}

print_plan() {
  printf 'PAGES_DEMO_TARGET=%s\n' "$PAGES_DEMO_TARGET"
  printf 'PAGES_API=%s\n' "$PAGES_API"
  printf 'PAGES_DEMO_PREFIX=%s\n' "$PAGES_DEMO_PREFIX"
  printf 'PAGES_DEMO_IP_RESTRICT=%s\n' "$PAGES_DEMO_IP_RESTRICT"
  printf '\n'
  printf '%-24s %-8s %-5s %s\n' 'site' 'preset' 'kv' 'source'
  while IFS= read -r demo; do
    local name preset kv_enabled source
    name="$(demo_site_name "$demo")"
    preset="$(demo_preset "$demo")"
    kv_enabled="$(demo_kv_enabled "$demo")"
    source="$(demo_dir "$demo")"
    validate_site_name "$name"
    printf '%-24s %-8s %-5s %s\n' "$name" "$preset" "$kv_enabled" "$source"
  done < <(selected_demos)
}

run_cmd() {
  printf '+ %s\n' "$*" >&2
  "$@" >&2
}

install_and_build() {
  local dir="$1"
  local script="$2"

  if [[ "${PAGES_DEMO_SKIP_INSTALL:-false}" != "true" ]]; then
    if [[ -f "$dir/pnpm-lock.yaml" ]]; then
      run_cmd pnpm --dir "$dir" install --frozen-lockfile
    elif [[ -f "$dir/package-lock.json" ]]; then
      run_cmd npm --prefix "$dir" ci
    else
      run_cmd pnpm --dir "$dir" install
    fi
  fi

  if [[ -f "$dir/pnpm-lock.yaml" ]]; then
    run_cmd pnpm --dir "$dir" run "$script"
  elif [[ -f "$dir/package-lock.json" ]]; then
    run_cmd npm --prefix "$dir" run "$script"
  else
    run_cmd pnpm --dir "$dir" run "$script"
  fi
}

prepare_demo_dir() {
  local demo="$1"
  case "$demo" in
    html-img)
      printf '%s/demos/html-img' "$REPO_ROOT"
      ;;
    vue-app)
      run_cmd pnpm --filter @xd/pages-sdk build
      install_and_build "$REPO_ROOT/demos/vue-app" build
      printf '%s/demos/vue-app/dist' "$REPO_ROOT"
      ;;
    nuxt-app)
      install_and_build "$REPO_ROOT/demos/nuxt-app" generate
      printf '%s/demos/nuxt-app/.output/public' "$REPO_ROOT"
      ;;
    api-demo)
      printf '%s/demos/api-demo' "$REPO_ROOT"
      ;;
    *)
      die "unknown demo id: $demo"
      ;;
  esac
}

json_field() {
  local field="$1"
  node -e '
    const field = process.argv[1];
    let body = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (body += chunk));
    process.stdin.on("end", () => {
      const json = JSON.parse(body);
      if (json[field] == null) process.exit(2);
      process.stdout.write(String(json[field]));
    });
  ' "$field"
}

deploy_dir() {
  local demo="$1"
  local site="$2"
  local preset="$3"
  local dir="$4"

  [[ -d "$dir" ]] || die "build output not found for $demo: $dir"

  local curl_args=(-sS -w $'\n%{http_code}' -X POST -H "X-Pages-Token: ${PAGES_TOKEN}")
  curl_args+=(-F "name=${site}")
  curl_args+=(-F "preset=${preset}")
  curl_args+=(-F "ip_restrict=${PAGES_DEMO_IP_RESTRICT}")
  if [[ "$(demo_kv_enabled "$demo")" == "true" ]]; then
    curl_args+=(-F "kv=true")
  fi

  local count=0
  while IFS= read -r -d '' file; do
    local rel
    rel="${file#"$dir"/}"
    curl_args+=(-F "file-${count}=@${file};filename=${rel}")
    count=$((count + 1))
  done < <(
    find "$dir" -type f \
      ! -path '*/node_modules/*' \
      ! -name '.pages.json' \
      ! -name '.pages.example.json' \
      -print0
  )

  [[ "$count" -gt 0 ]] || die "no files found for $demo in $dir"

  printf '\nDeploying %s -> %s (%s, %s files)\n' "$demo" "$site" "$preset" "$count" >&2
  local response http_code body url
  response="$(curl "${curl_args[@]}" "${PAGES_API}/deploy")"
  http_code="$(printf '%s' "$response" | tail -n 1)"
  body="$(printf '%s' "$response" | sed '$d')"

  if [[ "$http_code" != "200" ]]; then
    printf 'Deploy failed for %s (HTTP %s)\n%s\n' "$demo" "$http_code" "$body" >&2
    return 1
  fi

  url="$(printf '%s' "$body" | json_field url)"
  [[ -n "$url" ]] || die "deploy response for $demo did not include url"
  printf 'Published %s: %s\n' "$demo" "$url" >&2
  printf '%s' "$url"
}

verify_url() {
  local demo="$1"
  local url="$2"
  local spec path expected tmp http_code
  spec="$(verify_path "$demo")"
  path="${spec%% *}"
  expected="${spec#* }"
  tmp="$(mktemp)"

  http_code="$(curl -L -sS -w '%{http_code}' -o "$tmp" "${url}${path}")"
  if [[ "$http_code" != "200" ]]; then
    printf 'Verify failed for %s: %s%s returned HTTP %s\n' "$demo" "$url" "$path" "$http_code" >&2
    rm -f "$tmp"
    return 1
  fi

  if ! grep -q "$expected" "$tmp"; then
    printf 'Verify failed for %s: %s%s did not contain expected text: %s\n' "$demo" "$url" "$path" "$expected" >&2
    rm -f "$tmp"
    return 1
  fi

  rm -f "$tmp"
  printf 'Verified %s: %s%s\n' "$demo" "$url" "$path" >&2
}

if [[ "$DRY_RUN" == "true" ]]; then
  print_plan
  exit 0
fi

print_plan

while IFS= read -r demo; do
  name="$(demo_site_name "$demo")"
  preset="$(demo_preset "$demo")"
  validate_site_name "$name"
  output_dir="$(prepare_demo_dir "$demo")"
  url="$(deploy_dir "$demo" "$name" "$preset" "$output_dir")"
  verify_url "$demo" "$url"
done < <(selected_demos)

printf '\nAll staging demos deployed and verified.\n'
