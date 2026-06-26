/* global TextEncoder */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BINDINGS,
  ERROR_CODES,
  GATEWAY,
  HEADERS,
  RUNTIME,
  buildErrorEnvelope,
  buildOkEnvelope,
  buildStorageKey,
  buildUserStorageKey,
  encodeUserKey,
  isReservedSiteSlug,
  isValidSiteSlug,
  isValidSiteUuid,
  parseKvEnabled,
  scopeForDataOperation,
  validateSiteSlug,
  validateKvType,
  validateListOptions,
  validateTtl,
  validateUserKey,
} from './index.js';

test('exports stable runtime, gateway, header, binding and error constants', () => {
  assert.equal(RUNTIME.BASE_PATH, '/.xd-pages/runtime/v1');
  assert.equal(RUNTIME.KV_GET_PATH, '/.xd-pages/runtime/v1/kv/get');
  assert.equal(RUNTIME.KV_GET_WITH_METADATA_PATH, '/.xd-pages/runtime/v1/kv/get-with-metadata');
  assert.equal(RUNTIME.KV_LIST_PATH, '/.xd-pages/runtime/v1/kv/list');
  assert.equal(RUNTIME.KV_SET_PATH, '/.xd-pages/runtime/v1/kv/set');
  assert.equal(GATEWAY.KV_SET_PATH, '/v1/kv/set');
  assert.equal(GATEWAY.KV_GET_WITH_METADATA_PATH, '/v1/kv/get-with-metadata');
  assert.equal(GATEWAY.KV_LIST_PATH, '/v1/kv/list');
  assert.equal(RUNTIME.DATA_SITE_GET_PATH, '/.xd-pages/runtime/v1/data/site/get');
  assert.equal(RUNTIME.DATA_SITE_GET_WITH_METADATA_PATH, '/.xd-pages/runtime/v1/data/site/get-with-metadata');
  assert.equal(RUNTIME.DATA_SITE_LIST_PATH, '/.xd-pages/runtime/v1/data/site/list');
  assert.equal(RUNTIME.DATA_USER_SET_PATH, '/.xd-pages/runtime/v1/data/user/set');
  assert.equal(GATEWAY.DATA_SITE_GET_WITH_METADATA_PATH, '/v1/data/site/get-with-metadata');
  assert.equal(GATEWAY.DATA_SITE_LIST_PATH, '/v1/data/site/list');
  assert.equal(GATEWAY.DATA_SITE_DELETE_PATH, '/v1/data/site/delete');
  assert.equal(GATEWAY.DATA_USER_GET_PATH, '/v1/data/user/get');
  assert.equal(HEADERS.RUNTIME_REQUEST, 'X-XD-Pages-Runtime');
  assert.equal(BINDINGS.KV_GATEWAY, 'XD_PAGES_KV_GATEWAY');
  assert.equal(ERROR_CODES.INVALID_RUNTIME_RESPONSE, 'INVALID_RUNTIME_RESPONSE');
  assert.equal(ERROR_CODES.USER_REQUIRED, 'USER_REQUIRED');
  assert.equal(ERROR_CODES.INVALID_METADATA, 'INVALID_METADATA');
  assert.equal(ERROR_CODES.INVALID_LIMIT, 'INVALID_LIMIT');
  assert.equal(ERROR_CODES.INVALID_CURSOR, 'INVALID_CURSOR');
  assert.equal(ERROR_CODES.INVALID_EXPIRATION, 'INVALID_EXPIRATION');
  assert.equal(ERROR_CODES.UNSUPPORTED_KV_OPTION, 'UNSUPPORTED_KV_OPTION');
  assert.equal(scopeForDataOperation('site', 'get'), 'data:site:get');
  assert.equal(scopeForDataOperation('site', 'list'), 'data:site:list');
  assert.equal(scopeForDataOperation('user', 'delete'), 'data:user:delete');
});

test('parseKvEnabled is explicit and fail closed', () => {
  assert.equal(parseKvEnabled(undefined).enabled, false);
  assert.equal(parseKvEnabled(null).enabled, false);
  assert.equal(parseKvEnabled(false).enabled, false);
  assert.equal(parseKvEnabled('false').enabled, false);
  assert.equal(parseKvEnabled(true).enabled, true);
  assert.equal(parseKvEnabled('true').enabled, true);
  assert.deepEqual(parseKvEnabled('worker'), {
    enabled: false,
    error: { code: 'INVALID_KV_OPTION', message: 'kv must be true or false' },
  });
});

