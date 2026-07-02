import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ACCESS_KEY_EXPIRY_OPTIONS,
  ACCESS_KEY_PERMISSION_OPTIONS,
  buildAccessKeyCreateBody,
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
