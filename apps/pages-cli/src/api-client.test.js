import assert from 'node:assert/strict';
import test from 'node:test';

import { ApiError, createApiClient } from './api-client.js';

test('API client sends bearer credential and JSON body with idempotency key', async () => {
  const calls = [];
  const client = createApiClient({
    apiBaseUrl: 'https://api.pages.xd.team',
    authBaseUrl: 'https://auth.pages.xd.team',
    credential: { type: 'cli_token', value: 'cli_secret' },
    fetch: async (request) => {
      calls.push(request);
      return Response.json({ ok: true });
    },
  });

  assert.deepEqual(
    await client.requestApi('POST', '/.xd-pages/api/deployments', { siteId: 'site_1' }, { idempotencyKey: 'idem_1' }),
    { ok: true }
  );

  const request = calls[0];
  assert.equal(request.url, 'https://api.pages.xd.team/.xd-pages/api/deployments');
  assert.equal(request.method, 'POST');
  assert.equal(request.headers.get('Authorization'), 'Bearer cli_secret');
  assert.equal(request.headers.get('Idempotency-Key'), 'idem_1');
  assert.equal(request.headers.get('Content-Type'), 'application/json');
  assert.deepEqual(await request.json(), { siteId: 'site_1' });
});

test('API client sends bearer credential and multipart body without JSON content type', async () => {
  const calls = [];
  const client = createApiClient({
    apiBaseUrl: 'https://api.pages.xd.team',
    authBaseUrl: 'https://auth.pages.xd.team',
    credential: { type: 'cli_token', value: 'cli_secret' },
    fetch: async (request) => {
      calls.push(request);
      return Response.json({ ok: true });
    },
  });
  const form = new FormData();
  form.set('siteSlug', 'docs');
  form.set('file-0', new Blob(['hello'], { type: 'text/plain' }), 'index.txt');

  assert.deepEqual(
    await client.requestApiForm('POST', '/.xd-pages/api/deployments', form, { idempotencyKey: 'idem_form' }),
    { ok: true }
  );

  const request = calls[0];
  assert.equal(request.url, 'https://api.pages.xd.team/.xd-pages/api/deployments');
  assert.equal(request.headers.get('Authorization'), 'Bearer cli_secret');
  assert.equal(request.headers.get('Idempotency-Key'), 'idem_form');
  assert.match(request.headers.get('Content-Type'), /^multipart\/form-data; boundary=/);
  const received = await request.formData();
  assert.equal(received.get('siteSlug'), 'docs');
  assert.equal(await received.get('file-0').text(), 'hello');
});

test('API client calls auth base without bearer for login endpoints', async () => {
  const calls = [];
  const client = createApiClient({
    apiBaseUrl: 'https://api.pages.xd.team',
    authBaseUrl: 'https://auth.pages.xd.team',
    fetch: async (request) => {
      calls.push(request);
      return Response.json({ status: 'pending' });
    },
  });

  assert.deepEqual(await client.requestAuth('POST', '/.xd-pages/cli/login/poll', { loginId: 'cli_1' }), {
    status: 'pending',
  });
  assert.equal(calls[0].url, 'https://auth.pages.xd.team/.xd-pages/cli/login/poll');
  assert.equal(calls[0].headers.has('Authorization'), false);
});

test('API client turns safe error envelopes into ApiError', async () => {
  const client = createApiClient({
    apiBaseUrl: 'https://api.pages.xd.team',
    authBaseUrl: 'https://auth.pages.xd.team',
    credential: { type: 'access_key', value: 'xdpak_production_ak_1_secret' },
    fetch: async () =>
      Response.json(
        {
          error: {
            code: 'SITE_NOT_FOUND',
            message: 'Site not found.',
            action: 'Check the site id.',
            reason: 'oauth_state_invalid_or_expired',
            step: 'oauth.state',
            requestId: 'req_test_cli',
            retryable: false,
            details: {
              httpStatus: 502,
              providerEndpointType: 'sso_profile',
            },
          },
        },
        { status: 404 }
      ),
  });

  await assert.rejects(
    () => client.requestApi('GET', '/.xd-pages/api/sites/site_1'),
    (error) => {
      assert.equal(error instanceof ApiError, true);
      assert.equal(error.status, 404);
      assert.equal(error.code, 'SITE_NOT_FOUND');
      assert.equal(error.action, 'Check the site id.');
      assert.equal(error.reason, 'oauth_state_invalid_or_expired');
      assert.equal(error.step, 'oauth.state');
      assert.equal(error.requestId, 'req_test_cli');
      assert.equal(error.retryable, false);
      assert.deepEqual(error.details, {
        httpStatus: 502,
        providerEndpointType: 'sso_profile',
      });
      return true;
    }
  );
});

