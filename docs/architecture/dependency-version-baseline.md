# Dependency Version Baseline

## 定位

`pages-manager` 做平台化大改时，运行时和基础设施版本建议参考 `xdclaw` 当前基线，尤其是 Node、pnpm、MySQL、Redis、Docker base image、K8s 本地集群和前端工具链。MVP 已决定本地 K8s 跑常驻控制面，因此需要锁定 cluster / manifest / app image 基线；K8s JS client、job-runner 镜像和 executor 镜像只在启用 K8s Job executor 时再引入。

这份文档只参考版本和工程栈，不代表复用 `xdclaw` 的业务代码、DB schema、CRD 或 OpenClaw 实例模型。

## 版本来源

当前基线来自本地 `xdclaw` 仓库这些文件：

```text
xdclaw/gateway/package.json
xdclaw/gateway/pnpm-lock.yaml
xdclaw/frontend/package.json
xdclaw/frontend/pnpm-lock.yaml
xdclaw/instance-manager/package.json
xdclaw/instance-manager/pnpm-lock.yaml
xdclaw/gateway/Dockerfile
xdclaw/frontend/Dockerfile
xdclaw/instance-manager/Dockerfile
xdclaw/gateway/test/integration/docker-compose.yaml
xdclaw/scripts/k3d-up.sh
xdclaw/scripts/kind-up.sh
xdclaw/scripts/mirror-images-acr-amd64.sh
xdclaw/vendor-xd-releases/openclaw-operator/go.mod
xdclaw/vendor-xd-releases/openclaw-operator/Dockerfile
xdclaw/k8s/operator/values/*.yaml
```

## 总体建议

| 层 | pages-manager 建议 | 参考 xdclaw |
| --- | --- | --- |
| Node runtime | Node 22 | `node:22-bookworm` / `node:22-bookworm-slim` |
| package manager | pnpm 10.x，建议统一到 `pnpm@10.33.x` | gateway Dockerfile 用 `10.14.0`，instance-manager 用 `10.33.0`，OpenClaw 用 `10.33.2` |
| backend framework | Fastify 5.x | gateway `fastify@5.8.5` |
| DB | MySQL 8.x，优先 MySQL 8.4 兼容 | gateway 使用 `mysql2@3.22.1` + `drizzle-orm@0.45.2` |
| Redis | Redis 7 | integration compose 用 `redis:7-alpine` |
| Queue | BullMQ 5.x | gateway `bullmq@5.76.4` |
| K8s JS client | 启用 K8s Job executor adapter 时使用 `@kubernetes/client-node@1.4.0`；仅部署静态 manifests 不需要 | gateway 当前版本 |
| K8s API baseline | MVP 控制面 manifest 使用 Kubernetes 1.31 API 能力范围，生产至少 1.28+ | operator `k8s.io/*@v0.31.0` |
| Local K8s | MVP 本地控制面使用 k3d/k3s 1.31.6 或 kind，二选一 | `rancher/k3s:v1.31.6-k3s1` |
| Frontend | React 19 + Vite 8 + TypeScript 6 | frontend 当前基线 |
| Cloudflare deploy | 保留 pages-manager 现有 Wrangler 4.91.0 | pages-manager 已有 catalog |

## Backend 版本

`pages-manager` 新增 `apps/gateway` 和 `apps/worker` 时，建议优先贴近 `xdclaw/gateway`：

| 类别 | 建议版本 |
| --- | --- |
| `fastify` | `^5.8.5` |
| `@fastify/cookie` | `^11.0.2` |
| `@fastify/cors` | `^11.2.0` |
| `@fastify/multipart` | `^10.0.0` |
| `drizzle-orm` | `^0.45.2` |
| `drizzle-kit` | `^0.31.10` |
| `mysql2` | `^3.22.1` |
| `ioredis` | `^5.10.1` |
| `bullmq` | `^5.76.4` |
| `@bull-board/api` / `@bull-board/fastify` | `^7.0.0` |
| `@kubernetes/client-node` | `^1.4.0`，仅 K8s executor adapter 需要 |
| `zod` | `^4.3.6` |
| `pino` | `^10.3.1` |
| `tsx` | `^4.21.0` |
| `typescript` | `^6.0.3` |
| `@types/node` | `^25.6.0` |
| `playwright` | `^1.52.0` specifier，lock resolved 到 `1.59.1` |
| `undici` | gateway specifier `^6.21.3`，instance-manager resolved 到 `6.25.0` |
| `ws` | `^8.20.0` |

说明：

- `pages-manager` 现在 root 是 `pnpm@9.15.0`、Node `>=22.12.0`。如果要引入 gateway / worker / Actions-first executor workflow，建议升级到 pnpm 10.x，并把 Node 下限提升到 `>=22.14.0` 或直接约定 Node 22 LTS 镜像。
- `xdclaw/instance-manager` 仍用 `fastify@4.29.1`，这是 sidecar 历史原因；`pages-manager` 新服务不建议从 Fastify 4 开始。
- `playwright` 只给 browser-worker / screenshot / visual check 使用，不进入普通 gateway 必需依赖。

