# Repository Structure

## 决策

`pages-manager` 采用大仓 monorepo 方案。

这个 repo 同时承载：

- 底层 Cloudflare 发布能力
- 员工多站点平台控制面
- Slack / Git / review / workflow worker
- GitHub Actions-first executor workflow，以及后续 K8s job container 代码和 manifest
- 员工网站源码
- 网站模板、coding agent 输出合同和校验器

这样做的好处是 issue、PR、review、merge、deploy 都可以在一个 repo 内闭环；坏处是必须严格用目录边界和自动化规则隔离平台代码与自动生成的网站内容。

## 目标目录

```text
pages-manager/
├── apps/
│   ├── deploy-api/          # 现有 Cloudflare 发布 API；apps/server 可先作为过渡名
│   ├── gateway/             # 平台控制面：鉴权、权限、PublishingJob、webhook、executor 调度
│   ├── slack-connector/     # Slack Socket Mode 长驻接入；转交 gateway，不直接做发布
│   ├── frontend/            # 管理控制台
│   ├── indexer/             # 项目索引组件；MVP 放在大仓内，后续可拆独立服务
│   ├── worker/              # workflow / slack / review 调度 worker
│   └── job-runner/          # 后续 K8s Job 容器入口；Actions-first MVP 可先不实现
├── packages/
│   ├── deploy-core/         # Cloudflare 发布逻辑
│   ├── workflow-core/       # 状态机、JobStage、Attempt、错误码
│   ├── page-kit/            # site.json schema、模板渲染、校验器
│   ├── project-index/       # repo manifest、模板索引、agent context bundle
│   ├── git-client/          # GitHub Enterprise issue、PR、review、merge API
│   ├── slack-client/        # Slack event、message、reply helper
│   ├── access-control/      # SiteAccessPolicy / SiteAdminGrant 判断
│   ├── ip-guard/            # 现有 IP allowlist 逻辑
│   └── worker-kit/          # 现有 Worker helper
├── sites/
│   └── <employee-slug>/
│       └── <site-slug>/
│           ├── site.json
│           ├── src/
│           ├── public/
│           └── assets/
├── templates/
│   ├── personal-basic/
│   ├── personal-portfolio/
│   ├── report-page/
│   └── landing-page/
├── k8s/
│   ├── base/
│   │   └── pages-system/    # MVP 本地/服务器常驻控制面 manifests
│   └── jobs/                # 后续启用 K8s Job executor 时使用
├── docs/
│   ├── architecture/
│   └── superpowers/
├── scripts/
├── tests/                   # 所有单元测试和脚本测试，镜像 apps/packages/scripts 结构
└── .github/
    ├── workflows/
    ├── CODEOWNERS
    └── pull_request_template.md
```

## Issue / PR 放在哪里

所有平台生成的网站 issue 和 PR 都放在 GitHub Enterprise 上的 `pages-manager` repo。员工站点生成 PR 只允许修改 `sites/<employee>/<site>/`，平台、模板、K8s 和 Actions 变更仍然走同一个 repo 但必须人工 review。

前期不使用 K8s Job executor 时，自动开发、索引和构建由 `.github/workflows/project-index.yml`、`pages-agent.yml`、`site-check.yml`、`pages-preview.yml` 承担。`pages-production-deploy.yml` 和 `apps/job-runner` 是后续增强；`k8s/` 先用于本地 `pages-system` 控制面 manifests，`pages-jobs` 后置。

Slack 不用临时本地脚本。MVP 的长期接入进程放在 `apps/slack-connector`，通过 Socket Mode 监听统一 Slack bot，并调用 `apps/gateway` 的 `/integrations/slack/events`。后续如果改成 Slack HTTP Events，仍然复用同一个 gateway endpoint 和状态机。

项目索引能力不需要先拆独立 repo。MVP 先在 `pages-manager` 内实现 `apps/indexer` / `packages/project-index`，保持 issue、PR、Review Agent comment、Preview deploy 和审计在同一个 repo 内闭环。后续如果索引服务要服务多个业务 repo 或多个平台，再拆独立 repo / 独立服务。

