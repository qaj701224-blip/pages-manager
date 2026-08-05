import assert from 'node:assert/strict';
import test from 'node:test';

import worker from './index.js';
import {
  isLegacyApiRetiredRequest,
  legacyApiRetiredResponse,
  LEGACY_API_RETIRED_CODE,
  LEGACY_API_RETIRED_MESSAGE,
} from './retirement.js';

const EXPECTED_RETIRED_MESSAGE =
  '如果你使用 Cindy 客户端，请使用 xd-sites 插件；如果无法安装或找不到插件，请先更新 Cindy 客户端。' +
  '非 Cindy 客户端请使用 https://skills.xindong.com/skills/xd-cell 的 skill。';

function request(path, options = {}) {
  return new Request(`https://api.workers.xd.team${path}`, options);
}

test('only GET and HEAD /health escape the legacy retirement guard', () => {
  assert.equal(isLegacyApiRetiredRequest(request('/health')), false);
  assert.equal(isLegacyApiRetiredRequest(request('/health', { method: 'HEAD' })), false);
  assert.equal(isLegacyApiRetiredRequest(request('/health', { method: 'POST' })), true);
  assert.equal(isLegacyApiRetiredRequest(request('/deploy', { method: 'POST' })), true);
  assert.equal(isLegacyApiRetiredRequest(request('/unknown')), true);
});

test('health remains available without IP authorization', async () => {
  const response = await worker.fetch(request('/health', { headers: { 'CF-Connecting-IP': '203.0.113.10' } }), {
    IP_ALLOWLIST: '10.0.0.0/8',
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'ok' });
});

test('retired requests return before IP authorization and request parsing', async () => {
  const response = await worker.fetch(
    request('/deploy', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': '203.0.113.10' },
      body: 'not multipart',
    }),
    { IP_ALLOWLIST: '10.0.0.0/8' }
  );

  assert.equal(response.status, 410);
  assert.deepEqual(await response.json(), {
    error: 'LEGACY_API_RETIRED',
    message: EXPECTED_RETIRED_MESSAGE,
  });
});

test('non-exact health requests use the retirement response', async () => {
  for (const candidate of [
    request('/health', { method: 'POST' }),
    request('/health', { method: 'OPTIONS' }),
    request('/health/'),
  ]) {
    const response = await worker.fetch(candidate, {});
    assert.equal(response.status, 410);
  }
});

test('legacy retirement response uses the stable message-only protocol', async () => {
  const response = legacyApiRetiredResponse();
  assert.equal(response.status, 410);
  assert.equal(response.headers.get('Content-Type'), 'application/json');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), {
    error: 'LEGACY_API_RETIRED',
    message: EXPECTED_RETIRED_MESSAGE,
  });
  assert.equal(LEGACY_API_RETIRED_CODE, 'LEGACY_API_RETIRED');
  assert.equal(LEGACY_API_RETIRED_MESSAGE, EXPECTED_RETIRED_MESSAGE);
  assert.match(LEGACY_API_RETIRED_MESSAGE, /xd-sites/);
  assert.match(LEGACY_API_RETIRED_MESSAGE, /更新 Cindy/);
  assert.match(LEGACY_API_RETIRED_MESSAGE, /skills\.xindong\.com\/skills\/xd-cell/);
  assert.equal(LEGACY_API_RETIRED_MESSAGE.includes('hint'), false);
  assert.equal(LEGACY_API_RETIRED_MESSAGE.includes('migration'), false);
});
