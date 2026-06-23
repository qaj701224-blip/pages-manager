# GitHub Automation

本文是 GitHub 相关设计的唯一主入口，覆盖 GitHub Enterprise、分支策略、Actions executor、webhook、Review Agent、runtime 配置和本地 `gh` 排障边界。

## 当前定位

`pages-manager` 的 issue、PR、review、site-check、workflow dispatch、preview gate 和平台自身开发 PR 都在 `xindong/pages-manager` 仓库内闭环。

用户不需要拥有这个 repo 的 GitHub 写权限才能通过 Slack 发起站点发布或平台开发 issue。GitHub 写操作由平台身份完成，Slack 用户身份只用于 gateway 内部权限判断、审计、站点归属派生和平台 issue 请求人记录。

当前代码路径：

| 能力                                       | 代码位置                                                                                                    |
| ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| GitHub webhook HTTP 入口                   | `apps/gateway/src/routes/github-routes.js`、`apps/gateway/src/control-plane/handlers.js`                     |
| GitHub webhook 事件解析                    | `apps/gateway/src/github/webhook.js`                                                                        |
| Review Agent allowlist / 分类              | `apps/gateway/src/github/review.js`                                                                         |
| GitHub delivery / review / site-check 入库 | `apps/gateway/src/db/repositories/github-deliveries.js`、`apps/gateway/src/db/repositories/review-gates.js` |
| GitHub issue / workflow dispatch           | `apps/worker/src/jobs/issue-and-index.js`、`apps/worker/src/jobs/coding-agent.js`、`packages/git-client/src/` |
| Coding Agent workflow                      | `.github/workflows/pages-agent.yml`                                                                         |
| Platform Dev Coding Agent workflow         | `.github/workflows/platform-agent.yml`                                                                      |
| Project index workflow                     | `.github/workflows/project-index.yml`                                                                       |
| 站点 required check                        | `.github/workflows/site-check.yml`                                                                          |
| Preview workflow 兼容路径                  | `.github/workflows/pages-preview.yml`                                                                       |

## 身份和权限

长期平台身份应使用 GitHub App installation token。当前测试环境可以通过 `GITHUB_APP_INSTALLATION_TOKEN` 或 `GITHUB_TOKEN` 注入给 `apps/worker`，但不能把个人 PAT 当成长期产品身份。

推荐 GitHub App 权限：

| 权限          | 级别       | 用途                               |
| ------------- | ---------- | ---------------------------------- |
| Metadata      | read       | repo 基础信息                      |
| Contents      | read/write | 创建受控 branch / commit           |
| Issues        | read/write | 创建 issue、追加 comment、同步状态 |
| Pull requests | read/write | 创建 / 更新 PR、读取 review 状态   |
| Checks        | read       | 读取 CI / site-check 结果          |
| Actions       | read/write | dispatch workflow，读取 run 状态   |

红线：

- GitHub App 不持有 Slack bot token。
- GitHub App 不持有 Cloudflare production token。
- Coding Agent 不能直接拿 Slack token、Cloudflare token 或 auto-merge token。
- `Contents: write` 是 repo 级能力，不是 path-scoped token；路径隔离必须靠 diff validator、allowed path、Rulesets、required checks 和 gateway DB 权限判断兜底。

## Workflow 分层

平台本体 workflow：

```text
.github/workflows/ci.yml
.github/workflows/deploy-staging.yml
.github/workflows/deploy-pages-v2-staging.yml
.github/workflows/deploy.yml
.github/workflows/deploy-pages-v2.yml
.github/workflows/deploy-ack-preview.yml
.github/workflows/sync-master-pr-to-staging.yml
```

这些 workflow 处理平台代码、v1 `apps/server` Cloudflare Worker、v2 `apps/pages-api` / `apps/pages-auth` / `apps/pages-router` / `apps/kv-gateway` Cloudflare Worker、ACK 镜像和 K8s Deployment。它们可以在受控环境读取平台部署 secret。

用户站点发布执行器 workflow：

```text
.github/workflows/project-index.yml
.github/workflows/pages-agent.yml
.github/workflows/site-check.yml
.github/workflows/pages-preview.yml
```

