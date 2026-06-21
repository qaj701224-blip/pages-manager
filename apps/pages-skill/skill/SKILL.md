---
name: xd-pages
version: __XD_PAGES_SKILL_VERSION__
description: 围绕内置 pages-cli 和 @xd/pages-sdk 使用 XD Pages：发布站点、查看部署、配置访问规则，并在浏览器或 Worker 代码中接入 runtime helper。适用于用户要求部署静态站点、SPA 构建产物、自定义 Worker，使用 pages CLI，管理 pages.xd.team 站点，或接入 XD Pages SDK 的场景。
---

# XD Pages

使用本 skill 调用内置 `pages-cli` 发布和管理 XD Pages 站点，并按需接入内置 `@xd/pages-sdk`。

始终使用本 skill 内置 CLI 和内置文档，确保会话使用的是随最新 `xd-pages` skill 发布的能力。

## 起步流程

1. 每个会话首次使用本 skill 时，先读取 `references/update.md` 做版本自检。
2. 发布和管理操作使用内置 CLI：`node tools/pages-cli/main.js`。
3. 执行具体操作前先运行对应的 `help`，以 CLI 输出作为参数和用法的权威来源。
4. 不要优先使用环境里的 `pages`，避免使用到旧版本 CLI。
5. 修改导入 `@xd/pages-sdk` 的应用代码前，先读 `references/sdk.md`。
6. 处理登录、发布 token 或生成配置时，按 `references/cli.md` 的 CLI 流程执行。

## 使用原则

- 内置 CLI 能完成的操作，使用内置 CLI。
- 不要引导用户把内置 CLI 全局安装；全局副本可能滞后于当前 skill。
- 不主动切换目标环境；普通发布让 CLI 使用默认目标，内部测试环境按维护流程处理。
- 凭证只通过 CLI 支持的登录流程或 `--token <token>` 传入。
- 不要把发布 token、CLI token、cookie、SSO code 或 secret 写入源码、配置、日志、文档、截图或聊天内容。
- agent 或 CI 场景可以使用 CLI help 中支持的发布 token 参数；需要解析输出时使用 CLI help 中支持的 JSON 输出参数。

## 内置工具

- CLI 入口：`node tools/pages-cli/main.js`
- SDK 包：`tools/pages-sdk`
