import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

function readDoc(path) {
  return readFileSync(join(repoRoot, path), 'utf8');
}

test('agent instructions stay synchronized', () => {
  assert.equal(readDoc('AGENTS.md'), readDoc('CLAUDE.md'));
});

test('branch policy documents master PR preview sync and CI lane isolation', () => {
  const policy = readDoc('docs/architecture/github-automation.md');
  const agents = readDoc('AGENTS.md');

  for (const doc of [policy, agents]) {
    assert.match(doc, /feature branch[\s\S]*PR to master[\s\S]*sync.*staging preview/s);
    assert.match(doc, /staging.*preview 分支|共享 preview 分支/s);
    assert.match(doc, /不是晋级来源|不能反向晋级到 `master`/);
    assert.match(doc, /production.*workflow_dispatch|Deploy Production/s);
    assert.match(doc, /用户站点发布执行器/);
    assert.match(doc, /deploy-ack-preview\.yml/);
    assert.match(doc, /project-index\.yml/);
    assert.match(doc, /pages-agent\.yml/);
    assert.match(doc, /pages-preview\.yml/);
    assert.match(doc, /KUBE_CONFIG_B64/);
    assert.match(doc, /sites\/<employee/);
    assert.match(doc, /\.github\/\*\*/);
    assert.match(doc, /k8s\/\*\*/);
  }

  assert.match(agents, /pr-classify\.yml/);
  assert.match(agents, /pr-platform\.yml/);
  assert.match(agents, /pr-site\.yml/);
});

