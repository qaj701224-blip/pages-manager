#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SSH_TARGET="${ECS_SSH_TARGET:-}"
DEPLOY_MODE="${ECS_DEPLOY_MODE:-ssh}"
REMOTE_DIR="${ECS_REMOTE_DIR:-/opt/pages-manager}"
REMOTE_BUILD_DIR="${ECS_REMOTE_BUILD_DIR:-/opt/pages-manager-build}"
ENV_FILE_REMOTE="${ECS_ENV_FILE_REMOTE:-${REMOTE_DIR}/.env.ecs}"
IMAGE_TAG="${ECS_IMAGE_TAG:-ecs-$(date +%Y%m%d%H%M%S)-$(git -C "${ROOT}" rev-parse --short HEAD)}"
IMAGE_REGISTRY="${ECS_IMAGE_REGISTRY:-local}"
BASE_IMAGE_TAG="${ECS_BASE_IMAGE_TAG:-}"
BASE_IMAGE_TAG_ARG="${BASE_IMAGE_TAG:-__empty__}"
NODE_IMAGE="${ECS_NODE_IMAGE:-node:22-bookworm-slim}"
BUILD_FROM_PREVIOUS="${ECS_BUILD_FROM_PREVIOUS:-false}"
SERVICES_INPUT="${ECS_SERVICES:-all}"
RESTART_ALL="${ECS_RESTART_ALL:-false}"
PLATFORM="${ECS_DOCKER_PLATFORM:-linux/amd64}"
SMOKE_TIMEOUT_SECONDS="${ECS_SMOKE_TIMEOUT_SECONDS:-120}"
IMAGE_RETENTION="${ECS_IMAGE_RETENTION:-5}"
BUILD_DIR_RETENTION="${ECS_BUILD_DIR_RETENTION:-5}"
UPDATE_LATEST_ALIAS="${ECS_UPDATE_LATEST_ALIAS:-false}"
LATEST_ALIAS_TAG="${ECS_LATEST_ALIAS_TAG:-latest}"

ALL_SERVICES=(gateway worker slack-agent slack-notifier)

usage() {
  cat <<'USAGE'
Usage:
  ECS_SSH_TARGET=root@host ECS_SSH_OPTS="-i ~/.ssh/pages-manager-ecs" bash scripts/deploy-ecs.sh

Fast ECS deploy path:
  - uploads source only; never uploads .env files
  - builds selected service images on ECS with an immutable tag
  - deploys with a candidate env file, then writes .env.ecs only after smoke passes
  - rolls back .env.ecs and services if deployment smoke fails
  - checks gateway, worker, slack-agent, and slack-notifier before success
  - falls back to the previous ECS app image if the stable Node base cannot be pulled

Environment:
  ECS_DEPLOY_MODE      Optional. ssh/local. Default: ssh. Use local on an ECS self-hosted runner.
  ECS_SSH_TARGET       Required. SSH target for the ECS host.
  ECS_SSH_OPTS         Optional. Extra ssh options, for example "-i ~/.ssh/pages-manager-ecs -o BatchMode=yes".
  ECS_REMOTE_DIR       Optional. Runtime dir. Default: /opt/pages-manager.
  ECS_REMOTE_BUILD_DIR Optional. Remote build cache dir. Default: /opt/pages-manager-build.
  ECS_ENV_FILE_REMOTE  Optional. Remote private env file. Default: <ECS_REMOTE_DIR>/.env.ecs.
  ECS_IMAGE_TAG        Optional. Default: ecs-<local timestamp>-<git sha>.
  ECS_IMAGE_REGISTRY   Optional. Default: local. Current ECS uses local images.
  ECS_NODE_IMAGE       Optional. Node base image for stable builds. Default: node:22-bookworm-slim.
  ECS_BASE_IMAGE_TAG   Optional. Existing app tag used as offline build base only when explicitly set.
  ECS_BUILD_FROM_PREVIOUS Optional. true/false. Reuse remote PAGES_IMAGE_TAG as offline build base. Default: false.
  ECS_SERVICES         Optional. Space/comma separated services or "all". Default: all.
  ECS_RESTART_ALL      Optional. true/false. Default: false.
  ECS_DOCKER_PLATFORM  Optional. Default: linux/amd64.
  ECS_SMOKE_TIMEOUT_SECONDS Optional. Default: 120.
  ECS_IMAGE_RETENTION  Optional. Immutable app image tags to retain per service, excluding current/rollback. Default: 5.
  ECS_BUILD_DIR_RETENTION Optional. Uploaded release dirs to retain, excluding current/rollback. Default: 5.
  ECS_UPDATE_LATEST_ALIAS Optional. true/false. Also retag app images as ECS_LATEST_ALIAS_TAG. Default: false.
  ECS_LATEST_ALIAS_TAG Optional. Default: latest.

Examples:
  ECS_SSH_TARGET=root@123.56.251.50 ECS_SSH_OPTS="-i ~/.ssh/pages-manager-ecs" bash scripts/deploy-ecs.sh
  ECS_SSH_TARGET=root@123.56.251.50 ECS_SSH_OPTS="-i ~/.ssh/pages-manager-ecs" ECS_SERVICES=all bash scripts/deploy-ecs.sh
  ECS_DEPLOY_MODE=local ECS_SERVICES=all bash scripts/deploy-ecs.sh
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

case "${DEPLOY_MODE}" in
  ssh | local) ;;
  *)
    echo "error: ECS_DEPLOY_MODE must be ssh or local" >&2
    exit 1
    ;;
