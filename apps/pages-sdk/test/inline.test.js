import assert from 'node:assert/strict';
import test from 'node:test';

import { PAGES_RUNTIME_SOURCE } from '../dist/internal/runtime-source.js';

test('PAGES_RUNTIME_SOURCE is self-contained runtime source text', () => {
  assert.equal(typeof PAGES_RUNTIME_SOURCE, 'string');
  assert.match(PAGES_RUNTIME_SOURCE, /handlePagesRuntimeRequest/);
  assert.doesNotMatch(PAGES_RUNTIME_SOURCE, /from\s+['"]@xd\//);
  assert.doesNotMatch(PAGES_RUNTIME_SOURCE, /import\(['"]@xd\//);
});
