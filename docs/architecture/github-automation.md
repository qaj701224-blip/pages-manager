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

`apps/worker` 直接创建 issue 的路径必须先成功 dispatch `project-index.yml`，再向 gateway 回调 `issue_created`。如果 project-index dispatch 失败，任务不能提前进入 issue_created，避免用户看到“issue 已进入下一阶段”但索引和后续 agent 没有启动。

GitHub webhook、Review gate、site-check 和 Slack gate 回调里的 `patch/update` 都要按可能返回 `null` 处理。并发删除或状态被其它流程收口时，入口应返回 ignored / ephemeral 提示，不能继续读取 `.status` 或启动 worker；worker dispatcher 也必须把缺失 work item 当作 no-op。

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

ECS worker 可以使用 `PAGES_PREVIEW_MODE=local_deploy`：`pages-worker` 从 PR head 读取目标站点文件，并用固定 ECS 出口调用 Cloudflare staging `/deploy`。这样避免 GitHub-hosted runner 的动态出口 IP 进入 Cloudflare staging 白名单。这里的 preview 指 Site Publishing Lane 的站点预览交付物，不表示 ECS 是 preview 环境。

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
- push `staging` 后必须先等待 GitHub refs API 确认 `refs/heads/staging` 已指向该 merge commit，再 dispatch staging deploy，避免 workflow_dispatch 读到旧 `staging` head。
- 由于 GitHub `GITHUB_TOKEN` 产生的 push 不会自动触发后续 push workflow，同步 workflow 必须显式 dispatch `Deploy XD Pages Staging`，并等待 `Deploy XD Pages Staging` 完成。
- v1 平台变更 dispatch `deploy-staging.yml`；v2 平台变更 dispatch `deploy-pages-v2-staging.yml` 且 `component=all`。
- 如果 PR head 无法干净 merge 到 `staging`，或者临时分支 `CI` 失败，workflow 失败并转人工处理。
- 这条 workflow 只使用 GitHub `GITHUB_TOKEN`，不读取 Cloudflare、Aliyun、ACR、ACK 或用户发布执行器 secret。

### Executor Callback 幂等

executor callback 只能推进仍可转换的当前任务。已取消、已合并、已部署或已失败的终态 job 收到迟到 callback 时，gateway 返回 200 并标记 ignored，不能让 workflow 因有意取消而失败。`pages-preview.yml` 的成功和失败 callback 必须携带 `prNumber` 与 `headSha`；已绑定 `headSha` 的 job 收到 `preview_deployed` 时，如果 callback 缺少 `headSha` 或不匹配当前 job head，只保留当前 DB 状态，不触发 Slack 成功卡片、plain progress、reaction settlement 或新的 worker dispatch。已绑定 PR 但没有持久化 `headSha` 的 job 也必须匹配 `prNumber`；只有没有 PR/head 元数据的 legacy / manual job 才接受无 `headSha` callback。

`pages-preview.yml` 在部署前必须重新读取当前 PR head，并在 head 已移动时跳过 deploy、artifact 和 callback，避免旧 workflow run 覆盖同一个 preview site。该 workflow 还必须按 `prNumber` 设置 `concurrency` 且 `cancel-in-progress: true`，让同一 PR 的旧 preview run 在发布前被取消。预览内容只从 `sites/<employeeSlug>/<siteSlug>/src` 发布；没有 `src/` 时 workflow 失败，而不是回退发布整个站点根目录。

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
| `PAGES_PLATFORM_WORKFLOW_REF`                            | Platform Agent workflow 文件读取分支               |
| `PAGES_PLATFORM_BASE_REF` / `PAGES_PLATFORM_PR_BASE_REF` | Platform Agent checkout 和 PR base                 |
| `PAGES_GATEWAY_CALLBACK_URL`                             | GitHub Actions runner 回调公网 gateway             |
| `PAGES_WORKER_CALLBACK_URL` / `PAGES_GATEWAY_URL`        | worker 到 gateway 的内部 callback                  |
| `INTERNAL_CALLBACK_TOKEN`                                | executor callback shared token                     |
| `PAGES_PREVIEW_MODE`                                     | `actions` 或 `local_deploy`                        |
| `PAGES_API`                                              | Cloudflare staging / production API                |

