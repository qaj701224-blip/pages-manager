# v1 Email Takeover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. This session uses inline execution; do not create workers or subagents.

**Goal:** Let pages-api automatically remove an active v1 site when a strongly authenticated v2 actor with the same email creates or deploys the same slug, then atomically continue as a v2 site.

**Architecture:** Keep all v1-specific runtime behavior under `apps/pages-api/src/legacy-v1/`. The module reads the v1 `SITES` KV binding, validates the legacy owner marker, removes only the verified Cloudflare exact route and Worker, and asks the store to atomically convert the active v1 claim while creating the v2 site. Existing sites and deployments handlers call the same helper; `apps/server` is not changed.

**Tech Stack:** Cloudflare Workers, D1, KV, Cloudflare Workers API, JavaScript ESM, `node:test`, Wrangler template rendering, GitHub Actions.

---

## File map

Create:

- `apps/pages-api/src/legacy-v1/ownership.js`: read and validate `V1_SITES` metadata and compare the canonical actor email with `pages_<email>`.
- `apps/pages-api/src/legacy-v1/cloudflare-cleanup.js`: isolated Cloudflare route/script client and destructive safety checks.
- `apps/pages-api/src/legacy-v1/takeover.js`: orchestration, error classification, atomic site creation handoff, and deferred KV cleanup task creation.
- `apps/pages-api/src/legacy-v1/takeover.test.js`: ownership, cleanup, retry, and orchestration tests.

Modify:

- `apps/pages-api/src/store.js`: add atomic `createSiteByTakingOverV1Claim()`.
- `apps/pages-api/src/test-store.js`: mirror the atomic takeover contract for handler tests.
- `apps/pages-api/src/sites.js`: use the shared helper for `POST /.xd-pages/api/sites`; map takeover errors without exposing v1 metadata.
- `apps/pages-api/src/deployments.js`: use the same helper from pending site creation.
- `apps/pages-api/src/admin.js`: execute deferred `v1_sites_kv_record` cleanup tasks and keep the existing WFP cleanup path isolated.
- `apps/pages-api/src/index.js`: scheduled cleanup already calls `runDueDeploymentCleanups`; no new cron is needed unless the implementation exposes a separate runner hook.
- `apps/pages-api/wrangler.production.template.toml`: add the production `V1_SITES` KV binding.
- `apps/pages-api/wrangler.staging.template.toml`: add the staging `V1_SITES` KV binding.
- `scripts/render-pages-v2-wrangler.mjs`: require and replace `V1_SITES_KV_NAMESPACE_ID` for pages-api only.
- `scripts/render-pages-v2-wrangler.test.js`: test the new required replacement and production/staging binding isolation.
- `scripts/put-pages-v2-secrets.sh`: inject `CF_ZONE_ID_NEW` into pages-api while retaining the existing `CF_ACCOUNT_ID` and `CF_API_TOKEN` injection.
- `scripts/pages-v2-secrets.test.js`: test the new required pages-api secret.
- `.github/workflows/deploy-pages-v2.yml`: pass the production v1 KV namespace id to template rendering and `CF_ZONE_ID_NEW` to pages-api secret validation/injection.
- `.github/workflows/deploy-pages-v2-staging.yml`: pass the staging equivalents.
- `apps/pages-api/src/openapi.js`: add takeover error responses to existing create/deploy operation contracts; do not add a path.
- `apps/pages-api/src/openapi.test.js`: lock the new error code set and absence of a takeover endpoint.
- `apps/pages-api/src/sites.test.js`: cover API-level creation takeover and deny paths.
- `apps/pages-api/src/deployments.test.js`: cover direct deployment takeover and deferred KV cleanup.
- `apps/pages-api/src/index.test.js`: cover scheduled retry of the new cleanup resource type.
- `apps/pages-api/src/admin.test.js`: cover manual cleanup execution and resource allowlists.
- `docs/operations/legacy-api-and-site-publishing-retirement.md`: document the private v2-driven exception without restoring v1 public API.
- `docs/operations/v2-workers-domain-rollout.md`: document exact route removal, D1 CAS, failure recovery, and staging gates.
- `docs/api-boundary.md`: update only if the current boundary table needs the create/deploy conflict behavior.

