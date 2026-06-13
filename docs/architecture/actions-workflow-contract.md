# GitHub Actions Workflow Contract

## 定位

当前用 GitHub Actions runner 承担一次性 executor 职责，但控制面必须跑在 K8s，详见 [k8s-runtime-contract.md](./k8s-runtime-contract.md)：

```text
K8s pages-gateway
  ↓ PAGES_WORKER_START_URL
K8s apps/worker
  ↓ create GitHub issue
GitHub issues webhook
  ↓ pages-gateway validates job / issue / delivery
apps/worker
  ↓ workflow_dispatch
GitHub Actions runner
  ↓ callback
K8s pages-gateway
```

这个合同定义 gateway 和 workflows 之间传什么、怎么验签、怎么幂等、失败怎么回写。

GitHub Actions runner 不能承担 Review Agent comment 监听、required check 归一化、preview gate 或 Slack 回写；这些状态推进必须通过 GitHub webhook / executor callback 回到 K8s gateway / worker。开发者本机 `gh run watch`、`gh pr view` 或 `gh api` 只能排障，不能作为平台机制。

## Workflows

完整合同包含五个 workflow。第一优先级需要 `project-index.yml`、`pages-agent.yml`、`site-check.yml`、`pages-preview.yml` 跑通，production workflow 可以后置：

| Workflow | 触发 | 职责 |
| --- | --- | --- |
| `project-index.yml` | repo 变更 / gateway dispatch | 生成 `ProjectIndexSnapshot` 和 agent context bundle |
| `pages-agent.yml` | gateway-controlled `workflow_dispatch` / `repository_dispatch` | coding agent initial/fix、precheck、controlled commit、create/update PR |
| `site-check.yml` | `pull_request` | required check，重复验证 PR 真实 diff |
| `pages-preview.yml` | `site-check` / `pages-site-policy` 和 Review Agent gate 通过后由 gateway dispatch，或受控 `workflow_run` | 从 PR head SHA 构建 preview，回写 preview URL |
| `pages-production-deploy.yml` | gateway dispatch 或 merge 后受控触发 | 从 `merge_commit_sha` 构建 production 并部署 |

普通 site PR workflow 不能读取 Slack bot token、Cloudflare production token、auto-merge token。

第一优先级只要求 `project-index.yml`、`pages-agent.yml`、`site-check.yml`、`pages-preview.yml` 跑通。`pages-production-deploy.yml` 可以后置。

当前 workflow 默认使用 GitHub-hosted runner：

```text
runs-on: ubuntu-latest
```

不要求在 GitHub Settings 里先创建 self-hosted runner。self-hosted runner 属于后续运行环境增强。

## Shared Inputs

所有由 gateway 触发的 workflow 都必须带这些输入：

```json
{
  "publishingJobId": "job_...",
  "jobStageId": "stage_...",
  "attemptId": "attempt_...",
  "callbackUrl": "https://api.workers.xd.team/internal/executor-callback",
  "callbackNonceRef": "github-actions-secret-or-short-token",
  "repoFullName": "org/pages-manager",
  "requestedByType": "user",
  "requestedById": "usr_...",
  "siteProjectId": "site_...",
  "ownerScopeId": "scope_...",
  "employeeSlug": "zhangsan",
  "siteSlug": "profile",
  "allowedPath": "sites/zhangsan/profile",
  "baseRef": "staging",
  "issueNumber": "456",
  "approvalMode": "manual-required"
}
```

Rules:

- `attemptId` 必须对应 DB 里的当前有效 `JobStageAttempt`。
- workflow 不自行相信 actor 权限；权限结论由 gateway 在创建 attempt 前写入。
- workflow callback 时必须原样带回 `publishingJobId`、`jobStageId`、`attemptId`。
- `allowedPath` 必须是单个站点目录，不能是 `sites/zhangsan` 或 `sites/**`。
- `baseRef` 是 Project Index / Pages Agent 的 checkout 和 PR base，当前默认 `staging`；它不同于 workflow dispatch 的 `ref`。
- `issueNumber` 由 `apps/worker` 创建或复用 issue 后传入，coding agent 不自行创建 issue。

## Callback Signing

workflow callback 使用短期 callback nonce 或 GitHub OIDC 换取短期 token。

