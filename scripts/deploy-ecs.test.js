import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readRepoFile(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('ECS deploy script is valid bash', () => {
  for (const script of ['scripts/deploy-ecs.sh', 'scripts/detect-ecs-deploy.sh']) {
    const result = spawnSync('bash', ['-n', script], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
});

test('ECS deploy uses immutable full-service deployment defaults', () => {
  const script = readRepoFile('scripts/deploy-ecs.sh');
  const envExample = readRepoFile('.env.ecs.example');

  assert.match(script, /DEPLOY_MODE="\$\{ECS_DEPLOY_MODE:-ssh\}"/);
  assert.match(
    script,
    /IMAGE_TAG="\$\{ECS_IMAGE_TAG:-ecs-\$\(date \+%Y%m%d%H%M%S\)-\$\(git -C "\$\{ROOT\}" rev-parse --short HEAD\)\}"/
  );
  assert.match(script, /SERVICES_INPUT="\$\{ECS_SERVICES:-all\}"/);
  assert.match(script, /BASE_IMAGE_TAG_ARG="\$\{BASE_IMAGE_TAG:-__empty__\}"/);
  assert.match(script, /BUILD_FROM_PREVIOUS="\$\{ECS_BUILD_FROM_PREVIOUS:-false\}"/);
  assert.match(script, /UPDATE_LATEST_ALIAS="\$\{ECS_UPDATE_LATEST_ALIAS:-false\}"/);
  assert.match(script, /LATEST_ALIAS_TAG="\$\{ECS_LATEST_ALIAS_TAG:-latest\}"/);
  assert.match(script, /IMAGE_REGISTRY="\$\{ECS_IMAGE_REGISTRY:-\}"/);
  assert.match(script, /IMAGE_RETENTION="\$\{ECS_IMAGE_RETENTION:-5\}"/);
  assert.match(script, /BUILD_DIR_RETENTION="\$\{ECS_BUILD_DIR_RETENTION:-5\}"/);
  assert.match(script, /RUNTIME_BACKUP_RETENTION="\$\{ECS_RUNTIME_BACKUP_RETENTION:-0\}"/);
  assert.match(script, /image_registry="\$previous_image_registry"/);
  assert.match(script, /PAGES_IMAGE_REGISTRY is missing from \$\{env_file\}/);
  assert.match(script, /image registry: \$\{IMAGE_REGISTRY:-<preserve existing \.env\.ecs value>\}/);
  assert.match(envExample, /^PAGES_IMAGE_TAG=ecs-YYYYMMDDHHMMSS-sha$/m);
  assert.doesNotMatch(envExample, /^PAGES_IMAGE_TAG=latest$/m);
});

test('ECS deploy supports local mode for self-hosted runner deploys', () => {
  const script = readRepoFile('scripts/deploy-ecs.sh');

  assert.match(script, /ECS_DEPLOY_MODE {6}Optional\. ssh\/local/);
  assert.match(script, /case "\$\{DEPLOY_MODE\}" in\n {2}ssh \| local/);
  assert.match(script, /if \[\[ "\$\{DEPLOY_MODE\}" == "ssh" && -z "\$\{SSH_TARGET\}" \]\]; then/);
  assert.match(script, /run_target_shell\(\)/);
  assert.match(script, /if \[\[ "\$\{DEPLOY_MODE\}" == "local" \]\]; then\n {4}bash -c "\$1"/);
  assert.match(script, /run_target_script\(\)/);
  assert.match(script, /if \[\[ "\$\{DEPLOY_MODE\}" == "local" \]\]; then\n {4}bash -s -- "\$@"/);
  assert.match(script, /ECS_DEPLOY_MODE=local ECS_SERVICES=all bash scripts\/deploy-ecs\.sh/);
  assert.match(script, /\| run_target_shell "set -euo pipefail;/);
  assert.match(script, /run_target_script \\\n {2}"\$\{REMOTE_DIR\}"/);
});

test('ECS deploy builds from stable Node image unless previous app image is explicitly requested', () => {
  const script = readRepoFile('scripts/deploy-ecs.sh');
  const dockerfile = readRepoFile('Dockerfile.node-service');

  assert.match(script, /NODE_IMAGE="\$\{ECS_NODE_IMAGE:-node:22-bookworm-slim\}"/);
  assert.match(script, /if \[\[ "\$base_image_tag" == "__empty__" \]\]; then/);
  assert.match(script, /if \[\[ -z "\$base_image_tag" \]\] && is_truthy "\$build_from_previous"; then/);
  assert.match(script, /fallback_base_image_tag="\$previous_image_tag"/);
  assert.doesNotMatch(
    script,
    /base_image_tag="\$\(sed -n 's\/\^PAGES_IMAGE_TAG=\/\/p' "\$env_file" \| tail -1 \|\| true\)"/
  );
  assert.match(script, /--build-arg "NODE_IMAGE=\$\{node_image\}"/);
  assert.match(script, /stable Node build failed; retry \$\{service\} from \$\{fallback_base_image_tag\}/);
  assert.match(script, /--build-arg "NODE_IMAGE=\$\(image_for "\$service" "\$fallback_base_image_tag"\)"/);
  assert.match(dockerfile, /RUN corepack enable && corepack prepare pnpm@\$\{PNPM_VERSION\} --activate/);
  assert.match(
    dockerfile,
    /RUN rm -rf \/app\/apps \/app\/packages \/app\/docs \/app\/scripts \/app\/\.github \/app\/node_modules/
  );
});

test('ECS deploy writes runtime env only after candidate compose smoke succeeds', () => {
  const script = readRepoFile('scripts/deploy-ecs.sh');

  assert.match(script, /backup_runtime_files\(\)/);
  assert.match(script, /restore_runtime_files\(\)/);
  assert.match(script, /cleanup_runtime_backup\(\)/);
  assert.match(script, /runtime_backup_dir="\$\{remote_dir\}\/\.deploy-backups\/\$\{image_tag\}"/);
  assert.match(script, /rm -rf "\$runtime_backup_dir" \|\| echo "\[ecs:remote\] warning: failed to reset runtime backup/);
  assert.match(script, /cp "\$\{remote_dir\}\/docker-compose\.ecs\.yml" "\$runtime_backup_dir\/docker-compose\.ecs\.yml"/);
  assert.match(script, /cp "\$runtime_backup_dir\/docker-compose\.ecs\.yml" "\$\{remote_dir\}\/docker-compose\.ecs\.yml"/);
  assert.match(script, /trap on_deploy_error ERR/);
  assert.match(script, /compose_services=\(\)\n\s*cleanup_old_runtime_backups\n\s*backup_runtime_files/);
  assert.match(script, /candidate_env_file="\$\{env_file\}\.candidate\.\$\{image_tag\}"/);
  assert.match(script, /update_env_file "\$candidate_env_file" PAGES_IMAGE_REGISTRY "\$image_registry"/);
  assert.match(script, /update_env_file "\$candidate_env_file" PAGES_IMAGE_TAG "\$image_tag"/);
  assert.match(script, /compose_env_file="\$candidate_env_file"/);
  assert.match(script, /if ! smoke_services; then[\s\S]*rollback_env_and_services[\s\S]*false[\s\S]*fi/);
  assert.match(script, /cat "\$candidate_env_file" >"\$env_file"/);
  assert.match(script, /cat "\$candidate_env_file" >"\$env_file"\n\s*deploy_completed=true/);
  assert.match(script, /rm -f "\$candidate_env_file" \|\| echo "\[ecs:remote\] warning: failed to remove candidate env/);
  assert.match(script, /deploy_completed=true\n\s*rm -f "\$candidate_env_file"[\s\S]*cleanup_runtime_backup/);
  assert.match(script, /deploy_completed=true/);
});

test('ECS deploy smoke checks only selected app services', () => {
  const script = readRepoFile('scripts/deploy-ecs.sh');

  assert.match(script, /smoke_service_health\(\)/);
  assert.match(script, /smoke_app_services\(\)/);
  assert.match(script, /smoke_targets=\("\$\{selected_services\[@\]\}"\)/);
  assert.match(script, /if is_truthy "\$restart_all"; then\n\s*smoke_targets=\("\$\{all_services\[@\]\}"\)/);
  assert.match(script, /smoke_service_health pages-gateway "gateway ready" "http:\/\/127\.0\.0\.1:8788\/ready" \|\| return 1/);
  assert.match(script, /smoke_service_health pages-worker "worker health" "http:\/\/127\.0\.0\.1:8790\/health" \|\| return 1/);
  assert.match(
    script,
    /smoke_service_health slack-agent "slack-agent health" "http:\/\/127\.0\.0\.1:8791\/health" \|\| return 1/
  );
  assert.match(
    script,
    /smoke_service_health slack-notifier "slack-notifier health" "http:\/\/127\.0\.0\.1:8792\/health" \|\| return 1/
  );
  assert.match(script, /if contains_service gateway "\$\{smoke_targets\[@\]\}" && ! smoke_gateway_frontdoor; then/);
  assert.doesNotMatch(script, /ECS_SMOKE_CHECKS/);
  assert.doesNotMatch(script, /exec -T pages-gateway \\\n\s*env "ECS_SMOKE_CHECKS/);
  assert.match(script, /deployment smoke ok/);
  assert.doesNotMatch(script, /gateway did not become ready in time/);
});

test('ECS deploy upload excludes ignored local env and Pages config files', () => {
  const script = readRepoFile('scripts/deploy-ecs.sh');

  for (const pattern of [
    "--exclude='.dev.vars'",
    "--exclude='*/.dev.vars'",
    "--exclude='.pages.json'",
    "--exclude='*/.pages.json'",
    "--exclude='wrangler.toml'",
    "--exclude='*/wrangler.toml'",
    "--exclude='.staging.env'",
  ]) {
    assert.match(script, new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
});

test('ECS deploy rolls back services and keeps image/build retention bounded', () => {
  const script = readRepoFile('scripts/deploy-ecs.sh');

  assert.match(script, /rollback_env_and_services\(\)/);
  assert.match(script, /rm -f "\$candidate_env_file"/);
  assert.match(script, /restore_runtime_files/);
  assert.match(script, /cat "\$runtime_backup_dir\/\.env\.ecs" >"\$env_file"/);
  assert.match(script, /rm -rf "\$runtime_backup_dir" \|\| echo "\[ecs:remote\] warning: failed to remove runtime backup/);
  assert.match(script, /\[\[ -n "\$base_image_tag" && "\$tag" == "\$base_image_tag" \]\] && continue/);
  assert.match(script, /compose_up_services \|\| true/);
  assert.match(script, /cleanup_old_images\(\)/);
  assert.match(script, /docker image rm "\$\{repo\}:\$\{tag\}"/);
  assert.match(script, /cleanup_old_release_dirs\(\)/);
  assert.match(script, /find "\$remote_build_dir" -maxdepth 1 -mindepth 1 -type d -name 'ecs-\*'/);
  assert.match(script, /rm -rf "\$dir" \|\| echo "\[ecs:remote\] warning: failed to prune old release dir \$\{dir\}"/);
  assert.match(script, /cleanup_old_runtime_backups\(\)/);
  assert.match(script, /find "\$backup_root" -maxdepth 1 -mindepth 1 -type d -name 'ecs-\*'/);
  assert.match(script, /if \(\( kept > runtime_backup_retention \)\); then/);
  assert.match(script, /rm -rf "\$dir" \|\| echo "\[ecs:remote\] warning: failed to prune old runtime backup \$\{dir\}"/);
});
