# XDMaker S2S Access Key Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let trusted xdt-api exchange a Feishu-backed XDMaker identity for a 24-hour personal XD Cell access key, revoke those keys, link users by email in the existing table, and expose the key source/revocation in Console.

**Architecture:** Add a controlled `pages-api` S2S lane behind the existing `IP_ALLOWLIST`, HMAC request signing, timestamp validation, nonce reservation, and atomic rate buckets. Reuse the existing access-key format and owner-scoped deploy authorization; add only source and issued-session metadata. Keep identity, cryptographic authentication, token orchestration, storage, and Console presentation in separate modules.

**Tech Stack:** Cloudflare Workers, Web Crypto, D1/SQLite migrations, Node.js 22 ESM, built-in `node:test`, React 19 Console, Wrangler templates, GitHub Actions.

---

## File Structure

- Create `apps/pages-api/migrations/0014_xdmaker_s2s_access_keys.sql`: identity, key-source, nonce, rate-limit schema.
- Modify `apps/pages-api/src/schema.js` and `schema.test.js`: keep bootstrap schema aligned with migration 14.
- Modify `apps/pages-api/src/store.js`, `test-store.js`, and `store.test.js`: identity lookup/binding, guards, atomic issue/revoke, cleanup, mapping.
- Create `apps/pages-api/src/s2s-auth.js` and `s2s-auth.test.js`: canonical input, registry, HMAC, timestamp, nonce, client rate limit.
- Create `apps/pages-api/src/s2s-tokens.js` and `s2s-tokens.test.js`: validate input, resolve identity, issue/replace/revoke keys, user rate limit, audit.
- Modify `apps/pages-api/src/access-keys.js` and `access-keys.test.js`: reusable key material, source formatting, ordinary-key compatibility.
- Modify `apps/pages-api/src/auth.js` and `auth.test.js`: S2S-only session-version freshness.
- Modify `apps/pages-api/src/index.js`, `index.test.js`, `openapi.js`, and `openapi.test.js`: route and development contract.
- Modify `apps/pages-api/src/slack-alerts.js` and `slack-alerts.test.js`: safe S2S anomaly alert payload.
- Modify `apps/pages-console/src/ui/access-keys-model.js`, its test, and `pages/AccessKeys.jsx`: XDMaker source label and existing revoke action.
- Modify Wrangler templates, `scripts/render-pages-v2-wrangler.mjs`, render/secret scripts, workflows, and their tests: registry validation and secret injection.
- Modify `docs/api-boundary.md`, `docs/architecture/publishing-and-runtime.md`, and `docs/operations/resources-and-deployment.md`: controlled integration and staging runbook.

### Task 1: Add Migration 14 and Bootstrap Schema

**Files:**

- Create: `apps/pages-api/migrations/0014_xdmaker_s2s_access_keys.sql`
- Modify: `apps/pages-api/src/schema.test.js`
- Modify: `apps/pages-api/src/schema.js`

- [ ] **Step 1: Write the failing schema assertions**

Extend `schema.test.js`:

```js
test('schema defines XDMaker identity, access-key source, and S2S guards', () => {
  const sql = createSchemaSql().join('\n');
  assert.equal(SCHEMA_VERSION, 14);
  assert.match(sql, /feishu_open_id TEXT/);
  assert.match(sql, /created_source TEXT NOT NULL DEFAULT 'xd_sso'/);
  assert.match(sql, /issued_source TEXT NOT NULL DEFAULT 'legacy'/);
  assert.match(sql, /issued_session_version INTEGER/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS s2s_nonces/);
  assert.match(sql, /PRIMARY KEY \(environment, client_id, nonce\)/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS s2s_rate_limits/);
  assert.match(sql, /PRIMARY KEY \(environment, scope, subject, bucket_start\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_normalized[\s\S]*lower\(trim\(email\)\)/);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS idx_users_feishu_open_id/);
});
```

- [ ] **Step 2: Run the schema test and verify it fails**

Run: `node --test apps/pages-api/src/schema.test.js`

Expected: FAIL with schema version 13 and missing columns/tables.

- [ ] **Step 3: Create migration 14**

Create `0014_xdmaker_s2s_access_keys.sql`:

```sql
ALTER TABLE users ADD COLUMN feishu_open_id TEXT;
ALTER TABLE users ADD COLUMN created_source TEXT NOT NULL DEFAULT 'xd_sso';

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email_normalized
  ON users(lower(trim(email)));
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_feishu_open_id
  ON users(feishu_open_id)
  WHERE feishu_open_id IS NOT NULL;

ALTER TABLE access_keys ADD COLUMN issued_source TEXT NOT NULL DEFAULT 'legacy';
ALTER TABLE access_keys ADD COLUMN issued_session_version INTEGER;

CREATE TABLE IF NOT EXISTS s2s_nonces (
  environment TEXT NOT NULL,
  client_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  received_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (environment, client_id, nonce)
);

CREATE TABLE IF NOT EXISTS s2s_rate_limits (
  environment TEXT NOT NULL,
  scope TEXT NOT NULL,
  subject TEXT NOT NULL,
  bucket_start TEXT NOT NULL,
  request_count INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (environment, scope, subject, bucket_start)
);

CREATE INDEX IF NOT EXISTS idx_s2s_nonces_expires_at ON s2s_nonces(expires_at);
CREATE INDEX IF NOT EXISTS idx_s2s_rate_limits_expires_at ON s2s_rate_limits(expires_at);
CREATE INDEX IF NOT EXISTS idx_access_keys_s2s_owner_created
  ON access_keys(environment, issued_source, owner_user_id, created_at);
```

