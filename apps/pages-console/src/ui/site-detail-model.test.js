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
  siteAccessEffectLabel,
  siteExposureAuditWarning,
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

test('site action errors explain effective exposure with an audit failure', () => {
  const message = formatSiteActionError({
    code: 'SITE_EXPOSURE_AUDIT_FAILED',
    message: 'Site exposure is effective, but the final audit record could not be confirmed.',
    action: 'Refresh the site status and retry the exposure operation to reconcile its audit trail.',
  });

  assert.equal(message, '公网访问已经生效，但最终审计记录未确认，请刷新站点状态并核对审计日志。');
});

test('site action errors explain that required exposure audit failure prevents the operation', () => {
  const message = formatSiteActionError({
    code: 'SITE_EXPOSURE_AUDIT_REQUIRED',
    message: 'Exposure operation was not started because its required audit record could not be written.',
    action: 'Retry after checking the audit store.',
  });

  assert.equal(message, '审计记录当前不可用，公网访问操作尚未开始，请稍后重试。');
});

test('site exposure audit warnings describe the requested transition', () => {
  assert.equal(siteExposureAuditWarning('public'), '公网访问已经生效，但最终审计记录未确认，请刷新站点状态并核对审计日志。');
  assert.equal(siteExposureAuditWarning('internal'), '公网访问已关闭，但最终审计记录未确认，请刷新站点状态并核对审计日志。');
});

test('site access effect labels keep network exposure separate from identity mode', () => {
  assert.equal(siteAccessEffectLabel({ exposure: 'public', accessMode: 'anonymous' }), '互联网匿名访问');
  assert.equal(siteAccessEffectLabel({ exposure: 'public', accessMode: 'org' }), '公网可达，需企业成员登录');
  assert.equal(siteAccessEffectLabel({ exposure: 'internal', visibility: 'internal' }), '公司网络内免登录访问');
  assert.equal(siteAccessEffectLabel({ exposure: 'internal', accessMode: 'acl' }), '公司网络内需通过 ACL');
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
