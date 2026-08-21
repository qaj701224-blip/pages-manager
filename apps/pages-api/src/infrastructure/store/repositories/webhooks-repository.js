import {
  cloneRecord,
  mapWebhookDelivery,
  mapWebhookSubscription,
  normalizeRequiredString,
  normalizeWebhookEvents,
  normalizeWebhookPayloadMode,
  normalizeWebhookSubscriptionPatch,
  randomStoreId,
  stringifyJsonColumn,
  withoutWebhookSecret,
} from '../store-support.js';

export const webhooksRepositoryMethods = {
  async createWebhookSubscription(input) {
    const now = this.now();
    const record = {
      id: input.id || randomStoreId('wh'),
      environment: normalizeRequiredString(input.environment),
      name: normalizeRequiredString(input.name),
      events: normalizeWebhookEvents(input.events),
      payloadMode: normalizeWebhookPayloadMode(input.payloadMode),
      restrictedTemplate: input.restrictedTemplate ?? null,
      encryptedUrlCiphertext: normalizeRequiredString(input.encryptedUrlCiphertext),
      urlSecretRef: null,
      urlHost: normalizeRequiredString(input.urlHost),
      urlMasked: normalizeRequiredString(input.urlMasked),
      urlFingerprint: normalizeRequiredString(input.urlFingerprint),
      enabled: input.enabled !== false,
      lastDeliveryStatus: input.lastDeliveryStatus || null,
      createdByUserId: normalizeRequiredString(input.createdByUserId),
      disabledAt: input.disabledAt || null,
      disabledByUserId: input.disabledByUserId || null,
      createdAt: input.createdAt || now,
      updatedAt: input.updatedAt || now,
    };
    if (
      !record.environment ||
      !record.name ||
      record.events.length === 0 ||
      !record.payloadMode ||
      !record.encryptedUrlCiphertext ||
      !record.urlHost ||
      !record.urlMasked ||
      !record.urlFingerprint ||
      !record.createdByUserId
    ) {
      throw new Error('WEBHOOK_SUBSCRIPTION_INVALID');
    }
    await this.ensureWebhookUrlFingerprintAvailable(record.environment, record.urlFingerprint);

    await this.db
      .prepare(
        `INSERT INTO webhook_subscriptions (
            id, environment, name, events_json, payload_mode, restricted_template_json,
            encrypted_url_ciphertext, url_host, url_masked, url_fingerprint,
            enabled, last_delivery_status, created_by_user_id,
            disabled_at, disabled_by_user_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        record.id,
        record.environment,
        record.name,
        stringifyJsonColumn(record.events),
        record.payloadMode,
        stringifyJsonColumn(record.restrictedTemplate),
        record.encryptedUrlCiphertext,
        record.urlHost,
        record.urlMasked,
        record.urlFingerprint,
        record.enabled ? 1 : 0,
        record.lastDeliveryStatus,
        record.createdByUserId,
        record.disabledAt,
        record.disabledByUserId,
        record.createdAt,
        record.updatedAt
      )
      .run();
    return cloneRecord(withoutWebhookSecret(record));
  },

  async getWebhookSubscription({ environment, id, includeSecret = false }) {
    const normalizedId = normalizeRequiredString(id);
    if (!normalizedId) return null;
    const normalizedEnvironment = normalizeRequiredString(environment);
    const row = await this.db
      .prepare(
        `SELECT * FROM webhook_subscriptions
          WHERE id = ?${normalizedEnvironment ? ' AND environment = ?' : ''}
          LIMIT 1`
      )
      .bind(...(normalizedEnvironment ? [normalizedId, normalizedEnvironment] : [normalizedId]))
      .first();
    return row ? mapWebhookSubscription(row, { includeSecret }) : null;
  },

  async listWebhookSubscriptions({ environment }) {
    const normalizedEnvironment = normalizeRequiredString(environment);
    if (!normalizedEnvironment) return [];
    const result = await this.db
      .prepare(
        `SELECT * FROM webhook_subscriptions
          WHERE environment = ?
          ORDER BY updated_at DESC, name ASC`
      )
      .bind(normalizedEnvironment)
      .all();
    return (result.results || []).map((row) => mapWebhookSubscription(row));
  },

  async updateWebhookSubscription({ environment, id, patch }) {
    const existing = await this.getWebhookSubscription({ environment, id, includeSecret: true });
    if (!existing) return null;
    const now = this.now();
    const next = {
      ...existing,
      ...normalizeWebhookSubscriptionPatch(patch),
      updatedAt: now,
    };
    if (patch?.enabled === false && existing.enabled) {
      next.disabledAt = now;
      next.disabledByUserId = patch.disabledByUserId || existing.disabledByUserId || null;
    }
    if (patch?.enabled === true) {
      next.disabledAt = null;
      next.disabledByUserId = null;
    }
    await this.ensureWebhookUrlFingerprintAvailable(environment, next.urlFingerprint, id);

    await this.db
      .prepare(
        `UPDATE webhook_subscriptions
          SET name = ?, events_json = ?, payload_mode = ?, restricted_template_json = ?,
            encrypted_url_ciphertext = ?, url_host = ?, url_masked = ?, url_fingerprint = ?,
            enabled = ?, last_delivery_status = ?, disabled_at = ?, disabled_by_user_id = ?, updated_at = ?
          WHERE id = ? AND environment = ?`
      )
      .bind(
        next.name,
        stringifyJsonColumn(next.events),
        next.payloadMode,
        stringifyJsonColumn(next.restrictedTemplate),
        next.encryptedUrlCiphertext,
        next.urlHost,
        next.urlMasked,
        next.urlFingerprint,
        next.enabled ? 1 : 0,
        next.lastDeliveryStatus,
        next.disabledAt,
        next.disabledByUserId,
        next.updatedAt,
        next.id,
        next.environment
      )
      .run();
    return this.getWebhookSubscription({ environment, id });
  },

  async ensureWebhookUrlFingerprintAvailable(environment, urlFingerprint, currentId = null) {
    const normalizedEnvironment = normalizeRequiredString(environment);
    const normalizedFingerprint = normalizeRequiredString(urlFingerprint);
    if (!normalizedEnvironment || !normalizedFingerprint) return;
    const row = await this.db
      .prepare(
        `SELECT id FROM webhook_subscriptions
          WHERE environment = ? AND url_fingerprint = ? ${currentId ? 'AND id != ?' : ''}
          LIMIT 1`
      )
      .bind(
        ...(currentId
          ? [normalizedEnvironment, normalizedFingerprint, currentId]
          : [normalizedEnvironment, normalizedFingerprint])
      )
      .first();
    if (row) throw new Error('WEBHOOK_URL_CONFLICT');
  },

  async recordWebhookDelivery(input) {
    const now = input.createdAt || this.now();
    const record = {
      id: input.id || randomStoreId('whd'),
      environment: normalizeRequiredString(input.environment),
      subscriptionId: normalizeRequiredString(input.subscriptionId),
      eventType: normalizeRequiredString(input.eventType),
      deliveryStatus: input.deliveryStatus || 'pending',
      renderStatus: input.renderStatus || 'pending',
      payloadMode: normalizeWebhookPayloadMode(input.payloadMode || 'standard'),
      templateRevision: input.templateRevision ?? null,
      payloadHash: input.payloadHash || null,
      targetHost: normalizeRequiredString(input.targetHost),
      httpStatus: input.httpStatus ?? null,
      attemptCount: Number(input.attemptCount || 0),
      nextRetryAt: input.nextRetryAt || null,
      errorCode: input.errorCode || null,
      createdAt: now,
      updatedAt: input.updatedAt || now,
    };
    if (!record.environment || !record.subscriptionId || !record.eventType || !record.payloadMode || !record.targetHost) {
      throw new Error('WEBHOOK_DELIVERY_INVALID');
    }

    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO webhook_deliveries (
              id, environment, subscription_id, event_type, delivery_status, render_status,
              payload_mode, template_revision, payload_hash, target_host, http_status,
              attempt_count, next_retry_at, error_code, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          record.id,
          record.environment,
          record.subscriptionId,
          record.eventType,
          record.deliveryStatus,
          record.renderStatus,
          record.payloadMode,
          record.templateRevision,
          record.payloadHash,
          record.targetHost,
          record.httpStatus,
          record.attemptCount,
          record.nextRetryAt,
          record.errorCode,
          record.createdAt,
          record.updatedAt
        ),
      this.db
        .prepare('UPDATE webhook_subscriptions SET last_delivery_status = ?, updated_at = ? WHERE id = ? AND environment = ?')
        .bind(record.deliveryStatus, record.updatedAt, record.subscriptionId, record.environment),
    ]);
    return cloneRecord(record);
  },

  async updateWebhookDelivery(id, patch) {
    const existing = await this.db.prepare('SELECT * FROM webhook_deliveries WHERE id = ? LIMIT 1').bind(id).first();
    if (!existing) return null;
    const current = mapWebhookDelivery(existing);
    const now = this.now();
    const next = {
      ...current,
      deliveryStatus: patch.deliveryStatus || current.deliveryStatus,
      renderStatus: patch.renderStatus || current.renderStatus,
      payloadHash: patch.payloadHash ?? current.payloadHash,
      httpStatus: patch.httpStatus ?? current.httpStatus,
      attemptCount: patch.attemptCount ?? current.attemptCount,
      nextRetryAt: patch.nextRetryAt ?? current.nextRetryAt,
      errorCode: patch.errorCode ?? current.errorCode,
      updatedAt: patch.updatedAt || now,
    };
    await this.db
      .prepare(
        `UPDATE webhook_deliveries
          SET delivery_status = ?, render_status = ?, payload_hash = ?, http_status = ?,
            attempt_count = ?, next_retry_at = ?, error_code = ?, updated_at = ?
          WHERE id = ?`
      )
      .bind(
        next.deliveryStatus,
        next.renderStatus,
        next.payloadHash,
        next.httpStatus,
        next.attemptCount,
        next.nextRetryAt,
        next.errorCode,
        next.updatedAt,
        id
      )
      .run();
    await this.db
      .prepare('UPDATE webhook_subscriptions SET last_delivery_status = ?, updated_at = ? WHERE id = ? AND environment = ?')
      .bind(next.deliveryStatus, next.updatedAt, next.subscriptionId, next.environment)
      .run();
    return cloneRecord(next);
  },

  async listWebhookDeliveries({ environment, subscriptionId }) {
    const normalizedEnvironment = normalizeRequiredString(environment);
    const normalizedSubscriptionId = normalizeRequiredString(subscriptionId);
    if (!normalizedEnvironment) return [];
    const result = await this.db
      .prepare(
        `SELECT * FROM webhook_deliveries
          WHERE environment = ?${normalizedSubscriptionId ? ' AND subscription_id = ?' : ''}
          ORDER BY created_at DESC
          LIMIT 100`
      )
      .bind(...(normalizedSubscriptionId ? [normalizedEnvironment, normalizedSubscriptionId] : [normalizedEnvironment]))
      .all();
    return (result.results || []).map(mapWebhookDelivery);
  },
};
