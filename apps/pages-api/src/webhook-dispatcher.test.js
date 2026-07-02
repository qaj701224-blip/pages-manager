import assert from 'node:assert/strict';
import test from 'node:test';

import { assertSafeWebhookUrl, dispatchWebhook, nextRetryAt } from './webhook-dispatcher.js';

test('safe webhook URL validation rejects non-https and private targets', async () => {
  await assert.rejects(
    () => assertSafeWebhookUrl('http://example.com/hook', { resolveHost: publicResolver }),
    /WEBHOOK_URL_PROTOCOL_INVALID/
  );
  await assert.rejects(
    () => assertSafeWebhookUrl('https://localhost/hook', { resolveHost: publicResolver }),
    /WEBHOOK_URL_HOST_FORBIDDEN/
  );
  await assert.rejects(
    () => assertSafeWebhookUrl('https://127.0.0.1/hook', { resolveHost: publicResolver }),
    /WEBHOOK_URL_HOST_FORBIDDEN/
  );
  await assert.rejects(
    () => assertSafeWebhookUrl('https://10.2.3.4/hook', { resolveHost: publicResolver }),
    /WEBHOOK_URL_HOST_FORBIDDEN/
  );
  await assert.rejects(
    () => assertSafeWebhookUrl('https://service.internal.example/hook', { resolveHost: async () => ['172.16.0.9'] }),
    /WEBHOOK_URL_HOST_FORBIDDEN/
  );
  await assert.rejects(
    () => assertSafeWebhookUrl('https://metadata.google.internal/hook', { resolveHost: async () => ['169.254.169.254'] }),
    /WEBHOOK_URL_HOST_FORBIDDEN/
  );
  await assert.rejects(
    () => assertSafeWebhookUrl('https://[::1]/hook', { resolveHost: publicResolver }),
    /WEBHOOK_URL_HOST_FORBIDDEN/
  );
  await assert.rejects(
    () => assertSafeWebhookUrl('https://[fe80::1]/hook', { resolveHost: publicResolver }),
    /WEBHOOK_URL_HOST_FORBIDDEN/
  );
  await assert.rejects(
    () => assertSafeWebhookUrl('https://[fd00::1]/hook', { resolveHost: publicResolver }),
    /WEBHOOK_URL_HOST_FORBIDDEN/
  );
  await assert.rejects(
    () => assertSafeWebhookUrl('https://[::ffff:127.0.0.1]/hook', { resolveHost: publicResolver }),
    /WEBHOOK_URL_HOST_FORBIDDEN/
  );
  await assert.rejects(
    () => assertSafeWebhookUrl('https://[::ffff:7f00:1]/hook', { resolveHost: publicResolver }),
    /WEBHOOK_URL_HOST_FORBIDDEN/
  );
  await assert.rejects(
    () => assertSafeWebhookUrl('https://public.example/hook', { resolveHost: async () => ['::ffff:7f00:1'] }),
    /WEBHOOK_URL_HOST_FORBIDDEN/
  );
  await assert.rejects(
    () => assertSafeWebhookUrl('https://[::7f00:1]/hook', { resolveHost: publicResolver }),
    /WEBHOOK_URL_HOST_FORBIDDEN/
  );
  await assert.rejects(
    () => assertSafeWebhookUrl('https://public.example/hook', { resolveHost: async () => ['::7f00:1'] }),
    /WEBHOOK_URL_HOST_FORBIDDEN/
  );

  await assert.doesNotReject(() =>
    assertSafeWebhookUrl('https://hooks.slack.com/services/T/B/C', { resolveHost: publicResolver })
  );
});

test('dispatchWebhook posts JSON with XD Cell headers and manual redirect mode', async () => {
  let capturedRequest;
  const result = await dispatchWebhook({
    url: 'https://hooks.slack.com/services/T/B/C',
    eventType: 'site.deployed',
    deliveryId: 'whd_1',
    payload: { text: 'ok' },
    now: () => '2026-07-01T00:00:00.000Z',
    resolveHost: publicResolver,
    fetchImpl: async (request) => {
      capturedRequest = request;
      return new Response('ok', { status: 200 });
    },
  });

  assert.deepEqual(result, {
    deliveryStatus: 'succeeded',
    httpStatus: 200,
    errorCode: null,
  });
  assert.equal(capturedRequest.method, 'POST');
  assert.equal(capturedRequest.redirect, 'manual');
  assert.equal(capturedRequest.headers.get('Content-Type'), 'application/json');
  assert.equal(capturedRequest.headers.get('X-XD-Cell-Event'), 'site.deployed');
  assert.equal(capturedRequest.headers.get('X-XD-Cell-Delivery'), 'whd_1');
  assert.equal(capturedRequest.headers.get('X-XD-Cell-Timestamp'), '2026-07-01T00:00:00.000Z');
  assert.deepEqual(await capturedRequest.json(), { text: 'ok' });
});

test('dispatchWebhook treats redirects as failed deliveries without following them', async () => {
  const result = await dispatchWebhook({
    url: 'https://hooks.slack.com/services/T/B/C',
    eventType: 'site.deployed',
    deliveryId: 'whd_1',
    payload: { text: 'ok' },
    now: () => '2026-07-01T00:00:00.000Z',
    resolveHost: publicResolver,
    fetchImpl: async (request) => {
      assert.equal(request.redirect, 'manual');
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://127.0.0.1/hook' },
      });
    },
  });

  assert.deepEqual(result, {
    deliveryStatus: 'failed',
    httpStatus: 302,
    errorCode: 'WEBHOOK_REDIRECT_FORBIDDEN',
  });
});

test('nextRetryAt uses finite exponential retry schedule', () => {
  const now = new Date('2026-07-01T00:00:00.000Z');

  assert.equal(nextRetryAt(0, now), '2026-07-01T00:01:00.000Z');
  assert.equal(nextRetryAt(1, now), '2026-07-01T00:05:00.000Z');
  assert.equal(nextRetryAt(4, now), '2026-07-01T01:00:00.000Z');
  assert.equal(nextRetryAt(5, now), null);
});

async function publicResolver() {
  return ['8.8.8.8'];
}
