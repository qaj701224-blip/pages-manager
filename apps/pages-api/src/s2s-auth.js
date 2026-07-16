const encoder = new globalThis.TextEncoder();
const decoder = new globalThis.TextDecoder();
const MAX_BODY_BYTES = 16 * 1024;
const TIMESTAMP_SKEW_SECONDS = 300;
const RATE_LIMIT = 1200;
const RATE_WINDOW_SECONDS = 10 * 60;
const NONCE_TTL_SECONDS = 610;

export async function buildS2SCanonicalInput(input = {}) {
  const {
    environment,
    clientId,
    keyId,
    method,
    pathname,
    timestamp,
    nonce,
    rawBody = '',
  } = input;
  const bodyBytes = toBytes(rawBody);
  const bodyHash = await sha256Hex(bodyBytes);
  const normalizedPathname = String(pathname || '').split('?')[0] || '/';
  return [
    'xd-cell-s2s-v1',
    String(environment ?? ''),
    String(clientId ?? ''),
    String(keyId ?? ''),
    String(method ?? '').toUpperCase(),
    normalizedPathname,
    String(timestamp ?? ''),
    String(nonce ?? ''),
    bodyHash,
  ].join('\n');
}

export async function createS2SSignature(input = {}, maybeCanonicalInput) {
  const options = typeof input === 'string' ? { secret: input, canonicalInput: maybeCanonicalInput } : input;
  const secret = options?.secret;
  if (typeof secret !== 'string' || secret.length === 0) throw new Error('S2S secret is required');
  const canonicalInput =
    typeof options.canonicalInput === 'string'
      ? options.canonicalInput
      : typeof options.canonical === 'string'
        ? options.canonical
        : await buildS2SCanonicalInput(options);
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(canonicalInput));
  return toBase64Url(new Uint8Array(signature));
}

export async function authenticateS2SRequest(input = {}, maybeOptions) {
  const options = normalizeAuthOptions(input, maybeOptions);
  const { request, env, environment, store } = options;
  if (!request || !request.headers) return failure('S2S_REQUEST_INVALID');

  const headers = readHeaders(request.headers);
  if ([headers.clientId, headers.keyId, headers.timestamp, headers.nonce, headers.signature].some((value) => !value)) {
    return failure('S2S_AUTH_REQUIRED');
  }

  const url = safeUrl(request.url);
  if (!url || request.method !== 'POST' || url.search || !isJsonContentType(headers.contentType)) {
    return failure('S2S_REQUEST_INVALID');
  }
  if (!/^nonce_[A-Za-z0-9_-]{8,128}$/.test(headers.nonce)) return failure('S2S_REQUEST_INVALID');

  const registration = resolveClientRegistration(env, headers.clientId, headers.keyId);
  const authContext = registration ? { clientId: headers.clientId, keyId: headers.keyId } : {};

  const now = normalizeNowSeconds(options.nowSeconds);
  if (!Number.isSafeInteger(now)) return failure('S2S_TIMESTAMP_INVALID', authContext);
  const timestamp = parseTimestamp(headers.timestamp);
  if (timestamp === null || Math.abs(timestamp - now) > TIMESTAMP_SKEW_SECONDS) {
    return failure('S2S_TIMESTAMP_INVALID', authContext);
  }

  const key = resolveClientKey(env, registration);
  if (!key) return failure('S2S_CLIENT_INVALID', authContext);

  let bodyBytes;
  try {
    bodyBytes = new Uint8Array(await request.arrayBuffer());
  } catch {
    return failure('S2S_REQUEST_INVALID', authContext);
  }
  if (bodyBytes.byteLength > MAX_BODY_BYTES) return failure('S2S_REQUEST_INVALID', authContext);
  const rawBody = decoder.decode(bodyBytes);

  const canonicalInput = await buildS2SCanonicalInput({
    environment,
    clientId: headers.clientId,
    keyId: headers.keyId,
    method: request.method,
    pathname: url.pathname,
    timestamp,
    nonce: headers.nonce,
    rawBody: bodyBytes,
  });
  const expectedSignature = await createS2SSignature({ secret: key.secret, canonicalInput });
  if (!constantTimeEqual(expectedSignature, headers.signature)) return failure('S2S_SIGNATURE_INVALID', authContext);
  const verifiedAuthContext = { ...authContext, signatureVerified: true };

  const receivedAt = new Date(now * 1000).toISOString();
  const nonceReserved = await store.reserveS2SNonce({
    environment,
    clientId: headers.clientId,
    nonce: headers.nonce,
    endpoint: url.pathname,
    receivedAt,
    expiresAt: new Date((now + NONCE_TTL_SECONDS) * 1000).toISOString(),
  });
  if (!nonceReserved) return failure('S2S_REPLAY_DETECTED', verifiedAuthContext);

  const bucketSeconds = Math.floor(now / RATE_WINDOW_SECONDS) * RATE_WINDOW_SECONDS;
  const rate = await store.consumeS2SRateLimit({
    environment,
    scope: 'client',
    subject: headers.clientId,
    bucketStart: new Date(bucketSeconds * 1000).toISOString(),
    expiresAt: new Date((bucketSeconds + RATE_WINDOW_SECONDS) * 1000).toISOString(),
    limit: RATE_LIMIT,
  });
  if (!rate?.allowed) return failure('S2S_RATE_LIMITED', { ...verifiedAuthContext, retryAfter: RATE_WINDOW_SECONDS });

  return {
    ok: true,
    clientId: headers.clientId,
    keyId: headers.keyId,
    timestamp,
    nonce: headers.nonce,
    rawBody,
  };
}

