# 破坏性变更

## 状态

首次发布；对已发布 npm 用户无破坏性变更。

## 适用版本

- `@xd-cell/skill`：0.1.0

## 影响对象

- 使用 `xd-cell` skill 的 AI agent；
- 维护 skill 发布流程的开发者。

## Agent 处理动作

可按当前 `SKILL.md`、`references/*` 和 `manifest.json` 使用。

## 首发契约

- 对外 skill 名称为 `xd-cell`。
- npm 包名为 `@xd-cell/skill`。
- 内部依赖 `@xd-cell/cli` 随 skill 包内置，入口为 `tools/xd-cell-cli/main.js`。
- 外部依赖 `@xd-cell/worker-sdk` 不随 skill 包内置；需要接入业务 Worker 时，按 `manifest.json` 和 `references/sdk.md` 安装并读取其包内文档。

## 安全注意事项

不要把发布 token、CLI token、cookie、SSO code、capability、secret 或 access key 写入源码、配置、日志、文档、截图或聊天内容。
