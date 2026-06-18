import assert from 'node:assert/strict';
import test from 'node:test';

import { browserPageResponse } from './browser-pages.js';

test('browser page drops unsafe action href protocols', async () => {
  const response = browserPageResponse({
    title: 'Test page',
    message: 'Action should not be rendered for unsafe protocols.',
    actionHref: 'javascript:alert(1)',
    actionLabel: 'Run action',
  });

  const text = await response.text();
  assert.equal(text.includes('href="javascript:alert(1)"'), false);
  assert.equal(text.includes('Run action'), false);
});
