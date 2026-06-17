# pages-manager 当前状态

更新时间：2026-06-17

当前分支：`feat/slack-preview-gateway`

当前 HEAD：以 `git log -1 --oneline` 为准。

本文件记录当前实现、运行态验证和阻塞点。真实 secret、token、`.env`、`.env.ecs`、`.ack-preview.env` 不得写入本文档。

## 1. 当前结论

当前目标已经在代码层面实现：`pages-manager` 已从原有 Cloudflare 站点发布工具，扩展为 Slack 驱动的个人网页 preview 发布平台。

阶段判断：

- Cloudflare 发布底座、KV SDK 和公开站点 API 属于已有能力，仍要谨慎保护兼容性、权限隔离和 staging / production 行为。
- Slack / gateway / agent / DB / worker 这条 pages-manager 新平台线还没有正式上线，不需要兼容旧测试版本。后续可以继续按最终目标直接调整内部 API、表结构、状态机、Slack 卡片和服务拆分，只要不影响 Cloudflare 既有能力和用户站点隔离。

已经具备的主链路：

```text
用户在 Slack DM / thread / @bot 发需求
  -> pages-gateway 接收 Slack HTTP event 并验签
  -> slack-agent 做自由对话、需求整理、澄清和会话续接
  -> 用户点击确认按钮
  -> pages-worker 创建 GitHub issue
  -> GitHub issue webhook 回到 gateway
  -> pages-worker dispatch GitHub Actions Coding Agent
  -> pages-agent.yml 生成或修改 sites/<employee>/<site>/ 代码
  -> 创建或更新 PR
  -> site-check / GitHub Review Agent 结果经 webhook 回到 gateway
  -> Review gate 通过后发布 preview
  -> slack-notifier 在同一个 Slack thread 更新状态卡和 preview URL
```

当前仍不能按生产化宣称“完全稳定”的原因集中在运行环境和产品稳定性，而不是主链路缺失。

## 2. 当前代码状态

### 常驻服务

当前长期服务拆成四个：

- `apps/gateway`
  - 对外入口：Slack Events、Slack Interactivity、GitHub webhook、executor callback、内部 API。
  - 负责签名校验、幂等、Slack session、PublishingJob 状态机、Review gate。

- `apps/worker`
  - 调度发布任务。
  - 创建 / 复用 GitHub issue。
  - dispatch `project-index.yml`、`pages-agent.yml`。
  - 当前 ECS 验证路径下用 `local_deploy` 调 Cloudflare staging `/deploy`。

- `apps/slack-agent`
  - 常驻对话 Agent。
  - 使用公司 OpenAI-compatible 模型网关。
  - 负责自由聊天、需求整理、澄清、任务续接、任务列表意图。
  - 不写代码、不创建 PR、不直接部署。

- `apps/slack-notifier`
  - 持有 Slack bot token。
  - 负责 reaction、thread 消息、Block Kit 状态卡、用户 profile 查询。
  - GitHub Actions / Coding Agent 不拿 Slack token。

### Gateway 目录结构

```text
apps/gateway/src/
  index.js
  dev.js
  routes/register.js
  routes/health-routes.js
  routes/publishing-routes.js
  routes/slack-routes.js
  routes/github-routes.js
  routes/internal-routes.js
  control-plane/context.js
  control-plane/health-handlers.js
  control-plane/handlers.js
  publishing/api-handlers.js
  publishing/worker-dispatcher.js
  http/body.js
  http/router.js
  slack/agent-turn.js
  slack/http.js
  slack/intake.js
  slack/job-input.js
  slack/notifier.js
  slack/session.js
  slack/text.js
  slack/work-items.js
  github/review.js
  github/webhook.js
  db/gateway-store.js
  db/sql.js
  db/client.js
  db/config.js
  db/redis.js
  db/schema.js
  db/rows/*.js
  db/repositories/*.js
  utils/crypto.js
```

`routes/` 现在只负责 HTTP 路由分组注册；`control-plane/` 保留 Slack / GitHub / Review gate 的运行时 orchestration 和通用上下文；`publishing/` 承接 PublishingJob API 输入归一化和 worker 调度。后续如果继续拆，可以把其中的 Slack Agent turn、GitHub webhook、Review gate、PublishingJob follow-up 再下沉到各自 domain service。

### Worker 目录结构

