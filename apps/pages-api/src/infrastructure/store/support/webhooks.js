import { normalizeRequiredString } from './normalizers.js';

export function normalizeWebhookEvents(events) {
  if (!Array.isArray(events)) return [];
  return [...new Set(events.map((event) => (typeof event === 'string' ? event.trim() : '')).filter(Boolean))];
}

export function normalizeWebhookPayloadMode(mode) {
  if (mode === 'standard' || mode === 'template') return mode;
  return '';
}

export function normalizeWebhookSubscriptionPatch(patch = {}) {
  const normalized = {};
  if ('name' in patch) normalized.name = normalizeRequiredString(patch.name);
  if ('events' in patch) normalized.events = normalizeWebhookEvents(patch.events);
  if ('payloadMode' in patch) normalized.payloadMode = normalizeWebhookPayloadMode(patch.payloadMode);
  if ('restrictedTemplate' in patch) normalized.restrictedTemplate = patch.restrictedTemplate ?? null;
  if ('encryptedUrlCiphertext' in patch)
    normalized.encryptedUrlCiphertext = normalizeRequiredString(patch.encryptedUrlCiphertext);
  if ('urlHost' in patch) normalized.urlHost = normalizeRequiredString(patch.urlHost);
  if ('urlMasked' in patch) normalized.urlMasked = normalizeRequiredString(patch.urlMasked);
  if ('urlFingerprint' in patch) normalized.urlFingerprint = normalizeRequiredString(patch.urlFingerprint);
  if ('enabled' in patch) normalized.enabled = patch.enabled !== false;
  if ('lastDeliveryStatus' in patch) normalized.lastDeliveryStatus = patch.lastDeliveryStatus || null;
  if ('disabledAt' in patch) normalized.disabledAt = patch.disabledAt || null;
  if ('disabledByUserId' in patch) normalized.disabledByUserId = patch.disabledByUserId || null;
  return normalized;
}
