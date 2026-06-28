---
name: pages-deploy
description: Legacy compatibility note for XD Cell deployments. Use the current xd-cell skill and xd-cell CLI.
version: 2.0.0
---

# XD Cell Deploy

本文件只保留兼容入口。新的发布、状态查询、访问控制和 secret 管理流程以 `apps/pages-skill/skill/SKILL.md` 和 `xd-cell` CLI help 为准。

## 使用当前 CLI

```bash
xd-cell login
xd-cell detect ./dist --json
xd-cell deploy ./dist demo --dry-run --json
xd-cell deploy ./dist demo --visibility org
xd-cell deploy --config xd-cell.config.json
xd-cell secrets put demo API_TOKEN
xd-cell secrets delete demo API_TOKEN
xd-cell status demo
xd-cell open demo
```

CI 或 AI agent 可以使用平台签发的 API token，也可以通过 `XD_CELL_API_TOKEN` 避免交互登录或在命令里显式传 token：

```bash
xd-cell deploy ./dist demo --token <token> --json
XD_CELL_API_TOKEN=<token> xd-cell deploy ./dist demo --json
```

## 配置

```json
{
  "name": "demo",
  "main": "./src/index.js",
  "assets": {
    "directory": "./dist",
    "not_found_handling": "single-page-application"
  },
  "vars": {
    "API_BASE": "https://api.example.com"
  },
  "visibility": "org"
}
```

保存为项目根目录的 `xd-cell.config.json` 后，可以直接运行 `xd-cell deploy`；也可以用 `--config <file>` 显式指定其它配置文件。未显式传 `--config` 时，CLI 只自动读取当前目录的 `xd-cell.config.json`。

配置文件只保存非敏感发布意图。静态资源未命中行为通过 `assets.not_found_handling` 表达；`vars` 是站点级当前 runtime config，由 Worker deploy 同步，省略时沿用站点当前值，显式 `{}` 清空；secret value 使用 `xd-cell secrets put/delete` 管理，不写入配置文件。
runtime bindings 只注入 Worker 发布；单个 var / secret value 当前限制为 8 KiB，单次 Worker 发布最多 64 个 runtime bindings。站点发布权限是高信任权限：能发布 Worker 代码，也能设置并使用该站点 secrets。

## 规则

- 不手写部署 HTTP 请求。
- 不保存或输出 API token、CLI token、cookie、SSO code 或 secret。
- 不把凭证写进配置文件、源码、README、日志、截图或聊天内容。
- 遇到错误时，优先按 CLI 输出的错误码和 action 处理。
- v1 不再提供 Pages KV；业务自定义 Worker 需要 runtime helper 或 KV 相关能力时，按当前 `@xd-cell/worker-sdk` 文档接入。