```text
apps/worker/src/
  index.js
  dev.js
  config.js
  orchestrator.js
  jobs/issue-and-index.js
  jobs/coding-agent.js
  jobs/preview.js
  integrations/gateway-client.js
```

`orchestrator.js` 只根据 `job.status` 分发执行步骤；创建 issue、触发 Coding Agent、发布 preview、回调 gateway 已拆到独立文件。

### DB-only 运行态

Gateway runtime 已切到 MySQL-backed store：

- `apps/gateway/src/store.js` 已删除。
- `apps/gateway/src/file-store.js` 已删除。
- `apps/gateway/src/dev.js` 只允许 `PAGES_STORE_BACKEND=mysql` 或不设置。
- `apps/gateway/src/index.js` 默认 lazily 创建 `MySqlGatewayStore`。
- `MySqlGatewayStore` 内部的 `Map` 只是单进程缓存，不是状态真相源。
- 单元测试使用 `tests/helpers/gateway-store-fixture.js`，不代表运行时架构。

当前 DB 相关代码：

- Drizzle schema：`apps/gateway/src/db/schema.js`
- Migration：`apps/gateway/drizzle/migrations/`
- Row mapper：`apps/gateway/src/db/rows/`
- Repository：`apps/gateway/src/db/repositories/`

运行态不应再依赖：

- JSON 文件 store
- 进程内内存 store
- SQLite
- 单 pod PVC
- `PAGES_GATEWAY_STORE_FILE`

## 3. 当前产品行为

Slack 当前以自然语言对话为主，不要求用户输入 `/issue`。

当前规则：

- 用户消息先进入 Slack Agent。
- 信息不足时追问。
- 信息足够时展示确认卡片。
- 只有点击确认按钮后才创建 issue。
- 创建任务后，同一个 thread 用一张主状态卡持续更新。
- 普通进度默认只更新卡片，不额外刷屏。
- 用户继续回复修改意见时，默认续接同一个 session / issue / PR。
- 如果用户要求“我的 PR / 我的任务”，返回任务选择卡片，不自动创建新任务。
- Slack Agent 可以通过 `toolCall` 请求受控查询或操作；Gateway 负责把结果限定在当前 Slack 用户和当前 session 权限内。
- 正常的任务查询、任务切换、恢复已关闭 issue / PR 都优先由 Slack Agent 理解，再由 Gateway 执行 `toolCall`；Gateway 的规则分类只做 help / ping / status / 危险操作拦截和无 Agent 时的兜底。
- 已关闭或不可继续的任务不展示“继续修改”；可恢复的 GitHub issue / PR 展示“重新打开”动作。
- 用户明确说“重新打开 issue #数字 / PR #数字”时，Slack Agent 可以请求 `reopen_work_item`；Gateway 会重新校验该 issue / PR 是否属于当前 Slack 用户，并只恢复可恢复的关闭任务。
- 用户点击“关闭会话”后，当前 SlackSession 会关闭并清理 running AgentRun；之后即使继续在同一个 Slack thread 里发消息，也不会复活旧会话，而是开启新的会话上下文或按用户显式选择继续旧任务。
- 危险批量操作，例如“关闭我名下所有 issue / PR”，会被拒绝，不会改写成任务列表查询。

Slack 用户隔离：

```text
team_id + primary_slack_user_id + session_key
```

一个用户可以有多个 session。Slack thread 是强 session 边界；DM 会根据 thread、active context 和最近任务选择规则续接。用户不能通过猜 job id、issue number 或 session id 接管别人的任务。

## 4. 当前运行验证

当前已在 ECS 路线验证过：

- ECS compose 运行 `pages-gateway / pages-worker / slack-agent / slack-notifier / pages-mysql / pages-redis`。
- 公司反代可把公网请求转到 ECS。
- Slack Events / Interactivity 可以命中 gateway，并由 gateway 验签。
- GitHub webhook ping 返回 200。
- Slack Agent 可以调用公司模型网关。
- GitHub Actions Coding Agent 可以生成站点 PR。
- site-check / Review Agent 结果可以经 GitHub webhook 回到 gateway。
- `pages-worker` 可以用固定 ECS 出口调用 Cloudflare staging `/deploy`。
- Slack 状态卡可以回写 preview URL。

历史真实链路曾跑通到 preview：

```text
Issue: #61
PR: #62
Preview: https://pm-pr-62-xiaoyi-1pdp8m-profile-real-slack-identity-staging.workers.xd.team
```

