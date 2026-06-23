#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

SSH_TARGET="${ECS_SSH_TARGET:-}"
REMOTE_DIR="${ECS_REMOTE_DIR:-/opt/pages-manager}"
REMOTE_BUILD_DIR="${ECS_REMOTE_BUILD_DIR:-/opt/pages-manager-build}"
ENV_FILE_REMOTE="${ECS_ENV_FILE_REMOTE:-${REMOTE_DIR}/.env.ecs}"
IMAGE_TAG="${ECS_IMAGE_TAG:-ecs-$(date +%Y%m%d%H%M%S)-$(git -C "${ROOT}" rev-parse --short HEAD)}"
IMAGE_REGISTRY="${ECS_IMAGE_REGISTRY:-local}"
BASE_IMAGE_TAG="${ECS_BASE_IMAGE_TAG:-}"
BASE_IMAGE_TAG_ARG="${BASE_IMAGE_TAG:-__auto__}"
SERVICES_INPUT="${ECS_SERVICES:-gateway slack-notifier}"
RESTART_ALL="${ECS_RESTART_ALL:-false}"
PLATFORM="${ECS_DOCKER_PLATFORM:-linux/amd64}"

ALL_SERVICES=(gateway worker slack-agent slack-notifier)

usage() {
  cat <<'USAGE'
Usage:
  ECS_SSH_TARGET=root@host ECS_SSH_OPTS="-i ~/.ssh/pages-manager-ecs" bash scripts/deploy-ecs.sh

Fast ECS deploy path:
  - uploads source only; never uploads .env files
  - builds selected service images on ECS
  - reuses the previous ECS image as the offline pnpm base when available
  - updates PAGES_IMAGE_TAG in the remote .env.ecs

Environment:
  ECS_SSH_TARGET       Required. SSH target for the ECS host.
  ECS_SSH_OPTS         Optional. Extra ssh options, for example "-i ~/.ssh/pages-manager-ecs -o BatchMode=yes".
  ECS_REMOTE_DIR       Optional. Runtime dir. Default: /opt/pages-manager.
  ECS_REMOTE_BUILD_DIR Optional. Remote build cache dir. Default: /opt/pages-manager-build.
  ECS_ENV_FILE_REMOTE  Optional. Remote private env file. Default: <ECS_REMOTE_DIR>/.env.ecs.
  ECS_IMAGE_TAG        Optional. Default: ecs-<local timestamp>-<git sha>.
  ECS_IMAGE_REGISTRY   Optional. Default: local. Current ECS uses local images.
  ECS_BASE_IMAGE_TAG   Optional. Previous tag used as offline build base. Defaults to remote PAGES_IMAGE_TAG.
  ECS_SERVICES         Optional. Space/comma separated services or "all". Default: "gateway slack-notifier".
  ECS_RESTART_ALL      Optional. true/false. Default: false.
  ECS_DOCKER_PLATFORM  Optional. Default: linux/amd64.

Examples:
  ECS_SSH_TARGET=root@123.56.251.50 ECS_SSH_OPTS="-i ~/.ssh/pages-manager-ecs" bash scripts/deploy-ecs.sh
  ECS_SSH_TARGET=root@123.56.251.50 ECS_SSH_OPTS="-i ~/.ssh/pages-manager-ecs" ECS_SERVICES=all bash scripts/deploy-ecs.sh
USAGE
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -z "${SSH_TARGET}" ]]; then
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

read -r -a SSH_OPTS <<<"${ECS_SSH_OPTS:-}"

ssh_ecs() {
  ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "$@"
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

echo "[ecs] target: ${SSH_TARGET}"
echo "[ecs] remote dir: ${REMOTE_DIR}"
echo "[ecs] remote build dir: ${REMOTE_BUILD_DIR}"
echo "[ecs] image registry: ${IMAGE_REGISTRY}"
echo "[ecs] image tag: ${IMAGE_TAG}"
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
    --exclude='.ack-preview.env' \
    --exclude='.ack_preview.env' \
    --exclude='.ack*.env' \
    --exclude='*.tar.gz' \
    --exclude='.DS_Store' \
    --exclude='._*' \
    -czf - .
) | ssh "${SSH_OPTS[@]}" "${SSH_TARGET}" "set -euo pipefail; rm -rf '${REMOTE_BUILD_DIR}/${IMAGE_TAG}'; mkdir -p '${REMOTE_BUILD_DIR}/${IMAGE_TAG}'; LC_ALL=C tar -xzf - -C '${REMOTE_BUILD_DIR}/${IMAGE_TAG}'"

