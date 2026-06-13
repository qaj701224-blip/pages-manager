# xdclaw Reference Points

## 结论

`xdclaw` 对 `pages-manager` 最有参考价值的是工程边界，不是业务对象。

可以参考：

- gateway / worker 分层。
- 本地 LocalWorkerClient 与生产 RemoteWorkerClient 的双模式。
- DB / Redis / Secret 的职责拆分。
- executor、namespace、label、callback、attempt、condition 的运行规则。
- 浏览器和外部入口永远先经过 gateway。
- Node、pnpm、MySQL、Redis、Docker base image 和本地 K8s cluster 等依赖版本基线；K8s client 只作为后续 executor adapter 参考，详见 [dependency-version-baseline.md](./dependency-version-baseline.md)。

不能照搬：

- `OpenClawInstance` CRD。
- 一人一实例的业务模型。
- 实例反代和 iframe 入口。
- instance-manager sidecar。
- 每个用户长驻容器的运行模型。

`pages-manager` 的核心对象是 `SiteProject` 和 `PublishingJob`。常驻控制面必须跑在 K8s 的 `pages-system` namespace；当前一次性发布任务可以跑在 GitHub Actions runner。后续如果启用 K8s Job executor，也只运行一次性的发布任务。最终网站跑在 Cloudflare resource pool。

## 1. Gateway / Worker 边界

`xdclaw` 的关键经验是：gateway 保持无状态、可水平扩容；有状态或耗时的自动化放到 worker。

映射到 `pages-manager`：

| xdclaw | pages-manager |
| --- | --- |
| gateway | `pages-gateway` |
| gateway-worker | `pages-worker` / `slack-agent` / `review-monitor-worker` / `browser-worker` |
| worker callback gateway | worker / executor callback `pages-gateway` |
| gateway 写 DB / K8s Secret / CR | gateway 写 DB / enqueue job / 触发 Actions workflow 或 K8s Job / 写 Cloudflare deploy 状态 |

规则：

- gateway 做鉴权、状态机、审计、资源调度。
- worker 做外部 API 调用、消息总结、review 编排、浏览器自动化。
- worker 不直接成为权限真相源。
- worker 的结果必须 callback gateway，由 gateway 校验后写入 DB。

## 2. Local / Remote 双模式

`xdclaw` 本地开发时可以用 `LocalWorkerClient`，生产用独立 worker 服务。`pages-manager` 可以借鉴“接口隔离”的代码组织方式，但完整链路验收必须使用 K8s worker；Local client 只能作为单元测试或开发调试替身。

建议：

```text
PagesWorkerClient
├─ LocalPagesWorkerClient
│    单元测试 / 调试替身，不能作为完整链路运行态
│
└─ RemotePagesWorkerClient
     生产通过 HTTP / queue dispatch 到 worker Deployment
```

好处：

- 单元测试可以不用先起完整 K8s worker，也不需要真实触发 GitHub Actions。
- 业务代码只依赖接口，不关心执行位置。
- 本地完整验收和生产使用同一套 K8s callback / attempt / state transition 逻辑。

## 3. DB / Redis / Secret 分层

`xdclaw` 的职责拆分可以直接参考：

| 层 | xdclaw | pages-manager |
| --- | --- | --- |
| DB | `user`、`tenant`、`instance`、`feishu_binding` | `User`、`Employee`、`SiteProject`、`PublishingJob`、`DeployRecord` |
| Redis / queue | session、device flow、event pubsub | Slack event 去重、job lease、临时状态、进度事件 |
| Secret | 实例运行凭据 | Slack/GitHub Enterprise/Cloudflare/job callback 等运行凭据；Actions-first 用 GitHub secret/environment，K8s executor 用 K8s Secret |
| runtime resource | OpenClawInstance / Pod / Service | Actions workflow run；后续 K8s Job / PVC / ConfigMap / Secret |

规则：

- DB 是平台真相源。
- Redis / queue 只保存易失状态、幂等索引、lease、事件。
- Secret 不进 DB 明文字段；DB 只保存 `secret_ref`。
- worker / executor 拿最小权限 secret。

## 4. Callback 和 Attempt

`xdclaw` 中 worker 完成后 callback gateway，由 gateway 校验归属并写状态。`pages-manager` 也应该这样做。

建议 callback 规则：

```text
worker / executor
  ↓
POST /internal/job-callback/<stage>
  ↓
pages-gateway 校验:
  - callback secret
  - job_id
  - attempt_id
  - stage_type
  - 当前 job 状态
  - site_project_id 归属
  ↓
gateway 写 JobStage / AuditLog
```

retry 必须新建 attempt。旧 attempt 的迟到 callback 只能写审计，不能覆盖当前状态。

## 5. Namespace 和 Label

`xdclaw` 是一实例一 namespace：

```text
namespace: instance-<instanceId>
```

先使用 `pages-system` namespace 跑常驻控制面。后续 K8s executor 不应该一网站一 namespace。它应该是一任务一 namespace，或共享 jobs namespace：

```text
namespace: page-job-<jobId>
```

或：

```text
namespace: pages-jobs
  Job job-<jobId>-coding-agent
  Job job-<jobId>-builder
  Job job-<jobId>-site-check
```

K8s label 只放业务 ID，不表达权限规则。Actions-first 中对应的是 workflow input、concurrency group 和 callback payload：

```text
pages.xd.com/job-id=<jobId>
pages.xd.com/site-project-id=<siteProjectId>
pages.xd.com/owner-scope-id=<ownerScopeId>
pages.xd.com/task-type=coding-agent|builder|site-check|controlled-committer|deployer
```

权限判断仍然回 DB。

## 6. 外部入口先过 Gateway

`xdclaw` 的实例访问原则是浏览器不直接打实例 Pod，永远先经过 gateway。

`pages-manager` 应对应为：

- 控制台管理请求先过 `pages-gateway`。
- Slack event / command 先过 `pages-gateway`。
- GitHub Enterprise webhook 先过 `pages-gateway`。
- GitHub Actions / K8s executor callback 先过 `pages-gateway`。
- 已发布网站内容走 Cloudflare Edge Worker，不进入 GitHub Actions runner 或 K8s job pod。

不要让 Slack bot、GitHub Enterprise webhook 或 executor 任务直接改 DB 最终状态、合并 PR 或生产部署。

## 7. 可以借鉴但要改造的点

### Redis event-bus

`xdclaw` 用 Redis Stream 做 chat event-bus。`pages-manager` 可以把这个思想用于发布进度和 Slack 回写：

```text
PublishingJob event
  → Redis Stream / queue
  → console SSE
  → slack-notifier
```

这样控制台和 Slack 都能看到同一套进度事件。

### Worker 并发限制

`xdclaw` 的 gateway-worker 对浏览器任务有限流。`pages-manager` 也需要：

- Slack 总结并发。
- 页面生成并发。
- browser screenshot 并发。
- GitHub Review Agent comment 处理并发。
- Cloudflare deploy 并发。

超限时应该排队或返回可重试状态，不应该无限触发 GitHub Actions workflow 或创建 K8s Job。

### Graceful shutdown

worker 收到 SIGTERM 后需要：

1. 停止接新任务。
2. 续租或释放 lease。
3. 等当前安全点完成。
4. callback gateway 标记可重试或失败。

## 8. 不应参考的点

以下不适合迁移：

- 不要把每个网站做成长驻 OpenClaw 实例。
- 不要给每个员工一个专属 bot。
- 不要让 K8s namespace 承载 employee 权限语义。
- 不要把 Cloudflare KV 当 DB 真相源。
- 不要把 `xdclaw` gateway 或 DB schema 作为运行时依赖。
