#!/usr/bin/env bash
set -euo pipefail

ecs_path_re='^(apps/(gateway|worker|slack-agent|slack-notifier)/|packages/(worker-kit|workflow-core|git-client|slack-notifier)/|docker-compose\.ecs\.yml$|Dockerfile\.node-service$|deploy/ecs/|scripts/deploy-ecs\.sh$|package\.json$|pnpm-lock\.yaml$|pnpm-workspace\.yaml$)'

event_name="${EVENT_NAME:-workflow_dispatch}"
ref_name="${GITHUB_REF_NAME_VALUE:-${GITHUB_REF_NAME:-}}"
ref_value="${GITHUB_REF_VALUE:-${GITHUB_REF:-}}"
head_sha="${GITHUB_SHA_VALUE:-${GITHUB_SHA:-}}"
input_deploy="${INPUT_DEPLOY:-false}"
input_force_deploy="${INPUT_FORCE_DEPLOY:-false}"
input_allow_non_master_deploy="${INPUT_ALLOW_NON_MASTER_DEPLOY:-false}"
input_base_sha="${INPUT_BASE_SHA:-}"
input_head_sha="${INPUT_HEAD_SHA:-}"
github_output="${GITHUB_OUTPUT:-}"
github_step_summary="${GITHUB_STEP_SUMMARY:-}"

if [[ -z "$ref_value" && -n "$ref_name" ]]; then
  ref_value="refs/heads/${ref_name}"
fi
if [[ -z "$ref_name" && "$ref_value" == refs/heads/* ]]; then
  ref_name="${ref_value#refs/heads/}"
fi
if [[ -z "$head_sha" ]]; then
  head_sha="$(git rev-parse HEAD)"
fi

if [[ -n "$input_base_sha" && -n "$input_head_sha" ]]; then
  base="$input_base_sha"
  head="$input_head_sha"
else
  head="$head_sha"
  base="$(git rev-parse "${head}^" 2>/dev/null || git rev-list --max-parents=0 "$head")"
fi

if [[ "$base" =~ ^0+$ ]]; then
  base="$(git rev-list --max-parents=0 "$head")"
fi

if ! git cat-file -e "${base}^{commit}" 2>/dev/null; then
  echo "Base commit is not available locally: $base" >&2
  exit 1
fi
if ! git cat-file -e "${head}^{commit}" 2>/dev/null; then
  echo "Head commit is not available locally: $head" >&2
  exit 1
fi

changed="$(git diff --name-only "$base" "$head")"
ecs_files="$(printf '%s\n' "$changed" | grep -E "$ecs_path_re" || true)"

ecs_changed=false
if [[ -n "$ecs_files" ]]; then
  ecs_changed=true
fi

should_deploy=false
reason="No ECS runtime paths changed."
if [[ "$input_deploy" == "true" ]]; then
  if [[ "$ref_value" != "refs/heads/master" ]]; then
    if [[ "$input_allow_non_master_deploy" == "true" && ( "$ecs_changed" == "true" || "$input_force_deploy" == "true" ) ]]; then
      should_deploy=true
      reason="Manual ECS deploy requested from non-master ref ${ref_name} with allowNonMasterDeploy=true."
    elif [[ "$input_allow_non_master_deploy" == "true" ]]; then
      reason="Manual non-master deploy requested, but no ECS runtime paths changed and forceDeploy=false."
    else
      reason="Manual ECS deploy is only allowed from master unless allowNonMasterDeploy=true; this run is on ${ref_name}."
    fi
  elif [[ "$ecs_changed" == "true" || "$input_force_deploy" == "true" ]]; then
    should_deploy=true
    reason="Manual ECS deploy requested on master."
  else
    reason="Manual deploy requested, but no ECS runtime paths changed and forceDeploy=false."
  fi
else
  reason="Dry run only; deploy=false."
fi

if [[ -n "$github_output" ]]; then
  {
    echo "ecs_changed=$ecs_changed"
    echo "should_deploy=$should_deploy"
    echo "reason=$reason"
  } >> "$github_output"
fi

summary="$(
  {
    echo "### Deploy ECS Production decision"
    echo
    echo "- Event: \`$event_name\`"
    echo "- Ref: \`$ref_name\`"
    echo "- Base: \`$base\`"
    echo "- Head: \`$head\`"
    echo "- ECS paths changed: \`$ecs_changed\`"
    echo "- Deploy: \`$should_deploy\`"
    echo "- Allow non-master deploy: \`$input_allow_non_master_deploy\`"
    echo "- Reason: $reason"
    echo
    echo "#### Matching ECS files"
    if [[ -n "$ecs_files" ]]; then
      printf '%s\n' "$ecs_files" | sed 's/^/- `/' | sed 's/$/`/'
    else
      echo "- none"
    fi
  }
)"

if [[ -n "$github_step_summary" ]]; then
  printf '%s\n' "$summary" >> "$github_step_summary"
else
  printf '%s\n' "$summary"
fi
