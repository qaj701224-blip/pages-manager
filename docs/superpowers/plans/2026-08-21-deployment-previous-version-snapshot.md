# Deployment Previous Version Snapshot Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 deployment 创建时立即记录请求开始时的活动版本，使 Provider 上传前失败也能通过 `previous_version_id` 判断旧版本是否保留。

**Architecture:** 复用站点解析阶段已经读取到的 `site.route.activeVersionId`，在 `createDeploymentForIdempotency` 创建记录时保存初始快照。成功部署进入站点提交锁后仍以 `latestRoute.activeVersionId` 覆盖该值，保持现有并发提交语义；首次部署没有活动版本时继续保存 `null`。

**Tech Stack:** Node.js `node:test`、pages-api deployment orchestration、D1/test store。

---

### Task 1: 建立 Provider 上传失败的 previous version 回归测试

**Files:**

- Modify: `apps/pages-api/src/deployments.test.js`
- Reference: `apps/pages-api/src/deployments.js:470-535,819-883`

- [x] **Step 1: 写已有活动版本时上传失败的测试**

先成功部署 `ver_1`，再让第二次 `WFP_PROVIDER.upload` 失败，断言 `dep_2.status === 'failed'` 且 `dep_2.previousVersionId === 'ver_1'`。

```js
assert.equal(failed.status, 'failed');
assert.equal(failed.previousVersionId, 'ver_1');
```

- [x] **Step 2: 写首次部署上传失败的测试**

对没有活动版本的初始站点直接制造上传失败，断言失败 deployment 的 `previousVersionId` 仍为 `null`。

```js
assert.equal(failed.status, 'failed');
assert.equal(failed.previousVersionId, null);
```

- [x] **Step 3: 写上传失败后 route 保持活动版本的测试**

先成功部署 `ver_1`，第二次上传失败后重新读取 route，断言 `activeVersionId`、`workerName` 和 `routeGeneration` 与失败前完全一致。

```js
assert.equal(after.activeVersionId, before.activeVersionId);
assert.equal(after.workerName, before.workerName);
assert.equal(after.routeGeneration, before.routeGeneration);
```

- [x] **Step 4: 运行三个测试并确认红灯**

Run:

```bash
node --test --test-name-pattern='upload failure.*previous version|first upload failure.*previous version|upload failure.*active route' apps/pages-api/src/deployments.test.js
```

Expected: 已有活动版本的失败 deployment 得到 `null` 而不是 `ver_1`；另外两个场景用于锁定首发和路由安全语义。

### Task 2: 在 deployment 创建时保存活动版本快照

**Files:**

- Modify: `apps/pages-api/src/deployments.js:470-535`
- Test: `apps/pages-api/src/deployments.test.js`

- [x] **Step 1: 实现最小赋值**

在 `createDeploymentForIdempotency` 输入中加入：

```js
previousVersionId: site.route?.activeVersionId || null,
```

不要移动 Provider 上传、route lock 或成功终态逻辑；提交锁内已有的 `latestRoute.activeVersionId` 更新继续保留，用于覆盖并发期间变化的活动版本。

- [x] **Step 2: 运行三个 focused tests 并确认绿灯**

Run:

```bash
node --test --test-name-pattern='upload failure.*previous version|first upload failure.*previous version|upload failure.*active route' apps/pages-api/src/deployments.test.js
```

Expected: 3 tests pass。

- [x] **Step 3: 运行 deployments 全文件测试**

Run:

```bash
node --test apps/pages-api/src/deployments.test.js
```

Expected: all tests pass。

### Task 3: 验证改动边界

**Files:**

- Verify: `apps/pages-api/src/deployments.js`
- Verify: `apps/pages-api/src/deployments.test.js`

- [x] **Step 1: 运行 pages-api focused suite**

Run:

```bash
node --test apps/pages-api/src/deployments.test.js apps/pages-api/src/store-contract.test.js apps/pages-api/src/admin.test.js
```

Expected: all tests pass。

- [x] **Step 2: 检查格式和差异**

Run:

```bash
git diff --check
git diff -- apps/pages-api/src/deployments.js apps/pages-api/src/deployments.test.js
```

确认只有 deployment 初始快照与三个回归测试，没有改变 CLI、Provider、route 提交或公开 API。
