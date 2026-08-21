import { parseJsonColumn } from '../support/common.js';

export function mapWebhookSubscription(row, { includeSecret = false } = {}) {
  const record = {
    id: row.id,
    environment: row.environment,
    name: row.name,
    events: parseJsonColumn(row.events_json) || [],
    payloadMode: row.payload_mode,
    restrictedTemplate: parseJsonColumn(row.restricted_template_json),
    encryptedUrlCiphertext: row.encrypted_url_ciphertext,
    urlSecretRef: null,
    urlHost: row.url_host,
    urlMasked: row.url_masked,
    urlFingerprint: row.url_fingerprint,
    enabled: Boolean(row.enabled),
    lastDeliveryStatus: row.last_delivery_status || null,
    createdByUserId: row.created_by_user_id,
    disabledAt: row.disabled_at || null,
    disabledByUserId: row.disabled_by_user_id || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return includeSecret ? record : withoutWebhookSecret(record);
}

export function mapWebhookDelivery(row) {
  return {
    id: row.id,
    environment: row.environment,
    subscriptionId: row.subscription_id,
    eventType: row.event_type,
    deliveryStatus: row.delivery_status,
    renderStatus: row.render_status,
    payloadMode: row.payload_mode,
    templateRevision: row.template_revision ?? null,
    payloadHash: row.payload_hash || null,
    targetHost: row.target_host,
    httpStatus: row.http_status ?? null,
    attemptCount: Number(row.attempt_count || 0),
    nextRetryAt: row.next_retry_at || null,
    errorCode: row.error_code || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function withoutWebhookSecret(record) {
  if (!record) return null;
  const safeRecord = { ...record };
  delete safeRecord.encryptedUrlCiphertext;
  safeRecord.urlSecretRef = null;
  return safeRecord;
}
