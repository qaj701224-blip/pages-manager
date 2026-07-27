# 管理员站点部署形态展示与筛选 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在管理员站点管理列表展示并筛选当前 active version 的 `assets-only`、`worker-only`、`worker-with-assets` 部署形态，并将无 active version 的站点显示为“未部署”。

**Architecture:** 复用现有 `site_routes.active_version_id -> site_versions.id` 关系，在 D1 store 和测试内存 store 的列表/详情读取路径解析 nullable `deploymentShape`。管理员 API 通过现有站点 formatter 返回该字段；前端使用纯模型函数映射文案并在现有客户端筛选链路中增加部署形态条件，不新增站点字段、migration 或发布输入。

**Tech Stack:** Cloudflare D1 SQL、Node.js `node:test`、React 19、Vite、现有 pages-console CSS。

---

### Task 1: 为 store active-version 解析建立回归测试

**Files:**
- Modify: `apps/pages-api/src/admin.test.js`（管理员站点列表/详情测试附近）
- Test helper: `apps/pages-api/src/test-store.js` 的现有 `createSite`、`createSiteVersion`、route 建立 helper

- [ ] **Step 1: 写列表和详情 API 的失败测试**

在 `admin.test.js` 增加一个 focused test，建立四个站点：三个站点的 route `activeVersionId` 分别指向三种 shape，一个站点没有 active version；调用 `GET /.xd-pages/api/console/admin/sites` 和其中一个站点的 `GET /.xd-pages/api/console/admin/sites/:id`，断言：

```js
assert.equal(listedById.get('site_assets').deploymentShape, 'assets-only');
assert.equal(listedById.get('site_worker').deploymentShape, 'worker-only');
assert.equal(listedById.get('site_worker_assets').deploymentShape, 'worker-with-assets');
assert.equal(listedById.get('site_empty').deploymentShape, null);
assert.equal((await detail.json()).site.deploymentShape, 'worker-only');
```

再建立一个 active route 指向其它站点的 version，断言该站点返回 `deploymentShape: null`，验证 SQL/内存实现不会跨站点借用版本。

- [ ] **Step 2: 写未知 shape 原样保留的失败测试**

为一个 active version 设置 `deploymentShape: 'future-shape'`，调用列表 API，断言：

```js
assert.equal(body.sites.find((site) => site.id === 'site_future').deploymentShape, 'future-shape');
```

- [ ] **Step 3: 运行 focused API 测试确认失败**

Run: `node --test apps/pages-api/src/admin.test.js`

Expected: 新增断言因 API 尚未返回 `deploymentShape` 或返回 `undefined` 而失败；现有测试不应因本测试准备数据失败。

### Task 2: 实现 D1 和测试内存 store 的 active-version 解析

**Files:**
- Modify: `apps/pages-api/src/store.js:773-835` 的 `listAdminSites` 和 `getAdminSiteById` SQL
- Modify: `apps/pages-api/src/store.js:4883-4911` 的 `mapSiteWithJoinedRoute`
- Modify: `apps/pages-api/src/test-store.js:2373-2383` 的 `siteWithRoute`

- [ ] **Step 1: 在两个 D1 查询增加相同的 LEFT JOIN**

在两个查询的 SELECT 中增加：

```sql
site_versions.deployment_shape AS active_version_deployment_shape
```

并在现有 `LEFT JOIN site_routes` 后增加：

```sql
LEFT JOIN site_versions
  ON site_versions.id = site_routes.active_version_id
  AND site_versions.site_id = sites.id
```

列表和详情必须使用同一 join 条件；不加入仅按 `active_version_id` 的跨站点关联。

- [ ] **Step 2: 将 D1 查询字段映射到站点资源**

在 `mapSiteWithJoinedRoute(row)` 的 `mapSite(row)` 结果上设置：

```js
site.deploymentShape = row.active_version_deployment_shape ?? null;
```

不得用已知枚举集合归一化未知值；未知非空字符串必须原样保留。

- [ ] **Step 3: 让测试内存 store 与 D1 保持同一语义**

在 `siteWithRoute(siteId)` 中读取 route 的 `activeVersionId`，仅当对应 version 存在且 `version.siteId === site.id` 时设置该站点的 `deploymentShape`，否则设置 `null`：

```js
const route = this.routes.get(this.routeBySiteId.get(siteId)) || null;
const version = route?.activeVersionId ? this.siteVersions.get(route.activeVersionId) : null;
return {
  ...site,
  deploymentShape: version?.siteId === site.id ? version.deploymentShape ?? null : null,
  route,
};
```

- [ ] **Step 4: 运行 API focused 测试确认 store 层通过**

Run: `node --test apps/pages-api/src/admin.test.js`

Expected: Task 1 新增的 shape、空状态、未知值和跨站点保护断言 PASS。

### Task 3: 暴露管理员资源字段并补齐后端测试

**Files:**
- Modify: `apps/pages-api/src/admin.js:1279-1315` 的 `formatAdminSite` / `formatAdminSiteDetail`
- Modify: `apps/pages-api/src/admin.test.js`

- [ ] **Step 1: 写 formatter/API 字段断言**

在管理员站点响应测试中断言 `deploymentShape` 位于 site 顶层，并且 owner、visibility、status 等现有字段保持不变；详情响应也断言同名字段存在。

- [ ] **Step 2: 在共享 formatter 返回 nullable 字段**

在 `formatAdminSite(site)` 返回值中增加：

