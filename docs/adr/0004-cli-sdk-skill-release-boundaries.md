# ADR 0004: XD Cell CLI、Worker SDK 与 Skill 分发边界

## 状态

已接受，已按当前仓库实现落地。

本文记录 XD Cell v2 面向 AI agent 和人类用户的分发边界。已落地决策是：`xd-cell` skill / `@xd-cell/skill` 内置一个锁定版本的 `@xd-cell/cli` 构建产物，同时 `@xd-cell/cli` 作为可独立发布的 npm 包治理；Worker SDK 作为独立 npm 包 `@xd-cell/worker-sdk` 治理；skill 不复制 Worker SDK 领域产物，只维护安装、兼容和安全边界说明。

## 背景

XD Cell 有三个面向外部消费者的入口：

- `xd-cell` CLI：agent 执行登录、发布、状态查询、访问策略和回滚的操作工具。
- `@xd-cell/worker-sdk`：业务自定义 Worker 在运行时接入 runtime context 与 KV 资源的 SDK。
- `xd-cell` skill / `@xd-cell/skill`：AI agent 使用 XD Cell 的说明书和工具入口。

三者服务对象不同：

- CLI 是控制面工具，强调可执行、可锁定、少依赖环境。
- Worker SDK 是业务运行时代码依赖，强调包边界、类型、兼容承诺和破坏性变更提示。
- Skill 是 agent 操作契约，强调流程、安全和版本关系，不应成为业务运行时代码的依赖宿主。

如果 skill 同时打包 CLI、SDK 源码、SDK 文档和 AI 文档，会带来几个问题：

- skill 发布产物与 npm 包发布产物可能漂移。
- agent 无法明确判断 SDK API 的真相源是 skill 内副本还是包内文档。
- 后续 Worker SDK 重构时，需要同时维护 skill 内复制物和 npm 包内容。
- 维护 skill-managed cache 或运行时依赖管理机制会引入复杂度，但和直接把 SDK 打包进 skill 的收益差异不大。

## 决策

初期采用“CLI 随 skill，Worker SDK 随 npm 包”的分发模型：

```text
AI agent
  -> xd-cell skill
  -> 内置 @xd-cell/cli 工具
  -> references/sdk.md 说明 Worker SDK 依赖关系

业务自定义 Worker
  -> package.json dependencies
  -> @xd-cell/worker-sdk
  -> 包内 README / docs/llms / 类型声明 / BREAKING_CHANGES
```

`xd-cell` skill 构建产物包含：

- `SKILL.md`
- `references/*`
- `tools/xd-cell-cli/*`

`xd-cell` skill 构建产物不包含：

- `tools/worker-sdk`
- Worker SDK 的 `dist`
- Worker SDK 的 `docs/llms/*`
- Worker SDK 的 README 副本
- Worker SDK API reference 副本

Worker SDK 的 AI-readable 文档随 `@xd-cell/worker-sdk` 包发布。Skill reference 只告诉 agent 如何安装依赖、如何读取包内 `docs/llms/*`、如何处理缺包场景，以及有哪些安全边界；不复刻函数签名、示例全集或 API 摘要。

## 组件职责

### xd-cell CLI

CLI 是 XD Cell 控制面的 agent 操作工具。它通过 CLI-managed API 与 `pages-api` / `pages-auth` 交互，不要求用户或 agent 手写部署 HTTP 请求或认证 header。

Skill 场景下 CLI 仍不要求用户单独安装，作为 `@xd-cell/skill` 的内部依赖随 skill 包发布并暴露给 agent 使用：

```bash
node tools/xd-cell-cli/main.js
```

人类用户和 CI 也可以安装独立的 `@xd-cell/cli` npm 包。包内的 `README.md` 是 npm 使用入口，`apps/pages-cli/src/build.js` 生成的发布产物必须携带该 README；skill 继续使用自身内置的 CLI 快照，不在运行时隐式依赖全局 npm 安装。

### Worker SDK

Worker SDK 是业务运行时代码依赖，包名为 `@xd-cell/worker-sdk`。它的真相源在包内：

- `apps/worker-sdk/package.json`
- `apps/worker-sdk/README.md`
- `apps/worker-sdk/src/worker/index.ts`
- 构建后的 `.d.ts`
- `apps/worker-sdk/docs/llms/*`
- `apps/worker-sdk/BREAKING_CHANGES.md`
- 相关测试

