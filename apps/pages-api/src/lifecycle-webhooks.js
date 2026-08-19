import { nextId } from './id.js';
import { deliverWebhookEventToSubscriptions } from './webhooks.js';

export async function emitSiteFailedWebhook({ store, env, config, ctx, actor, site, deployment }) {
  await schedule(ctx, () =>
    buildSiteFailedEvent({ store, env, config, actor, site, deployment }).then((event) =>
      deliverWebhookEventToSubscriptions({
        store,
        env,
        config,
        event,
        fetchImpl: typeof env.WEBHOOK_FETCH === 'function' ? env.WEBHOOK_FETCH : undefined,
        resolveHost: typeof env.resolveWebhookHost === 'function' ? env.resolveWebhookHost : undefined,
        now: () => deployment.completedAt || readNow(env),
      })
    )
  );
}

export async function emitSiteDisabledWebhook({ store, env, config, ctx, actor, site, previousRoute, route }) {
  if (!actor || !previousRoute || previousRoute.visibility === 'disabled' || route?.visibility !== 'disabled') return;
  await schedule(ctx, () =>
    buildSiteDisabledEvent({ store, env, config, actor, site, previousRoute, route }).then((event) =>
      deliverWebhookEventToSubscriptions({
        store,
        env,
        config,
        event,
        fetchImpl: typeof env.WEBHOOK_FETCH === 'function' ? env.WEBHOOK_FETCH : undefined,
        resolveHost: typeof env.resolveWebhookHost === 'function' ? env.resolveWebhookHost : undefined,
      })
    )
  );
}

export async function emitSiteDeletedWebhook({ store, env, config, ctx, actor, site, previousRoute, route }) {
  if (!actor) return;
  await schedule(ctx, () =>
    buildSiteDeletedEvent({ store, env, config, actor, site, previousRoute, route }).then((event) =>
      deliverWebhookEventToSubscriptions({
        store,
        env,
        config,
        event,
        fetchImpl: typeof env.WEBHOOK_FETCH === 'function' ? env.WEBHOOK_FETCH : undefined,
        resolveHost: typeof env.resolveWebhookHost === 'function' ? env.resolveWebhookHost : undefined,
      })
    )
  );
}

async function schedule(ctx, task) {
  const promise = Promise.resolve()
    .then(task)
    .catch(() => undefined);
  if (ctx && typeof ctx.waitUntil === 'function') {
    try {
      ctx.waitUntil(promise);
    } catch {
      // Best-effort delivery must not alter the business response.
    }
    return;
  }
  await promise;
}

async function buildSiteFailedEvent({ store, env, config, actor, site, deployment }) {
  const route = site?.route || null;
  return {
    id: nextId(env, 'evt'),
    type: 'site.failed',
    environment: config.environment,
    occurredAt: deployment.completedAt || readNow(env),
    actor: actor ? actorPayload(actor) : undefined,
    site: sitePayload(site, route),
    team: await teamPayload(store, site),
    deployment: {
      id: deployment.id,
      status: deployment.status,
      source: deployment.source,
      operation: deployment.operation,
      createdAt: deployment.createdAt,
      completedAt: deployment.completedAt || null,
      failureStage: deployment.failureStage,
      errorCode: deployment.errorCode,
    },
  };
}

async function buildSiteDisabledEvent({ store, env, config, actor, site, previousRoute, route }) {
  return {
    id: nextId(env, 'evt'),
    type: 'site.disabled',
    environment: config.environment,
    occurredAt: readNow(env),
    actor: actorPayload(actor),
    site: sitePayload(site, route),
    team: await teamPayload(store, site),
    change: {
      field: 'visibility',
      previousValue: previousRoute.visibility,
      currentValue: route.visibility,
    },
  };
}

async function buildSiteDeletedEvent({ store, env, config, actor, site, previousRoute, route }) {
  return {
    id: nextId(env, 'evt'),
    type: 'site.deleted',
    environment: config.environment,
    occurredAt: readNow(env),
    actor: actorPayload(actor),
    site: {
      ...sitePayload(site, route || previousRoute),
      status: 'deleted',
    },
    team: await teamPayload(store, site),
  };
}

async function teamPayload(store, site) {
  if (site?.ownerType !== 'team' || !site.ownerId || typeof store?.getTeam !== 'function') return undefined;
  try {
    const team = await store.getTeam(site.ownerId);
    return team
      ? {
          id: team.id,
          name: team.name || null,
          teamType: team.teamType || null,
        }
      : undefined;
  } catch {
    return undefined;
  }
}

function actorPayload(actor) {
  return {
    type: actor?.type || 'user',
    userId: actor?.userId || null,
    email: actor?.email || null,
    name: actor?.name || actor?.realname || actor?.user?.realname || null,
  };
}

function sitePayload(site, route) {
  return {
    id: site?.id,
    slug: site?.slug,
    hostname: route?.hostname || site?.hostname,
    ownerType: site?.ownerType || 'user',
    ownerId: site?.ownerId || site?.ownerUserId,
    visibility: route?.visibility || site?.defaultVisibility,
    status: route?.routeStatus,
  };
}

function readNow(env) {
  return typeof env?.now === 'function' ? env.now() : new Date().toISOString();
}