这个结果证明主链路可行，但仍需要继续做多用户、多 session、多轮修改、失败重试和长时间运行稳定性验证。

## 5. 当前运行环境

### ECS

ECS 是当前测试部署载体。服务形态接近后续 K8s：

```text
pages-gateway
pages-worker
slack-agent
slack-notifier
pages-mysql
pages-redis
```

ECS 不应放 `.ack-preview.env`，也不需要 Aliyun AK。它只需要运行服务所需的 `.env.ecs` 类配置和 Docker compose runtime secret。

### ACK / K8s

ACK preview 暂时不是主验证环境。K8s 目录已按 `pages-manager-preview` namespace 组织，不应影响 `xdclaw-preview`。

K8s 目标服务仍是：

```text
gateway / worker / slack-agent / slack-notifier
```

K8s Secret 应在 `pages-manager-preview` namespace 内独立维护：

- `slack-platform-secret`
- `github-platform-secret`
- `callback-secrets`
- `model-provider-secret`
- `database-secret`
- `redis-secret`

不要引用或修改 xdclaw 的业务 Secret。

## 6. GitHub / Workflow 边界

平台本体 workflow：

```text
ci.yml
deploy-staging.yml
deploy.yml
deploy-ack-preview.yml
sync-master-pr-to-staging.yml
```

用户站点发布 workflow：

```text
project-index.yml
pages-agent.yml
site-check.yml
pages-preview.yml
```

用户站点 workflow 不能拿：

- Aliyun AK
- ACR 权限
- `KUBE_CONFIG_B64`
- `kubectl`
- Slack bot token
- production Cloudflare token

自动站点 PR 只能改：

```text
sites/<employeeSlug>/<siteSlug>/
```

## 7. 当前阻塞点

1. 外网入口和反代稳定性

   Slack Events、Slack Interactivity、GitHub webhook、executor callback 都需要公网 HTTPS 入口命中 gateway。当前通过公司反代 / ECS 能跑，但长期部署时需要确保原始 body、Slack 签名 header、GitHub 签名 header 都被透明转发。

2. 数据库和 Redis 的最终归属

   当前测试可以使用 ECS compose 内置 MySQL / Redis，或者短期在独立 namespace 内跑临时 MySQL / Redis。这样是为了快速验证链路，不是最终生产数据面。最终需要 pages-manager 独立 database / Redis DB / 用户授权，不能复用 xdclaw 的业务 database，也不能把表建进 xdclaw schema。

3. ACK / ACR lane 的网络可达性

   GitHub-hosted runner 到阿里云 ACR 公网 registry 曾出现 `i/o timeout`。这不是 kubeconfig 问题，更像 GitHub runner 到 ACR 公网 registry 的网络连通问题。它影响 ACK/ACR 自动构建部署 lane，不影响当前 ECS compose 测试链路。

4. GitHub 平台身份

   当前测试里使用过 token。长期应迁移到 GitHub App installation token，保证审计、权限和员工生命周期不依赖个人 PAT。

5. Slack 多用户 / 多轮稳定性

   主链路跑通过，但还需要持续验证：
   - 多个 Slack 用户同时发起任务。
   - 同一个用户多个 session 并存。
   - 已有 preview 多轮修改。
   - 任务列表选择旧 PR 后继续修改。
   - 关闭会话、关闭 issue、不可继续任务的按钮状态。

6. Review Agent comment 处理闭环

   当前已有 Review gate 和 watchdog。后续还需要更细地记录每条 Review Agent comment 的处理状态，逐条回复“已处理 / 无需处理 / 转人工”，并与 Slack follow-up 进入同一条 per job 修复队列。

## 8. 当前待做

- 继续在真实 Slack 上验证多轮对话和旧任务续接。
- 检查 closed issue / closed PR 的任务列表展示和按钮状态。
- 完善 Review Agent comment 逐条处理状态。
- 将 GitHub 写入身份迁移到 GitHub App installation token。
- 确认生产级 MySQL / Redis 独立授权。
- 确认长期公网入口方案，避免依赖临时反代。
- 在 ACK/ACR lane 可达性解决后，再恢复 ACK 自动部署验证。

## 9. 最近本地验证

代码改造后已验证过：

```text
corepack pnpm lint
corepack pnpm test
git diff --check
```

文档对齐后需要重新运行上述命令。
