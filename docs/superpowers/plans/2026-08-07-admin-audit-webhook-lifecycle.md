# Admin 审计与站点生命周期 Webhook Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现已审查通过的 Admin 审计可读性、脱敏详情和四类站点生命周期 Webhook，同时复用现有 route lifecycle、投递、错误和异步语义。

**Architecture:** pages-api 新增一个 Webhook 事件目录，作为 supported events、模板 allowlist 和标准 Payload 字段的唯一来源；Console 通过管理 API消费目录，不再维护独立事件常量。审计 API 在 `formatAuditEvent` 边界统一脱敏并补回资源 ID，Console 仅使用脱敏后的数据展示摘要和详情。三个新增生产者只在既有业务流程确认成功后调用现有 `deliverWebhookEventToSubscriptions`，不新增 D1/KV 状态机、outbox、重试器、timeout 或 route rollback 协议。

**Tech Stack:** Cloudflare Worker JavaScript, D1 store, React 19, `node:test`, existing Webhook dispatcher/payload/template renderer, existing route snapshot and delete/access-policy flows.

---

### Task 1: 建立 pages-api Webhook 事件目录并扩展标准 Payload

**Files:**

- Create: `apps/pages-api/src/webhook-events.js`
- Create: `apps/pages-api/src/webhook-events.test.js`
- Modify: `apps/pages-api/src/webhook-payload.js`
- Modify: `apps/pages-api/src/webhook-payload.test.js`
- Modify: `apps/pages-api/src/webhooks.js`
- Modify: `apps/pages-api/src/webhooks.test.js`

- [ ] **Step 1: Write the failing catalog and compatibility tests**

Add tests that import `SUPPORTED_WEBHOOK_EVENTS`, `getWebhookEventCatalog`, and `getWebhookTemplateVariablePaths` from `webhook-events.js` and assert:

```js
test('webhook catalog has four real lifecycle events and disjoint variable partitions', () => {
  const catalog = getWebhookEventCatalog();
  assert.deepEqual(
    catalog.map((event) => event.type),
    ['site.deployed', 'site.failed', 'site.disabled', 'site.deleted']
  );
  for (const event of catalog) {
    const required = new Set(event.requiredTemplateVariables);
    const optional = new Set(event.optionalTemplateVariables);
    assert.equal(
      [...required].some((path) => optional.has(path)),
      false,
      event.type
    );
    assert.deepEqual(new Set(event.templateVariables), new Set([...required, ...optional]), event.type);
  }
});

test('site.deployed keeps every existing allowlisted variable', () => {
  const paths = getWebhookTemplateVariablePaths();
  for (const path of [
    'event.id',
    'event.type',
    'event.environment',
    'event.occurredAt',
    'actor.type',
    'actor.userId',
    'actor.email',
    'actor.name',
    'site.id',
    'site.slug',
    'site.hostname',
    'site.ownerType',
    'site.ownerId',
    'site.visibility',
    'site.status',
    'team.id',
    'team.name',
    'team.teamType',
    'deployment.id',
    'deployment.status',
    'deployment.source',
    'deployment.operation',
    'deployment.createdAt',
    'deployment.completedAt',
  ])
    assert.equal(paths.has(path), true, path);
});
```

Extend `webhook-payload.test.js` with concrete fixtures for `site.failed`, `site.disabled`, and `site.deleted`; assert `failureStage`, `errorCode`, and `change.*` are retained while `errorMessage`, `failureDiagnostics`, and provider fields are absent. Add a pending-site failure fixture with `site: { id: 'site_pending', slug: 'pending', ownerType: 'user' }` and assert it satisfies the `site.failed` required paths without a `site.status` property.

