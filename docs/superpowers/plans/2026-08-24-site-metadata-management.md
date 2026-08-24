# 站点名称与 slug 管理实施计划

> 本计划对应 `docs/superpowers/specs/2026-08-24-site-metadata-management-design.md`。实现遵循 consumer-before-producer：Gateway 与 Router 必须先兼容新协议，metadata mutation 才能启用。

## Goal

为 XD Cell v2 增加可独立修改的站点展示名称和 canonical slug；认证 Public API、Workspace Console 与 Admin Console 行为一致。slug 修改不产生部署或版本，历史 hostname 308 到当前 hostname，并保持身份、权限、版本、runtime config 与 runtime data 连续。缩略图延期，不引入 R2。

## 全程不变量

- v1 `apps/server` 不变。
- production 不因 push/PR 自动部署；staging/production D1、KV、Worker、domain 不串用。
- Public API 继续认证；Console mutation 继续执行 session、same-origin 与 CSRF；Router 所有失败路径 fail closed。
- slug rename 不写 `deployments` / `site_versions`，不调用 WFP provider。
- `site.id`、`siteUuid`、`dataNamespace`、Owner、ACL、active version、vars/secrets 不随 rename 改变。

## Task 1：数据模型与 Store 契约

**Files**

- Add: `apps/pages-api/migrations/0021_site_metadata.sql`
- Modify: `apps/pages-api/src/schema.js`
- Modify: `apps/pages-api/src/infrastructure/store/row-mappers/sites.js`
- Modify/Add: `apps/pages-api/src/infrastructure/store/repositories/sites-repository.js`
- Add: `apps/pages-api/src/infrastructure/store/transactions/site-metadata.js`
- Modify: `apps/pages-api/src/infrastructure/store/create-store.js`
- Modify: `apps/pages-api/test-support/pages-store-fixture.js`
- Test: schema/migration/store contract tests

**Steps**

- [ ] 先写 migration/schema 测试，覆盖 `title`、`data_namespace`、两个 slug revision、alias 表与 indexes。
- [ ] 增加 migration 并回填存量 `data_namespace=slug`；fresh schema 对齐目标结构。
- [ ] 扩展 site mapper/projection，内部保留 namespace/revision，公开层不泄露 namespace。
- [ ] 实现 alias-aware lookup、active alias list 和 pending reconciliation list。
- [ ] 实现带 site commit lease/fencing 的 metadata D1 transaction；空 namespace 在首次 rename 时以旧 slug 固化。
- [ ] 覆盖 title-only、rename、历史 alias 回切、冲突、并发 CAS、删除全部 aliases/claims 和无 deployment/version 副作用。

**Verify**

```bash
node --test apps/pages-api/src/schema.test.js apps/pages-api/src/store.test.js apps/pages-api/src/store-contract.test.js scripts/pages-v2-migrations.test.js
```

## Task 2：KV dataNamespace 兼容基线

**Files**

- Modify: `apps/kv-gateway/src/auth.js`
- Modify: `apps/kv-gateway/src/index.js`
- Test: `apps/kv-gateway/src/auth.test.js`
- Test: `apps/kv-gateway/src/index.test.js`
- Modify/Test: `packages/pages-runtime-protocol/src/index.js`（仅在共享校验确有必要时）

**Steps**

- [ ] 先写旧 claim、新 `namespaceVersion: 2` claim、非法真实 site id / namespace 的验证测试。
- [ ] Gateway 规范化为 `{ siteId, dataNamespace }`；旧 claim fallback 为 `dataNamespace=siteId`。
- [ ] 所有 site/user key、prefix、provider metadata 与 cursor context 使用 `dataNamespace`，真实 site id 单独保留。
- [ ] 新 cursor version 同时绑定 site id 与 namespace；旧 cursor 在其 key 有效期间继续按旧 namespace 规则读取。
- [ ] 覆盖 rename 前后相同 KV prefix、跨 site/namespace cursor 拒绝与旧 token TTL 窗口。

**Verify**

```bash
node --test apps/kv-gateway/src/auth.test.js apps/kv-gateway/src/index.test.js packages/pages-runtime-protocol/src/*.test.js
```

## Task 3：Router v4 serve/redirect reader

**Files**