`workflowRef` 和 `baseRef` 必须分开理解：

- `PAGES_WORKFLOW_REF` 决定从哪个分支读取 workflow。
- `PAGES_BASE_REF` 决定生成站点 PR 的 base。
- Platform Dev Lane 使用独立的 `PAGES_PLATFORM_WORKFLOW_REF` 和 `PAGES_PLATFORM_BASE_REF`。手动测试某个特性分支时，两者必须指向同一个已 push 到远端的 ref，避免 workflow 代码和 Agent checkout / PR base 混用。
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
| `pull_request`                | PR opened / synchronize / closed / merged 状态推进和合并公告 |
| `issue_comment`               | Review Agent summary、人工状态指令、issue 追加需求 |
| `pull_request_review`         | Review Agent 或人工 review 总结                    |
| `pull_request_review_comment` | Review Agent inline comment                        |
| `check_run`                   | site-check / CI 结果和 Review gate                 |

delivery 写入 `github_webhook_deliveries`，Review Agent comment 写入 `review_agent_comments`，site-check 写入 `site_check_runs`。这些都是 MySQL 真相源。

## Merge Announcement Agent

目标：每次 PR 合并后，由平台机器人在固定 Slack 频道发一条类似发布简报的富文本消息，内容包含 PR 链接、标题、作者、合并人、影响范围和 3-5 条中文摘要。摘要可以由 Agent 生成，但触发、权限、幂等和投递仍由 gateway / slack-notifier 控制。

这不是用户对话，也不是 Coding Agent。它是 GitHub webhook 触发的系统型 `AgentRun`：

```text
GitHub pull_request.closed + merged=true
  -> gateway 校验 signature / delivery 幂等 / repo allowlist
  -> gateway 记录 merge announcement pending / 幂等键
  -> gateway 立即返回 200
  -> 后台任务读取 PR payload + 必要的 GitHub API 补充信息
  -> 后台任务创建 merge_announcement AgentRun
  -> slack-agent 生成结构化中文摘要
  -> gateway 校验摘要 JSON / 脱敏 / 截断 / 兜底
  -> slack-notifier chat.postMessage 到固定频道
  -> gateway 记录 sent / failed 事件和 Slack message binding
```

### 触发条件

只在这些条件同时满足时发送：

- `X-GitHub-Event=pull_request`。
- `body.action=closed`。
- `body.pull_request.merged=true`。
- `repository.full_name` 命中允许的 repo，默认只允许 `GITHUB_REPO`。
- 目标 PR base ref 命中配置，默认 `master`；需要 staging 或其它分支时显式配置。
- 不是 delivery 重放；`github_webhook_deliveries` 对同一个 `delivery_id` 必须只创建一次。
- 同一个 `repo + pr_number + merge_commit_sha` 只能成功发送一条公告。

不触发：

- PR 关闭但未合并。
- draft / synchronize / reopened / ready_for_review。
- workflow 把 PR head merge 到 `staging` 做 preview 的同步 commit。那是预览验证，不是最终合并公告。
- GitHub Actions runner 内部直接调用 Slack。runner 不持有 Slack token，也不绕过 gateway 幂等。

### 运行边界

职责分工：

| 组件 | 职责 |
| --- | --- |
| `pages-gateway` | 接收 GitHub webhook、判断是否需要公告、先登记 pending / 幂等键并快速返回、后台创建系统 `AgentRun`、校验 Agent 输出、调用 notifier |
| `apps/slack-agent` | 根据受控上下文生成中文摘要 JSON，不读取 Slack token，不访问 GitHub 写权限 |
| `apps/slack-notifier` | 持有 `SLACK_BOT_TOKEN`，执行 `chat.postMessage`，处理 Slack API 错误 |
| MySQL | 保存 webhook delivery、AgentRun、AgentRunEvent、Slack message binding / notification attempt |

