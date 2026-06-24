import assert from 'node:assert/strict';
import test from 'node:test';

import { jsonError, readJsonBody, redactUrl, safeRedirect, withRequestId } from './http.js';

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

test('jsonError only emits public diagnostic fields', async () => {
  const response = jsonError('OAUTH_STATE_INVALID', 'OAuth state is invalid.', 400, {
    action: 'Restart login.',
    reason: 'oauth_state_invalid_or_expired',
    step: 'oauth.state',
    requestId: 'req_test_public',
    retryable: false,
    details: {
      httpStatus: 502,
      providerEndpointType: 'sso_profile',
      stateAgeBucket: 'expired',
      loginId: 'cli_secret',
    },
    internalReason: 'already_consumed',
    internalStep: 'oauth.state.consume',
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'OAUTH_STATE_INVALID',
      message: 'OAuth state is invalid.',
      action: 'Restart login.',
      reason: 'oauth_state_invalid_or_expired',
      step: 'oauth.state',
      requestId: 'req_test_public',
      retryable: false,
      details: {
        httpStatus: 502,
        providerEndpointType: 'sso_profile',
      },
    },
  });
});

test('jsonError drops nested public diagnostic detail values', async () => {
  const response = jsonError('SSO_EXCHANGE_FAILED', 'SSO exchange failed.', 502, {
    action: { token: 'secret-action' },
    reason: ['sso_profile_unavailable'],
    step: { name: 'sso.profile' },
    requestId: { value: 'req_secret' },
    details: {
      httpStatus: { token: 'secret-token' },
      providerEndpointType: ['sso_profile'],
    },
  });

  assert.deepEqual(await response.json(), {
    error: {
      code: 'SSO_EXCHANGE_FAILED',
      message: 'SSO exchange failed.',
    },
  });
});

test('jsonError drops unsafe request ids', async () => {
  const response = jsonError('OAUTH_STATE_INVALID', 'OAuth state is invalid.', 400, {
    requestId: 'req_bad\nrequest',
  });

  assert.deepEqual(await response.json(), {
    error: {
      code: 'OAUTH_STATE_INVALID',
      message: 'OAuth state is invalid.',
      reason: 'oauth_state_invalid_or_expired',
      step: 'oauth.state',
    },
  });
});

test('jsonError validates public diagnostic detail value domains', async () => {
  const response = jsonError('SSO_EXCHANGE_FAILED', 'SSO exchange failed.', 502, {
    details: {
      httpStatus: 700,
      providerEndpointType: 'https://sso.example.test/oauth/profile?access_token=secret',
    },
  });

  assert.deepEqual(await response.json(), {
    error: {
      code: 'SSO_EXCHANGE_FAILED',
      message: 'SSO exchange failed.',
      reason: 'sso_token_unavailable',
      step: 'sso.token',
    },
  });
});

test('jsonError keeps allowlisted public diagnostic detail values', async () => {
  const response = jsonError('SSO_EXCHANGE_FAILED', 'SSO exchange failed.', 502, {
    details: {
      httpStatus: 502,
      providerEndpointType: 'sso_profile',
    },
  });

  assert.deepEqual(await response.json(), {
    error: {
      code: 'SSO_EXCHANGE_FAILED',
      message: 'SSO exchange failed.',
      reason: 'sso_token_unavailable',
      step: 'sso.token',
      details: {
        httpStatus: 502,
        providerEndpointType: 'sso_profile',
      },
    },
  });
});

test('jsonError only emits allowlisted public reason and step values', async () => {
  const response = jsonError('SSO_EXCHANGE_FAILED', 'SSO exchange failed.', 502, {
    reason: 'https://sso.example.test/oauth/error?error_description=secret-provider-description',
    step: 'sso.profile.parse',
  });

  assert.deepEqual(await response.json(), {
    error: {
      code: 'SSO_EXCHANGE_FAILED',
      message: 'SSO exchange failed.',
    },
  });

  const publicResponse = jsonError('OAUTH_STATE_INVALID', 'OAuth state is invalid.', 400, {
    reason: 'oauth_state_invalid_or_expired',
    step: 'oauth.state',
  });

  assert.deepEqual(await publicResponse.json(), {
    error: {
      code: 'OAUTH_STATE_INVALID',
      message: 'OAuth state is invalid.',
      reason: 'oauth_state_invalid_or_expired',
      step: 'oauth.state',
    },
  });
});

