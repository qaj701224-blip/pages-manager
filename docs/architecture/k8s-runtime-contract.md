# K8s Runtime Contract

## 定位

这是 `pages-manager` 的运行态硬约束，不按 MVP 降级：

```text
Slack / Internal API / GitHub webhook
  ↓
K8s 中的 pages-gateway
  ↓
K8s 中的常驻 worker / agent / notifier
  ↓
一次性 executor
  ↓ callback / webhook
K8s 中的 pages-gateway
```

本地、测试服务器和生产环境都必须使用同一个控制面模型。区别只应该是 kube context、Ingress / tunnel、域名、Secret 和资源规格，不应该是“本地用脚本，服务器再改成 K8s”。

## 必须跑在 K8s 的部分

这些组件是平台运行时，必须常驻在 K8s 的 `pages-system` namespace，不能靠开发者本机进程代替：

| 组件 | 职责 |
| --- | --- |
| `pages-gateway` | Slack / GitHub / Internal API 入口、鉴权、幂等、状态机、审计、callback 接收 |
| `slack-agent` | 按 Slack 用户和 session 隔离的多轮需求理解、澄清、续接判断 |
| `pages-worker` | issue、workflow / job dispatch、preview gate、Cloudflare preview 调度 |
| `review-monitor-worker` | 消费 GitHub webhook 中的 review / comment / check 事件并归一化 |
| `slack-notifier` | 消费 `JobEvent`，用 Slack thread / Block Kit 回写状态 |
| DB / queue | `PublishingJob`、`SlackSession`、`IssueLink`、`ReviewAgentComment`、幂等和 lease 的真相源 |

当前实现可以暂时把 `review-monitor-worker` 和 `slack-notifier` 合在 `pages-gateway` 进程里，但它们仍属于 K8s 控制面，不能移到本机 `gh` 脚本或手动 watch。

## 一次性 executor 可以在哪

Coding / build / site-check / preview deploy 是一次性 executor。它们可以先跑在 GitHub Actions runner，也可以后续迁到 K8s Job：

```text
当前可接受:
pages-worker
  ↓ workflow_dispatch
GitHub Actions runner
  ↓ executor callback
pages-gateway

长期目标:
pages-worker
  ↓ create K8s Job
pages-jobs / page-job-<jobId>
  ↓ executor callback
pages-gateway
```

无论 executor 跑在哪，状态推进都必须回到 K8s 控制面：

- GitHub Actions 用 `/internal/executor-callback` 回报 `index_ready`、`pr_created`、`reviewing`、`preview_deployed`、`failed`。
- GitHub Review Agent、required checks、PR 更新和 issue comment 用 `/integrations/github/webhook` 进入 gateway。
- executor 不能直接发 Slack、不能直接改 DB 最终状态、不能直接判定 preview gate。

## 禁止依赖本机 gh watch

`gh` CLI 只允许作为开发者观察和排障工具，不能成为平台逻辑的一部分。

禁止：

- 用本机 `gh run watch` 决定 job 是否成功。
- 用本机 `gh pr view` / `gh api` 轮询 Review Agent comment，再手动推进 preview。
- 让 gateway、worker、K8s Job 或 GitHub Actions runtime 依赖某个开发者机器上的 `gh` 登录态。
- 在文档或验收里把“我本机 watch 到成功”描述为平台已跑通。

允许：

- 开发者手动用 `gh pr view` 看 PR 细节。
- 开发者用 `gh run view --log` 排查 Actions 日志。
- 用 `gh secret set` / `gh variable set` / `gh api` 修改仓库配置，但必须记录到 [github-runtime-config.md](./github-runtime-config.md)。

## 事件推进合同

平台状态只从这些入口推进：

| 事件 | 入口 | 状态来源 |
| --- | --- | --- |
| Slack 消息 | `POST /integrations/slack/events` | Slack signed HTTP request |
| Slack 按钮 / 交互 | `POST /integrations/slack/interactions` | Slack signed HTTP request |
| Internal API | `POST /api/publishing-jobs` 等 | gateway 鉴权后的 API request |
| Issue 创建 / 更新 | `POST /integrations/github/webhook` | GitHub signed `issues` webhook |
| PR / review / comment | `POST /integrations/github/webhook` | GitHub signed PR / review / comment webhook |
| required check | `POST /integrations/github/webhook` | GitHub signed `check_run` / `check_suite` webhook |
| executor 结果 | `POST /internal/executor-callback` | callback token / nonce 校验后的 payload |

如果 GitHub webhook 或 executor callback 丢失，正确做法是：

1. K8s 控制面把对应 `JobStageAttempt` 标记为 pending / timeout / retryable。
2. 由 `pages-worker` 或后续 `reconciler-worker` 在 K8s 内做受控补偿。
3. 补偿动作必须写 `AuditLog` 和 `JobEvent`。

不能用本机临时 watch 结果直接补状态。

## 本地验收标准

本地声称“完整跑通”时必须满足：

- `pages-gateway`、`pages-worker`、`slack-agent` 运行在本地 K8s cluster 的 `pages-system` namespace。
- Slack Events / Interactivity URL 指向当前 K8s gateway 的公网 tunnel / Ingress。
- GitHub webhook URL 指向同一个 K8s gateway。
- GitHub Actions callback URL 指向同一个 K8s gateway。
- `.env` 只作为 `k8s-local-up.sh` 生成 Secret / ConfigMap 的 bootstrap 输入；验证时以 K8s pod env、Secret、ConfigMap 和服务日志为准。
- `PublishingJob` 状态变化来自 gateway / worker 日志、K8s 持久化 store / DB、GitHub webhook delivery 和 executor callback。
- `gh` CLI 输出只能作为旁证，不作为状态机推进依据。

推荐验证入口：

```bash
pnpm k8s:validate
kubectl -n pages-system get pods
kubectl -n pages-system logs deploy/pages-gateway --tail=200
kubectl -n pages-system logs deploy/pages-worker --tail=200
kubectl -n pages-system logs deploy/slack-agent --tail=120
```

## 与 GitHub Actions 的边界

GitHub Actions runner 是执行器，不是控制面。

它可以：

- checkout repo。
- 调用 Coding Agent。
- 生成候选站点文件。
- 做 path allowlist、schema、secret scan、lint、test、build。
- 创建受控 branch / PR。
- 通过 callback 回报结果。

它不能：

- 监听 Slack。
- 监听 GitHub Review Agent comment。
- 轮询 PR 状态并直接推进 preview gate。
- 持有 Slack bot token。
- 持有 production deploy token。
- 绕过 gateway 状态机直接合并或发布 production。

如果后续把 coding / build / preview executor 迁到 K8s Job，上层事件合同不变，只替换 executor adapter。

