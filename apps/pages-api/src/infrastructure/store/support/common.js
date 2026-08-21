export function deploymentIdempotencyScope({ environment, actorId, siteId, operation }) {
  return `${environment}:${actorId}:${siteId}:${operation}`;
}

export function cloneRecord(record) {
  return record == null ? null : JSON.parse(JSON.stringify(record));
}

export function stringifyJsonColumn(value) {
  return value == null ? null : JSON.stringify(value);
}

export function parseJsonColumn(value) {
  if (typeof value !== 'string' || value === '') return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export function isSqliteConstraintError(error) {
  const message = error instanceof Error ? error.message : String(error || '');
  return /constraint|unique/i.test(message);
}

export function fnv1a64Hex(value) {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  const bytes = new globalThis.TextEncoder().encode(value);
  for (const byte of bytes) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}

export function randomStoreId(prefix) {
  const bytes = new Uint8Array(16);
  globalThis.crypto?.getRandomValues?.(bytes);
  if (!bytes.some(Boolean)) throw new Error('STORE_ID_CRYPTO_UNAVAILABLE');
  return `${prefix}_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}