Agent 只做摘要，不做这些事：

- 不决定是否发送公告。
- 不决定发到哪个频道。
- 不读取或改写 GitHub PR。
- 不调用 Slack Web API。
- 不输出 secret、token、完整 diff、内部 prompt 或 provider 原始响应。

### Agent 输入

gateway 给 `slack-agent` 的输入必须是已经裁剪和脱敏后的结构化 JSON。不要把完整 PR diff、完整 commit log 或全部 review 线程直接塞进 prompt。

建议字段：

```json
{
  "task": "merge_announcement_summary",
  "repoFullName": "xindong/pages-manager",
  "prNumber": 276,
  "prTitle": "fix(desktop): 修复更新公告 UTF-8 分片乱码",
  "prUrl": "https://github.com/xindong/pages-manager/pull/276",
  "baseRef": "master",
  "headRef": "fix/release-note-utf8",
  "authorLogin": "alice",
  "mergedByLogin": "bob",
  "mergeCommitSha": "abc123...",
  "labels": ["fix", "desktop"],
  "changedFiles": [
    "apps/desktop/src/update-notes.js",
    "tests/update-notes.test.js"
  ],
  "additions": 120,
  "deletions": 24,
  "prBodyExcerpt": "用户反馈 0.0.122 更新公告中文乱码...",
  "commitSubjects": [
    "fix(desktop): stream decode release notes as utf8",
    "test(desktop): cover split utf8 chunks"
  ],
  "reviewSummary": "CI passed; review resolved.",
  "knownRisk": "影响 release note 拉取与展示，不改变发布流程。"
}
```

裁剪规则：

- `prBodyExcerpt` 建议不超过 2000 字符。
- `commitSubjects` 最多 20 条。
- `changedFiles` 最多 50 条；超过时按目录聚合，例如 `apps/desktop/** 12 files`。
- 不传 patch 内容；如后续确实需要 diff 摘要，先由 gateway 用文件路径和统计信息做二次摘要。
- 所有输入先走 secret-like 脱敏：Slack token、GitHub token、Cloudflare token、OpenAI key、cookie、session、`.env` 片段都替换为 `[REDACTED]`。

### Agent 输出合同

`slack-agent` 必须返回严格 JSON。gateway 只消费 JSON 字段，不从自然语言里反解析。

建议 schema：

```json
{
  "headline": "修复更新公告中文乱码",
  "summaryBullets": [
    "改用 StringDecoder('utf8') 对 CDN JSON 响应做流式解码，保留跨 chunk 的多字节字符。",
    "非 200、网络错误、超时和 JSON parse 失败仍保持静默返回 null，由调用方决定展示方式。",
    "新增回归测试，覆盖中文字符被拆在两个网络 chunk 之间的场景。"
  ],
  "impact": "影响桌面端更新公告读取与展示。",
  "risk": "低风险；不改变更新检查和发布流程。",
  "audience": "desktop",
  "tags": ["fix", "desktop", "utf8"]
}
```

校验规则：

- `headline` 必填，最长 80 个中文字符左右。
- `summaryBullets` 必填，3-5 条，每条最长 180 个中文字符左右。
- `impact` 和 `risk` 可为空，但为空时 gateway 用规则兜底。
- `tags` 最多 5 个。
- 输出不能包含 Markdown 表格、HTML、代码块、原始 token、完整 stack trace 或 provider debug 字段。
- JSON parse 失败、字段缺失、内容过长或命中 secret-like pattern 时，gateway 丢弃 Agent 输出并走 deterministic fallback。

deterministic fallback 示例：

