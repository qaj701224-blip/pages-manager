# Platform Overview

## 目标定位

`pages-manager` 目标从“内部 Cloudflare Workers 站点托管服务”升级为“员工多站点自动发布平台”。

核心模型：

```text
User / Employee
  ↓
SiteOwnerScope
  ↓
SiteProject(s)
  ↓
PublishingJob
  ↓
Issue / PR / Review / Merge / Deploy
  ↓
Cloudflare resource pool
  ↓
Cloudflare Workers site
```

不是一个员工一个网站。员工是归属主体，站点是发布主体。一个员工可以创建、维护、部署多个 `SiteProject`，实际数量由 `SiteOwnerScope.max_sites`、并发配额和资源配额控制。

## 五层架构

```text
用户 / Slack / 浏览器
  ↓
pages-manager 控制台入口
  ↓
pages-gateway
  (MVP: K8s pages-system)
  ↓
slack-agent / pages-worker / review-monitor-worker / browser-worker
  (MVP: K8s pages-system)
  ↓
GitHub Actions runner (MVP) / K8s job executor (later)
  ↓
Cloudflare Workers 上的员工网站
```

职责一句话：

```text
pages-gateway 管谁能发布、发布什么、任务状态如何；
worker 管自动化流程如何推进；MVP 常驻控制面先跑在本地 K8s 的 `pages-system` namespace；
executor 管生成、构建、review、部署任务如何运行；MVP 用 GitHub Actions runner，后续再换 K8s Job；
Cloudflare resource pool 管员工网站最终如何访问；
Slack 是 MVP 默认用户入口和实时通知渠道，但所有动作仍必须先经过 gateway。
```

## 实现边界

`pages-manager` 是实现真相源：

- 新增应用放在 `pages-manager/apps/*`。
- 共享逻辑放在 `pages-manager/packages/*`。
- 员工站点源码放在 `pages-manager/sites/*`。
- 站点模板放在 `pages-manager/templates/*`。
- GitHub Actions workflow 放在 `pages-manager/.github/workflows/*`；后续 K8s manifest 放在 `pages-manager/k8s/*`。
- 数据库 schema、Slack/GitHub Enterprise/Cloudflare 集成都在 `pages-manager` 内实现。

仓库采用大仓 monorepo 方案。Issue、PR、review、merge 和 deploy 都在 `pages-manager` repo 内闭环，但必须通过路径规则区分站点内容 PR 和平台代码 PR。详细目录和 PR 边界见 [repository-structure.md](./repository-structure.md)。

`xdclaw` 只作为架构参考：

- 不 import `xdclaw` 代码。
- 不依赖 `xdclaw` gateway / worker / DB schema / CRD。
- 不部署到 `xdclaw` namespace / service / gateway。
- 具体参考点见 [xdclaw-reference.md](./xdclaw-reference.md)。

## 参考 xdclaw 的原则

- gateway 是控制平面，不执行长任务。
- worker 是自动化助手，不是 K8s node。
- executor 资源只承载运行时和调度信息，通过 workflow input、job label 或 callback 关联业务 ID；如果启用 K8s，K8s label 不表达业务规则。
- MySQL 保存持久元数据真相源；MVP 不同时兼容 Postgres。
- Redis 只承载会话、临时 flow、幂等索引和事件。
- gateway 必须从 DB 校验 owner，不接受前端或 worker 直接传来的身份结论。

## 当前保留能力

现有 `apps/server` 的 `/deploy`、`/list`、`/site/:name`、`/openapi.json`、`/skill.md` 可以作为底层发布能力继续保留。

平台化后，production deploy 不应继续依赖弱归属的 `X-Pages-Token`。`/deploy` 需要收口为 gateway 或受控 deploy workflow/job 调用，或者升级为强认证、绑定 `site_project_id` / `publishing_job_id` 并写审计。

Cloudflare 长期目标不是每站点一套 Cloudflare 资源，而是平台级资源池：少量 Edge Worker、少量 KV namespace、平台级 assets/R2 bucket，通过 `site_project_id`、`deploy_id`、hostname 和 key prefix 做逻辑隔离。详细设计见 [cloudflare-resource-pool.md](./cloudflare-resource-pool.md)。
