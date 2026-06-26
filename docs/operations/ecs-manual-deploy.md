# ECS Manual Deploy

本文说明 `pages-manager` ECS runtime 的手动部署边界。这里的 ECS runtime 指
Docker Compose 上的四个长期服务：

- `pages-gateway`
- `pages-worker`
- `slack-agent`
- `slack-notifier`

这条链路只部署 ECS runtime，不部署 Cloudflare Workers、ACK、用户站点或
个人站点 preview。

## 触发规则

`Deploy ECS Production` workflow 只允许手动 `workflow_dispatch` 运行。
它不会在 `push`、`pull_request` 或 PR 合并后自动部署。
真实部署 job 绑定 GitHub `production` environment，沿用生产环境审批和审计。

手动运行默认是 dry run。只有在 `master` 上显式传 `deploy=true`，并且命中
路径或 `forceDeploy=true` 时，才会真实部署。未命中时 workflow 只写
summary 并跳过部署。因为部署不是由每次 merge 自动触发，正式发布建议传
`forceDeploy=true`；路径判断主要用于 dry run 或显式提供 `baseSha` / `headSha`
时的变更确认。

测试期如需从非 `master` 分支部署，必须显式传 `allowNonMasterDeploy=true`。
该开关只服务手动测试，不代表允许 push / PR 自动部署，也不改变正式发布应从
`master` 手动触发的规则。

命中路径包括：

```text
apps/gateway/**
apps/worker/**
apps/slack-agent/**
apps/slack-notifier/**
packages/worker-kit/**
packages/workflow-core/**
packages/git-client/**
packages/slack-notifier/**
docker-compose.ecs.yml
Dockerfile.node-service
deploy/ecs/**
scripts/deploy-ecs.sh
package.json
pnpm-lock.yaml
pnpm-workspace.yaml
```

## Runner 模型

部署 job 必须运行在 ECS 内部的 GitHub self-hosted runner：

```yaml
runs-on: [self-hosted, linux, x64, pages-manager-ecs]
```

不要让 GitHub-hosted runner SSH 到 ECS。GitHub-hosted runner 只负责手动
运行时的路径判断和 summary；真实部署在 ECS 本机执行。

安装 runner 时建议：

1. 在 ECS 上创建专用系统用户，例如 `github-runner`。
2. 在仓库设置中注册 repository-level self-hosted runner。
3. 给 runner 添加 label：`pages-manager-ecs`、`ecs-deploy`、`linux`、`x64`。
4. 用 `svc.sh install` / `svc.sh start` 安装成 systemd 服务。
5. 确认 runner 用户可执行 `docker` 和 `docker compose`。
6. 确认 runner 用户可以读写 `/opt/pages-manager/.env.ecs`，并可以写入
   `/opt/pages-manager` 和 `/opt/pages-manager-build`。部署脚本会写
   candidate env、env backup、`docker-compose.ecs.yml`、`deploy/ecs/Caddyfile`
   和 release 目录；推荐用专用部署组授权：目录 group 设为部署组并开启 group
   write，`.env.ecs` owner 保持 `root`、group 设为部署组、权限为 `660`，并把
   runner 用户加入该组。既有 `docker-compose.ecs.yml`、`Dockerfile.node-service`
   和 `deploy/ecs/Caddyfile` 也需要对部署组可写。
7. Alibaba Cloud Linux 4 可能缺少 GitHub runner 依赖的 `libicu`，安装 runner
   前需要确认系统已安装对应包。
8. 不在 runner 用户下保存 GitHub 写权限 token；checkout 使用 workflow
   默认的只读 `GITHUB_TOKEN`。

这个 runner 只用于 `Deploy ECS Production`，不要让 PR workflow 或 fork 代码运行在该
runner 上。

## Runtime 配置

运行时配置继续保存在 ECS 本机：

```text
/opt/pages-manager/.env.ecs
```

不要把 `.env.ecs` 的运行时 secret 复制到 GitHub secrets。GitHub workflow
只需要少量非敏感变量：

```text
ECS_REMOTE_DIR=/opt/pages-manager
ECS_REMOTE_BUILD_DIR=/opt/pages-manager-build
ECS_ENV_FILE_REMOTE=/opt/pages-manager/.env.ecs
ECS_DOCKER_PLATFORM=linux/amd64
ECS_SMOKE_TIMEOUT_SECONDS=120
ECS_IMAGE_RETENTION=5
ECS_BUILD_DIR_RETENTION=5
ECS_RUNTIME_BACKUP_RETENTION=0
```

`ECS_IMAGE_REGISTRY` 可以不配置；未配置时部署脚本沿用 ECS `.env.ecs` 里的
`PAGES_IMAGE_REGISTRY`，避免 GitHub vars 覆盖当前生产 registry。只有需要迁移
registry 时才显式设置 `ECS_IMAGE_REGISTRY`。

以下值应继续只保存在 ECS `.env.ecs`：

```text
MYSQL_ROOT_PASSWORD
MYSQL_PASSWORD
INTERNAL_CALLBACK_TOKEN
PAGES_GATEWAY_API_TOKEN
PAGES_WORKER_SHARED_SECRET
SLACK_AGENT_SHARED_SECRET
SLACK_NOTIFIER_SHARED_SECRET
SLACK_BOT_TOKEN
SLACK_SIGNING_SECRET
GITHUB_APP_INSTALLATION_TOKEN
GITHUB_WEBHOOK_SECRET
SLACK_AGENT_API_KEY
AGENT_CODE_API_KEY
PAGES_PREVIEW_TOKEN
```