- [ ] **Step 4: Mirror the migration in `schema.js`**

Set `SCHEMA_VERSION = 14`, add both columns to `users`, both columns to `access_keys`, add the two tables, and append the five indexes exactly as defined in the migration.

- [ ] **Step 5: Run schema tests and migration hygiene checks**

Run:

```bash
node --test apps/pages-api/src/schema.test.js
rg -n "0014_xdmaker_s2s_access_keys|SCHEMA_VERSION = 14" apps/pages-api
```

Expected: PASS and one migration-14/schema-version match.

- [ ] **Step 6: Commit the schema**

```bash
git add apps/pages-api/migrations/0014_xdmaker_s2s_access_keys.sql apps/pages-api/src/schema.js apps/pages-api/src/schema.test.js
git commit -m "feat(pages-api): 增加 XDMaker S2S 数据模型"
```

### Task 2: Implement Same-Table Identity Association

**Files:**

- Modify: `apps/pages-api/src/store.test.js`
- Modify: `apps/pages-api/src/test-store.js:18-104`
- Modify: `apps/pages-api/src/store.js:18-174,4433-4447`
- Modify: `apps/pages-auth/src/oauth-endpoints.test.js`

- [ ] **Step 1: Write failing identity tests**

Add to `store.test.js`:

```js
test('XDMaker identities use normalized email and conditional Feishu binding', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-14T00:00:00.000Z' });
  const created = await store.createUser({
    userId: 'usr_xdmaker',
    email: 'user@example.test',
    realname: 'Example User',
    employeeStatus: 'active',
    feishuOpenId: 'ou_first',
    createdSource: 'xdmaker',
  });

  assert.equal((await store.getUserByEmail('USER@example.test')).id, created.id);
  assert.equal((await store.getUserByFeishuOpenId('ou_first')).id, created.id);
  assert.equal(created.createdSource, 'xdmaker');
  assert.equal(await store.bindUserFeishuOpenId(created.id, 'ou_second'), false);
  assert.equal(await store.bindUserFeishuOpenId(created.id, 'ou_first'), true);
});

test('SSO upsert reuses an XDMaker user by email and preserves platform user id', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-14T00:00:00.000Z' });
  await store.createUser({
    userId: 'usr_platform',
    email: 'user@example.test',
    employeeStatus: 'active',
    feishuOpenId: 'ou_user',
    createdSource: 'xdmaker',
  });
  const linked = await store.upsertUserFromSso({
    userId: 'usr_xd_sso',
    email: 'USER@example.test',
    accountId: 'acct_1',
    employeeStatus: 'active',
    sessionVersion: 1,
  });

  assert.equal(linked.id, 'usr_platform');
  assert.equal(linked.accountId, 'acct_1');
  assert.equal(linked.createdSource, 'xdmaker');
  assert.equal(linked.feishuOpenId, 'ou_user');
});
```

Add a conflict case asserting `upsertUserFromSso` rejects with `USER_IDENTITY_CONFLICT` when incoming `userId` and normalized email already belong to different rows.

- [ ] **Step 2: Run store tests and verify they fail**

Run: `node --test apps/pages-api/src/store.test.js`

Expected: FAIL because identity fields and lookup/bind methods do not exist.

- [ ] **Step 3: Extend user records and lookup methods in both stores**

Add these fields to `createUser` and include `feishu_open_id`/`created_source` in its D1 insert:

```js
feishuOpenId: input.feishuOpenId || null,
createdSource: input.createdSource || 'xd_sso',
```

In `upsertUserFromSso`, preserve the established source and Feishu binding:

```js
feishuOpenId: existing?.feishuOpenId || null,
createdSource: existing?.createdSource || 'xd_sso',
```

Add these fields to `mapUser`:

```js
feishuOpenId: row.feishu_open_id || null,
createdSource: row.created_source || 'xd_sso',
```

Add the D1 lookups:

```js
async getUserByEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  const row = await this.db.prepare('SELECT * FROM users WHERE lower(trim(email)) = ?').bind(normalized).first();
  return row ? mapUser(row) : null;
}

async getUserByFeishuOpenId(feishuOpenId) {
  const row = await this.db.prepare('SELECT * FROM users WHERE feishu_open_id = ?').bind(feishuOpenId).first();
  return row ? mapUser(row) : null;
}

async bindUserFeishuOpenId(userId, feishuOpenId) {
  const result = await this.db
    .prepare(
      `UPDATE users SET feishu_open_id = ?, updated_at = ?
       WHERE user_id = ? AND (feishu_open_id IS NULL OR feishu_open_id = ?)`
    )
    .bind(feishuOpenId, this.now(), userId, feishuOpenId)
    .run();
  return result?.meta?.changes === 1;
}
```

Mirror the same behavior with map scans and conditional mutation in `test-store.js`, enforcing case-insensitive unique email and unique non-null Feishu id on create.

- [ ] **Step 4: Resolve SSO upserts by id and normalized email**

Before building the existing SSO upsert record, add:

```js
const incomingUserId = input.userId || input.id;
const byId = await this.getUser(incomingUserId);
const byEmail = await this.getUserByEmail(input.email);
if (byId && byEmail && byId.id !== byEmail.id) throw new Error('USER_IDENTITY_CONFLICT');
const existing = byId || byEmail;
const userId = byId?.id || byEmail?.id || incomingUserId;
```