esac

if [[ "${DEPLOY_MODE}" == "ssh" && -z "${SSH_TARGET}" ]]; then
  usage >&2
  echo "error: ECS_SSH_TARGET is required" >&2
  exit 1
fi

if [[ ! "${IMAGE_TAG}" =~ ^[A-Za-z0-9._-]{1,120}$ ]]; then
  echo "error: ECS_IMAGE_TAG contains unsupported characters: ${IMAGE_TAG}" >&2
  exit 1
fi

if [[ "${IMAGE_REGISTRY}" == */ ]]; then
  echo "error: ECS_IMAGE_REGISTRY must not end with /" >&2
  exit 1
fi

if [[ ! "${LATEST_ALIAS_TAG}" =~ ^[A-Za-z0-9._-]{1,120}$ ]]; then
  echo "error: ECS_LATEST_ALIAS_TAG contains unsupported characters: ${LATEST_ALIAS_TAG}" >&2
  exit 1
fi

for numeric_value in SMOKE_TIMEOUT_SECONDS IMAGE_RETENTION BUILD_DIR_RETENTION; do
  if [[ ! "${!numeric_value}" =~ ^[0-9]+$ ]]; then
    echo "error: ${numeric_value} must be a non-negative integer" >&2
    exit 1
  fi
done

read -r -a SSH_OPTS <<<"${ECS_SSH_OPTS:-}"

ssh_ecs() {
  ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "$@"
}

run_target_shell() {
  if [[ "${DEPLOY_MODE}" == "local" ]]; then
    bash -c "$1"
  else
    ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "$1"
  fi
}

run_target_script() {
  if [[ "${DEPLOY_MODE}" == "local" ]]; then
    bash -s -- "$@"
  else
    ssh_ecs "bash -s" -- "$@"
  fi
}

is_all_service() {
  [[ " ${ALL_SERVICES[*]} " == *" $1 "* ]]
}

