const encoder = new globalThis.TextEncoder();

const ENVIRONMENT_KEY_PREFIX = {
  production: 'prod',
  staging: 'stg',
  local: 'local',
};

const KEY_PREFIX_ENVIRONMENT = new Map(Object.entries(ENVIRONMENT_KEY_PREFIX).map(([environment, hint]) => [hint, environment]));

export async function canonicalRequestHash(value) {
  return `sha256:${await sha256Hex(canonicalJson(value))}`;
}

export async function sha256HexForText(value) {
  return sha256Hex(String(value));
}

export async function sha256HexForBytes(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : encoder.encode(String(bytes));
  const digest = await crypto.subtle.digest('SHA-256', input);
  return bytesToHex(new Uint8Array(digest));
}

export async function hashAccessKey(plaintext, pepper) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(pepper), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(String(plaintext)));
  return bytesToHex(new Uint8Array(signature));
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

export function createAccessKeyPlaintext({ environment, keyId, bytes } = {}) {
  const hint = ENVIRONMENT_KEY_PREFIX[environment];
  if (!hint) throw new Error('Unsupported access key environment');
  if (typeof keyId !== 'string' || !/^ak_[A-Za-z0-9_]{1,128}$/.test(keyId)) {
    throw new Error('Invalid access key id');
  }

  const secretBytes = bytes || randomBytes(24);
  return `xdp_${hint}_${keyId}_${bytesToHex(secretBytes)}`;
}

export function parseAccessKeyPlaintext(plaintext) {
  const match = String(plaintext || '').match(/^xdp_(prod|stg|local)_(ak_[A-Za-z0-9_]{1,128})_([a-f0-9]{48,})$/);
  if (!match) return null;
  return {
    environmentHint: KEY_PREFIX_ENVIRONMENT.get(match[1]),
    keyId: match[2],
  };
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(value)));
  return bytesToHex(new Uint8Array(digest));
}

function canonicalJson(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;

  const valueType = typeof value;
  if (valueType === 'string' || valueType === 'number' || valueType === 'boolean') return JSON.stringify(value);
  if (valueType !== 'object') throw new Error('Request body contains unsupported values');

  const entries = Object.entries(value)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalJson(entryValue)}`).join(',')}}`;
}

function randomBytes(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytes;
}

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
