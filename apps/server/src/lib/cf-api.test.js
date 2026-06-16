import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWorkerCode, buildWorkerMetadata, deleteScript } from './cf-api.js';

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

test('worker preset binds IP_ALLOWLIST even when ipRestrict is false', () => {
  const metadata = buildWorkerMetadata('completion-jwt', 'worker', false, '127.0.0.1');

  assert.deepEqual(metadata.bindings, [
    { type: 'assets', name: 'ASSETS' },
    { type: 'plain_text', name: 'IP_ALLOWLIST', text: '127.0.0.1' },
  ]);
});

test('v1 worker metadata does not bind KV gateway or capability', () => {
  const metadata = buildWorkerMetadata('completion-jwt', 'spa', false, '127.0.0.1');

  assert.equal(metadata.bindings.some((binding) => binding.name === 'XD_PAGES_KV_GATEWAY'), false);
  assert.equal(metadata.bindings.some((binding) => binding.name === 'XD_PAGES_KV_CAPABILITY'), false);
});

test('v1 worker metadata ignores legacy KV options', () => {
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

  assert.deepEqual(metadata.bindings, [{ type: 'assets', name: 'ASSETS' }]);
});

test('static preset still compiles the allowlist into the generated guard', () => {
  const code = buildWorkerCode('static', null, true, '127.0.0.1,::1');

  assert.match(code, /const A=\["127\.0\.0\.1","::1"\]/);
  assert.match(code, /checkIP\(request\)/);
});

test('static preset with legacy KV options does not generate runtime support', () => {
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

test('spa preset with legacy KV options does not generate runtime support', () => {
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

  assert.match(code, /function checkIP/);
  assert.match(code, /const b=checkIP\(request\);if\(b\)return b;/);
  assert.doesNotMatch(code, /handlePagesRuntimeRequest/);
  assert.doesNotMatch(code, /\/\.xd-pages\/runtime\/v1/);
  assert.doesNotMatch(code, /from\s+['"]@xd\//);
  assert.doesNotMatch(code, /import\(['"]@xd\//);
});

test('worker preset with legacy KV options keeps user worker code unchanged without KV bindings', () => {
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
  assert.equal(metadata.bindings.some((binding) => binding.name === 'XD_PAGES_KV_GATEWAY'), false);
  assert.equal(metadata.bindings.some((binding) => binding.name === 'XD_PAGES_KV_CAPABILITY'), false);
});

test('deleteScript rejects platform worker names even when they use the site prefix', async () => {
  await assert.rejects(() => deleteScript('token', 'account', 'pages-manager'), /平台保留 Worker/);
  await assert.rejects(() => deleteScript('token', 'account', 'pages-manager-staging'), /平台保留 Worker/);
  await assert.rejects(() => deleteScript('token', 'account', 'pages-kv-gateway'), /平台保留 Worker/);
  await assert.rejects(() => deleteScript('token', 'account', 'pages-kv-gateway-staging'), /平台保留 Worker/);
});