test('API client drops unsafe error diagnostic details from API envelopes', async () => {
  const client = createApiClient({
    apiBaseUrl: 'https://api.pages.xd.team',
    authBaseUrl: 'https://auth.pages.xd.team',
    credential: { type: 'access_key', value: 'xdpak_production_ak_1_secret' },
    fetch: async () =>
      Response.json(
        {
          error: {
            code: 'SSO_EXCHANGE_FAILED',
            message: 'SSO exchange failed.',
            details: {
              httpStatus: 502,
              providerEndpointType: 'sso_profile',
              redirectUri: 'https://demo.pages.xd.team/callback?token=secret',
              stateAgeBucket: 'expired',
              token: 'secret-token',
            },
          },
        },
        { status: 502 }
      ),
  });

  await assert.rejects(
    () => client.requestApi('GET', '/.xd-pages/api/sites/site_1'),
    (error) => {
      assert.equal(error instanceof ApiError, true);
      assert.deepEqual(error.details, {
        httpStatus: 502,
        providerEndpointType: 'sso_profile',
      });
      return true;
    }
  );
});

test('API client drops non-allowlisted diagnostic reason and step from API envelopes', async () => {
  const client = createApiClient({
    apiBaseUrl: 'https://api.pages.xd.team',
    authBaseUrl: 'https://auth.pages.xd.team',
    credential: { type: 'access_key', value: 'xdpak_production_ak_1_secret' },
    fetch: async () =>
      Response.json(
        {
          error: {
            code: 'SSO_EXCHANGE_FAILED',
            message: 'SSO exchange failed.',
            reason: 'https://sso.example.test/oauth/error?token=secret',
            step: 'sso.profile.parse',
            requestId: 'req_test_cli',
          },
        },
        { status: 502 }
      ),
  });

  await assert.rejects(
    () => client.requestApi('GET', '/.xd-pages/api/sites/site_1'),
    (error) => {
      assert.equal(error instanceof ApiError, true);
      assert.equal(error.reason, undefined);
      assert.equal(error.step, undefined);
      assert.equal(error.requestId, 'req_test_cli');
      return true;
    }
  );
});

test('API client drops unsafe request ids from API envelopes', async () => {
  const client = createApiClient({
    apiBaseUrl: 'https://api.pages.xd.team',
    authBaseUrl: 'https://auth.pages.xd.team',
    credential: { type: 'access_key', value: 'xdpak_production_ak_1_secret' },
    fetch: async () =>
      Response.json(
        {
          error: {
            code: 'OAUTH_STATE_INVALID',
            message: 'OAuth state is invalid.',
            requestId: 'req_bad\nrequest',
          },
        },
        { status: 400 }
      ),
  });

  await assert.rejects(
    () => client.requestApi('GET', '/.xd-pages/api/sites/site_1'),
    (error) => {
      assert.equal(error instanceof ApiError, true);
      assert.equal(error.requestId, undefined);
      return true;
    }
  );
});

test('API client explains non-JSON responses with HTTP context', async () => {
  const client = createApiClient({
    apiBaseUrl: 'https://api.pages.xd.team',
    authBaseUrl: 'https://auth.pages.xd.team',
    fetch: async () =>
      new Response('<!doctype html><title>not found</title>', {
        status: 404,
        statusText: 'Not Found',
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      }),
  });

  await assert.rejects(
    () => client.requestAuth('POST', '/.xd-pages/cli/login/start'),
    (error) => {
      assert.equal(error instanceof ApiError, true);
      assert.equal(error.status, 404);
      assert.equal(error.code, 'INVALID_JSON_RESPONSE');
      assert.match(error.message, /HTTP 404/);
      assert.match(error.message, /text\/html/);
      assert.match(error.action, /服务地址和网络访问/);
      assert.doesNotMatch(error.action, /xd-cell env|--env/);
      return true;
    }
  );
});
