# GitHub Runtime Config

## 定位

本文记录 `pages-manager` 在 GitHub 仓库侧依赖的 runtime 配置，包括 GitHub Actions secrets、repository variables 和 repository webhooks。

凡是通过 `gh secret set`、`gh variable set`、`gh api repos/.../hooks`、GitHub UI 或其它方式修改这些配置，都必须在同一轮变更中更新本文。

## 记录规则

- 只记录 secret 名称、用途、值来源和适用环境，不记录 secret 明文。
- 不在文档中写真实 token、callback token、webhook secret、GitHub token、Cloudflare token。
- 临时公网 tunnel URL 不直接固化在文档中；记录为 `PAGES_GATEWAY_PUBLIC_URL` 的当前 origin。
- 每次改动都要在“变更记录”中写明日期、修改项、原因和验证路径。
- 如果配置来自本地 `.env`，只写变量名，不写变量值。

## 当前 MVP 配置

仓库：

```text
xindong/pages-manager
```

### Secrets

| Secret | 值来源 | 用途 | 备注 |
| --- | --- | --- | --- |
| `PAGES_CALLBACK_TOKEN` | 本地 `.env` 的 `INTERNAL_CALLBACK_TOKEN`，fallback 为 `PAGES_CALLBACK_TOKEN` | GitHub Actions executor callback 到 gateway 时使用 | 必须与 `pages-gateway` runtime 的 `INTERNAL_CALLBACK_TOKEN` 一致 |
| `PAGES_GITHUB_APP_TOKEN` | 本地 `.env` 的 `GITHUB_APP_INSTALLATION_TOKEN`，fallback 为 `GITHUB_TOKEN` | `pages-agent.yml` 创建 / 更新受控 branch 和 PR | MVP 可用平台 token；长期应换 GitHub App installation token |
| `PAGES_PREVIEW_TOKEN` | 本地 `.env` 的 `PAGES_PREVIEW_TOKEN`，fallback 为 `PAGES_TOKEN` | `pages-preview.yml` 或本地 preview deploy 兼容现有 `/deploy` 的 owner marker | 不是员工 Cloudflare token；长期应换 job / owner-scope 受限 deploy identity |
| `AGENT_CODE_API_KEY` | 本地 `.env` 的 `AGENT_CODE_API_KEY` | `pages-agent.yml` 在 Actions runner 中调用公司 OpenAI-compatible 网关生成站点代码 | 只允许 Coding Agent 使用，不能注入 Slack Agent、preview deploy 或站点页面 |

### Repository Variables

| Variable | 值来源 | 用途 | 备注 |
| --- | --- | --- | --- |
| `PAGES_CALLBACK_ALLOWED_ORIGINS` | `origin(PAGES_GATEWAY_PUBLIC_URL)` | callback helper 发送 token 前校验目标 origin | 本地 quick tunnel 变化时必须同步更新 |
| `PAGES_GATEWAY_CALLBACK_URL` | `${PAGES_GATEWAY_PUBLIC_URL}/internal/executor-callback` | gateway / worker dispatch `pages-agent.yml` 时传入 callback URL | 手动 dispatch 时也可作为 fallback |
| `PAGES_BASE_REF` | 本地 `.env` 的 `PAGES_BASE_REF` | `pages-agent.yml` checkout 和 PR base fallback | MVP 默认 `staging` |
| `AGENT_GATEWAY_URL` | 本地 `.env` 的 `AGENT_GATEWAY_URL` | `pages-agent.yml` 调用公司 OpenAI-compatible 网关 | 非 secret，但不要写进公开日志 |
| `AGENT_MODEL_NAME` | 本地 `.env` 的 `AGENT_MODEL_NAME` | `pages-agent.yml` 传给公司模型网关的 router/model 名 | 可为空 |
| `PAGES_API` | 本地 `.env` 的 `PAGES_API` | preview workflow 调用 pages-manager `/deploy` | MVP 当前指向 staging API |

### Repository Webhook

| 项 | 配置 |
| --- | --- |
| URL | `${PAGES_GATEWAY_PUBLIC_URL}/integrations/github/webhook` |
| Content type | `json` |
| Active | `true` |
| Secret | 本地 `.env` 的 `GITHUB_WEBHOOK_SECRET` |
| Events | `issues`, `check_run`, `issue_comment`, `pull_request_review`, `pull_request_review_comment` |