```text
headline = PR title 去掉 type/scope 后的主体
summaryBullets = [
  "合并了 PR 标题对应的改动。",
  "变更范围：按 changedFiles 聚合出的目录。",
  "详情请查看 PR 描述和 diff。"
]
impact = "影响范围请以 PR 描述和 changed files 为准。"
risk = "未生成 Agent 风险摘要。"
```

### Slack 富文本消息

Slack 消息使用 Block Kit，而不是只发纯文本。`text` 字段仍要有完整 fallback，便于通知预览和搜索。

推荐 blocks：

```json
[
  {
    "type": "header",
    "text": { "type": "plain_text", "text": "PR 已合并" }
  },
  {
    "type": "section",
    "text": {
      "type": "mrkdwn",
      "text": "*XDMaker 合并了 PR #276: fix(desktop): 修复更新公告 UTF-8 分片乱码*"
    }
  },
  {
    "type": "section",
    "text": {
      "type": "mrkdwn",
      "text": "这次修的是桌面端更新公告中文乱码问题：\n• 改用 UTF-8 流式解码...\n• 保持错误兜底策略不变...\n• 新增跨 chunk 中文回归测试..."
    }
  },
  {
    "type": "context",
    "elements": [
      { "type": "mrkdwn", "text": "作者 alice · 合并 bob · master · abc1234" }
    ]
  },
  {
    "type": "actions",
    "elements": [
      {
        "type": "button",
        "text": { "type": "plain_text", "text": "查看 PR" },
        "url": "https://github.com/xindong/pages-manager/pull/276",
        "action_id": "open_pr"
      }
    ]
  }
]
```

格式要求：

- 中文摘要用 `mrkdwn` bullet；不要用 Slack `rich_text` block 作为第一版。`rich_text` 难测、兼容性更差，`section + mrkdwn` 已能实现截图里的富文本效果。
- 单条消息控制在 Slack block 限制内；摘要过长时截断并提示“更多见 PR”。
- 频道公告不 `@channel` / `@here`。如需 mention 负责人，必须有显式配置，默认关闭。
- 对于从 Slack 用户触发的平台开发 PR，可以在公告里展示 Slack display name，但不能暴露 `slack_session_id`、内部 job id 或用户邮箱。

### 幂等和数据模型

必须有独立的 merge announcement 幂等键：

```text
merge-announcement:<repo_full_name>:<pr_number>:<merge_commit_sha>
```

建议落库方式：

- 如果已有通用 `SlackNotificationAttempt` / `SlackMessageBinding`，新增 `message_kind=merge_announcement`。
- 如果当前实现还没有统一 binding，可先复用现有可全局去重的事件记录，但 key 必须包含 `repo + pr + merge sha`，并且 pending 事件必须在 `chat.postMessage` 之前写入。
- 记录 `channel_id`、`message_ts`、`repo_full_name`、`pr_number`、`merge_commit_sha`、`agent_run_id`、`status`、`error_code`。

重放策略：

- GitHub webhook delivery 重放：直接返回已处理结果，不重复创建 AgentRun。
- Agent 失败后重试：同一个幂等键只能有一条最终 Slack 消息；可以重跑 Agent 更新待发送 payload，但不能重复投递。
- Slack `chat.postMessage` 返回超时但实际可能成功时，优先查询/依赖 notification attempt 状态；不能盲目再发一条相同公告。
- pending 记录创建失败时不允许先发 Slack；否则 Slack 成功但 binding 写失败会造成 delivery 重试后的重复公告。

### 失败兜底

失败不能影响 PR 合并状态，也不能回滚 work item：

- GitHub webhook 已收到但 Agent 超时：使用 deterministic fallback 发送公告，并在内部事件里标记 `summary_source=fallback_timeout`。
- Agent 输出不合法：使用 fallback，记录 `summary_source=fallback_invalid_agent_output`。
- Slack channel 未配置：不发送，记录 `skipped=missing_channel`，webhook 仍返回 200。
- Slack API 失败：记录 notification attempt，按 notifier 策略重试或 dead-letter；不改变 `PublishingJob` / `PlatformDevItem` 状态。
- `pull_request` payload 缺少关键字段：只要 `repo + pr_number + pr_url/title` 足够，就发简化公告；不够则跳过并记录原因。