normalize_services() {
  local raw="${SERVICES_INPUT//,/ }"
  local selected=()

  if [[ "${raw}" =~ (^|[[:space:]])all($|[[:space:]]) ]]; then
    selected=("${ALL_SERVICES[@]}")
  else
    read -r -a selected <<<"${raw}"
  fi

  if [[ "${#selected[@]}" -eq 0 ]]; then
    echo "error: ECS_SERVICES resolved to an empty service list" >&2
    exit 1
  fi

  for service in "${selected[@]}"; do
    if ! is_all_service "${service}"; then
      echo "error: unsupported service '${service}'. Use one of: ${ALL_SERVICES[*]}, all" >&2
      exit 1
    fi
  done

  printf '%s\n' "${selected[@]}"
}

remote_image() {
  local service="$1"
  local tag="$2"
  printf '%s/pages-manager/%s:%s' "${IMAGE_REGISTRY}" "${service}" "${tag}"
}

SELECTED_SERVICES=()
while IFS= read -r service; do
  SELECTED_SERVICES+=("${service}")
done < <(normalize_services)

echo "[ecs] deploy mode: ${DEPLOY_MODE}"
if [[ "${DEPLOY_MODE}" == "ssh" ]]; then
  echo "[ecs] target: ${SSH_TARGET}"
else
  echo "[ecs] target: local host"
fi
echo "[ecs] remote dir: ${REMOTE_DIR}"
echo "[ecs] remote build dir: ${REMOTE_BUILD_DIR}"
echo "[ecs] image registry: ${IMAGE_REGISTRY}"
echo "[ecs] image tag: ${IMAGE_TAG}"
echo "[ecs] node image: ${NODE_IMAGE}"
echo "[ecs] services: ${SELECTED_SERVICES[*]}"

echo "[ecs] sync source to remote build dir"
(
  cd "${ROOT}"
  COPYFILE_DISABLE=1 tar \
    --no-xattrs \
    --exclude='.git' \
    --exclude='.wrangler' \
    --exclude='node_modules' \
    --exclude='*/node_modules' \
    --exclude='*/node_modules/*' \
    --exclude='.env' \
    --exclude='.env.*' \
    --exclude='.dev.vars' \
    --exclude='*/.dev.vars' \
    --exclude='.ack-preview.env' \
    --exclude='.ack_preview.env' \
    --exclude='.ack*.env' \
    --exclude='.staging.env' \
    --exclude='.pages.json' \
    --exclude='*/.pages.json' \
    --exclude='wrangler.toml' \
    --exclude='*/wrangler.toml' \
    --exclude='*.tar.gz' \
    --exclude='.DS_Store' \
    --exclude='._*' \
    -czf - .
) | run_target_shell "set -euo pipefail; rm -rf '${REMOTE_BUILD_DIR}/${IMAGE_TAG}'; mkdir -p '${REMOTE_BUILD_DIR}/${IMAGE_TAG}'; LC_ALL=C tar -xzf - -C '${REMOTE_BUILD_DIR}/${IMAGE_TAG}'"

echo "[ecs] build and deploy on remote host"
run_target_script \
  "${REMOTE_DIR}" \
  "${REMOTE_BUILD_DIR}" \
  "${ENV_FILE_REMOTE}" \
  "${IMAGE_TAG}" \
  "${IMAGE_REGISTRY}" \
  "${BASE_IMAGE_TAG_ARG}" \
  "${RESTART_ALL}" \
  "${PLATFORM}" \
  "${NODE_IMAGE}" \
  "${BUILD_FROM_PREVIOUS}" \
  "${SMOKE_TIMEOUT_SECONDS}" \
  "${IMAGE_RETENTION}" \
  "${BUILD_DIR_RETENTION}" \
  "${UPDATE_LATEST_ALIAS}" \
  "${LATEST_ALIAS_TAG}" \
  "${SELECTED_SERVICES[@]}" <<'REMOTE'
set -euo pipefail