Use this canonical `userId` in the existing SQL and return `this.getUser(userId)`. Apply equivalent logic in `test-store.js`. Preserve `created_source` and `feishu_open_id` in all SSO updates.

- [ ] **Step 5: Add a pages-auth callback regression**

In `oauth-endpoints.test.js`, seed an XDMaker-origin user in `PAGES_STORE`, complete a callback with a different SSO `userId` but matching email, and assert the created auth session subject is the original platform `user_id`.

- [ ] **Step 6: Run identity-focused tests**

Run:

```bash
node --test apps/pages-api/src/store.test.js apps/pages-auth/src/oauth-endpoints.test.js
```

Expected: PASS.

- [ ] **Step 7: Commit identity association**

```bash
git add apps/pages-api/src/store.js apps/pages-api/src/store.test.js apps/pages-api/src/test-store.js apps/pages-auth/src/oauth-endpoints.test.js
git commit -m "feat(pages-api): 按邮箱关联 XDMaker 用户"
```

### Task 3: Add HMAC Authentication, Replay Protection, and Atomic Rate Buckets

**Files:**

- Create: `apps/pages-api/src/s2s-auth.test.js`
- Create: `apps/pages-api/src/s2s-auth.js`
- Modify: `apps/pages-api/src/store.test.js`
- Modify: `apps/pages-api/src/test-store.js`
- Modify: `apps/pages-api/src/store.js`

- [ ] **Step 1: Write failing canonical/HMAC tests**

Create `s2s-auth.test.js` with fixed inputs:

```js
test('S2S signature binds environment, client, key id, path, timestamp, nonce, and raw body', async () => {
  const canonical = await buildS2SCanonicalInput({
    environment: 'staging',
    clientId: 'xdmaker',
    keyId: 'key_202607',
    method: 'POST',
    pathname: '/.xd-pages/api/s2s/tokens',
    timestamp: '1784016000',
    nonce: 'nonce_0123456789',
    rawBody: '{"email":"user@example.test"}',
  });
  assert.equal(
    canonical,
    'xd-cell-s2s-v1\nstaging\nxdmaker\nkey_202607\nPOST\n/.xd-pages/api/s2s/tokens\n1784016000\nnonce_0123456789\n' +
      (await sha256HexForText('{"email":"user@example.test"}'))
  );
  assert.notEqual(await createS2SSignature('secret-a', canonical), await createS2SSignature('secret-b', canonical));
});
```

Add table-driven failures for missing headers, unknown client/key, query strings, timestamps outside `+/-300`, malformed nonce, bad signature, and bodies over 16 KiB. Assert two keys for one client work and a third registry key is rejected as invalid server configuration.

- [ ] **Step 2: Write failing nonce/rate-store tests**

Add to `store.test.js`:

```js
test('S2S nonce replay is rejected and atomic rate buckets stop at the limit', async () => {
  const store = createTestPagesStore({ now: () => '2026-07-14T08:00:00.000Z' });
  const nonce = {
    environment: 'staging',
    clientId: 'xdmaker',
    nonce: 'nonce_0123456789',
    endpoint: '/.xd-pages/api/s2s/tokens',
    receivedAt: '2026-07-14T08:00:00.000Z',
    expiresAt: '2026-07-14T08:10:00.000Z',
  };
  assert.equal(await store.reserveS2SNonce(nonce), true);
  assert.equal(await store.reserveS2SNonce(nonce), false);

  for (let count = 1; count <= 5; count += 1) {
    assert.deepEqual(
      await store.consumeS2SRateLimit({
        environment: 'staging',
        scope: 'user',
        subject: 'email_digest',
        bucketStart: '2026-07-14T08:00:00.000Z',
        expiresAt: '2026-07-14T08:20:00.000Z',
        limit: 5,
      }),
      { allowed: true, count }
    );
  }
  assert.deepEqual(
    await store.consumeS2SRateLimit({
      environment: 'staging',
      scope: 'user',
      subject: 'email_digest',
      bucketStart: '2026-07-14T08:00:00.000Z',
      expiresAt: '2026-07-14T08:20:00.000Z',
      limit: 5,
    }),
    { allowed: false, count: 5 }
  );
});
```

- [ ] **Step 3: Run the new tests and verify they fail**

Run: `node --test apps/pages-api/src/s2s-auth.test.js apps/pages-api/src/store.test.js`

Expected: FAIL because the module and guard methods do not exist.

- [ ] **Step 4: Implement canonical signing and registry validation**

In `s2s-auth.js`, export `buildS2SCanonicalInput`, `createS2SSignature`, and `authenticateS2SRequest`. Use Web Crypto HMAC-SHA256 and base64url without padding. Parse `S2S_CLIENT_KEYS` entries as exactly `clientId:keyId:secretEnvName`, require `/^S2S_SECRET_[A-Z0-9_]+$/`, reject duplicates, and allow at most two keys per client.

The success result must be:

```js
return {
  ok: true,
  clientId,
  keyId,
  timestamp,
  nonce,
  rawBody,
};
```

Failures return `{ ok: false, code, status, message, action }` using the stable codes from the design. Compare signatures with a length-checking constant-time string comparator.

Use these exact auth mappings: missing headers -> `S2S_AUTH_REQUIRED`/401; unknown or malformed client registry entry -> `S2S_CLIENT_INVALID`/401; timestamp outside the window -> `S2S_TIMESTAMP_INVALID`/401; signature mismatch -> `S2S_SIGNATURE_INVALID`/401; invalid nonce, query string, method, content type, or body size -> `S2S_REQUEST_INVALID`/400.