## Slack 版本

`xdclaw` 平台服务本身不以 Slack 为主入口，但 vendored OpenClaw 里已有 Slack SDK 版本可参考：

| 包 | 参考版本 |
| --- | --- |
| `@slack/bolt` | `^4.7.2` |
| `@slack/web-api` | `^7.15.1` |
| `@slack/types` | `^2.20.1` |

`pages-manager` 的 Slack 入口可以有两种方式：

| 方式 | 建议 |
| --- | --- |
| Fastify raw endpoint + `@slack/web-api` | 更贴合当前 gateway 架构，适合严格控制 signature、幂等和状态机 |
| `@slack/bolt` | 适合快速接 event / command / interaction，但必须确认不会绕过 gateway 的统一鉴权和幂等 |

MVP 推荐先用 Fastify endpoint 自己校验 Slack signature，再用 `@slack/web-api@^7.15.1` 拉 thread 和回写消息。

## 数据库和 Redis

### MySQL

`xdclaw/gateway` 使用：

```text
drizzle-orm/mysql2
mysql2/promise
```

连接池基线：

```text
connectionLimit: 10
maxIdle: 10
idleTimeout: 60000
```

`pages-manager` 建议：

- DB 首选 MySQL 8.x。
- 如果公司 RDS 标准是 MySQL 8.4，可以直接按 8.4 设计。
- SQL 和迁移要保持 MySQL 方言，不要在 MVP 同时兼容 Postgres。
- 使用 `drizzle-orm@0.45.2` + `drizzle-kit@0.31.10`。
- `PublishingJob`、`SlackEvent`、`GitHubWebhookDelivery`、`ReviewAgentComment`、`DeployRecord` 的唯一约束必须落 DB。

注意：`xdclaw` 代码里已经遇到 MySQL 8.0.20+ 对 `VALUES(col)` upsert 写法的 warning，但当前 `drizzle-orm@0.45.2` 仍可用。`pages-manager` 设计 upsert 时要接受这个现状，等 Drizzle 支持 row alias 后再统一升级。

### Redis

`xdclaw` integration compose 使用：

```text
redis:7-alpine
```

Node client：

```text
ioredis@5.10.1
bullmq@5.76.4
```

`pages-manager` 建议：

- Redis 7 作为 queue、event stream、dedupe cache、lease、Slack/GitHub webhook 临时状态。
- DB 仍是真相源；Redis 不保存最终发布状态。
- BullMQ 用于 worker task queue，Redis Stream 可用于 job progress / Slack notifier / console SSE。

## K8s 版本

本节分两层：MVP 需要本地 K8s cluster、`pages-system` manifests 和常驻服务镜像；后续启用 K8s Job executor 时才需要 K8s JS client、`job-runner` 镜像和 executor 镜像发布链路。

### JS client

`xdclaw/gateway` 使用：

```text
@kubernetes/client-node@1.4.0
```

`pages-manager` 的 `pages-gateway` 如果要创建 K8s Job / ConfigMap / Secret / PVC，建议沿用这个版本。

### Go operator 参考

`xdclaw` vendored OpenClaw operator 当前是：

```text
go 1.25.0
k8s.io/api v0.31.0
k8s.io/apimachinery v0.31.0
k8s.io/client-go v0.31.0
sigs.k8s.io/controller-runtime v0.19.0
```

`pages-manager` MVP 不需要写 operator，也不建议一开始引入 CRD。只有未来要把 publishing job 做成 CRD 时，才参考这套 Go operator 版本。

### Cluster baseline

`xdclaw` 本地 k3d：

```text
rancher/k3s:v1.31.6-k3s1
```

`xdclaw` kind：

```text
kind.x-k8s.io/v1alpha4
```

operator README 标注 Kubernetes 1.28+，但实际代码生成文档和 Go modules 对齐 Kubernetes 1.31 API。

`pages-manager` K8s 基线建议：

- 本地 K8s 控制面和后续 K8s executor 都以 Kubernetes 1.31 作为开发和 CI 基线。
- 生产 ACK / 企业集群至少要求 Kubernetes 1.28+。
- 新 manifest 使用 `apps/v1`、`batch/v1`、`networking.k8s.io/v1`、`rbac.authorization.k8s.io/v1`。
- 不做 per-site namespace；K8s executor 初期用 `pages-jobs`，长期可以一任务一 namespace。

## Docker / Image 基线

`xdclaw` 常用镜像：

