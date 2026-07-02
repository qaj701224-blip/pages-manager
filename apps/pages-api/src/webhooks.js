import { sha256HexForText } from './crypto.js';
import { jsonError, jsonOk, readJsonBody } from './http.js';
import { assertSafeWebhookUrl, dispatchWebhook, nextRetryAt } from './webhook-dispatcher.js';
import {
  buildStandardWebhookPayload,
  payloadHash,
  renderRestrictedTemplate,
  validateRestrictedTemplate,
} from './webhook-payload.js';

const CONSOLE_PREFIX = '/.xd-pages/api/console';
const SUPPORTED_WEBHOOK_EVENTS = new Set(['site.deployed']);
const PAYLOAD_MODES = new Set(['standard', 'template']);

export async function handleConsoleAdminWebhooksApi(request, env, config, store, session) {
  const url = new URL(request.url);

  if (url.pathname === `${CONSOLE_PREFIX}/admin/webhooks`) {
    if (request.method === 'GET') return listWebhookSubscriptions(config, store);
    if (request.method === 'POST') return createWebhookSubscription(request, env, config, store, session);
    return methodNotAllowed();
  }

  const deliveriesMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/webhooks\/([^/]+)\/deliveries$/);
  if (deliveriesMatch) {
    if (request.method !== 'GET') return methodNotAllowed();
    return listWebhookDeliveries(config, store, decodeURIComponent(deliveriesMatch[1]));
  }

  const subscriptionMatch = url.pathname.match(/^\/\.xd-pages\/api\/console\/admin\/webhooks\/([^/]+)$/);
  if (subscriptionMatch) {
    const subscriptionId = decodeURIComponent(subscriptionMatch[1]);
    if (request.method === 'PATCH') return updateWebhookSubscription(request, env, config, store, subscriptionId);
    if (request.method === 'DELETE') return disableWebhookSubscription(config, store, session, subscriptionId);
    return methodNotAllowed();
  }

  return null;
}