- [ ] **Step 5: Implement nonce and rate methods in both stores**

Use `INSERT` plus unique-constraint handling for `reserveS2SNonce`. Implement the rate counter as one SQLite statement:

```sql
INSERT INTO s2s_rate_limits (
  environment, scope, subject, bucket_start, request_count, expires_at
) VALUES (?, ?, ?, ?, 1, ?)
ON CONFLICT(environment, scope, subject, bucket_start) DO UPDATE SET
  request_count = s2s_rate_limits.request_count + 1,
  expires_at = excluded.expires_at
WHERE s2s_rate_limits.request_count < ?
RETURNING request_count
```

Return `{ allowed: true, count }` when a row is returned, otherwise `{ allowed: false, count: limit }`. Add `cleanupExpiredS2SGuards(now)` that deletes expired rows from both tables.

- [ ] **Step 6: Compose replay-safe authentication ordering**

After HMAC succeeds, `authenticateS2SRequest` must reserve the nonce first. A duplicate returns `S2S_REPLAY_DETECTED` before touching the client rate bucket. A new nonce consumes `scope=client`, `subject=clientId`, limit 300, then returns success. Add `retryAfter: 600` to rate failures.

- [ ] **Step 7: Run HMAC and guard tests**

Run: `node --test apps/pages-api/src/s2s-auth.test.js apps/pages-api/src/store.test.js`

Expected: PASS.

- [ ] **Step 8: Commit the S2S authentication boundary**

```bash
git add apps/pages-api/src/s2s-auth.js apps/pages-api/src/s2s-auth.test.js apps/pages-api/src/store.js apps/pages-api/src/store.test.js apps/pages-api/src/test-store.js
git commit -m "feat(pages-api): 增加 S2S HMAC 与防重放门禁"
```

### Task 4: Add Access-Key Source, Reusable Material, and Freshness

**Files:**

- Modify: `apps/pages-api/src/access-keys.test.js`
- Modify: `apps/pages-api/src/access-keys.js`
- Modify: `apps/pages-api/src/auth.test.js`
- Modify: `apps/pages-api/src/auth.js`
- Modify: `apps/pages-api/src/store.js`
- Modify: `apps/pages-api/src/test-store.js`

- [ ] **Step 1: Write failing source and compatibility assertions**

Extend existing access-key creation tests:

```js
assert.equal(body.accessKey.issuedSource, 'cli');
assert.equal((await store.getAccessKeyById('ak_1')).issuedSessionVersion, null);
```

For Console-created personal and team keys assert `issuedSource === 'console'` and `issuedSessionVersion === null`.

- [ ] **Step 2: Write the failing S2S freshness auth test**

Add to `auth.test.js`:

```js
test('only access keys issued with a session version enforce freshness', async () => {
  const plaintext = createAccessKeyPlaintext({ environment: 'production', keyId: 'ak_s2s', bytes: new Uint8Array(24).fill(7) });
  const store = await createSeededStore();
  await store.createAccessKey({
    id: 'ak_s2s',
    environment: 'production',
    ownerUserId: 'usr_1',
    keyHash: await hashAccessKey(plaintext, 'pepper-secret'),
    pepperId: 'pepper_1',
    name: 'XDMaker',
    scopes: ['deploy:site', 'read:site', 'rollback:site'],
    siteId: null,
    expiresAt: '2026-07-15T00:00:00.000Z',
    issuedSource: 'xdmaker_s2s',
    issuedSessionVersion: 1,
  });
  const user = store.users.get('usr_1');
  user.sessionVersion = 2;

  const stale = await authenticateApiRequest(bearerRequest(plaintext), accessKeyEnv(), store, config, '2026-07-14T00:00:00.000Z');
  assert.equal(stale.ok, false);
  assert.equal(stale.error.code, 'ACCESS_KEY_SESSION_STALE');
});
```

- [ ] **Step 3: Run access-key/auth tests and verify they fail**

Run: `node --test apps/pages-api/src/access-keys.test.js apps/pages-api/src/auth.test.js`

Expected: FAIL on missing fields and freshness behavior.

- [ ] **Step 4: Extract reusable key material creation**

Export this function from `access-keys.js` and make the existing creation handler call it:

```js
export async function createAccessKeyMaterial(env, config, input) {
  const pepper = readActiveAccessKeyPepper(env);
  const id = input.id || nextId(env, 'ak');
  const plaintext = createAccessKeyPlaintext({
    environment: config.environment,
    keyId: id,
    bytes: randomBytes(env, 24),
  });
  return {
    plaintext,
    record: {
      id,
      environment: config.environment,
      ownerType: input.ownerType,
      ownerId: input.ownerId,
      ownerUserId: input.ownerUserId,
      createdByUserId: input.createdByUserId,
      keyHash: await hashAccessKey(plaintext, pepper.secret),
      pepperId: pepper.id,
      name: input.name,
      scopes: input.scopes,
      siteId: input.siteId || null,
      expiresAt: input.expiresAt || null,
      issuedSource: input.issuedSource,
      issuedSessionVersion: input.issuedSessionVersion || null,
    },
  };
}
```

Pass `issuedSource: 'cli'` from the CLI API and `issuedSource: 'console'` from both Console owners. Do not pass `issuedSessionVersion` from ordinary paths.

- [ ] **Step 5: Persist/map/format source and issued session version**

