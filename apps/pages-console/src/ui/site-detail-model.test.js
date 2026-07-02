import assert from 'node:assert/strict';
import test from 'node:test';

import { getSiteCapabilities, parseAclEntriesInput } from './site-detail-model.js';

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