Extend `webhooks.test.js` so `GET /.xd-pages/api/console/admin/webhooks` expects `supportedEvents`, and POST/PATCH accept all four catalog values but reject `team.member.updated` with an action generated from the catalog.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
node --test apps/pages-api/src/webhook-events.test.js apps/pages-api/src/webhook-payload.test.js apps/pages-api/src/webhooks.test.js
```

Expected: FAIL because the catalog module, `supportedEvents` response, and new Payload fields do not exist yet.

- [ ] **Step 3: Implement the single-source catalog**

Create `apps/pages-api/src/webhook-events.js` with only descriptor data and mechanical derivation:

```js
const EVENT_DESCRIPTORS = [
  {
    type: 'site.deployed',
    label: '部署成功',
    description: '站点部署成功并激活后触发',
    requiredTemplateVariables: [
      'event.id',
      'event.type',
      'event.environment',
      'event.occurredAt',
      'site.id',
      'site.slug',
      'site.ownerType',
      'site.status',
    ],
    optionalTemplateVariables: [
      'actor.type',
      'actor.userId',
      'actor.email',
      'actor.name',
      'site.hostname',
      'site.ownerId',
      'site.visibility',
      'team.id',
      'team.name',
      'team.teamType',
      'deployment.id',
      'deployment.status',
      'deployment.source',
      'deployment.operation',
      'deployment.createdAt',
      'deployment.completedAt',
    ],
  },
  {
    type: 'site.failed',
    label: '部署失败',
    description: '站点部署或回滚进入失败终态时触发',
    requiredTemplateVariables: [
      'event.id',
      'event.type',
      'event.environment',
      'event.occurredAt',
      'site.id',
      'site.slug',
      'site.ownerType',
      'deployment.id',
      'deployment.status',
      'deployment.operation',
    ],
    optionalTemplateVariables: [
      'actor.type',
      'actor.userId',
      'actor.email',
      'actor.name',
      'site.hostname',
      'site.ownerId',
      'site.visibility',
      'site.status',
      'team.id',
      'team.name',
      'team.teamType',
      'deployment.source',
      'deployment.createdAt',
      'deployment.completedAt',
      'deployment.failureStage',
      'deployment.errorCode',
    ],
  },
  {
    type: 'site.disabled',
    label: '站点停用',
    description: '站点访问策略成功切换为 disabled 后触发',
    requiredTemplateVariables: [
      'event.id',
      'event.type',
      'event.environment',
      'event.occurredAt',
      'actor.type',
      'site.id',
      'site.slug',
      'site.ownerType',
      'site.visibility',
      'change.field',
      'change.previousValue',
      'change.currentValue',
    ],
    optionalTemplateVariables: [
      'actor.userId',
      'actor.email',
      'actor.name',
      'site.hostname',
      'site.ownerId',
      'site.status',
      'team.id',
      'team.name',
      'team.teamType',
    ],
  },
  {
    type: 'site.deleted',
    label: '站点删除',
    description: '站点删除流程成功完成后触发',
    requiredTemplateVariables: [
      'event.id',
      'event.type',
      'event.environment',
      'event.occurredAt',
      'actor.type',
      'site.id',
      'site.slug',
      'site.ownerType',
      'site.status',
    ],
    optionalTemplateVariables: [
      'actor.userId',
      'actor.email',
      'actor.name',
      'site.hostname',
      'site.ownerId',
      'site.visibility',
      'team.id',
      'team.name',
      'team.teamType',
    ],
  },
];

export const SUPPORTED_WEBHOOK_EVENTS = new Set(EVENT_DESCRIPTORS.map(({ type }) => type));

export function getWebhookEventCatalog() {
  return EVENT_DESCRIPTORS.map((event) => ({
    ...event,
    requiredTemplateVariables: [...event.requiredTemplateVariables],
    optionalTemplateVariables: [...event.optionalTemplateVariables],
    templateVariables: [...event.requiredTemplateVariables, ...event.optionalTemplateVariables],
  }));
}

export function getWebhookTemplateVariablePaths() {
  return new Set(getWebhookEventCatalog().flatMap((event) => event.templateVariables));
}
```

Keep `templateVariables` derived and never hand-maintained. Keep all values safe and public; do not add provider references, error messages, diagnostics, tokens, or URLs.

- [ ] **Step 4: Make Payload and Webhook API consume the catalog**

In `webhook-payload.js`, replace the hard-coded global allowlist with `getWebhookTemplateVariablePaths()` and extend `buildStandardWebhookPayload` as follows:

```js
const deployment = pickDefined({
  id: event.deployment?.id,
  status: event.deployment?.status,
  source: event.deployment?.source,
  operation: event.deployment?.operation,
  createdAt: event.deployment?.createdAt,
  completedAt: event.deployment?.completedAt,
  failureStage: event.deployment?.failureStage,
  errorCode: event.deployment?.errorCode,
});
if (Object.keys(deployment).length > 0) payload.deployment = deployment;

const change = pickDefined({
  field: event.change?.field,
  previousValue: event.change?.previousValue,
  currentValue: event.change?.currentValue,
});
if (Object.keys(change).length > 0) payload.change = change;
```

Do not serialize arbitrary event keys. In `webhooks.js`, return the catalog from `listWebhookSubscriptions`:

```js
return jsonOk({
  webhooks: webhooks.map(formatWebhookSubscription),
  supportedEvents: getWebhookEventCatalog(),
});
```

Use `SUPPORTED_WEBHOOK_EVENTS` and a dynamic joined list in `normalizeEvents`; preserve `WEBHOOK_EVENTS_INVALID` and all existing URL/template validation.

- [ ] **Step 5: Run the focused tests and commit the catalog slice**

Run:

```bash
node --test apps/pages-api/src/webhook-events.test.js apps/pages-api/src/webhook-payload.test.js apps/pages-api/src/webhooks.test.js
```

Expected: PASS. Commit only the catalog/Payload/API files with:

```bash
git add apps/pages-api/src/webhook-events.js apps/pages-api/src/webhook-events.test.js apps/pages-api/src/webhook-payload.js apps/pages-api/src/webhook-payload.test.js apps/pages-api/src/webhooks.js apps/pages-api/src/webhooks.test.js
git commit -m "feat(pages-api): 建立站点生命周期 webhook 事件目录"
```

### Task 2: 增加审计 API 的防御性 sanitizer 和资源 ID

**Files:**

- Create: `apps/pages-api/src/audit-sanitizer.js`
- Create: `apps/pages-api/src/audit-sanitizer.test.js`
- Modify: `apps/pages-api/src/admin.js:2502-2705`
- Modify: `apps/pages-api/src/admin.test.js`

- [ ] **Step 1: Write sanitizer and API regression tests**

Add `audit-sanitizer.test.js` cases for nested sensitive keys, provider references, URL reduction, primitive preservation, and bounds:

```js
test('audit sanitizer redacts secrets and provider references recursively', () => {
  const result = sanitizeAuditMetadata({
    siteSlug: 'demo',
    nested: {
      Authorization: 'Bearer secret',
      workerName: 'pages-v2-secret-reference',
      resourceRef: 'route-secret-reference',
      url: 'https://hooks.example.test/path/bearer?token=secret#fragment',
    },
  });
  assert.equal(result.siteSlug, 'demo');
  assert.equal(result.nested.Authorization, '[REDACTED]');
  assert.equal(result.nested.workerName, '[REDACTED]');
  assert.equal(result.nested.resourceRef, '[REDACTED]');
  assert.equal(result.nested.url, 'https://hooks.example.test');
});