Add `issued_source` and `issued_session_version` to the D1 insert and mapper, plus equivalent fields in `test-store.js`. Add only `issuedSource` to `formatAccessKey`; do not expose `issuedSessionVersion` in API responses.

- [ ] **Step 6: Enforce freshness after the user active check**

In `authenticateAccessKey`, before updating last-used time:

```js
if (
  Number.isInteger(accessKey.issuedSessionVersion) &&
  accessKey.issuedSessionVersion > 0 &&
  accessKey.issuedSessionVersion !== user.sessionVersion
) {
  return authError('ACCESS_KEY_SESSION_STALE', 'Access key session is stale.', 401, 'Ask XDMaker to exchange a new access key.');
}
```

- [ ] **Step 7: Run access-key/auth tests**

Run: `node --test apps/pages-api/src/access-keys.test.js apps/pages-api/src/auth.test.js apps/pages-api/src/store.test.js`

Expected: PASS, including ordinary key compatibility.

- [ ] **Step 8: Commit access-key metadata and freshness**

```bash
git add apps/pages-api/src/access-keys.js apps/pages-api/src/access-keys.test.js apps/pages-api/src/auth.js apps/pages-api/src/auth.test.js apps/pages-api/src/store.js apps/pages-api/src/test-store.js
git commit -m "feat(pages-api): 标记并失效 XDMaker Access Key"
```

### Task 5: Implement S2S Issue, Replace, and Revoke

**Files:**

- Create: `apps/pages-api/src/s2s-tokens.test.js`
- Create: `apps/pages-api/src/s2s-tokens.js`
- Modify: `apps/pages-api/src/store.js`
- Modify: `apps/pages-api/src/test-store.js`

- [ ] **Step 1: Write a signed-request test helper and failing issue tests**

In `s2s-tokens.test.js`, build raw JSON first, construct canonical input with `buildS2SCanonicalInput`, sign with `createS2SSignature`, and set all five S2S headers plus `CF-Connecting-IP`.

Add tests asserting:

```js
assert.equal(response.status, 201);
assert.match(body.token, /^xdp_stg_ak_s2s_[a-f0-9]{48}$/);
assert.equal(body.source, 'xdmaker_s2s');
assert.deepEqual(stored.scopes, ['deploy:site', 'read:site', 'rollback:site']);
assert.equal(stored.siteId, null);
assert.equal(stored.expiresAt, '2026-07-15T08:00:00.000Z');
assert.equal(stored.issuedSessionVersion, 1);
assert.equal(
  JSON.stringify(await store.listAuditEvents()),
  JSON.stringify(await store.listAuditEvents()).replace(body.token, '')
);
```

Cover an existing active email, a new `createdSource=xdmaker` user, inactive/unknown rejection, Feishu/email conflicts, conditional bind conflict, and two calls producing different keys.

- [ ] **Step 2: Add failing replacement and revocation tests**

Test that `replaces_key_id` revokes an older same-user XDMaker key only after the new key exists. Table-test cross-user, `issuedSource=console`, and cross-environment replacement as `S2S_REPLACEMENT_KEY_INVALID`.

Test revoke bodies `{ key_id }` and `{ email }`; assert repeated revoke returns 200 with `revoked_count: 0`, email revoke leaves ordinary keys active, and responses contain no plaintext/hash/pepper/Feishu id.

- [ ] **Step 3: Add failing user-rate and anomaly tests**

Use the same normalized email with a forced key-write failure, retry five times, and assert the sixth attempt returns 429. Assert `Retry-After: 600`, the subject is a SHA-256 digest rather than email, count 3 creates `s2s.anomaly.detect`, and an Asia/Shanghai 02:00 issue creates an off-hours anomaly.

- [ ] **Step 4: Run token tests and verify they fail**

Run: `node --test apps/pages-api/src/s2s-tokens.test.js`

Expected: FAIL because the handler and atomic store methods do not exist.

- [ ] **Step 5: Implement request normalization and identity resolution**

In `s2s-tokens.js`, accept only the two exact POST paths. Parse the authenticated raw body as an object. Normalize email with trim/lowercase, require a valid email, a 1-128 character Feishu id without controls, a 1-80 character display name, and at most one revoke selector.

Compute the user rate subject exactly as:

```js
const subject = await sha256HexForText(`xdmaker-s2s:user:${email}`);
```

Consume limit 5 before key generation. Resolve by email and Feishu id; reject split matches, reject Feishu match with a different email, require existing status `active`, conditionally bind an empty Feishu field, or create `usr_*` with `createdSource: 'xdmaker'` and no department fields.

- [ ] **Step 6: Implement atomic issue/replace storage**

Add `issueS2SAccessKey({ accessKey, replacesKeyId, auditEvents, now })` to both stores. D1 uses one `db.batch` containing the access-key insert, an optional conditional revoke restricted to same environment/user/source, and audit statements. Reject invalid replacement before building the batch.

Create key material with:

```js
const { plaintext, record } = await createAccessKeyMaterial(env, config, {
  ownerType: 'user',
  ownerId: user.id,
  ownerUserId: user.id,
  createdByUserId: user.id,
  name: 'XDMaker',
  scopes: ['deploy:site', 'read:site', 'rollback:site'],
  siteId: null,
  expiresAt: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
  issuedSource: 'xdmaker_s2s',
  issuedSessionVersion: user.sessionVersion,
});
```

Return the exact one-time response only after persistence succeeds:

```js
return jsonOk(
  {
    token: plaintext,
    key_id: record.id,
    expires_at: record.expiresAt,
    source: 'xdmaker_s2s',
    actor: {
      user_id: user.id,
      email: user.email,
      display_name: user.realname,
      created_source: user.createdSource,
    },
  },
  201
);
```

Return plaintext only after the batch succeeds.

- [ ] **Step 7: Implement source-scoped idempotent revocation**

Add store queries restricted by `environment` and `issued_source = 'xdmaker_s2s'`. Revoke by key id or normalized-email owner, update `revoked_at`/`revoked_reason = 'xdmaker_s2s_revoke'`, record one audit event per changed key, and return `{ revokedCount, keyIds }`. Already revoked, expired, or unknown targets return an empty result.

Map that internal result to the stable wire response:

```js
return jsonOk({
  revoked_count: result.revokedCount,
  key_ids: result.keyIds,
});
```

- [ ] **Step 8: Add audit events without sensitive metadata**

Record `s2s.user.create`, `s2s.user.link_feishu`, `s2s.access_key.issue`, `s2s.access_key.replace`, `s2s.access_key.revoke`, `s2s.request.deny`, and `s2s.anomaly.detect`. Metadata may contain environment, client id, signing key id, internal user id, access key id, reason, and bucket count; it must not contain raw email, Feishu id, nonce, signature, body, plaintext, hash, or pepper.

Map identity splits and conditional-bind failures to `S2S_IDENTITY_CONFLICT`/409, inactive existing users to `S2S_USER_INACTIVE`/403, invalid replacement ownership/source/environment to `S2S_REPLACEMENT_KEY_INVALID`/409, and exhausted buckets to `S2S_RATE_LIMITED`/429 with `Retry-After: 600`. Wrap unexpected identity/key/nonce/audit persistence failures as `S2S_STORE_UNAVAILABLE`/500 and never include the caught message in the public response.

- [ ] **Step 9: Run token, store, and access-key tests**

Run:

```bash
node --test apps/pages-api/src/s2s-tokens.test.js apps/pages-api/src/store.test.js apps/pages-api/src/access-keys.test.js
```

Expected: PASS.

- [ ] **Step 10: Commit token orchestration**

```bash
git add apps/pages-api/src/s2s-tokens.js apps/pages-api/src/s2s-tokens.test.js apps/pages-api/src/store.js apps/pages-api/src/test-store.js
git commit -m "feat(pages-api): 支持 XDMaker S2S 凭证发放与吊销"
```

### Task 6: Register the Endpoint, Cleanup, Contract, and Alerts

**Files:**

- Modify: `apps/pages-api/src/index.test.js`
- Modify: `apps/pages-api/src/index.js`
- Modify: `apps/pages-api/src/openapi.test.js`
- Modify: `apps/pages-api/src/openapi.js`
- Modify: `apps/pages-api/src/slack-alerts.test.js`
- Modify: `apps/pages-api/src/slack-alerts.js`

- [ ] **Step 1: Write failing route-order and cleanup tests**

In `index.test.js`, send a correctly signed S2S request from a denied IP and assert `IP_NOT_ALLOWED` before any nonce is stored. Send from an allowed IP and assert it reaches the S2S handler without bearer auth. Invoke `scheduled` and assert expired nonce/rate rows are removed alongside deployment cleanup.

- [ ] **Step 2: Write failing OpenAPI contract assertions**

Assert both S2S paths exist only in `buildOpenApi()`, use POST, declare the stable error codes, mark plaintext as write-only/one-time, and keep public `/openapi.json` returning 404. Assert serialized schemas contain no example secret or real Feishu id.

- [ ] **Step 3: Write the failing safe-alert payload test**

Add:

```js
test('S2S anomaly alert contains identifiers but no user identity or credentials', () => {
  const payload = buildS2SAnomalyPayload({
    environment: 'staging',
    clientId: 'xdmaker',
    userId: 'usr_1',
    accessKeyId: 'ak_1',
    reason: 'rate_threshold',
  });
  const serialized = JSON.stringify(payload);
  assert.match(serialized, /staging/);
  assert.match(serialized, /rate_threshold/);
  assert.doesNotMatch(serialized, /user@example|ou_|xdp_|signature|nonce/i);
});
```

- [ ] **Step 4: Run route/contract/alert tests and verify they fail**

Run: `node --test apps/pages-api/src/index.test.js apps/pages-api/src/openapi.test.js apps/pages-api/src/slack-alerts.test.js`

Expected: FAIL on missing route, contract, cleanup, and alert payload.

- [ ] **Step 5: Register S2S after the global IP check**

Import `handleS2STokensApi`. Immediately after the IP check, create the store and call the handler when pathname starts with `/.xd-pages/api/s2s/`. Pass `ctx` so best-effort alerts can use `ctx.waitUntil`. Do not add any IP exception or bearer fallback.

- [ ] **Step 6: Add scheduled guard cleanup**

Run both cleanup families without letting one skip the other:

```js
await Promise.allSettled([
  runDueDeploymentCleanups(env, config, store, {
    limit: Number(env.DEPLOYMENT_CLEANUP_CRON_LIMIT || 10),
  }),
  store.cleanupExpiredS2SGuards(typeof env.now === 'function' ? env.now() : new Date().toISOString()),
]);
```

- [ ] **Step 7: Add OpenAPI schemas and HMAC security scheme**

Document request/response fields, both POST paths, the five required S2S headers, `Cache-Control: no-store`, and the stable error list. State that this is a controlled integration and never serve the contract through a public route.

