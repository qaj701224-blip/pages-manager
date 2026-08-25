# Console 站点归属转移 Implementation Plan

> 对应设计：`docs/superpowers/specs/2026-08-25-console-site-owner-transfer-design.md`

**Goal:** 清理站点设置页重复信息，把 Owner 改造成独立且受保护的归属转移能力；个人站点仅当前 Owner、团队站点仅 team admin 可以发起。

**Architecture:** UI 使用独立归属卡片与二次确认；pages-api 投影专用 `canTransferOwnership` capability，并在共享 ownership application 和 D1 guarded statement 中复核源权限；Console session 从 AuthSessionDO 端到端携带权威 `authTime`，Owner 转移在服务端要求 15 分钟内重新经过 SSO 验证。

**Tech Stack:** Cloudflare Workers、Durable Objects、D1、JavaScript ESM、React、Radix Dialog、Node.js `node:test`、OpenAPI source contract。

---

### Task 1：补齐 recent-login 可信链路

**Files:**

- Modify: `apps/pages-auth/src/console-session.js`
- Modify: `apps/pages-auth/src/oauth-endpoints.js`
- Modify: `apps/pages-console/src/worker/pages-auth-client.js`
- Modify: `apps/pages-console/src/worker/session.js`
- Modify: `apps/pages-console/src/worker/pages-api-client.js`
- Modify: `apps/pages-api/src/console-auth.js`
- Modify: 对应 focused tests

- [ ] 将 AuthSessionDO 的 `authTime` 传入 console code、exchange、Console JWT 和可信 BFF header。
- [ ] 增加 `reauth=1`，跳过本地 auth-session shortcut 并重新经过 SSO callback。
- [ ] pages-api 实现 900 秒 recent window、30 秒未来时钟偏差的 fail-closed 校验。
- [ ] 覆盖旧 cookie、伪造 header、stale/future/boundary 时间与安全 returnTo。

### Task 2：收紧共享 Owner 转移权限

**Files:**

- Modify: `apps/pages-api/src/domain/sites/authorization.js`
- Modify: `apps/pages-api/src/application/sites/authorize-site-mutation.js`
- Modify: `apps/pages-api/src/application/sites/transfer-owner.js`
- Modify: `apps/pages-api/src/infrastructure/store/support/site-mutation-authorization.js`
- Modify: Console/Public/deploy handlers 与 focused tests

- [ ] 个人源站点只允许当前 Owner，团队源站点只允许 team admin；platform admin 保留 bypass。
- [ ] 把源 team admin 条件写入持锁后的 D1 guard，覆盖并发降权。
- [ ] 同 Owner 请求在首次提交前拒绝，不写 audit、不递增 `policyVersion`、不刷新 snapshot。
- [ ] 保持 Public 目标个人限 actor 自己；TAT 不能改变 Owner；deploy 同步使用源权限规则。
- [ ] 保持 snapshot 失败时的现有补偿与 fail-closed 行为。

### Task 3：增加权限投影并改造 Console UI

**Files:**

- Modify: `apps/pages-api/src/transport/console/site-projections.js`
- Modify: `apps/pages-api/src/application/governance/list-admin-resources.js`
- Modify: `apps/pages-console/src/ui/pages/SiteDetail.jsx`
- Modify: `apps/pages-console/src/ui/site-settings-model.js`
- Modify: 对应 API、model 与 DOM interaction tests

- [ ] 增加服务端 `permissions.canTransferOwnership`，UI 不复用 `canManage` 推断。
- [ ] 删除旧设置卡片重复的站点标题、Slug 与 Hostname，改为“站点归属”卡片。
- [ ] 复用 Owner picker 与 `ConfirmDialog`，冻结确认目标并阻止相同 Owner。
- [ ] Workspace 只显示 active 用户和可管理团队；Admin 显示当前环境全部 active 团队。
- [ ] recent-login 错误提供重认证入口；转移后失权则 replace 导航到个人站点列表。
- [ ] 保留 request guard、滚动位置、焦点和并发 metadata 状态。

### Task 4：同步公开契约与架构文档

**Files:**

- Modify: `apps/pages-api/src/openapi.js`
- Modify: `apps/pages-api/src/openapi.test.js`
- Modify: `docs/api-boundary.md`
- Modify: `docs/architecture/xd-cell-console.md`
- Modify: `docs/architecture/publishing-and-runtime.md`
- Modify: CLI/skill 文案（存在对应 Owner 转移说明时）

- [ ] 明确 Public transfer、deploy、PAT/Connection JWT/TAT 的源权限与错误语义。
- [ ] 更新团队角色矩阵，移除 publisher 的归属转移权限。
- [ ] 记录 Console recent-login 可信传递、时间窗和 reauth 流程。
- [ ] 保持 OpenAPI 仅为源码合约，不新增公网 `/openapi.json`。

### Task 5：验证与 Review

- [ ] 运行相关 application、store、Console API、Public API、auth、worker 与 UI focused tests。
- [ ] 运行 pages-console production build。
- [ ] 运行 `git diff --check`、`pnpm lint` 和 `pnpm test`。
- [ ] 独立审查权限、session、路由补偿、UI 状态和文档一致性；修复所有 P0/P1。
- [ ] 提交并推送分支，更新 PR #178 的标题、说明和测试结果；不执行手动 staging/production 部署。
