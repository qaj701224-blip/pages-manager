# Legacy API Retirement and Site Publishing Freeze Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retire the v1 `apps/server` management API with a stable 410 migration response, freeze new Site Publishing work without deleting existing code or Cloudflare resources, and preserve Platform Dev Lane plus all existing sites and data.

**Architecture:** Keep the `apps/server` Worker, API Custom Domain, route, `SITES` KV, old site Workers, exact routes, DNS, hostname claims, and historical database records. Add an early retirement response before v1 IP and business handlers. Freeze Site Publishing at its existing write/review entry points with static code paths (no runtime feature flag); retain `preview.js` and old workflows as dormant historical code, while preserving read-only job/history access where safe and leaving Platform Dev dispatch paths unchanged.

**Tech Stack:** Cloudflare Worker JavaScript, Node `node:test`, Gateway route/control-plane handlers, MySQL-backed PublishingJob repository, GitHub Actions workflow fixtures.

---

### Task 1: Add the retirement protocol contract tests

**Files:**
- Create: `apps/server/src/index.test.js`
- Create: `apps/gateway/src/publishing/retirement.test.js`
- Test: `apps/server/src/index.test.js`
- Test: `apps/gateway/src/publishing/retirement.test.js`

- [ ] **Step 1: Write the failing `apps/server` Worker tests**

  Import the default Worker from `apps/server/src/index.js` and assert:

  ```js
  test('health remains available without IP authorization', async () => {
    const response = await worker.fetch(
      new Request('https://api.workers.xd.team/health', {
        headers: { 'CF-Connecting-IP': '203.0.113.10' },
      }),
      { IP_ALLOWLIST: '10.0.0.0/8' }
    );
    assert.equal(response.status, 200);
  });

  test('retired v1 endpoints return 410 before IP authorization and without parsing input', async () => {
    const response = await worker.fetch(
      new Request('https://api.workers.xd.team/deploy', {
        method: 'POST',
        headers: { 'CF-Connecting-IP': '203.0.113.10' },
        body: 'not multipart',
      }),
      { IP_ALLOWLIST: '10.0.0.0/8' }
    );
    const body = await response.json();
    assert.equal(response.status, 410);
    assert.equal(body.error, 'LEGACY_API_RETIRED');
    assert.match(body.message, /xd-sites/);
    assert.match(body.message, /更新 Cindy/);
    assert.match(body.message, /skills\.xindong\.com\/skills\/xd-cell/);
    assert.equal(Object.hasOwn(body, 'hint'), false);
    assert.equal(Object.hasOwn(body, 'migration'), false);
  });
  ```

- [ ] **Step 2: Run the tests and confirm the expected RED failure**

  Run:

  ```bash
  node --test apps/server/src/index.test.js
  ```

  Expected: the new tests fail because `/deploy` currently returns an IP error or reaches the legacy route instead of returning `410`.

- [ ] **Step 3: Write the failing Gateway retirement helper tests**

  Assert that the shared static contract exposes:

  ```js
  assert.equal(SITE_PUBLISHING_RETIRED_CODE, 'PUBLISHING_LANE_RETIRED');
  assert.match(SITE_PUBLISHING_RETIRED_MESSAGE, /站点自动发布能力已停止/);
  assert.equal(sitePublishingRetiredResponse().status, 410);
  ```

  The Gateway helper must not inspect environment variables or introduce a feature flag.

- [ ] **Step 4: Run the helper tests and confirm RED**

  Run:

  ```bash
  node --test apps/gateway/src/publishing/retirement.test.js
  ```

  Expected: module or exported contract is missing.

### Task 2: Implement the v1 `apps/server` retirement response

**Files:**
- Create: `apps/server/src/retirement.js`
- Modify: `apps/server/src/index.js`
- Test: `apps/server/src/index.test.js`

