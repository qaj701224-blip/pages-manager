# Local K8s Control Plane Runtime

## 定位

`pages-manager` 的控制面从本地验证开始就必须跑在 K8s 上。这不是 MVP 降级选项，而是当前和长期都要遵守的运行态合同：

```text
本地 K8s 跑常驻控制面服务
  +
GitHub Actions 跑一次性 coding / site-check / preview executor
  +
后续再把一次性 executor 迁到 K8s Job
```

这不是“全量 K8s executor”。当前先把长期常驻服务按 K8s 方式运行起来，让本地、测试服务器和后续生产部署使用同一种控制面模型。完整硬约束见 [k8s-runtime-contract.md](./k8s-runtime-contract.md)。

因此：

- Slack Events / Interactivity 必须进入 K8s 里的 `pages-gateway`。
- GitHub webhook 和 executor callback 必须进入同一个 K8s `pages-gateway`。
- Review Agent comment、required check、preview gate 的状态推进必须由 K8s gateway / worker 完成。
- 本机 `gh watch`、`gh pr view`、临时 Node listener 只能排障，不能成为平台链路的一环。

## 为什么这样做

相比本地裸 Node 或 Docker Compose：

- gateway、Slack Agent、worker、DB、Redis 从第一天就有 namespace、Service、Secret、ConfigMap 和 readiness 边界。
- 本地跑通后，上服务器主要是换 kube context、Ingress、域名和 secret。
- Slack HTTP Events / Interactivity、GitHub webhook、Actions callback、worker callback 的网络拓扑能提前验证。
- 后续启用 K8s Job executor 时，不需要重写控制面部署方式。

相比第一阶段直接全量 K8s Job executor：

- coding agent、builder、site-check、preview 继续用 GitHub Actions，少做 PVC、Job image、RBAC、workspace cleanup 和受控 committer 容器。
- 当前仍然聚焦 Slack 到 Preview URL 的闭环，但控制面和状态监听不从 K8s 退回本机脚本。

## 本地集群

本地推荐使用 `kind` 或 `k3d`。二选一即可，不要在同一套文档里要求同时支持两种。

```text
local cluster
  └─ namespace: pages-system
       ├─ Deployment pages-gateway
       ├─ Deployment slack-agent
       ├─ Deployment pages-worker
       ├─ Deployment review-monitor-worker  (MVP 可先合在 gateway)
       ├─ Deployment slack-notifier         (MVP 可先合在 gateway)
       ├─ Service pages-gateway
       ├─ Service pages-worker
       ├─ Service slack-agent
       ├─ MySQL
       ├─ Redis
       ├─ ConfigMap pages-config
       ├─ Secret slack-platform-secret
       ├─ Secret github-platform-secret
       ├─ Secret cloudflare-preview-secret
       └─ Secret callback-secrets
```

`pages-jobs` namespace 不属于当前必需项。它等到 K8s Job executor 开始实现时再启用。即使一次性 executor 还在 GitHub Actions，控制面、webhook、callback、Slack 回写仍必须在 `pages-system`。

## MySQL / Redis 定位

MySQL 和 Redis 是 `pages-manager` 控制面的平台级依赖。

它们服务整条链路：

| 组件                    | MySQL 用途                                                                                        | Redis 用途                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `pages-gateway`         | `PublishingJob`、Slack/GitHub delivery、session、issue link、review comment、deploy、audit 真相源 | Slack / GitHub 幂等短缓存、gateway lease、API rate limit、状态事件 fan-out |
| `slack-agent`           | 读取 `SlackSession`、`SessionMemory`、`IssueLink`、`AgentRun` 上下文                              | session lease、模型调用并发控制、临时 provider thread state                |
| `pages-worker`          | 读取 job 和 stage attempt，通过 gateway 合同推进状态                                              | worker queue、retry delay、dispatch lock                                   |
| `review-monitor-worker` | 写 GitHub delivery、review comment、review run                                                    | webhook dedupe、review event queue                                         |
| `slack-notifier`        | 读取 JobEvent / IssueLink，记录通知结果                                                           | notification queue、Slack rate-limit 协调                                  |

原则：

