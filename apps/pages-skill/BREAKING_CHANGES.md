# 破坏性变更

## 状态

本次发布内置新版 `@xd-cell/cli`，并同步存在类型级破坏性变更的 `@xd-cell/worker-sdk@0.2.0` 兼容指引；对 skill 自身已发布 npm 用户无破坏性变更。

## 适用版本

- `@xd-cell/skill`：0.1.2

## 影响对象

- 使用 `xd-cell` skill 的 AI agent；
- 维护 skill 发布流程的开发者。

## Agent 处理动作

更新当前 `xd-cell` skill 后，按当前 `SKILL.md`、`references/*` 和 `manifest.json` 使用内置 CLI；接入 Worker SDK 时先读取其包内 `BREAKING_CHANGES.md`。

## 发布顺序

1. 先发布并验证 `@xd-cell/worker-sdk@0.2.0` 可以从目标 registry 安装。
2. 再构建并发布 `@xd-cell/skill@0.1.2`，确认 `manifest.json` 推荐的 Worker SDK 版本为 `0.2.0`，内置 CLI 版本为 `0.1.2`。

## 首发契约

- 对外 skill 名称为 `xd-cell`。
- npm 包名为 `@xd-cell/skill`。
- 内部依赖 `@xd-cell/cli` 随 skill 包内置，入口为 `tools/xd-cell-cli/main.js`。
- 外部依赖 `@xd-cell/worker-sdk` 不随 skill 包内置；需要接入业务 Worker 时，按 `manifest.json` 和 `references/sdk.md` 安装并读取其包内文档。

## 安全注意事项

不要把发布 token、CLI token、cookie、SSO code、capability、secret 或 access key 写入源码、配置、日志、文档、截图或聊天内容。