当前推荐先用 HMAC nonce：

```text
X-Pages-Callback-Timestamp: 2026-06-12T10:00:00Z
X-Pages-Callback-Attempt-Id: attempt_...
X-Pages-Callback-Signature: sha256=<hex>
```

签名内容：

```text
timestamp + "\n" + attemptId + "\n" + sha256(body)
```

gateway 校验：

- timestamp 未过期，建议 5 分钟。
- `attemptId` 是当前有效 attempt。
- nonce hash 匹配 DB 中 `callback_nonce_hash`。
- stage type 和当前 job status 允许接收该 callback。
- 旧 attempt callback 只能写 `AuditLog`，不能改当前状态。

当前使用 `scripts/post-executor-callback.js` 发送 callback。该 helper 会在网络错误或 `408 / 425 / 429 / 5xx` 响应时重试，避免 tunnel 或 Ingress 瞬时 502 直接丢掉 workflow 结果；`401`、`400` 这类确定性配置错误不会重试，应直接修 token、origin 或 payload。callback 目标必须是 K8s gateway 对外暴露的 `/internal/executor-callback`。

## Callback Body

统一 callback body：

```json
{
  "publishingJobId": "job_...",
  "jobStageId": "stage_...",
  "attemptId": "attempt_...",
  "executorType": "github_actions",
  "workflowName": "pages-agent.yml",
  "workflowRunId": "123456789",
  "workflowRunAttempt": 1,
  "status": "running | succeeded | failed",
  "stageResult": "index_ready | patch_generated | pr_created | reviewing | preview_deployed | deployed",
  "baseRef": "staging",
  "headSha": "abc123",
  "branchName": "sites/job-job_123-zhangsan-profile",
  "prNumber": 123,
  "issueNumber": 456,
  "indexSnapshotId": "idxsnap_...",
  "previewUrl": "https://pr-123-zhangsan-profile-staging.workers.xd.team",
  "deployId": "deploy_...",
  "errorCode": null,
  "errorMessage": null,
  "artifacts": [
    {
      "name": "agent-report",
      "url": "https://github.example/actions/runs/123/artifacts/456",
      "sha256": "..."
    }
  ],
  "report": {}
}
```

`status=failed` 必须带：

```json
{
  "errorCode": "PATH_ALLOWLIST_FAILED",
  "errorMessage": "Patch touched apps/gateway."
}
```

## `project-index.yml`

`project-index.yml` 为 coding agent 准备受控上下文。它可以在 repo 变更后预先运行，也可以在 `PublishingJob` 创建后由 gateway dispatch。

Required steps:

```text
checkout exact base ref / SHA
load include / exclude rules
scan sites / templates / page-kit / related issue and review metadata
generate manifest and context bundle
upload index artifact
callback gateway with index_snapshot_id / artifact_ref
```

Rules:

- indexer 只读 repo 和平台元数据。
- indexer 不创建 PR、不 push、不 merge、不 deploy。
- index artifact 不得包含 secret 明文。
- `pages-agent.yml` 只能读取 gateway 绑定到当前 job 的 `index_snapshot_id`。

Current dispatch owner:

```text
apps/worker
  ensure issue exists
  dispatch project-index.yml with issueNumber + allowedPath + baseRef
```

## `pages-agent.yml`

### Modes

```text
mode: initial | fix
```

`initial` 输入来自 gateway / worker 受控 `workflow_dispatch` inputs。GitHub issue body 可以携带 `PublishingJob:`、`Target:`、`Allowed path:` 和 `Base ref:` 供人工追踪，但不能作为最终可信输入；gateway 必须先处理 GitHub `issues` webhook，再启动 `pages-agent.yml`。

`initial` 输入：

- issue number
- Slack summary
- target site info
- allowed path
- template info

`fix` 额外输入：

- PR number
- branch name
- open blocking `ReviewAgentComment` ids
- fix round number
- Slack follow-up summary / latest preview feedback, if the fix is user-driven

### Required Steps

```text
checkout `baseRef`
load job context from workflow input
load issue body
if mode=fix, checkout existing agent branch before coding
run coding agent
generate patch
validate patch path allowlist
validate site.json schema
secret scan
file size and forbidden path check
lint / test / build
controlled commit
create or update PR against `baseRef`
callback gateway
```

