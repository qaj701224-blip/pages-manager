# Workers And Runtime Executors

## Worker 定位

worker 是自动化助手，不是 K8s worker node，也不是最终运行员工网站的容器。

当前实际常驻服务：

```text
pages-gateway
pages-worker
slack-agent
slack-notifier
```

其中：

- `pages-worker` 推进 issue、workflow dispatch、preview deploy。
- `slack-agent` 负责 Slack 多轮对话和需求理解。
- `slack-notifier` 负责 Slack Web API 输出。
- Review gate 当前合在 `pages-gateway` 的 GitHub webhook 处理里。

未来可以拆出 `review-monitor-worker`、browser / screenshot worker 或 K8s Job executor，但它们不是当前代码事实。

## Executor 跑在哪

当前一次性 executor 跑在 GitHub Actions：

```text
project-index.yml
pages-agent.yml
site-check.yml
pages-preview.yml
```

Platform Dev Lane 使用独立 executor：

```text
platform-agent.yml
```

Coding Agent 不跑在 gateway、worker、Slack bot、GitHub Review Agent 或员工最终网站里。Site Publishing Lane 跑在 `.github/workflows/pages-agent.yml` 的 GitHub Actions runner 中；Platform Dev Lane 使用独立 `.github/workflows/platform-agent.yml`。

后续如果要更强隔离，可以把 executor adapter 换成 K8s Job，但上层状态机不变。

## Coding Agent 边界

Site Publishing Coding Agent 能做：

- 读取 issue、Slack 摘要、site context。
- 读取目标站点目录。
- 调公司模型网关。
- 生成或修改 `sites/<employeeSlug>/<siteSlug>/` 文件。
- 把执行结果 callback gateway。

Site Publishing Coding Agent 不能做：

- 直接发 Slack。
- 读取 Slack bot token。
- 读取 Cloudflare production token。
- 修改 `.github/**`、`apps/**`、`packages/**`、`k8s/**`、`scripts/**`。
- 直接 production deploy。

当前 `pages-agent.yml` 会在创建 / 更新 PR 前执行 allowed path 校验。PR 创建后仍必须跑 `site-check.yml`。

Platform Dev Coding Agent 能修改 `pages-manager` repo 全目录内与 issue 直接相关的文件，但必须通过 `lane:platform-dev` issue、risk gate、CI 和 review 约束。`.github/**`、`k8s/**`、Dockerfile、部署脚本、secret、production deploy 相关改动默认 high risk，不能绕过人工 gate。

## Code 更新和编译跑在哪

当前 Actions executor 形态：

```text
pages-agent.yml
  -> 运行 Coding Agent
  -> 生成站点文件
  -> allowed path / secret / build 校验
  -> 创建或更新受控 PR
  -> callback gateway pr_created

platform-agent.yml
  -> 运行 Platform Dev Coding Agent
  -> 修改 pages-manager repo 相关文件
  -> risk / secret / CI policy 校验
  -> 创建或更新受控 PR
  -> callback gateway pr_created

site-check.yml
  -> PR required check
  -> GitHub check_run webhook 回到 gateway

pages-worker
  -> Review gate 通过后触发 preview
  -> 当前 ECS 路径可用 local_deploy 调 Cloudflare staging /deploy
```

最终网站不跑在 GitHub Actions 或 K8s，最终网站跑在 Cloudflare Workers / assets。

## K8s 目标形态

K8s 控制面目标 namespace：

```text
namespace: pages-system
  ├─ pages-gateway
  ├─ pages-worker
  ├─ slack-agent
  ├─ slack-notifier
  ├─ mysql
  ├─ redis
  └─ platform secrets
```

ACK preview overlay 使用：

```text
namespace: pages-manager-preview
```

不要部署到 `xdclaw-preview`、`xdclaw-system` 或任何 `instance-*` namespace。

## 后续 K8s Job Executor

如果后续迁移一次性任务到 K8s，建议先使用共享 job namespace：

```text
namespace: pages-jobs
  ├─ Job job-<jobId>-coding-agent
  ├─ Job job-<jobId>-builder
  ├─ Job job-<jobId>-site-check
  ├─ Job job-<jobId>-controlled-committer
  └─ Job job-<jobId>-deployer
```

更强隔离时再考虑一任务一 namespace：

```text
namespace: page-job-<jobId>
```

这只是执行层替换，不改变：

- Slack event 进入 gateway。
- GitHub webhook 进入 gateway。
- executor callback 进入 gateway。
- MySQL 是状态真相源。
- Slack 回写由 slack-notifier 做。

## Secret 边界

| 组件 / 任务       | 允许的凭据                                                            | 禁止的凭据                                                    |
| ----------------- | --------------------------------------------------------------------- | ------------------------------------------------------------- |
| `pages-gateway`   | Slack signing secret、GitHub webhook secret、callback token、DB/Redis | Slack bot token（正式路径）、Cloudflare production token      |
| `pages-worker`    | GitHub platform token、callback token、preview deploy token、DB/Redis | Slack bot token                                               |
| `slack-agent`     | Slack Agent model API key                                             | GitHub write token、Cloudflare token、Slack bot token         |
| `slack-notifier`  | Slack bot token                                                       | GitHub write token、Cloudflare token                          |
| `pages-agent.yml` | Coding Agent API key、受控 GitHub token、callback token               | Slack bot token、ACR/ACK/kubectl、production Cloudflare token |
| `site-check.yml`  | 无敏感 secret                                                         | Slack bot token、Cloudflare token、GitHub App private key     |

## Retry 和回调

状态推进只接受：

- `/internal/executor-callback`
- `/integrations/github/webhook`
- `/integrations/slack/events`
- `/integrations/slack/interactions`

旧 workflow run、旧 attempt 或重复 webhook 只能幂等处理，不能覆盖新状态。
