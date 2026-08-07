# Admin Exposure Audit Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 Admin 开启公网时 D1 审计参数包含 `undefined` 的失败，并让最终观测审计失败不再把已生效操作返回为失败。

**Architecture:** 保留 OfficeNet remove/verify 作为 public policy 提交前的安全屏障。D1 policy mutation 与 `policy_committed` 权威审计继续原子提交；snapshot exact 后的 `effective_success` 改为非阻断观测审计，通过 `auditStatus` 和固定安全 warning 暴露未确认状态。

**Tech Stack:** JavaScript、Cloudflare Workers/D1、Node `node:test`、React Console。

---

### Task 1: D1 审计参数统一归一化

**Files:**
- Modify: `apps/pages-api/src/store.js:4393`
- Test: `apps/pages-api/src/store.test.js`

- [ ] **Step 1: 写入严格 bind 的失败测试**

新增一个 fake D1 statement，捕获 `auditEventStatement()` 的 bind 参数，并断言省略可空字段时不存在 `undefined`：

```js
test('D1 audit statements bind omitted nullable fields as null', () => {
  let bound = [];
  const db = {
    prepare() {
      return {
        bind(...args) {
          bound = args;
          return this;
        },
      };
    },
  };
  const store = new D1PagesStore(db);

  store.auditEventStatement({
    id: 'audit_1',
    environment: 'staging',
    eventType: 'admin.site.exposure',
    actorUserId: 'usr_admin',
    actorType: 'platform_admin',
    siteId: 'site_1',
    routeId: 'route_1',
    decision: 'allow',
    statusCode: 200,
    metadata: { stage: 'policy_committed' },
    createdAt: '2026-08-07T10:00:00.000Z',
  });

  assert.equal(bound.includes(undefined), false);
  assert.equal(bound[2], null);
  assert.equal(bound[8], null);
  assert.equal(bound[11], null);
  assert.equal(bound[12], null);
});
```

- [ ] **Step 2: 运行测试并确认 RED**

Run: `node --test apps/pages-api/src/store.test.js --test-name-pattern='D1 audit statements bind omitted nullable fields as null'`

Expected: FAIL，因为 bind 参数仍包含 `undefined`。

- [ ] **Step 3: 在 Store 边界做最小归一化**

在 `auditEventStatement()` 的 `.bind()` 中，将所有可空字段用 `?? null` 归一化：

```js
record.traceId ?? null,
record.actorUserId ?? null,
record.siteId ?? null,
record.routeId ?? null,
record.versionId ?? null,
record.statusCode ?? null,
record.ipHash ?? null,
record.userAgentHash ?? null,
stringifyJsonColumn(record.metadata ?? null),
```

必填字段继续保持原值，不静默接受缺失的 `eventType`、`actorType`、`decision` 或 `createdAt`。

- [ ] **Step 4: 运行 focused test 并确认 GREEN**

Run: `node --test apps/pages-api/src/store.test.js --test-name-pattern='D1 audit statements bind omitted nullable fields as null'`

Expected: PASS。

- [ ] **Step 5: 提交 D1 修复**

```bash
git add apps/pages-api/src/store.js apps/pages-api/src/store.test.js
git commit -m "fix(pages-api): 归一化 D1 审计可空参数"
```

### Task 2: 最终观测审计失败返回成功与 warning

**Files:**
- Modify: `apps/pages-api/src/admin.js:2480-2513`
- Modify: `apps/pages-api/src/openapi.js:418-454`
- Modify: `apps/pages-console/src/ui/pages/SiteDetail.jsx:663-689`
- Test: `apps/pages-api/src/admin.test.js:3535-3637`
- Test: `apps/pages-api/src/openapi.test.js:40-43`
- Test: `apps/pages-console/src/ui/site-detail-interaction.test.js`

- [ ] **Step 1: 将现有 final-audit 测试改成新期望并确认 RED**

测试捕获 `console.warn`，让 `effective_success` 审计写入失败，并断言：

```js
assert.equal(response.status, 200);
const body = await response.json();
assert.equal(body.access.exposure, 'public');
assert.equal(body.auditStatus, 'unconfirmed');
assert.equal(warnings.some((entry) => entry.includes('SITE_EXPOSURE_AUDIT_UNCONFIRMED')), true);
assert.equal(audits.some((event) => event.decision === 'deny'), false);
```

正常成功测试补充 `assert.equal(body.auditStatus, 'confirmed')`。

- [ ] **Step 2: 运行 Admin focused tests 并确认 RED**

Run: `node --test apps/pages-api/src/admin.test.js --test-name-pattern='final audit|effective public exposure|enable public exposure'`

Expected: final-audit 测试仍收到 503 `SITE_EXPOSURE_AUDIT_FAILED`。

- [ ] **Step 3: 实现非阻断观测审计**

将 `effective_success` catch 改为设置状态并输出安全日志，不再 throw：