- [ ] **Step 1: Add the static retirement constants and response helper**

  Create `apps/server/src/retirement.js` with:

  ```js
  import { jsonResponse } from '@xd/worker-kit';

  export const LEGACY_API_RETIRED_CODE = 'LEGACY_API_RETIRED';
  export const LEGACY_API_RETIRED_MESSAGE =
    '如果你使用 Cindy 客户端，请使用 xd-sites 插件；如果无法安装或找不到插件，请先更新 Cindy 客户端。' +
    '非 Cindy 客户端请使用 https://skills.xindong.com/skills/xd-cell 的 skill。';

  export function legacyApiRetiredResponse() {
    return jsonResponse(
      {
        error: LEGACY_API_RETIRED_CODE,
        message: LEGACY_API_RETIRED_MESSAGE,
      },
      410
    );
  }
  ```

- [ ] **Step 2: Add the early guard in `apps/server/src/index.js`**

  Keep `/health` before the retirement guard. For every other request, return `legacyApiRetiredResponse()` before reading `CF-Connecting-IP`, checking `IP_ALLOWLIST`, matching routes, or invoking handlers. Preserve the existing Router registrations and all handler files so the code remains available for historical reference.

- [ ] **Step 3: Run the focused server tests and verify GREEN**

  Run:

  ```bash
  node --test apps/server/src/index.test.js
  ```

  Expected: health is 200; `/deploy`, `/list`, `/site/:name`, `/openapi.json`, `/readme.md`, `/skill.md`, unknown paths, and unauthorized callers all receive the retirement response.

### Task 3: Implement static Site Publishing retirement helpers and API freeze

**Files:**
- Create: `apps/gateway/src/publishing/retirement.js`
- Create: `apps/gateway/src/publishing/retirement.test.js`
- Modify: `apps/gateway/src/publishing/api-handlers.js`
- Modify: `tests/apps/gateway/index.test.js`

- [ ] **Step 1: Add Gateway constants and JSON response helper**

  Create a static helper with:

  ```js
  import { jsonResponse } from '@xd/worker-kit';

  export const SITE_PUBLISHING_RETIRED_CODE = 'PUBLISHING_LANE_RETIRED';
  export const SITE_PUBLISHING_RETIRED_MESSAGE =
    '站点自动发布能力已停止服务，新的发布任务不会再创建或继续执行。';

  export function sitePublishingRetiredResponse() {
    return jsonResponse(
      {
        error: SITE_PUBLISHING_RETIRED_CODE,
        message: SITE_PUBLISHING_RETIRED_MESSAGE,
      },
      410
    );
  }
  ```

- [ ] **Step 2: Write the failing create-job API test**

  Add an integration test for `POST /api/publishing-jobs` that supplies a valid Gateway token and valid job payload, then asserts `410`, `PUBLISHING_LANE_RETIRED`, and no call to `store.createJob` or worker start. Keep the existing `GET` job/list/events routes unchanged so retained history remains readable.

- [ ] **Step 3: Add the static guard to `handleCreatePublishingJob()`**

  Return `sitePublishingRetiredResponse()` before parsing the request body or calling `getStore()`. Leave `handleListPublishingJobs`, `handleGetPublishingJob`, and `handleGetPublishingJobEvents` read-only.

- [ ] **Step 4: Run the focused Gateway API tests and verify GREEN**

  Run:

  ```bash
  node --test tests/apps/gateway/index.test.js --test-name-pattern='publishing job|PublishingJob'
  ```

  Expected: create requests return 410; existing read-only tests retain their behavior.

### Task 4: Freeze Slack site-publishing creation without affecting Platform Dev

**Files:**
- Modify: `apps/gateway/src/control-plane/slack-event-handlers.js`
- Modify: `apps/gateway/src/control-plane/slack-interaction-handlers.js`
- Modify: `apps/gateway/src/slack/followup.js`
- Modify: `apps/gateway/src/slack/work-item-tools.js`
- Test: `tests/apps/gateway/index.test.js`
- Test: `tests/apps/gateway/platform-dev-lane.test.js`