test('audit sanitizer bounds depth, keys, arrays, and strings', () => {
  const result = sanitizeAuditMetadata({
    long: 'x'.repeat(2000),
    many: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`key${index}`, index])),
    nested: { level: { deeper: { deepest: { value: true } } } },
  });
  assert.equal(result.long, '[TRUNCATED]');
  assert.ok(Object.keys(result.many).length <= 40);
  assert.equal(result.nested.level.deeper, '[TRUNCATED]');
});
```

Extend `admin.test.js` with a record such as `{ siteId: 'site_1', routeId: 'route_1', versionId: 'ver_1', metadata: { workerName: 'provider-worker', Authorization: 'Bearer secret' } }`; assert the response contains the three nullable resource IDs, contains `[REDACTED]`, and does not contain `provider-worker` or `secret`. Assert `traceId`, `ipHash`, and `userAgentHash` are still absent from the API response.

- [ ] **Step 2: Run the tests and verify they fail**

Run:

```bash
node --test apps/pages-api/src/audit-sanitizer.test.js apps/pages-api/src/admin.test.js
```

Expected: FAIL because no sanitizer module is exported and `formatAuditEvent` currently drops resource IDs and returns raw metadata.

- [ ] **Step 3: Implement the bounded sanitizer**

Create `audit-sanitizer.js` with fixed limits (`MAX_DEPTH = 5`, `MAX_KEYS = 40`, `MAX_ARRAY_LENGTH = 30`, `MAX_STRING_LENGTH = 512`) and case-insensitive key sets. Sensitive keys are replaced with `[REDACTED]`; provider references include `workerName`, `resourceRef`, `providerResourceId`, `accountId`, `zoneId`, `namespaceId`, `databaseId`, `routeRef`, and `cleanupResourceRef`. Strings matching `http://` or `https://` are reduced to `${protocol}//${hostname}`. Only JSON primitives, arrays, and plain objects are retained; unsupported values become `[UNSUPPORTED]`.

Use this public interface:

```js
export function sanitizeAuditMetadata(value) {
  return sanitizeValue(value, 0);
}
```

Do not add event-specific allowlists. The generic sanitizer is the only second-layer boundary for unknown/future audit events.

- [ ] **Step 4: Wire sanitizer and resource IDs into `formatAuditEvent`**

In `admin.js`, import `sanitizeAuditMetadata` and change `formatAuditEvent` to return:

```js
function formatAuditEvent(event) {
  return {
    id: event.id,
    eventType: event.eventType,
    actorUserId: event.actorUserId || null,
    actorType: event.actorType,
    actor: {
      type: event.actor?.type || event.actorType || null,
      userId: event.actor?.userId || event.actorUserId || null,
      displayName: event.actor?.displayName || null,
      email: event.actor?.email || null,
    },
    siteId: event.siteId || null,
    routeId: event.routeId || null,
    versionId: event.versionId || null,
    decision: event.decision,
    statusCode: event.statusCode ?? null,
    metadata: sanitizeAuditMetadata(event.metadata),
    createdAt: event.createdAt,
  };
}
```

The Console response must never expose `traceId`, `ipHash`, `userAgentHash`, raw metadata, or provider references.

- [ ] **Step 5: Run the API tests and commit the audit boundary**

Run:

```bash
node --test apps/pages-api/src/audit-sanitizer.test.js apps/pages-api/src/admin.test.js
```

Expected: PASS. Commit:

```bash
git add apps/pages-api/src/audit-sanitizer.js apps/pages-api/src/audit-sanitizer.test.js apps/pages-api/src/admin.js apps/pages-api/src/admin.test.js
git commit -m "feat(pages-api): 脱敏管理员审计详情"
```

### Task 3: 实现 Console 审计中文目录、摘要、搜索和详情层

**Files:**

- Modify: `apps/pages-console/src/ui/admin-audit-model.js`
- Modify: `apps/pages-console/src/ui/admin-audit-model.test.js`
- Modify: `apps/pages-console/src/ui/pages/AdminAudit.jsx`
- Create: `apps/pages-console/src/ui/admin-audit-layout.test.js`
- Modify: `apps/pages-console/src/ui/styles.css`

- [ ] **Step 1: Add model tests before changing the UI**

Extend `admin-audit-model.test.js` with known/unknown labels, event-aware summaries, resource-ID search, and nested metadata search:

```js
test('audit labels keep Chinese title and stable enum', () => {
  assert.deepEqual(auditEventLabel('site.owner.transfer'), {
    title: '转移站点归属',
    technical: 'site.owner.transfer',
  });
  assert.deepEqual(auditEventLabel('future.event'), {
    title: 'future.event',
    technical: 'future.event',
  });
});

test('audit search includes resource ids and sanitized metadata', () => {
  const events = [
    {
      id: 'audit_1',
      eventType: 'site.deleted',
      actorType: 'user',
      actorUserId: 'usr_1',
      siteId: 'site_1',
      routeId: 'route_1',
      versionId: null,
      decision: 'allow',
      metadata: { siteSlug: 'demo', nested: { reason: 'owner request' } },
    },
  ];
  assert.equal(filterAuditEvents(events, { query: 'route_1', decision: 'all' }).length, 1);
  assert.equal(filterAuditEvents(events, { query: 'owner request', decision: 'all' }).length, 1);
});
```

- [ ] **Step 2: Run model tests and verify the new tests fail**

Run:

```bash
pnpm --filter @xd-cell/pages-console test -- src/ui/admin-audit-model.test.js
```

Expected: FAIL because `auditEventLabel` and the expanded search/summary behavior are not implemented.

- [ ] **Step 3: Implement the model without retaining raw metadata**

In `admin-audit-model.js`:

- Add the stable Chinese map from the design for all currently produced audit event types.
- Export `auditEventLabel(eventType)` with unknown-event fallback to the raw enum.
- Replace the two-field preference-only summary with event-aware formatting for owner transfer, team merge, cleanup, v1 retirement, and connection deny; unknown events use up to three sanitized primitive values or bounded object/array counts.
- Add a stable recursive `serializeAuditSearchValue` and include `siteId`, `routeId`, `versionId`, actor fields, label title, enum, decision/status, and sanitized metadata in `filterAuditEvents`.

Keep the model pure: it may only consume the API response and must not reach another endpoint or reconstruct hidden metadata.

- [ ] **Step 4: Add the detail layer and responsive styles**

In `AdminAudit.jsx`:

- Render the Chinese title as the primary event text and the original enum as secondary text.
- Add a `查看详情` button per row with `aria-label="查看审计事件详情"`.
- Track `selectedEvent` and render a Radix dialog or existing dialog-compatible markup containing event id, actor, decision, status code, time, nullable resource IDs, and `JSON.stringify(event.metadata, null, 2)`.
- Add copy buttons for event/resource IDs and a copy button for the exact sanitized metadata JSON; use `navigator.clipboard?.writeText` and show a local success/error state without changing the API data.
- Close the detail layer without changing filters or fetched events.

Add focused CSS in `styles.css` for a 390px-safe detail panel, 768px/1280px responsive widths, bounded horizontal scrolling for the metadata code block, and no page-level horizontal overflow. Use existing icon/button/tooltip conventions and explicit `title` plus `aria-label` values.

Add `admin-audit-layout.test.js` that reads `AdminAudit.jsx` and `styles.css` and asserts the detail button, `role="dialog"`, metadata container, copy labels, and responsive width rules exist. This repository’s Console tests are source/model tests; do not introduce a new browser test framework.

- [ ] **Step 5: Run Console tests and commit the audit UI**

Run:

```bash
pnpm --filter @xd-cell/pages-console test
```

Expected: PASS. Commit:

```bash
git add apps/pages-console/src/ui/admin-audit-model.js apps/pages-console/src/ui/admin-audit-model.test.js apps/pages-console/src/ui/pages/AdminAudit.jsx apps/pages-console/src/ui/admin-audit-layout.test.js apps/pages-console/src/ui/styles.css
git commit -m "feat(pages-console): 改进管理员审计展示与详情"
```

### Task 4: 让 Console Webhook UI 使用 pages-api 事件目录

**Files:**

- Modify: `apps/pages-console/src/ui/pages/AdminWebhooks.jsx`
- Modify: `apps/pages-console/src/ui/pages/admin-webhook-layout.test.js`
- Modify: `apps/pages-console/src/ui/api.test.js`

- [ ] **Step 1: Add UI contract tests**

Add source/API tests asserting the page does not declare a hard-coded `EVENT_OPTIONS`/single-event list, consumes `supportedEvents`, renders event labels/descriptions, and handles an existing subscription containing `team.member.updated` as an unsupported historical value with an explicit remove action and disabled save until removed. The fixture response must be `{ webhooks: [{ id: 'wh_1', events: ['site.deployed', 'team.member.updated'] }], supportedEvents }` so the test covers the real list API shape.

Use a representative API fixture:

```js
const supportedEvents = [
  {
    type: 'site.deployed',
    label: '部署成功',
    description: '站点部署成功并激活后触发',
    requiredTemplateVariables: ['event.id', 'site.slug'],
    optionalTemplateVariables: ['actor.email'],
    templateVariables: ['event.id', 'site.slug', 'actor.email'],
  },
];
```

- [ ] **Step 2: Implement dynamic event selection and historical-event handling**

In `AdminWebhooks.jsx`:

- Store `supportedEvents` from the list response; on load/error do not fall back to a local event list.
- Render checkboxes from descriptors with Chinese label, enum, and description.
- Keep `site.deployed` as the new-subscription default.
- For edit mode, compute `unsupportedEvents = webhook.events.filter((event) => !supportedEvents.some((item) => item.type === event))`; render each value in a warning area with a remove button. Disable save while any unsupported value remains; viewing deliveries and disabling a subscription remain available.
- Generate preview placeholders from the selected descriptor’s `requiredTemplateVariables` and `optionalTemplateVariables`; when multiple events are selected, provide an event switcher rather than merging structures.
- Keep existing template validation, default template, and update API shape unchanged.

- [ ] **Step 3: Run Console tests and commit**

Run:

```bash
pnpm --filter @xd-cell/pages-console test
```

Expected: PASS. Commit:

```bash
git add apps/pages-console/src/ui/pages/AdminWebhooks.jsx apps/pages-console/src/ui/pages/admin-webhook-layout.test.js apps/pages-console/src/ui/api.test.js
git commit -m "feat(pages-console): 从 pages-api 读取 webhook 事件目录"
```

### Task 5: 接入 `site.failed`，保留现有失败和幂等语义

**Files:**

- Modify: `apps/pages-api/src/deployments.js`
- Modify: `apps/pages-api/src/deployments.test.js`
- Modify: `apps/pages-api/src/webhooks.js` only if extracting the existing `site.deployed` emitter

- [ ] **Step 1: Add failing producer tests**

Extend deployment tests with:

```js
test('first persisted deploy failure emits site.failed with safe failure fields', async () => {
  const requests = [];
  const env = testEnv(store, createSnapshotStore(), {
    WEBHOOK_URL_ENCRYPTION_KEY: 'test-webhook-url-key',
    resolveWebhookHost: async () => ['8.8.8.8'],
    WEBHOOK_FETCH: async (request) => {
      requests.push(request);
      return new Response('ok', { status: 200 });
    },
    WFP_PROVIDER: {
      upload: async () => {
        throw new Error('upload failed');
      },
      verify: async () => {
        throw new Error('verify should not run');
      },
    },
  });
  await createSiteFailedSubscription(store, env);
  const response = await worker.fetch(
    deploymentRequest('https://api.pages.xd.team/.xd-pages/api/deployments', deployPayload(), {
      'Idempotency-Key': 'failed-webhook-1',
    }),
    env
  );
  assert.equal(response.status, 502);
  assert.equal(requests.length, 1);
  const payload = await requests[0].json();
  assert.equal(payload.deployment.operation, 'deploy');
  assert.equal(payload.deployment.failureStage, 'upload_worker');
  assert.equal(payload.deployment.errorCode, 'DEPLOYMENT_UPLOAD_FAILED');
  assert.equal(payload.deployment.errorMessage, undefined);
  assert.equal(payload.deployment.failureDiagnostics, undefined);
});

test('replaying a failed deployment returns the existing HTTP 200 failed envelope without redelivery', async () => {
  assert.equal(firstResponse.status, 502);
  assert.equal(replayResponse.status, 200);
  assert.equal((await replayResponse.json()).deployment.status, 'failed');
  assert.equal(deliveryRequests.length, 1);
});
```

Add a rollback fixture that seeds `ver_1`, makes `activateSiteVersion` or `writeSnapshot` fail, and asserts `deployment.operation === 'rollback'`. Add a store fixture whose `updateDeployment` throws during failed finalization and assert no `site.failed` delivery is recorded.

- [ ] **Step 2: Run the deployment tests and verify they fail**

Run:

```bash
node --test apps/pages-api/src/deployments.test.js
```

Expected: FAIL because failed finalization currently writes only the deployment row and no lifecycle event.

- [ ] **Step 3: Add a narrow failure-finalization notification path**

Preserve every existing failure patch (`errorCode`, safe `errorMessage` storage, `failureStage`, diagnostics, `completedAt`, version IDs) and preserve every existing HTTP response. Introduce a local helper in `deployments.js` with this contract:

```js
async function updateDeploymentToFailedAndNotify({ store, env, config, deploymentId, patch, actor, site }) {
  const before = await store.getDeployment(deploymentId, config.environment);
  let updated;
  try {
    updated = await store.updateDeployment(deploymentId, { ...patch, status: 'failed' });
  } catch {
    return null;
  }
  if (!updated || before?.status === 'failed') return updated;
  await emitDeploymentFailedWebhook({ store, env, config, actor, site, deployment: updated });
  return updated;
}
```

The helper must use the store’s existing environment-aware lookup when available; a missing `before` row or failed update means no event. For pending site creation, pass the synthetic site object already held by `createDeployment` rather than inventing a route/status.

The helper must:

1. Execute the current store update with the original patch and force only `status: 'failed'`.
2. Treat the result as a first failure only when the previous status was not `failed` and the updated row is `failed`.
3. Call the existing Webhook delivery function with a `site.failed` event containing only safe fields (`failureStage` and `errorCode`, never `errorMessage` or diagnostics).
4. Catch event construction/delivery failures so the original response is returned.

Use the helper for all existing deploy and rollback failure writes, including `markDeploymentFailed`, `markRuntimeConfigDeploymentFailed`, `markDeploymentStateWriteFailed`, provider upload/verify failures, route activation/snapshot failures, and rollback failure branches. Do not introduce terminal CAS, reconcile changes, new retries, or a new HTTP response mapping.