No implementation task imports `apps/server/src`. No generated `wrangler.toml`, `.env`, or real resource id is committed.

### Task 1: Lock ownership and Cloudflare cleanup contracts with tests

**Files:**
- Create: `apps/pages-api/src/legacy-v1/takeover.test.js`

- [ ] **Step 1: Add ownership fixture tests for the exact legacy marker.**

Use a fake KV binding with `get(key, 'json')` and assert that `pages_<canonical email>` succeeds only for an active v1 claim and matching environment/hostname/script metadata. Include these deny cases before implementation exists:

```js
test('resolves a matching active v1 site without returning the token', async () => {
  const target = await resolveLegacyV1SiteTarget({
    sites: kvWith({ token: 'pages_owner@example.com', scriptName: 'pages-guide', url: 'https://guide.workers.xd.team' }),
    actor: { userId: 'usr_1', email: 'OWNER@example.com' },
    claim: activeV1Claim(),
    environment: 'production',
    slug: 'guide',
    hostname: 'guide.workers.xd.team',
  });

  assert.equal(target.scriptName, 'pages-guide');
  assert.equal('token' in target, false);
  assert.equal('email' in target, false);
});

test('rejects a held, conflicted, or non-v1 claim before reading destructive resources', async () => {
  await assert.rejects(
    resolveLegacyV1SiteTarget({ ...fixtureInput(), claim: { ...activeV1Claim(), status: 'held' } }),
    { code: 'HOSTNAME_CLAIM_CONFLICT' }
  );
});
```

- [ ] **Step 2: Add Cloudflare safety tests before implementation.**

Inject a fake Cloudflare client and assert the call order `listRoutes → deleteRoute → deleteScript`; assert no delete is issued for wildcard patterns, mismatched script bindings, protected scripts, wrong environments, or malformed API results. Treat not-found route/script responses as idempotent success.

- [ ] **Step 3: Run the new focused test and verify it fails for missing modules.**

Run: `node --test apps/pages-api/src/legacy-v1/takeover.test.js`

Expected: FAIL because the new `legacy-v1` modules and exports do not exist.

### Task 2: Implement isolated v1 ownership and Cloudflare adapters

**Files:**
- Create: `apps/pages-api/src/legacy-v1/ownership.js`
- Create: `apps/pages-api/src/legacy-v1/cloudflare-cleanup.js`
- Modify: `apps/pages-api/src/legacy-v1/takeover.test.js`

- [ ] **Step 1: Implement `ownership.js` with closed validation.**

Export `resolveLegacyV1SiteTarget({ sites, actor, claim, environment, slug, hostname })`. It must:

- require `claim.ownerSystem === 'v1'` and `claim.status === 'active'`;
- require the exact environment, normalized slug, hostname family, and hostname;
- read `await sites.get(slug, 'json')` and reject missing/non-object metadata;
- require `scriptName` to be a string with the environment v1 prefix;
- require `claim.ownerRef` to match `scriptName` when ownerRef exists;
- require `token` to use the exact lowercase `pages_` prefix and compare its email suffix with normalized actor email;
- return only `{ environment, slug, hostname, routePattern, scriptName, claimOwnerId, claimOwnerRef }`.

Use error objects with stable internal codes, but map ownership denial to `HOSTNAME_CLAIM_CONFLICT` at the API boundary. Never include token or email in an error object that reaches a response or log.

- [ ] **Step 2: Implement `cloudflare-cleanup.js` with its own narrow REST client.**

Export `cleanupLegacyV1CloudflareSite({ env, config, target })` and support `env.V1_CLOUDFLARE_CLIENT` as a test seam. The default client uses `env.fetch || globalThis.fetch`, `env.CF_ACCOUNT_ID`, `env.CF_API_TOKEN`, and `env.CF_ZONE_ID_NEW`.

The adapter must list zone routes, verify the exact target pattern is bound to `target.scriptName`, delete that route, then delete the account Worker script. Normalize 404 as already absent; reject all other failed Cloudflare responses with `V1_TAKEOVER_CLEANUP_FAILED`. Sanitize Cloudflare error payloads before internal diagnostics.

- [ ] **Step 3: Run the focused tests and make them pass.**

