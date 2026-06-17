# pages-manager

本文件是 Codex、Claude 和其它 coding agent 的共同项目说明。`AGENTS.md` 是唯一正文；`CLAUDE.md` 应作为指向本文件的软链，不维护第二份内容。

## 项目概览

`pages-manager` 是 XD Pages 的 monorepo。当前主线是 v2：基于 Cloudflare Workers for Platforms 的内部站点发布平台，用于把静态站点、SPA 或自定义 Worker 发布到 `pages.xd.team` 域名下。

v2 用户入口是 `pages` CLI。平台负责登录认证、发布 token、上传、访问策略、路由快照、runtime data/KV helper 和执行隔离。

v1 位于 `apps/server`，服务旧 `workers.xd.team` 链路。v1 只做 legacy 维护，后续不再作为新能力设计目标。

核心目录：

- `apps/pages-api/`：v2 管理 API Worker，部署编排、站点、版本和路由数据。
- `apps/pages-cli/`：用户和 agent 使用的 CLI。
- `apps/pages-router/`：子站访问 router，执行 visibility、SSO、ACL 和路由快照。
- `apps/pages-auth/`：登录、SSO、session 和 token 相关 Worker。
- `apps/kv-gateway/`：runtime data/KV 能力的受控网关。
- `apps/pages-sdk/`：站点 runtime helper SDK。
- `apps/pages-skill/`：发布给 AI agent 的 XD Pages skill。
- `packages/wfp-client/`：Cloudflare Workers for Platforms 客户端。
- `packages/pages-runtime-protocol/`：runtime 协议共享定义。
- `packages/worker-kit/`、`packages/ip-guard/`：Worker 公共工具。
- `apps/server/`：v1 legacy 管理 API Worker，仅维护旧 `workers.xd.team` 链路。
- `apps/gateway/src/`：平台控制面，接收 Slack Events、Slack Interactivity、GitHub webhook、executor callback 和内部 API。
- `apps/gateway/src/routes/`：gateway HTTP 路由注册，按 health / publishing / Slack / GitHub / internal lane 拆分。
- `apps/gateway/src/control-plane/`：AI 发布控制面 orchestration，承接 Slack、GitHub、Review gate 的运行时处理和通用上下文。
- `apps/gateway/src/publishing/`：PublishingJob HTTP API、输入归一化和 worker 调度 adapter。
- `apps/gateway/src/slack/`：Slack 验签、会话、消息解析、状态卡 adapter。
- `apps/gateway/src/github/`：GitHub webhook 和 Review Agent comment 归一化。
- `apps/gateway/src/db/`：MySQL / Redis runtime store、Drizzle schema、rows、repositories。
- `apps/worker/src/`：发布任务调度 worker，按 jobs / integrations 拆分 issue、Coding Agent、preview 和 gateway callback。
- `apps/slack-agent/src/`：常驻 Slack Agent，负责自由对话、需求整理、会话续接，不写代码。
- `apps/slack-notifier/src/`：Slack Web API 输出服务，负责 reaction、thread 回复和 Block Kit 状态卡。
- `packages/git-client/`：GitHub API helper。
- `packages/slack-notifier/`：Slack notifier shared Block Kit / Web API helper。
- `packages/workflow-core/`：PublishingJob、PlatformDevItem 状态机、ID 和事件 helper。
- `tests/`：所有单元测试和脚本测试，测试 helper 不属于运行时架构。
- `.github/workflows/`：CI、staging、production 和用户站点发布 workflow。
- `docs/`：文档索引、架构、运维、安全和 ADR。

文档入口和真相源矩阵见 `docs/README.md`。

Gateway 运行态必须是 MySQL-backed。`apps/gateway/src/db/gateway-store.js` 里的 `Map` 只能作为单进程缓存，不能作为跨请求真相源。不要重新引入 `PAGES_GATEWAY_STORE_FILE`、JSON 文件 store、SQLite、单 pod PVC 或运行时 `MemoryGatewayStore`。`tests/helpers/gateway-store-fixture.js` 只服务单元测试，不得被生产代码 import。

## 开发命令

使用仓库根目录执行：

```bash
pnpm install
pnpm lint
pnpm test
```

环境要求：

- Node.js `>=22.12.0`
- pnpm `>=9.15.0`

不要把 `.env`、`.env.ecs`、`.ack-preview.env`、`.staging.env`、`apps/server/wrangler.toml`、`apps/xdads-302/wrangler.toml`、demo 目录里的 `.pages.json` 提交到 Git。

## 分支与部署

- `master`：生产真相源，feature / fix / ci / build 等项目类 PR 默认直接合入这里；合并后不自动部署。
- `staging`：共享 preview 分支，用于提前部署和验证指向 `master` 的项目类 PR；不是晋级来源。
- v2 production 部署必须人工在 GitHub Actions 中手动触发 `Deploy XD Pages Production`。
- v1 production 部署必须人工在 GitHub Actions 中手动触发 `Deploy Production`。

