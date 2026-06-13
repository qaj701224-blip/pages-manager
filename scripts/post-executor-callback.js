#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export function parseAllowedOrigins(value = '') {
  return String(value)
    .split(/[,\s]+/)
    .map((origin) => origin.trim())
    .filter(Boolean)
    .map((origin) => new URL(origin).origin);
}

export function validateCallbackUrl(callbackUrl, options = {}) {
  const url = new URL(callbackUrl);
  const allowedOrigins = parseAllowedOrigins(
    Object.hasOwn(options, 'allowedOrigins') ? options.allowedOrigins : process.env.PAGES_CALLBACK_ALLOWED_ORIGINS || ''
  );
  const hasToken = Boolean(options.hasToken);

  if (url.protocol !== 'https:') {
    throw new Error('PAGES_CALLBACK_URL must use https');
  }

  if (hasToken && allowedOrigins.length === 0) {
    throw new Error('PAGES_CALLBACK_ALLOWED_ORIGINS is required when PAGES_CALLBACK_TOKEN is configured');
  }

  if (allowedOrigins.length > 0 && !allowedOrigins.includes(url.origin)) {
    throw new Error(`PAGES_CALLBACK_URL origin is not allowed: ${url.origin}`);
  }

  if (url.pathname !== '/internal/executor-callback') {
    throw new Error('PAGES_CALLBACK_URL must point to /internal/executor-callback');
  }

  return url.toString();
}

export async function readCallbackPayload(path) {
  if (!path) {
    throw new Error('payload file path is required');
  }

  const raw = await readFile(path, 'utf8');
  return JSON.parse(raw);
}

function retryConfig(options = {}) {
  const attempts = Number(
    Object.hasOwn(options, 'maxAttempts') ? options.maxAttempts : process.env.PAGES_CALLBACK_MAX_ATTEMPTS || 4
  );
  const delayMs = Number(
    Object.hasOwn(options, 'retryDelayMs') ? options.retryDelayMs : process.env.PAGES_CALLBACK_RETRY_DELAY_MS || 1000
  );

  return {
    maxAttempts: Number.isFinite(attempts) && attempts > 0 ? Math.floor(attempts) : 4,
    retryDelayMs: Number.isFinite(delayMs) && delayMs >= 0 ? Math.floor(delayMs) : 1000,
  };
}

function isRetryableStatus(status) {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

async function wait(ms, options = {}) {
  if (ms <= 0) return;
  const sleep = options.sleep || ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  await sleep(ms);
}

export async function postExecutorCallback(payload, options = {}) {
  const callbackUrl = Object.hasOwn(options, 'callbackUrl')
    ? options.callbackUrl
    : process.env.PAGES_CALLBACK_URL || payload.callbackUrl;
  if (!callbackUrl) {
    return { skipped: true, reason: 'PAGES_CALLBACK_URL is not set' };
  }

  const token = options.callbackToken || process.env.PAGES_CALLBACK_TOKEN || '';
  const safeCallbackUrl = validateCallbackUrl(callbackUrl, {
    allowedOrigins: Object.hasOwn(options, 'allowedOrigins')
      ? options.allowedOrigins
      : process.env.PAGES_CALLBACK_ALLOWED_ORIGINS || '',
    hasToken: Boolean(token),
  });
  const headers = {
    'Content-Type': 'application/json',
  };

  if (token) {
    headers['X-Pages-Callback-Token'] = token;
  }

  const fetchImpl = options.fetchImpl || fetch;
  const { maxAttempts, retryDelayMs } = retryConfig(options);
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let response;
    let body;

    try {
      response = await fetchImpl(safeCallbackUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      body = await response.json().catch(() => null);
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await wait(retryDelayMs * attempt, options);
        continue;
      }
      throw new Error(`Executor callback failed: ${err.message}`);
    }

    if (response.ok) {
      return { skipped: false, status: response.status, body, attempts: attempt };
    }

    const message = body?.error || response.statusText || `HTTP ${response.status}`;
    lastError = new Error(message);
    if (isRetryableStatus(response.status) && attempt < maxAttempts) {
      await wait(retryDelayMs * attempt, options);
      continue;
    }

    throw new Error(`Executor callback failed: ${message}`);
  }

  throw new Error(`Executor callback failed: ${lastError?.message || 'unknown error'}`);
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
