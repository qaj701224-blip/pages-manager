# Dependency Version Baseline

## 定位

本文记录 `pages-manager` 当前依赖基线，以及参考 `xdclaw` 时哪些可以对齐、哪些不能照搬。版本以当前仓库代码为准。

## 当前仓库基线

根目录：

```text
Node.js: >=22.12.0
pnpm: >=9.15.0
packageManager: pnpm@9.15.0
type: module
eslint: ^9.0.0
prettier: ^3.0.0
```

当前根命令：

```text
pnpm lint
pnpm test
pnpm db:generate
pnpm db:migrate
pnpm db:setup
pnpm db:reset
pnpm k8s:*
```

## 当前 app / package 依赖

| 组件                      | 关键依赖                                                                                                                                             |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/gateway`            | `drizzle-orm@^0.45.2`、`drizzle-kit@^0.31.10`、`mysql2@^3.22.1`、`ioredis@^5.10.1`、`bullmq@^5.76.4`、`@xd/workflow-core`、`@xd/slack-notifier-core` |
| `apps/worker`             | `@xd/git-client`、`@xd/worker-kit`                                                                                                                   |
| `apps/slack-agent`        | `@xd/worker-kit`                                                                                                                                     |
| `apps/slack-notifier`     | `@xd/slack-notifier-core`、`@xd/worker-kit`                                                                                                          |
| `apps/server`             | `wrangler`、`@xd/ip-guard`、`@xd/pages-sdk`、`@xd/worker-kit`                                                                                        |
| `apps/pages-sdk`          | `typescript@^5.8.0`                                                                                                                                  |
| `packages/git-client`     | 原生 `fetch` / ESM helper                                                                                                                            |
| `packages/slack-notifier` | Slack Web API / Block Kit helper，无 Slack SDK runtime 依赖                                                                                          |

当前 gateway 没有引入 Fastify；HTTP 路由由 `apps/gateway/src/http/router.js` 的轻量 router 承载。后续如果重构到 Fastify，需要另开 PR 评估，不应在文档里把 Fastify 写成当前事实。

## DB / Redis

当前 DB 运行态：

```text
MySQL 8.x
drizzle-orm/mysql2
mysql2/promise
```

当前 Redis 运行态：

```text
Redis 7.x
ioredis
bullmq
```

MySQL 是最终状态真相源，Redis 只做 lease、queue、短期 dedupe 和 rate limit。

运行态配置优先使用：

```text
MYSQL_ADDR
MYSQL_USER
MYSQL_PASSWORD
MYSQL_DATABASE
REDIS_URL
```

代码仍可解析 `DATABASE_URL`，但 K8s / ECS 主约定是拆分 MySQL 配置。

## Docker / K8s

当前通用 Node 服务镜像：

```text
Dockerfile.node-service
```

长期服务：

```text
pages-gateway
pages-worker
slack-agent
slack-notifier
```

K8s manifest 当前在：

```text
k8s/base/pages-system
k8s/overlays/pages-manager-preview
k8s/ci
```

ACK preview overlay 使用 `pages-manager-preview` namespace，不得部署到 `xdclaw-preview` 或修改 xdclaw 资源。

## Cloudflare / Wrangler

当前 Cloudflare 发布底座继续使用仓库已有 Wrangler catalog：

```text
wrangler: 4.91.0
```

Cloudflare token 只进入受控 deployer / Worker secret，不进入 Slack Agent、Coding Agent、site-check 或用户生成页面。

## 参考 xdclaw 的部分

可以参考：

- MySQL + Drizzle + migration journal 的管理方式。
- Redis 只做短期协调，不做真相源。
- Node 22 镜像基线。
- K8s namespace / Secret / Deployment 分层。
- ACR 镜像路径和 ACK overlay 的隔离习惯。

不能照搬：

- OpenClawInstance CRD。
- openclaw-operator。
- instance-manager sidecar。
- OpenClaw 主容器和 agent runtime。
- Feishu / Nova / Google Workspace 业务绑定。
- 每用户一台长驻容器的实例模型。

## 后续可评估升级

这些不是当前代码事实，只是后续可评估项：

- pnpm 从 `9.15.0` 升到 10.x。
- Node 下限提升到更高的 Node 22 LTS patch。
- 如果 admin UI 重新进入主线，再选择 React / Vite / Tailwind 栈。
- 如果启用 K8s Job executor，再引入 `@kubernetes/client-node` 和 job-runner 镜像。
- 如果 Slack API 调用复杂化，再考虑引入 `@slack/web-api`；当前仍使用 fetch + 自有 helper。