- MySQL 是长期真相源；Redis 只做短期协调、队列、lease、rate limit 和 pub/sub。
- Redis flush 或 pod 重启不能导致 `PublishingJob`、Slack session、issue/PR 关联、deploy record 或 audit 丢失。
- 本地 smoke、staging 和 production 都必须使用 MySQL + Redis；`FileBackedGatewayStore` 和内存 queue 只能作为历史过渡代码、单元测试 fixture 或一次性迁移输入。
- 参考 `xdclaw` 的 DB 架构：gateway 是无状态多副本入口，持久元数据进外置 MySQL，in-flight flow / session lease / pub-sub 进 Redis；跨请求状态不得依赖文件、SQLite、进程内 Map / Set 或单 pod PVC。

## 网络入口

Slack HTTP Events / Interactivity：

```text
Slack Platform
  ↓ HTTPS public URL
Cloudflare Tunnel / ngrok / Ingress
  ↓
pages-gateway Service
```

Slack、GitHub webhook 和 GitHub Actions callback 都需要能访问同一个 gateway public URL。本地用 tunnel；测试服务器和生产建议用正式 Ingress + 域名。

GitHub webhook / Actions callback：

```text
GitHub Enterprise / GitHub Actions
  ↓ HTTPS public URL
Cloudflare Tunnel / ngrok / Ingress
  ↓
pages-gateway Service
```

本地可以用 tunnel；测试服务器和生产建议用正式 Ingress + 域名。

## Secret 边界

K8s Secret 只保存引用和运行时注入，不写进 Git。

| Secret                      | 用途                                                                                                                                   | 可注入组件                                               |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `slack-platform-secret`     | Slack bot token、signing secret、app metadata                                                                                          | `pages-gateway`、必要时 `slack-agent` / `slack-notifier` |
| `model-provider-secret`     | 公司 OpenAI-compatible 模型网关 key；`slack-agent-api-key` 注入 Slack Agent，`coding-agent-api-key` 预留给 Coding Agent / 后续 K8s Job | `slack-agent`                                            |
| `github-platform-secret`    | GitHub App / callback / webhook secret                                                                                                 | `pages-gateway`、`pages-worker`                          |
| `cloudflare-preview-secret` | legacy `/deploy` preview owner marker；仅用于本地 smoke / 兼容旧 API                                                                   | `pages-worker` 或 preview deploy executor                |
| `database-secret`           | MySQL 连接                                                                                                                             | `pages-gateway`、`slack-agent`、`pages-worker`           |
| `redis-secret`              | Redis 连接                                                                                                                             | `pages-gateway`、`slack-agent`、`pages-worker`           |

Gateway 持久化：

- 旧实现中的 `PAGES_GATEWAY_STORE_FILE=/data/pages-gateway-store.json` 和 `pages-gateway-data` PVC 必须迁出运行态。
- MVP 运行态使用 `DATABASE_URL` 连接 MySQL，使用 `REDIS_URL` 连接 Redis。
- MySQL 初始化必须通过 `pnpm db:setup` / `pnpm db:migrate` 或等价 K8s init / pre-start 流程执行 Drizzle migration；失败时 gateway 不允许 fallback 到文件 store。
- `PublishingJob`、`SlackSession`、`SessionMemory`、`IssueLink`、AgentRun、GitHub webhook delivery、Review Agent comment、DeployRecord、JobEvent、AuditLog、RuntimeLogPointer、ExternalApiCallLog 都落 MySQL。
- Slack / GitHub dedupe cache、session lease、worker queue、notifier queue、rate limit 和 console live update 落 Redis。
- 如果已有 JSON snapshot，需要提供一次性迁移脚本导入 MySQL，迁移完成后 K8s manifest 不再挂载 gateway store PVC。

禁止：

- 把 Slack token 注入 GitHub Actions runner、coding agent、site-check 或 deployer。
- 把模型供应商 API key 注入 GitHub Actions runner、coding agent、site-check、deployer、员工站点或生成页面。
- 把 Cloudflare production token 注入 Slack Agent、coding agent、site-check。
- 把 GitHub write token 注入 Slack Agent。
- 在 manifest、ConfigMap、文档或测试 fixture 中提交真实 secret。

## 与 GitHub Actions Executor 的关系

常驻控制面负责：

```text
Slack event intake
identity / permission
PublishingJob state machine
GitHub issue / workflow dispatch
GitHub webhook / ReviewAgentComment
Preview Gate
Slack notification
DB / audit
```

GitHub Actions 负责：

