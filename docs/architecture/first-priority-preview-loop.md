# First Priority Preview Loop

## 定位

当前第一优先级不是完整 production 发布平台，而是先跑通 Slack 到 Preview 的自动闭环。

目标链路：

```text
Slack
  ↓
pages-gateway 接收 Slack HTTP event 并创建任务
  ↓
需求整理
  ↓
提交 GitHub Enterprise issue
  ↓
固定项目索引 / agent context
  ↓
Agent 自运行编码
  (当前可用 placeholder generator 或公司 Coding Agent)
  ↓
site-check / pages-site-policy
  ↓
Agent Review
  ↓
Agent 自合并 / 部署到 Preview
  ↓
回通 Slack
```

这里的 Preview 不是 production。第一阶段不要求自动合并到 production，也不要求线上正式发布。

运行态不按 MVP 降级：Slack 入口、GitHub webhook、Review Agent comment 监听、executor callback、preview gate 和 Slack 回写必须跑在 K8s 控制面里。本机 `gh watch` / `gh pr view` / `gh api` 只能用于开发排障，不能作为这条链路的状态来源。详见 [k8s-runtime-contract.md](./k8s-runtime-contract.md)。

当前实现以 `staging` 作为自动生成站点 PR 的默认 base 分支。`master` 仍然是仓库默认分支和 workflow bootstrap 的安全落点；Slack 自动化的 Project Index、Pages Agent 和 Preview gate 应以 `PAGES_BASE_REF=staging` 为准。

## 第一阶段成功标准

必须跑通：

- Slack 私聊、mention 或 slash command 能进入平台。
- Slack Events / Interactivity 直接进入 `pages-gateway`，不使用临时 `/tmp` 监听脚本，也不使用 Socket Mode fallback。
- 平台能把 Slack 消息整理成结构化需求。
- 平台能创建 GitHub Enterprise issue。
- issue 创建由 `apps/worker` 使用平台 GitHub App installation token 完成，不依赖 Slack 用户拥有 repo 权限。
- 平台能为本次 job 固定 `ProjectIndexSnapshot`，让 agent 使用可追溯的 repo / template / site context。
- coding agent 能根据 issue 和需求摘要自运行，生成站点改动；当前 `pages-agent.yml` 已通过 `AGENT_CODE_API_KEY` 调用公司 OpenAI-compatible 网关生成站点页面。
- agent 改动只能落到目标 `sites/<employee_slug>/<site_slug>/`。
- 平台能创建受控 branch / PR。
- `site-check` 能在 PR head SHA 上作为 required check 跑完，并把 `SiteCheckRun` 写回平台。
- Actions executor 形态中 `pages-agent.yml` 先执行 diff allowlist，再创建受控 branch / PR，并以 `stageResult=pr_created` callback K8s gateway。
- GitHub Review Agent / Greptile 能对 PR 进行 review。
- 平台能实时读取 Review Agent comments。
- blocking comment 能触发 agent 修复，至少支持一轮。
- `site-check` / `pages-site-policy` 通过，且无 blocking / unknown comment 后，自动进入 Preview。
- Preview URL 回写到 Slack thread、issue、PR。
- 全流程状态可在 DB 中追踪。
- 用户可以在 Slack 里随时调整设计和想法：gateway 必须先通过 `IssueLink` 识别当前 active job / issue / PR，再把补充需求追加到同一个 issue 或触发同一 PR branch 的后续 coding/fix round；不能默认创建无关联的新站点任务。

当前代码进度：