这些 workflow 只处理 `PublishingJob` 和 `sites/<employeeSlug>/<siteSlug>/`。它们不能读取 Aliyun AK、ACR、`KUBE_CONFIG_B64`、`kubectl`、Slack bot token 或 production Cloudflare token。

平台研发执行器 workflow：

```text
.github/workflows/platform-agent.yml
```

这条 workflow 只处理 `lane:platform-dev` issue。它可以在受控分支上修改 `pages-manager` repo 全目录，但不能读取 Slack bot token、生产部署 secret、Aliyun AK、ACR、`KUBE_CONFIG_B64` 或自动 merge token。`.github/**`、`k8s/**`、Dockerfile、部署脚本、secret、production deploy 相关变更必须走高风险 gate 和人工 review。

当前执行边界：

```text
Slack / API
  -> apps/gateway 创建或更新 PublishingJob
  -> apps/worker 创建 issue
  -> GitHub issues webhook 回到 gateway
  -> apps/worker dispatch project-index.yml / pages-agent.yml
  -> pages-agent.yml 生成站点代码并创建 / 更新 PR
  -> site-check.yml 和 GitHub Review Agent 产生结果
  -> GitHub webhook 回到 gateway
  -> Review gate 通过后由 worker 触发 preview
```

Platform Dev Lane 执行边界：

```text
Slack / API
  -> apps/gateway 分类 issue type / area / risk
  -> apps/gateway 创建 PlatformDevItem / work item link / risk gate
  -> apps/worker 创建 pages-manager issue + label
  -> gateway 判断 agent eligible / gate approved / blocked
  -> apps/worker dispatch platform-agent.yml
  -> platform-agent.yml 修改 repo 全目录内相关文件并创建 PR
  -> GitHub CI / review / webhook 回到 gateway
  -> gateway / slack-notifier 回写 PR、CI、review、merge / close 状态
```

当前 ECS 验证路径使用 `PAGES_PREVIEW_MODE=local_deploy`：`pages-worker` 从 PR head 读取目标站点文件，并用固定 ECS 出口调用 Cloudflare staging `/deploy`。这样避免 GitHub-hosted runner 的动态出口 IP 进入 Cloudflare staging 白名单。

## 分支和部署策略

平台代码以 `master` 为生产真相源，`staging` 是共享 preview 分支，用来提前部署和验证指向 `master` 的项目类 PR：

```text
feature branch
  -> PR to master
  -> sync PR head to staging preview
  -> staging preview / validation
  -> merge PR to master
  -> manual production deploy
```

规则：

- 默认所有 feature、fix、docs、ci、build 分支 PR 到 `master`。
- `staging` 只作为 preview 分支，不是晋级来源，不能从 `staging` 反向晋级到 `master`。
- production 只允许人工触发 `Deploy Production` / `workflow_dispatch`，不能在 push 或 PR 上自动部署。
- 项目类 PR 指向 `master` 后，由 `Sync Master PR To Staging` 把 PR head merge 到 `staging` 做预览验证。
- 纯 `sites/**` 用户站点 PR 跳过 master PR -> staging 同步，继续走 `site-check` 和 Review gate。
- `staging` 被废弃 PR 污染时，由维护者确认没有活跃 preview 后重新对齐 `master`，再重新触发需要验证的 PR。

### Master PR 同步 Staging 预览

`Sync Master PR To Staging` 对齐 xdclaw `sync-mr-to-preview` 的语义：项目类 PR 指向 `master` 后，先把该 PR 的 head 提前合入 `staging`，让 staging 尽早跑预览部署和验证。

触发条件：

```text
pull_request.opened / synchronize / reopened / ready_for_review
base: master
```

执行规则：

