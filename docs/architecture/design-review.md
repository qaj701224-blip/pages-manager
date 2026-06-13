# Design Review Notes

## Review 结论

当前方向建议继续放在 `pages-manager` repo 内演进，作为一个大仓 monorepo 做平台化改造。

不建议新建一个独立业务 repo 再把结果交给 `pages-manager` 发布。原因是 issue、PR、review、Preview deploy、权限、审计和发布真相源需要在同一个平台闭环；如果拆成两个 repo，自动化链路会更长，权限边界更难校验，失败恢复和审计也会变复杂。

需要项目索引能力，但 MVP 不建议为了索引单独新建 Git repo。更合适的是在 `pages-manager` 内新增独立组件：`apps/indexer`、`packages/project-index` 和 `.github/workflows/project-index.yml`。它们可以独立运行、独立重建索引、独立存储 `ProjectIndexSnapshot`，但仍然服务同一个 `PublishingJob` / issue / PR / Preview 闭环。后续如果索引服务要检索多个业务 repo 或供多个平台复用，再拆成独立 repo / 独立服务。

不建议放进 `xdclaw`。`xdclaw` 可以参考它的 gateway、worker、K8s、namespace、状态机、员工/租户边界，但 pages 发布平台的业务对象是 `SiteProject`，不是 OpenClaw 实例。

## 已确认的关键设计

### 1. 员工不是网站，站点才是发布对象

模型必须是：

```text
Employee
  └─ SiteOwnerScope
       ├─ SiteProject(profile)
       ├─ SiteProject(q2-report)
       └─ SiteProject(demo-portal)
```

一个员工可以拥有多个站点。权限、部署、PR、回滚、审计都应该绑定到 `site_project_id`，不能只绑定到 `employee_id`。

### 2. 站点内容访问和管理权限必须分离

已发布网站可以公开、公司内可见或 allowlist 可见，但管理界面不能因为网站公开而公开。

```text
SiteAccessPolicy
  控制谁能访问已发布内容

SiteAdminGrant
  控制谁能管理站点、批准、回滚、触发部署
```

这点很重要：别人可以访问某个员工的个人网页，不代表别人可以修改这个网页。

### 3. Slack bot 统一一个

平台只维护一个 Slack bot。

它负责：

- 收集消息
- 总结 SlackBot 或员工发来的需求
- 创建 `PublishingJob`
- 回写 issue / PR / deploy 进度

它不直接合并、不直接部署、不绕过 gateway 鉴权。Slack 事件进入后必须先通过 `ExternalIdentityBinding` 解析 actor。

### 4. Issue / PR 放在 pages-manager 大仓

自动生成的网站 issue 和 PR 都放在 `pages-manager`。

推荐边界：

| 改动类型 | 目录 | 自动化程度 |
| --- | --- | --- |
| 站点内容 | `sites/<employee>/<site>/` | MVP 为 manual-required；后续可在 `pages-site-policy` 通过后进入 trusted-auto |
| 平台代码 | `apps/`, `packages/` | 必须人工 review |
| 基础设施 | `k8s/`, `.github/` | 必须人工 review |
| 模板 | `templates/` | 必须人工 review |

自动生成 PR 只能修改单个目标站点目录。任何跨目录 patch 都应失败并写审计。

### 5. Coding Agent 不能直接 push

更安全的链路是：

```text
coding agent
  ↓
生成 workspace patch
  ↓
controlled-committer
  ↓
校验 path allowlist / schema / secret / 文件大小
  ↓
提交 branch
  ↓
创建 PR
```

coding agent 不应该拿 repo push token，也不应该拿 Cloudflare token、Slack bot token 或 auto-merge token。

这样即使 coding agent 产出了越界 patch，也只能停在 workspace，不能改平台代码、workflow 或部署配置。

### 6. Cloudflare 采用平台资源池

员工不申请 Cloudflare。平台统一持有 Cloudflare account、zone、token 和资源。

长期模型不是：

```text
一个站点 = 一个 Worker script + 一个 KV namespace + 一套路由
```

而是：

```text
CloudflareResourcePool
  ├─ 少量 Edge Worker
  ├─ 少量平台级 KV namespace
  ├─ 平台级 R2 / assets bucket
  └─ DB 真相源
```

每个站点通过 `site_project_id`、`deploy_id`、hostname、KV key prefix 和 assets 路径隔离。

### 7. KV namespace 上限的含义

同事提到的 Cloudflare KV namespace 上限，意思是 Cloudflare 账号下能创建的 KV namespace 不是无限的。