Run: `node --test apps/pages-api/src/legacy-v1/takeover.test.js`

Expected: PASS for ownership matching/denial, route/script safety, deletion order, and idempotent not-found behavior.

### Task 3: Add atomic D1 takeover mutation

**Files:**
- Modify: `apps/pages-api/src/store.js`
- Modify: `apps/pages-api/src/test-store.js`
- Modify: `apps/pages-api/src/store.test.js`

- [ ] **Step 1: Add failing store contract tests.**

Test `createSiteByTakingOverV1Claim(input, expectedClaim, environment)` with an active v1 claim. Assert one call creates the site, route, owner member, audit event, and v2 claim. Add a stale snapshot test that changes `owner_ref` or status and asserts no site, route, member, or claim mutation remains.

- [ ] **Step 2: Implement the D1 batch mutation.**

Build the same site/route/member records as `createSite`, but replace the normal claim insert/reacquire statement with a conditional update:

```sql
UPDATE hostname_claims
SET owner_system = 'v2', owner_id = ?, owner_ref = ?, status = 'active',
    source = 'v1_email_takeover', acquired_at = ?, lease_expires_at = NULL,
    released_at = NULL, reuse_hold_until = NULL, release_reason = NULL, updated_at = ?
WHERE hostname = ? AND environment = ? AND normalized_slug = ?
  AND owner_system = 'v1' AND owner_id = ? AND status = 'active'
  AND (owner_ref = ? OR owner_ref IS NULL)
```

Execute the conditional update, a guard that fails when it changes zero rows, site/route/member inserts, and the sanitized takeover audit statement in one D1 batch. Preserve the original claim id/created timestamp. Use the existing SQL constraint mapping to return `SITE_SLUG_CONFLICT` or `HOSTNAME_CLAIM_CONFLICT`.

- [ ] **Step 3: Mirror the mutation in `test-store.js`.**

Implement the same compare-and-set semantics against the in-memory claim map. Check the existing site slug, verify all expected claim fields, update the claim and insert the same records, then record the audit event. Do not make the test store read KV or invoke Cloudflare.

- [ ] **Step 4: Run store-focused tests.**

Run: `node --test apps/pages-api/src/store.test.js apps/pages-api/src/store-contract.test.js`

Expected: PASS, including stale claim rejection and no partial mutation.

### Task 4: Implement takeover orchestration and wire both API entry points

**Files:**
- Create: `apps/pages-api/src/legacy-v1/takeover.js`
- Modify: `apps/pages-api/src/sites.js`
- Modify: `apps/pages-api/src/deployments.js`
- Modify: `apps/pages-api/src/legacy-v1/takeover.test.js`
- Modify: `apps/pages-api/src/sites.test.js`
- Modify: `apps/pages-api/src/deployments.test.js`

- [ ] **Step 1: Add failing orchestration tests.**

Use a test store, fake `V1_SITES`, and fake Cloudflare client. Cover:

- normal v2 create does not read KV or call Cloudflare;
- active v1 claim plus matching actor email deletes legacy resources, atomically creates v2 state, deletes KV, and returns the normal site;
- mismatched email returns `HOSTNAME_CLAIM_CONFLICT` with no Cloudflare DELETE;
- cleanup failure preserves v1 claim/KV and returns `V1_TAKEOVER_CLEANUP_FAILED`;
- stale claim after cleanup returns `V1_TAKEOVER_STATE_CHANGED` without creating v2 state;
- KV deletion failure creates a cleanup task after v2 commit;
- direct deployments API performs the same takeover before pending site creation;
- the existing sites → deployments sequence does not require a new request field.

- [ ] **Step 2: Implement `takeover.js`.**

Export `createSiteWithLegacyV1Takeover({ env, config, store, actor, siteInput })`. The function first calls `store.createSite(siteInput)`. Only on `HOSTNAME_CLAIM_CONFLICT` does it load the exact hostname claim and call `resolveLegacyV1SiteTarget`. It then calls Cloudflare cleanup, invokes `store.createSiteByTakingOverV1Claim`, and finally deletes the KV key.

For KV deletion failure, call `store.createDeploymentResourceCleanupTask` with:

```js
{
  id: nextId(env, 'cleanup'),
  environment: config.environment,
  resourceType: 'v1_sites_kv_record',
  resourceRef: siteInput.slug,
  siteId: siteInput.id,
  cleanupReason: 'v1_email_takeover_kv_delete',
  status: 'pending',
  cleanupAfter: readNow(env),
}
```

If task creation also fails, record only a closed-set diagnostic and still return the committed v2 site. Never retry Cloudflare deletion after the D1 v2 claim has committed.

- [ ] **Step 3: Add a shared site creation wrapper in `sites.js`.**

Replace the direct `store.createSite({ ... })` call in `createSite()` with `createSiteWithLegacyV1Takeover({ ... })`. Keep `siteCreateErrorResponse()` as the single public mapping point and add mappings for takeover configuration, cleanup, and state-change codes without exposing details.

- [ ] **Step 4: Wire pending deployment site creation.**

Change `applyPendingDeploySiteCreation(store, site)` to receive `env`, `config`, and `actor`, then call the same wrapper with `site.pendingSiteCreation`. Preserve the existing deployment failure bookkeeping when the wrapper returns a `Response` or throws a mapped error.

- [ ] **Step 5: Run focused handler tests.**

Run: `node --test apps/pages-api/src/legacy-v1/takeover.test.js apps/pages-api/src/sites.test.js apps/pages-api/src/deployments.test.js`

Expected: PASS, with existing create/deploy behavior unchanged outside the eligible active-v1 case.

### Task 5: Add deferred v1 KV cleanup to the existing task runner

**Files:**
- Modify: `apps/pages-api/src/admin.js`
- Modify: `apps/pages-api/src/index.test.js`
- Modify: `apps/pages-api/src/admin.test.js`
- Modify: `apps/pages-api/src/store-contract.test.js`

- [ ] **Step 1: Add failing cleanup task tests.**

Create a `v1_sites_kv_record` task and assert the scheduled runner deletes only the configured `V1_SITES` key, marks the task succeeded, treats a missing key as success, and marks KV errors failed for retry. Assert WFP tasks still use the existing WFP executor and an unsupported resource type is rejected.

- [ ] **Step 2: Add an isolated v1 KV cleanup executor.**

In `admin.js`, branch `executeDeploymentCleanupTask` by resource type before WFP-specific route/version checks. Add `executeV1SitesKvCleanupTask(env, config, store, task)` that validates the task resource ref as a normalized slug, obtains `env.V1_SITES`, marks the task running, calls `delete(slug)`, and finishes the task. Keep `v1_sites_kv_record` out of `isManagedWfpCleanupResource()`.

- [ ] **Step 3: Add task response safety checks.**

Keep cleanup task responses free of token/KV content. The task resource ref may contain only a normalized slug; reject strings containing `/`, `*`, `..`, uppercase characters, or a hostname.

- [ ] **Step 4: Run cleanup-focused tests.**

Run: `node --test apps/pages-api/src/index.test.js apps/pages-api/src/admin.test.js apps/pages-api/src/store-contract.test.js`

Expected: PASS for scheduled and manual retry behavior, with all existing WFP cleanup tests unchanged.

### Task 6: Add Worker bindings, runtime secret injection, and workflow coverage

**Files:**
- Modify: `apps/pages-api/wrangler.production.template.toml`
- Modify: `apps/pages-api/wrangler.staging.template.toml`
- Modify: `scripts/render-pages-v2-wrangler.mjs`
- Modify: `scripts/render-pages-v2-wrangler.test.js`
- Modify: `scripts/put-pages-v2-secrets.sh`
- Modify: `scripts/pages-v2-secrets.test.js`
- Modify: `.github/workflows/deploy-pages-v2.yml`
- Modify: `.github/workflows/deploy-pages-v2-staging.yml`

- [ ] **Step 1: Add failing template and secret tests.**

Assert pages-api rendering requires `V1_SITES_KV_NAMESPACE_ID` and produces `binding = "V1_SITES"` with the supplied namespace id. Assert staging and production render their own values. Assert pages-api secret injection requires and prints only the name `CF_ZONE_ID_NEW` in dry-run mode, never the value.

- [ ] **Step 2: Add the KV binding to both templates.**

