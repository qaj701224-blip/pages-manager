import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkerCode, buildWorkerMetadata } from './cf-api.js';

test('worker preset binds IP_ALLOWLIST without rewriting user worker code', () => {
  const allowlist = '127.0.0.1,::1';
  const userWorkerCode = 'export default { async fetch() { return new Response("ok"); } };';

  const metadata = buildWorkerMetadata('completion-jwt', 'worker', true, allowlist);
  const code = buildWorkerCode('worker', userWorkerCode, true, allowlist);

  assert.deepEqual(metadata.bindings, [
    { type: 'assets', name: 'ASSETS' },
    { type: 'plain_text', name: 'IP_ALLOWLIST', text: allowlist },
  ]);
  assert.equal(code, userWorkerCode);
});

test('public worker preset does not bind IP_ALLOWLIST', () => {
  const metadata = buildWorkerMetadata('completion-jwt', 'worker', false, '127.0.0.1');

  assert.deepEqual(metadata.bindings, [{ type: 'assets', name: 'ASSETS' }]);
});

test('kv disabled does not bind gateway or capability', () => {
  const metadata = buildWorkerMetadata('completion-jwt', 'spa', false, '127.0.0.1');

  assert.equal(metadata.bindings.some((binding) => binding.name === 'XD_PAGES_KV_GATEWAY'), false);
  assert.equal(metadata.bindings.some((binding) => binding.name === 'XD_PAGES_KV_CAPABILITY'), false);
});

test('kv enabled binds gateway, site identifiers, env and capability', () => {
  const metadata = buildWorkerMetadata('completion-jwt', 'spa', false, '127.0.0.1', {
    kv: {
      enabled: true,
      gatewayService: 'pages-kv-gateway',
      siteId: 'demo',
      siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47',
      envName: 'staging',
      capability: 'capability.jwt',
    },
  });

  assert.deepEqual(metadata.bindings, [
    { type: 'assets', name: 'ASSETS' },
    { type: 'service', name: 'XD_PAGES_KV_GATEWAY', service: 'pages-kv-gateway' },
    { type: 'plain_text', name: 'XD_PAGES_SITE_ID', text: 'demo' },
    { type: 'plain_text', name: 'XD_PAGES_SITE_UUID', text: '4b4c8e8361ef4b47b64f5c20a7db7c47' },
    { type: 'plain_text', name: 'XD_PAGES_ENV', text: 'staging' },
    { type: 'plain_text', name: 'XD_PAGES_KV_CAPABILITY', text: 'capability.jwt' },
  ]);
});

test('static preset still compiles the allowlist into the generated guard', () => {
  const code = buildWorkerCode('static', null, true, '127.0.0.1,::1');

  assert.match(code, /const A=\["127\.0\.0\.1","::1"\]/);
  assert.match(code, /checkIP\(request\)/);
});

test('static preset with kv options does not generate runtime support', () => {
  const code = buildWorkerCode('static', null, false, '127.0.0.1', {
    kv: {
      enabled: true,
      gatewayService: 'pages-kv-gateway',
      siteId: 'demo',
      siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47',
      envName: 'staging',
      capability: 'capability.jwt',
    },
  });

  assert.doesNotMatch(code, /handlePagesRuntimeRequest/);
  assert.doesNotMatch(code, /\/\.xd-pages\/runtime\/v1/);
});

test('spa kv worker checks runtime path before assets with guard and inline runtime', () => {
  const code = buildWorkerCode('spa', null, false, '127.0.0.1', {
    kv: {
      enabled: true,
      gatewayService: 'pages-kv-gateway',
      siteId: 'demo',
      siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47',
      envName: 'staging',
      capability: 'capability.jwt',
    },
  });

  assert.match(code, /handlePagesRuntimeRequest/);
  assert.match(code, /checkIP\(request\)/);
  assert.doesNotMatch(code, /from\s+['"]@xd\//);
  assert.doesNotMatch(code, /import\(['"]@xd\//);
  assert.ok(code.indexOf('/.xd-pages/runtime/v1') < code.indexOf('env.ASSETS.fetch'));
  assert.ok(code.indexOf('handlePagesRuntimeRequest') < code.indexOf('env.ASSETS.fetch'));
});

test('worker preset with kv keeps user worker code unchanged while metadata has kv bindings', () => {
  const userWorkerCode = 'export default { async fetch() { return new Response("ok"); } };';
  const options = {
    kv: {
      enabled: true,
      gatewayService: 'pages-kv-gateway',
      siteId: 'demo',
      siteUuid: '4b4c8e8361ef4b47b64f5c20a7db7c47',
      envName: 'staging',
      capability: 'capability.jwt',
    },
  };

  const metadata = buildWorkerMetadata('completion-jwt', 'worker', false, '', options);
  const code = buildWorkerCode('worker', userWorkerCode, false, '', options);

  assert.equal(code, userWorkerCode);
  assert.ok(metadata.bindings.some((binding) => binding.name === 'XD_PAGES_KV_GATEWAY'));
  assert.ok(metadata.bindings.some((binding) => binding.name === 'XD_PAGES_KV_CAPABILITY'));
});
