import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');

test('pages-agent workflow is gateway-dispatched and uses Coding Agent secret', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/pages-agent.yml'), 'utf8');

  assert.doesNotMatch(workflow, /^\s*issues:\n\s+types:/m);
  assert.match(workflow, /^\s*workflow_dispatch:/m);
  assert.match(workflow, /pages-agent-context\.mjs/);
  assert.match(workflow, /pages-agent-coding\.mjs/);
  assert.match(workflow, /AGENT_MODE" == "fix"/);
  assert.match(workflow, /stageResult: process\.env\.AGENT_MODE === 'fix' \? 'reviewing' : 'pr_created'/);
  assert.match(workflow, /AGENT_GATEWAY_URL: \$\{\{ vars\.AGENT_GATEWAY_URL \}\}/);
  assert.match(workflow, /AGENT_MODEL_NAME: \$\{\{ vars\.AGENT_MODEL_NAME \}\}/);
  assert.match(workflow, /AGENT_CODE_API_KEY: \$\{\{ secrets\.AGENT_CODE_API_KEY \}\}/);
  assert.match(workflow, /^\s*actions: write$/m);
  assert.match(workflow, /^\s*statuses: write$/m);
  assert.match(workflow, /branchName must use the sites\/ agent branch prefix/);
  assert.match(workflow, /agent branch must use the sites\/ prefix/);
  assert.match(workflow, /base_sha="\$\(git rev-parse "origin\/\$BASE_REF"\)"/);
  assert.match(workflow, /BASE_SHA=\$base_sha/);
  assert.match(workflow, /git merge --no-edit "origin\/\$BASE_REF"/);
  assert.match(workflow, /gh pr list --head "\$branch" --base "\$BASE_REF" --state open/);
  assert.doesNotMatch(workflow, /gh pr view "\$branch"/);
  assert.match(workflow, /Dispatch required PR checks/);
  assert.match(workflow, /post_status\(\)/);
  assert.match(workflow, /wait_for_run\(\)/);
  assert.match(workflow, /gh workflow run ci\.yml --ref "\$BRANCH_NAME"/);
  assert.match(workflow, /gh workflow run site-check\.yml/);
  assert.match(workflow, /-f baseRef="\$BASE_REF"/);
  assert.match(workflow, /-f baseSha="\$BASE_SHA"/);
  assert.match(workflow, /-f headSha="\$HEAD_SHA"/);
  assert.match(workflow, /-f allowedPath="\$ALLOWED_PATH"/);
  assert.match(workflow, /repos\/\$GITHUB_REPOSITORY\/statuses\/\$HEAD_SHA/);
  assert.match(workflow, /post_status "pending" "check" "Project CI dispatched by Pages Agent"/);
  assert.match(workflow, /post_status "pending" "pages-generated-site-check"/);
  assert.match(workflow, /post_status "pending" "pages-user-flow"/);
  assert.match(workflow, /wait_for_run ci\.yml check/);
  assert.match(workflow, /wait_for_run site-check\.yml pages-generated-site-check/);
  assert.match(workflow, /post_status "success" "pages-user-flow"/);
  assert.match(workflow, /post_status "failure" "pages-user-flow"/);
  assert.match(workflow, /post_status "success" "\$context"/);
  assert.match(workflow, /Callback gateway on failure[\s\S]*PUBLISHING_JOB_ID: \$\{\{ inputs\.publishingJobId \}\}/);
  assert.match(workflow, /Callback gateway on failure[\s\S]*PAGES_CALLBACK_URL: \$\{\{ inputs\.callbackUrl \}\}/);
  assert.match(workflow, /failure\(\) && hashFiles\('\.pages-artifacts\/callback\.json'\) == ''/);
  assert.match(workflow, /callbackUrl: process\.env\.PAGES_CALLBACK_URL/);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\.(SLACK_BOT_TOKEN|SLACK_APP_TOKEN|CF_API_TOKEN|CLOUDFLARE_API_TOKEN)/);
  assert.doesNotMatch(workflow, /^\s+(SLACK_BOT_TOKEN|SLACK_APP_TOKEN|CF_API_TOKEN|CLOUDFLARE_API_TOKEN):/m);
});

test('pages-preview workflow keeps deploy API ip restriction compatible', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/pages-preview.yml'), 'utf8');

  assert.match(workflow, /-F "ip_restrict=true"/);
  assert.doesNotMatch(workflow, /-F "ip_restrict=false"/);
});

test('ci and site-check support gateway-dispatched generated PR checks', async () => {
  const ci = await readFile(path.join(root, '.github/workflows/ci.yml'), 'utf8');
  const siteCheck = await readFile(path.join(root, '.github/workflows/site-check.yml'), 'utf8');

  assert.match(ci, /^\s*workflow_dispatch:/m);
  assert.match(siteCheck, /^\s*workflow_dispatch:/m);
  assert.match(siteCheck, /baseRef:/);
  assert.match(siteCheck, /baseSha:/);
  assert.match(siteCheck, /headSha:/);
  assert.match(siteCheck, /allowedPath:/);
  assert.match(siteCheck, /EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(siteCheck, /INPUT_BASE_SHA: \$\{\{ inputs\.baseSha \}\}/);
  assert.match(siteCheck, /baseSha must be a full commit SHA/);
  assert.match(siteCheck, /git fetch origin "\+refs\/heads\/\$base_ref:refs\/remotes\/origin\/\$base_ref"/);
  assert.match(siteCheck, /PR must only modify expected site root/);
});
