export function createDeploymentSucceededWebhook({ teams, webhooks, clock, ids }) {
  if (typeof webhooks?.deliver !== 'function') throw new TypeError('webhooks.deliver is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');
  if (typeof ids?.next !== 'function') throw new TypeError('ids.next is required');

  return { deliver };

  async function deliver(command) {
    try {
      const team = await resolveTeam(teams, command.site);
      const deliveries = await webhooks.deliver(buildEvent(command, team, clock, ids), {
        now: () => command.deployment.completedAt || clock.now(),
      });
      if (!Array.isArray(deliveries)) return failedOutcome();
      if (deliveries.length === 0) return { status: 'skipped' };
      if (deliveries.some((delivery) => delivery?.deliveryStatus === 'failed')) return failedOutcome();
      return { status: 'succeeded' };
    } catch {
      return failedOutcome();
    }
  }
}

async function resolveTeam(teams, site) {
  if (site.ownerType !== 'team' || !site.ownerId || typeof teams?.get !== 'function') return null;
  return teams.get(site.ownerId);
}

function buildEvent(command, team, clock, ids) {
  const { actor, site, route, deployment, environment } = command;
  return {
    id: ids.next('evt'),
    type: 'site.deployed',
    environment,
    occurredAt: deployment.completedAt || clock.now(),
    actor: {
      type: actor.type,
      userId: actor.userId || null,
      email: actor.email || null,
      name: actor.name || null,
    },
    site: {
      id: site.id,
      slug: site.slug,
      hostname: route.hostname,
      ownerType: site.ownerType || 'user',
      ownerId: site.ownerId || site.ownerUserId,
      visibility: route.visibility || site.defaultVisibility,
      status: route.routeStatus,
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
    },
  };
}

function failedOutcome() {
  return { status: 'failed', causeClass: 'webhook_delivery_error' };
}