### 配置项

gateway：

| 变量 | 用途 |
| --- | --- |
| `MERGE_ANNOUNCEMENT_ENABLED` | 是否启用 merge 频道公告，默认 `false` |
| `MERGE_ANNOUNCEMENT_CHANNEL_ID` | 固定 Slack 频道 ID，例如 `C0123` |
| `MERGE_ANNOUNCEMENT_BASE_REFS` | 允许公告的 base refs，默认 `master` |
| `MERGE_ANNOUNCEMENT_AGENT_ENABLED` | 是否调用 Agent 生成摘要，默认跟随 enabled；关闭时只用 fallback |
| `SLACK_AGENT_MERGE_SUMMARY_URL` | 可选，merge 摘要专用 Slack Agent endpoint；不配时从 `SLACK_AGENT_TURN_URL` / `SLACK_AGENT_ANALYZE_URL` 推导 `/merge-summary` |
| `MERGE_ANNOUNCEMENT_INCLUDE_SITE_PRS` | 是否包含 `sites/**` 用户站点 PR，默认 `false`，避免个人站点变更刷公共频道 |
| `MERGE_ANNOUNCEMENT_MENTION_USER_IDS` | 可选固定 mention 列表，默认空 |

`slack-agent`：

| 变量 | 用途 |
| --- | --- |
| `SLACK_AGENT_MERGE_SUMMARY_MODEL` | 可选，merge 摘要专用模型；不配则使用 Slack Agent 默认模型 |
| `SLACK_AGENT_MERGE_SUMMARY_TIMEOUT_SECONDS` | 摘要超时，建议 20-30 秒 |

配置原则：

- Slack 频道 ID 不是 secret，可以放 vars / config；`SLACK_BOT_TOKEN` 仍只进 `slack-notifier` secret。
- Agent 模型 key 只进 `apps/slack-agent`，不能进 GitHub Actions。
- GitHub token 只在 gateway/worker 的受控 GitHub API 路径使用，不能传给 `slack-agent` prompt。

### 实现落点

建议最小实现路径：

1. 在 `apps/gateway/src/github/resource-webhooks.js` 的 `handleGithubPullRequestWebhook` 中识别 `closed + merged`，只做触发判断、pending 记录和后台任务入队。
2. 新增 `apps/gateway/src/github/merge-announcement.js`，封装触发判断、PR payload 归一化、幂等 key 和 fallback。
3. 新增 gateway 到 `slack-agent` 的内部调用模式，例如 `task=merge_announcement_summary`；复用现有 provider、脱敏和 JSON 校验 helper。
4. 新增 `apps/gateway/src/slack/merge-announcement-notifier.js`，构建 Block Kit 并通过 `postSlackMessage` 调 `slack-notifier`。
5. 在 store 增加或复用 notification/binding 记录，保存 `message_kind=merge_announcement` 和幂等 key。
6. 补测试：webhook 触发、未合并不触发、重复 delivery 不重复、Agent 失败 fallback、Slack payload blocks、配置关闭跳过。

不要把这件事放进 `.github/workflows/*`：

- workflow 不应该持有 Slack bot token。
- workflow merge 事件不如 webhook 权威，且容易把 staging preview merge 和最终 master merge 混在一起。
- webhook 已经有 delivery 幂等、repo allowlist、状态机和 notifier adapter。

### 验收标准

