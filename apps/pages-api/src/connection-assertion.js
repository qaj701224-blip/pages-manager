import { readConnectionAuthConfig } from './infrastructure/config/identity-config.js';

const encoder = new globalThis.TextEncoder();
const decoder = new globalThis.TextDecoder();

export { readConnectionAuthConfig };

const MAX_ASSERTION_LENGTH = 8192;
const MAX_JWKS_KEYS = 32;
const CLOCK_SKEW_SECONDS = 60;
// Contract TTL is 30 minutes; exp - iat is pure issuer arithmetic, so only a small
// rounding buffer is allowed before failing closed against issuer misconfiguration.
// A legitimate TTL change on the Cindy side is a coordinated contract change.
const MAX_ASSERTION_LIFETIME_SECONDS = 30 * 60 + 60;
const JWKS_REFETCH_COOLDOWN_MS = 30 * 1000;
// Positive-cache freshness bounds emergency revocation propagation: a kid removed from
// the JWKS stops being trusted at most one max-age later, without waiting for new-kid
// traffic or an isolate recycle.
const JWKS_CACHE_MAX_AGE_MS = 15 * 60 * 1000;
// When a stale-cache refresh fails, cached keys stay usable for at most one hour, then
// verification fails closed. This only covers a JWKS-only partial outage: a full
// auth-server outage stops assertion signing too, so traffic self-terminates within the
// 30-minute assertion TTL regardless.
const JWKS_STALE_GRACE_MS = 60 * 60 * 1000;
const JWKS_UNAVAILABLE = Symbol('connection-jwks-unavailable');

const defaultJwksCache = new Map();

export function createConnectionJwksCache() {
  return new Map();
}

export function isConnectionAssertionCandidate(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_ASSERTION_LENGTH) return false;
  const segments = token.split('.');
  return segments.length === 3 && segments.every((segment) => /^[A-Za-z0-9_-]+$/.test(segment));
}

export async function verifyConnectionAssertion(token, config, options = {}) {
  if (!config?.audience || !config.orgSlug || !Array.isArray(config.issuers) || config.issuers.length === 0) {
    return failure('config_invalid');
  }
  if (!isConnectionAssertionCandidate(token)) return failure('format_invalid');

  const nowSeconds = Number.isSafeInteger(options.nowSeconds) ? options.nowSeconds : Math.floor(Date.now() / 1000);
  const cache = options.cache || defaultJwksCache;
  const fetchFn = options.fetchFn || globalThis.fetch;

  const [headerSegment, payloadSegment, signatureSegment] = token.split('.');
  const header = decodeJsonSegment(headerSegment);
  const payload = decodeJsonSegment(payloadSegment);
  if (!header || !payload) return failure('segment_invalid');

  if (header.alg !== 'RS256') return failure('alg_rejected');
  if (typeof header.kid !== 'string' || header.kid === '' || header.kid.length > 128) return failure('kid_invalid');
  if (header.crit !== undefined) return failure('crit_rejected');

  // Trusted-issuer allowlist must pass before any key material is fetched.
  const issuer = payload.iss;
  if (typeof issuer !== 'string' || !config.issuers.includes(issuer)) return failure('iss_untrusted');

  if (payload.typ !== 'connection') return failure('typ_mismatch');
  if (!audienceMatches(payload.aud, config.audience)) return failure('aud_mismatch');
  if (payload.ctx !== 'org') return failure('ctx_mismatch');
  if (payload.orgSlug !== config.orgSlug) return failure('org_mismatch');
  if (!Number.isSafeInteger(payload.exp) || nowSeconds > payload.exp + CLOCK_SKEW_SECONDS) return failure('expired');
  if (!Number.isSafeInteger(payload.iat) || payload.iat > nowSeconds + CLOCK_SKEW_SECONDS) return failure('iat_invalid');
  if (payload.nbf !== undefined && (!Number.isSafeInteger(payload.nbf) || payload.nbf > nowSeconds + CLOCK_SKEW_SECONDS)) {
    return failure('nbf_invalid');
  }
  if (payload.exp - payload.iat <= 0 || payload.exp - payload.iat > MAX_ASSERTION_LIFETIME_SECONDS) {
    return failure('lifetime_invalid');
  }

  const membershipId = normalizeIdentifierClaim(payload.sub);
  const jti = normalizeIdentifierClaim(payload.jti);
  const email = normalizeEmailClaim(payload.email);
  if (!membershipId || !jti || !email) return failure('claims_invalid');

  const key = await resolveSigningKey({
    issuer,
    kid: header.kid,
    cache,
    fetchFn,
    nowMs: nowSeconds * 1000,
  });
  if (key === JWKS_UNAVAILABLE) return { ok: false, reason: 'jwks_unavailable', unavailable: true };
  if (!key) return failure('kid_unknown');

  const signature = decodeBase64UrlBytes(signatureSegment);
  if (!signature) return failure('segment_invalid');
  let valid = false;
  try {
    valid = await crypto.subtle.verify(
      { name: 'RSASSA-PKCS1-v1_5' },
      key,
      signature,
      encoder.encode(`${headerSegment}.${payloadSegment}`)
    );
  } catch {
    valid = false;
  }
  if (!valid) return failure('signature_invalid');

  return {
    ok: true,
    claims: {
      membershipId,
      email,
      orgSlug: payload.orgSlug,
      issuer,
      audience: config.audience,
      jti,
      issuedAt: new Date(payload.iat * 1000).toISOString(),
      expiresAt: new Date(payload.exp * 1000).toISOString(),
    },
  };
}

