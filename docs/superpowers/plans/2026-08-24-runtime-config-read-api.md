# 站点运行配置读取 API Implementation Plan

> 对应设计：`docs/superpowers/specs/2026-08-24-runtime-config-read-api-design.md`

**Goal:** 为外部管理 API 和 Console 提供安全一致的运行配置读取能力；只有 publisher/admin 可读，secret 查询与响应均不接触 value。

**Architecture:** Public 与 Console transport 分别完成认证和 HTTP 投影，共享 `application/runtime-config` 的只读 use case。Infrastructure 提供 vars 查询和 metadata-only secret 查询；后者不选择密文、不依赖解密 key。Console UI 根据已投影的管理权限隐藏 viewer 的运行配置入口，后端独立 fail closed。

**Tech Stack:** Cloudflare Workers、D1、JavaScript ESM、React、Node.js `node:test`、OpenAPI source contract。

---

### Task 1：建立 Store 与 application 失败测试

**Files:**

- Modify: `apps/pages-api/src/store.test.js`
- Add: `apps/pages-api/src/application/runtime-config/reads.test.js`
- Modify: `apps/pages-api/src/application/ports/runtime-config.js`

- [ ] 覆盖 secret metadata 查询只返回 live `name/revision/updatedAt`，按 name 排序且不需要 encryption key。
- [ ] 锁定 SQL 不选择 `encrypted_value`，不调用 secret 解密路径。
- [ ] 覆盖 application reader 的 vars/secrets 独立调用、缺失 capability 和查询失败。
- [ ] 运行新增测试并确认实现前失败。

### Task 2：实现安全的共享读取能力

**Files:**

- Modify: `apps/pages-api/src/infrastructure/store/repositories/runtime-config-repository.js`
- Modify: `apps/pages-api/src/infrastructure/store/row-mappers/runtime-config.js`
- Modify: `apps/pages-api/src/application/ports/runtime-config.js`
- Add: `apps/pages-api/src/application/runtime-config/reads.js`

- [ ] 新增 `listEnabledSiteSecretMetadata(environment, siteId)`，只查询 `name/revision/updated_at`。
- [ ] 新增最小 read port 和 application reader，分别暴露 vars、secret metadata 读取。
- [ ] 保持部署/同步使用的 `listEnabledSiteSecrets()` 解密行为不变。
- [ ] 运行 Store 与 application focused tests。

### Task 3：实现 Public GET 与合约

**Files:**

- Modify: `apps/pages-api/src/sites.test.js`
- Modify: `apps/pages-api/src/transport/public/site-runtime-config-handler.js`
- Modify: `apps/pages-api/src/transport/public/sites-handler.js`
- Modify: `apps/pages-api/src/openapi.js`
- Modify: `apps/pages-api/src/openapi.test.js`
- Modify: `docs/api-boundary.md`

- [ ] 先覆盖个人 owner、团队 publisher/admin、团队 viewer、deploy/read-only Access Key、404 和 capability failure。
- [ ] 增加 GET vars/secrets 路由；权限检查先于 repository 调用。
- [ ] vars 返回 `name/value/revision/updatedAt`；secrets 仅返回 `name/revision/updatedAt`；均按 name 排序。
- [ ] OpenAPI 增加 GET schemas/responses/error codes，并修正 var value “never returned”旧描述。
- [ ] API 边界文档将受控集成能力更新为 read/mutation；CLI/skill 保持不变。
- [ ] 运行 pages-api sites/OpenAPI focused tests。

### Task 4：收紧 Console API 与 UI

**Files:**

- Modify: `apps/pages-api/src/console.test.js`
- Modify: `apps/pages-api/src/console.js`
- Modify: `apps/pages-api/src/transport/console/site-mutations.js`
- Modify: `apps/pages-console/src/ui/pages/SiteDetail.jsx`
- Modify: `apps/pages-console/src/ui/site-detail-model.js`（仅在需要统一 capability helper 时）
- Modify: focused Console UI tests

- [ ] 先覆盖个人 owner、团队 publisher/admin 可读，viewer 返回 `SITE_PUBLISHER_REQUIRED` 且不调用配置 repository。
- [ ] Console config 改用共享 application reader 与 metadata-only secret port，保持现有响应字段。
- [ ] Workspace viewer 隐藏“运行配置”导航；直接 config URL 不展示或请求配置。
- [ ] Platform Admin Console 保持可读；admin/publisher 的版本和更新时间展示不回退。
- [ ] 运行 pages-api Console 与 pages-console UI/worker focused tests。

### Task 5：验证与完成审计

- [ ] 运行 `git diff --check`，检查没有 secret value、密文或无关改动。
- [ ] 运行 pages-api architecture tests，确认 transport lane 没有交叉 import。
- [ ] 运行 `pnpm lint`。
- [ ] 运行 `pnpm test`。
- [ ] 对照设计逐项确认 API、权限、Console UI、OpenAPI、文档和安全查询均有直接证据。
