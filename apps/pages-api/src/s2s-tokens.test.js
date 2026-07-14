import assert from 'node:assert/strict';
import test from 'node:test';

import { hashAccessKey, sha256HexForText } from './crypto.js';
import { buildS2SCanonicalInput, createS2SSignature } from './s2s-auth.js';
import { handleS2STokensApi } from './s2s-tokens.js';
import { D1PagesStore } from './store.js';
import { createTestPagesStore } from './test-store.js';

const BASE_NOW = '2026-07-14T00:00:00.000Z';
const CLIENT_ID = 'xdmaker';
const CLIENT_KEY_ID = 'key_1';
const CLIENT_SECRET = 's2s-test-secret';

test('issues a 24-hour staging token for an active user with a safe exact response', async () => {
  const store = createTestPagesStore({ now: () => BASE_NOW });
  await store.createUser({
    userId: 'usr_existing',
    email: 'maker@example.com',
    realname: 'Existing Maker',
    employeeStatus: 'active',
    feishuOpenId: 'ou_existing',
    sessionVersion: 7,
  });
  const env = testEnv({ environment: 'staging', now: BASE_NOW, accessKeyIds: ['ak_s2s', 'ak_s2s_second'] });

  const first = await handleS2STokensApi(
    await signedRequest({
      environment: 'staging',
      now: BASE_NOW,
      nonce: 'nonce_issue0001',
      body: {
        email: '  MAKER@Example.COM ',
        feishu_open_id: 'ou_existing',
        display_name: 'Ignored Replacement Name',
      },
    }),
    env,
    { environment: 'staging' },
    store
  );

  assert.equal(first.status, 201, await first.clone().text());
  const firstBody = await first.json();
  assert.deepEqual(firstBody, {
    token: firstBody.token,
    key_id: 'ak_s2s',
    expires_at: '2026-07-15T00:00:00.000Z',
    source: 'xdmaker_s2s',
    actor: {
      user_id: 'usr_existing',
      email: 'maker@example.com',
      display_name: 'Existing Maker',
      created_source: 'xd_sso',
    },
  });
  assert.match(firstBody.token, /^xdp_stg_ak_s2s_[a-f0-9]{48}$/);
  assert.doesNotMatch(JSON.stringify(firstBody), /ou_existing|keyHash|pepper|nonce|signature/i);

  const stored = await store.getAccessKeyById('ak_s2s', 'staging');
  assert.deepEqual(
    {
      ownerType: stored.ownerType,
      ownerId: stored.ownerId,
      ownerUserId: stored.ownerUserId,
      createdByUserId: stored.createdByUserId,
      name: stored.name,
      scopes: stored.scopes,
      siteId: stored.siteId,
      expiresAt: stored.expiresAt,
      issuedSource: stored.issuedSource,
      issuedSessionVersion: stored.issuedSessionVersion,
    },
    {
      ownerType: 'user',
      ownerId: 'usr_existing',
      ownerUserId: 'usr_existing',
      createdByUserId: 'usr_existing',
      name: 'XDMaker',
      scopes: ['deploy:site', 'read:site', 'rollback:site'],
      siteId: null,
      expiresAt: '2026-07-15T00:00:00.000Z',
      issuedSource: 'xdmaker_s2s',
      issuedSessionVersion: 7,
    }
  );
  assert.equal(stored.keyHash, await hashAccessKey(firstBody.token, CLIENT_SECRET + '-pepper'));
  assert.equal('plaintext' in stored, false);
  assert.equal((await store.getUser('usr_existing')).realname, 'Existing Maker');

  const issueAudit = (await store.listAuditEvents({ environment: 'staging' })).find(
    (event) => event.eventType === 's2s.access_key.issue' && event.metadata?.accessKeyId === 'ak_s2s'
  );
  assert.deepEqual(issueAudit.metadata, {
    environment: 'staging',
    clientId: CLIENT_ID,
    signingKeyId: CLIENT_KEY_ID,
    accessKeyId: 'ak_s2s',
    userId: 'usr_existing',
  });
  assert.equal('keyId' in issueAudit.metadata, false);

  const second = await handleS2STokensApi(
    await signedRequest({
      environment: 'staging',
      now: BASE_NOW,
      nonce: 'nonce_issue0002',
      body: { email: 'maker@example.com', feishu_open_id: 'ou_existing', display_name: 'Existing Maker' },
    }),
    env,
    { environment: 'staging' },
    store
  );
  assert.equal(second.status, 201, await second.clone().text());
  assert.notEqual((await second.json()).token, firstBody.token);
});

