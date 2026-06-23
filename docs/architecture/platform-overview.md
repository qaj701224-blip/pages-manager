# Platform Overview

## 定位

`pages-manager` 当前从“内部 Cloudflare Workers 站点发布服务”扩展为“Slack 驱动的研发与发布协作平台”。

阶段边界：

- `apps/server`、KV SDK、Cloudflare staging / production 发布底座属于已有能力，改动时要保守处理公开 API、token 归属、staging / production 隔离和现有站点行为。
- Slack / gateway / worker / slack-agent / slack-notifier / MySQL / Redis 这条新平台线尚未正式上线，不承担旧版本用户兼容。相关数据结构、内部 API、Slack 卡片和状态机可以优先按目标架构直接收敛，不需要为了临时测试版本保留 file store、MemoryGatewayStore、旧 Socket Mode、本地脚本或过渡字段。
- Slack 新平台线分为两条 lane：Site Publishing Lane 处理员工个人站点；Platform Dev Lane 处理 `pages-manager` 自身 issue / PR。两条 lane 可以复用 gateway、agent、worker、notifier 和 webhook 基建，但权限边界、issue 模板、PR 改动范围和验收标准必须显式区分。
- 自动生成的 `sites/**` 用户站点仍然必须被隔离，不能因为新平台未上线就放松路径、secret 或 workflow 权限边界。Platform Dev Lane 不使用 `sites/**` 白名单作为主约束，而是使用 issue 类型、风险 gate、CI、review 和 GitHub Rulesets 约束 repo 全目录改动。

核心模型：

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
  -> issue type / label / risk gate
  -> Coding Agent PR
  -> CI / review / merge
  -> Slack merge / close notification
```

## 当前分层

下面是 Slack 新平台线的运行分层。当前代码具备 gateway、worker、slack-agent、slack-notifier、MySQL-backed store、Site Publishing Lane，以及 Platform Dev Lane 的独立状态机、确认卡、`platform-agent.yml`、风险 gate、PR / CI / merge 回写。

```text
Slack / Browser / Internal API / GitHub webhook
  ↓
apps/gateway
  - Slack 签名校验
  - GitHub webhook 校验
  - Site Publishing Lane 的 PublishingJob 状态机
  - Platform Dev Lane 的 issue / PR 状态机
  - SlackSession / WorkItemLink / Review gate
  ↓
MySQL + Redis
  - MySQL 是最终状态真相源
  - Redis 只做 lease / queue / 短期 dedupe / rate limit
  ↓
apps/slack-agent / apps/worker / apps/slack-notifier
  - slack-agent 负责对话理解
  - worker 作为 job runner 推进 GitHub issue / workflow / preview 或平台代码 PR
  - slack-notifier 负责 Slack Web API 输出
  ↓
GitHub Actions
  - project-index.yml
  - pages-agent.yml
  - platform-agent.yml
  - site-check.yml
  - pages-preview.yml 兼容路径
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

| 组件                  | 职责                                                                       | 不能做                                                    |
| --------------------- | -------------------------------------------------------------------------- | --------------------------------------------------------- |
| `apps/gateway`        | AI 控制面：HTTP 入口、验签、幂等、session、Site Publishing job 状态机、Platform Dev issue/PR 状态机、webhook、callback、Review gate | 长时间编码、直接跑构建、保存 secret 明文、直接管理 WFP / 站点 ACL |
| `apps/slack-agent`    | 自由对话、需求整理、澄清、续接已有任务、输出结构化 intent                  | 写代码、创建 PR、部署、读取 GitHub/Cloudflare token       |
| `apps/worker`         | job runner：创建 / 复用 issue、dispatch workflow、触发 preview、调度平台代码 PR、回调 gateway | 直接发 Slack、执行 Coding Agent、绕过 gateway 写状态      |
| `apps/slack-notifier` | `chat.postMessage`、`chat.update`、reaction、用户 profile 查询             | 创建 issue、调 Coding Agent、读取 GitHub/Cloudflare token |
| GitHub Actions        | Coding Agent、站点校验、PR 创建 / 更新、site-check                         | 常驻监听 Slack/GitHub、持有 Slack bot token、部署平台 Pod |
| `apps/server`         | 现有 Cloudflare `/deploy`、`/list` 等发布能力                              | 作为 Slack / GitHub 控制面真相源                          |

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

## 当前保留能力

`apps/server` 的 `/deploy`、`/list`、`/site/:name`、`/openapi.json`、`/skill.md` 继续作为底层 Cloudflare 发布能力。

当前 preview 路径可以由 `pages-worker` 以 `local_deploy` 模式调用 staging `/deploy`，避免 GitHub-hosted runner 动态出口 IP 进入 Cloudflare 白名单。长期 production deploy 仍应由受控 gateway / worker / deploy workflow 从已记录的 commit 或 PR 状态触发。

Platform Dev Lane 不是站点发布能力。它用于把 Slack 中的开发需求、bug、反馈、CI/CD 问题和文档需求转成 `pages-manager` 仓库 issue / PR，并把 PR 状态回写 Slack。详细规则和企业级验收见 [platform-dev-lane.md](./platform-dev-lane.md)。
