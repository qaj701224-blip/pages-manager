# Cloudflare Resource Pool

## 决策

Cloudflare 资源必须按平台级资源池设计，不能按员工或站点无限拆分。

禁止的长期模型：

```text
一个站点 = 一个 Worker script + 一个 KV namespace + 一套路由 + 一套配置
```

目标模型：

```text
少量平台级 Edge Worker
  + 少量平台级 KV namespace
  + 平台级 R2 bucket / assets store
  + DB 真相源
  + site_project_id / deploy_id 逻辑隔离
```

原因：

- Cloudflare KV namespace、Worker script、route、assets 等都有账号级或产品级上限。
- `pages-manager` 的产品模型是一个员工可以有多个站点，站点数量不能直接映射为 Cloudflare namespace / Worker 数量。
- 平台应通过资源池、key prefix、hostname routing 和 immutable deploy 隔离站点。

## 平台资源池

按环境拆资源池：

```text
CloudflareResourcePool(production)
  ├─ edge_worker_name: pages-edge-prod
  ├─ config_kv_namespace: PAGES_EDGE_CONFIG_PROD
  ├─ assets_bucket: pages-assets-prod
  ├─ route_pattern: *.workers.xd.team/*
  └─ status: active

CloudflareResourcePool(preview)
  ├─ edge_worker_name: pages-edge-preview
  ├─ config_kv_namespace: PAGES_EDGE_CONFIG_PREVIEW
  ├─ assets_bucket: pages-assets-preview
  ├─ route_pattern: *-staging.workers.xd.team/*
  └─ status: active
```

`CloudflareResourcePool` 建议字段：

```text
id
env: production | preview
account_id_ref
zone_id_ref
edge_worker_name
config_kv_namespace
assets_bucket
route_pattern
status
created_at
updated_at
```

`account_id_ref` / `zone_id_ref` 是内部 secret/config 引用，不在公开文档、日志、PR 中输出真实值。

## 站点绑定

`SiteProject` 不直接拥有 Cloudflare account/token。

```text
SiteProject
  id
  resource_pool_id
  site_name
  hostname
  current_deploy_id
```

`DeployRecord` 记录每次部署：

```text
DeployRecord
  id
  site_project_id
  resource_pool_id
  deploy_id
  environment
  repo_full_name
  pr_number
  merge_commit_sha
  github_delivery_id
  r2_prefix
  manifest_key
  commit_sha
  status
```

production 部署幂等约束：

```text
unique(site_project_id, environment, merge_commit_sha)
```

## KV Key 设计

KV namespace 是平台级，不是每站点一个。

建议 key：

```text
host:<hostname>
  -> { siteProjectId, currentDeployId, accessPolicyVersion }

site:<siteProjectId>:current
  -> <deployId>

deploy:<deployId>:manifest
  -> { files, entrypoint, contentTypes, createdAt }

access:<siteProjectId>:policy
  -> { mode, allowlist, ipRestrict, version }
```

隔离方式：

```text
site_project_id + deploy_id + key prefix
```

不是：

```text
每站点一个 KV namespace
```

## Assets / R2 路径

站点文件使用 immutable deploy 路径：

```text
sites/<siteProjectId>/deploys/<deployId>/index.html
sites/<siteProjectId>/deploys/<deployId>/assets/app.css
sites/<siteProjectId>/deploys/<deployId>/assets/app.js
```

部署只新增 immutable deploy 目录，然后更新 current pointer。

这样即使 KV 存在短暂旧值，也只会继续访问旧版本，不会访问半个新版本。

## Edge Worker 请求链路

```text
GET https://<siteName>.workers.xd.team/path
  ↓
pages-edge-prod
  ↓
读取 host:<hostname>
  ↓
得到 siteProjectId + currentDeployId
  ↓
读取 access:<siteProjectId>:policy
  ↓
执行站点访问策略
  ↓
读取 deploy:<deployId>:manifest
  ↓
从 assets bucket 读取文件
  ↓
返回响应
```

Edge Worker 是多租户站点路由器。

## DB / KV 分工

DB 是真相源：

- `SiteProject`
- `SiteAccessPolicy`
- `DeployRecord`
- `CloudflareResourcePool`
- `PublishingJob`

KV 是边缘运行时快照：

- hostname -> current deploy
- deploy manifest
- access policy cache

规则：

- 不把 KV 当平台真相源。
- 管理端读写先落 DB。
- deploy 成功后再刷新 KV runtime snapshot。
- KV 旧值只能造成短时间旧版本访问，不能造成权限越权或半部署状态。

## 迁移路径

当前可以保留现有一站点一 Worker 的兼容发布能力，但新平台模型必须抽象出 `CloudflareResourcePool`。

建议分两步：

1. **兼容阶段**
   - 保留现有 `apps/server` / `/deploy`。
   - 禁止每站点创建 KV namespace。
   - 记录 `CloudflareResourcePool`、`SiteProject.resource_pool_id`、`DeployRecord`。
   - 增加资源使用监控和配额告警。

2. **平台级 Edge 阶段**
   - 引入 `pages-edge-prod` / `pages-edge-preview`。
   - R2 / assets bucket 存放 immutable deploy 文件。
   - KV 存 runtime snapshot。
   - `/deploy` 变成写资源池的内部 deploy API。