单元测试不和主代码混放。约定使用顶层 `tests/`：

```text
tests/
├── apps/
├── packages/
└── scripts/
```

`src/` 目录只放运行时代码。

按改动类型分流：

| 改动类型 | 目录 | Issue / PR 归属 | 自动合并 |
| --- | --- | --- | --- |
| 员工站点内容 | `sites/<employee>/<site>/` | `pages-manager` | 第一阶段只自动 Preview；production trusted-auto 后续 |
| 站点模板 | `templates/*` | `pages-manager` | 不默认自动合并 |
| 平台控制面 | `apps/gateway`, `apps/frontend` | `pages-manager` | 禁止自动合并 |
| worker / executor | `apps/worker`, `.github/workflows/pages-agent.yml`, `apps/job-runner` | `pages-manager` | 禁止自动合并 |
| 发布底座 | `apps/deploy-api`, `packages/deploy-core` | `pages-manager` | 禁止自动合并 |
| K8s / CI | `k8s/*`, `.github/*` | `pages-manager` | 禁止自动合并 |

核心判断：

```text
自动生成网站内容的 PR 只能改 sites/<employee-slug>/<site-slug>/。
任何改到 apps/、packages/、k8s/、.github/、templates/ 的 PR 都必须人工 review。
```

## Branch 命名

站点内容 PR：

```text
sites/job-<jobId>-<employee-slug>-<site-slug>
```

平台代码 PR：

```text
platform/<short-topic>
```

发布底座 PR：

```text
deploy/<short-topic>
```

模板 PR：

```text
template/<template-name>-<short-topic>
```

## PR 标签

建议由 gateway 或 CI 自动打标签：

| 标签 | 条件 |
| --- | --- |
| `site-change` | 只修改 `sites/<employee>/<site>/` |
| `template-change` | 修改 `templates/*` |
| `platform-change` | 修改 `apps/gateway`、`apps/frontend`、`packages/workflow-core` 等 |
| `deploy-change` | 修改 `apps/deploy-api`、`packages/deploy-core` |
| `infra-change` | 修改 `k8s/*`、`.github/*` |
| `auto-merge-candidate` | 满足 site-only、CI、review、权限等自动合并前置条件 |

## CODEOWNERS

建议规则使用 GitHub Enterprise organization/team：

```text
/apps/                  @pages-platform-admins
/packages/              @pages-platform-admins
/k8s/                   @pages-infra-admins
/.github/               @pages-infra-admins
/templates/             @pages-platform-admins @pages-template-reviewers
```

`sites/**` 不建议放进 required CODEOWNERS。原因是 GitHub CODEOWNERS 不能动态展开 `<employee>`，也不能表达 `SiteAdminGrant` 里的站点自定义授权；如果把 `/sites/` 配成 required CODEOWNERS，未来 `trusted-auto` 会被人工 review 要求卡住。

站点目录的动态权限应由 `pages-site-policy` required check 和 gateway DB 权限判断完成：

```text
pages-site-policy
  - PR 只改一个 sites/<employee>/<site>/
  - PR 绑定 PublishingJob
  - PR 绑定 SiteProject
  - requested_by 有 SiteAdminGrant / owner scope / admin 权限
```

GitHub Enterprise 组织 / 团队、GitHub App、Rulesets 和 Actions environment 的细节见 [github-enterprise.md](./github-enterprise.md)。

## Branch Protection / Rulesets

GitHub Enterprise 必须保护默认分支和发布分支：

```text
main / master
staging
production
```

规则：

- 禁止直接 push 到受保护分支。
- 合并必须通过 PR。
- 必须通过 required checks。
- `.github/**`、`k8s/**`、`apps/**`、`packages/**`、`templates/**` 必须执行 CODEOWNERS review，且不能自动合并。
- `sites/**` 不依赖 required CODEOWNERS，必须通过 `pages-site-policy` required check。
- `sites/**` 的 site-only PR 只有在 gateway 权限校验、path allowlist、CI、review 全部通过后，才可进入 `trusted-auto` 候选。