function normalizeAuthOptions(input, maybeOptions) {
  if (input && typeof input === 'object' && 'request' in input) return input;
  return { ...(maybeOptions || {}), request: input };
}

function readHeaders(headers) {
  return {
    clientId: headers.get('X-XD-Cell-S2S-Client')?.trim() || '',
    keyId: headers.get('X-XD-Cell-S2S-Key-Id')?.trim() || '',
    timestamp: headers.get('X-XD-Cell-S2S-Timestamp')?.trim() || '',
    nonce: headers.get('X-XD-Cell-S2S-Nonce')?.trim() || '',
    signature: headers.get('X-XD-Cell-S2S-Signature')?.trim() || '',
    contentType: headers.get('Content-Type') || '',
  };
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function isJsonContentType(value) {
  return /^application\/json\s*(?:;|$)/i.test(value);
}

function parseTimestamp(value) {
  if (!/^\d{1,16}$/.test(value)) return null;
  const timestamp = Number(value);
  return Number.isSafeInteger(timestamp) ? timestamp : null;
}

function normalizeNowSeconds(value) {
  if (value === undefined || value === null) return Math.floor(Date.now() / 1000);
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? Math.floor(number) : NaN;
}

function resolveClientRegistration(env, clientId, keyId) {
  const entries = parseClientKeyRegistry(env?.S2S_CLIENT_KEYS);
  if (!entries) return null;
  return entries.find((candidate) => candidate.clientId === clientId && candidate.keyId === keyId) || null;
}

function resolveClientKey(env, registration) {
  if (!registration) return null;
  const secret = env?.[registration.secretEnvName];
  if (typeof secret !== 'string' || secret.length === 0) return null;
  return { ...registration, secret };
}

function parseClientKeyRegistry(value) {
  if (typeof value !== 'string' || value.trim() === '') return null;
  const seen = new Set();
  const counts = new Map();
  const entries = [];
  for (const rawEntry of value.split(',')) {
    const parts = rawEntry.trim().split(':');
    if (parts.length !== 3 || parts.some((part) => part === '')) return null;
    const [clientId, keyId, secretEnvName] = parts;
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(clientId) || !/^[A-Za-z0-9._-]{1,128}$/.test(keyId)) return null;
    if (!/^S2S_SECRET_[A-Z0-9_]+$/.test(secretEnvName)) return null;
    const identity = `${clientId}\u0000${keyId}`;
    if (seen.has(identity)) return null;
    seen.add(identity);
    const count = (counts.get(clientId) || 0) + 1;
    if (count > 2) return null;
    counts.set(clientId, count);
    entries.push({ clientId, keyId, secretEnvName });
  }
  return entries.length ? entries : null;
}

function failure(code, extra = {}) {
  const details = {
    S2S_AUTH_REQUIRED: ['S2S authentication is required.', 'Provide all required XD Cell S2S headers.', 401],
    S2S_CLIENT_INVALID: ['S2S client is invalid.', 'Check the S2S client registration.', 401],
    S2S_TIMESTAMP_INVALID: ['S2S timestamp is invalid.', 'Synchronize the client clock and retry.', 401],
    S2S_SIGNATURE_INVALID: ['S2S signature is invalid.', 'Recompute the S2S signature and retry.', 401],
    S2S_REQUEST_INVALID: ['S2S request is invalid.', 'Send a POST application/json request with a valid nonce and body.', 400],
    S2S_REPLAY_DETECTED: ['S2S request has already been received.', 'Generate a new nonce and retry.', 409],
    S2S_RATE_LIMITED: ['S2S rate limit exceeded.', 'Wait before retrying.', 429],
  }[code];
  const [message, action, status] = details || ['S2S request rejected.', 'Check the request and retry.', 400];
  return { ok: false, code, status, message, action, ...extra };
}

function constantTimeEqual(left, right) {
  const leftBytes = encoder.encode(String(left));
  const rightBytes = encoder.encode(String(right));
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index += 1) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}

function toBytes(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return encoder.encode(String(value ?? ''));
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function toBase64Url(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return globalThis.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
