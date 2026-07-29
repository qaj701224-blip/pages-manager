const DEFAULT_ISSUER = 'pages-auth';
const ALGORITHM = 'HS256';
const CLOCK_SKEW_SECONDS = 0;
const encoder = new globalThis.TextEncoder();

const ALLOWED_PURPOSES = new Set([
  'auth_session',
  'site_session',
  'console_session',
  'cli_token',
  'cli_login_confirm',
  'internal_worker_jwt',
]);
const SAFE_JTI_RE = /^[A-Za-z0-9_-]{1,128}$/;
const RESERVED_CLAIMS = new Set(['iss', 'aud', 'env', 'purpose', 'sub', 'iat', 'nbf', 'exp']);

export function parseKeyRegistry(env) {
  const registry = String(env?.PAGES_SESSION_JWT_KEYS || '').trim();
  if (!registry) throw new Error('Session JWT key registry is required');

  const keys = new Map();
  for (const entry of registry.split(',')) {
    const normalizedEntry = entry.trim();
    if (!normalizedEntry) throw new Error('Malformed session JWT key registry entry');

    const parts = normalizedEntry.split(':');
    if (parts.length !== 3) throw new Error('Malformed session JWT key registry entry');

    const [kid, alg, secretEnvName] = parts.map((part) => part.trim());
    if (!kid || !alg || !secretEnvName) throw new Error('Malformed session JWT key registry entry');
    if (keys.has(kid)) throw new Error(`Duplicate session JWT key registry entry for kid ${kid}`);
    if (alg !== ALGORITHM) throw new Error(`Unsupported session JWT algorithm ${alg}`);

    if (!Object.hasOwn(env, secretEnvName)) throw new Error(`Missing session JWT secret for kid ${kid}`);

    const secret = env[secretEnvName];
    if (typeof secret !== 'string' || secret === '') {
      throw new Error(`Session JWT secret for kid ${kid} must be a non-empty string`);
    }
    keys.set(kid, { kid, alg, secret, secretEnvName });
  }

  return keys;
}

export async function signSessionJwt({ purpose, audience, subject, now, ttlSeconds, claims = {} }, env) {
  const activeKid = String(env?.PAGES_SESSION_JWT_ACTIVE_KID || '').trim();
  if (!activeKid) throw new Error('Session JWT active kid is required');

  const keys = parseKeyRegistry(env);
  const key = keys.get(activeKid);
  if (!key) throw new Error(`Session JWT active kid ${activeKid} is not present in key registry`);

  const issuedAt = validateUnixTime(now, 'now');
  const ttl = validateTtl(ttlSeconds);
  const environment = validateEnvironment(env?.PAGES_ENV);
  const tokenPurpose = validatePurpose(purpose);
  validateRequiredString(audience, 'audience');
  validateRequiredString(subject, 'subject');
  const extraClaims = sanitizeExtraClaims(claims);

  const header = { alg: ALGORITHM, typ: 'JWT', kid: activeKid };
  const payload = {
    iss: readIssuer(env),
    aud: audience,
    env: environment,
    purpose: tokenPurpose,
    sub: subject,
    iat: issuedAt,
    nbf: issuedAt,
    exp: issuedAt + ttl,
    ...extraClaims,
  };
  validateJtiForPurpose(payload);

  const encodedHeader = base64UrlEncodeJson(header);
  const encodedPayload = base64UrlEncodeJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await signHs256(signingInput, key.secret);

  return `${signingInput}.${signature}`;
}