test('siteUuid must be 32 lowercase hex characters', () => {
  assert.equal(isValidSiteUuid('4b4c8e8361ef4b47b64f5c20a7db7c47'), true);
  assert.equal(isValidSiteUuid('4B4C8E8361EF4B47B64F5C20A7DB7C47'), false);
  assert.equal(isValidSiteUuid('4b4c8e83-61ef-4b47-b64f-5c20a7db7c47'), false);
});

test('siteSlug matches deploy handler name semantics', () => {
  assert.equal(isValidSiteSlug('ab'), true);
  assert.equal(isValidSiteSlug('q2-report'), true);
  assert.equal(isValidSiteSlug(`a${'b'.repeat(48)}1`), true);
  assert.equal(isValidSiteSlug('a'), false);
  assert.equal(isValidSiteSlug(`a${'b'.repeat(49)}1`), false);
  assert.equal(isValidSiteSlug('Q2-report'), false);
  assert.equal(isValidSiteSlug('-q2-report'), false);
  assert.equal(isValidSiteSlug('q2-report-'), false);
  assert.equal(isValidSiteSlug('q2_report'), false);
});

test('siteSlug reserves platform names consistently across control and data plane', () => {
  assert.equal(isReservedSiteSlug('api'), true);
  assert.equal(isReservedSiteSlug('auth-staging'), true);
  assert.equal(isReservedSiteSlug('router'), true);
  assert.equal(isReservedSiteSlug('kv-gateway'), true);
  assert.equal(isReservedSiteSlug('login'), true);
  assert.equal(isReservedSiteSlug('docs'), true);
  assert.equal(isReservedSiteSlug('deployments'), true);
  assert.equal(isReservedSiteSlug('runtime'), true);
  assert.equal(isReservedSiteSlug('pages-api'), true);
  assert.equal(isReservedSiteSlug('staging-slot-001'), true);
  assert.equal(isReservedSiteSlug('production-slot-001'), true);
  assert.equal(isReservedSiteSlug('pages-v2-production-slot-001'), true);
  assert.equal(isReservedSiteSlug('v2-staging-slot-001'), true);
  assert.equal(validateSiteSlug('staging', { environment: 'production' }).error.code, 'RESERVED_SLUG');
  assert.equal(validateSiteSlug('staging-demo', { environment: 'production' }).error.code, 'RESERVED_SLUG');
  assert.equal(isReservedSiteSlug('q2-report'), false);
  assert.equal(validateSiteSlug('q2-report', { environment: 'production' }).ok, true);
  assert.equal(validateSiteSlug('docs-staging', { environment: 'production' }).error.code, 'RESERVED_SLUG');
  assert.equal(validateSiteSlug('docs-staging', { environment: 'staging' }).ok, true);
  assert.equal(validateSiteSlug('kv-gateway', { environment: 'production' }).error.code, 'RESERVED_SLUG');
  assert.equal(validateSiteSlug(`a${'b'.repeat(49)}1`, { environment: 'production' }).error.code, 'INVALID_SLUG');
});

test('user key validation rejects empty, reserved and oversized keys', () => {
  assert.equal(validateUserKey('app/config').ok, true);
  assert.equal(validateUserKey('').error.code, 'INVALID_KEY');
  assert.equal(validateUserKey('.').error.code, 'INVALID_KEY');
  assert.equal(validateUserKey('..').error.code, 'INVALID_KEY');
  assert.equal(validateUserKey('.xd-pages/runtime').error.code, 'INVALID_KEY');
  assert.equal(validateUserKey('__xd_pages/runtime').error.code, 'INVALID_KEY');
  assert.equal(validateUserKey('a'.repeat(257)).error.code, 'INVALID_KEY');
});

test('list options allow empty prefix while validating real prefixes', () => {
  assert.deepEqual(validateListOptions({ prefix: '' }), {
    ok: true,
    value: { prefix: '', limit: undefined, cursor: undefined },
  });
  assert.equal(validateListOptions({ prefix: 'app/' }).ok, true);
  assert.equal(validateListOptions({ prefix: '.xd-pages/' }).error.code, 'INVALID_KEY');
});

