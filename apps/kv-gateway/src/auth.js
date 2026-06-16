import { isValidSiteSlug, isValidSiteUuid } from '@xd/pages-runtime-protocol';

const JWT_ISSUER = 'pages-v2';
const JWT_AUDIENCE = 'pages-kv-gateway';
const MAX_IAT_FUTURE_SKEW_SECONDS = 60;
const MAX_CAPABILITY_TTL_SECONDS = 60;

const encoder = new globalThis.TextEncoder();
const decoder = new globalThis.TextDecoder();

export function parseKeyRegistry(env) {
  if (!env?.PAGES_CAP_JWT_KEYS) throw new Error('Capability key registry is missing');

  const registry = new Map();
  const entries = String(env.PAGES_CAP_JWT_KEYS)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const parts = entry.split(':').map((part) => part.trim());
    if (parts.length !== 3 || parts.some((part) => part === '')) {
      throw new Error('Malformed capability key registry entry');
    }

    const [kid, alg, secretEnvName] = parts;
    if (alg !== 'HS256') throw new Error(`Unsupported capability key alg: ${alg}`);
    if (registry.has(kid)) throw new Error(`Duplicate capability key kid: ${kid}`);

    const secret = env[secretEnvName];
    if (typeof secret !== 'string' || secret === '') {
      throw new Error(`Missing capability secret env var: ${secretEnvName}`);
    }

    registry.set(kid, { alg, secret });
  }

  if (registry.size === 0) throw new Error('Capability key registry is empty');
  return registry;
}

export async function createHs256Jwt({ kid, secret, payload, header = {} }) {
  const jwtHeader = { typ: 'JWT', alg: 'HS256', kid, ...header };
  const encodedHeader = base64UrlEncodeJson(jwtHeader);
  const encodedPayload = base64UrlEncodeJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await signHs256(secret, signingInput);

  return `${signingInput}.${base64UrlEncodeBytes(signature)}`;
}

export async function verifyCapability(authorization, env, { requiredScope, now = Math.floor(Date.now() / 1000) } = {}) {
  if (typeof authorization !== 'string' || !authorization.startsWith('Bearer ')) {
    throw new Error('Capability invalid: missing bearer authorization');
  }

  const token = authorization.slice('Bearer '.length).trim();
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((part) => part === '')) {
    throw new Error('Capability invalid: malformed JWT');
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parseJwtJson(encodedHeader, 'header');
  const payload = parseJwtJson(encodedPayload, 'payload');

  const registry = parseKeyRegistry(env);
  const key = registry.get(header.kid);
  if (!key) throw new Error('Capability invalid: unknown kid');
  if (header.alg !== key.alg) throw new Error('Capability invalid: alg mismatch');
  if (key.alg !== 'HS256') throw new Error('Capability invalid: unsupported alg');

  const expectedSignature = await signHs256(key.secret, `${encodedHeader}.${encodedPayload}`);
  const actualSignature = base64UrlDecodeBytes(encodedSignature);
  if (!constantTimeEqual(expectedSignature, actualSignature)) {
    throw new Error('Capability invalid: invalid signature');
  }

  validateClaims(payload, env, requiredScope, now);
  return payload;
}

function validateClaims(claims, env, requiredScope, now) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new Error('Capability invalid: invalid claims');
  }

  if (claims.iss !== JWT_ISSUER) throw new Error('Capability invalid: invalid issuer');
  if (claims.aud !== JWT_AUDIENCE) throw new Error('Capability invalid: invalid audience');
  const expectedEnv = env.PAGES_ENV ?? env.XD_PAGES_ENV;
  if (!expectedEnv || claims.env !== expectedEnv) throw new Error('Capability invalid: environment mismatch');
  if (!isValidSiteSlug(claims.siteId)) throw new Error('Capability invalid: invalid site id');
  if (!isValidSiteUuid(claims.siteUuid)) throw new Error('Capability invalid: invalid site UUID');

  if (!Array.isArray(claims.scope) || !claims.scope.includes(requiredScope)) {
    throw new Error('Capability scope denied: missing required scope');
  }

  if (typeof claims.nbf !== 'number' || !Number.isFinite(claims.nbf) || claims.nbf > now) {
    throw new Error('Capability invalid: nbf is not active');
  }

  if (
    typeof claims.iat !== 'number' ||
    !Number.isFinite(claims.iat) ||
    claims.iat > now + MAX_IAT_FUTURE_SKEW_SECONDS
  ) {
    throw new Error('Capability invalid: iat is in the future');
  }

  if (typeof claims.exp !== 'number' || !Number.isFinite(claims.exp) || claims.exp <= now) {
    throw new Error('Capability invalid: exp is expired');
  }

  if (claims.exp - claims.iat > MAX_CAPABILITY_TTL_SECONDS) {
    throw new Error('Capability invalid: exp exceeds max ttl');
  }
}

async function signHs256(secret, signingInput) {
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));
  return new Uint8Array(signature);
}

function parseJwtJson(value, label) {
  try {
    return JSON.parse(decoder.decode(base64UrlDecodeBytes(value)));
  } catch {
    throw new Error(`Capability invalid: invalid JWT ${label}`);
  }
}

function base64UrlEncodeJson(value) {
  return base64UrlEncodeBytes(encoder.encode(JSON.stringify(value)));
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }

  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeBytes(value) {
  if (typeof value !== 'string' || /[^A-Za-z0-9_-]/.test(value)) {
    throw new Error('Capability invalid: malformed base64url');
  }

  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  return bytes;
}

function constantTimeEqual(expected, actual) {
  if (expected.byteLength !== actual.byteLength) return false;

  let diff = 0;
  for (let index = 0; index < expected.byteLength; index += 1) {
    diff |= expected[index] ^ actual[index];
  }

  return diff === 0;
}
