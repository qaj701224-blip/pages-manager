import assert from 'node:assert/strict';
import test from 'node:test';

import {
  aclSubjectPlaceholder,
  aclSubjectTypeLabel,
  appendAclEntry,
  formatSiteActionError,
  getSiteCapabilities,
  normalizeAclEntriesForForm,
  parseAclEntriesInput,
  removeAclEntryAt,
  toAclUpdatePayload,
} from './site-detail-model.js';

test('site capabilities allow publisher to edit vars but not access policy or secrets', () => {
  const capabilities = getSiteCapabilities({
    permissions: {
      role: 'publisher',
      canManage: true,
      canManageAccess: false,
    },
  });

  assert.deepEqual(capabilities, {
    role: 'publisher',
    canEditVars: true,
    canEditAccess: false,
    canEditSecrets: false,
  });
});

test('site capabilities allow admin to edit access policy, vars, and secrets', () => {
  const capabilities = getSiteCapabilities({
    permissions: {
      role: 'admin',
      canManage: true,
      canManageAccess: true,
    },
  });

  assert.deepEqual(capabilities, {
    role: 'admin',
    canEditVars: true,
    canEditAccess: true,
    canEditSecrets: true,
  });
});

test('site capabilities keep viewer read-only', () => {
  const capabilities = getSiteCapabilities({
    permissions: {
      role: 'viewer',
      canManage: false,
      canManageAccess: false,
    },
  });

  assert.deepEqual(capabilities, {
    role: 'viewer',
    canEditVars: false,
    canEditAccess: false,
    canEditSecrets: false,
  });
});

test('site action errors explain missing publisher permission in Chinese', () => {
  const message = formatSiteActionError({
    code: 'SITE_PUBLISHER_REQUIRED',
    message: 'Site publisher role required.',
    action: 'Ask a site or team publisher.',
  });

  assert.equal(message, '当前账号没有发布权限，需要站点归属用户或团队 publisher/admin 操作。');
});

test('parseAclEntriesInput accepts an ACL array and rejects other JSON shapes', () => {
  assert.deepEqual(parseAclEntriesInput('[{"subjectType":"email","subjectValue":"user@example.com","accessRole":"viewer"}]'), [
    { subjectType: 'email', subjectValue: 'user@example.com', accessRole: 'viewer' },
  ]);

  assert.throws(() => parseAclEntriesInput('{}'), {
    code: 'ACL_JSON_INVALID',
  });
  assert.throws(() => parseAclEntriesInput('{'), {
    code: 'ACL_JSON_INVALID',
  });
});

test('appendAclEntry normalizes email and department entries for the form', () => {
  const withEmail = appendAclEntry([], {
    subjectType: 'email',
    subjectValue: ' Alice@Example.COM ',
  });
  const withDepartment = appendAclEntry(withEmail, {
    subjectType: 'department',
    subjectValue: ' 心动 / 平台支撑部 / Web ',
  });

  assert.deepEqual(withDepartment, [
    {
      subjectType: 'email',
      subjectValue: 'alice@example.com',
      accessRole: 'viewer',
      effect: 'allow',
    },
    {
      subjectType: 'department',
      subjectValue: '心动/平台支撑部/Web',
      accessRole: 'viewer',
      effect: 'allow',
    },
  ]);
});

test('appendAclEntry dedupes subjects and rejects unsupported entries', () => {
  const entries = appendAclEntry(
    [
      {
        subjectType: 'email',
        subjectValue: 'alice@example.com',
        accessRole: 'viewer',
        effect: 'allow',
      },
    ],
    {
      subjectType: 'email',
      subjectValue: 'Alice@Example.COM',
    }
  );

  assert.equal(entries.length, 1);
  assert.throws(() => appendAclEntry([], { subjectType: 'user', subjectValue: 'usr_1' }), {
    code: 'ACL_SUBJECT_TYPE_UNSUPPORTED',
  });
  assert.throws(() => appendAclEntry([], { subjectType: 'email', subjectValue: 'not-an-email' }), {
    code: 'ACL_SUBJECT_VALUE_INVALID',
  });
});

test('ACL form helpers remove entries and build the update payload', () => {
  const entries = normalizeAclEntriesForForm([
    { id: 'acl_1', subjectType: 'email', subjectValue: 'alice@example.com' },
    { id: 'acl_2', subjectType: 'department', subjectValue: '心动/平台支撑部' },
  ]);

  assert.deepEqual(toAclUpdatePayload(removeAclEntryAt(entries, 0)), [
    {
      subjectType: 'department',
      subjectValue: '心动/平台支撑部',
      accessRole: 'viewer',
      effect: 'allow',
    },
  ]);
  assert.equal(aclSubjectTypeLabel('email'), '邮箱');
  assert.equal(aclSubjectTypeLabel('department'), '部门');
  assert.equal(aclSubjectPlaceholder('email'), 'name@xd.com');
});
