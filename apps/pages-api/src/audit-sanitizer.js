const MAX_DEPTH = 5;
const MAX_KEYS = 40;
const MAX_ARRAY_LENGTH = 30;
const MAX_STRING_LENGTH = 512;

const REDACTED_KEYS = new Set([
  'token',
  'secret',
  'password',
  'authorization',
  'cookie',
  'session',
  'sessionid',
  'ciphertext',
  'privatekey',
  'apikey',
  'clientsecret',
  'accesstoken',
  'sessiontoken',
  'refreshtoken',
  'passwordhash',
  'apitoken',
  'authtokenvalue',
  'accesskeyhash',
  'accesskeyplaintext',
  'webhookurl',
]);

const PROVIDER_REFERENCE_KEYS = new Set([
  'workername',
  'resourceref',
  'providerresourceid',
  'providerresourceids',
  'cfaccountid',
  'artifactref',
  'scriptname',
  'accountid',
  'zoneid',
  'namespaceid',
  'databaseid',
  'routeref',
  'cleanupresourceref',
]);

export function sanitizeAuditMetadata(value) {
  return sanitizeValue(value, 0);
}

function sanitizeValue(value, depth) {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return sanitizeString(value);
  if (depth >= MAX_DEPTH) return '[TRUNCATED]';
  if (Array.isArray(value)) {
    const items = value.length > MAX_ARRAY_LENGTH ? value.slice(0, MAX_ARRAY_LENGTH - 1) : value;
    const sanitized = items.map((item) => sanitizeValue(item, depth + 1));
    if (value.length > MAX_ARRAY_LENGTH) sanitized.push('[TRUNCATED]');
    return sanitized;
  }
  if (isPlainObject(value)) {
    const entries = Object.entries(value);
    const keptEntries = entries.length > MAX_KEYS ? entries.slice(0, MAX_KEYS - 1) : entries;
    const result = Object.fromEntries(
      keptEntries.map(([key, entryValue]) => {
        const normalizedKey = key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        if (REDACTED_KEYS.has(normalizedKey) || PROVIDER_REFERENCE_KEYS.has(normalizedKey)) {
          return [key, '[REDACTED]'];
        }
        return [key, sanitizeValue(entryValue, depth + 1)];
      })
    );
    if (entries.length > MAX_KEYS) result.__truncated__ = '[TRUNCATED]';
    return result;
  }
  return '[UNSUPPORTED]';
}

function sanitizeString(value) {
  if (value.length > MAX_STRING_LENGTH) return '[TRUNCATED]';
  const trimmed = value.trim();
  if (/^https?:\/\/\S+$/i.test(trimmed)) return sanitizeHttpUrl(trimmed);
  return value.replace(/https?:\/\/[^\s<>"']+/gi, sanitizeEmbeddedHttpUrl);
}

function sanitizeEmbeddedHttpUrl(value) {
  const trailingPunctuation = value.match(/[),.;!?]+$/)?.[0] || '';
  const url = trailingPunctuation ? value.slice(0, -trailingPunctuation.length) : value;
  return `${sanitizeHttpUrl(url)}${trailingPunctuation}`;
}

function sanitizeHttpUrl(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}`;
  } catch {
    return '[UNSUPPORTED]';
  }
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