test('user key validation rejects unpaired surrogate code units', () => {
  assert.equal(validateUserKey('\uD800prefix').error.code, 'INVALID_KEY');
  assert.equal(validateUserKey('suffix\uD800').error.code, 'INVALID_KEY');
  assert.equal(validateUserKey('\uDC00suffix').error.code, 'INVALID_KEY');
  assert.equal(validateUserKey('prefix\uDC00').error.code, 'INVALID_KEY');
  assert.equal(validateUserKey('emoji-\uD83D\uDE00').ok, true);
  assert.equal(validateUserKey('\uD800').error.code, 'INVALID_KEY');
  assert.equal(validateUserKey('\uFFFD').ok, true);
});

test('user key encoding is base64url and reversible at storage-key boundary', () => {
  assert.equal(encodeUserKey('a/b c%中文'), 'YS9iIGMl5Lit5paH');
  const key = buildStorageKey({
    siteSlug: 'q2-report',
    siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47',
    userKey: 'a/b c%中文',
  });
  assert.equal(key, 's/q2-report--4b4c8e8361ef4b47b64f5c20a7db7c47/k/YS9iIGMl5Lit5paH');
});

test('user data storage key is isolated by platform user id', () => {
  const siteUuid = '4b4c8e8361ef4b47b64f5c20a7db7c47';
  const siteKey = buildStorageKey({
    siteSlug: 'q2-report',
    siteUuid,
    userKey: 'prefs/theme',
  });
  const userKey = buildUserStorageKey({
    siteSlug: 'q2-report',
    siteUuid,
    userId: 'usr_123',
    userKey: 'prefs/theme',
  });

  assert.equal(siteKey, `s/q2-report--${siteUuid}/k/cHJlZnMvdGhlbWU`);
  assert.equal(userKey, `s/q2-report--${siteUuid}/u/usr_123/k/cHJlZnMvdGhlbWU`);
  assert.notEqual(siteKey, userKey);
  assert.throws(
    () =>
      buildUserStorageKey({
        siteSlug: 'q2-report',
        siteUuid,
        userId: 'user@example.com',
        userKey: 'prefs/theme',
      }),
    /Invalid user id/
  );
});

test('storage key validates slug, UUID and final Cloudflare KV key length', () => {
  assert.throws(
    () => buildStorageKey({ siteSlug: 'Bad', siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47', userKey: 'ok' }),
    /Invalid site slug/
  );
  assert.throws(
    () => buildStorageKey({ siteSlug: 'q2-report', siteUuid: 'bad', userKey: 'ok' }),
    /Invalid site UUID/
  );
  const nearLimit = buildStorageKey({
    siteSlug: 'a'.repeat(50),
    siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47',
    userKey: '中'.repeat(80),
  });
  assert.ok(new TextEncoder().encode(nearLimit).byteLength <= 512);
});

test('type and ttl validation match runtime contract', () => {
  assert.equal(validateKvType(undefined).value, 'json');
  assert.equal(validateKvType('text').value, 'text');
  assert.equal(validateKvType('binary').error.code, 'INVALID_TYPE');
  assert.equal(validateTtl(undefined).value, undefined);
  assert.equal(validateTtl(null).value, undefined);
  assert.equal(validateTtl(null).ok, true);
  assert.equal(validateTtl(60).value, 60);
  assert.equal(validateTtl(31536000).value, 31536000);
  assert.equal(validateTtl(59).error.code, 'INVALID_TTL');
  assert.equal(validateTtl(60.5).error.code, 'INVALID_TTL');
  assert.equal(validateTtl(31536001).error.code, 'INVALID_TTL');
});

test('JSON envelopes are stable', () => {
  assert.deepEqual(buildOkEnvelope({ key: 'x' }), { ok: true, key: 'x' });
  assert.deepEqual(buildOkEnvelope({ ok: false, key: 'x' }), { ok: true, key: 'x' });
  assert.deepEqual(buildErrorEnvelope('INVALID_KEY', 'Invalid data key'), {
    ok: false,
    error: { code: 'INVALID_KEY', message: 'Invalid data key' },
  });
});