If the existing `site.deployed` emitter is generalized, extract only its event construction and call to `deliverWebhookEventToSubscriptions`; keep the current `ctx.waitUntil(promise)`/await fallback at the caller and keep the current best-effort catch.

- [ ] **Step 4: Run focused deployment tests and commit**

Run:

```bash
node --test apps/pages-api/src/deployments.test.js apps/pages-api/src/webhook-payload.test.js
```

Expected: PASS, including the pre-existing success deployment webhook tests. Commit:

```bash
git add apps/pages-api/src/deployments.js apps/pages-api/src/deployments.test.js apps/pages-api/src/webhooks.js
git commit -m "feat(pages-api): 为部署失败发送 lifecycle webhook"
```

### Task 6: 接入 `site.disabled`，只消费既有 access-policy/route 成功结果

**Files:**

- Modify: `apps/pages-api/src/index.js`
- Modify: `apps/pages-api/src/console.js`
- Modify: `apps/pages-api/src/sites.js`
- Modify: `apps/pages-api/src/deployments.js`
- Modify: `apps/pages-api/src/admin.js`
- Modify: `apps/pages-api/src/console.test.js`
- Modify: `apps/pages-api/src/sites.test.js`
- Modify: `apps/pages-api/src/deployments.test.js`

- [ ] **Step 1: Add failing visibility producer tests**

Add focused tests for:

- Console access update from `org` to `disabled`: one delivery after snapshot success, `change.previousValue === 'org'`, `change.currentValue === 'disabled'`.
- CLI-managed `PATCH /api/sites/:id` from `org` to `disabled`: one delivery after snapshot success.
- Same visibility update, ACL-only update, and snapshot failure: zero `site.disabled` deliveries.
- Deploy owner-transfer whose final route visibility changes to `disabled`: one delivery in the existing deployment request; no additional route mutation.

The assertions must inspect delivery payloads, not only event counts, and must verify the original API status/body is unchanged.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run:

```bash
node --test apps/pages-api/src/console.test.js apps/pages-api/src/sites.test.js apps/pages-api/src/deployments.test.js
```

Expected: FAIL because none of these producers currently emits `site.disabled`.

- [ ] **Step 3: Thread the optional ExecutionContext through existing handlers**

Change only the existing fetch-to-handler signatures used by the relevant producer tasks:

```js
await handleConsoleAdminApi(request, env, config, store, ctx);
await handleConsoleApi(request, env, config, store, ctx);
await handleSitesApi(request, env, config, store, ctx);
await handleVersionsApi(request, env, config, store, ctx);
```

Pass `ctx` to the access-policy and delete producers in Tasks 6–7, and to the rollback failure producer in Task 5. Preserve the current behavior when `ctx` is absent: await the delivery before returning. When `ctx.waitUntil` exists, register the existing delivery Promise and return the original business response without awaiting the external webhook.

- [ ] **Step 4: Add post-success event checks at the existing commit points**

In Console and CLI access updates, keep the existing sequence exactly intact:

```js
const route = await store.updateSiteVisibility(site.id, { visibility, updatedAt: readNow(env) }, config.environment);
// Existing ACL replacement remains unchanged.
const snapshotError = await refreshActiveRouteSnapshot(env, store, site, route, config.environment);
if (snapshotError) {
  // Existing restore behavior remains unchanged.
  return snapshotError;
}
if (previousRoute?.visibility !== 'disabled' && route?.visibility === 'disabled') {
  await scheduleLifecycleWebhook(ctx, () =>
    emitSiteDisabledWebhook({ store, env, config, actor: session, site, previousRoute, route })
  );
}
return jsonOk({ access: { visibility: route.visibility, aclEntries: nextAclEntries.map(formatAclEntry) } });
```

Wrap the event construction/delivery in the same best-effort catch used by `emitDeploymentSucceededWebhook`; do not add a scheduler abstraction. Do not add CAS gates, route rollback logic, pointer reconciliation, ACL revisions, or a new interpretation of snapshot uncertainty. ACL-only updates and repeated `disabled` saves must not emit.

In the successful deploy path, compare the saved pre-deploy route visibility with the final activated route visibility and emit `site.disabled` when the existing owner-transfer/deploy flow produced the transition. Do not call a generic visibility mutator from deploy; reuse the deployment’s existing activation/snapshot result.

- [ ] **Step 5: Run focused tests and commit**

Run:

```bash
node --test apps/pages-api/src/console.test.js apps/pages-api/src/sites.test.js apps/pages-api/src/deployments.test.js apps/pages-api/src/index.test.js
```

Expected: PASS. Commit:

```bash
git add apps/pages-api/src/index.js apps/pages-api/src/console.js apps/pages-api/src/sites.js apps/pages-api/src/deployments.js apps/pages-api/src/admin.js apps/pages-api/src/console.test.js apps/pages-api/src/sites.test.js apps/pages-api/src/deployments.test.js apps/pages-api/src/index.test.js
git commit -m "feat(pages-api): 为站点停用发送 lifecycle webhook"
```

