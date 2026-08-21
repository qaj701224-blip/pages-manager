export async function encryptSiteSecretValue(value, secretEncryptionKey) {
  if (!secretEncryptionKey) throw new Error('SITE_SECRET_ENCRYPTION_KEY_REQUIRED');
  const cryptoImpl = globalThis.crypto;
  if (!cryptoImpl?.subtle || !cryptoImpl.getRandomValues) throw new Error('SITE_SECRET_CRYPTO_UNAVAILABLE');
  const iv = new Uint8Array(12);
  cryptoImpl.getRandomValues(iv);
  const key = await importSiteSecretKey(secretEncryptionKey);
  const bytes = new globalThis.TextEncoder().encode(value);
  const encrypted = new Uint8Array(await cryptoImpl.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return `v1:${base64UrlEncode(iv)}:${base64UrlEncode(encrypted)}`;
}

export async function decryptSiteSecretValue(value, secretEncryptionKey) {
  if (!secretEncryptionKey) throw new Error('SITE_SECRET_ENCRYPTION_KEY_REQUIRED');
  const parts = String(value || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('SITE_SECRET_CIPHERTEXT_INVALID');
  const key = await importSiteSecretKey(secretEncryptionKey);
  const iv = base64UrlDecode(parts[1]);
  const encrypted = base64UrlDecode(parts[2]);
  const decrypted = await globalThis.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
  return new TextDecoder().decode(decrypted);
}

export async function importSiteSecretKey(secretEncryptionKey) {
  const material = new globalThis.TextEncoder().encode(String(secretEncryptionKey));
  const digest = await globalThis.crypto.subtle.digest('SHA-256', material);
  return globalThis.crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

export function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export function base64UrlDecode(value) {
  const normalized = String(value || '')
    .replaceAll('-', '+')
    .replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