test('creates a production XDMaker user without trusting department input', async () => {
  const store = createTestPagesStore({ now: () => BASE_NOW });
  const env = testEnv({ environment: 'production', now: BASE_NOW, accessKeyIds: ['ak_s2s'] });
  const response = await handleS2STokensApi(
    await signedRequest({
      environment: 'production',
      now: BASE_NOW,
      nonce: 'nonce_create001',
      body: {
        email: ' New.Maker@Example.com ',
        feishu_open_id: 'ou_new_maker',
        display_name: 'New Maker',
        department: 'Never Persist This',
      },
    }),
    env,
    { environment: 'production' },
    store
  );

  assert.equal(response.status, 201, await response.clone().text());
  const body = await response.json();
  assert.match(body.token, /^xdp_prod_ak_s2s_[a-f0-9]{48}$/);
  assert.deepEqual(body.actor, {
    user_id: 'usr_s2s_1',
    email: 'new.maker@example.com',
    display_name: 'New Maker',
    created_source: 'xdmaker',
  });
  const user = await store.getUser('usr_s2s_1');
  assert.deepEqual(
    {
      email: user.email,
      realname: user.realname,
      employeeStatus: user.employeeStatus,
      feishuOpenId: user.feishuOpenId,
      createdSource: user.createdSource,
      departmentPath: user.departmentPath,
    },
    {
      email: 'new.maker@example.com',
      realname: 'New Maker',
      employeeStatus: 'active',
      feishuOpenId: 'ou_new_maker',
      createdSource: 'xdmaker',
      departmentPath: null,
    }
  );
});

test('binds an empty Feishu identity and rejects inactive or split identities', async (t) => {
  await t.test('conditionally binds an active email match', async () => {
    const store = createTestPagesStore({ now: () => BASE_NOW });
    await store.createUser({
      userId: 'usr_bind',
      email: 'bind@example.com',
      realname: 'Bind User',
      employeeStatus: 'active',
    });
    const response = await issueFor(store, {
      email: 'bind@example.com',
      feishu_open_id: 'ou_bound',
      display_name: 'Bind User',
    });
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal((await store.getUser('usr_bind')).feishuOpenId, 'ou_bound');
  });

  await t.test('fills an empty realname from display_name for an active email match', async () => {
    const store = createTestPagesStore({ now: () => BASE_NOW });
    await store.createUser({
      userId: 'usr_name_fill',
      email: 'name-fill@example.com',
      employeeStatus: 'active',
      feishuOpenId: 'ou_name_fill',
    });
    const response = await issueFor(store, {
      email: 'name-fill@example.com',
      feishu_open_id: 'ou_name_fill',
      display_name: 'Filled Name',
    });
    assert.equal(response.status, 201, await response.clone().text());
    assert.equal((await response.json()).actor.display_name, 'Filled Name');
    assert.equal((await store.getUser('usr_name_fill')).realname, 'Filled Name');
  });

  for (const employeeStatus of ['disabled', 'left', 'unknown']) {
    await t.test(`rejects ${employeeStatus} users`, async () => {
      const store = createTestPagesStore({ now: () => BASE_NOW });
      await store.createUser({
        userId: `usr_${employeeStatus}`,
        email: `${employeeStatus}@example.com`,
        employeeStatus,
        feishuOpenId: `ou_${employeeStatus}`,
      });
      const response = await issueFor(store, {
        email: `${employeeStatus}@example.com`,
        feishu_open_id: `ou_${employeeStatus}`,
        display_name: 'Inactive User',
      });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).error.code, 'S2S_USER_INACTIVE');
    });
  }

  await t.test('rejects email and Feishu matches that point to different users', async () => {
    const store = createTestPagesStore({ now: () => BASE_NOW });
    await store.createUser({
      userId: 'usr_email',
      email: 'split@example.com',
      employeeStatus: 'active',
      feishuOpenId: 'ou_email',
    });
    await store.createUser({
      userId: 'usr_feishu',
      email: 'other@example.com',
      employeeStatus: 'active',
      feishuOpenId: 'ou_split',
    });
    const response = await issueFor(store, {
      email: 'split@example.com',
      feishu_open_id: 'ou_split',
      display_name: 'Split User',
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'S2S_IDENTITY_CONFLICT');
  });

  await t.test('rejects changing an existing Feishu identity', async () => {
    const store = createTestPagesStore({ now: () => BASE_NOW });
    await store.createUser({
      userId: 'usr_bound',
      email: 'bound@example.com',
      employeeStatus: 'active',
      feishuOpenId: 'ou_original',
    });
    const response = await issueFor(store, {
      email: 'bound@example.com',
      feishu_open_id: 'ou_changed',
      display_name: 'Bound User',
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'S2S_IDENTITY_CONFLICT');
    assert.equal((await store.getUser('usr_bound')).feishuOpenId, 'ou_original');
  });

  await t.test('maps a concurrent D1 identity constraint to conflict', async () => {
    const store = createTestPagesStore({ now: () => BASE_NOW });
    store.createUser = async () => {
      throw new Error("D1_ERROR: UNIQUE constraint failed: index 'idx_users_email_normalized'");
    };
    const response = await issueFor(store, {
      email: 'race@example.com',
      feishu_open_id: 'ou_race',
      display_name: 'Race User',
    });
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'S2S_IDENTITY_CONFLICT');
  });
});

