import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

import { parseAllowedOrigins, postExecutorCallback, readCallbackPayload, validateCallbackUrl } from './post-executor-callback.js';

const tempDirs = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop(), { recursive: true, force: true });
  }
});

test('readCallbackPayload reads JSON file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pages-callback-'));
  tempDirs.push(dir);
  const file = join(dir, 'payload.json');
  writeFileSync(file, JSON.stringify({ publishingJobId: 'job_123' }));

  assert.deepEqual(await readCallbackPayload(file), { publishingJobId: 'job_123' });
});

test('postExecutorCallback skips when callback URL is not configured', async () => {
  const result = await postExecutorCallback({ publishingJobId: 'job_123' }, { callbackUrl: '' });

  assert.deepEqual(result, { skipped: true, reason: 'PAGES_CALLBACK_URL is not set' });
});

test('postExecutorCallback posts JSON with optional callback token', async () => {
  const result = await postExecutorCallback(
    { publishingJobId: 'job_123', stageResult: 'index_ready' },
    {
      callbackUrl: 'https://gateway.test/internal/executor-callback',
      callbackToken: 'callback-secret',
      allowedOrigins: 'https://gateway.test',
      async fetchImpl(url, request) {
        assert.equal(url, 'https://gateway.test/internal/executor-callback');
        assert.equal(request.method, 'POST');
        assert.equal(request.headers['X-Pages-Callback-Token'], 'callback-secret');
        assert.deepEqual(JSON.parse(request.body), {
          publishingJobId: 'job_123',
          stageResult: 'index_ready',
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }
  );

  assert.deepEqual(result, { skipped: false, status: 200, body: { ok: true }, attempts: 1 });
});

test('parseAllowedOrigins normalizes comma and whitespace separated origins', () => {
  assert.deepEqual(parseAllowedOrigins('https://gateway.test/path, https://other.test\nhttps://third.test'), [
    'https://gateway.test',
    'https://other.test',
    'https://third.test',
  ]);
});

test('validateCallbackUrl rejects unsafe callback targets before token use', () => {
  assert.equal(
    validateCallbackUrl('https://gateway.test/internal/executor-callback', {
      allowedOrigins: 'https://gateway.test',
      hasToken: true,
    }),
    'https://gateway.test/internal/executor-callback'
  );

  assert.equal(
    validateCallbackUrl('https://gateway.test/publisher-test/internal/executor-callback', {
      allowedOrigins: 'https://gateway.test',
      hasToken: true,
    }),
    'https://gateway.test/publisher-test/internal/executor-callback'
  );

  assert.throws(
    () =>
      validateCallbackUrl('https://attacker.test/internal/executor-callback', {
        allowedOrigins: 'https://gateway.test',
        hasToken: true,
      }),
    /origin is not allowed/
  );

  assert.throws(
    () =>
      validateCallbackUrl('http://gateway.test/internal/executor-callback', {
        allowedOrigins: 'http://gateway.test',
        hasToken: true,
      }),
    /must use https/
  );

  assert.throws(
    () =>
      validateCallbackUrl('https://gateway.test/other', {
        allowedOrigins: 'https://gateway.test',
        hasToken: true,
      }),
    /must point to/
  );

  assert.throws(
    () =>
      validateCallbackUrl('https://gateway.test/internal/executor-callback', {
        allowedOrigins: '',
        hasToken: true,
      }),
    /ALLOWED_ORIGINS is required/
  );
});

test('postExecutorCallback rejects gateway failures', async () => {
  await assert.rejects(
    () =>
      postExecutorCallback(
        { publishingJobId: 'job_123' },
        {
          callbackUrl: 'https://gateway.test/internal/executor-callback',
          allowedOrigins: 'https://gateway.test',
          async fetchImpl() {
            return new Response(JSON.stringify({ error: 'bad callback' }), { status: 400 });
          },
        }
      ),
    /bad callback/
  );
});

test('postExecutorCallback retries transient network failures', async () => {
  let calls = 0;
  const sleeps = [];
  const result = await postExecutorCallback(
    { publishingJobId: 'job_123' },
    {
      callbackUrl: 'https://gateway.test/internal/executor-callback',
      allowedOrigins: 'https://gateway.test',
      maxAttempts: 3,
      retryDelayMs: 5,
      sleep(delay) {
        sleeps.push(delay);
        return Promise.resolve();
      },
      async fetchImpl() {
        calls += 1;
        if (calls < 3) throw new Error('fetch failed');
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }
  );

  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [5, 10]);
  assert.deepEqual(result, { skipped: false, status: 200, body: { ok: true }, attempts: 3 });
});

test('postExecutorCallback retries transient HTTP failures but rejects deterministic failures', async () => {
  let retryableCalls = 0;
  const result = await postExecutorCallback(
    { publishingJobId: 'job_123' },
    {
      callbackUrl: 'https://gateway.test/internal/executor-callback',
      allowedOrigins: 'https://gateway.test',
      maxAttempts: 2,
      retryDelayMs: 0,
      async fetchImpl() {
        retryableCalls += 1;
        if (retryableCalls === 1) {
          return new Response(JSON.stringify({ error: 'temporary' }), { status: 502 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      },
    }
  );

  assert.equal(retryableCalls, 2);
  assert.equal(result.attempts, 2);

  let deterministicCalls = 0;
  await assert.rejects(
    () =>
      postExecutorCallback(
        { publishingJobId: 'job_123' },
        {
          callbackUrl: 'https://gateway.test/internal/executor-callback',
          allowedOrigins: 'https://gateway.test',
          maxAttempts: 3,
          retryDelayMs: 0,
          async fetchImpl() {
            deterministicCalls += 1;
            return new Response(JSON.stringify({ error: 'bad callback' }), { status: 400 });
          },
        }
      ),
    /bad callback/
  );
  assert.equal(deterministicCalls, 1);
});
