import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import worker from './index.js';
import { createTestPagesStore } from './test-store.js';

test('health returns pages-api service and environment', async () => {
  const response = await worker.fetch(new Request('https://api.pages.xd.team/.xd-pages/health'), {
    PAGES_ENV: 'production',
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(await response.json(), {
    status: 'ok',
    service: 'pages-api',
    environment: 'production',
  });
});

test('health rejects legacy token headers', async () => {
  const response = await worker.fetch(
    new Request('https://api.pages.xd.team/.xd-pages/health', {
      headers: { 'X-Pages-Token': 'legacy' },
    }),
    {
      PAGES_ENV: 'production',
    }
  );

  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, 'LEGACY_TOKEN_UNSUPPORTED');
});

test('invalid environment fails closed', async () => {
  const response = await worker.fetch(new Request('https://api.pages.xd.team/.xd-pages/health'), {
    PAGES_ENV: 'preview',
  });

  assert.equal(response.status, 500);
  const body = await response.json();
  assert.equal(body.error.code, 'API_ENV_INVALID');
  assert.equal(body.error.action, 'Check the pages-api Worker environment configuration.');
});

test('unknown endpoints return safe JSON errors', async () => {
  const response = await worker.fetch(new Request('https://api.pages.xd.team/.xd-pages/api/missing'), {
    PAGES_ENV: 'production',
  });

  assert.equal(response.status, 404);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const body = await response.json();
  assert.equal(body.error.code, 'NOT_FOUND');
  assert.match(body.error.action, /Check the endpoint/);
});

test('internal user upsert is only callable through internal service host', async () => {
  const store = createTestPagesStore({
    now: () => '2026-06-15T00:00:00.000Z',
  });
  const publicResponse = await worker.fetch(
    jsonRequest('https://api.pages.xd.team/.xd-pages/internal/users/upsert', {
      user: { id: 'usr_1', ssoSubject: 'usr_1', email: 'user@example.com', employeeStatus: 'active' },
      now: 1_800_000_000,
    }),
    { PAGES_ENV: 'production', PAGES_STORE: store }
  );
  const internalResponse = await worker.fetch(
    jsonRequest('https://pages-api.internal/.xd-pages/internal/users/upsert', {
      user: { id: 'usr_1', ssoSubject: 'usr_1', email: 'USER@example.com', employeeStatus: 'active', sessionVersion: 2 },
      now: 1_800_000_000,
    }),
    { PAGES_ENV: 'production', PAGES_STORE: store }
  );

  assert.equal(publicResponse.status, 404);
  assert.equal((await publicResponse.json()).error.code, 'NOT_FOUND');
  assert.equal(internalResponse.status, 200, await internalResponse.clone().text());
  assert.equal((await store.getUser('usr_1')).email, 'user@example.com');
  assert.equal((await store.getUser('usr_1')).sessionVersion, 2);
});

test('wrangler template includes required WFP vars without runtime token placeholders', async () => {
  const template = await readFile(new URL('../wrangler.template.toml', import.meta.url), 'utf8');

  assert.match(template, /WFP_DISPATCH_NAMESPACE = "__WFP_DISPATCH_NAMESPACE__"/);
  assert.match(template, /WFP_COMPATIBILITY_DATE = "__WFP_COMPATIBILITY_DATE__"/);
  assert.doesNotMatch(template, /CF_API_TOKEN|CF_ACCOUNT_ID/);
});

function jsonRequest(url, body) {
  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