test('D1 and test stores update user realname only while it is empty', async () => {
  const testStore = createTestPagesStore({ now: () => BASE_NOW });
  await testStore.createUser({
    userId: 'usr_realname',
    email: 'realname@example.com',
    employeeStatus: 'active',
  });
  assert.equal((await testStore.updateUserRealnameIfEmpty('usr_realname', 'First Name')).realname, 'First Name');
  assert.equal((await testStore.updateUserRealnameIfEmpty('usr_realname', 'Second Name')).realname, 'First Name');

  const d1Db = fakeRealnameD1(userRow({ id: 'usr_realname', email: 'realname@example.com', realname: null }));
  const d1Store = new D1PagesStore(d1Db, { now: () => BASE_NOW });
  assert.equal((await d1Store.updateUserRealnameIfEmpty('usr_realname', 'First Name')).realname, 'First Name');
  assert.equal((await d1Store.updateUserRealnameIfEmpty('usr_realname', 'Second Name')).realname, 'First Name');
  assert.match(d1Db.calls.find((call) => /UPDATE users/.test(call.sql)).sql, /realname IS NULL OR trim\(realname\) = ''/);
});

test('validates authenticated issue and revoke bodies without parsing a second request body', async (t) => {
  const cases = [
    ['invalid JSON', '{', '/.xd-pages/api/s2s/tokens'],
    ['invalid email', { email: 'not-an-email', feishu_open_id: 'ou_valid', display_name: 'Maker' }, '/.xd-pages/api/s2s/tokens'],
    ['empty Feishu id', { email: 'maker@example.com', feishu_open_id: '', display_name: 'Maker' }, '/.xd-pages/api/s2s/tokens'],
    [
      'control in Feishu id',
      { email: 'maker@example.com', feishu_open_id: 'ou_\ninvalid', display_name: 'Maker' },
      '/.xd-pages/api/s2s/tokens',
    ],
    [
      'long display name',
      { email: 'maker@example.com', feishu_open_id: 'ou_valid', display_name: 'x'.repeat(81) },
      '/.xd-pages/api/s2s/tokens',
    ],
    ['both revoke selectors', { key_id: 'ak_1', email: 'maker@example.com' }, '/.xd-pages/api/s2s/tokens/revoke'],
    ['missing revoke selector', {}, '/.xd-pages/api/s2s/tokens/revoke'],
  ];
  let nonce = 0;
  for (const [name, body, pathname] of cases) {
    await t.test(name, async () => {
      const store = createTestPagesStore({ now: () => BASE_NOW });
      const response = await handleS2STokensApi(
        await signedRequest({ body, pathname, now: BASE_NOW, nonce: `nonce_invalid${++nonce}` }),
        testEnv({ now: BASE_NOW }),
        { environment: 'staging' },
        store
      );
      assert.equal(response.status, 400);
      assert.equal((await response.json()).error.code, 'S2S_REQUEST_INVALID');
      const denyAudit = (await store.listAuditEvents({ environment: 'staging' })).find(
        (event) => event.eventType === 's2s.request.deny'
      );
      assert.equal(denyAudit.metadata.signingKeyId, CLIENT_KEY_ID);
      assert.equal('accessKeyId' in denyAudit.metadata, false);
      assert.equal('keyId' in denyAudit.metadata, false);
    });
  }
});

test('audits bad signatures and replays with internal signing context without exposing it publicly', async () => {
  const store = createTestPagesStore({ now: () => BASE_NOW });
  await store.createUser({
    userId: 'usr_auth_deny',
    email: 'auth-deny@example.com',
    realname: 'Auth Deny',
    employeeStatus: 'active',
    feishuOpenId: 'ou_auth_deny',
  });
  const env = testEnv({ now: BASE_NOW, accessKeyIds: ['ak_s2s'] });
  const body = {
    email: 'auth-deny@example.com',
    feishu_open_id: 'ou_auth_deny',
    display_name: 'Auth Deny',
  };

  const badSignature = await handleS2STokensApi(
    await signedRequest({ body, now: BASE_NOW, nonce: 'nonce_authdeny01', signature: 'invalid-signature' }),
    env,
    { environment: 'staging' },
    store
  );
  assert.equal(badSignature.status, 401);
  const badSignatureBody = await badSignature.json();
  assert.equal(badSignatureBody.error.code, 'S2S_SIGNATURE_INVALID');
  assert.equal(badSignatureBody.clientId, undefined);
  assert.equal(badSignatureBody.keyId, undefined);
  assert.equal(badSignatureBody.error.clientId, undefined);
  assert.equal(badSignatureBody.error.keyId, undefined);

  const replayRequest = { body, now: BASE_NOW, nonce: 'nonce_authdeny02' };
  const first = await handleS2STokensApi(
    await signedRequest(replayRequest),
    env,
    { environment: 'staging' },
    store
  );
  assert.equal(first.status, 201, await first.clone().text());
  const replay = await handleS2STokensApi(
    await signedRequest(replayRequest),
    env,
    { environment: 'staging' },
    store
  );
  assert.equal(replay.status, 409);
  const replayBody = await replay.json();
  assert.equal(replayBody.error.code, 'S2S_REPLAY_DETECTED');
  assert.equal(replayBody.clientId, undefined);
  assert.equal(replayBody.keyId, undefined);
  assert.equal(replayBody.error.clientId, undefined);
  assert.equal(replayBody.error.keyId, undefined);

  const denyMetadata = (await store.listAuditEvents({ environment: 'staging' }))
    .filter((event) => event.eventType === 's2s.request.deny')
    .map((event) => event.metadata);
  assert.deepEqual(denyMetadata, [
    {
      environment: 'staging',
      clientId: CLIENT_ID,
      signingKeyId: CLIENT_KEY_ID,
      reason: 'S2S_SIGNATURE_INVALID',
    },
    {
      environment: 'staging',
      clientId: CLIENT_ID,
      signingKeyId: CLIENT_KEY_ID,
      reason: 'S2S_REPLAY_DETECTED',
    },
  ]);
  assert.doesNotMatch(
    JSON.stringify(denyMetadata),
    /nonce_authdeny|invalid-signature|auth-deny@example\.com|ou_auth_deny|display_name|token|hash/i
  );
});