```js
let auditStatus = 'confirmed';
try {
  await store.recordAuditEvent(effectiveSuccessEvent);
} catch (error) {
  auditStatus = 'unconfirmed';
  console.warn(
    'SITE_EXPOSURE_AUDIT_UNCONFIRMED',
    JSON.stringify({
      operationId,
      siteId: committedSite.id,
      environment: config.environment,
      errorCode: safeAdminExposureAuditWarningCode(error),
    })
  );
}
return { access: ..., auditStatus };
```

`safeAdminExposureAuditWarningCode()` 只能返回固定安全分类，例如 `AUDIT_WRITE_FAILED` 或 `UNKNOWN`，不得返回原始 message。

- [ ] **Step 4: 对齐 Admin OpenAPI 与 Console**

- 从 exposure endpoint 的 `x-error-codes` 删除 `SITE_EXPOSURE_AUDIT_FAILED`，把 200 描述补充为可能返回 `auditStatus: confirmed|unconfirmed`。
- Console 成功响应若 `data.auditStatus === 'unconfirmed'`，展示现有 `auditWarning` 文案；正常确认则清空 warning。
- 保留旧 `SITE_EXPOSURE_AUDIT_FAILED` catch 作为旧后端兼容分支，但新 pages-api 不再产生该错误。

- [ ] **Step 5: 运行 API、OpenAPI 和 Console focused tests**

Run:

```bash
node --test apps/pages-api/src/admin.test.js --test-name-pattern='final audit|effective public exposure|enable public exposure'
node --test apps/pages-api/src/openapi.test.js
node --test apps/pages-console/src/ui/site-detail-interaction.test.js apps/pages-console/src/ui/site-detail-model.test.js
```

Expected: 全部 PASS。

- [ ] **Step 6: 提交审计语义修复**

```bash
git add apps/pages-api/src/admin.js apps/pages-api/src/admin.test.js apps/pages-api/src/openapi.js apps/pages-api/src/openapi.test.js apps/pages-console/src/ui/pages/SiteDetail.jsx apps/pages-console/src/ui/site-detail-interaction.test.js
git commit -m "fix: 区分公网 exposure 权威审计与观测审计"
```

### Task 3: 补齐 Admin exposure 阶段证明

**Files:**
- Modify: `apps/pages-api/src/admin.js:2332-2380`
- Test: `apps/pages-api/src/admin.test.js:3312-3357`

- [ ] **Step 1: 增加阶段审计失败测试**

成功开启 public 后断言同一 `operationId` 至少能重建以下顺序：

```js
assert.deepEqual(stages, [
  'attempted',
  'office_net_removed_verified',
  'policy_committed',
  'effective_success',
]);
assert.equal(policyCommitted.metadata.activationState, 'pending_activation');
```

- [ ] **Step 2: 运行阶段测试并确认 RED**

Run: `node --test apps/pages-api/src/admin.test.js --test-name-pattern='enable public exposure while preserving visibility'`

Expected: FAIL，当前缺少 `office_net_removed_verified` 和 `activationState`。

- [ ] **Step 3: 最小实现阶段证明**

- `ensurePublicWorkerOfficeNetAbsent()` 成功后返回 `verified` 或 `not_applicable` evidence；best-effort 写对应的 `${operationId}:office_net_removed_verified` / `${operationId}:office_net_not_applicable`，不得把 assets-only 或 normal-worker-slot 伪报为已移除并验证。verified metadata 包含 `stage`、`officeNetBindingRemoved: true`、`officeNetBindingVerified: true`。
- `policy_committed` 事件继续与 policy mutation 同 batch，并在 metadata 增加 `activationState: 'pending_activation'`；不另开非原子的 pending event。
- OfficeNet 阶段审计写失败只输出固定安全 warning，不阻止仍受 `policy_committed` 保护的策略流程。

- [ ] **Step 4: 运行阶段与补偿测试**

Run:

```bash
node --test apps/pages-api/src/admin.test.js --test-name-pattern='enable public exposure|snapshot failure|read-back drift|compensation'
```

Expected: 全部 PASS，snapshot 失败仍不产生 `effective_success`。

- [ ] **Step 5: 提交阶段审计修复**

```bash
git add apps/pages-api/src/admin.js apps/pages-api/src/admin.test.js
git commit -m "fix(pages-api): 补齐公网 exposure 阶段审计"
```

### Task 4: 全量验证与更新 PR

**Files:**
- Verify all modified files
- Update existing PR #165

- [ ] **Step 1: 运行静态检查和全量测试**

```bash
pnpm lint
pnpm test
git diff --check
```

Expected: lint 无新增 error；全部测试通过；diff check 无输出。

- [ ] **Step 2: 自查变更和敏感信息**

```bash
git status --short
git diff origin/master...HEAD --check
git log --oneline origin/master..HEAD
```

确认仅 `.agents/skills/` 和 `.claude/` 保持未追踪，未提交任何 secret、Worker setting 或 staging resource id。

- [ ] **Step 3: 推送当前分支更新 PR**

```bash
git push origin cindy/auto-ifi941
```

- [ ] **Step 4: 更新 PR 描述的 bugfix 章节**

补充 staging 现象、根因、审计分层修复、回归测试和 staging 复测要求；在重新部署前不执行远端 exposure 写操作。
