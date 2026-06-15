import { classifyHost } from '../../pages-router/src/host.js';
import { constantTimeEqualHex, createOpaqueToken, sha256Hex } from './id.js';

export async function createOAuthState({
  environment,
  siteHost,
  returnTo,
  now,
  ttlSeconds,
  stateId = createOpaqueToken('ost'),
  stateSecret = createOpaqueToken('sec'),
}) {
  const normalizedSiteHost = validateSiteHost(siteHost, environment);
  const normalizedReturnTo = validateReturnTo(returnTo, normalizedSiteHost);

  return {
    publicState: `${stateId}.${stateSecret}`,
    record: {
      id: stateId,
      environment,
      siteHost: normalizedSiteHost,
      returnTo: normalizedReturnTo,
      secretHash: await sha256Hex(stateSecret),
      issuedAt: now,
      expiresAt: now + ttlSeconds,
      consumedAt: null,
    },
  };
}

export async function consumeOAuthState(publicState, record, { now }) {
  const [stateId, stateSecret] = parsePublicState(publicState);
  if (!record || record.id !== stateId) throw new Error('OAuth state invalid: unknown state');
  if (record.consumedAt !== null) throw new Error('OAuth state invalid: already consumed');
  if (record.expiresAt <= now) throw new Error('OAuth state invalid: expired');

  const actualHash = await sha256Hex(stateSecret);
  if (!constantTimeEqualHex(record.secretHash, actualHash)) throw new Error('OAuth state invalid: secret mismatch');

  const consumedRecord = { ...record, consumedAt: now };
  return { ok: true, record: consumedRecord, returnTo: record.returnTo, siteHost: record.siteHost };
}

function parsePublicState(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 2 || parts.some((part) => part === '')) throw new Error('OAuth state invalid: malformed state');
  return parts;
}

function validateSiteHost(siteHost, environment) {
  const host = String(siteHost || '').trim().toLowerCase();
  const classified = classifyHost(host, { environment });
  if (!classified.ok) throw new Error('OAuth state invalid: site host is not allowed');
  return classified.hostname;
}

function validateReturnTo(returnTo, siteHost) {
  let url;
  try {
    url = new URL(returnTo);
  } catch {
    throw new Error('OAuth state invalid: return_to must be an absolute URL');
  }

  if (url.protocol !== 'https:') throw new Error('OAuth state invalid: return_to must use https');
  if (url.username || url.password) throw new Error('OAuth state invalid: return_to credentials are not allowed');
  if (url.hash) throw new Error('OAuth state invalid: return_to fragment is not allowed');
  if (url.hostname !== siteHost) throw new Error('OAuth state invalid: return_to host is not allowed');
  return url.toString();
}