- Draft PR、跨仓库 PR、`sites/*` head branch 和只修改 `sites/**` 的 PR 都跳过。
- workflow 从 `origin/staging` 创建临时工作分支，fetch PR head，并确认 fetch 到的 commit 与 PR head sha 一致。
- merge 成功后先 push 到 `staging-sync/pr-<number>-<sha>` 临时分支，并 dispatch `CI` 在该 merge commit 上运行 `check`。
- `check` 成功后再把同一个已验证 commit push 到 `staging`，满足 `staging` ruleset 的 required status check。
- 由于 GitHub `GITHUB_TOKEN` 产生的 push 不会自动触发后续 push workflow，同步 workflow 必须显式 dispatch `Deploy XD Pages Staging`，并等待 `Deploy XD Pages Staging` 完成。
- v1 平台变更 dispatch `deploy-staging.yml`；v2 平台变更 dispatch `deploy-pages-v2-staging.yml` 且 `component=all`。
- 如果 PR head 无法干净 merge 到 `staging`，或者临时分支 `CI` 失败，workflow 失败并转人工处理。
- 这条 workflow 只使用 GitHub `GITHUB_TOKEN`，不读取 Cloudflare、Aliyun、ACR、ACK 或用户发布执行器 secret。

## Worker 配置

`apps/worker/src/config.js` 当前读取这些关键配置：

| 变量                                                     | 用途                                               |
| -------------------------------------------------------- | -------------------------------------------------- |
| `GITHUB_REPO`                                            | 目标 repo，例如 `xindong/pages-manager`            |
| `GITHUB_ENTERPRISE_API_BASE_URL` / `GITHUB_API_BASE_URL` | GitHub API base URL，默认 `https://api.github.com` |
| `GITHUB_APP_INSTALLATION_TOKEN` / `GITHUB_TOKEN`         | 平台 GitHub 写入身份                               |
| `PAGES_EXECUTOR_MODE`                                    | `actions`、`github_issue_webhook` 或 `issue_only`  |
| `PAGES_WORKFLOW_REF`                                     | workflow 文件读取分支                              |
| `PAGES_BASE_REF` / `PAGES_PR_BASE_REF`                   | index、agent checkout 和 PR base                   |
| `PAGES_GATEWAY_CALLBACK_URL`                             | GitHub Actions runner 回调公网 gateway             |
| `PAGES_WORKER_CALLBACK_URL` / `PAGES_GATEWAY_URL`        | worker 到 gateway 的内部 callback                  |
| `INTERNAL_CALLBACK_TOKEN`                                | executor callback shared token                     |
| `PAGES_PREVIEW_MODE`                                     | `actions` 或 `local_deploy`                        |
| `PAGES_API`                                              | Cloudflare staging / production API                |

`workflowRef` 和 `baseRef` 必须分开理解：

- `PAGES_WORKFLOW_REF` 决定从哪个分支读取 workflow。
- `PAGES_BASE_REF` 决定生成站点 PR 的 base。
- 当前预览验证通常使用 `staging`，生产合入仍以 `master` 为真相源。

## Repository Webhook

GitHub webhook 统一打到：

```text
POST /integrations/github/webhook
```

gateway 必须校验：

- `X-Hub-Signature-256`
- `X-GitHub-Delivery`
- `X-GitHub-Event`
- `repository.full_name` 是否等于允许的 repo
- delivery 幂等是否已处理

当前需要关注的事件：

| Event                         | 用途                                               |
| ----------------------------- | -------------------------------------------------- |
| `issues`                      | issue 创建 / 编辑后触发后续 workflow               |
| `issue_comment`               | Review Agent summary、人工状态指令、issue 追加需求 |
| `pull_request_review`         | Review Agent 或人工 review 总结                    |
| `pull_request_review_comment` | Review Agent inline comment                        |
| `check_run`                   | site-check / CI 结果和 Review gate                 |

delivery 写入 `github_webhook_deliveries`，Review Agent comment 写入 `review_agent_comments`，site-check 写入 `site_check_runs`。这些都是 MySQL 真相源。

## Review Agent Gate

Review Agent 不是 Coding Agent，也不是 gateway 内置 reviewer。它作为 GitHub PR 外部 reviewer 产生 comment / review / check output，再由 GitHub webhook 回到 gateway。

处理规则：

