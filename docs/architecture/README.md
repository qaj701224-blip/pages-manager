# pages-manager Architecture

> 本目录参考 `xdclaw/docs/architecture/` 的组织方式，用来记录 `pages-manager` 平台化后的架构快照和长期边界。
>
> 当前这些文档描述的是目标架构。代码尚未全部落地时，以文档中的“目标 / MVP / 非目标”标注区分当前能力和未来能力。

## 文档地图

| 文档 | 说明 |
| --- | --- |
| [platform-overview.md](./platform-overview.md) | 总体分层、实现边界、核心原则 |
| [repository-structure.md](./repository-structure.md) | 大仓 monorepo 目录、Issue/PR 归属、自动合并边界 |
| [mvp-scope.md](./mvp-scope.md) | MVP 分步范围、必须保留的边界和可简化项 |
| [first-priority-preview-loop.md](./first-priority-preview-loop.md) | 当前第一优先级：Slack 到需求整理、issue、Agent 自运行、Agent Review、Preview 自动闭环和 Slack 回通 |
| [end-to-end-flow.md](./end-to-end-flow.md) | Slack / API 到 issue、PR、review、deploy、回写的完整流程 |
| [slack-to-pr-review-agent-flow.md](./slack-to-pr-review-agent-flow.md) | MVP 主线：Slack 发消息、创建 issue、agent 编码、自动 PR、实时监听 GitHub Review Agent comments、按 comment 修复 |
| [k8s-runtime-contract.md](./k8s-runtime-contract.md) | 非 MVP 降级的运行态硬约束：Slack/GitHub/Review 监控必须进入 K8s 控制面，`gh` CLI 只作排障 |
| [github-actions-first-runtime.md](./github-actions-first-runtime.md) | 前期不使用 K8s Job executor 时，基于 GitHub Actions runner 跑 coding agent、build、preview；控制面仍在 K8s |
| [local-k8s-control-plane.md](./local-k8s-control-plane.md) | 本地 K8s 控制面运行模型：常驻服务跑 `pages-system`，一次性 executor 可继续跑 GitHub Actions |
| [project-indexing.md](./project-indexing.md) | 项目索引能力：MVP 放在 pages-manager 大仓内做独立组件，后续可拆独立 repo / 服务 |
| [app-domain.md](./app-domain.md) | frontend / pages-gateway / 数据模型 / 权限控制 |
| [db-schema-v0.md](./db-schema-v0.md) | MVP 数据库 schema v0：字段、索引、唯一约束、迁移顺序 |
| [api-entry.md](./api-entry.md) | 高级用户 API、内部 API、鉴权和权限边界 |
| [workers-and-k8s.md](./workers-and-k8s.md) | pages-worker、GitHub Actions-first executor、后续 K8s Job / namespace 边界 |
| [actions-workflow-contract.md](./actions-workflow-contract.md) | GitHub Actions-first workflow 的输入、输出、callback、secret 和失败码合同 |
| [github-runtime-config.md](./github-runtime-config.md) | GitHub Actions secrets、repository variables、webhook 的当前 runtime 配置和变更记录规则 |
| [site-check.md](./site-check.md) | 员工站点自动 PR 的 deterministic required check、路径隔离、schema、secret scan、Preview Gate 合同 |
| [github-review-agent-contract.md](./github-review-agent-contract.md) | Greptile / GitHub Review Agent comment allowlist、归一化、分类、幂等和 fix trigger |
| [legacy-deploy-wrapper.md](./legacy-deploy-wrapper.md) | 现有 `/deploy` 如何收口为受控 deploy workflow/job，并写 DeployRecord / AuditLog |
| [site-lifecycle-and-naming.md](./site-lifecycle-and-naming.md) | 员工多站点的 slug、hostname、repo path、生命周期和冲突处理 |
| [dependency-version-baseline.md](./dependency-version-baseline.md) | 对齐 xdclaw 的 Node、pnpm、MySQL、Redis、Docker、K8s 本地控制面和前端工具链版本基线；K8s JS client 仅后续 executor adapter 需要 |
| [cloudflare-resource-pool.md](./cloudflare-resource-pool.md) | Cloudflare 平台级资源池、KV/R2/Edge Worker、多站点隔离 |
| [access-and-integrations.md](./access-and-integrations.md) | Cloudflare、Slack bot、GitHub Enterprise、站点访问与管理权限 |
| [slack-runtime.md](./slack-runtime.md) | Slack bot 运行位置、事件入口、secret、幂等和回写 |
| [slack-agent-session.md](./slack-agent-session.md) | 常驻 Slack Agent 的 session / memory / issue 续接、preview 不满意后的 fix round |
| [agent-policy-and-prompts.md](./agent-policy-and-prompts.md) | 公司规则、issue 规范、secret 权限和 Slack Agent / Coding Agent prompt 分层 |
| [slack-socket-mode-local-test.md](./slack-socket-mode-local-test.md) | 已归档的 Slack Socket Mode 本地验证记录；当前运行方案不使用 Socket fallback |
| [github-enterprise.md](./github-enterprise.md) | GitHub Enterprise 组织/团队仓库、GitHub App、Rulesets、Actions 和 webhook |
| [github-cli-local-dev.md](./github-cli-local-dev.md) | 本地 gh CLI 冒烟测试：issue、workflow、PR、Review comment 查询；不作为生产身份 |
| [xdclaw-reference.md](./xdclaw-reference.md) | 从 xdclaw 参考哪些边界、哪些不能照搬 |
| [design-review.md](./design-review.md) | 方案 review 结论、已确认边界和仍需确认风险 |

## 与设计 / 计划文档的关系

- `docs/architecture/`：架构快照和长期边界，供实现、review、排障时快速查阅。
- `docs/superpowers/specs/2026-06-11-employee-pages-platform-design.md`：完整设计稿，保留更细的背景、数据模型和阶段说明。
- `docs/superpowers/plans/2026-06-11-employee-pages-platform.md`：实施任务拆分和阶段计划。

当实现推进后，architecture 文档应像 `xdclaw` 一样逐步从“目标架构”更新为“当前实现快照”。如果代码和文档冲突，以代码为准，并在同一任务中回写文档。

## 总原则

- `pages-manager` 是实现主体，`xdclaw` 只作为架构参考。
- 不在 `xdclaw` 中新增 pages 业务代码。
- 不依赖 `xdclaw` 的 gateway、worker、DB schema 或 K8s CRD。
- 员工是归属主体，站点是发布主体，一个员工可以拥有多个站点。
- Cloudflare 由平台统一管理，员工不申请 Cloudflare 账号或 token。
- 站点访问权限和管理权限分离。
- Slack bot 全平台统一一个。
- 平台运行态必须跑在 K8s 控制面；本机 `gh` CLI、`gh watch`、临时 Node listener 只能用于排障，不能推进状态机。