分支整理规则：

- 默认流向是 `feature branch -> PR to master -> sync to staging preview -> merge to master`。
- 不要从 `staging` 向 `master` 发起晋级 PR；`staging` 可能包含尚未合入 `master` 的其它 PR 代码。
- 如果项目类 PR 直接提交到 `master`，`Sync Master PR To Staging` workflow 必须在 PR ready 后把 PR head 提前 merge 到 `staging`，并按变更范围显式 dispatch v1 或 v2 staging deploy 做预览验证。
- 纯 `sites/**` 用户站点 PR 跳过平台 staging sync。
- `staging` 被废弃 PR 污染时，由维护者确认没有活跃 preview 后重新对齐 `master`，再重新触发需要验证的 PR。
- 不要双向随意 cherry-pick 多个 workflow / k8s commit，避免把 preview-only 代码带入主线。

v2 部署隔离要求：

- production API：`https://api.pages.xd.team`
- staging API：`https://api-staging.pages.xd.team`
- production auth：`https://auth.pages.xd.team`
- staging auth：`https://auth-staging.pages.xd.team`
- production 子站：`<site>.pages.xd.team`
- staging 子站：`<site>-staging.pages.xd.team`
- production Worker 前缀和 D1/KV/route 资源不得与 staging 混用。

v1 legacy 隔离要求：

- staging Worker：`pages-manager-staging`
- production Worker：`pages-manager`
- staging API：`https://api-staging.workers.xd.team`
- production API：`https://api.workers.xd.team`
- staging 子站域名后缀：`-staging.workers.xd.team`
- production 子站域名：`workers.xd.team`
- staging 子 Worker 前缀：`pages-staging-`
- production 子 Worker 前缀：`pages-`

CI/CD 隔离要求：

- 所有 PR 先由 `pr-classify.yml` 按目录分类：只改 `sites/<employee>/<site>/` 是个人站点线，只改非 `sites/**` 是平台线，同时改两者的 mixed PR 不支持，必须拆分。
- 平台代码 PR 走 `pr-platform.yml`（Platform CI），个人站点 PR 走 `pr-site.yml`；自动站点 PR 还会由 `pages-agent.yml` 显式 dispatch `pr-classify.yml`、`pr-platform.yml` 和 `pr-site.yml`。
- 平台本体部署包括 `deploy-staging.yml`、`deploy.yml`、`deploy-pages-v2-staging.yml`、`deploy-pages-v2.yml`、`deploy-ack-preview.yml`，只能构建 / 部署平台 Worker、ACK 镜像和 K8s Deployment。
- 用户站点发布执行器包括 `project-index.yml`、`pages-agent.yml`、`pages-preview.yml`、`pr-site.yml`，只能处理 `PublishingJob`、`sites/<employee>/<site>/`、生成 PR 和 preview。
- 用户站点发布 workflow 禁止使用 Aliyun AK、ACR、`KUBE_CONFIG_B64`、`kubectl`、production Wrangler token 或 ACK namespace 权限。
- 自动生成的 `sites/**` PR 不得修改 `.github/**`、`apps/**`、`packages/**`、`k8s/**`、`scripts/**`、Dockerfile 或部署文档。

改动 GitHub Actions 时，必须确认不会让 production 在 push/PR 时自动部署。
详细 GitHub、分支和发布规则见 `docs/architecture/github-automation.md`。

## 敏感信息规则

这是 public repo 标准的代码库。禁止提交或公开输出：

- Cloudflare API token、account id、zone id、KV namespace id、D1 database id 的真实值。
- 任何 `.env` 中的真实值。
- GitHub token、SSH key、cookie、session、内部账号凭证。
- 发布 token、CLI token、部署 token 列表、历史站点 token。

GitHub Actions 中：

- 机密值放 `secrets`。
- 非敏感配置才放 `vars`。
- `CF_API_TOKEN` 在 Worker 运行时通过 Worker secret 注入。
- `CLOUDFLARE_API_TOKEN` 只用于 Wrangler/GitHub Actions 调用 Cloudflare。

文档中必须使用占位示例，不要写真实 secret。

## API 与 token 规则

v2 以 CLI-managed API 为边界。普通用户和 AI agent 不手写部署 HTTP 请求，也不手写认证 header。

实现或评审 v2 API 时重点检查：

- `apps/pages-api/src/openapi.js` 是开发期 API 合约源码，只服务实现、测试和受控内部集成。
- pages-api 不公开 `/openapi.json`；不要在文档或测试里把它当用户入口。
- 除 `/skill.md`、`/readme.md` 外，管理 API 需要认证并受公司网络 / VPN / 办公网出口 IP allowlist 约束。
- 发布 token、CLI token、cookie、SSO code 和 session 不得出现在响应、日志、文档或截图中。
- 新增公开响应时不得泄露站点 metadata、内部 provider 资源 ID、Cloudflare token 或 runtime capability。
- 同名站点归属检查不能允许用户覆盖他人站点。
- skill、README、API 文档和 CLI help 必须与真实行为同步。

