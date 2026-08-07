# 管理后台失败部署归属与操作人 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让管理员失败部署记录明确区分已持久化的站点归属与本次部署操作人，并覆盖新站点创建失败场景。

**Architecture:** 复用 `deployments.actor_*` 字段，不改数据库；pages-api 的 D1/test store 统一输出带 `owner.state` 和 `actor` 的管理读模型。pages-console 只在管理员失败部署列表和管理员站点详情部署页展示操作人，普通 workspace 页面保持原有归属语义。

**Tech Stack:** Cloudflare D1 SQL、Node `node:test`、React JSX、pnpm monorepo。

---

### Task 1: 后端读模型与 API 回归测试

**Files:**
- Modify: `apps/pages-api/src/admin.test.js`
- Modify: `apps/pages-api/src/store.test.js`

- [x] **Step 1: 为新站点失败和已有团队站点写失败测试**

在 `admin.test.js` 的 dashboard 测试中新增一个 actor 用户（姓名、邮箱、Cindy-created 标记），写入一个不存在 site 行的失败 deployment，并断言响应包含 `owner.state = not_created` 和具体 actor；同时把现有团队 deployment 断言补成 `owner.state = persisted` 和对应 actor。

- [x] **Step 2: 为 D1 查询写失败断言**

在 `store.test.js` 的管理员查询测试中断言 dashboard 和 site deployment SQL 都包含 `sites.id AS joined_site_id`、`LEFT JOIN users AS actor_users`、`actor_users.email AS actor_user_email` 和 `actor_users.realname AS actor_user_realname`。

- [x] **Step 3: 运行 focused API 测试确认旧实现失败**

运行 `pnpm exec node --test apps/pages-api/src/admin.test.js apps/pages-api/src/store.test.js`。Expected: FAIL，原因是旧响应没有 `owner.state / actor`，且 SQL 没有 actor join。

### Task 2: 实现 pages-api D1 与测试存储映射

**Files:**
- Modify: `apps/pages-api/src/store.js:731-755, 1102-1134, 5404-5432`
- Modify: `apps/pages-api/src/test-store.js:2614-2635`

- [x] **Step 1: 给两个管理员 deployment 查询补 actor join 和 joined-site 标记**

在 SELECT 中增加 `sites.id AS joined_site_id`、actor user email/name，并用同一 alias 连接 `users`。

- [x] **Step 2: 修改 mapper**

`mapAdminDeploymentWithOwner` 根据 `joined_site_id` 生成 `ownerState = persisted | not_created`，保留现有 owner 字段；同时返回安全的 `actor` 对象，不能返回 token/hash。

- [x] **Step 3: 同步 TestPagesStore**

`decorateAdminDeployment` 对不存在 site 返回 `ownerState: not_created`，并从 `this.users.get(deployment.actorUserId)` 构造 actor；已有 site 返回 persisted owner。

- [x] **Step 4: 运行 focused API 测试确认映射通过**

运行同一条 node:test 命令，Expected: PASS。

### Task 3: 管理 API formatter 与 Dashboard UI

**Files:**
- Modify: `apps/pages-api/src/admin.js:2586-2608`
- Modify: `apps/pages-console/src/ui/site-display-model.js`
- Modify: `apps/pages-console/src/ui/site-display-model.test.js`
- Modify: `apps/pages-console/src/ui/pages/AdminDashboard.jsx`
- Modify: `apps/pages-console/src/ui/admin-management-actions.test.js`

- [x] **Step 1: 写 UI model 和页面回归测试**

覆盖 `not_created` owner、user/access_key/unknown actor fallback；断言 Dashboard 表头含“客户端来源”“站点归属”“操作人”，且调用新的 deployment owner/actor view helper。

- [x] **Step 2: 运行 UI focused tests 确认失败**

运行 `pnpm exec node --test apps/pages-console/src/ui/site-display-model.test.js apps/pages-console/src/ui/admin-management-actions.test.js`。Expected: FAIL，因为 helper、列和 actor 展示尚不存在。

- [x] **Step 3: 实现 API formatter 与 UI helper**

新增 `owner.state`，保持旧 owner 字段；新增 `actor`。在 UI 中对未创建站点显示“未创建 / 站点未创建”，对 actor 显示姓名、邮箱或安全 ID fallback。

- [x] **Step 4: 更新 Dashboard 表格**

增加“客户端来源”“站点归属”“操作人”列，避免复用普通站点 owner helper 处理未创建 deployment。

- [x] **Step 5: 运行 UI focused tests 确认通过**

运行同一条 node:test 命令，Expected: PASS。

### Task 4: 管理员站点详情部署记录一致化

**Files:**
- Modify: `apps/pages-console/src/ui/pages/SiteDetail.jsx`
- Modify: `apps/pages-console/src/ui/site-detail-interaction.test.js`

- [x] **Step 1: 写失败回归断言**

断言管理员 scope 的部署面板显示“操作人”并使用 actor helper；普通 workspace scope 继续保留“归属”。

- [x] **Step 2: 运行 focused UI test确认失败**

运行 `pnpm exec node --test apps/pages-console/src/ui/site-detail-interaction.test.js`。Expected: FAIL。

- [x] **Step 3: 实现 scope-aware deployment panel**

从 `SiteTabContent` 传递 `scope`，仅 `scope === 'admin'` 时显示 actor；workspace 保持 owner。

- [x] **Step 4: 运行 focused UI test确认通过**

运行同一条 node:test 命令，Expected: PASS。

### Task 5: 全量验证与变更审查

**Files:**
- Modify only files listed above.

- [x] **Step 1: 运行所有相关测试**

运行 `pnpm exec node --test apps/pages-api/src/admin.test.js apps/pages-api/src/store.test.js apps/pages-console/src/ui/site-display-model.test.js apps/pages-console/src/ui/admin-management-actions.test.js apps/pages-console/src/ui/site-detail-interaction.test.js`。

- [x] **Step 2: 运行 lint**

运行 `pnpm lint`。

- [x] **Step 3: 运行完整测试**

运行 `pnpm test`。

- [x] **Step 4: 检查 diff**

确认无 schema/migration、公开 API、CLI、webhook 或敏感字段改动；确认普通 workspace 部署视图未被修改。
