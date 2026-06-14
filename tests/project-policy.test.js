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
  const policy = readDoc('docs/deployment-branch-policy.md');
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
    assert.match(doc, /site-check\.yml/);
    assert.match(doc, /KUBE_CONFIG_B64/);
    assert.match(doc, /sites\/<employee/);
    assert.match(doc, /\.github\/\*\*/);
    assert.match(doc, /k8s\/\*\*/);
  }
});

test('master PR sync workflow merges project PR heads to staging and skips user-site PRs', () => {
  const workflow = readDoc('.github/workflows/sync-master-pr-to-staging.yml');
  const policy = readDoc('docs/deployment-branch-policy.md');

  assert.match(workflow, /^name: Sync Master PR To Staging$/m);
  assert.match(
    workflow,
    /pull_request:[\s\S]*types: \[opened, synchronize, reopened, ready_for_review\][\s\S]*branches: \[master\]/,
  );
  assert.match(workflow, /permissions:[\s\S]*actions: write[\s\S]*checks: read[\s\S]*contents: write/);
  assert.doesNotMatch(workflow, /pull_request_target/);
  assert.match(workflow, /HEAD_REPO[\s\S]*BASE_REPO/);
  assert.match(workflow, /IS_DRAFT[\s\S]*draft PRs are not synced/);
  assert.match(workflow, /gh api --paginate/);
  assert.match(workflow, /HEAD_REF.*sites\/\*/);
  assert.match(workflow, /PR only touches sites\/\*\*/);
  assert.match(workflow, /concurrency:[\s\S]*sync-master-pr-to-staging/);
  assert.match(workflow, /ref: staging/);
  assert.match(workflow, /fetch-depth: 0/);
  assert.match(workflow, /git fetch --no-tags origin staging/);
  assert.match(workflow, /refs\/pull\/\$\{PR_NUMBER\}\/head/);
  assert.match(workflow, /actual_sha[\s\S]*PR_HEAD_SHA/);
  assert.match(workflow, /git merge --no-ff "\$pr_ref"/);
  assert.match(workflow, /git push origin "HEAD:staging"/);
  assert.match(workflow, /gh workflow run deploy-staging\.yml[\s\S]*--ref staging[\s\S]*component=all/);
  assert.match(workflow, /gh run list[\s\S]*deploy-staging\.yml/);
  assert.match(workflow, /gh run watch "\$run_id"[\s\S]*--exit-status/);
  assert.doesNotMatch(workflow, /force-with-lease|git push --force/);
  assert.doesNotMatch(workflow, /ALIYUN_ACCESS_KEY|ACR_INSTANCE_ID|KUBE_CONFIG_B64|CLOUDFLARE_API_TOKEN|CF_API_TOKEN/);

  assert.match(policy, /Master PR 同步 Staging 预览/);
  assert.match(policy, /项目类 PR 指向 `master`/);
  assert.match(policy, /push 到 `staging`/);
  assert.match(policy, /dispatch `Deploy Staging`/);
  assert.match(policy, /等待 `Deploy Staging` 完成/);
  assert.match(policy, /纯 `sites\/\*\*` 用户站点 PR/);
});
