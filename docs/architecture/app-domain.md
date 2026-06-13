# App Domain

## 范围

App 域负责用户可见入口、平台元数据、权限判断和状态机推进。

目标组件：

| 组件 | 职责 |
| --- | --- |
| frontend | 控制台、站点列表、任务状态、授权管理、人工批准 |
| pages-gateway | 登录鉴权、Slack/GitHub Enterprise webhook、PublishingJob、状态机、executor 调度、权限校验 |
| project-indexer | 为 coding agent 准备 repo / site / template / review 上下文；MVP 可以是 Actions workflow 或 `apps/indexer` |
| database | User、Employee、SiteOwnerScope、SiteProject、PublishingJob 等持久元数据 |
| Redis / queue | 会话、临时 flow、事件、幂等索引、任务调度信号 |

## 控制台职责

frontend 只做用户交互，不直接执行 git、build、review、merge、deploy。

控制台允许用户：

- 查看自己有管理权限的网站列表。
- 创建、修改、删除、回滚站点。
- 查看 Slack 触发的发布任务。
- 查看 issue、PR、review、merge、deploy 状态。
- 管理站点访问策略。
- 管理站点管理成员授权。

## Gateway 职责

`pages-gateway` 是控制平面：

- 用户登录和鉴权。
- Slack webhook / event / slash command 入口。
- GitHub Enterprise webhook 入口。
- 创建和查询 `PublishingJob`。
- 保存平台元数据。
- 校验用户是否能管理某个 `SiteProject`。
- 创建 issue / PR / review / deploy 的调度请求。
- 选择并固定本次 `PublishingJob` 使用的 `ProjectIndexSnapshot`。
- 触发 GitHub Actions workflow 或调用 K8s 创建任务容器。
- 接收 worker 和 executor callback。
- 推进状态机。
- 管理站点归属、访问策略、管理授权和部署记录。

红线：

```text
gateway 不直接在主进程里生成网页、跑浏览器、clone repo、跑 build、跑 review 或执行长任务。
```

## 核心数据模型

```text
User
  └─ Employee
       └─ SiteOwnerScope(kind=personal)
            ├─ SiteProject(site_slug=profile)
            ├─ SiteProject(site_slug=q2-report)
            └─ SiteProject(site_slug=demo-portal)
```

未来 team scope：

```text
User
  └─ TeamMembership
       └─ SiteOwnerScope(kind=team)
            ├─ SiteProject(site_slug=team-dashboard)
            └─ SiteProject(site_slug=campaign-site)
```

关键表：

| 表 | 说明 |
| --- | --- |
| `User` | 登录用户真相源，参考 `xdclaw.user` |
| `Employee` | 员工归属主体，不是部署对象 |
| `ExternalIdentityBinding` | Slack/GitHub Enterprise 身份到内部用户的绑定 |
| `ServiceAccount` | CI / 内部系统 / 平台集成的 API 调用主体 |
| `ApiToken` | Personal token / service token 的 hash、scope 和授权范围 |
| `SiteOwnerScope` | 站点归属域，参考 `xdclaw.tenant` |
| `SiteProject` | 单个网站项目，一个员工可拥有多个 |
| `SiteAccessPolicy` | 站点内容访问策略 |
| `SiteAdminGrant` | 站点管理授权 |
| `PublishingJob` | 一次发布请求 |
| `JobStage` | 发布阶段状态，参考 `xdclaw.instance_condition` |
| `JobStageAttempt` | 阶段执行尝试，用于 retry 和 callback 幂等 |
| `AgentRun` | coding agent 初次编码和按 Review Agent comment 修复的执行记录 |
| `ProjectIndexSnapshot` | agent 使用的项目索引快照 |
| `ProjectIndexItem` | 索引快照里的文件、模板、站点和 review 上下文条目 |
| `SlackEvent` | Slack event / command 幂等记录，防止重复创建任务 |
| `SlackMessageBatch` | Slack thread 原文和摘要 |
| `TrustedSlackBotPolicy` | 允许特定 Slack bot 作为证据来源或 service account 发起者的策略 |
| `IntegrationBinding` | Slack、GitHub Enterprise、Cloudflare 等集成绑定 |
| `GitHubWebhookDelivery` | GitHub Enterprise webhook 投递幂等记录 |
| `ReviewRun` | PR review 运行和结论 |
| `ReviewAgentComment` | GitHub Review Agent comment 归一化记录 |
| `DeployRecord` | preview / production 部署记录 |

## 权限模型

站点访问权限和管理权限必须分离：

```text
站点访问面
  访问已发布网站内容
  可按站点配置为公司内网、指定人群或公开访问
  不等于拥有管理权限

管理控制面
  创建、修改、删除、回滚、查看发布任务、触发部署
  只允许站点 owner、管理员或显式授权成员访问
```

管理权限来自：

- `SiteAdminGrant`
- owner scope
- platform admin role

API 调用还必须先从 session / token 解析出 `User` 或 `ServiceAccount`。请求里的 employee/site slug 只能表示目标资源，不能作为身份结论。

网站内容访问来自：

- `SiteAccessPolicy(mode=public | company | allowlist)`