```js
deploymentShape: site.deploymentShape ?? null,
```

`formatAdminSiteDetail` 继续通过 spread 复用该字段。不要返回 active version ID 或 provider 资源信息。

- [ ] **Step 3: 运行后端 focused 测试**

Run: `node --test apps/pages-api/src/admin.test.js apps/pages-api/src/store.test.js`

Expected: PASS。

### Task 4: 为前端类型文案和筛选编写纯模型测试

**Files:**
- Modify: `apps/pages-console/src/ui/site-display-model.js`
- Modify: `apps/pages-console/src/ui/site-display-model.test.js`

- [ ] **Step 1: 写模型失败测试**

增加以下断言：

```js
assert.equal(siteDeploymentShapeLabel('assets-only'), '静态资源');
assert.equal(siteDeploymentShapeLabel('worker-only'), 'Worker');
assert.equal(siteDeploymentShapeLabel('worker-with-assets'), 'Worker + 静态资源');
assert.equal(siteDeploymentShapeLabel(null), '未部署');
assert.equal(siteDeploymentShapeLabel('future-shape'), '未知类型');

const sites = [
  { deploymentShape: 'assets-only' },
  { deploymentShape: 'worker-only' },
  { deploymentShape: 'worker-with-assets' },
  { deploymentShape: null },
  { deploymentShape: 'future-shape' },
];
assert.equal(filterAdminSites(sites, { deploymentShape: 'worker-only' }).length, 1);
assert.equal(filterAdminSites(sites, { deploymentShape: 'un-deployed' }).length, 1);
assert.equal(filterAdminSites(sites, { deploymentShape: 'future-shape' }).length, 0);
```

筛选函数还必须保留现有 query、ownerType、status 条件的 AND 组合语义。

- [ ] **Step 2: 运行前端模型测试确认失败**

Run: `pnpm --filter @xd-cell/pages-console exec node --test src/ui/site-display-model.test.js`

Expected: 因新函数尚未导出而失败。

- [ ] **Step 3: 实现文案和筛选模型**

在 `site-display-model.js` 增加 `siteDeploymentShapeLabel(shape)`；空值返回“未部署”，三个已知值返回固定中文文案，其它非空值返回“未知类型”。将现有 `filterAdminSites` 从 `AdminSites.jsx` 移入该纯 JS 模型并新增 `deploymentShape` 条件：`all` 不过滤，`un-deployed` 仅匹配 null/空值，已知 shape 只精确匹配；未知值不提供独立筛选选项。

- [ ] **Step 4: 运行前端模型测试确认通过**

Run: `pnpm --filter @xd-cell/pages-console exec node --test src/ui/site-display-model.test.js`

Expected: PASS。

### Task 5: 接入管理员站点列表 UI

**Files:**
- Modify: `apps/pages-console/src/ui/pages/AdminSites.jsx:1-180`
- Modify: `apps/pages-console/src/ui/admin-management-actions.test.js`

- [ ] **Step 1: 写列表结构失败断言**

在 `admin-management-actions.test.js` 增加源码断言，要求站点列表包含“站点类型”表头、类型筛选 `aria-label`、`siteDeploymentShapeLabel(site.deploymentShape)` 和 `deploymentShape` 传入 `filterAdminSites`。

- [ ] **Step 2: 增加类型筛选状态和选项**

在 `AdminSites` 中增加：

```js
const [deploymentShape, setDeploymentShape] = useState('all');
```

工具栏增加原生 `<select aria-label="站点类型">`，选项为全部类型、静态资源、Worker、Worker + 静态资源、未部署；`visibleSites` 的筛选参数增加 `deploymentShape`。

- [ ] **Step 3: 增加列表列和 tag 文案**

在 Owner 与可见性之间加入“站点类型”列，行内用 `siteDeploymentShapeLabel(site.deploymentShape)` 展示现有 `tag`。未知值显示“未知类型”，不影响列表渲染。

- [ ] **Step 4: 运行前端 UI focused tests**

Run: `pnpm --filter @xd-cell/pages-console exec node --test src/ui/admin-management-actions.test.js src/ui/site-display-model.test.js`

Expected: PASS。

### Task 6: 完成全量验证并检查改动边界

**Files:**
- No new files; inspect all changed files and the committed design/plan docs.

- [ ] **Step 1: 运行相关测试**

Run: `node --test apps/pages-api/src/admin.test.js apps/pages-api/src/store.test.js` 和 `pnpm --filter @xd-cell/pages-console test`。

Expected: 两组测试均 PASS。

- [ ] **Step 2: 运行仓库全量校验**

Run: `pnpm lint`，然后 `pnpm test`。

Expected: lint 无错误；全量测试 PASS。

- [ ] **Step 3: 做最终 diff 检查**

Run: `git diff --check` 与 `git status --short`，确认只包含站点类型功能、设计/计划文档，以及原有未跟踪的 `.claude/` 不被修改或提交。

- [ ] **Step 4: 提交实现**

```bash
git add apps/pages-api/src/admin.js apps/pages-api/src/admin.test.js apps/pages-api/src/store.js apps/pages-api/src/test-store.js apps/pages-console/src/ui/pages/AdminSites.jsx apps/pages-console/src/ui/site-display-model.js apps/pages-console/src/ui/site-display-model.test.js apps/pages-console/src/ui/admin-management-actions.test.js docs/superpowers/plans/2026-07-27-admin-site-deployment-shape.md
git commit -m "feat(pages-console): 增加站点部署形态筛选"
```