test('master PR sync workflow merges project PR heads to staging and skips user-site PRs', () => {
  const workflow = readDoc('.github/workflows/sync-master-pr-to-staging.yml');
  const compatibilityCi = readDoc('.github/workflows/ci.yml');
  const policy = readDoc('docs/architecture/github-automation.md');

  assert.match(workflow, /^name: Sync Master PR To Staging$/m);
  assert.match(
    workflow,
    /pull_request:[\s\S]*types: \[opened, synchronize, reopened, ready_for_review\][\s\S]*branches: \[master\]/
  );
  assert.match(workflow, /permissions:[\s\S]*actions: write[\s\S]*contents: write[\s\S]*pull-requests: read/);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.match(workflow, /HEAD_REPO[\s\S]*BASE_REPO/);
  assert.match(workflow, /IS_DRAFT[\s\S]*draft PRs are not synced/);
  assert.match(workflow, /run: \|\n\s+echo "Skipped staging sync:/);
  assert.match(workflow, /gh api --paginate/);
  assert.match(workflow, /HEAD_REF.*sites\/\*/);
  assert.match(workflow, /site_changed=false/);
  assert.match(workflow, /platform_changed=false/);
  assert.match(
    workflow,
    /Mixed PRs are not supported: split personal site changes and PageManager platform changes into separate PRs\./,
  );
  assert.match(workflow, /PR only touches sites\/\*\*/);
  assert.match(workflow, /concurrency:[\s\S]*sync-master-pr-to-staging/);
  assert.match(workflow, /ref: staging/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /git fetch --no-tags origin staging/);
  assert.match(workflow, /refs\/pull\/\$\{PR_NUMBER\}\/head/);
  assert.match(workflow, /actual_sha[\s\S]*PR_HEAD_SHA/);
  assert.match(workflow, /git merge --no-ff "\$pr_ref"/);
  assert.match(workflow, /sync_branch="staging-sync\/pr-\$\{PR_NUMBER\}-\$\{short_sha\}"/);
  assert.match(workflow, /git push origin "HEAD:refs\/heads\/\$\{sync_branch\}"/);
  assert.match(workflow, /gh workflow run ci\.yml[\s\S]*--ref "\$sync_branch"/);
  assert.match(workflow, /gh run list[\s\S]*--workflow ci\.yml[\s\S]*--branch "\$sync_branch"/);
  assert.match(workflow, /gh run watch "\$ci_run_id"[\s\S]*--exit-status/);
  assert.match(workflow, /git push origin "HEAD:staging"/);
  assert.match(workflow, /git push origin ":refs\/heads\/\$\{sync_branch\}"/);
  assert.match(workflow, /v1_changed=false/);
  assert.match(workflow, /v2_changed=false/);
  assert.match(workflow, /apps\/server\/\*|deploy-staging\.yml/);
  assert.match(
    workflow,
    /apps\/pages-api\/\*|apps\/pages-auth\/\*|apps\/pages-router\/\*|apps\/kv-gateway\/\*|packages\/wfp-client\/\*/
  );
  assert.match(workflow, /if \[\[ "\$V1_CHANGED" == "true" \]\]/);
  assert.match(workflow, /gh workflow run deploy-staging\.yml[\s\S]*--ref staging/);
  assert.match(workflow, /gh run list[\s\S]*deploy-staging\.yml/);
  assert.match(workflow, /gh workflow run deploy-pages-v2-staging\.yml[\s\S]*--ref staging[\s\S]*component=all/);
  assert.match(workflow, /gh run list[\s\S]*deploy-pages-v2-staging\.yml/);
  assert.match(workflow, /gh run watch "\$v1_run_id"[\s\S]*--exit-status/);
  assert.match(workflow, /gh run watch "\$v2_run_id"[\s\S]*--exit-status/);
  assert.doesNotMatch(workflow, /force-with-lease|git push --force/);
  assert.doesNotMatch(workflow, /ALIYUN_ACCESS_KEY|ACR_INSTANCE_ID|KUBE_CONFIG_B64|CLOUDFLARE_API_TOKEN|CF_API_TOKEN/);

  assert.match(compatibilityCi, /^name: CI$/m);
  assert.match(compatibilityCi, /Compatibility workflow for staging sync during the PR lane split\./);
  assert.match(compatibilityCi, /^\s*workflow_dispatch:/m);
  assert.doesNotMatch(compatibilityCi, /^\s*pull_request:/m);
  assert.doesNotMatch(compatibilityCi, /^\s*push:/m);
  assert.match(compatibilityCi, /jobs:[\s\S]*check:/);
  assert.match(compatibilityCi, /pnpm lint/);
  assert.match(compatibilityCi, /pnpm test/);

  assert.match(policy, /Master PR 同步 Staging 预览/);
  assert.match(policy, /项目类 PR 指向 `master`/);
  assert.match(policy, /staging-sync\/pr-<number>-<sha>/);
  assert.match(policy, /required status check/);
  assert.match(policy, /dispatch `Deploy XD Pages Staging`/);
  assert.match(policy, /等待 `Deploy XD Pages Staging` 完成/);
  assert.match(policy, /纯 `sites\/\*\*` 用户站点 PR/);
});

test('platform dev lane documents Slack-to-platform PR flow and isolates deployment secrets', () => {
  const doc = readDoc('docs/architecture/platform-dev-lane.md');
  const workflow = readDoc('.github/workflows/platform-agent.yml');

  assert.match(doc, /Platform Dev Lane/);
  assert.match(doc, /Site Publishing Lane/);
  assert.match(doc, /PlatformDevItem/);
  assert.match(doc, /type:ci/);
  assert.match(doc, /risk:high/);
  assert.match(doc, /PlatformDevItem: pdev_xxx/);
  assert.match(doc, /不生成 Cloudflare preview/);
  assert.match(readDoc('docs/architecture/db-schema.md'), /gate_type=risk,status=approved/);
  assert.doesNotMatch(readDoc('docs/architecture/db-schema.md'), /gate_type=coding|platform-dev\.js`（计划）|work-items\.js`（计划）/);

  assert.match(workflow, /^name: Platform Agent$/m);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /platformDevItemId:/);
  assert.match(workflow, /gateApproved:/);
  assert.match(workflow, /effective_risk/);
  assert.match(workflow, /AGENT_CODE_API_KEY/);
  assert.match(workflow, /post-executor-callback\.js/);
  assert.match(workflow, /pnpm lint/);
  assert.match(workflow, /pnpm test/);
  assert.match(workflow, /EFFECTIVE_RISK/);
  assert.match(workflow, /sensitive_paths/);
  assert.match(workflow, /deploy\//);
  assert.match(workflow, /High-risk paths require gate-approved Platform Dev work/);
  assert.match(workflow, /Potential secret detected/);
  assert.doesNotMatch(workflow, /ALIYUN_ACCESS_KEY|ACR_INSTANCE_ID|KUBE_CONFIG_B64|CLOUDFLARE_API_TOKEN|CF_API_TOKEN/);
  assert.doesNotMatch(workflow, /pages-preview\.yml|deploy-pages-v2|Deploy Production/);
});