如果平台每创建一个网站就创建一个 KV namespace，那么员工多站点模型会很快被 Cloudflare 产品配额卡住。更合理的做法是创建少量平台级 KV namespace，然后用 key prefix 区分站点：

```text
host:<hostname>
site:<siteProjectId>:current
deploy:<deployId>:manifest
access:<siteProjectId>:policy
```

KV 只作为 Edge Worker 运行时快照，不作为平台真相源。真相源仍然是数据库。

### 8. 前期可以用 GitHub Actions，不必先上 K8s

截图里的方案是可行的：前期把 GitHub Actions 当成平台的云端 executor，用它跑 coding agent、候选构建、preview 和 PR required checks。

这意味着 MVP 主链路可以是：

```text
Slack
  ↓
pages-gateway
  ↓
GitHub issue
  ↓
GitHub Actions pages-agent workflow
  ↓
PR
  ↓
Greptile / GitHub Review Agent comment
  ↓
review-monitor-worker
  ↓
fix workflow 或人工处理
  ↓
Preview 自动闭环
```

这个选择只替换执行层，不替换控制面。`pages-gateway` 仍然是权限、状态机、审计、webhook 和回调的真相源；Slack bot、GitHub webhook、`ReviewAgentComment`、Cloudflare resource pool 这些边界仍然要保留。

### 8A. 项目索引是独立能力，但先不拆独立 repo

同事提到的“独立项目对其他项目进行索引，然后 AI 根据需求开发，再 Greptile review”可以作为长期形态参考。

在当前 `pages-manager` MVP 里，推荐落成：

```text
project-index.yml / apps/indexer
  ↓
ProjectIndexSnapshot
  ↓
pages-agent.yml 读取 bounded context
  ↓
生成站点 patch
```

索引内容先包括 `sites/<employee>/<site>`、`templates/**`、`packages/page-kit/**`、相关 issue / PR / ReviewAgentComment 和构建报告。索引只给 agent 提供上下文，不扩大写权限；agent 仍然只能通过 controlled-committer 修改目标站点目录。

### 9. K8s 运行发布任务，不运行最终网站

`pages-manager` 的 K8s container 如果后续启用，也不是给每个网站长驻运行的容器。

如果后续启用 K8s，它负责一次性的任务：

- 生成页面
- 构建
- 截图
- site-check
- 提交 PR
- 部署

最终网站运行在 Cloudflare Edge Worker / assets 上。

长期隔离模型可以是一任务一 namespace：

```text
namespace: page-job-<jobId>
```

后续 K8s MVP 可以先用共享 `pages-jobs` namespace，再通过 label、RBAC、resource quota 和 task-scoped secret 隔离。

### 10. GitHub Review Agent comment 是一等事件

MVP 的 review 重点不是平台自己生成一段泛化 review 文本，而是实时监听 GitHub Enterprise PR 里 GitHub Review Agent 提交的 comment。

关键边界：

- `review-monitor-worker` 通过 GitHub webhook 接收 `pull_request_review`、`pull_request_review_comment`、`issue_comment`、`check_run` / `check_suite`。
- 只处理 `GITHUB_REVIEW_AGENT_ALLOWLIST` 中的 GitHub App、bot login 或 check name。
- comment 先入库为 `ReviewAgentComment`，再分类为 `blocking | suggestion | note | unknown`。
- blocking comment 可以触发 `AgentRun(type=fix)`，coding agent 修复后由 controlled-committer push 到同一个 PR branch。
- GitHub Actions runner 或 K8s job 不长轮询 PR comment，GitHub webhook 和 `review-monitor-worker` 才是实时监听入口。

## 仍需确认的风险

### 0. 还需要继续描述的细节

当前文档已经定了大方向，但实现前还需要把下面这些细节继续写实：