export async function deliverWebhookEvent({ store, env, config, subscriptionId, event, fetchImpl, resolveHost, now } = {}) {
  const environment = config?.environment;
  const subscription = await store.getWebhookSubscription({ environment, id: subscriptionId, includeSecret: true });
  if (!subscription || !subscription.enabled || !subscription.events.includes(event?.type)) return null;

  const deliveryId = nextId(env, 'whd');
  const timestamp = readNowIso(now);
  const standardPayload = buildStandardWebhookPayload({
    ...event,
    environment: event?.environment || environment,
  });

  let outboundPayload = standardPayload;
  if (subscription.payloadMode === 'template') {
    try {
      outboundPayload = renderRestrictedTemplate(subscription.restrictedTemplate, standardPayload);
    } catch (error) {
      return store.recordWebhookDelivery({
        id: deliveryId,
        environment,
        subscriptionId: subscription.id,
        eventType: event.type,
        deliveryStatus: 'failed',
        renderStatus: 'failed',
        payloadMode: subscription.payloadMode,
        payloadHash: null,
        targetHost: subscription.urlHost,
        attemptCount: 0,
        errorCode: errorCodeFromError(error, 'WEBHOOK_TEMPLATE_RENDER_FAILED'),
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
  }

  const pending = await store.recordWebhookDelivery({
    id: deliveryId,
    environment,
    subscriptionId: subscription.id,
    eventType: event.type,
    deliveryStatus: 'pending',
    renderStatus: 'succeeded',
    payloadMode: subscription.payloadMode,
    payloadHash: await payloadHash(outboundPayload),
    targetHost: subscription.urlHost,
    attemptCount: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  });

  try {
    const url = await decryptWebhookUrl(subscription.encryptedUrlCiphertext, readWebhookUrlEncryptionKey(env));
    const result = await dispatchWebhook({
      url,
      eventType: event.type,
      deliveryId,
      payload: outboundPayload,
      fetchImpl,
      resolveHost: resolveHost || createWebhookResolveHost(env),
      now: () => timestamp,
    });
    return store.updateWebhookDelivery(pending.id, {
      deliveryStatus: result.deliveryStatus,
      httpStatus: result.httpStatus,
      attemptCount: 1,
      nextRetryAt: result.deliveryStatus === 'failed' ? nextRetryAt(0, timestamp) : null,
      errorCode: result.errorCode,
      updatedAt: timestamp,
    });
  } catch (error) {
    return store.updateWebhookDelivery(pending.id, {
      deliveryStatus: 'failed',
      httpStatus: null,
      attemptCount: 1,
      nextRetryAt: nextRetryAt(0, timestamp),
      errorCode: errorCodeFromError(error, 'WEBHOOK_DISPATCH_FAILED'),
      updatedAt: timestamp,
    });
  }
}

export async function deliverWebhookEventToSubscriptions({ store, env, config, event, fetchImpl, resolveHost, now } = {}) {
  if (!event?.type || typeof store?.listWebhookSubscriptions !== 'function') return [];
  const environment = config?.environment;
  const subscriptions = await store.listWebhookSubscriptions({ environment });
  const matchingSubscriptions = subscriptions.filter(
    (subscription) => subscription.enabled && subscription.events.includes(event.type)
  );
  return Promise.all(
    matchingSubscriptions.map((subscription) =>
      deliverWebhookEvent({
        store,
        env,
        config,
        subscriptionId: subscription.id,
        event,
        fetchImpl,
        resolveHost,
        now,
      })
    )
  );
}

async function listWebhookSubscriptions(config, store) {
  const webhooks = await store.listWebhookSubscriptions({ environment: config.environment });
  return jsonOk({ webhooks: webhooks.map(formatWebhookSubscription) });
}

async function createWebhookSubscription(request, env, config, store, session) {
  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 64 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const parsed = await normalizeWebhookSubscriptionInput(body, env);
  if (parsed instanceof Response) return parsed;

  const webhook = await store.createWebhookSubscription({
    id: nextId(env, 'wh'),
    environment: config.environment,
    name: parsed.name,
    events: parsed.events,
    payloadMode: parsed.payloadMode,
    restrictedTemplate: parsed.restrictedTemplate,
    encryptedUrlCiphertext: parsed.encryptedUrlCiphertext,
    urlHost: parsed.urlHost,
    urlMasked: parsed.urlMasked,
    urlFingerprint: parsed.urlFingerprint,
    createdByUserId: session.userId,
  });

  return jsonOk({ webhook: formatWebhookSubscription(webhook) }, 201);
}

async function updateWebhookSubscription(request, env, config, store, subscriptionId) {
  let body;
  try {
    body = await readJsonBody(request, { maxBytes: 64 * 1024 });
  } catch {
    return jsonError('INVALID_JSON', 'Invalid JSON body.', 400, 'Send a JSON object.');
  }

  const patch = {};
  if ('name' in body) {
    const name = normalizeName(body.name);
    if (!name) return jsonError('WEBHOOK_NAME_INVALID', 'Webhook name is invalid.', 400, 'Use a non-empty name.');
    patch.name = name;
  }
  if ('events' in body) {
    const events = normalizeEvents(body.events);
    if (events instanceof Response) return events;
    if (!events.length) {
      return jsonError('WEBHOOK_EVENTS_INVALID', 'Webhook events are invalid.', 400, 'Choose at least one event.');
    }
    patch.events = events;
  }
  if ('payloadMode' in body || 'restrictedTemplate' in body) {
    const payloadMode = normalizePayloadMode('payloadMode' in body ? body.payloadMode : 'template');
    if (!payloadMode) {
      return jsonError('WEBHOOK_PAYLOAD_MODE_INVALID', 'Webhook payload mode is invalid.', 400, 'Use standard or template.');
    }
    patch.payloadMode = payloadMode;
    const restrictedTemplate = normalizeRestrictedTemplate(payloadMode, body.restrictedTemplate);
    if (restrictedTemplate instanceof Response) return restrictedTemplate;
    patch.restrictedTemplate = restrictedTemplate;
  }
  if ('enabled' in body) patch.enabled = body.enabled !== false;
  if ('url' in body) {
    const urlFields = await prepareWebhookUrlFields(body.url, env);
    if (urlFields instanceof Response) return urlFields;
    Object.assign(patch, urlFields);
  }

  const webhook = await store.updateWebhookSubscription({
    environment: config.environment,
    id: subscriptionId,
    patch,
  });
  if (!webhook) return jsonError('WEBHOOK_NOT_FOUND', 'Webhook was not found.', 404, 'Check the webhook id.');
  return jsonOk({ webhook: formatWebhookSubscription(webhook) });
}

async function disableWebhookSubscription(config, store, session, subscriptionId) {
  const webhook = await store.updateWebhookSubscription({
    environment: config.environment,
    id: subscriptionId,
    patch: {
      enabled: false,
      disabledByUserId: session.userId,
    },
  });
  if (!webhook) return jsonError('WEBHOOK_NOT_FOUND', 'Webhook was not found.', 404, 'Check the webhook id.');
  return jsonOk({ webhook: formatWebhookSubscription(webhook) });
}

async function listWebhookDeliveries(config, store, subscriptionId) {
  const webhook = await store.getWebhookSubscription({ environment: config.environment, id: subscriptionId });
  if (!webhook) return jsonError('WEBHOOK_NOT_FOUND', 'Webhook was not found.', 404, 'Check the webhook id.');

  const deliveries = await store.listWebhookDeliveries({
    environment: config.environment,
    subscriptionId,
  });
  return jsonOk({ deliveries: deliveries.map(formatWebhookDelivery) });
}

async function normalizeWebhookSubscriptionInput(body, env) {
  const name = normalizeName(body.name);
  if (!name) return jsonError('WEBHOOK_NAME_INVALID', 'Webhook name is invalid.', 400, 'Use a non-empty name.');

  const events = normalizeEvents(body.events);
  if (events instanceof Response) return events;
  if (!events.length) {
    return jsonError('WEBHOOK_EVENTS_INVALID', 'Webhook events are invalid.', 400, 'Choose at least one event.');
  }

  const payloadMode = normalizePayloadMode(body.payloadMode || 'standard');
  if (!payloadMode) {
    return jsonError('WEBHOOK_PAYLOAD_MODE_INVALID', 'Webhook payload mode is invalid.', 400, 'Use standard or template.');
  }

  const restrictedTemplate = normalizeRestrictedTemplate(payloadMode, body.restrictedTemplate);
  if (restrictedTemplate instanceof Response) return restrictedTemplate;

  const urlFields = await prepareWebhookUrlFields(body.url, env);
  if (urlFields instanceof Response) return urlFields;

  return {
    name,
    events,
    payloadMode,
    restrictedTemplate,
    ...urlFields,
  };
}

async function prepareWebhookUrlFields(value, env) {
  let url;
  try {
    url = await assertSafeWebhookUrl(value, { resolveHost: createWebhookResolveHost(env) });
  } catch (error) {
    return webhookUrlErrorResponse(error);
  }

  return {
    encryptedUrlCiphertext: await encryptWebhookUrl(url.toString(), readWebhookUrlEncryptionKey(env)),
    urlHost: url.hostname,
    urlMasked: maskWebhookUrl(url),
    urlFingerprint: `sha256:${await sha256HexForText(url.toString())}`,
  };
}

function webhookUrlErrorResponse(error) {
  const code = errorCodeFromError(error, 'WEBHOOK_URL_INVALID');
  return jsonError(code, 'Webhook URL is invalid or unsafe.', 400, 'Use a public https webhook URL.');
}

function createWebhookResolveHost(env = {}) {
  if (typeof env.resolveWebhookHost === 'function') return env.resolveWebhookHost;
  return (hostname) => resolveHostWithDnsOverHttps(hostname, env);
}

async function resolveHostWithDnsOverHttps(hostname, env = {}) {
  const fetchImpl = typeof env.fetch === 'function' ? env.fetch : fetch;
  const addresses = [];
  for (const type of ['A', 'AAAA']) {
    const endpoint = new URL(env.WEBHOOK_DNS_RESOLVER_URL || 'https://cloudflare-dns.com/dns-query');
    endpoint.searchParams.set('name', hostname);
    endpoint.searchParams.set('type', type);
    const response = await fetchImpl(endpoint.toString(), {
      headers: { Accept: 'application/dns-json' },
    });
    if (!response.ok) throw new Error('WEBHOOK_URL_RESOLUTION_FAILED');
    const body = await response.json();
    for (const answer of body.Answer || []) {
      if ((answer.type === 1 || answer.type === 28) && typeof answer.data === 'string') addresses.push(answer.data);
    }
  }
  return addresses;
}

function maskWebhookUrl(url) {
  const pathSegments = url.pathname.split('/').filter(Boolean);
  const tail = pathSegments.at(-1);
  if (!tail) return `${url.protocol}//${url.hostname}/...`;
  return `${url.protocol}//${url.hostname}/.../${tail.slice(-4)}`;
}

function formatWebhookSubscription(webhook) {
  return {
    id: webhook.id,
    environment: webhook.environment,
    name: webhook.name,
    events: [...webhook.events],
    payloadMode: webhook.payloadMode,
    restrictedTemplate: webhook.restrictedTemplate || null,
    urlHost: webhook.urlHost,
    urlMasked: webhook.urlMasked,
    urlFingerprint: webhook.urlFingerprint,
    enabled: webhook.enabled,
    lastDeliveryStatus: webhook.lastDeliveryStatus || null,
    createdByUserId: webhook.createdByUserId,
    disabledAt: webhook.disabledAt || null,
    createdAt: webhook.createdAt,
    updatedAt: webhook.updatedAt,
  };
}

function formatWebhookDelivery(delivery) {
  return {
    id: delivery.id,
    subscriptionId: delivery.subscriptionId,
    eventType: delivery.eventType,
    deliveryStatus: delivery.deliveryStatus,
    renderStatus: delivery.renderStatus,
    payloadMode: delivery.payloadMode,
    payloadHash: delivery.payloadHash || null,
    targetHost: delivery.targetHost,
    httpStatus: delivery.httpStatus ?? null,
    attemptCount: delivery.attemptCount,
    nextRetryAt: delivery.nextRetryAt || null,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
}

function normalizeName(value) {
  return typeof value === 'string' ? value.trim().slice(0, 120) : '';
}

function normalizeEvents(value) {
  if (!Array.isArray(value)) return [];
  const events = [];
  const seen = new Set();
  for (const item of value) {
    const event = typeof item === 'string' ? item.trim() : '';
    if (!event) continue;
    if (!SUPPORTED_WEBHOOK_EVENTS.has(event)) {
      return jsonError(
        'WEBHOOK_EVENTS_INVALID',
        'Webhook events are invalid.',
        400,
        'Use supported events: site.deployed.'
      );
    }
    if (!seen.has(event)) {
      seen.add(event);
      events.push(event);
    }
  }
  return events;
}

function normalizePayloadMode(value) {
  return PAYLOAD_MODES.has(value) ? value : '';
}

function normalizeRestrictedTemplate(payloadMode, value) {
  if (payloadMode !== 'template') return null;
  if (value == null) {
    return jsonError(
      'WEBHOOK_TEMPLATE_REQUIRED',
      'Webhook payload template is required.',
      400,
      'Provide a restricted template or use standard payload mode.'
    );
  }
  try {
    validateRestrictedTemplate(value);
  } catch (error) {
    return templateErrorResponse(error);
  }
  return value;
}

function templateErrorResponse(error) {
  const code = String(error?.message || '').split(':', 1)[0] || 'WEBHOOK_TEMPLATE_INVALID';
  return jsonError(code, 'Webhook payload template is invalid.', 400, 'Use only allowed XD Cell payload variables.');
}

function methodNotAllowed() {
  return jsonError('METHOD_NOT_ALLOWED', 'Method not allowed.', 405, 'Use a supported HTTP method.');
}

function nextId(env, prefix) {
  if (typeof env?.nextId === 'function') return env.nextId(prefix);
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `${prefix}_${[...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function readWebhookUrlEncryptionKey(env) {
  const key = env.WEBHOOK_URL_ENCRYPTION_KEY || env.PAGES_SECRET_ENCRYPTION_KEY || env.SITE_SECRET_ENCRYPTION_KEY;
  if (typeof key !== 'string' || !key) throw new Error('WEBHOOK_URL_ENCRYPTION_KEY_REQUIRED');
  return key;
}

function readNowIso(now) {
  const value = typeof now === 'function' ? now() : new Date().toISOString();
  return value instanceof Date ? value.toISOString() : String(value);
}

function errorCodeFromError(error, fallback) {
  const message = String(error?.message || '');
  const code = message.split(':', 1)[0];
  return /^[A-Z0-9_]+$/.test(code) ? code : fallback;
}

async function encryptWebhookUrl(value, secretEncryptionKey) {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await importAesGcmKey(secretEncryptionKey);
  const bytes = new globalThis.TextEncoder().encode(value);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, bytes));
  return `v1:${base64UrlEncode(iv)}:${base64UrlEncode(encrypted)}`;
}

async function decryptWebhookUrl(value, secretEncryptionKey) {
  const parts = String(value || '').split(':');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('WEBHOOK_URL_CIPHERTEXT_INVALID');
  const key = await importAesGcmKey(secretEncryptionKey);
  const iv = base64UrlDecode(parts[1]);
  const encrypted = base64UrlDecode(parts[2]);
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, encrypted);
  return new globalThis.TextDecoder().decode(decrypted);
}

async function importAesGcmKey(secretEncryptionKey) {
  const material = new globalThis.TextEncoder().encode(String(secretEncryptionKey));
  const digest = await crypto.subtle.digest('SHA-256', material);
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

function base64UrlEncode(bytes) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

function base64UrlDecode(value) {
  const normalized = String(value || '')
    .replaceAll('-', '+')
    .replaceAll('_', '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}