- 只有 allowlist 命中的 bot login / app / check name 才能作为 Review Agent。
- comment 先入库，再分类为 `blocking`、`suggestion`、`note` 或 `unknown`。
- blocking / unknown 不放行 preview。
- suggestion / note 可以放行 preview，但需要在 Slack 进度消息中提示。
- 如果 Review Agent 超时没有返回最终评论，gateway 的 review gate watchdog 可以记录一条兜底结果，避免任务永久卡住。
- 同一个 PR / job 同一时间只允许一个 Coding Agent fix round；Slack follow-up 和 Review Agent comment 都进入同一条修复队列。

Review gate 当前实现在 gateway 内，后续可以拆成独立 worker，但不能退化成本机 `gh pr view` 轮询。

## 站点 PR 边界

自动站点 PR 只能改一个目录：

```text
sites/<employeeSlug>/<siteSlug>/
```

禁止改：

```text
.github/**
apps/**
packages/**
k8s/**
scripts/**
Dockerfile*
docs/** 中的平台部署文档
```

如果用户需求需要改平台代码、workflow、模板、K8s 或部署逻辑，不能走 Site Publishing Lane；应转入 Platform Dev Lane 或人工平台 PR，并按 issue type、risk gate、CI 和 review 控制。

## Platform Dev PR 边界

Platform Dev Lane 的目标就是修改 `pages-manager` 平台代码，因此不使用 `sites/<employeeSlug>/<siteSlug>/` 作为 allowed path。它允许修改 repo 全目录，但必须按 issue type 和 risk gate 控制：

```text
docs/**
tests/**
apps/**
packages/**
scripts/**
k8s/**
.github/**
Dockerfile*
```

规则：

- 所有改动必须来自 `lane:platform-dev` issue，PR body 必须引用该 issue 和 Slack thread。
- `type:dev`、`type:bug`、`type:docs` 可以进入自动开发候选。
- `type:feedback`、`type:question` 默认只沉淀和归纳，不自动改代码。
- `type:ci`、`type:ops`、`type:security` 默认 `agent:blocked`，需要人工 gate。
- `.github/**`、`k8s/**`、Dockerfile、部署脚本、secret、production deploy 相关改动必须在 PR 中标记 `risk:high`，并由人工 review 放行。
- production workflow 仍只能手动触发；Platform Dev Lane 不能引入 push/PR 自动生产部署。
- Coding Agent 不能 merge PR，也不能 resolve review thread 作为放行依据。

Platform Dev Lane 的设计细节见 [platform-dev-lane.md](./platform-dev-lane.md)。

## GitHub Runtime 配置记录规则

凡是通过 GitHub UI、`gh secret set`、`gh variable set` 或 `gh api repos/.../hooks` 修改仓库配置，都必须记录：

- 修改日期
- secret / variable / webhook 名称
- 为什么改
- 验证路径

只记录名称、用途和值来源，不记录明文。

常见配置：

| 类型     | 名称                                             | 用途                                  |
| -------- | ------------------------------------------------ | ------------------------------------- |
| secret   | `PAGES_CALLBACK_TOKEN`                           | Actions callback gateway              |
| secret   | `PAGES_GITHUB_APP_TOKEN` 或平台 GitHub App token | 创建受控 branch / PR                  |
| secret   | `AGENT_CODE_API_KEY`                             | Coding Agent 调公司模型网关           |
| variable | `PAGES_GATEWAY_CALLBACK_URL`                     | Actions runner 回调 gateway           |
| variable | `PAGES_CALLBACK_ALLOWED_ORIGINS`                 | callback helper 允许的 gateway origin |
| variable | `PAGES_BASE_REF`                                 | PR base fallback                      |
| variable | `AGENT_GATEWAY_URL`                              | 公司模型网关 BaseURL                  |
| variable | `AGENT_MODEL_NAME`                               | Coding Agent 模型名                   |
| webhook  | repo webhook payload URL                         | GitHub 事件进入 gateway               |

## 本地 gh CLI 边界

`gh` CLI 只能用于排障：

- 查看 issue / PR / workflow run
- 手动补跑 workflow
- 查看 webhook delivery
- 对比 ruleset / check 状态

`gh` CLI 不能作为产品运行时状态来源，不能靠本机 watch 推进 Review gate、preview 或 Slack 回写。