test('replaces only an active XDMaker key owned by the same user and environment', async () => {
  const store = createTestPagesStore({ now: () => BASE_NOW });
  await store.createUser({
    userId: 'usr_owner',
    email: 'owner@example.com',
    realname: 'Owner',
    employeeStatus: 'active',
    feishuOpenId: 'ou_owner',
  });
  await store.createAccessKey(accessKeyRecord({ id: 'ak_old', ownerId: 'usr_owner' }));
  const response = await issueFor(
    store,
    {
      email: 'owner@example.com',
      feishu_open_id: 'ou_owner',
      display_name: 'Owner',
      replaces_key_id: 'ak_old',
    },
    { accessKeyIds: ['ak_s2s'] }
  );
  assert.equal(response.status, 201, await response.clone().text());
  const oldKey = await store.getAccessKeyById('ak_old', 'staging');
  assert.equal(oldKey.revokedAt, BASE_NOW);
  assert.equal(oldKey.revokedByUserId, 'usr_owner');
  assert.equal(oldKey.revokedReason, 'xdmaker_s2s_replace');
  assert.ok(await store.getAccessKeyById('ak_s2s', 'staging'));
  const replaceAudit = (await store.listAuditEvents({ environment: 'staging' })).find(
    (event) => event.eventType === 's2s.access_key.replace'
  );
  assert.equal(replaceAudit.metadata.signingKeyId, CLIENT_KEY_ID);
  assert.equal(replaceAudit.metadata.accessKeyId, 'ak_old');
  assert.equal('keyId' in replaceAudit.metadata, false);

  for (const [name, oldKeyInput] of [
    ['other user', { id: 'ak_other', ownerId: 'usr_other' }],
    ['other source', { id: 'ak_console', ownerId: 'usr_owner', issuedSource: 'console' }],
    ['other environment', { id: 'ak_prod', ownerId: 'usr_owner', environment: 'production' }],
  ]) {
    const isolated = createTestPagesStore({ now: () => BASE_NOW });
    await isolated.createUser({
      userId: 'usr_owner',
      email: 'owner@example.com',
      realname: 'Owner',
      employeeStatus: 'active',
      feishuOpenId: 'ou_owner',
    });
    await isolated.createAccessKey(accessKeyRecord(oldKeyInput));
    const rejected = await issueFor(
      isolated,
      {
        email: 'owner@example.com',
        feishu_open_id: 'ou_owner',
        display_name: 'Owner',
        replaces_key_id: oldKeyInput.id,
      },
      { accessKeyIds: ['ak_s2s'], nonce: `nonce_${name.replaceAll(' ', '_')}0001` }
    );
    assert.equal(rejected.status, 409);
    assert.equal((await rejected.json()).error.code, 'S2S_REPLACEMENT_KEY_INVALID');
    assert.equal(await isolated.getAccessKeyById('ak_s2s'), null);
    const denyAudit = (await isolated.listAuditEvents({ environment: 'staging' })).find(
      (event) => event.eventType === 's2s.request.deny'
    );
    assert.equal(denyAudit.metadata.signingKeyId, CLIENT_KEY_ID);
    assert.equal(denyAudit.metadata.accessKeyId, oldKeyInput.id);
    assert.equal('keyId' in denyAudit.metadata, false);
  }
});

