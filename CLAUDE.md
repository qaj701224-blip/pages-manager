# pages-manager

本文件同时面向 Codex、Claude 和其它 coding agent。`AGENTS.md` 与 `CLAUDE.md` 必须保持一致；修改其中任意一份时，同一个 PR 里必须同步另一份。

## 项目概览

`pages-manager` 是基于 Cloudflare Workers 的内部站点发布服务，用于把静态站点、SPA 或自定义 Worker 发布到 `workers.xd.team` 域名下。

核心目录：

- `apps/server/src/`：管理 API Worker 源码
- `apps/server/src/handlers/`：路由处理器
- `apps/server/src/lib/`：Cloudflare API、IP 白名单、公开配置等共享逻辑
- `.github/workflows/`：CI、staging 和 production 部署流程
- `pages-deploy.skill.md`、`API.md`、`README.md`：供用户和 agent 使用的公开说明

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

不要把 `.env`、`.staging.env`、`apps/server/wrangler.toml`、`apps/xdads-302/wrangler.toml`、demo 目录里的 `.pages.json` 提交到 Git。

## 分支与部署

- `master`：生产真相源，feature / fix / ci / build 等项目类 PR 默认直接合入这里；合并后不自动部署
- `staging`：共享 preview 分支，用于提前部署和验证指向 `master` 的项目类 PR；不是晋级来源
- 生产部署必须人工在 GitHub Actions 中手动触发 `Deploy Production`

分支整理规则：

- 默认流向是 `feature branch -> PR to master -> sync to staging preview -> merge to master`
- 不要从 `staging` 向 `master` 发起晋级 PR；`staging` 可能包含尚未合入 `master` 的其它 PR 代码
- 如果项目类 PR 直接提交到 `master`，`Sync Master PR To Staging` workflow 必须在 PR ready 后把 PR head 提前 merge 到 `staging`，并显式 dispatch `Deploy Staging` 做预览验证；纯 `sites/**` 用户站点 PR 跳过这条同步
- `staging` 被废弃 PR 污染时，由维护者确认没有活跃 preview 后重新对齐 `master`，再重新触发需要验证的 PR
- 不要双向随意 cherry-pick 多个 workflow / k8s commit，避免把 preview-only 代码带入主线

部署隔离要求：

- staging Worker：`pages-manager-staging`
- production Worker：`pages-manager`
- staging API：`https://api-staging.workers.xd.team`
- production API：`https://api.workers.xd.team`
- staging 子站域名后缀：`-staging.workers.xd.team`
- production 子站域名：`workers.xd.team`
- staging 子 Worker 前缀：`pages-staging-`
- production 子 Worker 前缀：`pages-`

CI/CD 隔离要求：

- 平台本体部署包括 `deploy-staging.yml`、`deploy.yml`、`deploy-ack-preview.yml`，只能构建 / 部署平台 Worker、ACK 镜像和 K8s Deployment
- 用户站点发布执行器包括 `project-index.yml`、`pages-agent.yml`、`pages-preview.yml`、`site-check.yml`，只能处理 `PublishingJob`、`sites/<employee>/<site>/`、生成 PR 和 preview
- 用户站点发布 workflow 禁止使用 Aliyun AK、ACR、`KUBE_CONFIG_B64`、`kubectl`、production Wrangler token 或 ACK namespace 权限
- 自动生成的 `sites/**` PR 不得修改 `.github/**`、`apps/**`、`packages/**`、`k8s/**`、`scripts/**`、Dockerfile 或部署文档

改动 GitHub Actions 时，必须确认不会让 production 在 push/PR 时自动部署。
详细分支和发布规则见 `docs/deployment-branch-policy.md`。

## 敏感信息规则

这是 public repo 标准的代码库。禁止提交或公开输出：

- Cloudflare API token、account id、zone id、KV namespace id 的真实值
- 任何 `.env` 中的真实值
- GitHub token、SSH key、cookie、session、内部账号凭证
- 真实用户 token、部署 token 列表、历史站点 token

GitHub Actions 中：

- 机密值放 `secrets`
- 非敏感配置才放 `vars`
- `CF_API_TOKEN` 在 Worker 运行时通过 Worker secret 注入
- `CLOUDFLARE_API_TOKEN` 只用于 Wrangler/GitHub Actions 调用 Cloudflare

文档中必须使用占位示例，不要写真实 secret。

## API 与 token 规则

`X-Pages-Token` / `PAGES_TOKEN` 是站点归属标记，不是强认证。

实现或评审 API 时重点检查：

- `/list` 必须携带 token，只能返回当前 token 名下站点，且不能返回 token 字段
- 新增公开响应时不得泄露站点 metadata 里的 token
- 同名站点归属检查不能允许用户覆盖其它 token 创建的站点
- 管理 API 除 `/openapi.json`、`/skill.md`、`/readme.md` 外受 IP 白名单保护
- `openapi.json`、`skill.md` 这类动态下发内容不得返回旧环境的 API 地址
- OpenAPI、skill、README、API 文档必须与真实行为同步

## 代码改动原则

- 保持改动小而精确，不做无关重构
- 复用现有 helper 和项目风格
- 行为变更必须有 focused `node:test` 覆盖
- 修改 Cloudflare Worker 部署逻辑时，同时检查 staging 和 production 路径
- 修改 `openapi.js` 的公开 spec 或脚本时，要验证 staging 会动态替换 API/domain
- 修改 `cf-api.js` 子 Worker 生成逻辑时，要确认 static/spa/worker 三种 preset 的 IP 限制行为
- 不要在代码、测试、文档里写真实敏感域外资源或 secret

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

- `server`
- `openapi`
- `deploy`
- `skill`
- `docs`
- `ci`
- `demo`

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
- [ ] OpenAPI / skill / README / API.md 与行为一致
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

- secret、token、Cloudflare 资源 id 泄露
- 用户 token 或站点 metadata 跨用户暴露
- production 会被 push/PR 自动部署
- staging/prod Worker、KV、route、domain 串环境
- 站点归属保护失效，允许覆盖别人的站点
- 部署 API 会删除或覆盖非目标 Worker/route

P1：本 PR 必须修。包括：

- 行为变更缺少测试
- OpenAPI / skill / README / API.md 与实现不一致
- IP 白名单逻辑绕过或 worker preset 未说明调用方式
- GitHub Actions secret/var 用错，导致运行时拿不到必要配置
- Cloudflare API token 流程混淆：Wrangler token 和 Worker 运行时 `CF_API_TOKEN` 用途混用
- 错误处理导致 agent/用户拿不到可操作提示

审查流程：

1. 先检查 PR title/body 是否符合规范。
2. 再看 changed files、diff 和相关调用方，不只看 diff 内部。
3. 重点核对 Cloudflare 部署链路、token 数据流和公开文档。
4. 合并前确认 CI 通过、无 unresolved conversation、无 staging/production 串环境。
5. 需要打回时给出具体文件、行为风险和可操作修改建议。

Codex GitHub review 应使用本节作为重点审查规则。Claude 本地 review 也应遵守相同规则。
