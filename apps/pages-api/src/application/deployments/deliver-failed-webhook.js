export function createDeploymentFailedWebhook({ teams, webhooks, telemetry, clock, ids }) {
  if (typeof webhooks?.deliver !== 'function') throw new TypeError('webhooks.deliver is required');
  if (typeof telemetry?.start !== 'function') throw new TypeError('telemetry.start is required');
  if (typeof telemetry?.finish !== 'function') throw new TypeError('telemetry.finish is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');
  if (typeof ids?.next !== 'function') throw new TypeError('ids.next is required');

  return { deliver };

  function deliver(command) {
    const stage = telemetry.start();
    return Promise.resolve().then(() => deliverAfterStart(command, stage));
  }

  async function deliverAfterStart(command, stage) {
    let outcome;
    try {
      const team = await resolveTeam(teams, command.site);
      const deliveries = await webhooks.deliver(buildEvent(command, team, clock, ids), {
        now: () => command.deployment.completedAt || clock.now(),
      });
      if (!Array.isArray(deliveries)) outcome = failedOutcome();
      else if (deliveries.length === 0) outcome = { status: 'skipped' };
      else if (deliveries.some((delivery) => delivery?.deliveryStatus === 'failed')) outcome = failedOutcome();
      else outcome = { status: 'succeeded' };
    } catch {
      outcome = failedOutcome();
    }
    await telemetry.finish(stage, outcome);
    return outcome;
  }
}

async function resolveTeam(teams, site) {
  if (site?.ownerType !== 'team' || !site.ownerId || typeof teams?.get !== 'function') return null;
  try {
    return await teams.get(site.ownerId);
  } catch {
    return null;
  }
}

function buildEvent(command, team, clock, ids) {
  const { actor, site, deployment, environment } = command;
  const route = site?.route || null;
  return {
    id: ids.next('evt'),
    type: 'site.failed',
    environment,
    occurredAt: deployment.completedAt || clock.now(),
    actor: actor ? actorPayload(actor) : undefined,
    site: {
      id: site?.id,
      slug: site?.slug,
      hostname: route?.hostname || site?.hostname,
      ownerType: site?.ownerType || 'user',
      ownerId: site?.ownerId || site?.ownerUserId,
      visibility: route?.visibility || site?.defaultVisibility,
      status: route?.routeStatus,
    },
    team: team
      ? {
          id: team.id,
          name: team.name || null,
          teamType: team.teamType || null,
        }
      : undefined,
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

function actorPayload(actor) {
  return {
    type: actor?.type || 'user',
    userId: actor?.userId || null,
    email: actor?.email || null,
    name: actor?.name || actor?.realname || actor?.user?.realname || null,
  };
}

function failedOutcome() {
  return { status: 'failed', causeClass: 'webhook_delivery_error' };
}
