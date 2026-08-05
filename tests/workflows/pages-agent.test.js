import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '../..');

test('pages-agent workflow is retained but statically frozen', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/pages-agent.yml'), 'utf8');

  assert.doesNotMatch(workflow, /^\s*issues:\n\s+types:/m);
  assert.doesNotMatch(workflow, /^\s*workflow_dispatch:/m);
  assert.match(workflow, /^\s{2}workflow_call:/m);
  assert.match(workflow, /^\s+if: \$\{\{ false \}\}$/m);
  assert.match(workflow, /pages-agent-context\.mjs/);
  assert.match(workflow, /pages-agent-coding\.mjs/);
  assert.match(workflow, /stageResult: process\.env\.AGENT_MODE === 'fix' \? 'reviewing' : 'pr_created'/);
  assert.match(workflow, /Pipeline: user-site publishing/);
  assert.match(workflow, /Platform deployment: out of scope/);
  assert.match(workflow, /Boundary: only %s\/\*\*/);
  assert.match(workflow, /Do not modify platform code, GitHub Actions, Kubernetes manifests, Dockerfiles, or deployment secrets/);
  assert.match(workflow, /AGENT_GATEWAY_URL: \$\{\{ vars\.AGENT_GATEWAY_URL \}\}/);
  assert.match(workflow, /AGENT_MODEL_NAME: \$\{\{ vars\.AGENT_MODEL_NAME \}\}/);
  assert.match(workflow, /AGENT_CODE_API_KEY: \$\{\{ secrets\.AGENT_CODE_API_KEY \}\}/);
  assert.match(workflow, /^\s*actions: write$/m);
  assert.match(workflow, /^\s*statuses: write$/m);
  assert.match(workflow, /branchName must use the sites\/ agent branch prefix/);
  assert.match(workflow, /agent branch must use the sites\/ prefix/);
  assert.match(workflow, /base_sha="\$\(git rev-parse "origin\/\$BASE_REF"\)"/);
  assert.match(workflow, /BASE_SHA=\$base_sha/);
  assert.match(workflow, /if git fetch origin "\+refs\/heads\/\$branch:refs\/remotes\/origin\/\$branch"; then/);
  assert.match(workflow, /git switch -C "\$branch" "origin\/\$branch"[\s\S]*git merge --no-edit "origin\/\$BASE_REF"/);
  assert.match(workflow, /else[\s\S]*git switch -C "\$branch" "origin\/\$BASE_REF"/);
  assert.match(workflow, /gh pr list --head "\$branch" --base "\$BASE_REF" --state open/);
  assert.doesNotMatch(workflow, /gh pr view "\$branch"/);
  assert.match(workflow, /Dispatch required PR checks/);
  assert.match(workflow, /post_status\(\)/);
  assert.match(workflow, /wait_for_run\(\)/);
  assert.match(workflow, /gh workflow run pr-classify\.yml[\s\S]*--ref "\$BRANCH_NAME"/);
  assert.match(workflow, /gh workflow run pr-platform\.yml[\s\S]*--ref "\$BRANCH_NAME"/);
  assert.match(workflow, /gh workflow run pr-site\.yml/);
  assert.match(workflow, /-f baseRef="\$BASE_REF"/);
  assert.match(workflow, /-f baseSha="\$BASE_SHA"/);
  assert.match(workflow, /-f headSha="\$HEAD_SHA"/);
  assert.match(workflow, /-f allowedPath="\$ALLOWED_PATH"/);
  assert.match(workflow, /repos\/\$GITHUB_REPOSITORY\/statuses\/\$HEAD_SHA/);
  assert.match(workflow, /post_status "pending" "PR Classify" "PR lane classification dispatched"/);
  assert.match(workflow, /post_status "pending" "check" "Project CI dispatched by Pages Agent"/);
  assert.match(workflow, /post_status "pending" "site-check"/);
  assert.match(workflow, /post_status "pending" "pages-user-flow"/);
  assert.match(workflow, /wait_for_run pr-classify\.yml "PR Classify"/);
  assert.match(workflow, /wait_for_run pr-platform\.yml check/);
  assert.match(workflow, /wait_for_run pr-site\.yml site-check/);
  assert.match(workflow, /post_status "success" "pages-user-flow"/);
  assert.match(workflow, /post_status "failure" "pages-user-flow"/);
  assert.match(workflow, /post_status "success" "\$context"/);
  assert.match(workflow, /Callback gateway on failure[\s\S]*PUBLISHING_JOB_ID: \$\{\{ inputs\.publishingJobId \}\}/);
  assert.match(workflow, /Callback gateway on failure[\s\S]*PAGES_CALLBACK_URL: \$\{\{ inputs\.callbackUrl \}\}/);
  assert.match(workflow, /failure\(\) && hashFiles\('\.pages-artifacts\/callback\.json'\) == ''/);
  assert.match(workflow, /callbackUrl: process\.env\.PAGES_CALLBACK_URL/);
  assert.match(workflow, /git reset[\s\S]*git add -N "\$ALLOWED_PATH"[\s\S]*changed="\$\(git diff HEAD --name-only\)"/);
  assert.match(workflow, /git diff HEAD -- "\$ALLOWED_PATH" > \.pages-artifacts\/site\.patch/);
  assert.match(workflow, /added_lines="\$\(git diff HEAD --unified=0 -- "\$ALLOWED_PATH"/);
  assert.match(workflow, /git config user\.email[\s\S]*git reset[\s\S]*git add "\$ALLOWED_PATH"/);
  assert.doesNotMatch(
    workflow,
    /Controlled commit and PR[\s\S]*git switch -C "\$branch"[\s\S]*git reset[\s\S]*git add "\$ALLOWED_PATH"/
  );
  assert.doesNotMatch(
    workflow,
    /Controlled commit and PR[\s\S]*git fetch origin "\+refs\/heads\/\$branch:refs\/remotes\/origin\/\$branch"/
  );
  assert.match(workflow, /printf '%s\\n' "\$added_lines" \| grep -Ein "\$\{token_shape_re\}\|\$\{secret_value_re\}"/);
  assert.match(workflow, /gh\[pousr\]_\[A-Za-z0-9_\]\{20,\}/);
  assert.doesNotMatch(workflow, /grep -REn [^\n]+ "\$ALLOWED_PATH"/);
  assert.doesNotMatch(
    workflow,
    /gh\[pousr\]_\|github_pat_\|sk-\[A-Za-z0-9\]\|CF_API_TOKEN\|SLACK_AGENT_API_KEY\|AGENT_CODE_API_KEY/
  );
  assert.doesNotMatch(workflow, /\$\{\{\s*secrets\.(SLACK_BOT_TOKEN|SLACK_APP_TOKEN|CF_API_TOKEN|CLOUDFLARE_API_TOKEN)/);
  assert.doesNotMatch(workflow, /^\s+(SLACK_BOT_TOKEN|SLACK_APP_TOKEN|CF_API_TOKEN|CLOUDFLARE_API_TOKEN):/m);
});

test('platform-agent workflow excludes runtime artifacts from repository scans', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/platform-agent.yml'), 'utf8');

  assert.match(workflow, /^name: Platform Agent$/m);
  assert.match(workflow, /prNumber:/);
  assert.match(workflow, /headSha:/);
  assert.match(workflow, /reviewContext:/);
  assert.match(workflow, /memoryContext:/);
  assert.match(workflow, /statusContext:/);
  assert.match(workflow, /followupContext:/);
  assert.match(workflow, /execFileSync\('git', \['status', '--porcelain=v1', '-z', '--untracked-files=all'\]/);
  assert.match(workflow, /\^\(\\\.pages-artifacts\|\\\.pages-trusted\)\(\\\/\|\$\)/);
  assert.match(workflow, /platform-agent-finalize\.mjs/);
  assert.match(workflow, /Refusing to commit generated build artifacts/);
  assert.match(workflow, /\(\^\|\/\)\(node_modules\|dist\|build\)\(\/\|\$\)/);
  assert.match(workflow, /while IFS= read -r path; do[\s\S]*done <<< "\$changed_files"/);
  assert.match(workflow, /Potential secret detected in changed file: \$path/);
  assert.match(workflow, /secret_field_re=/);
  assert.match(workflow, /private\[_-\]\?key/);
  assert.match(workflow, /password\|passwd\|pwd/);
  assert.match(workflow, /secret_value_re=/);
  assert.match(workflow, /Copy trusted callback helper[\s\S]*platform-agent-runner\.mjs/);
  assert.match(workflow, /Copy trusted callback helper[\s\S]*platform-agent-finalize\.mjs/);
  assert.match(workflow, /Install Codex CLI[\s\S]*PLATFORM_AGENT_CODEX_PACKAGE/);
  assert.match(workflow, /npm install -g "\$PLATFORM_AGENT_CODEX_PACKAGE"/);
  assert.match(workflow, /Preflight Codex CLI[\s\S]*platform-agent-runner\.mjs" --codex-preflight/);
  assert.match(workflow, /Run platform coding agent[\s\S]*platform-agent-runner\.mjs/);
  assert.doesNotMatch(workflow, /node "\$RUNNER_TEMP\/platform-agent-coding\.mjs"/);
  assert.match(workflow, /AGENT_BACKEND:[^\n]*(vars\.AGENT_BACKEND|codex)/);
  assert.doesNotMatch(workflow, /AGENT_CODE_API_KEY is required for Platform Agent/);
  assert.match(workflow, /Run platform checks[\s\S]*AGENT_CODE_API_KEY: ''/);
  assert.match(workflow, /Commit changes[\s\S]*platform-agent-finalize\.mjs/);
  assert.match(workflow, /Commit changes[\s\S]*PLATFORM_AGENT_RUNNER_PATH/);
  assert.match(workflow, /Commit changes[\s\S]*AGENT_BRANCH_NAME/);
  assert.match(workflow, /BODY_FILE="\$body_file" TITLE_FILE="\$title_file" node <<'NODE'/);
  assert.match(workflow, /const issueNumber = String\(env\.ISSUE_NUMBER \|\| ''\)\.trim\(\);/);
  assert.match(workflow, /const requestSummary = redactPublicText\(env\.REQUEST_SUMMARY \|\| ''\);/);
  assert.match(workflow, /const requestTitle = redactPublicText\(env\.REQUEST_TITLE \|\| '平台需求'\)/);
  assert.match(workflow, /writeFileSync\(env\.TITLE_FILE, `feat: \$\{requestTitle\}\\n`\)/);
  assert.match(workflow, /--title "\$pr_title"/);
  assert.match(workflow, /Closes #\$\{issueNumber\}/);
  assert.match(workflow, /- Issue: \$\{issueReference\}/);
  assert.doesNotMatch(workflow, /cat > "\$body_file" <<EOF/);
  assert.doesNotMatch(workflow, /Issue: \$\(if \[\[ -n "\$\{ISSUE_NUMBER\}" \]\]/);
  assert.doesNotMatch(workflow, /--title "feat: \$\{REQUEST_TITLE\}"/);
  assert.match(workflow, /added_lines="\$\(git diff HEAD --unified=0 -- "\$path"/);
  assert.match(workflow, /added_lines="\$\(sed 's\/\^\/\+\/' "\$path"\)"/);
  assert.match(workflow, /Upload platform agent diagnostics[\s\S]*if: always\(\)/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.match(workflow, /\.pages-artifacts\/platform-agent-report\.json/);
  assert.match(workflow, /\.pages-artifacts\/platform-agent-debug\.json/);
  assert.match(workflow, /\.pages-artifacts\/platform-agent-running\.json/);
  assert.match(workflow, /\.pages-artifacts\/platform-agent-pr\.json/);
  assert.match(workflow, /\.pages-artifacts\/platform-agent-failed\.json/);
  assert.doesNotMatch(workflow, /\.pages-artifacts\/platform-agent-\*\.md/);
  assert.doesNotMatch(workflow, /\.pages-artifacts\/platform-agent-\*\.json/);
  assert.match(workflow, /include-hidden-files: true/);
});

test('pages-preview workflow keeps deploy API ip restriction compatible', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/pages-preview.yml'), 'utf8');

  assert.doesNotMatch(workflow, /^\s*workflow_dispatch:/m);
  assert.match(workflow, /^\s{2}workflow_call:/m);
  assert.match(workflow, /^\s+if: \$\{\{ false \}\}$/m);
  assert.match(workflow, /Verify current PR head[\s\S]*gh pr view "\$PR_NUMBER"/);
  assert.match(workflow, /current_head.*!= "\$HEAD_SHA"/);
  assert.match(workflow, /echo "stale=true" >> "\$GITHUB_OUTPUT"/);
  assert.match(
    workflow,
    /Deploy preview through pages-manager[\s\S]*if: \$\{\{ steps\.current-head\.outputs\.stale != 'true' \}\}/
  );
  assert.match(workflow, /source_dir="\$ALLOWED_PATH\/src"/);
  assert.doesNotMatch(workflow, /source_dir="\$ALLOWED_PATH"\n/);
  assert.match(workflow, /-F "ip_restrict=true"/);
  assert.match(workflow, /prNumber: report\.prNumber/);
  assert.match(workflow, /headSha: report\.headSha/);
  assert.match(workflow, /prNumber: process\.env\.PR_NUMBER/);
  assert.match(workflow, /headSha: process\.env\.HEAD_SHA/);
  assert.match(workflow, /Callback gateway[\s\S]*if: \$\{\{ steps\.current-head\.outputs\.stale != 'true' \}\}/);
  assert.match(workflow, /Callback gateway on failure[\s\S]*steps\.current-head\.outputs\.stale != 'true'/);
  assert.doesNotMatch(workflow, /-F "ip_restrict=false"/);
});

test('ci keeps dispatch support while site-check only runs for site pull requests', async () => {
  const classify = await readFile(path.join(root, '.github/workflows/pr-classify.yml'), 'utf8');
  const ci = await readFile(path.join(root, '.github/workflows/pr-platform.yml'), 'utf8');
  const siteCheck = await readFile(path.join(root, '.github/workflows/pr-site.yml'), 'utf8');

  assert.match(classify, /^\s*workflow_dispatch:/m);
  assert.match(classify, /baseSha:/);
  assert.match(classify, /headSha:/);
  assert.match(classify, /allowedPath:/);
  assert.match(classify, /Mixed PRs are not supported/);
  assert.match(classify, /base="\$\(git merge-base "\$PR_BASE_SHA" "\$PR_HEAD_SHA"\)"/);
  assert.match(classify, /echo "lane=site"/);
  assert.match(classify, /echo "origin=site-agent"/);
  assert.match(ci, /^\s*workflow_dispatch:/m);
  assert.match(ci, /baseSha:/);
  assert.match(ci, /headSha:/);
  assert.match(ci, /allowedPath:/);
  assert.doesNotMatch(siteCheck, /^\s*workflow_dispatch:/m);
  assert.match(ci, /EVENT_NAME: \$\{\{ github\.event_name \}\}/);
  assert.match(ci, /INPUT_BASE_SHA: \$\{\{ inputs\.baseSha \}\}/);
  assert.match(ci, /INPUT_HEAD_SHA: \$\{\{ inputs\.headSha \}\}/);
  assert.match(ci, /INPUT_ALLOWED_PATH: \$\{\{ inputs\.allowedPath \}\}/);
  assert.match(ci, /site_only=true/);
  assert.match(ci, /base="\$\(git merge-base "\$PR_BASE_SHA" "\$PR_HEAD_SHA"\)"/);
  assert.match(ci, /Mixed PRs are not supported/);
  assert.doesNotMatch(siteCheck, /EVENT_NAME:/);
  assert.doesNotMatch(siteCheck, /inputs\./);
  assert.doesNotMatch(siteCheck, /INPUT_(?:BASE_REF|BASE_SHA|HEAD_SHA|ALLOWED_PATH)/);
  assert.doesNotMatch(siteCheck, /workflow_dispatch/);
  assert.doesNotMatch(siteCheck, /baseSha must be a full commit SHA/);
  assert.match(siteCheck, /base="\$\(git merge-base "\$PR_BASE_SHA" "\$PR_HEAD_SHA"\)"/);
  assert.match(siteCheck, /manifest="\$SITE_ROOT\/site\.json"/);
  assert.match(siteCheck, /Site Check requires \$manifest/);
  assert.match(siteCheck, /while IFS= read -r file/);
  assert.match(siteCheck, /done < <\(find "\$SITE_ROOT"/);
});

test('project-index workflow is retained but statically frozen', async () => {
  const workflow = await readFile(path.join(root, '.github/workflows/project-index.yml'), 'utf8');

  assert.doesNotMatch(workflow, /^\s*workflow_dispatch:/m);
  assert.match(workflow, /^\s{2}workflow_call:/m);
  assert.match(workflow, /^\s+if: \$\{\{ false \}\}$/m);
});