Webhook 用途：

- 接收平台 issue 的 `opened` / `edited` / `reopened` 事件，gateway 校验 `PublishingJob` 关联后启动受控 `pages-agent.yml`。
- 接收 GitHub Review Agent 在 PR 上的 issue comment / review / inline comment。
- 接收 required check / site-check 相关 `check_run` 事件。
- 由 `pages-gateway` 校验签名、记录 delivery 幂等，并推进 preview gate。

## 本地 Smoke 配置约束

本地 K8s smoke 当前推荐：

```text
PAGES_WORKFLOW_REF=feat/slack-preview-gateway-mvp
PAGES_BASE_REF=staging
PAGES_PREVIEW_MODE=local_deploy
PAGES_PREVIEW_SITE_NAME_PATTERN=pm-{publishingJobId}
```

说明：

- `PAGES_WORKFLOW_REF` 指 workflow 文件读取分支。
- `PAGES_BASE_REF` 指生成 PR 的目标分支。
- `local_deploy` 用本地 K8s `pages-worker` 从 PR head 读取站点文件并调用 `PAGES_API/deploy`，避免 GitHub-hosted runner 出口 IP 被 staging API 白名单挡住。
- preview site name 必须包含 `publishingJobId`，否则 smoke 模式复用同一个 PR 时会撞站点名。

## 变更记录

### 2026-06-12 本地 Slack 到 Preview MVP

更新方式：

```text
gh secret set ...
gh variable set ...
gh api repos/xindong/pages-manager/hooks/... --method PATCH
```

更新项：

- 写入 / 对齐 `PAGES_CALLBACK_TOKEN`，修复 GitHub Actions callback 返回 `Invalid callback token`。
- 写入 / 对齐 `PAGES_GITHUB_APP_TOKEN`，供 `pages-agent.yml` 创建或更新 PR。
- 写入 / 对齐 `PAGES_PREVIEW_TOKEN`，供 preview deploy 兼容现有 `/deploy` owner marker。
- 写入 / 对齐 `PAGES_CALLBACK_ALLOWED_ORIGINS`，值为当前 `PAGES_GATEWAY_PUBLIC_URL` 的 origin。
- 写入 / 对齐 `PAGES_API`，供 preview workflow 或本地 preview deploy 使用。
- 更新 repo webhook：
  - URL 指向当前 `PAGES_GATEWAY_PUBLIC_URL` 下的 `/integrations/github/webhook`。
  - Events 设置为 `check_run`、`issue_comment`、`pull_request_review`、`pull_request_review_comment`。
  - Webhook secret 来源为 `GITHUB_WEBHOOK_SECRET`。

验证路径：

```text
Slack event
  -> pages-gateway
  -> GitHub issue
  -> GitHub issues webhook
  -> pages-gateway validates issue and dispatches pages-agent.yml
  -> pages-agent.yml uses AGENT_CODE_API_KEY
  -> PR
  -> GitHub Review Agent comment
  -> GitHub webhook
  -> local K8s pages-worker local_deploy
  -> preview_deployed
```

验证结果：

- GitHub issue 复用 smoke issue。
- GitHub PR 复用 smoke PR。
- Review Agent comment 通过 webhook 触发 preview gate。
- 本地 K8s `pages-worker` 成功生成 staging preview URL。

### 2026-06-13 Issue webhook 到 Coding Agent PR

更新项：

- 新增 `AGENT_CODE_API_KEY` secret，供 `pages-agent.yml` 的 Coding Agent 调用公司模型网关。
- 新增 / 对齐 `AGENT_GATEWAY_URL`、`AGENT_MODEL_NAME`、`PAGES_GATEWAY_CALLBACK_URL`、`PAGES_BASE_REF` repository variables。
- `pages-gateway` 增加 `issues.opened/edited/reopened` webhook 处理；GitHub issue 创建后先回到 gateway，再由 gateway / worker 启动 `pages-agent.yml`。

验证路径：

```text
Slack / API
  -> worker creates GitHub issue with PublishingJob marker
  -> GitHub issues webhook
  -> gateway dispatches pages-agent.yml
  -> scripts/pages-agent-coding.mjs uses AGENT_CODE_API_KEY
  -> controlled branch
  -> PR
```
