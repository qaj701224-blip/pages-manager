# GitHub CLI Local Dev

## 定位

本地 `gh` CLI 已经配置好，可以作为 MVP 开发期的冒烟测试工具。

它适合用来验证：

- 当前本机能访问 `pages-manager` repo。
- issue 创建是否可用。
- PR 查询是否可用。
- GitHub Actions workflow dispatch 是否可用。
- workflow run 状态和日志是否可读。
- Review Agent comment 是否能从 PR 中读到。

它不适合作为生产运行身份。

生产平台自动化仍然必须使用：

```text
GitHub App installation token
gateway / worker / workflow callback
GitHub webhook
DB audit
```

不能让 `pages-gateway`、GitHub Actions、worker 或 K8s job 依赖某个开发者机器上的 `gh` 登录态。

## 当前本地确认

本机已确认：

```text
gh CLI 可用
repo: xindong/pages-manager
default branch: master
automation base branch: staging
remote: git@github.com:xindong/pages-manager.git
```

不要把 `gh auth status` 输出里的 token 写进文档、环境变量、issue、PR 或日志。即使是 masked token，也只用于排障时临时确认，不作为配置来源。

## 可做的本地冒烟测试

### 1. 确认登录和 repo

```bash
gh auth status
gh repo view --json nameWithOwner,url,isPrivate,defaultBranchRef
git remote -v
```

### 2. 创建测试 issue

用于验证 GitHub issue API、权限和模板：

```bash
gh issue create \
  --title "[MVP smoke] Slack to Preview test" \
  --body "Created by local gh CLI smoke test. Do not use as production automation identity."
```

如果创建了真实 issue，测试结束后应关闭并标注为 smoke test。

### 3. 触发 workflow

`project-index.yml`、`pages-agent.yml`、`pages-preview.yml` 落地后，可以用本地 `gh` 手动触发 workflow：

```bash
gh workflow run project-index.yml \
  --ref master \
  -f publishingJobId=job_smoke \
  -f siteProjectId=site_smoke \
  -f allowedPath=sites/smoke/profile \
  -f baseRef=staging

gh run list --workflow project-index.yml --limit 5
gh run view <run-id> --log
```

这只用于本地调试。正式流程必须由 `pages-gateway` 创建 `JobStageAttempt` 后触发 workflow，并通过 callback 签名推进状态机。

`--ref` 表示从哪个分支读取和执行 workflow；`baseRef` 表示 Project Index / Pages Agent 以哪个业务分支作为生成和 PR base。MVP 默认 `baseRef=staging`，避免自动生成的站点 PR 直接指向 `master`。

如果是反复验证 Slack 到 PR 的本地 smoke，不要每次都新建 PR。worker 应启用：

```text
PAGES_ISSUE_MODE=smoke_single
PAGES_PR_MODE=smoke_single
PAGES_SMOKE_PR_BRANCH=sites/smoke-local-slack-smoke-profile
```

此时 `gh` 只用于观察固定 smoke issue / PR 的状态，不作为平台运行时。

### 4. 查询 PR 和 Review Agent comment

用于验证 PR comment 读取能力：

```bash
gh pr view <pr-number> --json number,title,headRefName,headRefOid,reviewDecision,comments,reviews
gh pr checks <pr-number>
```

平台实现不能靠 `gh pr view` 轮询。正式运行必须通过 GitHub webhook 写入 `GitHubWebhookDelivery` 和 `ReviewAgentComment`。

### 5. 暴露本地 gateway callback

当本地 worker 从 `issue_only` 切到 `actions` 后，GitHub Actions runner 会从 GitHub 云端回调本机 gateway：

```text
GitHub Actions runner
  ↓
https://<public-tunnel>/internal/executor-callback
  ↓
http://localhost:8788/internal/executor-callback
```

Slack Socket Mode 不需要公网 tunnel，因为它是本机主动连 Slack。当前 tunnel 只给 GitHub Actions callback 用；后续接 GitHub webhook 监听 Review Agent comment 时，也可以先复用同一个 gateway tunnel。

推荐本地临时调试用 Cloudflare quick tunnel：

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:8788
```

启动后终端会打印一个 `https://*.trycloudflare.com` URL。把它拼成 callback URL：

```bash
export PAGES_PUBLIC_GATEWAY_URL='https://example.trycloudflare.com'
export PAGES_GATEWAY_CALLBACK_URL="$PAGES_PUBLIC_GATEWAY_URL/internal/executor-callback"
```

本地 gateway 和 GitHub Actions 必须使用同一个 callback token。gateway 启动时使用：

```bash
INTERNAL_CALLBACK_TOKEN='local-callback-secret'
```

GitHub workflow 里读取的是 `secrets.PAGES_CALLBACK_TOKEN`。如果这是个人本地 smoke repo，可以临时设置：

```bash
gh secret set PAGES_CALLBACK_TOKEN \
  --repo xindong/pages-manager \
  --body 'local-callback-secret'
```

workflow 还会在发送 token 前校验 callback URL origin。把 tunnel origin 加入 repo variable：

```bash
gh variable set PAGES_CALLBACK_ALLOWED_ORIGINS \
  --repo xindong/pages-manager \
  --body "$PAGES_PUBLIC_GATEWAY_URL"
```

如果团队已经把 `PAGES_CALLBACK_TOKEN` 用作共享或生产 secret，不要覆盖它；应先约定一个 dev-only secret 或改 workflow 支持环境级 secret。

可以用这两个命令确认 tunnel 通了：

```bash
curl -sS "$PAGES_PUBLIC_GATEWAY_URL/health"

curl -i -X POST "$PAGES_GATEWAY_CALLBACK_URL" \
  -H 'Content-Type: application/json' \
  -H 'X-Pages-Callback-Token: local-callback-secret' \
  -d '{"publishingJobId":"job_fake","stageResult":"index_ready","indexSnapshotId":"idx_fake"}'
```

第二个请求返回 `PublishingJob not found` 是正常的，表示公网能打到本机 gateway 且 callback token 通过了；如果返回 `Invalid callback token`，说明 GitHub secret / 本地 `INTERNAL_CALLBACK_TOKEN` 不一致。

## 本地 CLI 与平台身份的边界

| 场景                     | 可以用 `gh` CLI | 生产必须用                      |
| ------------------------ | --------------- | ------------------------------- |
| 手动创建 smoke issue     | yes             | GitHub App                      |
| 手动触发 workflow 冒烟   | yes             | gateway dispatch                |
| 查看 run 日志            | yes             | GitHub API / Actions callback   |
| 读取 PR comments 排障    | yes             | GitHub webhook                  |
| controlled commit        | no              | GitHub App installation token   |
| 自动 PR / Preview 主链路 | no              | gateway + workflow              |
| production deploy        | no              | 受控 deploy workflow / deployer |

## 安全红线

- 不把个人 `gh` token 写入 `.env`、GitHub Actions secret、DB 或文档。
- 不用个人 `gh` token 做平台 production 自动化。
- 不让本地 `gh` 创建的 issue / workflow run 绕过 `PublishingJob` 和 `AuditLog`。
- 不把 `gh` CLI 当成 worker runtime。
- 不用 `gh` CLI 代替 GitHub webhook 监听 Review Agent comment。

## 对第一优先级的帮助

本地 `gh` CLI 可以让第一阶段更快验证这些点：

```text
repo access
  ↓
issue create
  ↓
workflow dispatch
  ↓
PR query
  ↓
Review Agent comment visibility
```

验证通过后，再把同样动作接回正式链路：

```text
Slack -> gateway -> PublishingJob -> GitHub App -> workflow -> webhook -> Preview -> Slack
```
