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

test('static preset still compiles the allowlist into the generated guard', () => {
  const code = buildWorkerCode('static', null, true, '127.0.0.1,::1');

  assert.match(code, /const A=\["127\.0\.0\.1","::1"\]/);
  assert.match(code, /checkIP\(request\)/);
});