## CI 分层

CI 需要按路径分流：

| 路径 | CI |
| --- | --- |
| `sites/**` | site schema 校验、模板构建、链接检查、截图检查、内容安全检查 |
| `templates/**` | 模板测试、示例站点构建、截图回归 |
| `apps/**` / `packages/**` | lint、unit test、typecheck、integration tests |
| `k8s/**` | manifest lint、dry-run、policy check |
| `.github/**` | workflow lint、安全检查、禁止 production push 自动部署 |

## GitHub Actions 权限和 Secret 暴露

大仓里最危险的是站点内容 PR 触发了带高权限 secret 的平台 workflow。

规则：

- `site-change` workflow 只能使用只读 token 或低权限 job token。
- `site-change` workflow 不能读取 Cloudflare token、auto-merge token、Slack bot token、production deploy secret。
- `site-change` workflow 不能触发 production deploy。
- `site-change` workflow 只运行站点 schema、构建、链接、截图和内容安全检查。
- `site-change` workflow 禁止使用带生产 secret 的 `pull_request_target` 执行 PR 代码。
- `platform-change`、`deploy-change`、`infra-change` 才允许进入需要平台 secret 的 workflow，但必须人工 review。
- `.github/**` 改动必须由平台管理员人工 review，禁止自动合并。
- production deploy workflow 必须只接受受控 gateway/deployer job 或人工审批触发，不能被普通 push/PR 自动触发。

建议把 CI 拆成：

| Workflow | 触发路径 | Secret 等级 |
| --- | --- | --- |
| `site-check` | `sites/**` | 无敏感 secret |
| `template-check` | `templates/**` | 无生产 secret |
| `platform-check` | `apps/**`, `packages/**` | 测试 secret 或 mock secret |
| `infra-check` | `k8s/**`, `.github/**` | 无生产 secret，dry-run only |
| `deploy-production` | gateway/deployer job 或人工审批 | Cloudflare deploy secret |

## 自动合并边界

`trusted-auto` 只允许用于 site-only PR：

```text
必须只修改 sites/<employee-slug>/<site-slug>/
必须绑定 PublishingJob
必须绑定 SiteProject
必须由 gateway 校验 requested_by 有管理权限
必须 CI 通过
必须 pages-site-policy 通过
必须没有 open blocking / unknown ReviewAgentComment
必须没有人工 reviewer 打回
必须没有触碰 apps/、packages/、templates/、k8s/、.github/
```

任何平台代码、模板、部署底座或基础设施改动都不能自动合并。MVP 默认 `manual-required`；`trusted-auto` 是后续能力，开启前必须确认 GitHub Rulesets 没有对 `sites/**` 配置 required CODEOWNERS。

## 生成内容入库策略

为了避免大仓膨胀，Git 只保存站点源码和轻量素材：

允许进入 Git：

- `site.json`
- 源码文件
- 小型静态素材
- 文档和配置

不允许进入 Git：

- 构建产物 `dist/`
- 大文件素材
- 历史截图
- Review Agent comment 分析中间产物
- 部署包
- node_modules / cache

这些内容应进入 artifact store、R2 或 CI artifact：

```text
R2 / artifact store
  ├─ deploy files
  ├─ large assets
  ├─ screenshots
  ├─ visual diff reports
  └─ generated logs
```

`page-kit` 和 CI 需要检查文件大小、文件类型和禁止目录。超限素材应上传到平台资产存储，再在 `site.json` 或源码中引用。

## 与现有 apps/server 的关系

当前 `apps/server` 是现有 Cloudflare Worker 管理 API。

迁移可以分两步：

1. 保持 `apps/server` 作为兼容路径，新增平台 app。
2. 当边界稳定后，将 `apps/server` 重命名或拆分为 `apps/deploy-api`，并把可复用逻辑下沉到 `packages/deploy-core`。
