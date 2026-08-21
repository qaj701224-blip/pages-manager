export function createAdminDashboardQuery({ dashboards, clock }) {
  if (typeof dashboards?.read !== 'function') throw new TypeError('dashboards.read is required');
  if (typeof clock?.now !== 'function') throw new TypeError('clock.now is required');

  return { get };

  async function get(query) {
    const dashboard = await dashboards.read({ environment: query.environment });
    const oldestPendingAt = dashboard.resourceCleanup?.oldestPendingAt || null;
    return {
      environment: dashboard.environment,
      counts: dashboard.counts,
      resourceCleanup: {
        pendingTasks: dashboard.resourceCleanup?.pendingTasks || 0,
        failedTasks: dashboard.resourceCleanup?.failedTasks || 0,
        oldestPendingAt,
        oldestPendingAgeSeconds: backlogAgeSeconds(oldestPendingAt, clock.now()),
        orphanCandidates: null,
        v1Sites: null,
      },
      failedDeployments: dashboard.failedDeployments.map(projectFailedDeployment),
    };
  }
}

function projectFailedDeployment(deployment) {
  const ownerState = deployment.ownerState === 'not_created' ? 'not_created' : 'persisted';
  const actor = deployment.actor || {};
  const projected = {
    id: deployment.id,
    siteId: deployment.siteId,
    siteSlug: deployment.siteSlug || null,
    owner: {
      state: ownerState,
      type: ownerState === 'not_created' ? null : deployment.ownerType || 'user',
      id: ownerState === 'not_created' ? null : deployment.ownerId || deployment.ownerUserId || null,
      email: ownerState === 'not_created' ? null : deployment.ownerEmail || null,
      displayName: ownerState === 'not_created' ? null : deployment.ownerDisplayName || null,
      departmentPath: ownerState === 'not_created' ? null : deployment.ownerDepartmentPath || null,
      teamType: ownerState === 'not_created' ? null : deployment.ownerTeamType || null,
    },
    actor: {
      type: actor.type ?? deployment.actorType ?? null,
      id: actor.id ?? deployment.actorId ?? null,
      userId: actor.userId ?? deployment.actorUserId ?? null,
      email: actor.email ?? null,
      displayName: actor.displayName ?? null,
    },
    status: deployment.status,
    source: deployment.source || null,
    operation: deployment.operation || null,
    createdAt: deployment.createdAt,
  };
  if (deployment.traceId) projected.traceId = deployment.traceId;
  if (deployment.errorCode) projected.errorCode = deployment.errorCode;
  if (deployment.errorMessage) projected.errorMessage = deployment.errorMessage;
  if (deployment.failureStage) projected.failureStage = deployment.failureStage;
  return projected;
}

function backlogAgeSeconds(oldestPendingAt, now) {
  if (!oldestPendingAt) return null;
  const ageMs = Date.parse(now) - Date.parse(oldestPendingAt);
  if (!Number.isFinite(ageMs)) return null;
  return Math.max(0, Math.floor(ageMs / 1000));
}
