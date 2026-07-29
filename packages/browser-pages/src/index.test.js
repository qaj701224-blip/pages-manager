import assert from 'node:assert/strict';
import test from 'node:test';

import { browserPageResponse, siteErrorResponse, wantsHtml } from './index.js';

test('wantsHtml follows the Accept negotiation matrix', () => {
  const request = (accept) => new Request('https://demo.pages.xd.team/', { headers: accept ? { Accept: accept } : {} });
  assert.equal(wantsHtml(request('text/html')), true);
  assert.equal(wantsHtml(request('text/html,application/json')), true);
  assert.equal(wantsHtml(request('application/json')), false);
  assert.equal(wantsHtml(request('')), false);
});

test('escapes page text and allows only HTTP(S) action hrefs', async () => {
  const response = browserPageResponse({
    title: '<Title>',
    message: `<script>"'&`,
    actionHref: 'javascript:alert(1)',
    actionLabel: '<Action>',
  });
  const text = await response.text();
  assert.equal(text.includes('<Title>'), false);
  assert.equal(text.includes('&lt;Title&gt;'), true);
  assert.equal(text.includes('&lt;script&gt;&quot;&#39;&amp;'), true);
  assert.equal(text.includes('javascript:alert(1)'), false);
});

test('siteErrorResponse uses the registry fallback and preserves JSON shape', async () => {
  const response = siteErrorResponse(new Request('https://demo.pages.xd.team/'), 'UNKNOWN_CODE');
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), {
    error: { code: 'UNKNOWN_CODE', message: 'Site could not be opened.' },
  });
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('siteErrorResponse renders HTML with status detail and safe hostname action', async () => {
  const response = siteErrorResponse(
    new Request('https://demo.pages.xd.team/', { headers: { Accept: 'text/html' } }),
    'SITE_ACCESS_FORBIDDEN',
    { hostname: 'demo.pages.xd.team' }
  );
  assert.equal(response.status, 403);
  const text = await response.text();
  assert.match(text, /状态详情：SITE_ACCESS_FORBIDDEN/);
  assert.match(text, /href="https:\/\/demo\.pages\.xd\.team\/"/);
  assert.match(text, /你暂时没有访问权限/);
});

test('siteErrorResponse resolves status and JSON message from the registry', async () => {
  const response = siteErrorResponse(new Request('https://demo.pages.xd.team/'), 'SITE_SESSION_STALE');
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: { code: 'SITE_SESSION_STALE', message: 'Site access denied.' },
  });
});