Current contract:

- `initial` 成功 callback `stageResult=pr_created`。
- `fix` 成功 callback `stageResult=reviewing`，因为同一个 PR 已存在，gateway 只需要更新 branch / PR / head SHA 并把 job 从 `fixing` 推回 `reviewing`。
- `fix` 必须复用原 PR branch。若原 branch 不存在，workflow 失败并 callback `status=failed`，不能从 `baseRef` 静默重新创建一个无历史的新 PR。
- `apps/worker` 在 dispatch `mode=fix` 前追加原 issue comment，comment body 必须包含 `PublishingJob:`、`Allowed path:` 和最新 Slack follow-up summary。

### Controlled Commit Rules

The workflow may use a GitHub App installation token only after validation passes.

Allowed:

- create branch with prefix `sites/job-<jobId>-<employeeSlug>-<siteSlug>`
- commit only under `allowedPath`
- create or update one PR

Forbidden:

- modify `.github/**`, `apps/**`, `packages/**`, `templates/**`, `k8s/**`
- merge PR
- publish production
- read Slack bot token
- read Cloudflare production token
- use `pull_request_target` to execute untrusted PR code

### Outputs

Callback on success:

```json
{
  "stageResult": "pr_created | reviewing",
  "branchName": "sites/job-job_123-zhangsan-profile",
  "prNumber": 123,
  "headSha": "..."
}
```

## `site-check.yml`

`site-check` 是 GitHub Rulesets required check。

它必须调用 `packages/site-check`，不能在 workflow 里临时复制一份规则。`pages-agent.yml` 的 precheck 也应复用同一个包，但 precheck 不能替代 PR required check。

Trigger:

```text
pull_request
```

Required checks:

- PR has `PublishingJob` marker in body.
- PR modifies exactly one `sites/<employee>/<site>/`.
- PR path matches recorded `allowedPath`.
- no platform path changed.
- `site.json` schema valid.
- no secret found.
- file size limit passed.
- no build artifact committed.
- lint / test / build passed.
- `pages-site-policy` passed against gateway / DB.

Outputs:

```json
{
  "stageResult": "site_check_completed",
  "siteCheckRunId": "check_...",
  "publishingJobId": "job_...",
  "prNumber": 123,
  "headSha": "abc123",
  "allowedPath": "sites/zhangsan/profile",
  "status": "passed | failed",
  "reportArtifactRef": "..."
}
```

Rules:

- `site-check` 不依赖 agent workflow 的结果。PR 分支才是 merge / preview 前真相。
- `site-check` 不能读取 Slack token、Cloudflare token、production deploy token 或 GitHub push token。
- `site-check` 结果必须通过 gateway callback 或 GitHub `check_run` webhook 写入 `SiteCheckRun`。
- 如果 gateway 无法持久化当前 PR head SHA 的 `SiteCheckRun`，Preview Gate 必须视为未通过。
- 任何触碰 `apps/**`、`packages/**`、`.github/**`、`k8s/**`、`templates/**`、`scripts/**` 的自动 PR 必须失败并转人工。

## `pages-preview.yml`

Preview 只能在 PR 创建、`site-check` / `pages-site-policy` 成功且 Review Agent gate 通过后触发。不能在 gate 之前仅因为 PR 已创建就部署 Preview。

Inputs:

```json
{
  "publishingJobId": "job_...",
  "prNumber": 123,
  "headSha": "abc123",
  "siteProjectId": "site_...",
  "employeeSlug": "zhangsan",
  "siteSlug": "profile",
  "allowedPath": "sites/zhangsan/profile",
  "previewSiteName": "pm-pr-123-zhangsan-profile",
  "previewHostname": "pr-123-zhangsan-profile-staging.workers.xd.team"
}
```

Rules:

- preview token and production token are separate.
- 当前 preview 复用现有 `pages-manager` deploy API: `POST ${PAGES_API}/deploy`.
- workflow secret `PAGES_PREVIEW_TOKEN` or `PAGES_TOKEN` is passed as `X-Pages-Token` only as a compatibility marker for the legacy `/deploy` API.
- This compatibility marker is a platform preview deploy identity, not an employee-owned Cloudflare token.
- Long-term preview deploy auth should be gateway/deployer service auth or a short-lived identity scoped to `ownerScopeId` / `siteProjectId` / `publishingJobId`.
- `previewSiteName` must follow the existing global pages site name rule.
- deploy source is `sites/<employee>/<site>/src` from the exact PR head SHA.
- preview can use staging/preview Cloudflare resource pool only.
- preview deploy uses PR head SHA or controlled agent branch.
- preview auto-merge/deploy does not merge to main or production.
- preview requires current-head `SiteCheckRun.status=passed`.
- preview requires `pages-site-policy=passed`.
- preview requires PR diff only touches `allowedPath`.
- preview requires no open blocking / unknown `ReviewAgentComment`.
- preview failure writes `JobEvent`, but does not auto-merge or production deploy.
- preview URL must be callbacked to gateway and posted to PR / Slack.

## `pages-production-deploy.yml`

Production deploy only runs after merge has been recorded by gateway.

Inputs:

```json
{
  "publishingJobId": "job_...",
  "deployRecordId": "deploy_...",
  "repoFullName": "org/pages-manager",
  "prNumber": 123,
  "mergeCommitSha": "abc123",
  "siteProjectId": "site_...",
  "resourcePoolId": "cfpool_..."
}
```

Rules:

- checkout exact `mergeCommitSha`.
- never deploy from floating branch.
- production Cloudflare token only available in production environment.
- callback gateway with `deployId`, URL, manifest key and status.
- do not send Slack directly.

## Concurrency

Use GitHub Actions concurrency:

```yaml
concurrency:
  group: pages-site-${{ inputs.siteProjectId }}
  cancel-in-progress: false
```

Rules:

- same `SiteProject` serializes.
- different sites can run in parallel.
- fix round reuses same PR branch.
- if a new request targets same site, gateway should queue or ask for human confirmation.

## Artifact Names

| Artifact | Producer | Contents |
| --- | --- | --- |
| `project-index` | `project-index.yml` | manifest, context bundle, metadata, no secret |
| `agent-report` | `pages-agent.yml` | `report.json`, model summary, changed files |
| `candidate-patch` | `pages-agent.yml` | sanitized patch, not production secret |
| `site-build-report` | `site-check.yml` | build logs summary, not full secret logs |
| `preview-report` | `pages-preview.yml` | preview URL, artifact manifest |
| `deploy-report` | `pages-production-deploy.yml` | deploy id, manifest key, resource pool |

Artifacts must not contain Slack token, Cloudflare token, GitHub private key, `.env`, or raw user secret.

## Failure Codes

| Code | Meaning | Retry |
| --- | --- | --- |
| `JOB_CONTEXT_LOAD_FAILED` | gateway context unavailable | yes |
| `PROJECT_INDEX_FAILED` | project index or context bundle failed | yes |
| `PROJECT_INDEX_STALE` | index snapshot does not match expected base SHA | yes |
| `ISSUE_LOAD_FAILED` | GitHub issue read failed | yes |
| `AGENT_FAILED` | coding agent failed | maybe |
| `PATH_ALLOWLIST_FAILED` | patch touched forbidden path | no, needs new agent run |
| `SITE_SCHEMA_FAILED` | `site.json` invalid | fix |
| `SECRET_SCAN_FAILED` | secret detected | no auto-commit |
| `BUILD_FAILED` | lint/test/build failed | fix |
| `PR_CREATE_FAILED` | branch/PR API failed | yes |
| `PREVIEW_DEPLOY_FAILED` | preview failed | yes |
| `PRODUCTION_DEPLOY_FAILED` | production deploy failed | yes |

## Implementation Order

1. Add gateway endpoint for executor callback and attempt validation.
2. Add `project-index.yml` as no-op workflow that creates a placeholder `ProjectIndexSnapshot`.
3. Add `pages-agent.yml` as no-op workflow that loads the job context and index snapshot.
4. Add `site-check.yml` with path allowlist and schema placeholder.
5. Add controlled commit step.
6. Add preview workflow.
7. Add failure code mapping and Slack notifier messages.
8. After the Preview loop is stable, add production deploy workflow from exact `mergeCommitSha`.
