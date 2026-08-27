import assert from 'node:assert/strict';
import test from 'node:test';

import { decodePublicSitesCursor, encodePublicSitesCursor, parsePublicSitesQuery } from './public-sites-handler.js';

const UPDATED_AT = '2026-08-27T01:02:03.000Z';

test('public sites query defaults limit and accepts canonical boundaries', () => {
  assert.deepEqual(parsePublicSitesQuery(new URL('https://api.pages.xd.team/public/sites'), 'production'), {
    limit: 50,
    cursor: null,
  });
  assert.deepEqual(parsePublicSitesQuery(new URL('https://api.pages.xd.team/public/sites?limit=1'), 'staging'), {
    limit: 1,
    cursor: null,
  });
  assert.deepEqual(parsePublicSitesQuery(new URL('https://api.pages.xd.team/public/sites?limit=100'), 'local'), {
    limit: 100,
    cursor: null,
  });
});

test('public sites query rejects noncanonical and out-of-range limits', () => {
  for (const value of ['', '0', '101', '-1', '+1', '1.0', '01', ' 1']) {
    assertPublicSitesQueryInvalid(
      () => parsePublicSitesQuery(new URL(`https://api.pages.xd.team/public/sites?limit=${encodeURIComponent(value)}`), 'local'),
      `limit=${JSON.stringify(value)}`
    );
  }
});

test('public sites query rejects unknown and repeated parameters', () => {
  for (const query of ['owner=user', 'limit=1&limit=2', 'cursor=abc&cursor=def']) {
    assertPublicSitesQueryInvalid(
      () => parsePublicSitesQuery(new URL(`https://api.pages.xd.team/public/sites?${query}`), 'production'),
      query
    );
  }
});

test('public sites query rejects empty, overlong, non-ASCII, and non-base64url cursors', () => {
  for (const cursor of ['', 'a'.repeat(2049), 'é', 'abc=', 'abc.def']) {
    const url = new URL('https://api.pages.xd.team/public/sites');
    url.searchParams.set('cursor', cursor);
    assertPublicSitesQueryInvalid(() => parsePublicSitesQuery(url, 'production'), `cursor=${JSON.stringify(cursor)}`);
  }
});

test('public sites cursor uses the exact versioned payload and round-trips in local', () => {
  const cursor = encodePublicSitesCursor({
    environment: 'local',
    updatedAt: UPDATED_AT,
    id: 'site_local_1',
  });

  assert.match(cursor, /^[A-Za-z0-9_-]+$/);
  assert.ok(cursor.length <= 2048);
  assert.deepEqual(readCursorPayload(cursor), {
    v: 1,
    scope: 'public-sites',
    environment: 'local',
    updatedAt: UPDATED_AT,
    id: 'site_local_1',
  });
  assert.deepEqual(decodePublicSitesCursor(cursor, 'local'), {
    updatedAt: UPDATED_AT,
    id: 'site_local_1',
  });

  const url = new URL('https://api.pages.xd.team/public/sites?limit=25');
  url.searchParams.set('cursor', cursor);
  assert.deepEqual(parsePublicSitesQuery(url, 'local'), {
    limit: 25,
    cursor: { updatedAt: UPDATED_AT, id: 'site_local_1' },
  });
});

test('public sites cursor rejects malformed base64, UTF-8, and JSON', () => {
  for (const cursor of ['a', encodeBytes(new Uint8Array([0xc3, 0x28])), encodeText('{')]) {
    assertPublicSitesQueryInvalid(() => decodePublicSitesCursor(cursor, 'production'), cursor);
  }
});

test('public sites cursor rejects noncanonical base64url pad bits', () => {
  const canonical = encodePayload(validPayload());
  const alias = replaceUnusedPadBits(canonical);

  assert.notEqual(alias, canonical);
  assert.deepEqual(readCursorPayload(alias), validPayload());
  assertPublicSitesQueryInvalid(() => decodePublicSitesCursor(alias, 'production'));
});

