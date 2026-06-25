---
name: pages-deploy
description: Legacy compatibility note for XD Cell deployments. Use the current xd-cell skill and xd-cell CLI.
version: 2.0.0
---

# XD Cell Deploy

本文件只保留兼容入口。新的发布、状态查询、访问控制和回滚流程以 `apps/pages-skill/skill/SKILL.md` 和 `xd-cell` CLI help 为准。

## 使用当前 CLI

```bash
xd-cell login
xd-cell detect ./dist --json
xd-cell deploy ./dist demo --dry-run --json
xd-cell deploy ./dist demo --visibility org
xd-cell status demo
xd-cell open demo
```

CI 或 AI agent 使用平台签发的发布 token：

```bash
xd-cell deploy ./dist demo --token <token> --json
```

## 配置

```json
{
  "site": "demo",
  "source": "./dist",
  "fallback": "auto",
  "worker": {
    "entry": "./worker.mjs"
  }
}
```

保存为项目根目录的 `pages.config.json` 后，可以直接运行 `xd-cell deploy`；也可以用 `--config <file>` 显式指定其它配置文件。

默认让 CLI 自动判断发布目录。只有需要明确控制静态资源未命中行为时，才设置 `fallback: "index"` 或 `fallback: "not-found"`。

## 规则

- 不手写部署 HTTP 请求。
- 不保存或输出发布 token、CLI token、cookie、SSO code 或 secret。
- 不把凭证写进配置文件、源码、README、日志、截图或聊天内容。
- 遇到错误时，优先按 CLI 输出的错误码和 action 处理。
- v1 不再提供 Pages KV；业务自定义 Worker 需要 runtime helper 或 KV 相关能力时，按当前 `@xd-cell/worker-sdk` 文档接入。