- [ ] **Step 8: Add best-effort anomaly alerts**

Export `buildS2SAnomalyPayload` and `notifyS2SAnomaly` from `slack-alerts.js`, reusing `sendSlackAlert`. The payload includes only environment, client id, internal user id, access-key id, and reason. In the S2S handler, call through `ctx.waitUntil`; alert failure must not change a successful issue response.

- [ ] **Step 9: Run route/contract/alert tests**

Run: `node --test apps/pages-api/src/index.test.js apps/pages-api/src/openapi.test.js apps/pages-api/src/slack-alerts.test.js apps/pages-api/src/s2s-tokens.test.js`

Expected: PASS.

- [ ] **Step 10: Commit endpoint integration**

```bash
git add apps/pages-api/src/index.js apps/pages-api/src/index.test.js apps/pages-api/src/openapi.js apps/pages-api/src/openapi.test.js apps/pages-api/src/slack-alerts.js apps/pages-api/src/slack-alerts.test.js apps/pages-api/src/s2s-tokens.js
git commit -m "feat(pages-api): 接入 S2S 路由与安全审计"
```

### Task 7: Display and Revoke XDMaker Keys in Console

**Files:**

- Modify: `apps/pages-console/src/ui/access-keys-model.test.js`
- Modify: `apps/pages-console/src/ui/access-keys-model.js`
- Modify: `apps/pages-console/src/ui/pages/AccessKeys.jsx`

- [ ] **Step 1: Write the failing model test**

Add an active key with `issuedSource: 'xdmaker_s2s'` to the existing row test and assert:

```js
assert.equal(rows[0].sourceLabel, 'XDMaker');
assert.equal(rows[0].sourceKind, 'xdmaker');
assert.equal(rows[0].raw.id, 'ak_00197d61ff057c411c631cde9b67dc04');
```

Add an ordinary `issuedSource: 'console'` row and assert it uses `Console`/`console`.

- [ ] **Step 2: Run the model test and verify it fails**

Run: `node --test apps/pages-console/src/ui/access-keys-model.test.js`

Expected: FAIL because source labels are absent.

- [ ] **Step 3: Map source labels without exposing credential material**

Add to each row:

```js
sourceLabel: formatSourceLabel(accessKey.issuedSource),
sourceKind: accessKey.issuedSource === 'xdmaker_s2s' ? 'xdmaker' : 'default',
```

Implement `formatSourceLabel` with exact mappings: `xdmaker_s2s -> XDMaker`, `console -> Console`, `cli -> CLI`, `legacy -> 历史`, unknown -> `其它`.

- [ ] **Step 4: Render the source tag and keep the existing revoke callback**

Beside the scope tags in `AccessKeys.jsx`, render:

```jsx
<span className={`tag token-source-tag token-source-tag--${row.sourceKind}`}>{row.sourceLabel}</span>
```

Do not add a second revoke path; the existing `onRevoke(row.raw)` and dialog must continue to call the owner-checked Console API.

- [ ] **Step 5: Run Console tests and build**

Run:

```bash
pnpm --filter @xd-cell/pages-console test
pnpm --filter @xd-cell/pages-console build
```

Expected: PASS and a successful Vite build.

- [ ] **Step 6: Commit Console presentation**

```bash
git add apps/pages-console/src/ui/access-keys-model.js apps/pages-console/src/ui/access-keys-model.test.js apps/pages-console/src/ui/pages/AccessKeys.jsx
git commit -m "feat(pages-console): 标记 XDMaker Access Key"
```

### Task 8: Wire Secrets, Existing Allowlist, Workflows, and Documentation

**Files:**

- Modify: `apps/pages-api/wrangler.production.template.toml`
- Modify: `apps/pages-api/wrangler.staging.template.toml`
- Modify: `scripts/pages-v2-secrets.test.js`
- Modify: `scripts/put-pages-v2-secrets.sh`
- Modify: `scripts/render-pages-v2-wrangler.test.js`
- Modify: `scripts/render-pages-v2-wrangler.mjs`
- Modify: `.github/workflows/deploy-pages-v2-staging.yml`
- Modify: `.github/workflows/deploy-pages-v2.yml`
- Modify: `scripts/workflows.test.js`
- Modify: `docs/api-boundary.md`
- Modify: `docs/architecture/publishing-and-runtime.md`
- Modify: `docs/operations/resources-and-deployment.md`

- [ ] **Step 1: Write failing script/workflow assertions**

Use the non-secret registry value:

```text
xdmaker:key_202607:S2S_SECRET_XDMAKER_202607
```

Assert rendered pages-api configs contain `S2S_CLIENT_KEYS` but no secret value. Extend secret-script tests to require/inject `S2S_SECRET_XDMAKER_202607`, reject malformed entries/unsafe secret names/more than two keys per client, and never print the fixture secret. Extend workflow tests to assert both environments pass the registry and map `${{ secrets.S2S_SECRET_XDMAKER_202607 }}` only to pages-api validation/injection steps.

- [ ] **Step 2: Run script/workflow tests and verify they fail**

Run:

```bash
node --test scripts/pages-v2-secrets.test.js scripts/render-pages-v2-wrangler.test.js scripts/workflows.test.js
```

Expected: FAIL because the registry is not validated or injected.

- [ ] **Step 3: Add registry vars to both templates**

Add under access-key registry vars:

```toml
S2S_CLIENT_KEYS = "xdmaker:key_202607:S2S_SECRET_XDMAKER_202607"
```

