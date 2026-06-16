# pages-manager Architecture

本目录记录 `pages-manager` 当前架构和长期边界。现在以代码为准，文档负责把运行态、目录、权限和配置讲清楚；如果实现与文档冲突，同一轮变更必须回写文档。

## 推荐阅读顺序

| 文档                                                               | 说明                                                                               |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| [platform-overview.md](./platform-overview.md)                     | 平台分层、当前运行形态、Cloudflare / Slack / GitHub 的边界                         |
| [end-to-end-flow.md](./end-to-end-flow.md)                         | Slack 到 issue、Coding Agent、PR、Review、Preview、Slack 回写的完整链路            |
| [repository-structure.md](./repository-structure.md)               | 当前 monorepo 目录、gateway 内部结构、站点 PR 和平台 PR 边界                       |
| [slack-platform-runtime.md](./slack-platform-runtime.md)           | Slack HTTP Events / Interactivity、常驻 Agent、对话流式、notifier、session 和状态卡 |
| [github-automation.md](./github-automation.md)                     | GitHub Enterprise、分支策略、Actions executor、webhook、Review Agent、runtime 配置 |
| [db-schema-v0.md](./db-schema-v0.md)                               | MySQL / Redis / Drizzle schema、repository 分层和迁移规则                          |
| [workers-and-k8s.md](./workers-and-k8s.md)                         | `pages-worker`、GitHub Actions executor、后续 K8s Job executor 的职责边界          |
| [site-lifecycle-and-naming.md](./site-lifecycle-and-naming.md)     | 一个员工多个站点时的 slug、目录、hostname 和生命周期规则                           |
| [site-check.md](./site-check.md)                                   | 站点 PR 的 deterministic check、路径隔离、schema、secret scan                      |
| [agent-policy-and-prompts.md](./agent-policy-and-prompts.md)       | Slack Agent / Coding Agent 的提示词、公司规则、secret 红线                         |
| [access-and-integrations.md](./access-and-integrations.md)         | Slack、GitHub、Cloudflare、站点访问和管理权限总览                                  |
| [cloudflare-resource-pool.md](./cloudflare-resource-pool.md)       | Cloudflare 统一资源池、preview / production 发布隔离                               |
| [dependency-version-baseline.md](./dependency-version-baseline.md) | Node、pnpm、MySQL、Redis、Docker、K8s 和前端版本基线                               |

## 当前代码事实

- 实现主体是 `pages-manager`，`xdclaw` 只作为架构参考。
- 除现有 Cloudflare 发布底座、KV SDK 和公开站点 API 外，Slack / gateway / agent / DB 这条 pages-manager 新平台线尚未正式上线；这部分可以按目标态直接调整，不需要兼容临时测试版本或旧的本地运行形态。
- 常驻服务是 `apps/gateway`、`apps/worker`、`apps/slack-agent`、`apps/slack-notifier`。
- Gateway 运行态只使用 MySQL-backed store；文件 store、内存 store、单 pod PVC 不是运行时选项。
- Redis 只承载 lease、queue、短期幂等和 rate limit，不是最终状态真相源。
- Coding Agent 当前跑在 GitHub Actions `pages-agent.yml`，不跑在 gateway / worker / Slack bot 里。
- Slack 正式入口是 HTTP Events / Interactivity，不使用 Socket Mode fallback。
- Slack token 只应进入 `slack-notifier`；gateway 持有 signing secret 和内部 shared secret，只有本地 fallback 可临时持有 bot token。
- 员工是归属主体，站点是发布主体，一个员工可以有多个 `sites/<employeeSlug>/<siteSlug>/`。
- 自动生成的站点 PR 只能修改目标 `sites/<employeeSlug>/<siteSlug>/`，任何 `.github/**`、`apps/**`、`packages/**`、`k8s/**`、`scripts/**`、Dockerfile 或部署文档改动都必须走人工平台 PR。

## 文档收敛规则

- GitHub 相关规则只写在 [github-automation.md](./github-automation.md)。
- Slack 运行、session、对话流式和状态卡只写在 [slack-platform-runtime.md](./slack-platform-runtime.md)。
- Cloudflare 和 KV 相关文档保留，不和 Slack / GitHub / DB 设计混写。
- `docs/superpowers/` 中同事保留的 KV SDK 设计 / 实施文档不作为当前架构真相源，但不能因本次 Slack / gateway 文档收敛被删除。
- 历史计划、临时测试、阶段性设计 review 不再保留为架构真相源。
