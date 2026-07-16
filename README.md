# pages-manager

`pages-manager` 是 XD Cell 的 monorepo。当前主线是 v2：基于 Cloudflare Workers for Platforms 的内部站点发布平台，用于把构建产物目录或自定义 Worker 发布到 XD Cell 托管站点。新建站点默认使用 `workers.xd.team` 站点后缀；已存在的 `pages.xd.team` 路由会继续保留。用户入口是 `xd-cell` CLI；平台负责认证、上传、访问策略、路由快照和执行隔离。

v1 位于 `apps/server`，服务 `workers.xd.team` 旧链路。v1 只做 legacy 维护，后续不再作为新能力的设计目标。

## 架构一览

```text
用户 / AI / CI
  -> xd-cell CLI
  -> apps/pages-api       管理 API、部署编排、站点与版本数据
  -> apps/pages-auth      登录、SSO、session 和 token 相关能力
  -> apps/pages-router    子站访问入口、visibility、ACL、路由快照
  -> apps/kv-gateway      runtime data/KV 能力的受控网关
  -> Cloudflare WFP / Workers / D1 / KV
```

核心包：

- `apps/pages-cli/`：用户和 agent 使用的 CLI。
- `apps/pages-skill/`：随 CLI 发布给 AI agent 的 `xd-cell` skill。
- `apps/worker-sdk/`：业务自定义 Worker 使用的 runtime helper SDK，包名 `@xd-cell/worker-sdk`。
- `packages/wfp-client/`：Cloudflare Workers for Platforms 客户端。
- `packages/pages-runtime-protocol/`：runtime 协议共享定义。
- `packages/worker-kit/`、`packages/ip-guard/`：Worker 公共工具。

## 用户入口

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

CI 或 AI agent 可以使用一次性 API token；也可以手动设置 `XD_CELL_API_TOKEN`，避免交互登录或在命令里显式传 token：

```bash
xd-cell deploy ./dist demo --token <token> --json
XD_CELL_API_TOKEN=<token> xd-cell deploy ./dist demo --json
```

CLI 会自动识别发布目录：

- 普通构建目录直接发布为静态资源。
- 需要自定义请求逻辑时，可以把 Worker 入口作为 `entry`，并用 `--assets <dir>` 附带静态资源目录。
- `xd-cell.config.json` 可以保存非敏感发布模板；未传 `--config` 时，只自动读取当前目录的 `xd-cell.config.json`。
- 静态资源未命中行为通过 `assets.not_found_handling` 配置，不提供单独的 `--fallback` 命令行入口。
- `vars` 是站点级当前 runtime config，由 Worker deploy 时的 `xd-cell.config.json` 同步；省略 `vars` 会沿用站点当前值，显式 `"vars": {}` 会在下一次 Worker deploy 清空。
- 站点级 secret 使用 `xd-cell secrets put/delete` 管理；secret value 不进入配置文件、deploy metadata、日志或响应。
- `vars` 和站点级 secrets 只会注入 Worker 发布；静态资源发布不会携带 runtime bindings。单个 var / secret value 当前限制为 8 KiB，单次 Worker 发布最多 64 个 runtime bindings。

配置文件只保存非敏感发布意图：

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

保存为项目根目录的 `xd-cell.config.json` 后，可以直接运行 `xd-cell deploy`；也可以用 `--config <file>` 显式指定其它配置文件。命令行位置参数和 flag 会覆盖配置文件里的同名发布意图。

更多 API 边界见 [docs/api-boundary.md](./docs/api-boundary.md)。文档索引和真相源矩阵见 [docs/README.md](./docs/README.md)。

## 安全边界

- 发布必须通过 CLI token 或 API token 强认证。
- 管理 API 需要认证，所有 `pages-api` 对外管理 API 路由都可从公网访问且只接受 HTTPS；子站访问由 router 执行 IP allowlist、visibility、SSO 和 ACL，Console 暂时继续限制公司网络来源。
- `internal` 表示公司网络内匿名可访问，不代表互联网公开。
- `acl` 支持邮箱和完整部门路径授权，部门路径默认包含子部门。
- API token、CLI token、cookie、SSO code、Cloudflare token、secret value 和平台能力不得写入项目文件、日志、README、截图或聊天消息。
- 站点发布权限是高信任权限：能发布 Worker 代码，也能设置并使用该站点 secrets；只读成员不能创建 deploy-capable access key。

## 代码目录

```text
pages-manager/
├── apps/pages-api/      # v2 管理 API Worker
├── apps/pages-cli/      # 用户和 agent 使用的 CLI
├── apps/pages-router/   # 子站访问 router
├── apps/pages-auth/     # 登录和认证相关 Worker
├── apps/worker-sdk/     # Worker runtime helper SDK
├── apps/pages-skill/    # 发布给 AI agent 的 xd-cell skill
├── packages/wfp-client/ # 平台执行客户端
├── packages/worker-kit/
├── packages/ip-guard/
├── docs/
└── scripts/
```

legacy v1 目录：

```text
apps/server/              # v1 管理 API Worker，仅维护旧 workers.xd.team 链路
pages-deploy.skill.md     # v1 文件名兼容入口，内容指向当前 xd-cell skill
```

## 开发

```bash
pnpm install
pnpm lint
pnpm test
```

环境要求：

- Node.js `>=22.12.0`
- pnpm `>=9.15.0`

不要提交 `.env`、`.staging.env`、`apps/server/wrangler.toml`、`apps/xdads-302/wrangler.toml`、demo 目录里的 `.pages.json`，也不要在测试或文档中写真实 Cloudflare 资源 ID、token 或账号信息。

## 部署

平台部署规则见 [docs/deployment-branch-policy.md](./docs/deployment-branch-policy.md)。v2 架构入口见 [docs/pages-v2-wfp-architecture.md](./docs/pages-v2-wfp-architecture.md)。

常用维护命令：

```bash
pnpm --dir apps/pages-api test
pnpm --dir apps/pages-cli test
pnpm --dir apps/pages-skill build
```

production 部署必须人工在 GitHub Actions 中手动触发；改动 workflow 时必须确认 push/PR 不会自动部署 production。

## Pages KV

v1 不再提供 Pages KV。业务自定义 Worker 需要 runtime helper 或 KV 相关能力时，按 `@xd-cell/worker-sdk` 和当前平台文档接入，不要使用旧部署参数。

## Slack 合并通知 Smoke

- 2026-06-24：用于验证 `feat/slack-preview-gateway` 合并 PR 后会发送 Slack 合并通知。
- 2026-06-24：用于验证 Slack 合并通知的消息样式接近 MR 摘要格式。
