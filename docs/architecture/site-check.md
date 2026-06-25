# Site Check

## 定位

`site-check` 是员工站点 PR 的确定性门禁。它不是 Slack Agent、Coding Agent 或 GitHub Review Agent。

它回答：

```text
这个 PR 是否只修改授权站点目录，并且没有 secret、越界文件或构建问题？
```

## 当前实现边界

当前 workflow：

```text
.github/workflows/site-check.yml
```

gateway 通过 GitHub `check_run` webhook 记录 `site_check_runs`，再和 Review Agent gate 一起决定是否可以 preview。

`Platform CI` 是 Platform Dev Lane 的平台 PR 检查，不属于 Site Publishing Lane 的 site-check。gateway 可以消费 `Platform CI` 来推进平台任务，但不能把它写成站点 PR 的 site-check 通过记录，也不能用它放行站点 preview。二者的 check name 和 GitHub App allowlist 也必须分开配置，避免收紧 site-check app 后误伤平台 PR CI。

`GITHUB_SITE_CHECK_NAMES`、`GITHUB_PLATFORM_CI_CHECK_NAMES` 和对应 `*_APP_LOGINS` 按逗号分隔完整 check / app 名称；名称里的空格或 `/` 是名称本身的一部分，不能再按空白拆分。Platform CI 默认同时接受 workflow 展示名 `Platform CI` 和当前 job context `check`。Node/ECS gateway 运行时必须把这些配置透传进 gateway env，否则 webhook 会按默认 check / app 名称判定。

## 必跑检查

| Check                | 说明                                                                                |
| -------------------- | ----------------------------------------------------------------------------------- |
| path allowlist       | diff 只能包含目标 `sites/<employeeSlug>/<siteSlug>/`                                |
| platform path block  | 禁止修改 `.github/**`、`apps/**`、`packages/**`、`k8s/**`、`scripts/**`、Dockerfile |
| single site scope    | 一个 PR 只能修改一个员工的一个站点                                                  |
| marker / job binding | PR 必须能绑定 `PublishingJob`、issue、allowed path                                  |
| secret scan          | 不允许 token、private key、cookie、`.env` 明文进入 PR                               |
| file policy          | 禁止构建产物、大文件、`node_modules/**`、缓存和越界 symlink                         |
| build / validation   | 站点 schema、lint、test、build 或等价校验                                           |

`pages-agent.yml` 在创建 PR 前可以做 precheck，但 PR 上仍必须由 `site-check.yml` 在 PR head SHA 上重新跑。

## Preview Gate

Preview 前必须满足：

```text
site-check passed
PR head SHA == SiteCheckRun.head_sha
PR only touches allowedPath
no open blocking ReviewAgentComment
no open unknown ReviewAgentComment
no active pages-agent fix round
```

site-check 失败时不发布 preview。Review Agent suggestion / note 可以放行，但需要在 Slack 状态里提示。`issue_comment` 类型的 Review Agent 汇总如果没有 `Reviewed commit` 标记，且 job 已绑定 `headSha`，note / suggestion 只记录评论，不据此触发 Preview；blocking / unknown 必须保守阻塞当前 head。带 7-40 位 commit 前缀的评论才会按对应 head 参与 gate。

## Secret 边界

`site-check.yml` 不能读取：

- Slack bot token
- Cloudflare production token
- GitHub App private key
- ACR / ACK / kubectl 权限
- auto-merge token

Coding Agent 也不能通过修改 `site-check.yml` 或平台代码来绕过规则。