test('revokes active non-expired XDMaker keys by email or key id and is idempotent', async () => {
  const store = createTestPagesStore({ now: () => BASE_NOW });
  await store.createUser({
    userId: 'usr_revoke',
    email: 'revoke@example.com',
    realname: 'Revoke User',
    employeeStatus: 'active',
    feishuOpenId: 'ou_revoke',
  });
  await store.createAccessKey(accessKeyRecord({ id: 'ak_one', ownerId: 'usr_revoke' }));
  await store.createAccessKey(accessKeyRecord({ id: 'ak_two', ownerId: 'usr_revoke' }));
  await store.createAccessKey(accessKeyRecord({ id: 'ak_console', ownerId: 'usr_revoke', issuedSource: 'console' }));
  await store.createAccessKey(
    accessKeyRecord({ id: 'ak_expired', ownerId: 'usr_revoke', expiresAt: '2026-07-13T00:00:00.000Z' })
  );
  await store.createAccessKey(accessKeyRecord({ id: 'ak_production', ownerId: 'usr_revoke', environment: 'production' }));

  const first = await handleS2STokensApi(
    await signedRequest({
      now: BASE_NOW,
      nonce: 'nonce_revoke001',
      pathname: '/.xd-pages/api/s2s/tokens/revoke',
      body: { email: ' REVOKE@EXAMPLE.COM ' },
    }),
    testEnv({ now: BASE_NOW }),
    { environment: 'staging' },
    store
  );
  assert.equal(first.status, 200, await first.clone().text());
  assert.deepEqual(await first.json(), { revoked_count: 2, key_ids: ['ak_one', 'ak_two'] });
  assert.equal((await store.getAccessKeyById('ak_console')).revokedAt, null);
  assert.equal((await store.getAccessKeyById('ak_expired')).revokedAt, null);
  assert.equal((await store.getAccessKeyById('ak_production')).revokedAt, null);

  const repeated = await handleS2STokensApi(
    await signedRequest({
      now: BASE_NOW,
      nonce: 'nonce_revoke002',
      pathname: '/.xd-pages/api/s2s/tokens/revoke',
      body: { email: 'revoke@example.com' },
    }),
    testEnv({ now: BASE_NOW }),
    { environment: 'staging' },
    store
  );
  assert.deepEqual(await repeated.json(), { revoked_count: 0, key_ids: [] });

  const unknown = await handleS2STokensApi(
    await signedRequest({
      now: BASE_NOW,
      nonce: 'nonce_revoke003',
      pathname: '/.xd-pages/api/s2s/tokens/revoke',
      body: { key_id: 'ak_unknown' },
    }),
    testEnv({ now: BASE_NOW }),
    { environment: 'staging' },
    store
  );
  assert.deepEqual(await unknown.json(), { revoked_count: 0, key_ids: [] });

  await store.createAccessKey(accessKeyRecord({ id: 'ak_by_id', ownerId: 'usr_revoke' }));
  const byKeyId = await handleS2STokensApi(
    await signedRequest({
      now: BASE_NOW,
      nonce: 'nonce_revoke004',
      pathname: '/.xd-pages/api/s2s/tokens/revoke',
      body: { key_id: 'ak_by_id' },
    }),
    testEnv({ now: BASE_NOW }),
    { environment: 'staging' },
    store
  );
  assert.deepEqual(await byKeyId.json(), { revoked_count: 1, key_ids: ['ak_by_id'] });
  assert.equal((await store.getAccessKeyById('ak_by_id')).revokedReason, 'xdmaker_s2s_revoke');

  const audits = await store.listAuditEvents({ environment: 'staging' });
  const revokeAudits = audits.filter((event) => event.eventType === 's2s.access_key.revoke');
  assert.equal(revokeAudits.length, 3);
  for (const audit of revokeAudits) {
    assert.equal(audit.metadata.signingKeyId, CLIENT_KEY_ID);
    assert.ok(['ak_one', 'ak_two', 'ak_by_id'].includes(audit.metadata.accessKeyId));
    assert.equal('keyId' in audit.metadata, false);
  }
  assert.doesNotMatch(
    JSON.stringify(audits.map((event) => event.metadata)),
    /revoke@example\.com|ou_revoke|s2s-test-secret|pepper-secret|nonce_revoke|signature/i
  );
});

test('limits each normalized email to five issues per ten-minute bucket and records safe anomalies', async () => {
  const store = createTestPagesStore({ now: () => BASE_NOW });
  await store.createUser({
    userId: 'usr_rate',
    email: 'rate@example.com',
    realname: 'Rate User',
    employeeStatus: 'active',
    feishuOpenId: 'ou_rate',
  });
  const env = testEnv({
    now: BASE_NOW,
    accessKeyIds: ['ak_s2s', 'ak_s2s_2', 'ak_s2s_3', 'ak_s2s_4', 'ak_s2s_5', 'ak_s2s_6'],
  });
  for (let index = 1; index <= 5; index += 1) {
    const response = await handleS2STokensApi(
      await signedRequest({
        now: BASE_NOW,
        nonce: `nonce_rate000${index}`,
        body: { email: ' RATE@EXAMPLE.COM ', feishu_open_id: 'ou_rate', display_name: 'Rate User' },
      }),
      env,
      { environment: 'staging' },
      store
    );
    assert.equal(response.status, 201, await response.clone().text());
  }
  const limited = await handleS2STokensApi(
    await signedRequest({
      now: BASE_NOW,
      nonce: 'nonce_rate0006',
      body: { email: 'rate@example.com', feishu_open_id: 'ou_rate', display_name: 'Rate User' },
    }),
    env,
    { environment: 'staging' },
    store
  );
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('Retry-After'), '600');
  assert.equal((await limited.json()).error.code, 'S2S_RATE_LIMITED');

  const subject = await sha256HexForText('xdmaker-s2s:user:rate@example.com');
  const userRate = [...store.s2sRateLimits.values()].find((row) => row.scope === 'user');
  assert.equal(userRate.subject, subject);
  assert.equal(userRate.requestCount, 5);

  const audits = await store.listAuditEvents({ environment: 'staging' });
  assert.ok(
    audits.some(
      (event) =>
        event.eventType === 's2s.anomaly.detect' &&
        event.metadata?.reason === 'user_rate_count_3' &&
        event.metadata?.bucketCount === 3
    )
  );
  assert.ok(audits.some((event) => event.eventType === 's2s.request.deny'));
  const denyAudit = audits.find((event) => event.eventType === 's2s.request.deny');
  assert.equal(denyAudit.metadata.signingKeyId, CLIENT_KEY_ID);
  assert.equal('accessKeyId' in denyAudit.metadata, false);
  assert.doesNotMatch(
    JSON.stringify(audits.map((event) => event.metadata)),
    /rate@example\.com|ou_rate|nonce_rate|signature|pepper-secret/i
  );
});