test('withRequestId keeps JSON error body and headers aligned to the server request id', async () => {
  const response = await withRequestId(
    new Response(
      JSON.stringify({
        error: {
          code: 'BAD_REQUEST',
          message: 'Request is invalid.',
          requestId: 'attacker-request',
        },
      }),
      {
        status: 400,
        statusText: 'Bad Request',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Content-Length': '99',
          'Cache-Control': 'no-store',
        },
      }
    ),
    'req_test_server'
  );

  assert.equal(response.status, 400);
  assert.equal(response.statusText, 'Bad Request');
  assert.equal(response.headers.get('X-Request-Id'), 'req_test_server');
  assert.equal(response.headers.has('Content-Length'), false);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'BAD_REQUEST',
      message: 'Request is invalid.',
      requestId: 'req_test_server',
    },
  });
});

test('withRequestId rejects unsafe request ids', async () => {
  const response = await withRequestId(
    new Response(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'Request is invalid.' } }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
      },
    }),
    'req_bad\nrequest'
  );

  assert.equal(response.headers.has('X-Request-Id'), false);
  assert.deepEqual(await response.json(), {
    error: {
      code: 'BAD_REQUEST',
      message: 'Request is invalid.',
    },
  });
});

test('withRequestId handles immutable response headers', async () => {
  const response = await withRequestId(await fetch('data:text/plain,ok'), 'req_test_server');

  assert.equal(response.status, 200);
  assert.equal(response.statusText, 'OK');
  assert.equal(response.headers.get('X-Request-Id'), 'req_test_server');
  assert.equal(await response.text(), 'ok');
});

test('withRequestId does not rewrite non-error JSON response bodies', async () => {
  const body = '{\n  "status": "error-like"\n}';
  const response = await withRequestId(
    new Response(body, {
      status: 400,
      statusText: 'Bad Request',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': String(body.length),
      },
    }),
    'req_test_server'
  );

  assert.equal(response.statusText, 'Bad Request');
  assert.equal(response.headers.get('Content-Length'), String(body.length));
  assert.equal(await response.text(), body);
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
  const url = new URL('https://auth.pages.xd.team/.xd-pages/auth/callback');
  url.search = new URLSearchParams({
    code: 'secret-code',
    state: 'secret-state',
    access_token: 'secret-token',
    client_secret: 'secret-client',
    login_secret: 'secret-login',
    token: 'secret-jwt',
    ok: '1',
  }).toString();
  const redacted = redactUrl(url);

  assert.equal(redacted, 'https://auth.pages.xd.team/.xd-pages/auth/callback');
  for (const value of ['secret-code', 'secret-state', 'secret-token', 'secret-client', 'secret-login', 'secret-jwt']) {
    assert.equal(redacted.includes(value), false);
  }
  assert.equal(redacted.includes('ok=1'), false);
});

