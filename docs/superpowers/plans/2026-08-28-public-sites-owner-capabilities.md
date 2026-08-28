# Public Sites Owner 与部署能力实施计划

> 对应设计：`docs/superpowers/specs/2026-08-27-public-sites-api-design.md`

**Goal:** 在现有 `GET /.xd-pages/api/public/sites` 响应中安全增加 Owner 展示名、当前用户直接归属标记和当前凭证部署能力，供 Cindy `xd-sites` 展示归属并控制操作入口。

**Architecture:** 保持现有认证、结果集、分页和 router 不变。Public Sites repository 在单条 D1 查询中增加 Owner user/team 展示字段和当前 viewer 的有效团队角色，只把部署鉴权所需的 `ownerId`、`ownerUserId`、`managementRole` 留在 Store→handler 内部记录；handler 复用真实部署入口的 `actorCanDeploySite()`，最终 response mapper 严格裁掉内部 ID、邮箱、部门路径和 team role。OpenAPI 和边界文档将 `canDeploy` 定义为 point-in-time UI hint，部署入口仍重新鉴权。

**Tech Stack:** Cloudflare Workers、D1/SQLite、JavaScript ESM、Node.js `node:test`、OpenAPI 3.1 source contract。

## 范围

- Modify: `apps/pages-api/src/infrastructure/store/repositories/public-sites-repository.js`
- Modify: `apps/pages-api/src/infrastructure/store/row-mappers/public-sites.js`
- Modify: `apps/pages-api/src/transport/public/public-sites-handler.js`
- Modify: `apps/pages-api/src/public-sites.test.js`
- Modify: `apps/pages-api/src/connection-auth.test.js`
- Modify: `apps/pages-api/src/openapi.js`
- Modify: `apps/pages-api/src/openapi.test.js`
- Modify: `docs/api-boundary.md`
- Modify: `docs/architecture/xd-cell-console.md`
- Modify: `scripts/public-docs.test.js`
- Modify: `scripts/pages-v2-docs.test.js`

不修改 schema/migration、router、认证协议、部署授权 helper、CLI 或 pages-skill。

## Task 1：扩展 Store 内部 Owner 与团队角色投影

### Step 1：先写 Store 失败测试

在 `apps/pages-api/src/public-sites.test.js` 扩展真实 SQLite-backed D1 测试，锁定内部 record：

```js
{
  ...existingFields,
  ownerType: 'user',
  ownerId: 'usr_owner',
  ownerUserId: 'usr_owner',
  ownerDisplayName: '张三',
  managementRole: null,
}
```

覆盖：

- 个人 Owner 有非空 `realname` 时只返回规范化展示名；仅有 email 或空白 realname 时为 `null`。
- custom team 返回 team name；department team 返回不含完整部门路径的安全叶名称。
- 当前 viewer 为 team publisher/admin 时保留对应 `managementRole`；viewer、未知角色、removed membership 都映射为 `null`。
- 既有多 ACL、多可访问关系去重和 keyset 顺序不变。
- 不改变详细 spec 已锁定的个人 Owner 入选语义；姓名缺失不排除 active 站点。

Run:

```bash
node --test apps/pages-api/src/public-sites.test.js
```

Expected: FAIL，缺少新增内部字段。

### Step 2：扩展单 SQL 查询

在 Public Sites CTE 中：

- 选择 `sites.owner_id`、`sites.owner_user_id`。
- `LEFT JOIN users AS owner_users` 读取个人 Owner `realname`。
- `LEFT JOIN` 同环境、active、未删除的 owner team，复用该 join 完成现有有效团队门禁。
- `LEFT JOIN team_members`，限定 `team_id = sites.owner_id`、`user_id = viewer_users.user_id`、`removed_at IS NULL`。
- 用 `CASE WHEN role IN ('publisher', 'admin') THEN role ELSE NULL END` 白名单化 `management_role`。
- ACL 继续使用 `EXISTS`，不得直接 JOIN，避免多 ACL 产生重复行。
- 同步 `PUBLIC_SITE_COLUMNS`，确保 cursor 前后两个查询投影一致。

所有新增 join 都命中现有唯一键，不新增 index 或 migration。

### Step 3：扩展安全 row mapper

`mapPublicSite()` 增加：

```js
ownerId: row.owner_id || row.owner_user_id,
ownerUserId: row.owner_user_id,
ownerDisplayName,
managementRole: row.management_role || null,
```

个人展示名只接受 trim 后非空的 `realname`，不得回退 email/ID。custom team 只使用非空 name；department team 使用 `deriveDepartmentTeamIdentity(departmentPath || name).displayName` 派生安全叶名称，禁止调用可能输出完整部门路径的 Console display helper。team 原始 name/type/department path 不离开 row mapper。

### Step 4：验证 Store

Run:

```bash
node --test \
  apps/pages-api/src/public-sites.test.js \
  apps/pages-api/src/store-contract.test.js
```

Expected: PASS。

## Task 2：输出直接归属与真实部署能力

### Step 1：先写 HTTP 失败测试

在 `apps/pages-api/src/public-sites.test.js` 增加精确响应与 credential × relationship 矩阵：

| 关系 / 凭证 | `owner.isCurrentUser` | `permissions.canDeploy` |
| --- | ---: | ---: |
| 个人 Owner + CLI login | `true` | `true` |
| 个人 Owner + Cindy assertion | `true` | `true` |
| 个人 Owner + read-only PAT | `true` | `false` |
| 个人 Owner + 普通 `*` PAT | `true` | `false` |
| 个人 Owner + `read:site,deploy:site` PAT | `true` | `true` |
| team publisher/admin + 可部署凭证 | `false` | `true` |
| team viewer 或仅 visibility/ACL 可访问 | `false` | `false` |