test('records an off-hours Asia/Shanghai anomaly without failing issue on best-effort audit errors', async () => {
  const offHours = '2026-07-13T18:00:00.000Z';
  const store = createTestPagesStore({ now: () => offHours });
  await store.createUser({
    userId: 'usr_night',
    email: 'night@example.com',
    realname: 'Night User',
    employeeStatus: 'active',
    feishuOpenId: 'ou_night',
  });
  const response = await issueFor(
    store,
    { email: 'night@example.com', feishu_open_id: 'ou_night', display_name: 'Night User' },
    { now: offHours, accessKeyIds: ['ak_s2s'] }
  );
  assert.equal(response.status, 201, await response.clone().text());
  const anomaly = (await store.listAuditEvents({ environment: 'staging' })).find(
    (event) => event.eventType === 's2s.anomaly.detect' && event.metadata?.reason === 'off_hours_issue'
  );
  assert.ok(anomaly);

  const bestEffortStore = createTestPagesStore({ now: () => offHours, failAuditWrites: true });
  await bestEffortStore.createUser({
    userId: 'usr_best_effort',
    email: 'best@example.com',
    realname: 'Best Effort',
    employeeStatus: 'active',
    feishuOpenId: 'ou_best',
  });
  const bestEffortResponse = await issueFor(
    bestEffortStore,
    { email: 'best@example.com', feishu_open_id: 'ou_best', display_name: 'Best Effort' },
    { now: offHours, accessKeyIds: ['ak_s2s'] }
  );
  assert.equal(bestEffortResponse.status, 201, await bestEffortResponse.clone().text());
});

test('maps auth guard and persistence exceptions to a generic store error without leaking messages', async () => {
  const store = createTestPagesStore({ now: () => BASE_NOW });
  await store.createUser({
    userId: 'usr_failure',
    email: 'failure@example.com',
    realname: 'Failure User',
    employeeStatus: 'active',
    feishuOpenId: 'ou_failure',
  });
  store.issueS2SAccessKey = async () => {
    throw new Error('D1 write failed password=do-not-leak');
  };
  const response = await issueFor(store, {
    email: 'failure@example.com',
    feishu_open_id: 'ou_failure',
    display_name: 'Failure User',
  });
  assert.equal(response.status, 500);
  const text = await response.text();
  assert.match(text, /S2S_STORE_UNAVAILABLE/);
  assert.doesNotMatch(text, /D1|password|do-not-leak/);

  const authStore = createTestPagesStore({ now: () => BASE_NOW });
  authStore.reserveS2SNonce = async () => {
    throw new Error('nonce database DSN=do-not-leak');
  };
  const authFailure = await handleS2STokensApi(
    await signedRequest({
      now: BASE_NOW,
      nonce: 'nonce_failure02',
      body: { email: 'failure@example.com', feishu_open_id: 'ou_failure', display_name: 'Failure User' },
    }),
    testEnv({ now: BASE_NOW }),
    { environment: 'staging' },
    authStore
  );
  assert.equal(authFailure.status, 500);
  assert.doesNotMatch(await authFailure.text(), /nonce database|DSN|do-not-leak/);
});