### Task 7: 接入 `site.deleted` 并传递认证 actor

**Files:**

- Modify: `apps/pages-api/src/index.js`
- Modify: `apps/pages-api/src/console.js`
- Modify: `apps/pages-api/src/admin.js`
- Modify: `apps/pages-api/src/sites.js`
- Modify: `apps/pages-api/src/console.test.js`
- Modify: `apps/pages-api/src/admin.test.js`
- Modify: `apps/pages-api/src/sites.test.js`

- [ ] **Step 1: Add failing delete producer tests**

Cover all three required producers:

```js
test('workspace console delete emits site.deleted with authenticated actor', async () => {
  assert.equal(response.status, 200);
  assert.equal(payload.event.type, 'site.deleted');
  assert.equal(payload.actor.type, 'user');
  assert.equal(payload.site.status, 'deleted');
});

test('platform-admin force delete emits site.deleted with the admin actor', async () => {
  assert.equal(response.status, 200);
  assert.equal(payload.actor.type, 'user');
});

test('CLI-managed delete emits site.deleted with the authenticated API actor', async () => {
  assert.equal(response.status, 200);
  assert.equal(payload.actor.type, 'user');
});
```

Add zero-delivery cases for not found, repeated deletion, snapshot failure, and an existing delete path that does not confirm success.

- [ ] **Step 2: Run focused delete tests and verify they fail**

Run:

```bash
node --test apps/pages-api/src/console.test.js apps/pages-api/src/admin.test.js apps/pages-api/src/sites.test.js
```

Expected: FAIL because delete functions currently have no actor argument and no lifecycle delivery.

- [ ] **Step 3: Thread actor/session into all delete calls**

Change the shared Console delete signature to accept an explicit actor argument in `options` (`options.actor`), and update the exact callers to pass `{ actor: sessionActor }` for workspace DELETE and `{ force: true, actor: sessionActor }` for platform-admin force DELETE. Pass `auth.actor` to the CLI delete function. Do not create an actorless fallback.

Keep the existing delete, deleted snapshot, hostname claim, and cleanup order. After the existing flow has returned no error and the cleanup enqueue has completed/best-effort returned, emit:

```js
{
  type: 'site.deleted',
  actor: authenticatedActor,
  site: {
    id: deleted.id,
    slug: deleted.slug,
    hostname: previousRoute?.hostname,
    ownerType: site.ownerType || 'user',
    ownerId: site.ownerId || site.ownerUserId,
    visibility: previousRoute?.visibility || site.defaultVisibility,
    status: 'deleted',
  },
  team: team ? { id: team.id, name: team.name || null, teamType: team.teamType || null } : undefined,
}
```

Do not include worker names, route snapshots, cleanup task IDs, hostname claim internals, or provider references. Preserve all existing responses and cleanup behavior.

- [ ] **Step 4: Run focused tests and commit**

Run:

```bash
node --test apps/pages-api/src/console.test.js apps/pages-api/src/admin.test.js apps/pages-api/src/sites.test.js apps/pages-api/src/index.test.js
```

Expected: PASS. Commit:

```bash
git add apps/pages-api/src/index.js apps/pages-api/src/console.js apps/pages-api/src/admin.js apps/pages-api/src/sites.js apps/pages-api/src/console.test.js apps/pages-api/src/admin.test.js apps/pages-api/src/sites.test.js apps/pages-api/src/index.test.js
git commit -m "feat(pages-api): 为站点删除发送 lifecycle webhook"
```

### Task 8: 同步架构文档并完成全量验证

**Files:**

- Modify: `docs/architecture/xd-cell-console.md`

- [ ] **Step 1: Update the Console architecture source**

Replace the “第一版只支持 `site.deployed`” statement with the current four-event catalog and exact trigger timing. Document:

- `site.deployed` compatibility and the fact that successful rollback does not emit it.
- `site.failed` only after persisted first failure, including deploy/rollback operation and safe failure fields.
- `site.disabled` only after existing access-policy/route snapshot success, including Console, CLI-managed, and deploy owner-transfer producers.
- `site.deleted` for workspace Console DELETE, platform-admin force DELETE, and CLI-managed DELETE, with authenticated actor.
- forbidden Payload fields and generic audit sanitizer boundary.
- best-effort delivery, no exactly-once/outbox/signing secret, receiver idempotency headers, and existing `ctx.waitUntil`/await behavior.
- explicit statement that no new route lifecycle, rollback, reconciliation, CAS, timeout, or delivery protocol is introduced.
- historical `site.failed`/`site.disabled` subscriptions become active when their producers are deployed; unsupported historical values remain visible in the Console editor until removed.

- [ ] **Step 2: Run documentation and focused verification**

Run:

```bash
git diff --check
node --test scripts/agent-docs.test.js scripts/pages-v2-docs.test.js scripts/public-docs.test.js
node --test apps/pages-api/src/audit-sanitizer.test.js apps/pages-api/src/webhook-events.test.js apps/pages-api/src/webhook-payload.test.js apps/pages-api/src/webhook-dispatcher.test.js apps/pages-api/src/webhooks.test.js
pnpm --filter @xd-cell/pages-console test
```