精确断言：

- `owner` 只有 `type`、`displayName`、`isCurrentUser`。
- `permissions` 只有 `canDeploy`。
- response 不包含 owner ID/email、team role、department path 或 team 原始 metadata。
- deploy-only key 仍在目录入口返回 403，不产生目录项。

### Step 2：复用权威部署授权 helper

在 handler 中 import `actorCanDeploySite`，让 mapper 接收完整 `auth.actor`：

```js
owner: {
  type: site.ownerType,
  displayName: site.ownerDisplayName,
  isCurrentUser:
    site.ownerType === 'user' &&
    (site.ownerId || site.ownerUserId) === actor.userId,
},
permissions: {
  canDeploy: actorCanDeploySite(actor, site, 'deploy:site'),
},
```

不得使用 `actorCanManageSite()` 或在 Public handler 复制一套角色/scope 判断。普通个人 `*` PAT 按当前权威 helper 返回 `false`；CLI login 认证后是 user actor，按 Owner/团队角色返回真实结果。

`canDeploy` 只是当前请求时刻的 UI hint；不得改变部署入口或跳过后续鉴权。

### Step 3：扩展 Cindy assertion E2E

在 `apps/pages-api/src/connection-auth.test.js`：

- 增加 Cindy 用户拥有的个人站点，断言安全 Owner 名、`isCurrentUser=true`、`canDeploy=true`。
- 保留非本人 org 站点并断言 `false/false`。
- 保留伪造 role/department claim trap，证明能力来自权威 Store 关系而不是 assertion 附加 claim。

### Step 4：运行 runtime focused tests

Run:

```bash
node --test \
  apps/pages-api/src/public-sites.test.js \
  apps/pages-api/src/connection-auth.test.js \
  apps/pages-api/src/domain/sites/authorization.test.js \
  apps/pages-api/src/transport/public/public-sites-handler.test.js
```

Expected: PASS。

Commit:

```bash
git add \
  apps/pages-api/src/infrastructure/store/repositories/public-sites-repository.js \
  apps/pages-api/src/infrastructure/store/row-mappers/public-sites.js \
  apps/pages-api/src/transport/public/public-sites-handler.js \
  apps/pages-api/src/public-sites.test.js \
  apps/pages-api/src/connection-auth.test.js
git commit -m "feat(pages-api): 返回 Public Sites 归属与部署能力"
```

## Task 3：同步 OpenAPI 和文档边界

### Step 1：先更新合约测试

`apps/pages-api/src/openapi.test.js` 锁定：

- `PublicSiteOwner.required = ['type', 'displayName', 'isCurrentUser']`，`displayName` 为 `string|null`。
- 新增 closed schema `PublicSitePermissions`，required 只有 `canDeploy:boolean`。
- `PublicSite` required/properties 精确增加 `permissions`。
- operation 描述说明 Owner 展示名最小披露、`canDeploy` 是当前凭证提示且部署会重新鉴权。

### Step 2：更新 OpenAPI source

在 `apps/pages-api/src/openapi.js` 实现上述 schema，所有对象继续 `additionalProperties:false`。不得暴露 owner email/ID、department path 或 team role。

### Step 3：同步边界文档与文档测试

更新：

- `docs/api-boundary.md`
- `docs/architecture/xd-cell-console.md`
- `scripts/public-docs.test.js`
- `scripts/pages-v2-docs.test.js`

把旧的“只返回 `owner.type`”改为：返回安全 Owner 展示名、个人直接归属标记和当前凭证部署能力；仍不返回 owner email/内部 ID、部门路径、team role、ACL、route/version/runtime/provider metadata。明确 `canDeploy` 不替代部署入口重新鉴权。

### Step 4：运行合约和文档测试

Run:

```bash
node --test \
  apps/pages-api/src/openapi.test.js \
  scripts/public-docs.test.js \
  scripts/pages-v2-docs.test.js \
  tests/pages-api-architecture.test.js
```

Expected: PASS。

Commit:

```bash
git add \
  apps/pages-api/src/openapi.js \
  apps/pages-api/src/openapi.test.js \
  docs/api-boundary.md \
  docs/architecture/xd-cell-console.md \
  scripts/public-docs.test.js \
  scripts/pages-v2-docs.test.js
git commit -m "docs(pages-api): 更新 Public Sites Owner 合约"
```

## Task 4：完整验证与 PR 更新

### Step 1：运行 focused suite

```bash
node --test \
  apps/pages-api/src/public-sites.test.js \
  apps/pages-api/src/transport/public/public-sites-handler.test.js \
  apps/pages-api/src/domain/sites/authorization.test.js \
  apps/pages-api/src/connection-auth.test.js \
  apps/pages-api/src/openapi.test.js \
  apps/pages-api/src/store-contract.test.js \
  scripts/public-docs.test.js \
  scripts/pages-v2-docs.test.js \
  tests/pages-api-architecture.test.js
```

### Step 2：运行仓库级验证

```bash
pnpm lint
pnpm test
git diff --check
git status --short
```

Expected: lint/test 退出 0，工作树只包含已知且待提交的目标文件，且无 secret/provider ID。

### Step 3：安全与合约审查

独立检查：

- Store 内部 Owner ID/role/department 原始字段未进入 response。
- `canDeploy` 与 `actorCanDeploySite()` 对 Cindy、CLI、read-only、`*`、read+deploy PAT 和团队角色的结果一致。
- 原有 active/latest route、ACL、环境隔离、cursor 与 `Cache-Control:no-store` 无回归。
- OpenAPI、API boundary、Console architecture 和测试一致。

### Step 4：推送现有 feature branch

推送 `codex/cindy-public-sites`，让现有 PR #179 重新运行 Platform CI 和 staging sync；不得合并或触发 production 部署。