- [ ] **Step 1: Add failing Slack confirmation/intake tests**

  Assert that site-publishing confirmation and intake return an ephemeral response containing `SITE_PUBLISHING_RETIRED_MESSAGE`, do not call `store.createJob`, and do not enqueue a site worker. Add a neighboring Platform Dev assertion proving `pages_confirm_platform_issue` still creates/dispatches a platform item.

- [ ] **Step 2: Add static guards only at site-publishing branches**

  In the existing `pages_confirm_issue` and `shouldCreateSlackJob(...)` branches, return `slackAckResponse({ response_type: 'ephemeral', text: SITE_PUBLISHING_RETIRED_MESSAGE })` before `store.createJob`. In follow-up/retry/work-item actions, reject only `workItemKind === 'site_publishing'`; leave `platform_dev` branches unchanged.

- [ ] **Step 3: Run focused Slack and Platform Dev tests**

  Run:

  ```bash
  node --test tests/apps/gateway/index.test.js --test-name-pattern='Slack|publishing|follow-up'
  node --test tests/apps/gateway/platform-dev-lane.test.js
  ```

  Expected: site-publishing writes are retired; Platform Dev tests remain green.

### Task 5: Stop review-driven Site Publishing progression while retaining callback history

**Files:**
- Modify: `apps/gateway/src/github/review-webhooks.js`
- Modify: `apps/gateway/src/github/site-check-webhooks.js`
- Modify: `apps/gateway/src/github/resource-webhooks.js`
- Modify: `apps/gateway/src/github/review-gate.js`
- Modify: `apps/gateway/src/control-plane/executor-callback-handlers.js`
- Test: `tests/apps/gateway/index.test.js`
- Test: `tests/apps/gateway/platform-dev-lane.test.js`

- [ ] **Step 1: Add failing tests for retired site callbacks**

  Assert that site PublishingJob review/site-check/resource events return HTTP 200 with an ignored retirement marker and do not transition jobs into `previewing` or start a worker. Assert that callbacks for a pre-cancelled job remain `200` and ignored. Keep Platform Dev webhook and callback behavior unchanged.

- [ ] **Step 2: Add static site-only guards**

  Before any site job transition to `previewing`, `fixing`, or a reopened active state, return an ignored response carrying `PUBLISHING_LANE_RETIRED`. Do not return non-2xx to GitHub webhook delivery paths, because GitHub would retry them.

- [ ] **Step 3: Run the focused webhook/callback tests**

  Run:

  ```bash
  node --test tests/apps/gateway/index.test.js --test-name-pattern='review|site-check|callback|reopen'
  node --test tests/apps/gateway/platform-dev-lane.test.js
  ```

### Task 6: Validate dormant legacy code and preservation boundaries

**Files:**
- Modify: `.github/workflows/pages-preview.yml` only if required to remove manual dispatch while retaining the file
- Modify: `tests/workflows/pages-agent.test.js` only to assert the workflow is not dispatchable after freeze
- Modify: relevant docs only if they currently claim Site Publishing remains active

- [ ] **Step 1: Verify no normal path can create or advance Site Publishing**

  Run focused Gateway tests and inspect route registration. Do not require `rg` to have zero `/deploy` references because legacy code is intentionally retained.

- [ ] **Step 2: Verify resource-preservation invariants**

  Run repository checks that confirm no change deletes or unbinds `SITES`, Worker scripts, routes, hostname claims, or historical PublishingJob data. Review `git diff --stat` and `git diff -- apps/server apps/gateway .github k8s`.

- [ ] **Step 3: Run verification commands**

  Run:

  ```bash
  node --test apps/server/src/index.test.js
  node --test tests/apps/gateway/index.test.js --test-name-pattern='publishing|review|site-check|callback|Slack'
  node --test tests/apps/gateway/platform-dev-lane.test.js
  pnpm lint
  ```

  Do not claim completion until each command exits successfully and the output is reviewed.
