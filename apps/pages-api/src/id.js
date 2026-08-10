const SAFE_ID_PREFIX_RE = /^[a-z][a-z0-9]{1,15}$/;

export function newId(prefix, { bytes } = {}) {
  assertSafeIdPrefix(prefix);
  const random = bytes || randomBytes(16);
  return `${prefix}_${bytesToHex(random)}`;
}

export function nextId(env, prefix) {
  assertSafeIdPrefix(prefix);
  if (typeof env?.nextId === 'function') {
    const id = env.nextId(prefix);
    if (id) return id;
  }
  return newId(prefix);
}

export function newHexId({ bytes } = {}) {
  return bytesToHex(bytes || randomBytes(16));
}

function randomBytes(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytes;
}

function assertSafeIdPrefix(prefix) {
  if (!SAFE_ID_PREFIX_RE.test(prefix)) throw new Error('ID prefix must be lowercase alphanumeric');
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