```text
project-index.yml
pages-agent.yml
site-check.yml
pages-preview.yml
```

Actions callback 仍然回到 K8s 里的 `pages-gateway`。

## 下一步落地顺序

1. 基于现有 `k8s/base/pages-system` 骨架继续收口 namespace、ConfigMap、Secret template、ServiceAccount、Deployment、Service。
2. MySQL / Redis / Drizzle 平台基座已经进入 K8s 运行态：`DATABASE_URL`、`REDIS_URL` 由 Secret 注入，`PAGES_STORE_BACKEND=mysql`、`PAGES_QUEUE_BACKEND=redis` 由 ConfigMap 注入，gateway 不再挂载 PVC。
3. 为 `apps/gateway`、`apps/slack-agent`、`apps/worker` 准备容器镜像构建方式。
4. 本地用 kind/k3d 部署 `pages-system`。
5. 用 tunnel 暴露 gateway 的 webhook / callback URL。
6. 让 Slack Events / Interactivity、GitHub Actions callback 和 GitHub webhook 都打到同一个 gateway public URL。
7. 保持 `pages-agent.yml`、`site-check.yml`、`pages-preview.yml` 继续在 GitHub Actions 上运行，但 workflow 结果必须 callback K8s gateway，PR / Review / check 状态必须通过 GitHub webhook 进入 K8s gateway。

当前仓库内已落地第一版骨架：

```text
Dockerfile.node-service
scripts/k8s-local-build.sh
scripts/k8s-local-cluster.sh
scripts/k8s-local-status.sh
scripts/k8s-local-logs.sh
scripts/k8s-local-port-forward.sh
scripts/k8s-local-up.sh
k8s/base/pages-system/
  namespace.yaml
  serviceaccount.yaml
  configmap.yaml
  gateway.yaml
  kustomization.yaml
  worker.yaml
  slack-agent.yaml
  secrets.template.yaml
```

当前 K8s 运行态已经移除 gateway PVC 和 `PAGES_GATEWAY_STORE_FILE`，并通过 `PAGES_STORE_BACKEND=mysql` 使用 MySQL-backed runtime store。测试阶段不迁移旧 file store 数据。

本地启动入口：

```bash
pnpm k8s:check-env
pnpm k8s:cluster
pnpm k8s:up
pnpm k8s:smoke
```

`pnpm k8s:check-env` 会检查本地 Slack / GitHub / callback 必需变量是否齐全，但不会打印 secret 值。`pnpm k8s:cluster` 会创建或复用名为 `pages-manager` 的本地 kind/k3d cluster，并把 kubectl context 切到专用 context。`pnpm k8s:up` 会先确认当前操作目标是这个 cluster，避免误把 `pages-system` 部署到其它项目的 K8s 集群。

`.env` 只作为本地 bootstrap 输入，用来生成 K8s Secret / ConfigMap；启动后的运行态真相必须以 K8s 为准。排障、smoke 和 Slack 链路验证不能直接读取宿主机 `.env` 判断服务是否配置正确，必须通过 `kubectl -n pages-system get configmap/secret`、`kubectl exec ... printenv` 或 `pnpm k8s:smoke` 检查 pod 实际注入的配置。这样本地验证和后续服务器部署模型保持一致。

共享开发机隔离要求：

- 默认 `pages-manager` cluster / `pages-system` namespace 只适合一个本地控制面绑定同一个 Slack App 的 Events / Interactivity Request URL。
- 多个开发者同时跑本地控制面时，必须分别设置独立的 cluster 名、API port、storage 目录、Cloudflare tunnel、公网 callback URL 和 Slack App；不要让多套本地控制面争用同一个 Slack App Request URL。
- `.env`、K8s Secret、MySQL database/schema、Redis namespace/key prefix 和集群持久卷都按控制面实例隔离；不要把个人 `.env` 放到共享路径，也不要复用别人的 `PAGES_GATEWAY_PUBLIC_URL`。
- 如果只是多人从 Slack 使用同一个 bot，不需要启动多套控制面；所有用户都走同一个 `pages-gateway`，再由 gateway 按 Slack user/session 隔离。

如果要按 `xdclaw` 的本地验证方式一次跑完整个非破坏性链路，使用：

```bash
pnpm k8s:validate
```

它会顺序执行：

