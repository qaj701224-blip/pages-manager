# Access And Integrations

## Cloudflare

Cloudflare 由平台统一托管：

- 员工不申请 Cloudflare 账号。
- 员工不保存 Cloudflare API token。
- 平台统一管理 account、zone、Worker、route、KV、assets/R2 和 API token。
- 站点通过 `site_project_id`、`deploy_id`、hostname 和 key prefix 做逻辑隔离。

Cloudflare 高权限 token 只能进入受控 deployer / Worker secret，不能进入 Slack Agent、Coding Agent、site-check 或用户生成页面。

当前 preview 可以由 `pages-worker` 以 `local_deploy` 模式调用 staging `/deploy`。GitHub-hosted runner 不直接调用 `/deploy`，避免动态出口 IP 进入 Cloudflare staging 白名单。

## 站点访问和管理权限

访问网站内容不等于拥有管理权限。

站点内容访问：

```text
SiteAccessPolicy.mode = public | company | allowlist
```

站点管理权限：

```text
SiteAdminGrant.role = owner | maintainer | reviewer | viewer
```

规则：

- production 站点可以公网、公司内或 allowlist 访问。
- 管理界面始终走 `pages-gateway` 鉴权。
- 站点内容公开不代表管理界面公开。
- 站点访问策略变更必须写审计。

## Slack

Slack bot 全平台统一一个：

- 不为每个员工创建 bot。
- 不为每个站点创建 bot。
- Slack Events / Interactivity 进入 `pages-gateway`。
- `apps/slack-agent` 负责对话理解。
- `apps/slack-notifier` 负责 Slack Web API 输出。

Slack runtime 是 `pages-manager` 的常驻平台服务，组件是 `pages-gateway`、`apps/slack-agent` 和 `apps/slack-notifier`。Slack 平台通过 HTTPS event / interaction 打到 `pages-gateway`，gateway 校验签名和幂等后再调用 Slack Agent。详细拓扑见 [slack-platform-runtime.md](./slack-platform-runtime.md)。

Slack bot 不能绕过 gateway 创建 PR、合并或部署。Slack actor 必须通过 `(team_id, slack_user_id)` 绑定到内部用户 / 员工身份。

## GitHub

GitHub 规则统一见 [github-automation.md](./github-automation.md)。

当前核心边界：

- issue、PR、review、site-check、webhook 都在 `xindong/pages-manager` 闭环。
- 用户不需要 repo 写权限也可以通过 Slack 发起任务。
- GitHub 写操作来自平台身份。
- 自动站点 PR 只能改 `sites/<employeeSlug>/<siteSlug>/`。
- GitHub webhook 必须验签并写入 MySQL 幂等表。

## Legacy Deploy 收口

现有 `/deploy` 可以作为底层发布能力保留，但不能作为绕过 issue / PR / Review gate 的用户入口。

平台化后：

- production deploy 应只允许 gateway / worker / 受控 workflow 触发。
- 人工 deploy 必须强认证。
- deploy 必须绑定 `site_project_id` / `publishing_job_id`。
- `X-Pages-Token` 只能作为兼容归属标记，不是新平台强认证。