## 部署行为

workflow 调用：

```bash
ECS_DEPLOY_MODE=local bash scripts/deploy-ecs.sh
```

脚本会：

1. 把当前 checkout 打包到 ECS build 目录。
2. 为四个 app service 构建不可变 tag。
3. 部署前清理旧 runtime backup 目录；默认 `ECS_RUNTIME_BACKUP_RETENTION=0`
   表示不保留历史 backup，只保留本轮失败回滚所需的临时备份。
4. 备份当前 runtime env、compose、Caddyfile 和 Dockerfile。
5. 写 candidate env，只修改 `PAGES_IMAGE_REGISTRY` 和 `PAGES_IMAGE_TAG`；如果
   未配置 `ECS_IMAGE_REGISTRY`，则沿用 `.env.ecs` 原值。
6. `docker compose up` 目标服务。
7. 等待目标服务 health；只有部署 gateway 时额外检查 Caddy `/ready`。
8. smoke 通过后再写回 `/opt/pages-manager/.env.ecs`。
9. 构建、镜像检查、compose 或 smoke 任一阶段失败时，回滚 runtime 文件、env
   和服务；成功或回滚完成后清理包含 `.env.ecs` 副本的临时备份目录。

默认 `ECS_SERVICES=all`。测试阶段可以传 `services=gateway`、`services=worker`、
`services=slack-agent` 或 `services=slack-notifier` 做单服务部署；smoke 只校验
本次目标服务，避免非目标服务短暂异常误阻塞部署。

## 测试路径

开发 workflow 或部署前建议先手动 dry run：

```text
workflow_dispatch
deploy=false
baseSha=<base>
headSha=<head>
```

确认 summary 中：

- 文档或 `sites/**` 变更：`Deploy: false`
- `apps/gateway/**` 变更：`ECS paths changed: true`
- `scripts/deploy-ecs.sh` 变更：`ECS paths changed: true`

runner 安装完成后，在 `master` 上手动运行：

```text
deploy=true
forceDeploy=true
services=all
```

测试阶段可以先用 `services=gateway` 做单服务验证。生产发布前仍由维护者人工
确认再触发，不依赖 `push master` 自动部署。

新 workflow 首次需要先合入默认分支后才会出现在 GitHub Actions 页面。合入后，
如果要从测试分支部署，需要在手动运行时选择对应分支 ref，并同时传：

```text
deploy=true
forceDeploy=true
allowNonMasterDeploy=true
services=gateway
```

## 接入 Todo

正式测试前需要完成：

1. 在 GitHub repository variables 配置非敏感 ECS 变量：
   `ECS_REMOTE_DIR`、`ECS_REMOTE_BUILD_DIR`、`ECS_ENV_FILE_REMOTE`、
   `ECS_DOCKER_PLATFORM`、`ECS_SMOKE_TIMEOUT_SECONDS`。`ECS_IMAGE_REGISTRY`
   只有迁移 registry 时才需要配置。
2. 在 ECS 上安装 GitHub self-hosted runner，并确保 label 包含
   `pages-manager-ecs`。
3. 在 ECS 上完成 preflight：确认 `.env.ecs` 存在、Docker / Docker Compose
   可用、runner 用户可以读写 `.env.ecs`、`/opt/pages-manager` 和
   `/opt/pages-manager-build`，并检查磁盘空间。
4. 先手动 dry run，再手动部署单服务 `services=gateway`。
5. 单服务验证通过后，再手动部署 `services=all`。

测试期从非 `master` 分支部署时，必须显式设置 `allowNonMasterDeploy=true`。
该开关只能用于手动触发，不能引入 `push` 或 `pull_request` 自动部署；测试
结束后应收回到 `master` 手动部署。

## 潜在阻塞点

- GitHub runner 未注册、未授权到本仓库，或缺少 `pages-manager-ecs` label，
  deploy job 会一直 queued。
- ECS runner 机器不能访问 GitHub，或 runner service 没有常驻运行，GitHub
  无法派发 job。
- runner 用户没有 Docker 权限，`docker info` 或 `docker compose` 会失败。
- `/opt/pages-manager/.env.ecs` 缺失、不可读写，runner 不能写
  `/opt/pages-manager` / `/opt/pages-manager-build`，或不能覆盖 runtime compose /
  Caddy / Dockerfile 文件，preflight 会失败；不要把这些路径改成
  world-readable，应用专用部署组授权。
- GitHub runner 运行依赖缺失时，`config.sh` 会失败；Alibaba Cloud Linux 4
  至少需要确认 `libicu` 已安装。
- ECS 磁盘不足或 Docker build cache 过大，构建阶段可能失败或影响现有服务。
- ECS CPU / 内存较小，构建期间可能让现有服务变慢；真正替换服务发生在
  `docker compose up` 阶段。
- `docker compose up` 或 smoke 失败会触发回滚，但仍可能产生短暂服务抖动。
- 新增 workflow 只有在首次合入 GitHub 默认分支后才会出现在 Actions 页面；
  后续可以在手动运行时选择分支 ref，并用 `allowNonMasterDeploy=true` 做测试。
- 非 `master` 部署必须显式传 `allowNonMasterDeploy=true`；忘记设置时，
  workflow 会只写 summary 并跳过真实部署。