remote_dir="$1"
remote_build_dir="$2"
env_file="$3"
image_tag="$4"
image_registry="$5"
base_image_tag="$6"
restart_all="$7"
platform="$8"
node_image="$9"
build_from_previous="${10}"
smoke_timeout_seconds="${11}"
image_retention="${12}"
build_dir_retention="${13}"
update_latest_alias="${14}"
latest_alias_tag="${15}"
shift 15
selected_services=("$@")
all_services=(gateway worker slack-agent slack-notifier)
release_dir="${remote_build_dir}/${image_tag}"
compose_env_file="$env_file"

if [[ "$base_image_tag" == "__empty__" ]]; then
  base_image_tag=""
fi

image_for() {
  local service="$1"
  local tag="$2"
  printf '%s/pages-manager/%s:%s' "$image_registry" "$service" "$tag"
}

compose_service_for() {
  case "$1" in
    gateway) echo pages-gateway ;;
    worker) echo pages-worker ;;
    slack-agent) echo slack-agent ;;
    slack-notifier) echo slack-notifier ;;
    *) echo "$1" ;;
  esac
}

contains_service() {
  local needle="$1"
  shift
  local item
  for item in "$@"; do
    [[ "$item" == "$needle" ]] && return 0
  done
  return 1
}

is_truthy() {
  case "$1" in
    true | TRUE | 1 | yes | YES | y | Y) return 0 ;;
    *) return 1 ;;
  esac
}

update_env_file() {
  local target_file="$1"
  local key="$2"
  local value="$3"
  local tmp
  tmp="$(mktemp)"
  awk -v key="$key" -v value="$value" '
    BEGIN { done = 0 }
    $0 ~ "^" key "=" {
      print key "=" value
      done = 1
      next
    }
    { print }
    END {
      if (!done) print key "=" value
    }
  ' "$target_file" >"$tmp"
  cat "$tmp" >"$target_file"
  rm -f "$tmp"
}

update_env() {
  local key="$1"
  local value="$2"
  update_env_file "$env_file" "$key" "$value"
}

backup_runtime_files() {
  runtime_backup_dir="${remote_dir}/.deploy-backups/${image_tag}"
  mkdir -p "$runtime_backup_dir/deploy/ecs"

  cp "$env_file" "$runtime_backup_dir/.env.ecs"
  if [[ -f "${remote_dir}/docker-compose.ecs.yml" ]]; then
    cp "${remote_dir}/docker-compose.ecs.yml" "$runtime_backup_dir/docker-compose.ecs.yml"
  fi
  if [[ -f "${remote_dir}/Dockerfile.node-service" ]]; then
    cp "${remote_dir}/Dockerfile.node-service" "$runtime_backup_dir/Dockerfile.node-service"
  fi
  if [[ -f "${remote_dir}/deploy/ecs/Caddyfile" ]]; then
    cp "${remote_dir}/deploy/ecs/Caddyfile" "$runtime_backup_dir/deploy/ecs/Caddyfile"
  fi
}

restore_runtime_files() {
  if [[ -z "${runtime_backup_dir:-}" || ! -d "$runtime_backup_dir" ]]; then
    return 0
  fi

  if [[ -f "$runtime_backup_dir/.env.ecs" ]]; then
    cat "$runtime_backup_dir/.env.ecs" >"$env_file"
  fi
  if [[ -f "$runtime_backup_dir/docker-compose.ecs.yml" ]]; then
    cp "$runtime_backup_dir/docker-compose.ecs.yml" "${remote_dir}/docker-compose.ecs.yml"
  fi
  if [[ -f "$runtime_backup_dir/Dockerfile.node-service" ]]; then
    cp "$runtime_backup_dir/Dockerfile.node-service" "${remote_dir}/Dockerfile.node-service"
  fi
  if [[ -f "$runtime_backup_dir/deploy/ecs/Caddyfile" ]]; then
    mkdir -p "${remote_dir}/deploy/ecs"
    cp "$runtime_backup_dir/deploy/ecs/Caddyfile" "${remote_dir}/deploy/ecs/Caddyfile"
  fi
}