test('D1 issue validates replacement before one atomic batch and D1 revoke audits each changed key', async () => {
  const invalidDb = fakeS2SD1({ replacement: accessKeyRow({ id: 'ak_old', ownerId: 'usr_other' }) });
  const invalidStore = new D1PagesStore(invalidDb, { now: () => BASE_NOW });
  await assert.rejects(
    () =>
      invalidStore.issueS2SAccessKey({
        accessKey: accessKeyRecord({ id: 'ak_new', ownerId: 'usr_owner' }),
        replacesKeyId: 'ak_old',
        auditEvents: [auditEvent('aud_issue', 's2s.access_key.issue', 'ak_new')],
        now: BASE_NOW,
      }),
    (error) => error?.code === 'S2S_REPLACEMENT_KEY_INVALID'
  );
  assert.equal(invalidDb.batches.length, 0);

  const validDb = fakeS2SD1({ replacement: accessKeyRow({ id: 'ak_old', ownerId: 'usr_owner' }) });
  const validStore = new D1PagesStore(validDb, { now: () => BASE_NOW });
  const created = await validStore.issueS2SAccessKey({
    accessKey: accessKeyRecord({ id: 'ak_new', ownerId: 'usr_owner' }),
    replacesKeyId: 'ak_old',
    auditEvents: [
      auditEvent('aud_issue', 's2s.access_key.issue', 'ak_new'),
      auditEvent('aud_replace', 's2s.access_key.replace', 'ak_old'),
    ],
    now: BASE_NOW,
  });
  assert.equal(created.id, 'ak_new');
  assert.equal(validDb.batches.length, 1);
  assert.match(validDb.batches[0].map((statement) => statement.sql).join('\n'), /INSERT INTO access_keys/);
  assert.match(validDb.batches[0].map((statement) => statement.sql).join('\n'), /UPDATE access_keys/);
  assert.equal(validDb.batches[0].filter((statement) => /INSERT INTO audit_events/.test(statement.sql)).length, 2);

  const revokeDb = fakeS2SD1({
    revocable: [accessKeyRow({ id: 'ak_one', ownerId: 'usr_owner' }), accessKeyRow({ id: 'ak_two', ownerId: 'usr_owner' })],
  });
  const revokeStore = new D1PagesStore(revokeDb, { now: () => BASE_NOW });
  const revoked = await revokeStore.revokeS2SAccessKeys({
    environment: 'staging',
    email: 'owner@example.com',
    clientId: CLIENT_ID,
    signingKeyId: CLIENT_KEY_ID,
    now: BASE_NOW,
  });
  assert.deepEqual(revoked, { revokedCount: 2, keyIds: ['ak_one', 'ak_two'] });
  assert.equal(revokeDb.batches.length, 1);
  assert.equal(revokeDb.batches[0].filter((statement) => /UPDATE access_keys/.test(statement.sql)).length, 2);
  const revokeAuditStatements = revokeDb.batches[0].filter((statement) => /INSERT INTO audit_events/.test(statement.sql));
  assert.equal(revokeAuditStatements.length, 2);
  assert.ok(revokeAuditStatements.every((statement) => /changes\(\) = 1/.test(statement.sql)));
  assert.deepEqual(
    revokeAuditStatements.map((statement) => JSON.parse(statement.args[13])),
    [
      {
        environment: 'staging',
        clientId: CLIENT_ID,
        signingKeyId: CLIENT_KEY_ID,
        accessKeyId: 'ak_one',
        userId: 'usr_owner',
        reason: 'xdmaker_s2s_revoke',
      },
      {
        environment: 'staging',
        clientId: CLIENT_ID,
        signingKeyId: CLIENT_KEY_ID,
        accessKeyId: 'ak_two',
        userId: 'usr_owner',
        reason: 'xdmaker_s2s_revoke',
      },
    ]
  );

  const concurrentDb = fakeS2SD1({
    revocable: [accessKeyRow({ id: 'ak_raced', ownerId: 'usr_owner' })],
    batchChanges: [0, 0],
  });
  const concurrentStore = new D1PagesStore(concurrentDb, { now: () => BASE_NOW });
  const concurrent = await concurrentStore.revokeS2SAccessKeys({
    environment: 'staging',
    keyId: 'ak_raced',
    clientId: CLIENT_ID,
    signingKeyId: CLIENT_KEY_ID,
    now: BASE_NOW,
  });
  assert.deepEqual(concurrent, { revokedCount: 0, keyIds: [] });
  assert.doesNotMatch(concurrentDb.batches[0].map((statement) => statement.sql).join('\n'), /REVOKE_CONFLICT/);
});

async function issueFor(store, body, options = {}) {
  const now = options.now || BASE_NOW;
  return handleS2STokensApi(
    await signedRequest({
      now,
      nonce: options.nonce || 'nonce_issuefortest',
      body,
    }),
    testEnv({ now, accessKeyIds: options.accessKeyIds || ['ak_s2s'] }),
    { environment: 'staging' },
    store
  );
}