test('public sites cursor rejects a UTF-8 BOM before JSON', () => {
  const json = new globalThis.TextEncoder().encode(JSON.stringify(validPayload()));
  const bytes = new Uint8Array(json.length + 3);
  bytes.set([0xef, 0xbb, 0xbf]);
  bytes.set(json, 3);

  assertPublicSitesQueryInvalid(() => decodePublicSitesCursor(encodeBytes(bytes), 'production'));
});

test('public sites cursor rejects wrong version, scope, and environment', () => {
  const base = validPayload();
  for (const payload of [
    { ...base, v: 2 },
    { ...base, scope: 'sites' },
    { ...base, environment: 'staging' },
  ]) {
    assertPublicSitesQueryInvalid(() => decodePublicSitesCursor(encodePayload(payload), 'production'));
  }

  assertPublicSitesQueryInvalid(() => decodePublicSitesCursor(encodePayload(base), 'preview'));
});

test('public sites cursor rejects noncanonical timestamps and illegal site ids', () => {
  const base = validPayload();
  for (const updatedAt of ['2026-08-27T01:02:03Z', '2026-08-27 01:02:03.000Z', 'not-a-date']) {
    assertPublicSitesQueryInvalid(() => decodePublicSitesCursor(encodePayload({ ...base, updatedAt }), 'production'));
  }
  for (const id of ['site_', 'site_bad/id', `site_${'a'.repeat(129)}`, 'page_1']) {
    assertPublicSitesQueryInvalid(() => decodePublicSitesCursor(encodePayload({ ...base, id }), 'production'));
  }
});

test('public sites cursor rejects missing, extra, and mistyped payload properties', () => {
  const base = validPayload();
  const missingId = { ...base };
  delete missingId.id;

  for (const payload of [
    null,
    [],
    missingId,
    { ...base, extra: true },
    { ...base, v: '1' },
    { ...base, updatedAt: 0 },
    { ...base, id: null },
  ]) {
    assertPublicSitesQueryInvalid(() => decodePublicSitesCursor(encodePayload(payload), 'production'));
  }
});

test('public sites cursor encoder validates its inputs and remains within the wire limit', () => {
  const largestId = `site_${'a'.repeat(128)}`;
  const cursor = encodePublicSitesCursor({ environment: 'production', updatedAt: UPDATED_AT, id: largestId });
  assert.ok(cursor.length <= 2048);
  assert.deepEqual(decodePublicSitesCursor(cursor, 'production'), { updatedAt: UPDATED_AT, id: largestId });

  for (const input of [
    { environment: 'preview', updatedAt: UPDATED_AT, id: 'site_1' },
    { environment: 'production', updatedAt: '2026-08-27T01:02:03Z', id: 'site_1' },
    { environment: 'production', updatedAt: UPDATED_AT, id: 'site_' },
  ]) {
    assertPublicSitesQueryInvalid(() => encodePublicSitesCursor(input));
  }
});

function validPayload() {
  return {
    v: 1,
    scope: 'public-sites',
    environment: 'production',
    updatedAt: UPDATED_AT,
    id: 'site_1',
  };
}

function encodePayload(payload) {
  return encodeText(JSON.stringify(payload));
}

function encodeText(value) {
  return encodeBytes(new globalThis.TextEncoder().encode(value));
}

function encodeBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function replaceUnusedPadBits(cursor) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  assert.equal(cursor.length % 4, 3);
  const lastIndex = alphabet.indexOf(cursor.at(-1));
  assert.equal(lastIndex % 4, 0);
  return `${cursor.slice(0, -1)}${alphabet[lastIndex + 1]}`;
}

function readCursorPayload(cursor) {
  const padded = cursor.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (cursor.length % 4)) % 4);
  const binary = globalThis.atob(padded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  return JSON.parse(new globalThis.TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function assertPublicSitesQueryInvalid(callback, message) {
  assert.throws(
    callback,
    (error) => error instanceof Error && error.name === 'PublicSitesQueryError' && error.code === 'PUBLIC_SITES_QUERY_INVALID',
    message
  );
}
