import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTokenCopyFeedback } from './token-copy-model.js';

const messages = {
  copyToken: '复制 Token',
  tokenCopied: '已复制',
  tokenCopyFailed: '复制失败',
};

test('token copy feedback shows success after clipboard write succeeds', () => {
  assert.deepEqual(buildTokenCopyFeedback('copied', (key) => messages[key]), {
    label: '已复制',
    className: 'token-copy-feedback success',
    ariaLive: 'polite',
  });
});

test('token copy feedback keeps default label before copy', () => {
  assert.deepEqual(buildTokenCopyFeedback('idle', (key) => messages[key]), {
    label: '复制 Token',
    className: 'token-copy-feedback',
    ariaLive: 'polite',
  });
});

test('token copy feedback shows failure when clipboard write fails', () => {
  assert.deepEqual(buildTokenCopyFeedback('failed', (key) => messages[key]), {
    label: '复制失败',
    className: 'token-copy-feedback error',
    ariaLive: 'assertive',
  });
});
