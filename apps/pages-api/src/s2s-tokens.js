import { createAccessKeyMaterial } from './access-keys.js';
import { sha256HexForText } from './crypto.js';
import { jsonError, jsonOk } from './http.js';
import { newId } from './id.js';
import { authenticateS2SRequest } from './s2s-auth.js';
import { buildS2SAnomalyPayload, notifyS2SAnomaly } from './slack-alerts.js';

const ISSUE_PATH = '/.xd-pages/api/s2s/tokens';
const REVOKE_PATH = '/.xd-pages/api/s2s/tokens/revoke';
const USER_RATE_LIMIT = 20;
const USER_RATE_WINDOW_SECONDS = 10 * 60;
const ACCESS_KEY_TTL_MS = 24 * 60 * 60 * 1000;
const ACCESS_KEY_SCOPES = ['deploy:site', 'read:site', 'rollback:site'];

export async function handleS2STokensApi(request, env, config, store, ctx = null) {
  const url = safeUrl(request?.url);
  if (!url || ![ISSUE_PATH, REVOKE_PATH].includes(url.pathname)) return null;

  const now = readNow(env);
  let auth;
  try {
    auth = await authenticateS2SRequest({
      request,
      env,
      environment: config.environment,
      store,
      nowSeconds: Math.floor(new Date(now).getTime() / 1000),
    });
  } catch {
    return storeUnavailable();
  }
  if (!auth.ok) {
    await recordBestEffortAudit(
      store,
      auditEvent(env, config, auth.clientId || null, 's2s.request.deny', {
        decision: 'deny',
        statusCode: auth.status,
        signingKeyId: auth.keyId,
        reason: auth.code,
        now,
      })
    );
    return authFailureResponse(auth);
  }

  let body;
  try {
    body = parseRawJsonObject(auth.rawBody);
  } catch {
    return deniedResponse(env, config, store, auth, requestInvalid(), now);
  }

  if (url.pathname === ISSUE_PATH) {
    return issueToken(body, env, config, store, auth, now, ctx);
  }
  return revokeTokens(body, env, config, store, auth, now);
}