async function resolveSigningKey({ issuer, kid, cache, fetchFn, nowMs }) {
  let bucket = cache.get(issuer);
  if (!bucket) {
    bucket = { keys: new Map(), fetchedAtMs: null, lastFetchAtMs: null, lastFetchFailed: false };
    cache.set(issuer, bucket);
  }

  const cached = bucket.keys.get(kid);
  if (cached && nowMs - bucket.fetchedAtMs < JWKS_CACHE_MAX_AGE_MS) return cached;
  const staleCached = cached && nowMs - bucket.fetchedAtMs < JWKS_STALE_GRACE_MS ? cached : null;

  if (bucket.lastFetchAtMs !== null && nowMs - bucket.lastFetchAtMs < JWKS_REFETCH_COOLDOWN_MS) {
    // Refresh is throttled: a known-but-stale key stays usable within the grace window,
    // and a prior fetch failure must keep surfacing as a retryable outage, not as an
    // invalid assertion.
    if (staleCached) return staleCached;
    return bucket.lastFetchFailed ? JWKS_UNAVAILABLE : null;
  }
  bucket.lastFetchAtMs = nowMs;
  bucket.lastFetchFailed = true;

  let jwks;
  try {
    const response = await fetchFn(`${issuer}/.well-known/jwks.json`, { headers: { Accept: 'application/json' } });
    if (!response?.ok) return staleCached || JWKS_UNAVAILABLE;
    jwks = await response.json();
  } catch {
    return staleCached || JWKS_UNAVAILABLE;
  }

  const keys = new Map();
  for (const jwk of (Array.isArray(jwks?.keys) ? jwks.keys : []).slice(0, MAX_JWKS_KEYS)) {
    if (!jwk || jwk.kty !== 'RSA' || typeof jwk.kid !== 'string' || jwk.kid === '') continue;
    if (jwk.use !== undefined && jwk.use !== 'sig') continue;
    if (jwk.alg !== undefined && jwk.alg !== 'RS256') continue;
    try {
      keys.set(
        jwk.kid,
        await crypto.subtle.importKey(
          'jwk',
          { kty: 'RSA', n: jwk.n, e: jwk.e },
          { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
          false,
          ['verify']
        )
      );
    } catch {
      // Skip malformed key entries; other keys in the set stay usable.
    }
  }
  // The fetched document is the whole truth: retired kids drop out here.
  bucket.keys = keys;
  bucket.fetchedAtMs = nowMs;
  bucket.lastFetchFailed = false;
  return keys.get(kid) || null;
}

function audienceMatches(aud, expected) {
  if (typeof aud === 'string') return aud === expected;
  if (Array.isArray(aud)) return aud.length <= 8 && aud.includes(expected);
  return false;
}

function normalizeIdentifierClaim(value) {
  if (typeof value !== 'string') return '';
  const normalized = value.trim();
  if (normalized === '' || normalized.length > 256 || normalized !== value) return '';
  if (/\p{Cc}/u.test(normalized)) return '';
  return normalized;
}

function normalizeEmailClaim(value) {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 320) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

function decodeJsonSegment(segment) {
  const bytes = decodeBase64UrlBytes(segment);
  if (!bytes || bytes.byteLength === 0) return null;
  try {
    const value = JSON.parse(decoder.decode(bytes));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

function decodeBase64UrlBytes(segment) {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  let binary;
  try {
    binary = globalThis.atob(padded);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function failure(reason) {
  return { ok: false, reason };
}