async function signedRequest({
  body = {},
  pathname = '/.xd-pages/api/s2s/tokens',
  environment = 'staging',
  now = BASE_NOW,
  nonce = 'nonce_signed0001',
  method = 'POST',
  signature: signatureOverride,
} = {}) {
  const rawBody = typeof body === 'string' ? body : JSON.stringify(body);
  const timestamp = Math.floor(new Date(now).getTime() / 1000);
  const canonicalInput = await buildS2SCanonicalInput({
    environment,
    clientId: CLIENT_ID,
    keyId: CLIENT_KEY_ID,
    method,
    pathname,
    timestamp,
    nonce,
    rawBody,
  });
  const signature = signatureOverride || (await createS2SSignature({ secret: CLIENT_SECRET, canonicalInput }));
  return new Request(`https://api.example.test${pathname}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'CF-Connecting-IP': '192.0.2.10',
      'X-XD-Cell-S2S-Client': CLIENT_ID,
      'X-XD-Cell-S2S-Key-Id': CLIENT_KEY_ID,
      'X-XD-Cell-S2S-Timestamp': String(timestamp),
      'X-XD-Cell-S2S-Nonce': nonce,
      'X-XD-Cell-S2S-Signature': signature,
    },
    body: rawBody,
  });
}

function testEnv({ environment = 'staging', now = BASE_NOW, accessKeyIds = ['ak_s2s'] } = {}) {
  let userSequence = 0;
  let auditSequence = 0;
  let randomSequence = 0;
  const ids = [...accessKeyIds];
  return {
    S2S_CLIENT_KEYS: `${CLIENT_ID}:${CLIENT_KEY_ID}:S2S_SECRET_XDMAKER`,
    S2S_SECRET_XDMAKER: CLIENT_SECRET,
    ACCESS_KEY_ACTIVE_PEPPER_ID: 'pepper_s2s',
    ACCESS_KEY_PEPPERS: 'pepper_s2s:S2S_ACCESS_KEY_PEPPER',
    S2S_ACCESS_KEY_PEPPER: CLIENT_SECRET + '-pepper',
    now: () => now,
    nextId(prefix) {
      if (prefix === 'usr') return `usr_s2s_${++userSequence}`;
      if (prefix === 'ak') return ids.shift() || `ak_s2s_${Date.now()}`;
      if (prefix === 'aud') return `aud_s2s_${++auditSequence}`;
      return `${prefix}_s2s_1`;
    },
    randomBytes(length) {
      randomSequence += 1;
      return new Uint8Array(length).fill(randomSequence);
    },
    environment,
  };
}

function accessKeyRecord({
  id,
  ownerId,
  environment = 'staging',
  issuedSource = 'xdmaker_s2s',
  expiresAt = '2026-07-15T00:00:00.000Z',
} = {}) {
  return {
    id,
    environment,
    ownerType: 'user',
    ownerId,
    ownerUserId: ownerId,
    createdByUserId: ownerId,
    keyHash: `hash_${id}`,
    pepperId: 'pepper_s2s',
    name: 'XDMaker',
    scopes: ['deploy:site', 'read:site', 'rollback:site'],
    siteId: null,
    expiresAt,
    issuedSource,
    issuedSessionVersion: 1,
  };
}

function accessKeyRow(input) {
  const record = accessKeyRecord(input);
  return {
    id: record.id,
    environment: record.environment,
    owner_type: record.ownerType,
    owner_id: record.ownerId,
    owner_user_id: record.ownerUserId,
    created_by_user_id: record.createdByUserId,
    key_hash: record.keyHash,
    pepper_id: record.pepperId,
    name: record.name,
    scopes_json: JSON.stringify(record.scopes),
    site_id: null,
    expires_at: record.expiresAt,
    last_used_at: null,
    revoked_at: null,
    revoked_by_user_id: null,
    revoked_reason: null,
    created_at: BASE_NOW,
    issued_source: record.issuedSource,
    issued_session_version: record.issuedSessionVersion,
  };
}

function auditEvent(id, eventType, accessKeyId) {
  return {
    id,
    environment: 'staging',
    eventType,
    actorUserId: 'usr_owner',
    actorType: 's2s',
    decision: 'allow',
    statusCode: 201,
    metadata: {
      environment: 'staging',
      clientId: CLIENT_ID,
      signingKeyId: CLIENT_KEY_ID,
      accessKeyId,
      userId: 'usr_owner',
    },
    createdAt: BASE_NOW,
  };
}

function fakeS2SD1({ replacement = null, revocable = [], batchChanges = null } = {}) {
  const calls = [];
  const batches = [];
  return {
    calls,
    batches,
    prepare(sql) {
      const statement = {
        sql,
        args: [],
        bind(...args) {
          this.args = args;
          return this;
        },
        async first() {
          calls.push(this);
          if (/WHERE access_keys\.id = \?/.test(sql)) return replacement;
          return null;
        },
        async all() {
          calls.push(this);
          if (/FROM access_keys/.test(sql)) return { results: revocable };
          return { results: [] };
        },
        async run() {
          calls.push(this);
          return { meta: { changes: 1 } };
        },
      };
      return statement;
    },
    async batch(statements) {
      batches.push(statements);
      return statements.map((_, index) => ({ success: true, meta: { changes: batchChanges?.[index] ?? 1 } }));
    },
  };
}

function fakeRealnameD1(row) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const call = {
        sql,
        args: [],
        bind(...args) {
          this.args = args;
          return this;
        },
        async run() {
          calls.push(this);
          const [realname, updatedAt, userId] = this.args;
          if (row.user_id === userId && !row.realname?.trim()) {
            row.realname = realname;
            row.updated_at = updatedAt;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
        async first() {
          calls.push(this);
          return row.user_id === this.args[0] ? row : null;
        },
      };
      return call;
    },
  };
}

function userRow({ id, email, realname }) {
  return {
    user_id: id,
    email,
    realname,
    account: null,
    account_id: null,
    employeenum: null,
    employee_status: 'active',
    feishu_open_id: 'ou_realname',
    created_source: 'xd_sso',
    department_path: null,
    department_checked_at: null,
    session_version: 1,
    last_login_at: null,
    created_at: BASE_NOW,
    updated_at: BASE_NOW,
  };
}
