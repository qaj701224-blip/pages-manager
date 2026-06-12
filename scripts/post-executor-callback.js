#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function readCallbackPayload(path) {
  if (!path) {
    throw new Error('payload file path is required');
  }

  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

export async function postExecutorCallback(payload, options = {}) {
  const callbackUrl = Object.hasOwn(options, 'callbackUrl')
    ? options.callbackUrl
    : process.env.PAGES_CALLBACK_URL || payload.callbackUrl;
  if (!callbackUrl) {
    return { skipped: true, reason: 'PAGES_CALLBACK_URL is not set' };
  }

  const token = options.callbackToken || process.env.PAGES_CALLBACK_TOKEN || '';
  const headers = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['X-Pages-Callback-Token'] = token;
  }

  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(callbackUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => null);

  if (!response.ok) {
    const message = body?.error || response.statusText || `HTTP ${response.status}`;
    throw new Error(`Executor callback failed: ${message}`);
  }

  return { skipped: false, status: response.status, body };
}

async function main(argv) {
  const payload = await readCallbackPayload(argv[2]);
  const result = await postExecutorCallback(payload);
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv).catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
