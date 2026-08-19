export const TEST_WEBHOOK_URL_ENCRYPTION_KEY = 'test-webhook-url-key';

export async function seedLifecycleWebhook(store, eventType, { id = `wh_${eventType.replaceAll('.', '_')}` } = {}) {
  await store.createWebhookSubscription({
    id,
    environment: 'production',
    name: `${eventType} test webhook`,
    events: [eventType],
    payloadMode: 'standard',
    restrictedTemplate: null,
    encryptedUrlCiphertext: await encryptWebhookUrlForTest('https://hooks.example.test/hook'),
    urlHost: 'hooks.example.test',
    urlMasked: 'https://hooks.example.test/.../hook',
    urlFingerprint: `sha256:${eventType}`,
    createdByUserId: 'usr_root',
  });
}

async function encryptWebhookUrlForTest(value) {
  const material = new globalThis.TextEncoder().encode(TEST_WEBHOOK_URL_ENCRYPTION_KEY);
  const digest = await crypto.subtle.digest('SHA-256', material);
  const key = await crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt']);
  const iv = new Uint8Array(12).fill(7);
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new globalThis.TextEncoder().encode(value))
  );
  return `v1:${base64UrlEncode(iv)}:${base64UrlEncode(encrypted)}`;
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