```text
check root .env
  ↓
ensure local cluster
  ↓
build/apply pages-system
  ↓
smoke control plane
```

`pnpm k8s:smoke` 会验证：

- `pages-gateway`、`pages-worker`、`slack-agent` Deployment 已 rollout。
- `slack-platform-secret`、`github-platform-secret`、`callback-secrets` 中存在必须 key，但不会打印 secret 值。
- `database-secret/database-url` 与 `redis-secret/redis-url` 存在；测试阶段不迁移旧 file/PVC 数据。
- `pages-config` 中的 GitHub repo、workflow ref、base ref、gateway public/callback URL 等运行时值不是占位符。
- `SLACK_EVENTS_PROCESSING_MODE`、`SLACK_SIGNATURE_REQUIRED`、`SLACK_SIGNATURE_MAX_SKEW_SECONDS` 等 Slack HTTP 入口配置已经写入 K8s ConfigMap。测试时仍以 K8s ConfigMap/Secret 和 pod env 为准，不能直接读取宿主机 `.env` 判断运行态。
- 通过临时 `kubectl port-forward` 探测 `pages-gateway` 的 `/ready`，以及 `pages-worker`、`slack-agent` 的 `/health`。`/ready` 会检查 gateway 当前 DB-backed store。
- 如果 `PAGES_PREVIEW_MODE=local_deploy`，还会要求 `cloudflare-preview-secret` 中存在 legacy preview owner marker。这个 marker 只用于本地 smoke，不代表长期员工隔离模型。

本地推荐：

```text
PAGES_WORKFLOW_REF=staging
PAGES_BASE_REF=staging
```

`PAGES_WORKFLOW_REF` 表示从哪个分支读取 GitHub Actions workflow 文件；`PAGES_BASE_REF` 表示生成代码和 PR 的目标业务分支。当前新版 `project-index.yml`、`pages-agent.yml`、`site-check.yml`、`pages-preview.yml` 合同已先合入 `staging`，本地 K8s smoke 用 `staging` 同时作为 workflow ref 和生成 PR 的 base。

Preview token 边界：

- 员工不申请 Cloudflare，也不持有 Cloudflare token。
- `PAGES_PREVIEW_TOKEN` / `PAGES_TOKEN` 是现有 `apps/server` `/deploy` 的兼容 owner marker，不是强认证。
- 本地 `PAGES_PREVIEW_MODE=local_deploy` 可以用一个 smoke marker 快速拿到 preview URL，但这只适合本地验证。
- 长期 preview deploy 应由 gateway / preview deployer 根据 `PublishingJob.ownerScopeId`、`siteProjectId`、`employeeSlug`、`siteSlug` 解析或签发受限 deploy identity，并写入审计。
- 隔离边界来自 owner scope、site project、站点命名、管理权限和 deploy record，而不是让每个员工各自申请 Cloudflare token。

本地 k3d cluster 创建逻辑参考 `xdclaw/scripts/k3d-up.sh`：

- 默认使用 `rancher/k3s:v1.31.6-k3s1`。
- API 绑定到 `127.0.0.1:${PAGES_K3D_API_PORT:-6551}`，避免和 `xdclaw-dev` 默认 `6550` 冲突。
- 禁用内置 traefik，后续如果要本地 Ingress 再单独安装。
- 挂载本机 storage 到 k3s local-path storage，默认路径是 `${HOME}/.local/share/pages-manager/k3d/pages-manager/storage`。
- 创建完成后等待 node ready，并输出默认 StorageClass。

`scripts/k8s-local-up.sh` 会：

- 构建 `pages-manager/gateway:local`、`pages-manager/worker:local`、`pages-manager/slack-agent:local`。
- 如果本地存在名为 `pages-manager` 的 kind/k3d cluster，则自动把镜像 load/import 进去。
- 默认读取仓库根目录 `.env`。
- 从 `.env` 和当前 shell 环境变量创建 K8s Secret，不输出 secret，也不提交真实 `.env`。
- 应用 `k8s/base/pages-system`。

关键本地变量：

```text
PAGES_GATEWAY_PUBLIC_URL
SLACK_BOT_TOKEN
SLACK_SIGNING_SECRET
SLACK_AGENT_SHARED_SECRET
AGENT_GATEWAY_URL
SLACK_AGENT_API_KEY
GITHUB_REPO
GITHUB_APP_INSTALLATION_TOKEN
GITHUB_WEBHOOK_SECRET
INTERNAL_CALLBACK_TOKEN
PAGES_WORKER_SHARED_SECRET
PAGES_PREVIEW_TOKEN      # local_deploy smoke only; long-term should be owner/job scoped
```