export async function verifySessionJwt(token, env, { purpose, audience, now } = {}) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts.some((part) => !part)) throw new Error('Malformed JWT');

  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = decodeJson(encodedHeader, 'header');
  if (header.alg !== ALGORITHM) throw new Error(`Unsupported JWT algorithm ${header.alg}`);
  validateRequiredString(header.kid, 'kid');

  const keys = parseKeyRegistry(env);
  const key = keys.get(header.kid);
  if (!key) throw new Error(`Unknown session JWT kid ${header.kid}`);

  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signatureIsValid = await verifyHs256(signingInput, encodedSignature, key.secret);
  if (!signatureIsValid) throw new Error('JWT signature verification failed');

  const payload = decodeJson(encodedPayload, 'payload');
  const environment = validateEnvironment(env?.PAGES_ENV);
  const checkedAt = validateUnixTime(now, 'now');
  const expectedPurpose = validatePurpose(purpose);

  if (payload.iss !== readIssuer(env)) throw new Error('JWT issuer mismatch');
  if (payload.aud !== audience) throw new Error('JWT audience mismatch');
  if (payload.env !== environment) throw new Error('JWT environment mismatch');
  validatePurpose(payload.purpose);
  if (payload.purpose !== expectedPurpose) throw new Error('JWT purpose mismatch');
  validateRequiredString(payload.sub, 'sub');
  validateNumericClaim(payload.iat, 'iat');
  validateNumericClaim(payload.nbf, 'nbf');
  validateNumericClaim(payload.exp, 'exp');
  validateJtiForPurpose(payload);

  if (payload.iat > checkedAt + CLOCK_SKEW_SECONDS) throw new Error('JWT iat is in the future');
  if (payload.nbf > checkedAt + CLOCK_SKEW_SECONDS) throw new Error('JWT nbf is in the future');
  if (payload.exp <= checkedAt - CLOCK_SKEW_SECONDS) throw new Error('JWT expired');

  return payload;
}

async function signHs256(signingInput, secret) {
  const key = await importHmacKey(secret, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(signingInput));
  return base64UrlEncodeBytes(new Uint8Array(signature));
}

async function verifyHs256(signingInput, encodedSignature, secret) {
  const key = await importHmacKey(secret, ['verify']);
  const signature = base64UrlDecodeBytes(encodedSignature);
  return crypto.subtle.verify('HMAC', key, signature, encoder.encode(signingInput));
}

async function importHmacKey(secret, usages) {
  return crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, usages);
}

function validateEnvironment(environment) {
  if (environment !== 'production' && environment !== 'staging' && environment !== 'local') {
    throw new Error('Unsupported Pages environment');
  }
  return environment;
}

function readIssuer(env) {
  const issuer = String(env?.PAGES_SESSION_JWT_ISSUER || DEFAULT_ISSUER).trim();
  if (!issuer) throw new Error('Session JWT issuer is required');
  return issuer;
}

function validateUnixTime(value, label) {
  if (!Number.isInteger(value) || value < 0) throw new Error(`JWT ${label} must be a unix timestamp`);
  return value;
}

function validateTtl(value) {
  if (!Number.isInteger(value) || value <= 0) throw new Error('JWT ttlSeconds must be a positive integer');
  return value;
}

function validateNumericClaim(value, label) {
  if (!Number.isInteger(value)) throw new Error(`JWT ${label} claim must be an integer`);
}

function validateRequiredString(value, label) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`JWT ${label} is required`);
}

function validatePurpose(value) {
  validateRequiredString(value, 'purpose');
  if (!ALLOWED_PURPOSES.has(value)) throw new Error(`JWT purpose ${value} is unsupported`);
  return value;
}

function validateJtiForPurpose(payload) {
  if (payload.purpose === 'cli_token' || Object.hasOwn(payload, 'jti')) {
    validateJwtId(payload.jti);
  }
}

function validateJwtId(value) {
  if (typeof value !== 'string' || !SAFE_JTI_RE.test(value)) {
    throw new Error('JWT jti must be a safe non-empty string');
  }
}

function sanitizeExtraClaims(claims) {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims) || Object.getPrototypeOf(claims) !== Object.prototype) {
    throw new Error('JWT claims must be a plain object');
  }

  const sanitizedClaims = {};
  for (const [claim, value] of Object.entries(claims)) {
    if (claim === 'toJSON') throw new Error('JWT claim toJSON is not allowed');
    if (RESERVED_CLAIMS.has(claim)) throw new Error(`JWT claim ${claim} is reserved`);
    if (typeof value === 'function') throw new Error(`JWT claim ${claim} must not be a function`);
    sanitizedClaims[claim] = value;
  }

  return sanitizedClaims;
}

function base64UrlEncodeJson(value) {
  return base64UrlEncodeBytes(encoder.encode(JSON.stringify(value)));
}

function decodeJson(encoded, label) {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlDecodeBytes(encoded)));
  } catch (error) {
    throw new Error(`Malformed JWT ${label}: ${error.message}`);
  }
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecodeBytes(value) {
  if (!/^[A-Za-z0-9_-]*$/.test(value)) throw new Error('Malformed base64url value');

  const padded = value
    .replace(/-/g, '+')
    .replace(/_/g, '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