async function issueToken(body, env, config, store, auth, now, ctx) {
  const input = normalizeIssueInput(body);
  if (!input) return deniedResponse(env, config, store, auth, requestInvalid(), now);

  let rate;
  try {
    const subject = await sha256HexForText(`xdmaker-s2s:user:${input.email}`);
    const bucketStartSeconds = Math.floor(new Date(now).getTime() / 1000 / USER_RATE_WINDOW_SECONDS) * USER_RATE_WINDOW_SECONDS;
    rate = await store.consumeS2SRateLimit({
      environment: config.environment,
      scope: 'user',
      subject,
      bucketStart: new Date(bucketStartSeconds * 1000).toISOString(),
      expiresAt: new Date((bucketStartSeconds + USER_RATE_WINDOW_SECONDS) * 1000).toISOString(),
      limit: USER_RATE_LIMIT,
    });
  } catch {
    return deniedResponse(env, config, store, auth, storeFailure(), now);
  }
  if (!rate?.allowed) {
    return deniedResponse(env, config, store, auth, rateLimited(), now);
  }
  if (rate.count === 3) {
    await recordBestEffortAudit(
      store,
      auditEvent(env, config, auth.clientId, 's2s.anomaly.detect', {
        decision: 'alert',
        statusCode: 200,
        signingKeyId: auth.keyId,
        reason: 'user_rate_count_3',
        bucketCount: rate.count,
        now,
      })
    );
    scheduleS2SAnomaly(ctx, env, {
      environment: config.environment,
      clientId: auth.clientId,
      userId: null,
      accessKeyId: null,
      reason: 'user_rate_count_3',
    });
  }

  let identity;
  try {
    identity = await resolveIdentity(store, env, config, auth, input, now);
  } catch (error) {
    const failure = error instanceof S2STokenError ? error.failure : storeFailure();
    return deniedResponse(env, config, store, auth, failure, now, { userId: error.userId });
  }

  const expiresAt = new Date(new Date(now).getTime() + ACCESS_KEY_TTL_MS).toISOString();
  let plaintext;
  let record;
  try {
    ({ plaintext, record } = await createAccessKeyMaterial(env, config, {
      ownerType: 'user',
      ownerId: identity.id,
      ownerUserId: identity.id,
      createdByUserId: identity.id,
      name: 'XDMaker',
      scopes: ACCESS_KEY_SCOPES,
      siteId: null,
      expiresAt,
      issuedSource: 'xdmaker_s2s',
      issuedSessionVersion: identity.sessionVersion,
    }));

    const auditEvents = [
      auditEvent(env, config, auth.clientId, 's2s.access_key.issue', {
        actorUserId: identity.id,
        decision: 'allow',
        statusCode: 201,
        signingKeyId: auth.keyId,
        accessKeyId: record.id,
        userId: identity.id,
        now,
      }),
    ];
    if (input.replacesKeyId) {
      auditEvents.push(
        auditEvent(env, config, auth.clientId, 's2s.access_key.replace', {
          actorUserId: identity.id,
          decision: 'allow',
          statusCode: 201,
          signingKeyId: auth.keyId,
          accessKeyId: input.replacesKeyId,
          userId: identity.id,
          reason: 'xdmaker_s2s_replace',
          now,
        })
      );
    }
    await store.issueS2SAccessKey({
      accessKey: record,
      replacesKeyId: input.replacesKeyId,
      auditEvents,
      now,
    });
  } catch (error) {
    const failure = error?.code === 'S2S_REPLACEMENT_KEY_INVALID' ? replacementInvalid() : storeFailure();
    return deniedResponse(env, config, store, auth, failure, now, {
      userId: identity.id,
      accessKeyId: error?.code === 'S2S_REPLACEMENT_KEY_INVALID' ? input.replacesKeyId : record?.id,
    });
  }

  if (isShanghaiOffHours(now)) {
    await recordBestEffortAudit(
      store,
      auditEvent(env, config, auth.clientId, 's2s.anomaly.detect', {
        actorUserId: identity.id,
        decision: 'alert',
        statusCode: 201,
        signingKeyId: auth.keyId,
        userId: identity.id,
        accessKeyId: record.id,
        reason: 'off_hours_issue',
        now,
      })
    );
    scheduleS2SAnomaly(ctx, env, {
      environment: config.environment,
      clientId: auth.clientId,
      userId: identity.id,
      accessKeyId: record.id,
      reason: 'off_hours_issue',
    });
  }

  return jsonOk(
    {
      token: plaintext,
      key_id: record.id,
      expires_at: record.expiresAt,
      source: 'xdmaker_s2s',
      actor: {
        user_id: identity.id,
        email: identity.email,
        display_name: identity.realname,
        created_source: identity.createdSource,
      },
    },
    201
  );
}

function scheduleS2SAnomaly(ctx, env, input) {
  if (typeof ctx?.waitUntil !== 'function') return;
  try {
    ctx.waitUntil(notifyS2SAnomaly(env, buildS2SAnomalyPayload(input)));
  } catch {
    // Alert delivery is best-effort and must not change the token response.
  }
}

async function revokeTokens(body, env, config, store, auth, now) {
  const selector = normalizeRevokeInput(body);
  if (!selector) return deniedResponse(env, config, store, auth, requestInvalid(), now);

  try {
    const result = await store.revokeS2SAccessKeys({
      environment: config.environment,
      keyId: selector.keyId,
      email: selector.email,
      clientId: auth.clientId,
      signingKeyId: auth.keyId,
      now,
    });
    return jsonOk({ revoked_count: result.revokedCount, key_ids: result.keyIds });
  } catch {
    return deniedResponse(env, config, store, auth, storeFailure(), now, { accessKeyId: selector.keyId });
  }
}

