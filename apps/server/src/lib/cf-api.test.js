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
    { type: 'secret_text', name: 'XD_PAGES_KV_CAPABILITY', text: 'capability.jwt' },
  ]);
});

test('kv capability binding is not plain text metadata', () => {
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

  const capabilityBinding = metadata.bindings.find((binding) => binding.name === 'XD_PAGES_KV_CAPABILITY');

  assert.equal(capabilityBinding?.type, 'secret_text');
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

test('public spa kv worker exposes runtime before assets without IP allowlist', () => {
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
  assert.match(code, /CF-Connecting-IP/);
  assert.doesNotMatch(code, /function checkIP/);
  assert.doesNotMatch(code, /checkIP\(request\)/);
  assert.doesNotMatch(code, /from\s+['"]@xd\//);
  assert.doesNotMatch(code, /import\(['"]@xd\//);
  assert.ok(code.indexOf('/.xd-pages/runtime/v1') < code.indexOf('env.ASSETS.fetch'));
  assert.ok(code.indexOf('handlePagesRuntimeRequest') < code.indexOf('env.ASSETS.fetch'));
});

test('restricted spa kv worker applies IP allowlist to runtime and assets', () => {
  const code = buildWorkerCode('spa', null, true, '127.0.0.1', {
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
  assert.match(code, /const denied = checkIP\(request\);if\(denied\)return denied;/);
  assert.match(code, /const b=checkIP\(request\);if\(b\)return b;/);
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

test('deleteScript rejects platform worker names even when they use the site prefix', async () => {
  await assert.rejects(() => deleteScript('token', 'account', 'pages-manager'), /平台保留 Worker/);
  await assert.rejects(() => deleteScript('token', 'account', 'pages-manager-staging'), /平台保留 Worker/);
  await assert.rejects(() => deleteScript('token', 'account', 'pages-kv-gateway'), /平台保留 Worker/);
  await assert.rejects(() => deleteScript('token', 'account', 'pages-kv-gateway-staging'), /平台保留 Worker/);
});
