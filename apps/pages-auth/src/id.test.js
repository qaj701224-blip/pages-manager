import assert from 'node:assert/strict';
import test from 'node:test';

import { constantTimeEqualHex, createOpaqueToken, sha256Hex } from './id.js';

test('createOpaqueToken uses prefix and base64url characters', () => {
  const token = createOpaqueToken('ost', {
    bytes: new Uint8Array([0, 1, 2, 3, 250, 251, 252, 253]),
  });

  assert.equal(token, 'ost_AAECA_r7_P0');
});

test('createOpaqueToken requires a safe lowercase prefix', () => {
  assert.throws(() => createOpaqueToken('Bad', { bytes: new Uint8Array([1]) }), /prefix/i);
  assert.throws(() => createOpaqueToken('bad-prefix', { bytes: new Uint8Array([1]) }), /prefix/i);
});

test('sha256Hex returns stable lowercase hex', async () => {
  assert.equal(await sha256Hex('secret'), '2bb80d537b1da3e38bd30361aa855686bde0eacd7162fef6a25fe97bf527a25b');
});

test('constantTimeEqualHex compares equal-length hex digests', () => {
  assert.equal(constantTimeEqualHex('aa00', 'aa00'), true);
  assert.equal(constantTimeEqualHex('aa00', 'aa01'), false);
  assert.equal(constantTimeEqualHex('aa00', 'aa'), false);
});