async function resolveIdentity(store, env, config, auth, input, now) {
  let byEmail;
  let byFeishu;
  try {
    [byEmail, byFeishu] = await Promise.all([store.getUserByEmail(input.email), store.getUserByFeishuOpenId(input.feishuOpenId)]);
  } catch {
    throw new S2STokenError(storeFailure());
  }

  if ((byEmail && byFeishu && byEmail.id !== byFeishu.id) || (!byEmail && byFeishu)) {
    throw new S2STokenError(identityConflict());
  }
  if (byEmail?.feishuOpenId && byEmail.feishuOpenId !== input.feishuOpenId) {
    throw new S2STokenError(identityConflict());
  }

  if (byEmail) {
    if (byEmail.employeeStatus !== 'active') {
      throw new S2STokenError(userInactive(), byEmail.id);
    }
    if (!byEmail.feishuOpenId) {
      let bound;
      try {
        bound = await store.bindUserFeishuOpenId(byEmail.id, input.feishuOpenId);
      } catch (error) {
        if (isIdentityConstraintError(error)) throw new S2STokenError(identityConflict(), byEmail.id);
        throw new S2STokenError(storeFailure(), byEmail.id);
      }
      if (!bound) throw new S2STokenError(identityConflict(), byEmail.id);
      byEmail = { ...byEmail, feishuOpenId: input.feishuOpenId };
      await recordBestEffortAudit(
        store,
        auditEvent(env, config, auth.clientId, 's2s.user.link_feishu', {
          actorUserId: byEmail.id,
          decision: 'allow',
          statusCode: 200,
          signingKeyId: auth.keyId,
          userId: byEmail.id,
          now,
        })
      );
    }
    if (!byEmail.realname?.trim()) {
      try {
        byEmail = await store.updateUserRealnameIfEmpty(byEmail.id, input.displayName);
      } catch {
        throw new S2STokenError(storeFailure(), byEmail.id);
      }
      if (!byEmail) throw new S2STokenError(storeFailure());
    }
    return byEmail;
  }

  let created;
  try {
    created = await store.createUser({
      userId: nextId(env, 'usr'),
      email: input.email,
      realname: input.displayName,
      employeeStatus: 'active',
      feishuOpenId: input.feishuOpenId,
      createdSource: 'xdmaker',
      departmentPath: null,
      departmentCheckedAt: null,
    });
  } catch (error) {
    if (isIdentityConstraintError(error)) throw new S2STokenError(identityConflict());
    throw new S2STokenError(storeFailure());
  }
  await recordBestEffortAudit(
    store,
    auditEvent(env, config, auth.clientId, 's2s.user.create', {
      actorUserId: created.id,
      decision: 'allow',
      statusCode: 201,
      signingKeyId: auth.keyId,
      userId: created.id,
      now,
    })
  );
  return created;
}

function normalizeIssueInput(body) {
  const email = normalizeEmail(body.email);
  const feishuOpenId = body.feishu_open_id;
  const displayName = typeof body.display_name === 'string' ? body.display_name.trim() : '';
  const replacesKeyId = body.replaces_key_id;
  if (!email || !isFeishuOpenId(feishuOpenId) || displayName.length < 1 || displayName.length > 80) return null;
  if (replacesKeyId !== undefined && !isAccessKeyId(replacesKeyId)) return null;
  return { email, feishuOpenId, displayName, replacesKeyId: replacesKeyId || null };
}