echo "[ecs] build and deploy on remote host"
ssh_ecs "bash -s" -- \
  "${REMOTE_DIR}" \
  "${REMOTE_BUILD_DIR}" \
  "${ENV_FILE_REMOTE}" \
  "${IMAGE_TAG}" \
  "${IMAGE_REGISTRY}" \
  "${BASE_IMAGE_TAG_ARG}" \
  "${RESTART_ALL}" \
  "${PLATFORM}" \
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
shift 8
selected_services=("$@")
all_services=(gateway worker slack-agent slack-notifier)
release_dir="${remote_build_dir}/${image_tag}"

if [[ "$base_image_tag" == "__auto__" ]]; then
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

update_env() {
  local key="$1"
  local value="$2"
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
  ' "$env_file" >"$tmp"
  cat "$tmp" >"$env_file"
  rm -f "$tmp"
}

test -d "$release_dir"
test -f "$env_file"

if [[ -z "$base_image_tag" ]]; then
  base_image_tag="$(sed -n 's/^PAGES_IMAGE_TAG=//p' "$env_file" | tail -1 || true)"
fi

cat >"${release_dir}/Dockerfile.node-service.offline" <<'DOCKERFILE'
ARG NODE_IMAGE
FROM ${NODE_IMAGE} AS runtime
ARG SERVICE
WORKDIR /app
ENV NODE_ENV=production
ENV PAGES_SERVICE=${SERVICE}
RUN rm -rf /app/apps /app/packages /app/node_modules /app/package.json /app/pnpm-lock.yaml /app/pnpm-workspace.yaml
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
    echo "[ecs:remote] missing base image for ${service}; falling back to online build"
    docker build \
      --platform "$platform" \
      -f "${release_dir}/Dockerfile.node-service" \
      --build-arg "SERVICE=${service}" \
      -t "$target_image" \
      "$release_dir"
  fi
done

for service in "${all_services[@]}"; do
  target_image="$(image_for "$service" "$image_tag")"
  if docker image inspect "$target_image" >/dev/null 2>&1; then
    continue
  fi

  base_image="$(image_for "$service" "$base_image_tag")"
  if [[ -n "$base_image_tag" ]] && docker image inspect "$base_image" >/dev/null 2>&1; then
    echo "[ecs:remote] retag unchanged ${service}: ${base_image_tag} -> ${image_tag}"
    docker tag "$base_image" "$target_image"
  fi
done

cp "$env_file" "${env_file}.bak.$(date +%Y%m%d%H%M%S)"
update_env PAGES_IMAGE_REGISTRY "$image_registry"
update_env PAGES_IMAGE_TAG "$image_tag"

compose_services=()
if [[ "$restart_all" == "true" || "$restart_all" == "1" || "$restart_all" == "yes" ]]; then
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

cd "$remote_dir"
if [[ "$restart_all" == "true" || "$restart_all" == "1" || "$restart_all" == "yes" ]]; then
  docker compose --env-file "$env_file" -f docker-compose.ecs.yml up -d --force-recreate "${compose_services[@]}"
else
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
    docker compose --env-file "$env_file" -f docker-compose.ecs.yml up -d --force-recreate --no-deps "${app_compose_services[@]}"
  fi
  if [[ "$should_restart_caddy" == "true" ]]; then
    docker compose --env-file "$env_file" -f docker-compose.ecs.yml up -d --force-recreate --no-deps caddy
  fi
fi
ready_ok=false
for _ in $(seq 1 30); do
  if curl -fsS http://127.0.0.1:80/ready >/dev/null; then
    ready_ok=true
    break
  fi
  sleep 2
done

docker compose --env-file "$env_file" -f docker-compose.ecs.yml ps
if [[ "$ready_ok" != "true" ]]; then
  echo "[ecs:remote] gateway did not become ready in time" >&2
  docker compose --env-file "$env_file" -f docker-compose.ecs.yml logs --tail=120 pages-gateway caddy >&2 || true
  exit 1
fi
echo "[ecs:remote] ready ok"
REMOTE

echo "[ecs] done"