cleanup_runtime_backup() {
  if [[ -n "${runtime_backup_dir:-}" && -d "$runtime_backup_dir" ]]; then
    rm -rf "$runtime_backup_dir" || echo "[ecs:remote] warning: failed to remove runtime backup ${runtime_backup_dir}" >&2
  fi
}

on_deploy_error() {
  local status=$?
  if [[ "${deploy_completed:-false}" != "true" && "${rollback_started:-false}" != "true" ]]; then
    rollback_env_and_services || true
  fi
  exit "$status"
}

compose_up_services() {
  if [[ "${#compose_services[@]}" -eq 0 ]]; then
    return 0
  fi

  if is_truthy "$restart_all"; then
    docker compose --env-file "$compose_env_file" -f docker-compose.ecs.yml up -d --force-recreate "${compose_services[@]}"
    return
  fi

  app_compose_services=()
  should_restart_caddy=false
  for service in "${compose_services[@]}"; do
    if [[ "$service" == "caddy" ]]; then
      should_restart_caddy=true
    else
      app_compose_services+=("$service")
    fi
  done

  if [[ "${#app_compose_services[@]}" -gt 0 ]]; then
    docker compose --env-file "$compose_env_file" -f docker-compose.ecs.yml up -d --force-recreate --no-deps "${app_compose_services[@]}"
  fi
  if [[ "$should_restart_caddy" == "true" ]]; then
    docker compose --env-file "$compose_env_file" -f docker-compose.ecs.yml up -d --force-recreate --no-deps caddy
  fi
}

probe_internal_services() {
  docker compose --env-file "$compose_env_file" -f docker-compose.ecs.yml exec -T pages-gateway node --input-type=module <<'NODE'
const checks = [
  ['gateway ready', 'http://127.0.0.1:8788/ready'],
  ['worker health', 'http://pages-worker:8790/health'],
  ['slack-agent health', 'http://slack-agent:8791/health'],
  ['slack-notifier health', 'http://slack-notifier:8792/health'],
];

for (const [name, url] of checks) {
  const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) {
    throw new Error(`${name} failed: ${response.status}`);
  }
  const body = await response.text();
  console.log(`[ecs:smoke] ${name} ok ${body.slice(0, 180)}`);
}
NODE
}

smoke_services() {
  local deadline=$((SECONDS + smoke_timeout_seconds))

  while (( SECONDS <= deadline )); do
    if curl -fsS http://127.0.0.1:80/ready >/dev/null && probe_internal_services; then
      return 0
    fi
    sleep 2
  done

  return 1
}

rollback_env_and_services() {
  rollback_started=true
  echo "[ecs:remote] rollback to ${previous_image_tag:-previous runtime tag}" >&2
  if [[ -n "${candidate_env_file:-}" ]]; then
    rm -f "$candidate_env_file"
  fi

  restore_runtime_files

  if [[ ! -f "$env_file" ]]; then
    if [[ -n "${previous_image_registry:-}" ]]; then
      update_env PAGES_IMAGE_REGISTRY "$previous_image_registry"
    fi
    if [[ -n "${previous_image_tag:-}" ]]; then
      update_env PAGES_IMAGE_TAG "$previous_image_tag"
    fi
  fi

  compose_env_file="$env_file"
  cd "$remote_dir"
  compose_up_services || true
  docker compose --env-file "$compose_env_file" -f docker-compose.ecs.yml ps || true
  cleanup_runtime_backup
}

print_deploy_logs() {
  docker compose --env-file "$compose_env_file" -f docker-compose.ecs.yml logs \
    --tail=160 \
    pages-gateway pages-worker slack-agent slack-notifier caddy >&2 || true
}