业务项目需要自定义 Worker runtime helper 时，应显式安装：

```bash
pnpm add @xd-cell/worker-sdk
```

业务 Worker 从包根导入公开 API：

```ts
import { createRuntime, readContext } from '@xd-cell/worker-sdk';
```

当前只公开 Worker runtime helper。`browser`、runtime adapter、inline runtime source 和平台内部 Worker 生成模板不属于 `@xd-cell/worker-sdk` 当前公共面；如果后续需要公开，应另行评估包名、导出路径、README、类型声明、兼容承诺和破坏性变更说明。

### xd-cell skill

Skill 是 agent 操作契约。它负责：

- 指导 agent 使用 XD Cell 的正确流程。
- 提供锁定版本的 CLI 工具。
- 说明 Worker SDK 与 skill 的依赖关系和版本兼容关系。
- 指导 agent 在用户项目中安装 `@xd-cell/worker-sdk` 并读取包内 AI 文档。
- 明确凭证、安全、环境和 API 边界。

Skill 不负责：

- 打包 Worker SDK 运行时代码。
- 复制 Worker SDK 的 `docs/llms/*`。
- 手写维护 Worker SDK API reference。
- 生成或复制本地 Worker SDK helper。
- 维护 skill-managed dependency cache。

如果 `@xd-cell/worker-sdk` 尚未发布或用户项目无法安装，agent 不应从 skill 产物寻找内置 SDK 副本，也不应复制 monorepo 内部源码到业务项目伪装成发布包。正确动作是说明依赖不可用，根据任务性质暂停、使用项目已有实现，或在本仓库内继续开发 Worker SDK。

### 内部 packages

`packages/pages-runtime-protocol`、`packages/worker-kit`、`packages/ip-guard`、`packages/wfp-client` 默认保持内部 workspace 依赖，不作为业务侧公共契约发布。

只有出现明确外部消费者和版本兼容需求时，才考虑把某个内部包提升为公开包。提升前应单独写 ADR，说明公开 API、兼容承诺和安全边界。

## 版本与一致性

Skill release 已通过 `manifest.json` 记录它绑定的 CLI 版本，以及推荐的 Worker SDK 版本。当前 manifest 由 `apps/pages-skill/src/build.js` 生成，schema 为：

```json
{
  "schemaVersion": 1,
  "product": {
    "name": "XD Cell",
    "siteDomainSuffix": "workers.xd.team"
  },
  "skill": {
    "name": "xd-cell",
    "packageName": "@xd-cell/skill",
    "version": "<skill-version>",
    "breakingChangesPath": "BREAKING_CHANGES.md"
  },
  "dependencies": {
    "cli": {
      "packageName": "@xd-cell/cli",
      "version": "<cli-version>",
      "bundled": true,
      "path": "tools/xd-cell-cli/main.js",
      "packageJsonPath": "tools/xd-cell-cli/package.json"
    },
    "workerSdk": {
      "packageName": "@xd-cell/worker-sdk",
      "recommendedVersion": "<worker-sdk-version>",
      "installCommand": "pnpm add @xd-cell/worker-sdk@<worker-sdk-version>",
      "packagePath": "node_modules/@xd-cell/worker-sdk",
      "docsPath": "docs/llms/worker-sdk.md",
      "apiDocsPath": "docs/llms/worker-sdk-api.md",
      "breakingChangesPath": "BREAKING_CHANGES.md"
    }
  }
}
```

`dependencies.workerSdk.packagePath` 和 `docsPath` / `apiDocsPath` / `breakingChangesPath` 用于 agent 在用户项目依赖中定位 Worker SDK 包内文档。业务 Worker 需要 import SDK 时，必须由用户项目自己的 `package.json` 显式依赖 `@xd-cell/worker-sdk` 并锁定版本；skill 不维护全局安装或 skill-managed cache。

当 skill manifest 推荐新的 Worker SDK 版本时，必须先发布并验证该 Worker SDK 版本可以从目标 registry 安装，再构建和发布 skill。skill 不得推荐尚未发布的外部依赖版本。

## AI 破坏性变更信号

发布给 AI agent 消费的产物必须明确说明是否有破坏性变更：

