import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyHost } from './host.js';

test('classifies production site hostnames', () => {
  assert.deepEqual(classifyHost('demo.pages.xd.team', { environment: 'production' }), {
    ok: true,
    environment: 'production',
    hostname: 'demo.pages.xd.team',
    slug: 'demo',
  });
});

test('classifies staging site hostnames', () => {
  assert.deepEqual(classifyHost('demo-staging.pages.xd.team', { environment: 'staging' }), {
    ok: true,
    environment: 'staging',
    hostname: 'demo-staging.pages.xd.team',
    slug: 'demo',
  });
});

test('rejects platform reserved hosts', () => {
  assert.equal(classifyHost('api.pages.xd.team', { environment: 'production' }).code, 'RESERVED_HOST');
  assert.equal(classifyHost('auth.pages.xd.team', { environment: 'production' }).code, 'RESERVED_HOST');
  assert.equal(classifyHost('api-staging.pages.xd.team', { environment: 'staging' }).code, 'RESERVED_HOST');
  assert.equal(classifyHost('auth-staging.pages.xd.team', { environment: 'staging' }).code, 'RESERVED_HOST');
});

test('rejects production slugs that look like staging hosts', () => {
  assert.equal(classifyHost('demo-staging.pages.xd.team', { environment: 'production' }).code, 'RESERVED_SLUG');
});

test('rejects invalid hostnames and cross-environment hosts', () => {
  assert.equal(classifyHost('demo.pages.xd.team', { environment: 'staging' }).code, 'HOST_ENV_MISMATCH');
  assert.equal(classifyHost('demo-staging.pages.xd.team', { environment: 'production' }).code, 'RESERVED_SLUG');
  assert.equal(classifyHost('foo.bar.pages.xd.team', { environment: 'production' }).code, 'INVALID_HOST');
  assert.equal(classifyHost('pages.xd.team', { environment: 'production' }).code, 'INVALID_HOST');
  assert.equal(classifyHost('demo.workers.xd.team', { environment: 'production' }).code, 'INVALID_HOST');
});

test('rejects reserved slugs and invalid slug syntax', () => {
  assert.equal(classifyHost('admin.pages.xd.team', { environment: 'production' }).code, 'RESERVED_SLUG');
  assert.equal(classifyHost('-bad.pages.xd.team', { environment: 'production' }).code, 'INVALID_SLUG');
  assert.equal(classifyHost('Bad.pages.xd.team', { environment: 'production' }).code, 'INVALID_SLUG');
});