| 主题 | 需要补充什么 | 为什么重要 |
| --- | --- | --- |
| Slack App 配置 | event、slash command、interactive action、重试、签名校验；scope MVP 可先拉满，后续再收敛 | 决定 Slack 入口能不能安全稳定运行 |
| GitHub Enterprise 权限 | GitHub App 权限、installation token、issue/PR/review/merge API、token 拆分 | 决定自动 PR 和自动合并的最小权限 |
| 状态机转移表 | `PublishingJob` 每个状态允许从哪里来、到哪里去、失败怎么 retry | 避免 worker 迟到 callback 或重复 webhook 改乱状态 |
| Queue / lease | worker 如何 claim job、续租、超时释放、幂等消费 | 多副本 worker 后必须有这个边界 |
| 站点命名 | `site_slug`、`site_name`、hostname 冲突、改名、转移 owner | 员工多站点下最容易撞名 |
| 站点生命周期 | create、update、delete、archive、restore、rollback | 不只新增网站，后续还要删除、归档和回滚 |
| 访问策略执行 | `company` 到底用 Cloudflare Access、SSO cookie 还是 IP/CIDR | 决定 Edge Worker 怎么判断访问者 |
| 模板和 schema | `site.json` schema、模板变量、允许的资源类型、禁止字段 | coding agent 和 review 都需要稳定合同 |
| 大文件策略 | 图片、附件、视频是否进 repo，何时进 R2 | 防止 monorepo 体积失控 |
| Preview 策略 | preview 域名、保留时间、清理规则、权限 | PR 多了以后 preview 会消耗资源 |
| Review 门禁 | GitHub Review Agent comment 分类、blocking 规则、确定性检查谁优先 | 决定什么时候能修复、等待人工或合并 |
| Rollback | 回滚到哪个 `deploy_id`、是否新建 PR、是否需要审批 | 线上页面出问题时必须能快速恢复 |
| 审计和日志 | 谁发起、谁批准、谁合并、谁部署、Slack 原文快照 | 追责和排障都依赖它 |
| 观测告警 | worker backlog、job failed、Slack 重试、Cloudflare deploy 失败 | 自动化平台没有告警会很难运营 |
| 配额 | 每员工站点数、每站点大小、并发 job、每日 deploy 次数 | “无限站点”需要产品配额托底 |
| 灾备 | DB 备份、KV 重建、R2 manifest 重建、repo 真相恢复 | Cloudflare KV 不是真相源，必须能重建 |

### 1. Cloudflare 实际配额

需要确认当前公司 Cloudflare 套餐下的 Worker、route、KV namespace、KV key、R2、请求量和存储限制。

这会影响：

- 资源池数量
- preview 保留时长
- 单站点文件大小限制
- 部署并发限制
- 是否需要多账号或多 zone 分片

### 2. 公司内访问策略具体实现

`SiteAccessPolicy(mode=company)` 需要选择一种执行方式：

- Cloudflare Access
- 公司 SSO + signed cookie / JWT
- 公司内网 IP/CIDR
- 多种方式组合

这个决定会影响 Edge Worker、gateway 登录态和审计模型。

### 3. GitHub Enterprise

已确认仓库在公司 GitHub Enterprise 组织 / 团队空间内，MVP 的 issue / PR / review / merge / webhook 都在 GitHub Enterprise 上闭环。

这会影响：

- GitHub App / installation token 权限模型
- review comments API
- required checks
- auto merge API
- CODEOWNERS、Rulesets、Actions environments 和 path filter 实现

### 4. 大仓体积治理

员工可以有很多网站，仓库不能无限膨胀。

需要约定：

- 单站点源码大小
- 图片和附件是否进 repo
- 大文件是否进 R2 / object storage
- 旧 preview 保留策略
- 归档和删除流程

### 5. Auto merge 开放节奏

MVP 不建议默认全自动合并。

推荐阶段：

```text
draft
manual-required
trusted-auto
```

只有 site-only PR、`pages-site-policy` 通过、CI 通过、没有 open blocking / unknown `ReviewAgentComment`、权限校验通过、无人工打回时，才允许 `trusted-auto`。GitHub Rulesets 不能对 `sites/**` 配 required CODEOWNERS，否则会和自动合并目标冲突。

## Review 后建议

下一步先不要急着写完整业务代码。更合适的是先把 monorepo 骨架和边界落下来：

1. 建立 `apps/gateway`、`apps/frontend`、`apps/worker`。
2. 建立 `packages/workflow-core`、`packages/git-client`、`packages/deploy-core`、`packages/access-control`。
3. 建立 `sites/`、`templates/` 和 `.github/workflows/`；`k8s/` 可作为后续 executor 目录预留。
4. 加上 path filter、`pages-site-policy`、CODEOWNERS、GitHub Enterprise Rulesets、Actions environment 和 workflow secret 分层。
5. 先做 Slack 触发的 `SlackEvent -> PublishingJob -> issue -> patch -> PR -> Agent Review -> Preview deploy -> Slack 回写` 闭环。

MVP 细化范围见 [mvp-scope.md](./mvp-scope.md)。当前第一优先级见 [first-priority-preview-loop.md](./first-priority-preview-loop.md)。MVP 必须结合 Slack；internal API 也是正式高级入口，但必须进入同一套 gateway、权限、issue/PR、review、preview deploy 和审计流程。CLI 暂不考虑。