- Modify: `apps/pages-router/src/index.js`
- Test: `apps/pages-router/src/index.test.js`
- Test: `apps/pages-router/src/access-policy.test.js`

**Steps**

- [ ] 先写 v2/v3 兼容、v4 serve、v4 redirect 的失败测试。
- [ ] 解析 redirect chain 到最终 serve snapshot，限制 16 跳并检测循环、跨环境、跨 site、target missing/reused。
- [ ] 根据最终 serve exposure 执行 IP allowlist，再返回单次 308；target 站点继续执行 SSO/ACL/owner/disabled。
- [ ] Location 仅由已验证 hostname + 原 path/query 组成，`Cache-Control: no-store`。
- [ ] v4 serve capability 发出真实 `siteId`、不可变 `dataNamespace` 与 `namespaceVersion: 2`；v2/v3 snapshot 使用 slug fallback。
- [ ] 覆盖旧 hostname 不执行 user Worker、不生成 capability、runtime path 与删除后 fail-closed。

**Verify**

```bash
node --test apps/pages-router/src/*.test.js apps/kv-gateway/src/*.test.js
```

## Task 4：pages-api v4 snapshot、metadata use case 与 reconciliation

**Files**

- Modify: `apps/pages-api/src/route-snapshot.js`
- Modify: `apps/pages-api/src/infrastructure/route-snapshots/site-route-snapshots.js`
- Add: `apps/pages-api/src/application/ports/site-metadata.js`
- Add: `apps/pages-api/src/application/sites/update-site-metadata.js`
- Add: `apps/pages-api/src/domain/sites/metadata.js`
- Modify: `apps/pages-api/src/transport/scheduled.js`
- Add focused tests beside each module

**Steps**

- [ ] 先锁定 v4 serve 与 redirect snapshot shape，同时保留现有 pointer monotonic/CAS 测试。
- [ ] 实现 title NFC/trim/control/长度规则和 metadata patch shape 校验。
- [ ] use case 在 site commit lease 内调用 Task 1 transaction，commit 后先确认 canonical，再逐个确认 direct alias pointer。
- [ ] 每个 alias 确认后更新 sync revision；全部确认后以 slug-revision CAS 标记 site ready。
- [ ] 部分失败返回 pending 结果；同 slug retry 与 scheduled bounded reconciliation 可恢复，stale repair 不能误标 ready。
- [ ] 所有既有 snapshot writer 带 `dataNamespace`；delete 清理 canonical 与 aliases，且遗留 pointer 无法跨 site。

**Verify**

```bash
node --test apps/pages-api/src/route-snapshot.test.js 'apps/pages-api/src/application/sites/*.test.js' apps/pages-api/src/transport/scheduled.test.js
```

## Task 5：认证 Public API 与合约

**Files**

- Modify: `apps/pages-api/src/transport/public/sites-handler.js`
- Add/Modify focused Public API tests
- Modify: `apps/pages-api/src/openapi.js`
- Modify: `apps/pages-api/src/openapi.test.js`
- Modify: `docs/api-boundary.md`

**Steps**

- [ ] 新增 `PATCH /sites/{id}/metadata` 路由，确保先于通用 site-id matcher。
- [ ] 读取沿用 read scope；mutation 复用 owner/team publisher/admin 与 deploy scope，跨 site 返回不可枚举的 `SITE_NOT_FOUND`。
- [ ] 实现精确 200/202 success shape、错误矩阵和公开 site 的 title/displayName/routingStatus projection。
- [ ] mutation feature flag 只有精确 `true` 才开启，关闭返回稳定 503；读取和兼容 writer 不受影响。
- [ ] OpenAPI 与 boundary 文档同步，继续断言没有公开 `/openapi.json`。

**Verify**

```bash
node --test apps/pages-api/src/sites.test.js apps/pages-api/src/openapi.test.js apps/pages-api/src/index.test.js
```

## Task 6：Console BFF、Workspace/Admin API 与 UI

**Files**