- 已跑通 Slack / API 创建 `PublishingJob`。
- 已跑通 issue 创建、Project Index workflow、Pages Agent workflow、受控 PR 创建。
- 当前 issue 创建由 `apps/worker` 使用平台 GitHub token 调 GitHub API 完成，不是由 Codex / Claude 直接创建。Codex / Claude 后续可以起草 issue 内容，但创建动作仍归 gateway / worker 控制。
- 已把自动生成 PR 的 base 对准 `staging`。
- 已新增 Review Agent webhook 处理：allowed bot -> 归一化 comment / review -> 分类 -> blocking 进入 `changes_requested`，approved note 进入 `previewing` 并 dispatch `pages-preview.yml`。
- 已新增 GitHub webhook signature 可选校验：公网 / staging gateway 必须配置 `GITHUB_WEBHOOK_SECRET`。
- 已新增 gateway 内置 Slack 回通：`issue_created`、`index_ready`、`pr_created`、Review Agent blocking / suggestion / unknown / gate pass、`preview_deployed` 和失败回调会写回原 Slack DM 或 mention thread。Actions runner / coding agent 仍然不拿 Slack token。
- 当前 GitHub issues webhook 先进入 `pages-gateway` 校验，再由 gateway / worker 通过 `workflow_dispatch` 启动 `pages-agent.yml`。workflow 解析受控 job context，调用 Coding Agent 产出 `sites/<employee>/<site>/src/index.html` 和 `site.json`，再按 controlled committer 规则创建 / 更新 PR。
- 已新增 Slack follow-up：同一用户在 active session 里说“这个 preview 不满意 / 继续改 / 调整文案”等，不再默认新建任务；gateway 通过 `IssueLink` 找到当前 job，把反馈写入 `SessionMemory` 和 job summary，将 job 推到 `fixing`，worker 追加原 issue comment，并 dispatch `pages-agent.yml(mode=fix)` 更新同一个 PR branch。
- `pages-agent.yml(mode=fix)` 会先 checkout 现有 PR branch，再把已有 `src/index.html` 作为上下文交给 Coding Agent；成功后 callback `stageResult=reviewing`，gateway 把 job 从 `fixing` 推回 `reviewing` 等待 Review Agent。
- 当前还没有把 Codex / Claude 接成真正的 coding agent；`@codex review` 触发的是 GitHub 上的 Review Agent，不是 K8s 里的常驻 Agent。
- `pages-agent.yml` 创建 / 更新 PR 后会自动评论 `@codex review`，不再需要人工手动触发 Codex Review。
- `pages-preview.yml` 复用原有 `pages-manager` 的 `POST /deploy` 能力，把 PR head 中的站点文件部署成真实 preview URL。
- 本地优先 smoke 可设置 `PAGES_PREVIEW_MODE=local_deploy`，由本地 K8s 中的 `apps/worker` 直接读取 PR head 文件并调用原有 `POST /deploy`，避免 GitHub-hosted runner 被公司 IP 白名单挡住。

仍需继续补：

- 把 gateway 内置 Slack 回通拆成独立 `slack-notifier`，改为消费 `JobEvent` / queue，并用持久化幂等表替代当前内存去重。
- required checks / site-check 结果进入 preview gate。
- blocking comment 自动触发 `pages-agent.yml(mode=fix)` 的修复策略仍需补完整，包括 max fix rounds、Review Agent comment id 输入、失败熔断和人工接管；当前已具备用户 Slack follow-up 触发 fix round 的执行通路。
- `preview_deployed` 后把 Preview URL 继续回写 issue / PR；Slack 回写已在 gateway 内完成。

可以暂不做：

- production 自动发布。
- production 自动合并。
- trusted-auto 到默认分支。
- 完整控制台。
- K8s Job executor。
- 每任务独立 namespace。
- 完整 rollback。

## Preview 自动合并的含义

“Agent 自合并到 Preview”在本阶段定义为：

```text
PR head / agent branch
  ↓
通过 site-check / pages-site-policy 和 Review Agent gate
  ↓
自动生成 Preview 部署
  ↓
记录 Preview DeployRecord
  ↓
回写 Slack
```

它不等于：

```text
merge to main
merge to production
publish production
```

实现上可以有两种方式：

| 方式 | 说明 | 当前推荐 |
| --- | --- | --- |
| PR head preview deploy | 从 PR head SHA 构建 preview，不合并到长期分支 | 推荐 |
| preview branch auto-merge | 将受控 PR branch 合入 `preview` / `staging` 分支后部署 | 可选 |

当前推荐 PR head preview deploy，因为它更简单，不需要额外维护 preview 分支冲突。

如果团队坚持“合并”语义，可以把它命名为 `preview merge`，但技术上仍应保证：

- 只影响 preview environment。
- 不改 production current deploy。
- 不绕过 `site-check` / `pages-site-policy` / Review Agent gate。
- 不绕过 path allowlist。

## Preview Gate

进入 Preview 前必须满足：

```text
pages-site-policy = passed
site-check = passed
no open blocking ReviewAgentComment
no open unknown ReviewAgentComment
PR only touches allowedPath
agent fix round not running
```

不要求人工 approve。

不要求 production branch merge。

## 状态机裁剪

第一优先级可以只启用这些状态：

```text
received
summarizing
issue_creating
issue_created
indexing
generating_page
patch_generated
branch_committed
pr_created
reviewing
changes_requested
fixing
previewing
preview_deployed
failed
cancelled
```

完整 production 状态保留但不作为第一阶段验收：

```text
approved
merging
merged
deploying
deployed
```

## GitHub Actions Executor Workflow

第一阶段需要：

```text
pages-agent.yml
  initial / fix coding agent
  load ProjectIndexSnapshot / agent context
  path allowlist
  schema / secret / size check
  lint / test / build
  controlled branch / PR

site-check.yml
  PR required check

pages-preview.yml
  site-check / pages-site-policy 和 Review Agent gate 通过后调用现有 pages-manager /deploy 自动部署 Preview
```

