import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCESS_KEY_EXPIRY_OPTIONS,
  ACCESS_KEY_PERMISSION_OPTIONS,
  buildAccessKeyCreateBody,
  buildAccessKeyRows,
  initialAccessKeyForm,
} from './access-keys-model.js';

test('access key create model defaults to read and publish for 90 days', () => {
  const form = initialAccessKeyForm();

  assert.deepEqual(form.permissions, ['read', 'publish']);
  assert.equal(form.expiresInDays, 90);
  assert.equal(ACCESS_KEY_PERMISSION_OPTIONS.map((option) => option.value).join(','), 'read,publish');
  assert.equal(ACCESS_KEY_EXPIRY_OPTIONS.map((option) => option.days).join(','), '30,90,180,365');
});

test('access key create body maps UI permissions to API scopes and expiry', () => {
  const body = buildAccessKeyCreateBody(
    {
      name: ' Local CLI ',
      permissions: ['read', 'publish'],
      expiresInDays: 90,
    },
    new Date('2026-07-01T00:00:00.000Z')
  );

  assert.deepEqual(body, {
    name: 'Local CLI',
    scopes: ['read:site', 'deploy:site'],
    expiresAt: '2026-09-29T00:00:00.000Z',
  });
});

test('access key create body rejects empty permissions', () => {
  assert.throws(
    () =>
      buildAccessKeyCreateBody({
        name: 'no permission',
        permissions: [],
        expiresInDays: 90,
      }),
    /ACCESS_KEY_PERMISSION_REQUIRED/
  );
});

test('access key create body rejects permissions that are not exposed in this version', () => {
  assert.throws(
    () =>
      buildAccessKeyCreateBody({
        name: 'rollback',
        permissions: ['rollback'],
        expiresInDays: 90,
      }),
    /ACCESS_KEY_PERMISSION_UNSUPPORTED/
  );
});

test('access key rows hide revoked keys and expose only token preview', () => {
  const rows = buildAccessKeyRows([
    {
      id: 'ak_00197d61ff057c411c631cde9b67dc04',
      name: 'Local CLI',
      scopes: ['read:site', 'deploy:site'],
      ownerType: 'user',
      createdAt: '2026-07-01T00:00:00.000Z',
      expiresAt: null,
      plaintext: 'xdsk_user_full_secret_should_not_render',
    },
    {
      id: 'ak_revoked',
      name: 'Old key',
      scopes: ['read:site'],
      revokedAt: '2026-07-02T00:00:00.000Z',
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'Local CLI');
  assert.equal(rows[0].tokenPreview, 'ak_00197d61');
  assert.equal(rows[0].plaintext, undefined);
  assert.deepEqual(rows[0].scopeLabels, ['read', 'deploy']);
  assert.equal(rows[0].ownerLabel, '个人');
  assert.equal(rows[0].expiresLabel, '永久');
});

test('access key rows expose safe source labels for Console, CLI login, and unknown-source keys', () => {
  const rows = buildAccessKeyRows([
    {
      id: 'ak_console',
      name: 'Console',
      scopes: ['read:site'],
      ownerType: 'user',
      issuedSource: 'console',
    },
    {
      id: 'ak_cli_login',
      name: 'CLI login',
      scopes: ['*'],
      ownerType: 'user',
      issuedSource: 'cli_login',
    },
    {
      id: 'ak_00197d61ff057c411c631cde9b67dc04',
      name: 'Unknown source',
      scopes: ['read:site', 'deploy:site'],
      ownerType: 'user',
      issuedSource: 'xdmaker_s2s',
    },
  ]);

  assert.equal(rows[0].sourceLabel, 'Console');
  assert.equal(rows[0].sourceKind, 'console');
  assert.equal(rows[1].sourceLabel, 'CLI');
  assert.equal(rows[1].sourceKind, 'cli');
  assert.equal(rows[2].sourceLabel, '其它');
  assert.equal(rows[2].sourceKind, 'other');
  assert.equal(rows[2].raw.id, 'ak_00197d61ff057c411c631cde9b67dc04');
});
