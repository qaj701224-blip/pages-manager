const encoder = new globalThis.TextEncoder();

export function parseCapabilitySigningKey(env) {
  const activeKid = env?.PAGES_CAP_JWT_ACTIVE_KID?.trim();
  if (typeof activeKid !== 'string' || activeKid === '') {
    throw new Error('Capability active kid is missing');
  }

  const registryValue = env?.PAGES_CAP_JWT_KEYS;
  if (typeof registryValue !== 'string' || registryValue === '') {
    throw new Error('Capability key registry is missing');
  }

  const entries = registryValue
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);

  if (entries.length === 0) throw new Error('Capability key registry is empty');

  const registry = new Map();
  for (const entry of entries) {
    const parts = entry.split(':').map((part) => part.trim());
    if (parts.length !== 3) throw new Error('Malformed capability key registry entry');

    const [kid, alg, secretEnvName] = parts;
    if (!kid || !alg || !secretEnvName) throw new Error('Malformed capability key registry entry');
    if (alg !== 'HS256') throw new Error(`Unsupported capability key alg: ${alg}`);
    if (registry.has(kid)) throw new Error(`Duplicate capability key kid: ${kid}`);

    const secret = env[secretEnvName];
    if (typeof secret !== 'string' || secret === '') {
      throw new Error(`Missing capability secret env var: ${secretEnvName}`);
    }

    registry.set(kid, { kid, alg, secret });
  }

  const key = registry.get(activeKid);
  if (key) return key;

  throw new Error(`Capability active kid not found: ${activeKid}`);
}

export async function signKvCapability({ siteId, siteUuid, siteGeneration, envName, now, jti }, env) {
  const { kid, secret } = parseCapabilitySigningKey(env);
  const header = { typ: 'JWT', alg: 'HS256', kid };
  const payload = {
    iss: 'pages-manager',
    aud: 'pages-kv-gateway',
    env: envName,
    siteId,
    siteUuid,
    siteGeneration,
    scope: ['kv:get', 'kv:put', 'kv:delete'],
    iat: now,
    nbf: now,
    jti,
  };

  const encodedHeader = base64UrlEncodeJson(header);
  const encodedPayload = base64UrlEncodeJson(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = await signHs256(secret, signingInput);

  return `${signingInput}.${base64UrlEncodeBytes(signature)}`;
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