- Modify: `apps/pages-api/src/console.js`
- Modify: `apps/pages-api/src/transport/console/admin-handler.js`
- Modify: `apps/pages-api/src/transport/console/site-projections.js`
- Modify: `apps/pages-api/src/application/governance/list-admin-resources.js`
- Modify: `apps/pages-console/src/worker/index.js`
- Modify: `apps/pages-console/src/worker/pages-api-client.js`
- Modify: `apps/pages-console/src/ui/api.js`
- Modify: `apps/pages-console/src/ui/pages/SitesDirectory.jsx`
- Modify: `apps/pages-console/src/ui/pages/WorkspaceSites.jsx`
- Modify: `apps/pages-console/src/ui/pages/SiteDetail.jsx`
- Modify: `apps/pages-console/src/ui/pages/AdminSites.jsx`
- Modify: `apps/pages-console/src/ui/styles.css`
- Add/Modify focused Console worker/UI tests

**Steps**

- [ ] 增加 Workspace/Admin metadata routes，调用同一 use case；保留 Owner transfer `/settings` 契约和 CSRF/same-origin。
- [ ] API client 增加 metadata patch；处理 202 success 而不是抛错。
- [ ] Directory/Workspace/Admin/detail 显示 title 主标题和 slug 次信息。
- [ ] Settings 提供名称、URL 两个独立保存状态；URL 确认提示 config 更新，pending 时轮询 detail。
- [ ] 覆盖 Owner、team publisher/admin/viewer、platform admin、匿名 directory、CSRF 和独立错误状态。

**Verify**

```bash
node --test apps/pages-api/src/console.test.js apps/pages-api/src/admin.test.js 'apps/pages-console/src/**/*.test.js'
pnpm --filter @xd-cell/pages-console build
```

## Task 7：CLI stale slug 兼容

**Files**

- Modify: `apps/pages-api/src/application/deployments/resolve-deploy-site.js`
- Modify: `apps/pages-api/src/transport/public/deployment-projection.js`
- Modify: `apps/pages-cli/src/commands/deploy.js`
- Modify: `apps/pages-cli/src/commands/shared.js`
- Modify tests in pages-api/pages-cli
- Modify `apps/pages-skill` references if published behavior is documented there

**Steps**

- [ ] deployment resolution 用 alias-aware lookup，历史 slug 必须解析到原 site id，不能进入 pending creation。
- [ ] deployment response 增加最小 canonical site projection。
- [ ] CLI human 输出 canonical warning，JSON 保留既有字段并增加 canonical site/warning；URL 使用 route hostname。
- [ ] 其它精确 list lookup 命令的 not-found action 提示可能已改名并建议列出当前站点。
- [ ] 覆盖 stale config 发布、access-key scope、别人的 alias、无重复 site/data namespace。

**Verify**

```bash
node --test apps/pages-api/src/application/deployments/resolve-deploy-site.test.js apps/pages-api/src/deployments.test.js apps/pages-cli/src/commands.test.js
```

## Task 8：rollout 护栏与文档

**Files**

- Modify: `apps/pages-api/src/config-inventory.test.js`
- Modify: `scripts/workflows.test.js`
- Modify current truth-source README/docs and tests

**Steps**

- [ ] 配置 metadata mutation feature flag；本期不新增 Cloudflare resource binding。
- [ ] workflow 保持 production 手动触发，且 consumer-before-producer 通过兼容基线/两阶段 rollout 文档与检查保证。
- [ ] 更新 API/CLI/Console 行为文档和运维步骤，不复制历史 spec 内容，不写真实资源值。
- [ ] 增加静态检查，禁止 API response 暴露 data namespace、hostname claim 或内部 route metadata。

**Verify**

```bash
node --test scripts/workflows.test.js scripts/pages-v2-docs.test.js apps/pages-api/src/config-inventory.test.js tests/project-policy.test.js
```

## Task 9：集成验证与完成审计

- [ ] 跑所有本功能 focused tests，修复 flaky/竞态，不扩大无关改动。
- [ ] 运行 `pnpm lint`。
- [ ] 运行 `pnpm test`。
- [ ] 构造需求—证据矩阵，逐项确认独立 mutation、API/Console 权限、308、无部署、数据连续与环境隔离。
- [ ] 检查 `git diff --check`、敏感信息、未跟踪文件和最终 commit 范围。
- [ ] staging 手工验收项保留给部署者；本地无法证明的外部 Cloudflare 状态不得宣称已验证。