- `@xd-cell/worker-sdk` 包携带自己的 `BREAKING_CHANGES.md`，说明包名、导入路径、`exports`、类型签名、runtime 语义和安全边界是否变化。
- `xd-cell` skill 应携带或引用 skill 自身的破坏性变更信息，说明 CLI 路径、agent 流程、推荐 Worker SDK 版本或兼容关系是否变化。

Skill 不应复制 Worker SDK 的破坏性变更文档；它只应告诉 agent 去安装包内读取：

```bash
SDK_ROOT="node_modules/@xd-cell/worker-sdk"
sed -n '1,160p' "$SDK_ROOT/BREAKING_CHANGES.md"
```

即使没有破坏性变更，也必须发布明确的空状态，而不是省略文件。推荐格式：

```markdown
# 破坏性变更

## 状态

无破坏性变更。

## 适用版本

- @xd-cell/worker-sdk：0.1.1

## Agent 处理动作

可继续按现有说明使用。
```

如果有破坏性变更，必须写清楚：

- `状态`：例如 `存在破坏性变更`。
- `适用版本`：影响的产物和版本。
- `影响对象`：用户、CI、业务应用、agent、平台维护者中哪些会受影响。
- `旧用法` / `新用法`：旧用法和新用法。
- `Agent 处理动作`：agent 应继续、暂停、要求用户确认，还是自动迁移。
- `兼容窗口`：旧入口是否保留、保留到哪个版本或日期。
- `验证方式`：迁移后应该运行的命令或检查。
- `回滚方式`：可行的回滚方式。
- `安全注意事项`：token、cookie、secret、session 和发布凭证不得出现在示例中。

## 文档真相源

文档按消费者分层维护，避免同一 API 在多处复刻：

- Worker SDK 使用说明：`apps/worker-sdk/README.md`
- Worker SDK API 摘要：`apps/worker-sdk/docs/llms/worker-sdk-api.md`，由 `.d.ts` 生成
- Worker SDK AI 主文档：`apps/worker-sdk/docs/llms/worker-sdk.md`，由包真相源生成
- Worker SDK 破坏性变更：`apps/worker-sdk/BREAKING_CHANGES.md`
- CLI 用法：skill 内置 CLI 的 `xd-cell help` 输出
- Agent 操作流程：`apps/pages-skill/skill/SKILL.md` 和 `apps/pages-skill/skill/references/*`
- 架构决策：本文和后续相关 ADR

Skill reference 不应复刻 SDK 函数签名、CLI 参数清单或示例全集。它应指导 agent 读取 CLI help 和 `@xd-cell/worker-sdk` 包内文档。

实现包重命名、产物组装或 release manifest 时，必须同步：

- `apps/worker-sdk/README.md`
- `apps/worker-sdk/BREAKING_CHANGES.md`
- `apps/worker-sdk/docs/llms/*`
- `apps/pages-skill/skill/references/sdk.md`
- `apps/pages-skill/skill/SKILL.md`
- `docs/README.md` 的真相源矩阵
- 相关测试中对包名、`exports`、README 和 skill 文档的断言

历史设计文档位于 `docs/superpowers/` 时，可以保留旧包名或旧分发策略作为历史记录，不应为了当前命名回写历史计划。

## 破坏性变更管理

本 ADR 本身不是用户可见破坏性变更；它记录当前分发边界。真正的破坏性变更发生在下列行为进入发布、用户文档或 `BREAKING_CHANGES.md` 时：

- Worker SDK 包名、根导出、公开 `exports` 或类型签名变化。
- Worker SDK 包名边界变化：公开包名只认 `@xd-cell/worker-sdk`；`@xd/pages-sdk/*`、`@xd-pages/sdk/*`、`@xd-pages/worker-sdk` 和 `@xd-pages/worker-sdk/worker` 只作为历史草案或旧文档路径识别，不新增使用、不补兼容。
- Skill 开始或停止内置某类工具，并改变 agent 可见路径。
- CLI 命令、参数、输出格式、退出码或 token 处理语义变化。
- Skill 推荐的 Worker SDK 版本或兼容关系变化且需要用户项目修改依赖。

发生上述变更时，需要单独写 `BREAKING_CHANGES.md`、用户迁移说明或 changelog entry，内容至少包含：

- 旧用法和新用法。
- 影响范围：用户、CI、业务应用、agent、平台维护者。
- 兼容窗口：是否保留旧包名、旧导入路径或旧 CLI alias。
- 迁移步骤和验证命令。
- 回滚策略。
- 安全注意事项，尤其是 token、cookie、secret 和发布凭证不得出现在迁移示例中。

