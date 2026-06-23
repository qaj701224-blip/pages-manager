# 文档索引与真相源矩阵

本文是 `pages-manager` 文档入口。新增文档前先判断是否已有领域内真相源；需要引用时链接到真相源，不复制长段内容。

## 真相源矩阵

| 领域 | 真相源 | 作用 | 维护规则 |
| --- | --- | --- | --- |
| 项目架构入口 | `README.md` | 说明 monorepo 架构、v2 主线和 v1 legacy 边界 | 保持短入口，不承载运行手册 |
| agent 协作规范 | `AGENTS.md` | Codex、Claude 和其它 coding agent 的项目规则 | `CLAUDE.md` 指向本文件，不维护第二份正文 |
| 文档索引 | `docs/README.md` | 文档地图和真相源矩阵 | 新增文档时更新本表或对应索引 |
| v2 架构 | `docs/pages-v2-wfp-architecture.md` | XD Cell v2 架构索引 | 正文按 `docs/architecture/`、`docs/operations/`、`docs/security/` 拆分 |
| v2 API 开发合约 | `apps/pages-api/src/openapi.js` | pages-api 开发、测试和受控内部集成合约 | 不公开 `/openapi.json`；用户入口是 CLI |
| 用户 / agent 操作 | `apps/pages-skill/skill/SKILL.md`、CLI help | `xd-cell` skill 发布、状态、访问控制和回滚流程 | 不手写部署 HTTP 请求，不复刻内部 API |
| Worker SDK / runtime helper | `apps/worker-sdk/README.md`、`apps/worker-sdk/docs/llms/*.md`、`apps/worker-sdk/BREAKING_CHANGES.md`、`docs/adr/0004-cli-sdk-skill-release-boundaries.md` | `@xd-cell/worker-sdk` 包定位、用法、AI 快照、公开 API 摘要和破坏性变更 | Worker SDK 行为变更时先更新包内 README、类型声明、测试和生成文档；skill 只引用依赖关系 |
| Worker SDK agent 接入 | `apps/pages-skill/skill/references/sdk.md` | agent 在用户项目中安装、读取和安全使用 `@xd-cell/worker-sdk` 的流程 | 不复制 SDK API 细节，不打包 Worker SDK 领域产物 |
| API 边界说明 | `docs/api-boundary.md` | 说明 CLI-managed API 边界和开发合约位置 | 不列不完整 endpoint 清单 |
| 分支与部署 | `docs/deployment-branch-policy.md` | master/staging/production 部署规则 | workflow 变更必须同步核对 |
| v2 运行与部署 | `docs/operations/` | 资源、部署、状态、一致性、上线和观测 | 单篇过长时拆子主题并从索引链接 |
| v2 数据与运行时模型 | `docs/architecture/` | 数据模型、发布、runtime、组件边界 | 避免混入临时手工待办 |
| Slack Agent policy skill | `docs/architecture/slack-agent-policy-skill.md` | Slack Agent 生产级 prompt package、tool contract、golden cases 和迁移计划 | 语义边界、intent、toolCall 或 prompt package 变更时同步 |
| v2 安全边界 | `docs/security/` | 路由、访问、认证、header/cookie 清洗 | 安全行为变更必须有测试或审计说明 |
| 架构决策记录 | `docs/adr/` | 长期设计决策和取舍，包括产物识别、auth 诊断、产物存储和 CLI/SDK/skill 分发边界 | ADR 过长时保留索引页，正文拆到同名目录 |
| 历史计划和规格 | `docs/superpowers/` | 设计/实施过程记录 | 可作为历史，不作为当前行为真相源 |
| v1 legacy | `apps/server/README.md`、`apps/server/docs/` | 旧 `workers.xd.team` 链路和 DNS 记录 | 只维护必要事实，不把新能力写回 v1 文档 |

## 长度规则

- 普通 Markdown 文档尽量控制在 700 行以内。
- 超过阈值时优先拆成主题文件，并让原路径变成索引。
- `docs/superpowers/` 是历史工作记录，可保留原始长度；不要把它当当前规范引用。
- 删除临时待办时同步清理 workflow、测试和文档索引引用。

## v2 架构阅读顺序

1. [XD Cell v2 架构索引](./pages-v2-wfp-architecture.md)
2. [资源与部署](./operations/resources-and-deployment.md)
3. [数据模型](./architecture/data-model.md)
4. [路由与访问边界](./security/routing-and-access.md)
5. [发布与运行时模型](./architecture/publishing-and-runtime.md)

## v1 文档边界

`workers.xd.team` 和 `apps/server` 属于 v1 legacy。根 README、agent 规范和 API 边界文档默认描述 v2；需要查看 v1 行为时，优先读 `apps/server/README.md`、`apps/server/src/**`、对应测试和 `apps/server/docs/`。
