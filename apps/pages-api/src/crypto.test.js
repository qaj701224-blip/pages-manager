import assert from 'node:assert/strict';
import test from 'node:test';

import {
  canonicalRequestHash,
  constantTimeEqualHex,
  createAccessKeyPlaintext,
  hashAccessKey,
  parseAccessKeyPlaintext,
  sha256HexForBytes,
  sha256HexForText,
} from './crypto.js';

const encoder = new globalThis.TextEncoder();

test('canonical request hash is stable for object key ordering', async () => {
  const left = await canonicalRequestHash({
    siteId: 'site_1',
    deployment: { shape: 'worker-only', files: ['b.js', 'a.js'] },
    visibility: 'org',
  });
  const right = await canonicalRequestHash({
    visibility: 'org',
    deployment: { files: ['b.js', 'a.js'], shape: 'worker-only' },
    siteId: 'site_1',
  });

  assert.equal(left, right);
  assert.match(left, /^sha256:[a-f0-9]{64}$/);
});

test('hashAccessKey uses HMAC pepper and constant-time hex comparison', async () => {
  const first = await hashAccessKey('xdp_prod_ak_1_secret', 'pepper-secret');
  const second = await hashAccessKey('xdp_prod_ak_1_secret', 'pepper-secret');
  const differentPepper = await hashAccessKey('xdp_prod_ak_1_secret', 'other-pepper');

  assert.equal(first, second);
  assert.notEqual(first, differentPepper);
  assert.equal(constantTimeEqualHex(first, second), true);
  assert.equal(constantTimeEqualHex(first, differentPepper), false);
});

test('sha256 helpers hash text and uploaded bytes', async () => {
  const textHash = await sha256HexForText('hello');
  const bytesHash = await sha256HexForBytes(encoder.encode('hello'));

  assert.equal(textHash, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.equal(bytesHash, textHash);
});

test('access key plaintext carries non-authoritative environment hint and key id', () => {
  const plaintext = createAccessKeyPlaintext({
    environment: 'production',
    keyId: 'ak_test',
    bytes: new Uint8Array(24).fill(7),
  });

  assert.match(plaintext, /^xdp_prod_ak_test_[A-Za-z0-9_-]+$/);
  assert.deepEqual(parseAccessKeyPlaintext(plaintext), {
    environmentHint: 'production',
    keyId: 'ak_test',
  });
});