Add only a comment for the required `S2S_SECRET_XDMAKER_202607`; never add the secret value.

- [ ] **Step 4: Add generic S2S secret collection**

In `put-pages-v2-secrets.sh`, parse `S2S_CLIENT_KEYS` as three colon-separated fields, require safe client/key ids, require `S2S_SECRET_[A-Z0-9_]+`, reject duplicate `(client,key)` and more than two entries per client, and append unique secret env names to `SECRET_NAMES`. Call this collector only for `apps/pages-api`. Add the same registry-shape validation to `render-pages-v2-wrangler.mjs` so invalid committed template values fail before deploy.

- [ ] **Step 5: Map the registry in staging and production workflows**

Add `S2S_CLIENT_KEYS` to the job env and this secret only to Pages API validation/injection env blocks:

```yaml
S2S_SECRET_XDMAKER_202607: ${{ secrets.S2S_SECRET_XDMAKER_202607 }}
```

Do not add push/PR production triggers. Do not add a dedicated IP variable; operators append the approved xdt-api egress CIDR to the existing environment `IP_ALLOWLIST` value.

- [ ] **Step 6: Run script/workflow tests**

Run: `node --test scripts/pages-v2-secrets.test.js scripts/render-pages-v2-wrangler.test.js scripts/workflows.test.js`

Expected: PASS.

- [ ] **Step 7: Update API boundary and architecture truth sources**

Document that xdt-api alone may use the controlled HMAC credential exchange, while XDMaker deploys only through bundled `@xd-cell/cli`. Correct the architecture text to state that owner-scoped personal AKs already create sites during deployment. Record `issuedSource`, 24-hour TTL, session-version security invalidation, Console visibility, and source-scoped revoke.

- [ ] **Step 8: Add the staging operations checklist**

In `resources-and-deployment.md`, add the registry format, two-key rotation order, separate staging/production secrets, existing `IP_ALLOWLIST` extension, duplicate-email preflight query, migration order, and smoke checks for issue -> CLI first deploy -> Console list -> Console revoke -> xdt-api revoke -> session-version invalidation. State that shared-secret exchange and actual CIDR values are manual and never committed.

- [ ] **Step 9: Commit deployment configuration and docs**

```bash
git add apps/pages-api/wrangler.production.template.toml apps/pages-api/wrangler.staging.template.toml scripts/pages-v2-secrets.test.js scripts/put-pages-v2-secrets.sh scripts/render-pages-v2-wrangler.mjs scripts/render-pages-v2-wrangler.test.js .github/workflows/deploy-pages-v2-staging.yml .github/workflows/deploy-pages-v2.yml scripts/workflows.test.js docs/api-boundary.md docs/architecture/publishing-and-runtime.md docs/operations/resources-and-deployment.md
git commit -m "build(pages-api): 配置 XDMaker S2S 凭证"
```

### Task 9: Verify Security and the Complete Deliverable

**Files:**

- Verify only; fix only defects found by these checks.

- [ ] **Step 1: Run all affected focused tests**

Run:

```bash
node --test apps/pages-api/src/schema.test.js apps/pages-api/src/store.test.js apps/pages-api/src/s2s-auth.test.js apps/pages-api/src/s2s-tokens.test.js apps/pages-api/src/access-keys.test.js apps/pages-api/src/auth.test.js apps/pages-api/src/index.test.js apps/pages-api/src/openapi.test.js apps/pages-api/src/slack-alerts.test.js apps/pages-auth/src/oauth-endpoints.test.js
pnpm --filter @xd-cell/pages-console test
node --test scripts/pages-v2-secrets.test.js scripts/render-pages-v2-wrangler.test.js scripts/workflows.test.js
```

Expected: PASS.

- [ ] **Step 2: Re-run existing owner-scoped first-deploy tests**

Run:

```bash
node --test --test-name-pattern="owner-scoped access keys can create|owner-scoped access keys can create a new team|cannot create a new site" apps/pages-api/src/deployments.test.js
```

Expected: PASS, proving S2S uses existing authorization rather than a special deploy bypass.

- [ ] **Step 3: Scan the diff for credential leakage and environment mixing**

Run:

```bash
git diff --check
git diff --name-only
rg -n "xdp_(prod|stg)_[A-Za-z0-9_]+_[a-f0-9]{48}|S2S_SECRET_XDMAKER_202607\s*=\s*[^$<]" apps scripts .github docs
```

Expected: no plaintext access key, no secret value, no real Feishu id, no dedicated S2S IP allowlist, and no staging/production resource crossover.

- [ ] **Step 4: Run lint and the full repository suite**

Run:

```bash
pnpm lint
pnpm test
```

Expected: both exit 0.

- [ ] **Step 5: Build Console once more from the final tree**

Run: `pnpm --filter @xd-cell/pages-console build`

Expected: successful production build.

- [ ] **Step 6: Review the final diff against the design**

Check every requirement in `docs/superpowers/specs/2026-07-14-xdmaker-s2s-access-key-design.md`: endpoints, same-table identity, email-only linking, 24-hour scope, replacement, both revocation modes, Console source/revoke, session freshness, HMAC rotation, nonce ordering, rate limits, audits, existing allowlist, staging-first rollout, and no public S2S instructions.

- [ ] **Step 7: Commit verification-only corrections if necessary**

Only when a preceding verification step required a correction:

```bash
git add apps/pages-api apps/pages-auth apps/pages-console scripts .github/workflows docs
git commit -m "test(pages-api): 完善 XDMaker S2S 回归覆盖"
```
