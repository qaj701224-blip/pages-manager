# Legacy Deploy Wrapper

## 定位

现有 `pages-manager` 已有 Cloudflare deploy 能力。MVP 可以复用它，但必须包进新平台的权限、状态机、DeployRecord 和审计模型里。

目标：

```text
legacy /deploy capability
  ↓
controlled deploy adapter
  ↓
DeployRecord + CloudflareResourcePool + AuditLog
```

非目标：

- 不让用户继续用弱 `X-Pages-Token` 绕过 issue / PR / review。
- 不从 floating branch 部署 production。
- 不让 coding agent 或 site-check workflow 拿 production Cloudflare token。

## Deploy Modes

| Mode | MVP 行为 |
| --- | --- |
| preview | PR head SHA 构建后发布到 preview resource pool |
| production | PR merge 后，从 recorded `merge_commit_sha` 构建并发布 |

production 输入必须有：

```text
repo_full_name
pr_number
merge_commit_sha
site_project_id
publishing_job_id
resource_pool_id
```

## Adapter Boundary

新增 `deploy-core` 适配层：

```text
packages/deploy-core
  ├─ buildSiteArtifact()
  ├─ publishPreview()
  ├─ publishProduction()
  ├─ writeRuntimeSnapshot()
  └─ callLegacyDeployApi()
```

`apps/server` 的现有 `/deploy` 可以短期作为底层能力，但新平台入口必须是：

```text
pages-gateway
  ↓ creates deploy stage
pages-production-deploy workflow 或受控 deployer
  ↓ calls deploy-core
legacy deploy capability
```

## Production Deploy Contract

production deploy workflow input：

```json
{
  "publishingJobId": "job_...",
  "deployRecordId": "deploy_...",
  "siteProjectId": "site_...",
  "repoFullName": "org/pages-manager",
  "prNumber": 123,
  "mergeCommitSha": "abc123",
  "resourcePoolId": "cfpool_prod"
}
```

Required checks before deploy:

- `PublishingJob.status = merged | deploying`。
- `DeployRecord.status = pending | deploying`。
- `mergeCommitSha` matches recorded PR merge event。
- `siteProjectId` matches PR target path。
- production Cloudflare resource pool is active。
- actor/action has deploy permission or is system after merge.

## Legacy `/deploy` Call

If calling legacy `/deploy`, adapter must supply platform-managed identity:

```json
{
  "siteName": "zhangsan-profile",
  "environment": "production",
  "source": "pages-platform",
  "siteProjectId": "site_...",
  "publishingJobId": "job_...",
  "repoFullName": "org/pages-manager",
  "prNumber": 123,
  "mergeCommitSha": "abc123",
  "artifactRef": "r2://pages-builds/...",
  "accessPolicySnapshot": {}
}
```

Legacy token rules:

- `X-Pages-Token` remains compatibility marker only.
- New platform deploy auth must be gateway/deployer secret or internal service auth.
- API response must never expose stored token or Cloudflare secret.

## DeployRecord Lifecycle

```text
pending
  ↓
deploying
  ↓
deployed
```

Failure:

```text
deploying
  ↓
failed
```

Rollback later:

```text
deployed
  ↓
rolled_back
```

Idempotency:

```text
unique(site_project_id, environment, merge_commit_sha)
```

If the same merge SHA deploy is retried:

- reuse existing `DeployRecord` if pending/failed.
- no duplicate production deploy records.
- callback only updates current attempt.

## Cloudflare Resource Pool

MVP can still publish using existing one-site-one-worker behavior if needed, but platform data model must already speak resource pool:

```text
CloudflareResourcePool(production)
  edge_worker_name
  config_kv_namespace
  assets_bucket
  route_pattern
```

Long-term target:

- small number of platform Edge Workers.
- small number of platform KV namespaces.
- assets/R2 immutable deploy prefix.
- DB is truth source; KV is runtime snapshot.

禁止：

- 每站点默认创建独立 KV namespace。
- 员工自己申请 Cloudflare token。
- site PR workflow 读取 production token。

## Runtime Snapshot

After deploy, gateway/deployer writes a snapshot for Edge Worker:

```json
{
  "siteProjectId": "site_...",
  "deployId": "deploy_...",
  "hostname": "zhangsan-profile.workers.xd.team",
  "assetsPrefix": "sites/site_.../deploy_...",
  "manifestKey": "deploy/deploy_.../manifest.json",
  "accessPolicyVersion": 3
}
```

KV key examples:

```text
host:<hostname>
site:<siteProjectId>:current
deploy:<deployId>:manifest
access:<siteProjectId>:policy
```

## Audit

Every deploy writes:

- `DeployRecord`
- `JobEvent`
- `AuditLog`
- PR comment
- issue comment
- Slack thread message via `slack-notifier`

AuditLog required data:

```json
{
  "action": "production_deploy",
  "siteProjectId": "site_...",
  "publishingJobId": "job_...",
  "repoFullName": "org/pages-manager",
  "prNumber": 123,
  "mergeCommitSha": "abc123",
  "deployRecordId": "deploy_...",
  "resourcePoolId": "cfpool_prod"
}
```

## Failure Handling

| Failure | Job behavior | User message |
| --- | --- | --- |
| build failed | `deploying -> failed` | production build failed from merge SHA |
| Cloudflare API failed | retryable failed stage | Cloudflare deploy failed, retry available |
| KV snapshot failed | deploy failed unless previous snapshot intact and explicit partial allowed | runtime config update failed |
| duplicate deploy | idempotent success or existing record returned | existing deploy found |

Merged PR should remain merged even if deploy fails. Gateway creates a deploy retry task, not a code rollback automatically.

## Implementation Order

1. Extract deploy-core wrapper around current deploy behavior.
2. Create `CloudflareResourcePool` seed data for preview and production.
3. Create `DeployRecord` before calling Cloudflare.
4. Make production deploy require `mergeCommitSha`.
5. Add callback from production workflow to gateway.
6. Write runtime snapshot and update `SiteProject.current_deploy_id`.
7. Add Slack / issue / PR deploy messages.
8. Lock down legacy `/deploy` so it cannot bypass platform auth for production.
