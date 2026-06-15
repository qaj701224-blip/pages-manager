import assert from 'node:assert/strict';
import test from 'node:test';

import { jsonError, readJsonBody, redactUrl, safeRedirect } from './http.js';

test('jsonError returns no-store JSON error envelope', async () => {
  const response = jsonError('BAD_REQUEST', 'Request is invalid.', 400, 'Retry with valid JSON.');

  assert.equal(response.status, 400);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(await response.json(), {
    error: {
      code: 'BAD_REQUEST',
      message: 'Request is invalid.',
      action: 'Retry with valid JSON.',
    },
  });
});

test('readJsonBody accepts bounded JSON request bodies', async () => {
  const request = new Request('https://auth.pages.xd.team/.xd-pages/cli/login/poll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ loginId: 'cli_123' }),
  });

  assert.deepEqual(await readJsonBody(request, { maxBytes: 128 }), { loginId: 'cli_123' });
});

test('readJsonBody rejects non-JSON, invalid JSON, and oversized bodies without echoing input', async () => {
  await assert.rejects(
    () =>
      readJsonBody(
        new Request('https://auth.pages.xd.team/.xd-pages/cli/login/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: 'secret-body',
        })
      ),
    /JSON content type is required/
  );

  await assert.rejects(
    () =>
      readJsonBody(
        new Request('https://auth.pages.xd.team/.xd-pages/cli/login/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: '{"secret":',
        })
      ),
    (error) => error.message === 'Invalid JSON body'
  );

  await assert.rejects(
    () =>
      readJsonBody(
        new Request('https://auth.pages.xd.team/.xd-pages/cli/login/poll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: 'should-not-appear' }),
        }),
        { maxBytes: 8 }
      ),
    (error) => error.message === 'JSON body is too large'
  );
});

test('safeRedirect only accepts absolute http URLs without credentials or fragments', () => {
  const response = safeRedirect('https://demo.pages.xd.team/app?x=1', 303);

  assert.equal(response.status, 303);
  assert.equal(response.headers.get('Location'), 'https://demo.pages.xd.team/app?x=1');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer');

  assert.throws(() => safeRedirect('/relative'), /redirect/i);
  assert.throws(() => safeRedirect('https://user:pass@demo.pages.xd.team/'), /redirect/i);
  assert.throws(() => safeRedirect('https://demo.pages.xd.team/#access_token=secret'), /redirect/i);
  assert.throws(() => safeRedirect('javascript:alert(1)'), /redirect/i);
});

test('redactUrl removes sensitive query values without leaking their content', () => {
  const redacted = redactUrl(
    'https://auth.pages.xd.team/.xd-pages/auth/callback?code=secret-code&state=secret-state&access_token=secret-token&client_secret=secret-client&login_secret=secret-login&token=secret-jwt&ok=1'
  );

  assert.equal(
    redacted,
    'https://auth.pages.xd.team/.xd-pages/auth/callback?code=%5BREDACTED%5D&state=%5BREDACTED%5D&access_token=%5BREDACTED%5D&client_secret=%5BREDACTED%5D&login_secret=%5BREDACTED%5D&token=%5BREDACTED%5D&ok=1'
  );
  for (const value of ['secret-code', 'secret-state', 'secret-token', 'secret-client', 'secret-login', 'secret-jwt']) {
    assert.equal(redacted.includes(value), false);
  }
});
