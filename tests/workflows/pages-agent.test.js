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
  assert.match(workflow, /branchName must use the sites\/ agent branch prefix/);
  assert.match(workflow, /agent branch must use the sites\/ prefix/);
  assert.match(workflow, /gh pr list --head "\$branch" --base "\$BASE_REF" --state open/);
  assert.doesNotMatch(workflow, /gh pr view "\$branch"/);
  assert.match(workflow, /Callback gateway on failure[\s\S]*PUBLISHING_JOB_ID: \$\{\{ inputs\.publishingJobId \}\}/);
  assert.match(workflow, /Callback gateway on failure[\s\S]*PAGES_CALLBACK_URL: \$\{\{ inputs\.callbackUrl \}\}/);
  assert.match(workflow, /callbackUrl: process\.env\.PAGES_CALLBACK_URL/);
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\.(SLACK_BOT_TOKEN|SLACK_APP_TOKEN|CF_API_TOKEN|CLOUDFLARE_API_TOKEN)/);
  assert.doesNotMatch(workflow, /^\s+(SLACK_BOT_TOKEN|SLACK_APP_TOKEN|CF_API_TOKEN|CLOUDFLARE_API_TOKEN):/m);
});

test('pages-preview workflow keeps deploy API ip restriction compatible', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/pages-preview.yml'), 'utf8');

  assert.match(workflow, /-F "ip_restrict=true"/);
  assert.doesNotMatch(workflow, /-F "ip_restrict=false"/);
});