| 用途 | 版本 |
| --- | --- |
| Node build | `node:22-bookworm` |
| Node runtime | `node:22-bookworm-slim` |
| frontend runtime | `nginx:1.27-alpine` |
| Redis local test | `redis:7-alpine` |
| local k3d | `rancher/k3s:v1.31.6-k3s1` |
| kubectl helper | `kubectl:v1.35.4` |
| buildkit | `moby/buildkit:v0.25.0-rootless` |
| docker CLI / dind | `docker:27.5.1-cli` / `docker:27.5.1-dind` |
| busybox | `busybox:1.37` |
| alpine helper | `alpine:3.20` |
| rclone | `rclone:1.68` |

`pages-manager` 建议：

- gateway / worker 镜像统一使用 `node:22-bookworm` build + `node:22-bookworm-slim` runtime；`job-runner` 镜像只在启用 K8s executor 时需要。
- frontend 如果是静态控制台，可以用 `nginx:1.27-alpine`；如果走 SSR，再单独评估。
- `job-runner` 需要浏览器能力时，单独做 Playwright image，不把浏览器依赖塞进普通 gateway。
- 镜像 mirror 策略可以参考 `xdclaw/scripts/mirror-images-acr-amd64.sh`，但 registry namespace 要用 pages-manager 自己的。

## Frontend 版本

如果 `pages-manager` 建 `apps/frontend`，可以参考 `xdclaw/frontend`：

| 包 | 建议版本 |
| --- | --- |
| `react` / `react-dom` | `^19.2.4`，lock resolved 到 `19.2.5` |
| `vite` | `^8.0.4`，lock resolved 到 `8.0.8` |
| `typescript` | `~6.0.2` / `6.0.3` |
| `@vitejs/plugin-react` | `^6.0.1` |
| `tailwindcss` | `^4.1.14`，lock resolved 到 `4.2.2` |
| `@tailwindcss/vite` | `^4.1.14`，lock resolved 到 `4.2.2` |
| `react-router-dom` | `^7.9.6`，lock resolved 到 `7.14.1` |
| `lucide-react` | `^1.14.0` |
| `recharts` | `^3.8.1` |
| `dompurify` | `^3.4.7` |
| `markdown-it` | `^14.2.0` |

`pages-manager` 控制台是运维和发布工具，视觉可以参考依赖栈，但不应照搬 `xdclaw` 的实例控制台业务界面。

## Cloudflare / Wrangler

`pages-manager` 当前已有：

```text
pnpm-workspace catalog:
  wrangler: 4.91.0
```

建议保留 `wrangler@4.91.0` 作为 Cloudflare deploy 底座版本。新增 gateway / worker 不应该直接持有 Cloudflare token；Cloudflare token 只进入受控 deployer job 或 deployment secret。

## pages-manager 当前差异

当前 `pages-manager` 已有：

```text
packageManager: pnpm@9.15.0
node: >=22.12.0
wrangler: 4.91.0
eslint: 9.39.4
prettier: 3.8.3
```

与 `xdclaw` 对齐时建议做这些变化：

1. root pnpm 从 `9.15.0` 升到 `10.33.x`。
2. Node 下限从 `>=22.12.0` 提到 `>=22.14.0`，Docker 统一 Node 22 bookworm。
3. 新增 `apps/gateway` 时采用 Fastify 5 + Drizzle + MySQL2 + Redis/BullMQ。
4. 启用 K8s executor 时，再新增 `@kubernetes/client-node@1.4.0`。
5. 保留现有 `wrangler@4.91.0` 给 Cloudflare deploy，不被 gateway 直接调用为用户入口。

## 不要对齐的内容

这些是 `xdclaw` 业务或 OpenClaw runtime 的依赖，不应成为 `pages-manager` MVP 的默认依赖：

- `OpenClawInstance` CRD / openclaw-operator。
- instance-manager sidecar。
- OpenClaw 主容器和 agent runtime 依赖。
- Feishu / Nova / Google Workspace 具体绑定逻辑。
- per-user long-running container 模型。

如果将来 pages-manager 的 coding agent job 需要具体 agent runtime，再单独为 `apps/job-runner` 定义 agent image，不从平台 gateway 依赖 OpenClaw runtime。

## MVP 版本锁定清单

MVP 开工前建议先在 `pages-manager` 固定这些版本：

```text
node: >=22.14.0
pnpm: 10.33.x
typescript: 6.0.3
tsx: 4.21.0
fastify: 5.8.5
zod: 4.3.6
drizzle-orm: 0.45.2
drizzle-kit: 0.31.10
mysql2: 3.22.1
redis server: 7.x
ioredis: 5.10.1
bullmq: 5.76.4
@kubernetes/client-node: 1.4.0 # only when K8s executor is enabled
wrangler: 4.91.0
react: 19.2.x
vite: 8.0.x
kubernetes dev baseline: 1.31 # only when K8s executor is enabled
production minimum: 1.28+ # only when K8s executor is enabled
```
