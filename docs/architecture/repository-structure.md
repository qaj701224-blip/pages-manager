# Repository Structure

`pages-manager` 当前采用大仓 monorepo：平台代码、Cloudflare 发布底座、Slack 控制面、GitHub Actions executor、员工站点源码、测试和 K8s manifest 都在同一个 repo 中。这样 issue、PR、review、preview 和审计能在一个 GitHub repo 内闭环；代价是必须严格隔离自动生成站点内容和平台代码。

## 当前目录

```text
pages-manager/
├── apps/
│   ├── server/            # 现有 Cloudflare 发布 API Worker
│   ├── kv-gateway/        # KV/runtime 相关 Worker
│   ├── xdads-302/         # 现有 302 Worker
│   ├── pages-sdk/         # 对外 pages SDK
│   ├── gateway/           # AI 发布控制面 HTTP 服务
│   ├── worker/            # 发布任务执行推进器
│   ├── slack-agent/       # 常驻 Slack Agent
│   └── slack-notifier/    # Slack Web API 输出服务
├── packages/
│   ├── git-client/        # GitHub API helper
│   ├── ip-guard/          # IP allowlist 逻辑
│   ├── pages-runtime-protocol/
│   ├── slack-intent-policy/
│   ├── slack-notifier/    # Block Kit / Slack API core
│   ├── worker-kit/        # HTTP / worker helper
│   └── workflow-core/     # PublishingJob 状态机、ID、事件 helper
├── sites/
│   └── <employeeSlug>/<siteSlug>/
├── k8s/
│   ├── base/pages-system/
│   ├── overlays/pages-manager-preview/
│   └── ci/
├── scripts/
├── tests/
│   ├── apps/
│   ├── helpers/
│   ├── packages/
│   ├── scripts/
│   └── workflows/
├── docs/
└── .github/workflows/
```

`tests/helpers/gateway-store-fixture.js` 是测试夹具，不是运行时 store。生产代码不能 import 测试 helper。

## Gateway 内部结构

```text
apps/gateway/src/
├── index.js                  # app factory 和路由注册
├── dev.js                    # Node dev server；只接受 MySQL runtime store
├── routes/
│   ├── register.js           # 统一注册 HTTP 路由
│   ├── health-routes.js
│   ├── publishing-routes.js
│   ├── slack-routes.js
│   ├── github-routes.js
│   └── internal-routes.js
├── control-plane/
│   ├── context.js            # store / required / internal callback token 等通用控制面上下文
│   ├── health-handlers.js    # health / ready
│   └── handlers.js           # Slack / GitHub / Review gate orchestration；后续继续向 domain service 收敛
├── publishing/
│   ├── api-handlers.js       # PublishingJob HTTP API
│   └── worker-dispatcher.js  # gateway -> worker start adapter
├── http/
│   ├── body.js
│   └── router.js
├── slack/
│   ├── agent-turn.js          # gateway -> slack-agent 调用、语义分块回复和 Agent 回复消息更新
│   ├── delivery.js            # Slack delivery、reaction、profile lookup 和通用输出 helper
│   ├── http.js               # Slack signature / raw body
│   ├── intake.js             # Slack event intake
│   ├── intents.js            # Slack Agent intent 常量
│   ├── issue-confirmation.js # issue 创建确认卡片和交互 payload
│   ├── job-input.js          # Slack -> PublishingJob 输入派生
│   ├── job-binding.js         # SlackSession 与 PublishingJob 绑定
│   ├── notifier.js           # gateway -> slack-notifier adapter
│   ├── session.js            # SlackSession / IssueLink / follow-up
│   ├── text.js
│   ├── work-item-reconciler.js # Slack 任务列表前的 GitHub 状态校准
│   └── work-items.js
├── github/
│   ├── review.js             # Review Agent allowlist / classification
│   └── webhook.js            # GitHub webhook normalization
├── db/
│   ├── schema.js             # Drizzle schema
│   ├── gateway-store.js      # MySQL-backed runtime store
│   ├── sql.js
│   ├── client.js
│   ├── config.js
│   ├── redis.js
│   ├── rows/
│   └── repositories/
└── utils/crypto.js
```