常用排障命令：

```bash
pnpm k8s:status
pnpm k8s:logs
PAGES_K8S_LOG_TARGET=slack-agent pnpm k8s:logs
pnpm k8s:port-forward
```

`pnpm k8s:port-forward` 是给本地 tunnel 长期使用的 gateway 转发入口。`kubectl port-forward` 在 pod 重启或连接 broken pipe 时可能退出，所以脚本默认会自动重连；只有设置 `PAGES_K8S_PORT_FORWARD_ONCE=true` 时才会按一次性命令退出。GitHub Actions callback 和 GitHub webhook 都依赖这条转发链路，测试前要确认公网 tunnel 的 `/ready` 能打到当前 gateway pod 并通过 DB store 检查。

`PAGES_GATEWAY_PUBLIC_URL` 必须是公网 HTTPS tunnel URL，用于 Slack Events、Slack Interactivity、GitHub webhook 和 GitHub Actions callback。`PAGES_GATEWAY_CALLBACK_URL` 应显式设置为 `${PAGES_GATEWAY_PUBLIC_URL}/internal/executor-callback`，本地 `k8s:up` 会在未单独配置时自动从 `PAGES_GATEWAY_PUBLIC_URL` 派生并写入 ConfigMap。

## 本地验证分层

这部分参考 `xdclaw` 的本地验证方式，但保持 `pages-manager` 自己的命名、端口、namespace 和根目录 `.env` 约束。

| 层级              | 命令                                 | 是否破坏性 | 验证目标                                                     |
| ----------------- | ------------------------------------ | ---------- | ------------------------------------------------------------ |
| 配置预检          | `pnpm k8s:check-env`                 | 否         | 根目录 `.env` 中是否具备 Slack / GitHub / callback 必需变量  |
| 集群启动          | `pnpm k8s:cluster`                   | 否         | `pages-manager` 本地 kind/k3d cluster、context、StorageClass |
| 控制面部署        | `pnpm k8s:up`                        | 否         | 构建镜像、导入本地集群、创建 Secret、应用 `pages-system`     |
| 控制面 smoke      | `pnpm k8s:smoke`                     | 否         | Deployment rollout、Secret key、gateway `/ready`、Service `/health` |
| 非破坏性整链      | `pnpm k8s:validate`                  | 否         | 串起 check-env / cluster / up / smoke                        |
| k3d Secret 持久化 | `pnpm k8s:verify-secret-persistence` | 是         | 验证 k3d control plane restart 与 stop/start 后 Secret 不丢  |

`pnpm k8s:verify-secret-persistence` 只用于本地 k3d。它会创建临时 namespace/Secret，然后执行：

```text
docker restart k3d-pages-manager-server-0
  ↓
校验 Secret hash
  ↓
k3d cluster stop/start pages-manager
  ↓
再次校验 Secret hash
```

它会短暂中断本地 `pages-manager` K8s control plane，不放进默认 `pnpm k8s:validate`。

本地 k3d 数据边界：

| 场景                                        | 预期                              |
| ------------------------------------------- | --------------------------------- |
| Pod 删除重建                                | K8s Secret 和 local-path PVC 保留 |
| Deployment rollout                          | K8s Secret 和 local-path PVC 保留 |
| `docker restart k3d-pages-manager-server-0` | K8s Secret 保留                   |
| `k3d cluster stop/start pages-manager`      | K8s Secret 保留                   |
| `k3d cluster delete pages-manager`          | K8s 元数据删除，不能视作无损恢复  |

## 后续迁移

当 K8s Job executor 开始实现时，新增：

```text
namespace: pages-jobs
  ├─ Job job-<jobId>-coding-agent
  ├─ Job job-<jobId>-builder
  ├─ Job job-<jobId>-site-check
  ├─ Job job-<jobId>-controlled-committer
  └─ Job job-<jobId>-preview-deployer
```

上层 `PublishingJob`、`JobStageAttempt`、`AgentRun`、`SiteCheckRun` 和 callback 合同不变，只替换 executor adapter。
