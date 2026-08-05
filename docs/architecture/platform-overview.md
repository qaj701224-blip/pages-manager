# Platform Overview

## 定位

`pages-manager` 当前主线是 XD Cell v2 和 Slack 驱动的 Platform Dev Lane。旧 Site Publishing Lane 已冻结，v1 `apps/server` 进入墓碑模式。

阶段边界：

- `apps/server` 不再提供 `/deploy`、`/list`、`/site/:name` 或文档 API；除精确的 `GET/HEAD /health` 外统一返回 `410 LEGACY_API_RETIRED`。旧站点、Worker、route、DNS、Custom Domain、KV 和 metadata 继续保留。
- Slack / gateway / worker / slack-agent / slack-notifier / MySQL / Redis 这条新平台线尚未正式上线，不承担旧版本用户兼容。相关数据结构、内部 API、Slack 卡片和状态机可以优先按目标架构直接收敛，不需要为了临时测试版本保留 file store、MemoryGatewayStore、旧 Socket Mode、本地脚本或过渡字段。
- Slack 新平台线历史上包含 Site Publishing Lane 和 Platform Dev Lane。Site Publishing 的创建、续接、Review gate、callback、worker 直调和 workflow 已静态冻结；Platform Dev Lane 继续处理 `pages-manager` 自身 issue / PR。
- 自动生成的 `sites/**` 用户站点仍然必须被隔离，不能因为新平台未上线就放松路径、secret 或 workflow 权限边界。Platform Dev Lane 不使用 `sites/**` 白名单作为主约束，而是使用 issue 类型、风险、手动“自动开发”触发、CI、review 和 GitHub Rulesets 约束 repo 全目录改动。

Site Publishing 历史模型（仅用于理解保留数据，不再推进）：

```text
Employee
  -> SiteProject(s)
  -> PublishingJob
  -> GitHub issue / PR / Review gate
  -> Preview / Production deploy
```

不是一个员工一个网站。员工是归属主体，站点是发布主体；一个员工可以拥有多个 `sites/<employeeSlug>/<siteSlug>/`。

Platform Dev Lane 核心模型：

```text
Slack requester
  -> PlatformIssue
  -> issue type / label / risk / auto-dev trigger
  -> Coding Agent PR
  -> CI / review / merge
  -> Slack merge / close notification
```

## 当前分层

下面是 Slack 运行分层。Gateway 和 MySQL 继续保存 Site Publishing 历史状态，但不再创建或推进 PublishingJob；Platform Dev Lane 的独立状态机、确认卡、`platform-agent.yml`、手动“自动开发”触发、PR / CI / merge 回写保持运行。

```text
Slack / Browser / Internal API / GitHub webhook
  ↓
apps/gateway
  - Slack 签名校验
  - GitHub webhook 校验
  - Site Publishing Lane 的退休响应和历史只读状态
  - Platform Dev Lane 的 issue / PR 状态机
  - SlackSession / WorkItemLink / Review gate
  ↓
MySQL + Redis
  - MySQL 是最终状态真相源
  - Redis 只做 lease / queue / 短期 dedupe / rate limit
  ↓
apps/slack-agent / apps/worker / apps/slack-notifier
  - slack-agent 负责对话理解
  - worker 拒绝 Site Publishing start，只调度平台代码 PR
  - slack-notifier 负责 Slack Web API 输出
  ↓
GitHub Actions
  - project-index.yml（静态冻结）
  - pages-agent.yml（静态冻结）
  - platform-agent.yml
  - pr-site.yml（仅保留 sites/** pull_request 校验）
  - pages-preview.yml（静态冻结）
  ↓
Cloudflare Workers / assets
```

当前 ECS / 本地 / ACK 的服务拆分都应保持同一套长期形态：

```text
pages-gateway
pages-worker
slack-agent
slack-notifier
mysql
redis
```

## 核心职责

| 组件                  | 职责                                                                                                                                    | 不能做                                                            |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `apps/gateway`        | AI 控制面：HTTP 入口、验签、幂等、session、Site Publishing 退休与历史读取、Platform Dev issue/PR 状态机、webhook、callback、Review gate | 长时间编码、直接跑构建、保存 secret 明文、直接管理 WFP / 站点 ACL |
| `apps/slack-agent`    | 自由对话、需求整理、澄清、续接已有任务、输出结构化 intent                                                                               | 写代码、创建 PR、部署、读取 GitHub/Cloudflare token               |
| `apps/worker`         | job runner：拒绝 Site PublishingJob，创建 / 调度 Platform Dev issue 和平台代码 PR、回调 gateway                                         | 直接发 Slack、执行 Coding Agent、绕过 gateway 写状态              |
| `apps/slack-notifier` | `chat.postMessage`、`chat.update`、reaction、用户 profile 查询                                                                          | 创建 issue、调 Coding Agent、读取 GitHub/Cloudflare token         |
| GitHub Actions        | Platform Agent、平台 CI，以及已有 / 人工 `sites/**` PR 校验；Site Publishing workflow body dormant                                      | 常驻监听 Slack/GitHub、持有 Slack bot token、部署平台 Pod         |
| `apps/server`         | v1 健康检查和 `410 LEGACY_API_RETIRED` 墓碑响应                                                                                         | 执行部署、查询、删除或迁移旧站点                                  |

## 数据真相源

Gateway 运行态已经切到 MySQL-backed store：

- Drizzle schema：`apps/gateway/src/db/schema.js`
- MySQL store：`apps/gateway/src/db/gateway-store.js`
- Repository 拆分：`apps/gateway/src/db/repositories/`
- Row mapper：`apps/gateway/src/db/rows/`
- Migration：`apps/gateway/drizzle/migrations/`

文件 store、内存 store、SQLite、单 pod PVC 不再是运行时选项。测试里的 fixture 只服务单元测试。

## 与 xdclaw 的关系

`xdclaw` 只作为架构参考：

- gateway 是控制面，不执行长任务。
- worker 是自动化助手，不是 K8s worker node。
- MySQL 是持久元数据真相源。
- Redis 只做临时协调。
- K8s namespace、Secret、Deployment 必须和 xdclaw 隔离。

不能做：

- 不 import xdclaw 代码。
- 不复用 xdclaw 的业务 DB schema。
- 不部署到 `xdclaw-preview` / `xdclaw-system`。
- 不把 pages-manager 的 Secret 写入 xdclaw namespace。

## 当前保留边界

`apps/server` Worker、`api.workers.xd.team` Custom Domain、API route、`SITES` KV、旧站点 Worker、exact route、DNS、hostname claim 和存量站点访问能力继续保留。API Worker 只提供健康检查和统一退休响应，不再执行旧管理能力。

`apps/worker/src/jobs/preview.js`、`pages-preview.yml` 和旧 `/deploy` 调用代码作为历史实现保留，但生产入口已静态冻结，不迁移到 v2，也不再触发 preview。PublishingJob、Review、site-check、Slack session 和 GitHub delivery 等历史记录继续保留和读取。

Platform Dev Lane 不是站点发布能力。它用于把 Slack 中的开发需求、bug、反馈、CI/CD 问题和文档需求转成 `pages-manager` 仓库 issue / PR，并把 PR 状态回写 Slack。详细规则和企业级验收见 [platform-dev-lane.md](./platform-dev-lane.md)。

退休协议、资源边界和人工上线顺序见 [Legacy API 与 Site Publishing 退休手册](../operations/legacy-api-and-site-publishing-retirement.md)。
