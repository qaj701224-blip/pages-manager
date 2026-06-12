import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { afterEach } from 'node:test';

import { postExecutorCallback, readCallbackPayload } from './post-executor-callback.js';

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

  assert.deepEqual(result, { skipped: false, status: 200, body: { ok: true } });
});

test('postExecutorCallback rejects gateway failures', async () => {
  await assert.rejects(
    () =>
      postExecutorCallback(
        { publishingJobId: 'job_123' },
        {
          callbackUrl: 'https://gateway.test/internal/executor-callback',
          async fetchImpl() {
            return new Response(JSON.stringify({ error: 'bad callback' }), { status: 400 });
          },
        }
      ),
    /bad callback/
  );
});