如果只是实现内部构建方式变化，且 skill 对 agent 暴露的 CLI 命令和 Worker SDK 依赖关系保持兼容，则不需要用户级破坏性变更文档；只需要在 PR 描述和内部 changelog 中说明构建链路变化。

## 安全与发布约束

- 发布流程不得把 npm token、CLI token、发布 token、Cloudflare token、cookie、session 或其它 secret 写入仓库、构建产物、skill 文档或日志。
- Worker SDK 发布到公开或公司受控 registry 时，凭证只能通过 CI secret 注入。
- Skill 内置工具不得鼓励用户打印或持久化发布 token。
- Agent 路径继续优先使用 skill 内置 CLI，避免受全局旧版 CLI 影响。
- Agent 不应信任浏览器传入的平台相关 header；自定义 Worker 需要平台上下文时，应按 Worker SDK 文档读取平台 router 注入的上下文。
- 修改 GitHub Actions 发布流程时，必须确认不会让 production 在 push 或 PR 上自动部署。

## 当前落地状态与后续决策点

当前已落地：

- `apps/worker-sdk` 已收敛为独立 Worker SDK 包，当前公开根导出、README、类型声明、AI 文档生成和测试覆盖。
- `browser` helper、runtime adapter 和 inline runtime source 已从 Worker SDK 公共面移出，暂存到根目录 `pages-sdk-extras/`，后续再决定是恢复为独立产物、skill 生成模板还是平台内部工具。
- CLI 仍作为 skill 内置工具，不要求 agent 单独安装 `@xd-cell/cli`；面向人类用户和 CI 的 `@xd-cell/cli` npm 包同时保持可独立发布。
- Skill 构建只复制 CLI 构建产物、skill references、skill 自身 `BREAKING_CHANGES.md` 和 release `manifest.json`。
- Worker SDK 自己生成 `docs/llms/worker-sdk.md` 和 `docs/llms/worker-sdk-api.md`，并通过 `pack:check` 检查 AI 文档是否与包真相源漂移。
- 根 `llms.txt` 只作为索引，指向 Worker SDK 包内领域文档、skill reference 和本 ADR。
- 文档说明用户项目通过 `@xd-cell/worker-sdk` 接入 runtime helper，skill 不复制 Worker SDK 领域产物。

后续如出现以下需求，应新增 ADR 或更新本文：

- 让 skill 改为只引用独立 CLI 包，或要求 skill 与 npm 包使用同一运行时版本，而不是继续内置 CLI 快照。
- 将 D1/R2、browser helper、runtime adapter、inline runtime source 或用户级存储恢复为公开能力。
- 改变 skill 与 Worker SDK 的版本兼容策略，例如从 `recommendedVersion` 改为 semver range。
- 改变 Worker SDK 文档读取方式，例如从用户项目依赖改为文档站、公司 registry 索引或其它受控索引。

## 后果

收益：

- CLI、Worker SDK 和 skill 的产品边界清晰，分别服务控制面操作、业务运行时代码和 agent 流程。
- Worker SDK API 的真相源只有包本身，AI 文档随包发布，不需要在 skill 中复制。
- Skill 构建更简单，不需要维护 SDK 复制、skill-managed cache 或运行时依赖管理机制。
- 业务项目依赖关系更显式，符合未来 npm 包发布和 semver 治理方式。

代价：

- 接入 Worker SDK 时依赖 npm registry 或公司包源可用性。
- `xd-cell` skill 需要维护与 Worker SDK 推荐版本和兼容关系的说明。
- 如果用户项目离线或 registry 不可用，agent 不能靠 skill 内置 SDK 完成接入，需要暂停或走项目已有实现。

## 非目标

- 本 ADR 不定义具体 npm registry、scope 权限或 CI secret 名称。
- 本 ADR 不要求用户立即单独安装 `@xd-cell/cli`。
- 本 ADR 不改变当前线上 API、auth、router 或 deployment 行为。
- 本 ADR 不要求 skill 运行时联网安装依赖；安装 Worker SDK 是用户项目依赖管理动作。
- 本 ADR 不把 browser helper、adapter 或 inline runtime source 纳入 Worker SDK 当前公共 API。