cleanup_old_images() {
  [[ "$image_retention" == "0" ]] && return 0

  local service repo tag image_id kept
  for service in "${all_services[@]}"; do
    repo="${image_registry}/pages-manager/${service}"
    kept=0
    while read -r tag image_id; do
      [[ -z "$tag" || "$tag" == "<none>" ]] && continue
      [[ "$tag" == "$image_tag" || "$tag" == "$previous_image_tag" || "$tag" == "$latest_alias_tag" ]] && continue
      [[ -n "$base_image_tag" && "$tag" == "$base_image_tag" ]] && continue
      [[ "$tag" =~ ^ecs- ]] || continue

      kept=$((kept + 1))
      if (( kept > image_retention )); then
        echo "[ecs:remote] prune old image ${repo}:${tag}"
        docker image rm "${repo}:${tag}" >/dev/null 2>&1 || true
      fi
    done < <(docker image ls "$repo" --format '{{.Tag}} {{.ID}}')
  done
}

cleanup_old_release_dirs() {
  [[ "$build_dir_retention" == "0" ]] && return 0
  [[ -d "$remote_build_dir" ]] || return 0

  local kept=0
  local dir tag
  while read -r dir; do
    [[ -n "$dir" ]] || continue
    tag="$(basename "$dir")"
    [[ "$tag" == "$image_tag" || "$tag" == "$previous_image_tag" ]] && continue
    kept=$((kept + 1))
    if (( kept > build_dir_retention )); then
      echo "[ecs:remote] prune old release dir ${dir}"
      rm -rf "$dir" || echo "[ecs:remote] warning: failed to prune old release dir ${dir}" >&2
    fi
  done < <(find "$remote_build_dir" -maxdepth 1 -mindepth 1 -type d -name 'ecs-*' | sort -r)
}

test -d "$release_dir"
test -f "$env_file"

previous_image_registry="$(sed -n 's/^PAGES_IMAGE_REGISTRY=//p' "$env_file" | tail -1 || true)"
previous_image_tag="$(sed -n 's/^PAGES_IMAGE_TAG=//p' "$env_file" | tail -1 || true)"

if [[ -z "$base_image_tag" ]] && is_truthy "$build_from_previous"; then
  base_image_tag="$previous_image_tag"
fi

fallback_base_image_tag=""
if [[ -z "$base_image_tag" && -n "$previous_image_tag" ]]; then
  fallback_base_image_tag="$previous_image_tag"
fi

compose_services=()
backup_runtime_files
deploy_completed=false
rollback_started=false
trap on_deploy_error ERR

cat >"${release_dir}/Dockerfile.node-service.offline" <<'DOCKERFILE'
ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS runtime
ARG SERVICE
WORKDIR /app
ENV NODE_ENV=production
ENV PAGES_SERVICE=${SERVICE}
RUN rm -rf /app/apps /app/packages /app/node_modules /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml
RUN rm -rf /app/docs /app/scripts /app/.github
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps ./apps
COPY packages ./packages
COPY docs ./docs
COPY scripts ./scripts
COPY .github ./.github
RUN pnpm install --frozen-lockfile --prod --offline
CMD ["sh", "-c", "pnpm --filter @xd/${PAGES_SERVICE} dev"]
DOCKERFILE

mkdir -p "${remote_dir}/deploy/ecs"
cp "${release_dir}/docker-compose.ecs.yml" "${remote_dir}/docker-compose.ecs.yml"
cp "${release_dir}/deploy/ecs/Caddyfile" "${remote_dir}/deploy/ecs/Caddyfile"
cp "${release_dir}/Dockerfile.node-service" "${remote_dir}/Dockerfile.node-service"

