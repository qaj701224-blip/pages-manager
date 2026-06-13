# Project Indexing

## 结论

需要项目索引能力，但 MVP 不建议为了索引单独新建一个 Git repo。

推荐做法：

```text
pages-manager monorepo
  ├─ apps/indexer
  ├─ packages/project-index
  ├─ .github/workflows/project-index.yml
  └─ DB / artifact store 中保存索引快照
```

也就是说，`project-indexer` 是独立组件，不是独立业务仓库。它可以独立部署、独立跑 workflow、独立重建索引，但 issue、PR、Review Agent comment、Preview deploy 和审计仍然留在 `pages-manager` repo 闭环。

## 为什么不先拆独立 repo

第一阶段的目标是：

```text
Slack -> 需求整理 -> issue -> Agent 编码 -> PR -> Review Agent -> Preview -> Slack 回通
```

如果把索引项目拆成另一个 repo，会立刻引入跨 repo 协调：

- Slack job 在 `pages-manager`，索引上下文在另一个 repo。
- issue / PR 在 `pages-manager`，索引版本和 commit SHA 需要跨 repo 对齐。
- GitHub App 权限、webhook、Actions secret、审计要跨 repo 配两套。
- agent 生成 patch 时要判断“索引看见的代码”和“实际 PR base SHA”是否一致。
- Preview deploy 失败时，排障要在两个 repo 之间跳转。

这些都不是 MVP 的核心价值。MVP 更需要一条短链路先跑通。

## 什么时候需要独立 repo

后续满足这些条件时，可以把 `apps/indexer` / `packages/project-index` 拆成独立 repo 或独立平台项目：

- 索引目标不止 `pages-manager`，还包括多个业务 repo。
- 多个内部 AI 平台都要复用同一套代码索引服务。
- 索引量很大，需要独立 release、独立扩缩容、独立权限边界。
- 需要给其他团队开放只读检索 API。
- 需要把索引服务和 pages 发布平台分开计费、告警和运维。

拆出去之前，`pages-manager` 内部接口要先稳定成 API 合同，这样未来拆仓只是部署形态变化，不改主链路。

## MVP 索引内容

MVP 索引不追求全量代码智能搜索，先解决 coding agent 生成页面所需上下文：

| 内容 | 用途 |
| --- | --- |
| `sites/<employee>/<site>/site.json` | 读取站点结构、模板、访问策略 |
| `sites/<employee>/<site>/src/**` | 更新已有站点时给 agent 当前源码 |
| `templates/**` | 让 agent 选择和复用模板 |
| `packages/page-kit/**` | 读取 schema、渲染和校验规则 |
| 最近 issue / PR / ReviewAgentComment | 修复时理解历史需求和 review 反馈 |
| 构建和 preview 报告 | 避免重复踩已知失败 |

默认不把 `node_modules`、构建产物、截图历史、大文件资产和 secret 文件放进索引。

## 索引触发

推荐两类触发：

```text
main / template / page-kit 变更
  -> project-index.yml
  -> 生成 ProjectIndexSnapshot

PublishingJob 创建
  -> gateway 请求 index context
  -> 固定本次 job 使用的 index_snapshot_id
```

每个 `PublishingJob` 必须记录它使用的 `index_snapshot_id`。coding agent 读取上下文时要同时绑定：

```text
repo_full_name
base_sha
allowed_path
index_snapshot_id
```

这样可以避免 agent 用旧索引生成新代码。

## 组件职责

### `apps/indexer`

常驻或批处理索引服务，负责：

- 接收 gateway 或 workflow 的索引请求。
- 根据 repo、commit SHA、目标路径生成索引快照。
- 写入 `ProjectIndexSnapshot`。
- 把大索引文件写入 artifact store / R2 / GitHub artifact。
- 提供只读 context API 给 gateway / agent workflow。

### `packages/project-index`

纯库，负责：

- 扫描 repo 文件清单。
- 应用 include / exclude 规则。
- 生成 file manifest、symbol-lite manifest、template manifest。
- 从 issue / PR / review 生成 compact context。
- 生成 agent context bundle。

### `.github/workflows/project-index.yml`

Actions-first MVP 中可以先用 workflow 跑索引：

```text
checkout exact SHA
run project-index
upload index artifact
callback gateway
```

后续如果上 K8s，这个 workflow 可以替换为：

```text
namespace: pages-jobs
job: job-<jobId>-project-indexer
container: project-indexer
```

## Agent 使用方式

coding agent 不应该自己全仓搜索、自己决定读取任意文件。

推荐链路：

```text
pages-agent.yml(mode=initial|fix)
  ↓
load job context from gateway
  ↓
load project index context bundle
  ↓
run coding agent with bounded context
  ↓
generate patch only under allowedPath
```

索引只能扩大 agent 的理解能力，不能扩大 agent 的写权限。最终仍然由 path allowlist、schema check、secret scan、site-check 和 Review Agent gate 决定能不能进入 Preview。

## 数据模型

MVP 需要两类记录：

```text
ProjectIndexSnapshot
  repo_full_name
  base_sha
  index_type
  artifact_ref
  status

ProjectIndexItem
  snapshot_id
  path
  item_type
  content_hash
  metadata_json
```

如果第一阶段不引入向量数据库，可以先只做 manifest + 精确路径检索 + 关键词摘要。向量检索、OpenSearch、Qdrant、pgvector 等都可以后置。

## 权限边界

- indexer 只能读 repo 和历史元数据，不能 push、merge、deploy。
- indexer 不拿 Slack bot token。
- indexer 不拿 Cloudflare production token。
- indexer artifact 不能包含 secret 明文。
- agent 只能读取 gateway 授权的 context bundle，不能拿全仓无限制上下文。

## 和 Preview 闭环的关系

索引不是第一阶段的最终产物，Preview URL 才是。

第一优先级中，索引的职责是让 agent 更稳地完成：

```text
需求摘要 -> 站点上下文 -> 生成 patch -> 修复 Review Agent comments
```

它不改变第一阶段主链路：

```text
Slack -> issue -> Agent -> PR -> Review Agent -> Preview -> Slack
```
