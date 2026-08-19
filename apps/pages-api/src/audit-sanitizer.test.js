import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeAuditMetadata } from './audit-sanitizer.js';

test('audit sanitizer redacts secrets and provider references recursively', () => {
  const result = sanitizeAuditMetadata({
    siteSlug: 'demo',
    nested: {
      Authorization: 'Bearer secret',
      workerName: 'pages-v2-secret-reference',
      resourceRef: 'route-secret-reference',
      url: 'https://hooks.example.test/path/bearer?token=secret#fragment',
    },
  });
  assert.equal(result.siteSlug, 'demo');
  assert.equal(result.nested.Authorization, '[REDACTED]');
  assert.equal(result.nested.workerName, '[REDACTED]');
  assert.equal(result.nested.resourceRef, '[REDACTED]');
  assert.equal(result.nested.url, 'https://hooks.example.test');
});

test('audit sanitizer redacts composite sensitive keys and trims URLs before inspection', () => {
  const result = sanitizeAuditMetadata({
    clientSecret: 'secret',
    accessToken: 'token',
    sessionToken: 'session',
    passwordHash: 'hash',
    api_token: 'api-token',
    refresh_token: 'refresh-token',
    cfAccountId: 'account',
    artifactRef: 'artifact',
    scriptName: 'worker',
    url: '  https://hooks.example.test/path?token=secret  ',
  });

  for (const key of [
    'clientSecret',
    'accessToken',
    'sessionToken',
    'passwordHash',
    'api_token',
    'refresh_token',
    'cfAccountId',
    'artifactRef',
    'scriptName',
  ]) {
    assert.equal(result[key], '[REDACTED]', key);
  }
  assert.equal(result.url, 'https://hooks.example.test');
});

test('audit sanitizer removes embedded URL credentials and common sensitive key variants', () => {
  const result = sanitizeAuditMetadata({
    reason: 'See https://hooks.example.test/bearer-secret?token=abc#fragment before approval',
    sessionId: 'sess-secret',
    providerResourceIds: ['cf-secret'],
    authTokenValue: 'token-secret',
  });

  assert.equal(result.reason, 'See https://hooks.example.test before approval');
  assert.equal(result.sessionId, '[REDACTED]');
  assert.equal(result.providerResourceIds, '[REDACTED]');
  assert.equal(result.authTokenValue, '[REDACTED]');
});

test('audit sanitizer bounds depth, keys, arrays, and strings', () => {
  const result = sanitizeAuditMetadata({
    long: 'x'.repeat(2000),
    many: Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`key${index}`, index])),
    values: Array.from({ length: 100 }, (_, index) => index),
    nested: { level: { deeper: { deepest: { another: { value: true } } } } },
  });
  assert.equal(result.long, '[TRUNCATED]');
  assert.equal(Object.keys(result.many).length, 40);
  assert.equal(result.many.__truncated__, '[TRUNCATED]');
  assert.equal(result.values.length, 30);
  assert.equal(result.values.at(-1), '[TRUNCATED]');
  assert.equal(result.nested.level.deeper.deepest.another, '[TRUNCATED]');
});

test('audit sanitizer keeps safe primitives and rejects unsupported values', () => {
  const result = sanitizeAuditMetadata({
    number: 3,
    boolean: false,
    nullValue: null,
    unsupported: new Date('2026-01-01T00:00:00.000Z'),
  });
  assert.deepEqual(result, {
    number: 3,
    boolean: false,
    nullValue: null,
    unsupported: '[UNSUPPORTED]',
  });
});