本地 K8s smoke 如果要先从 Slack 拿到真实 preview URL，可以先用：

```text
PAGES_PREVIEW_MODE=local_deploy
PAGES_API=https://api-staging.workers.xd.team
PAGES_PREVIEW_TOKEN=pages-preview-smoke@xd.com
PAGES_PREVIEW_IP_RESTRICT=false
PAGES_PREVIEW_SITE_NAME_PATTERN=pm-{publishingJobId}
```

这只是本地 smoke 用的 legacy `/deploy` owner marker。`PAGES_PREVIEW_SITE_NAME_PATTERN` 在 smoke 模式下必须带 `publishingJobId`，否则复用同一个 PR 时会反复生成同名 preview 站点并撞到“站点名称已被占用”。长期 Actions 模式仍可使用 `pages-preview.yml`，但需要 GitHub Actions runner 能访问 `PAGES_API`，并配置 repo variable `PAGES_API` 与 preview deploy secret。该 secret 是平台 preview deploy identity，不是员工自己的 Cloudflare token；长期应替换为 gateway/deployer 根据 `ownerScopeId` / `siteProjectId` / `publishingJobId` 签发或解析的受限 deploy identity。

第一阶段不要求：

```text
pages-production-deploy.yml
```

production workflow 可以先留空壳或完全后置。

## Slack 回通

Slack thread 完整目标至少回写这些节点：

```text
已收到需求
已整理需求
已创建 issue
已固定项目索引
Agent 开始编码
已创建 PR
Agent Review 进行中
发现 blocking comments，开始修复
Review 通过，开始 Preview
Preview 已生成：<preview_url>
失败：<stage + error_message>
```

当前先由 `pages-gateway` 内置通知函数完成回写，触发点是 executor callback 和 GitHub Review Agent webhook。两类触发都必须进入 K8s gateway，不能靠本机 `gh` 轮询后手工回写：

- `issue_created`：回写 issue number 和 issue URL。
- `index_ready`：回写本次 job 固定的 `ProjectIndexSnapshot`。
- `pr_created`：回写 PR number 和 PR URL。
- Review Agent webhook：blocking 进入 `changes_requested` 并回写；suggestion / note / unknown 也会回写，其中 unknown 不进入 Preview。
- Slack follow-up：active session 命中唯一 `IssueLink` 时，回写“已启动同一个 PR 的修复轮次”；多个 active / recent session 时先要求用户用 `session: sess_xxx` 选择。
- `pages-agent.yml(mode=fix)` callback：回写“修复轮次已提交，等待 Review Agent”。
- Review gate 通过：回写“开始生成 staging Preview”。
- `preview_deployed`：回写 Preview URL。
- `failed` callback：回写失败原因。

长期目标仍是独立 `slack-notifier`：gateway 只写 `JobEvent`，notifier 消费事件并发 Slack 消息。无论当前形态还是长期形态，Actions runner / coding agent 都不能直接拿 Slack token。

## 最小数据要求

第一阶段仍然需要：

- `PublishingJob`
- `JobStage`
- `JobStageAttempt`
- `AgentRun`
- `SlackEvent`
- `SlackMessageBatch`
- `SlackSession`
- `SessionMemory`
- `IssueLink`
- `GitHubWebhookDelivery`
- `SiteCheckRun`
- `ReviewRun`
- `ReviewAgentComment`
- `DeployRecord`
- `JobEvent`
- `AuditLog`

其中 `DeployRecord.environment=preview` 是第一阶段验收对象；`production` 可以后置。

## 验收用例

### Happy Path

```text
Slack 私聊: "给张三生成一个 profile 页面"
  ↓
Slack 收到: 已整理需求
  ↓
GitHub issue created
  ↓
pages-agent creates PR
  ↓
Review Agent no blocking comments
  ↓
pages-preview deploys preview URL
  ↓
Slack 收到 preview URL
```

### Blocking Fix Path

```text
Slack request
  ↓
PR created
  ↓
Review Agent adds blocking comment
  ↓
ReviewAgentComment(classification=blocking)
  ↓
pages-agent mode=fix
  ↓
push same PR branch
  ↓
Review Agent passes
  ↓
Preview deployed
  ↓
Slack 回通
```

### Unknown Comment Path

```text
Review Agent comment cannot be classified
  ↓
ReviewAgentComment(classification=unknown)
  ↓
No preview auto-merge/deploy
  ↓
Slack asks for human classification
```

## 后续升级

第一阶段跑通后，再做：

1. production deploy from `merge_commit_sha`
2. manual production approval
3. trusted-auto production merge
4. rollback
5. complete console
6. K8s executor
