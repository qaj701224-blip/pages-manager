# Access And Integrations

## Cloudflare

Cloudflare 由平台统一托管：

- 员工不申请 Cloudflare 账号。
- 员工不保存 Cloudflare API token。
- 平台统一管理 Cloudflare account、zone、Edge Worker、Worker route、KV、assets/R2 和 API token。
- 平台为每个 `SiteProject` 分配 `site_name`、hostname、resource pool 和 preview/production URL。
- Cloudflare 资源归属记录在 `SiteProject` 和 `DeployRecord` 中。
- Cloudflare 资源池设计见 [cloudflare-resource-pool.md](./cloudflare-resource-pool.md)。

Cloudflare 高权限 token 只允许进入受控 deployer workflow/job 或 gateway 管理 secret，不进入 coding-agent / builder / site-check。

长期目标不是每站点一套 Worker/KV/route，而是少量平台级 Edge Worker + 平台级 KV/assets 资源池。站点通过 `site_project_id`、`deploy_id`、hostname 和 key prefix 做逻辑隔离。

## 站点访问和管理权限

访问网站内容不等于拥有管理权限。

站点内容访问由 `SiteAccessPolicy` 控制：

```text
mode: public | company | allowlist
```

管理界面访问由 `SiteAdminGrant`、owner scope 或 platform admin role 控制：

```text
role: owner | maintainer | reviewer | viewer
```

规则：

- production 站点可以配置为公网、公司内或 allowlist 访问。
- 管理界面始终走 `pages-gateway` 鉴权。
- 站点内容公开不代表管理界面公开。
- 站点访问策略变更必须走管理权限校验和审计记录。

Edge 执行模型：

| mode | Edge 行为 |
| --- | --- |
| `public` | 直接放行并返回站点内容 |
| `company` | 要求公司网络 IP、Cloudflare Access/SSO 身份，或平台签发的 company access cookie |
| `allowlist` | 校验 signed cookie/JWT、邮箱/用户/群组 allowlist，或 IP/CIDR allowlist |

规则：

- `SiteAccessPolicy` 的真相源在 DB。
- deploy 或策略变更后，gateway 将策略快照写入平台级 KV。
- Edge Worker 使用 KV 快照执行访问判断。
- 对需要强身份的访问，Edge 只能信任 gateway/SSO/Access 签发的短期 token 或 cookie，不能信任 URL 参数。
- 管理权限不在 Edge Worker 判断，管理界面始终回到 `pages-gateway`。

## Slack

Slack bot 全平台统一一个：

- 不为每个员工创建 bot。
- 不为每个站点创建 bot。
- Slack bot token 属于 `scope_type=platform` 的 `IntegrationBinding`。
- Slack bot 负责收集消息和回写进度；需求理解、会话续接和任务创建判断由 `apps/slack-agent` 通过 gateway 完成。
- Slack bot 不能绕过 gateway 权限检查直接创建 PR、合并或部署。

Slack runtime 是 `pages-manager` 的常驻平台服务，组件是 `pages-gateway`、`apps/slack-connector`、`apps/slack-agent` 和 `slack-notifier`；如果保留 `slack-worker`，它只是异步执行器，不是会话真相源。MVP 本地先跑在 K8s 的 `pages-system` namespace，后续服务器沿用同一套控制面部署模型。Slack 平台通过 HTTPS event / command / interaction 打到 `pages-gateway`，gateway 校验签名和幂等后再调用 Slack Agent。详细拓扑见 [slack-runtime.md](./slack-runtime.md)。

Slack event 的真实 actor 必须通过 `ExternalIdentityBinding` 解析到内部 `User` / `Employee`。

另一个 SlackBot 发来的消息只能作为需求来源和证据，不能作为 `requested_by` 身份结论。没有 `TrustedSlackBotPolicy` 或真人确认时，gateway 不能为 bot 消息创建 `PublishingJob`。

## GitHub Enterprise

MVP 的 issue、branch、PR、review、merge 和 webhook 都在公司 GitHub Enterprise 组织 / 团队仓库内闭环。平台使用 GitHub App，不使用个人 PAT。

deploy task 必须绑定：

```text
repo_full_name
pr_number
merge_commit_sha
site_project_id
```

规则：

- GitHub Enterprise webhook 必须校验签名。
- webhook 必须校验 delivery id 幂等、repo allowlist 和 event allowlist。
- webhook delivery 必须写入 `GitHubWebhookDelivery`，唯一约束为 `(repo_full_name, delivery_id)`。
- GitHub App installation token 只按任务短期获取，不能长期写入 DB。
- GitHub App `Contents: write` 是 repo 级能力，不提供 path scope；站点路径隔离由 diff validator、`pages-site-policy`、Rulesets 和 branch prefix 兜底。
- controlled-committer 可以使用 GitHub App installation token 写受控 branch，但不能拿 Slack、Cloudflare、auto-merge 或 production deploy secret。
- production 构建只能来自已记录的 `merge_commit_sha`。
- deploy workflow/job 不能从 floating branch 直接构建 production。
- 重复 webhook 必须幂等。
- 同一 `site_project_id + merge_commit_sha + environment` 只能生成一个有效 `DeployRecord`。

更完整的 GitHub Enterprise 权限、Teams、Rulesets、Actions 和 webhook 设计见 [github-enterprise.md](./github-enterprise.md)。

## Legacy Deploy 收口

现有 `/deploy` 可以作为底层发布能力保留，但不能长期作为绕过 issue / PR / review 的用户入口。

平台化后：

- production deploy 应只允许 `pages-gateway` 或受控 deploy workflow/job 调用。
- 如果保留人工 deploy，需要升级为强认证。
- 人工 deploy 必须绑定 `site_project_id` 和 `publishing_job_id`。
- 所有 deploy 都必须写审计。
- 旧 `X-Pages-Token` 只能作为兼容归属标记，不作为新平台强认证。