function normalizeRevokeInput(body) {
  const hasKeyId = Object.prototype.hasOwnProperty.call(body, 'key_id');
  const hasEmail = Object.prototype.hasOwnProperty.call(body, 'email');
  if (hasKeyId === hasEmail) return null;
  if (hasKeyId) return isAccessKeyId(body.key_id) ? { keyId: body.key_id, email: null } : null;
  const email = normalizeEmail(body.email);
  return email ? { keyId: null, email } : null;
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  const email = value.trim().toLowerCase();
  if (email.length < 3 || email.length > 320) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

function isFeishuOpenId(value) {
  return (
    typeof value === 'string' && value.length >= 1 && value.length <= 128 && value.trim() === value && !/\p{Cc}/u.test(value)
  );
}

function isAccessKeyId(value) {
  return typeof value === 'string' && /^ak_[A-Za-z0-9_]{1,128}$/.test(value);
}

function parseRawJsonObject(rawBody) {
  const value = JSON.parse(rawBody || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON object required');
  return value;
}

async function deniedResponse(env, config, store, auth, failure, now, { userId = null, accessKeyId = null } = {}) {
  await recordBestEffortAudit(
    store,
    auditEvent(env, config, auth?.clientId || null, 's2s.request.deny', {
      actorUserId: userId,
      decision: 'deny',
      statusCode: failure.status,
      signingKeyId: auth?.keyId,
      accessKeyId,
      userId,
      reason: failure.code,
      now,
    })
  );
  return failureResponse(failure);
}

async function recordBestEffortAudit(store, event) {
  try {
    await store.recordAuditEvent(event);
  } catch {
    // Alerts and deny-path audit records must not change the request result.
  }
}

function auditEvent(env, config, clientId, eventType, input) {
  const metadata = { environment: config.environment };
  if (clientId) metadata.clientId = clientId;
  if (input.signingKeyId) metadata.signingKeyId = input.signingKeyId;
  if (input.accessKeyId) metadata.accessKeyId = input.accessKeyId;
  if (input.userId) metadata.userId = input.userId;
  if (input.reason) metadata.reason = input.reason;
  if (input.bucketCount !== undefined) metadata.bucketCount = input.bucketCount;
  return {
    id: nextId(env, 'aud'),
    environment: config.environment,
    traceId: null,
    eventType,
    actorUserId: input.actorUserId || null,
    actorType: 's2s',
    siteId: null,
    routeId: null,
    versionId: null,
    decision: input.decision,
    statusCode: input.statusCode,
    ipHash: null,
    userAgentHash: null,
    metadata,
    createdAt: input.now,
  };
}

function authFailureResponse(auth) {
  return failureResponse({
    code: auth.code,
    message: auth.message,
    action: auth.action,
    status: auth.status,
    retryAfter: auth.retryAfter,
  });
}

function failureResponse(failure) {
  const response = jsonError(failure.code, failure.message, failure.status, failure.action);
  if (!failure.retryAfter) return response;
  const headers = new Headers(response.headers);
  headers.set('Retry-After', String(failure.retryAfter));
  return new Response(response.body, { status: response.status, headers });
}

function requestInvalid() {
  return {
    code: 'S2S_REQUEST_INVALID',
    message: 'S2S request is invalid.',
    action: 'Send a valid JSON request.',
    status: 400,
  };
}

function identityConflict() {
  return {
    code: 'S2S_IDENTITY_CONFLICT',
    message: 'S2S user identity conflicts with an existing user.',
    action: 'Resolve the user identity conflict before retrying.',
    status: 409,
  };
}

function userInactive() {
  return {
    code: 'S2S_USER_INACTIVE',
    message: 'S2S user is not active.',
    action: 'Contact the Pages platform owner.',
    status: 403,
  };
}

function replacementInvalid() {
  return {
    code: 'S2S_REPLACEMENT_KEY_INVALID',
    message: 'Replacement access key is invalid.',
    action: 'Use an active XDMaker key owned by the same user and environment.',
    status: 409,
  };
}

function rateLimited() {
  return {
    code: 'S2S_RATE_LIMITED',
    message: 'S2S rate limit exceeded.',
    action: 'Wait before retrying.',
    status: 429,
    retryAfter: USER_RATE_WINDOW_SECONDS,
  };
}

function storeFailure() {
  return {
    code: 'S2S_STORE_UNAVAILABLE',
    message: 'S2S token service is temporarily unavailable.',
    action: 'Retry later.',
    status: 500,
  };
}

function storeUnavailable() {
  return failureResponse(storeFailure());
}

function isIdentityConstraintError(error) {
  return (
    ['USER_EXISTS', 'USER_EMAIL_CONFLICT', 'USER_FEISHU_OPEN_ID_CONFLICT', 'USER_IDENTITY_CONFLICT'].includes(
      error?.code || error?.message
    ) || /UNIQUE constraint failed:\s*(?:users\.|index\s+['"]?idx_users)/i.test(String(error?.message || ''))
  );
}

function isShanghaiOffHours(now) {
  const hour = (new Date(now).getUTCHours() + 8) % 24;
  return hour < 6;
}

function readNow(env) {
  if (typeof env?.now === 'function') return env.now();
  return new Date().toISOString();
}

function nextId(env, prefix) {
  if (typeof env?.nextId === 'function') return env.nextId(prefix);
  return newId(prefix);
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

class S2STokenError extends Error {
  constructor(failure, userId = null) {
    super(failure.code);
    this.failure = failure;
    this.userId = userId;
  }
}