- 合并 `master` PR 后，webhook 快速返回 200，后台在目标频道发出一条且只有一条公告。
- 公告包含 PR 标题、链接、作者、合并人、base ref、短 sha 和 3-5 条中文摘要。
- Agent 超时或输出非法时仍能发 fallback 公告。
- 重放同一个 GitHub delivery、重复收到同一 PR merge webhook，不会重复发频道消息。
- 未合并关闭、staging sync、配置外 base ref、配置关闭时不发公告。
- 公告内容不包含 token、cookie、session、`.env` 值、内部 job id 或 Slack session id。
- `pnpm test` 或定向 `node:test` 覆盖新增 helper 和 webhook 分支。

## Review Agent Gate

Review Agent 不是 Coding Agent，也不是 gateway 内置 reviewer。它作为 GitHub PR 外部 reviewer 产生 comment / review / check output，再由 GitHub webhook 回到 gateway。

Slack 中把已入库 Review Agent 评论整理成 blocker / suggestion / note 摘要的只读产品能力见 [slack-review-results-summary.md](./slack-review-results-summary.md)。本节只定义 Review gate 和 webhook 放行规则。

处理规则：

- 只有 allowlist 命中的 bot login / app / check name 才能作为 Review Agent。
- comment 先入库，再分类为 `blocking`、`suggestion`、`note` 或 `unknown`。
- blocking / unknown 不放行 preview。
- suggestion / note 可以放行 preview，但需要在 Slack 进度消息中提示。
- 如果 Review Agent 超时没有返回最终评论，gateway 的 review gate watchdog 可以记录一条兜底结果，避免任务永久卡住。
- 同一个 PR / job 同一时间只允许一个 Coding Agent fix round；Slack follow-up 和 Review Agent comment 都进入同一条修复队列。

Review gate 当前实现在 gateway 内，后续可以拆成独立 worker，但不能退化成本机 `gh pr view` 轮询。

### 自动修复轮次

Platform Dev PR 的 `blocking` / `unknown` review comment、CI 失败和 Slack follow-up 都进入同一条 fix 队列，不各自启动互相竞争的 Coding Agent。每轮自动修复必须满足：

- webhook 先把 comment / check / follow-up 入库，再决定是否 dispatch `platform-agent.yml(mode=fix)`。
- dispatch 输入必须包含 PR number、当前 head SHA、issue / follow-up 摘要，以及触发本轮修复的 review comment 或 CI 失败摘要。
- 处理 review comment 时必须按 PR head SHA 匹配当前 work item；无法确认 head SHA 的事件不能回退到任意 active PR。
- 中间状态更新必须 fail closed；例如 `pr_created -> reviewing -> fixing` 中任一步找不到当前 job / item，直接返回可恢复失败，不继续按旧对象 dispatch。
- 生成结果必须同步回 workflow checkout 的 repo 工作区，由 workflow 的 `git diff`、secret scan、commit 和 push 统一处理，不能只停留在 agent session 或 artifact。
- 同一 PR / work item 同一时间只允许一个 fix round；新 follow-up 在当前轮未结束时排队，并在可安全推进的 callback 后继续启动下一轮。
- 非 open 的 review comment 事件，例如 deleted、dismissed 或 outdated，只记录状态，不触发自动修复。

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

`pages-agent.yml` 在提交自动生成站点 PR 前必须清空 index，使用 `git diff HEAD` 同时覆盖 staged 与 unstaged 改动，并只把 `ALLOWED_PATH` 加回提交。secret scan 只扫描本轮新增 diff 行，覆盖 Slack token、`sk-*`、`CF_API_TOKEN`、`SLACK_AGENT_API_KEY`、`AGENT_CODE_API_KEY`、`github_pat_*` 和 GitHub `gh[pousr]_` token 家族。扫描必须匹配真实 token 形态或敏感变量赋值，不能因为站点目录历史正文或示例文档里已有短前缀 `ghp_` / `gho_` 就阻断新的 PR 创建和 callback。

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
- PR body 生成也属于安全边界：request / review / follow-up 等 workflow input 只能作为文本写入 `--body-file`，不能通过 bash heredoc、`eval` 或 shell 模板展开。
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
