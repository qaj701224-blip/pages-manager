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
  const result = spawnSync('bash', ['-n', 'scripts/deploy-ecs.sh'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('ECS deploy uses immutable full-service deployment defaults', () => {
  const script = readRepoFile('scripts/deploy-ecs.sh');
  const envExample = readRepoFile('.env.ecs.example');

  assert.match(
    script,
    /IMAGE_TAG="\$\{ECS_IMAGE_TAG:-ecs-\$\(date \+%Y%m%d%H%M%S\)-\$\(git -C "\$\{ROOT\}" rev-parse --short HEAD\)\}"/
  );
  assert.match(script, /SERVICES_INPUT="\$\{ECS_SERVICES:-all\}"/);
  assert.match(script, /BASE_IMAGE_TAG_ARG="\$\{BASE_IMAGE_TAG:-__empty__\}"/);
  assert.match(script, /BUILD_FROM_PREVIOUS="\$\{ECS_BUILD_FROM_PREVIOUS:-false\}"/);
  assert.match(script, /UPDATE_LATEST_ALIAS="\$\{ECS_UPDATE_LATEST_ALIAS:-false\}"/);
  assert.match(script, /LATEST_ALIAS_TAG="\$\{ECS_LATEST_ALIAS_TAG:-latest\}"/);
  assert.match(script, /IMAGE_RETENTION="\$\{ECS_IMAGE_RETENTION:-5\}"/);
  assert.match(script, /BUILD_DIR_RETENTION="\$\{ECS_BUILD_DIR_RETENTION:-5\}"/);
  assert.match(envExample, /^PAGES_IMAGE_TAG=ecs-YYYYMMDDHHMMSS-sha$/m);
  assert.doesNotMatch(envExample, /^PAGES_IMAGE_TAG=latest$/m);
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

  assert.match(script, /candidate_env_file="\$\{env_file\}\.candidate\.\$\{image_tag\}"/);
  assert.match(script, /update_env_file "\$candidate_env_file" PAGES_IMAGE_REGISTRY "\$image_registry"/);
  assert.match(script, /update_env_file "\$candidate_env_file" PAGES_IMAGE_TAG "\$image_tag"/);
  assert.match(script, /compose_env_file="\$candidate_env_file"/);
  assert.match(script, /if ! smoke_services; then[\s\S]*rollback_env_and_services[\s\S]*exit 1[\s\S]*fi/);
  assert.match(script, /cat "\$candidate_env_file" >"\$env_file"/);
  assert.match(script, /rm -f "\$candidate_env_file"/);
});

test('ECS deploy smoke checks all app services, not only gateway ready', () => {
  const script = readRepoFile('scripts/deploy-ecs.sh');

  assert.match(script, /probe_internal_services\(\)/);
  assert.match(script, /\['gateway ready', 'http:\/\/127\.0\.0\.1:8788\/ready'\]/);
  assert.match(script, /\['worker health', 'http:\/\/pages-worker:8790\/health'\]/);
  assert.match(script, /\['slack-agent health', 'http:\/\/slack-agent:8791\/health'\]/);
  assert.match(script, /\['slack-notifier health', 'http:\/\/slack-notifier:8792\/health'\]/);
  assert.match(script, /curl -fsS http:\/\/127\.0\.0\.1:80\/ready[\s\S]*probe_internal_services/);
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
  assert.match(script, /cat "\$env_backup" >"\$env_file"/);
  assert.match(script, /\[\[ -n "\$base_image_tag" && "\$tag" == "\$base_image_tag" \]\] && continue/);
  assert.match(script, /compose_up_services \|\| true/);
  assert.match(script, /cleanup_old_images\(\)/);
  assert.match(script, /docker image rm "\$\{repo\}:\$\{tag\}"/);
  assert.match(script, /cleanup_old_release_dirs\(\)/);
  assert.match(script, /find "\$remote_build_dir" -maxdepth 1 -mindepth 1 -type d -name 'ecs-\*'/);
  assert.match(script, /rm -rf "\$dir"/);
});
