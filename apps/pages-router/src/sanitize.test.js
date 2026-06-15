import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeRequestForUserWorker, sanitizeUserWorkerResponse } from './sanitize.js';

test('strips platform request headers and platform cookies before dispatch', async () => {
  const request = new Request('https://demo.pages.xd.team/path', {
    headers: {
      Cookie: 'theme=dark; __Host-pages_site_session=secret; app=ok; __Secure-pages_capability=nope',
      'CF-Platform-Auth': 'fake',
      'X-Pages-Token': 'fake',
      'X-XD-Pages-Runtime': 'fake',
      Accept: 'text/html',
    },
  });

  const sanitized = sanitizeRequestForUserWorker(request, {
    'CF-Platform-Auth': 'internal.jwt',
    'CF-Platform-User': 'usr_123',
  });

  assert.equal(sanitized.headers.get('CF-Platform-Auth'), 'internal.jwt');
  assert.equal(sanitized.headers.get('CF-Platform-User'), 'usr_123');
  assert.equal(sanitized.headers.get('X-Pages-Token'), null);
  assert.equal(sanitized.headers.get('X-XD-Pages-Runtime'), null);
  assert.equal(sanitized.headers.get('Accept'), 'text/html');
  assert.equal(sanitized.headers.get('Cookie'), 'theme=dark; app=ok');
});

test('removes cookie header when only platform cookies were present', () => {
  const request = new Request('https://demo.pages.xd.team/path', {
    headers: {
      Cookie: '__Host-pages_site_session=secret; __Secure-pages_capability=nope',
    },
  });

  const sanitized = sanitizeRequestForUserWorker(request, {});

  assert.equal(sanitized.headers.get('Cookie'), null);
});

test('strips platform response headers and platform Set-Cookie values', async () => {
  const headers = new Headers({
    'CF-Platform-Trace-Id': 'fake',
    'X-Pages-Token': 'fake',
    'Content-Type': 'text/plain',
  });
  headers.append('Set-Cookie', '__Host-pages_site_session=evil; Path=/; Secure');
  headers.append('Set-Cookie', 'app=ok; Path=/; Secure');
  headers.append('Set-Cookie', 'bad=parent; Domain=.pages.xd.team; Path=/; Secure');
  headers.append('Set-Cookie', 'bad=apex; Domain=pages.xd.team; Path=/; Secure');

  const response = sanitizeUserWorkerResponse(new Response('ok', {
    status: 299,
    statusText: 'Router Sanitized',
    headers,
  }));

  assert.equal(response.headers.get('CF-Platform-Trace-Id'), null);
  assert.equal(response.headers.get('X-Pages-Token'), null);
  assert.equal(response.headers.get('Content-Type'), 'text/plain');
  assert.equal(response.status, 299);
  assert.equal(response.statusText, 'Router Sanitized');

  const setCookies = getSetCookies(response.headers);
  assert.deepEqual(setCookies, ['app=ok; Path=/; Secure']);
  assert.equal(await response.text(), 'ok');
});

function getSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') return headers.getSetCookie();
  const value = headers.get('Set-Cookie');
  return value ? [value] : [];
}
