# Deployment Branch Policy

## 目标

`pages-manager` 同时承载平台本体部署和用户站点发布执行器。平台代码以 `master` 为合入主线，`staging` 是共享 preview 分支，用来提前部署和验证指向 `master` 的项目类 PR：

```text
feature branch
  -> PR to master
  -> sync PR head to staging preview
  -> staging preview / validation
  -> merge PR to master
  -> manual production deploy
```

`master` 是生产真相源。`staging` 不是晋级来源，允许暂时包含尚未合入 `master` 的 PR 代码；生产部署只允许人工触发 `Deploy Production`。

## 分支规则

- 默认所有 feature、fix、docs、ci、build 分支 PR 到 `master`。
- `staging` 只作为 preview 分支，不从 `staging` 向 `master` 发起晋级 PR。
- 项目类 PR 指向 `master` 后，`Sync Master PR To Staging` workflow 必须在 PR ready 后把 PR head 提前 merge 到 `staging`，用于 staging preview / validation。
- 纯 `sites/**` 用户站点 PR 不触发 master PR -> staging 同步；用户站点 PR 继续走 `site-check` 门禁。
- `staging` 可以领先或不同于 `master`，这种差异代表当前 preview 状态，不代表可晋级主线。
- 如果 `staging` 被已关闭或废弃 PR 污染，由维护者在确认没有活跃 preview 后把 `staging` 重新对齐 `master`，再重新触发需要验证的 PR。

## Master PR 同步 Staging 预览

`Sync Master PR To Staging` 对齐 xdclaw `sync-mr-to-preview` 的语义：在项目类 PR 指向 `master` 时，把该 PR 的 head 提前 merge 到 `staging`，让 staging 尽早跑预览部署和验证。

触发条件：

```text
pull_request.opened / synchronize / reopened / ready_for_review
base: master
```

执行规则：

- Draft PR 跳过，等 `ready_for_review` 后再同步。
- 跨仓库 PR 跳过，避免在 fork PR 上使用写权限。
- 如果 PR 的 head branch 是 `sites/*`，跳过。
- 如果 PR 只修改 `sites/**`，跳过。
- 如果 PR 修改了平台路径，例如 `.github/**`、`apps/**`、`packages/**`、`k8s/**`、`scripts/**` 或 Dockerfile，则从 `origin/staging` 创建临时工作分支。
- workflow 使用全量历史 fetch PR head，并确认 fetch 到的 commit 与 PR head sha 一致。
- 在临时工作分支上 merge PR head；冲突时 workflow 失败，作者需要先 rebase / merge `staging` 后再重试。
- merge 成功后 push 到 `staging`。
- 由于 GitHub `GITHUB_TOKEN` 产生的 push 不会自动触发后续 push workflow，同步 workflow 必须显式 dispatch `Deploy Staging`。
- 同步 workflow 必须等待 `Deploy Staging` 完成并继承其结果；这样 master PR 上能直接看到 staging preview / validation 是否通过。

约束：

- workflow 不读取 Cloudflare、Aliyun、ACR、ACK 或用户发布执行器 secret。
- workflow 只使用 GitHub `GITHUB_TOKEN`，不引入额外 bot token。
- workflow 必须串行执行，避免多个 master PR 同时改写 `staging`。
- 如果 PR head 无法干净 merge 到 `staging`，workflow 必须失败，转人工处理冲突。
- 如果 `staging` branch protection 不允许 GitHub Actions push，workflow 会失败；需要在仓库分支规则中允许该 workflow 的 `GITHUB_TOKEN` 写入，或改为创建 `staging` PR 的模式。
- 如果仓库规则不允许 `GITHUB_TOKEN` dispatch workflow，`Deploy Staging` 不会被触发；需要允许 Actions workflow dispatch，或改用 GitHub App token。

## Staging Preview 整理流程

当 `staging` 包含废弃 PR、验证失败 PR 或其它不再需要的 preview commit 时，按这个顺序收敛：

1. 确认没有正在验证的 master PR 需要当前 `staging` 状态。
2. 由维护者把 `staging` 重新对齐到 `master`。
3. 对仍需验证的 PR 重新运行 `Sync Master PR To Staging`。
4. `staging` 验证通过后，只能作为该 master PR 的检查信号，不能反向晋级到 `master`。
5. PR 合入 `master` 后，只允许人工触发 production deploy。

不要从 `staging` 反向 cherry-pick 或开 PR 到 `master`。这样会把 preview 分支里的其它未合入 PR 一起带进主线。

## CI/CD Lane 隔离

平台本体 CI/CD 和用户站点发布执行器必须隔离。

平台本体部署 workflow：

```text
.github/workflows/deploy-staging.yml
.github/workflows/deploy.yml
.github/workflows/deploy-ack-preview.yml
```

职责：

- 部署 `apps/server`、`apps/kv-gateway` Cloudflare Worker。
- 构建并发布 ACK 平台镜像。
- 滚动平台 Pod，例如 `gateway`、`worker`、`slack-agent`、`slack-notifier`。

允许使用：

```text
CLOUDFLARE_API_TOKEN
CF_API_TOKEN
ALIYUN_ACCESS_KEY_ID
ALIYUN_ACCESS_KEY_SECRET
ACR_INSTANCE_ID
KUBE_CONFIG_B64
```

用户站点发布执行器 workflow：

```text
.github/workflows/project-index.yml
.github/workflows/pages-agent.yml
.github/workflows/pages-preview.yml
.github/workflows/site-check.yml
```

职责：

- 处理一次 `PublishingJob`。
- 生成或修复 `sites/<employee>/<site>/`。
- 创建 / 更新受控 PR。
- 运行站点 PR 门禁。
- 发布 preview 或回调 gateway。

禁止使用：

```text
ALIYUN_ACCESS_KEY_ID
ALIYUN_ACCESS_KEY_SECRET
ACR_INSTANCE_ID
KUBE_CONFIG_B64
kubectl
docker build / docker push for platform images
production Wrangler token
ACK namespace write permission
```

## 用户生成 PR 规则

自动生成的站点 PR 只能修改一个目录：

```text
sites/<employeeSlug>/<siteSlug>/**
```

不得修改：

```text
.github/**
apps/**
packages/**
k8s/**
scripts/**
Dockerfile*
docs/deployment-branch-policy.md
AGENTS.md
CLAUDE.md
```

如果用户生成 PR 需要修改平台代码、workflow、K8s 或部署文档，必须转成人工平台 PR，不能走用户站点发布执行器。

## GitHub 配置规则

- ACK preview 部署 secret 只放在 GitHub environment `ack-preview`。
- Cloudflare staging secret 只放在 `staging` environment。
- Cloudflare production secret 只放在 `production` environment。
- 用户站点发布执行器只能读取 repo secret / variable 中的 callback、GitHub App、Coding Agent、preview marker 配置。
- `production` environment 应配置人工审批；production workflow 只保留 `workflow_dispatch`。

## 验证要求

分支同步或 CI/CD 改动合入前，至少运行：

```bash
pnpm lint
pnpm test
```

涉及 ACK preview 时，还应运行：

```bash
node --test scripts/workflows.test.js scripts/k8s-overlays.test.js scripts/acr-write-docker-config.test.js
kubectl apply -k k8s/overlays/pages-manager-preview --dry-run=server
```

如果当前分支还没有 ACK overlay，则只运行存在的测试和 Cloudflare Worker 部署相关验证。