for service in "${selected_services[@]}"; do
  target_image="$(image_for "$service" "$image_tag")"
  base_image="$(image_for "$service" "$base_image_tag")"
  echo "[ecs:remote] build ${service} -> ${target_image}"

  if [[ -n "$base_image_tag" ]] && docker image inspect "$base_image" >/dev/null 2>&1; then
    docker build \
      --platform "$platform" \
      -f "${release_dir}/Dockerfile.node-service.offline" \
      --build-arg "NODE_IMAGE=${base_image}" \
      --build-arg "SERVICE=${service}" \
      -t "$target_image" \
      "$release_dir"
  else
    echo "[ecs:remote] build ${service} from ${node_image}"
    if docker build \
      --platform "$platform" \
      -f "${release_dir}/Dockerfile.node-service" \
      --build-arg "NODE_IMAGE=${node_image}" \
      --build-arg "SERVICE=${service}" \
      -t "$target_image" \
      "$release_dir"; then
      :
    elif [[ -n "$fallback_base_image_tag" ]] && docker image inspect "$(image_for "$service" "$fallback_base_image_tag")" >/dev/null 2>&1; then
      echo "[ecs:remote] stable Node build failed; retry ${service} from ${fallback_base_image_tag}" >&2
      docker build \
        --platform "$platform" \
        -f "${release_dir}/Dockerfile.node-service.offline" \
        --build-arg "NODE_IMAGE=$(image_for "$service" "$fallback_base_image_tag")" \
        --build-arg "SERVICE=${service}" \
        -t "$target_image" \
        "$release_dir"
    else
      exit 1
    fi
  fi
done

for service in "${all_services[@]}"; do
  target_image="$(image_for "$service" "$image_tag")"
  if docker image inspect "$target_image" >/dev/null 2>&1; then
    continue
  fi

  base_image="$(image_for "$service" "$previous_image_tag")"
  if [[ -n "$previous_image_tag" ]] && docker image inspect "$base_image" >/dev/null 2>&1; then
    echo "[ecs:remote] retag unchanged ${service}: ${previous_image_tag} -> ${image_tag}"
    docker tag "$base_image" "$target_image"
  fi
done

missing_images=()
for service in "${all_services[@]}"; do
  target_image="$(image_for "$service" "$image_tag")"
  if ! docker image inspect "$target_image" >/dev/null 2>&1; then
    missing_images+=("$target_image")
  fi
done

if [[ "${#missing_images[@]}" -gt 0 ]]; then
  echo "[ecs:remote] missing app images for deploy tag:" >&2
  printf '  %s\n' "${missing_images[@]}" >&2
  exit 1
fi

if is_truthy "$update_latest_alias"; then
  for service in "${all_services[@]}"; do
    docker tag "$(image_for "$service" "$image_tag")" "$(image_for "$service" "$latest_alias_tag")"
  done
fi

if is_truthy "$restart_all"; then
  for service in "${all_services[@]}"; do
    compose_services+=("$(compose_service_for "$service")")
  done
else
  for service in "${selected_services[@]}"; do
    compose_services+=("$(compose_service_for "$service")")
  done
fi

if contains_service pages-gateway "${compose_services[@]}"; then
  compose_services+=(caddy)
fi

candidate_env_file="${env_file}.candidate.${image_tag}"
cp "$env_file" "$candidate_env_file"
update_env_file "$candidate_env_file" PAGES_IMAGE_REGISTRY "$image_registry"
update_env_file "$candidate_env_file" PAGES_IMAGE_TAG "$image_tag"
compose_env_file="$candidate_env_file"

cd "$remote_dir"

if ! compose_up_services; then
  echo "[ecs:remote] compose up failed" >&2
  print_deploy_logs
  rollback_env_and_services
  false
fi

docker compose --env-file "$compose_env_file" -f docker-compose.ecs.yml ps
if ! smoke_services; then
  echo "[ecs:remote] deployment smoke did not pass in ${smoke_timeout_seconds}s" >&2
  print_deploy_logs
  rollback_env_and_services
  false
fi

cat "$candidate_env_file" >"$env_file"
rm -f "$candidate_env_file"
cleanup_runtime_backup
deploy_completed=true

cleanup_old_images
cleanup_old_release_dirs

echo "[ecs:remote] deployment smoke ok"
REMOTE

echo "[ecs] done"