v1 legacy 里 `X-Pages-Token` / `PAGES_TOKEN` 只是旧站点归属标记，不是强认证。修改 `apps/server` 时仍需保证 `/list` 只返回当前 token 名下站点，且不能返回 token 字段。

## 文档规则

- 根 `README.md` 说明项目架构、当前主线和入口，不承载长篇运行手册。
- `docs/README.md` 维护文档索引和真相源矩阵。
- 领域内 README 或主题文档就近维护；需要引用时链接到真相源，不复制长段内容。
- 普通 Markdown 文档尽量控制在 700 行以内；超过时拆分主题文件，并把原路径变成索引。
- `docs/superpowers/` 是历史设计和计划记录，不作为当前行为真相源。
- v1 文档应标注 legacy；新能力不要写回 v1 文档。

## 代码改动原则

- 保持改动小而精确，不做无关重构。
- 复用现有 helper 和项目风格。
- 行为变更必须有 focused `node:test` 覆盖。
- 修改 Cloudflare Worker 部署逻辑时，同时检查 staging 和 production 路径。
- 修改 `apps/pages-api/src/openapi.js` 或 CLI/skill 公开行为时，要同步测试和文档边界。
- 修改 `apps/pages-router` 访问控制时，要确认 `internal`、`org`、`acl`、`owner`、`disabled` 的 fail-closed 行为。
- 修改 `packages/wfp-client` 或子 Worker 生成逻辑时，要确认 static assets、Worker-only、Worker with Assets 的路由语义。
- 不要在代码、测试、文档里写真实敏感域外资源或 secret。

## PR 提交规范

Title 格式：

- 单模块：`<type>(<scope>): <精准中文描述>`
- 跨模块或无明确 scope：`<type>: <精准中文描述>`

`type` 白名单：

- `feat`
- `fix`
- `refactor`
- `perf`
- `chore`
- `docs`
- `test`
- `revert`
- `build`
- `ci`

常用 scope：

- `pages-api`
- `pages-cli`
- `pages-router`
- `pages-auth`
- `pages-skill`
- `server`
- `deploy`
- `docs`
- `ci`
- `demo`
- `gateway`
- `worker`
- `slack-agent`
- `slack-notifier`
- `db`

Title 和 Description 主体使用中文；技术术语、文件名、命令、API 名称、域名保留英文。禁止含糊标题，例如 `fix: bug`、`feat: 优化`、`chore: misc`、`update xxx`。

功能或行为变更的 Description 应包含：

```markdown
## 动机 / 背景

## 改动范围

## 测试路径

## 风险与回滚

## Self-review Checklist

- [ ] Title 符合 `<type>(<scope>): <精准中文描述>`
- [ ] 没有提交 secret、真实 token、真实 `.env` 或本地部署配置
- [ ] staging / production 配置没有串环境
- [ ] `apps/pages-api/src/openapi.js` / skill / README / docs/api-boundary.md 与行为一致
- [ ] 行为变更已有测试覆盖
- [ ] 已跑 `pnpm lint`
- [ ] 已跑 `pnpm test`
```

Bugfix PR 应额外说明：

- Bug 现象
- 复现步骤
- 根因分析
- 修复思路
- 回归测试

## Review guidelines

代码审查优先找 P0/P1 问题，少报风格偏好。

P0：不改不能合。包括：

- secret、token、Cloudflare 资源 id 泄露。
- 用户 token、session 或站点 metadata 跨用户暴露。
- production 会被 push/PR 自动部署。
- staging/prod Worker、KV、D1、route、domain 串环境。
- 站点归属保护失效，允许覆盖别人的站点。
- 部署 API 会删除或覆盖非目标 Worker/route。
- router visibility 或 ACL fail-open。

P1：本 PR 必须修。包括：

- 行为变更缺少测试。
- `apps/pages-api/src/openapi.js` / skill / README / docs/api-boundary.md 与实现不一致。
- IP allowlist、SSO、ACL 或 cookie/header 清洗逻辑绕过。
- GitHub Actions secret/var 用错，导致运行时拿不到必要配置。
- Cloudflare API token 流程混淆：Wrangler token 和 Worker 运行时 `CF_API_TOKEN` 用途混用。
- 错误处理导致 agent/用户拿不到可操作提示。

审查流程：

1. 先检查 PR title/body 是否符合规范。
2. 再看 changed files、diff 和相关调用方，不只看 diff 内部。
3. 重点核对 Cloudflare 部署链路、token/session 数据流、router 访问控制和公开文档。
4. 合并前确认 CI 通过、无 unresolved conversation、无 staging/production 串环境。
5. 需要打回时给出具体文件、行为风险和可操作修改建议。

Codex GitHub review 应使用本节作为重点审查规则。Claude 本地 review 也应遵守相同规则。