Gateway 运行态只使用 `MySqlGatewayStore`。`gateway-store.js` 里保留的 `Map` 是单进程缓存，用于减少同一请求链路内重复对象构造；MySQL 仍是最终事实来源。不要重新引入文件 store、内存 store、SQLite 或 PVC snapshot。

## Worker 内部结构

`apps/worker` 是发布任务执行推进器，不保存 Slack 会话真相，也不直接发 Slack。HTTP app 只暴露内部 job start endpoint，具体执行步骤按 job 拆分：

```text
apps/worker/src/
├── index.js
├── dev.js
├── config.js
├── orchestrator.js              # 根据 job.status 分发到具体 job step
├── jobs/
│   ├── issue-and-index.js       # 创建 / 复用 issue，dispatch project-index
│   ├── coding-agent.js          # dispatch pages-agent initial / fix
│   └── preview.js               # dispatch pages-preview 或 local_deploy preview
└── integrations/
    └── gateway-client.js        # executor callback -> gateway
```

后续接入 XD Pages / WFP 时，`pages-api-client.js` 应进入 `apps/worker/src/integrations/`，由 preview / publish job step 调用；不要让 `apps/gateway` 直接持有 WFP / Cloudflare 部署细节。

## 站点目录和 PR 边界

平台生成的网站 issue 和 PR 都放在 `xindong/pages-manager`。

自动站点 PR 只能修改一个目标目录：

```text
sites/<employeeSlug>/<siteSlug>/
```

站点 PR 禁止修改：

```text
.github/**
apps/**
packages/**
k8s/**
scripts/**
Dockerfile*
docs/** 中的平台部署文档
```

如果用户需求需要修改平台代码、workflow、模板、K8s 或部署逻辑，必须转成人工平台 PR。

分支、workflow lane、GitHub App、Review Agent、webhook 和本地 `gh` 边界统一见 [github-automation.md](./github-automation.md)。本文件只描述 repo 结构，不重复展开 GitHub 运行规则。

## PR 类型边界

| 改动类型            | 目录                                                                                     | 自动合并                                                 |
| ------------------- | ---------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 员工站点内容        | `sites/<employeeSlug>/<siteSlug>/`                                                       | 只允许在站点策略、CI、Review gate 全部通过后进入自动候选 |
| 平台控制面          | `apps/gateway`、`apps/worker`、`apps/slack-agent`、`apps/slack-notifier`                 | 禁止自动合并                                             |
| Cloudflare 发布底座 | `apps/server`、`apps/kv-gateway`、`packages/ip-guard`、`packages/pages-runtime-protocol` | 禁止自动合并                                             |
| SDK / 共享包        | `apps/pages-sdk`、`packages/**`                                                          | 禁止自动合并                                             |
| K8s / CI            | `k8s/**`、`.github/**`、`Dockerfile*`                                                    | 禁止自动合并                                             |
| 文档                | `docs/**`                                                                                | 涉及平台部署、权限、workflow 时必须人工 review           |

## CODEOWNERS / Rulesets

建议 CODEOWNERS 只覆盖平台、模板、基础设施，不把 `sites/**` 配成 required CODEOWNERS：

```text
/apps/                  @pages-platform-admins
/packages/              @pages-platform-admins
/k8s/                   @pages-infra-admins
/.github/               @pages-infra-admins
/templates/             @pages-platform-admins @pages-template-reviewers
```

`sites/**` 的动态权限由 gateway DB、`pages-site-policy` 和 required checks 判断。GitHub CODEOWNERS 不能表达每个员工名下多个站点的动态授权关系。

## 生成内容入库策略

允许进入 Git：

- `site.json`
- 站点源码
- 小型静态素材
- 文档和配置

不允许进入 Git：

- 构建产物 `dist/`
- 大文件素材
- 历史截图
- Review Agent 分析中间产物
- secret、token、cookie、私钥或可复原凭据