Append a second `[[kv_namespaces]]` entry after `ROUTE_SNAPSHOTS`:

```toml
[[kv_namespaces]]
binding = "V1_SITES"
id = "__V1_SITES_KV_NAMESPACE_ID__"
```

- [ ] **Step 3: Extend renderer replacements for pages-api only.**

Add `V1_SITES_KV_NAMESPACE_ID` to `REQUIRED_TOKENS_BY_APP['apps/pages-api']`. Do not add it to any other app. Reuse the existing TOML safety, environment boundary, and unresolved placeholder checks.

- [ ] **Step 4: Inject the zone secret.**

Add `CF_ZONE_ID_NEW` to the pages-api `SECRET_NAMES` list in `put-pages-v2-secrets.sh`. Keep `CF_ACCOUNT_ID` and `CF_API_TOKEN` unchanged. Add the secret to the validation and injection environment blocks in both v2 deploy workflows.

- [ ] **Step 5: Pass environment-specific namespace ids.**

Add `V1_SITES_KV_NAMESPACE_ID: ${{ secrets.SITES_KV_NAMESPACE_ID }}` to the pages-api renderer environment in production and staging workflows. Do not print or commit the value.

- [ ] **Step 6: Run configuration tests.**

Run: `node --test scripts/render-pages-v2-wrangler.test.js scripts/pages-v2-secrets.test.js scripts/workflows.test.js`

Expected: PASS, including no production/staging cross-environment strings and no runtime secrets in rendered templates.

### Task 7: Update API contracts and operations documentation

**Files:**
- Modify: `apps/pages-api/src/openapi.js`
- Modify: `apps/pages-api/src/openapi.test.js`
- Modify: `docs/operations/legacy-api-and-site-publishing-retirement.md`
- Modify: `docs/operations/v2-workers-domain-rollout.md`
- Modify: `docs/api-boundary.md` only if its current matrix needs the new error codes

- [ ] **Step 1: Add the four internal conflict error codes to existing create/deploy responses.**

Add `V1_TAKEOVER_CONFIG_UNAVAILABLE`, `V1_TAKEOVER_CLEANUP_FAILED`, and `V1_TAKEOVER_STATE_CHANGED` alongside existing hostname conflict responses. Keep the API paths and successful schemas unchanged. Add tests asserting no takeover path or token field appears in OpenAPI.

- [ ] **Step 2: Update v1 retirement documentation.**

State that v1 public management requests remain 410 and v1 Worker runtime is not required for takeover. Document the narrowly scoped v2-side cleanup of a matching active v1 site and the fact that old resources otherwise remain retained.

- [ ] **Step 3: Update v2 domain operations documentation.**

Document staging-first verification for exact route deletion, Worker deletion, active claim CAS, failed cleanup retry, and deferred KV cleanup. Preserve the rule that wildcard router routes and unrelated Workers are never deleted.

- [ ] **Step 4: Run documentation tests.**

Run: `node --test scripts/pages-v2-docs.test.js scripts/public-docs.test.js`

Expected: PASS without adding a new user-facing API document source.

### Task 8: Verify the complete change

**Files:**
- No new files; inspect the complete diff.

- [ ] **Step 1: Run pages-api focused tests.**

Run: `node --test apps/pages-api/src/legacy-v1/takeover.test.js apps/pages-api/src/store.test.js apps/pages-api/src/sites.test.js apps/pages-api/src/deployments.test.js apps/pages-api/src/admin.test.js apps/pages-api/src/index.test.js apps/pages-api/src/openapi.test.js`

- [ ] **Step 2: Run lint.**

Run: `pnpm lint`

- [ ] **Step 3: Run the full test suite.**

Run: `pnpm test`

- [ ] **Step 4: Check security and environment boundaries.**

Run: `git diff --check` and inspect `git diff --stat`, then verify no `.env`, generated `wrangler.toml`, real namespace id, zone id, API token, v1 token, or KV payload is present in the diff. Confirm staging and production workflow values remain separate.

- [ ] **Step 5: Report verification without committing.**

Do not create a git commit unless the user explicitly requests one. Report focused tests, lint, full tests, any unrelated pre-existing failures, and the exact changed file paths.
