const encoder = new globalThis.TextEncoder();
const SAFE_PREFIX_RE = /^[a-z][a-z0-9_]{1,15}$/;

export function createOpaqueToken(prefix, { byteLength = 24, bytes } = {}) {
  if (!SAFE_PREFIX_RE.test(prefix)) throw new Error('Token prefix must be lowercase snake case');
  const tokenBytes = bytes || randomBytes(byteLength);
  return `${prefix}_${base64UrlEncodeBytes(tokenBytes)}`;
}

export async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return bytesToHex(new Uint8Array(digest));
}

export function constantTimeEqualHex(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (left.length !== right.length) return false;

  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

function randomBytes(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytes;
}

function base64UrlEncodeBytes(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