test('redactUrl removes auth transaction query values without leaking their content', () => {
  const sensitiveParams = {
    refresh_token: 'secret-refresh',
    id_token: 'secret-id',
    code_verifier: 'secret-verifier',
    nonce: 'secret-nonce',
    loginSecret: 'secret-login-camel',
    deviceCode: 'secret-device-camel',
    device_code: 'secret-device-snake',
    confirmToken: 'secret-confirm-camel',
    confirm_token: 'secret-confirm-snake',
    csrfToken: 'secret-csrf-camel',
    csrf_token: 'secret-csrf-snake',
    loginId: 'secret-login-id-camel',
    login_id: 'secret-login-id-snake',
    cli_login_id: 'secret-cli-login-id',
    stateId: 'secret-state-id-camel',
    state_id: 'secret-state-id-snake',
    sid: 'secret-session-id',
    jti: 'secret-jwt-id',
    redirect_uri: 'https://service.example/callback?token=secret-nested',
    return_to: 'https://service.example/return?code=secret-nested-code',
    error: 'secret-provider-error',
    error_description: 'secret-provider-description',
    error_uri: 'https://provider.example/error?debug=secret-provider-debug',
  };
  const url = new URL('https://auth.pages.xd.team/.xd-pages/auth/callback');
  url.search = new URLSearchParams({ ...sensitiveParams, ok: '1' }).toString();

  const redacted = redactUrl(url);

  assert.equal(redacted, 'https://auth.pages.xd.team/.xd-pages/auth/callback');
  for (const value of Object.values(sensitiveParams)) {
    assert.equal(redacted.includes(value), false);
  }
  assert.equal(redacted.includes('ok=1'), false);
});

test('redactUrl removes sensitive query values case-insensitively', () => {
  const url = new URL('https://auth.pages.xd.team/.xd-pages/auth/callback');
  url.search = new URLSearchParams({
    Code: 'secret-code',
    ACCESS_TOKEN: 'secret-token',
    LoginSecret: 'secret-login',
    DeviceCode: 'secret-device',
    CONFIRM_TOKEN: 'secret-confirm',
    Redirect_URI: 'https://service.example/callback?token=secret-nested',
    ok: '1',
  }).toString();

  const redacted = redactUrl(url);

  assert.equal(redacted, 'https://auth.pages.xd.team/.xd-pages/auth/callback');
  for (const value of [
    'secret-code',
    'secret-token',
    'secret-login',
    'secret-device',
    'secret-confirm',
    'secret-nested',
  ]) {
    assert.equal(redacted.includes(value), false);
  }
  assert.equal(redacted.includes('ok=1'), false);
});

test('redactUrl removes camelCase OAuth token query aliases without leaking their content', () => {
  const sensitiveParams = {
    accessToken: 'secret-access-camel',
    refreshToken: 'secret-refresh-camel',
    idToken: 'secret-id-camel',
    codeVerifier: 'secret-verifier-camel',
    clientSecret: 'secret-client-camel',
  };
  const url = new URL('https://auth.pages.xd.team/.xd-pages/auth/callback');
  url.search = new URLSearchParams({ ...sensitiveParams, ok: '1' }).toString();

  const redacted = redactUrl(url);

  assert.equal(redacted, 'https://auth.pages.xd.team/.xd-pages/auth/callback');
  for (const value of Object.values(sensitiveParams)) {
    assert.equal(redacted.includes(value), false);
  }
  assert.equal(redacted.includes('ok=1'), false);
});

test('redactUrl removes camelCase redirect and provider error query aliases without leaking their content', () => {
  const sensitiveParams = {
    redirectUri: 'https://service.example/callback?token=secret-nested',
    returnTo: 'https://service.example/return?code=secret-nested-code',
    errorDescription: 'secret-provider-description',
    errorUri: 'https://provider.example/error?debug=secret-provider-debug',
  };
  const url = new URL('https://auth.pages.xd.team/.xd-pages/auth/callback');
  url.search = new URLSearchParams({ ...sensitiveParams, ok: '1' }).toString();

  const redacted = redactUrl(url);

  assert.equal(redacted, 'https://auth.pages.xd.team/.xd-pages/auth/callback');
  for (const value of Object.values(sensitiveParams)) {
    assert.equal(redacted.includes(value), false);
  }
  assert.equal(redacted.includes('ok=1'), false);
});

test('redactUrl drops unknown query keys and fragments', () => {
  const redacted = redactUrl('https://auth.pages.xd.team/callback?debug_secret=value&ok=1#access_token=secret');

  assert.equal(redacted, 'https://auth.pages.xd.team/callback');
  assert.equal(redacted.includes('debug_secret'), false);
  assert.equal(redacted.includes('access_token'), false);
});
