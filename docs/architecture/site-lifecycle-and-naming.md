# Site Lifecycle And Naming

## 定位

员工不是网站。一个员工可以有多个 `SiteProject`。

本文件定义 MVP 站点命名、目录、hostname、生命周期和冲突处理，避免 coding agent、gateway、deploy 和 review 各自猜规则。

## Slugs

### `employee_slug`

MVP 格式：

```text
^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$
```

来源优先级：

1. 管理员预配置。
2. 公司 SSO / HR 系统同步。
3. 邮箱前缀转换后人工确认。

规则：

- 全局唯一。
- 不随展示名变化自动变更。
- 离职后默认保留，不立即释放。

### `site_slug`

MVP 格式：

```text
^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$
```

规则：

- 在同一个 `owner_scope_id` 下唯一。
- 不允许使用保留词。
- 修改 `site_slug` 是 rename 操作，不是普通 update。

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
sites/<employee_slug>/<site_slug>/
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
templates/**
k8s/**
sites/<other-employee>/**
sites/<same-employee>/<other-site>/**
```

## Site Name And Hostname

默认 `site_name`：

```text
<employee_slug>-<site_slug>
```

production hostname：

```text
<site_name>.workers.xd.team
```

preview hostname：

```text
pr-<prNumber>-<site_name>-staging.workers.xd.team
```

冲突处理：

1. 如果 `site_name` 未被占用，直接使用。
2. 如果被占用，gateway 返回冲突，让用户选择新 `site_slug`。
3. 不自动追加随机后缀，避免用户不理解最终 URL。

## Lifecycle States

`SiteProject.status`：

```text
active
archived
deleted
```

MVP 支持：

| Action | MVP |
| --- | --- |
| create | yes |
| update | yes |
| archive | manual/admin |
| restore | manual/admin |
| delete | soft delete only |
| rename | manual/admin, creates PR |
| transfer owner | manual/admin |
| rollback | manual deploy record rollback later |

## Create Site

Input:

```json
{
  "employeeSlug": "zhangsan",
  "siteSlug": "profile",
  "title": "Zhangsan Profile",
  "accessMode": "company"
}
```

Flow:

```text
gateway validates actor
  ↓
checks owner scope and quota
  ↓
checks slug and hostname conflict
  ↓
creates SiteProject(status=active)
  ↓
creates PublishingJob(intent=create_site)
  ↓
issue → project index → pages-agent → PR → review → preview deploy
```

If site creation fails before Preview:

- `SiteProject` can remain `active` with no deploy, or be marked `archived` by cleanup.
- `PublishingJob` records failure.

## Update Site

Update means content or config changes under same `site_slug`.

Rules:

- Must target existing active `SiteProject`.
- Actor must have `owner | admin | maintainer`.
- PR modifies only `repo_path`.
- deploy updates `current_deploy_id`.

## Archive Site

Archive means site is hidden from normal update flow but historical deploy remains auditable.

Rules:

- Requires owner/admin.
- Does not delete Git history.
- Can optionally disable production route in Cloudflare snapshot.
- New publishing jobs should be rejected unless action is `restore_site`.

## Delete Site

MVP uses soft delete:

```text
status=deleted
deleted_at=<time>
```

Rules:

- Requires owner/admin plus optional platform admin confirmation.
- Does not immediately release hostname.
- Does not delete historical `DeployRecord`.
- Cloudflare runtime snapshot can serve tombstone or 404.

## Rename Site

Rename changes `site_slug`, `repo_path`, `site_name`, hostname.

MVP recommendation:

- Do not allow automatic agent rename in normal content update.
- Require explicit admin/owner action.
- Create PR that moves directory.
- Keep redirect from old hostname only if configured.

Rename flow:

```text
validate new slug
  ↓
check hostname conflict
  ↓
create rename PublishingJob
  ↓
PR moves sites/<employee>/<old> to sites/<employee>/<new>
  ↓
merge
  ↓
deploy new hostname
  ↓
mark old hostname redirect/tombstone
```

## Transfer Owner

Transfer moves site between owner scopes.

MVP recommendation:

- Admin-only.
- Not part of Slack auto-generation.
- Requires audit reason.
- May create PR if repo path changes.

## Quotas

Even if product language says “一个员工可以有无数个网站”， implementation must have operational quotas.

MVP default suggestions:

```text
max_sites_per_employee: configurable
max_active_jobs_per_site: 1
max_daily_jobs_per_employee: configurable
max_site_source_size_mb: configurable
max_single_file_size_mb: configurable
```

Quota exceeded:

- gateway rejects or queues request.
- Slack returns actionable message.
- no issue/PR created until quota passes or admin overrides.

## Access Policy Defaults

MVP default:

```text
SiteAccessPolicy.mode = company
```

Rules:

- production site content can be `public | company | allowlist`.
- management UI always requires gateway auth.
- public content access never implies management permission.

## Implementation Order

1. Implement slug validators and reserved words.
2. Add `SiteProject` unique checks.
3. Add path derivation helper.
4. Add hostname derivation helper.
5. Add create/update lifecycle methods.
6. Add archive/restore admin methods.
7. Add quota checks before `PublishingJob` creation.
8. Add tests for slug, path, hostname and conflict cases.
