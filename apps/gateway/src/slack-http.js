import { jsonResponse } from '@xd/worker-kit';

function bytesToHex(bytes) {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function timingSafeEqualString(a, b) {
  const left = new globalThis.TextEncoder().encode(a);
  const right = new globalThis.TextEncoder().encode(b);
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let i = 0; i < left.length; i += 1) {
    diff |= left[i] ^ right[i];
  }
  return diff === 0;
}

function unauthorized(message) {
  const error = new Error(message);
  error.status = 401;
  return error;
}

function parseJsonText(text) {
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    const error = new Error('Invalid JSON body');
    error.status = 400;
    throw error;
  }
}

function timestampSkewSeconds(env = {}) {
  const configured = Number(env.SLACK_SIGNATURE_MAX_SKEW_SECONDS);
  return Number.isFinite(configured) && configured > 0 ? configured : 300;
}

function flagFromEnv(value) {
  if (value === undefined || value === null || value === '') return null;
  if (['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())) return false;
  return null;
}

function shouldRequireSlackSignature(env = {}) {
  const configured = flagFromEnv(env.SLACK_SIGNATURE_REQUIRED);
  if (configured !== null) return configured;
  return env.NODE_ENV === 'production' || env.SLACK_EVENTS_PROCESSING_MODE === 'async';
}

export async function verifySlackSignature(request, env = {}, rawBody = '') {
  if (!env.SLACK_SIGNING_SECRET) {
    if (shouldRequireSlackSignature(env)) {
      throw unauthorized('Slack signing secret is not configured');
    }
    return { verified: false, reason: 'signing_secret_not_configured' };
  }

  const timestamp = request.headers.get('X-Slack-Request-Timestamp') || '';
  const signature = request.headers.get('X-Slack-Signature') || '';
  if (!timestamp || !signature.startsWith('v0=')) {
    throw unauthorized('Missing Slack signature');
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    throw unauthorized('Invalid Slack timestamp');
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSeconds - timestampSeconds) > timestampSkewSeconds(env)) {
    throw unauthorized('Stale Slack timestamp');
  }

  const key = await crypto.subtle.importKey(
    'raw',
    new globalThis.TextEncoder().encode(env.SLACK_SIGNING_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const base = `v0:${timestamp}:${rawBody}`;
  const digest = await crypto.subtle.sign('HMAC', key, new globalThis.TextEncoder().encode(base));
  const expected = `v0=${bytesToHex(digest)}`;

  if (!timingSafeEqualString(signature, expected)) {
    throw unauthorized('Invalid Slack signature');
  }

  return { verified: true };
}

export async function readSlackRequest(request, env = {}) {
  const rawBody = await request.text();
  await verifySlackSignature(request, env, rawBody);

  const contentType = request.headers.get('Content-Type') || '';
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const form = new URLSearchParams(rawBody);
    const payload = form.get('payload');
    if (!payload) {
      const error = new Error('Missing Slack interaction payload');
      error.status = 400;
      throw error;
    }
    return {
      rawBody,
      body: parseJsonText(payload),
      contentType: 'form',
    };
  }

  return {
    rawBody,
    body: parseJsonText(rawBody),
    contentType: 'json',
  };
}

export function slackChallengeResponse(body = {}) {
  return new Response(String(body.challenge || ''), {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
}

export function slackAckResponse(body = { ok: true }) {
  return jsonResponse(body);
}
