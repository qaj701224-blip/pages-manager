# Site Lifecycle And Naming

## 定位

员工不是网站。一个员工可以有多个 `SiteProject`。本文定义站点 slug、repo path、hostname 和生命周期规则，避免 Slack Agent、Coding Agent、gateway、deploy 和 review 各自猜。

## Slug

`employeeSlug`：

```text
^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$
```

来源优先级：

1. 管理员预配置。
2. 公司 SSO / HR 系统同步。
3. 邮箱前缀转换后人工确认。

`siteSlug`：

```text
^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$
```

规则：

- `employeeSlug` 全局唯一。
- `siteSlug` 在同一个 owner scope 下唯一。
- Slack Agent 可以给 `siteSlug` hint，但 `employeeSlug` 最终由 gateway 根据 Slack 身份派生。
- 修改 `siteSlug` 是 rename 操作，不是普通 update。

Gateway API 创建 `PublishingJob` 时还必须先做 repo path segment guard：`employeeSlug` 和 `siteSlug` 只允许小写字母、数字和连字符，且首尾必须是字母或数字；不能接受 `/`、`.`、路径穿越片段或首尾连字符。API 层 guard 的长度上限跟 `publishing_jobs.employee_slug` / `site_slug` 字段保持一致，最终 SiteProject slug 规则仍以本节产品规则为准。

保留词：

```text
admin
api
assets
auth
login
logout
preview
staging
www
root
system
_next
dist
node_modules
```

## Repo Path

站点源码路径：

```text
sites/<employeeSlug>/<siteSlug>/
```

示例：

```text
sites/zhangsan/profile/
sites/zhangsan/q2-report/
sites/lisi/demo-portal/
```

自动生成 PR 只能修改一个目标目录。

禁止自动修改：

```text
.github/**
apps/**
packages/**
k8s/**
scripts/**
Dockerfile*
sites/<other-employee>/**
sites/<same-employee>/<other-site>/**
```

## Site Name 和 Hostname

默认 site name：

```text
<employeeSlug>-<siteSlug>
```

production hostname：

```text
<siteName>.workers.xd.team
```

preview hostname：

```text
pr-<prNumber>-<siteName>-staging.workers.xd.team
```

冲突处理：

1. 如果 `siteName` 未被占用，直接使用。
2. 如果被占用，gateway 返回冲突，让用户选择新 `siteSlug`。
3. 不自动追加随机后缀，避免用户不理解最终 URL。

## 生命周期

`SiteProject.status`：

```text
active
archived
deleted
```

当前支持重点：

| Action         | 规则                                                      |
| -------------- | --------------------------------------------------------- |
| create         | Slack / API 创建发布任务，确认后进入 issue / PR / preview |
| update         | 默认修改同一个站点目录和同一个 active PR                  |
| archive        | 管理员 / owner 操作，保留历史 deploy                      |
| restore        | 管理员 / owner 操作                                       |
| delete         | 软删除，不立即释放 hostname                               |
| rename         | 显式操作，不能由普通内容修改隐式触发                      |
| transfer owner | 站点管理操作；要求 actor 对源 owner 和目标 owner 都具备站点管理权限 |
| rollback       | 后续通过 `DeployRecord` 实现                              |

## Quota

产品上可以说“一个员工可以有很多网站”，但运行态必须有配额：

```text
max_sites_per_employee: configurable
max_active_jobs_per_site: 1
max_daily_jobs_per_employee: configurable
max_site_source_size_mb: configurable
max_single_file_size_mb: configurable
```

配额超出时：

- gateway 拒绝或排队。
- Slack 给出可操作提示。
- 不创建 issue / PR，直到配额恢复或管理员 override。

## Access Policy 默认值

默认建议：

```text
SiteAccessPolicy.mode = company
```

规则：

- production 内容可以是 `public | company | allowlist`。
- 管理界面始终要求 gateway auth。
- public 内容访问不等于管理权限。