Expected: all commands pass. If workspace aliases are unavailable, record the exact `ERR_MODULE_NOT_FOUND` limitation rather than changing package configuration for this feature.

- [ ] **Step 3: Run repository verification before handoff**

Run:

```bash
pnpm lint
pnpm test
```

Expected: PASS. Review `git diff --check`, `git status --short`, and ensure only intended tracked files are changed; do not add `.agents/skills/` or `.claude/` local symlinks.

- [ ] **Step 4: Final implementation review**

Before claiming completion, verify every design requirement against the diff:

- no OpenAPI/CLI/pages-skill changes;
- no database migration;
- no generic audit-to-Webhook conversion;
- no route lifecycle redesign;
- no raw metadata, provider resource reference, secret, token, URL query/path, error message, or diagnostics in Webhook/audit output;
- no actorless delete Payload;
- no duplicate event on repeat/ACL-only/failed snapshot/not-found paths;
- existing `site.deployed` Payload, headers, subscription behavior, and asynchronous business responses remain compatible.

### Task 9: 修复 master 合并后的 reviewer findings

**Files:**

- Modify: `apps/pages-api/src/deployments.js`
- Modify: `apps/pages-api/src/deployments.test.js`
- Modify: `apps/pages-api/src/console.test.js`
- Modify: `apps/pages-console/src/ui/admin-audit-model.js`
- Modify: `apps/pages-console/src/ui/admin-audit-model.test.js`
- Modify: `apps/pages-console/src/ui/pages/AdminAudit.jsx`
- Modify: `apps/pages-console/src/ui/admin-audit-layout.test.js`

- [ ] **Step 1: Add focused failing tests**

Cover only the six reviewed regressions:

- provider failure plus a failed terminal-state write returns `DEPLOYMENT_STATE_WRITE_FAILED` and sends no `site.failed` delivery;
- owner-transfer failures build `site.failed` from the restored owner;
- Console delete snapshot failure, missing site, and repeated delete do not emit `site.deleted`;
- rollback `SITE_POLICY_CONFLICT` keeps the historical `wfp` provider fallback;
- `admin.site.exposure` has a Chinese label;
- unknown audit events can summarize top-level resource ids and `metadata: null` is rendered/copied as `null`.

- [ ] **Step 2: Preserve strict and best-effort failure writes**

Keep the best-effort behavior only for the branches that already used the old best-effort helpers. For branches that previously awaited `store.updateDeployment(... status: 'failed')` directly, surface a failed terminal write through the existing `DEPLOYMENT_STATE_WRITE_FAILED` 503 response. Emit `site.failed` only after the failed row is persisted.

- [ ] **Step 3: Use the restored site in owner-transfer failure payloads**

In the three owner-transfer rollback branches that currently discard `restoreDeployOwnerTransferAfterFailure()`'s return value, assign the restored site before finalizing the failed deployment. Do not change route activation, rollback, or snapshot protocols.

- [ ] **Step 4: Apply the small audit and diagnostics fixes**

Preserve `wfp` for the nullable-provider rollback policy-conflict branch, add the `admin.site.exposure` label, pass the complete audit event to the summary formatter, and serialize nullable metadata without replacing it with `{}`.

- [ ] **Step 5: Verify the affected surfaces**

Run:

```bash
node --test apps/pages-api/src/deployments.test.js apps/pages-api/src/sites.test.js apps/pages-api/src/console.test.js apps/pages-api/src/admin.test.js
node --test apps/pages-api/src/audit-sanitizer.test.js apps/pages-api/src/lifecycle-webhooks.test.js apps/pages-api/src/webhook-events.test.js apps/pages-api/src/webhook-payload.test.js apps/pages-api/src/webhooks.test.js
node --test apps/pages-console/src/ui/admin-audit-model.test.js apps/pages-console/src/ui/admin-audit-layout.test.js apps/pages-console/src/ui/admin-webhook-model.test.js apps/pages-console/src/ui/admin-webhook-layout.test.js
node --test scripts/agent-docs.test.js scripts/pages-v2-docs.test.js scripts/public-docs.test.js
pnpm lint
git diff --check
```

Do not add a new state machine, CAS, outbox, timeout, route lifecycle protocol, or unrelated refactor.

### Task 10: 收紧通用审计 sanitizer 的剩余边界

**Files:**

- Modify: `apps/pages-api/src/audit-sanitizer.js`
- Modify: `apps/pages-api/src/audit-sanitizer.test.js`

- [ ] **Step 1: Add a failing regression test**

Cover an `admin.site.exposure`-style free-text reason containing an embedded HTTP(S) URL, plus the verified `sessionId`, `providerResourceIds`, and `authTokenValue` key variants. Require the URL to retain only its protocol and hostname while preserving surrounding safe prose, and require the key variants to become `[REDACTED]`.

- [ ] **Step 2: Apply the smallest generic sanitizer change**

Sanitize embedded HTTP(S) URL spans with the existing origin-only rule and add only the explicit normalized key aliases covered by the regression test. Do not introduce event-specific metadata allowlists or broad substring matching.

- [ ] **Step 3: Verify the affected and repository-wide surfaces**

Run the sanitizer and Admin API focused tests, format the two edited files, then run `pnpm lint`, `pnpm test`, and `git diff --check` before final review.
